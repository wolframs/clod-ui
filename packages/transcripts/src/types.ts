/**
 * Wire + watcher types for the transcript subsystem.
 *
 * Spec: `plans/landed/2026-04-23-clod-ui-pr7-transcript-watcher-v1.md` §"Design".
 */

/**
 * A single observed line from the JSONL transcript.
 *
 * **Wire identity**: this interface mirrors `TranscriptLine` from
 * `@clod-ui/contracts` exactly. Both the watcher's `transcript.updated`
 * event and the `GET /conversations/:id/transcript` route project lines
 * through the same `parseTranscriptLine` helper (`./parse-line.ts`), so
 * any change here must also land in `packages/contracts/src/transcript.ts`.
 * See `plans/landed/2026-05-02-clod-ui-pr20a-transcript-route-v1.md`
 * §"Wire identity" for the rationale.
 */
export interface TranscriptLine {
  /** Zero-indexed line number within the JSONL file. */
  line_number: number;
  /** Byte offset of the start of this line within the file. */
  byte_offset: number;
  /**
   * Decoded JSON object for the line. `null` iff `parse_error` is set —
   * the watcher never silently drops a line; failures travel with the line.
   */
  raw: unknown;
  /** Present iff `JSON.parse` threw on the line. */
  parse_error?: { message: string; raw_text: string };
}

/**
 * Wire event emitted whenever the watcher observes one or more new lines.
 * `lines` is non-empty by construction.
 */
export interface TranscriptUpdatedEvent {
  kind: 'transcript.updated';
  conv_id: string;
  session_id: string;
  lines: TranscriptLine[];
}

/**
 * Pluggable timer source. Defaults to global timers; tests can inject a
 * `FakeClock`-backed shim for deterministic scheduling.
 */
export interface TimerLike {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  now: () => number;
}

export interface TranscriptWatcherOptions {
  conv_id: string;
  session_id: string;
  /** Conversation cwd; encodes into the projects-dir subpath. */
  cwd: string;
  /** Root of `<CLAUDE_HOME>/projects`. */
  projectsDir: string;
  /** Receives one `transcript.updated` event per debounced batch. */
  onUpdate: (event: TranscriptUpdatedEvent) => void;
  /** Polling interval (ms). Default 50. */
  pollIntervalMs?: number;
  /**
   * Debounce window (ms). Default 25. After a poll observes new lines, the
   * watcher waits this long for further activity before emitting; subsequent
   * polls within the window roll into the same batch.
   */
  debounceMs?: number;
  /** Time / timer source. Defaults to the global `setTimeout` / etc. */
  timers?: TimerLike;
  /**
   * Optional sink for non-fatal warnings (e.g. transient stat failure).
   * Defaults to a silent no-op.
   */
  onWarn?: (message: string) => void;
}
