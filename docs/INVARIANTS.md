# Invariants

Nine invariants have hardened across PR #1–#20 but live nowhere as
documentation. This file is the canonical reference. Future PR plans can
cite an invariant by number ("Invariant 3 — discriminated state hooks")
instead of re-deriving it.

If a future PR violates one of these, _that_ is a load-bearing decision
that needs an explicit override in its plan with rationale. Don't violate
silently.

---

## I-1 — Opt-in 404 contract

Routes that depend on optional engine subsystems return
`404 { error: '<surface> not configured' }` when the subsystem is absent.
The body shape is exact: an `error` string with the literal `<surface>
not configured` suffix.

**Why it matters:** the typed client's [`ClientError.kind ===
'not_configured'`](../packages/contracts/src/client/errors.ts) discriminator
is a one-line string-suffix check against this exact body. If the body
shape drifts, the discriminator silently degrades to `kind: 'http'` and
UIs lose their "you forgot `--persist`" affordance.

**Where it lives:**

- Engine: `apps/engine/src/index.ts` `/conversations`, `/settings` routes.
- Client: `packages/contracts/src/client/local-http.ts` (response check).
- UI: `apps/web/src/lib/use-conversations.ts` (variant routing).
- Sidebar: `apps/web/src/components/sidebar.tsx` (5th render variant).

---

## I-2 — Discriminated state hooks

Every hook over the typed client returns
`{ status: 'loading' | 'ok' | 'error' [+ 'not_configured' if applicable] }`.
No nullable fields at the leaf. The status field is the discriminator;
the rest of the shape is variant-specific.

**Why it matters:** consumers can render exhaustively without `?.` chains
and `null` guards. TypeScript narrows correctly inside each `if`-branch.
Tests assert on `status` first, then drill into the variant payload.

**Where it lives:**

- `apps/web/src/lib/use-health.ts` — `loading | ok | error`.
- `apps/web/src/lib/use-conversations.ts` — `loading | ok | error | not_configured`.
- `apps/web/src/lib/use-subscribe.ts` — `idle | connecting | open | reconnecting | closed`.
- `apps/web/src/lib/use-turn-stream.ts` — projection: `idle | streaming | completed | cancelled | errored`.
- `apps/web/src/lib/use-submit-turn.ts` — `idle | submitting | error`.
- `apps/web/src/lib/use-transcript.ts` — `loading | ok | error | not_configured`.
- Future hooks (`useSettings`) **must** follow this template.

---

## I-3 — `data-state` + `data-test` markers for hermetic tests

Components expose a `data-state="<variant>"` attribute on their outer
element. Iterated children carry `data-test="<component>-row"` and a
semantic `data-<key>="<id>"` (e.g. `data-conv-id`). Tests assert on these
markers — **never** on Tailwind class fragments.

**Why it matters:** styling is a presentation concern that should be free
to change without test fallout. The variant is a contract; CSS is not.

**Where it lives:**

- `apps/web/src/components/health-badge.tsx` — `data-state="loading|ok|error"`.
- `apps/web/src/components/sidebar.tsx` — `data-test="sidebar"`,
  `data-state="loading|empty|list|error|not_configured"`,
  `data-test="sidebar-row"`, `data-conv-id`, `data-selected`.
- All component tests under `apps/web/tests/*.test.tsx`.

---

## I-4 — Pure presentational components, hook-owned state

Presentational components (anything under `apps/web/src/components/`)
are functions from props to JSX. No `useEffect`, no `useState`, no
internal data fetching. State lives in custom hooks; selection / layout
state lives in the parent that orchestrates the component tree.

**Why it matters:** components compose trivially into Storybook,
Playwright E2E, dark-mode preview, server-side rendering, and unit
tests via `renderToString` — without "but the test needs to mock the
network" friction.

**Where it lives:**

- `apps/web/src/components/health-badge.tsx` — props-only.
- `apps/web/src/components/sidebar.tsx` — props-only; selection in App.
- `apps/web/src/App.tsx` — orchestrator; owns `selectedId`.

---

## I-5 — Fire-and-forget worker with double-check

Async writes into the manifest follow a strict pattern:

1. Read the manifest, fold to state.
2. Guard: abort if state already has the field set (idempotent).
3. Make the external call (titler, session resolver, etc).
4. Re-read the manifest, re-fold, re-guard. A concurrent write may
   have raced you while step 3 was in flight.
5. Append the event.

The worker is `void`-launched from a hot path; failures inside it are
log-only and never propagate to the originating turn.

**Why it matters:** PR #6 (`recordSessionId`) and PR #10 (`maybeTitle`)
both have a real concurrency window between read and write. The
re-read after the external call is what makes "first writer wins" hold
under racing manual UI writes.

**Where it lives:**

- `apps/engine/src/provisioning.ts` — `recordSessionId`.
- `apps/engine/src/index.ts` — `maybeTitle`.

---

## I-6 — Atomic IO for canonical files

On-disk single-source-of-truth files are written atomically:

1. Write to `<path>.tmp.<pid>.<rand>` (same filesystem as target).
2. Sync the file descriptor.
3. Rotate `<path>` → `.bak` → `.bak.1` → `.bak.2` (best-effort,
   oldest discarded).
4. Rename `.tmp.<pid>.<rand>` → `<path>` (atomic on POSIX).

A reader observing the target file always sees a fully-formed previous
version or the new version, never a torn write.

**Why it matters:** crash recovery is free if you survive a `kill -9`
mid-write — the worst case is a fresh-but-orphaned `.tmp` file (cleaned
up on next boot) and the previous `.bak` is intact.

**Where it lives:**

- `packages/settings/src/store.ts` — settings.json.
- `packages/manifest/src/store.ts` — manifest.json (append-only, but
  the same atomic-rename idiom applies for full rewrites).
- Any future canonical file (`projects.json`, `skills.json`, etc.)
  **must** follow this template.

---

## I-7 — Manifest fold purity vs. engine policy

The `ManifestStore.fold(events)` projection is **last-write-wins** at
the data layer for _every_ field. The "first auto-title wins" /
"manual title wins over auto-title" / "session_id is immutable once
set" policies live in the **engine workers** that write to the
manifest, not in the fold itself.

**Why it matters:** the fold stays pure and forward-compatible. A
future endpoint that _does_ want to overwrite the title can append a
new `conversation.titled` event without coordinating with the fold.
Policy is the writer's problem, not the reader's.

**Where it lives:**

- `packages/manifest/src/store.ts` — `fold()` is pure last-write-wins.
- `apps/engine/src/index.ts` — `maybeTitle` reads + guards before
  appending; `recordSessionId` does the same for `claude_session_id`.

---

## I-8 — Wire-only events vs. manifest events

Events that carry **transient stream content** (transcript lines,
streaming deltas, tool deltas) are wire-only — they ship over WS as
`EventEnvelope`s but are **not** appended to the manifest.

Events that carry **state-shaping facts** (session*id captured, title
set, conversation created) are \_both* wire events _and_ manifest
events.

The discriminator is: "if the engine restarts, would I want to
reconstruct this from the manifest fold?" If yes → manifest event.
If no → wire-only.

**Why it matters:** manifest is for state, JSONL transcripts are for
content. Duplicating content into the manifest violates the
"single source of truth" principle and bloats the hash chain.

**Where it lives:**

- Wire-only kinds: `assistant.delta`, `tool.use`, `tool.result`,
  `transcript.updated`, `turn.result`, `turn.cancelled`, `turn.error`.
- Manifest event kinds: `conversation.created`, `session.captured`,
  `conversation.titled`. (See `packages/manifest/src/types.ts`.)

---

## I-9 — Shared parser for transcript wire + route

JSONL transcript bytes are parsed by **exactly one** function:
`parseTranscriptLine(line_number, byte_offset, text)` in
`packages/transcripts/src/parse-line.ts`. Two consumers share it:

1. The watcher (`packages/transcripts/src/watcher.ts`) — emits
   `transcript.updated { lines: TranscriptLine[] }` over WS as new
   bytes append.
2. The HTTP route (`apps/engine/src/routes/transcript.ts`) — replies to
   `GET /conversations/:id/transcript` with `{ lines: TranscriptLine[] }`
   on demand.

The wire schema (`TranscriptLineSchema` in
`packages/contracts/src/transcript.ts`) and the source-of-truth type
(`TranscriptLine` in `packages/transcripts/src/types.ts`) are kept
identical: same field shape, same `parse_error` semantics, same
`raw_text` recovery field. A breadcrumb in each file points at the other.

**Why it matters:** the UI's `useTranscript` (HTTP fetch) and
`useTurnStream` (WS deltas) project from a single normalizer
(`normalizeTranscriptLines`). If the wire and route shapes ever diverge,
half the renderer goes blind silently. The shared parser is the
mechanical guarantee that they don't.

**Where it lives:**

- `packages/transcripts/src/parse-line.ts` — the parser (only call site).
- `packages/transcripts/src/watcher.ts` — wire consumer.
- `apps/engine/src/routes/transcript.ts` — route consumer.
- `packages/contracts/src/transcript.ts` — wire schema (mirrored).
- `packages/transcripts/src/types.ts` — source-of-truth type (mirrored).

A future PR adding a third consumer (CLI inspector, replay debugger,
log viewer) **must** route through the same parser. Don't re-derive.

---

## A note on session-summary drift

Across PR #1–#16, several session summaries drifted from on-disk
reality (e.g. inventing semantic names for spine tests that don't
match `tests/spine/T1.XX-*.test.ts` filenames; describing schemas
with shapes the actual code doesn't carry). The on-disk file is
**always** canonical. When a session summary disagrees with the
file, trust the file.

`docs/SPINE.md` is the authoritative catalog of the spine contracts
(its total row carries the current count).
