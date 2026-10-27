/**
 * `<SettingsPanel />` — modal preferences editor over CC's real
 * `settings.json` (Phase 5.4).
 *
 * Discriminated render over `SettingsState`; the `ok` variant owns a
 * local form draft (Composer-textarea precedent) reset whenever the
 * loaded settings object changes (adjust-on-prop, PR #19.1 pattern).
 * Every write goes through the diff confirmation view — that preview is
 * the deliberateness gate before touching the real file (PR #30 D4);
 * the engine side is already atomic + `.bak` (I-6). The `unknown`
 * bucket renders read-only and is carried verbatim by `applyDraft`.
 *
 * Spec: plans/2026-06-12-clod-ui-pr30-preferences-ui-v1.md §D2–D6.
 */
import type { ClaudeSettings } from '@clod-ui/contracts';
import { ClaudeThemeSchema } from '@clod-ui/contracts';
import * as React from 'react';

import type { SettingsDraft } from '../lib/settings-form.ts';
import { applyDraft, diffSettings, draftFromSettings } from '../lib/settings-form.ts';
import type { SettingsState } from '../lib/use-settings.ts';
import { cn } from '../lib/utils.ts';

export interface SettingsPanelProps {
  open: boolean;
  state: SettingsState;
  onClose: () => void;
  onSave: (next: ClaudeSettings) => void;
}

const EMPTY_DRAFT: SettingsDraft = {
  theme: '',
  model: '',
  allowedToolsText: '',
  disallowedToolsText: '',
};

const FIELD_CLASS =
  'rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

export function SettingsPanel(props: SettingsPanelProps): React.ReactElement | null {
  const { open, state, onClose, onSave } = props;

  const loaded = state.status === 'ok' ? state.settings : null;
  const [draft, setDraft] = React.useState<SettingsDraft>(
    loaded ? draftFromSettings(loaded) : EMPTY_DRAFT,
  );
  const [confirming, setConfirming] = React.useState(false);

  // Re-init the draft whenever the loaded document changes identity
  // (initial load, post-save response, refetch on reopen).
  const trackedRef = React.useRef<ClaudeSettings | null>(loaded);
  if (trackedRef.current !== loaded) {
    trackedRef.current = loaded;
    setDraft(loaded ? draftFromSettings(loaded) : EMPTY_DRAFT);
    setConfirming(false);
  }

  if (!open) return null;

  const next = loaded ? applyDraft(loaded, draft) : null;
  const diff = loaded && next ? diffSettings(loaded, next) : [];
  const saving = state.status === 'ok' && state.saving;
  const dataState = state.status === 'ok' && confirming ? 'confirming' : state.status;

  const set = (patch: Partial<SettingsDraft>): void => {
    setDraft((d) => ({ ...d, ...patch }));
  };

  return (
    <div
      data-test="settings-panel"
      data-state={dataState}
      role="dialog"
      aria-label="Settings"
      onClick={onClose}
      className="absolute inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm"
    >
      <div
        onClick={(ev) => ev.stopPropagation()}
        className="flex max-h-[80%] w-[28rem] flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-card p-4 shadow-lg"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Settings</h2>
          <button
            data-test="settings-close"
            type="button"
            onClick={onClose}
            className="rounded px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Close
          </button>
        </div>

        {state.status === 'loading' && (
          <p className="text-xs text-muted-foreground">Loading settings…</p>
        )}

        {state.status === 'not_configured' && (
          <p className="text-xs text-muted-foreground">
            Settings are not configured on this engine. Restart with{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-foreground">--persist</code> to
            enable reading and editing{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-foreground">settings.json</code>.
          </p>
        )}

        {state.status === 'error' && (
          <p role="alert" className="text-xs text-destructive">
            Failed to load settings: {state.error.message}
          </p>
        )}

        {state.status === 'ok' && loaded && next && !confirming && (
          <div className="flex flex-col gap-2.5 text-xs">
            <label className="flex items-center justify-between gap-2 text-muted-foreground">
              Theme
              <select
                data-test="settings-theme"
                aria-label="Theme"
                value={draft.theme}
                disabled={saving}
                onChange={(ev) => set({ theme: ev.target.value as SettingsDraft['theme'] })}
                className={FIELD_CLASS}
              >
                <option value="">(unset)</option>
                {ClaudeThemeSchema.options.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center justify-between gap-2 text-muted-foreground">
              Model
              <input
                data-test="settings-model"
                aria-label="Model"
                type="text"
                value={draft.model}
                disabled={saving}
                placeholder="(unset)"
                onChange={(ev) => set({ model: ev.target.value })}
                className={cn(FIELD_CLASS, 'w-56')}
              />
            </label>
            <label className="flex flex-col gap-1 text-muted-foreground">
              Allowed tools (one per line)
              <textarea
                data-test="settings-allowed"
                aria-label="Allowed tools"
                rows={3}
                value={draft.allowedToolsText}
                disabled={saving}
                onChange={(ev) => set({ allowedToolsText: ev.target.value })}
                className={cn(FIELD_CLASS, 'resize-y font-mono')}
              />
            </label>
            <label className="flex flex-col gap-1 text-muted-foreground">
              Disallowed tools (one per line)
              <textarea
                data-test="settings-disallowed"
                aria-label="Disallowed tools"
                rows={3}
                value={draft.disallowedToolsText}
                disabled={saving}
                onChange={(ev) => set({ disallowedToolsText: ev.target.value })}
                className={cn(FIELD_CLASS, 'resize-y font-mono')}
              />
            </label>
            {loaded.unknown !== undefined && (
              <div className="flex flex-col gap-1 text-muted-foreground">
                Other keys (read-only, preserved on save)
                <pre
                  data-test="settings-unknown"
                  className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[10px] text-foreground"
                >
                  {JSON.stringify(loaded.unknown, null, 2)}
                </pre>
              </div>
            )}
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                data-test="settings-save"
                type="button"
                disabled={saving || diff.length === 0}
                onClick={() => setConfirming(true)}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-sm hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Save…
              </button>
            </div>
          </div>
        )}

        {state.status === 'ok' && loaded && next && confirming && (
          <div className="flex flex-col gap-2.5 text-xs">
            <p className="text-muted-foreground">
              This writes <code className="rounded bg-muted px-1 py-0.5">settings.json</code>{' '}
              (atomically, with a .bak):
            </p>
            <ul className="flex flex-col gap-1">
              {diff.map((row) => (
                <li
                  key={row.key}
                  data-test="settings-diff-row"
                  data-key={row.key}
                  className="flex items-baseline gap-2"
                >
                  <span className="font-medium text-foreground">{row.key}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {row.from} → {row.to}
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                data-test="settings-cancel-confirm"
                type="button"
                disabled={saving}
                onClick={() => setConfirming(false)}
                className="rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground hover:bg-accent"
              >
                Back
              </button>
              <button
                data-test="settings-confirm"
                type="button"
                disabled={saving}
                onClick={() => onSave(next)}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-sm hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Confirm'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
