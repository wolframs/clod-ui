/**
 * `<TurnControlsBar />` — model picker + thinking-effort segments for the
 * Composer's controls slot (Phase 5.1/5.2).
 *
 * Pure-ish (same precedent as Composer's textarea): the only local state
 * is whether the model select is in "Custom…" entry mode, which can't be
 * derived from `value` alone while the custom field is still empty. App
 * keys this component by conv_id so that state resets per conversation.
 *
 * Spec: plans/2026-06-10-clod-ui-pr24-turn-controls-v1.md §D6/D7;
 * PR #42 (plans/landed/2026-10-27-clod-ui-pr42-models-and-effort-v1.md §4–§5):
 * options come from the CLI's own model list, effort levels are the CLI's,
 * gated by what the selected model takes.
 */
import type { ModelInfo } from '@clod-ui/contracts';
import * as React from 'react';

import type { TurnControls } from '../lib/turn-controls.ts';
import {
  EFFORT_OPTIONS,
  KNOWN_MODELS,
  effortAllowed,
  isKnownModel,
  modelInfoFor,
  reconcileEffort,
} from '../lib/turn-controls.ts';
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
   * The CLI's own model list (PR #42, `GET /models`). Undefined while it
   * loads or when it cannot be had: the picker then offers KNOWN_MODELS.
   */
  models?: ModelInfo[];
  /**
   * Fallback labels: what each alias resolved to on this machine, learned
   * from earlier turns (`default` for no `--model`). Used without `models`.
   */
  resolvedModels?: Record<string, string>;
}

function modelLabel(alias: string, resolved: string | undefined): string {
  return resolved === undefined ? alias : `${alias} · ${resolved}`;
}

/** `Opus 5.5 · claude-opus-5-5`; the id alone once it adds nothing. */
function infoLabel(m: ModelInfo): string {
  const id = m.resolved_model ?? m.value;
  return id === m.display_name ? id : `${m.display_name} · ${id}`;
}

export function TurnControlsBar(props: TurnControlsBarProps): React.ReactElement {
  const { value, onChange, disabled = false, className, models, resolvedModels = {} } = props;

  const modelIsCustom = value.model !== undefined && !isKnownModel(value.model, models);
  const selectedInfo = modelInfoFor(models, value.model);
  const listedModels = models?.filter((m) => m.value !== 'default');
  const defaultInfo = modelInfoFor(models, undefined);
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
      onChange(reconcileEffort(rest, modelInfoFor(models, undefined)));
    } else {
      onChange(reconcileEffort({ ...value, model: selected }, modelInfoFor(models, selected)));
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
    // Auto composes the same argv as unset; store it as unset.
    if (effort === undefined || effort === 'auto') {
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
          <option value={MODEL_DEFAULT}>
            {defaultInfo !== undefined
              ? `Default · ${defaultInfo.resolved_model ?? defaultInfo.display_name}`
              : modelLabel('Default', resolvedModels['default'])}
          </option>
          {listedModels !== undefined
            ? listedModels.map((m) => (
                <option key={m.value} value={m.value} title={m.description}>
                  {infoLabel(m)}
                </option>
              ))
            : KNOWN_MODELS.map((m) => (
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
        aria-label="Effort"
        className="flex items-center gap-1 text-muted-foreground"
      >
        Effort
        {EFFORT_OPTIONS.map((opt) => {
          const selected =
            opt.value === 'auto'
              ? value.thinking_effort === undefined || value.thinking_effort === 'auto'
              : value.thinking_effort === opt.value;
          const allowed = effortAllowed(opt.value, selectedInfo);
          return (
            <button
              key={opt.value}
              data-test={`turn-controls-effort-${opt.value}`}
              data-selected={selected ? 'true' : 'false'}
              data-allowed={allowed ? 'true' : 'false'}
              type="button"
              title={
                allowed
                  ? opt.title
                  : `${selectedInfo?.display_name ?? 'This model'} does not take ${opt.label}`
              }
              disabled={disabled || !allowed}
              onClick={() => handleEffort(opt.value)}
              className={cn(segmentClass(selected), !allowed && 'cursor-not-allowed opacity-40')}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      <SystemPromptEditor value={value} onChange={onChange} disabled={disabled} />
      <ToolsEditor value={value} onChange={onChange} disabled={disabled} />
      <RawFlagsEditor value={value} onChange={onChange} disabled={disabled} />
    </div>
  );
}
