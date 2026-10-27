/**
 * `<ThemeToggle />` — pure presentational theme cycler (PR #26 D5).
 * Cycles system → light → dark; state lives in `useTheme` (App).
 */
import * as React from 'react';

import type { ResolvedTheme, ThemePreference } from '../lib/theme.ts';
import { nextThemePreference } from '../lib/theme.ts';
import { cn } from '../lib/utils.ts';

const LABELS: Record<ThemePreference, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

export interface ThemeToggleProps {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  onChange: (next: ThemePreference) => void;
  className?: string;
}

export function ThemeToggle(props: ThemeToggleProps): React.ReactElement {
  const { preference, resolved, onChange, className } = props;
  const label = LABELS[preference];
  return (
    <button
      data-test="theme-toggle"
      data-preference={preference}
      data-resolved={resolved}
      type="button"
      aria-label={`Theme: ${label}`}
      title={`Theme: ${label} — click to switch`}
      onClick={() => onChange(nextThemePreference(preference))}
      className={cn(
        'rounded px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
        className,
      )}
    >
      {`${resolved === 'dark' ? '☾' : '☀'} ${label}`}
    </button>
  );
}
