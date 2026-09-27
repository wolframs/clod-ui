/**
 * T1.10 — Manifest fold and append-only guarantee.
 *
 * Contract: the manifest is an append-only log of `ManifestEvent`s. Folding
 * events in order yields a deterministic state; writes never rewrite or
 * truncate earlier entries; a truncated manifest file is detected and the
 * engine refuses to open it with a typed error.
 *
 * Implementation: PR #6 (plans/landed/2026-04-23-clod-ui-pr6-sqlite-manifest-v1.md §1).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ManifestCorruptError, ManifestStore } from '@clod-ui/manifest';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

describe('T1.10 manifest fold and append-only', () => {
  let root: string;
  let store: ManifestStore;
  const convId = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'clod-ui-t110-'));
    let now = 1_700_000_000_000;
    store = new ManifestStore(root, { now: () => now++ });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('folding a known event sequence produces expected state', async () => {
    await store.appendEvent(convId, { kind: 'conversation.created', title: 'first' });
    await store.appendEvent(convId, { kind: 'session.captured', session_id: 'sess-A' });
    await store.appendEvent(convId, {
      kind: 'settings.applied',
      model: 'claude-3-7-sonnet',
      thinking_effort: 'think',
      allowed_tools: ['Read', 'Bash'],
    });
    await store.appendEvent(convId, {
      kind: 'model.changed',
      from: 'claude-3-7-sonnet',
      to: 'claude-opus',
    });
    await store.appendEvent(convId, {
      kind: 'attachment.added',
      attachment_id: 'a1',
      relative_path: 'cwd/notes.md',
      content_hash: 'sha256:deadbeef',
      bytes: 42,
    });
    await store.appendEvent(convId, { kind: 'skills.changed', enabled: ['mock-calculator'] });

    const events = await store.readAll(convId);
    expect(events.length).toBe(6);
    const state = store.fold(events);

    expect(state.title).toBe('first');
    expect(state.claude_session_id).toBe('sess-A');
    // model.changed wins over the earlier settings.applied
    expect(state.model).toBe('claude-opus');
    expect(state.thinking_effort).toBe('think');
    expect(state.allowed_tools).toEqual(['Read', 'Bash']);
    expect(state.attachments).toHaveLength(1);
    expect(state.attachments[0]).toMatchObject({
      id: 'a1',
      relative_path: 'cwd/notes.md',
      content_hash: 'sha256:deadbeef',
      bytes: 42,
    });
    expect(state.enabled_skills).toEqual(['mock-calculator']);
    expect(state.created_at).toBe(1_700_000_000_000);
  });

  test('writes only append; earlier bytes are immutable', async () => {
    const path = store.pathFor(convId);
    const snapshots: Buffer[] = [];

    await store.appendEvent(convId, { kind: 'conversation.created' });
    snapshots.push(readFileSync(path));
    await store.appendEvent(convId, { kind: 'session.captured', session_id: 's1' });
    snapshots.push(readFileSync(path));
    await store.appendEvent(convId, { kind: 'model.changed', to: 'claude-opus' });
    snapshots.push(readFileSync(path));
    await store.appendEvent(convId, { kind: 'skills.changed', enabled: ['x'] });
    snapshots.push(readFileSync(path));

    // Each snapshot must be a strict byte-prefix of the next.
    for (let i = 0; i < snapshots.length - 1; i++) {
      const prev = snapshots[i]!;
      const next = snapshots[i + 1]!;
      expect(next.length).toBeGreaterThan(prev.length);
      expect(next.subarray(0, prev.length).equals(prev)).toBe(true);
    }
  });

  test('truncated manifest yields ManifestCorruptError on open', async () => {
    await store.appendEvent(convId, { kind: 'conversation.created' });
    await store.appendEvent(convId, { kind: 'session.captured', session_id: 's1' });
    await store.appendEvent(convId, { kind: 'model.changed', to: 'claude-opus' });

    const path = store.pathFor(convId);
    const full = readFileSync(path);
    // Cut the file in the middle of the second line — past line 0, mid-line 1.
    const firstNewline = full.indexOf(0x0a);
    expect(firstNewline).toBeGreaterThan(0);
    const cutAt = firstNewline + 10; // mid second line
    store.truncateFor(convId, cutAt);

    let caught: unknown;
    try {
      await store.readAll(convId);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ManifestCorruptError);
    const corrupt = caught as ManifestCorruptError;
    expect(corrupt.line).toBe(1);
    expect(corrupt.reason).toBe('truncated');
  });

  test('hash chain detects in-place tampering of an earlier event', async () => {
    await store.appendEvent(convId, { kind: 'conversation.created', title: 'orig' });
    await store.appendEvent(convId, { kind: 'session.captured', session_id: 's1' });

    const path = store.pathFor(convId);
    const text = readFileSync(path, 'utf8');
    // Rewrite the first line's title without touching its hash_self —
    // exactly the corruption the chain is designed to catch.
    const tampered = text.replace('"orig"', '"hax"');
    expect(tampered).not.toBe(text);
    await Bun.write(path, tampered);

    let caught: unknown;
    try {
      await store.readAll(convId);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ManifestCorruptError);
    expect((caught as ManifestCorruptError).reason).toBe('hash');
  });
});
