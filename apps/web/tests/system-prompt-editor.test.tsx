/**
 * Variant tests for `<SystemPromptEditor />` (PR #25). Initial-render
 * variants via `renderToString` on the bun tier; toggle/typing/warning
 * interactions are pinned in tests/dom/system-prompt-editor.test.tsx.
 * Asserts on `data-test` / `data-state` / `data-active` markers (I-3).
 */
import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';

import { SystemPromptEditor } from '../src/components/system-prompt-editor.tsx';
import { TurnControlsBar } from '../src/components/turn-controls-bar.tsx';

const noop = (): void => {};

describe('SystemPromptEditor', () => {
  test('default variant: collapsed, inactive toggle, no panel', () => {
    const html = renderToString(<SystemPromptEditor value={{}} onChange={noop} />);
    expect(html).toContain('data-test="system-prompt-editor"');
    expect(html).toContain('data-state="collapsed"');
    expect(html).toContain('data-test="system-prompt-toggle" data-active="false"');
    expect(html).not.toContain('system-prompt-text');
    expect(html).not.toContain('system-prompt-warning');
  });

  test('append draft: expanded with text, count, append selected, no warning', () => {
    const html = renderToString(
      <SystemPromptEditor
        value={{ system_prompt: { mode: 'append', text: 'be terse' } }}
        onChange={noop}
      />,
    );
    expect(html).toContain('data-state="expanded"');
    expect(html).toContain('data-test="system-prompt-toggle" data-active="true"');
    expect(html).toContain('data-test="system-prompt-text"');
    expect(html).toContain('be terse');
    expect(html).toContain('8 chars');
    expect(html).toContain('data-mode="append" data-selected="true"');
    expect(html).toContain('data-mode="override" data-selected="false"');
    expect(html).not.toContain('system-prompt-warning');
  });

  test('override draft: warning with dismiss affordance', () => {
    const html = renderToString(
      <SystemPromptEditor
        value={{ system_prompt: { mode: 'override', text: 'you are a pirate' } }}
        onChange={noop}
      />,
    );
    expect(html).toContain('data-mode="override" data-selected="true"');
    expect(html).toContain('data-test="system-prompt-warning"');
    expect(html).toContain('data-test="system-prompt-warning-dismiss"');
  });

  test('whitespace-only draft: expanded but toggle inactive (nothing would be sent)', () => {
    const html = renderToString(
      <SystemPromptEditor
        value={{ system_prompt: { mode: 'append', text: '  ' } }}
        onChange={noop}
      />,
    );
    expect(html).toContain('data-state="expanded"');
    expect(html).toContain('data-test="system-prompt-toggle" data-active="false"');
  });

  test('disabled variant: controls carry the disabled attribute', () => {
    const html = renderToString(
      <SystemPromptEditor
        value={{ system_prompt: { mode: 'append', text: 'x' } }}
        onChange={noop}
        disabled
      />,
    );
    expect(html).toContain('disabled');
  });

  test('TurnControlsBar composes the editor toggle', () => {
    const html = renderToString(<TurnControlsBar value={{}} onChange={noop} />);
    expect(html).toContain('data-test="system-prompt-toggle"');
  });
});
