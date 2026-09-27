# PR #9 — `ChatMessage` normalization

> Status: Active. Executes architecture v2 Task **3.4 (second half)** — the watcher landed in PR #7 with raw JSONL lines on the wire; this PR turns those lines into a typed `ChatMessage` shape any consumer can render. Companion plans: `plans/2026-04-23-clod-ui-architecture-v2.md`, `plans/landed/2026-04-23-clod-ui-pr7-transcript-watcher-v1.md`, `plans/landed/2026-04-23-clod-ui-pr8-settings-roundtrip-v1.md`.

## Objective

Add a pure transformation `TranscriptLine[] → ChatMessage[]` that the web UI (Phase 4) can call client-side over the `transcript.updated` payload it already receives. The wire surface does **not** change; this PR only adds:

1. A canonical `ChatMessage` schema in `@clod-ui/contracts` — the wire-facing data type the UI renders, the engine never speaks it as a stream event.
2. A `normalizeTranscriptLines(lines): NormalizationResult` function in `@clod-ui/transcripts` — pure, no IO, one `TranscriptLine` becomes at most one `ChatMessage`.

## Out of Scope

- **A new wire event for normalized messages** (`chat.messages` / similar). The watcher emitting raw lines + the consumer normalizing them client-side is strictly more flexible: the UI can re-render without re-fetching, and a future debug client (or a different UI) can choose to read the raw view. Adding a wire event would also double the payload bandwidth for no informational gain.
- **Streaming partial-message support.** CC's `--include-partial-messages` flag is off in PR #4; each assistant content block arrives as a complete line. When we flip it on, the normalizer will need a "fold this fragment into the prior in-progress assistant message" rule. Until then, one line = one message.
- **Folding `tool_result` user messages into the prior assistant's `tool_use` block.** That's a *rendering* decision (does the UI show a tool-use card with its result inlined, or as a sibling message?). Baking it into the data primitive removes the choice. The normalizer keeps the chronological structure; the UI decides how to display it.
- **Conversation-level metadata** (titles, timestamps beyond per-line `byte_offset`, token usage rollups). All belong to higher-level `ConversationState` projections, not the per-message shape.
- **Engine-side normalization toggle.** The engine continues to broadcast raw `transcript.updated{lines}` only. If a future use case (server-side rendering, log export) needs normalized messages, we can add a one-line hook then; doing it now is YAGNI.
- **Auto-titling (Task 3.5).** Distinct slice; needs the secondary `claude -p` invocation surface and its own design plan.

## Design

### `ChatMessage` shape — one line, one message

```ts
// @clod-ui/contracts
export const ContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('thinking'), text: z.string(), signature: z.string().optional() }),
  z.object({
    type: z.literal('tool_use'),
    tool_use_id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.unknown(),
    is_error: z.boolean(),
  }),
]);

export const ChatMessageSchema = z.object({
  /** Stable identifier; derived from the source line_number. */
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  content: z.array(ContentBlockSchema),
  /** Provenance: where in the JSONL this message came from. */
  source: z.object({
    line_number: z.number().int().nonnegative(),
    byte_offset: z.number().int().nonnegative(),
  }),
});
```

**Why one line = one message:**

- The JSONL on disk *is* one event per line; preserving that mapping makes the normalizer trivially incremental (handed a new batch of lines from the watcher, it produces a new batch of messages with no lookback).
- Folding tool-results into prior assistants would require the normalizer to be stateful or to scan an arbitrary lookback window. Either bakes a rendering decision into the data primitive.
- The ID can be deterministic without a hash: `msg-<line_number>` is unique within a conversation by construction.

**Why `is_error` is required (not optional):**

- The ToolResult rendering decision (red badge vs. neutral) hinges on this flag. Making it optional means every consumer has to guard with `?? false`. The normalizer reads CC's `is_error: true | undefined` once and writes `false` explicitly when absent — cheaper for every reader.

**Why `signature` on `thinking` is optional:**

