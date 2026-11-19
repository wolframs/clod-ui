/**
 * `useBackDismiss` — the phone's Back closes what is open.
 *
 * While `open`, one marker entry sits on the history stack. Back pops it and
 * calls `onClose`; closing any other way pops it for you. Pass `open` as
 * false on a desktop width: nothing touches history then.
 *
 * `release()` hands the marker on instead of popping it: for leaving an
 * overlay into something that takes its entry. Going from the drawer to a
 * panel, the panel adopts the marker; picking a conversation replaces it.
 * Popping there would race the next push (history.back() is asynchronous).
 *
 * Spec: plans/2026-11-01-clod-ui-pr44-mobile-v1.md §3.
 */
import * as React from 'react';

const isMarker = (state: unknown): boolean =>
  typeof state === 'object' && state !== null && 'dismiss' in state;

/**
 * A reload resets every overlay but keeps its marker, which would leave a
 * Back that does nothing. Called once, before the first render.
 */
export function dropStaleBackEntry(): void {
  if (isMarker(window.history.state)) window.history.back();
}

export interface BackDismiss {
  release: () => void;
}

export function useBackDismiss(open: boolean, onClose: () => void): BackDismiss {
  const pushedRef = React.useRef(false);
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;

  React.useEffect(() => {
    if (open && !pushedRef.current) {
      if (!isMarker(window.history.state)) window.history.pushState({ dismiss: true }, '');
      pushedRef.current = true;
    } else if (!open && pushedRef.current) {
      pushedRef.current = false;
      window.history.back();
    }
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onPop = (): void => {
      pushedRef.current = false;
      onCloseRef.current();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [open]);

  // Unmounted while open (a phone rotated past the breakpoint): same as closing.
  React.useEffect(
    () => () => {
      if (pushedRef.current) {
        pushedRef.current = false;
        window.history.back();
      }
    },
    [],
  );

  const release = React.useCallback((): void => {
    pushedRef.current = false;
  }, []);

  return { release };
}
