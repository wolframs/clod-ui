# PR #14 — `EngineProvider` React context + `useHealth` first concrete consumer

**Status:** in-progress
**Phase:** 4 (Web UI Scaffolding) — Task 4.2 (engine wiring)
**Closes:** half of architecture Task 4.2 (provider/hook half).
**Prereq:** PR #13 (`@clod-ui/contracts/client`).

## 1. Why now

PR #13 landed the typed client. Phase 4 needs *one* place where the React tree is wrapped with a `Client` instance — that's the `EngineProvider`. Every component that ever needs to talk to the engine reaches for `useEngine()` and gets back the same client. This PR establishes that seam plus the smallest possible concrete consumer (`useHealth` + `HealthBadge`) to prove the wire works end-to-end.

The sidebar (architecture Task 4.3) is reserved for PR #15, the streaming renderer (Task 4.4) for PR #16, the composer (Task 4.5) for PR #17, etc. Each Phase 4 task gets its own PR; the cadence stays predictable.

## 2. Scope

**In:**

- `EngineProvider` React context, single client instance per app.
- `useEngine()` hook → `{ client }`. Throws outside the provider.
- `useHealth()` hook → `{ status: 'loading' | 'ok' | 'error', health?, error? }` driven by `client.getHealth()`. Cancels on unmount via `AbortController`.
- `HealthBadge` pure presentational component rendering all three status variants with Tailwind classes.
- `main.tsx` wiring: construct `LocalHttpTransport` against `import.meta.env.VITE_ENGINE_URL ?? 'http://127.0.0.1:5174'`, create one `Client`, wrap `<App />` in `<EngineProvider client>`.
- `App.tsx` updated to render `<HealthBadge>` driven by `useHealth()`. Replaces the hard-coded "Engine offline".
- Tests via `renderToString`:
  - `useEngine` throws when used outside provider.
  - `useEngine` returns the injected client when wrapped.
  - `HealthBadge` renders correctly for each of the three status variants.

**Out (deferred):**

- Reactive WS connection state (`useConnectionState()`). PR #15.
- Sidebar component listing `client.getConversations()`. PR #15.
- Reconnect-and-resume, exponential backoff. PR #16 (architecture Task 4.8).
- Vitest + `@testing-library/react` for async hook + interactive tests. Lands when the first PR genuinely needs it (likely PR #15 once we render lists with state transitions).

## 3. The provider seam

```ts
export interface EngineProviderProps {
  client: Client;
  children: React.ReactNode;
}

export function EngineProvider({ client, children }: EngineProviderProps): JSX.Element;

export function useEngine(): { client: Client };
```

**Why client-as-prop instead of factory-as-prop:** the provider takes a fully-constructed `Client`, not a transport config. This keeps the provider testable (inject a fake client built over `FakeTransport`) and lets `main.tsx` make the production-vs-dev decision once, at the app root, where the env vars live.

**Throwing on missing provider:** `useEngine` calls `useContext(EngineContext)` and throws if the context's default sentinel is still in place. Standard React pattern; the alternative (returning `null`) forces every consumer to handle a `null` client with an early return, which is noise. The error message names the offending hook so a misplaced `useEngine` outside the provider surfaces in the dev console immediately.

## 4. The first consumer: `useHealth` + `HealthBadge`

```ts
type HealthState =
  | { status: 'loading' }
  | { status: 'ok'; health: HealthResponse }
  | { status: 'error'; error: ClientError };

export function useHealth(): HealthState;
```

`useHealth` lifecycle:

1. Mount → `setState({ status: 'loading' })`, construct `AbortController`, call `client.getHealth({ signal })`.
2. Success → `setState({ status: 'ok', health })`.
3. Failure → `setState({ status: 'error', error })`. The error is already a `ClientError`; the badge picks the message off it.
4. Unmount → `controller.abort()` so a still-pending fetch doesn't `setState` after teardown (React's StrictMode warning catches this; the abort suppresses it).

Why `AbortController` and not a `cancelled` boolean: the fetch in `LocalHttpTransport` already accepts a signal, so propagating it actually cancels the network request, not just the state-update gate.

`HealthBadge` is pure: takes a `HealthState`, returns one of three Tailwind-styled badges:

- `loading` → muted gray, "Connecting…"
- `ok` → green, "Engine OK · v{health.version}"
- `error` → red, error.message (capped at ~80 chars; full string on title attribute)

## 5. Why no Vitest yet

The architecture plan calls out Vitest + RTL for UI component tests (Task 4.x). Two reasons we defer:

1. **Bun-test reach is enough for the data layer.** `EngineProvider` and `useEngine` are testable via `react-dom/server`'s `renderToString` because the relevant assertions ("throws outside provider", "returns the wrapped client") fire on first render. No effects, no async.
2. **Scope discipline.** Adding Vitest + happy-dom + RTL is a real dep + config + glue commitment. Defer it to the first PR that genuinely needs interactive tests — likely PR #15 (sidebar with loading→ready→error transitions).

A `// TODO(vitest-rtl)` ticket lives at the call site for `useHealth` so the next PR knows where to land async tests.

## 6. Test surface

Three small tests under `apps/web/tests/`:

1. **`engine-context.test.tsx` — `useEngine` outside provider throws.**
   Renders a tiny consumer component without `EngineProvider`. `renderToString` catches the thrown error; assert it carries the documented message.
2. **`engine-context.test.tsx` — `useEngine` inside provider returns the injected client.**
   A fake client (no transport needed — we only check identity via `client === injected`) is passed to `EngineProvider`. The consumer renders `<span data-test={String(useEngine().client === fakeClient)}>` and the rendered HTML is asserted to contain `data-test="true"`.
3. **`health-badge.test.tsx` — renders all three variants correctly.**
   Pure render assertions: `loading` produces the "Connecting…" string + the muted variant class; `ok` produces "Engine OK" + version; `error` carries the error message.

## 7. Production wiring

`main.tsx` constructs the production client once:

```ts
const baseUrl = import.meta.env.VITE_ENGINE_URL ?? `${window.location.protocol}//${window.location.host}`;
const transport = new LocalHttpTransport({ baseUrl });
const client = createClient({ transport });

createRoot(rootEl).render(
  <StrictMode>
    <EngineProvider client={client}>
      <App />
    </EngineProvider>
  </StrictMode>,
);
```

The default base URL (`window.location.origin`-equivalent) reflects the eventual launcher behavior: the engine and the web app are served from the same origin in production. `VITE_ENGINE_URL` overrides for development against a separately-running engine.

## 8. Out of scope (named TODOs)

- `// TODO(vitest-rtl)` — async/interactive UI component tests. PR #15.
- `// TODO(reconnect-state)` — `useConnectionState()` hook driven by the WS subscribe lifecycle. PR #15.
- `// TODO(error-boundary)` — top-level React error boundary capturing render-time throws into a typed surface. PR #16.

## 9. Verification gate

- `bun run ci:fast` green
- 5× flake-check on the new test files
- 5× full spine pass-through (must remain 22/22)
