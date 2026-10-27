/**
 * Variant tests for `<SettingsPanel />` (PR #30). Initial-render variants
 * via `renderToString`; the edit → diff → confirm flow is dom-tested in
 * tests/dom/settings-panel.test.tsx. Marker assertions only (I-3).
 */
import type { ClaudeSettings } from '@clod-ui/contracts';
import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';

import { SettingsPanel } from '../src/components/settings-panel.tsx';
import type { SettingsState } from '../src/lib/use-settings.ts';

const noop = (): void => {};

function html(state: SettingsState, open = true): string {
  return renderToString(<SettingsPanel open={open} state={state} onClose={noop} onSave={noop} />);
}

const DOC: ClaudeSettings = {
  theme: 'dark',
  allowedTools: ['Read'],
  unknown: { customKey: 1 },
};

describe('SettingsPanel', () => {
  test('closed renders nothing', () => {
    expect(html({ status: 'ok', settings: DOC, saving: false }, false)).toBe('');
  });

  test('loading variant', () => {
    const out = html({ status: 'loading' });
    expect(out).toContain('data-test="settings-panel"');
    expect(out).toContain('data-state="loading"');
  });

  test('not_configured variant renders the --persist affordance', () => {
    const out = html({ status: 'not_configured' });
    expect(out).toContain('data-state="not_configured"');
    expect(out).toContain('--persist');
  });

  test('error variant carries the message', () => {
    const out = html({
      status: 'error',
      error: { message: 'boom' } as never,
    });
    expect(out).toContain('data-state="error"');
    expect(out).toContain('boom');
  });

  test('ok variant: schema-aware fields populated, unknown read-only block present', () => {
    const out = html({ status: 'ok', settings: DOC, saving: false });
    expect(out).toContain('data-state="ok"');
    expect(out).toContain('data-test="settings-theme"');
    expect(out).toContain('data-test="settings-model"');
    expect(out).toContain('data-test="settings-allowed"');
    expect(out).toContain('data-test="settings-disallowed"');
    expect(out).toContain('data-test="settings-unknown"');
    expect(out).toContain('customKey');
    // No edits yet → Save disabled.
    expect(out).toMatch(/data-test="settings-save"[^>]*disabled/);
  });

  test('ok variant without unknown keys omits the read-only block', () => {
    const out = html({ status: 'ok', settings: { theme: 'light' }, saving: false });
    expect(out).not.toContain('settings-unknown');
  });
});
