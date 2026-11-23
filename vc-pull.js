// The daily Vendor Central pull (see PLAN-vendor-central.md).
//
// Opens the "Armando Review & Rating View" dashboard like a person, scrolls
// down through its 4 tables (the lower ones only load when scrolled to),
// keeps the data the page itself loaded for each (it has each column's
// refresh date), clicks Export once on the 12-month table and keeps Amazon's
// file too. All saved untouched; the rows go into data/reviews.db.
//
// The tables (set up 22 Nov 2026, see PLAN-vendor-central.md):
//   A "Reviews & Shipped Units"  Month to date   review count + rating (new launches)
//   B "Ratings, 12 Months"       Trailing 12 mo  review count + rating (everything that sold in a year)
//   C "Last Week"                last full week  shipped + ordered units
//   D "Last Month"               last full month shipped + ordered units
//
// Quiet when all is well (one line in the log). Emails only when something
// needs you, and every email explains what this is and what to do.
//
//   npm run vc-pull
//
// Exit codes: 0 ok, 2 sign-in needed, 1 error.
import fs from 'node:fs';
import path from 'node:path';
import { openBrowser, needsLogin, sleep } from './lib/browser.js';
import { openDb } from './lib/db.js';
import { notify } from './lib/notify.js';
import { takeLock } from './lib/lock.js';
import { config } from './lib/config.js';
import { rebuildKpis } from './lib/kpi.js';
import {
  METRIC_PATH, parseMetricData, compareExport, sha256, readHeader, tilePeriod,
  startVcPull, finishVcPull, saveVcRows, saveVcUnits, earlierSnapshot,
} from './lib/vc.js';

