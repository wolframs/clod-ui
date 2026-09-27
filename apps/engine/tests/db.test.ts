import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import {
  createConversation,
  CURRENT_SCHEMA_VERSION,
  getConversation,
  listConversations,
  openDb,
  setSessionId,
} from '../src/db/index.ts';

function mkRoot(): string {
  return mkdtempSync(join(tmpdir(), 'clod-ui-db-'));
}

const CONV_A = '11111111-1111-4111-8111-111111111111';
const CONV_B = '22222222-2222-4222-8222-222222222222';

describe('openDb migrations', () => {
  test('fresh file → schema applied, _migrations populated', () => {
    const root = mkRoot();
    try {
      const dbPath = join(root, 'test.sqlite');
      const db = openDb({ path: dbPath });
      try {
        const rows = db
          .query<{ version: number }, []>('SELECT version FROM _migrations ORDER BY version')
          .all();
        expect(rows.map((r) => r.version)).toEqual(
          Array.from({ length: CURRENT_SCHEMA_VERSION }, (_, i) => i + 1),
        );
        // conversations table exists
        const tableInfo = db
          .query<
            { name: string },
            []
          >("SELECT name FROM sqlite_schema WHERE type='table' AND name='conversations'")
          .all();
        expect(tableInfo).toHaveLength(1);
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reopen is idempotent — no duplicate migration rows', () => {
    const root = mkRoot();
    try {
      const dbPath = join(root, 'test.sqlite');
      openDb({ path: dbPath }).close();
      const db = openDb({ path: dbPath });
      try {
        const rows = db
          .query<{ count: number }, []>('SELECT COUNT(*) as count FROM _migrations')
          .get();
        expect(rows?.count).toBe(CURRENT_SCHEMA_VERSION);
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('DB at future schema version refuses to open', () => {
    const root = mkRoot();
    try {
      const dbPath = join(root, 'test.sqlite');
      // First open creates the schema.
      const db = openDb({ path: dbPath });
      // Pretend a future binary applied a migration ahead of us.
      db.run('INSERT INTO _migrations (version, description, applied_at) VALUES (?, ?, ?)', [
        CURRENT_SCHEMA_VERSION + 5,
        'future migration from a binary not yet shipped',
        Date.now(),
      ]);
      db.close();

      let err: unknown;
      try {
        openDb({ path: dbPath }).close();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('forward-only');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('conversations repository', () => {
  test('createConversation + getConversation roundtrip', () => {
    const root = mkRoot();
    try {
      const db = openDb({ path: join(root, 'test.sqlite') });
      try {
        const cwd = '/tmp/conv-a/cwd';
        const row = createConversation(db, { id: CONV_A, cwd, created_at: 5000 });
        expect(row).toEqual({ id: CONV_A, claude_session_id: null, cwd, created_at: 5000 });

        const fetched = getConversation(db, CONV_A);
        expect(fetched).toEqual(row);
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('getConversation on absent id returns null', () => {
    const root = mkRoot();
    try {
      const db = openDb({ path: join(root, 'test.sqlite') });
      try {
        expect(getConversation(db, CONV_A)).toBeNull();
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('setSessionId updates claude_session_id', () => {
    const root = mkRoot();
    try {
      const db = openDb({ path: join(root, 'test.sqlite') });
      try {
        createConversation(db, { id: CONV_A, cwd: '/x' });
        setSessionId(db, CONV_A, 'sess-12345');
        expect(getConversation(db, CONV_A)?.claude_session_id).toBe('sess-12345');
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('listConversations orders by created_at DESC', () => {
    const root = mkRoot();
    try {
      const db = openDb({ path: join(root, 'test.sqlite') });
      try {
        createConversation(db, { id: CONV_A, cwd: '/a', created_at: 1000 });
        createConversation(db, { id: CONV_B, cwd: '/b', created_at: 2000 });
        const all = listConversations(db);
        expect(all.map((r) => r.id)).toEqual([CONV_B, CONV_A]);
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('createConversation throws on duplicate id', () => {
    const root = mkRoot();
    try {
      const db = openDb({ path: join(root, 'test.sqlite') });
      try {
        createConversation(db, { id: CONV_A, cwd: '/a' });
        let err: unknown;
        try {
          createConversation(db, { id: CONV_A, cwd: '/b' });
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(Error);
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('persistence across reopens', () => {
  test('rows survive close + reopen', () => {
    const root = mkRoot();
    try {
      const dbPath = join(root, 'test.sqlite');
      const db1 = openDb({ path: dbPath });
      createConversation(db1, { id: CONV_A, cwd: '/x', created_at: 1234 });
      setSessionId(db1, CONV_A, 'sess-persist');
      db1.close();

      const db2 = openDb({ path: dbPath });
      try {
        const row = getConversation(db2, CONV_A);
        expect(row?.id).toBe(CONV_A);
        expect(row?.claude_session_id).toBe('sess-persist');
        expect(row?.cwd).toBe('/x');
        expect(row?.created_at).toBe(1234);
      } finally {
        db2.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
