/**
 * Tests for the pure `HealthBadge` presentational component.
 *
 * Three render variants — loading / ok / error. `renderToString` is enough
 * here because the component is stateless and synchronous; no effects, no
 * async transitions. We assert on the `data-state` marker rather than on
 * Tailwind class fragments (those are styling concerns, not contract).
 */
import { ClientError } from '@clod-ui/contracts/client';
import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';

import { HealthBadge } from '../src/components/health-badge.tsx';

describe('HealthBadge', () => {
  test('loading variant: renders muted "Connecting…" text and data-state', () => {
    const html = renderToString(<HealthBadge state={{ status: 'loading' }} />);
    expect(html).toContain('data-state="loading"');
    expect(html).toContain('Connecting');
  });

  test('ok variant: renders "Engine OK" + version when present', () => {
    const html = renderToString(
      <HealthBadge
        state={{
          status: 'ok',
          health: {
            cli: 'ok',
            version: '2.1.0',
            engine_version: '0.0.0',
            started_at: 1,
          },
        }}
      />,
    );
    expect(html).toContain('data-state="ok"');
    expect(html).toContain('Engine OK');
    expect(html).toContain('v2.1.0');
  });

  test('ok variant: omits version fragment when health.version is absent', () => {
    const html = renderToString(
      <HealthBadge
        state={{
          status: 'ok',
          health: { cli: 'ok', engine_version: '0.0.0', started_at: 1 },
        }}
      />,
    );
    expect(html).toContain('Engine OK');
    expect(html).not.toContain('· v');
  });

  test('error variant: renders the ClientError message + title attribute', () => {
    const err = new ClientError({
      kind: 'transport',
      message: 'fetch failed: ECONNREFUSED',
      path: '/health',
    });
    const html = renderToString(<HealthBadge state={{ status: 'error', error: err }} />);
    expect(html).toContain('data-state="error"');
    expect(html).toContain('fetch failed: ECONNREFUSED');
    // The title attribute carries the full message verbatim.
    expect(html).toContain('title="fetch failed: ECONNREFUSED"');
  });

  test('error variant: truncates messages over the 80-char cap with an ellipsis', () => {
    const longMessage = 'x'.repeat(200);
    const err = new ClientError({ kind: 'transport', message: longMessage });
    const html = renderToString(<HealthBadge state={{ status: 'error', error: err }} />);
    // The visible body is truncated…
    expect(html).toContain('…');
    // Strip the title attribute (which carries the full message) and class
    // strings before scanning the visible body for the run-length.
    const body = html.replace(/title="[^"]*"/g, '').replace(/class="[^"]*"/g, '');
    expect(body).not.toContain('x'.repeat(81));
    // …but the title attribute carries the full message verbatim.
    expect(html).toContain(`title="${longMessage}"`);
  });
});
