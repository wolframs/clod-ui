import { Database } from 'bun:sqlite';

import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from './migrations.ts';

/**
 * Open the engine's SQLite index and apply pending migrations atomically.
 *
 * - Enables WAL journal mode (concurrent readers + better crash safety).
 * - Enables foreign_keys (off by default in SQLite).
 * - Tracks applied migrations in `_migrations`.
 * - Refuses to open a DB from a future schema version (forward-only safety).
 *
 * Spec: plans/2026-04-23-clod-ui-architecture-v2.md Task 3.1.
 */
export interface OpenDbOptions {
  /** Absolute path or ':memory:'. */
  path: string;
}

export function openDb(opts: OpenDbOptions): Database {
  const db = new Database(opts.path, { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );`,
  );

  const applied = db
    .query<{ version: number }, []>('SELECT version FROM _migrations ORDER BY version ASC')
    .all();
  const appliedSet = new Set(applied.map((r) => r.version));
  const maxApplied = applied.length > 0 ? Math.max(...applied.map((r) => r.version)) : 0;

  if (maxApplied > CURRENT_SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `engine DB at ${opts.path} is at schema version ${maxApplied}, but this binary supports ` +
        `up to ${CURRENT_SCHEMA_VERSION}. Refusing to open (forward-only migrations).`,
    );
  }

  // Apply all pending migrations in a single transaction.
  const pending = MIGRATIONS.filter((m) => !appliedSet.has(m.version));
  if (pending.length > 0) {
    db.transaction(() => {
      for (const m of pending) {
        db.exec(m.up);
        db.run('INSERT INTO _migrations (version, description, applied_at) VALUES (?, ?, ?)', [
          m.version,
          m.description,
          Date.now(),
        ]);
      }
    })();
  }

  return db;
}
