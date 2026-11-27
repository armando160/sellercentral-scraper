// The pull. For each view (store + marketplace) in views.json for today:
// picks it in the Seller Central top bar, opens the reviews page, clicks ›
// through every page (up to 20) like a person would, and saves each page of
// reviews the page loads. At the end it switches back to the home view
// (LIFEPRO OUTLET / United States), uploads to Google Sheets and sends ONE email.
//
//   npm run pull                          today's views (Mon: Lifepro NA, Tue: Joyberri + Sunello, Wed: Lifepro UK/SA/TR, Thu: Lifepro US)
//   npm run pull -- --day=tuesday         another day's views
//   npm run pull -- --view="Joyberri LLC/CA"   one view (can repeat)
//   npm run pull -- --all                 every enabled view
//
// Views can live on different Seller Central sites (US, UK, Saudi Arabia,
// Turkey; see "sites" in views.json), each with its own sign-in. It never
// signs in: if one site is signed out, only that site's views are skipped.
//
// Exit codes: 0 ok, 2 sign-in needed, 1 error (in at least one view).
import fs from 'node:fs';
import path from 'node:path';
import { openBrowser, isSignedOut, confirmSignedOut, onReviewsData, findNext, clickNext, politeDelay, sleep } from './lib/browser.js';
import { selectView, checkView, SwitchError } from './lib/switcher.js';
import { rowsFromResponse } from './lib/bcr.js';
import { openDb, upsertReview, saveRaw, startRun, finishRun, saveViewRun, markMissing } from './lib/db.js';
import { uploadToSheets } from './lib/sheets.js';
import { notify, healthcheck } from './lib/notify.js';
import { esc, htmlTable, H, P } from './lib/emailhtml.js';
import { loadViews, pickViews, waitingViews, viewKey, viewName, reviewLink, siteName, siteUrl } from './lib/views.js';
import { config } from './lib/config.js';
import { takeLock } from './lib/lock.js';
import { statusRows, STATUS_HEAD } from './lib/status.js';
import { rebuildKpis } from './lib/kpi.js';

const log = (msg) => console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`);

const data = loadViews();
let views;
try { views = pickViews(data); } catch (err) { console.error(err.message); process.exit(1); }
const dayArg = process.argv.find((a) => a.startsWith('--day='))?.slice(6);
const manual = process.argv.some((a) => a.startsWith('--view=') || a === '--all');
const day = dayArg || new Date().toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
const runName = manual ? 'Manual' : day[0].toUpperCase() + day.slice(1);
if (!views.length) { log(`No views to pull on ${day}. See views.json.`); process.exit(0); }
log(`${runName} pull: ${views.map(viewName).join(', ')}`);

// One browser job at a time (the Vendor Central pull may be running).
const release = await takeLock(`Seller Central pull (${runName})`, { log });
if (!release) { log('Another browser job is still running after 45 minutes. Stopping.'); process.exit(1); }

const db = openDb();
const runId = startRun(db);
let { context, page } = await openBrowser();

// The view being read right now. Data the page loads is only kept while a
// view is set, and only after the top bar was checked (until then it waits).
let cur = null;

function take(text, url) {
  let json;
  try { json = JSON.parse(text); } catch { return; }
  const { view, res } = cur;
  saveRaw(db, runId, url, text, viewKey(view));
  if (Number.isFinite(json.totalReviewCount)) res.amazon_total = json.totalReviewCount;
  let fresh = 0;
  for (const r of rowsFromResponse(json)) {
    res.seen += 1;
    if (r.review_date && (!res.oldest || r.review_date < res.oldest)) res.oldest = r.review_date;
    if (upsertReview(db, r, view) === 'new') {
      fresh += 1;
      res.new_reviews += 1;
      if (r.rating >= 1 && r.rating <= 5) res.stars[r.rating] += 1;
      if (r.parent_asin) res.asins.set(r.parent_asin, (res.asins.get(r.parent_asin) || 0) + 1);
      if (r.rating && r.rating <= 2) { res.low_star_new += 1; res.newLowStar.push(r); }
    }
  }
  cur.loaded += 1;
  log(`  ${viewName(view)} page ${json.pageId + 1}: ${json.reviews?.length ?? 0} reviews, ${fresh} new`);
}

function listen() {
  onReviewsData(page, async (url, text) => {
    if (!cur) return;
    if (!cur.checked) { cur.queue.push([text, url]); return; }
    take(text, url);
  });
}
listen();

async function waitForPage(target, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cur.loaded >= target) return true;
    await sleep(250);
  }
  return false;
}

async function snapshot(tag) {
  const dir = path.join(config.root, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `run-${runId}-${tag.replace(/[^\w-]+/g, '_')}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  return file;
}

