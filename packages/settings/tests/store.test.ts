import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  bucket,
  flatten,
  SettingsCorruptError,
  SettingsStore,
  SettingsValidationError,
  type ClaudeSettings,
} from '../src/index.ts';

/**
 * Unit tests for `@clod-ui/settings`.
 *
 * Spec: plans/landed/2026-04-23-clod-ui-pr8-settings-roundtrip-v1.md §2.
 */

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clod-ui-settings-'));
  path = join(dir, 'settings.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('bucket / flatten', () => {
  test('bucket: documented keys go top-level, others into unknown', () => {
    const out = bucket({
      theme: 'dark',
      model: 'claude-opus',
      mcpServers: { foo: 'bar' },
      somethingNew: 42,
    });
    expect(out).toEqual({
      theme: 'dark',
      model: 'claude-opus',
      unknown: { mcpServers: { foo: 'bar' }, somethingNew: 42 },
    });
  });

  test('bucket: file with only documented keys has no unknown bucket', () => {
    const out = bucket({ theme: 'light' });
    expect(out).toEqual({ theme: 'light' });
    expect('unknown' in out).toBe(false);
  });

  test('flatten: documented keys appear in source order, then unknown in insertion order', () => {
    const settings: ClaudeSettings = {
      // Source order is theme, model, allowedTools, disallowedTools.
      // We supply keys in a different order to verify flatten reorders.
      disallowedTools: ['ban'],
      theme: 'dark',
      allowedTools: ['ok'],
      unknown: { z_last: 1, a_first: 2 },
    };
    const flat = flatten(settings);
    expect(Object.keys(flat)).toEqual([
      'theme',
      'allowedTools',
      'disallowedTools',
      'z_last',
      'a_first',
    ]);
  });

  test('round-trip via bucket(flatten(...)) preserves shape', () => {
    const settings: ClaudeSettings = {
      theme: 'dark',
      model: 'claude-opus',
      unknown: { custom_field: 42, nested: { a: 1 } },
    };
    const back = bucket(flatten(settings));
    expect(back).toEqual(settings);
  });
});

describe('SettingsStore.read', () => {
  test('missing file returns empty settings', async () => {
    const store = new SettingsStore({ path });
    const out = await store.read();
    expect(out).toEqual({});
  });

  test('empty file returns empty settings', async () => {
    writeFileSync(path, '');
    const store = new SettingsStore({ path });
    const out = await store.read();
    expect(out).toEqual({});
  });

  test('valid file with documented + unknown keys round-trips', async () => {
    const onDisk = {
      theme: 'dark',
      model: 'claude-opus',
      mcpServers: { foo: 'bar' },
    };
    writeFileSync(path, JSON.stringify(onDisk, null, 2));
    const store = new SettingsStore({ path });
    const out = await store.read();
    expect(out).toEqual({
      theme: 'dark',
      model: 'claude-opus',
      unknown: { mcpServers: { foo: 'bar' } },
    });
  });

  test('unparseable JSON throws SettingsCorruptError(parse)', async () => {
    writeFileSync(path, 'not json');
    const store = new SettingsStore({ path });
    await expect(store.read()).rejects.toMatchObject({
      name: 'SettingsCorruptError',
      reason: 'parse',
    });
  });

  test('top-level array throws SettingsCorruptError(parse)', async () => {
    writeFileSync(path, '[]');
    const store = new SettingsStore({ path });
    await expect(store.read()).rejects.toMatchObject({
      name: 'SettingsCorruptError',
      reason: 'parse',
    });
  });

  test('documented key with wrong type throws SettingsCorruptError(schema)', async () => {
    writeFileSync(path, JSON.stringify({ theme: 'periwinkle' }));
    const store = new SettingsStore({ path });
    await expect(store.read()).rejects.toMatchObject({
      name: 'SettingsCorruptError',
      reason: 'schema',
    });
  });

  test('corrupt-read does not touch the on-disk file', async () => {
    const garbage = '###not-json###';
    writeFileSync(path, garbage);
    const store = new SettingsStore({ path });
    await expect(store.read()).rejects.toBeInstanceOf(SettingsCorruptError);
    expect(readFileSync(path, 'utf8')).toBe(garbage);
  });
});

