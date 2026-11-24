// Morning check (9:00am and 1:00pm by the schedule): did today's pulls work?
//   1. Vendor Central (every day) and Seller Central (pull days): is there a
//      successful pull today?
//   2. If one failed for a reason a retry can fix (page didn't load, internet),
//      run it again now. At most 2 tries per day after the 6:00am one.
//      Signed out: no retry (the pull already emailed how to sign in).
//   3. Rebuild the KPI tables (the pulls do it too; this catches a failed rebuild).
//   4. Email: the 9:00am check ALWAYS emails (subject starts with "OK" or
//      "PROBLEM, open now"). The 1:00pm check emails only if something is
//      still wrong or was fixed since 9:00.
//
//   npm run check            (--force: email even at 1:00pm when all is good)
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { openDb } from './lib/db.js';
import { rebuildKpis } from './lib/kpi.js';
import { runKeepa } from './keepa-pull.js';
import { notify } from './lib/notify.js';
import { config } from './lib/config.js';
import { loadViews, pickViews, viewName } from './lib/views.js';
import { statusRows, STATUS_HEAD } from './lib/status.js';
import { esc, htmlTable, H, P, UL, wrap } from './lib/emailhtml.js';

const force = process.argv.includes('--force');
const today = new Date().toLocaleDateString('en-CA');
const localDay = (ts) => (ts ? new Date(ts).toLocaleDateString('en-CA') : null);
const log = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
const MAX_RETRIES = 2;

const scViews = pickViews(loadViews(), [], new Date());
const JOBS = [
  { key: 'vc', name: 'Vendor Central pull (review counts, star ratings, units)', table: 'vc_pulls', script: 'vc-pull.js', due: true },
  { key: 'sc', name: `Seller Central pull (written reviews: ${scViews.map(viewName).join(', ')})`, table: 'runs', script: 'scrape.js', due: scViews.length > 0 },
];

function todaysRuns(table) {
  const db = openDb();
  const rows = db.prepare(`SELECT id, status, note, started_at FROM ${table} WHERE started_at >= ? ORDER BY id`)
    .all(new Date(Date.now() - 36 * 3600e3).toISOString()).filter((r) => localDay(r.started_at) === today);
  db.close();
  return rows;
}

const report = [];
for (const job of JOBS) {
  if (!job.due) continue;
  let runs = todaysRuns(job.table);
  const ok = () => runs.some((r) => r.status === 'ok');
  if (ok()) { report.push({ job, state: 'ok', runs }); continue; }
  const last = runs.at(-1);
  // A "signed out" reading is retried too: on 24 Nov 2026 the 6:00am pull said
  // signed out while the saved sign-in was still good (see isSignedOut).
  // no status yet = still going, unless it started over 2 hours ago (it crashed)
  if (last && !last.status && Date.now() - new Date(last.started_at) < 2 * 3600e3) { report.push({ job, state: 'running', runs }); continue; }
  const retriesSoFar = Math.max(0, runs.length - 1);
  if (retriesSoFar >= MAX_RETRIES) { report.push({ job, state: 'gave_up', runs }); continue; }
  log(`${job.name}: ${last ? `failed (${last.status}: ${last.note ?? 'no note'})` : 'did not run'}. Trying again now.`);
  spawnSync(process.execPath, [job.script], { cwd: config.root, stdio: 'inherit' });
  runs = todaysRuns(job.table);
  report.push({ job, state: ok() ? 'fixed' : runs.at(-1)?.status === 'login_needed' ? 'signed_out' : 'failed', runs, retried: true });
}

// Keepa monthly history (lib/keepa.js): copy the teammate's sheet once a
// morning. Same content as last time = nothing stored. Never a PROBLEM by
// itself: Vendor Central is the main ratings source.
let keepaNote = null;
if (new Date().getHours() < 12) {
  try {
    const k = await runKeepa({ quiet: true });
    keepaNote = k.repeat ? `Keepa history: no new copy (sheet last updated ${k.keepaUpdated ?? '?'}, Karachi time).`
      : `Keepa history: new copy saved, ${k.months} ASIN-months (sheet updated ${k.keepaUpdated ?? '?'}, Karachi time).`;
  } catch (e) { keepaNote = `Keepa history not copied: ${e.message}`; }
  log(keepaNote);
}

