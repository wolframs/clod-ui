/**
 * T1.04 — Streaming ordering invariants.
 *
 * Contract: for every turn the engine streams,
 *   1. `turn.result` is the last envelope (no events arrive after it),
 *   2. every `tool.use` is paired with exactly one `tool.result` or
 *      `tool.error` for the same `tool_use_id` before the turn ends,
 *   3. `assistant.delta` text chunks arrive in the exact order the backend
 *      produced them (the envelope layer does not reorder).
 *
 * Property-style: N random valid scripts per run, a deterministic PRNG seed
 * printed on any failure so the failing case is reproducible.
 */
import type { EventEnvelope } from '@clod-ui/contracts';
import { MockEngineServer, ScriptedBackend, TypedTestClient, script } from '@clod-ui/test-kit';
import { afterEach, describe, expect, test } from 'bun:test';

// Mulberry32 — tiny, deterministic, no deps.
function prng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

interface ScriptShape {
  assistantDeltas: string[];
  tools: Array<{ id: string; name: string; errored: boolean }>;
}

/**
 * Generate a random valid event script. "Valid" means: assistant deltas in
 * a fixed order, every tool.use is followed by a result-or-error with the
 * same tool_use_id, the sequence ends with turn.result.
 */
function genScript(rng: () => number): {
  built: ReturnType<ReturnType<typeof script>['end']>;
  shape: ScriptShape;
} {
  const numDeltas = Math.floor(rng() * 4); // 0..3
  const numTools = Math.floor(rng() * 3); // 0..2
  const b = script().init(`sess-${Math.floor(rng() * 1e6)}`);
  const assistantDeltas: string[] = [];
  for (let i = 0; i < numDeltas; i++) {
    const text = `d${i}-${Math.floor(rng() * 1e4).toString(16)}`;
    assistantDeltas.push(text);
    b.assistantText(text);
  }
  const tools: Array<{ id: string; name: string; errored: boolean }> = [];
  for (let i = 0; i < numTools; i++) {
    const id = `tu-${i}-${Math.floor(rng() * 1e4).toString(16)}`;
    const name = ['Read', 'Edit', 'Bash'][Math.floor(rng() * 3)] ?? 'Read';
    const errored = rng() < 0.25;
    b.toolUse(name, { idx: i }, id);
    if (errored) {
      b.toolError(`synthetic failure #${i}`, id);
    } else {
      b.toolResult({ ok: true, idx: i }, id);
    }
    tools.push({ id, name, errored });
  }
  return { built: b.result().end(), shape: { assistantDeltas, tools } };
}

const SEED_ENV = process.env['T1_04_SEED'];
const BASE_SEED = SEED_ENV !== undefined ? Number(SEED_ENV) : 0xc10d01;
const SCRIPTS_PER_RUN = 10;

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const fn = cleanup.pop();
    if (fn) await fn().catch(() => {});
  }
});

async function runOneScript(seed: number): Promise<void> {
  const rng = prng(seed);
  const { built, shape } = genScript(rng);

  const server = new MockEngineServer({ backend: new ScriptedBackend(built) });
  cleanup.push(() => server.stop());
  const { url } = await server.start(0);

  const client = new TypedTestClient({ baseUrl: url });
  cleanup.push(() => client.close());
  await client.connect();

  const convId = '00000000-0000-4000-8000-000000000001';
  const turnId = `turn-${seed}`;
  await client.submitTurn({ conv_id: convId, turn_id: turnId, user_message: 'go' });

  // Wait until we observe the turn.result (final envelope for this turn).
  const resultEnv = await client.awaitEvent(
    {
      conv_id: convId,
      predicate: (e) => envPayloadTurnId(e) === turnId && e.kind === 'turn.result',
    },
    { timeout: 3000 },
  );
  // Small settling delay in case a stray envelope arrives *after* turn.result
  // (it shouldn't; this catches a bug if it ever does).
  await new Promise((r) => setTimeout(r, 20));

  const allForTurn = client.recordEvents(convId).filter((e) => envPayloadTurnId(e) === turnId);

  // Invariant 1: turn.result is the strict last envelope.
  expect(allForTurn.length).toBeGreaterThan(0);
  expect(allForTurn[allForTurn.length - 1]?.id).toBe(resultEnv.id);
  expect(allForTurn.filter((e) => e.kind === 'turn.result').length).toBe(1);

  // Invariant 2: every tool.use has a matching tool.result/tool.error before
  // turn.result, with the same tool_use_id.
  const seenToolUses = new Map<string, number>(); // id → index
  const seenToolClosers = new Map<string, number>();
  for (let i = 0; i < allForTurn.length; i++) {
    const env = allForTurn[i]!;
    const payload = env.payload as Record<string, unknown>;
    const id = payload['tool_use_id'] as string | undefined;
    if (env.kind === 'tool.use' && id) seenToolUses.set(id, i);
    if ((env.kind === 'tool.result' || env.kind === 'tool.error') && id) seenToolClosers.set(id, i);
  }
  for (const { id, errored } of shape.tools) {
    const useAt = seenToolUses.get(id);
    const closeAt = seenToolClosers.get(id);
    expect(useAt).toBeDefined();
    expect(closeAt).toBeDefined();
    expect(closeAt!).toBeGreaterThan(useAt!);
    const closerKind = allForTurn[closeAt!]?.kind;
    expect(closerKind).toBe(errored ? 'tool.error' : 'tool.result');
  }

  // Invariant 3: assistant.delta text order preserved.
  const deltaTexts = allForTurn
    .filter((e) => e.kind === 'assistant.delta')
    .map((e) => (e.payload as { text: string }).text);
  expect(deltaTexts).toEqual(shape.assistantDeltas);
}

function envPayloadTurnId(env: EventEnvelope): string | undefined {
  const p = env.payload as { turn_id?: string } | null;
  return p?.turn_id;
}

describe('T1.04 streaming ordering', () => {
  test(`invariants hold across ${SCRIPTS_PER_RUN} random scripts (seed=${BASE_SEED.toString(16)})`, async () => {
    for (let i = 0; i < SCRIPTS_PER_RUN; i++) {
      const seed = (BASE_SEED + i) >>> 0;
      try {
        await runOneScript(seed);
      } catch (err) {
        // Surface the offending seed so the failure is reproducible:
        //   T1_04_SEED=0x<seed> bun test tests/spine/T1.04-streaming-ordering.test.ts

        console.error(`T1.04 failed at iteration ${i}, seed=0x${seed.toString(16)}`);
        throw err;
      }
    }
  });
});
