import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { RealClaudeBackend } from '../src/real.ts';
import type { BackendEvent, TurnRequest } from '../src/types.ts';

/**
 * Warm processes (PR #39): one CLI process serves a conversation's turns.
 *
 * The shim mimics the real CLI's stream-json input mode (pinned by the PR #39
 * probe against CLI 2.1.310): it reads one user message per stdin line and
 * answers each with init → assistant → result, exiting on EOF. Every spawn
 * appends "<pid> <argv>" to a log so tests can count processes.
 *
 * Spec: plans/landed/2026-10-27-clod-ui-pr39-warm-sessions-v1.md.
 */

let dir: string;
let shim: string;
let spawnLog: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clod-ui-warm-'));
  spawnLog = join(dir, 'spawns.log');
  shim = join(dir, 'claude');
  writeFileSync(
    shim,
    [
      '#!/usr/bin/env bash',
      'if [[ "${1:-}" == "--version" ]]; then echo "2.1.310 (Claude Code)"; exit 0; fi',
      `echo "$$ $*" >> ${JSON.stringify(spawnLog)}`,
      'n=0',
      'while IFS= read -r line; do',
      '  n=$((n+1))',
      '  if [[ "$line" == *VERYSLOW* ]]; then sleep 1.5; elif [[ "$line" == *SLOW* ]]; then sleep 0.5; fi',
      `  printf '%s\\n' '{"type":"system","subtype":"init","session_id":"sess-1"}'`,
      '  if [[ "$line" == *BIGERR* ]]; then head -c 100000 /dev/zero | tr "\\0" x >&2; fi',
      '  if [[ "$line" == *FAIL* ]]; then',
      `    printf '%s\\n' '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"boom"}'`,
      '    continue',
      '  fi',
      `  printf '{"type":"assistant","message":{"content":[{"type":"text","text":"pid %s turn %s"}]}}\\n' "$$" "$n"`,
      `  printf '%s\\n' '{"type":"result","subtype":"success","usage":{"input_tokens":2,"cache_read_input_tokens":100}}'`,
      // TAIL: a late line after the result, the PR #40 stray case.
      '  if [[ "$line" == *TAIL* ]]; then',
      '    sleep 0.3',
      `    printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"STALE"}]}}'`,
      '  fi',
      'done',
    ].join('\n') + '\n',
  );
  chmodSync(shim, 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function spawns(): number[] {
  let body = '';
  try {
    body = readFileSync(spawnLog, 'utf8');
  } catch {
    return [];
  }
  return body
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => Number(l.split(' ')[0]));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await Bun.sleep(20);
  }
  return !alive(pid);
}

