/**
 * Tests for the pure `Sidebar` component. `renderToString` is enough
 * for all five render variants — the component is stateless and
 * synchronous (no effects, no async transitions). We assert on
 * `data-state` markers and visible content, never on Tailwind classes.
 *
 * Click-handler dispatch is covered by the Vitest+RTL DOM tests; this
 * file is only concerned with static render output.
 */
import { ClientError } from '@clod-ui/contracts/client';
import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';

import { Sidebar } from '../src/components/sidebar.tsx';

// Frozen reference time so `relativeTime` output is deterministic.
const NOW = Date.UTC(2026, 3, 27, 12, 0, 0);

describe('Sidebar', () => {
  test('loading variant: data-state="loading" + skeleton + aria-busy', () => {
    const html = renderToString(
      <Sidebar state={{ status: 'loading' }} onSelect={() => undefined} now={NOW} />,
    );
    expect(html).toContain('data-state="loading"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Conversations');
  });

  test('empty variant: data-state="empty" + helpful copy', () => {
    const html = renderToString(
      <Sidebar state={{ status: 'ok', conversations: [] }} onSelect={() => undefined} now={NOW} />,
    );
    expect(html).toContain('data-state="empty"');
    expect(html).toContain('No conversations yet');
  });

  test('list variant: one row per conversation, titles + relative time visible', () => {
    const conversations = [
      {
        conv_id: 'conv-a',
        title: 'Refactor the manifest fold',
        created_at: NOW - 5 * 60_000,
        updated_at: NOW - 5 * 60_000, // 5m ago
      },
      {
        conv_id: 'conv-b',
        // No title — should render the italic 'untitled' placeholder.
        created_at: NOW - 2 * 60 * 60_000,
        updated_at: NOW - 2 * 60 * 60_000, // 2h ago
      },
    ];
    const html = renderToString(
      <Sidebar state={{ status: 'ok', conversations }} onSelect={() => undefined} now={NOW} />,
    );
    expect(html).toContain('data-state="list"');
    expect(html).toContain('Refactor the manifest fold');
    expect(html).toContain('5m ago');
    expect(html).toContain('untitled');
    expect(html).toContain('2h ago');
    // Both rows render.
    expect(html).toContain('data-conv-id="conv-a"');
    expect(html).toContain('data-conv-id="conv-b"');
  });

  test('selected row carries data-selected="true"', () => {
    const conversations = [
      { conv_id: 'conv-a', created_at: NOW, updated_at: NOW },
      { conv_id: 'conv-b', created_at: NOW, updated_at: NOW },
    ];
    const html = renderToString(
      <Sidebar
        state={{ status: 'ok', conversations }}
        selectedId="conv-b"
        onSelect={() => undefined}
        now={NOW}
      />,
    );
    // The `b` row is selected, the `a` row is not.
    expect(html).toMatch(/data-conv-id="conv-b"[^>]*data-selected="true"/);
    expect(html).toMatch(/data-conv-id="conv-a"[^>]*data-selected="false"/);
  });

  test('error variant: data-state="error" + message + role=alert', () => {
    const err = new ClientError({
      kind: 'transport',
      message: 'fetch failed: ECONNREFUSED',
      path: '/conversations',
    });
    const html = renderToString(
      <Sidebar state={{ status: 'error', error: err }} onSelect={() => undefined} now={NOW} />,
    );
    expect(html).toContain('data-state="error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('fetch failed: ECONNREFUSED');
    expect(html).toContain('Couldn&#x27;t load conversations');
  });

  test('not_configured variant: data-state="not_configured" + mentions --persist', () => {
    const html = renderToString(
      <Sidebar state={{ status: 'not_configured' }} onSelect={() => undefined} now={NOW} />,
    );
    expect(html).toContain('data-state="not_configured"');
    expect(html).toContain('--persist');
    expect(html).toContain('Persistence is off');
  });

  test('renders New button when onNew is supplied', () => {
    const html = renderToString(
      <Sidebar
        state={{ status: 'ok', conversations: [] }}
        onSelect={() => undefined}
        onNew={() => undefined}
        now={NOW}
      />,
    );
    expect(html).toContain('data-test="sidebar-new"');
    expect(html).toContain('New');
  });

  test('omits New button when onNew is not supplied', () => {
    const html = renderToString(
      <Sidebar state={{ status: 'ok', conversations: [] }} onSelect={() => undefined} now={NOW} />,
    );
    expect(html).not.toContain('data-test="sidebar-new"');
  });
});
