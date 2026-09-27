/**
 * Engine integration tests for the WS replay buffer + ?since= upgrade.
 *
 * Boots `createApp` + `Bun.serve` on port 0 with a ScriptedBackend, then
 * exercises three WS scenarios:
 *   - fresh subscriber (no ?since)
 *   - resuming subscriber (?since=<id>) — receives only missed envelopes
 *   - too-old subscriber (?since=<old_id>) — receives gap=true + full buffer
 *
 * Spec: plans/landed/2026-04-30-clod-ui-pr17-reconnect-and-resume-v1.md §9.
 */
import type { EventEnvelope } from '@clod-ui/contracts';
import { ScriptedBackend, script } from '@clod-ui/test-kit';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createApp, REPLAY_START_SENTINEL_ID } from '../src/index.ts';
import type { AppContext } from '../src/index.ts';

const CONV = '33333333-3333-4333-8333-333333333333';

interface Booted {
  baseUrl: string;
  wsUrl: string;
  app: AppContext;
  stop: () => Promise<void>;
}

async function boot(opts?: { capacity?: number }): Promise<Booted> {
  const built = script()
    .init('s-replay')
    .assistantText('a')
    .assistantText('b')
    .assistantText('c')
    .result()
    .end();
  const backend = new ScriptedBackend(built);
  const ctx = createApp({
    backend,
    ...(opts?.capacity !== undefined ? { replay: { capacity: opts.capacity } } : {}),
  });
  const sockets = new Set<WebSocket>();
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
      const url = new URL(req.url);
      if (url.pathname === '/ws') {
        const sinceId = url.searchParams.get('since');
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
        sockets.add(ws as unknown as WebSocket);
      },
      close: (ws) => {
        sockets.delete(ws as unknown as WebSocket);
      },
      message: () => {},
    },
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  return {
    baseUrl,
    wsUrl: `ws://127.0.0.1:${server.port}/ws`,
    app: ctx,
    stop: async () => {
      server.stop(true);
      await ctx.cancelAll();
    },
  };
}

interface Collector {
  envelopes: EventEnvelope[];
  ws: WebSocket;
  closed: Promise<void>;
}

function openWs(wsUrl: string, sinceId: string | null): Promise<Collector> {
  return new Promise((resolve) => {
    const url = sinceId === null ? wsUrl : `${wsUrl}?since=${encodeURIComponent(sinceId)}`;
    const ws = new WebSocket(url);
    const envelopes: EventEnvelope[] = [];
    let closeResolve: () => void = () => {};
    const closed = new Promise<void>((r) => {
      closeResolve = r;
    });
    ws.addEventListener('open', () => {
      resolve({ envelopes, ws, closed });
    });
    ws.addEventListener('message', (msg) => {
      const data = typeof msg.data === 'string' ? msg.data : '';
      if (!data) return;
      try {
        envelopes.push(JSON.parse(data) as EventEnvelope);
      } catch {
        /* ignore non-JSON */
      }
    });
    ws.addEventListener('close', () => closeResolve());
  });
}

async function waitForCount(c: Collector, n: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && c.envelopes.length < n) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

let booted: Booted;

beforeEach(async () => {
  booted = await boot();
});

afterEach(async () => {
  await booted.stop();
});

describe('engine WS replay buffer + ?since=', () => {
  test('fresh subscriber receives replay.start { since: null, replayed_count: 0, gap: false }', async () => {
    const c = await openWs(booted.wsUrl, null);
    await waitForCount(c, 1);
    expect(c.envelopes.length).toBeGreaterThanOrEqual(1);
    const start = c.envelopes[0]!;
    expect(start.kind).toBe('replay.start');
    expect(start.id).toBe(REPLAY_START_SENTINEL_ID);
    expect(start.payload).toMatchObject({
      kind: 'replay.start',
      since: null,
      replayed_count: 0,
      gap: false,
    });
    c.ws.close();
    await c.closed;
  });

  test('subscriber after a turn receives replay.start with the buffer + live envelopes', async () => {
    // Run a turn with no subscribers, so envelopes fill the buffer.
    const res = await fetch(`${booted.baseUrl}/conversations/${CONV}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ turn_id: 'turn-replay-1', user_message: 'hi' }),
    });
    expect(res.status).toBe(202);
    // Wait for the buffer to populate (5 envelopes: init + 3 deltas + result).
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const replay = booted.app.computeReplay(null);
      if (replay.envelopes.length >= 5) break;
      await new Promise((r) => setTimeout(r, 5));
    }

    // Now connect — should get replay.start + all 5 buffered envelopes.
    const c = await openWs(booted.wsUrl, null);
    await waitForCount(c, 6);
    expect(c.envelopes.length).toBe(6);
    expect(c.envelopes[0]!.kind).toBe('replay.start');
    expect((c.envelopes[0]!.payload as { replayed_count: number }).replayed_count).toBe(5);
    const kinds = c.envelopes.slice(1).map((e) => e.kind);
    expect(kinds).toEqual([
      'system.init',
      'assistant.delta',
      'assistant.delta',
      'assistant.delta',
      'turn.result',
    ]);
    c.ws.close();
    await c.closed;
  });

  test('resuming subscriber with ?since=<mid_id> receives only missed envelopes', async () => {
    // Drive a turn so the buffer fills.
    await fetch(`${booted.baseUrl}/conversations/${CONV}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ turn_id: 'turn-replay-2', user_message: 'hi' }),
    });
    // Wait for the buffer.
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      if (booted.app.computeReplay(null).envelopes.length >= 5) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    const all = booted.app.computeReplay(null).envelopes;
    expect(all.length).toBe(5);
    // Resume from after the 2nd envelope (assistant.delta 'a'). Should miss
    // exactly the 3rd, 4th, 5th — plus a fresh replay.start for the resume.
    const sinceId = all[1]!.id;

    const c = await openWs(booted.wsUrl, sinceId);
    await waitForCount(c, 4);
    expect(c.envelopes.length).toBe(4);
    expect(c.envelopes[0]!.kind).toBe('replay.start');
    expect(c.envelopes[0]!.payload).toMatchObject({
      kind: 'replay.start',
      since: sinceId,
      replayed_count: 3,
      gap: false,
    });
    expect(c.envelopes.slice(1).map((e) => e.id)).toEqual([all[2]!.id, all[3]!.id, all[4]!.id]);
    c.ws.close();
    await c.closed;
  });
});

describe('engine WS replay buffer — gap reporting', () => {
  test('subscriber with ?since=<too_old> gets gap=true and full buffer', async () => {
    await booted.stop();
    booted = await boot({ capacity: 3 });
    // Drive enough turns to overflow capacity 3.
    await fetch(`${booted.baseUrl}/conversations/${CONV}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ turn_id: 'turn-replay-overflow', user_message: 'hi' }),
    });
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      if (booted.app.computeReplay(null).envelopes.length === 3) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(booted.app.computeReplay(null).envelopes.length).toBe(3);

    // Pretend the client's last id is something older than the oldest
    // buffered envelope. Use envelope id=1's value (counter 1, hex tail 1).
    const STALE_ID = '00000000-0000-4000-8000-000000000001';

    const c = await openWs(booted.wsUrl, STALE_ID);
    await waitForCount(c, 4);
    expect(c.envelopes.length).toBe(4);
    expect(c.envelopes[0]!.kind).toBe('replay.start');
    expect(c.envelopes[0]!.payload).toMatchObject({
      kind: 'replay.start',
      since: STALE_ID,
      replayed_count: 3,
      gap: true,
    });
    c.ws.close();
    await c.closed;
  });
});
