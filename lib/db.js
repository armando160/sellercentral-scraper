// SQLite storage on this Mac (data/reviews.db). Node's built-in sqlite.
import { FAMILY_SCHEMA } from './families.js';
// One row per Amazon review ID, so re-running never creates duplicates.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reviews (
  review_id      TEXT PRIMARY KEY,    -- Amazon's ID, e.g. R1ABCDEFGHIJK
  review_ts      TEXT,                -- full timestamp (UTC)
  review_date    TEXT,                -- YYYY-MM-DD
  rating         INTEGER,             -- 1 to 5
  title          TEXT,
  body           TEXT,
  parent_asin    TEXT,
  child_asin     TEXT,
  product_title  TEXT,
  brand          TEXT,                -- Amazon's brand field (LifePro, Waver...)
  sheet_brand    TEXT,                -- our brand for the sheet: Lifepro, Joyberri, Sunello
  store          TEXT,                -- Seller Central store, e.g. LIFEPRO OUTLET
  marketplace    TEXT,                -- US, CA, MX, UK...
  verified       INTEGER,             -- 1 yes, 0 no
  vine           INTEGER,
  has_images     INTEGER,
  has_video      INTEGER,
  replied        INTEGER,
  marked_done    INTEGER,
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  changed_at     TEXT,                -- last time any field changed
  uploaded_at    TEXT                 -- last time sent to Google Sheets
);
CREATE INDEX IF NOT EXISTS idx_reviews_date ON reviews(review_date);
CREATE INDEX IF NOT EXISTS idx_reviews_parent ON reviews(parent_asin);

-- Every API response, untouched, so the mapping can be redone without
-- going back to Amazon ("npm run reparse").
CREATE TABLE IF NOT EXISTS raw_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER, url TEXT NOT NULL, captured_at TEXT NOT NULL, body TEXT NOT NULL,
  view TEXT                   -- "STORE|CODE", e.g. "LIFEPRO OUTLET|US"
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL, finished_at TEXT,
  status TEXT,                -- ok, login_needed, error
  pages INTEGER DEFAULT 0, seen INTEGER DEFAULT 0,
  new_reviews INTEGER DEFAULT 0, low_star_new INTEGER DEFAULT 0,
  amazon_total INTEGER,       -- totalReviewCount Amazon reported
  uploaded INTEGER DEFAULT 0,
  note TEXT
);

-- Vendor Central (see PLAN-vendor-central.md). Saved exactly as Amazon gave
-- it, with its dates. Nothing here is ever overwritten; numbers are worked
-- out later from these rows.
CREATE TABLE IF NOT EXISTS vc_pulls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL, finished_at TEXT,
  status TEXT,                -- ok, login_needed, error
  note TEXT,
  page_updated TEXT,          -- "Data last updated on" at the top of the table, as shown
  period_text TEXT,           -- Time period box, as shown ("Month to date: Nov 1, 2026 (Nov) - Nov 19, 2026")
  period_ok INTEGER,          -- 1 if it was the expected period (this month to date)
  channel_text TEXT, view_text TEXT,
  common_date TEXT,           -- YYYY-MM-DD, the table's date (from the page data)
  ratings_date TEXT,          -- YYYY-MM-DD the review count + star rating are from
  units_date TEXT,            -- YYYY-MM-DD the shipped units go up to
  rows INTEGER,
  data_path TEXT,             -- the page's data, untouched (data/vc/...json)
  export_path TEXT,           -- Amazon's Export file, untouched (data/vc/...xlsx)
  export_sha256 TEXT,
  export_matches INTEGER,     -- 1 if the file's numbers equal the page data
  repeat_of INTEGER           -- an earlier pull with the same ratings_date (same snapshot)
);

