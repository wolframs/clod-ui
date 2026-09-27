import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { encodeCwd, TranscriptWatcher } from '../src/index.ts';
import type { TimerLike, TranscriptUpdatedEvent } from '../src/index.ts';

const CONV_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = 'sess-watcher-A';

interface Fixture {
  root: string;
  projectsDir: string;
  cwd: string;
  filePath: string;
  events: TranscriptUpdatedEvent[];
}

function setupFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'clod-ui-transcript-'));
  const projectsDir = join(root, 'fake-claude-home', 'projects');
  // The watcher's `cwd` is the *conversation* cwd; it doesn't need to actually
  // exist on disk for the watcher to function — only the encoded path under
  // `projectsDir` matters.
  const cwd = join(root, 'conv-cwd');
  const fileDir = join(projectsDir, encodeCwd(cwd));
  const filePath = join(fileDir, `${SESSION_ID}.jsonl`);
  return { root, projectsDir, cwd, filePath, events: [] };
}

function teardown(f: Fixture): void {
  rmSync(f.root, { recursive: true, force: true });
}

function makeWatcher(
  f: Fixture,
  opts: Partial<{ pollIntervalMs: number; debounceMs: number }> = {},
) {
  return new TranscriptWatcher({
    conv_id: CONV_ID,
    session_id: SESSION_ID,
    cwd: f.cwd,
    projectsDir: f.projectsDir,
    pollIntervalMs: opts.pollIntervalMs ?? 5,
    debounceMs: opts.debounceMs ?? 1,
    onUpdate: (e) => f.events.push(e),
  });
}

describe('TranscriptWatcher — tail semantics', () => {
  let f: Fixture;

  beforeEach(() => {
    f = setupFixture();
  });

  afterEach(() => {
    teardown(f);
  });

  test('emits batches for appended lines without duplicates', async () => {
    mkdirSync(join(f.projectsDir, encodeCwd(f.cwd)), { recursive: true });
    writeFileSync(f.filePath, '');
    const w = makeWatcher(f);
    w.start();

    appendFileSync(f.filePath, '{"a":1}\n{"a":2}\n');
    await w.tickNow({ flush: true });

    expect(f.events).toHaveLength(1);
    expect(f.events[0]?.lines.map((l) => l.line_number)).toEqual([0, 1]);
    expect(f.events[0]?.lines[0]?.raw).toEqual({ a: 1 });
    expect(f.events[0]?.lines[1]?.raw).toEqual({ a: 2 });

    appendFileSync(f.filePath, '{"a":3}\n{"a":4}\n');
    await w.tickNow({ flush: true });

    expect(f.events).toHaveLength(2);
    expect(f.events[1]?.lines.map((l) => l.line_number)).toEqual([2, 3]);

    // Second tick with no new bytes is a no-op.
    await w.tickNow({ flush: true });
    expect(f.events).toHaveLength(2);

    await w.stop();
  });

  test('picks up files that appear after watcher start', async () => {
    const w = makeWatcher(f);
    w.start();

    // Tick once with no file yet — must be a no-op, no events.
    await w.tickNow({ flush: true });
    expect(f.events).toHaveLength(0);

    mkdirSync(join(f.projectsDir, encodeCwd(f.cwd)), { recursive: true });
    writeFileSync(f.filePath, '{"hello":"world"}\n');
    await w.tickNow({ flush: true });

    expect(f.events).toHaveLength(1);
    expect(f.events[0]?.lines).toHaveLength(1);
    expect(f.events[0]?.lines[0]?.line_number).toBe(0);
    expect(f.events[0]?.lines[0]?.raw).toEqual({ hello: 'world' });

    await w.stop();
  });

  test('parse errors travel with the line and do not stop the watcher', async () => {
    mkdirSync(join(f.projectsDir, encodeCwd(f.cwd)), { recursive: true });
    writeFileSync(f.filePath, '{not valid json}\n{"ok":true}\n');
    const w = makeWatcher(f);
    w.start();
    await w.tickNow({ flush: true });

    expect(f.events).toHaveLength(1);
    const lines = f.events[0]!.lines;
    expect(lines).toHaveLength(2);
    expect(lines[0]?.parse_error?.raw_text).toBe('{not valid json}');
    expect(lines[0]?.raw).toBeNull();
    expect(lines[1]?.raw).toEqual({ ok: true });

    await w.stop();
  });

  test('partial trailing line waits for completion', async () => {
    mkdirSync(join(f.projectsDir, encodeCwd(f.cwd)), { recursive: true });
    writeFileSync(f.filePath, '{"a":1}\n{"b":');
    const w = makeWatcher(f);
    w.start();
    await w.tickNow({ flush: true });

    expect(f.events).toHaveLength(1);
    expect(f.events[0]?.lines).toHaveLength(1);
    expect(f.events[0]?.lines[0]?.raw).toEqual({ a: 1 });

    appendFileSync(f.filePath, '2}\n');
    await w.tickNow({ flush: true });

    expect(f.events).toHaveLength(2);
    expect(f.events[1]?.lines).toHaveLength(1);
    expect(f.events[1]?.lines[0]?.line_number).toBe(1);
    expect(f.events[1]?.lines[0]?.raw).toEqual({ b: 2 });

    await w.stop();
  });

  test('stop is idempotent', async () => {
    const w = makeWatcher(f);
    w.start();
    await w.stop();
    await w.stop(); // does not throw
  });
});

