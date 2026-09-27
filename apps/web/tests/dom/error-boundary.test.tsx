/**
 * ErrorBoundary tests — vitest+RTL+happy-dom tier.
 *
 * Error boundaries require a real reconciler (renderToString from
 * react-dom/server doesn't run lifecycle methods like
 * componentDidCatch / getDerivedStateFromError). All four branches
 * are exercised here:
 *
 *   - children render verbatim when no descendant throws
 *   - thrown error from a child is caught and the default fallback
 *     renders with data-state="error" + visible message + Reload button
 *   - long messages truncate with ellipsis in body + full text in title
 *   - caller-provided fallback prop is used in lieu of the default
 *
 * Note on selectors: the project uses `data-test=` (singular) per
 * docs/INVARIANTS.md I-3, while RTL's `getByTestId` defaults to
 * `data-testid`. We query via `container.querySelector('[data-test=...]')`
 * to keep the marker convention uniform across renderToString and
 * vitest tiers.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { ErrorBoundary } from '../../src/components/error-boundary.tsx';

afterEach(() => {
  cleanup();
});

function Boom({ message }: { message: string }): never {
  throw new Error(message);
}

test('renders children verbatim when no error is thrown', () => {
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { container } = render(
    <ErrorBoundary>
      <p data-test="child">hello world</p>
    </ErrorBoundary>,
  );
  const child = container.querySelector('[data-test="child"]');
  expect(child).not.toBeNull();
  expect(child?.textContent).toBe('hello world');
  expect(container.querySelector('[data-test="error-boundary"]')).toBeNull();
  errSpy.mockRestore();
});

test('catches a thrown render error and shows the default fallback', () => {
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { container } = render(
    <ErrorBoundary>
      <Boom message="kaboom" />
    </ErrorBoundary>,
  );
  const fallback = container.querySelector('[data-test="error-boundary"]');
  expect(fallback).not.toBeNull();
  expect(fallback?.getAttribute('data-state')).toBe('error');
  expect(fallback?.getAttribute('role')).toBe('alert');
  expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  expect(screen.getByText('kaboom')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  // The boundary logs the error via console.error in componentDidCatch
  // (plus React itself logs the rendered error). Assert the spy was
  // called with the boundary's structured payload at least once.
  expect(
    errSpy.mock.calls.some(
      (call) => call[0] === '[ErrorBoundary] caught render error' && typeof call[1] === 'object',
    ),
  ).toBe(true);
  errSpy.mockRestore();
});

test('truncates very long error messages with ellipsis but keeps full text in title', () => {
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const long = 'x'.repeat(500);
  render(
    <ErrorBoundary>
      <Boom message={long} />
    </ErrorBoundary>,
  );
  // The visible <pre> body should contain ellipsis and be truncated;
  // the full message should appear verbatim in the title attribute.
  const pre = screen.getByTitle(long);
  expect(pre.textContent ?? '').toContain('\u2026');
  expect((pre.textContent ?? '').length).toBeLessThan(long.length);
  errSpy.mockRestore();
});

test('uses caller-provided fallback when supplied', () => {
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { container } = render(
    <ErrorBoundary fallback={(error) => <span data-test="custom">CUSTOM:{error.message}</span>}>
      <Boom message="hi" />
    </ErrorBoundary>,
  );
  const custom = container.querySelector('[data-test="custom"]');
  expect(custom).not.toBeNull();
  expect(custom?.textContent).toBe('CUSTOM:hi');
  expect(container.querySelector('[data-test="error-boundary"]')).toBeNull();
  errSpy.mockRestore();
});
