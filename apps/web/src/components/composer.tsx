/**
 * `<Composer />` — text input + Send + Cancel for a single conversation.
 *
 * Pure-ish: owns the textarea state locally; everything else (submit
 * dispatch, cancel dispatch, surfaces of the active turn) flows in via
 * typed props. Wired into App.tsx where `useSubmitTurn` and
 * `useTurnStream` provide the runtime.
 *
 * Spec: plans/landed/2026-05-02-clod-ui-pr19-composer-v1.md §5-§6.
 *
 * UX rules:
 *   - Enter submits; Shift+Enter inserts a newline.
 *   - Empty / whitespace-only submits are no-ops; Send is disabled.
 *   - Submit clears the textarea; on submit error the textarea retains
 *     the user's text so they can retry without losing it.
 *   - Cancel button is visible only when `turnStatus === 'streaming'`.
 *   - When `convId` is undefined a hint replaces the form.
 */
import * as React from 'react';

import type { TurnState } from '../lib/turn-reducer.ts';
import type { SubmitTurnState } from '../lib/use-submit-turn.ts';
import { cn } from '../lib/utils.ts';

export interface ComposerProps {
  convId: string | undefined;
  /** State from `useTurnStream`; drives Cancel visibility + activeTurnId. */
  turnState: TurnState;
  /** State from `useSubmitTurn`; drives the error surface + Send disabled. */
  submitState: SubmitTurnState;
  /**
   * Most recently submitted turn id from `useSubmitTurn`. Used as a
   * fallback for Cancel when `turnState` hasn't observed `system.init`
   * yet (cancel-before-first-event path; see spine T1.06).
   */
  lastSubmittedTurnId: string | undefined;
  onSubmit: (text: string) => void;
  onCancel: (turnId: string) => void;
  /** Optional click handler for the error block's "Dismiss" affordance. */
  onResetError?: () => void;
  className?: string;
}

export function Composer(props: ComposerProps): React.ReactElement {
  const {
    convId,
    turnState,
    submitState,
    lastSubmittedTurnId,
    onSubmit,
    onCancel,
    onResetError,
    className,
  } = props;

  const [text, setText] = React.useState('');
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  // Empty-pane variant: no conv selected.
  if (!convId) {
    return (
      <div
        data-test="composer-hint"
        data-state="no-conversation"
        className={cn(
          'flex items-center justify-center px-4 py-6 text-sm text-muted-foreground',
          className,
        )}
      >
        Select or create a conversation to start
      </div>
    );
  }

  const trimmed = text.trim();
  const canSend = trimmed.length > 0 && submitState.status !== 'submitting';
  const isStreaming = turnState.status === 'streaming';
  // Prefer the live turn_id from useTurnStream; fall back to the most-
  // recently submitted id so cancel works between submit and system.init.
  const cancelableTurnId = turnState.status !== 'idle' ? turnState.turn_id : lastSubmittedTurnId;
  const showCancel = isStreaming && cancelableTurnId !== undefined;

  const handleSubmit = (): void => {
    if (!canSend) return;
    const value = text;
    setText(''); // clear synchronously so a fast typist doesn't double-fire
    onSubmit(value);
  };

  const handleKeyDown = (ev: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      // Don't submit on IME composition (Japanese/Chinese input)
      if (ev.nativeEvent.isComposing) return;
      ev.preventDefault();
      handleSubmit();
    }
  };

  const handleCancel = (): void => {
    if (cancelableTurnId !== undefined) onCancel(cancelableTurnId);
  };

  return (
    <form
      data-test="composer"
      data-state={submitState.status}
      onSubmit={(ev) => {
        ev.preventDefault();
        handleSubmit();
      }}
      className={cn('flex flex-col gap-2 border-t border-border bg-card p-3', className)}
    >
      {submitState.status === 'error' && (
        <div
          data-test="composer-error"
          role="alert"
          className="flex items-start justify-between gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <span className="line-clamp-2" title={submitState.error.message}>
            {submitState.error.message}
          </span>
          {onResetError && (
            <button
              data-test="composer-error-dismiss"
              type="button"
              onClick={onResetError}
              className="shrink-0 rounded px-2 text-xs underline-offset-2 hover:underline"
            >
              Dismiss
            </button>
          )}
        </div>
      )}
      <textarea
        ref={textareaRef}
        data-test="composer-input"
        aria-label="Message"
        value={text}
        onChange={(ev) => setText(ev.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type a message…  (Enter to send · Shift+Enter for newline)"
        rows={3}
        className="min-h-[5rem] resize-none rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      />
      <div className="flex items-center justify-end gap-2">
        {showCancel && (
          <button
            data-test="composer-cancel"
            type="button"
            onClick={handleCancel}
            className="rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium text-foreground shadow-sm hover:bg-accent"
          >
            Cancel
          </button>
        )}
        <button
          data-test="composer-send"
          type="submit"
          disabled={!canSend}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitState.status === 'submitting' ? 'Sending…' : 'Send'}
        </button>
      </div>
    </form>
  );
}
