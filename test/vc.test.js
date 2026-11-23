import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseMetricData, compareExport, periodOk, readHeader, num } from '../lib/vc.js';
import { readXlsx } from '../lib/xlsx.js';
import { openDb } from '../lib/db.js';
import { startVcPull, finishVcPull, saveVcRows, earlierSnapshot } from '../lib/vc.js';

const sample = {
  metricsData: {
    metadata: { commonDate: { day: 19, month: 11, year: 2026 } },
    data: { rowData: [
      { ASIN: 'B0TESTCHL1', PARENT_ASIN: 'B0TESTPAR1', TOTAL_RATING_COUNT: '1,200', RAW_RATING: '4.60', QUANTITY_SHIPPED: '50', PREFERRED_DISPLAY_NAME: 'TestBrand', BRAND_NAME: 'TestBrand', COLOR_NAME: 'Black', ITEM_NAME: 'Test Plate Black' },
      { ASIN: 'B0TESTCHL2', PARENT_ASIN: 'B0TESTPAR1', TOTAL_RATING_COUNT: '1,200', RAW_RATING: '4.60', QUANTITY_SHIPPED: '20', PREFERRED_DISPLAY_NAME: 'TestBrand', BRAND_NAME: 'TestBrand', COLOR_NAME: 'Blue', ITEM_NAME: 'Test Plate Blue' },
      { ASIN: 'B0TESTCHL3', PARENT_ASIN: 'B0TESTPAR2', TOTAL_RATING_COUNT: '75', RAW_RATING: '4.37', QUANTITY_SHIPPED: '5', PREFERRED_DISPLAY_NAME: 'OtherBrand', BRAND_NAME: 'TestBrand', COLOR_NAME: 'Gray', ITEM_NAME: 'Test Gun' },
      { ASIN: 'B0TESTOLD1', PARENT_ASIN: 'B0TESTOLDP', TOTAL_RATING_COUNT: '40', RAW_RATING: '3.90', QUANTITY_SHIPPED: '3', PREFERRED_DISPLAY_NAME: 'TestBrand', BRAND_NAME: 'TestBrand', COLOR_NAME: '', ITEM_NAME: 'Old product' },
    ] },
    schema: { columns: ['ASIN', 'PARENT_ASIN', 'TOTAL_RATING_COUNT', 'RAW_RATING', 'QUANTITY_SHIPPED'].map((c) => ({
      columnId: c, columnLabel: c, dataSetDate: c === 'QUANTITY_SHIPPED' ? { day: 18, month: 11, year: 2026 } : { day: 19, month: 11, year: 2026 } })) },
  },
};

test('reads the table data with each column date', () => {
  const p = parseMetricData(JSON.stringify(sample));
  assert.equal(p.commonDate, '2026-11-19');
  assert.equal(p.ratingsDate, '2026-11-19');
  assert.equal(p.unitsDate, '2026-11-18');
  assert.deepEqual(p.missing, []);
  assert.equal(p.rows[0].rating_count, 1200);
  assert.equal(p.rows[0].raw_rating, 4.6);
  assert.equal(p.rows[2].brand_display, 'OtherBrand');
});

test('numbers: commas, dashes, blanks', () => {
  assert.equal(num('30,978'), 30978);
  assert.equal(num('-'), null);
  assert.equal(num(''), null);
  assert.equal(num(4.37), 4.37);
});

test('Excel file: HYPERLINK cells, blanks, and it matches the page data', () => {
  const buf = fs.readFileSync(new URL('./fixtures/vc-export.xlsx', import.meta.url));
  const rows = readXlsx(buf);
  assert.equal(rows[2][0], 'B0TESTCHL1');
  assert.equal(rows[1][1], null);
  assert.deepEqual(compareExport(buf, parseMetricData(sample).rows), { ok: true, note: '' });
  const changed = parseMetricData(sample).rows.map((r) => ({ ...r, rating_count: r.rating_count + 1 }));
  assert.equal(compareExport(buf, changed).ok, false);
});

test('time period must be month to date of the data month', () => {
  assert.equal(periodOk('Month to date: Nov 1, 2026 (Nov) - Nov 19, 2026', '2026-11-19'), true);
  assert.equal(periodOk('Month to date: Nov 1, 2026 (Nov) - Nov 30, 2026', '2026-12-01'), false);
  assert.equal(periodOk('Week 46 > Nov 8, 2026 - Nov 14, 2026', '2026-11-19'), false);
});

test('page header ignores the side menu', () => {
  const h = readHeader('View\nAmazon Curated\nData last updated on: 11/19/2026\nTime Period(s)\nMonth to date: Nov 1, 2026 (Nov) - Nov 19, 2026\nFulfillment channel\nBoth (Retail and B2B)\nView\nManufacturing\n');
  assert.equal(h.view, 'Manufacturing');
  assert.equal(h.pageUpdated, '11/19/2026');
});

test('a second pull with the same ratings date is marked as a repeat', () => {
  const db = openDb(':memory:');
  const p = parseMetricData(sample);
  const a = startVcPull(db); saveVcRows(db, a, p); finishVcPull(db, a, { status: 'ok', ratings_date: p.ratingsDate });
  const b = startVcPull(db); saveVcRows(db, b, p);
  assert.equal(earlierSnapshot(db, p.ratingsDate, b), a);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM vc_ratings_daily').get().n, 4);
});

import { tilePeriod } from '../lib/vc.js';
test('table periods from the request the page sent', () => {
  const k = (r) => tilePeriod(JSON.stringify({ dateRanges: [r] })).kind;
  assert.equal(k({ fromDate: '20251101', toDate: '20261031', type: 'TRAILINGLY' }), 'trailing12');
  assert.equal(k({ fromDate: '20261108', toDate: '20261114', type: 'WEEKLY' }), 'week');
  assert.equal(k({ fromDate: '20261001', toDate: '20261031', type: 'MONTHLY' }), 'month');
  assert.equal(k({ fromDate: '20261101', toDate: '20261119', type: 'RECURRINGLY' }), 'mtd');
  assert.equal(tilePeriod(null).kind, 'unknown');
});
