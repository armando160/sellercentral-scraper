// Copies the Keepa "Review History" sheet (monthly ratings per ASIN, US only)
// into the database. See lib/keepa.js for what is saved and why.
//
//   npm run keepa                      read the sheet through our Apps Script web app
//   npm run keepa -- --file x.json     import a saved copy ({ keepa_updated, state, meta, sku_view })
//   npm run keepa -- --tabs STATE META SKU [--updated "Mon 23 Nov 2026, 20:18"]
//                                      import three Sheets API value dumps ({ values: [...] })
//
// check.js runs it every morning; a copy identical to the last one is only
// noted (repeat_of), so running it daily costs nothing.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openDb } from './lib/db.js';
import { importKeepa, fetchKeepaSheet } from './lib/keepa.js';
import { rebuildKpis } from './lib/kpi.js';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const log = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);

export async function runKeepa({ quiet = false } = {}) {
  let payload; let source = 'web app';
  if (opt('--file')) {
    payload = JSON.parse(fs.readFileSync(opt('--file'), 'utf8')); source = 'file';
  } else if (args.includes('--tabs')) {
    const i = args.indexOf('--tabs');
    const tab = (p) => (p ? JSON.parse(fs.readFileSync(p, 'utf8')).values : null);
    payload = { state: tab(args[i + 1]), meta: tab(args[i + 2]), sku_view: tab(args[i + 3]), keepa_updated: opt('--updated') };
    source = 'file';
  } else {
    payload = await fetchKeepaSheet();
  }
  const db = openDb();
  try {
    const r = importKeepa(db, payload, { source });
    if (!quiet) log(r.repeat ? `Keepa: same as the last copy (pull ${r.pullId}), nothing new.`
      : `Keepa: pull ${r.pullId}, ${r.months} ASIN-months, ${r.asins} ASINs, ${r.skus} SKU links (sheet updated ${payload.keepa_updated ?? '?'}).`);
    if (!r.repeat) { rebuildKpis(db); if (!quiet) log('KPI tables rebuilt.'); }
    return { ...r, keepaUpdated: payload.keepa_updated ?? null };
  } finally { db.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runKeepa().catch((e) => { console.error(`Keepa copy failed: ${e.message}`); process.exit(1); });
}
