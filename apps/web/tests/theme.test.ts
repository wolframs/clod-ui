/**
 * Pure-module tests for `lib/theme.ts` (PR #26) — the vocabulary as data.
 */
import { describe, expect, test } from 'bun:test';

import { nextThemePreference, parseThemePreference, resolveTheme } from '../src/lib/theme.ts';

describe('parseThemePreference', () => {
  test('valid values pass through', () => {
    expect(parseThemePreference('system')).toBe('system');
    expect(parseThemePreference('light')).toBe('light');
    expect(parseThemePreference('dark')).toBe('dark');
  });

  test('unknown and absent fall back to system', () => {
    expect(parseThemePreference(null)).toBe('system');
    expect(parseThemePreference('')).toBe('system');
    expect(parseThemePreference('blue')).toBe('system');
  });
});

describe('resolveTheme', () => {
  test('system defers to prefers-color-scheme', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  test('a manual choice wins regardless of the system', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});

describe('nextThemePreference', () => {
  test('cycles system → light → dark → system', () => {
    expect(nextThemePreference('system')).toBe('light');
    expect(nextThemePreference('light')).toBe('dark');
    expect(nextThemePreference('dark')).toBe('system');
  });
});