const loginNeeded = (msg) => Object.assign(new Error(msg), { kind: 'login_needed' });

async function pullView(view, res) {
  cur = null;
  await selectView(page, view);

  cur = { view, res, loaded: 0, checked: false, queue: [] };
  await page.goto(view.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  if (await isSignedOut(page, { url: view.url, tag: viewName(view) })) throw loginNeeded('Signed out');
  await checkView(page, view);
  cur.checked = true;
  for (const [text, url] of cur.queue.splice(0)) take(text, url);

  if (!(await waitForPage(1, 45000))) {
    throw new Error(`Reviews didn't load. Screenshot: ${await snapshot(`${viewName(view)}-no-data`)}`);
  }
  res.pages = 1;

  while (res.pages < config.maxPages) {
    const next = await findNext(page);
    if (!next) break;
    await politeDelay();
    await clickNext(page, next);
    if (await isSignedOut(page, { tag: viewName(view) })) throw loginNeeded('Signed out mid-run');
    if (!(await waitForPage(res.pages + 1))) {
      throw new Error(`Page ${res.pages + 1} didn't load. Screenshot: ${await snapshot(`${viewName(view)}-stuck-p${res.pages + 1}`)}`);
    }
    res.pages += 1;
  }
}

const results = [];
const signedOutSites = new Set(); // Seller Central sites that are signed out

async function runView(view, i) {
  const res = { view, status: 'ok', pages: 0, seen: 0, new_reviews: 0, low_star_new: 0,
    amazon_total: null, note: null, newLowStar: [], stars: [0, 0, 0, 0, 0, 0], asins: new Map() };
  if (signedOutSites.has(view.site)) { res.status = 'not_run'; res.note = `not run: ${siteName(data, view.site)} signed out`; return res; }
  if (i > 0) { await politeDelay(); await politeDelay(); } // a short break between views
  log(`${viewName(view)} (${view.store} / ${view.marketplace})`);
  const readStartedAt = new Date().toISOString();
  try {
    await pullView(view, res);
    res.missing = markMissing(db, view, readStartedAt, res.oldest);
    if (res.missing) log(`  ${viewName(view)}: ${res.missing} saved reviews no longer on the page (removed?). Kept, marked missing.`);
  } catch (err) {
    const msg = String(err.message || err).split('\n')[0].slice(0, 300);
    if (err.kind === 'login_needed') { res.status = 'login_needed'; signedOutSites.add(view.site); }
    else if (err instanceof SwitchError && (err.kind === 'not_available' || err.kind === 'other_site')) res.status = 'skipped';
    else res.status = 'error';
    res.note = msg;
    console.error(`  ${viewName(view)}: ${msg}`);
  }
  cur = null;
  log(`  ${viewName(view)}: ${res.status}, ${res.pages} pages, ${res.new_reviews} new, Amazon shows ${res.amazon_total ?? '?'}`);
  return res;
}

for (const [i, view] of views.entries()) results.push(await runView(view, i));

// Second opinion before telling anyone a site is signed out. On 25 Nov 2026
// the pulls said UK/Turkey/US were signed out on a shaky connection, and a
// fresh Chrome one minute later was signed in everywhere (see confirmSignedOut).
// Signed in after all = pull those views again. Can't tell = "failed", not
// "signed out" (the morning check retries failed pulls).
if (signedOutSites.size) {
  await context.close().catch(() => {});
  const verdicts = new Map();
  for (const site of signedOutSites) {
    const verdict = await confirmSignedOut({ url: siteUrl(data, site), profileDir: config.profileDir, tag: site });
    log(`Second check of ${siteName(data, site)}: ${{ signed_out: 'really signed out', signed_in: 'signed in after all', unknown: "can't tell (internet?)" }[verdict]}.`);
    verdicts.set(site, verdict);
  }
  ({ context, page } = await openBrowser());
  listen();
  for (const [site, verdict] of verdicts) {
    if (verdict === 'signed_out') continue;
    signedOutSites.delete(site);
    for (const [i, res] of results.entries()) {
      if (res.view.site !== site || !['login_needed', 'not_run'].includes(res.status)) continue;
      if (verdict === 'signed_in') results[i] = await runView(res.view, 1);
      else { res.status = 'error'; res.note = `Amazon showed a sign-in page, but the second check could not confirm it (internet?): ${res.note}`; }
    }
  }
}
for (const res of results) saveViewRun(db, runId, viewKey(res.view), res);

// Leave the browser on the home view, so your own Seller Central tabs are back to normal.
let homeNote = null;
if (!signedOutSites.has(data.home.site)) {
  try {
    await politeDelay();
    await selectView(page, data.home);
    log(`Back to ${data.home.store} / ${data.home.marketplace}.`);
  } catch (err) {
    homeNote = `Could not switch back to ${data.home.store} / ${data.home.marketplace}: ${err.message}`;
    console.error(homeNote);
  }
}
await context.close();

const sum = (k) => results.reduce((a, r) => a + (r[k] || 0), 0);
const totals = { pages: sum('pages'), seen: sum('seen'), new_reviews: sum('new_reviews'),
  low_star_new: sum('low_star_new'), amazon_total: sum('amazon_total'), uploaded: 0 };
const failed = results.filter((r) => r.status === 'error');
const signedOut = signedOutSites.size > 0;
const signedOutNames = [...signedOutSites].map((x) => siteName(data, x)).join(', ');
let status = signedOut ? 'login_needed' : failed.length ? 'error' : 'ok';
let note = [...results.filter((r) => r.note).map((r) => `${viewName(r.view)}: ${r.note}`), homeNote]
  .filter(Boolean).join(' | ') || null;

// Upload even after a partial run: whatever we got is real.
let uploadError = null;
try {
  totals.uploaded = await uploadToSheets(db, log);
} catch (err) {
  uploadError = err.message;
  note = [note, `Sheets upload failed: ${err.message}`].filter(Boolean).join(' | ');
  if (status === 'ok') status = 'error';
  console.error(err.message);
}
finishRun(db, runId, { status, note, ...totals });

// ---- The email (plain text + an HTML version with real tables) ----
const brands = [...new Set(views.map((v) => v.brand))];
const monthsBack = db.prepare(`SELECT substr(review_date, 1, 7) m, sheet_brand b, COUNT(*) n,
    SUM(rating = 1) s1, SUM(rating = 2) s2, SUM(rating = 3) s3, SUM(rating = 4) s4, SUM(rating = 5) s5,
    ROUND(AVG(rating), 2) avg, COUNT(DISTINCT parent_asin) asins FROM reviews
  WHERE sheet_brand IN (${brands.map(() => '?').join(',')}) AND review_date >= ?
  GROUP BY m, b ORDER BY m DESC, b`)
  .all(...brands, new Date(Date.now() - 100 * 864e5).toISOString().slice(0, 7));
// Product names for the ASIN list.
const titleOf = (asin) => db.prepare(`SELECT product_title t FROM reviews WHERE parent_asin = ?
  ORDER BY review_ts DESC LIMIT 1`).get(asin)?.t ?? '';
const allAsins = new Map();
for (const r of results) for (const [a, n] of r.asins) {
  const k = `${a}|${viewName(r.view)}`;
  allAsins.set(k, { asin: a, view: viewName(r.view), n });
}
const topAsins = [...allAsins.values()].sort((a, b) => b.n - a.n).slice(0, 10)
  .map((x) => ({ ...x, title: titleOf(x.asin) }));
try { rebuildKpis(db); log('KPI tables rebuilt.'); } catch (e) { log(`KPI tables not rebuilt (${e.message}). The morning check retries.`); }
const dataRows = statusRows(db); // "Latest data available" table
db.close();

const fmt = (n) => (n == null ? '?' : Number(n).toLocaleString('en-US'));
const avgOf = (st) => {
  const n = st.reduce((a, b) => a + b, 0);
  return n ? (st.reduce((a, c, i) => a + c * i, 0) / n).toFixed(2) : '-';
};
const STATUS = { ok: 'ok', skipped: 'skipped', error: 'FAILED', login_needed: 'SIGNED OUT', not_run: 'not run' };
const totalStars = [0, 1, 2, 3, 4, 5].map((i) => results.reduce((a, r) => a + r.stars[i], 0));
const totalAsins = new Set(results.flatMap((r) => [...r.asins.keys()])).size;

// Headline and what to do, same in both versions.
const intro = [];
if (status === 'login_needed') {
  const got = results.filter((r) => r.status === 'ok').length;
  intro.push(`The ${runName} pull is missing views: signed out of ${signedOutNames}.` +
    (got ? ` The other ${got} views were pulled.` : ''), '',
    'Fix: double-click "Amazon Sign In" on the Desktop and sign in where Chrome asks.',
    "It re-runs today's pull by itself once you are in.");
} else if (failed.length) {
  intro.push(`The ${runName} pull finished, but ${failed.length} of ${results.length} views FAILED (see below).`,
    'Screenshots are in the logs/ folder. To retry one view:',
    `  npm run pull -- --view="${failed[0].view.store}/${failed[0].view.code}"`);
} else {
  intro.push(`The ${runName} pull finished: ${fmt(totals.new_reviews)} new reviews on ${totalAsins} products (parent ASINs).`);
}
const notes = [];
for (const r of results.filter((x) => x.note)) notes.push(`${viewName(r.view)}: ${r.note}`);
for (const r of results.filter((x) => x.amazon_total > 1000)) {
  notes.push(`${viewName(r.view)} has ${fmt(r.amazon_total)} reviews in 90 days. The page shows the newest 1,000, which is fine for a weekly pull.`);
}
const waiting = manual ? [] : waitingViews(data, day);
if (waiting.length) notes.push(`Not pulled yet (waiting for access): ${waiting.map((v) => viewName(v)).join(', ')}`);
if (homeNote) notes.push(homeNote);
notes.push(uploadError ? `Google Sheet upload FAILED: ${uploadError}` : `Sent to Google Sheet: ${fmt(totals.uploaded)}`);

const viewRows = results.map((r) => [viewName(r.view), fmt(r.new_reviews), ...r.stars.slice(1).map(fmt),
  avgOf(r.stars), fmt(r.asins.size), fmt(r.amazon_total), STATUS[r.status]]);
const totalRow = ['Total', fmt(totals.new_reviews), ...totalStars.slice(1).map(fmt), avgOf(totalStars), fmt(totalAsins), '', ''];
const viewHead = ['View', 'New', '1 star', '2 star', '3 star', '4 star', '5 star', 'Avg', 'ASINs', 'Amazon 90 days', 'Status'];
// Months across the top (oldest to newest), one block of rows per brand.
const monthKeys = [...new Set(monthsBack.map((m) => m.m))].sort();
const monthLabel = (k) => new Date(`${k}-15T12:00:00`).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
const monthHead = ['Brand', 'What', ...monthKeys.map(monthLabel)];
const MONTH_LINES = [['Reviews', 'n'], ['1 star', 's1'], ['2 star', 's2'], ['3 star', 's3'], ['4 star', 's4'],
  ['5 star', 's5'], ['Avg stars', 'avg'], ['ASINs', 'asins']];
const monthRows = brands.flatMap((b) => MONTH_LINES.map(([label, f], i) => [i ? '' : b, label, ...monthKeys.map((k) => {
  const m = monthsBack.find((x) => x.m === k && x.b === b);
  if (!m) return '-';
  return f === 'avg' ? Number(m.avg).toFixed(2) : fmt(m[f]);
})]));
const asinHead = ['Parent ASIN', 'View', 'New', 'Product'];
const asinRows = topAsins.map((x) => [x.asin, x.view, fmt(x.n), (x.title || '').slice(0, 70)]);
const lows = results.flatMap((r) => r.newLowStar.map((x) => ({ ...x, view: r.view })))
  .sort((a, b) => (b.review_ts || '').localeCompare(a.review_ts || '')).slice(0, 10);

// Plain text
const textTable = (head, rows) => {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  return [head, ...rows].map((r) => r.map((c, i) => (i === 0 || ['Status', 'Product', 'What', 'Source', 'Note'].includes(head[i]) ? String(c).padEnd(w[i]) : String(c).padStart(w[i]))).join('  ').trimEnd());
};
const lines = [...intro, '', 'New reviews this run:', ...textTable(viewHead, [...viewRows, totalRow]), '', ...notes];
if (asinRows.length) lines.push('', `Products with the most new reviews (${totalAsins} products got reviews):`, ...textTable(asinHead, asinRows));
lines.push('', 'Reviews per month, by brand:', ...textTable(monthHead, monthRows));
lines.push('', 'Latest data available (all sources):', ...textTable(STATUS_HEAD, dataRows));
if (lows.length) {
  lines.push('', `Newest 1-2 star reviews (${lows.length} of ${totals.low_star_new}; all are in the sheet):`);
  for (const x of lows) {
    lines.push('', `${x.rating} star, ${viewName(x.view)}, ${x.review_date}, ${x.parent_asin}`,
      `  "${x.title ?? ''}": ${(x.body ?? '').slice(0, 200)}`, `  ${reviewLink(x.review_id, x.view.code)}`);
  }
}

// HTML (helpers in lib/emailhtml.js)
let html = `<div style="font:13px Arial,sans-serif;color:#222">`;
html += intro.map((t) => (t.startsWith('  ') ? `<pre style="margin:2px 0">${esc(t)}</pre>` : P(t))).join('');
html += H('New reviews this run') + htmlTable(viewHead, [...viewRows, totalRow], true);
html += notes.map(P).join('');
if (asinRows.length) html += H(`Products with the most new reviews (${totalAsins} products got reviews)`) + htmlTable(asinHead, asinRows);
html += H('Reviews per month, by brand') + htmlTable(monthHead, monthRows);
html += H('Latest data available (all sources)') + htmlTable(STATUS_HEAD, dataRows);
if (lows.length) {
  html += H(`Newest 1-2 star reviews (${lows.length} of ${totals.low_star_new}; all are in the sheet)`);
  html += lows.map((x) => `<p style="font:13px Arial,sans-serif;margin:8px 0"><b>${x.rating} star</b>, ${esc(viewName(x.view))}, ${esc(x.review_date)}, ${esc(x.parent_asin)}<br>
"${esc(x.title)}": ${esc((x.body ?? '').slice(0, 200))}<br><a href="${reviewLink(x.review_id, x.view.code)}">Open on Amazon</a></p>`).join('');
}
html += '</div>';

const title = status === 'login_needed' ? `ACTION NEEDED: sign in to ${signedOutNames} (${runName} pull)`
  : failed.length ? `${runName} pull: ${failed.length} of ${results.length} views FAILED`
    : uploadError ? `${runName} pull: Sheet upload FAILED`
      : `${runName}: ${fmt(totals.new_reviews)} new reviews on ${totalAsins} products, avg ${avgOf(totalStars)}`;
const short = status === 'login_needed'
  ? `Signed out of ${signedOutNames}. Double-click "Amazon Sign In" on the Mac.`
  : `${totals.new_reviews} new reviews on ${totalAsins} products (avg ${avgOf(totalStars)} stars) across ${results.length} views.` +
    (failed.length ? ` FAILED: ${failed.map((r) => viewName(r.view)).join(', ')}.` : '');

log(`Run ${runId}: ${short}`);
await notify({ title, short, emailText: lines.join('\n'), emailHtml: html, kind: 'pull' });
await healthcheck(status === 'ok');
process.exitCode = { ok: 0, login_needed: 2 }[status] ?? 1;
