// SQLite storage on this Mac (data/reviews.db). Node's built-in sqlite.
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
  brand          TEXT,
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
  run_id INTEGER, url TEXT NOT NULL, captured_at TEXT NOT NULL, body TEXT NOT NULL
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
`;

export const FIELDS = ['review_ts', 'review_date', 'rating', 'title', 'body', 'parent_asin', 'child_asin',
  'product_title', 'brand', 'verified', 'vine', 'has_images', 'has_video', 'replied', 'marked_done'];

export function openDb(dbPath = config.dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

const now = () => new Date().toISOString();

// Insert a new review or update a known one. Returns 'new', 'changed' or 'same'.
export function upsertReview(db, r) {
  const ts = now();
  const old = db.prepare('SELECT * FROM reviews WHERE review_id = ?').get(r.review_id);
  if (!old) {
    db.prepare(`INSERT INTO reviews (review_id, ${FIELDS.join(', ')}, first_seen_at, last_seen_at, changed_at)
      VALUES (?, ${FIELDS.map(() => '?').join(', ')}, ?, ?, ?)`)
      .run(r.review_id, ...FIELDS.map((f) => r[f] ?? null), ts, ts, ts);
    return 'new';
  }
  const changed = FIELDS.some((f) => (r[f] ?? null) !== null && (r[f] ?? null) !== old[f]);
  if (changed) {
    db.prepare(`UPDATE reviews SET ${FIELDS.map((f) => `${f} = COALESCE(?, ${f})`).join(', ')},
      last_seen_at = ?, changed_at = ? WHERE review_id = ?`)
      .run(...FIELDS.map((f) => r[f] ?? null), ts, ts, r.review_id);
    return 'changed';
  }
  db.prepare('UPDATE reviews SET last_seen_at = ? WHERE review_id = ?').run(ts, r.review_id);
  return 'same';
}

export function saveRaw(db, runId, url, body) {
  db.prepare('INSERT INTO raw_responses (run_id, url, captured_at, body) VALUES (?, ?, ?, ?)')
    .run(runId, url, now(), body);
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
