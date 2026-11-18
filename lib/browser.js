// Browser helpers: open the saved Chrome profile, check sign-in,
// listen to the reviews data the page loads, click the › arrow.
import fs from 'node:fs';
import { chromium } from 'playwright';
import { config } from './config.js';
import { API_PATH } from './bcr.js';

export async function openBrowser({ headless = config.headless } = {}) {
  fs.mkdirSync(config.profileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(config.profileDir, {
    channel: config.browserChannel,
    headless,
    viewport: { width: 1440, height: 900 },
  });
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}

// True if Amazon is showing a sign-in, OTP or account-picker page.
export async function needsLogin(page) {
  if (/\/ap\/(signin|mfa|cvf)|\/signin|account-switcher/i.test(page.url())) return true;
  const n = await page.locator('input[type="password"]:visible, input#ap_email:visible, input#auth-mfa-otpcode:visible')
    .count().catch(() => 0);
  return n > 0;
}

// Calls onData(url, text) each time the PAGE ITSELF loads a page of reviews.
// We never call Amazon's API ourselves; we only read what the page receives.
export function onReviewsData(page, onData) {
  page.on('response', async (res) => {
    try {
      if (!res.url().includes(API_PATH) || res.status() !== 200) return;
      await onData(res.url(), await res.text());
    } catch {
      // Response bodies can vanish on navigation; ignore.
    }
  });
}

// The pager is Amazon's <kat-pagination>. The › arrow is the element with
// part="pagination-nav-right"; it gets the class "end" on the last page.
// Playwright's CSS selectors reach inside the component's shadow DOM.
const NEXT = 'kat-pagination [part="pagination-nav-right"]';

// Returns the › locator, or null if there is no next page.
export async function findNext(page) {
  const loc = page.locator(NEXT).first();
  if ((await loc.count().catch(() => 0)) === 0) return null;
  const disabled = await loc.evaluate((el) => el.classList.contains('end') ||
    el.getAttribute('aria-disabled') === 'true').catch(() => true);
  return disabled ? null : loc;
}

// Scroll down to the pager the way a person would, then click ›.
export async function clickNext(page, loc) {
  await loc.scrollIntoViewIfNeeded();
  await sleep(400 + Math.random() * 800);
  await loc.hover();
  await sleep(150 + Math.random() * 350);
  await loc.click();
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function politeDelay() {
  const { minDelaySec: a, maxDelaySec: b } = config;
  return sleep((a + Math.random() * (b - a)) * 1000);
}

export async function waitForEnter(prompt) {
  process.stdout.write(prompt);
  await new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
  });
}
