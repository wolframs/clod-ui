# PR #13 — `@clod-ui/contracts/client` typed client + `LocalHttpTransport`

**Status:** in-progress
**Phase:** 4 (Web UI Scaffolding) — foundation
**Closes:** Architecture Task 1.2 (typed client factory) and unblocks Task 4.2 (engine wiring from the React app).

## 1. Why now

Phase 4 is eight tasks deep (4.1–4.8) and every single one of them needs *some* way to talk to the engine. The previous template cadence (types-first → pure module → first concrete consumer → in-process tests) means the *typed client* must land before any UI work, the same way `@clod-ui/contracts` had to land before any engine route.

The architecture plan parks this deliverable in **Phase 1.2**, not Phase 4 — it's a contracts package surface. PR #1–#12 deferred it because no consumer existed yet; spine tests rolled their own `TypedTestClient` in `@clod-ui/test-kit`. Now that the engine surface is stable and the web app is about to consume it, we promote the test-only client's design into a transport-agnostic contract layer.

## 2. Scope

**In:**

- New `@clod-ui/contracts/client` subpath export (`@clod-ui/contracts/client`).
- `Transport` interface — the adapter seam between the client and the wire.
- `LocalHttpTransport` — concrete implementation using `fetch` + `WebSocket`. Targets a Bun.serve engine at `http://host:port`.
- `createClient({ transport })` factory — typed methods over every existing engine route, plus a typed WS subscriber. All payloads validated through the existing Zod schemas in `@clod-ui/contracts`.
- Unit tests against an in-memory `FakeTransport` covering every method, schema-validation failure paths, and the WS subscriber's typed dispatch.
- Integration test booting a real `createApp` + `Bun.serve` and exercising the client end-to-end over HTTP **and** WS.

**Out (deferred):**

