# PR #16 — Sidebar component (Phase 4 first user-visible read surface)

> **Status:** plan + impl in this PR. First Phase 4 component that
> renders *user data*, not just diagnostic state. Consumes
> `client.getConversations()` (wired in PR #12) through the
> `EngineProvider`/hook template (PR #14) and validates the full
> read-side seam from manifest fold to pixels.

## Objective

Build the sidebar component that lists known conversations and lets
the user pick one. Lands the first piece of architecture Task 4.3
(3-pane responsive layout) — specifically the sidebar pane — using
the Provider+hook+component template proven in PR #14.

After this PR, opening the running engine in a browser shows:

- A live `/health` badge at the top (already there, PR #14)
- A scrollable list of every conversation in the engine's app-data
  directory, each with its auto-derived Haiku title and a relative
  timestamp
- A persisted "selected conversation" state held in the App component
  (no UI to act on it yet — that's the transcript pane in PR #17/#18)

## Non-goals

- **No 3-pane layout yet.** This PR ships a 2-column scaffold
  (sidebar + main); the third pane (inspector) and the responsive
  collapse rules land in PR #18.
- **No transcript view.** Selecting a conversation only updates the
  selected-id state. Rendering messages waits for the streaming
  message renderer (PR #19+).
- **No search/filter, no pagination, no "new conversation" button.**
  Each is a deliberate follow-up; the spine `// TODO(pagination)` and
  `// TODO(search-filter)` named in PR #12 stay open.
- **No drag-to-reorder, no manual retitle, no delete.** Phase 5+.
- **No real-time updates** when a new conversation is created or a
  title changes mid-session. The hook fetches once on mount; the
  reconnect-and-resume PR (#17) is what wires `conversation.titled`
  WS broadcasts into the sidebar.

## Surface

### `apps/web/src/lib/use-conversations.ts`

Mirrors `useHealth` exactly — same discriminated state shape, same
`AbortController` lifecycle, same `not_configured` discrimination on
the engine's opt-in 404:

```ts
export type ConversationsState =
  | { status: 'loading' }
  | { status: 'ok'; conversations: ConversationSummary[] }
  | { status: 'error'; error: ClientError }
  | { status: 'not_configured' };
```

The `not_configured` variant is new in this hook. The `useHealth`
hook collapsed it into `error`, but the sidebar wants to render a
distinct affordance ("the engine is running without `--persist`;
start it with persistence to see your conversations") rather than
the same red error chip. The `ClientError.kind === 'not_configured'`
discriminator (PR #13) makes this a one-line check.

### `apps/web/src/components/sidebar.tsx`

Pure presentational. Five render variants discriminated on `state`:

1. **loading** — skeleton with three muted bars.
2. **empty** — friendly "No conversations yet" with a hint pointing at
   the composer (which doesn't exist yet; copy says "submit a turn to
   start your first conversation" and points at the placeholder main
   pane).
3. **list** — scroll-area with one row per `ConversationSummary`. Each
   row shows the title (or italicized "untitled" if absent), an
   `<RelativeTime />` badge, and a left border highlight when selected.
4. **error** — same red treatment as `HealthBadge` but at sidebar
   width, with the `ClientError.message` shown.
5. **not_configured** — muted info card explaining persistence isn't
   on; mentions `--persist` so power users know what to flip.

Props:
- `state: ConversationsState`
- `selectedId?: string`
- `onSelect: (conv_id: string) => void`

`data-test="sidebar"` and `data-state="<variant>"` for tests.

### `apps/web/src/lib/relative-time.ts` *(small helper)*

Pure function `relativeTime(ts: number, now = Date.now()): string`
returning strings like `'just now'`, `'3m ago'`, `'2h ago'`, `'4d
ago'`, `'Apr 27'` (for >7d). Frozen at call time so render output is
deterministic for tests.

### `apps/web/src/App.tsx`

Becomes a 2-column scaffold:

```
┌────────────┬─────────────────────────────┐
│  Sidebar   │  <main>                     │
│  (240-320px│   <HealthBadge .../>        │
│   fixed)   │   placeholder + selected-id │
│            │   visualizer (just text     │
│            │   "Selected: <id>" for now) │
└────────────┴─────────────────────────────┘
```

Manages `selectedId` state via `useState<string | undefined>`. Future
PRs hoist this to a layout-state module + localStorage; for this PR,
in-memory state is sufficient.

### Tests

**`apps/web/tests/sidebar.test.tsx`** (bun test, renderToString) —
covers all five render variants of the pure component:

1. loading variant: `data-state="loading"`, three skeleton bars.
2. empty variant: `data-state="empty"`, "No conversations yet" copy.
3. list variant: one row per conversation, title visible, untitled
   placeholder rendered for entries lacking a title, selected row
   shows the highlight marker.
4. error variant: `data-state="error"`, error message visible.
5. not_configured variant: `data-state="not_configured"`, mentions
   `--persist`.

**`apps/web/tests/relative-time.test.ts`** (bun test, pure fn) —
covers the time bucket boundaries: `<60s`, `<60m`, `<24h`, `<7d`,
`>=7d`.

**`apps/web/tests/dom/use-conversations.test.tsx`** (vitest, real
DOM) — covers the async lifecycle:

1. loading → ok with non-empty list.
2. loading → ok with empty list.
3. loading → error on a generic `ClientError`.
4. loading → not_configured on `ClientError { kind: 'not_configured' }`.
5. abort on unmount (mirrors useHealth).

## Verification

- `bun run typecheck` clean.
- `bun run ci:fast` green; ~10 new bun tests + ~5 new vitest tests.
- `bun run lint` clean; no warnings.
- 5× flake-check on the new tests.
- Spine 22 / 22 unchanged.

## Deferred TODOs (carried + new)

Carried from prior PRs:
- `// TODO(reconnect-and-resume)` — PR #17.
- `// TODO(typed-event-dispatch)` — queued behind reconnect-and-resume.
- `// TODO(pagination)` — sidebar cursor on `/conversations`.
- `// TODO(search-filter)` — sidebar `?q=` filter.

New in this PR:
- `// TODO(layout-state)` — hoist `selectedId` into a typed
  layout-state module + localStorage when the 3-pane PR lands.
- `// TODO(live-sidebar-updates)` — re-fetch / patch when
  `conversation.titled` arrives over WS, after PR #17 lands the
  reconnect-and-resume seam.
- `// TODO(time-locale)` — `relativeTime` is currently English-only;
  swap to `Intl.RelativeTimeFormat` once we have a locale layer.

## Risks and mitigations

- **`relativeTime` non-determinism in tests.** Mitigation: the helper
  takes `now` as a parameter, defaulting to `Date.now()`; tests pass
  a frozen `now`.
- **Sidebar feels empty without a "new conversation" button.**
  Acknowledged. The composer + new-conv flow is its own slice; we'd
  rather ship a smaller-but-correct sidebar than couple two PRs.
