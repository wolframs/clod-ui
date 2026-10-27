# PR #20b — Transcript history (client side)

> Date: 2026-05-06
> Status: in flight
> Predecessors: PR #20a (server route + shared parser + spine T1.15)
> Architecture refs: plans/2026-04-23-clod-ui-architecture-v2.md Phase 4 §
> "Transcript history pane"; INVARIANTS I-2 (envelopes wire only),
> I-3 (data-state markers), I-4 (pure presentational).

## 1. Charter

Closes the client-side half of PR #20. After this slice the renderer shows
**history above the active turn**: every message from the on-disk JSONL renders
above the live `TurnView` already wired in PR #18c, composing into a continuous
conversation experience.

Scope kept narrow on the same principles PR #20a established:

- One new hook (`useTranscript`) — discriminated state, `refetch`-without-reset,
  conv_id reset pattern (the one PR #19.1 promoted to load-bearing).
- One new component (`<TranscriptHistory />`) plus four block sub-components
  (`<TextBlockView />`, `<ThinkingBlockView />`, `<ToolUseBlockView />`,
  `<ToolResultBlockView />`) — all pure presentational, all marked with
  `data-test` + `data-state` per I-3.
- App.tsx wires history above the active turn and triggers `refetch()` on every
  active-turn terminator (`completed | cancelled | errored`) so the user sees
  the just-finished turn appear in history when the watcher catches up.

Explicitly **deferred** to PR #18d:

- Markdown rendering (text blocks render as `<pre>` for now)
- Tool-card collapsibles (use+result blocks render fully expanded)
- Scroll-to-bottom (sticky-bottom + freeze-on-scroll-up)
- `tool_use` ↔ `tool_result` cross-message visual pairing (renders as
  separate blocks with shared `tool_use_id` discoverable via `data-tool-id`)

Explicitly **deferred** to a future "live history" PR:

- Live history updates from `transcript.updated` envelopes. Today the renderer
  refetches on terminator; the WebSocket envelope path stays unread because
  history is naturally consistent at turn boundaries, not mid-stream.

## 2. Wire shape (already pinned by PR #20a)

```ts
type TranscriptResponse = {
  conv_id: string;
  cwd: string | null;
  session_id: string | null;
  lines: TranscriptLine[];
};
```

The hook calls `client.getTranscript(conv_id)`; the component renders
`normalizeTranscriptLines(response.lines): ChatMessage[]` (PR #9). The `cwd` /
`session_id` fields are presented in a small "transcript meta" footer for
debugging — useful when the UI starts behaving suspiciously and you want to
double-check which JSONL file it's reading from.

## 3. Hook shape

```ts
type TranscriptState =
  | { status: 'idle' }              // conv_id undefined
  | { status: 'loading' }           // first fetch in flight
  | { status: 'ok'; messages: ChatMessage[]; meta: TranscriptMeta }
  | { status: 'error'; error: ClientError }
  | { status: 'not_configured' };   // engine without `transcripts` opt-in

interface UseTranscriptReturn {
  state: TranscriptState;
  /** Re-issue the request without resetting status to 'loading'. */
  refetch: () => void;
}

useTranscript({ conv_id }: { conv_id: string | undefined }): UseTranscriptReturn;
```

Same template as `useConversations` + `useTurnStream`:

- Discriminated state (I-2) with the established `not_configured` discriminator
  (PR #13's `ClientError.kind === 'not_configured'`).
- `refetch()` does **not** flip status to 'loading' — calling it on terminator
  must not blank the history mid-render.
- `conv_id` change → synchronous reset during render (the pattern PR #19.1
  promoted to load-bearing across all conv_id-keyed hooks).
- AbortController on unmount; cancelled flag for late-resolve safety.

## 4. Component shape

```tsx
<TranscriptHistory state={state} />
```

Five render variants discriminated on `state.status`:

- `idle`: returns `null` (nothing to render — composer's hint variant covers
  the empty-pane case).
- `loading`: muted "Loading history…" placeholder with `data-state="loading"`.
- `ok`: vertical column of `<ChatMessageView />` rows + `<TranscriptMetaFooter />`.
- `error`: error block with truncated message + full text in title attr (matches
  the I-3 / HealthBadge / Composer pattern).
- `not_configured`: muted "History unavailable on this engine" placeholder.

`<ChatMessageView />` discriminates on `role`:

- `user`: muted "You" header + content blocks.
- `assistant`: "Claude" header + content blocks.

Each `ContentBlock` renders through one of:

- `<TextBlockView text={block.text} />` — `<pre className="whitespace-pre-wrap">`
- `<ThinkingBlockView text={block.text} />` — dashed border, italic muted
- `<ToolUseBlockView block={block} />` — name + JSON-stringified input
- `<ToolResultBlockView block={block} />` — `tool_use_id` reference + content
  (string verbatim or JSON-stringified)

All sub-components carry `data-test` + appropriate `data-*` markers. Pure
presentational — no `useState`, no `useEffect`, no event handlers (I-4).

## 5. App.tsx wiring

```tsx
const transcript = useTranscript({ conv_id: selectedId });
const turn = useTurnStream({ conv_id: selectedId ?? '', enabled: !!selectedId });

// Refetch history when the active turn terminates.
useEffect(() => {
  if (turn.status === 'completed' || turn.status === 'cancelled' ||
      turn.status === 'errored') {
    transcript.refetch();
  }
}, [turn.status, turn.turn_id]);

// Layout: history scrollable above active turn (which is itself scrollable);
// composer fixed at bottom.
return (
  <main>
    <TranscriptHistory state={transcript.state} />
    <TurnView state={turn} />
    <Composer ... />
  </main>
);
```

The `useEffect` on `turn.status + turn.turn_id` covers both common cases:

- Turn completes → status flips to 'completed' → effect fires once → refetch.
- New turn starts and completes → turn_id changes → effect fires once → refetch.

Calling `refetch()` does not blank history (per §3) so the UI stays continuous.

## 6. Breadcrumbs (the user's explicit ask from PR #20a feedback)

The wire-event format (`TranscriptUpdatedEvent.payload.lines`) and the
HTTP-route response format (`TranscriptResponse.lines`) are *guaranteed
identical* because both consumers (`packages/transcripts/src/watcher.ts` for
WS, `apps/engine/src/routes/transcript.ts` for HTTP) call the same
`parseTranscriptLine` primitive from `@clod-ui/transcripts`.

This invariant matters and is currently invisible. Add breadcrumbs in:

1. `packages/transcripts/src/parse-line.ts` — the function's docstring already
   describes its role; add a load-bearing-callers list so future agents can
   `grep` for who depends on it.
2. `packages/transcripts/src/index.ts` — top-level export note that the parser
   is the contract boundary.
3. `apps/engine/src/routes/transcript.ts` — comment near the response-shape
   construction noting the WS-HTTP identity.
4. `packages/transcripts/src/watcher.ts` — comment near the parser call noting
   the same.
5. `docs/INVARIANTS.md` — promote to a named invariant: I-9 *Shared parsers
   guarantee wire/route identity*.

## 7. Test plan

Hook (vitest+RTL+happy-dom, ~7 tests):

- starts idle when conv_id undefined
- transitions loading → ok on resolve
- transitions loading → error on reject
- transitions loading → not_configured on `ClientError.kind === 'not_configured'`
- `refetch()` re-issues without resetting status to loading
- conv_id change resets state synchronously (no stale frame)
- aborts in-flight on unmount

Component (renderToString, ~14 tests):

- TranscriptHistory: 5 variants × 1 test each (idle, loading, ok, error, not_configured)
- ChatMessageView: 2 variants (user, assistant)
- TextBlockView: 1 test (renders text)
- ThinkingBlockView: 1 test (italic + dashed)
- ToolUseBlockView: 2 tests (string input, object input)
- ToolResultBlockView: 3 tests (string content, error state, object content)

Total estimated: ~21 new tests.

## 8. Verification

- ci:fast green
- spine 26 / 26 unchanged (no new spine contract — PR #20a's T1.15 covers the
  HTTP path; client-side wiring is integration-tier)
- 5× flake check on new tests + 5× full spine
- Typecheck + lint + format + README link-check clean

## 9. Deferred tickets (after this PR)

- `// TODO(markdown-renderer)` — queued for PR #18d
- `// TODO(tool-card-collapse)` — queued for PR #18d
- `// TODO(scroll-to-bottom)` — queued for PR #18d
- `// TODO(tool-pairing)` — render `tool_use` and matching `tool_result` as
  visually paired cards across message boundaries; deferred until UX research
  confirms what "paired" should look like
- `// TODO(live-history-updates)` — wire `transcript.updated` envelopes into
  `useTranscript` so history updates without waiting for terminator; deferred
  until the terminator-based refetch proves insufficient in practice
- `// TODO(layout-state)` — still not on the critical path
