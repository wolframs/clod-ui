import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  FileProfileSource,
  IMPLICIT_PROFILE,
  IMPLICIT_REGISTRY,
  parseProfileRegistry,
  resolveTurnProfile,
  type ProfileRegistry,
} from '../src/profiles.ts';

const GOOD = {
  default: 'seat',
  profiles: [
    { id: 'seat', label: 'Seat', binary: '/seat/clod_seat.sh', cwd: '/seat' },
    {
      id: 'lab',
      label: 'lab',
      binary: '/mp/clod_claude.py',
      cwd: '/mp',
      require_browser: true,
    },
    { id: 'plain', label: 'plain Claude', binary: 'claude', cwd: null },
  ],
};

describe('parseProfileRegistry', () => {
  test('the deployed shape parses; omitted require_browser is false', () => {
    const r = parseProfileRegistry(GOOD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.default).toBe('seat');
    expect(r.value.profiles.map((p) => [p.id, p.cwd, p.require_browser, p.implicit])).toEqual([
      ['seat', '/seat', false, false],
      ['lab', '/mp', true, false],
      ['plain', null, false, false],
    ]);
  });

  test('omitted cwd means the conversation’s own directory (null)', () => {
    const r = parseProfileRegistry({
      default: 'a',
      profiles: [{ id: 'a', label: 'A', binary: 'claude' }],
    });
    expect(r.ok && r.value.profiles[0]?.cwd).toBeNull();
  });

  const entry = { id: 'a', label: 'A', binary: 'claude', cwd: null };
  const bad: Array<[string, unknown, string]> = [
    ['not an object', [], 'object'],
    ['unknown top key', { default: 'a', profiles: [entry], extra: 1 }, 'unknown key "extra"'],
    ['empty list', { default: 'a', profiles: [] }, 'non-empty'],
    ['bad id', { default: 'A', profiles: [{ ...entry, id: 'A' }] }, 'profiles[0].id'],
    ['long id', { default: 'a', profiles: [{ ...entry, id: 'x'.repeat(33) }] }, '.id'],
    ['duplicate id', { default: 'a', profiles: [entry, entry] }, 'not unique'],
    ['empty label', { default: 'a', profiles: [{ ...entry, label: ' ' }] }, '.label'],
    ['missing binary', { default: 'a', profiles: [{ id: 'a', label: 'A' }] }, '.binary'],
    ['relative cwd', { default: 'a', profiles: [{ ...entry, cwd: 'rel' }] }, '.cwd'],
    [
      'misspelt gate',
      { default: 'a', profiles: [{ ...entry, require_browsr: true }] },
      'unknown key "require_browsr"',
    ],
    [
      'non-boolean gate',
      { default: 'a', profiles: [{ ...entry, require_browser: 'yes' }] },
      '.require_browser',
    ],
    ['default names none', { default: 'b', profiles: [entry] }, 'default must name'],
  ];
  for (const [name, raw, fragment] of bad) {
    test(`refuses: ${name}`, () => {
      const r = parseProfileRegistry(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(fragment);
    });
  }
});

describe('FileProfileSource', () => {
  let root: string;
  let path: string;
  let logs: string[];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'clod-ui-profiles-'));
    path = join(root, 'profiles.json');
    logs = [];
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const source = (): FileProfileSource => new FileProfileSource({ path, log: (m) => logs.push(m) });
  // Atomic replace: a new inode, so the change is seen within one mtime tick.
  const write = (body: string): void => {
    writeFileSync(`${path}.tmp`, body);
    renameSync(`${path}.tmp`, path);
  };

  test('no file → the implicit registry, no warning', () => {
    expect(source().current()).toEqual({ registry: IMPLICIT_REGISTRY });
  });

  test('re-reads on change; a malformed file keeps the last good one and says why once', () => {
    const src = source();
    write(JSON.stringify(GOOD));
    expect(src.current().registry.default).toBe('seat');

    write('{ not json');
    const broken = src.current();
    expect(broken.registry.default).toBe('seat');
    expect(broken.warning).toBe(
      'profiles file not taken: not valid JSON; keeping the last good registry',
    );
    src.current();
    expect(logs).toHaveLength(1);

    write(JSON.stringify({ ...GOOD, default: 'plain' }));
    expect(src.current()).toEqual({
      registry: expect.objectContaining({ default: 'plain' }) as ProfileRegistry,
    });
  });

  test('a malformed first file runs on the implicit profile', () => {
    write(JSON.stringify({ default: 'x', profiles: [] }));
    const snap = source().current();
    expect(snap.registry).toBe(IMPLICIT_REGISTRY);
    expect(snap.warning).toContain('using the implicit profile');
  });

  test('a deleted file means no registry again', () => {
    const src = source();
    write(JSON.stringify(GOOD));
    expect(src.current().registry.profiles).toHaveLength(3);
    rmSync(path);
    expect(src.current()).toEqual({ registry: IMPLICIT_REGISTRY });
  });
});

describe('resolveTurnProfile', () => {
  const parsed = parseProfileRegistry(GOOD);
  if (!parsed.ok) throw new Error(parsed.error);
  const registry = parsed.value;
  const base = { registry, hasOrigin: true };

  test('a new conversation takes the body profile, else the default', () => {
    const named = resolveTurnProfile({ ...base, row: undefined, requested: 'plain' });
    expect(named.ok && named.profile.id).toBe('plain');
    const dflt = resolveTurnProfile({ ...base, row: undefined, requested: undefined });
    expect(dflt.ok && dflt.profile.id).toBe('seat');
  });

  test('a NULL row runs on the implicit profile, whatever the registry default', () => {
    const r = resolveTurnProfile({ ...base, row: { profile: null }, requested: undefined });
    expect(r.ok && r.profile).toBe(IMPLICIT_PROFILE);
    const same = resolveTurnProfile({ ...base, row: { profile: null }, requested: 'default' });
    expect(same.ok).toBe(true);
  });

  test('a body profile that differs from the row is a 400', () => {
    const r = resolveTurnProfile({ ...base, row: { profile: 'plain' }, requested: 'lab' });
    expect(r).toMatchObject({ ok: false, status: 400 });
    const nullRow = resolveTurnProfile({ ...base, row: { profile: null }, requested: 'plain' });
    expect(nullRow).toMatchObject({ ok: false, status: 400 });
  });

  test('a profile missing from the registry is a 409 naming it', () => {
    for (const args of [
      { row: { profile: 'gone' }, requested: undefined },
      { row: undefined, requested: 'gone' },
    ]) {
      expect(resolveTurnProfile({ ...base, ...args })).toEqual({
        ok: false,
        status: 409,
        body: { error: { kind: 'profile_unavailable', profile: 'gone' } },
      });
    }
  });

  test('require_browser without an Origin is a 403', () => {
    const r = resolveTurnProfile({
      registry,
      hasOrigin: false,
      row: { profile: 'lab' },
      requested: undefined,
    });
    expect(r).toEqual({ ok: false, status: 403, body: { error: { kind: 'browser_required' } } });
    const other = resolveTurnProfile({
      registry,
      hasOrigin: false,
      row: { profile: 'plain' },
      requested: undefined,
    });
    expect(other.ok).toBe(true);
  });
});
