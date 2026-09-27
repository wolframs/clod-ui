# PR #17 — Reconnect-and-resume + typed event dispatch

**Status:** in-flight
**Spec sources:**

- `plans/2026-04-23-clod-ui-architecture-v2.md` §Phase 4 Task 4.8
- `plans/landed/2026-04-28-clod-ui-pr13-typed-client-v1.md` §6 (deferred TODOs)
- `docs/INVARIANTS.md` I-2, I-8

## 1 — Slice scope

Closes the deferred `// TODO(reconnect-and-resume)` and `// TODO(typed-event-dispatch)` from PR #13's plan. Three pieces:

1. **Engine-side replay buffer.** Bounded ring buffer keyed by `envelope.id`. Every wrapped envelope passes through it before broadcast. WS upgrades accept a `?since=<env_id>` query parameter; the server replays buffered envelopes strictly _after_ that id before subscribing the new socket to live broadcasts.

2. **Client-side reconnect-and-resume.** `LocalHttpTransport.subscribe` tracks the most recent successfully-received `envelope.id`. On a non-clean close, it schedules a reconnect with exponential backoff (250ms → 500ms → 1s → 2s → 5s, capped) and re-opens the WS with `?since=<last_id>` appended to the URL. The application sees a continuous stream of envelopes; gaps are invisible.

3. **Typed event dispatch sugar.** `subscribe({ on: { 'conversation.titled': h1, 'turn.result': h2 } })` dispatches by `envelope.kind`. The existing `onEnvelope` still works as the catch-all and runs alongside the typed dispatchers.

## 2 — Why now

PR #18-19 (streaming transcript renderer + composer) will subscribe to deltas at component-mount time. Without reconnect-and-resume, every WiFi blip during a streaming response loses content. The replay buffer + `since` protocol is the primitive that makes the entire streaming arc tolerate ephemeral disconnects.

Pinning it _before_ the streaming PRs land also means PR #18 can use the typed dispatch sugar from day one rather than carrying a `switch (env.kind)` ladder in every consumer.

## 3 — Replay buffer contract

```ts
// apps/engine/src/replay-buffer.ts
interface ReplayBuffer {
  push(env: EventEnvelope): void;
  /** Returns envelopes whose id is strictly greater than `sinceId`, in order. */
  since(sinceId: string | null): EventEnvelope[];
  size(): number;
  capacity(): number;
}
```

- Default capacity: **1024 envelopes**. Big enough for ~30s of dense delta streaming, small enough not to bloat memory.
- Eviction is FIFO — when full, the oldest entry is dropped. If a client's `last_id` is older than the oldest buffered entry, the server emits a typed `replay.gap` envelope before resuming live, so the client knows it lost content (UI surfaces this in PR #18).
- IDs are compared lexicographically. `EnvelopeIdSource` already produces zero-padded hex counters in UUID format — string comparison matches numeric ordering as long as the counter doesn't wrap (it won't; 16^12 = 281 trillion).
- Buffer lives **per `createApp` instance**. Two engines = two buffers. No cross-instance state.

## 4 — Engine wiring

`createApp` constructs a `ReplayBuffer` instance. The default broadcast sink in `index.ts` wraps the user-supplied `onBroadcast` so every envelope is `buffer.push(env)`-ed first, then forwarded to the sink. WS upgrades parse `?since=<env_id>` from the URL; on `open`, the server emits the replay batch _then_ subscribes the socket to the live sink.

Two new wire kinds, both on the WS only (per I-8 wire-only):

