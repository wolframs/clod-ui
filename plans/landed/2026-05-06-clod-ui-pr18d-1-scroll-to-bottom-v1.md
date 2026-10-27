# PR #18d.1 — scroll-to-bottom

**Status:** in-flight
**Phase:** 4 (web UI scaffolding)
**Slice of:** PR #18d (markdown + tool-card collapsibles + scroll-to-bottom; this is the third)
**Plan source:** `plans/2026-04-23-clod-ui-architecture-v2.md` Phase 4

## 1. Why now

The full conversation loop is wired (PR #19 + #20a + #20b), but during a streaming
turn the user sees a UX seam: new `assistant.delta` content lands inside `TurnView`,
which sits *below* `TranscriptHistory` inside the main flex column. Because
`TranscriptHistory` has its own `overflow-y-auto` (`transcript-history.tsx:137`)
and `TurnView` has natural height, two things go wrong:

1. The main column has effectively two stacked scroll containers — `TranscriptHistory`
   takes `flex-1` and scrolls internally; `TurnView` grows below the fold without
   triggering any scroll. The user has to manually scroll the *outer* column to
   see streaming text.
2. There's no sticky-bottom behavior: even after scrolling, content streamed
   subsequently appears off-screen until the user scrolls again.

This was named in `apps/web/src/App.tsx:113-114` as
`// TODO(scroll-to-bottom)` and queued for PR #18d. Splitting #18d into three
honest pieces (scroll-to-bottom, markdown rendering, tool-card collapsibles)
because each is its own concern with its own test surface.

## 2. Scope

- **In scope:**
  - `apps/web/src/lib/use-sticky-bottom.ts` — React hook that observes a
    scroll container, tracks whether the user is "at the bottom", auto-scrolls
    to bottom when content grows *and* user is sticky, freezes when the user
    scrolls up. Pure of layout decisions; takes a `ref` and an "input changes"
    signal.
  - `apps/web/src/lib/sticky-bottom.ts` — pure helper `shouldStickToBottom`
    over numeric scroll metrics. Tested in isolation.
  - Refactor `TranscriptHistory` to drop `overflow-y-auto` from its outer
    container; rendering becomes scroll-agnostic.
  - Refactor `TurnView`'s outer container similarly (it currently has no
    scroll, but renames `flex-1` semantics so it composes inside a single
    outer scroll container).
  - Wire `useStickyBottom` into `App.tsx`'s outer `<div>`; that single element
    becomes *the* scroll container for the whole conversation surface.

- **Out of scope:**
  - Markdown rendering (PR #18d.2).
  - Tool-card collapsibles (PR #18d.3).
  - Virtualization (deferred to when history grows past ~100 messages).
  - Scroll-position persistence across `conv_id` changes (the natural reset on
    selection feels right; if it doesn't, name a `TODO(scroll-position-memory)`).

## 3. Wire shape

No wire change. All client-side.

## 4. The hook contract

```ts
useStickyBottom(opts: {
  ref: React.RefObject<HTMLElement>;
  threshold?: number;       // default 50px from bottom = "sticky"
  /** Stable reference whose identity changes whenever new content lands. */
  inputs?: ReadonlyArray<unknown>;
}): {
  isStuck: boolean;         // user is within threshold of bottom
  scrollToBottom(): void;   // imperative escape hatch (e.g. "jump to bottom" button)
};
```

- On mount: scrolls to bottom synchronously after first paint.
- On scroll: re-evaluates `isStuck`. The user actively scrolling away breaks
  sticky; scrolling back into the threshold re-engages it.
- On `inputs` change (typically the messages array length or active text length):
  if `isStuck`, scroll to bottom; else, no-op.
- StrictMode-safe: the cleanup detaches the scroll listener.

## 5. The pure helper

```ts
shouldStickToBottom(metrics: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  threshold: number;
}): boolean
```

Returns `true` iff `scrollHeight - (scrollTop + clientHeight) <= threshold`.
Tested with a small table covering: at-bottom, near-bottom (within threshold),
mid-scroll, top-of-list, threshold-exact-boundary, and the degenerate case
where content is shorter than the viewport (always sticky).

## 6. Test plan

- Pure helper: 6 unit tests covering the cases above.
- Hook: 5 DOM tests via vitest+RTL+happy-dom:
  - Initial render scrolls to bottom synchronously.
  - User scrolling up breaks sticky; auto-scroll no longer fires on input change.
  - User scrolling back to bottom re-engages sticky.
  - `inputs` change while sticky scrolls to bottom.
  - `scrollToBottom()` imperative call works regardless of sticky state.
- App integration: the existing `TranscriptHistory` + `TurnView` tests are
  unaffected (both pass through their `className` prop already; the tests pin
  `data-test` attributes, not scroll behavior).

## 7. Deferred TODOs

- `// TODO(scroll-position-memory)` — if natural reset on `conv_id` change
  proves frustrating, persist the last scroll position per conversation.
- `// TODO(jump-to-bottom-button)` — visible affordance when `!isStuck` so
  the user can re-engage with one click. Worth landing once the renderer has
  enough vertical content that the affordance matters.
- `// TODO(reduced-motion)` — `prefers-reduced-motion: reduce` should make
  the sticky-bottom auto-scroll instant rather than smooth.

## 8. Commit cadence

Four logical chunks (typed-first → pure helper → hook → integration):

1. `docs(plans): PR #18d.1 — scroll-to-bottom`
2. `feat(web): shouldStickToBottom — pure helper for sticky-bottom decision`
3. `feat(web): useStickyBottom — auto-scroll hook + DOM tests`
4. `feat(web): single scroll container + useStickyBottom in App.tsx`

## 9. Verification

- `bun run typecheck` clean.
- `bun run ci:fast` green (all bun + vitest tests).
- 5× flake check on the new tests + 5× full spine.
