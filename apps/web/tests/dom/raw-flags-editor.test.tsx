/**
 * Interaction tests for `<RawFlagsEditor />` (PR #28) — expand/collapse,
 * draft round-trips, and the always-on warning need a real DOM.
 * Initial-render variants live in tests/raw-flags-editor.test.tsx (bun).
 */
import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { RawFlagsEditor } from '../../src/components/raw-flags-editor.tsx';
import type { TurnControls } from '../../src/lib/turn-controls.ts';

function Harness(props: { initial?: TurnControls; spy?: (v: TurnControls) => void }) {
  const [value, setValue] = React.useState<TurnControls>(props.initial ?? {});
  return (
    <RawFlagsEditor
      value={value}
      onChange={(next) => {
        props.spy?.(next);
        setValue(next);
      }}
    />
  );
}

const toggle = (): HTMLElement => screen.getByRole('button', { name: /Raw flags/ });

describe('RawFlagsEditor interactions', () => {
  it('toggle expands without firing onChange; typing commits the draft', () => {
    const seen: TurnControls[] = [];
    render(<Harness spy={(v) => seen.push(v)} />);
    fireEvent.click(toggle());
    expect(seen).toEqual([]);
    fireEvent.change(screen.getByLabelText('Raw flags'), {
      target: { value: '--fork-session\n-d' },
    });
    expect(seen.at(-1)).toEqual({ extra_argv_text: '--fork-session\n-d' });
    expect(screen.getByText('2 tokens')).toBeTruthy();
    expect(toggle().getAttribute('data-active')).toBe('true');
  });

  it('warning appears with tokens and disappears when cleared', () => {
    render(<Harness initial={{ extra_argv_text: '-d' }} />);
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Raw flags'), { target: { value: '' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(toggle().getAttribute('data-active')).toBe('false');
    expect(screen.getByText('0 tokens')).toBeTruthy();
  });
});
