import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { RealClaudeBackend } from '../src/real.ts';
import type { BackendEvent } from '../src/types.ts';

/**
 * Unit tests for RealClaudeBackend — hermetic, no real CLI dependency. Each
 * test builds a temp dir of synthetic shims (tiny bash scripts) and points
 * the backend at them via either an absolute path or a controlled PATH.
 *
 * Spec: plans/landed/2026-04-23-clod-ui-pr2-health-probe-v1.md §2.
 */

type Shim = { stdout?: string; stderr?: string; exitCode?: number; sleepMs?: number };

function writeShim(dir: string, name: string, spec: Shim): string {
  const fullPath = join(dir, name);
  const lines = ['#!/usr/bin/env bash'];
  if (spec.sleepMs && spec.sleepMs > 0) {
    // bash `sleep` takes seconds; support fractional for short sleeps.
    lines.push(`sleep ${spec.sleepMs / 1000}`);
  }
  if (spec.stderr) lines.push(`printf %s ${JSON.stringify(spec.stderr)} 1>&2`);
  if (spec.stdout) lines.push(`printf %s ${JSON.stringify(spec.stdout)}`);
  lines.push(`exit ${spec.exitCode ?? 0}`);
  writeFileSync(fullPath, lines.join('\n') + '\n');
  chmodSync(fullPath, 0o755);
  return fullPath;
}

let shimDir: string;

beforeEach(() => {
  shimDir = mkdtempSync(join(tmpdir(), 'clod-ui-real-backend-'));
});

afterEach(() => {
  rmSync(shimDir, { recursive: true, force: true });
});

describe('RealClaudeBackend.health', () => {
  test('absolute path to nonexistent binary → cli: "missing"', async () => {
    const be = new RealClaudeBackend({
      claudeBinary: join(shimDir, 'nonexistent-claude'),
    });
    try {
      await (be as unknown as { refresh(): Promise<void> }).refresh();
      expect(await be.health()).toEqual({ cli: 'missing' });
    } finally {
      await be.stop();
    }
  });

  test('PATH without claude → cli: "missing"', async () => {
    const emptyDir = join(shimDir, 'empty');
    mkdirSync(emptyDir);
    const be = new RealClaudeBackend({
      claudeBinary: 'claude',
      env: { PATH: emptyDir },
    });
    try {
      await (be as unknown as { refresh(): Promise<void> }).refresh();
      expect(await be.health()).toEqual({ cli: 'missing' });
    } finally {
      await be.stop();
    }
  });

  test('ok shim with matching version → cli: "ok" with parsed version', async () => {
    const shim = writeShim(shimDir, 'claude', {
      stdout: '2.1.118 (Claude Code)\n',
      exitCode: 0,
    });
    const be = new RealClaudeBackend({ claudeBinary: shim });
    try {
      await (be as unknown as { refresh(): Promise<void> }).refresh();
      expect(await be.health()).toEqual({ cli: 'ok', version: '2.1.118' });
      expect(await be.version()).toBe('2.1.118');
    } finally {
      await be.stop();
    }
  });

  test('shim that exits non-zero → cli: "crashed"', async () => {
    const shim = writeShim(shimDir, 'claude', {
      stderr: 'kaboom',
      exitCode: 1,
    });
    const be = new RealClaudeBackend({ claudeBinary: shim });
    try {
      await (be as unknown as { refresh(): Promise<void> }).refresh();
      expect(await be.health()).toEqual({ cli: 'crashed' });
    } finally {
      await be.stop();
    }
  });

  test('shim that exceeds probeTimeoutMs → cli: "crashed"', async () => {
    const shim = writeShim(shimDir, 'claude', {
      stdout: '2.1.118\n',
      sleepMs: 500,
      exitCode: 0,
    });
    const be = new RealClaudeBackend({
      claudeBinary: shim,
      probeTimeoutMs: 50,
    });
    try {
      await (be as unknown as { refresh(): Promise<void> }).refresh();
      expect((await be.health()).cli).toBe('crashed');
    } finally {
      await be.stop();
    }
  });

  test('shim with unparseable stdout → cli: "crashed"', async () => {
    const shim = writeShim(shimDir, 'claude', {
      stdout: 'banana phone\n',
      exitCode: 0,
    });
    const be = new RealClaudeBackend({ claudeBinary: shim });
    try {
      await (be as unknown as { refresh(): Promise<void> }).refresh();
      expect((await be.health()).cli).toBe('crashed');
    } finally {
      await be.stop();
    }
  });

  test('health() returns the cached value within staleAfterMs without re-probing', async () => {
    const shim = writeShim(shimDir, 'claude', {
      stdout: '9.9.9\n',
      exitCode: 0,
    });
    const be = new RealClaudeBackend({
      claudeBinary: shim,
      staleAfterMs: 60_000, // ensure no background refresh during the test
    });
    try {
      await (be as unknown as { refresh(): Promise<void> }).refresh();
      const firstAt = be.lastProbedAt;
      expect(firstAt).toBeGreaterThan(0);
      await be.health();
      await be.health();
      await be.health();
      expect(be.lastProbedAt).toBe(firstAt);
    } finally {
      await be.stop();
    }
  });

  test('start() kicks an immediate probe and stop() is idempotent', async () => {
    const shim = writeShim(shimDir, 'claude', {
      stdout: '3.3.3\n',
      exitCode: 0,
    });
    const be = new RealClaudeBackend({
      claudeBinary: shim,
      refreshIntervalMs: 10_000,
    });
    be.start();
    be.start(); // idempotent
    // Wait for the fire-and-forget initial probe to resolve.
    await (be as unknown as { refresh(): Promise<void> }).refresh();
    expect((await be.health()).cli).toBe('ok');
    await be.stop();
    await be.stop(); // idempotent
  });
});