async function collect(iter: AsyncIterable<BackendEvent>): Promise<BackendEvent[]> {
  const out: BackendEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

async function backend(warmIdleMs: number): Promise<RealClaudeBackend> {
  const be = new RealClaudeBackend({ claudeBinary: shim, warmIdleMs });
  await (be as unknown as { refresh(): Promise<void> }).refresh();
  return be;
}

function turn(n: number, extra: Partial<TurnRequest> = {}): TurnRequest {
  return {
    turn_id: `t${n}`,
    conv_id: 'conv-1',
    user_message: `message ${n}`,
    cwd: dir,
    ...(n > 1 ? { resume_session_id: 'sess-1' } : {}),
    ...extra,
  };
}

function text(events: BackendEvent[]): string {
  return events
    .filter(
      (e): e is Extract<BackendEvent, { kind: 'assistant.delta' }> => e.kind === 'assistant.delta',
    )
    .map((e) => e.text)
    .join('');
}

describe('RealClaudeBackend warm processes', () => {
  test('second turn is written to the same process; argv reported for diagnostics', async () => {
    const be = await backend(60_000);
    try {
      const first = await collect(be.startTurn(turn(1)));
      expect(first.map((e) => e.kind)).toEqual(['system.init', 'assistant.delta', 'turn.result']);
      expect(first[2]).toMatchObject({ usage: { input_tokens: 2, cache_read_input_tokens: 100 } });

      const reused = be.reusableArgv(turn(2));
      expect(reused?.[0]).toBe(shim);
      expect(reused).not.toContain('--resume');

      const second = await collect(be.startTurn(turn(2)));
      expect(second.map((e) => e.kind)).toEqual(['system.init', 'assistant.delta', 'turn.result']);
      const [pid] = spawns();
      expect(spawns()).toHaveLength(1);
      expect(text(second)).toBe(`pid ${pid} turn 2`);
      expect(alive(pid!)).toBe(true);
    } finally {
      await be.stop();
    }
    expect(await waitDead(spawns()[0]!)).toBe(true);
  }, 15_000);

  test('warmIdleMs 0 keeps one process per turn', async () => {
    const be = await backend(0);
    try {
      await collect(be.startTurn(turn(1)));
      expect(be.reusableArgv(turn(2))).toBeUndefined();
      const second = await collect(be.startTurn(turn(2)));
      expect(spawns()).toHaveLength(2);
      expect(text(second)).toBe(`pid ${spawns()[1]} turn 1`);
    } finally {
      await be.stop();
    }
  }, 15_000);

  test('a control change respawns with --resume and retires the old process', async () => {
    const be = await backend(60_000);
    try {
      await collect(be.startTurn(turn(1)));
      expect(be.reusableArgv(turn(2, { model: 'opus' }))).toBeUndefined();
      await collect(be.startTurn(turn(2, { model: 'opus' })));
      const [first, second] = spawns();
      expect(spawns()).toHaveLength(2);
      expect(readFileSync(spawnLog, 'utf8')).toContain('--resume sess-1 --model opus');
      expect(await waitDead(first!)).toBe(true);
      expect(alive(second!)).toBe(true);
    } finally {
      await be.stop();
    }
  }, 15_000);

  test('a turn without a resume id never reuses (fresh-session semantics)', async () => {
    const be = await backend(60_000);
    try {
      await collect(be.startTurn(turn(1)));
      const { resume_session_id: _r, ...fresh } = turn(2);
      await collect(be.startTurn(fresh));
      expect(spawns()).toHaveLength(2);
    } finally {
      await be.stop();
    }
  }, 15_000);

  test('an attachment dir the warm process lacks respawns; a subset reuses', async () => {
    const be = await backend(60_000);
    const att = { path: join(dir, 'attachments', 'a.txt') };
    try {
      await collect(be.startTurn(turn(1)));
      await collect(be.startTurn(turn(2, { attachments: [att] })));
      expect(spawns()).toHaveLength(2);
      await collect(be.startTurn(turn(3)));
      expect(spawns()).toHaveLength(2);
    } finally {
      await be.stop();
    }
  }, 15_000);

  test('an error result retires the process', async () => {
    const be = await backend(60_000);
    try {
      const first = await collect(be.startTurn(turn(1, { user_message: 'FAIL please' })));
      expect(first.at(-1)?.kind).toBe('turn.error');
      expect(await waitDead(spawns()[0]!)).toBe(true);
      await collect(be.startTurn(turn(2)));
      expect(spawns()).toHaveLength(2);
    } finally {
      await be.stop();
    }
  }, 15_000);

  test('an idle process is retired after warmIdleMs', async () => {
    const be = await backend(100);
    try {
      await collect(be.startTurn(turn(1)));
      expect(await waitDead(spawns()[0]!)).toBe(true);
      expect(be.reusableArgv(turn(2))).toBeUndefined();
    } finally {
      await be.stop();
    }
  }, 15_000);

  test('cancel kills the warm process; the next turn spawns', async () => {
    const be = await backend(60_000);
    try {
      await collect(be.startTurn(turn(1)));
      const [pid] = spawns();
      // The shim answers instantly, so cancel lands between turns' lines:
      // start turn 2, cancel before draining, then drain to the terminator.
      const iter = be.startTurn(turn(2))[Symbol.asyncIterator]();
      const firstEv = await iter.next();
      expect(firstEv.value?.kind).toBe('system.init');
      await be.cancel('t2');
      const rest: BackendEvent[] = [];
      for (let r = await iter.next(); r.done !== true; r = await iter.next()) rest.push(r.value);
      expect(await waitDead(pid!)).toBe(true);
      await collect(be.startTurn(turn(3)));
      expect(spawns()).toHaveLength(2);
    } finally {
      await be.stop();
    }
  }, 15_000);

  // ---- PR #40 hardening --------------------------------------------------

  for (const [when, waitMs] of [
    ['while idle', 600],
    ['after the next message is sent', 50],
  ] as const) {
    test(`a late line from the previous turn arriving ${when} never reaches the next turn`, async () => {
      const be = await backend(60_000);
      try {
        await collect(be.startTurn(turn(1, { user_message: 'TAIL please' })));
        await Bun.sleep(waitMs);
        const second = await collect(be.startTurn(turn(2)));
        expect(text(second)).not.toContain('STALE');
        expect(second.map((e) => e.kind)).toEqual([
          'system.init',
          'assistant.delta',
          'turn.result',
        ]);
        expect(spawns()).toHaveLength(1);
      } finally {
        await be.stop();
      }
    }, 15_000);
  }

  test('a next turn started the moment turn.result arrives reuses, no collision', async () => {
    const be = await backend(60_000);
    try {
      let second: BackendEvent[] | undefined;
      for await (const ev of be.startTurn(turn(1))) {
        // Still inside the first generator's yield, as the engine is when it
        // broadcasts the terminator.
        if (ev.kind === 'turn.result') second = await collect(be.startTurn(turn(2)));
      }
      expect(second?.at(-1)?.kind).toBe('turn.result');
      expect(spawns()).toHaveLength(1);
    } finally {
      await be.stop();
    }
  }, 15_000);

  test('a second turn while the warm process is busy is refused, not forked', async () => {
    const be = await backend(60_000);
    try {
      await collect(be.startTurn(turn(1)));
      const slow = collect(be.startTurn(turn(2, { user_message: 'SLOW please' })));
      await Bun.sleep(100);
      const clash = await collect(be.startTurn(turn(3)));
      expect(clash).toHaveLength(1);
      expect(clash[0]).toMatchObject({ kind: 'turn.error', error: { kind: 'unknown' } });
      expect((await slow).at(-1)?.kind).toBe('turn.result');
      expect(spawns()).toHaveLength(1);
    } finally {
      await be.stop();
    }
  }, 15_000);

  test('stop() SIGKILLs a process that ignores EOF and SIGTERM, within the ladder', async () => {
    writeFileSync(
      shim,
      [
        '#!/usr/bin/env bash',
        'if [[ "${1:-}" == "--version" ]]; then echo "2.1.310 (Claude Code)"; exit 0; fi',
        `echo "$$ $*" >> ${JSON.stringify(spawnLog)}`,
        "trap '' TERM INT",
        'while true; do',
        '  if IFS= read -r line; then',
        `    printf '%s\\n' '{"type":"system","subtype":"init","session_id":"sess-1"}'`,
        `    printf '%s\\n' '{"type":"result","subtype":"success"}'`,
        '  else sleep 0.05; fi',
        'done',
      ].join('\n') + '\n',
    );
    const be = await backend(60_000);
    await collect(be.startTurn(turn(1)));
    const [pid] = spawns();
    const t0 = Date.now();
    await be.stop();
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(alive(pid!)).toBe(false);
  }, 15_000);

  test('warmMax retires the least recently used idle process', async () => {
    const be = new RealClaudeBackend({ claudeBinary: shim, warmIdleMs: 60_000, warmMax: 2 });
    await (be as unknown as { refresh(): Promise<void> }).refresh();
    try {
      for (const conv of ['a', 'b', 'c']) {
        await collect(be.startTurn({ ...turn(1), conv_id: conv, turn_id: `t-${conv}` }));
      }
      const [a, b, c] = spawns();
      expect(await waitDead(a!)).toBe(true);
      expect(alive(b!)).toBe(true);
      expect(alive(c!)).toBe(true);
    } finally {
      await be.stop();
    }
  }, 15_000);

  test('stderr kept per turn is capped to its last 64 KiB', async () => {
    const be = await backend(60_000);
    try {
      const events = await collect(be.startTurn(turn(1, { user_message: 'BIGERR FAIL' })));
      const err = events.at(-1);
      expect(err?.kind).toBe('turn.error');
      if (err?.kind === 'turn.error') {
        expect(err.error.raw_stderr?.length).toBe(64 * 1024);
      }
    } finally {
      await be.stop();
    }
  }, 15_000);

  // ---- PR #41 lifecycle edges --------------------------------------------

  test("a finished turn's late cleanup does not retire the next turn's process", async () => {
    const be = await backend(60_000);
    try {
      // Turn 1 suspended at its result, as the engine is while it broadcasts.
      const first = be.startTurn(turn(1))[Symbol.asyncIterator]();
      for (let r = await first.next(); r.value?.kind !== 'turn.result'; r = await first.next()) {
        expect(r.done).not.toBe(true);
      }
      // Turn 2 takes the process over and is in flight (longer than the
      // retirement ladder's EOF wait) when turn 1's finally finally runs.
      const second = collect(be.startTurn(turn(2, { user_message: 'VERYSLOW please' })));
      await Bun.sleep(50);
      expect((await first.next()).done).toBe(true);
      const events = await second;
      expect(events.at(-1)?.kind).toBe('turn.result');
      expect(spawns()).toHaveLength(1);
      expect(alive(spawns()[0]!)).toBe(true);
    } finally {
      await be.stop();
    }
  }, 15_000);

  test('stop() also kills descendants that ignore SIGTERM after the CLI exits on EOF', async () => {
    const childPidFile = join(dir, 'child.pid');
    writeFileSync(
      shim,
      [
        '#!/usr/bin/env bash',
        'if [[ "${1:-}" == "--version" ]]; then echo "2.1.310 (Claude Code)"; exit 0; fi',
        `echo "$$ $*" >> ${JSON.stringify(spawnLog)}`,
        // A descendant in the same process group that shrugs off SIGTERM.
        `bash -c 'trap "" TERM; echo $$ > ${childPidFile}; while true; do sleep 0.1; done' >/dev/null 2>&1 &`,
        'while IFS= read -r line; do',
        `  printf '%s\\n' '{"type":"system","subtype":"init","session_id":"sess-1"}'`,
        `  printf '%s\\n' '{"type":"result","subtype":"success"}'`,
        'done',
      ].join('\n') + '\n',
    );
    const be = await backend(60_000);
    let child = 0;
    try {
      await collect(be.startTurn(turn(1)));
      const [leader] = spawns();
      for (let i = 0; i < 100 && !existsSync(childPidFile); i++) await Bun.sleep(20);
      child = Number(readFileSync(childPidFile, 'utf8').trim());
      expect(alive(child)).toBe(true);
      const t0 = Date.now();
      await be.stop();
      expect(Date.now() - t0).toBeLessThan(4000);
      expect(alive(leader!)).toBe(false);
      expect(alive(child)).toBe(false);
    } finally {
      // Never leak the stubborn child, even when an assertion above failed.
      await be.stop();
      if (child > 0 && alive(child)) process.kill(child, 'SIGKILL');
    }
  }, 15_000);

  // ---- PR #43 (review: Sol) ----------------------------------------------

  test('raw flags that resume another session force a spawn instead of reuse', async () => {
    const be = await backend(60_000);
    try {
      await collect(be.startTurn(turn(1)));
      const raw = turn(2, { extra_argv: ['--resume', 's2'] });
      expect(be.reusableArgv(raw)).toBeUndefined();
      await collect(be.startTurn(raw));
      expect(spawns()).toHaveLength(2);
    } finally {
      await be.stop();
    }
  }, 15_000);

  /** A shim whose CLI leader leaves a SIGTERM-ignoring child in its group. */
  function writeLeakyShim(childPidFile: string, leaderExitsAfterTurn: boolean): void {
    writeFileSync(
      shim,
      [
        '#!/usr/bin/env bash',
        'if [[ "${1:-}" == "--version" ]]; then echo "2.1.310 (Claude Code)"; exit 0; fi',
        `echo "$$ $*" >> ${JSON.stringify(spawnLog)}`,
        `bash -c 'trap "" TERM; echo $$ > ${childPidFile}; while true; do sleep 0.1; done' >/dev/null 2>&1 &`,
        // Answer only once the child has its trap: a sweep must meet a real holdout.
        `while [ ! -s ${childPidFile} ]; do sleep 0.02; done`,
        'while IFS= read -r line; do',
        `  printf '%s\\n' '{"type":"system","subtype":"init","session_id":"sess-1"}'`,
        `  printf '%s\\n' '{"type":"result","subtype":"success"}'`,
        leaderExitsAfterTurn ? '  exit 0' : '  :',
        'done',
      ].join('\n') + '\n',
    );
  }

  async function childPid(file: string): Promise<number> {
    for (let i = 0; i < 100 && !existsSync(file); i++) await Bun.sleep(20);
    return Number(readFileSync(file, 'utf8').trim());
  }

  test('stop() waits for the group sweep of a leader that already exited', async () => {
    const childPidFile = join(dir, 'child.pid');
    writeLeakyShim(childPidFile, false);
    const be = await backend(0); // one-shot: the leader exits on EOF after the turn
    let child = 0;
    try {
      await collect(be.startTurn(turn(1)));
      child = await childPid(childPidFile);
      expect(await waitDead(spawns()[0]!)).toBe(true); // leader gone, child not
      await be.stop();
      expect(alive(child)).toBe(false);
    } finally {
      await be.stop();
      if (child > 0 && alive(child)) process.kill(child, 'SIGKILL');
    }
  }, 15_000);

  test('a warm leader that exits on its own has its group swept, stop() or not', async () => {
    const childPidFile = join(dir, 'child.pid');
    writeLeakyShim(childPidFile, true);
    const be = await backend(60_000);
    let child = 0;
    try {
      await collect(be.startTurn(turn(1)));
      child = await childPid(childPidFile);
      expect(await waitDead(child, 4000)).toBe(true);
    } finally {
      await be.stop();
      if (child > 0 && alive(child)) process.kill(child, 'SIGKILL');
    }
  }, 15_000);
});
