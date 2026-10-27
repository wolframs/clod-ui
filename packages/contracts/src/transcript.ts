/**
 * Transcript history projection — read-side companion to the
 * `transcript.updated` wire envelope. Mirrors the structural shape produced
 * by `@clod-ui/transcripts`'s `parseTranscriptLine` and `readAllLines`.
 *
 * Spec: plans/landed/2026-05-02-clod-ui-pr20a-transcript-route-v1.md §2.
 */
import { z } from 'zod';

/**
 * Per-line parse-error metadata. Always carries the original raw text so
 * consumers can render parse failures without losing fidelity.
 */
export const TranscriptParseErrorSchema = z.object({
  message: z.string(),
  raw_text: z.string(),
});

export type TranscriptParseError = z.infer<typeof TranscriptParseErrorSchema>;

/**
 * Single parsed line from a JSONL transcript file. `raw` is the JSON-decoded
 * payload (an opaque object — exact shape varies by Claude Code version);
 * `parse_error` is set instead when the line could not be decoded. `raw` is
 * required (set to `null` when `parse_error` is present); the parser never
 * silently drops a line.
 *
 * **Wire identity**: this schema mirrors `TranscriptLine` from
 * `@clod-ui/transcripts/src/types.ts` exactly. Both the watcher's
 * `transcript.updated` event and the `GET /conversations/:id/transcript`
 * route read through the same `parseTranscriptLine` helper, so any change
 * here must also land in `packages/transcripts/src/types.ts` (and vice
 * versa). The shared parser is the load-bearing primitive — see
 * `plans/landed/2026-05-02-clod-ui-pr20a-transcript-route-v1.md` §"Wire identity".
 *
 * `line_number` is 0-based; `byte_offset` is the file position at the start
 * of the line. Both are useful as cursors for incremental re-renders and for
 * debugging.
 */
export const TranscriptLineSchema = z.object({
  line_number: z.number().int().nonnegative(),
  byte_offset: z.number().int().nonnegative(),
  raw: z.unknown(),
  parse_error: TranscriptParseErrorSchema.optional(),
});

export type TranscriptLine = z.infer<typeof TranscriptLineSchema>;

/**
 * `GET /conversations/:id/transcript` response shape. Wrapped so future
 * pagination cursors (`since_line_number`, `total_count`, `truncated`) land
 * without a wire-shape break, mirroring the `ConversationsListResponse`
 * precedent.
 *
 * `lines` is the in-order array; an empty array is a valid response when the
 * underlying JSONL file does not exist yet (the conversation has been
 * provisioned but not yet had a turn that emitted JSONL).
 */
export const TranscriptResponseSchema = z.object({
  lines: z.array(TranscriptLineSchema),
});

export type TranscriptResponse = z.infer<typeof TranscriptResponseSchema>;
