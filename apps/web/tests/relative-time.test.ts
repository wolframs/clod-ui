/**
 * Tests for the pure `relativeTime` helper. Pure function, frozen `now`,
 * deterministic across runs.
 */
import { describe, expect, test } from 'bun:test';

import { relativeTime } from '../src/lib/relative-time.ts';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Anchor: Apr 27 2026 12:00:00 UTC. Tests pass `now` so the output is
// independent of when the suite runs.
const NOW = Date.UTC(2026, 3, 27, 12, 0, 0);

describe('relativeTime', () => {
  test('< 60s → "just now"', () => {
    expect(relativeTime(NOW - 0, NOW)).toBe('just now');
    expect(relativeTime(NOW - 30 * SECOND, NOW)).toBe('just now');
    expect(relativeTime(NOW - 59 * SECOND, NOW)).toBe('just now');
  });

  test('< 60m → "<n>m ago"', () => {
    expect(relativeTime(NOW - 1 * MINUTE, NOW)).toBe('1m ago');
    expect(relativeTime(NOW - 5 * MINUTE, NOW)).toBe('5m ago');
    expect(relativeTime(NOW - 59 * MINUTE, NOW)).toBe('59m ago');
  });

  test('< 24h → "<n>h ago"', () => {
    expect(relativeTime(NOW - 1 * HOUR, NOW)).toBe('1h ago');
    expect(relativeTime(NOW - 12 * HOUR, NOW)).toBe('12h ago');
    expect(relativeTime(NOW - 23 * HOUR, NOW)).toBe('23h ago');
  });

  test('< 7d → "<n>d ago"', () => {
    expect(relativeTime(NOW - 1 * DAY, NOW)).toBe('1d ago');
    expect(relativeTime(NOW - 3 * DAY, NOW)).toBe('3d ago');
    expect(relativeTime(NOW - 6 * DAY, NOW)).toBe('6d ago');
  });

  test('>= 7d in the same year → absolute date without year', () => {
    // 14 days before NOW (Apr 27 2026) lands on Apr 13 2026.
    expect(relativeTime(NOW - 14 * DAY, NOW)).toBe('Apr 13');
  });

  test('different year → absolute date with year', () => {
    // 1 year before — different year branch.
    expect(relativeTime(Date.UTC(2024, 5, 15, 10, 0, 0), NOW)).toBe('Jun 15, 2024');
  });

  test('boundary: exactly 60s → minutes branch', () => {
    expect(relativeTime(NOW - 60 * SECOND, NOW)).toBe('1m ago');
  });

  test('boundary: exactly 60m → hours branch', () => {
    expect(relativeTime(NOW - 60 * MINUTE, NOW)).toBe('1h ago');
  });
});
