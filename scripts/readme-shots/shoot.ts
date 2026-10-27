#!/usr/bin/env bun
/**
 * Drives the demo server (demo-server.ts, port 4619) with Playwright and
 * writes shot-light.png / shot-dark.png into the directory given as argv[2].
 * Light seeds two conversations through the UI; dark reloads and opens the
 * first one. Both end scrolled to the bottom of the live turn.
 */
import { chromium } from '@playwright/test';
const out = process.argv[2] ?? '.';
const browser = await chromium.launch();
for (const theme of ['light', 'dark'] as const) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 1040 },
    deviceScaleFactor: 2,
    colorScheme: theme,
  });
  await page.goto('http://127.0.0.1:4619/');
  if (theme === 'light') {
    // Seed: an older conversation, then the one on screen.
    const msgs = [
      'Attach this PNG and tell me what you see.',
      'What does the usage badge under each turn show?',
      'And why does turn 2 of a conversation start so much faster than turn 1?',
    ];
    for (const msg of msgs) {
      if (msg !== msgs[2]) await page.locator('[data-test="sidebar-new"]').click();
      const input = page.locator('[data-test="composer-input"]');
      await input.fill(msg);
      await input.press('Enter');
      await page
        .getByText(
          msg.includes('PNG')
            ? 'red square'
            : msg.includes('badge')
              ? 'dwarf everything'
              : 'checks before every turn',
        )
        .first()
        .waitFor({ timeout: 10000 });
      await page.waitForTimeout(1500);
    }
  } else {
    await page.locator('[data-test="sidebar-row"]').first().click();
    await page.waitForTimeout(300);
  }
  // Bottom of the conversation: the live turn's header (status, cache badge,
  // model) down to its tool card.
  await page.evaluate(() => {
    const sc = document.querySelector('[data-test="conversation-scroll"]') as HTMLElement;
    sc.scrollTop = sc.scrollHeight;
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/shot-${theme}.png` });
  await page.close();
}
await browser.close();
