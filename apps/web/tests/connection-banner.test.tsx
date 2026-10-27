/**
 * Tests for the pure `ConnectionBanner` presentational component (PR #22).
 *
 * Stateless and synchronous → `renderToString` on the bun tier (the
 * HealthBadge treatment). Asserts on `data-state` markers (I-3), never on
 * Tailwind class fragments. Hook-level connection-state plumbing is pinned
 * in tests/dom/use-turn-stream.test.tsx.
 */
import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';

import { ConnectionBanner } from '../src/components/connection-banner.tsx';

const CLOSE = { code: 1006, reason: 'engine died' };

describe('ConnectionBanner', () => {
  test('hidden for idle, connecting, and open', () => {
    expect(renderToString(<ConnectionBanner state={{ status: 'idle' }} />)).toBe('');
    expect(renderToString(<ConnectionBanner state={{ status: 'connecting' }} />)).toBe('');
    expect(renderToString(<ConnectionBanner state={{ status: 'open' }} />)).toBe('');
  });

  test('reconnecting variant: visible with data-state + reconnecting copy', () => {
    const html = renderToString(
      <ConnectionBanner state={{ status: 'reconnecting', lastClose: CLOSE }} />,
    );
    expect(html).toContain('data-test="connection-banner"');
    expect(html).toContain('data-state="reconnecting"');
    expect(html).toContain('reconnecting');
  });

  test('closed variant: visible with data-state + disconnected copy', () => {
    const html = renderToString(
      <ConnectionBanner state={{ status: 'closed', lastClose: CLOSE }} />,
    );
    expect(html).toContain('data-test="connection-banner"');
    expect(html).toContain('data-state="closed"');
    expect(html).toContain('Disconnected');
  });
});
