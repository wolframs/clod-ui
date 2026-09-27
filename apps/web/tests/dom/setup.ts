/**
 * Vitest setup — registers `@testing-library/jest-dom` matchers and
 * wires React Testing Library's auto-cleanup hook.
 *
 * Loaded once before the test files run; configured via
 * `setupFiles` in `vitest.config.ts`.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
