/**
 * `<ShortcutOverlay />` — the `?` keyboard-shortcut reference (PR #27 D5).
 * Pure presentational: open/close state lives in App; rows render from
 * `KEYMAP`, so the overlay can't drift from the actual bindings.
 */
import * as React from 'react';

import { KEYMAP } from '../lib/keymap.ts';

export interface ShortcutOverlayProps {
  open: boolean;
  onClose: () => void;
}

const KEY_LABELS: Record<string, string> = { Escape: 'Esc' };

export function ShortcutOverlay(props: ShortcutOverlayProps): React.ReactElement | null {
  const { open, onClose } = props;
  if (!open) return null;

  return (
    <div
      data-test="shortcut-overlay"
      data-state="open"
      role="dialog"
      aria-label="Keyboard shortcuts"
      onClick={onClose}
      className="absolute inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm"
    >
      <div
        onClick={(ev) => ev.stopPropagation()}
        className="w-80 rounded-lg border border-border bg-card p-4 shadow-lg"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Keyboard shortcuts</h2>
          <button
            data-test="shortcut-overlay-close"
            type="button"
            onClick={onClose}
            className="rounded px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Close
          </button>
        </div>
        <ul className="flex flex-col gap-1.5">
          {KEYMAP.map((b) => (
            <li
              key={b.key}
              data-test="shortcut-overlay-row"
              data-action={b.action}
              className="flex items-center justify-between gap-4 text-xs"
            >
              <span className="text-muted-foreground">{b.description}</span>
              <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">
                {KEY_LABELS[b.key] ?? b.key}
              </kbd>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