- `replay.start` — emitted as the first envelope on every WS connection. Carries `{ since: string | null, replayed_count: number, gap: boolean }`. Lets the UI distinguish "fresh subscriber" from "resumed subscriber".
- `replay.gap` — emitted when the requested `sinceId` is older than the buffer's oldest entry. Payload: `{ since: string, oldest_buffered: string | null }`. The UI's `useTranscript` hook will refetch in response (PR #18).

## 5 — Client wiring

`LocalHttpTransport.subscribe` gains internal state:

- `lastEventId: string | null` — updated on every successfully-validated envelope.
- `reconnect: { attempt: number; timer: number | null }` — scheduling state.
- `closed: boolean` — set once the consumer calls `subscription.close()`. Suppresses pending reconnects.

On `ws.close` with a non-1000 code, schedule a reconnect with backoff `[250, 500, 1000, 2000, 5000][attempt] || 5000`. Each reconnect re-opens the WS with `?since=<lastEventId>` (omitted on the very first connection). Successful reception of any envelope resets `attempt = 0`.

`onOpen` fires on **every** successful (re)connection so consumers can show "reconnected" feedback. `onReplay` fires on the synthesized `replay.start` envelope before live envelopes resume.

A new option `reconnect: false | { backoffMs?: number[]; maxAttempts?: number }` lets tests opt out of the default reconnect loop or override timings.

## 6 — Typed dispatch sugar

```ts
client.subscribe({
  on: {
    'conversation.titled': (env) => refreshSidebar(),
    'turn.result': (env) => settleSpinner(env.payload),
  },
  onEnvelope: (env) => audit(env), // still runs for everything
});
```

Implementation: a thin handler-by-kind dispatcher inside `createClient.subscribe`. The transport `onEnvelope` callback iterates the registered handlers for the envelope's kind, then calls the catch-all if one is registered. No type-narrowing of `env.payload` inside the per-kind handler — that's deferred to a future schema-aware `on` overload (named `// TODO(payload-narrowing)`).

## 7 — Spine T1.14

```
test('reconnect-and-resume — sockets see no gap across a forced disconnect')
```

In-process boot: `createApp` + `Bun.serve`, ScriptedBackend producing 5 events. Test flow:

1. Open WS, await `replay.start { since: null }`.
2. Submit a turn; collect the first 2 envelopes.
3. Force-close the WS from the client side.
4. Re-open WS with `?since=<id-of-2nd-envelope>` (simulating what `LocalHttpTransport` does internally).
5. Assert: receive `replay.start { since: <id>, replayed_count: 3, gap: false }` followed by exactly the 3 envelopes the first socket missed.
6. No duplicates, no skipped envelopes, terminator ordering preserved.

Spine count after: **23 / 23 across 14 contracts.** No reserved tests.

## 8 — Deferred / explicitly out of scope

| TODO | Why deferred |
| --- | --- |
| `// TODO(payload-narrowing)` | The handler-by-kind dispatcher receives `EventEnvelope` (`payload: unknown`). A type-narrowing overload requires a schema-per-kind registry that doesn't exist yet. PR #18 may build it for the streaming kinds. |
| `// TODO(server-sent-replay-window-config)` | Buffer capacity is hard-coded at 1024. Future: a `replay: { capacity: number }` option on `createApp`. Not needed until we measure memory. |
| `// TODO(persistent-replay-buffer)` | Buffer is in-memory; an engine restart loses all buffered events. Acceptable: clients reconnect, get `replay.gap`, refetch from the manifest + JSONL. Persistence would be a separate slice. |
| `// TODO(jitter)` | Backoff is deterministic. Production should add ±20% jitter once we have multiple clients colliding on reconnect. |

## 9 — Test plan

- **Replay buffer unit tests** (~10): push under capacity, push over capacity (FIFO eviction), `since(null)` returns full snapshot, `since(latest)` returns empty, `since(oldest_evicted)` returns oldest available + gap signal, ordering preserved across pushes.
- **Engine integration tests** (~3): WS connection without `?since=` gets `replay.start { since: null }`; WS with `?since=<id>` gets `replay.start { since: <id> }` and missed envelopes; WS with `?since=<too_old>` gets `replay.gap`.
- **Client integration tests** (~4): reconnect fires on non-clean close; `?since` is sent on reconnect URL; clean close does not trigger reconnect; backoff escalates; `reconnect: false` opt-out works; `subscription.close()` cancels pending reconnect.
- **Typed dispatch unit tests** (~3): per-kind handler fires only for matching kind; multiple handlers for same kind both fire; `onEnvelope` catch-all fires alongside.
- **Spine T1.14**: end-to-end no-gap assertion.

Total new tests: ~21.

## 10 — Verification gate

- ci:fast green (~423 + 13 = 436 tests target)
- Spine 23 / 23
- 5× T1.14 + replay buffer + LocalHttpTransport reconnect tests = 5/5 green
- 5× full spine green
- Typecheck + lint + format + README link-check clean

## 11 — Cadence

5 commits:

1. `docs(plans): PR #17 plan` (this file)
2. `feat(engine): ReplayBuffer + WS upgrade with ?since=` (replay-buffer.ts + unit tests + index.ts wiring + integration tests)
3. `feat(contracts): reconnect-and-resume + typed event dispatch in client` (LocalHttpTransport + createClient.subscribe + unit tests + integration tests)
4. `test(spine): T1.14 reconnect-and-resume end-to-end` (one new spine file)
5. (only if needed) lint/format/typecheck cleanup pass
