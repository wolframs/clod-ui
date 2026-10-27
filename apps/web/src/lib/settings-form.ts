/**
 * Pure form layer for the preferences UI (Phase 5.4) — draft shape,
 * field codecs, document assembly, and the diff that gates every PUT.
 *
 * The draft holds the documented keys as form-friendly strings; the
 * `unknown` bucket never enters the draft and is carried verbatim by
 * `applyDraft` (read-only by PR #30 D3/D4 — a raw-JSON editor is a
 * different risk class).
 *
 * Spec: plans/2026-06-12-clod-ui-pr30-preferences-ui-v1.md §D3/D4.
 */
import type { ClaudeSettings, ClaudeTheme } from '@clod-ui/contracts';

/** Form-friendly projection of the documented keys. */
export interface SettingsDraft {
  /** '' = unset. */
  theme: '' | ClaudeTheme;
  /** Trimmed; '' = unset. */
  model: string;
  /** Newline-separated entries; blank lines ignored. */
  allowedToolsText: string;
  disallowedToolsText: string;
}

export function linesToList(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function listToLines(list: string[] | undefined): string {
  return (list ?? []).join('\n');
}

export function draftFromSettings(settings: ClaudeSettings): SettingsDraft {
  return {
    theme: settings.theme ?? '',
    model: settings.model ?? '',
    allowedToolsText: listToLines(settings.allowedTools),
    disallowedToolsText: listToLines(settings.disallowedTools),
  };
}

/**
 * Assemble the full document to PUT: documented keys from the draft
 * (empty → key omitted), `unknown` carried verbatim from `current`.
 */
export function applyDraft(current: ClaudeSettings, draft: SettingsDraft): ClaudeSettings {
  const next: ClaudeSettings = {};
  if (draft.theme !== '') next.theme = draft.theme;
  const model = draft.model.trim();
  if (model.length > 0) next.model = model;
  const allowed = linesToList(draft.allowedToolsText);
  if (allowed.length > 0) next.allowedTools = allowed;
  const disallowed = linesToList(draft.disallowedToolsText);
  if (disallowed.length > 0) next.disallowedTools = disallowed;
  if (current.unknown !== undefined) next.unknown = current.unknown;
  return next;
}

export interface SettingsDiffRow {
  key: 'theme' | 'model' | 'allowedTools' | 'disallowedTools';
  /** Human-readable; '(unset)' for an absent key. */
  from: string;
  to: string;
}

const renderValue = (v: string | string[] | undefined): string => {
  if (v === undefined) return '(unset)';
  return Array.isArray(v) ? v.join(', ') : v;
};

/**
 * Documented-key diff between the loaded document and what `applyDraft`
 * would write. Empty array = nothing to save.
 */
export function diffSettings(current: ClaudeSettings, next: ClaudeSettings): SettingsDiffRow[] {
  const rows: SettingsDiffRow[] = [];
  for (const key of ['theme', 'model', 'allowedTools', 'disallowedTools'] as const) {
    const from = current[key];
    const to = next[key];
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      rows.push({ key, from: renderValue(from), to: renderValue(to) });
    }
  }
  return rows;
}