describe('TranscriptWatcher — debounce coalescing (deterministic)', () => {
  let f: Fixture;

  beforeEach(() => {
    f = setupFixture();
  });

  afterEach(() => {
    teardown(f);
  });

  test('multiple ticks within the debounce window collapse into one onUpdate', async () => {
    // We control the timer source: timers never fire on their own. We drive
    // tickNow() three times and then advance time past the debounce window
    // by manually firing the most recently-scheduled timeout.
    const scheduled: Array<{ id: number; fn: () => void; ms: number }> = [];
    let nextId = 1;
    const timers: TimerLike = {
      setTimeout: (fn, ms) => {
        const id = nextId++;
        scheduled.push({ id, fn, ms });
        return id;
      },
      clearTimeout: (handle) => {
        const idx = scheduled.findIndex((s) => s.id === handle);
        if (idx >= 0) scheduled.splice(idx, 1);
      },
      setInterval: () => 0,
      clearInterval: () => {},
      now: () => 0,
    };

    mkdirSync(join(f.projectsDir, encodeCwd(f.cwd)), { recursive: true });
    writeFileSync(f.filePath, '');
    const w = new TranscriptWatcher({
      conv_id: CONV_ID,
      session_id: SESSION_ID,
      cwd: f.cwd,
      projectsDir: f.projectsDir,
      pollIntervalMs: 1000, // never fires on its own (no setInterval running)
      debounceMs: 50,
      timers,
      onUpdate: (e) => f.events.push(e),
    });
    w.start();

    // Three ticks within the debounce window: each schedules / reschedules
    // a single pending timeout. No onUpdate should fire yet.
    appendFileSync(f.filePath, '{"a":1}\n');
    await w.tickNow();
    appendFileSync(f.filePath, '{"a":2}\n');
    await w.tickNow();
    appendFileSync(f.filePath, '{"a":3}\n');
    await w.tickNow();

    expect(f.events).toHaveLength(0);
    // Only one debounce timeout outstanding (each tick clears + reschedules).
    expect(scheduled).toHaveLength(1);

    // Fire the debounce: one batch with all three lines.
    scheduled[0]!.fn();

    expect(f.events).toHaveLength(1);
    const lines = f.events[0]!.lines;
    expect(lines.map((l) => l.line_number)).toEqual([0, 1, 2]);
    expect(lines.map((l) => l.raw)).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);

    await w.stop();
  });
});
