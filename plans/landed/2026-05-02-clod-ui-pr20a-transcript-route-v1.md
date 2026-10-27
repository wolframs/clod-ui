# PR #20a — Transcript HTTP route (server-side half of history loop)

**Status:** in flight
**Date:** 2026-05-02
**Spine before:** 24 / 24 across 14 contracts
**Spine after:** 25 / 25 across 15 contracts (T1.15 lands)

## 1. Why now

PR #19 closed the read/write loop for the *active* turn — a user can submit, watch
deltas stream, and see the terminal state. What it can't do: see anything that
happened *before* this session opened the conversation. The engine has the data
(JSONL on disk, written by Claude Code; the watcher tails it for live updates),
but no read-side API exposes the historical tail to the UI.

PR #20a lands that API surface. The client-side hook + history pane that consume
it land separately in **PR #20b** to keep each slice scoped to one ~4-commit
diff. Same split rationale as PR #18a/#18b/#18c.

## 2. Slice scope

In:

- `@clod-ui/contracts` — `TranscriptLineSchema`, `TranscriptParseErrorSchema`,
  `TranscriptResponseSchema`. Wire schema for the historical-read response.
- `@clod-ui/transcripts` — extract the watcher's private `parseLine` into a
  shared `parseTranscriptLine` helper; add `readAllLines(filePath)` that
  parses the entire file end-to-end into a `TranscriptLine[]`. Pure, async,
  used by both the engine route and (later) the spine test's expected-value
  computation.
- Engine — `GET /conversations/:id/transcript` route. Opt-in via persistence
  (need cwd from db row to compute path) AND transcripts (need projectsDir).
  Returns `200 { lines: TranscriptLine[] }` with `lines: []` for an empty or
  missing file. Returns `404 { error: 'transcripts not configured' }` when
  the engine runs without the transcripts option.
- Engine — route tests against a real Bun.serve.
- Client — `client.getTranscript(conv_id): Promise<TranscriptLine[]>`. Same
  validation discipline as `getConversations`.
- Spine — **T1.15 transcript-http-round-trip**: write a JSONL file directly,
  GET via the typed client, assert the response matches what `readAllLines`
  parses against the same file. Pins the HTTP path end-to-end.

Out:

