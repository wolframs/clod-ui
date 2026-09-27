/**
 * `relativeTime` — pure helper turning a unix-millisecond timestamp into
 * a human-readable relative string.
 *
 * Buckets:
 *   - `<60s` → "just now"
 *   - `<60m` → "<n>m ago"
 *   - `<24h` → "<n>h ago"
 *   - `<7d`  → "<n>d ago"
 *   - `>=7d` → e.g. "Apr 27" (no year), or "Apr 27, 2025" if year != now
 *
 * Frozen at call time: `now` is a parameter so tests can pass a fixed
 * reference and assert deterministic output. The default of `Date.now()`
 * keeps callers simple.
 *
 * TODO(time-locale): replace with `Intl.RelativeTimeFormat` once we
 * have a locale layer. English-only is acceptable for v1.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export function relativeTime(ts: number, now: number = Date.now()): string {
  const delta = now - ts;
  if (delta < MINUTE) return 'just now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  if (delta < WEEK) return `${Math.floor(delta / DAY)}d ago`;
  // Absolute date for older entries.
  const d = new Date(ts);
  const month = MONTH_NAMES[d.getMonth()] ?? '?';
  const day = d.getDate();
  const year = d.getFullYear();
  const nowYear = new Date(now).getFullYear();
  if (year === nowYear) return `${month} ${day}`;
  return `${month} ${day}, ${year}`;
}
