import { z } from 'zod';

/**
 * Wire-side schema and constants for the `replay.start` control envelope.
 *
 * Every WS upgrade emits one `replay.start` envelope before any replay tail or
 * live envelopes. It marks the boundary between replayed and live streams and
 * carries the cursor metadata consumers need to detect gaps:
 *
 *   - `since`          — the cursor the client supplied (or `null` for fresh)
 *   - `replayed_count` — how many envelopes follow before live resumes
 *   - `gap`            — `true` iff the buffer couldn't satisfy the cursor
 *                        (i.e. `since` is older than the buffer's oldest id);
 *                        consumers should refetch from the persistent surface
 *                        (manifest + JSONL) when seen.
 *
 * Spec: plans/landed/2026-04-30-clod-ui-pr17-reconnect-and-resume-v1.md §3-§4
 *       plans/landed/2026-04-30-clod-ui-pr17-1-replay-schema-and-reconnect-integration-v1.md §3.
 */
export const REPLAY_START_KIND = 'replay.start' as const;

/**
 * Sentinel envelope id used by every `replay.start` envelope.
 *
 * Lex-less-than every real envelope id `EnvelopeIdSource` produces (which
 * starts the hex tail at counter=1 → `...000000000001`). Documented as a
 * wire-level "ignore for last-id tracking" id; the client transport never
 * updates its resume cursor on receiving this id.
 */
export const REPLAY_START_SENTINEL_ID = '00000000-0000-4000-8000-000000000000';

export const ReplayStartPayloadSchema = z.object({
  kind: z.literal(REPLAY_START_KIND),
  since: z.string().uuid().nullable(),
  replayed_count: z.number().int().nonnegative(),
  gap: z.boolean(),
});

export type ReplayStartPayload = z.infer<typeof ReplayStartPayloadSchema>;
