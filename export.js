// CSV files for Excel / Sheets, in exports/.
//   npm run export                      -> reviews-<date>.csv (every review)
//   npm run export -- --since=2026-10-01
//   npm run export -- --monthly         -> monthly-<date>.csv (month x parent ASIN counts)
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './lib/db.js';
import { config } from './lib/config.js';

const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1] || null;
const since = arg('since');
const monthly = process.argv.includes('--monthly');
const db = openDb();

const cell = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

let cols, rows, name;
if (monthly) {
  name = 'monthly';
  cols = ['month', 'parent_asin', 'reviews', 'stars_1', 'stars_2', 'stars_3', 'stars_4', 'stars_5', 'avg_stars'];
  rows = db.prepare(`SELECT substr(review_date, 1, 7) month, parent_asin,
      COUNT(*) reviews, SUM(rating = 1) stars_1, SUM(rating = 2) stars_2, SUM(rating = 3) stars_3,
      SUM(rating = 4) stars_4, SUM(rating = 5) stars_5, ROUND(AVG(rating), 2) avg_stars
    FROM reviews WHERE (? IS NULL OR review_date >= ?)
    GROUP BY month, 2 ORDER BY month DESC, reviews DESC`).all(since, since);
} else {
  name = 'reviews';
  cols = ['review_id', 'review_date', 'rating', 'parent_asin', 'child_asin', 'product_title', 'title', 'body',
    'verified', 'vine', 'replied', 'first_seen_at'];
  rows = db.prepare(`SELECT ${cols.join(', ')} FROM reviews
    WHERE (? IS NULL OR review_date >= ?) ORDER BY review_date DESC, review_id`).all(since, since);
}

fs.mkdirSync(config.exportDir, { recursive: true });
const file = path.join(config.exportDir, `${name}-${new Date().toISOString().slice(0, 10)}.csv`);
fs.writeFileSync(file, '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n'));
console.log(`Wrote ${rows.length} rows to ${file}`);
db.close();
