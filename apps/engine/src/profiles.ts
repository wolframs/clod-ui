/**
 * Conversation profiles (PR #45): which binary runs a conversation's turns
 * and in which directory, picked when the conversation is created and fixed
 * after.
 *
 *   - `parseProfileRegistry` — pure parser of the registry file's JSON.
 *   - `FileProfileSource` — re-reads the file when it changes; a malformed
 *     file keeps the last good registry and says why.
 *   - `resolveTurnProfile` — pure: which profile a turn runs on, or the
 *     typed refusal (400 / 409 / 403) the turn route answers with.
 *
 * With no registry file there is one implicit profile, `default`, built from
 * the engine-wide binary and conversation cwd (`CLOD_UI_CLAUDE_BINARY`,
 * `CLOD_UI_CONVERSATION_CWD`). It is stored as NULL, so a conversation made
 * on it keeps running on it whatever the registry later says.
 *
 * Spec: plans/2026-11-05-clod-ui-pr45-profiles-v1.md §D1–D5.
 */
import { readFileSync, statSync } from 'node:fs';

import { PROFILE_ID_PATTERN } from '@clod-ui/contracts';

export const IMPLICIT_PROFILE_ID = 'default';

export interface Profile {
  id: string;
  label: string;
  /** The binary for its turns; undefined = the backend-wide one (implicit only). */
  binary?: string;
  /**
   * A directory = new conversations run there; null = each conversation's
   * own directory; undefined = the engine's conversation cwd (implicit only).
   */
  cwd?: string | null;
  /** Turns need a browser request (an `Origin` header). */
  require_browser: boolean;
  /** The implicit env profile, stored as NULL. */
  implicit: boolean;
}

export interface ProfileRegistry {
  default: string;
  profiles: readonly Profile[];
}

export const IMPLICIT_PROFILE: Profile = {
  id: IMPLICIT_PROFILE_ID,
  label: 'default',
  require_browser: false,
  implicit: true,
};

export const IMPLICIT_REGISTRY: ProfileRegistry = {
  default: IMPLICIT_PROFILE_ID,
  profiles: [IMPLICIT_PROFILE],
};

export type ParsedRegistry = { ok: true; value: ProfileRegistry } | { ok: false; error: string };

const TOP_KEYS = new Set(['default', 'profiles']);
// Unknown keys are refused: a misspelt `require_browser` must not silently
// drop the gate it was meant to set.
const ENTRY_KEYS = new Set(['id', 'label', 'binary', 'cwd', 'require_browser']);

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

/** Parse the registry file's JSON value. Pure; errors name the field, never a path value. */
export function parseProfileRegistry(raw: unknown): ParsedRegistry {
  const fail = (error: string): ParsedRegistry => ({ ok: false, error });
  if (!isRecord(raw)) return fail('the file must hold an object { default, profiles }');
  for (const key of Object.keys(raw)) {
    if (!TOP_KEYS.has(key)) return fail(`unknown key "${key}"`);
  }
  const list = raw['profiles'];
  if (!Array.isArray(list) || list.length === 0) {
    return fail('profiles must be a non-empty array');
  }
  const profiles: Profile[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of list.entries()) {
    const at = `profiles[${i}]`;
    if (!isRecord(entry)) return fail(`${at} must be an object`);
    for (const key of Object.keys(entry)) {
      if (!ENTRY_KEYS.has(key)) return fail(`${at}: unknown key "${key}"`);
    }
    const { id, label, binary, cwd, require_browser } = entry;
    if (typeof id !== 'string' || !PROFILE_ID_PATTERN.test(id)) {
      return fail(`${at}.id must match [a-z0-9-]{1,32}`);
    }
    if (seen.has(id)) return fail(`${at}.id "${id}" is not unique`);
    seen.add(id);
    if (typeof label !== 'string' || label.trim() === '') {
      return fail(`${at}.label must be a non-empty string`);
    }
    if (typeof binary !== 'string' || binary.trim() === '') {
      return fail(`${at}.binary must be a non-empty string`);
    }
    if (cwd !== undefined && cwd !== null && (typeof cwd !== 'string' || !cwd.startsWith('/'))) {
      return fail(`${at}.cwd must be an absolute path or null`);
    }
    if (require_browser !== undefined && typeof require_browser !== 'boolean') {
      return fail(`${at}.require_browser must be a boolean`);
    }
    profiles.push({
      id,
      label,
      binary,
      cwd: cwd ?? null,
      require_browser: require_browser === true,
      implicit: false,
    });
  }
  const def = raw['default'];
  if (typeof def !== 'string' || !seen.has(def)) {
    return fail('default must name one of the profiles');
  }
  return { ok: true, value: { default: def, profiles } };
}

