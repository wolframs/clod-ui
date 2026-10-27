/**
 * Interaction tests for `useTheme` + `<ThemeToggle />` (PR #26) — storage,
 * matchMedia subscription, and the data-theme dataset application need a
 * real DOM. Pure resolution logic is bun-tested in tests/theme.test.ts.
 */
import { fireEvent, render, renderHook, act, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ThemeToggle } from '../../src/components/theme-toggle.tsx';
import { THEME_STORAGE_KEY } from '../../src/lib/theme.ts';
import { useTheme } from '../../src/lib/use-theme.ts';

type MediaListener = (ev: { matches: boolean }) => void;

/** Controllable stand-in for `matchMedia('(prefers-color-scheme: dark)')`. */
function installMatchMedia(initialDark: boolean): { setDark: (dark: boolean) => void } {
  let matches = initialDark;
  const listeners = new Set<MediaListener>();
  const mql = {
    get matches() {
      return matches;
    },
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_type: string, cb: MediaListener) => listeners.add(cb),
    removeEventListener: (_type: string, cb: MediaListener) => listeners.delete(cb),
  };
  (window as unknown as { matchMedia: unknown }).matchMedia = () => mql;
  return {
    setDark(dark: boolean) {
      matches = dark;
      listeners.forEach((cb) => cb({ matches: dark }));
    },
  };
}

/**
 * This happy-dom build exposes `window.localStorage` as a bare object with
 * no Storage API — install a Map-backed stand-in per test.
 */
function installLocalStorage(): void {
  const map = new Map<string, string>();
  const storage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, String(value)),
    removeItem: (key: string) => void map.delete(key),
  };
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
}

beforeEach(() => {
  installLocalStorage();
});

afterEach(() => {
  delete document.documentElement.dataset['theme'];
});

describe('useTheme', () => {
  it('defaults to system and applies the resolved theme to <html>', () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useTheme());
    expect(result.current.preference).toBe('system');
    expect(result.current.resolved).toBe('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });

  it('loads a stored manual preference on mount', () => {
    installMatchMedia(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    const { result } = renderHook(() => useTheme());
    expect(result.current.preference).toBe('dark');
    expect(result.current.resolved).toBe('dark');
  });

  it('setPreference persists and wins over the system setting', () => {
    const media = installMatchMedia(true);
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setPreference('light'));
    expect(result.current.resolved).toBe('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(document.documentElement.dataset['theme']).toBe('light');
    // A later OS flip must not override the manual choice.
    act(() => media.setDark(false));
    act(() => media.setDark(true));
    expect(result.current.resolved).toBe('light');
  });

  it('follows OS changes while preference is system', () => {
    const media = installMatchMedia(false);
    const { result } = renderHook(() => useTheme());
    expect(result.current.resolved).toBe('light');
    act(() => media.setDark(true));
    expect(result.current.resolved).toBe('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });
});

describe('ThemeToggle interaction', () => {
  it('click cycles the preference through the hook', () => {
    installMatchMedia(false);
    function Harness(): React.ReactElement {
      const theme = useTheme();
      return (
        <ThemeToggle
          preference={theme.preference}
          resolved={theme.resolved}
          onChange={theme.setPreference}
        />
      );
    }
    render(<Harness />);
    const button = (): HTMLElement => screen.getByRole('button');
    expect(button().getAttribute('data-preference')).toBe('system');
    fireEvent.click(button());
    expect(button().getAttribute('data-preference')).toBe('light');
    fireEvent.click(button());
    expect(button().getAttribute('data-preference')).toBe('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
    fireEvent.click(button());
    expect(button().getAttribute('data-preference')).toBe('system');
  });
});
