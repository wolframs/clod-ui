/**
 * Launcher core — the Phase 7.3 orchestration as a pure-ish state machine.
 *
 * `runLauncher(deps)` owns sequencing only; every side effect (spawn,
 * build, fetch, browser, sleep, signals, logging) is a `deps` member so
 * tests drive the whole flow with fakes — no real spawns, no real
 * browsers (the test-kit treatment, applied to the launcher).
 *
 * Flow: ensure web dist → spawn engine → parse listen line from stdout →
 * poll /health with backoff → open browser → wait for engine exit.
 * Operator signals forward to the engine via a SIGINT→SIGTERM→SIGKILL
 * ladder (mirrors the PR #5 cancel-ladder shape).
 *
 * Crash recovery (Phase 7.4): engine death *after* ready and *without*
 * an operator signal gets exactly one restart, pinned to the first
 * boot's port so the open browser tab's origin survives. Death during
 * boot, or a second death, propagates the exit code.
 *
 * Spec: plans/2026-06-10-clod-ui-pr21-launcher-v1.md (boot sequence) +
 * plans/2026-06-10-clod-ui-pr22-crash-recovery-v1.md (restart-once).
 */

export type EngineSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL';

export interface EngineHandle {
  /** Settles with the engine's exit code when the child exits. */
  exited: Promise<number>;
  kill: (signal: EngineSignal) => void;
}

export interface LauncherTiming {
  /** First /health retry delay; grows by `backoffFactor` up to `backoffCapMs`. */
  backoffInitialMs: number;
  backoffFactor: number;
  backoffCapMs: number;
  /** Total budget for /health to come up before the launch is abandoned. */
  healthDeadlineMs: number;
  /** Budget for the engine to print its listen line after spawn. */
  listenDeadlineMs: number;
  /** Grace after SIGINT before escalating to SIGTERM. */
  sigintGraceMs: number;
  /** Grace after SIGTERM before escalating to SIGKILL. */
  sigtermGraceMs: number;
}

export const DEFAULT_TIMING: LauncherTiming = {
  backoffInitialMs: 100,
  backoffFactor: 1.5,
  backoffCapMs: 1000,
  healthDeadlineMs: 10_000,
  listenDeadlineMs: 10_000,
  sigintGraceMs: 5000,
  sigtermGraceMs: 2000,
};

export interface LauncherDeps {
  /** True when the built SPA (apps/web/dist/index.html) is present. */
  webDistExists: () => boolean | Promise<boolean>;
  /** Runs the web build to completion; resolves with its exit code. */
  buildWeb: () => Promise<number>;
  /**
   * Spawns the engine child; `onLine` receives each stdout line.
   * `opts.port` pins the listen port (restart path: effects set
   * `CLOD_UI_ENGINE_PORT` so the respawned engine keeps the origin).
   */
  spawnEngine: (onLine: (line: string) => void, opts?: { port?: number }) => EngineHandle;
  /** GET `<baseUrl>/health`; resolves with the HTTP status, rejects on network error. */
  fetchHealth: (baseUrl: string) => Promise<number>;
  /** Opens the default browser at the engine origin (no-op under CLOD_UI_NO_BROWSER). */
  openBrowser: (url: string) => void | Promise<void>;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
  /** Registers the operator-signal handler (SIGINT/SIGTERM on the launcher). */
  onSignal: (handler: (signal: 'SIGINT' | 'SIGTERM') => void) => void;
  timing?: Partial<LauncherTiming>;
}

/**
 * Extract the engine base URL from its startup log line
 * (`[engine] listening on http://127.0.0.1:<port>`). Returns null for
 * every other line. If this line ever needs to change shape, replace
 * the parse with a structured readiness handshake. // TODO(ready-file)
 */
export function parseListenLine(line: string): string | null {
  const match = /\[engine\] listening on (http:\/\/\S+)/.exec(line);
  return match?.[1] ?? null;
}

/**
 * The /health retry schedule: delays starting at `initialMs`, growing by
 * `factor`, capped at `capMs`, whose cumulative sum stays within
 * `deadlineMs`. Pure — the poll loop just walks the array.
 */
export function backoffDelays(opts: {
  initialMs: number;
  factor: number;
  capMs: number;
  deadlineMs: number;
}): number[] {
  const delays: number[] = [];
  let next = opts.initialMs;
  let total = 0;
  while (total + next <= opts.deadlineMs) {
    delays.push(next);
    total += next;
    next = Math.min(Math.round(next * opts.factor), opts.capMs);
  }
  return delays;
}

