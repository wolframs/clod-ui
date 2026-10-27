/**
 * `useTheme` — owns the theme side effects (PR #26 D4): localStorage
 * persistence, the `prefers-color-scheme` subscription, and applying
 * `data-theme` to `<html>`. Resolution logic is pure in `theme.ts`.
 *
 * The media listener always tracks the OS setting; whether it changes
 * the rendered theme falls out of `resolveTheme` — only a 'system'
 * preference follows it, a manual choice wins.
 *
 * Not a typed-client hook, so the I-2 discriminated template does not
 * apply: theme state is synchronous and always available.
 */
import * as React from 'react';

import type { ResolvedTheme, ThemePreference } from './theme.ts';
import { THEME_STORAGE_KEY, parseThemePreference, resolveTheme } from './theme.ts';

const MEDIA_QUERY = '(prefers-color-scheme: dark)';

export interface UseThemeReturn {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference(next: ThemePreference): void;
}

function readStoredPreference(): string | null {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    // Storage unavailable or not a real Storage (blocked cookies,
    // bare test DOMs) — fall back to 'system' via the parser.
    return null;
  }
}

export function useTheme(): UseThemeReturn {
  const [preference, setPreferenceState] = React.useState<ThemePreference>(() =>
    parseThemePreference(readStoredPreference()),
  );
  const [systemPrefersDark, setSystemPrefersDark] = React.useState<boolean>(
    () => window.matchMedia(MEDIA_QUERY).matches,
  );

  React.useEffect(() => {
    const mql = window.matchMedia(MEDIA_QUERY);
    const onChange = (ev: MediaQueryListEvent): void => setSystemPrefersDark(ev.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  const resolved = resolveTheme(preference, systemPrefersDark);

  React.useEffect(() => {
    document.documentElement.dataset['theme'] = resolved;
  }, [resolved]);

  const setPreference = React.useCallback((next: ThemePreference): void => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage unavailable (private mode) — the choice still applies
      // for this session via state.
    }
  }, []);

  return { preference, resolved, setPreference };
}