describe('RealClaudeBackend.startTurn (via shim)', () => {
  // ---- shim helpers ------------------------------------------------------
  // A shim is a bash script that emits canned stream-JSON lines on stdout,
  // optionally drains stdin (to mimic the real CLI's behavior of waiting for
  // EOF before emitting), optionally sleeps, and exits with a given code.

  type TurnShim = {
    /** Lines written to stdout BEFORE any sleep. Useful as a "I've spawned" marker. */
    preSleepStdoutLines?: string[];
    /** Lines written to stdout, joined with \n and terminated by \n. */
    stdoutLines?: string[];
    /** Bytes written to stderr before exit. */
    stderr?: string;
    /** Exit code. Default 0. */
    exitCode?: number;
    /** If set, `sleep <ms>/1000` after stdin drain, before emitting stdout. */
    sleepMs?: number;
  };

  function writeTurnShim(dir: string, spec: TurnShim): string {
    const fullPath = join(dir, 'claude');
    const lines = ['#!/usr/bin/env bash', 'set -eu'];
    // Drain stdin into /dev/null so the child mimics the CLI: it reads the
    // stream-JSON payload to EOF before it starts producing output.
    lines.push('cat >/dev/null');
    for (const line of spec.preSleepStdoutLines ?? []) {
      lines.push(`printf '%s\\n' ${JSON.stringify(line)}`);
    }
    if (spec.sleepMs && spec.sleepMs > 0) {
      lines.push(`sleep ${spec.sleepMs / 1000}`);
    }
    for (const line of spec.stdoutLines ?? []) {
      // printf %s\n keeps the exact JSON untouched.
      lines.push(`printf '%s\\n' ${JSON.stringify(line)}`);
    }
    if (spec.stderr) lines.push(`printf %s ${JSON.stringify(spec.stderr)} 1>&2`);
    lines.push(`exit ${spec.exitCode ?? 0}`);
    writeFileSync(fullPath, lines.join('\n') + '\n');
    chmodSync(fullPath, 0o755);
    return fullPath;
  }

  const req = {
    turn_id: 'turn-abc',
    conv_id: 'conv-xyz',
    user_message: 'hi',
    cwd: '/tmp',
  } as const;

  async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const ev of iter) out.push(ev);
    return out;
  }

  test('emits system.init → assistant.delta → turn.result with correct turn_id', async () => {
    const shim = writeTurnShim(shimDir, {
      stdoutLines: [
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          session_id: 'sess-1',
          cwd: '/tmp',
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'hello world' }],
          },
        }),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 3, output_tokens: 2 },
        }),
      ],
    });
    const be = new RealClaudeBackend({ claudeBinary: shim });
    try {
      // Seed the health cache so startTurn doesn't short-circuit as `missing`.
      await (be as unknown as { refresh(): Promise<void> }).refresh();
      const events = await collect(be.startTurn(req));
      expect(events.length).toBe(3);
      expect(events[0]).toEqual({ kind: 'system.init', turn_id: 'turn-abc', session_id: 'sess-1' });
      expect(events[1]).toEqual({
        kind: 'assistant.delta',
        turn_id: 'turn-abc',
        text: 'hello world',
      });
      expect(events[2]).toEqual({
        kind: 'turn.result',
        turn_id: 'turn-abc',
        usage: { input_tokens: 3, output_tokens: 2 },
      });
    } finally {
      await be.stop();
    }
  });

  test('tool_use → tool_result flow roundtrips through parser', async () => {
    const shim = writeTurnShim(shimDir, {
      stdoutLines: [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-2' }),
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { path: '/x' } }],
          },
        }),
        JSON.stringify({
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'file body' }],
          },
        }),
        JSON.stringify({ type: 'result', subtype: 'success' }),
      ],
    });
    const be = new RealClaudeBackend({ claudeBinary: shim });
    try {
      await (be as unknown as { refresh(): Promise<void> }).refresh();
      const events = await collect(be.startTurn(req));
      expect(events.map((e) => e.kind)).toEqual([
        'system.init',
        'tool.use',
        'tool.result',
        'turn.result',
      ]);
      const toolUse = events[1] as Extract<(typeof events)[number], { kind: 'tool.use' }>;
      expect(toolUse.tool_use_id).toBe('tu-1');
      expect(toolUse.name).toBe('Read');
    } finally {
      await be.stop();
    }
  });

  test('non-zero exit without result line yields synthesized turn.error{cli_crashed}', async () => {
    const shim = writeTurnShim(shimDir, {
      stdoutLines: [JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' })],
      stderr: 'uh oh',
      exitCode: 2,
    });
    const be = new RealClaudeBackend({ claudeBinary: shim });
    try {
      await (be as unknown as { refresh(): Promise<void> }).refresh();
      const events = await collect(be.startTurn(req));
      // [system.init, turn.error]
      expect(events.length).toBe(2);
      expect(events[0]?.kind).toBe('system.init');
      const err = events[1] as Extract<(typeof events)[number], { kind: 'turn.error' }>;
      expect(err.kind).toBe('turn.error');
      expect(err.error.kind).toBe('cli_crashed');
      if (err.error.kind === 'cli_crashed') {
        expect(err.error.exit_code).toBe(2);
        expect(err.error.raw_stderr).toContain('uh oh');
      }
    } finally {
      await be.stop();
    }
  });

  test('binary missing (cached health=missing) short-circuits to turn.error{cli_missing}', async () => {
    // Use a nonexistent absolute path so resolveBinary returns null.
    const nonexistent = join(shimDir, 'nonexistent-claude');
    const be = new RealClaudeBackend({ claudeBinary: nonexistent });
    try {
      await (be as unknown as { refresh(): Promise<void> }).refresh();
      // Health is now cached as `missing` — startTurn must short-circuit.
      const events = await collect(be.startTurn(req));
      expect(events.length).toBe(1);
      expect(events[0]?.kind).toBe('turn.error');
      const err = events[0] as Extract<(typeof events)[number], { kind: 'turn.error' }>;
      expect(err.error.kind).toBe('cli_missing');
    } finally {
      await be.stop();
    }
  });

  test('cancel() during a sleeping turn terminates the subprocess within budget', async () => {
    // Shim emits a "I'm alive" init line BEFORE the sleep so the test can
    // synchronise cancel() against the actual subprocess having spawned and
    // been registered in `active` — a fixed-delay setTimeout is flaky under
    // test-suite load.
    const shim = writeTurnShim(shimDir, {
      preSleepStdoutLines: [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sleepy' }),
      ],
      sleepMs: 5000,
    });
    // Keep probeTimeoutMs short — the same shim answers `--version` by
    // draining stdin + emitting the init line (not a version string) +
    // sleeping; we need the probe to bail fast.
    const be = new RealClaudeBackend({
      claudeBinary: shim,
      probeTimeoutMs: 150,
      graceTermMs: 50,
      graceKillMs: 50,
    });
    try {
      await (be as unknown as { refresh(): Promise<void> }).refresh();
      // Health is `crashed` (probe timed out) — importantly NOT `missing`,
      // so startTurn doesn't short-circuit.
      expect((await be.health()).cli).toBe('crashed');
      const iter = be.startTurn(req);
      const collected: BackendEvent[] = [];
      let sawInit = false;
      const consumer = (async () => {
        for await (const ev of iter) {
          collected.push(ev);
          if (ev.kind === 'system.init') sawInit = true;
        }
      })();
      // Spin until the init event actually arrived. Bounded so a bug can't hang.
      const spinDeadline = Date.now() + 2000;
      while (!sawInit && Date.now() < spinDeadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(sawInit).toBe(true);
      const cancelStart = Date.now();
      await be.cancel(req.turn_id);
      await Promise.race([
        consumer,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('cancel did not terminate in 2s')), 2000),
        ),
      ]);
      const elapsed = Date.now() - cancelStart;
      expect(elapsed).toBeLessThan(2000);
      // Terminal envelope must be turn.cancelled (bash `sleep` dies on SIGINT).
      const last = collected[collected.length - 1];
      expect(last?.kind).toBe('turn.cancelled');
      if (last?.kind === 'turn.cancelled') {
        expect(last.escalation).toBe('sigint');
      }
    } finally {
      await be.stop();
    }
  }, 15_000);

  test('cancel() on unknown turn_id is a silent no-op', async () => {
    const be = new RealClaudeBackend({ claudeBinary: '/bin/true' });
    try {
      await be.cancel('never-started');
    } finally {
      await be.stop();
    }
  });
});

