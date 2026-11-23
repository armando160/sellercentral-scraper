// Vendor Central: reading the dashboard table's data and saving it.
// The page loads the whole table in one response from METRIC_PATH. We only
// read what the page itself received; we never call Amazon ourselves.
import crypto from 'node:crypto';
import { readXlsx } from './xlsx.js';

export const METRIC_PATH = '/ca/metricdata/api/v1/metricdata';

// Amazon's column ids -> our names.
export const COLS = {
  ASIN: 'asin', PARENT_ASIN: 'parent_asin', ITEM_NAME: 'item_name',
  PREFERRED_DISPLAY_NAME: 'brand_display', BRAND_NAME: 'brand_name', COLOR_NAME: 'color',
  TOTAL_RATING_COUNT: 'rating_count', RAW_RATING: 'raw_rating', QUANTITY_SHIPPED: 'shipped_units',
  TOTAL_ORDERED_UNITS: 'ordered_units',
};
// The pull stops if the table doesn't have these.
export const REQUIRED = ['ASIN', 'PARENT_ASIN', 'TOTAL_RATING_COUNT', 'RAW_RATING', 'QUANTITY_SHIPPED'];

// Same columns in the Export file (headers as Amazon writes them).
const FILE_COLS = { 'ASIN': 'asin', 'Customer review count': 'rating_count', 'Raw star ratings': 'raw_rating', 'Shipped Units': 'shipped_units' };

const ymd = (d) => (d && d.year ? `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}` : null);
// "30,978" -> 30978, "4.60" -> 4.6, "" / "-" -> null
export function num(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[,$\s]/g, '');
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// The page's data -> { commonDate, columnDates, rows, missing }
export function parseMetricData(text) {
  const json = typeof text === 'string' ? JSON.parse(text) : text;
  const md = json.metricsData;
  if (!md || !md.data || !Array.isArray(md.data.rowData)) throw new Error('Not the table data (no metricsData.data.rowData)');
  const columns = md.schema?.columns || [];
  const columnDates = columns.map((c) => ({ id: c.columnId, label: c.columnLabel, date: ymd(c.dataSetDate) }));
  const have = new Set(columns.map((c) => c.columnId));
  const missing = REQUIRED.filter((c) => !have.has(c));
  const rows = md.data.rowData.map((r) => {
    const out = { raw: JSON.stringify(r) };
    for (const [id, name] of Object.entries(COLS)) {
      const v = r[id];
      out[name] = ['rating_count', 'raw_rating', 'shipped_units', 'ordered_units'].includes(name) ? num(v) : (v ?? null);
    }
    return out;
  }).filter((r) => r.asin);
  const dateOf = (id) => columnDates.find((c) => c.id === id)?.date ?? null;
  return {
    has: (id) => have.has(id),
    commonDate: ymd(md.metadata?.commonDate),
    ratingsDate: dateOf('TOTAL_RATING_COUNT'),
    unitsDate: dateOf('QUANTITY_SHIPPED'),
    columnDates, rows, missing,
  };
}

// A table's time period, from the request the page sent for it:
// { start, end, kind } with kind week (Sun to Sat) | month (a whole month) |
// trailing12 (300+ days) | mtd (month to date) | other.
export function tilePeriod(reqText) {
  let r;
  try { r = (JSON.parse(reqText || '{}').dateRanges || [])[0]; } catch { r = null; }
  if (!r || !r.fromDate || !r.toDate) return { start: null, end: null, kind: 'unknown' };
  const d = (x) => `${x.slice(0, 4)}-${x.slice(4, 6)}-${x.slice(6, 8)}`;
  const start = d(String(r.fromDate)), end = d(String(r.toDate));
  const t0 = Date.parse(`${start}T00:00:00Z`), t1 = Date.parse(`${end}T00:00:00Z`);
  const days = Math.round((t1 - t0) / 864e5) + 1;
  const lastOfMonth = new Date(t1 + 864e5).getUTCDate() === 1;
  let kind = 'other';
  if (r.type === 'WEEKLY') kind = 'week';
  else if (r.type === 'MONTHLY') kind = 'month';
  else if (days >= 300) kind = 'trailing12';
  else if (days === 7 && new Date(t0).getUTCDay() === 0) kind = 'week';
  else if (start.endsWith('-01') && start.slice(0, 7) === end.slice(0, 7)) kind = lastOfMonth ? 'month' : 'mtd';
  return { start, end, kind, type: r.type ?? null };
}

