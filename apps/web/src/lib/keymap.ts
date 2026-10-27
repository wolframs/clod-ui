/**
 * Keyboard map (Phase 7.1) — bindings as data, pure match logic.
 *
 * `KEYMAP` is the single source for both dispatch (`useKeymap`) and the
 * `?` overlay's documentation rows — no second list to drift. Policy
 * for context-dependent actions (what `escape` means right now) lives
 * with the consumer that owns the state (App), not here.
 *
 * Guards (PR #27 D3): IME composition and ctrl/meta/alt never match —
 * browser shortcuts stay the browser's. Shift is deliberately not a
 * blocking modifier (`?` is Shift+/ on most layouts). Plain-letter
 * bindings stay inert while an editable element has focus; `Escape`
 * opts in via `inEditable`.
 *
 * Spec: plans/2026-06-12-clod-ui-pr27-keyboard-map-v1.md §D1–D3.
 */

export type KeyAction =
  | 'new_conversation'
  | 'focus_composer'
  | 'next_conversation'
  | 'prev_conversation'
  | 'toggle_help'
  | 'escape';

export interface KeyBinding {
  /** `KeyboardEvent.key` value, exact match. */
  key: string;
  action: KeyAction;
  /** Shown in the shortcut overlay. */
  description: string;
  /** Fires even while an editable element has focus. */
  inEditable: boolean;
  /** Call `preventDefault()` when dispatched. */
  preventDefault: boolean;
}

export const KEYMAP: readonly KeyBinding[] = [
  {
    key: 'n',
    action: 'new_conversation',
    description: 'New conversation',
    inEditable: false,
    preventDefault: true,
  },
  {
    key: '/',
    action: 'focus_composer',
    description: 'Focus the composer',
    inEditable: false,
    preventDefault: true,
  },
  {
    key: 'j',
    action: 'next_conversation',
    description: 'Next conversation',
    inEditable: false,
    preventDefault: true,
  },
  {
    key: 'k',
    action: 'prev_conversation',
    description: 'Previous conversation',
    inEditable: false,
    preventDefault: true,
  },
  {
    key: '?',
    action: 'toggle_help',
    description: 'Show / hide this overlay',
    inEditable: false,
    preventDefault: true,
  },
  {
    key: 'Escape',
    action: 'escape',
    description: 'Close overlay · cancel the active turn',
    inEditable: true,
    preventDefault: false,
  },
];

export interface KeyContext {
  inEditable: boolean;
  isComposing: boolean;
  hasModifier: boolean;
}

export function matchBinding(key: string, ctx: KeyContext): KeyBinding | undefined {
  if (ctx.isComposing || ctx.hasModifier) return undefined;
  const binding = KEYMAP.find((b) => b.key === key);
  if (binding === undefined) return undefined;
  if (ctx.inEditable && !binding.inEditable) return undefined;
  return binding;
}

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** Derive the match context from a real keydown event. */
export function contextFromEvent(ev: KeyboardEvent): KeyContext {
  const target = ev.target;
  const el = target instanceof Element ? target : null;
  const inEditable =
    el !== null &&
    (EDITABLE_TAGS.has(el.tagName) || (el as HTMLElement).isContentEditable === true);
  return {
    inEditable,
    isComposing: ev.isComposing === true,
    hasModifier: ev.ctrlKey || ev.metaKey || ev.altKey,
  };
}
