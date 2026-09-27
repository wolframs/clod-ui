/**
 * T1.14 — Reconnect-and-resume.
 *
 * Contract: an engine restart-tolerant client can disconnect mid-session and
 * reconnect with `?since=<lastEventId>` to receive only the envelopes that
 * arrived during the gap. Strictly:
 *   1. envelopes broadcast while a subscriber is disconnected are replayed
 *      verbatim (kind, payload, env_id) when that subscriber reconnects with
 *      `?since=<lastEventId>` — assuming the gap is within the buffer's
 *      capacity;
 *   2. `?since=<largest_seen_env_id>` returns no replay — the buffer respects
 *      the cursor and never re-delivers envelopes the subscriber already saw.
 *
 * Implementation: PR #17 (plans/landed/2026-04-30-clod-ui-pr17-reconnect-and-resume-v1.md).
 *   - Engine: ReplayBuffer (apps/engine/src/replay-buffer.ts) + WS upgrade
 *     handler reading `?since=` and prepending captured envelopes.
 *   - Client: LocalHttpTransport.subscribe re-subscribes on non-clean close
 *     with the last seen `env_id` and exponential backoff.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EventEnvelope } from '@clod-ui/contracts';
import { LocalHttpTransport, createClient } from '@clod-ui/contracts/client';
import { ManifestStore } from '@clod-ui/manifest';
import { ScriptedBackend, script } from '@clod-ui/test-kit';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { openDb } from '../../apps/engine/src/db/index.ts';
import { createApp } from '../../apps/engine/src/index.ts';
import { FallbackTitler } from '../../apps/engine/src/titler.ts';

interface RunningEngine {
  server: ReturnType<typeof Bun.serve>;
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

  interface SocketData {
    since: string | null;
  }
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

  const server = Bun.serve<SocketData, never>({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req, srv) => {
      const u = new URL(req.url);
      if (u.pathname === '/ws') {
        const since = u.searchParams.get('since');
        const upgraded = srv.upgrade(req, { data: { since: since ?? null } satisfies SocketData });
        if (upgraded) return undefined;
        return new Response('upgrade failed', { status: 400 });
      }
      return context.app.fetch(req);
    },
    websocket: {
      open: (ws) => {
        sockets.add(ws as unknown as WebSocket);
        const data = (ws as unknown as { data?: SocketData }).data;
        const replay = context.computeReplay(data?.since ?? null);
        try {
          ws.send(JSON.stringify(replay.start));
        } catch {
          /* ignore */
        }
        for (const env of replay.envelopes) {
          try {
            ws.send(JSON.stringify(env));
          } catch {
            /* ignore */
          }
        }
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
  return { server, db, baseUrl };
}

function shutdown(engine: RunningEngine): void {
  engine.server.stop(true);
  engine.db.close();
}

function collect(): { handler: (env: EventEnvelope) => void; envelopes: EventEnvelope[] } {
  const envelopes: EventEnvelope[] = [];
  return {
    envelopes,
    handler: (env) => {
      // Ignore the per-connection `replay.start` control envelope; the
      // contracts under test reason about real broadcast envelopes only.
      if (env.kind === 'replay.start') return;
      envelopes.push(env);
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('T1.14 reconnect-and-resume', () => {
  let appDataDir: string;
  let engine: RunningEngine | undefined;

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'clod-ui-t114-'));
    appDataDir = join(root, 'app-data');
    mkdirSync(appDataDir, { recursive: true });
    engine = undefined;
  });

  afterEach(() => {
    if (engine) shutdown(engine);
    rmSync(appDataDir, { recursive: true, force: true });
  });

  test('?since=<lastSeen> replays envelopes that arrived during disconnect', async () => {
    const convA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const convB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    engine = await bootEngine({ appDataDir, sessionId: 'sess-T114-a' });

    const transport = new LocalHttpTransport({ baseUrl: engine.baseUrl });
    const client = createClient({ transport });

    // Phase 1 — subscribe, drive turn A, capture last id, then close.
    const phase1 = collect();
    const sub1 = client.subscribe({
      onEnvelope: phase1.handler,
      reconnect: false,
    });

    await client.submitTurn({
      conv_id: convA,
      turn_id: 't-a',
      user_message: 'first',
    });
    await waitFor(
      () => phase1.envelopes.some((e) => e.kind === 'turn.result' && e.conv_id === convA),
      3000,
    );

    // Capture the largest id from phase 1 — ids are zero-padded hex UUIDs
    // produced by EnvelopeIdSource, so lexicographic max == numeric max.
    const lastSeen = phase1.envelopes.reduce<string>((max, e) => (e.id > max ? e.id : max), '');
    expect(lastSeen.length).toBeGreaterThan(0);
    sub1.close();

    // Phase 2 — drive turn B while no subscriber is connected. Its envelopes
    // land in the engine's replay buffer.
    await client.submitTurn({
      conv_id: convB,
      turn_id: 't-b',
      user_message: 'second',
    });
    // Wait for the turn to fully complete server-side.
    await new Promise((r) => setTimeout(r, 200));

    // Phase 3 — reconnect with ?since=<lastSeen>. The buffer must replay all
    // turn-B envelopes (id > lastSeen), and must not re-deliver any of
    // turn-A's envelopes (id <= lastSeen).
    const phase3 = collect();
    const sub3 = client.subscribe({
      onEnvelope: phase3.handler,
      reconnect: false,
      since: lastSeen,
    });

    await waitFor(
      () => phase3.envelopes.some((e) => e.kind === 'turn.result' && e.conv_id === convB),
      3000,
    );

    // Every replayed envelope must belong to turn B (no turn-A leakage).
    for (const env of phase3.envelopes) {
      expect(env.conv_id).toBe(convB);
      expect(env.id > lastSeen).toBe(true);
    }
    // The replay must be ordered by id ascending.
    const ids = phase3.envelopes.map((e) => e.id);
    expect(ids).toEqual([...ids].sort());

    sub3.close();
  });

  test('?since=<latest> returns no replay (cursor respects already-seen)', async () => {
    const convId = '11111111-1111-4111-8111-111111111111';
    engine = await bootEngine({ appDataDir, sessionId: 'sess-T114-b' });

    const transport = new LocalHttpTransport({ baseUrl: engine.baseUrl });
    const client = createClient({ transport });

    // Phase 1 — drive a turn, observe envelopes, capture latest id.
    const phase1 = collect();
    const sub1 = client.subscribe({
      onEnvelope: phase1.handler,
      reconnect: false,
    });
    await client.submitTurn({ conv_id: convId, turn_id: 't-1', user_message: 'hi' });
    await waitFor(
      () => phase1.envelopes.some((e) => e.kind === 'turn.result' && e.conv_id === convId),
      3000,
    );
    const latest = phase1.envelopes.reduce<string>((max, e) => (e.id > max ? e.id : max), '');
    expect(latest.length).toBeGreaterThan(0);
    sub1.close();

    // Phase 2 — reconnect with ?since=<latest>. Nothing is in flight; the
    // buffer must yield nothing.
    const phase2 = collect();
    const sub2 = client.subscribe({
      onEnvelope: phase2.handler,
      reconnect: false,
      since: latest,
    });

    // Give the server a generous window to deliver any stragglers.
    await new Promise((r) => setTimeout(r, 150));
    expect(phase2.envelopes).toEqual([]);

    sub2.close();
  });
});
