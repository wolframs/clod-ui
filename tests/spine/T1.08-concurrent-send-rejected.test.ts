/**
 * T1.08 — Concurrent send rejected.
 *
 * Contract: while a turn is in flight on a conversation, a second send on
 * the same conversation returns HTTP 409 with a typed
 * `{error: {kind: 'conversation_busy', active_turn_id}}` body. Queueing, if
 * ever implemented, is a separate explicit endpoint (out of scope).
 *
 * PR: plans/landed/2026-04-23-clod-ui-pr5-cancel-ladder-and-taxonomy-v1.md §7.4
 */
import { ChaosBackend, ScriptedBackend, TestEnv, script } from '@clod-ui/test-kit';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createApp } from '../../apps/engine/src/index.ts';

const CONV_UUID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

let env: TestEnv;

beforeEach(async () => {
  env = await TestEnv.create({ name: 't1.08' });
});

afterEach(async () => {
  await env.dispose();
});

describe('T1.08 concurrent send rejected', () => {
  test('second concurrent POST returns 409 with typed conversation_busy body', async () => {
    const built = script().init('s').assistantText('ok').result().end();
    const scripted = new ScriptedBackend(built);
    // 500ms startup delay keeps the first turn "in flight" long enough for
    // the second POST to race it.
    const chaos = new ChaosBackend(scripted, { startupDelayMs: 500 });

    const ctx = createApp({ backend: chaos });

    const firstTurnId = 'turn-08-first';
    const r1 = await ctx.app.fetch(
      new Request(`http://x/conversations/${CONV_UUID}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ turn_id: firstTurnId, user_message: 'hi' }),
      }),
    );
    expect(r1.status).toBe(202);

    // Immediately send a second POST while the first is still pending.
    const r2 = await ctx.app.fetch(
      new Request(`http://x/conversations/${CONV_UUID}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ turn_id: 'turn-08-second', user_message: 'again' }),
      }),
    );
    expect(r2.status).toBe(409);
    const body = (await r2.json()) as {
      error: { kind: string; active_turn_id: string };
    };
    expect(body.error.kind).toBe('conversation_busy');
    expect(body.error.active_turn_id).toBe(firstTurnId);

    // Let the first turn drain so we don't leak.
    await new Promise((r) => setTimeout(r, 800));

    // `env` is held for the fixtures contract (temp dirs wiped on dispose).
    expect(env.id).toBeTruthy();
  }, 5000);
});
