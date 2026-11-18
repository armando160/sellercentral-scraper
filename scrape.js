// The pull: opens the reviews page, clicks › through every page (up to 20)
// like a person would, and saves each page of reviews the page loads.
// Then uploads new and changed reviews to Google Sheets.
//   npm run pull
//
// It never signs in. If the session expired it stops and tells you to run
// "npm run login".
//
// Exit codes: 0 ok, 2 sign-in needed, 1 error.
import fs from 'node:fs';
import path from 'node:path';
import { openBrowser, needsLogin, onReviewsData, findNext, clickNext, politeDelay, sleep } from './lib/browser.js';
import { rowsFromResponse } from './lib/bcr.js';
import { openDb, upsertReview, saveRaw, startRun, finishRun } from './lib/db.js';
import { uploadToSheets } from './lib/sheets.js';
import { notify, healthcheck } from './lib/notify.js';
import { config } from './lib/config.js';

const db = openDb();
const runId = startRun(db);
const totals = { pages: 0, seen: 0, new_reviews: 0, low_star_new: 0, amazon_total: null, uploaded: 0 };
let loaded = 0; // pages of data received so far
const newLowStar = []; // new 1 and 2 star reviews, for the email

const log = (msg) => console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`);
const { context, page } = await openBrowser();

onReviewsData(page, async (url, text) => {
  let json;
  try { json = JSON.parse(text); } catch { return; }
  saveRaw(db, runId, url, text);
  if (Number.isFinite(json.totalReviewCount)) totals.amazon_total = json.totalReviewCount;
  let fresh = 0;
  for (const r of rowsFromResponse(json)) {
    totals.seen += 1;
    if (upsertReview(db, r) === 'new') {
      fresh += 1;
      totals.new_reviews += 1;
      if (r.rating && r.rating <= 2) { totals.low_star_new += 1; newLowStar.push(r); }
    }
  }
  loaded += 1;
  log(`page ${json.pageId + 1}: ${json.reviews?.length ?? 0} reviews, ${fresh} new`);
});

async function waitForPage(target, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (loaded >= target) return true;
    await sleep(250);
  }
  return false;
}

async function snapshot(tag) {
  const dir = path.join(config.root, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `run-${runId}-${tag}`);
  await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
  return `${base}.png`;
}

let status = 'ok';
let note = null;

try {
  await page.goto(config.reviewsUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  if (await needsLogin(page)) {
    throw Object.assign(new Error('Signed out. Run: npm run login'), { status: 'login_needed' });
  }
  if (!(await waitForPage(1, 45000))) {
    throw new Error(`Reviews didn't load. Screenshot: ${await snapshot('no-data')}`);
  }
  totals.pages = 1;

  while (totals.pages < config.maxPages) {
    const next = await findNext(page);
    if (!next) { log('Last page.'); break; }
    await politeDelay();
    await clickNext(page, next);
    if (await needsLogin(page)) throw Object.assign(new Error('Signed out mid-run. Run: npm run login'), { status: 'login_needed' });
    if (!(await waitForPage(totals.pages + 1))) {
      throw new Error(`Page ${totals.pages + 1} didn't load. Screenshot: ${await snapshot(`stuck-p${totals.pages + 1}`)}`);
    }
    totals.pages += 1;
  }
} catch (err) {
  status = err.status || 'error';
  note = String(err.message || err).slice(0, 1000);
  console.error(note);
}
await context.close();

// Upload even after a partial run: whatever we got is real.
try {
  totals.uploaded = await uploadToSheets(db, log);
} catch (err) {
  note = [note, `Sheets upload failed: ${err.message}`].filter(Boolean).join(' | ');
  if (status === 'ok') status = 'error';
  console.error(err.message);
}

finishRun(db, runId, { status, note, ...totals });
const month = new Date().toISOString().slice(0, 7);
const mtd = db.prepare('SELECT COUNT(*) n FROM reviews WHERE substr(review_date, 1, 7) = ?').get(month).n;
const months = db.prepare(`SELECT substr(review_date, 1, 7) m, COUNT(*) n, SUM(rating <= 2) low, ROUND(AVG(rating), 2) avg
  FROM reviews GROUP BY m ORDER BY m DESC LIMIT 4`).all();
db.close();

const short = status === 'ok'
  ? `${totals.new_reviews} new reviews (${totals.low_star_new} are 1-2 star). ${mtd} so far this month.`
  : status === 'login_needed'
    ? 'Seller Central signed out. Run "npm run login" on the Mac, then "npm run pull".'
    : `FAILED: ${note}`;

const lines = [];
if (status === 'ok') {
  lines.push(`The weekly pull finished.`, '',
    `New reviews: ${totals.new_reviews}`,
    `New 1-2 star reviews: ${totals.low_star_new}`,
    `Pages read: ${totals.pages}`,
    `Amazon shows ${totals.amazon_total ?? '?'} reviews in the last 90 days.`,
    `Sent to Google Sheet: ${totals.uploaded}`);
} else if (status === 'login_needed') {
  lines.push('The pull could not run: Seller Central signed out.', '',
    'Fix (on the Mac, in Terminal):',
    '  cd "' + config.root + '"', '  npm run login     (sign in, press Enter)', '  npm run pull');
} else {
  lines.push('The pull FAILED.', '', `Error: ${note}`, '',
    `Pages read before it stopped: ${totals.pages}. New reviews saved: ${totals.new_reviews}.`,
    'A screenshot is in the logs/ folder. Try again with: npm run pull');
}
lines.push('', 'Reviews per month (newest first):');
for (const m of months) lines.push(`  ${m.m}: ${m.n} reviews, ${m.low} are 1-2 star, avg ${m.avg} stars`);
if (newLowStar.length) {
  lines.push('', 'New 1-2 star reviews:');
  for (const r of newLowStar.slice(0, 25)) {
    lines.push('', `${r.rating} star, ${r.review_date}, ${r.parent_asin}${r.child_asin ? ` / ${r.child_asin}` : ''}`,
      `  ${r.product_title ? r.product_title.slice(0, 90) : ''}`,
      `  "${r.title ?? ''}": ${(r.body ?? '').slice(0, 300)}`,
      `  https://www.amazon.com/gp/customer-reviews/${r.review_id}`);
  }
  if (newLowStar.length > 25) lines.push('', `...and ${newLowStar.length - 25} more in the sheet.`);
}

const title = status === 'ok' ? `${totals.new_reviews} new (${totals.low_star_new} low-star)`
  : status === 'login_needed' ? 'ACTION NEEDED: sign in' : 'PULL FAILED';
log(`Run ${runId}: ${short}`);
await notify({ title, short, emailText: lines.join('\n'), kind: 'pull' });
await healthcheck(status === 'ok');
process.exitCode = { ok: 0, login_needed: 2 }[status] ?? 1;
