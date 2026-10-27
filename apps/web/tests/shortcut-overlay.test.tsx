/**
 * Variant tests for `<ShortcutOverlay />` (PR #27) — marker assertions
 * (I-3). Rows render from KEYMAP, so the count is pinned to the data.
 */
import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';

import { ShortcutOverlay } from '../src/components/shortcut-overlay.tsx';
import { KEYMAP } from '../src/lib/keymap.ts';

const noop = (): void => {};

describe('ShortcutOverlay', () => {
  test('closed renders nothing', () => {
    const html = renderToString(<ShortcutOverlay open={false} onClose={noop} />);
    expect(html).toBe('');
  });

  test('open renders one row per KEYMAP binding', () => {
    const html = renderToString(<ShortcutOverlay open onClose={noop} />);
    expect(html).toContain('data-test="shortcut-overlay"');
    expect(html).toContain('data-state="open"');
    const rows = html.match(/data-test="shortcut-overlay-row"/g) ?? [];
    expect(rows.length).toBe(KEYMAP.length);
    for (const b of KEYMAP) {
      expect(html).toContain(`data-action="${b.action}"`);
      expect(html).toContain(b.description);
    }
  });

  test('Escape is labelled Esc in the kbd column', () => {
    const html = renderToString(<ShortcutOverlay open onClose={noop} />);
    expect(html).toContain('>Esc</kbd>');
  });
});