// Compares Amazon's Export file with the page data. Returns { ok, note }.
export function compareExport(buf, rows) {
  const sheet = readXlsx(buf);
  const head = sheet[0] || [];
  const idx = {};
  head.forEach((h, i) => { if (FILE_COLS[h]) idx[FILE_COLS[h]] = i; });
  if (idx.asin === undefined) return { ok: false, note: 'Export file has no ASIN column' };
  const byAsin = new Map(rows.map((r) => [r.asin, r]));
  let checked = 0;
  const diffs = [];
  for (const line of sheet.slice(1)) {
    const asin = line[idx.asin];
    if (!asin || asin === 'Total') continue;
    const r = byAsin.get(asin);
    if (!r) { diffs.push(`${asin} only in the file`); continue; }
    checked++;
    for (const k of ['rating_count', 'raw_rating', 'shipped_units']) {
      if (idx[k] === undefined) continue;
      const a = num(line[idx[k]]), b = r[k];
      if (a !== b && !(a !== null && b !== null && Math.abs(a - b) < 0.0051)) diffs.push(`${asin} ${k}: file ${a}, page ${b}`);
    }
  }
  if (checked !== rows.length) diffs.push(`file has ${checked} of the page's ${rows.length} ASINs`);
  return { ok: diffs.length === 0, note: diffs.slice(0, 5).join('; ') };
}

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// What the page shows above the table. text = the page's visible text.
export function readHeader(fullText) {
  // Only look at the table's own header (the side menu also says "View").
  const at = fullText.indexOf('Data last updated on');
  const text = at >= 0 ? fullText.slice(at) : fullText;
  const line = (label) => {
    const m = text.match(new RegExp(`${label}\\s*\\n+\\s*([^\\n]+)`));
    return m ? m[1].trim() : null;
  };
  return {
    pageUpdated: text.match(/Data last updated on:\s*([0-9/]+)/)?.[1] ?? null,
    period: line('Time Period\\(s\\)'),
    channel: line('Fulfillment channel'),
    view: line('View'),
  };
}

// The period should be "Month to date" for the month of the table's date.
// commonDate 2026-11-19 -> expects "Month to date: Nov 1, 2026 ..."
export function periodOk(periodText, commonDate) {
  if (!periodText || !commonDate) return false;
  const [y, m] = commonDate.split('-').map(Number);
  const mon = new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
  return new RegExp(`^Month to date:\\s*${mon} 1, ${y}\\b`).test(periodText);
}

// ---- database
const now = () => new Date().toISOString();

export function startVcPull(db) {
  return Number(db.prepare('INSERT INTO vc_pulls (started_at) VALUES (?)').run(now()).lastInsertRowid);
}

export function finishVcPull(db, id, f) {
  const keys = Object.keys(f);
  db.prepare(`UPDATE vc_pulls SET finished_at = ?, ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(now(), ...keys.map((k) => f[k] ?? null), id);
}

export function saveVcRows(db, pullId, parsed) {
  const ins = db.prepare(`INSERT OR REPLACE INTO vc_rows (pull_id, asin, parent_asin, item_name, brand_display, brand_name,
    color, rating_count, raw_rating, shipped_units, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insDate = db.prepare('INSERT OR REPLACE INTO vc_column_dates (pull_id, column_id, label, data_date) VALUES (?, ?, ?, ?)');
  db.exec('BEGIN');
  try {
    for (const r of parsed.rows) {
      ins.run(pullId, r.asin, r.parent_asin, r.item_name, r.brand_display, r.brand_name, r.color,
        r.rating_count, r.raw_rating, r.shipped_units, r.raw);
    }
    for (const c of parsed.columnDates) insDate.run(pullId, c.id, c.label, c.date);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Units for a period (a "Last week" or "Last month" table, or any table with
// Shipped Units). complete = Amazon's units date reaches the period's end.
export function saveVcUnits(db, pullId, period, parsed) {
  const complete = parsed.unitsDate && period.end && parsed.unitsDate >= period.end ? 1 : 0;
  const ins = db.prepare(`INSERT OR REPLACE INTO vc_units (pull_id, period_start, period_end, period_kind, units_date,
    complete, asin, parent_asin, shipped_units, ordered_units, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.exec('BEGIN');
  try {
    for (const r of parsed.rows) {
      ins.run(pullId, period.start, period.end, period.kind, parsed.unitsDate, complete, r.asin, r.parent_asin,
        r.shipped_units, r.ordered_units ?? null, r.raw);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return complete;
}

// An earlier good pull with the same ratings date = the same snapshot.
export function earlierSnapshot(db, ratingsDate, pullId) {
  return db.prepare(`SELECT id FROM vc_pulls WHERE status = 'ok' AND ratings_date = ? AND id <> ?
    ORDER BY id LIMIT 1`).get(ratingsDate, pullId)?.id ?? null;
}
