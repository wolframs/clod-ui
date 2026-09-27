# PR #15 — Vitest + happy-dom + React Testing Library (Phase 4 test depth)

> **Status:** plan + impl in this PR. Closes the `// TODO(vitest-rtl)` placed
> in `apps/web/src/lib/use-health.ts` by PR #14. Lifts the test ceiling for
> every Phase 4 hook from "static render variants only" to "full async
> lifecycle, real DOM, real `useEffect`, real cleanup."

## Objective

Stand up a second test runner (Vitest with happy-dom) inside `apps/web`
*alongside* the existing `bun test` runner. The two runners cover
non-overlapping test surfaces:

| Runner | Surface | File location | When to use |
|---|---|---|---|
| `bun test` (existing) | Pure functions, `renderToString` static variants, integration tests booting `createApp` | `apps/web/tests/*.test.tsx` (and everything outside `apps/web`) | Synchronous, hermetic, no DOM, no `useEffect` |
| Vitest + happy-dom + RTL (new) | Hooks under `useEffect`, async state transitions, `AbortController`-on-unmount, future event-driven UI behavior | `apps/web/tests/dom/**/*.test.{ts,tsx}` | DOM, async, lifecycle |

Both run in `ci:fast`. Both must be green for the gate to pass.

## Non-goals

- **No Playwright / E2E.** That's L5 in the test-strategy plan, deferred
  per `scripts/ci.ts:131-133`. Vitest covers component-level lifecycle;
  Playwright covers cross-page flow.
- **No replacement of `bun test`.** The existing fast-and-hermetic tests
  for engine, manifest, transcripts, contracts, and the renderToString
  variants stay on `bun test`. Vitest is additive; it owns the DOM slice
  only.
- **No JSDOM.** happy-dom is faster and ships fewer surprises for our
  use case; Vitest defaults to it cleanly.

## Why two runners

A pragmatic answer to a real constraint: `bun test` is excellent for the
~370 pure/integration tests we already have, and `bun test`'s React DOM
support is not yet at parity with what RTL needs. Vitest+happy-dom is
the canonical React testing stack and delivers `renderHook` + `waitFor`
+ `userEvent` out of the box. Running both is cheaper than waiting for
one to grow into the other's surface.

The directory split (`tests/` vs `tests/dom/`) is the contract that
prevents collision: bun test ignores the dom subdir; vitest only reads
the dom subdir.

## Surface

### `apps/web/vitest.config.ts`

- React plugin (`@vitejs/plugin-react`).
- Environment: `happy-dom`.
- Globals: false (explicit imports, matches the project's import-order
  preference).
- Include: `tests/dom/**/*.test.{ts,tsx}`.
- Setup: `tests/dom/setup.ts` registers `@testing-library/jest-dom`
  matchers and configures RTL.
- TypeScript paths: inherits from the existing `tsconfig.json` so
  `@/lib/...` and `@clod-ui/...` resolve identically to runtime.

### `apps/web/tests/dom/setup.ts`

- `import '@testing-library/jest-dom'` to extend `expect` with
  `toBeInTheDocument`, `toHaveTextContent`, etc.
- `afterEach(() => cleanup())` so RTL's auto-cleanup hook is wired even
  with `globals: false`.

### `apps/web/tests/dom/use-health.test.tsx`

The first concrete consumer of the new runner. Three tests:

1. **`useHealth` resolves to `{ status: 'ok', health }` on mount.**
   `renderHook(() => useHealth(), { wrapper })`; `waitFor` until
   `result.current.status === 'ok'`; assert the health response is
   forwarded verbatim.
2. **`useHealth` resolves to `{ status: 'error', error }` when the
   client rejects.** Same shape, fake client rejects with a
   `ClientError`; assert the error reaches the hook's state.
3. **`useHealth` aborts in-flight requests on unmount.** Inject a fake
   client whose `getHealth` returns a Promise that captures the signal;
   render+unmount; assert `signal.aborted === true`.

The fake client is a partial `Client` with only `getHealth` populated —
the unit-test seam established by `packages/contracts/tests/client.test.ts`
applied at the React layer.

### Root `bunfig.toml`

```toml
[test]
ignore = ["apps/web/tests/dom/**"]
```

Single line. Bun test walks the whole repo by default and would
otherwise pick up `apps/web/tests/dom/use-health.test.tsx` as a normal
test file. The ignore pattern keeps the two runners non-overlapping.

### `apps/web/package.json`

New scripts:

- `"test": "vitest run"` — single-pass run for CI.
- `"test:watch": "vitest"` — interactive dev mode.

New devDependencies:

- `vitest` — runner.
- `@vitejs/plugin-react` — JSX transform during tests.
- `@testing-library/react` — `render`, `renderHook`, `screen`, `waitFor`.
- `@testing-library/jest-dom` — extended matchers.
- `@testing-library/user-event` — for future PRs (composer, etc.); cheap
  to add now.
- `happy-dom` — the DOM environment.

### `scripts/ci.ts`

`runFast` gains one step after `bun test`:

```ts
run({
  name: 'web:test',
  argv: ['bun', '--cwd', 'apps/web', 'run', 'test'],
});
```

Same shell-out idiom as the other steps. Failure aborts the pipeline
with a clear `[ci] ✗ web:test failed` line.

## Lift the deferred TODO

`apps/web/src/lib/use-health.ts:10-12` currently reads:

```
TODO(vitest-rtl): async hook tests once Vitest + happy-dom + RTL land
in PR #15. Current Bun-test reach (renderToString) only verifies the
loading state because effects don't run.
```

This PR removes that TODO (the comment block stays, the TODO line is
deleted) and the test file referenced above proves the lift.

## Verification

- `bun run typecheck` — clean.
- `bun run ci:fast` — both `bun test` (375 / 375) and `web:test` (3 / 3)
  green; total runtime budget < 12s.
- `bun run lint` — clean.
- `bun run format:check` — clean.
- 5× flake-check on the new vitest tests — 5/5 green.
- Spine — 22 / 22 unchanged.
- README link-check — green.

## Deferred TODOs (carried forward)

- `// TODO(reconnect-and-resume)` — still queued for PR #17 (subscribe
  hardening; closes Task 4.8).
- `// TODO(typed-event-dispatch)` — `subscribe({ on: { kind: handler } })`
  sugar, queued behind reconnect-and-resume.
- `// TODO(playwright-e2e)` — L5 cross-page flow tests; deferred until
  enough UI surface exists to be worth driving.

## Risks and mitigations

- **Two runners drift in their TS settings.** Mitigation: vitest config
  inherits the existing tsconfig path map; both runners walk the same
  source tree; CI runs both per push so any drift surfaces immediately.
- **happy-dom misses a browser-only surface (e.g. ResizeObserver).**
  Mitigation: shim in `tests/dom/setup.ts` as needed; the surface we
  need today (basic DOM, `fetch`, `WebSocket`) is well-covered.
- **Doubles `ci:fast` runtime.** Mitigation: the new runner has 3 tests
  today; even at 50 tests Vitest+happy-dom finishes in <2s. Budget is
  held.
