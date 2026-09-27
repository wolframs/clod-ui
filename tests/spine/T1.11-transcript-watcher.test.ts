/**
 * T1.11 — Transcript watcher.
 *
 * Contract: the engine watches Claude Code's per-session JSONL transcript at
 * `<CLAUDE_HOME>/projects/<encoded-cwd>/<session_id>.jsonl`, and emits
 * `transcript.updated` envelopes over the WebSocket whenever new lines
 * appear. The watcher:
 *   1. emits one batch per debounce window with the lines exactly as written;
 *   2. picks up files that materialize *after* `system.init` arrives;
 *   3. coalesces rapid bursts into a single batch.
 *
 * Implementation: PR #7 (plans/landed/2026-04-23-clod-ui-pr7-transcript-watcher-v1.md).
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ManifestStore } from '@clod-ui/manifest';
import { ScriptedBackend, TypedTestClient, script } from '@clod-ui/test-kit';
import { encodeCwd } from '@clod-ui/transcripts';
import type { TranscriptUpdatedEvent } from '@clod-ui/transcripts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { openDb } from '../../apps/engine/src/db/index.ts';
import { createApp } from '../../apps/engine/src/index.ts';

interface RunningEngine {
  server: ReturnType<typeof Bun.serve>;
  client: TypedTestClient;
  db: ReturnType<typeof openDb>;
  appDataDir: string;
  projectsDir: string;
}

async function bootEngine(opts: {
  appDataDir: string;
  projectsDir: string;
  sessionId: string;
  pollIntervalMs?: number;
  debounceMs?: number;
}): Promise<RunningEngine> {
  const built = script().init(opts.sessionId).assistantText('ok').result().end();
  const backend = new ScriptedBackend(built);
  const store = new ManifestStore(opts.appDataDir);
  const db = openDb({ path: join(opts.appDataDir, 'engine.sqlite') });
  const context = createApp({
    backend,
    store,
    db,
    transcripts: {
      projectsDir: opts.projectsDir,
      pollIntervalMs: opts.pollIntervalMs ?? 5,
      debounceMs: opts.debounceMs ?? 5,
    },
  });

  const sockets = new Set<WebSocket>();
  context.setBroadcast((envelope) => {
    const data = JSON.stringify(envelope);
    for (const ws of sockets) {
      try {
        ws.send(data);
      } catch {
        /* ignore */
      }
    }
  });

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req, srv) => {
      const u = new URL(req.url);
      if (u.pathname === '/ws') {
        const upgraded = srv.upgrade(req);
        if (upgraded) return undefined;
        return new Response('upgrade failed', { status: 400 });
      }
      return context.app.fetch(req);
    },
    websocket: {
      open: (ws) => {
        sockets.add(ws as unknown as WebSocket);
      },
      close: (ws) => {
        sockets.delete(ws as unknown as WebSocket);
      },
      message: () => {
        /* no framed client protocol yet */
      },
    },
  });

  const client = new TypedTestClient({ baseUrl: `http://127.0.0.1:${server.port}` });
  await client.connect();
  return { server, client, db, appDataDir: opts.appDataDir, projectsDir: opts.projectsDir };
}

async function shutdown(engine: RunningEngine): Promise<void> {
  await engine.client.close();
  engine.server.stop(true);
  engine.db.close();
}

/** Resolve the JSONL path the engine's watcher will tail for a given conv. */
function transcriptPathFor(args: {
  appDataDir: string;
  projectsDir: string;
  convId: string;
  sessionId: string;
}): string {
  // Engine roots a conv's cwd at `<appDataDir>/conversations/<convId>/cwd`.
  const cwd = join(args.appDataDir, 'conversations', args.convId, 'cwd');
  return join(args.projectsDir, encodeCwd(cwd), `${args.sessionId}.jsonl`);
}