describe('SettingsStore.write', () => {
  test('creates the parent directory if missing', async () => {
    const nestedPath = join(dir, 'nested', 'deep', 'settings.json');
    const store = new SettingsStore({ path: nestedPath });
    await store.write({ theme: 'dark' });
    expect(existsSync(nestedPath)).toBe(true);
  });

  test('write+read round-trip preserves documented + unknown keys', async () => {
    const store = new SettingsStore({ path });
    const input: ClaudeSettings = {
      theme: 'dark',
      model: 'claude-opus',
      allowedTools: ['Bash', 'Read'],
      unknown: { custom_field: 42, another: 'value' },
    };
    await store.write(input);
    const out = await store.read();
    expect(out).toEqual(input);
  });

  test('on-disk layout: documented keys first (source order), then unknown in insertion order', async () => {
    const store = new SettingsStore({ path });
    await store.write({
      // Insertion order chosen to differ from source-declared order.
      disallowedTools: ['ban'],
      theme: 'dark',
      unknown: { zKey: 1, aKey: 2 },
    });
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['theme', 'disallowedTools', 'zKey', 'aKey']);
  });

  test('invalid input throws SettingsValidationError; on-disk file is untouched', async () => {
    writeFileSync(path, JSON.stringify({ theme: 'dark' }));
    const before = readFileSync(path, 'utf8');
    const store = new SettingsStore({ path });
    await expect(
      store.write({ theme: 'periwinkle' as unknown as ClaudeSettings['theme'] }),
    ).rejects.toBeInstanceOf(SettingsValidationError);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  test('orphan temp file from a prior crash does not affect read()', async () => {
    // Simulate a prior crash mid-write: tmp file present, target absent.
    writeFileSync(`${path}.tmp.999.deadbe`, '{"theme":"dark"}');
    const store = new SettingsStore({ path });
    expect(await store.read()).toEqual({});
  });
});

describe('SettingsStore .bak rotation', () => {
  test('three sequential writes leave .bak / .bak.1 / .bak.2 with consecutive contents', async () => {
    const store = new SettingsStore({ path });
    await store.write({ theme: 'system' }); // current = sys
    await store.write({ theme: 'light' }); //  current = light, bak = sys
    await store.write({ theme: 'dark' }); //   current = dark, bak = light, bak.1 = sys
    await store.write({ model: 'opus' }); //   current = opus, bak = dark, bak.1 = light, bak.2 = sys

    const cur = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const bak = JSON.parse(readFileSync(`${path}.bak`, 'utf8')) as Record<string, unknown>;
    const bak1 = JSON.parse(readFileSync(`${path}.bak.1`, 'utf8')) as Record<string, unknown>;
    const bak2 = JSON.parse(readFileSync(`${path}.bak.2`, 'utf8')) as Record<string, unknown>;
    expect(cur).toEqual({ model: 'opus' });
    expect(bak).toEqual({ theme: 'dark' });
    expect(bak1).toEqual({ theme: 'light' });
    expect(bak2).toEqual({ theme: 'system' });
    // Oldest is discarded — no .bak.3.
    expect(existsSync(`${path}.bak.3`)).toBe(false);
  });

  test('rotation is best-effort: after a fresh write, only .bak exists', async () => {
    const store = new SettingsStore({ path });
    await store.write({ theme: 'dark' });
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.bak`)).toBe(false);
    await store.write({ theme: 'light' });
    expect(existsSync(`${path}.bak`)).toBe(true);
    expect(existsSync(`${path}.bak.1`)).toBe(false);
  });
});

describe('SettingsStore.patch', () => {
  test('partial update overwrites only the supplied documented keys', async () => {
    const store = new SettingsStore({ path });
    await store.write({
      theme: 'dark',
      model: 'claude-opus',
      allowedTools: ['Bash'],
      unknown: { custom: 1 },
    });
    const merged = await store.patch({ theme: 'light' });
    expect(merged).toEqual({
      theme: 'light',
      model: 'claude-opus',
      allowedTools: ['Bash'],
      unknown: { custom: 1 },
    });
    const reread = await store.read();
    expect(reread).toEqual(merged);
  });

  test('PUT-PATCH-PUT cycle preserves unknown bucket order across edits', async () => {
    const store = new SettingsStore({ path });
    await store.write({
      theme: 'dark',
      unknown: { z_last: 1, a_first: 2, m_middle: 3 },
    });
    await store.patch({ theme: 'light' });
    const out = await store.read();
    expect(Object.keys(out.unknown ?? {})).toEqual(['z_last', 'a_first', 'm_middle']);
    expect(out.unknown).toEqual({ z_last: 1, a_first: 2, m_middle: 3 });
  });

  test('patch with unknown bucket merges over existing bucket', async () => {
    const store = new SettingsStore({ path });
    await store.write({ unknown: { existing: 1, replaced: 2 } });
    const merged = await store.patch({ unknown: { replaced: 99, brandNew: 3 } });
    expect(merged.unknown).toEqual({ existing: 1, replaced: 99, brandNew: 3 });
  });

  test('patch on missing file initializes from {} and writes the supplied keys', async () => {
    const store = new SettingsStore({ path });
    const merged = await store.patch({ theme: 'dark' });
    expect(merged).toEqual({ theme: 'dark' });
    expect(existsSync(path)).toBe(true);
  });
});
