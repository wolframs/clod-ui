/**
 * `useKeymap` — one window keydown listener over the pure keymap
 * (PR #27 D4). The handler lives in a ref updated during render (the
 * `useSubscribe` precedent) so consumers can pass inline closures
 * without re-subscribing; the listener attaches once per mount.
 */
import * as React from 'react';

import type { KeyAction } from './keymap.ts';
import { contextFromEvent, matchBinding } from './keymap.ts';

export function useKeymap(onAction: (action: KeyAction) => void): void {
  const handlerRef = React.useRef(onAction);
  handlerRef.current = onAction;

  React.useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent): void => {
      const binding = matchBinding(ev.key, contextFromEvent(ev));
      if (binding === undefined) return;
      if (binding.preventDefault) ev.preventDefault();
      handlerRef.current(binding.action);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
