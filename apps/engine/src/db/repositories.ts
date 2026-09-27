import type { Database } from 'bun:sqlite';

/**
 * Typed repository functions over the engine's SQLite index. Each function
 * is a thin, named wrapper around a prepared statement to keep call sites
 * readable and the SQL surface narrow.
 *
 * Spec: plans/2026-04-23-clod-ui-architecture-v2.md Task 3.1.
 */

export interface ConversationRow {
  id: string;
  claude_session_id: string | null;
  cwd: string;
  created_at: number;
}

export interface CreateConversationInput {
  id: string;
  cwd: string;
  /** Defaults to `Date.now()` when omitted. */
  created_at?: number;
}

/** Insert a new conversation row. Throws on duplicate id. */
export function createConversation(db: Database, input: CreateConversationInput): ConversationRow {
  const created_at = input.created_at ?? Date.now();
  db.run(
    'INSERT INTO conversations (id, claude_session_id, cwd, created_at) VALUES (?, NULL, ?, ?)',
    [input.id, input.cwd, created_at],
  );
  return { id: input.id, claude_session_id: null, cwd: input.cwd, created_at };
}

/** Get a single conversation; returns null if absent. */
export function getConversation(db: Database, id: string): ConversationRow | null {
  const row = db
    .query<
      ConversationRow,
      [string]
    >('SELECT id, claude_session_id, cwd, created_at FROM conversations WHERE id = ?')
    .get(id);
  return row ?? null;
}

/** Update a conversation's claude_session_id. No-op if value is unchanged. */
export function setSessionId(db: Database, id: string, session_id: string): void {
  db.run('UPDATE conversations SET claude_session_id = ? WHERE id = ?', [session_id, id]);
}

/** List all conversations ordered by creation time descending. */
export function listConversations(db: Database): ConversationRow[] {
  return db
    .query<
      ConversationRow,
      []
    >('SELECT id, claude_session_id, cwd, created_at FROM conversations ORDER BY created_at DESC')
    .all();
}
