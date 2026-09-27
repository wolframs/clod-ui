/**
 * Vitest configuration — DOM-aware test runner for `apps/web`.
 *
 * Companion to the existing `bun test` runner that lives at the repo
 * root. The two are non-overlapping by file location:
 *
 *   - bun test    → apps/web/tests/*.test.tsx (renderToString, no DOM)
 *   - vitest      → apps/web/tests/dom/**\/*.test.tsx (real DOM, async)
 *
 * Spec: plans/landed/2026-04-29-clod-ui-pr15-vitest-rtl-v1.md
 */
import path from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'happy-dom',
    globals: false,
    include: ['tests/dom/**/*.test.{ts,tsx}'],
    setupFiles: ['./tests/dom/setup.ts'],
  },
});
