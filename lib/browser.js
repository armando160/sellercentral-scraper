// Browser helpers: open the saved Chrome profile, check sign-in,
// listen to the reviews data the page loads, click the › arrow.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { config } from './config.js';
import { API_PATH } from './bcr.js';

export async function openBrowser({ headless = config.headless, profileDir = config.profileDir } = {}) {
  fs.mkdirSync(profileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: config.browserChannel,
    headless,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
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

// The real "are we signed out?" answer. Use this, not needsLogin, to decide.
// Amazon sometimes passes through /ap/signin for a few seconds while it
// re-checks a session that is still good, then sends you back (seen 24 Nov
// 2026: the 6:00am pull and a check both said "signed out" while the saved
// sign-in from the night before kept working all day). So: wait up to waitMs
// for the page to come back; if it doesn't, load the page once more and wait
// again. Only then say signed out, and keep a screenshot of what it showed.
export async function isSignedOut(page, { url, waitMs = 20000, tag = 'site' } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const until = Date.now() + waitMs;
    while (Date.now() < until) {
      if (!(await needsLogin(page).catch(() => true))) return false;
      await sleep(1000);
    }
    if (!url || attempt) break;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(3000);
  }
  try {
    const dir = path.join(config.root, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 16).replace(/:/g, '-');
    const file = path.join(dir, `signed-out-${String(tag).replace(/[^\w.-]+/g, '_')}-${stamp}`);
    await page.screenshot({ path: `${file}.png` });
    fs.writeFileSync(`${file}.txt`, `${new Date().toISOString()}
${page.url()}
`);
  } catch {}
  return true;
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
