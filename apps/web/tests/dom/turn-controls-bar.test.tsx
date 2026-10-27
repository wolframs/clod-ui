/**
 * Interaction tests for `<TurnControlsBar />` (PR #24) — the local
 * "Custom…" entry mode and onChange round-trips need a real DOM.
 * Initial-render variants live in tests/turn-controls-bar.test.tsx (bun).
 */
import type { ModelInfo } from '@clod-ui/contracts';
import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { TurnControlsBar } from '../../src/components/turn-controls-bar.tsx';
import type { TurnControls } from '../../src/lib/turn-controls.ts';

/** Stateful harness so onChange round-trips into the next render. */
function Harness(props: {
  initial?: TurnControls;
  models?: ModelInfo[];
  spy: (v: TurnControls) => void;
}) {
  const [value, setValue] = React.useState<TurnControls>(props.initial ?? {});
  return (
    <TurnControlsBar
      {...(props.models !== undefined ? { models: props.models } : {})}
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
      <Harness initial={{ model: 'opus', thinking_effort: 'low' }} spy={(v) => seen.push(v)} />,
    );
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: '__default__' } });
    expect(seen).toEqual([{ thinking_effort: 'low' }]);
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

  it('effort segments round-trip: select, then back to Auto (stored as unset)', () => {
    const seen: TurnControls[] = [];
    render(<Harness spy={(v) => seen.push(v)} />);
    const xhigh = screen.getByText('XHigh');
    fireEvent.click(xhigh);
    expect(seen.at(-1)).toEqual({ thinking_effort: 'xhigh' });
    expect(xhigh.getAttribute('data-selected')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
    expect(seen.at(-1)).toEqual({});
  });
});

// PR #42: the CLI's own model list drives the picker and the effort gating.
const MODELS: ModelInfo[] = [
  {
    value: 'default',
    display_name: 'Default (recommended)',
    resolved_model: 'claude-fable-5-1',
    effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    value: 'opus',
    display_name: 'Opus 5.5',
    resolved_model: 'claude-opus-5-5',
    effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    value: 'claude-opus-4-6',
    display_name: 'Opus 4.6',
    resolved_model: 'claude-opus-4-6',
    effort_levels: ['low', 'medium', 'high', 'max'],
  },
  {
    value: 'claude-haiku-4-5-20251001',
    display_name: 'Haiku 4.5',
    resolved_model: 'claude-haiku-4-5-20251001',
  },
];

describe('TurnControlsBar with the CLI model list (PR #42)', () => {
  it('offers every listed model by name and id; Default shows what it resolves to', () => {
    render(<Harness models={MODELS} spy={() => {}} />);
    const options = Array.from((screen.getByLabelText('Model') as HTMLSelectElement).options).map(
      (o) => o.textContent,
    );
    expect(options).toEqual([
      'Default · claude-fable-5-1',
      'Opus 5.5 · claude-opus-5-5',
      'Opus 4.6 · claude-opus-4-6',
      'Haiku 4.5 · claude-haiku-4-5-20251001',
      'Custom…',
    ]);
  });

  it('a full id from the list is a listed choice, not a custom one', () => {
    render(<Harness models={MODELS} initial={{ model: 'claude-opus-4-6' }} spy={() => {}} />);
    expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('claude-opus-4-6');
    expect(screen.queryByLabelText('Custom model id')).toBeNull();
  });

  it('levels the model lacks are disabled; Ultracode needs xhigh', () => {
    render(<Harness models={MODELS} initial={{ model: 'claude-opus-4-6' }} spy={() => {}} />);
    expect(screen.getByText('XHigh').getAttribute('data-allowed')).toBe('false');
    expect(screen.getByText('Ultracode').getAttribute('data-allowed')).toBe('false');
    expect(screen.getByText('Max').getAttribute('data-allowed')).toBe('true');
    expect((screen.getByText('XHigh') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a model without effort control offers Auto only', () => {
    render(
      <Harness models={MODELS} initial={{ model: 'claude-haiku-4-5-20251001' }} spy={() => {}} />,
    );
    const allowed = ['Auto', 'Low', 'Medium', 'High', 'XHigh', 'Max', 'Ultracode'].filter(
      (label) => screen.getByText(label).getAttribute('data-allowed') === 'true',
    );
    expect(allowed).toEqual(['Auto']);
  });

  it('switching to a model that lacks the chosen level resets effort to Auto', () => {
    const seen: TurnControls[] = [];
    render(
      <Harness
        models={MODELS}
        initial={{ model: 'opus', thinking_effort: 'xhigh' }}
        spy={(v) => seen.push(v)}
      />,
    );
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'claude-opus-4-6' } });
    expect(seen.at(-1)).toEqual({ model: 'claude-opus-4-6' });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'opus' } });
    fireEvent.click(screen.getByText('Max'));
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'claude-opus-4-6' } });
    expect(seen.at(-1)).toEqual({ model: 'claude-opus-4-6', thinking_effort: 'max' });
  });
});
