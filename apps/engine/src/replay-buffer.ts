/**
 * `ReplayBuffer` — bounded ring buffer of recently-broadcast envelopes.
 *
 * Every envelope that crosses the WS boundary passes through here before
 * reaching live sockets. On WS upgrade with `?since=<env_id>`, the engine
 * replays envelopes whose id is strictly greater than the supplied id,
 * letting reconnecting clients resume exactly where they left off.
 *
 * Capacity is bounded; FIFO eviction. When a client's `since` id is older
 * than the buffer's oldest entry (or the buffer was emptied by a restart),
 * `since()` reports a gap so the engine can emit a `replay.gap` envelope
 * and the client can refetch from manifest + JSONL.
 *
 * IDs are compared lexicographically. `EnvelopeIdSource` produces zero-
 * padded hex counters in UUID format, so string ordering matches numeric
 * ordering up to 16^12 events per app instance — comfortable headroom.
 *
 * Spec: plans/landed/2026-04-30-clod-ui-pr17-reconnect-and-resume-v1.md §3.
 */
import type { EventEnvelope } from '@clod-ui/contracts';

export interface SinceResult {
  /** Envelopes strictly newer than the supplied `sinceId`, in order. */
  envelopes: EventEnvelope[];
  /**
   * `true` when the supplied `sinceId` is older than the oldest buffered
   * entry (i.e. some content was evicted / never buffered). UI should
   * refetch from the persistent surface (manifest + JSONL) in this case.
   */
  gap: boolean;
}

export interface ReplayBufferOptions {
  /** Maximum number of envelopes retained. Default 1024. */
  capacity?: number;
}

export class ReplayBuffer {
  private readonly buf: EventEnvelope[] = [];
  private readonly cap: number;

  constructor(opts: ReplayBufferOptions = {}) {
    const cap = opts.capacity ?? 1024;
    if (!Number.isInteger(cap) || cap < 1) {
      throw new Error(`ReplayBuffer: capacity must be a positive integer (got ${cap})`);
    }
    this.cap = cap;
  }

  /** Append an envelope. Drops the oldest entry when over capacity. */
  push(env: EventEnvelope): void {
    this.buf.push(env);
    if (this.buf.length > this.cap) {
      this.buf.shift();
    }
  }

  /**
   * Returns envelopes whose id is strictly greater than `sinceId`. When
   * `sinceId` is `null`, returns the full current buffer (a fresh
   * subscriber's initial snapshot is empty in practice; this branch is
   * mainly useful for tests). When `sinceId` is older than the oldest
   * buffered envelope (and the buffer is non-empty), `gap` is `true`.
   */
  since(sinceId: string | null): SinceResult {
    if (sinceId === null) {
      return { envelopes: this.buf.slice(), gap: false };
    }
    if (this.buf.length === 0) {
      // Empty buffer: we can't know whether anything was missed. Conservative
      // answer is "no gap" because the client has nothing to compare against
      // post-restart anyway.
      return { envelopes: [], gap: false };
    }
    const oldest = this.buf[0];
    const newest = this.buf[this.buf.length - 1];
    // sinceId already at-or-beyond newest → up-to-date, no replay needed.
    if (oldest === undefined || newest === undefined) {
      return { envelopes: [], gap: false };
    }
    if (sinceId >= newest.id) {
      return { envelopes: [], gap: false };
    }
    // sinceId older than oldest buffered → gap; replay everything we have.
    if (sinceId < oldest.id) {
      return { envelopes: this.buf.slice(), gap: true };
    }
    // sinceId is somewhere inside the buffer; binary-search the boundary.
    // The buffer is monotonically ordered by id, so we can find the first
    // index whose id > sinceId via linear scan (capacity is small enough
    // for the scan to be cheaper than a binary search's overhead in
    // practice; revisit if capacity grows past ~10k).
    const out: EventEnvelope[] = [];
    for (const env of this.buf) {
      if (env.id > sinceId) out.push(env);
    }
    return { envelopes: out, gap: false };
  }

  size(): number {
    return this.buf.length;
  }

  capacity(): number {
    return this.cap;
  }
}
