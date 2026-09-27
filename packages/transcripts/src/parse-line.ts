/**
 * Pure JSONL line parser. Mirrors the watcher's per-line semantics but is
 * decoupled from any tail-state — used by both the streaming watcher
 * (line-by-line) and the historical reader (whole-file).
 *
 * **Load-bearing identity**: this is the *single* parser used by both the
 * `transcript.updated` wire event (via `TranscriptWatcher`) and the
 * `GET /conversations/:id/transcript` HTTP route (via `readAllLines`).
 * Both consumers receive byte-identical `TranscriptLine` shapes — see
 * `docs/INVARIANTS.md` I-9 ("Wire-event and route-response shapes are
 * byte-identical for transcript surfaces").
 *
 * Spec: `plans/landed/2026-05-02-clod-ui-pr20a-transcript-route-v1.md` §"The transcripts helper".
 */
import type { TranscriptLine } from './types.ts';

export function parseTranscriptLine(
  line_number: number,
  byte_offset: number,
  text: string,
): TranscriptLine {
  try {
    const raw = JSON.parse(text) as unknown;
    return { line_number, byte_offset, raw };
  } catch (err) {
    return {
      line_number,
      byte_offset,
      raw: null,
      parse_error: {
        message: err instanceof Error ? err.message : String(err),
        raw_text: text,
      },
    };
  }
}