export interface ProfileSnapshot {
  registry: ProfileRegistry;
  /** Why the file as it stands was not taken; absent when it was (or there is none). */
  warning?: string;
}

/** Where the engine reads its profiles from; `current()` is called per request. */
export interface ProfileSource {
  current(): ProfileSnapshot;
}

/** A fixed registry (tests; and the no-file default). */
export function staticProfiles(registry: ProfileRegistry = IMPLICIT_REGISTRY): ProfileSource {
  const snapshot: ProfileSnapshot = { registry };
  return { current: () => snapshot };
}

/**
 * The registry file, re-read whenever its (mtime, size, inode) changes —
 * an atomic rename shows as a new inode even within one mtime tick. No
 * file = the implicit registry. A file that does not parse keeps the last
 * good registry (or the implicit one, before any) and carries the reason
 * as `warning`, logged once per file change.
 */
export class FileProfileSource implements ProfileSource {
  private readonly path: string;
  private readonly log: (msg: string) => void;
  private key: string | null = null;
  private lastGood: ProfileRegistry | null = null;
  private snapshot: ProfileSnapshot = { registry: IMPLICIT_REGISTRY };

  constructor(opts: { path: string; log?: (msg: string) => void }) {
    this.path = opts.path;
    // eslint-disable-next-line no-console
    this.log = opts.log ?? ((msg) => console.warn(msg));
  }

  current(): ProfileSnapshot {
    let key: string;
    try {
      const st = statSync(this.path);
      key = `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        if (this.key !== 'absent') {
          this.key = 'absent';
          this.lastGood = null;
          this.snapshot = { registry: IMPLICIT_REGISTRY };
        }
        return this.snapshot;
      }
      return this.refuse('stat-failed', `cannot stat the profiles file (${errCode(err)})`);
    }
    if (key === this.key) return this.snapshot;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (err) {
      return this.refuse(
        key,
        err instanceof SyntaxError ? 'not valid JSON' : `unreadable (${errCode(err)})`,
      );
    }
    const parsed = parseProfileRegistry(raw);
    if (!parsed.ok) return this.refuse(key, parsed.error);
    this.key = key;
    this.lastGood = parsed.value;
    this.snapshot = { registry: parsed.value };
    return this.snapshot;
  }

  private refuse(key: string, reason: string): ProfileSnapshot {
    if (this.key === key) return this.snapshot;
    this.key = key;
    const kept =
      this.lastGood !== null ? 'keeping the last good registry' : 'using the implicit profile';
    const warning = `profiles file not taken: ${reason}; ${kept}`;
    this.log(`[engine] ${warning} (${this.path})`);
    this.snapshot = { registry: this.lastGood ?? IMPLICIT_REGISTRY, warning };
    return this.snapshot;
  }
}

function errCode(err: unknown): string {
  return (err as NodeJS.ErrnoException | null)?.code ?? 'error';
}

export type TurnProfile =
  | { ok: true; profile: Profile }
  | {
      ok: false;
      status: 400 | 403 | 409;
      body: { error: string | { kind: string; profile?: string } };
    };

/**
 * Which profile a turn runs on (D5). `row` is the conversation's stored
 * profile (`null` = implicit) or `undefined` when it does not exist yet (or
 * the engine runs memory-only). Pure.
 */
export function resolveTurnProfile(args: {
  registry: ProfileRegistry;
  row: { profile: string | null } | undefined;
  requested: string | undefined;
  hasOrigin: boolean;
}): TurnProfile {
  const { registry, row, requested } = args;
  let profile: Profile | undefined;
  let id: string;
  if (row !== undefined) {
    id = row.profile ?? IMPLICIT_PROFILE_ID;
    if (requested !== undefined && requested !== id) {
      return {
        ok: false,
        status: 400,
        body: { error: `profile is fixed at creation: this conversation runs on "${id}"` },
      };
    }
    profile = row.profile === null ? IMPLICIT_PROFILE : registry.profiles.find((p) => p.id === id);
  } else {
    id = requested ?? registry.default;
    profile = registry.profiles.find((p) => p.id === id);
  }
  if (profile === undefined) {
    return {
      ok: false,
      status: 409,
      body: { error: { kind: 'profile_unavailable', profile: id } },
    };
  }
  if (profile.require_browser && !args.hasOrigin) {
    return { ok: false, status: 403, body: { error: { kind: 'browser_required' } } };
  }
  return { ok: true, profile };
}
