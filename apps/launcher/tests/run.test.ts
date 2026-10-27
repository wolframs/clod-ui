/**
 * Launcher core tests — drive `runLauncher` end-to-end with fake deps.
 * No real spawns, no real browsers, no real engine.
 *
 * Spec: plans/2026-06-10-clod-ui-pr21-launcher-v1.md.
 */
import { describe, expect, test } from 'bun:test';

import {
  backoffDelays,
  parseListenLine,
  runLauncher,
  type EngineHandle,
  type EngineSignal,
  type LauncherDeps,
} from '../src/run.ts';

describe('parseListenLine', () => {
  test('extracts the base URL from the engine listen line', () => {
    expect(parseListenLine('[engine] listening on http://127.0.0.1:43117')).toBe(
      'http://127.0.0.1:43117',
    );
  });

  test('returns null for other engine output', () => {
    expect(parseListenLine('[engine] app-data: /tmp/x')).toBeNull();
    expect(parseListenLine('')).toBeNull();
    expect(parseListenLine('listening on http://127.0.0.1:1')).toBeNull();
  });
});

describe('backoffDelays', () => {
  test('grows by factor, respects the cap, stays within the deadline', () => {
    const delays = backoffDelays({ initialMs: 100, factor: 1.5, capMs: 1000, deadlineMs: 10_000 });
    expect(delays[0]).toBe(100);
    expect(delays[1]).toBe(150);
    expect(delays[2]).toBe(225);
    expect(Math.max(...delays)).toBe(1000);
    expect(delays.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(10_000);
  });

  test('deadline smaller than the first delay yields no retries', () => {
    expect(backoffDelays({ initialMs: 100, factor: 1.5, capMs: 1000, deadlineMs: 50 })).toEqual([]);
  });
});

/** Fast timing so failure paths resolve in milliseconds. */
const FAST_TIMING = {
  backoffInitialMs: 1,
  backoffFactor: 1.5,
  backoffCapMs: 2,
  healthDeadlineMs: 10,
  listenDeadlineMs: 20,
  sigintGraceMs: 5,
  sigtermGraceMs: 5,
};

const LISTEN_LINE = '[engine] listening on http://127.0.0.1:43117';
const BASE_URL = 'http://127.0.0.1:43117';

interface FakeEngine {
  handle: EngineHandle;
  kills: EngineSignal[];
  emitLine: (line: string) => void;
  exit: (code: number) => void;
}

/**
 * A fake engine child factory. Each spawn yields a fresh engine; `dieOn`
 * resolves `exited` when the matching signal arrives (default: SIGINT,
 * i.e. a well-behaved engine). `engines` records every spawn in order,
 * `ports` the pinned port (if any) each spawn was given; `engine()`
 * returns the latest.
 */
function makeFakeEngine(opts: { dieOn?: EngineSignal | 'never' } = {}): {
  spawn: LauncherDeps['spawnEngine'];
  engine: () => FakeEngine;
  engines: FakeEngine[];
  ports: (number | undefined)[];
} {
  const dieOn = opts.dieOn ?? 'SIGINT';
  const engines: FakeEngine[] = [];
  const ports: (number | undefined)[] = [];
  const spawn: LauncherDeps['spawnEngine'] = (onLine, spawnOpts) => {
    let resolveExit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const kills: EngineSignal[] = [];
    const handle: EngineHandle = {
      exited,
      kill: (signal) => {
        kills.push(signal);
        if (signal === dieOn) resolveExit(130);
      },
    };
    engines.push({ handle, kills, emitLine: onLine, exit: resolveExit });
    ports.push(spawnOpts?.port);
    return handle;
  };
  return {
    spawn,
    engines,
    ports,
    engine: () => {
      const current = engines[engines.length - 1];
      if (!current) throw new Error('spawnEngine was never called');
      return current;
    },
  };
}

interface HarnessOptions {
  distExists?: boolean;
  buildExit?: number;
  healthStatus?: number | (() => number | Promise<number>);
  dieOn?: EngineSignal | 'never';
}

function makeHarness(opts: HarnessOptions = {}) {
  const events: string[] = [];
  const opened: string[] = [];
  const fake = makeFakeEngine({ dieOn: opts.dieOn ?? 'SIGINT' });
  let signalHandler: ((signal: 'SIGINT' | 'SIGTERM') => void) | undefined;

  const deps: LauncherDeps = {
    webDistExists: () => opts.distExists ?? true,
    buildWeb: () => {
      events.push('build');
      return Promise.resolve(opts.buildExit ?? 0);
    },
    spawnEngine: (onLine, spawnOpts) => {
      events.push('spawn');
      return fake.spawn(onLine, spawnOpts);
    },
    fetchHealth: async () => {
      events.push('health');
      const status = opts.healthStatus ?? 200;
      return typeof status === 'function' ? status() : status;
    },
    openBrowser: (url) => {
      events.push('open');
      opened.push(url);
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: () => {},
    onSignal: (handler) => {
      signalHandler = handler;
    },
    timing: FAST_TIMING,
  };

  return {
    deps,
    events,
    opened,
    fake,
    sendSignal: (signal: 'SIGINT' | 'SIGTERM') => signalHandler?.(signal),
  };
}

describe('runLauncher', () => {
  test('happy path: spawn → listen line → health → browser, exits with engine code', async () => {
    const h = makeHarness();
    const run = runLauncher(h.deps);
    await Bun.sleep(1);
    h.fake.engine().emitLine(LISTEN_LINE);
    await Bun.sleep(5); // health poll + browser open
    h.fake.engine().exit(0);
    expect(await run).toBe(0);
    expect(h.opened).toEqual([BASE_URL]);
    expect(h.events).not.toContain('build'); // dist present → no build
    expect(h.events.filter((e) => e === 'open')).toHaveLength(1);
  });

  test('builds the web app first when dist is missing', async () => {
    const h = makeHarness({ distExists: false });
    const run = runLauncher(h.deps);
    await Bun.sleep(1);
    h.fake.engine().emitLine(LISTEN_LINE);
    await Bun.sleep(5);
    h.fake.engine().exit(0);
    await run;
    expect(h.events.indexOf('build')).toBeGreaterThanOrEqual(0);
    expect(h.events.indexOf('build')).toBeLessThan(h.events.indexOf('spawn'));
  });

  test('failed web build aborts before spawning the engine', async () => {
    const h = makeHarness({ distExists: false, buildExit: 2 });
    expect(await runLauncher(h.deps)).toBe(2);
    expect(h.events).not.toContain('spawn');
  });

  test('engine exiting before the listen line propagates its exit code (no restart)', async () => {
    const h = makeHarness();
    const run = runLauncher(h.deps);
    await Bun.sleep(1);
    h.fake.engine().exit(3);
    expect(await run).toBe(3);
    expect(h.opened).toEqual([]);
    expect(h.fake.engines).toHaveLength(1); // death before ready never restarts
  });

  test('missing listen line times out: engine killed, exit 1', async () => {
    const h = makeHarness();
    const run = runLauncher(h.deps);
    expect(await run).toBe(1);
    expect(h.fake.engine().kills).toContain('SIGINT');
    expect(h.opened).toEqual([]);
  });

  test('health never coming up kills the engine and exits 1', async () => {
    const h = makeHarness({ healthStatus: 500 });
    const run = runLauncher(h.deps);
    await Bun.sleep(1);
    h.fake.engine().emitLine(LISTEN_LINE);
    expect(await run).toBe(1);
    expect(h.fake.engine().kills).toContain('SIGINT');
    expect(h.opened).toEqual([]);
  });

  test('operator SIGINT forwards to the engine and propagates its exit code', async () => {
    const h = makeHarness();
    const run = runLauncher(h.deps);
    await Bun.sleep(1);
    h.fake.engine().emitLine(LISTEN_LINE);
    await Bun.sleep(5);
    h.sendSignal('SIGINT');
    expect(await run).toBe(130);
    expect(h.fake.engine().kills).toEqual(['SIGINT']);
  });

  test('stubborn engine escalates SIGINT → SIGTERM → SIGKILL', async () => {
    const h = makeHarness({ dieOn: 'SIGKILL' });
    const run = runLauncher(h.deps);
    await Bun.sleep(1);
    h.fake.engine().emitLine(LISTEN_LINE);
    await Bun.sleep(5);
    h.sendSignal('SIGINT');
    expect(await run).toBe(130);
    expect(h.fake.engine().kills).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
  });
});

describe('runLauncher — crash restart (PR #22)', () => {
  test('death after ready → one restart on the pinned port, browser opened once, second exit propagates', async () => {
    const h = makeHarness();
    const run = runLauncher(h.deps);
    await Bun.sleep(1);
    h.fake.engine().emitLine(LISTEN_LINE);
    await Bun.sleep(5); // ready + browser open
    h.fake.engine().exit(9); // crash, not a signal
    await Bun.sleep(5); // restart window: respawn happens
    expect(h.fake.engines).toHaveLength(2);
    expect(h.fake.ports).toEqual([undefined, 43117]); // second boot pins the first boot's port
    h.fake.engine().emitLine(LISTEN_LINE); // same origin: same listen line
    await Bun.sleep(5); // readiness gate runs again
    h.fake.engine().exit(7); // second death
    expect(await run).toBe(7); // second engine's code propagates
    expect(h.fake.engines).toHaveLength(2); // no third spawn
    expect(h.opened).toEqual([BASE_URL]); // exactly one browser open across the restart
  });

  test('operator SIGINT racing the crash wins: no respawn', async () => {
    const h = makeHarness();
    const run = runLauncher(h.deps);
    await Bun.sleep(1);
    h.fake.engine().emitLine(LISTEN_LINE);
    await Bun.sleep(5);
    h.fake.engine().exit(5); // crash...
    h.sendSignal('SIGINT'); // ...and Ctrl+C lands before the restart branch runs
    expect(await run).toBe(5);
    expect(h.fake.engines).toHaveLength(1);
  });

  test('restarted engine that never gets healthy → give up, exit 1', async () => {
    let phase = 1;
    const h = makeHarness({ healthStatus: () => (phase === 1 ? 200 : 500) });
    const run = runLauncher(h.deps);
    await Bun.sleep(1);
    h.fake.engine().emitLine(LISTEN_LINE);
    await Bun.sleep(5);
    phase = 2;
    h.fake.engine().exit(9);
    await Bun.sleep(5);
    h.fake.engine().emitLine(LISTEN_LINE); // listen line arrives, /health never goes green
    expect(await run).toBe(1);
    expect(h.fake.engines).toHaveLength(2);
    expect(h.fake.engine().kills).toContain('SIGINT'); // unhealthy restart gets torn down
  });
});
