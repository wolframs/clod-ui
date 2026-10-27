import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ManifestStore } from '@clod-ui/manifest';
import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { getConversation, openDb } from '../src/db/index.ts';
import { ensureProvisioned, recordSessionId } from '../src/provisioning.ts';

const CONV_A = '11111111-1111-4111-8111-111111111111';

let root: string;
let store: ManifestStore;
let db: Database;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clod-ui-prov-'));
  store = new ManifestStore(root);
  db = openDb({ path: join(root, 'engine.sqlite') });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('ensureProvisioned', () => {
  test('creates dirs, manifest, and DB row on first call', async () => {
    const result = await ensureProvisioned({ store, db }, { convId: CONV_A });
    expect(result.created).toBe(true);

    const convDir = store.conversationDir(CONV_A);
    expect(existsSync(join(convDir, 'cwd'))).toBe(true);
    expect(existsSync(join(convDir, 'scratch'))).toBe(true);
    expect(existsSync(join(convDir, 'manifest.json'))).toBe(true);

    const events = await store.readAll(CONV_A);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('conversation.created');

    const row = getConversation(db, CONV_A);
    expect(row?.id).toBe(CONV_A);
    expect(row?.cwd).toBe(result.cwd);
    expect(row?.claude_session_id).toBeNull();
  });

  test('defaultCwd on the context anchors new conversations there (PR #38)', async () => {
    const shared = join(root, 'project-repo');
    const result = await ensureProvisioned({ store, db, defaultCwd: shared }, { convId: CONV_A });
    expect(result.cwd).toBe(shared);
    expect(existsSync(shared)).toBe(true);
    expect(getConversation(db, CONV_A)?.cwd).toBe(shared);
    // scratch stays per-conversation
    expect(existsSync(join(store.conversationDir(CONV_A), 'scratch'))).toBe(true);
  });

  test('second call on same id is a no-op (created:false, no duplicate manifest line)', async () => {
    await ensureProvisioned({ store, db }, { convId: CONV_A });
    const result2 = await ensureProvisioned({ store, db }, { convId: CONV_A });

    expect(result2.created).toBe(false);
    const events = await store.readAll(CONV_A);
    expect(events).toHaveLength(1);
  });

  test('returns the cwd from the existing row when re-provisioning', async () => {
    const r1 = await ensureProvisioned({ store, db }, { convId: CONV_A });
    const r2 = await ensureProvisioned({ store, db }, { convId: CONV_A, cwd: '/different/path' });
    expect(r2.cwd).toBe(r1.cwd);
  });
});

describe('recordSessionId', () => {
  test('appends session.captured + updates DB row', async () => {
    await ensureProvisioned({ store, db }, { convId: CONV_A });
    const result = await recordSessionId({ store, db }, { convId: CONV_A, session_id: 'sess-xyz' });
    expect(result.recorded).toBe(true);

    const events = await store.readAll(CONV_A);
    expect(events.map((e) => e.kind)).toEqual(['conversation.created', 'session.captured']);
    expect((events[1] as { session_id: string }).session_id).toBe('sess-xyz');

    expect(getConversation(db, CONV_A)?.claude_session_id).toBe('sess-xyz');
  });

  test('second recordSessionId on same conv is a no-op (idempotent)', async () => {
    await ensureProvisioned({ store, db }, { convId: CONV_A });
    await recordSessionId({ store, db }, { convId: CONV_A, session_id: 'sess-1' });
    const result2 = await recordSessionId({ store, db }, { convId: CONV_A, session_id: 'sess-2' });
    expect(result2.recorded).toBe(false);

    const events = await store.readAll(CONV_A);
    expect(events).toHaveLength(2);
    // First write wins.
    expect(getConversation(db, CONV_A)?.claude_session_id).toBe('sess-1');
  });

  test('recordSessionId on un-provisioned conv soft-refuses', async () => {
    const result = await recordSessionId(
      { store, db },
      { convId: CONV_A, session_id: 'sess-orphan' },
    );
    expect(result.recorded).toBe(false);
    expect(await store.readAll(CONV_A)).toEqual([]);
  });
});