/** Numeric port of a parsed engine base URL, for restart pinning. */
export function portOf(baseUrl: string): number | undefined {
  try {
    const port = Number(new URL(baseUrl).port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

/** SIGINT → grace → SIGTERM → grace → SIGKILL; resolves with the exit code. */
async function stopEngine(
  handle: EngineHandle,
  deps: Pick<LauncherDeps, 'sleep'>,
  timing: LauncherTiming,
): Promise<number> {
  handle.kill('SIGINT');
  const afterInt = await Promise.race([
    handle.exited,
    deps.sleep(timing.sigintGraceMs).then(() => null),
  ]);
  if (afterInt !== null) return afterInt;
  handle.kill('SIGTERM');
  const afterTerm = await Promise.race([
    handle.exited,
    deps.sleep(timing.sigtermGraceMs).then(() => null),
  ]);
  if (afterTerm !== null) return afterTerm;
  handle.kill('SIGKILL');
  return handle.exited;
}

export async function runLauncher(deps: LauncherDeps): Promise<number> {
  const timing: LauncherTiming = { ...DEFAULT_TIMING, ...deps.timing };

  if (!(await deps.webDistExists())) {
    deps.log('[launcher] web dist missing — building it (first run)');
    const buildCode = await deps.buildWeb();
    if (buildCode !== 0) {
      deps.log(`[launcher] web build failed (exit ${buildCode})`);
      return buildCode;
    }
  }

  // Forward operator signals to whichever engine is current, so Ctrl+C
  // works during boot, after ready, and across a restart.
  let currentHandle: EngineHandle | undefined;
  let signalled = false;
  deps.onSignal((signal) => {
    if (signalled) return;
    signalled = true;
    deps.log(`[launcher] ${signal} — stopping engine`);
    if (currentHandle) void stopEngine(currentHandle, deps, timing);
  });

  type BootOutcome =
    | { kind: 'ready'; handle: EngineHandle; baseUrl: string }
    | { kind: 'gone'; code: number };

  // The readiness gate: spawn → listen line → /health backoff. Shared by
  // the first boot and the restart path (decision 6 in the PR #22 plan).
  const bootEngine = async (opts: { port?: number }): Promise<BootOutcome> => {
    if (signalled) return { kind: 'gone', code: 130 };

    let resolveUrl: (url: string) => void = () => {};
    const urlPromise = new Promise<string>((resolve) => {
      resolveUrl = resolve;
    });
    const handle = deps.spawnEngine(
      (line) => {
        const url = parseListenLine(line);
        if (url !== null) resolveUrl(url);
      },
      opts.port !== undefined ? { port: opts.port } : undefined,
    );
    currentHandle = handle;

    type Boot =
      | { kind: 'url'; url: string }
      | { kind: 'exited'; code: number }
      | { kind: 'timeout' };
    const boot: Boot = await Promise.race([
      urlPromise.then((url): Boot => ({ kind: 'url', url })),
      handle.exited.then((code): Boot => ({ kind: 'exited', code })),
      deps.sleep(timing.listenDeadlineMs).then((): Boot => ({ kind: 'timeout' })),
    ]);
    if (boot.kind === 'exited') {
      deps.log(`[launcher] engine exited during startup (exit ${boot.code})`);
      return { kind: 'gone', code: boot.code !== 0 ? boot.code : 1 };
    }
    if (boot.kind === 'timeout') {
      deps.log('[launcher] engine never reported a listen address — giving up');
      await stopEngine(handle, deps, timing);
      return { kind: 'gone', code: 1 };
    }
    const baseUrl = boot.url;

    const delays = backoffDelays({
      initialMs: timing.backoffInitialMs,
      factor: timing.backoffFactor,
      capMs: timing.backoffCapMs,
      deadlineMs: timing.healthDeadlineMs,
    });
    let healthy = false;
    for (let attempt = 0; ; attempt++) {
      try {
        if ((await deps.fetchHealth(baseUrl)) === 200) {
          healthy = true;
          break;
        }
      } catch {
        // network error — engine not accepting connections yet; retry.
      }
      const delay = delays[attempt];
      if (delay === undefined) break;
      await deps.sleep(delay);
    }
    if (!healthy) {
      if (!signalled) {
        deps.log(
          `[launcher] /health never came up within ${timing.healthDeadlineMs}ms — giving up`,
        );
        await stopEngine(handle, deps, timing);
        return { kind: 'gone', code: 1 };
      }
      return { kind: 'gone', code: await handle.exited };
    }
    return { kind: 'ready', handle, baseUrl };
  };

  const first = await bootEngine({});
  if (first.kind === 'gone') return first.code;

  deps.log(`[launcher] ready — ${first.baseUrl}`);
  await deps.openBrowser(first.baseUrl);

  // Supervisor: the launcher lives as long as the engine does. Death
  // after ready without an operator signal gets exactly one restart on
  // the pinned port (the open tab's origin survives; the web client's
  // reconnect loop takes over — no second browser open). A second death,
  // or death during the restart's boot, propagates.
  // TODO(restart-policy) — budgets/windows beyond once-per-lifetime.
  const firstExit = await first.handle.exited;
  if (signalled) return firstExit;
  // Clean exit (0) is a deliberate shutdown, not a crash — propagate it.
  if (firstExit === 0) return firstExit;

  const port = portOf(first.baseUrl);
  deps.log(`[launcher] engine exited unexpectedly (exit ${firstExit}) — restarting once`);
  const second = await bootEngine(port !== undefined ? { port } : {});
  if (second.kind === 'gone') return second.code;

  deps.log(`[launcher] engine back — ${second.baseUrl}`);
  return second.handle.exited;
}
