/**
 * `<TurnControlsBar />` — model picker + thinking-effort segments for the
 * Composer's controls slot (Phase 5.1/5.2).
 *
 * Pure-ish (same precedent as Composer's textarea): the only local state
 * is whether the model select is in "Custom…" entry mode, which can't be
 * derived from `value` alone while the custom field is still empty. App
 * keys this component by conv_id so that state resets per conversation.
 *
 * Spec: plans/2026-06-10-clod-ui-pr24-turn-controls-v1.md §D6/D7.
 */
import * as React from 'react';

import type { TurnControls } from '../lib/turn-controls.ts';
import { EFFORT_OPTIONS, KNOWN_MODELS, isKnownModel } from '../lib/turn-controls.ts';
import { cn } from '../lib/utils.ts';

import { RawFlagsEditor } from './raw-flags-editor.tsx';
import { SystemPromptEditor } from './system-prompt-editor.tsx';
import { ToolsEditor } from './tools-editor.tsx';

const MODEL_DEFAULT = '__default__';
const MODEL_CUSTOM = '__custom__';

export interface TurnControlsBarProps {
  value: TurnControls;
  onChange: (next: TurnControls) => void;
  disabled?: boolean;
  className?: string;
  /**
   * What each choice resolved to on this machine, learned from earlier
   * turns (`default` for no `--model`). The CLI has no listing command, so
   * a choice nobody has used yet shows only its alias.
   */
  resolvedModels?: Record<string, string>;
}

function modelLabel(alias: string, resolved: string | undefined): string {
  return resolved === undefined ? alias : `${alias} · ${resolved}`;
}

export function TurnControlsBar(props: TurnControlsBarProps): React.ReactElement {
  const { value, onChange, disabled = false, className, resolvedModels = {} } = props;

  const modelIsCustom = value.model !== undefined && !isKnownModel(value.model);
  const [customMode, setCustomMode] = React.useState(modelIsCustom);
  const showCustomInput = customMode || modelIsCustom;
  const selectValue = showCustomInput
    ? MODEL_CUSTOM
    : value.model === undefined
      ? MODEL_DEFAULT
      : value.model;

  const handleModelSelect = (selected: string): void => {
    if (selected === MODEL_CUSTOM) {
      setCustomMode(true);
      return; // keep whatever model is set; the input takes over from here
    }
    setCustomMode(false);
    if (selected === MODEL_DEFAULT) {
      const { model: _model, ...rest } = value;
      onChange(rest);
    } else {
      onChange({ ...value, model: selected });
    }
  };

  const handleCustomModel = (text: string): void => {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      const { model: _model, ...rest } = value;
      onChange(rest);
    } else {
      onChange({ ...value, model: trimmed });
    }
  };

  const handleEffort = (effort: TurnControls['thinking_effort']): void => {
    if (effort === undefined) {
      const { thinking_effort: _effort, ...rest } = value;
      onChange(rest);
    } else {
      onChange({ ...value, thinking_effort: effort });
    }
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
      data-test="turn-controls"
      data-state={disabled ? 'disabled' : 'enabled'}
      className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 text-xs', className)}
    >
      <label className="flex items-center gap-1.5 text-muted-foreground">
        Model
        <select
          data-test="turn-controls-model"
          aria-label="Model"
          value={selectValue}
          disabled={disabled}
          onChange={(ev) => handleModelSelect(ev.target.value)}
          className="rounded-md border border-input bg-background px-1.5 py-0.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          <option value={MODEL_DEFAULT}>{modelLabel('Default', resolvedModels['default'])}</option>
          {KNOWN_MODELS.map((m) => (
            <option key={m} value={m}>
              {modelLabel(m, resolvedModels[m])}
            </option>
          ))}
          <option value={MODEL_CUSTOM}>Custom…</option>
        </select>
        {showCustomInput && (
          <input
            data-test="turn-controls-model-custom"
            aria-label="Custom model id"
            type="text"
            placeholder="claude-…"
            value={value.model ?? ''}
            disabled={disabled}
            onChange={(ev) => handleCustomModel(ev.target.value)}
            className="w-44 rounded-md border border-input bg-background px-1.5 py-0.5 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          />
        )}
      </label>
      <div
        role="group"
        aria-label="Thinking effort"
        className="flex items-center gap-1 text-muted-foreground"
      >
        Thinking
        <button
          data-test="turn-controls-effort-default"
          data-selected={value.thinking_effort === undefined ? 'true' : 'false'}
          type="button"
          disabled={disabled}
          onClick={() => handleEffort(undefined)}
          className={segmentClass(value.thinking_effort === undefined)}
        >
          Default
        </button>
        {EFFORT_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            data-test={`turn-controls-effort-${opt.value}`}
            data-selected={value.thinking_effort === opt.value ? 'true' : 'false'}
            type="button"
            disabled={disabled}
            onClick={() => handleEffort(opt.value)}
            className={segmentClass(value.thinking_effort === opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <SystemPromptEditor value={value} onChange={onChange} disabled={disabled} />
      <ToolsEditor value={value} onChange={onChange} disabled={disabled} />
      <RawFlagsEditor value={value} onChange={onChange} disabled={disabled} />
    </div>
  );
}
