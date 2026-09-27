import { ChaosBackend, ScriptedBackend, script } from '@clod-ui/test-kit';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createApp } from '../src/index.ts';

/**
 * Tests for the engine's HTTP routes — in-process, no subprocess, no server.
 * We call `createApp({...}).app.fetch(req)` directly, which is what Bun.serve
 * would do for us anyway.
 *
 * Spec: plans/landed/2026-04-23-clod-ui-pr5-cancel-ladder-and-taxonomy-v1.md §6
 */

const CONV_UUID_A = '11111111-1111-4111-8111-111111111111';
const CONV_UUID_B = '22222222-2222-4222-8222-222222222222';

function makeTurn(turnId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    turn_id: turnId,
    user_message: 'hi',
    ...extra,
  });
}

function buildBackend(opts?: { startupDelayMs?: number }) {
  const built = script().init('sess-engine-test').assistantText('ok').result().end();
  const scripted = new ScriptedBackend(built);
  return new ChaosBackend(scripted, {
    ...(opts?.startupDelayMs !== undefined ? { startupDelayMs: opts.startupDelayMs } : {}),
  });
}

// --- test lifecycle --------------------------------------------------------

type AppCtx = ReturnType<typeof createApp>;
let ctx: AppCtx | null = null;
const activeIters: Promise<unknown>[] = [];

beforeEach(() => {
  ctx = null;
  activeIters.length = 0;
});

afterEach(async () => {
  // Ensure any in-flight broadcast iterators settle so nothing leaks across tests.
  await Promise.allSettled(activeIters);
  ctx = null;
});

describe('engine POST /conversations/:id/turns — body validation', () => {
  test('invalid JSON → 400', async () => {
    ctx = createApp({ backend: buildBackend() });
    const res = await ctx.app.fetch(
      new Request(`http://x/conversations/${CONV_UUID_A}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-json',
      }),
    );
    expect(res.status).toBe(400);
  });

  test('missing turn_id → 400', async () => {
    ctx = createApp({ backend: buildBackend() });
    const res = await ctx.app.fetch(
      new Request(`http://x/conversations/${CONV_UUID_A}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user_message: 'hi' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test('valid body → 202 {accepted:true}', async () => {
    ctx = createApp({ backend: buildBackend() });
    const res = await ctx.app.fetch(
      new Request(`http://x/conversations/${CONV_UUID_A}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: makeTurn('t-ok'),
      }),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });
  });
});

describe('engine concurrent-send rejection', () => {
  test('second POST on same conv while first in flight → 409 with typed body', async () => {
    // Chaos gives the first turn a 500ms startup delay so the second request
    // arrives while it's still pending.
    ctx = createApp({ backend: buildBackend({ startupDelayMs: 500 }) });

    const res1 = await ctx.app.fetch(
      new Request(`http://x/conversations/${CONV_UUID_A}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: makeTurn('t-first'),
      }),
    );
    expect(res1.status).toBe(202);

    const res2 = await ctx.app.fetch(
      new Request(`http://x/conversations/${CONV_UUID_A}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: makeTurn('t-second'),
      }),
    );
    expect(res2.status).toBe(409);
    const body = (await res2.json()) as { error: { kind: string; active_turn_id: string } };
    expect(body.error.kind).toBe('conversation_busy');
    expect(body.error.active_turn_id).toBe('t-first');

    // Let the first turn finish so we don't leak.
    await new Promise((r) => setTimeout(r, 800));
  }, 5000);

  test('different convs can run in parallel — both 202', async () => {
    ctx = createApp({ backend: buildBackend({ startupDelayMs: 200 }) });
    const [r1, r2] = await Promise.all([
      ctx.app.fetch(
        new Request(`http://x/conversations/${CONV_UUID_A}/turns`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: makeTurn('t-A'),
        }),
      ),
      ctx.app.fetch(
        new Request(`http://x/conversations/${CONV_UUID_B}/turns`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: makeTurn('t-B'),
        }),
      ),
    ]);
    expect(r1.status).toBe(202);
    expect(r2.status).toBe(202);
    await new Promise((r) => setTimeout(r, 500));
  }, 5000);

  test('after first completes, a new turn on the same conv is accepted (not stuck at 409)', async () => {
    ctx = createApp({ backend: buildBackend({ startupDelayMs: 50 }) });
    const r1 = await ctx.app.fetch(
      new Request(`http://x/conversations/${CONV_UUID_A}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: makeTurn('t-one'),
      }),
    );
    expect(r1.status).toBe(202);
    // Wait for the first turn's stream to complete.
    await new Promise((r) => setTimeout(r, 400));
    const r2 = await ctx.app.fetch(
      new Request(`http://x/conversations/${CONV_UUID_A}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: makeTurn('t-two'),
      }),
    );
    expect(r2.status).toBe(202);
    await new Promise((r) => setTimeout(r, 400));
  }, 5000);
});

describe('engine classifier wiring on thrown iterator', () => {
  test('ChaosBackend crashAfterEvents yields a classified turn.error envelope', async () => {
    const built = script()
      .init('sess-crash')
      .assistantText('one')
      .assistantText('two')
      .assistantText('three')
      .result()
      .end();
    const scripted = new ScriptedBackend(built);
    const chaos = new ChaosBackend(scripted, { crashAfterEvents: 2 });

    const envelopes: Array<{ kind: string; payload: unknown }> = [];
    ctx = createApp({
      backend: chaos,
      onBroadcast: (env) => {
        envelopes.push({ kind: env.kind, payload: env.payload });
      },
    });

    const res = await ctx.app.fetch(
      new Request(`http://x/conversations/${CONV_UUID_A}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: makeTurn('t-crash'),
      }),
    );
    expect(res.status).toBe(202);

    // Wait for the stream to produce its terminal error.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const last = envelopes[envelopes.length - 1];
      if (last?.kind === 'turn.error') break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const last = envelopes[envelopes.length - 1];
    expect(last?.kind).toBe('turn.error');
    const errEnv = last?.payload as { error?: { kind: string; retryable: boolean } };
    expect(errEnv.error?.kind).toBe('cli_crashed');
    expect(errEnv.error?.retryable).toBe(true);
  }, 5000);
});
