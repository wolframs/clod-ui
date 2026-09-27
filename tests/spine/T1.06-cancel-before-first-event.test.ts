/**
 * T1.06 — Cancel before first event.
 *
 * Contract: cancelling a turn that has not yet emitted a single event
 * produces a clean shutdown with a terminal `turn.cancelled` envelope and no
 * orphan process. Uses ChaosBackend with a big startupDelay so we can inject
 * the cancel strictly before the inner backend has had a chance to emit.
 *
 * PR: plans/landed/2026-04-23-clod-ui-pr5-cancel-ladder-and-taxonomy-v1.md §7.2
 */
import type { EventEnvelope } from '@clod-ui/contracts';
import { ChaosBackend, ScriptedBackend, TestEnv, expectNoZombies, script } from '@clod-ui/test-kit';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createApp } from '../../apps/engine/src/index.ts';

const CONV_UUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let env: TestEnv;

beforeEach(async () => {
  env = await TestEnv.create({ name: 't1.06' });
});

afterEach(async () => {
  await env.dispose();
});

describe('T1.06 cancel before first event', () => {
  test('early cancel → single turn.cancelled envelope, no other events', async () => {
    const built = script().init('s').assistantText('ok').result().end();
    const scripted = new ScriptedBackend(built);
    // 2s startup delay — cancel at +50ms guarantees we intercept before any emission.
    const chaos = new ChaosBackend(scripted, { startupDelayMs: 2000 });

    const envelopes: EventEnvelope[] = [];
    const ctx = createApp({
      backend: chaos,
      onBroadcast: (envelope) => envelopes.push(envelope),
    });

    const turnId = 'turn-06-early';
    const res = await ctx.app.fetch(
      new Request(`http://x/conversations/${CONV_UUID}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ turn_id: turnId, user_message: 'hi' }),
      }),
    );
    expect(res.status).toBe(202);

    // Cancel very shortly after, still well inside startupDelayMs window.
    await new Promise((r) => setTimeout(r, 50));
    const cancelRes = await ctx.app.fetch(
      new Request(`http://x/conversations/${CONV_UUID}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ turn_id: turnId }),
      }),
    );
    expect(cancelRes.status).toBe(200);

    // Wait for terminal envelope.
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const last = envelopes[envelopes.length - 1];
      if (last?.kind === 'turn.cancelled') break;
      await new Promise((r) => setTimeout(r, 20));
    }

    // Exactly one envelope, the turn.cancelled terminal.
    expect(envelopes.length).toBe(1);
    expect(envelopes[0]?.kind).toBe('turn.cancelled');

    expectNoZombies(env);
  }, 10_000);
});