describe('RealClaudeBackend cancel ladder', () => {
  /**
   * Ladder shim: drains stdin, emits a marker init line, then busy-loops on
   * the bash `$SECONDS` builtin. Crucially, the busy loop contains NO
   * subprocess calls — which means the only signal delivery path is bash's
   * own handler. With `trap '' INT/TERM`, bash ignores those signals and
   * the loop continues; SIGKILL is always uncatchable and terminates bash
   * immediately. This gives deterministic per-signal behavior that a
   * `sleep` subprocess could never provide (sleep dies on SIGINT/SIGTERM
   * regardless of parent bash's traps).
   *
   * Total loop budget: 3s. Tests escalate within 500ms so this is a
   * hard-cap safety net, not the primary timing mechanism.
   */
  function writeLadderShim(
    dir: string,
    opts: { ignoreSigint?: boolean; ignoreSigterm?: boolean },
  ): string {
    const fullPath = join(dir, 'claude');
    const lines = ['#!/usr/bin/env bash', 'set -u'];
    lines.push('cat >/dev/null &'); // drain stdin in background
    lines.push('STDIN_PID=$!');
    if (opts.ignoreSigint) lines.push("trap '' INT");
    if (opts.ignoreSigterm) lines.push("trap '' TERM");
    lines.push('printf \'%s\\n\' \'{"type":"system","subtype":"init","session_id":"ladder"}\'');
    // Pure-bash busy loop: $SECONDS is a builtin, no subprocess calls.
    lines.push('SECONDS=0');
    lines.push('while [ $SECONDS -lt 3 ]; do :; done');
    lines.push('kill $STDIN_PID 2>/dev/null || true');
    lines.push('exit 0');
    writeFileSync(fullPath, lines.join('\n') + '\n');
    chmodSync(fullPath, 0o755);
    return fullPath;
  }

  const req = {
    turn_id: 'turn-ladder',
    conv_id: 'conv-ladder',
    user_message: 'hi',
    cwd: '/tmp',
  } as const;

  async function runAndCancel(
    shim: string,
    opts: { graceTermMs: number; graceKillMs: number; preCancelDelayMs?: number },
  ): Promise<{ events: BackendEvent[]; elapsed: number }> {
    const be = new RealClaudeBackend({
      claudeBinary: shim,
      probeTimeoutMs: 150,
      graceTermMs: opts.graceTermMs,
      graceKillMs: opts.graceKillMs,
    });
    try {
      await (be as unknown as { refresh(): Promise<void> }).refresh();
      const iter = be.startTurn(req);
      const events: BackendEvent[] = [];
      let sawInit = false;
      const consumer = (async () => {
        for await (const ev of iter) {
          events.push(ev);
          if (ev.kind === 'system.init') sawInit = true;
        }
      })();
      // Spin until init marker — the consumer loop must have registered the
      // subprocess in `active` before cancel has any meaning.
      const spinDeadline = Date.now() + 3000;
      while (!sawInit && Date.now() < spinDeadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(sawInit).toBe(true);
      if (opts.preCancelDelayMs) {
        await new Promise((r) => setTimeout(r, opts.preCancelDelayMs));
      }
      const cancelStart = Date.now();
      await be.cancel(req.turn_id);
      await Promise.race([
        consumer,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('cancel did not terminate in 5s')), 5000),
        ),
      ]);
      return { events, elapsed: Date.now() - cancelStart };
    } finally {
      await be.stop();
    }
  }

  test('honors SIGINT → escalation=sigint, exits promptly', async () => {
    const shim = writeLadderShim(shimDir, {});
    // Use big grace timers so even under heavy load we don't accidentally
    // race SIGTERM. The escalation level is the authoritative signal here,
    // not wall-clock elapsed.
    const { events } = await runAndCancel(shim, {
      graceTermMs: 2000,
      graceKillMs: 2000,
    });
    const last = events[events.length - 1];
    expect(last?.kind).toBe('turn.cancelled');
    if (last?.kind === 'turn.cancelled') {
      expect(last.escalation).toBe('sigint');
    }
  }, 15_000);

  test('ignores SIGINT, honors SIGTERM → escalation=sigterm', async () => {
    const shim = writeLadderShim(shimDir, { ignoreSigint: true });
    const { events, elapsed } = await runAndCancel(shim, {
      graceTermMs: 100,
      graceKillMs: 500,
    });
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(600); // escalated to SIGTERM but not SIGKILL
    const last = events[events.length - 1];
    expect(last?.kind).toBe('turn.cancelled');
    if (last?.kind === 'turn.cancelled') {
      expect(last.escalation).toBe('sigterm');
    }
  }, 15_000);

  test('ignores SIGINT + SIGTERM → escalation=sigkill', async () => {
    const shim = writeLadderShim(shimDir, {
      ignoreSigint: true,
      ignoreSigterm: true,
    });
    const { events, elapsed } = await runAndCancel(shim, {
      graceTermMs: 80,
      graceKillMs: 80,
    });
    expect(elapsed).toBeGreaterThanOrEqual(160); // reached SIGKILL timer
    expect(elapsed).toBeLessThan(1500);
    const last = events[events.length - 1];
    expect(last?.kind).toBe('turn.cancelled');
    if (last?.kind === 'turn.cancelled') {
      expect(last.escalation).toBe('sigkill');
    }
  }, 15_000);

  test('double-cancel is idempotent', async () => {
    const shim = writeLadderShim(shimDir, {});
    const be = new RealClaudeBackend({
      claudeBinary: shim,
      probeTimeoutMs: 150,
      graceTermMs: 500,
      graceKillMs: 500,
    });
    try {
      await (be as unknown as { refresh(): Promise<void> }).refresh();
      const iter = be.startTurn(req);
      const events: BackendEvent[] = [];
      let sawInit = false;
      const consumer = (async () => {
        for await (const ev of iter) {
          events.push(ev);
          if (ev.kind === 'system.init') sawInit = true;
        }
      })();
      const spinDeadline = Date.now() + 3000;
      while (!sawInit && Date.now() < spinDeadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(sawInit).toBe(true);
      // Two immediate cancels — second should be a silent no-op.
      await be.cancel(req.turn_id);
      await be.cancel(req.turn_id);
      await Promise.race([
        consumer,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('cancel did not terminate')), 3000),
        ),
      ]);
      // Only one terminal envelope.
      const terminalCount = events.filter(
        (e) => e.kind === 'turn.cancelled' || e.kind === 'turn.result' || e.kind === 'turn.error',
      ).length;
      expect(terminalCount).toBe(1);
    } finally {
      await be.stop();
    }
  }, 15_000);

  test('cancel before startTurn is a silent no-op', async () => {
    const be = new RealClaudeBackend({ claudeBinary: '/bin/true' });
    try {
      // No turn started — cancel(unknown) must not crash or register state.
      await be.cancel(req.turn_id);
      // Sanity: calling again is also a no-op.
      await be.cancel(req.turn_id);
    } finally {
      await be.stop();
    }
  });
});
