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
import type { UploadedAttachment } from '../lib/use-attachment-uploads.ts';
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
  /**
   * Optional controls slot rendered above the textarea (PR #24). The
   * Composer stays agnostic of what the controls are — App composes
   * `<TurnControlsBar />` in.
   */
  controls?: React.ReactNode;
  /**
   * Optional handle on the textarea so App-level features (the `/`
   * keyboard shortcut, PR #27) can focus it. Internal behavior is
   * unchanged when absent.
   */
  inputRef?: React.RefObject<HTMLTextAreaElement>;
  /** Pending attachments (PR #34): chips above the textarea. */
  attachments?: UploadedAttachment[];
  onAttachFiles?: (files: ArrayLike<File>) => void;
  onRemoveAttachment?: (name: string) => void;
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
    controls,
    inputRef,
    attachments = [],
    onAttachFiles,
    onRemoveAttachment,
    className,
  } = props;

  const [text, setText] = React.useState('');
  // A refused submit gives the draft back, unless the user has typed since.
  const attemptedText = submitState.status === 'error' ? submitState.attempted_text : undefined;
  React.useEffect(() => {
    if (attemptedText !== undefined) setText((cur) => (cur === '' ? attemptedText : cur));
  }, [attemptedText]);
  const [dragging, setDragging] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const internalRef = React.useRef<HTMLTextAreaElement>(null);
  const textareaRef = inputRef ?? internalRef;

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
  const isStreaming = turnState.status === 'streaming';
  // Submitted and accepted, but `system.init` not seen yet: the CLI is
  // starting. The turn is in flight even though the stream shows nothing
  // (or still shows the previous, finished turn).
  const isStarting =
    lastSubmittedTurnId !== undefined &&
    (turnState.status === 'idle' || turnState.turn_id !== lastSubmittedTurnId);
  const turnInFlight = isStreaming || isStarting;
  // The engine refuses a second turn while one runs (conversation_busy).
  const canSend = trimmed.length > 0 && submitState.status !== 'submitting' && !turnInFlight;
  const cancelableTurnId = isStreaming ? turnState.turn_id : lastSubmittedTurnId;
  const showCancel = turnInFlight && cancelableTurnId !== undefined;

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
      data-dragging={dragging ? 'true' : 'false'}
      onSubmit={(ev) => {
        ev.preventDefault();
        handleSubmit();
      }}
      onDragOver={(ev) => {
        if (!onAttachFiles) return;
        ev.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(ev) => {
        if (!onAttachFiles) return;
        ev.preventDefault();
        setDragging(false);
        if (ev.dataTransfer?.files?.length) onAttachFiles(ev.dataTransfer.files);
      }}
      className={cn(
        'flex flex-col gap-2 border-t border-border bg-card p-3',
        dragging && 'ring-2 ring-ring',
        className,
      )}
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
      {controls}
      {attachments.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {attachments.map((att) => (
            <span
              key={att.name}
              data-test="composer-attachment-chip"
              data-name={att.name}
              data-status={att.status}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px]',
                att.status === 'error'
                  ? 'border-destructive/50 bg-destructive/10 text-destructive'
                  : 'border-border bg-muted text-foreground',
                att.status === 'uploading' && 'opacity-60',
              )}
            >
              {`${att.name} · ${att.status === 'error' ? 'failed' : `${att.size} B`}`}
              {onRemoveAttachment && (
                <button
                  data-test="composer-attachment-remove"
                  type="button"
                  aria-label={`Remove ${att.name}`}
                  onClick={() => onRemoveAttachment(att.name)}
                  className="rounded px-0.5 text-muted-foreground hover:text-foreground"
                >
                  ×
                </button>
              )}
            </span>
          ))}
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
        {onAttachFiles && (
          <>
            <input
              ref={fileInputRef}
              data-test="composer-file-input"
              type="file"
              multiple
              className="hidden"
              onChange={(ev) => {
                if (ev.target.files?.length) onAttachFiles(ev.target.files);
                ev.target.value = '';
              }}
            />
            <button
              data-test="composer-attach"
              type="button"
              aria-label="Attach files"
              onClick={() => fileInputRef.current?.click()}
              className="mr-auto rounded-md border border-input bg-background px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              📎
            </button>
          </>
        )}
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
