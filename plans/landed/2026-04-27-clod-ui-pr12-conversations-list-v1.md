# PR #12 — Conversations list (`GET /conversations`)

**Status:** ready
**Predecessor:** PR #11 (`DefaultTitler`), PR #10 (auto-titling foundation), PR #6 (SQLite + manifest)
**Successor (anticipated):** PR #13 (manual retitle endpoint), PR #14 (web UI scaffolding)
**Spec link:** `plans/2026-04-23-clod-ui-architecture-v2.md` Phase 4 (read side, sidebar)

---

## 1. Why this slice

The web UI's first concrete dependency is "list the conversations the user
has so far." Every Phase 4 surface (sidebar, recent-list, search seed,
empty state) consumes this projection. It also closes a long-standing
asymmetry: we've been writing manifest events + SQLite rows for six PRs
without ever projecting them onto the wire as a list.

The slice is intentionally read-only. There is no new event kind, no new
manifest schema, no new SQLite migration. The fold from PR #6 already
tracks `state.title`; the conversations table already tracks `created_at`
and `claude_session_id`. The route fuses both into a single response.

## 2. Wire shape

```ts
// @clod-ui/contracts/conversations.ts
const ConversationSummarySchema = z.object({
  conv_id: z.string().min(1),
  title: z.string().optional(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
  claude_session_id: z.string().optional(),
});

const ConversationsListResponseSchema = z.object({
  conversations: z.array(ConversationSummarySchema),
});
```

Field semantics:

- `conv_id` — primary key, mirrors the URL the UI uses to reach the conversation.
- `title` — `state.title` from the manifest fold. **Optional** because
  brand-new conversations exist in SQLite + on disk before auto-titling
  has fired (and may never fire if the first turn errors before any
  text). The UI handles "untitled" rendering; the engine does not
  fabricate a placeholder.
- `created_at` — authoritative timestamp from the SQLite row (set by
  `ensureProvisioned` at the same call that emits `conversation.created`).
- `updated_at` — `max(events.ts)` over the manifest, with `created_at`
  as the fallback when the manifest is empty (it never should be — at
  minimum the `conversation.created` event lives there — but the
  fallback keeps the response shape total). Computed inline; **not**
  added to the fold (see §5).
- `claude_session_id` — mirror of the SQLite row's column. Optional
  because the value is only known after the first `system.init`. Useful
  for debug / introspection from the UI; the spine doesn't depend on it.

Response wrapper: `{ conversations: ConversationSummary[] }`. The wrap
buys forward-compat for `next_page_token`, `total_count`, etc. without
a wire-shape break.

## 3. Sort order

`updated_at` descending. Stable secondary key: `created_at` descending,
then `conv_id` ascending (purely for determinism — humans never see
the tiebreak). This matches every chat UI on the planet and survives
auto-titling races (re-titling bumps `updated_at` to the title event's
ts, surfacing freshly-titled conversations to the top).

## 4. Engine wiring

Opt-in via persistence (mirrors the `/settings` precedent):

