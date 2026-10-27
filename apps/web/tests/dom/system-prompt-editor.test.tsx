/**
 * Interaction tests for `<SystemPromptEditor />` (PR #25) — expand/collapse,
 * draft round-trips, mode switch + warning dismissal need a real DOM.
 * Initial-render variants live in tests/system-prompt-editor.test.tsx (bun).
 */
import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { SystemPromptEditor } from '../../src/components/system-prompt-editor.tsx';
import type { TurnControls } from '../../src/lib/turn-controls.ts';

/** Stateful harness so onChange round-trips into the next render. */
function Harness(props: { initial?: TurnControls; spy?: (v: TurnControls) => void }) {
  const [value, setValue] = React.useState<TurnControls>(props.initial ?? {});
  return (
    <SystemPromptEditor
      value={value}
      onChange={(next) => {
        props.spy?.(next);
        setValue(next);
      }}
    />
  );
}

const toggle = (): HTMLElement => screen.getByRole('button', { name: /System prompt/ });

describe('SystemPromptEditor interactions', () => {
  it('toggle expands the panel without firing onChange; toggling again collapses', () => {
    const seen: TurnControls[] = [];
    render(<Harness spy={(v) => seen.push(v)} />);
    fireEvent.click(toggle());
    expect(screen.getByLabelText('System prompt')).toBeTruthy();
    expect(seen).toEqual([]); // layout state only — no draft committed
    fireEvent.click(toggle());
    expect(screen.queryByLabelText('System prompt')).toBeNull();
  });

  it('typing commits an append-mode draft and updates the live count', () => {
    const seen: TurnControls[] = [];
    render(<Harness spy={(v) => seen.push(v)} />);
    fireEvent.click(toggle());
    fireEvent.change(screen.getByLabelText('System prompt'), { target: { value: 'be terse' } });
    expect(seen.at(-1)).toEqual({ system_prompt: { mode: 'append', text: 'be terse' } });
    expect(screen.getByText('8 chars')).toBeTruthy();
    expect(toggle().getAttribute('data-active')).toBe('true');
  });

  it('switching to Override keeps the text, shows the warning; Dismiss removes it', () => {
    const seen: TurnControls[] = [];
    render(
      <Harness
        initial={{ system_prompt: { mode: 'append', text: 'be terse' } }}
        spy={(v) => seen.push(v)}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Override' }));
    expect(seen.at(-1)).toEqual({ system_prompt: { mode: 'override', text: 'be terse' } });
    const warning = screen.getByRole('alert');
    expect(warning.getAttribute('data-test')).toBe('system-prompt-warning');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
    // Dismissal is per-mount: flipping modes does not resurface it.
    fireEvent.click(screen.getByRole('button', { name: 'Append' }));
    fireEvent.click(screen.getByRole('button', { name: 'Override' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('clearing the text keeps the draft (mode preserved) but deactivates the toggle', () => {
    const seen: TurnControls[] = [];
    render(
      <Harness
        initial={{ system_prompt: { mode: 'override', text: 'x' } }}
        spy={(v) => seen.push(v)}
      />,
    );
    fireEvent.change(screen.getByLabelText('System prompt'), { target: { value: '' } });
    expect(seen.at(-1)).toEqual({ system_prompt: { mode: 'override', text: '' } });
    expect(toggle().getAttribute('data-active')).toBe('false');
  });
});
