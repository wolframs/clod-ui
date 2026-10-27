/**
 * Interaction tests for `<TurnControlsBar />` (PR #24) — the local
 * "Custom…" entry mode and onChange round-trips need a real DOM.
 * Initial-render variants live in tests/turn-controls-bar.test.tsx (bun).
 */
import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { TurnControlsBar } from '../../src/components/turn-controls-bar.tsx';
import type { TurnControls } from '../../src/lib/turn-controls.ts';

/** Stateful harness so onChange round-trips into the next render. */
function Harness(props: { initial?: TurnControls; spy: (v: TurnControls) => void }) {
  const [value, setValue] = React.useState<TurnControls>(props.initial ?? {});
  return (
    <TurnControlsBar
      value={value}
      onChange={(next) => {
        props.spy(next);
        setValue(next);
      }}
    />
  );
}

describe('TurnControlsBar interactions', () => {
  it('selecting a known model fires onChange with the alias', () => {
    const seen: TurnControls[] = [];
    render(<Harness spy={(v) => seen.push(v)} />);
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'opus' } });
    expect(seen).toEqual([{ model: 'opus' }]);
  });

  it('selecting Default clears the model field entirely', () => {
    const seen: TurnControls[] = [];
    render(
      <Harness initial={{ model: 'opus', thinking_effort: 'think' }} spy={(v) => seen.push(v)} />,
    );
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: '__default__' } });
    expect(seen).toEqual([{ thinking_effort: 'think' }]);
  });

  it('Custom… reveals the input without firing onChange; typing commits the id', () => {
    const seen: TurnControls[] = [];
    render(<Harness spy={(v) => seen.push(v)} />);
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: '__custom__' } });
    expect(seen).toEqual([]); // entry mode only — nothing committed yet
    const input = screen.getByLabelText('Custom model id');
    fireEvent.change(input, { target: { value: 'claude-opus-4-8' } });
    expect(seen.at(-1)).toEqual({ model: 'claude-opus-4-8' });
  });

  it('clearing the custom input drops the model field', () => {
    const seen: TurnControls[] = [];
    render(<Harness initial={{ model: 'claude-opus-4-8' }} spy={(v) => seen.push(v)} />);
    fireEvent.change(screen.getByLabelText('Custom model id'), { target: { value: '' } });
    expect(seen.at(-1)).toEqual({});
  });

  it('effort segments round-trip: select, then back to default', () => {
    const seen: TurnControls[] = [];
    render(<Harness spy={(v) => seen.push(v)} />);
    const hard = screen.getByText('Think hard');
    fireEvent.click(hard);
    expect(seen.at(-1)).toEqual({ thinking_effort: 'think_hard' });
    expect(hard.getAttribute('data-selected')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Default' }));
    expect(seen.at(-1)).toEqual({});
  });
});
