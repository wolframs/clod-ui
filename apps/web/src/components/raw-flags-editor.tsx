/**
 * `<RawFlagsEditor />` — collapsible raw-flags escape hatch for the
 * turn-controls area (Phase 5.8). Same shape as `<SystemPromptEditor />`.
 *
 * The warning is always visible while tokens are non-empty — not
 * dismissible, unlike the override warning: raw flags stay sharp every
 * turn (PR #28, D4). Expanded state is local, reset per conversation by
 * App's `key={selectedId}` on the bar; initially expanded when a draft
 * exists so the open state is reachable from props alone.
 *
 * Spec: plans/2026-06-12-clod-ui-pr28-raw-flags-v1.md §D3–D5.
 */
import * as React from 'react';

import type { TurnControls } from '../lib/turn-controls.ts';
import { parseExtraArgv } from '../lib/turn-controls.ts';
import { cn } from '../lib/utils.ts';

export interface RawFlagsEditorProps {
  value: TurnControls;
  onChange: (next: TurnControls) => void;
  disabled?: boolean;
}

export function RawFlagsEditor(props: RawFlagsEditorProps): React.ReactElement {
  const { value, onChange, disabled = false } = props;

  const text = value.extra_argv_text ?? '';
  const tokens = parseExtraArgv(text);
  const isActive = tokens.length > 0;

  const [expanded, setExpanded] = React.useState(value.extra_argv_text !== undefined);

  return (
    <div
      data-test="raw-flags-editor"
      data-state={expanded ? 'expanded' : 'collapsed'}
      className="contents"
    >
      <button
        data-test="raw-flags-toggle"
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
        Raw flags
        {isActive && (
          <span aria-hidden className="text-[0.5rem] leading-none text-destructive">
            ●
          </span>
        )}
        <span aria-hidden className="text-[0.6rem] leading-none">
          {expanded ? '▾' : '▸'}
        </span>
      </button>
      {expanded && (
        <div className="flex basis-full flex-col gap-1.5 pt-1">
          {isActive && (
            <div
              data-test="raw-flags-warning"
              role="alert"
              className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              Appended verbatim to the claude argv, after every composed flag — typos can break
              turns or silently change behavior. There is no validation.
            </div>
          )}
          <textarea
            data-test="raw-flags-text"
            aria-label="Raw flags"
            value={text}
            disabled={disabled}
            rows={3}
            placeholder={'One argv token per line, e.g.\n--fork-session\n--model\nopus'}
            onChange={(ev) => onChange({ ...value, extra_argv_text: ev.target.value })}
            className="min-h-[4rem] resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          />
          <span data-test="raw-flags-count" className="self-end text-xs text-muted-foreground">
            {`${tokens.length} token${tokens.length === 1 ? '' : 's'}`}
          </span>
        </div>
      )}
    </div>
  );
}
