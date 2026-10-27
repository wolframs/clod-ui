/**
 * Variant tests for `<ThemeToggle />` (PR #26) — marker assertions (I-3).
 * The click → nextThemePreference cycle is dom-tested alongside useTheme.
 */
import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';

import { ThemeToggle } from '../src/components/theme-toggle.tsx';

const noop = (): void => {};

describe('ThemeToggle', () => {
  test('system preference carries both preference and resolved markers', () => {
    const html = renderToString(
      <ThemeToggle preference="system" resolved="dark" onChange={noop} />,
    );
    expect(html).toContain('data-test="theme-toggle"');
    expect(html).toContain('data-preference="system"');
    expect(html).toContain('data-resolved="dark"');
    expect(html).toContain('System');
  });

  test('manual light preference', () => {
    const html = renderToString(
      <ThemeToggle preference="light" resolved="light" onChange={noop} />,
    );
    expect(html).toContain('data-preference="light"');
    expect(html).toContain('data-resolved="light"');
    expect(html).toContain('Light');
  });

  test('manual dark preference', () => {
    const html = renderToString(<ThemeToggle preference="dark" resolved="dark" onChange={noop} />);
    expect(html).toContain('data-preference="dark"');
    expect(html).toContain('Dark');
  });
});
