/**
 * Tool-card collapse toggling — DOM-tier tests for both card components
 * (ToolCard in turn-view, ToolUseBlockView via ChatMessageView in
 * transcript-history).
 *
 * Pins the PR #18d.3 plan §2 decisions: collapsed by default, errors start
 * expanded, collapse is the `hidden` attribute (body stays in the DOM).
 */
import type { ChatMessage } from '@clod-ui/contracts';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { ChatMessageView } from '../../src/components/transcript-history';
import { ToolCard } from '../../src/components/turn-view';

function bodyOf(card: HTMLElement): HTMLElement {
  const body = card.querySelector('div[hidden], article > div:last-child');
  if (!(body instanceof HTMLElement)) throw new Error('card body not found');
  return body;
}

describe('ToolCard (turn-view) collapse', () => {
  test('success card: collapsed by default, click expands, click collapses', () => {
    render(
      <ToolCard
        tool={{
          tool_use_id: 't1',
          name: 'Bash',
          input: { command: 'ls' },
          status: 'success',
          result: 'ok',
        }}
      />,
    );
    const card = screen.getByText('Bash').closest('article') as HTMLElement;
    const toggle = screen.getByRole('button');

    expect(card.getAttribute('data-collapsed')).toBe('true');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(bodyOf(card).hidden).toBe(true);

    fireEvent.click(toggle);
    expect(card.getAttribute('data-collapsed')).toBe('false');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(bodyOf(card).hidden).toBe(false);

    fireEvent.click(toggle);
    expect(card.getAttribute('data-collapsed')).toBe('true');
  });

  test('error card starts expanded', () => {
    render(
      <ToolCard
        tool={{
          tool_use_id: 't2',
          name: 'Read',
          input: { path: '/nope' },
          status: 'error',
          error_message: 'ENOENT',
        }}
      />,
    );
    const card = screen.getByText('Read').closest('article') as HTMLElement;
    expect(card.getAttribute('data-collapsed')).toBe('false');
    expect(bodyOf(card).hidden).toBe(false);
  });
});

describe('ToolUseBlockView (transcript-history) collapse', () => {
  function message(isError: boolean): ChatMessage {
    return {
      id: 'm1',
      role: 'assistant',
      content: [
        { type: 'tool_use', tool_use_id: 'tu1', name: 'Bash', input: { command: 'pwd' } },
        { type: 'tool_result', tool_use_id: 'tu1', content: 'out', is_error: isError },
      ],
      source: { line_number: 1, byte_offset: 0 },
    } as ChatMessage;
  }

  test('ok result: collapsed by default, toggle expands', () => {
    render(<ChatMessageView message={message(false)} />);
    const card = document.querySelector('[data-block-type="tool_use"]') as HTMLElement;
    const toggle = card.querySelector('[data-test="tool-card-toggle"]') as HTMLElement;

    expect(card.getAttribute('data-collapsed')).toBe('true');
    fireEvent.click(toggle);
    expect(card.getAttribute('data-collapsed')).toBe('false');
    expect(card.querySelector('[data-test="tool-result-section"]')).not.toBeNull();
  });

  test('error result starts expanded', () => {
    render(<ChatMessageView message={message(true)} />);
    const card = document.querySelector('[data-block-type="tool_use"]') as HTMLElement;
    expect(card.getAttribute('data-collapsed')).toBe('false');
  });
});
