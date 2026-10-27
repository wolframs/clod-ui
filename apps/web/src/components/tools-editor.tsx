/**
 * `<ToolsEditor />` — per-conversation tool allow/disallow lists for the
 * turn-controls area (Phase 5.5). Third collapsible alongside the
 * system-prompt and raw-flags editors.
 *
 * Two sections (Allowed / Disallowed), each: curated builtin checkboxes
 * (checked = the bare name is in the list) + a free-form input for
 * entries like `Bash(npm run *)` + chips with remove. Malformed input
 * (per `parseToolEntry`) is refused with a visible invalid state.
 *
 * Spec: plans/2026-06-12-clod-ui-pr29-tools-editor-v1.md §D2–D5.
 */
import * as React from 'react';

import type { TurnControls } from '../lib/turn-controls.ts';
import {
  KNOWN_TOOLS,
  formatToolEntry,
  parseToolEntry,
  toggleToolEntry,
} from '../lib/turn-controls.ts';
import { cn } from '../lib/utils.ts';

type ToolKind = 'allowed' | 'disallowed';

const KIND_FIELD: Record<ToolKind, 'allowed_tools' | 'disallowed_tools'> = {
  allowed: 'allowed_tools',
  disallowed: 'disallowed_tools',
};

export interface ToolsEditorProps {
  value: TurnControls;
  onChange: (next: TurnControls) => void;
  disabled?: boolean;
}

export function ToolsEditor(props: ToolsEditorProps): React.ReactElement {
  const { value, onChange, disabled = false } = props;

  const allowed = value.allowed_tools ?? [];
  const disallowed = value.disallowed_tools ?? [];
  const isActive = allowed.length > 0 || disallowed.length > 0;

  const [expanded, setExpanded] = React.useState(
    value.allowed_tools !== undefined || value.disallowed_tools !== undefined,
  );

  const setList = (kind: ToolKind, list: string[] | undefined): void => {
    const field = KIND_FIELD[kind];
    const { [field]: _old, ...rest } = value;
    onChange(list === undefined ? rest : { ...rest, [field]: list });
  };

  return (
    <div
      data-test="tools-editor"
      data-state={expanded ? 'expanded' : 'collapsed'}
      className="contents"
    >
      <button
        data-test="tools-toggle"
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
        Tools
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
        <div className="flex basis-full flex-col gap-3 pt-1">
          <ToolListSection
            kind="allowed"
            label="Allowed (auto-approved)"
            entries={allowed}
            disabled={disabled}
            onListChange={(list) => setList('allowed', list)}
          />
          <ToolListSection
            kind="disallowed"
            label="Disallowed (denied)"
            entries={disallowed}
            disabled={disabled}
            onListChange={(list) => setList('disallowed', list)}
          />
        </div>
      )}
    </div>
  );
}

interface ToolListSectionProps {
  kind: ToolKind;
  label: string;
  entries: string[];
  disabled: boolean;
  onListChange: (list: string[] | undefined) => void;
}

function ToolListSection(props: ToolListSectionProps): React.ReactElement {
  const { kind, label, entries, disabled, onListChange } = props;

  const [draft, setDraft] = React.useState('');
  const parsed = parseToolEntry(draft);
  const draftInvalid = draft.trim().length > 0 && parsed === null;

  const handleAdd = (): void => {
    if (parsed === null) return;
    onListChange(toggleToolEntry(entries, formatToolEntry(parsed), true));
    setDraft('');
  };

  return (
    <div data-test={`tools-${kind}`} className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {KNOWN_TOOLS.map((tool) => (
          <label key={tool} className="flex items-center gap-1 text-xs text-muted-foreground">
            <input
              data-test={`tools-${kind}-builtin-${tool}`}
              type="checkbox"
              disabled={disabled}
              checked={entries.includes(tool)}
              onChange={(ev) => onListChange(toggleToolEntry(entries, tool, ev.target.checked))}
              className="h-3 w-3 accent-primary"
            />
            {tool}
          </label>
        ))}
      </div>
      {entries.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {entries.map((entry) => (
            <span
              key={entry}
              data-test={`tools-${kind}-chip`}
              data-entry={entry}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 font-mono text-[10px] text-foreground"
            >
              {entry}
              <button
                data-test={`tools-${kind}-remove`}
                type="button"
                disabled={disabled}
                aria-label={`Remove ${entry}`}
                onClick={() => onListChange(toggleToolEntry(entries, entry, false))}
                className="rounded px-0.5 text-muted-foreground hover:text-foreground"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <input
          data-test={`tools-${kind}-input`}
          aria-label={`Add ${kind} tool`}
          aria-invalid={draftInvalid}
          type="text"
          value={draft}
          disabled={disabled}
          placeholder="Tool or Bash(npm run *)"
          onChange={(ev) => setDraft(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') {
              ev.preventDefault();
              handleAdd();
            }
          }}
          className={cn(
            'w-56 rounded-md border bg-background px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
            draftInvalid ? 'border-destructive' : 'border-input',
          )}
        />
        <button
          data-test={`tools-${kind}-add`}
          type="button"
          disabled={disabled || parsed === null}
          onClick={handleAdd}
          className="rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          Add
        </button>
      </div>
    </div>
  );
}
