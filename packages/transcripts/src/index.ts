/**
 * @clod-ui/transcripts — per-conversation transcript watcher.
 *
 * The transcript file is owned by Claude Code: it lives at
 * `<CLAUDE_HOME>/projects/<encoded-cwd>/<session-id>.jsonl` and grows as the
 * CC subprocess streams its session log. We tail this file and emit
 * `transcript.updated` wire events for newly observed lines.
 *
 * Design: `plans/landed/2026-04-23-clod-ui-pr7-transcript-watcher-v1.md`.
 */
export { encodeCwd } from './encode-cwd.ts';
export { parseTranscriptLine } from './parse-line.ts';
export { readAllLines } from './read-all.ts';
export { TranscriptWatcher } from './watcher.ts';
export { extractBlocks, messageId, normalizeOne, normalizeTranscriptLines } from './normalize.ts';
export type { NormalizationResult, SkippedLine } from './normalize.ts';
export type {
  TimerLike,
  TranscriptLine,
  TranscriptUpdatedEvent,
  TranscriptWatcherOptions,
} from './types.ts';
