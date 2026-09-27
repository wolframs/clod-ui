import { existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  ClaudeSettingsSchema,
  DOCUMENTED_SETTINGS_KEYS,
  type ClaudeSettings,
} from '@clod-ui/contracts';

import { SettingsCorruptError, SettingsValidationError } from './errors.ts';

/**
 * Read/write Claude Code's `~/.claude/settings.json` with atomic IO and
 * three-deep `.bak` rotation. Documented keys (`theme`, `model`,
 * `allowedTools`, `disallowedTools`) are typed; everything else lands in
 * the `unknown` passthrough bucket on the wire and is flattened back to
 * top-level on disk so the file looks like an ordinary CC settings file.
 *
 * Spec: plans/landed/2026-04-23-clod-ui-pr8-settings-roundtrip-v1.md §"SettingsStore".
 *
 * Single-writer assumption: the engine is single-instance per host (Phase 2
 * Task 2.9 enforces via pidfile). Two concurrent writers to the same file
 * would race on the temp+rename window; we don't guard against that here.
 */
export interface SettingsStoreOptions {
  /** Optional warning sink (e.g. `.bak` rotation transient failures). */
  onWarn?: (message: string) => void;
}

export class SettingsStore {
  private readonly filePath: string;
  private readonly onWarn: (message: string) => void;

  constructor(opts: { path: string } & SettingsStoreOptions) {
    this.filePath = opts.path;
    this.onWarn = opts.onWarn ?? (() => {});
  }

  /** Absolute path to the underlying `settings.json`. */
  path(): string {
    return this.filePath;
  }

  /**
   * Read + validate the file. Missing file returns an empty `ClaudeSettings`
   * (`{}`). Throws `SettingsCorruptError` on JSON parse failure or schema
   * mismatch on a documented key. The on-disk file is not touched.
   *
   * TODO(mtime-guard): record file mtime here for `If-Match`-style guards on
   *   write/patch (architecture Task 3.6 deferred to a follow-up).
   */
  async read(): Promise<ClaudeSettings> {
    if (!existsSync(this.filePath)) return {};
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (err) {
      throw new SettingsCorruptError({
        reason: 'parse',
        detail: `read failed: ${String(err)}`,
      });
    }
    return parseSettingsJson(raw);
  }

