/**
 * Pure tests for `lib/keymap.ts` (PR #27) — the keymap as data.
 */
import { describe, expect, test } from 'bun:test';

import { KEYMAP, matchBinding } from '../src/lib/keymap.ts';

const FREE = { inEditable: false, isComposing: false, hasModifier: false };

describe('KEYMAP data invariants', () => {
  test('keys are unique', () => {
    const keys = KEYMAP.map((b) => b.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('every binding has a description for the overlay', () => {
    for (const b of KEYMAP) expect(b.description.length).toBeGreaterThan(0);
  });
});

describe('matchBinding', () => {
  test('every binding matches under a permissive context', () => {
    for (const b of KEYMAP) expect(matchBinding(b.key, FREE)).toBe(b);
  });

  test('unknown keys match nothing', () => {
    expect(matchBinding('x', FREE)).toBeUndefined();
    expect(matchBinding('Enter', FREE)).toBeUndefined();
  });

  test('IME composition blocks everything', () => {
    expect(matchBinding('n', { ...FREE, isComposing: true })).toBeUndefined();
    expect(matchBinding('Escape', { ...FREE, isComposing: true })).toBeUndefined();
  });

  test('ctrl/meta/alt block everything (browser shortcuts win)', () => {
    expect(matchBinding('n', { ...FREE, hasModifier: true })).toBeUndefined();
    expect(matchBinding('Escape', { ...FREE, hasModifier: true })).toBeUndefined();
  });

  test('editable focus blocks plain-letter bindings but not Escape', () => {
    const editable = { ...FREE, inEditable: true };
    expect(matchBinding('n', editable)).toBeUndefined();
    expect(matchBinding('/', editable)).toBeUndefined();
    expect(matchBinding('j', editable)).toBeUndefined();
    expect(matchBinding('?', editable)).toBeUndefined();
    expect(matchBinding('Escape', editable)?.action).toBe('escape');
  });

  test('Escape never claims preventDefault; the rest do', () => {
    for (const b of KEYMAP) expect(b.preventDefault).toBe(b.key !== 'Escape');
  });
});
