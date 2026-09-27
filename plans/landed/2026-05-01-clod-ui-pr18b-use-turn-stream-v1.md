# PR #18b — `useTurnStream`: streaming accumulator over the active turn

**Date:** 2026-05-01
**Phase:** 4 (Web UI Scaffolding) — Task 4.4 (streaming message renderer, foundation)
**Slot:** Second of three sub-PRs in the streaming-renderer arc.
**Predecessors:** PR #17 (replay-buffer + reconnect transport), PR #17.1 (typed `replay.start` schema + transient-drop integration test), PR #18a (`useSubscribe` hook).
**Successors:** PR #18c (`<TranscriptList />` virtualization + markdown + tool cards).

## 1 — Why this slice, why now

PR #18a landed the seam: a React hook that holds a typed-client subscription open across renders, with discriminated state, ref-stable handlers, and a clean `enabled` gate. What it doesn't do is **understand the wire's payload**. It treats every `EventEnvelope` opaquely and forwards it to the consumer.

The streaming renderer needs the next layer up: a hook that takes the same wire stream, **filters by `conv_id`**, **dispatches by `kind`**, and **accumulates into a typed projection** the renderer can read directly. That's `useTurnStream`.

Today, with PR #18a, a renderer that wants to display "the assistant is currently typing" would have to:

1. Call `useSubscribe`
2. Manually filter envelopes by `conv_id`
3. Maintain its own `useState` for accumulated text
4. Maintain its own `useState` for tool calls
5. Manually dispatch on `envelope.kind`
6. Cast `envelope.payload as unknown` and narrow it
7. Reset all of the above when a new `system.init` arrives

Multiplied by every component that wants this view, the cost is unbearable and the failure modes (state loss across re-render, stale closures over deltas, double-application after reconnect-replay) are exactly the sort of bug that white-screens a streaming UI. The hook centralizes all of it.

## 2 — Wire shape (sourced from `packages/backend/src/types.ts:10-44`)

The engine wraps these into `EventEnvelope`s with `conv_id` populated:

| Backend kind | Payload (relevant fields) | Effect on `TurnState` |
|---|---|---|
| `system.init` | `turn_id`, `session_id` | Start fresh turn (resets accumulator); records `session_id` |
| `assistant.delta` | `turn_id`, `text` | Append to `assistant_text` |
| `assistant.complete` | `turn_id` | Sets `assistant_complete: true` |
| `thinking.delta` | `turn_id`, `text` | Append to `thinking_text` |
| `thinking.complete` | `turn_id` | Sets `thinking_complete: true` |
| `tool.use` | `turn_id`, `tool_use_id`, `name`, `input` | Push `{ status: 'pending', name, input, ... }` to `tools` |
| `tool.result` | `turn_id`, `tool_use_id`, `content` | Update matching tool to `{ status: 'success', result: content }` |
| `tool.error` | `turn_id`, `tool_use_id`, `message` | Update matching tool to `{ status: 'error', error_message }` |
| `turn.result` | `turn_id`, `usage?` | Status → `completed`; records `usage` |
| `turn.cancelled` | `turn_id`, `escalation` | Status → `cancelled`; records `escalation` |
| `turn.error` | `turn_id`, `error: ClodError` | Status → `errored`; records `error` |

Plus the control envelope:

| Wire kind | Effect |
|---|---|
| `replay.start` | **Ignored.** Not part of turn state; the reducer is pure data layer. |

## 3 — `TurnState` shape

```ts
type ToolCall = {
  tool_use_id: string;
  name: string;
  input: unknown;
  status: 'pending' | 'success' | 'error';
  result?: unknown;       // present iff status === 'success'
  error_message?: string; // present iff status === 'error'
};

type TurnState =
  | { status: 'idle' }
  | {
      status: 'streaming' | 'completed' | 'cancelled' | 'errored';
      turn_id: string;
      session_id?: string;
      assistant_text: string;
      assistant_complete: boolean;
      thinking_text: string;
      thinking_complete: boolean;
      tools: ToolCall[];
      usage?: { input_tokens?: number; output_tokens?: number };
      escalation?: 'sigint' | 'sigterm' | 'sigkill';
      error?: ClodError;
    };
```

Discriminated on `status`, matching the established hook template (I-8 in `docs/INVARIANTS.md`). `idle` is the pre-stream state; the four other statuses share the same fields so the renderer can read `assistant_text` etc. without status-narrowing first.

## 4 — `turnReducer` purity

The reducer is a **pure function**: `(prev: TurnState, env: EventEnvelope) => TurnState`. No closures, no I/O, no shared mutable state. This means:

