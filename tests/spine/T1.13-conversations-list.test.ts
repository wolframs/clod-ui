/**
 * T1.13 — Conversations list (sidebar projection).
 *
 * Contract: `GET /conversations` returns the sidebar projection — a list of
 * `ConversationSummary` entries fusing the SQLite `conversations` table with
 * the manifest fold's `state.title` and `max(events.ts)`. The response:
 *   1. reflects a turn that has fully completed: `title`, `claude_session_id`,
 *      `created_at`, and `updated_at` are all populated correctly;
 *   2. orders entries by `updated_at` descending — fresh activity rises.
 *
 * Implementation: PR #12 (plans/landed/2026-04-27-clod-ui-pr12-conversations-list-v1.md).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ManifestStore } from '@clod-ui/manifest';
import { ScriptedBackend, TypedTestClient, script } from '@clod-ui/test-kit';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { openDb } from '../../apps/engine/src/db/index.ts';
import { createApp } from '../../apps/engine/src/index.ts';
import { FallbackTitler } from '../../apps/engine/src/titler.ts';

interface RunningEngine {
  server: ReturnType<typeof Bun.serve>;
  client: TypedTestClient;
  db: ReturnType<typeof openDb>;
  baseUrl: string;
}

async function bootEngine(opts: { appDataDir: string; sessionId: string }): Promise<RunningEngine> {
  const built = script().init(opts.sessionId).assistantText('ok').result().end();
  const backend = new ScriptedBackend(built);
  const store = new ManifestStore(opts.appDataDir);
  const db = openDb({ path: join(opts.appDataDir, 'engine.sqlite') });
  const context = createApp({
    backend,
    store,
    db,
    titler: new FallbackTitler(),
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

  const baseUrl = `http://127.0.0.1:${server.port}`;
  const client = new TypedTestClient({ baseUrl });
  await client.connect();
  return { server, client, db, baseUrl };
}

async function shutdown(engine: RunningEngine): Promise<void> {
  await engine.client.close();
  engine.server.stop(true);
  engine.db.close();
}

interface ListResponse {
  conversations: Array<{
    conv_id: string;
    title?: string;
    created_at: number;
    updated_at: number;
    claude_session_id?: string;
  }>;
}

describe('T1.13 conversations list', () => {
  let appDataDir: string;
  let engine: RunningEngine | undefined;

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'clod-ui-t113-'));
    appDataDir = join(root, 'app-data');
    mkdirSync(appDataDir, { recursive: true });
    engine = undefined;
  });

  afterEach(async () => {
    if (engine) await shutdown(engine);
    rmSync(appDataDir, { recursive: true, force: true });
  });

  test('list reflects a completed turn end-to-end (title + session + timestamps)', async () => {
    const sessionId = 'sess-T113-A';
    const convId = '11111111-1111-4111-8111-111111111111';
    engine = await bootEngine({ appDataDir, sessionId });

    // Drive one full turn over HTTP/WS. FallbackTitler is deterministic, so
    // the title is derivable from the user_message.
    await engine.client.submitTurn({
      conv_id: convId,
      turn_id: 't-1',
      user_message: 'How does the parser handle empty lines?',
    });
    await engine.client.awaitEvent({ conv_id: convId, kind: 'turn.result' }, { timeout: 2000 });
    const titledEnv = await engine.client.awaitEvent(
      { conv_id: convId, kind: 'conversation.titled' },
      { timeout: 2000 },
    );
    const titledPayload = titledEnv.payload as { title: string };

    // GET /conversations and assert the projection.
    const res = await fetch(`${engine.baseUrl}/conversations`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListResponse;
    expect(body.conversations).toHaveLength(1);
    const entry = body.conversations[0]!;

    expect(entry.conv_id).toBe(convId);
    // The list's title equals the title broadcast over the wire — single
    // source of truth (manifest fold) drives both.
    expect(entry.title).toBe(titledPayload.title);
    expect(entry.claude_session_id).toBe(sessionId);
    expect(entry.created_at).toBeGreaterThan(0);
    // The titled event bumped updated_at past created_at (or matched it
    // within ~1ms tolerance — both reads of Date.now() in fast succession).
    expect(entry.updated_at).toBeGreaterThanOrEqual(entry.created_at - 1);
    expect(titledEnv.ts).toBeGreaterThanOrEqual(entry.updated_at - 1);
  });

  test('list orders by updated_at desc across two conversations', async () => {
    const convA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const convB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    engine = await bootEngine({ appDataDir, sessionId: 'sess-T113-pair' });

    // Turn on A first.
    await engine.client.submitTurn({
      conv_id: convA,
      turn_id: 't-a-1',
      user_message: 'first conversation',
    });
    await engine.client.awaitEvent(
      { conv_id: convA, kind: 'conversation.titled' },
      { timeout: 2000 },
    );

    // Tiny gap so B's title-event ts is strictly later than A's.
    await new Promise((r) => setTimeout(r, 10));

    // Turn on B second.
    await engine.client.submitTurn({
      conv_id: convB,
      turn_id: 't-b-1',
      user_message: 'second conversation',
    });
    await engine.client.awaitEvent(
      { conv_id: convB, kind: 'conversation.titled' },
      { timeout: 2000 },
    );

    // GET /conversations and assert B appears before A: B's last manifest
    // event landed later, so its updated_at is greater.
    const res = await fetch(`${engine.baseUrl}/conversations`);
    const body = (await res.json()) as ListResponse;
    expect(body.conversations).toHaveLength(2);
    expect(body.conversations[0]!.conv_id).toBe(convB);
    expect(body.conversations[1]!.conv_id).toBe(convA);
    expect(body.conversations[0]!.updated_at).toBeGreaterThan(body.conversations[1]!.updated_at);
    // Both carry deterministic FallbackTitler-derived titles.
    expect(body.conversations[0]!.title).toBeDefined();
    expect(body.conversations[1]!.title).toBeDefined();
  });
});
