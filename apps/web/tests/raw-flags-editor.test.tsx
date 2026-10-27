/**
 * Variant tests for `<RawFlagsEditor />` (PR #28). Initial-render
 * variants via `renderToString` on the bun tier; interactions are in
 * tests/dom/raw-flags-editor.test.tsx. Marker assertions only (I-3).
 */
import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';

import { RawFlagsEditor } from '../src/components/raw-flags-editor.tsx';
import { TurnControlsBar } from '../src/components/turn-controls-bar.tsx';

const noop = (): void => {};

describe('RawFlagsEditor', () => {
  test('default variant: collapsed, inactive toggle, no panel', () => {
    const html = renderToString(<RawFlagsEditor value={{}} onChange={noop} />);
    expect(html).toContain('data-test="raw-flags-editor"');
    expect(html).toContain('data-state="collapsed"');
    expect(html).toContain('data-test="raw-flags-toggle" data-active="false"');
    expect(html).not.toContain('raw-flags-text');
    expect(html).not.toContain('raw-flags-warning');
  });

  test('draft with tokens: expanded, active, warning visible, count', () => {
    const html = renderToString(
      <RawFlagsEditor value={{ extra_argv_text: '--fork-session\n-d' }} onChange={noop} />,
    );
    expect(html).toContain('data-state="expanded"');
    expect(html).toContain('data-test="raw-flags-toggle" data-active="true"');
    expect(html).toContain('data-test="raw-flags-warning"');
    expect(html).toContain('2 tokens');
  });

  test('empty draft: expanded but inactive — no warning without tokens', () => {
    const html = renderToString(<RawFlagsEditor value={{ extra_argv_text: '' }} onChange={noop} />);
    expect(html).toContain('data-state="expanded"');
    expect(html).toContain('data-test="raw-flags-toggle" data-active="false"');
    expect(html).not.toContain('raw-flags-warning');
    expect(html).toContain('0 tokens');
  });

  test('disabled variant: controls carry the disabled attribute', () => {
    const html = renderToString(
      <RawFlagsEditor value={{ extra_argv_text: '-d' }} onChange={noop} disabled />,
    );
    expect(html).toContain('disabled');
  });

  test('TurnControlsBar composes the raw-flags toggle', () => {
    const html = renderToString(<TurnControlsBar value={{}} onChange={noop} />);
    expect(html).toContain('data-test="raw-flags-toggle"');
  });
});
