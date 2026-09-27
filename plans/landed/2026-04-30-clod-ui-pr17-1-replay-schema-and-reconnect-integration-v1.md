# PR #17.1 — `replay.start` typed payload + transient-drop integration test

**Status:** active
**Lineage:** follow-up to PR #17 (reconnect-and-resume); pre-cursor to PR #18 (streaming transcript renderer)
**Date:** 2026-04-30

---

## 1. Why this PR exists

PR #17 closed the architectural gap (replay buffer + state-machine transport + per-kind dispatch) but left two real loose ends surfaced in the post-merge inspection:

1. **The `replay.start` control envelope's payload is typed nowhere.** It crosses the wire as `EventEnvelope.payload = unknown`. The engine constructs it via an inline object literal; consumers reach into `unknown` to read `replayed_count` / `gap`. PR #18's transcript renderer will be the first consumer that genuinely needs to act on `gap: true` ("buffer too small, refetch from manifest"), and at that point reaching into `unknown` becomes a real footgun.

2. **The transient-server-side-WS-drop path has no executing test.** PR #17 covers the consumer-initiated close path (spine T1.14), the unit-tier reconnect state machine (FakeWebSocket + manual scheduler), and the engine's replay-on-upgrade behavior (replay-ws.test.ts). What's untested end-to-end is the **production scenario**: a live socket dropping with a non-1000 close code while the server stays up, the client autonomously reconnecting, and the engine replaying the missed envelopes. The state machine handles it; nothing pins it.

Both are small, both close real risks, both want to land before PR #18 layers UI on top of the wire.

---

## 2. Scope (and non-scope)

**In scope:**

- Typed `ReplayStartPayloadSchema` + `REPLAY_START_SENTINEL_ID` constant exported from `@clod-ui/contracts`.
- Engine imports the constant from contracts (single source of truth) instead of defining it locally.
- New `client-reconnect-integration.test.ts` boots the engine with the production-style replay-aware WS upgrade handler, drops the live socket from the server side with code 1006, and asserts the client (with default reconnect on) reconnects and receives the missed envelopes via `?since=`.

**Out of scope:**

- Validating `replay.start` payloads on consumers. The schema is *available*; whether to validate is a per-consumer call. The transport already silently drops envelopes that fail the *envelope* schema — narrowing payload-by-kind is `// TODO(payload-narrowing)` from PR #17 §8 and stays open.
- Recovering from `gap: true` by refetching from the manifest. Queued for PR #18 once a consumer has a UI affordance to trigger it.
- Multi-client load tests, server-restart-on-same-port reconnect tests. Both are "real" production paths but neither will be hit before Phase 7 (resilience polish).

---

## 3. The schema

Lands in `packages/contracts/src/replay.ts`:

```ts
export const REPLAY_START_KIND = 'replay.start' as const;
export const REPLAY_START_SENTINEL_ID = '00000000-0000-4000-8000-000000000000';

export const ReplayStartPayloadSchema = z.object({
  kind: z.literal(REPLAY_START_KIND),
  since: z.string().uuid().nullable(),
  replayed_count: z.number().int().nonnegative(),
  gap: z.boolean(),
});

export type ReplayStartPayload = z.infer<typeof ReplayStartPayloadSchema>;
```

Re-exported from `@clod-ui/contracts/index.ts`. The engine's `apps/engine/src/index.ts` imports `REPLAY_START_SENTINEL_ID` from `@clod-ui/contracts` and re-exports it for back-compat (the existing engine tests + replay-ws.test.ts already import it from the engine module).

**Why a literal-string constant alongside the schema:** consumers that *don't* validate still want the sentinel id to compare against (the transport's lex-cursor advancement check). One source of truth for the string value avoids drift if the sentinel ever needs to change.

---

## 4. The integration test

Lands in `packages/contracts/tests/client-reconnect-integration.test.ts` (new file — `client-integration.test.ts` stays focused on HTTP + simple WS).

Boot pattern: production-style replay-aware WS upgrade handler (mirrors `replay-ws.test.ts` and the production entrypoint), but the test owns the live-socket Set so it can force-drop.

Two contracts:

1. **Server-side socket drop with code 1006 triggers client reconnect with `?since=<lastSeen>`; missed envelopes arrive via replay.**
   - Subscribe with default reconnect on. Drive turn 1; record `lastSeen = max(envelope.id)` over the received batch.
   - Force-close the live socket from server with `ws.close(1006, 'transient drop')`. (Assert client received the close event, attempted reconnect.)
   - Drive turn 2 *while the client is reconnecting* — its envelopes land in the replay buffer.
   - Assert the client receives turn 2's envelopes after reconnect, all with `id > lastSeen`, in order.
   - Assert no envelope is delivered twice (no overlap with phase-1 batch).

2. **Reconnect URL carries `?since=<lastEventId>` after a non-clean close; sentinel ids do not advance the cursor.**
   - Subscribe; the very first envelope received is `replay.start` with the sentinel id.
   - Server-drop. Reconnect URL inspected via a server-side route that captures the last upgrade URL.
   - Assert the captured `?since=` value equals the *last real envelope id* the client received before the drop, not the sentinel.

Test scheduler stays real (`setTimeout`); backoff is the default `[250, 500, ...]` schedule, so each test waits ≤ 250 ms for the first reconnect attempt + up to 500 ms for envelopes to land. ~1.5s test budget is reasonable; if it ends up flakier than expected, we'll switch to an injected scheduler.

---

## 5. Verification

- 4 new contracts tests (2 schema, 2 integration).
- `bun test` for `packages/contracts/tests/replay.test.ts` (new) + `client-reconnect-integration.test.ts`.
- Engine + spine still green (no behavior change to the engine; the constant move is identifier-equivalent).
- 5× flake check on the new integration test.
- 5× full spine.

---

## 6. Deferred tickets

- `// TODO(payload-narrowing)` — opt-in per-consumer payload schema validation. Stays open from PR #17 §8.
- `// TODO(replay-gap-recovery)` — surface `gap: true` in a UI-visible way + offer "refetch from manifest" affordance. Queued for PR #18.
- `// TODO(server-restart-reconnect)` — test the scenario where the engine itself restarts (not just a socket drop). Queued for Phase 7 resilience.

---

## 7. Why this slice and not just-do-A

The user agreed that B → C → A is the right ordering after the inspection. A (the `useSubscribe` React hook) is the natural next streaming-arc slice; B + C are the kind of pre-arc maintenance that pays itself back many times — landing them as their own PR keeps the streaming arc PRs focused on the new behavior they introduce, not on the lift cost of fixing infrastructure mid-stream.

The cadence stays the same: types-first → first concrete consumer → test depth at the layer that consumes. Here the schema lands first (types), the integration test exercises the consumer path (concrete), and the test itself uses the typed schema (depth + recursion).
