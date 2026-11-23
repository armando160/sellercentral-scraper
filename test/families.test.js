import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.js';
import { rebuildFamilies } from '../lib/families.js';

test('children with the same count and stars under one parent are one family', () => {
  const db = openDb(':memory:');
  db.exec(`INSERT INTO vc_pulls (id, started_at, status, ratings_date) VALUES (1, 'x', 'ok', '2026-11-19'), (2, 'x', 'ok', '2026-11-20')`);
  const add = db.prepare(`INSERT INTO vc_rows (pull_id, asin, parent_asin, rating_count, raw_rating, raw) VALUES (?,?,?,?,?, '{}')`);
  // P1: A and B share a family, C is an older model under the same parent
  add.run(1, 'A', 'P1', 100, 4.5); add.run(1, 'B', 'P1', 100, 4.5); add.run(1, 'C', 'P1', 40, 4.1);
  // day 2: B drops out of the table; A gets a new review. B is still A's family (newest shared day).
  add.run(2, 'A', 'P1', 101, 4.5); add.run(2, 'C', 'P1', 40, 4.1);
  // P2: same numbers as A on day 1, but another parent: NOT the same family
  add.run(1, 'D', 'P2', 100, 4.5);
  assert.deepEqual(rebuildFamilies(db), { asins: 4, families: 3 });
  const fam = Object.fromEntries(db.prepare('SELECT asin, family_id FROM asin_family').all().map((r) => [r.asin, r.family_id]));
  assert.equal(fam.A, 'F-A'); assert.equal(fam.B, 'F-A'); assert.equal(fam.C, 'F-C'); assert.equal(fam.D, 'F-D');
  assert.equal(db.prepare(`SELECT rating_count c FROM asin_family WHERE asin = 'B'`).get().c, 101);
  assert.equal(db.prepare(`SELECT families FROM parent_family WHERE parent_asin = 'P1'`).get().families, 2);
  db.close();
});