- CC sometimes emits a `signature` (cryptographic hash for verifying extended-thinking content). When absent, the normalizer omits the key (matches `exactOptionalPropertyTypes: true`).

### `NormalizationResult` — bookkeeping for the lines we drop

```ts
export interface NormalizationResult {
  messages: ChatMessage[];
  /** Lines we deliberately skipped (system.init, result, hooks, etc.). */
  skipped: Array<{
    line_number: number;
    reason: 'parse_error' | 'system_event' | 'unknown_role' | 'no_content';
  }>;
}
```

Returning a `skipped[]` instead of silently filtering serves two callers:

1. **Tests** — assertions like "exactly two lines were skipped, both for `reason: 'system_event'`" pin behavior precisely.
2. **Diagnostic UIs** — a hypothetical "show me everything in the transcript including dropped lines" dev-tool view can render skipped entries as ghost rows.

`reason` taxonomy:
- `'parse_error'` — the upstream `TranscriptLine` had a `parse_error` set (the JSON itself was malformed).
- `'system_event'` — `type: 'system'`, `'result'`, `'rate_limit_event'` — not a chat message.
- `'unknown_role'` — a `user`/`assistant` line whose `message.role` is something else (defensive).
- `'no_content'` — a `user`/`assistant` line whose `message.content` is missing, empty, or contained only unrecognized content blocks.

### Mapping table

| Source line shape | → `ChatMessage` |
|---|---|
| `{type:'user', message:{role:'user', content:[{type:'text', text}]}}` | `{role:'user', content:[{type:'text', text}]}` |
| `{type:'user', message:{content:[{type:'tool_result', tool_use_id, content, is_error?}]}}` | `{role:'user', content:[{type:'tool_result', tool_use_id, content, is_error: !!is_error}]}` |
| `{type:'assistant', message:{content:[{type:'text', text}]}}` | `{role:'assistant', content:[{type:'text', text}]}` |
| `{type:'assistant', message:{content:[{type:'tool_use', id, name, input}]}}` | `{role:'assistant', content:[{type:'tool_use', tool_use_id:id, name, input}]}` |
| `{type:'assistant', message:{content:[{type:'thinking', thinking, signature?}]}}` | `{role:'assistant', content:[{type:'thinking', text:thinking, signature?}]}` |
| Multi-block content | One message with all valid blocks in source order |
| `{type:'system'\|'result'\|'rate_limit_event', ...}` | `skipped{reason:'system_event'}` |
| Any line with `parse_error` set | `skipped{reason:'parse_error'}` |

A line that yields zero recognized content blocks is `skipped{reason:'no_content'}` rather than emitting an empty message — the UI shouldn't have to filter.

### Pure, idempotent, incremental

- **Pure**: no IO, no logging, no `Date.now()` calls. Same input → same output, every time.
- **Idempotent**: calling twice on the same input returns deep-equal results. Test-pinned.
- **Incremental**: `normalizeTranscriptLines([line0, line1, line2])` yields the same prefix as `normalizeTranscriptLines([line0])` ++ `normalizeTranscriptLines([line1, line2])`. This means the UI can append-normalize each watcher batch instead of re-normalizing the full transcript every time. Test-pinned.

### Why this lives in `@clod-ui/transcripts` and not its own package