describe('T1.11 transcript watcher', () => {
  let appDataDir: string;
  let projectsDir: string;
  let engine: RunningEngine | undefined;

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'clod-ui-t111-'));
    appDataDir = join(root, 'app-data');
    projectsDir = join(root, 'fake-claude-home', 'projects');
    mkdirSync(appDataDir, { recursive: true });
    mkdirSync(projectsDir, { recursive: true });
    engine = undefined;
  });

  afterEach(async () => {
    if (engine) await shutdown(engine);
    rmSync(appDataDir, { recursive: true, force: true });
    rmSync(projectsDir, { recursive: true, force: true });
  });

  test('emits updates for appended lines without duplicates', async () => {
    const sessionId = 'sess-T111-A';
    const convId = '11111111-1111-4111-8111-111111111111';
    engine = await bootEngine({ appDataDir, projectsDir, sessionId });

    // Submit a turn so the engine starts the watcher on system.init.
    await engine.client.submitTurn({ conv_id: convId, turn_id: 't-1', user_message: 'hi' });
    await engine.client.awaitEvent({ conv_id: convId, kind: 'turn.result' }, { timeout: 2000 });

    const transcriptPath = transcriptPathFor({ appDataDir, projectsDir, convId, sessionId });
    mkdirSync(join(transcriptPath, '..'), { recursive: true });

    // Round 1: write two lines and await one batch.
    writeFileSync(
      transcriptPath,
      '{"role":"user","content":"hello"}\n{"role":"assistant","content":"hi"}\n',
    );
    const ev1 = await engine.client.awaitEvent(
      { conv_id: convId, kind: 'transcript.updated' },
      { timeout: 2000 },
    );
    const payload1 = ev1.payload as TranscriptUpdatedEvent;
    expect(payload1.session_id).toBe(sessionId);
    expect(payload1.lines.map((l) => l.line_number)).toEqual([0, 1]);
    expect(payload1.lines[0]?.raw).toEqual({ role: 'user', content: 'hello' });
    expect(payload1.lines[1]?.raw).toEqual({ role: 'assistant', content: 'hi' });

    // Round 2: append two more lines, await a *second* batch with 2,3.
    appendFileSync(
      transcriptPath,
      '{"role":"user","content":"again"}\n{"role":"assistant","content":"ok"}\n',
    );
    const ev2 = await engine.client.awaitEvent(
      {
        conv_id: convId,
        kind: 'transcript.updated',
        predicate: (env) =>
          (env.payload as TranscriptUpdatedEvent).lines.some((l) => l.line_number === 2),
      },
      { timeout: 2000 },
    );
    const payload2 = ev2.payload as TranscriptUpdatedEvent;
    expect(payload2.lines.map((l) => l.line_number)).toEqual([2, 3]);

    // No line is double-emitted: collected events partition the line space.
    const allEnvs = engine.client.recordEvents(convId);
    const transcriptEvs = allEnvs.filter((e) => e.kind === 'transcript.updated');
    const seenLineNumbers = transcriptEvs.flatMap((e) =>
      (e.payload as TranscriptUpdatedEvent).lines.map((l) => l.line_number),
    );
    expect(seenLineNumbers).toEqual([0, 1, 2, 3]);
  });

  test('picks up files that appear after watcher start', async () => {
    const sessionId = 'sess-T111-B';
    const convId = '22222222-2222-4222-8222-222222222222';
    engine = await bootEngine({ appDataDir, projectsDir, sessionId });

    // Turn completes before any JSONL file exists. The watcher should be
    // started in awaiting-file state.
    await engine.client.submitTurn({ conv_id: convId, turn_id: 't-1', user_message: 'hi' });
    await engine.client.awaitEvent({ conv_id: convId, kind: 'turn.result' }, { timeout: 2000 });

    // Sanity: no transcript event has been emitted yet (the file does not exist).
    expect(
      engine.client.recordEvents(convId).filter((e) => e.kind === 'transcript.updated'),
    ).toHaveLength(0);

    const transcriptPath = transcriptPathFor({ appDataDir, projectsDir, convId, sessionId });
    mkdirSync(join(transcriptPath, '..'), { recursive: true });
    writeFileSync(transcriptPath, '{"role":"user","content":"late arrival"}\n');

    const ev = await engine.client.awaitEvent(
      { conv_id: convId, kind: 'transcript.updated' },
      { timeout: 2000 },
    );
    const payload = ev.payload as TranscriptUpdatedEvent;
    expect(payload.lines).toHaveLength(1);
    expect(payload.lines[0]?.line_number).toBe(0);
    expect(payload.lines[0]?.raw).toEqual({ role: 'user', content: 'late arrival' });
  });

  test('debounces rapid writes into batched events', async () => {
    const sessionId = 'sess-T111-C';
    const convId = '33333333-3333-4333-8333-333333333333';
    // Generous debounce window relative to the inter-write delay so the burst
    // collapses into a single batch (or at most two; the test asserts <= 2 and
    // total-lines coverage is exact).
    engine = await bootEngine({
      appDataDir,
      projectsDir,
      sessionId,
      pollIntervalMs: 5,
      debounceMs: 100,
    });

    await engine.client.submitTurn({ conv_id: convId, turn_id: 't-1', user_message: 'hi' });
    await engine.client.awaitEvent({ conv_id: convId, kind: 'turn.result' }, { timeout: 2000 });

    const transcriptPath = transcriptPathFor({ appDataDir, projectsDir, convId, sessionId });
    mkdirSync(join(transcriptPath, '..'), { recursive: true });
    writeFileSync(transcriptPath, '');

    // Burst: 5 writes back-to-back, each kicking the debounce timer.
    for (let i = 0; i < 5; i++) {
      appendFileSync(transcriptPath, `${JSON.stringify({ i })}\n`);
    }

    // Wait until the line whose number is 4 has been emitted.
    await engine.client.awaitEvent(
      {
        conv_id: convId,
        kind: 'transcript.updated',
        predicate: (env) =>
          (env.payload as TranscriptUpdatedEvent).lines.some((l) => l.line_number === 4),
      },
      { timeout: 2000 },
    );

    const transcriptEvs = engine.client
      .recordEvents(convId)
      .filter((e) => e.kind === 'transcript.updated');
    // Coalescing: two batches max (typically one).
    expect(transcriptEvs.length).toBeLessThanOrEqual(2);
    const seenLineNumbers = transcriptEvs.flatMap((e) =>
      (e.payload as TranscriptUpdatedEvent).lines.map((l) => l.line_number),
    );
    expect(seenLineNumbers).toEqual([0, 1, 2, 3, 4]);
  });
});
