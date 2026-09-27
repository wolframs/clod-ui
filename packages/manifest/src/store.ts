import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, truncateSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import { ManifestCorruptError } from './errors.ts';
import type { ConversationState, ManifestEvent, ManifestEventInput } from './types.ts';

/**
 * Append-only NDJSON manifest store. One file per conversation under
 * `<root>/conversations/<convId>/manifest.json`.
 *
 * Single-writer assumption: the engine is single-instance per app-data root.
 * Concurrent writes to the same manifest file are not handled here (Phase 2
 * Task 2.9 enforces single-instance via pidfile).
 *
 * Append uses `O_APPEND` mode which is atomic for writes ≤ PIPE_BUF (4 KiB on
 * macOS) — all our event lines fit comfortably. We do **not** fsync per write:
 * losing the trailing few events on power-loss is acceptable; corrupting
 * earlier events is not, and append-mode prevents that by construction.
 *
 * Spec: plans/landed/2026-04-23-clod-ui-pr6-sqlite-manifest-v1.md §1.
 */
export interface ManifestStoreOptions {
  /**
   * Optional time source. Tests pass a deterministic clock; production omits
   * to use `Date.now()`. The store does not validate that supplied `ts` is
   * monotonic — that's the caller's contract.
   */
  now?: () => number;
}

export class ManifestStore {
  private readonly root: string;
  private readonly now: () => number;

  constructor(root: string, opts: ManifestStoreOptions = {}) {
    this.root = root;
    this.now = opts.now ?? Date.now;
  }

  /** Absolute path to a conversation's manifest file. */
  pathFor(convId: string): string {
    return join(this.root, 'conversations', convId, 'manifest.json');
  }

  /** Absolute path to a conversation's directory (for cwd/, scratch/, etc.). */
  conversationDir(convId: string): string {
    return join(this.root, 'conversations', convId);
  }

  /**
   * Append a single event. Computes the next `seq`, links `hash_prev` to the
   * previous line's `hash_self`, and writes one NDJSON line to the manifest.
   *
   * O(events) on first call per conversation (we read the file to find the
   * last event); subsequent calls in the same process could amortize via a
   * cache, but we keep it simple — a manifest read on append is microseconds
   * for the sizes we deal with.
   */
  async appendEvent(convId: string, input: ManifestEventInput): Promise<ManifestEvent> {
    const path = this.pathFor(convId);
    mkdirSync(dirname(path), { recursive: true });

    // Read existing events to determine seq + hash_prev. On a fresh file, that
    // means seq=0, hash_prev=undefined.
    const existing = await this.readAll(convId);
    const last = existing[existing.length - 1];
    const seq = last ? last.seq + 1 : 0;
    const hashPrev = last?.hash_self;
    const ts = input.ts ?? this.now();

    const eventBody: Record<string, unknown> = {
      seq,
      ts,
      kind: input.kind,
      ...stripUndefined(input as unknown as Record<string, unknown>, ['ts', 'kind']),
    };

    const hashSelf = computeHash(eventBody, hashPrev);
    const event: ManifestEvent = {
      ...(eventBody as object),
      hash_self: hashSelf,
      ...(hashPrev !== undefined ? { hash_prev: hashPrev } : {}),
    } as ManifestEvent;

    const line = JSON.stringify(event) + '\n';
    appendFileSync(path, line, { flag: 'a' });
    return event;
  }

