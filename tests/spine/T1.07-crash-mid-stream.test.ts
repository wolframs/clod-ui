/**
 * T1.07 — Crash mid-stream.
 *
 * Contract: ChaosBackend throws after the 3rd event. Engine routes the thrown
 * error through `classifyCliFailure` and broadcasts a terminal
 * `turn.error{kind: 'cli_crashed', retryable: true}` envelope. Exactly the
 * first 3 events + 1 turn.error are broadcast; no zombies.
 *
 * PR: plans/landed/2026-04-23-clod-ui-pr5-cancel-ladder-and-taxonomy-v1.md §7.3
 */
import type { EventEnvelope } from '@clod-ui/contracts';
import { ChaosBackend, ScriptedBackend, TestEnv, expectNoZombies, script } from '@clod-ui/test-kit';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createApp } from '../../apps/engine/src/index.ts';

const CONV_UUID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

let env: TestEnv;

beforeEach(async () => {
  env = await TestEnv.create({ name: 't1.07' });
});

afterEach(async () => {
  await env.dispose();
});

describe('T1.07 crash mid-stream', () => {
  test('crashAfterEvents:3 → 3 events + 1 turn.error{cli_crashed, retryable:true}', async () => {
    const built = script()
      .init('s')
      .assistantText('a')
      .assistantText('b')
      .assistantText('c')
      .assistantText('d')
      .result()
      .end();
    const scripted = new ScriptedBackend(built);
    const chaos = new ChaosBackend(scripted, { crashAfterEvents: 3 });

    const envelopes: EventEnvelope[] = [];
    const ctx = createApp({
      backend: chaos,
      onBroadcast: (envelope) => envelopes.push(envelope),
    });

    const turnId = 'turn-07-crash';
    const res = await ctx.app.fetch(
      new Request(`http://x/conversations/${CONV_UUID}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ turn_id: turnId, user_message: 'hi' }),
      }),
    );
    expect(res.status).toBe(202);

    // Wait for terminal envelope.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const last = envelopes[envelopes.length - 1];
      if (last?.kind === 'turn.error') break;
      await new Promise((r) => setTimeout(r, 20));
    }

    // 3 non-terminal events emitted before crash + 1 terminal turn.error.
    expect(envelopes.length).toBe(4);
    const kinds = envelopes.map((e) => e.kind);
    expect(kinds.slice(0, 3)).toEqual(['system.init', 'assistant.delta', 'assistant.delta']);
    expect(kinds[3]).toBe('turn.error');

    const errPayload = envelopes[3]?.payload as {
      error: { kind: string; retryable: boolean };
    };
    expect(errPayload.error.kind).toBe('cli_crashed');
    expect(errPayload.error.retryable).toBe(true);

    expectNoZombies(env);
  }, 10_000);
});
