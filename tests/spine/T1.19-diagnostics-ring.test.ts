/**
 * T1.19 — Per-turn diagnostics ring + route.
 *
 * Contract: with diagnostics enabled, every accepted turn records what
 * would spawn — argv with system-prompt text REDACTED at record time
 * (the raw text is never observable on the wire), env key names only,
 * stdin byte size, an ordered event timeline, and a terminal outcome.
 * `GET /diagnostics` lists entries most recent first within the
 * configured capacity. An unconfigured engine answers the exact I-1
 * body `404 { error: 'diagnostics not configured' }`. Wire-only by
 * I-8 — nothing is persisted.
 *
 * PR: plans/2026-06-12-clod-ui-pr32-diagnostics-v1.md §D1–D4/D7.
 */
import { ScriptedBackend, script } from '@clod-ui/test-kit';
import { describe, expect, test } from 'bun:test';

import { createApp } from '../../apps/engine/src/index.ts';

function makeBackend(): ScriptedBackend {
  return new ScriptedBackend(script().init('s-19').assistantText('ok').result().end());
}

async function postTurn(
  ctx: { app: { fetch: (req: Request) => Response | Promise<Response> } },
  body: Record<string, unknown>,
  conv = '19191919-1919-4919-8919-191919191919',
): Promise<Response> {
  return ctx.app.fetch(
    new Request(`http://x/conversations/${conv}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function getDiagnostics(ctx: {
  app: { fetch: (req: Request) => Response | Promise<Response> };
}): Promise<{ turns: Array<Record<string, unknown>> }> {
  const res = await ctx.app.fetch(new Request('http://x/diagnostics'));
  expect(res.status).toBe(200);
  return (await res.json()) as { turns: Array<Record<string, unknown>> };
}

async function waitForOutcome(
  ctx: { app: { fetch: (req: Request) => Response | Promise<Response> } },
  turnId: string,
): Promise<Record<string, unknown>> {
  for (let i = 0; i < 100; i++) {
    const body = await getDiagnostics(ctx);
    const entry = body.turns.find((t) => t['turn_id'] === turnId);
    if (entry && entry['outcome']) return entry;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('diagnostics entry never reached a terminal outcome');
}

describe('T1.19 diagnostics ring', () => {
  test('a turn with a system prompt records redacted argv + keys + timeline + outcome', async () => {
    const ctx = createApp({ backend: makeBackend(), diagnostics: {} });
    const SECRET = 'do not leak this prompt';
    const res = await postTurn(ctx, {
      turn_id: 'turn-19-a',
      user_message: 'hi',
      system_prompt: { mode: 'append', text: SECRET },
    });
    expect(res.status).toBe(202);

    const entry = await waitForOutcome(ctx, 'turn-19-a');
    const argv = entry['argv'] as string[];
    expect(argv[argv.indexOf('--append-system-prompt') + 1]).toBe(
      `[redacted ${SECRET.length} chars]`,
    );
    expect(JSON.stringify(entry)).not.toContain(SECRET);
    expect(Array.isArray(entry['env_keys'])).toBe(true);
    expect(entry['stdin_bytes'] as number).toBeGreaterThan(0);
    const kinds = (entry['events'] as Array<{ kind: string }>).map((e) => e.kind);
    expect(kinds).toEqual(['system.init', 'assistant.delta', 'turn.result']);
    expect(entry['outcome']).toEqual({ kind: 'result' });
  });

  test('capacity bounds the ring; entries are most recent first', async () => {
    const ctx = createApp({ backend: makeBackend(), diagnostics: { capacity: 2 } });
    // Distinct conversations: the per-conv busy guard clears in the pump's
    // `finally`, which can lag the recorded outcome by a microtask.
    let n = 0;
    for (const id of ['turn-19-b', 'turn-19-c', 'turn-19-d']) {
      n++;
      const conv = `19191919-1919-4919-8919-19191919190${n}`;
      const res = await postTurn(ctx, { turn_id: id, user_message: 'hi' }, conv);
      expect(res.status).toBe(202);
      await waitForOutcome(ctx, id);
    }
    const body = await getDiagnostics(ctx);
    expect(body.turns.map((t) => t['turn_id'])).toEqual(['turn-19-d', 'turn-19-c']);
  });

  test('unconfigured engine answers the exact I-1 not-configured body', async () => {
    const ctx = createApp({ backend: makeBackend() });
    const res = await ctx.app.fetch(new Request('http://x/diagnostics'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'diagnostics not configured' });
  });
});
