/**
 * Theme vocabulary + resolution (Phase 7.2) — pure, no DOM access.
 *
 * Preference is what the user chose ('system' | 'light' | 'dark');
 * resolved is what the page renders ('light' | 'dark'). 'system' defers
 * to `prefers-color-scheme`; a manual choice wins. Side effects (storage,
 * matchMedia, dataset) live in `use-theme.ts`.
 *
 * Mirrored copy: the inline FOUC guard in `apps/web/index.html` re-derives
 * this resolve logic before first paint — keep the two in sync.
 *
 * Spec: plans/2026-06-12-clod-ui-pr26-dark-mode-v1.md §D3.
 */

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'clod-ui:theme';

const PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark'];

/** Unknown / absent stored values fall back to 'system'. */
export function parseThemePreference(raw: string | null): ThemePreference {
  return (PREFERENCES as readonly string[]).includes(raw ?? '')
    ? (raw as ThemePreference)
    : 'system';
}

export function resolveTheme(pref: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (pref === 'system') return systemPrefersDark ? 'dark' : 'light';
  return pref;
}

/** Toggle cycle: system → light → dark → system. */
export function nextThemePreference(pref: ThemePreference): ThemePreference {
  const idx = PREFERENCES.indexOf(pref);
  return PREFERENCES[(idx + 1) % PREFERENCES.length] as ThemePreference;
}
