// Keepa monthly ratings history (third source, next to Vendor Central and
// Seller Central).
//
// A teammate's Apps Script asks the Keepa API every Monday ~6:00am Karachi
// time (Sunday ~9:20pm here) and writes the "Review History - Keepa" Google
// Sheet. We copy three of its tabs, exactly as they are:
//   _state         ASIN, month, displayed ratings at month end, written reviews at month end
//   _meta          ASIN, parent, title, color, ratings now, last Keepa reading...
//   ASIN-SKU-View  the team's ASIN to SKU mapping (GB / EU / CA / USA SKUs)
//
// Facts to remember (checked 2026-11-23):
//   - amazon.com (US) only. GB / EU / CA ASINs get no data.
//   - Ratings = Amazon's displayed count (written + star-only), shared by a
//     family's children, like Vendor Central. Never add children up.
//   - The current month is month to date. A month is final from the first
//     Keepa run after it ended.
//   - Keepa's written-review count is noisy when Amazon regroups listings.
//     Our Seller Central scrape stays the source for written reviews.
//
// Nothing is ever overwritten: every copy is a new keepa_pulls row. A copy
// identical to the previous one is recorded (repeat_of) but its rows are not
// stored again.
//
// Uses:
//   keepa_month_latest   view: newest copy of each ASIN's month-end numbers
//   family_keepa_month   table: per VC family and month, Keepa count at month
//                        end, new ratings, and the VC count for the same day
//                        when we have it (a check between the two sources)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { getSecret } from './secrets.js';

// The Keepa sheet's ID lives only in the sheet script (Code.gs, filled in from
// the Keychain item keepa-sheet-id). The Mac just asks for "the Keepa copy".

export const KEEPA_SCHEMA = `
CREATE TABLE IF NOT EXISTS keepa_pulls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pulled_at TEXT NOT NULL,      -- when we copied the sheet (UTC)
  source TEXT,                  -- web app, file
  keepa_updated TEXT,           -- the sheet's "Last successful update", as shown (Karachi time)
  sha256 TEXT,                  -- of the three tabs together
  state_rows INTEGER, meta_rows INTEGER, sku_rows INTEGER,
  raw_path TEXT,                -- the copy, untouched (data/keepa/...json)
  repeat_of INTEGER             -- an earlier pull with exactly the same content
);
CREATE TABLE IF NOT EXISTS keepa_month_end (
  pull_id INTEGER NOT NULL, asin TEXT NOT NULL,
  month TEXT NOT NULL,          -- YYYY-MM
  ratings INTEGER,              -- displayed ratings at month end (month to date for the current month)
  written INTEGER,              -- written reviews at month end (Keepa tracks it from about 2021)
  PRIMARY KEY (pull_id, asin, month)
);
CREATE INDEX IF NOT EXISTS idx_keepa_me_asin ON keepa_month_end(asin, month);
CREATE TABLE IF NOT EXISTS keepa_asins (
  pull_id INTEGER NOT NULL, asin TEXT NOT NULL,
  parent_asin TEXT, title TEXT, color TEXT, brand TEXT, model TEXT,
  ratings_now INTEGER, written_now INTEGER,
  last_reading TEXT,            -- when Keepa last read the count (UTC). Can be months old.
  raw TEXT NOT NULL,            -- the _meta row as given (JSON)
  PRIMARY KEY (pull_id, asin)
);
CREATE TABLE IF NOT EXISTS keepa_sku_map (
  pull_id INTEGER NOT NULL, asin TEXT NOT NULL,
  market TEXT NOT NULL,         -- GB, EU, CA, US
  slot INTEGER NOT NULL,        -- 1 to 3 (the sheet's "SKU 1", "SKU 2", "SKU 3")
  sku TEXT NOT NULL,
  PRIMARY KEY (pull_id, asin, market, slot)
);
DROP VIEW IF EXISTS keepa_month_latest;
CREATE VIEW keepa_month_latest AS
  SELECT m.asin, m.month, m.ratings, m.written, m.pull_id
  FROM keepa_month_end m
  WHERE m.pull_id = (SELECT MAX(m2.pull_id) FROM keepa_month_end m2 WHERE m2.asin = m.asin AND m2.month = m.month);
`;