let kpiNote = 'KPI tables rebuilt.';
try { const db = openDb(); rebuildKpis(db); db.close(); } catch (e) { kpiNote = `KPI tables NOT rebuilt: ${e.message}`; }
log(kpiNote);

for (const r of report) log(`${r.job.name}: ${r.state}`);
const bad = report.filter((r) => !['ok', 'running'].includes(r.state));
const kpiBad = kpiNote.includes('NOT');
const morning = new Date().getHours() < 12;
if (!morning && !bad.length && !force && !kpiBad) process.exit(0);
const problem = kpiBad || bad.some((r) => r.state !== 'fixed') || report.some((r) => r.state === 'running' && !morning);

const explain = {
  ok: 'worked.',
  running: 'still running (or stopped halfway). The 1:00pm check looks again.',
  fixed: 'failed at 6:00am, but worked when this check ran it again. Nothing to do.',
  signed_out: 'did not run: Amazon signed the Mac out. Double-click "Amazon Sign In" on the Desktop; it re-runs today\'s pull by itself once you are in.',
  failed: 'failed at 6:00am AND when this check ran it again. The 1:00pm check tries once more.',
  gave_up: 'failed 3 times today. No more tries today; tomorrow\'s pull runs as normal. Today\'s data is not lost for good: the next successful pull catches up (Vendor Central counts are cumulative; Seller Central shows the last 90 days).',
};
const lastNote = (r) => r.runs.at(-1)?.note;
const textTable = (head, rows) => {
  const w = head.map((h, i) => Math.max(String(h).length, ...rows.map((r) => String(r[i]).length)));
  return [head, ...rows].map((r) => '  ' + r.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd());
};
let dataTable = [];
let dataRows = null;
let dataError = null;
let kpiNewest = [];
try {
  const db = openDb();
  dataRows = statusRows(db);
  dataTable = textTable(STATUS_HEAD, dataRows);
  const k = db.prepare(`SELECT period_kind kind, MAX(period_start) newest FROM kpi_brand
    WHERE brand = 'All brands' GROUP BY 1`).all();
  kpiNewest = ['week', 'month'].map((kind) => [kind, k.find((x) => x.kind === kind)?.newest ?? 'none yet']);
  db.close();
} catch (e) { dataError = `(could not read: ${e.message})`; dataTable = [`  ${dataError}`]; }
const kpiLines = kpiNewest.map(([kind, d]) => `  Newest complete ${kind} in the KPI tables: ${d}`);
const dayName = new Date().toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'short' });
const headline = problem ? 'SOMETHING NEEDS YOU (details below).' : 'All good. Nothing to do.';
const happened = report.map((r) => ({ name: r.job.name, said: explain[r.state],
  note: lastNote(r) && r.state !== 'ok' && r.state !== 'fixed' ? lastNote(r) : null }));
const why = problem || bad.length ? [
  'The KPI tables (reviews and ratings per unit sold) need one Vendor Central snapshot per day and the',
  'weekly Seller Central pull. A missed day is filled from the day before when possible (marked in the',
  'tables); a missed week of Seller Central keeps that week "not complete" until the next pull.'] : null;
const todo = bad.some((r) => r.state === 'signed_out') ? ['Sign in: double-click "Amazon Sign In" on the Desktop.'] :
  bad.some((r) => ['failed', 'gave_up'].includes(r.state)) ? ['Usually nothing: retries are automatic. If this repeats 2 days in a row, look at the log:', path.join(config.root, 'logs')] :
  ['Nothing.'];