const log = (msg) => console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`);
const pause = (a, b) => sleep((a + Math.random() * (b - a)) * 1000);
const outDir = path.join(path.dirname(config.dbPath), 'vc');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// Every email starts with what this is, so it makes sense weeks from now.
const ABOUT = [
  'What this is: every morning this Mac opens your Vendor Central dashboard',
  '"Armando Review & Rating View" and saves the review count, star rating and',
  'shipped units for every ASIN. With the written reviews (Seller Central, weekly)',
  'this gives star-only ratings, reviews per unit, and removed reviews.',
  `Project folder: ${path.dirname(config.root)}`,
  'Details: sellercentral-scraper/PLAN-vendor-central.md',
];
const SIGN_IN_STEPS = [
  'Takes 2 minutes, on the Mac:',
  '  1. Double-click "Amazon Sign In" on the Desktop.',
  '  2. Sign in where Chrome asks (password, code, tick "Keep me signed in").',
  '     The window closes by itself when you are in, and the missed pull runs then.',
];

async function tell({ title, short, what, why, fix, ifIgnored }) {
  const text = [
    `WHAT HAPPENED\n${what}`,
    why && `WHY IT MATTERS\n${why}`,
    fix && `WHAT TO DO\n${fix}`,
    ifIgnored && `IF YOU DO NOTHING\n${ifIgnored}`,
    `ABOUT THIS EMAIL\n${ABOUT.join('\n')}`,
  ].filter(Boolean).join('\n\n');
  await notify({ title: `Vendor Central: ${title}`, short, emailText: text, kind: 'vc' });
}

const release = await takeLock('Vendor Central pull', { log });
if (!release) {
  log('Another browser job is still running after 45 minutes. Skipping today.');
  await tell({
    title: 'pull skipped today', short: 'Another pull was still running after 45 minutes.',
    what: 'The daily Vendor Central pull waited 45 minutes for another browser job on this Mac\n(the Seller Central review pull or a sign-in window) and then gave up for today.',
    why: "Today's review count is lost (Amazon only shows the current count). One missing day is fine.",
    fix: 'Nothing, unless it happens again tomorrow. Then check logs/ in the project folder\nfor a pull that never finished, or a sign-in window left open.',
    ifIgnored: 'Tomorrow it tries again.',
  });
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(path.join(config.root, 'logs'), { recursive: true });
const db = openDb();
const pullId = startVcPull(db);
const { context, page } = await openBrowser({ profileDir: config.vcProfileDir });

const tiles = []; // { text, req } per table, in the order they loaded
page.on('response', async (res) => {
  if (!res.url().includes(METRIC_PATH) || res.status() !== 200) return;
  try { tiles.push({ text: await res.text(), req: res.request().postData() }); } catch {}
});
const EXPECTED = ['mtd', 'trailing12', 'week', 'month'];
const SETUP_FIX = '1. Open the dashboard:\n   ' + config.vcUrl +
  '\n2. It should have 4 tables (tiles), each with its Time Period(s) picked from the list:' +
  '\n   A "Reviews & Shipped Units": Month to date. Metrics: ASIN, Customer review count, Raw star ratings,' +
  '\n     Brand name, Parent ASIN, Color Name, Shipped Units, Brand Name' +
  '\n   B "Ratings, 12 Months": T12M (under Trailing). Same metrics as A' +
  '\n   C "Last Week": the top Week. Metrics: ASIN, Parent ASIN, Shipped Units, Ordered units' +
  '\n   D "Last Month": the top Month. Same metrics as C' +
  '\n3. Check it says "Saved" at the top. Nothing else: tomorrow\'s pull picks it up.';

async function fail(status, note, mail, code = 1) {
  const shot = path.join(config.root, 'logs', `vc-${stamp}.png`);
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  finishVcPull(db, pullId, { status, note });
  await context.close().catch(() => {});
  db.close();
  log(`${status}: ${note}`);
  await tell(mail);
  release();
  process.exit(code);
}

try {
  log('Opening the Vendor Central dashboard.');
  await page.goto(config.vcUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await pause(3, 6);

  if (await needsLogin(page)) {
    await fail('login_needed', 'Vendor Central is signed out', {
      title: 'ACTION NEEDED: sign in', short: 'Vendor Central is signed out. Double-click "Amazon Sign In" on the Desktop.',
      what: "This morning's Vendor Central pull found Vendor Central signed out,\nso nothing was saved today.",
      why: "The review count only exists for the current day: today's is lost if nobody signs in.\nShipped units are not lost (they can be pulled later).",
      fix: SIGN_IN_STEPS.join('\n'),
      ifIgnored: 'It tries again every morning and sends this email each day until you sign in.',
    }, 2);
  }

  // Wait for the first tables, then scroll down like a person reading, so
  // the lower tables load too.
  const until = Date.now() + 90000;
  while (!tiles.length && Date.now() < until) await sleep(1000);
  if (!tiles.length) {
    await fail('error', "The tables' data never loaded", {
      title: "tables didn't load", short: "The dashboard tables didn't load. Screenshot in logs/.",
      what: "The dashboard opened but its tables never loaded in 90 seconds.\nA screenshot is in the project's logs/ folder (vc-<date>.png).",
      why: "Today's review count wasn't saved.",
      fix: '1. Open the dashboard in Chrome and check it loads:\n   ' + config.vcUrl +
        '\n2. If it loads fine, ignore this: Amazon was slow. Tomorrow tries again.' +
        '\n3. If it looks different (renamed, deleted, moved), tell Claude in this project folder.',
      ifIgnored: 'It tries again tomorrow.',
    });
  }
  await pause(2, 4);
  await page.mouse.move(400 + Math.random() * 400, 300 + Math.random() * 200, { steps: 8 }).catch(() => {});
  let quietSince = Date.now(), seen = tiles.length;
  const scrollUntil = Date.now() + 60000;
  while (Date.now() < scrollUntil) {
    await page.mouse.wheel(0, 300 + Math.random() * 250).catch(() => {});
    await pause(1.2, 2.8);
    if (tiles.length !== seen) { seen = tiles.length; quietSince = Date.now(); }
    const atBottom = await page.evaluate(() => innerHeight + scrollY >= document.body.scrollHeight - 5).catch(() => true);
    if (tiles.length >= EXPECTED.length && Date.now() - quietSince > 3000) break;
    if (atBottom && Date.now() - quietSince > 8000) break;
  }

  const header = readHeader(await page.locator('body').innerText().catch(() => ''));
  const parsedTiles = tiles.map((t, i) => {
    const file = path.join(outDir, `${stamp}-table${i + 1}.json`);
    fs.writeFileSync(file, JSON.stringify({ request: t.req, response: t.text }));
    return { ...parseMetricData(t.text), period: tilePeriod(t.req), file };
  });
  const ratingTiles = parsedTiles.filter((t) => t.has('TOTAL_RATING_COUNT'));
  const unitTiles = parsedTiles.filter((t) => t.has('QUANTITY_SHIPPED'));
  const missingKinds = EXPECTED.filter((k) => !parsedTiles.some((t) => t.period.kind === k));
  const broken = ratingTiles.flatMap((t) => t.missing);
  if (!ratingTiles.length || broken.length) {
    await fail('error', ratingTiles.length ? `Columns missing: ${[...new Set(broken)].join(', ')}` : 'No table with Customer review count', {
      title: 'the dashboard changed', short: 'The dashboard no longer has the review count columns. Nothing saved.',
      what: `The dashboard's tables don't have what the pull needs${broken.length ? ` (missing: ${[...new Set(broken)].join(', ')})` : ' (no table with Customer review count)'}.\nSomeone may have changed a table or "Edit metrics". Nothing was added to the database, to avoid half data.`,
      why: "Today's review count wasn't saved.",
      fix: SETUP_FIX,
      ifIgnored: 'It fails every day with this email until the tables are back.',
    });
  }

  // Review counts: every ASIN from the rating tables (A first, then B).
  // The same ASIN must show the same count in both; differences are noted.
  ratingTiles.sort((x, y) => (x.period.kind === 'mtd' ? -1 : 0) - (y.period.kind === 'mtd' ? -1 : 0));
  const byAsin = new Map();
  let disagree = 0;
  for (const t of ratingTiles) {
    for (const r of t.rows) {
      const had = byAsin.get(r.asin);
      if (!had) byAsin.set(r.asin, { ...r, shipped_units: t.period.kind === 'mtd' ? r.shipped_units : null });
      else if (had.rating_count !== r.rating_count || had.raw_rating !== r.raw_rating) disagree++;
    }
  }
  const parsed = {
    rows: [...byAsin.values()],
    columnDates: ratingTiles[0].columnDates,
    commonDate: ratingTiles[0].commonDate,
    ratingsDate: ratingTiles.map((t) => t.ratingsDate).filter(Boolean).sort().pop() ?? null,
    unitsDate: unitTiles.map((t) => t.unitsDate).filter(Boolean).sort().pop() ?? null,
  };
  const exportTile = ratingTiles.find((t) => t.period.kind === 'trailing12') || ratingTiles[0];

  // Export: one click, like a person. Amazon's own file is the backup.
  let exportPath = null, exportSha = null, exportMatches = null, exportNote = null;
  try {
    // The Export button of the 12-month table (its tile mentions "12 months").
    const tile12 = page.locator('div').filter({ hasText: /12 months/i })
      .filter({ has: page.locator('[data-testid="btn-export"]') }).last();
    const btn = (await tile12.count()) ? tile12.locator('[data-testid="btn-export"]').first()
      : page.locator('[data-testid="btn-export"]').first();
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn.hover();
    await pause(0.4, 1.2);
    const waitDl = page.waitForEvent('download', { timeout: 30000 });
    await btn.click();
    let dl = await waitDl.catch(() => null);
    if (!dl) {
      // Some exports open a small menu first: click the first Export/Download choice in it.
      const choice = page.getByRole('menuitem', { name: /export|download|excel|xlsx/i })
        .or(page.getByRole('button', { name: /^(export|download)/i })).last();
      if (await choice.isVisible().catch(() => false)) {
        const waitDl2 = page.waitForEvent('download', { timeout: 30000 });
        await pause(0.5, 1.5);
        await choice.click();
        dl = await waitDl2.catch(() => null);
      }
    }
    if (!dl) throw new Error('no file came after clicking Export');
    exportPath = path.join(outDir, `${stamp}-export.xlsx`);
    await dl.saveAs(exportPath);
    const buf = fs.readFileSync(exportPath);
    exportSha = sha256(buf);
    const cmp = compareExport(buf, exportTile.rows);
    exportMatches = cmp.ok ? 1 : 0;
    if (!cmp.ok) exportNote = `Export file differs from the page data: ${cmp.note}`;
  } catch (e) {
    exportNote = `Export file not saved (${e.message.split('\n')[0]}). The page data was saved.`;
  }

  saveVcRows(db, pullId, parsed);
  const unitNotes = [];
  for (const t of unitTiles) {
    const complete = saveVcUnits(db, pullId, t.period, t);
    if (['week', 'month'].includes(t.period.kind)) {
      unitNotes.push(`${t.period.kind} ${t.period.start} to ${t.period.end}: ${t.rows.length} ASINs${complete ? '' : ' (units not final yet)'}`);
    }
  }
  const repeat = earlierSnapshot(db, parsed.ratingsDate, pullId);
  const setupOk = missingKinds.length === 0;
  const notes = [exportNote,
    disagree ? `${disagree} ASINs had different counts in the two rating tables` : null,
    setupOk ? null : `Tables missing: ${missingKinds.join(', ')}`].filter(Boolean);
  finishVcPull(db, pullId, {
    status: 'ok', note: notes.join('; ') || null,
    page_updated: header.pageUpdated,
    period_text: parsedTiles.map((t) => `${t.period.kind} ${t.period.start} to ${t.period.end}`).join('; '),
    period_ok: setupOk ? 1 : 0,
    channel_text: header.channel, view_text: header.view,
    common_date: parsed.commonDate, ratings_date: parsed.ratingsDate, units_date: parsed.unitsDate,
    rows: parsed.rows.length, data_path: path.relative(config.root, exportTile.file),
    export_path: exportPath && path.relative(config.root, exportPath), export_sha256: exportSha,
    export_matches: exportMatches, repeat_of: repeat,
  });
  let famNote = '';
  try {
    rebuildKpis(db);
    famNote = ' KPI tables rebuilt.';
  } catch (e) { famNote = ` KPI tables not rebuilt (${e.message}). The morning check retries.`; }
  log(`Saved review counts for ${parsed.rows.length} ASINs (as of ${parsed.ratingsDate})` +
    `${repeat ? ` (same snapshot as pull ${repeat})` : ''}. Units: ${unitNotes.join('; ') || 'none'}.` +
    `${notes.length ? ` Note: ${notes.join('; ')}` : ''}${famNote}`);

  await pause(1, 3);
  await context.close();
  db.close();

  if (!setupOk) {
    await tell({
      title: 'dashboard tables changed', short: `Tables missing: ${missingKinds.join(', ')}. Review counts were saved.`,
      what: `The dashboard should have 4 tables. These were not found today: ${missingKinds.map((k) =>
        ({ mtd: 'A (Month to date)', trailing12: 'B (12 months)', week: 'C (Last week)', month: 'D (Last month)' }[k])).join(', ')}.\n` +
        `Found: ${parsedTiles.map((t) => `${t.period.kind} ${t.period.start} to ${t.period.end}`).join('; ')}.`,
      why: 'Review counts from the tables that loaded were saved. Missing A or B = some ASINs not tracked today.\nMissing C or D = no weekly or monthly units.',
      fix: SETUP_FIX,
      ifIgnored: 'It keeps saving what it finds, and sends this email every day.',
    });
  }
  if (exportNote) log(exportNote); // not worth an email: the page data has everything
  release();
} catch (e) {
  await fail('error', e.message.split('\n')[0], {
    title: 'pull failed', short: e.message.split('\n')[0],
    what: `The Vendor Central pull stopped with this error:\n  ${e.message.split('\n')[0]}\nA screenshot is in the project's logs/ folder (vc-<date>.png).`,
    why: "Today's review count wasn't saved.",
    fix: "If it happens once, nothing: tomorrow tries again. If it happens 2 days in a row,\nopen Claude in the project folder and say: \"the Vendor Central pull is failing\".",
    ifIgnored: 'It tries again tomorrow.',
  });
}
