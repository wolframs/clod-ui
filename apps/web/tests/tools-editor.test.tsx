/**
 * Variant tests for `<ToolsEditor />` (PR #29). Initial-render variants
 * via `renderToString` on the bun tier; interactions are in
 * tests/dom/tools-editor.test.tsx. Marker assertions only (I-3).
 */
import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';

import { ToolsEditor } from '../src/components/tools-editor.tsx';
import { TurnControlsBar } from '../src/components/turn-controls-bar.tsx';
import { KNOWN_TOOLS } from '../src/lib/turn-controls.ts';

const noop = (): void => {};

describe('ToolsEditor', () => {
  test('default variant: collapsed, inactive toggle, no panel', () => {
    const html = renderToString(<ToolsEditor value={{}} onChange={noop} />);
    expect(html).toContain('data-test="tools-editor"');
    expect(html).toContain('data-state="collapsed"');
    expect(html).toContain('data-test="tools-toggle" data-active="false"');
    expect(html).not.toContain('tools-allowed-input');
  });

  test('lists present: expanded, active, both sections with builtin checkboxes', () => {
    const html = renderToString(
      <ToolsEditor
        value={{ allowed_tools: ['Read', 'Bash(npm run *)'], disallowed_tools: ['WebSearch'] }}
        onChange={noop}
      />,
    );
    expect(html).toContain('data-state="expanded"');
    expect(html).toContain('data-test="tools-toggle" data-active="true"');
    for (const kind of ['allowed', 'disallowed'] as const) {
      expect(html).toContain(`data-test="tools-${kind}"`);
      for (const tool of KNOWN_TOOLS) {
        expect(html).toContain(`data-test="tools-${kind}-builtin-${tool}"`);
      }
    }
    expect(html).toContain('data-entry="Bash(npm run *)"');
    expect(html).toContain('data-entry="WebSearch"');
  });

  test('builtin checkbox reflects list membership', () => {
    const html = renderToString(
      <ToolsEditor value={{ allowed_tools: ['Read'] }} onChange={noop} />,
    );
    expect(html).toMatch(/data-test="tools-allowed-builtin-Read"[^>]*checked=""/);
    expect(html).not.toMatch(/data-test="tools-allowed-builtin-Write"[^>]*checked=""/);
  });

  test('disabled variant: controls carry the disabled attribute', () => {
    const html = renderToString(
      <ToolsEditor value={{ allowed_tools: ['Read'] }} onChange={noop} disabled />,
    );
    expect(html).toContain('disabled');
  });

  test('TurnControlsBar composes the tools toggle', () => {
    const html = renderToString(<TurnControlsBar value={{}} onChange={noop} />);
    expect(html).toContain('data-test="tools-toggle"');
  });
});
