import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.js';
import { importKeepa, buildKeepaFamily } from '../lib/keepa.js';

const payload = {
  keepa_updated: 'Mon 23 Nov 2026, 20:18  (Manual)',
  state: [['ASIN', 'Month', 'Displayed ratings (month-end)', 'Written reviews (month-end)'],
    ['A', '2026-09', '1,000', '400'], ['A', '2026-10', '1,050', '410'], ['B', '2026-09', '990', ''], ['B', '2026-10', '1,050', '']],
  meta: [['ASIN', 'Parent ASIN', 'Title', 'Color', 'Displayed ratings now', 'Last reading (ms)', 'Written reviews now', 'Points', 'Brand', 'Model'],
    ['A', 'P', 'Thing', 'Black', '1050', '1795396140000', '410', '9', 'Lifepro', 'M1']],
  sku_view: [['ASIN', 'GB SKU 1', 'GB SKU 2', 'GB SKU 3', 'EU SKU 1', 'EU SKU 2', 'EU SKU 3', 'CA SKU 1', 'CA SKU 2', 'CA SKU 3', 'USA SKU 1', 'USA SKU 2', 'USA SKU 3'],
    ['A', 'GB-LP-X-BLK', '', '', '', '', '', '', '', '', 'LP-X-BLK', '', '']],
};

test('Keepa copy is stored as given, repeats are only noted', () => {
  const db = openDb(':memory:');
  const r1 = importKeepa(db, payload, { saveDir: null });
  assert.deepEqual([r1.repeat, r1.months, r1.asins, r1.skus], [false, 4, 1, 2]);
  assert.equal(db.prepare("SELECT ratings FROM keepa_month_end WHERE asin='A' AND month='2026-09'").get().ratings, 1000);
  assert.equal(db.prepare("SELECT written FROM keepa_month_end WHERE asin='B' AND month='2026-09'").get().written, null);
  assert.equal(db.prepare("SELECT sku FROM keepa_sku_map WHERE asin='A' AND market='US'").get().sku, 'LP-X-BLK');
  assert.match(db.prepare("SELECT last_reading FROM keepa_asins WHERE asin='A'").get().last_reading, /^2026-11-2/);
  const r2 = importKeepa(db, payload, { saveDir: null });
  assert.equal(r2.repeat, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM keepa_month_end').get().n, 4);
  assert.equal(db.prepare('SELECT repeat_of FROM keepa_pulls WHERE id = ?').get(r2.pullId).repeat_of, r1.pullId);
});

test('a changed layout is refused', () => {
  const db = openDb(':memory:');
  assert.throws(() => importKeepa(db, { ...payload, state: [['Month', 'ASIN'], ['x', 'y']] }, { saveDir: null }), /layout changed/);
});

test('family month: highest child count, new ratings, VC check', () => {
  const db = openDb(':memory:');
  importKeepa(db, payload, { saveDir: null });
  db.exec(`INSERT INTO asin_family (asin, parent_asin, family_id) VALUES ('A','P','F-A'), ('B','P','F-A')`);
  db.exec(`INSERT INTO vc_pulls (id, started_at, status, ratings_date) VALUES (1,'x','ok','2026-10-31')`);
  db.exec(`INSERT INTO vc_rows (pull_id, asin, parent_asin, rating_count, raw) VALUES (1,'A','P',1052,'{}')`);
  buildKeepaFamily(db);
  const sep = db.prepare("SELECT * FROM family_keepa_month WHERE month='2026-09'").get();
  const oct = db.prepare("SELECT * FROM family_keepa_month WHERE month='2026-10'").get();
  assert.equal(sep.count_end, 1000); assert.equal(sep.new_ratings, null);
  assert.equal(oct.new_ratings, 50); assert.equal(oct.vc_count, 1052); assert.equal(oct.asins_with_data, 2);
});

test('a split listing is a jump, not lost ratings', () => {
  const db = openDb(':memory:');
  importKeepa(db, { ...payload, state: [payload.state[0], ['A', '2026-08', '6655', ''], ['A', '2026-09', '1626', ''], ['A', '2026-10', '1637', '']] }, { saveDir: null });
  db.exec(`INSERT INTO asin_family (asin, parent_asin, family_id) VALUES ('A','P','F-A')`);
  buildKeepaFamily(db);
  const sep = db.prepare("SELECT * FROM family_keepa_month WHERE month='2026-09'").get();
  const oct = db.prepare("SELECT * FROM family_keepa_month WHERE month='2026-10'").get();
  assert.equal(sep.raw_change, -5029); assert.equal(sep.new_ratings, null); assert.equal(sep.jump, 'regrouped down');
  assert.equal(oct.new_ratings, 11); assert.equal(oct.jump, null);
});
