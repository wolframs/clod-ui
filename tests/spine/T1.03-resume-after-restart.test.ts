/**
 * T1.03 — Resume after engine restart.
 *
 * Contract: complete a turn → tear down engine state → bring up a new engine
 * context against the same app-data dir → on the next turn, the engine
 * injects the captured `claude_session_id` as `resume_session_id` so the CLI
 * resumes the prior conversation. The manifest keeps appending across
 * restarts (no file truncation, monotonic seq, intact hash chain).
 *
 * In-process flavor: rather than spawning two engine subprocesses (which
 * requires a real `claude` shim + port plumbing + SIGTERM choreography), we
 * exercise the persistence path by creating two `createApp` instances against
 * the same `ManifestStore` + SQLite file, with the DB closed and reopened
 * between them — identical to what a real engine restart does to durable
 * state. The route logic that pulls `claude_session_id` out of SQLite and
 * sets `req.resume_session_id` is the spine invariant under test.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BackendEvent, ClaudeBackend, TurnRequest } from '@clod-ui/backend';
import { ManifestStore } from '@clod-ui/manifest';
import { ScriptedBackend, TypedTestClient, script } from '@clod-ui/test-kit';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { getConversation, openDb } from '../../apps/engine/src/db/index.ts';
import { createApp } from '../../apps/engine/src/index.ts';

/** Wraps a ClaudeBackend and records every TurnRequest seen by `startTurn`. */
class RecordingBackend implements ClaudeBackend {
  readonly seen: TurnRequest[] = [];
  constructor(private readonly inner: ClaudeBackend) {}
  health() {
    return this.inner.health();
  }
  version() {
    return this.inner.version();
  }
  startTurn(req: TurnRequest): AsyncIterable<BackendEvent> {
    this.seen.push(req);
    return this.inner.startTurn(req);
  }
  cancel(turnId: string) {
    return this.inner.cancel(turnId);
  }
}

interface RunningEngine {
  server: ReturnType<typeof Bun.serve>;
  client: TypedTestClient;
  recorder: RecordingBackend;
  db: ReturnType<typeof openDb>;
}

async function bootEngine(opts: {
  appDataDir: string;
  scripted: ScriptedBackend;
}): Promise<RunningEngine> {
  const recorder = new RecordingBackend(opts.scripted);
  const store = new ManifestStore(opts.appDataDir);
  const db = openDb({ path: join(opts.appDataDir, 'engine.sqlite') });
  const context = createApp({ backend: recorder, store, db });

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
  return { server, client, recorder, db };
}

async function shutdown(engine: RunningEngine): Promise<void> {
  await engine.client.close();
  engine.server.stop(true);
  engine.db.close();
}

describe('T1.03 resume after restart', () => {
  let appDataDir: string;
  let engines: RunningEngine[] = [];

  beforeEach(() => {
    appDataDir = mkdtempSync(join(tmpdir(), 'clod-ui-t103-'));
    engines = [];
  });

  afterEach(async () => {
    for (const e of engines) {
      await shutdown(e);
    }
    rmSync(appDataDir, { recursive: true, force: true });
  });

  test('manifest appends and session_id survives engine restart', async () => {
    const convId = '33333333-3333-4333-8333-333333333333';

    // ----- Engine #1 -----
    const scripted1 = new ScriptedBackend(
      script().init('sess-restart-A').assistantText('hi').result().end(),
    );
    const eng1 = await bootEngine({ appDataDir, scripted: scripted1 });
    engines.push(eng1);

    await eng1.client.submitTurn({ conv_id: convId, turn_id: 't-1', user_message: 'first' });
    await eng1.client.awaitEvent({ conv_id: convId, kind: 'turn.result' }, { timeout: 2000 });

    // First turn: no resume_session_id (fresh conversation).
    expect(eng1.recorder.seen).toHaveLength(1);
    expect(eng1.recorder.seen[0]?.resume_session_id).toBeUndefined();

    // Tear down engine #1 — closes WS, server, db. Manifest + sqlite file remain on disk.
    await shutdown(eng1);
    engines = engines.filter((e) => e !== eng1);

    // ----- Engine #2 (same app-data dir) -----
    const scripted2 = new ScriptedBackend(
      script().init('sess-restart-A').assistantText('hello again').result().end(),
    );
    const eng2 = await bootEngine({ appDataDir, scripted: scripted2 });
    engines.push(eng2);

    // Sanity: SQLite already knows the session_id from engine #1's run.
    const rowBefore = getConversation(eng2.db, convId);
    expect(rowBefore?.claude_session_id).toBe('sess-restart-A');

    await eng2.client.submitTurn({ conv_id: convId, turn_id: 't-2', user_message: 'second' });
    await eng2.client.awaitEvent({ conv_id: convId, kind: 'turn.result' }, { timeout: 2000 });

    // The spine invariant: engine #2 injected the persisted session_id as
    // resume_session_id on the second turn.
    expect(eng2.recorder.seen).toHaveLength(1);
    expect(eng2.recorder.seen[0]?.resume_session_id).toBe('sess-restart-A');

    // Manifest has continued appending (no rewrite, monotonic seq).
    const store = new ManifestStore(appDataDir);
    const events = await store.readAll(convId);
    const seqs = events.map((e) => e.seq);
    for (let i = 0; i < seqs.length; i++) expect(seqs[i]).toBe(i);
    // We expect at minimum: conversation.created (engine #1) + session.captured (engine #1).
    // Engine #2 calls ensureProvisioned, which is a no-op for an existing conv,
    // and recordSessionId is also a no-op since the session_id is unchanged.
    expect(events.find((e) => e.kind === 'conversation.created')).toBeDefined();
    expect(events.find((e) => e.kind === 'session.captured')).toBeDefined();
  });
});
