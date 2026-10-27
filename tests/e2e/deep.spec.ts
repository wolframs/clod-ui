/**
 * Deep-tier E2E (PR #36, goal S11): the six pinned scenarios over the
 * BUILT SPA + real engine + ChaosBackend(ScriptedBackend). Marker
 * assertions only (I-3). Serial — scenarios share one engine.
 */
import { expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

test('boot: SPA loads and the health badge reports ok', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-test="empty-pane"]')).toBeVisible();
  await expect(page.locator('[data-test="health-badge"]').first()).toHaveAttribute(
    'data-state',
    'ok',
  );
});

test('new conversation → streamed turn renders → completes', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('n'); // PR #27 keymap
  const input = page.locator('[data-test="composer-input"]');
  await expect(input).toBeVisible();
  await input.fill('hello deep tier');
  await input.press('Enter');

  const turnView = page.locator('[data-test="turn-view"]');
  await expect(turnView).toHaveAttribute('data-state', 'streaming');
  await expect(page.locator('[data-test="assistant-message"]')).toContainText('Streaming');
  await expect(turnView).toHaveAttribute('data-state', 'completed', { timeout: 10_000 });
  await expect(page.locator('[data-test="assistant-message"]')).toContainText(
    'Streaming response from the deep tier.',
  );
});

test('cancel mid-stream → cancelled state', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('n');
  const input = page.locator('[data-test="composer-input"]');
  await input.fill('cancel me');
  await input.press('Enter');

  const cancel = page.locator('[data-test="composer-cancel"]');
  await expect(cancel).toBeVisible();
  await cancel.click();
  await expect(page.locator('[data-test="turn-view"]')).toHaveAttribute('data-state', 'cancelled', {
    timeout: 10_000,
  });
});

test('reconnect banner appears when the stream drops, then clears', async ({ page, request }) => {
  await page.goto('/');
  await page.keyboard.press('n');
  await expect(page.locator('[data-test="composer-input"]')).toBeVisible();

  const res = await request.post('/_test/drop-sockets');
  expect(res.ok()).toBeTruthy();

  const banner = page.locator('[data-test="connection-banner"]');
  await expect(banner).toHaveAttribute('data-state', 'reconnecting', { timeout: 5_000 });
  // The transport reconnects on its own; the banner clears.
  await expect(banner).toHaveCount(0, { timeout: 10_000 });
});

test('controls change argv observably (diagnostics route)', async ({ page, request }) => {
  await page.goto('/');
  await page.keyboard.press('n');
  await page.locator('[data-test="turn-controls-model"]').selectOption('sonnet');
  const input = page.locator('[data-test="composer-input"]');
  await input.fill('with a model');
  await input.press('Enter');
  await expect(page.locator('[data-test="turn-view"]')).toHaveAttribute('data-state', 'completed', {
    timeout: 10_000,
  });

  const res = await request.get('/diagnostics');
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { turns: Array<{ argv: string[] }> };
  const latest = body.turns[0];
  expect(latest).toBeTruthy();
  const argv = latest!.argv;
  expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet');
});
