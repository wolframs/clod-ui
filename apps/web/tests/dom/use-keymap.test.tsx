/**
 * Interaction tests for `useKeymap` (PR #27) — real keydown dispatch on
 * window, editable-focus and modifier guards. Pure match logic is
 * bun-tested in tests/keymap.test.ts.
 */
import { render } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, it } from 'vitest';

import type { KeyAction } from '../../src/lib/keymap.ts';
import { useKeymap } from '../../src/lib/use-keymap.ts';

function Harness(props: { spy: (a: KeyAction) => void }): React.ReactElement {
  useKeymap(props.spy);
  return <textarea aria-label="editable" />;
}

function press(target: EventTarget, key: string, init?: KeyboardEventInit): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
}

describe('useKeymap', () => {
  it('dispatches actions for bare keys on window', () => {
    const seen: KeyAction[] = [];
    render(<Harness spy={(a) => seen.push(a)} />);
    press(window, 'n');
    press(window, '?');
    expect(seen).toEqual(['new_conversation', 'toggle_help']);
  });

  it('suppresses letter bindings inside a textarea, but not Escape', () => {
    const seen: KeyAction[] = [];
    const { container } = render(<Harness spy={(a) => seen.push(a)} />);
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    press(textarea, 'n');
    press(textarea, 'j');
    expect(seen).toEqual([]);
    press(textarea, 'Escape');
    expect(seen).toEqual(['escape']);
  });

  it('suppresses bindings under ctrl/meta/alt', () => {
    const seen: KeyAction[] = [];
    render(<Harness spy={(a) => seen.push(a)} />);
    press(window, 'n', { ctrlKey: true });
    press(window, 'n', { metaKey: true });
    press(window, 'n', { altKey: true });
    expect(seen).toEqual([]);
  });

  it('calls preventDefault per the binding flag', () => {
    render(<Harness spy={() => {}} />);
    const slash = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });
    window.dispatchEvent(slash);
    expect(slash.defaultPrevented).toBe(true);
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    window.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(false);
  });

  it('detaches the listener on unmount', () => {
    const seen: KeyAction[] = [];
    const { unmount } = render(<Harness spy={(a) => seen.push(a)} />);
    unmount();
    press(window, 'n');
    expect(seen).toEqual([]);
  });
});