- The function consumes `TranscriptLine` (the `transcripts` package's own type). Putting it elsewhere would create a circular-import problem or force `TranscriptLine` to move.
- It produces `ChatMessage` (a `contracts` type). The transformation depends on both, so the natural placement is the layer above `contracts` (which is `transcripts`).
- A separate `@clod-ui/chat-messages` package would be three exports in a folder — unnecessary structure for what amounts to one pure function and its types.

## Tasks

### §1 — `@clod-ui/contracts/chat-message.ts`
- `ContentBlockSchema` (Zod discriminated union over `type`).
- `ChatMessageSchema` with `id`, `role`, `content`, `source: { line_number, byte_offset }`.
- Re-export from contracts barrel.

### §2 — `@clod-ui/transcripts/normalize.ts`
- `normalizeTranscriptLines(lines: TranscriptLine[]): NormalizationResult` — pure.
- Internal helpers `normalizeOne(line)`, `extractBlocks(rawContent[])`, `messageId(lineNumber)`.
- Unit tests in `packages/transcripts/tests/normalize.test.ts`:
  - Each row of the mapping table → exact expected message.
  - Multi-block messages preserve content order.
  - Skipped lines are recorded with the right reason.
  - Idempotence: `normalize(normalize(lines).messages... )` not applicable (different types) but `normalize(lines)` called twice deep-equals.
  - Incrementality: `normalize(prefix ++ suffix)` deep-equals `normalize(prefix).messages ++ normalize(suffix-with-renumbered-line-numbers).messages`.
  - Realistic transcript fixture (≥ 8 lines, mix of roles + tool-use + tool-result + thinking + a system line + a parse_error line) with golden expected output.

### §3 — Verify
- `bun run ci:fast` green.
- 5× flake check on the new normalize tests.
- Spine count unchanged (20/20 — this PR ships no new spine contract since the wire didn't move).
- Commit cadence:
  1. `docs(plans)` — this file.
  2. `feat(contracts)` — `ChatMessage` schema.
  3. `feat(transcripts)` — `normalizeTranscriptLines` + tests.

## Risk + Mitigation

1. **CC's JSONL shape drifts (e.g. a new content block type lands in a future CC release).** The normalizer ignores unrecognized block types and reports the message as `no_content` if every block is unrecognized. Adding a new block (e.g. `image_url`) is a one-line schema + one-clause normalizer change; existing fixtures stay valid. We do **not** silently hard-fail on unknown shapes.

2. **Mismatched assumptions about `tool_result.content` shape.** CC sometimes emits the result as a string, sometimes as an array of `{type:'text', text}` blocks, sometimes as a structured object. The normalizer keeps `content: unknown` — the UI's `ToolResult` renderer is responsible for stringifying. This avoids tying the data primitive to one rendering choice. Tests pin all three observed shapes round-trip unchanged.

3. **Order-sensitivity within a multi-block message.** `extractBlocks` walks the source array in order and pushes blocks in that order. Tests pin a `[text, tool_use, text]` sequence to assert the order survives.

4. **Incremental property under retroactive line numbering.** The watcher's `line_number` is monotonically assigned per file; the normalizer is a function of `(line, line_number)` only — no global state. A test composes two normalizations with the right offsets and asserts deep-equal to the one-shot call.

5. **What if `message.role` is `'user'` but content is `[{type:'text', text:'…'}]` *and* `[{type:'tool_result', ...}]` mixed?** That's a single `ChatMessage` with both blocks in source order. The UI decides whether to show a "user" message with a tool result inline or to re-route the rendering — but the data faithfully carries what was on disk.

## Open Items (forward)

- A future `transcript.normalized` WS event that streams `ChatMessage[]` for clients that don't want to bundle the normalizer. Wait until at least one such client exists.
- Streaming-partial-message support (`--include-partial-messages true`): a stateful normalizer that folds `assistant.delta` fragments into an in-progress message. Distinct slice once we measure the perf impact of enabling the flag.
- Inline tool-use ↔ tool-result association at the data layer (not the rendering layer) — i.e. attaching the `ToolResultBlock` to the matching `ToolUseBlock` automatically. Defer until a UI surface needs it; the current chronological model loses no information.
- A `ChatMessage` → on-disk JSONL inverse for synthetic test transcripts. Useful when we add export/import features in Phase 5.

## What unblocks next

- **Phase 4 web UI** can render real transcripts as soon as it's scaffolded — the renderer's input contract is `ChatMessage[]`, which is now a stable wire-typed shape with golden fixtures.
- **Auto-titling (Task 3.5)** can consume `messages[0]` and `messages[1]` (typed) instead of fishing through raw JSONL when picking the prompt summary.
- **Conversation export** (Phase 5) gets a normalized intermediate it can serialize to Markdown / HTML cleanly.