const int = (v) => {
  const s = String(v ?? '').replace(/,/g, '').trim();
  return /^-?\d+$/.test(s) ? Number(s) : null;
};
const clean = (v) => { const s = String(v ?? '').trim(); return s === '' ? null : s; };

// payload = { keepa_updated, state, meta, sku_view } where each tab is an array
// of rows (first row = headers), exactly as the sheet gives them.
export function importKeepa(db, payload, { source = 'web app', saveDir = path.join(config.root, 'data', 'keepa'), now = new Date() } = {}) {
  db.exec(KEEPA_SCHEMA);
  const { state, meta, sku_view: skuView } = payload;
  if (!Array.isArray(state) || state.length < 2 || !Array.isArray(meta)) throw new Error('Keepa copy has no _state / _meta rows');
  const want = (rows, first) => {
    if (!rows || String(rows[0]?.[0]).trim() !== first) throw new Error(`Keepa tab layout changed: expected first header "${first}", got "${rows?.[0]?.[0]}"`);
  };
  want(state, 'ASIN'); want(meta, 'ASIN'); if (skuView) want(skuView, 'ASIN');

  const body = JSON.stringify({ state, meta, sku_view: skuView ?? null });
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  const prev = db.prepare('SELECT id, repeat_of FROM keepa_pulls WHERE sha256 = ? ORDER BY id LIMIT 1').get(sha);

  let rawPath = null;
  if (saveDir && !prev) {
    fs.mkdirSync(saveDir, { recursive: true });
    rawPath = path.join(saveDir, `keepa-${now.toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(rawPath, JSON.stringify({ keepa_updated: payload.keepa_updated ?? null, ...JSON.parse(body) }));
  }
  const pullId = Number(db.prepare(`INSERT INTO keepa_pulls (pulled_at, source, keepa_updated, sha256, state_rows, meta_rows, sku_rows, raw_path, repeat_of)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(now.toISOString(), source, payload.keepa_updated ?? null, sha,
    state.length - 1, meta.length - 1, skuView ? skuView.length - 1 : null,
    rawPath ? path.relative(config.root, rawPath) : null, prev ? prev.id : null).lastInsertRowid);
  if (prev) return { pullId, repeat: true, months: 0, asins: 0, skus: 0 };

  db.exec('BEGIN');
  try {
    const insM = db.prepare('INSERT OR IGNORE INTO keepa_month_end VALUES (?,?,?,?,?)');
    let months = 0;
    for (const r of state.slice(1)) {
      const asin = clean(r[0]); const month = clean(r[1]);
      if (!asin || !/^\d{4}-\d{2}$/.test(month ?? '')) continue;
      insM.run(pullId, asin, month, int(r[2]), int(r[3])); months++;
    }
    const H = meta[0].map((h) => String(h).trim());
    const col = (row, name) => row[H.indexOf(name)];
    const insA = db.prepare('INSERT OR IGNORE INTO keepa_asins VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    let asins = 0;
    for (const r of meta.slice(1)) {
      const asin = clean(r[0]); if (!asin) continue;
      const ms = int(col(r, 'Last reading (ms)'));
      insA.run(pullId, asin, clean(col(r, 'Parent ASIN')), clean(col(r, 'Title')), clean(col(r, 'Color')),
        clean(col(r, 'Brand')), clean(col(r, 'Model')), int(col(r, 'Displayed ratings now')), int(col(r, 'Written reviews now')),
        ms ? new Date(ms).toISOString() : null, JSON.stringify(Object.fromEntries(H.map((h, i) => [h, r[i] ?? '']))));
      asins++;
    }
    let skus = 0;
    if (skuView) {
      const SH = skuView[0].map((h) => String(h).trim());
      const insS = db.prepare('INSERT OR IGNORE INTO keepa_sku_map VALUES (?,?,?,?,?)');
      for (const r of skuView.slice(1)) {
        const asin = clean(r[0]); if (!asin) continue;
        SH.forEach((h, i) => {
          const m = h.match(/^(GB|EU|CA|USA) SKU (\d)$/); const sku = clean(r[i]);
          if (m && sku) { insS.run(pullId, asin, m[1] === 'USA' ? 'US' : m[1], Number(m[2]), sku); skus++; }
        });
      }
    }
    db.exec('COMMIT');
    return { pullId, repeat: false, months, asins, skus };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Per VC family and month: the family's Keepa count at month end. Children of
// one family share one count, so we take the highest child (a child Keepa
// stopped reading can lag behind). raw_change = this month end - last month end.
// Amazon sometimes splits or merges listings: the count then jumps (e.g. 6,655
// to 1,626 in one month). Those months are flagged in `jump` and get no
// new_ratings, so they never count as ratings won or lost. vc_count is the
// family's Vendor Central count on the month's last day, when we have that
// day, so the two sources can be compared.
export const JUMP_UP = (prev) => Math.max(100, 0.25 * prev);   // more than this many new ratings in a month = regrouping
export const JUMP_DOWN = (prev) => Math.max(10, 0.03 * prev);  // losing more than this = regrouping (removals are smaller)

export function buildKeepaFamily(db) {
  db.exec(KEEPA_SCHEMA);
  db.exec(`DROP TABLE IF EXISTS family_keepa_month;
  CREATE TABLE family_keepa_month (
    family_id TEXT, month TEXT,
    count_end INTEGER,           -- Keepa displayed ratings at month end (month to date for the current month)
    prev_count_end INTEGER,      -- same, previous month
    raw_change INTEGER,          -- count_end - prev_count_end, as is
    new_ratings INTEGER,         -- raw_change when it is a normal month (net: removals lower it); NULL on a jump
    jump TEXT,                   -- why the month is not normal: regrouped up / regrouped down / children disagree
    written_end INTEGER,         -- Keepa written reviews at month end (noisy after regroupings)
    asins_with_data INTEGER,     -- family children Keepa had a number for
    vc_day TEXT, vc_count INTEGER, -- Vendor Central count on the month's last day, if we have it
    PRIMARY KEY (family_id, month)
  );`);
  const rows = db.prepare(`SELECT f.family_id, k.month, MAX(k.ratings) count_end, MIN(k.ratings) min_end,
      MAX(k.written) written_end, COUNT(k.ratings) n
    FROM asin_family f JOIN keepa_month_latest k ON k.asin = f.asin
    GROUP BY f.family_id, k.month ORDER BY f.family_id, k.month`).all();
  const vcEnd = db.prepare(`SELECT d.ratings_date day, MAX(d.rating_count) c FROM vc_ratings_daily d JOIN asin_family f ON f.asin = d.asin
    WHERE f.family_id = ? AND d.ratings_date = ?`);
  const ins = db.prepare('INSERT INTO family_keepa_month VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const lastDay = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); };
  const prevMonth = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo - 2, 1)).toISOString().slice(0, 7); };
  const seen = new Map();
  let n = 0;
  for (const r of rows) {
    const prev = seen.get(`${r.family_id}|${prevMonth(r.month)}`) ?? null;
    const change = r.count_end != null && prev != null ? r.count_end - prev : null;
    let jump = null;
    if (change != null) {
      if (change > JUMP_UP(prev)) jump = 'regrouped up';
      else if (change < -JUMP_DOWN(prev)) jump = 'regrouped down';
      else if (r.min_end != null && r.count_end - r.min_end > JUMP_DOWN(r.count_end)) jump = 'children disagree';
    }
    const v = vcEnd.get(r.family_id, lastDay(r.month));
    ins.run(r.family_id, r.month, r.count_end, prev, change, jump ? null : change, jump, r.written_end, r.n,
      v?.day ?? null, v?.c ?? null);
    seen.set(`${r.family_id}|${r.month}`, r.count_end);
    n++;
  }
  return n;
}

// Asks our own Apps Script web app (apps-script/Code.gs, action "keepa") for
// the three tabs. Returns the payload, or throws with a plain reason.
export async function fetchKeepaSheet() {
  const url = getSecret('sheets-url', { required: false });
  const token = getSecret('sheets-token', { required: false });
  if (!url || !token) throw new Error('Google Sheets web app not set up (./setup-sheets.sh)');
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, keepa: {} }), redirect: 'follow',
  });
  const text = await res.text();
  let out;
  try { out = JSON.parse(text); } catch { throw new Error(`web app replied with non-JSON (HTTP ${res.status}). Probably the Apps Script was not redeployed with the Keepa step yet.`); }
  if (!out.ok) throw new Error(`web app refused: ${out.error}`);
  if (!out.state) throw new Error('web app answered without Keepa data: redeploy apps-script/Code.gs (new version)');
  return out;
}