-- One row per ASIN per pull. Review count is the FAMILY's count (shared by
-- colors/sizes): never add children up.
CREATE TABLE IF NOT EXISTS vc_rows (
  pull_id INTEGER NOT NULL, asin TEXT NOT NULL,
  parent_asin TEXT, item_name TEXT,
  brand_display TEXT,         -- "Brand name" column (PREFERRED_DISPLAY_NAME)
  brand_name TEXT,            -- "Brand Name" column (BRAND_NAME); they can differ
  color TEXT,
  rating_count INTEGER,       -- Customer review count (TOTAL_RATING_COUNT): written + star-only, all marketplaces in the summary
  raw_rating REAL,            -- Raw star ratings (RAW_RATING), Amazon sends 2 decimals
  shipped_units INTEGER,      -- Shipped Units (QUANTITY_SHIPPED) for the pull's period
  raw TEXT NOT NULL,          -- the row as the page received it (JSON)
  PRIMARY KEY (pull_id, asin)
);
CREATE INDEX IF NOT EXISTS idx_vc_rows_asin ON vc_rows(asin);

-- Shipped / ordered units per ASIN for one table's period. Every pull's
-- copy is kept (Amazon corrects units later); complete = 1 when Amazon's
-- units date reached the end of the period.
CREATE TABLE IF NOT EXISTS vc_units (
  pull_id INTEGER NOT NULL, period_start TEXT, period_end TEXT,
  period_kind TEXT,           -- week (Sun to Sat), month, mtd, trailing12, other
  units_date TEXT, complete INTEGER,
  asin TEXT NOT NULL, parent_asin TEXT,
  shipped_units INTEGER, ordered_units INTEGER, raw TEXT,
  PRIMARY KEY (pull_id, period_start, period_end, asin)
);

-- Each column's own refresh date ("Last refreshed on" in the (i) tooltip).
CREATE TABLE IF NOT EXISTS vc_column_dates (
  pull_id INTEGER NOT NULL, column_id TEXT NOT NULL, label TEXT, data_date TEXT,
  PRIMARY KEY (pull_id, column_id)
);


-- One row per view per run (Lifepro US, Joyberri CA...).
CREATE TABLE IF NOT EXISTS view_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL, view TEXT NOT NULL,
  status TEXT,                -- ok, skipped, error, login_needed
  pages INTEGER DEFAULT 0, seen INTEGER DEFAULT 0,
  new_reviews INTEGER DEFAULT 0, low_star_new INTEGER DEFAULT 0,
  amazon_total INTEGER, note TEXT
);
`;

// Columns added after the first version. Old databases get them here, and
// reviews from before views existed were all LIFEPRO OUTLET / United States.
const ADDED = { reviews: ['sheet_brand', 'store', 'marketplace', 'missing_since'], raw_responses: ['view'] };
function migrate(db) {
  for (const [table, cols] of Object.entries(ADDED)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const c of cols) if (!have.has(c)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${c} TEXT`);
  }
  db.exec(`UPDATE reviews SET sheet_brand = 'Lifepro', store = 'LIFEPRO OUTLET', marketplace = 'US'
    WHERE marketplace IS NULL`);
  db.exec(`UPDATE raw_responses SET view = 'LIFEPRO OUTLET|US' WHERE view IS NULL`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_reviews_view ON reviews(sheet_brand, marketplace)');
  // Daily ratings snapshot: one row per Amazon ratings date and ASIN, from the
  // first good pull that had that ASIN (later pulls of the same date can add ASINs).
  db.exec(`DROP VIEW IF EXISTS vc_ratings_daily;
  CREATE VIEW vc_ratings_daily AS
    SELECT p.ratings_date, r.asin, r.parent_asin, r.brand_display, r.color, r.rating_count, r.raw_rating, r.pull_id
    FROM vc_rows r JOIN vc_pulls p ON p.id = r.pull_id
    WHERE p.status = 'ok' AND r.pull_id = (SELECT MIN(r2.pull_id) FROM vc_rows r2 JOIN vc_pulls p2 ON p2.id = r2.pull_id
      WHERE p2.status = 'ok' AND p2.ratings_date = p.ratings_date AND r2.asin = r.asin);`);
  db.exec(FAMILY_SCHEMA); // review families (lib/families.js)
  if (!db.prepare('PRAGMA table_info(asin_family)').all().some((c) => c.name === 'source')) {
    db.exec('ALTER TABLE asin_family ADD COLUMN source TEXT');
  }
}

