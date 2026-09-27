/**
 * Integration test for transient WebSocket drops against a real engine.
 *
 * Companion to `client-integration.test.ts` (HTTP + simple WS subscribe) and
 * the unit-tier `local-http-reconnect.test.ts` (state machine via FakeWebSocket
 * + manual scheduler). This file exercises the production scenario the others
 * don't: a live socket dropping with a non-clean close code while the engine
 * stays up, the client autonomously reconnecting, and the engine replaying
 * the missed envelopes via `?since=<lastEventId>`.
 *
 * Boot pattern: production-style replay-aware WS upgrade handler (mirrors
 * `apps/engine/tests/replay-ws.test.ts` + the production entrypoint). The
 * test owns the live-socket Set so it can force-drop with `terminate()`.
 *
 * Spec: plans/landed/2026-04-30-clod-ui-pr17-1-replay-schema-and-reconnect-integration-v1.md §4.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ManifestStore } from '@clod-ui/manifest';
import { ScriptedBackend, script } from '@clod-ui/test-kit';
import type { ServerWebSocket } from 'bun';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { openDb } from '../../../apps/engine/src/db/index.ts';
import { createApp, type AppContext } from '../../../apps/engine/src/index.ts';
import { FallbackTitler } from '../../../apps/engine/src/titler.ts';
import { LocalHttpTransport, createClient, type Client } from '../src/client/index.ts';
import type { EventEnvelope } from '../src/event-envelope.ts';
import { REPLAY_START_KIND, REPLAY_START_SENTINEL_ID } from '../src/replay.ts';

interface RunningEngine {
  baseUrl: string;
  context: AppContext;
  /** Live server-side sockets — test can call `terminate()` to force-drop. */
  sockets: Set<ServerWebSocket<{ sinceId: string | null }>>;
  /** Captured `?since=` values from each upgrade attempt, in arrival order. */
  sinceParamHistory: (string | null)[];
  stop: () => Promise<void>;
}