- React `EngineProvider` context — PR #14 (Task 4.2 wiring half).
- Reconnection state machine + exponential backoff — PR #15 (Task 4.8).
- `RemoteWS` transport — beyond Phase 4.
- Pagination cursor wiring on `getConversations` — folds in when the route grows it (PR #12 left this as a forward-pointer).

## 3. The `Transport` seam

The interface is the contract; everything else is implementation detail.

```ts
export interface Transport {
  /** HTTP request. Returns the parsed JSON body on 2xx; throws on 4xx/5xx. */
  request(opts: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;                    // e.g. '/conversations', '/settings'
    body?: unknown;                  // JSON-serializable
    signal?: AbortSignal;
  }): Promise<unknown>;

  /** Open a WS connection. Returns a typed subscription handle. */
  subscribe(opts: {
    path: string;                    // e.g. '/ws'
    onEnvelope: (env: EventEnvelope) => void;
    onOpen?: () => void;
    onClose?: (ev: { code: number; reason: string }) => void;
    onError?: (err: Error) => void;
  }): { close: () => void };
}
```

**Why this shape:**

- HTTP is request/response, WS is fire-and-forget streaming — they don't share a return type, so they don't share a method.
- `signal: AbortSignal` is exposed for callers that need cancellation (composable with React's `AbortController` lifecycle, future React-Query bindings).
- The `onEnvelope` callback receives an *already-parsed-and-validated* `EventEnvelope`; transport-level concerns (string `JSON.parse`, schema check) live in the transport, not the consumer. Failures are silent (matches `TypedTestClient` precedent — invalid envelopes drop, never throw to user code).

`LocalHttpTransport` constructs from `{ baseUrl, fetch?, WebSocket? }` so tests can inject Bun-side polyfills if ever needed; production callers pass nothing and get the global `fetch` + `WebSocket`.

## 4. The client surface

`createClient({ transport })` returns one object exposing every engine route + a `subscribe` method:

```ts
interface Client {
  // /health
  getHealth(opts?: { signal?: AbortSignal }): Promise<HealthResponse>;

  // /settings (404 → throws ClientNotConfiguredError)
  getSettings(opts?: { signal?: AbortSignal }): Promise<ClaudeSettings>;
  putSettings(body: ClaudeSettings, opts?: { signal?: AbortSignal }): Promise<ClaudeSettings>;
  patchSettings(body: Partial<ClaudeSettings>, opts?: { signal?: AbortSignal }): Promise<ClaudeSettings>;

  // /conversations (404 → throws ClientNotConfiguredError)
  getConversations(opts?: { signal?: AbortSignal }): Promise<ConversationsListResponse>;

  // /conversations/:id/turns + /cancel
  submitTurn(input: SubmitTurnInput, opts?: { signal?: AbortSignal }): Promise<void>;
  cancelTurn(input: { conv_id: string; turn_id: string }, opts?: { signal?: AbortSignal }): Promise<void>;

  // /ws
  subscribe(handlers: SubscribeHandlers): Subscription;
}
```

Every Promise either resolves with a Zod-validated payload or rejects with a typed `ClientError`. The error taxonomy mirrors the engine's:

```ts
class ClientError extends Error {
  readonly kind: 'http' | 'schema' | 'transport' | 'not_configured';
  readonly status?: number;          // populated when kind === 'http'
  readonly issues?: ZodIssue[];      // populated when kind === 'schema'
}
```

- `kind: 'http'` — engine returned a 4xx/5xx; `status` carried.
- `kind: 'schema'` — wire response failed Zod validation; `issues` carried.
- `kind: 'transport'` — `fetch` threw, network failure.
- `kind: 'not_configured'` — engine returned 404 with `error: '<surface> not configured'` (the opt-in surfaces: `/settings`, `/conversations`).

The `kind: 'not_configured'` distinction is the *first* place this codebase has split a real 404 from an opt-in 404 — UIs need this to tell "you forgot to start with `--persist`" from "the route doesn't exist". Engine routes have all standardized on the same response shape, which makes the discriminator a one-line check.

## 5. Subscription semantics

```ts
interface SubscribeHandlers {
  onEnvelope?: (env: EventEnvelope) => void;
  onOpen?: () => void;
  onClose?: (ev: { code: number; reason: string }) => void;
  onError?: (err: Error) => void;
}
```

The subscription handle exposes `close()`. No reconnection logic in this PR — that's Task 4.8 / PR #15. A bare WS dropping triggers `onClose`; the consumer decides what to do.

The validated-envelopes-only invariant means the `onEnvelope` handler can deserialize discriminated unions safely:

```ts
client.subscribe({
  onEnvelope: (env) => {
    if (env.kind === 'turn.result') { ... }
    if (env.kind === 'conversation.titled') { ... }
  },
});
```

Future PRs may add a typed-event-handler-by-kind helper (e.g. `subscribe({ on: { 'turn.result': fn } })`) but the bare `onEnvelope` is the foundation.

## 6. Tests

### Unit (against `FakeTransport`)

- `getHealth` happy path → returns parsed `HealthResponse`.
- `getHealth` schema failure → throws `ClientError { kind: 'schema' }` with `issues`.
- `getSettings` happy path / 404 with `error: 'settings not configured'` → `ClientError { kind: 'not_configured' }`.
- `putSettings` happy path / 400 with `settings_invalid` → `ClientError { kind: 'http', status: 400 }`.
- `patchSettings` round-trip (validates body before send).
- `getConversations` happy path / 404 → `not_configured`.
- `submitTurn` posts to the right path with the right body.
- `cancelTurn` posts to the right path with the right body.
- `subscribe`: the fake transport's `onEnvelope` is wired through; `close` propagates.

### Integration (against real `createApp` + `Bun.serve`)

- Boot in-process engine with persistence + settings (port 0).
- Construct `LocalHttpTransport({ baseUrl: 'http://127.0.0.1:<port>' })` + `createClient`.
- Drive `getHealth`, `getSettings` (both 404 path and configured path), `putSettings` round-trip, `getConversations`, `submitTurn` against ScriptedBackend, observe a `turn.result` envelope through `client.subscribe`.

### Why no spine test

This PR doesn't introduce a new contract — it's a typed projection of contracts that already have spine tests via `TypedTestClient`. The integration test in `packages/contracts/tests/` is the equivalent end-to-end coverage.

## 7. Out of scope (named TODOs)

- `// TODO(react-engine-provider)` — `EngineProvider` context, `useEngine()` hook, `useEngineConnectionState()`. PR #14.
- `// TODO(reconnect-and-resume)` — exponential backoff, `resubscribe { since: last_event_id }` on WS reopen. PR #15. (Architecture Task 4.8.)
- `// TODO(typed-event-dispatch)` — `subscribe({ on: { kind: handler } })` sugar over `onEnvelope`. Quality-of-life, not foundation.
- `// TODO(retry-policy)` — automatic retries on transient `transport` errors. Composable as a transport decorator.

## 8. Verification gate

- `bun run ci:fast` green
- 5× flake-check on the new test files
- 5× full spine pass-through (must remain 22/22)
