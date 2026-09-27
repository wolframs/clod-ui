/**
 * Forward-only migrations for the engine's SQLite index.
 *
 * Add new migrations to the end of `MIGRATIONS`; never rewrite an applied
 * migration. The current `version` is `MIGRATIONS.length`.
 *
 * Spec: plans/2026-04-23-clod-ui-architecture-v2.md Task 3.1.
 * IMPL: PR #6 (plans/landed/2026-04-23-clod-ui-pr6-sqlite-manifest-v1.md).
 */
export interface Migration {
  version: number;
  description: string;
  up: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: 'conversations table + index on claude_session_id',
    up: `
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        claude_session_id TEXT,
        cwd TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conversations_session
        ON conversations(claude_session_id);
    `,
  },
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS.length;