  /**
   * Read all events from a conversation's manifest, validating the hash chain
   * and sequence monotonicity along the way. Throws `ManifestCorruptError` on
   * any violation. Returns `[]` for a missing file.
   */
  async readAll(convId: string): Promise<ManifestEvent[]> {
    const path = this.pathFor(convId);
    if (!existsSync(path)) return [];

    const raw = await readFile(path, 'utf8');
    if (raw.length === 0) return [];

    // Track whether the file ended with a newline. If not, the last "line" is
    // a partial write and must fail to parse — we surface that as truncated.
    const endsWithNewline = raw.endsWith('\n');
    const lines = raw.split('\n');
    // After split, a file ending in '\n' produces a trailing empty string
    // which we drop. A file *not* ending in '\n' has the last line as the
    // partial write itself; we keep it and let the hash check / parse catch it.
    if (endsWithNewline) {
      lines.pop();
    }

    const out: ManifestEvent[] = [];
    let prevHash: string | undefined;
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i]!;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        const reason = !endsWithNewline && i === lines.length - 1 ? 'truncated' : 'parse';
        throw new ManifestCorruptError({ line: i, reason, path });
      }
      if (parsed['seq'] !== i) {
        throw new ManifestCorruptError({
          line: i,
          reason: 'seq',
          path,
          detail: `expected seq ${i}, got ${String(parsed['seq'])}`,
        });
      }
      const storedHash = parsed['hash_self'];
      if (typeof storedHash !== 'string') {
        throw new ManifestCorruptError({
          line: i,
          reason: 'hash',
          path,
          detail: 'missing hash_self',
        });
      }
      const storedPrev = parsed['hash_prev'];
      if (i === 0 && storedPrev !== undefined) {
        throw new ManifestCorruptError({
          line: i,
          reason: 'hash',
          path,
          detail: 'hash_prev present on seq:0',
        });
      }
      if (i > 0 && storedPrev !== prevHash) {
        throw new ManifestCorruptError({
          line: i,
          reason: 'hash',
          path,
          detail: `hash_prev ${String(storedPrev)} does not match prior hash_self ${String(prevHash)}`,
        });
      }
      // Recompute hash_self from the body without hash_prev / hash_self,
      // using the actual prevHash from the chain.
      const body = stripFields(parsed, ['hash_prev', 'hash_self']);
      const expected = computeHash(body, prevHash);
      if (expected !== storedHash) {
        throw new ManifestCorruptError({
          line: i,
          reason: 'hash',
          path,
          detail: 'recomputed hash does not match stored hash_self (event body tampered with)',
        });
      }

      out.push(parsed as unknown as ManifestEvent);
      prevHash = storedHash;
    }
    return out;
  }

  /** Pure left-fold: events → projected `ConversationState`. */
  fold(events: ManifestEvent[]): ConversationState {
    const state: ConversationState = {
      attachments: [],
      artifacts: [],
      enabled_skills: [],
    };
    for (const ev of events) {
      switch (ev.kind) {
        case 'conversation.created':
          state.created_at = ev.ts;
          if (ev.title !== undefined) state.title = ev.title;
          break;
        case 'conversation.titled':
          state.title = ev.title;
          break;
        case 'session.captured':
          state.claude_session_id = ev.session_id;
          break;
        case 'settings.applied':
          if (ev.model !== undefined) state.model = ev.model;
          if (ev.thinking_effort !== undefined) state.thinking_effort = ev.thinking_effort;
          if (ev.system_prompt !== undefined) state.system_prompt = ev.system_prompt;
          if (ev.allowed_tools !== undefined) state.allowed_tools = ev.allowed_tools;
          if (ev.disallowed_tools !== undefined) state.disallowed_tools = ev.disallowed_tools;
          break;
        case 'model.changed':
          state.model = ev.to;
          break;
        case 'tool_config.changed':
          if (ev.allowed_tools !== undefined) state.allowed_tools = ev.allowed_tools;
          if (ev.disallowed_tools !== undefined) state.disallowed_tools = ev.disallowed_tools;
          break;
        case 'system_prompt.changed':
          state.system_prompt = { mode: ev.mode, text: ev.text };
          break;
        case 'skills.changed':
          state.enabled_skills = [...ev.enabled];
          break;
        case 'attachment.added':
          state.attachments.push({
            id: ev.attachment_id,
            relative_path: ev.relative_path,
            content_hash: ev.content_hash,
            bytes: ev.bytes,
          });
          break;
        case 'artifact.observed':
          state.artifacts.push({
            relative_path: ev.relative_path,
            content_hash: ev.content_hash,
            bytes: ev.bytes,
          });
          break;
        default: {
          // Forward-compat: unknown kinds are no-ops. Exhaustiveness check
          // below would force exhaustiveness, which is what we want.
          const _exhaustive: never = ev;
          void _exhaustive;
        }
      }
    }
    return state;
  }

  /**
   * Test/maintenance helper: truncate the manifest file to `bytes`. Used by
   * T1.10's truncation-detection test to simulate a process killed mid-write.
   * Production code has no business calling this.
   */
  truncateFor(convId: string, bytes: number): void {
    truncateSync(this.pathFor(convId), bytes);
  }
}

/** Strip a known set of fields from a record, returning a new object. */
function stripFields(obj: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!fields.includes(k)) out[k] = v;
  }
  return out;
}

/** Drop `undefined` values + named keys from a record. */
function stripUndefined(obj: Record<string, unknown>, alsoSkip: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (alsoSkip.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Compute `hash_self` for an event. Input is the event body **without** the
 * `hash_prev` and `hash_self` fields. The computation is:
 *
 *   sha256( canonical_json(body) || (prev ?? "") )
 */
function computeHash(body: Record<string, unknown>, prev: string | undefined): string {
  const canonical = canonicalJson(body);
  const h = createHash('sha256');
  h.update(canonical);
  h.update(prev ?? '');
  return h.digest('hex');
}