export const FIELDS = ['review_ts', 'review_date', 'rating', 'title', 'body', 'parent_asin', 'child_asin',
  'product_title', 'brand', 'verified', 'vine', 'has_images', 'has_video', 'replied', 'marked_done'];

export function openDb(dbPath = config.dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

const now = () => new Date().toISOString();

// Where a review was found. Set when it is first saved and never changed,
// so a review never moves between brands or marketplaces.
export const VIEW_FIELDS = ['sheet_brand', 'store', 'marketplace'];

// Insert a new review or update a known one. Returns 'new', 'changed' or 'same'.
// view = { brand, store, code } of the view it was read from.
export function upsertReview(db, r, view = null) {
  const ts = now();
  const old = db.prepare('SELECT * FROM reviews WHERE review_id = ?').get(r.review_id);
  if (!old) {
    const where = view ? [view.brand, view.store, view.code] : [null, null, null];
    db.prepare(`INSERT INTO reviews (review_id, ${FIELDS.join(', ')}, ${VIEW_FIELDS.join(', ')}, first_seen_at, last_seen_at, changed_at)
      VALUES (?, ${FIELDS.map(() => '?').join(', ')}, ?, ?, ?, ?, ?, ?)`)
      .run(r.review_id, ...FIELDS.map((f) => r[f] ?? null), ...where, ts, ts, ts);
    return 'new';
  }
  const changed = FIELDS.some((f) => (r[f] ?? null) !== null && (r[f] ?? null) !== old[f]);
  if (changed) {
    db.prepare(`UPDATE reviews SET ${FIELDS.map((f) => `${f} = COALESCE(?, ${f})`).join(', ')},
      last_seen_at = ?, changed_at = ?, missing_since = NULL WHERE review_id = ?`)
      .run(...FIELDS.map((f) => r[f] ?? null), ts, ts, r.review_id);
    return 'changed';
  }
  db.prepare('UPDATE reviews SET last_seen_at = ?, missing_since = NULL WHERE review_id = ?').run(ts, r.review_id);
  return 'same';
}

// Removed reviews. After a view was read in full, a saved review of that view
// that was NOT on the page, although its date is inside the window the page
// showed, was removed by Amazon (or hidden). It stays in the database and keeps
// counting as a review we earned; missing_since only records when it went
// missing (the KPI layer needs it, because a removal also lowers the Vendor
// Central review count). Seen again later = missing_since is cleared.
// The window: newer than the oldest review date seen in this read. The page
// shows the last 90 days and at most 1,000, so older reviews just fall off.
export function markMissing(db, view, readStartedAt, oldestSeen) {
  if (!oldestSeen) return 0;
  return Number(db.prepare(`UPDATE reviews SET missing_since = ?
    WHERE store = ? AND marketplace = ? AND review_date > ? AND last_seen_at < ? AND missing_since IS NULL`)
    .run(now(), view.store, view.code, oldestSeen, readStartedAt).changes);
}

export function saveRaw(db, runId, url, body, view = null) {
  db.prepare('INSERT INTO raw_responses (run_id, url, captured_at, body, view) VALUES (?, ?, ?, ?, ?)')
    .run(runId, url, now(), body, view);
}

export function saveViewRun(db, runId, view, f) {
  db.prepare(`INSERT INTO view_runs (run_id, view, status, pages, seen, new_reviews, low_star_new, amazon_total, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(runId, view, f.status, f.pages ?? 0, f.seen ?? 0,
    f.new_reviews ?? 0, f.low_star_new ?? 0, f.amazon_total ?? null, f.note ?? null);
}

export function startRun(db) {
  return Number(db.prepare('INSERT INTO runs (started_at) VALUES (?)').run(now()).lastInsertRowid);
}

export function finishRun(db, runId, f) {
  db.prepare(`UPDATE runs SET finished_at = ?, status = ?, pages = ?, seen = ?, new_reviews = ?,
    low_star_new = ?, amazon_total = ?, uploaded = ?, note = ? WHERE id = ?`).run(
    now(), f.status, f.pages ?? 0, f.seen ?? 0, f.new_reviews ?? 0, f.low_star_new ?? 0,
    f.amazon_total ?? null, f.uploaded ?? 0, f.note ?? null, runId);
}
