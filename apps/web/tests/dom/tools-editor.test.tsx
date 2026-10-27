/**
 * Interaction tests for `<ToolsEditor />` (PR #29) — checkbox round-trips,
 * free-form add/refuse, chip removal need a real DOM. Initial-render
 * variants live in tests/tools-editor.test.tsx (bun).
 */
import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { ToolsEditor } from '../../src/components/tools-editor.tsx';
import type { TurnControls } from '../../src/lib/turn-controls.ts';

function Harness(props: { initial?: TurnControls; spy?: (v: TurnControls) => void }) {
  const [value, setValue] = React.useState<TurnControls>(props.initial ?? {});
  return (
    <ToolsEditor
      value={value}
      onChange={(next) => {
        props.spy?.(next);
        setValue(next);
      }}
    />
  );
}

const toggle = (): HTMLElement => screen.getByRole('button', { name: /Tools/ });

describe('ToolsEditor interactions', () => {
  it('checkbox adds and removes a builtin; empty list drops the key', () => {
    const seen: TurnControls[] = [];
    render(<Harness spy={(v) => seen.push(v)} />);
    fireEvent.click(toggle());
    const read = screen.getAllByRole('checkbox', { name: 'Read' })[0] as HTMLInputElement;
    fireEvent.click(read);
    expect(seen.at(-1)).toEqual({ allowed_tools: ['Read'] });
    fireEvent.click(read);
    expect(seen.at(-1)).toEqual({});
  });

  it('free-form add via Enter commits a pattern entry; duplicates are no-ops', () => {
    const seen: TurnControls[] = [];
    render(<Harness initial={{ allowed_tools: ['Read'] }} spy={(v) => seen.push(v)} />);
    const input = screen.getByLabelText('Add allowed tool');
    fireEvent.change(input, { target: { value: 'Bash(npm run *)' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(seen.at(-1)).toEqual({ allowed_tools: ['Read', 'Bash(npm run *)'] });
    // duplicate add → list unchanged
    fireEvent.change(input, { target: { value: 'Read' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(seen.at(-1)).toEqual({ allowed_tools: ['Bash(npm run *)', 'Read'] });
  });

  it('malformed input is refused: invalid state, Add disabled, Enter no-op', () => {
    const seen: TurnControls[] = [];
    render(<Harness spy={(v) => seen.push(v)} />);
    fireEvent.click(toggle());
    const input = screen.getByLabelText('Add disallowed tool');
    fireEvent.change(input, { target: { value: 'Bash(' } });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect((screen.getAllByRole('button', { name: 'Add' })[1] as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(seen).toEqual([]);
  });

  it('chip remove deletes the entry', () => {
    const seen: TurnControls[] = [];
    render(
      <Harness
        initial={{ disallowed_tools: ['WebSearch', 'Bash(rm *)'] }}
        spy={(v) => seen.push(v)}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove Bash(rm *)' }));
    expect(seen.at(-1)).toEqual({ disallowed_tools: ['WebSearch'] });
  });
});
