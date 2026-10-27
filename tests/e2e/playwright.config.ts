/**
 * Deep-tier Playwright config (PR #36, goal S11). Run via
 * `bun run ci:deep` (which builds the SPA first) or directly with
 * `bunx playwright test --config tests/e2e/playwright.config.ts`.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  // Scenarios share one engine process and build on each other — serial.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:4609',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'bun tests/e2e/serve-deep.ts',
    url: 'http://127.0.0.1:4609/health',
    cwd: '../..',
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
