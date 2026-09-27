# PR #16.5 — pre-streaming-arc cleanup

> **Status:** plan + impl in this PR. Closes the slipped `TODO(error-boundary)`
> from PR #14, and lands the four highest-ROI cleanups identified in the
> 2026-04-30 codebase inspection (between PR #16 and PR #17). No behavior
> change to user-visible surfaces; structural-only refactor + new docs.

---

## 1. Why now

The Phase 4 streaming arc (PR #17 reconnect-and-resume → PR #18 transcript
renderer → PR #19 composer) is the most fragile slice of work this codebase
has ever taken on. Five risks identified in the inspection bite hardest
when the surrounding scaffold is unclear:

1. `apps/engine/src/index.ts` is 759 lines. Adding the WS resume protocol
   in PR #17 compounds that to ~850-900 in a single file.
2. `apps/web` has no `<ErrorBoundary />`. A render-time throw in the
   streaming renderer would white-screen the app, and we'd lose the
   diagnostic without a typed surface.
3. Eight invariants have hardened across 16 PRs but live nowhere:
   future agents (myself included) can violate one without realizing
   it's load-bearing.
4. The 22 spine contracts have *file-path* names, but session summaries
   keep drifting to *semantic* names that don't match disk. Every drift
   is a tiny risk.
5. `plans/` has 18 entries with no INDEX. Active vs landed is invisible.

This PR sweeps the floor for those five before PR #17 starts.

---

## 2. Slice scope

Five commits, one PR. No behavior change to ci:fast contract; structural
moves + new doc-tier files only.

| # | Commit | Surface |
|---|---|---|
| 1 | `docs(plans)` | This plan + `plans/INDEX.md` + move 14 landed plans to `plans/landed/` |
| 2 | `docs(invariants)` | `docs/INVARIANTS.md` capturing 8 implicit contracts |
| 3 | `docs(spine)` | `docs/SPINE.md` canonical mapping of 22 spine contracts |
| 4 | `refactor(engine)` | Split `createApp` into `routes/{health,turns,conversations,settings}.ts` + `wire.ts` + `maybe-title.ts` |
| 5 | `feat(web)` | `<ErrorBoundary />` at the app root, closes PR #14's slipped TODO |

---

## 3. Decisions

### Plans hygiene

- **`plans/INDEX.md`** — table-of-contents mapping PR# → file → 1-line
  surface description. Active plans stay flat under `plans/`. Landed
  plans (PR #1–#16) move under `plans/landed/` and are referenced via
  the INDEX.
- The architecture plan (`2026-04-23-clod-ui-architecture-v2.md`) and
  the test-strategy plan (`2026-04-23-clod-ui-test-strategy-v1.md`)
  stay at the top level — they're living references, not landed PRs.
- This plan and PR #17's plan (when authored) live at the top level
  too, since they're active.

### Invariants doc

Single-file `docs/INVARIANTS.md`. Eight invariants, each with: name,
1-paragraph spec, and a `where` block listing every load-bearing
implementation site. Future PR plans can reference invariants by name
(e.g. "Invariant 3 — discriminated state hooks") instead of re-deriving.

### Spine catalog

Single-file `docs/SPINE.md`. One row per contract: T-id, file-path,
1-line contract description, the PR that un-skipped it. Becomes the
*authoritative* source the next time a session summary needs to
reference what T1.07 actually covers.

### Engine route split

Conservative split — one file per logical route group, two helper
files for cross-cutting concerns. Internal-only API (no public
re-export change), so no consumer code changes.

```
apps/engine/src/
  index.ts              # createApp orchestrator + types + production entrypoint
  wire.ts               # wrap() + EnvelopeIdSource (reused across files)
  maybe-title.ts        # the auto-titling worker (reused; not a route)
  routes/
    health.ts           # registerHealthRoutes(app, deps)
    turns.ts            # registerTurnsRoutes(app, deps) — turns + cancel
    conversations.ts    # registerConversationsRoutes(app, deps)
    settings.ts         # registerSettingsRoutes(app, deps)
```

Each `register*Routes` function takes the Hono `app` and a `deps`
object carrying exactly the closures and state it needs. No globals,
no module-level state. Every test continues to work without changes
because `createApp` still returns the same `AppContext`.

### ErrorBoundary

`apps/web/src/components/error-boundary.tsx` — class component (React
mandates class for `componentDidCatch`). Renders a typed error card
with the same `data-state="error"` convention the rest of the app
uses. `main.tsx` wraps `<App />` with `<ErrorBoundary />`.

Test seam: a `data-test="error-boundary"` marker + a `<ThrowOnRender />`
helper component in the test file. Vitest+RTL covers it because
catching a render throw requires a real DOM.

---

## 4. Out of scope (deliberately)

- **Architecture plan v3 refresh.** Will land when Phase 4 closes
  (~PR #20). Documenting the diff against v2 every PR is overhead;
  one batched refresh is cleaner.
- **`TODO(degraded-conversations)`** — no UI affordance to render the
  warning yet. PR #18 or later.
- **`TODO(mtime-guard)` on settings** — single-user tool, last-write-wins
  is acceptable until multi-tab UX exists.
- **`TODO(retry-policy)` on the typed client** — composes as a transport
  decorator; lands when reconnect proves the seam in PR #17.
- **Engine-level test reorganization.** The 100 engine tests are well-
  structured by contract; the route-file split keeps the same test
  shape (route tests still hit `createApp({ ... })`).

---

## 5. Verification

- `bun run ci:fast` green: 398 tests across 47 files (no count change;
  this is a structural refactor + doc additions).
- `bun run typecheck` clean.
- 5× `web:test` green (covers the new `ErrorBoundary` test).
- 5× full spine green.
- Engine route registrars: every existing engine route test continues
  to pass without modification, proving the refactor preserves
  external behavior.

---

## 6. Deferred / queued for PR #17

- `TODO(reconnect-and-resume)` — exponential backoff + `since:
  last_event_id` on WS resubscribe.
- `TODO(typed-event-dispatch)` — `subscribe({ on: { kind: handler } })`
  sugar over `onEnvelope`.
- `TODO(reconnect-state)` — `useConnectionState()` hook driven by the
  WS subscribe lifecycle.
- `TODO(live-sidebar-updates)` — re-fetch / patch when
  `conversation.titled` lands over WS. Adds back the `refresh()` that
  the user-edit pass simplified out of `useConversations`.