async function bootEngine(opts: { appDataDir: string }): Promise<RunningEngine> {
  // Two-turn script: first call returns turn 1, second call returns turn 2.
  const built = script().init('sess-reconnect-int').assistantText('first turn body').result().end();
  const backend = new ScriptedBackend(built);
  const store = new ManifestStore(opts.appDataDir);
  const db = openDb({ path: join(opts.appDataDir, 'engine.sqlite') });
  const ctx = createApp({
    backend,
    store,
    db,
    titler: new FallbackTitler(),
  });

  const sockets = new Set<ServerWebSocket<{ sinceId: string | null }>>();
  const sinceParamHistory: (string | null)[] = [];
  ctx.setBroadcast((env) => {
    const data = JSON.stringify(env);
    for (const ws of sockets) {
      try {
        ws.send(data);
      } catch {
        /* culled on close */
      }
    }
  });

  const server = Bun.serve<{ sinceId: string | null }, never>({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req, srv) => {
      const u = new URL(req.url);
      if (u.pathname === '/ws') {
        const sinceId = u.searchParams.get('since');
        sinceParamHistory.push(sinceId);
        const upgraded = srv.upgrade(req, { data: { sinceId } });
        if (upgraded) return undefined;
        return new Response('upgrade failed', { status: 400 });
      }
      return ctx.app.fetch(req);
    },
    websocket: {
      open: (ws) => {
        const sinceId = ws.data?.sinceId ?? null;
        const replay = ctx.computeReplay(sinceId);
        ws.send(JSON.stringify(replay.start));
        for (const env of replay.envelopes) ws.send(JSON.stringify(env));
        sockets.add(ws);
      },
      close: (ws) => {
        sockets.delete(ws);
      },
      message: () => undefined,
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    context: ctx,
    sockets,
    sinceParamHistory,
    stop: async () => {
      server.stop(true);
      await ctx.cancelAll();
      db.close();
    },
  };
}

function makeClient(baseUrl: string): Client {
  const transport = new LocalHttpTransport({ baseUrl });
  return createClient({ transport });
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  opts: { timeout?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const timeout = opts.timeout ?? 3000;
  const intervalMs = opts.intervalMs ?? 10;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor (${opts.label ?? 'predicate'}) timed out after ${timeout}ms`);
}

describe('createClient — transient WS drop reconnect (real engine)', () => {
  let appDataDir: string;
  let engine: RunningEngine | undefined;

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'clod-ui-reconnect-int-'));
    appDataDir = join(root, 'app-data');
    mkdirSync(appDataDir, { recursive: true });
    engine = undefined;
  });

  afterEach(async () => {
    if (engine) await engine.stop();
    rmSync(appDataDir, { recursive: true, force: true });
  });

  test('server-side socket drop triggers client reconnect with ?since=<lastEventId>; missed envelopes replay', async () => {
    engine = await bootEngine({ appDataDir });
    const client = makeClient(engine.baseUrl);

    const phase1: EventEnvelope[] = [];
    const phase2: EventEnvelope[] = [];
    let phase: 1 | 2 = 1;
    let openedCount = 0;
    let closedCount = 0;

    const sub = client.subscribe({
      onOpen: () => {
        openedCount += 1;
      },
      onClose: () => {
        closedCount += 1;
      },
      onEnvelope: (env) => {
        // replay.start envelopes are control envelopes — ignore for this contract.
        if (env.id === REPLAY_START_SENTINEL_ID) return;
        if (phase === 1) phase1.push(env);
        else phase2.push(env);
      },
    });

    // Wait for the first connection.
    await waitFor(() => openedCount === 1, { label: 'initial open' });

    // Drive turn 1; collect its envelopes in phase1.
    const convA = '11111111-1111-4111-8111-111111111111';
    await client.submitTurn({ conv_id: convA, turn_id: 't-A', user_message: 'turn one' });
    await waitFor(() => phase1.some((e) => e.kind === 'turn.result'), {
      label: 'phase 1 turn.result',
    });
    const lastSeen = phase1.reduce<string | null>(
      (acc, e) => (acc === null || e.id > acc ? e.id : acc),
      null,
    );
    expect(lastSeen).not.toBeNull();

    // Switch collection to phase 2 and force-drop the live server socket.
    phase = 2;
    expect(engine.sockets.size).toBe(1);
    const liveSocket = [...engine.sockets][0]!;
    liveSocket.terminate(); // emits abnormal close (1006) on the client.

    // Wait for the client to observe the close event.
    await waitFor(() => closedCount >= 1, { label: 'client close event' });

    // Drive turn 2 *while client is reconnecting*. Its envelopes land in the
    // replay buffer; the reconnected client will receive them via ?since=.
    const convB = '22222222-2222-4222-8222-222222222222';
    await client.submitTurn({ conv_id: convB, turn_id: 't-B', user_message: 'turn two' });

    // Wait for reconnect + missed turn.result.
    await waitFor(() => openedCount >= 2, { label: 'reconnect open' });
    await waitFor(() => phase2.some((e) => e.kind === 'turn.result' && e.conv_id === convB), {
      label: 'phase 2 turn.result via replay',
    });

    // Phase 2 carries only convB envelopes (no convA leakage / no overlap).
    expect(phase2.every((e) => e.conv_id === convB || e.conv_id === undefined)).toBe(true);

    // Every phase-2 envelope's id is strictly greater than lastSeen
    // (the resume cursor advances monotonically; replay tail honors it).
    for (const env of phase2) {
      expect(env.id > lastSeen!).toBe(true);
    }

    // No id overlap between phase 1 and phase 2 (no double-delivery).
    const phase1Ids = new Set(phase1.map((e) => e.id));
    for (const env of phase2) {
      expect(phase1Ids.has(env.id)).toBe(false);
    }

    sub.close();
  });

  test('reconnect URL carries ?since=<lastEventId>; sentinel ids never advance the cursor', async () => {
    engine = await bootEngine({ appDataDir });
    const client = makeClient(engine.baseUrl);

    let openedCount = 0;
    let closedCount = 0;
    const received: EventEnvelope[] = [];

    const sub = client.subscribe({
      onOpen: () => {
        openedCount += 1;
      },
      onClose: () => {
        closedCount += 1;
      },
      onEnvelope: (env) => {
        received.push(env);
      },
    });

    await waitFor(() => openedCount === 1, { label: 'initial open' });

    // Initial connection: ?since= is null (history slot 0).
    expect(engine.sinceParamHistory[0]).toBeNull();

    // First envelope received is replay.start with the sentinel id.
    await waitFor(() => received.length >= 1, { label: 'replay.start arrival' });
    expect(received[0]!.id).toBe(REPLAY_START_SENTINEL_ID);
    expect(received[0]!.kind).toBe(REPLAY_START_KIND);

    // Drive a turn so we have a real (non-sentinel) cursor.
    const conv = '33333333-3333-4333-8333-333333333333';
    await client.submitTurn({ conv_id: conv, turn_id: 't-C', user_message: 'turn three' });
    await waitFor(() => received.some((e) => e.kind === 'turn.result'), {
      label: 'pre-drop turn.result',
    });
    const realIds = received.filter((e) => e.id !== REPLAY_START_SENTINEL_ID).map((e) => e.id);
    const lastReal = realIds.reduce<string | null>(
      (acc, id) => (acc === null || id > acc ? id : acc),
      null,
    );
    expect(lastReal).not.toBeNull();

    // Force-drop. Wait for reconnect.
    [...engine.sockets][0]!.terminate();
    await waitFor(() => closedCount >= 1, { label: 'close event' });
    await waitFor(() => openedCount >= 2, { label: 'reconnect open' });

    // After reconnect, the captured ?since= equals lastReal — NOT the sentinel.
    // sinceParamHistory[0] = null (initial), [1] = the resume cursor.
    expect(engine.sinceParamHistory.length).toBeGreaterThanOrEqual(2);
    const resumeSince = engine.sinceParamHistory[1];
    expect(resumeSince).not.toBeNull();
    expect(resumeSince).not.toBe(REPLAY_START_SENTINEL_ID);
    expect(resumeSince).toBe(lastReal);

    sub.close();
  });
});
