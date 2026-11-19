import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { ManifestStore } from '@clod-ui/manifest';
import type { Database } from 'bun:sqlite';

import { createConversation, getConversation, setSessionId } from './db/index.ts';

/**
 * Conversation provisioning service: maintains the invariant that every
 * conv_id seen by the engine has:
 *
 *   - a directory at `<root>/conversations/<id>/{cwd,scratch}/`
 *   - a `manifest.json` with at least the `conversation.created` event
 *   - a row in the `conversations` SQLite table
 *
 * SQLite is a cache; the manifest is the source of truth. Crash recovery is
 * "rebuild SQLite from `fold(readAll())`" — not implemented in this PR but the
 * design supports it without schema change.
 *
 * Spec: plans/2026-04-23-clod-ui-architecture-v2.md Task 3.3.
 */
export interface ProvisioningContext {
  /** Manifest store rooted at the engine's app-data dir. */
  store: ManifestStore;
  /** Engine's SQLite index. */
  db: Database;
  /**
   * Optional (PR #38): cwd for newly provisioned conversations instead of
   * their own `<conv>/cwd/` dir — e.g. a project repo whose CLAUDE.md,
   * hooks and MCP config the CLI should load. Existing rows keep theirs.
   */
  defaultCwd?: string;
}

/**
 * Provision a conversation if it doesn't exist yet. Idempotent: a second call
 * with the same id is a no-op (no duplicate manifest line, no DB conflict).
 *
 * `cwd`: a directory, `null` for the conversation's own `<conv>/cwd/` (a
 * profile with `cwd: null`, PR #45), or omitted for `defaultCwd` then its
 * own. `profile`: stored on the row and the `conversation.created` event;
 * omitted = the implicit profile (NULL, no event field).
 */
export async function ensureProvisioned(
  ctx: ProvisioningContext,
  args: { convId: string; cwd?: string | null; profile?: string },
): Promise<{ created: boolean; cwd: string }> {
  const existing = getConversation(ctx.db, args.convId);
  if (existing) {
    return { created: false, cwd: existing.cwd };
  }

  const convDir = ctx.store.conversationDir(args.convId);
  const ownDir = join(convDir, 'cwd');
  const cwdDir = args.cwd === null ? ownDir : (args.cwd ?? ctx.defaultCwd ?? ownDir);
  const scratchDir = join(convDir, 'scratch');
  mkdirSync(cwdDir, { recursive: true });
  mkdirSync(scratchDir, { recursive: true });

  await ctx.store.appendEvent(args.convId, {
    kind: 'conversation.created',
    ...(args.profile !== undefined && { profile: args.profile }),
  });
  createConversation(ctx.db, {
    id: args.convId,
    cwd: cwdDir,
    ...(args.profile !== undefined && { profile: args.profile }),
  });

  return { created: true, cwd: cwdDir };
}

/**
 * Persist the claude_session_id observed on the conversation's first
 * `system.init` event. Idempotent: if the conversation already has a
 * session_id matching `args.session_id`, this is a no-op. If the persisted
 * session_id differs, we still no-op (the first one wins) — protecting against
 * spurious init events from buggy backends.
 */
export async function recordSessionId(
  ctx: ProvisioningContext,
  args: { convId: string; session_id: string },
): Promise<{ recorded: boolean }> {
  const existing = getConversation(ctx.db, args.convId);
  if (!existing) {
    // Caller error: provisioning must precede session capture. We softly
    // refuse rather than crash — the engine treats this as a no-op and logs.
    return { recorded: false };
  }
  if (existing.claude_session_id) {
    return { recorded: false };
  }

  await ctx.store.appendEvent(args.convId, {
    kind: 'session.captured',
    session_id: args.session_id,
  });
  setSessionId(ctx.db, args.convId, args.session_id);
  return { recorded: true };
}
