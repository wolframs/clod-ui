import { existsSync, statSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import { encodeCwd } from './encode-cwd.ts';
import { parseTranscriptLine } from './parse-line.ts';
import type {
  TimerLike,
  TranscriptLine,
  TranscriptUpdatedEvent,
  TranscriptWatcherOptions,
} from './types.ts';

/**
 * Per-conversation JSONL tail watcher.
 *
 * Lifecycle:
 *
 *   constructed -> start() -> awaiting-file
 *   awaiting-file -> (file appears) -> tailing
 *   tailing -> (size grows) -> read new bytes -> debounce -> onUpdate
 *   any -> stop() -> stopped (timers cleared, file handle released)
 *
 * Polling (not `fs.watch`) is intentional: deterministic across macOS/Linux,
 * trivially `FakeClock`-testable, and the cost (one stat per pollIntervalMs)
 * is negligible. See `plans/landed/2026-04-23-clod-ui-pr7-transcript-watcher-v1.md`.
 */
export class TranscriptWatcher {
  private readonly opts: Required<
    Omit<TranscriptWatcherOptions, 'timers' | 'onWarn' | 'pollIntervalMs' | 'debounceMs'>
  > & {
    timers: TimerLike;
    onWarn: (message: string) => void;
    pollIntervalMs: number;
    debounceMs: number;
  };
  private readonly filePath: string;

  private state: 'idle' | 'awaiting-file' | 'tailing' | 'stopped' = 'idle';
  private pollHandle: unknown = null;
  private debounceHandle: unknown = null;
  private byteOffset = 0;
  private lineNumber = 0;
  /** Buffer for an incomplete trailing line (no newline yet). */
  private partial = '';
  /** Lines pending emission inside the current debounce window. */
  private pending: TranscriptLine[] = [];
  /** Used to serialize concurrent tail reads. */
  private readPromise: Promise<void> | null = null;

  constructor(options: TranscriptWatcherOptions) {
    const timers = options.timers ?? defaultTimers();
    this.opts = {
      conv_id: options.conv_id,
      session_id: options.session_id,
      cwd: options.cwd,
      projectsDir: options.projectsDir,
      onUpdate: options.onUpdate,
      pollIntervalMs: options.pollIntervalMs ?? 50,
      debounceMs: options.debounceMs ?? 25,
      timers,
      onWarn: options.onWarn ?? (() => {}),
    };
    this.filePath = join(
      this.opts.projectsDir,
      encodeCwd(this.opts.cwd),
      `${this.opts.session_id}.jsonl`,
    );
  }

  /** Absolute path to the JSONL file this watcher targets. */
  path(): string {
    return this.filePath;
  }

  start(): void {
    if (this.state !== 'idle') return;
    this.state = 'awaiting-file';
    this.pollHandle = this.opts.timers.setInterval(() => {
      void this.poll();
    }, this.opts.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped') return;
    this.state = 'stopped';
    if (this.pollHandle !== null) {
      this.opts.timers.clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    if (this.debounceHandle !== null) {
      this.opts.timers.clearTimeout(this.debounceHandle);
      this.debounceHandle = null;
    }
    // Wait for any in-flight read to settle so callers know all timers and
    // file handles are quiesced when stop() resolves.
    if (this.readPromise) {
      try {
        await this.readPromise;
      } catch {
        // ignore — best-effort flush
      }
    }
    this.flushPending();
  }

  /**
   * Force a synchronous tail-pass right now, bypassing the poll interval.
   * Returns the number of new lines emitted into the pending buffer
   * (note: emission to onUpdate still respects the debounce window unless
   * `flush: true` is passed).
   */
  async tickNow(opts: { flush?: boolean } = {}): Promise<number> {
    if (this.state === 'stopped') return 0;
    if (this.state === 'idle') this.state = 'awaiting-file';
    const before = this.pending.length;
    await this.poll();
    const added = this.pending.length - before;
    if (opts.flush) {
      this.flushPending();
    }
    return added;
  }

  private async poll(): Promise<void> {
    if (this.state === 'stopped') return;
    // Serialize concurrent polls (real timers can re-fire while a read is
    // still draining — debounce + batching keeps that benign, but the read
    // itself must not interleave).
    if (this.readPromise) return;
    const work = this.doPoll().finally(() => {
      this.readPromise = null;
    });
    this.readPromise = work;
    await work;
  }

  private async doPoll(): Promise<void> {
    if (this.state === 'awaiting-file') {
      if (!existsSync(this.filePath)) return;
      this.state = 'tailing';
    }
    let size: number;
    try {
      size = statSync(this.filePath).size;
    } catch (err) {
      // File may have been deleted (rotation); reset cursor and wait for it
      // to reappear. This is an edge case and not part of T1.11's contract.
      this.opts.onWarn(`stat failed for ${this.filePath}: ${String(err)}`);
      this.state = 'awaiting-file';
      this.byteOffset = 0;
      this.lineNumber = 0;
      this.partial = '';
      return;
    }
    if (size <= this.byteOffset) return;

    let handle: FileHandle | null = null;
    try {
      handle = await open(this.filePath, 'r');
      const length = size - this.byteOffset;
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, this.byteOffset);
      const text = this.partial + buf.toString('utf8');
      this.byteOffset = size;
      this.absorb(text);
    } catch (err) {
      this.opts.onWarn(`read failed for ${this.filePath}: ${String(err)}`);
    } finally {
      if (handle) await handle.close().catch(() => {});
    }

    if (this.pending.length > 0) this.scheduleDebounce();
  }

  /** Slice `text` on `\n`, append complete lines to pending, retain the tail. */
  private absorb(text: string): void {
    // The first byte of `text` lies at this file offset, recovered as
    // `byteOffset - byteLength(text)`. Each line's offset is then
    // `textStartOffset + byteLength(text.slice(0, cursor))`.
    const textStartOffset = this.byteOffset - Buffer.byteLength(text, 'utf8');
    let cursor = 0;
    while (true) {
      const newlineIdx = text.indexOf('\n', cursor);
      if (newlineIdx === -1) break;
      const lineText = text.slice(cursor, newlineIdx);
      const lineByteOffset = textStartOffset + Buffer.byteLength(text.slice(0, cursor), 'utf8');
      this.pending.push(parseTranscriptLine(this.lineNumber, lineByteOffset, lineText));
      this.lineNumber++;
      cursor = newlineIdx + 1;
    }
    this.partial = text.slice(cursor);
  }

  private scheduleDebounce(): void {
    if (this.debounceHandle !== null) {
      this.opts.timers.clearTimeout(this.debounceHandle);
    }
    this.debounceHandle = this.opts.timers.setTimeout(() => {
      this.debounceHandle = null;
      this.flushPending();
    }, this.opts.debounceMs);
  }

  private flushPending(): void {
    if (this.pending.length === 0) return;
    const lines = this.pending;
    this.pending = [];
    const ev: TranscriptUpdatedEvent = {
      kind: 'transcript.updated',
      conv_id: this.opts.conv_id,
      session_id: this.opts.session_id,
      lines,
    };
    try {
      this.opts.onUpdate(ev);
    } catch (err) {
      this.opts.onWarn(`onUpdate threw: ${String(err)}`);
    }
  }
}

function defaultTimers(): TimerLike {
  return {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof globalThis.setInterval>),
    now: () => Date.now(),
  };
}
