/**
 * Engine HTTP-route tests for `GET /conversations` (PR #12).
 *
 * Spec: plans/landed/2026-04-27-clod-ui-pr12-conversations-list-v1.md §6.
 *
 * Boot pattern: real `createApp` with persistence; we provision
 * conversations directly via `ensureProvisioned` and append manifest
 * events to drive the projection without spinning up turns. The route
 * itself reads the table and folds the manifests — turn lifecycle is
 * exercised by the spine test (T1.13).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ManifestStore } from '@clod-ui/manifest';
import { ScriptedBackend, script } from '@clod-ui/test-kit';
import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { openDb, setSessionId } from '../src/db/index.ts';
import { createApp } from '../src/index.ts';
import { ensureProvisioned } from '../src/provisioning.ts';

const CONV_A = '11111111-1111-4111-8111-111111111111';
const CONV_B = '22222222-2222-4222-8222-222222222222';

let root: string;
let store: ManifestStore;
let db: Database;

function buildBackend() {
  return new ScriptedBackend(script().init('sess-conv-routes').assistantText('ok').result().end());
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clod-ui-conv-routes-'));
  store = new ManifestStore(root);
  db = openDb({ path: join(root, 'engine.sqlite') });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

interface ListResponse {
  conversations: Array<{
    conv_id: string;
    title?: string;
    created_at: number;
    updated_at: number;
    claude_session_id?: string;
  }>;
}

describe('engine /conversations — 404 when persistence absent', () => {
  test('GET /conversations → 404 when no store/db', async () => {
    const ctx = createApp({ backend: buildBackend() });
    const res = await ctx.app.fetch(new Request('http://x/conversations'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('conversations not configured');
  });
});

describe('engine /conversations — empty list', () => {
  test('GET /conversations → 200 { conversations: [] } when nothing provisioned', async () => {
    const ctx = createApp({ backend: buildBackend(), store, db });
    const res = await ctx.app.fetch(new Request('http://x/conversations'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ conversations: [] });
  });
});

describe('engine /conversations — single provisioned conversation', () => {
  test('appears with no title; updated_at === created_at (only conversation.created event)', async () => {
    await ensureProvisioned({ store, db }, { convId: CONV_A });
    const ctx = createApp({ backend: buildBackend(), store, db });
    const res = await ctx.app.fetch(new Request('http://x/conversations'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListResponse;
    expect(body.conversations).toHaveLength(1);
    const entry = body.conversations[0]!;
    expect(entry.conv_id).toBe(CONV_A);
    expect(entry.title).toBeUndefined();
    expect(entry.claude_session_id).toBeUndefined();
    // ensureProvisioned calls store.appendEvent + createConversation in
    // sequence; their two Date.now() reads can differ by ~1ms either way.
    // The contract is: both timestamps are present and within a tight band.
    expect(entry.created_at).toBeGreaterThan(0);
    expect(entry.updated_at).toBeGreaterThan(0);
    expect(Math.abs(entry.updated_at - entry.created_at)).toBeLessThan(50);
  });

  test('title from manifest fold surfaces in the response', async () => {
    await ensureProvisioned({ store, db }, { convId: CONV_A });
    await store.appendEvent(CONV_A, {
      kind: 'conversation.titled',
      title: 'A Real Title',
    });
    const ctx = createApp({ backend: buildBackend(), store, db });
    const res = await ctx.app.fetch(new Request('http://x/conversations'));
    const body = (await res.json()) as ListResponse;
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]!.title).toBe('A Real Title');
  });

  test('claude_session_id mirrors the SQLite row when set', async () => {
    await ensureProvisioned({ store, db }, { convId: CONV_A });
    setSessionId(db, CONV_A, 'sess-xyz');
    const ctx = createApp({ backend: buildBackend(), store, db });
    const res = await ctx.app.fetch(new Request('http://x/conversations'));
    const body = (await res.json()) as ListResponse;
    expect(body.conversations[0]!.claude_session_id).toBe('sess-xyz');
  });
});

describe('engine /conversations — sort order', () => {
  test('updated_at desc surfaces freshly-touched conversations first', async () => {
    // Provision A then B: B's created_at > A's.
    await ensureProvisioned({ store, db }, { convId: CONV_A });
    // Tiny gap so created_at differs deterministically.
    await new Promise((r) => setTimeout(r, 5));
    await ensureProvisioned({ store, db }, { convId: CONV_B });
    // Bump A's updated_at past B's by appending a fresh event on A.
    await new Promise((r) => setTimeout(r, 5));
    await store.appendEvent(CONV_A, {
      kind: 'conversation.titled',
      title: 'Recently Titled',
    });

    const ctx = createApp({ backend: buildBackend(), store, db });
    const res = await ctx.app.fetch(new Request('http://x/conversations'));
    const body = (await res.json()) as ListResponse;
    expect(body.conversations).toHaveLength(2);
    expect(body.conversations[0]!.conv_id).toBe(CONV_A);
    expect(body.conversations[1]!.conv_id).toBe(CONV_B);
    expect(body.conversations[0]!.updated_at).toBeGreaterThan(body.conversations[1]!.updated_at);
  });
});

describe('engine /conversations — corrupt manifest is skipped, others render', () => {
  test('a corrupt manifest does not 500 the whole list', async () => {
    await ensureProvisioned({ store, db }, { convId: CONV_A });
    await ensureProvisioned({ store, db }, { convId: CONV_B });
    // Corrupt A's manifest by writing garbage that fails the hash chain.
    writeFileSync(store.pathFor(CONV_A), '{"this":"is","not":"a valid event"}\n');

    const ctx = createApp({ backend: buildBackend(), store, db });
    const res = await ctx.app.fetch(new Request('http://x/conversations'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListResponse;
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]!.conv_id).toBe(CONV_B);
  });
});
