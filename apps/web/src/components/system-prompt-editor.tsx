/**
 * `<SystemPromptEditor />` — collapsible per-conversation system-prompt
 * editor for the turn-controls area (Phase 5.3).
 *
 * Local state (same precedent as the bar's "Custom…" mode): whether the
 * panel is expanded, and whether the override warning was dismissed.
 * Both reset per conversation via App's `key={selectedId}` on the bar.
 * Initially expanded when a draft exists so the open state is reachable
 * from props alone.
 *
 * Append is the default mode; override replaces Claude Code's own system
 * prompt, so it carries a dismissible warning (PR #25, D3).
 *
 * Spec: plans/2026-06-12-clod-ui-pr25-system-prompt-editor-v1.md §D3–D7.
 */
import * as React from 'react';

import type { SystemPrompt, TurnControls } from '../lib/turn-controls.ts';
import { effectiveSystemPrompt } from '../lib/turn-controls.ts';
import { cn } from '../lib/utils.ts';

// TODO(system-prompt-presets): saved/named prompts once controls
// persistence exists (see TODO(controls-persistence) in App).

const MODES: ReadonlyArray<{ value: SystemPrompt['mode']; label: string }> = [
  { value: 'append', label: 'Append' },
  { value: 'override', label: 'Override' },
];

export interface SystemPromptEditorProps {
  value: TurnControls;
  onChange: (next: TurnControls) => void;
  disabled?: boolean;
}

export function SystemPromptEditor(props: SystemPromptEditorProps): React.ReactElement {
  const { value, onChange, disabled = false } = props;

  const draft = value.system_prompt;
  const mode = draft?.mode ?? 'append';
  const text = draft?.text ?? '';
  const isActive = effectiveSystemPrompt(value) !== undefined;

  const [expanded, setExpanded] = React.useState(draft !== undefined);
  const [warningDismissed, setWarningDismissed] = React.useState(false);
  const showWarning = expanded && mode === 'override' && !warningDismissed;

  const update = (next: SystemPrompt): void => {
    onChange({ ...value, system_prompt: next });
  };

  const segmentClass = (selected: boolean): string =>
    cn(
      'rounded px-2 py-0.5 text-xs transition-colors',
      selected
        ? 'bg-primary text-primary-foreground'
        : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      disabled && 'cursor-not-allowed opacity-50',
    );

  return (
    <div
      data-test="system-prompt-editor"
      data-state={expanded ? 'expanded' : 'collapsed'}
      className="contents"
    >
      <button
        data-test="system-prompt-toggle"
        data-active={isActive ? 'true' : 'false'}
        type="button"
        disabled={disabled}
        aria-expanded={expanded}
        onClick={() => setExpanded((e) => !e)}
        className={cn(
          'flex items-center gap-1.5 rounded px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        System prompt
        {isActive && (
          <span aria-hidden className="text-[0.5rem] leading-none text-primary">
            ●
          </span>
        )}
        <span aria-hidden className="text-[0.6rem] leading-none">
          {expanded ? '▾' : '▸'}
        </span>
      </button>
      {expanded && (
        <div className="flex basis-full flex-col gap-1.5 pt-1">
          {showWarning && (
            <div
              data-test="system-prompt-warning"
              role="alert"
              className="flex items-start justify-between gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              <span>
                Override replaces the Claude Code system prompt entirely — tool use and built-in
                behaviors may degrade. Append is the recommended mode.
              </span>
              <button
                data-test="system-prompt-warning-dismiss"
                type="button"
                onClick={() => setWarningDismissed(true)}
                className="shrink-0 rounded px-2 text-xs underline-offset-2 hover:underline"
              >
                Dismiss
              </button>
            </div>
          )}
          <div className="flex items-center gap-2">
            <div
              role="group"
              aria-label="System prompt mode"
              data-test="system-prompt-mode"
              className="flex items-center gap-1 text-muted-foreground"
            >
              Mode
              {MODES.map((m) => (
                <button
                  key={m.value}
                  data-mode={m.value}
                  data-selected={mode === m.value ? 'true' : 'false'}
                  type="button"
                  disabled={disabled}
                  onClick={() => update({ mode: m.value, text })}
                  className={segmentClass(mode === m.value)}
                >
                  {m.label}
                </button>
              ))}
            </div>
            {/* TODO(token-estimate): optional ~token estimate next to the count. */}
            <span data-test="system-prompt-count" className="ml-auto text-muted-foreground">
              {`${text.length} chars`}
            </span>
          </div>
          <textarea
            data-test="system-prompt-text"
            aria-label="System prompt"
            value={text}
            disabled={disabled}
            rows={3}
            placeholder={
              mode === 'append'
                ? 'Appended to the Claude Code system prompt…'
                : 'Replaces the entire system prompt…'
            }
            onChange={(ev) => update({ mode, text: ev.target.value })}
            className="min-h-[4rem] resize-y rounded-md border border-input bg-background px-3 py-2 text-xs text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>
      )}
    </div>
  );
}
