import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { canonicalJson, ManifestCorruptError, ManifestStore } from '../src/index.ts';

function mkRoot(): string {
  return mkdtempSync(join(tmpdir(), 'clod-ui-manifest-'));
}

const CONV_A = '11111111-1111-4111-8111-111111111111';

describe('canonicalJson', () => {
  test('sorts keys deterministically across nesting', () => {
    const a = canonicalJson({ b: 1, a: { d: 4, c: 3 }, e: [3, 2, 1] });
    const b = canonicalJson({ a: { c: 3, d: 4 }, e: [3, 2, 1], b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":3,"d":4},"b":1,"e":[3,2,1]}');
  });

  test('handles primitives + null', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson('s')).toBe('"s"');
  });
});

describe('ManifestStore.appendEvent + readAll happy path', () => {
  test('first event has seq:0, no hash_prev, valid hash_self', async () => {
    const root = mkRoot();
    try {
      const store = new ManifestStore(root, { now: () => 1000 });
      const ev = await store.appendEvent(CONV_A, { kind: 'conversation.created', title: 'first' });
      expect(ev.seq).toBe(0);
      expect(ev.ts).toBe(1000);
      expect(ev.hash_prev).toBeUndefined();
      expect(ev.hash_self).toMatch(/^[0-9a-f]{64}$/);

      const all = await store.readAll(CONV_A);
      expect(all).toHaveLength(1);
      expect(all[0]).toEqual(ev);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('subsequent events chain via hash_prev', async () => {
    const root = mkRoot();
    try {
      const store = new ManifestStore(root, { now: () => 1000 });
      const e0 = await store.appendEvent(CONV_A, { kind: 'conversation.created' });
      const e1 = await store.appendEvent(CONV_A, {
        kind: 'session.captured',
        session_id: 'sess-abc',
      });
      const e2 = await store.appendEvent(CONV_A, { kind: 'model.changed', to: 'sonnet-4.5' });

      expect(e1.seq).toBe(1);
      expect(e1.hash_prev).toBe(e0.hash_self);
      expect(e2.seq).toBe(2);
      expect(e2.hash_prev).toBe(e1.hash_self);

      const all = await store.readAll(CONV_A);
      expect(all).toHaveLength(3);
      expect(all.map((e) => e.kind)).toEqual([
        'conversation.created',
        'session.captured',
        'model.changed',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('readAll on missing manifest returns []', async () => {
    const root = mkRoot();
    try {
      const store = new ManifestStore(root);
      const all = await store.readAll(CONV_A);
      expect(all).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('appendEvent honors caller-supplied ts when provided', async () => {
    const root = mkRoot();
    try {
      const store = new ManifestStore(root, { now: () => 9999 });
      const ev = await store.appendEvent(CONV_A, {
        kind: 'conversation.created',
        ts: 12345,
      });
      expect(ev.ts).toBe(12345);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ManifestStore append-only invariant', () => {
  test('each snapshot is a strict byte-prefix of the next', async () => {
    const root = mkRoot();
    try {
      const store = new ManifestStore(root, { now: () => 1000 });
      const path = store.pathFor(CONV_A);

      const snapshots: Buffer[] = [];

      await store.appendEvent(CONV_A, { kind: 'conversation.created' });
      snapshots.push(readFileSync(path));

      await store.appendEvent(CONV_A, { kind: 'session.captured', session_id: 'a' });
      snapshots.push(readFileSync(path));

      await store.appendEvent(CONV_A, { kind: 'model.changed', to: 'opus-4' });
      snapshots.push(readFileSync(path));

      for (let i = 1; i < snapshots.length; i++) {
        const prev = snapshots[i - 1]!;
        const curr = snapshots[i]!;
        expect(curr.length).toBeGreaterThan(prev.length);
        expect(curr.subarray(0, prev.length).equals(prev)).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('directory and file are created on first append (no upfront mkdir needed)', async () => {
    const root = mkRoot();
    try {
      const store = new ManifestStore(root);
      expect(existsSync(store.pathFor(CONV_A))).toBe(false);
      await store.appendEvent(CONV_A, { kind: 'conversation.created' });
      expect(existsSync(store.pathFor(CONV_A))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ManifestStore corruption detection', () => {
  test('truncated last line → ManifestCorruptError(reason:truncated)', async () => {
    const root = mkRoot();
    try {
      const store = new ManifestStore(root);
      await store.appendEvent(CONV_A, { kind: 'conversation.created' });
      await store.appendEvent(CONV_A, { kind: 'session.captured', session_id: 'abc' });
      await store.appendEvent(CONV_A, { kind: 'model.changed', to: 'sonnet' });

      const path = store.pathFor(CONV_A);
      const before = readFileSync(path).length;
      // Drop trailing 6 bytes — well into the last line, before its closing }.
      store.truncateFor(CONV_A, before - 6);

      let caught: unknown;
      try {
        await store.readAll(CONV_A);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ManifestCorruptError);
      const e = caught as ManifestCorruptError;
      expect(e.reason).toBe('truncated');
      expect(e.line).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('hash chain tampered → ManifestCorruptError(reason:hash)', async () => {
    const root = mkRoot();
    try {
      const store = new ManifestStore(root);
      await store.appendEvent(CONV_A, { kind: 'conversation.created' });
      await store.appendEvent(CONV_A, { kind: 'session.captured', session_id: 'abc' });

      const path = store.pathFor(CONV_A);
      // Surgically rewrite the second line's session_id without recomputing hash.
      const raw = readFileSync(path, 'utf8');
      const tampered = raw.replace('"session_id":"abc"', '"session_id":"def"');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:fs').writeFileSync(path, tampered);

      let caught: unknown;
      try {
        await store.readAll(CONV_A);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ManifestCorruptError);
      expect((caught as ManifestCorruptError).reason).toBe('hash');
      expect((caught as ManifestCorruptError).line).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('sequence skip → ManifestCorruptError(reason:seq)', async () => {
    const root = mkRoot();
    try {
      const store = new ManifestStore(root);
      // Write three real events, then surgically rewrite the third line's seq
      // from 2 to 3. The seq check fires before the hash check, so the reader
      // raises seq (at line 2) without first failing on the (now-stale) hash.
      await store.appendEvent(CONV_A, { kind: 'conversation.created' });
      await store.appendEvent(CONV_A, { kind: 'session.captured', session_id: 'a' });
      await store.appendEvent(CONV_A, { kind: 'model.changed', to: 'opus' });

      const path = store.pathFor(CONV_A);
      const raw = readFileSync(path, 'utf8');
      const lines = raw.split('\n');
      // lines[2] is the third event with seq:2.
      lines[2] = lines[2]!.replace('"seq":2', '"seq":3');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:fs').writeFileSync(path, lines.join('\n'));

      let caught: unknown;
      try {
        await store.readAll(CONV_A);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ManifestCorruptError);
      expect((caught as ManifestCorruptError).reason).toBe('seq');
      expect((caught as ManifestCorruptError).line).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('parse failure on a complete line → ManifestCorruptError(reason:parse)', async () => {
    const root = mkRoot();
    try {
      const store = new ManifestStore(root);
      const path = store.pathFor(CONV_A);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('node:fs') as typeof import('node:fs');
      fs.mkdirSync(join(root, 'conversations', CONV_A), { recursive: true });
      fs.writeFileSync(path, '{not json at all}\n');

      let caught: unknown;
      try {
        await store.readAll(CONV_A);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ManifestCorruptError);
      expect((caught as ManifestCorruptError).reason).toBe('parse');
      expect((caught as ManifestCorruptError).line).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ManifestStore.fold', () => {
  test('folds known event kinds into ConversationState', async () => {
    const root = mkRoot();
    try {
      const store = new ManifestStore(root, { now: () => 1000 });
      await store.appendEvent(CONV_A, { kind: 'conversation.created', title: 'hello' });
      await store.appendEvent(CONV_A, { kind: 'session.captured', session_id: 'sess-abc' });
      await store.appendEvent(CONV_A, { kind: 'model.changed', to: 'opus-4' });
      await store.appendEvent(CONV_A, {
        kind: 'system_prompt.changed',
        mode: 'append',
        text: 'be concise',
      });
      await store.appendEvent(CONV_A, {
        kind: 'tool_config.changed',
        allowed_tools: ['Bash', 'Read'],
      });
      await store.appendEvent(CONV_A, { kind: 'skills.changed', enabled: ['skill-a'] });
      await store.appendEvent(CONV_A, {
        kind: 'attachment.added',
        attachment_id: 'att-1',
        relative_path: 'attachments/foo.png',
        content_hash: 'sha256:abc',
        bytes: 1024,
      });
      await store.appendEvent(CONV_A, {
        kind: 'artifact.observed',
        relative_path: 'cwd/output.txt',
        content_hash: 'sha256:def',
        bytes: 512,
      });

      const all = await store.readAll(CONV_A);
      const state = store.fold(all);

      expect(state.title).toBe('hello');
      expect(state.created_at).toBe(1000);
      expect(state.claude_session_id).toBe('sess-abc');
      expect(state.model).toBe('opus-4');
      expect(state.system_prompt).toEqual({ mode: 'append', text: 'be concise' });
      expect(state.allowed_tools).toEqual(['Bash', 'Read']);
      expect(state.enabled_skills).toEqual(['skill-a']);
      expect(state.attachments).toHaveLength(1);
      expect(state.attachments[0]?.id).toBe('att-1');
      expect(state.artifacts).toHaveLength(1);
      expect(state.artifacts[0]?.relative_path).toBe('cwd/output.txt');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fold of [] is the empty state with empty arrays', () => {
    const store = new ManifestStore(mkRoot());
    const state = store.fold([]);
    expect(state.attachments).toEqual([]);
    expect(state.artifacts).toEqual([]);
    expect(state.enabled_skills).toEqual([]);
    expect(state.claude_session_id).toBeUndefined();
  });

  test('settings.applied populates whatever fields it carries', async () => {
    const root = mkRoot();
    try {
      const store = new ManifestStore(root);
      await store.appendEvent(CONV_A, {
        kind: 'settings.applied',
        model: 'sonnet-4.5',
        thinking_effort: 'think_hard',
        allowed_tools: ['Read'],
      });
      const state = store.fold(await store.readAll(CONV_A));
      expect(state.model).toBe('sonnet-4.5');
      expect(state.thinking_effort).toBe('think_hard');
      expect(state.allowed_tools).toEqual(['Read']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('conversation.titled sets state.title', async () => {
    const root = mkRoot();
    try {
      const store = new ManifestStore(root);
      await store.appendEvent(CONV_A, { kind: 'conversation.created' });
      await store.appendEvent(CONV_A, {
        kind: 'conversation.titled',
        title: 'Refactor the login form',
      });
      const state = store.fold(await store.readAll(CONV_A));
      expect(state.title).toBe('Refactor the login form');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('conversation.titled overwrites a prior conversation.created.title at the fold layer', async () => {
    // The fold itself is last-write-wins. The engine enforces "first auto-title
    // wins" at a higher level by *not appending* when state.title is set; this
    // test pins the underlying fold contract so future engine-side guards can't
    // silently regress against it.
    const root = mkRoot();
    try {
      const store = new ManifestStore(root);
      await store.appendEvent(CONV_A, { kind: 'conversation.created', title: 'original' });
      await store.appendEvent(CONV_A, { kind: 'conversation.titled', title: 'updated' });
      const state = store.fold(await store.readAll(CONV_A));
      expect(state.title).toBe('updated');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
