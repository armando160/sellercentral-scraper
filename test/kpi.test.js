import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.js';
import { rebuildKpis, weekStart, periodOf } from '../lib/kpi.js';

test('weeks run Sunday to Saturday', () => {
  assert.equal(weekStart('2026-11-19'), '2026-11-15');
  assert.deepEqual(periodOf('week', '2026-11-21'), ['2026-11-15', '2026-11-21']);
  assert.deepEqual(periodOf('month', '2026-02-10'), ['2026-02-01', '2026-02-28']);
});

test('star-only = count change - written + removed written; per-unit KPIs', () => {
  const db = openDb(':memory:');
  // VC: family of A+B. Sat 14 Nov: 100 ratings at 4.50. Sat 21 Nov: 110 at 4.40.
  db.exec(`INSERT INTO vc_pulls (id, started_at, status, ratings_date) VALUES (1,'x','ok','2026-11-14'), (2,'x','ok','2026-11-21')`);
  const add = db.prepare(`INSERT INTO vc_rows (pull_id, asin, parent_asin, rating_count, raw_rating, brand_display, raw) VALUES (?,?,?,?,?,'Lifepro','{}')`);
  add.run(1, 'A', 'P', 100, 4.5); add.run(1, 'B', 'P', 100, 4.5);
  add.run(2, 'A', 'P', 110, 4.4); add.run(2, 'B', 'P', 110, 4.4);
  // Units for that week: A 300 shipped, B 100 shipped
  const u = db.prepare(`INSERT INTO vc_units (pull_id, period_start, period_end, period_kind, units_date, complete, asin, parent_asin, shipped_units, ordered_units)
    VALUES (2,'2026-11-15','2026-11-21','week','2026-11-21',1,?, 'P', ?, ?)`);
  u.run('A', 300, 320); u.run('B', 100, 80);
  // SC: 4 written in the week (stars 5,5,1,4), one of them later removed (the 1-star, found missing on 20 Nov)
  db.exec(`INSERT INTO runs (id, started_at, status) VALUES (1, '2026-11-23T12:00:00Z', 'ok')`);
  const r = db.prepare(`INSERT INTO reviews (review_id, review_date, rating, child_asin, parent_asin, marketplace, store, sheet_brand, first_seen_at, last_seen_at, missing_since)
    VALUES (?,?,?,?, 'P', 'US', 'LIFEPRO OUTLET', 'Lifepro', 'x', 'x', ?)`);
  r.run('R1', '2026-11-16', 5, 'A', null); r.run('R2', '2026-11-17', 5, 'B', null);
  r.run('R3', '2026-11-18', 1, 'A', '2026-11-20T10:00:00Z'); r.run('R4', '2026-11-20', 4, 'A', null);

  rebuildKpis(db, { today: '2026-11-25' });
  const w = db.prepare(`SELECT * FROM family_ratings WHERE period_kind='week' AND period_start='2026-11-15'`).get();
  assert.equal(w.new_ratings, 10);
  assert.equal(w.written, 4);          // removed one still counts as written
  assert.equal(w.written_removed, 1);
  assert.equal(w.star_only, 7);        // 10 - 4 + 1
  assert.equal(w.complete, 1, w.why_not);
  // new stars = 110*4.4 - 100*4.5 = 34 -> avg 3.4; star-only stars = 34 + 1 - 15 = 20 -> 20/7
  assert.equal(w.avg_new_stars, 3.4);
  assert.equal(w.avg_star_only_stars, 2.86);
  const k = db.prepare(`SELECT * FROM kpi_family WHERE period_kind='week' AND period_start='2026-11-15' AND basis='shipped'`).get();
  assert.equal(k.units, 400);
  assert.equal(k.written_per_unit, 0.01);
  assert.equal(k.star_only_per_unit, 0.0175);
  assert.equal(k.total_per_unit, 0.025);
  assert.equal(k.complete, 1);
  const b = db.prepare(`SELECT * FROM kpi_brand WHERE brand='All brands' AND period_kind='week' AND basis='ordered'`).get();
  assert.equal(b.units, 400); assert.equal(b.total_new, 10);
  db.close();
});

test('a period older than the page reached is not complete (1,000 cap / 90 days)', () => {
  const db = openDb(':memory:');
  db.exec(`INSERT INTO vc_pulls (id, started_at, status, ratings_date) VALUES (1,'x','ok','2026-11-19')`);
  db.exec(`INSERT INTO vc_rows (pull_id, asin, parent_asin, rating_count, raw_rating, brand_display, raw) VALUES (1,'A','P',100,4.5,'Lifepro','{}')`);
  db.exec(`INSERT INTO runs (id, started_at, status) VALUES (1, '2026-11-23T12:00:00Z', 'ok')`);
  // A full read that hit the cap: 1,000 reviews, the oldest dated 27 Aug.
  const reviews = Array.from({ length: 1000 }, (_, i) => ({ reviewId: `X${i}`,
    reviewCreatedTimestamp: i === 999 ? '2026-08-27T05:00:00Z' : '2026-11-10T05:00:00Z' }));
  db.prepare(`INSERT INTO raw_responses (run_id, url, captured_at, body, view) VALUES (1, 'u', 'x', ?, 'LIFEPRO OUTLET|US')`)
    .run(JSON.stringify({ reviews }));
  db.prepare(`INSERT INTO view_runs (run_id, view, status) VALUES (1, 'LIFEPRO OUTLET|US', 'ok')`).run();
  const r = db.prepare(`INSERT INTO reviews (review_id, review_date, rating, child_asin, parent_asin, marketplace, store, sheet_brand, first_seen_at, last_seen_at)
    VALUES (?,?,5,'A','P','US','LIFEPRO OUTLET','Lifepro','x','x')`);
  r.run('R1', '2026-08-27'); r.run('R2', '2026-08-30'); r.run('R3', '2026-11-10');
  rebuildKpis(db, { today: '2026-11-25' });
  const c = (kind, s) => db.prepare(`SELECT complete FROM family_written WHERE period_kind=? AND period_start=?`).get(kind, s).complete;
  assert.equal(c('month', '2026-08-01'), 0); // only 28 to 31 Aug were on the page
  assert.equal(c('week', '2026-08-23'), 0);  // 27 Aug may be cut in half
  assert.equal(c('week', '2026-08-30'), 1);
  db.close();
});