  /**
   * Replace the file atomically. The supplied settings are validated through
   * Zod first; on validation failure the disk is untouched and the call
   * throws `SettingsValidationError`.
   *
   * The on-disk layout is the canonical CC layout: documented keys appear
   * first in source-declared order, then any unknown keys in their original
   * insertion order (the wire's `unknown` bucket is flattened back to the
   * top level).
   *
   * Atomicity: write to `<path>.tmp.<pid>.<rand>`, fsync, rotate `.bak`
   * chain (best-effort), then `rename(2)` to the target. The temp file
   * lives in the same directory as the target so the rename is on the
   * same filesystem.
   */
  async write(settings: ClaudeSettings): Promise<void> {
    const validated = validate(settings);
    const flat = flatten(validated);
    const json = JSON.stringify(flat, null, 2) + '\n';

    // Ensure the parent directory exists so first-ever writes succeed
    // (the path may live under `~/.claude` even when CC has never run).
    mkdirSync(dirname(this.filePath), { recursive: true });

    const tmpPath = `${this.filePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(tmpPath, 'w');
      await handle.writeFile(json);
      // fsync the file before rename so the data hits the disk; this is the
      // standard belt-and-braces step for atomic-write idioms.
      await handle.sync();
    } finally {
      if (handle) await handle.close().catch(() => {});
    }

    try {
      this.rotateBackups();
      await rename(tmpPath, this.filePath);
    } catch (err) {
      // Best-effort cleanup of the orphan temp file on failure.
      try {
        unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  /**
   * Top-level read-modify-write: only the keys present in `partial` overwrite
   * their counterparts. The existing `unknown` bucket survives unless
   * `partial.unknown` is supplied — in which case its keys merge over the
   * existing bucket (top-level rules also apply within the bucket).
   *
   * Returns the post-merge settings (matches what's now on disk).
   */
  async patch(partial: Partial<ClaudeSettings>): Promise<ClaudeSettings> {
    const current = await this.read();
    // Validate the incoming patch shape first so we can fail without IO.
    validate({ ...current, ...partial });
    const merged: ClaudeSettings = { ...current };
    for (const key of DOCUMENTED_SETTINGS_KEYS) {
      if (key in partial) {
        const value = partial[key];
        if (value === undefined) {
          delete merged[key];
        } else {
          // Each branch is a sound assignment by Zod-validated shape.
          (merged as Record<string, unknown>)[key] = value;
        }
      }
    }
    if (partial.unknown !== undefined) {
      merged.unknown = { ...(current.unknown ?? {}), ...partial.unknown };
    }
    await this.write(merged);
    return merged;
  }

  /**
   * Rotate `<path>` → `.bak` → `.bak.1` → `.bak.2`; oldest is discarded.
   * Best-effort: any rotation failure is logged via `onWarn` and the call
   * proceeds. Runs synchronously so the rename that lands the new file
   * happens after the chain has shifted.
   */
  private rotateBackups(): void {
    const chain = [
      this.filePath, // current → .bak
      `${this.filePath}.bak`, // .bak → .bak.1
      `${this.filePath}.bak.1`, // .bak.1 → .bak.2
      `${this.filePath}.bak.2`, // .bak.2 → discard
    ];
    // Walk newest→oldest so we don't overwrite a file we still need to read.
    for (let i = chain.length - 1; i >= 1; i--) {
      const src = chain[i - 1]!;
      const dst = chain[i]!;
      if (!existsSync(src)) continue;
      try {
        if (existsSync(dst)) unlinkSync(dst);
        renameSync(src, dst);
      } catch (err) {
        this.onWarn(`backup rotation failed (${src} -> ${dst}): ${String(err)}`);
      }
    }
  }
}

// ---- helpers --------------------------------------------------------------

/**
 * Split a raw on-disk JSON record into the bucketed `ClaudeSettings` shape.
 * Keys in `DOCUMENTED_SETTINGS_KEYS` go to the top level; everything else
 * (except a literal nested `unknown` key — see note) lands in `unknown`.
 *
 * Note: a top-level key literally named `unknown` in the on-disk file is
 * folded into our `unknown` bucket as `unknown.unknown`, since the bucket
 * is our wire convention rather than something CC users would ever spell.
 * In practice this never collides.
 */
export function bucket(raw: Record<string, unknown>): ClaudeSettings {
  const out: ClaudeSettings = {};
  const unknownKeys: Record<string, unknown> = {};
  let hasUnknown = false;
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'theme' || key === 'model' || key === 'allowedTools' || key === 'disallowedTools') {
      // Validation runs after bucketing; we just route here.
      (out as Record<string, unknown>)[key] = value;
    } else {
      unknownKeys[key] = value;
      hasUnknown = true;
    }
  }
  if (hasUnknown) out.unknown = unknownKeys;
  return out;
}

/**
 * Inverse of `bucket`: emit the documented keys first (in source order),
 * then the unknown bucket flattened to the top level (in its original
 * insertion order). The two-step build preserves order across both halves.
 */
export function flatten(s: ClaudeSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of DOCUMENTED_SETTINGS_KEYS) {
    if (s[key] !== undefined) {
      out[key] = s[key];
    }
  }
  if (s.unknown) {
    for (const [k, v] of Object.entries(s.unknown)) {
      out[k] = v;
    }
  }
  return out;
}

function parseSettingsJson(raw: string): ClaudeSettings {
  if (raw.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SettingsCorruptError({
      reason: 'parse',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SettingsCorruptError({
      reason: 'parse',
      detail: 'top-level value must be a JSON object',
    });
  }
  const bucketed = bucket(parsed as Record<string, unknown>);
  const result = ClaudeSettingsSchema.safeParse(bucketed);
  if (!result.success) {
    throw new SettingsCorruptError({
      reason: 'schema',
      detail: 'one or more documented keys have the wrong type',
      issues: result.error.issues,
    });
  }
  return result.data;
}

function validate(input: ClaudeSettings): ClaudeSettings {
  const result = ClaudeSettingsSchema.safeParse(input);
  if (!result.success) {
    throw new SettingsValidationError({
      detail: 'one or more keys failed schema validation',
      issues: result.error.issues,
    });
  }
  return result.data;
}