- `useTranscript` hook (PR #20b).
- `<TranscriptHistory />` component (PR #20b).
- App.tsx wiring (PR #20b).
- WS merge — historical backfill + live `transcript.updated` envelopes — covered
  in PR #20b once both halves of the data flow exist.

## 3. Wire shape

```ts
// @clod-ui/contracts/transcript-response
export const TranscriptParseErrorSchema = z.object({
  message: z.string(),
  raw_text: z.string(),
});

export const TranscriptLineSchema = z.object({
  line_number: z.number().int().nonnegative(),
  byte_offset: z.number().int().nonnegative(),
  raw: z.unknown(),
  parse_error: TranscriptParseErrorSchema.optional(),
});

export const TranscriptResponseSchema = z.object({
  lines: z.array(TranscriptLineSchema),
});
```

Wrapped under `lines:` so future fields (`next_offset`, `truncated`) land
without a wire-shape break — same forward-compat posture as
`ConversationsListResponseSchema`.

The schema mirrors the existing `TranscriptLine` interface in
`@clod-ui/transcripts/types.ts`. The interface stays in transcripts; the schema
lives in contracts. Same split as `EventEnvelope` (schema in contracts; backend
events in `@clod-ui/backend/types`).

## 4. Engine route surface

```
GET /conversations/:id/transcript

  204 / 200 cases:
    persistence absent           → 404 { error: 'transcripts not configured' }
    transcripts absent           → 404 { error: 'transcripts not configured' }
    conv_id not found in db      → 404 { error: 'conversation not found' }
    conv has no claude_session_id (row exists, never had a turn)
                                 → 200 { lines: [] }
    JSONL file does not exist    → 200 { lines: [] }
    JSONL file empty             → 200 { lines: [] }
    JSONL file has N lines       → 200 { lines: [N entries] }
    JSONL file has parse errors  → 200 { lines: [...] } (errors travel with line)
```

The route is *additive* and read-only — same shape as `GET /conversations`.
Opt-in via the existing `transcripts: { projectsDir }` option (PR #7) AND
`persistence: { store, db }` (PR #6). Memory-only callers stay unaffected.

## 5. The transcripts helper

Currently `parseLine` is a private function inside `watcher.ts`. PR #20a
extracts it into `parse-line.ts` (named export `parseTranscriptLine`) and adds
`read-all.ts` exporting `readAllLines(filePath: string): Promise<TranscriptLine[]>`.

`readAllLines` semantics:

- File does not exist → return `[]` (caller decides whether to 404).
- File is empty → return `[]`.
- File has N lines → returns array of N entries with monotonic `line_number`
  starting at 0, monotonic `byte_offset` starting at 0.
- Trailing line without newline → still parsed and returned (real CC files
  always end with `\n`, but the helper is robust to in-progress writes).
- Parse errors → carried in `line.parse_error` per the existing
  `TranscriptLine` contract; never thrown.

Pure async function. No watcher, no polling, no shared state.

## 6. Spine T1.15 contract

```ts
test('transcript HTTP round-trip surfaces all lines from disk', async () => {
  // Write a JSONL file with 3 lines (mix of valid + parse-error)
  // GET /conversations/:id/transcript via the typed client
  // Assert the response matches what readAllLines parses against the file
  // Specifically:
  //   - same line count
  //   - same line_number ordering (0, 1, 2)
  //   - same byte_offset values
  //   - same raw payload for valid lines
  //   - same parse_error.message for the malformed line
});
```

Pinned: the HTTP path is *exactly* the same data as the disk read. This guards
against a future engine change (e.g. partial-tail optimization) silently
diverging from the canonical disk source.

## 7. Test depth

- Contracts: 5–6 schema tests (valid line, line with parse_error, response
  shape, missing required field rejection, extra fields stripped).
- Transcripts: 6–8 unit tests for `readAllLines` (missing / empty / one
  line / many lines / parse error / trailing partial line / large file).
- Engine: 6–7 route tests (404 paths × 3, 200 empty cases × 2, 200 with
  lines, 200 with parse error).
- Client: 1 unit test (validation discipline) + 1 integration test (real
  engine boot, end-to-end fetch).
- Spine: T1.15 (1 contract).

Estimated total new tests: ~22.

## 8. Boundaries (deferred to later PRs)

- `// TODO(transcript-tail-pagination)` — `?since_line=N` for partial fetch
  once a real consumer hits a transcript with thousands of lines.
- `// TODO(transcript-watcher-backfill)` — engine could re-emit historical
  lines as `transcript.updated` envelopes on first WS connect; right now the
  watcher only emits *new* lines. PR #20b chooses between this and "client
  fetches HTTP first" — the route lands first so the choice stays open.
- `// TODO(transcript-cache)` — engine-side LRU cache of parsed transcripts
  to avoid re-parsing on every fetch; defer until route latency is measured.

## 9. Verification gates

- ci:fast green; spine 25 / 25 across 15 contracts.
- 5× flake check on T1.15 + new unit + route tests.
- 5× full spine flake.
- Typecheck + lint + format clean.

## 10. Commit plan

1. `docs(plans):` PR #20a plan.
2. `feat(transcripts):` extract `parseTranscriptLine` + add `readAllLines` + unit tests.
3. `feat(contracts):` `TranscriptResponseSchema` + schema unit tests.
4. `feat(engine):` `GET /conversations/:id/transcript` route + route tests.
5. `feat(contracts/client):` `client.getTranscript()` + unit + integration tests.
6. `test(spine):` T1.15 transcript HTTP round-trip + SPINE.md update.
