/**
 * Variant tests for `<TurnControlsBar />` (PR #24). Initial-render
 * variants via `renderToString` on the bun tier; the local "Custom…"
 * entry-mode interaction is pinned in tests/dom/turn-controls-bar.test.tsx.
 * Asserts on `data-test` / `data-selected` markers (I-3).
 */
import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';

import { TurnControlsBar } from '../src/components/turn-controls-bar.tsx';
import { EFFORT_OPTIONS, KNOWN_MODELS } from '../src/lib/turn-controls.ts';

const noop = (): void => {};

describe('TurnControlsBar', () => {
  test('default variant: every known model offered, Default + Custom… present, effort default selected', () => {
    const html = renderToString(<TurnControlsBar value={{}} onChange={noop} />);
    expect(html).toContain('data-test="turn-controls"');
    expect(html).toContain('data-state="enabled"');
    for (const m of KNOWN_MODELS) expect(html).toContain(`>${m}</option>`);
    expect(html).toContain('Custom…');
    expect(html).toContain('data-test="turn-controls-effort-default" data-selected="true"');
    // no custom input until custom mode / a custom model
    expect(html).not.toContain('turn-controls-model-custom');
  });

  test('known model selected: select carries the alias, no custom input', () => {
    const html = renderToString(<TurnControlsBar value={{ model: 'sonnet' }} onChange={noop} />);
    expect(html).toContain('data-test="turn-controls-model"');
    expect(html).not.toContain('turn-controls-model-custom');
  });

  test('custom model: free-text input visible with the full id', () => {
    const html = renderToString(
      <TurnControlsBar value={{ model: 'claude-opus-4-8' }} onChange={noop} />,
    );
    expect(html).toContain('data-test="turn-controls-model-custom"');
    expect(html).toContain('claude-opus-4-8');
  });

  test('effort selected: only that segment carries data-selected="true"', () => {
    const html = renderToString(
      <TurnControlsBar value={{ thinking_effort: 'ultrathink' }} onChange={noop} />,
    );
    expect(html).toContain('data-test="turn-controls-effort-ultrathink" data-selected="true"');
    expect(html).toContain('data-test="turn-controls-effort-default" data-selected="false"');
    for (const opt of EFFORT_OPTIONS.filter((o) => o.value !== 'ultrathink')) {
      expect(html).toContain(`data-test="turn-controls-effort-${opt.value}" data-selected="false"`);
    }
  });

  test('disabled variant: data-state + disabled controls', () => {
    const html = renderToString(<TurnControlsBar value={{}} onChange={noop} disabled />);
    expect(html).toContain('data-state="disabled"');
    expect(html).toContain('disabled');
  });
});
