# PR #18a — `useSubscribe` React hook (streaming arc foundation)

**Status:** active
**Lineage:** Phase 4 streaming arc; foundation for PR #18b (transcript renderer) and PR #19 (composer)
**Date:** 2026-04-30

---

## 1. Why this PR exists

The streaming arc (PR #18b/c — transcript renderer; PR #19 — composer) is the first batch of UI consumers that reaches through `client.subscribe(...)`. Each will want:

- Per-kind envelope dispatch (`'transcript.updated'`, `'turn.result'`, `'conversation.titled'`, etc.)
- A discriminated connection-state machine the UI can render (offline indicator, "reconnecting…" badge)
- Ref-stable handler forwarding (no re-subscribing every render)
- Lifecycle parity with `useHealth` / `useConversations` (mount → open → unmount cleanup)
- Reconnect-and-resume baked in by default (the transport handles it; the hook surfaces the state)

Rather than have each consumer wire `useEffect + client.subscribe + cleanup` independently — duplicating ref-management, state tracking, and unmount safety three times — `useSubscribe` lands as the seam they all reach through.

---

## 2. Scope (and non-scope)

**In scope:**

- `apps/web/src/lib/use-subscribe.ts` — the hook + `SubscribeState` discriminated union + `UseSubscribeOptions` type.
- DOM lifecycle tests (vitest+RTL) covering: state transitions, ref-stable handler dispatch, `enabled: false`, unmount cleanup, reconnect-state surfacing.
- One render-side `data-state` marker invariant established (`I-3`-aligned) so future consumers can render conditional UI without coupling to internal state.

**Out of scope:**

- The transcript renderer itself (PR #18b).
- The composer (PR #19).
- Persisting `lastEventId` across remounts (the transport tracks it within a subscription; cross-mount persistence is a session-state concern for higher-level state, not this hook).
- A `useTurnStream` hook that maintains a partial-message accumulator from `assistant.delta` envelopes — that's PR #18b territory, layered on top of `useSubscribe`.
- Type-narrowing of `env.payload` per kind (still queued behind `// TODO(payload-narrowing)` from PR #17 §8).

---

## 3. Surface

```ts
export interface UseSubscribeOptions {
  /**
   * Per-kind handler dispatch. The hook stashes the latest snapshot in a
   * ref every render, so changing handlers does NOT re-subscribe — a
   * critical property for components that derive handlers from props or
   * other hooks.
   */
  on?: Record<string, (env: EventEnvelope) => void>;
  /** Catch-all envelope handler. Same ref-stability semantics as `on`. */
  onEnvelope?: (env: EventEnvelope) => void;
  /**
   * Initial replay cursor. Only consulted on the first subscription;
   * subsequent reconnects use the transport's internal lastEventId.
   */
  since?: string;
  /**
   * Reconnect policy. Defaults to enabled with the transport's standard
   * exponential backoff. `false` disables reconnects entirely.
   */
  reconnect?: false | { backoffMs?: number[]; maxAttempts?: number };
  /**
   * When `false`, no subscription opens and state stays 'idle'. Useful
   * for feature flags, route-conditional subscriptions, or SSR. Toggling
   * to `true` opens a subscription; toggling back to `false` closes it.
   * Default: `true`.
   */
  enabled?: boolean;
}

export type SubscribeState =
  | { status: 'idle' }                                  // disabled or pre-mount
  | { status: 'connecting' }                            // initial open or reconnect in flight
  | { status: 'open' }                                  // live socket
  | { status: 'reconnecting'; lastClose: { code: number; reason: string } }
  | { status: 'closed'; lastClose: { code: number; reason: string } };

export function useSubscribe(options: UseSubscribeOptions): SubscribeState;
```

State transitions:

```
   ┌─ enabled: false ──────────────────► idle
   │
   │              open()                 close (1000 or reconnect: false)
mount ──► connecting ─────► open ───────────────────────────────────► closed
   │       ▲                  │
   │       │                  │ close (non-1000, reconnect on)
   │       └─────── reconnecting ◄──────┘
   │
unmount: any → close subscription, no state update (component is gone)
```

`closed` differs from `reconnecting` only in whether the transport will retry. When `reconnect: false` and a non-clean close happens, we land in `closed` with the close code; when `reconnect` is on (default), the same event lands in `reconnecting` and the next `open()` brings us back.

---

## 4. Implementation notes

- **Ref-stable handlers**: handlers stash into `useRef` every render; the effect reads `ref.current` per envelope. The effect's deps are `[client, enabled, since, reconnect]` — re-subscribe only on engine change or configuration change.
- **`reconnect` is reference-stable**: comparing reconnect configs by `JSON.stringify` would be fragile; the contract is "the consumer should pass a stable `reconnect` value, typically `undefined` (default) or a `useMemo`-wrapped object". This matches the React conventions for option objects.
- **State updates are guarded by a `cancelled` ref** to prevent setState-after-unmount warnings in StrictMode (which double-invokes effect setup/teardown).
- **`enabled: false` → close existing subscription if any** + state transitions to `idle`.

---

## 5. Tests

DOM tests (`apps/web/tests/dom/use-subscribe.test.tsx`) using vitest+RTL+happy-dom + a `FakeClient` with a controllable subscribe seam:

1. Initial state when `enabled` (default): renders `connecting`; `subscribe` was called once.
2. Transitions to `open` when transport calls `onOpen`.
3. Forwards `onEnvelope` handler to every envelope; respects ref stability (changing the handler between renders does *not* re-subscribe).
4. Forwards `on[kind]` handler for matching envelopes; non-matching kinds skip the per-kind handler but still fire `onEnvelope`.
5. Transitions to `reconnecting` on non-1000 close; stashes the close code + reason.
6. Transitions back to `open` on subsequent open after reconnect.
7. Transitions to `closed` (not `reconnecting`) when `reconnect: false` and a non-1000 close happens.
8. `enabled: false` initially → state is `idle`; `subscribe` not called.
9. `enabled: true → false` post-mount → subscription closes; state `idle`.
10. `enabled: false → true` post-mount → subscription opens; state `connecting → open`.
11. Unmount closes subscription (transport's `subscription.close()` called; no state update after unmount).
12. Changing the handler ref between renders does NOT call `subscribe` again (ref-stability invariant).
13. `since` is forwarded to the transport on first subscribe.

---

## 6. Verification

- ~13 new vitest tests.
- ci:fast green (bun + vitest paths).
- Spine still 24 / 24 unchanged (pure UI hook PR; no spine surface change).
- 5× flake check on `use-subscribe.test.tsx`.

---

## 7. Deferred tickets

- `// TODO(payload-narrowing)` — kind-narrowed envelope payloads. Stays open from PR #17 §8.
- `// TODO(use-turn-stream)` — `assistant.delta` accumulator hook layered on `useSubscribe`. Lands in PR #18b.
- `// TODO(connection-badge)` — UI component rendering the `SubscribeState`. Lands in PR #18b alongside the renderer.
- `// TODO(replay-gap-recovery)` — surface `gap: true` on `replay.start` envelopes through the hook (currently the consumer would have to register an `on['replay.start']` handler manually). Queued for when a consumer needs it.