- When `store` + `db` are absent, `GET /conversations` returns
  **404 `{ error: 'conversations not configured' }`**. Memory-only
  callers (PR #4 / #5 in-process tests) are unaffected.
- When persistence is configured, the route:
  1. Calls `listConversations(db)` — returns rows in `created_at DESC` order.
  2. For each row, reads + folds the manifest, derives `title` and
     `last_event_ts`.
  3. Builds the summary objects, sorts by `updated_at` desc / `created_at`
     desc / `conv_id` asc, returns the wrapped list.

Per-conversation manifest read failures (corrupt hash chain, truncated
file) are logged-and-skipped — one bad manifest does not 500 the whole
sidebar. Recoverable from the on-disk JSONL even when hidden. **TODO**
(`degraded-conversations`): surface these as a separate field in the
response so the UI can render an inline warning.

## 5. Why no fold extension

Adding `updated_at` and `last_event_kind` to the fold would mirror the
`title` precedent and feel symmetric. We deliberately don't:

- The fold projects **state**. `updated_at` is metadata about the event
  stream, not state derived from the events. Adding it muddies the
  fold's contract.
- It's trivially computable inline in O(events) — same cost as the fold
  itself, no separate pass.
- Extending the fold means extending `ConversationState`, which ripples
  into every reader and the test surface for marginal benefit.

If a future projection genuinely needs typed last-event metadata
(e.g. "show last assistant message snippet in sidebar"), that's the
moment to extend the fold — not before.

## 6. Test plan

### Route tests (`apps/engine/tests/conversations-routes.test.ts`)

1. **404 when persistence absent** — `createApp({ backend })`, GET → 404
   `{ error: 'conversations not configured' }`.
2. **Empty list** — persistence configured, no provisioned conversations,
   GET → 200 `{ conversations: [] }`.
3. **Single provisioned conversation appears, title undefined** —
   provision via `ensureProvisioned`, GET → 200 with one entry,
   `title` absent, `updated_at === created_at`.
4. **Title from manifest fold surfaces in the response** — provision,
   then append `conversation.titled`, GET → 200 with `title`.
5. **Sort by updated_at desc** — provision A then B, append a fresh
   event on A, GET → A appears before B even though B was created later.
6. **Corrupt manifest entry is skipped, others render** — provision A
   and B, deliberately corrupt A's manifest, GET → 200 with only B.
   No 500.
7. **claude_session_id mirrors SQLite when set** — provision, run
   `recordSessionId`, GET → entry carries `claude_session_id`.

### Spine test — T1.13 (`tests/spine/T1.13-conversations-list.test.ts`)

In-process engine boot pattern (matches T1.09 / T1.11):

- Boot with persistence + `FallbackTitler` (deterministic, no CLI).
- POST one full turn over HTTP, await `turn.result` and the
  `conversation.titled` envelope over WS.
- GET `/conversations`, assert:
  - exactly one entry.
  - `title` matches the FallbackTitler-derived value (deterministic
    given the user_message + ts).
  - `updated_at >= title-event-ts` (i.e. the title event bumped it).
  - `claude_session_id` matches the scripted backend's emitted session.
  - `created_at <= updated_at`.

Two contracts:

1. **List reflects a completed turn end-to-end** — single conversation,
   all five fields populated as above.
2. **List orders by updated_at desc across two conversations** — boot,
   POST a turn on conv A, await terminator + title; POST a turn on
   conv B, await its title; POST another turn on conv A; GET → A
   appears before B because A's most-recent title bumped its
   updated_at past B's.

Spine count after this PR: **22 / 22** across 13 contract files. Zero
reserved.

## 7. Out of scope (named TODOs)

- `// TODO(pagination)` — return `next_page_token` once we hit ~100
  conversations. Cursor is `(updated_at, conv_id)`; route grows a
  `?cursor=` + `?limit=` pair.
- `// TODO(degraded-conversations)` — surface conversations whose
  manifest is unreadable as a separate field with the typed error.
  UI renders an inline "⚠ corrupt manifest" affordance.
- `// TODO(search-filter)` — `?q=` filter that scans `state.title` +
  the latest user message. Trivial scan for v1; fts5 once we have data
  to justify it.
- `// TODO(per-conv-stats)` — turn count, last-message snippet, archived
  flag. Each is a manifest fold extension; design the projection then
  the wire shape, not the other way around.

## 8. Cadence

Three logical commits matching PR #9's pattern (no engine surface change
beyond a single new route, no new package):

1. `docs(plans): PR #12 — conversations list design doc`
2. `feat(contracts): ConversationSummary + ConversationsListResponse schemas`
3. `feat(engine): GET /conversations route + route tests`
4. `test(spine): T1.13 conversations list (2/2 contracts live)`

Spine grows 20 → 22, contract files 12 → 13. No reserved tests.