const about = [
  'The daily check of the Amazon reviews project on this Mac. At 9:00am it checks that today\'s 6:00am',
  'pulls worked, retries what failed, and always emails (subject starts with OK or PROBLEM). At 1:00pm',
  'it checks again and emails only if something is still wrong.',
  `Project folder: ${path.dirname(config.root)}`,
];
const para = (lines) => P(lines.join(' '));
const html = wrap([
  `<p style="font:bold 15px Arial,sans-serif;margin:4px 0 10px;color:${problem ? '#c00' : '#1a7f37'}">${esc(headline)}</p>`,
  H('What happened'),
  UL([...happened.map((h) => `<b>${esc(h.name)}</b>: ${esc(h.said)}${h.note ? `<br><span style="color:#555">Amazon/the script said: ${esc(h.note)}</span>` : ''}`), esc(kpiNote), ...(keepaNote ? [esc(keepaNote)] : [])]),
  kpiNewest.length ? htmlTable(['KPI tables', 'Newest complete period'], kpiNewest.map(([kind, d]) => [kind === 'week' ? 'Week' : 'Month', d])) : '',
  H('Latest data available'),
  dataRows ? htmlTable(STATUS_HEAD, dataRows) : P(dataError),
  why ? H('Why it matters') + para(why) : '',
  H('What to do'),
  P(todo[0]) + (todo[1] ? `<p style="font:12px Menlo,monospace;margin:4px 0">${esc(todo[1])}</p>` : ''),
  H('About this email'),
  `<p style="font:12px Arial,sans-serif;color:#555;margin:4px 0">${esc(about.slice(0, 3).join(' '))}<br>${esc(about[3])}</p>`,
].join('\n'));

const text = [
  headline,
  '',
  'WHAT HAPPENED',
  ...report.map((r) => `  - ${r.job.name}: ${explain[r.state]}${lastNote(r) && r.state !== 'ok' && r.state !== 'fixed' ? `\n    Amazon/the script said: ${lastNote(r)}` : ''}`),
  `  - ${kpiNote}`,
  ...(keepaNote ? [`  - ${keepaNote}`] : []),
  ...kpiLines,
  '',
  'LATEST DATA AVAILABLE',
  ...dataTable,
  '',
  ...(problem || bad.length ? ['WHY IT MATTERS',
    '  The KPI tables (reviews and ratings per unit sold) need one Vendor Central snapshot per day and the',
    '  weekly Seller Central pull. A missed day is filled from the day before when possible (marked in the',
    '  tables); a missed week of Seller Central keeps that week "not complete" until the next pull.',
    ''] : []),
  'WHAT TO DO',
  bad.some((r) => r.state === 'signed_out') ? '  Sign in: double-click "Amazon Sign In" on the Desktop.' :
    bad.some((r) => ['failed', 'gave_up'].includes(r.state)) ? `  Usually nothing: retries are automatic. If this repeats 2 days in a row, look at the log:\n  ${path.join(config.root, 'logs')}` :
    '  Nothing.',
  '',
  'ABOUT THIS EMAIL',
  '  The daily check of the Amazon reviews project on this Mac. At 9:00am it checks that today\'s 6:00am',
  '  pulls worked, retries what failed, and always emails (subject starts with OK or PROBLEM). At 1:00pm',
  '  it checks again and emails only if something is still wrong.',
  `  Project folder: ${path.dirname(config.root)}`,
].join('\n');

const what = report.map((r) => `${r.job.key === 'vc' ? 'Vendor Central' : 'Seller Central'} ${r.state === 'ok' ? 'worked' : r.state.replace('_', ' ')}`).join(', ');
await notify({
  emailHtml: html,
  title: problem ? `PROBLEM, open now: ${what} (${dayName})`
    : bad.length ? `OK after a retry: ${what} (${dayName})` : `OK: ${what} (${dayName})`,
  short: report.map((r) => `${r.job.key.toUpperCase()}: ${r.state}`).join(', '),
  emailText: text,
  kind: 'check',
  statusFirst: true,
});
