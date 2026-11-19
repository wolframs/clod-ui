/**
 * Deep-tier E2E for the phone layout (PR #44): a Pixel-sized touch viewport
 * over the same hermetic engine as deep.spec.ts. Marker assertions only (I-3).
 * Spec: plans/2026-11-01-clod-ui-pr44-mobile-v1.md.
 */
import { expect, test, type Page } from '@playwright/test';

test.use({
  viewport: { width: 412, height: 780 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
});
test.describe.configure({ mode: 'serial' });

const marker = (page: Page, name: string) => page.locator(`[data-test="${name}"]`);

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(412);
}

async function send(page: Page, text: string): Promise<void> {
  await marker(page, 'composer-input').fill(text);
  await marker(page, 'composer-send').tap();
  await expect(marker(page, 'turn-view')).toHaveAttribute('data-state', 'completed', {
    timeout: 10_000,
  });
}

test('a tab ignores a reported status bar, a home-screen app clears it', async ({ page }) => {
  // What a WebView browser does: the inset is reported, the page is too tall by it.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', {
    insets: {
      top: 44,
      topMax: 44,
      left: 0,
      leftMax: 0,
      bottom: 24,
      bottomMax: 24,
      right: 0,
      rightMax: 0,
    },
  });
  await page.goto('/');
  await expect(marker(page, 'composer-input')).toBeVisible();

  const geometry = () =>
    page.evaluate(() => {
      const box = (name: string) =>
        document.querySelector(`[data-test="${name}"]`)!.getBoundingClientRect();
      return {
        barPadTop: parseFloat(
          getComputedStyle(document.querySelector('[data-test="mobile-top-bar"]')!).paddingTop,
        ),
        rootHeight: box('app-root').height,
        foot: box('mobile-controls-open').bottom,
        viewport: innerHeight,
      };
    });

  const tab = await geometry();
  expect(tab.barPadTop).toBe(4);
  expect(tab.rootHeight).toBe(tab.viewport - 44);
  expect(tab.foot).toBeLessThanOrEqual(tab.viewport - 44);

  // The emulator has no standalone mode; real fullscreen takes the same branch of the rule.
  await page.evaluate(() => document.documentElement.requestFullscreen());
  await expect.poll(async () => (await geometry()).barPadTop).toBe(44);
  const screen = await geometry();
  expect(screen.rootHeight).toBe(screen.viewport);
  await page.evaluate(() => document.exitFullscreen());

  await cdp.send('Emulation.setSafeAreaInsetsOverride', {
    insets: {
      top: 0,
      topMax: 0,
      left: 0,
      leftMax: 0,
      bottom: 0,
      bottomMax: 0,
      right: 0,
      rightMax: 0,
    },
  });
});

test('opens on a fresh composer, one pane, no sideways scroll', async ({ page }) => {
  await page.goto('/');
  await expect(marker(page, 'composer-input')).toBeVisible();
  await expect(marker(page, 'mobile-top-bar')).toBeVisible();
  await expect(marker(page, 'empty-pane')).toHaveCount(0);
  await expect(marker(page, 'sidebar')).toBeHidden();
  await expect(page).toHaveURL(/#\/c\/[0-9a-f-]+$/);
  await expectNoSidewaysScroll(page);
});

test('Enter is a newline, the button sends, a reload keeps the conversation', async ({ page }) => {
  await page.goto('/');
  const input = marker(page, 'composer-input');
  await input.tap();
  await input.pressSequentially('line one');
  await input.press('Enter');
  await expect(input).toHaveValue('line one\n');
  await expect(marker(page, 'turn-view')).toHaveCount(0);

  await send(page, 'hello from the phone');
  await expectNoSidewaysScroll(page);

  const url = page.url();
  await page.reload();
  expect(page.url()).toBe(url);
  await marker(page, 'mobile-menu').tap();
  await expect(
    page.locator(`[data-test="sidebar-row"][data-conv-id="${url.split('/').pop()}"]`),
  ).toHaveAttribute('data-selected', 'true');
});

test('the drawer lists conversations; picking one does not leave it in Back', async ({ page }) => {
  await page.goto('/');
  await send(page, 'first');
  const first = page.url();
  await marker(page, 'mobile-new').tap();
  await expect(marker(page, 'turn-view')).toHaveCount(0);
  await send(page, 'second');
  const second = page.url();
  expect(second).not.toBe(first);

  await marker(page, 'mobile-menu').tap();
  await expect(marker(page, 'sidebar')).toBeVisible();
  await expectNoSidewaysScroll(page);
  await page.locator(`[data-test="sidebar-row"][data-conv-id="${first.split('/').pop()}"]`).tap();
  await expect(marker(page, 'sidebar')).toBeHidden();
  await expect(page).toHaveURL(first);

  await page.goBack();
  await expect(page).toHaveURL(second);
  await expect(marker(page, 'sidebar')).toBeHidden();
});

test('Back closes the drawer and stays in the conversation', async ({ page }) => {
  await page.goto('/');
  await expect(marker(page, 'composer-input')).toBeVisible();
  const url = page.url();
  await marker(page, 'mobile-menu').tap();
  await expect(marker(page, 'sidebar')).toBeVisible();
  await page.goBack();
  await expect(marker(page, 'sidebar')).toBeHidden();
  await expect(page).toHaveURL(url);

  await marker(page, 'mobile-menu').tap();
  await marker(page, 'sidebar-close').tap();
  await expect(marker(page, 'sidebar')).toBeHidden();
});

test('a reload with the drawer open leaves no dead Back entry', async ({ page }) => {
  await page.goto('/');
  await send(page, 'first');
  const first = page.url();
  await marker(page, 'mobile-new').tap();
  await expect(page).not.toHaveURL(first);
  await marker(page, 'mobile-menu').tap();
  await page.reload();
  await expect(marker(page, 'sidebar')).toBeHidden();
  await page.goBack();
  await expect(page).toHaveURL(first);
});

test('a panel opened from the drawer replaces it; one Back closes it', async ({ page }) => {
  await page.goto('/');
  await marker(page, 'mobile-menu').tap();
  await marker(page, 'settings-open').tap();
  await expect(marker(page, 'settings-panel')).toBeVisible();
  await expect(marker(page, 'sidebar')).toBeHidden();
  await expectNoSidewaysScroll(page);
  await page.goBack();
  await expect(marker(page, 'settings-panel')).toHaveCount(0);
  await expect(marker(page, 'sidebar')).toBeHidden();
});

test('turn controls sit in a sheet; Back closes it', async ({ page }) => {
  await page.goto('/');
  await expect(marker(page, 'turn-controls')).toHaveCount(0);
  await marker(page, 'mobile-controls-open').tap();
  await expect(marker(page, 'mobile-controls-sheet')).toBeVisible();
  await expect(marker(page, 'turn-controls')).toBeVisible();
  await expectNoSidewaysScroll(page);
  await page.goBack();
  await expect(marker(page, 'mobile-controls-sheet')).toHaveCount(0);
});

test('the main controls are big enough for a thumb', async ({ page }) => {
  await page.goto('/');
  for (const name of ['mobile-menu', 'mobile-new', 'composer-attach', 'composer-send']) {
    const box = await marker(page, name).boundingBox();
    expect(box?.height, name).toBeGreaterThanOrEqual(40);
    expect(box?.width, name).toBeGreaterThanOrEqual(40);
  }
  // Under 16 px Chrome and Safari zoom the page on focus.
  const size = await marker(page, 'composer-input').evaluate((el) => getComputedStyle(el).fontSize);
  expect(parseFloat(size)).toBeGreaterThanOrEqual(16);
});