- **Unit-testable in isolation.** No fake hooks, no fake transport — just construct envelopes, call the reducer, assert. Fast (sub-1ms per test) and zero-flake.
- **Deterministic replay.** A consumer that loses the in-memory state can re-derive it from the WS replay by folding the reducer over `(initialState, [env_1, env_2, ...])`. No special-case "I'm in replay mode" branch needed.
- **Idempotent under double-application.** If reconnect-replay redelivers an envelope already folded, applying it twice should produce the same state. The reducer ensures this for every kind:
  - `assistant.delta`: text concatenation is **not** idempotent at the data layer — but the engine's replay buffer never re-emits an envelope already past `?since=<lastEventId>` (PR #17 contract). So idempotency is an engine-side invariant, not a reducer-side one. The reducer assumes deduplication has already happened.
  - All other kinds: setters or list-updates that produce the same end state under double-application *given dedup at the wire layer*.

The deferred `// TODO(reducer-idempotency-tests)` is queued for the moment a test surface needs to prove this end-to-end against replay envelopes that the reducer sees twice.

## 5 — `useTurnStream(client, { conv_id, enabled?, since? })` hook

Composes `useSubscribe` underneath:

```ts
const { client } = useEngine();
const turn = useTurnStream(client, { conv_id });
```

Internals:

1. `useSubscribe(client, handlers, { enabled, since })` opens the WS.
2. The hook owns a `useState<TurnState>({ status: 'idle' })`.
3. `handlers.onEnvelope = (env) => { if (env.conv_id !== conv_id) return; setState(prev => turnReducer(prev, env)); }`.
4. When `conv_id` or `enabled` changes, the state resets to `{ status: 'idle' }` so the consumer never sees stale data from the previous conversation flash before the first envelope of the new one arrives.

The hook **returns `TurnState`** directly — no wrapper object, no `refresh()`. For streams the live updates ARE the refresh.

## 6 — Why a reducer instead of inline `useState` updates

Two reasons:

1. **Testability surface area.** The reducer is the entire "what does this kind of envelope mean?" layer. By keeping it pure, every wire-shape change becomes a one-line test addition in `turn-reducer.test.ts` rather than a mock-the-hook rewrite. The unit tests cover ~24 cases (each kind × happy/edge); the hook tests cover ~6 cases (conv_id filter, reset semantics, enabled gate, lifecycle integration).
2. **Future use beyond React.** A non-React surface (CLI inspector, replay debugger, log-replay tool) can fold `turnReducer` over a recorded envelope stream and get back the same `TurnState` the UI would have shown. That property is worth the small extra indirection.

## 7 — Boundaries (what this PR does NOT do)

- **No historical message rendering.** Past turns of the conversation come from the JSONL transcript via the (future) `useTranscript` hook. `useTurnStream` is *only* the active turn projection.
- **No virtualization.** The renderer in PR #18c handles scroll/scroll-to-bottom/markdown/tool-card visuals.
- **No optimistic user-message rendering.** The user's submitted message is shown by the composer (PR #19) before `system.init` arrives. `useTurnStream` starts at `idle` and only fills in once the wire confirms the turn exists.
- **No reducer-level idempotency tests.** Deferred behind `// TODO(reducer-idempotency-tests)` until a real consumer can replay envelopes that the reducer sees twice.

## 8 — Test plan

| Tier | Coverage |
|---|---|
| **Unit** (`apps/web/tests/turn-reducer.test.ts`, bun test, renderToString-tier) | ~24 tests covering every kind transition, edge cases (mismatched `tool_use_id`, kind-out-of-order, unknown kind), the `replay.start` ignore branch, and the `system.init` reset semantic |
| **DOM** (`apps/web/tests/dom/use-turn-stream.test.tsx`, vitest+RTL) | ~6 tests covering: `conv_id` filter (envelopes for other convs ignored); state reset on `conv_id` change; `enabled` gate (hook stays idle); end-to-end lifecycle via the fake-client driver pattern; mid-stream cancel surfaces `escalation`; mid-stream error surfaces `error` |

Each tier is hermetic. Fake-client + driver from PR #18a continues to be the testing seam.

## 9 — Deferred (named, queued, not parked)

- `// TODO(reducer-idempotency-tests)` — proves under-test what the engine's replay-buffer already guarantees-by-construction; queued for the first consumer that needs to fold replays.
- `// TODO(turn-history)` — `useTurnStream` only sees the current turn. The next slice's `useTranscript` will project the JSONL into a list of past turns; `useTurnStream` will compose with it but not absorb it.
- `// TODO(structured-content)` — `assistant_text` is the flattened concatenation of all `assistant.delta` text payloads. Future support for `ChatMessage`-style structured content blocks (PR #9's `ContentBlock` schema) lands here when the renderer needs them.

## 10 — Acceptance

- `turnReducer` lands as a pure function with ~24 unit tests, all green.
- `useTurnStream` lands as a hook composing `useSubscribe`, with ~6 DOM tests, all green.
- ci:fast green; spine 24 / 24 unchanged; 5× flake-check green on new tests + full spine.
- No new TODOs without queueing in the deferred-tickets table above.
- No engine-side change. (PR #18b is purely a web-side projection layer.)
