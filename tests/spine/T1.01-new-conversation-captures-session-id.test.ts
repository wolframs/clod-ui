/**
 * T1.01 — New conversation captures session_id.
 *
 * Contract: POSTing a new turn on a fresh conversation produces a
 * `system.init` event whose `session_id` is persisted both in SQLite and in
 * `manifest.json`. Equality across those two sources is the spine invariant.
 *
 * PR #4 landed the **observability half**: session_id flowing from the
 * backend through the engine's WebSocket envelope.
 *
 * PR #6 lands the **persistence half**: the same session_id appears in
 * SQLite (`conversations.claude_session_id`) and in the conversation's
 * `manifest.json` as a `session.captured` event.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ManifestStore } from '@clod-ui/manifest';
import { ScriptedBackend, TypedTestClient, script } from '@clod-ui/test-kit';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { getConversation, openDb } from '../../apps/engine/src/db/index.ts';
import { createApp } from '../../apps/engine/src/index.ts';

describe('T1.01 new conversation captures session_id', () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  let client: TypedTestClient | undefined;

  beforeEach(() => {
    server = undefined;
    client = undefined;
  });

  afterEach(async () => {
    await client?.close();
    server?.stop(true);
  });

  test('system.init.session_id flows over WS through the engine', async () => {
    const built = script().init('sess-observable-abc').assistantText('ok').result().end();
    const backend = new ScriptedBackend(built);

    const context = createApp({ backend });
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
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (req, srv) => {
        const u = new URL(req.url);
        if (u.pathname === '/ws') {
          const upgraded = srv.upgrade(req, { data: {} });
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
    const url = `http://127.0.0.1:${server.port}`;

    client = new TypedTestClient({ baseUrl: url });
    await client.connect();

    const convId = '11111111-1111-4111-8111-111111111111';
    await client.submitTurn({
      conv_id: convId,
      turn_id: 't-1',
      user_message: 'hello',
    });

    const init = await client.awaitEvent(
      { conv_id: convId, kind: 'system.init' },
      { timeout: 2000 },
    );
    const payload = init.payload as { kind: 'system.init'; session_id: string };
    expect(payload.session_id).toBe('sess-observable-abc');
  });
});

describe('T1.01 persistence half (PR #6)', () => {
  let appDataDir: string;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let client: TypedTestClient | undefined;
  let dbHandle: ReturnType<typeof openDb> | undefined;

  beforeEach(() => {
    appDataDir = mkdtempSync(join(tmpdir(), 'clod-ui-t101b-'));
    server = undefined;
    client = undefined;
    dbHandle = undefined;
  });

  afterEach(async () => {
    await client?.close();
    server?.stop(true);
    dbHandle?.close();
    rmSync(appDataDir, { recursive: true, force: true });
  });

  test('session_id is persisted to SQLite and manifest', async () => {
    const built = script().init('sess-persist-A').assistantText('ok').result().end();
    const backend = new ScriptedBackend(built);

    const store = new ManifestStore(appDataDir);
    dbHandle = openDb({ path: join(appDataDir, 'engine.sqlite') });
    const context = createApp({ backend, store, db: dbHandle });

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
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (req, srv) => {
        const u = new URL(req.url);
        if (u.pathname === '/ws') {
          const upgraded = srv.upgrade(req, { data: {} });
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

    client = new TypedTestClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    await client.connect();

    const convId = '22222222-2222-4222-8222-222222222222';
    await client.submitTurn({ conv_id: convId, turn_id: 't-1', user_message: 'hi' });
    // Wait for the terminal envelope so we know persistence side-effects have
    // settled (session.captured is written before the assistant.delta flows).
    await client.awaitEvent({ conv_id: convId, kind: 'turn.result' }, { timeout: 2000 });

    // SQLite
    const row = getConversation(dbHandle, convId);
    expect(row?.claude_session_id).toBe('sess-persist-A');

    // Manifest
    const events = await store.readAll(convId);
    const captured = events.find((e) => e.kind === 'session.captured');
    expect(captured).toBeDefined();
    expect((captured as { session_id: string }).session_id).toBe('sess-persist-A');

    // Spine invariant: SQLite row matches the folded manifest state.
    const folded = store.fold(events);
    expect(folded.claude_session_id).toBe(row?.claude_session_id ?? undefined);
  });
});
