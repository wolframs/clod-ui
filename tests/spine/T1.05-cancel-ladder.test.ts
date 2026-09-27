/**
 * T1.05 — Cancel ladder.
 *
 * Contract: cancel() sends SIGINT; after grace1 escalates to SIGTERM;
 * after grace2 escalates to SIGKILL. Engine emits `turn.cancelled` tagged with
 * the escalation level actually reached. expectNoZombies() passes afterwards.
 *
 * Coverage split:
 *   - REAL subprocess signal handling is unit-tested in
 *     `packages/backend/tests/real.test.ts` (describe "cancel ladder") with
 *     bash shims that ignore SIGINT/SIGTERM via `trap ''`. Those tests
 *     exercise the actual signal delivery path to the subprocess pgid.
 *   - THIS spine test exercises the envelope-level contract: when cancel()
 *     is invoked against any ClaudeBackend implementation that models the
 *     ladder (here, ChaosBackend with `cancelEscalation: 'sigkill'`), the
 *     resulting event stream terminates with a `turn.cancelled{escalation}`
 *     envelope that propagates through the engine to subscribers.
 *
 * PR: plans/landed/2026-04-23-clod-ui-pr5-cancel-ladder-and-taxonomy-v1.md §7.1
 */
import type { EventEnvelope } from '@clod-ui/contracts';
import { ChaosBackend, ScriptedBackend, TestEnv, expectNoZombies, script } from '@clod-ui/test-kit';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createApp } from '../../apps/engine/src/index.ts';

const CONV_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

let env: TestEnv;

beforeEach(async () => {
  env = await TestEnv.create({ name: 't1.05' });
});

afterEach(async () => {
  await env.dispose();
});

describe('T1.05 cancel ladder', () => {
  test('cancel → turn.cancelled{escalation:"sigkill"} propagates through engine', async () => {
    // The inner scripted backend would normally emit init → delta → result.
    // Chaos layer refuses cancel for 300ms, then honors at escalation=sigkill.
    const built = script()
      .init('s')
      .assistantText('slow thinking')
      .assistantText('more slow thinking')
      .assistantText('final slow thinking')
      .result()
      .end();
    const scripted = new ScriptedBackend(built, { perEventDelayMs: 300 });
    const chaos = new ChaosBackend(scripted, {
      refuseSigtermFor: 300,
      cancelEscalation: 'sigkill',
    });

    const envelopes: EventEnvelope[] = [];
    const ctx = createApp({
      backend: chaos,
      onBroadcast: (envelope) => envelopes.push(envelope),
    });

    // Submit turn.
    const turnId = 'turn-05-sigkill';
    const res = await ctx.app.fetch(
      new Request(`http://x/conversations/${CONV_UUID}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ turn_id: turnId, user_message: 'slow' }),
      }),
    );
    expect(res.status).toBe(202);

    // Wait for at least one non-terminal event so we know startTurn has begun.
    const firstDeadline = Date.now() + 2000;
    while (envelopes.length === 0 && Date.now() < firstDeadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    // Trigger the cancel.
    const cancelRes = await ctx.app.fetch(
      new Request(`http://x/conversations/${CONV_UUID}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ turn_id: turnId }),
      }),
    );
    expect(cancelRes.status).toBe(200);

    // Wait for the terminal envelope.
    const termDeadline = Date.now() + 2000;
    while (Date.now() < termDeadline) {
      const last = envelopes[envelopes.length - 1];
      if (last?.kind === 'turn.cancelled') break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const last = envelopes[envelopes.length - 1];
    expect(last?.kind).toBe('turn.cancelled');
    const payload = last?.payload as {
      kind: 'turn.cancelled';
      escalation: 'sigint' | 'sigterm' | 'sigkill';
    };
    expect(payload.escalation).toBe('sigkill');

    expectNoZombies(env);
  }, 10_000);
});
