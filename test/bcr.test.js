import test from 'node:test';
import assert from 'node:assert/strict';
import { toRow, rowsFromResponse } from '../lib/bcr.js';
import { openDb, upsertReview } from '../lib/db.js';

// Shape copied from the real API response (2026-11-18), values made up.
const sample = {
  asin: 'B0TESTPAR1', asinThumbnail: 'https://m.media-amazon.com/images/I/x.jpg',
  asinTitle: 'Example Brand Massage Device', asinTotalReviewCount: 100,
  asinWeightedStarRating: 4.5, brandName: 'ExampleBrand', childAsin: 'B0TESTCHL1',
  reviewAuthorPublicName: 'Reviewer Name', reviewCreatedTimestamp: '2026-11-16T06:06:16.448Z',
  reviewHasImages: false, reviewId: 'R1TESTREVIEW01', reviewIsRepliedTo: false,
  reviewIsVerifiedPurchase: true, reviewIsVideo: false, reviewIsVineReview: false,
  reviewMarkedAsDone: false, reviewRating: 2, reviewText: 'Stopped working after a week.',
  reviewTitle: 'Not great',
};

test('maps the real API fields', () => {
  const r = toRow(sample);
  assert.equal(r.review_id, 'R1TESTREVIEW01');
  assert.equal(r.review_date, '2026-11-16');
  assert.equal(r.rating, 2);
  assert.equal(r.parent_asin, 'B0TESTPAR1');
  assert.equal(r.child_asin, 'B0TESTCHL1');
  assert.equal(r.verified, 1);
  assert.equal(r.vine, 0);
  assert.match(r.product_title, /Massage Device/);
});

test('never keeps the reviewer name', () => {
  assert.doesNotMatch(JSON.stringify(toRow(sample)), /Reviewer Name/);
});

test('handles empty or odd responses', () => {
  assert.deepEqual(rowsFromResponse({}), []);
  assert.deepEqual(rowsFromResponse({ errorMessage: 'x' }), []);
  assert.equal(rowsFromResponse({ reviews: [sample, { nope: 1 }] }).length, 1);
});

test('upsert: new, same, changed', () => {
  const db = openDb(':memory:');
  const r = toRow(sample);
  assert.equal(upsertReview(db, r), 'new');
  assert.equal(upsertReview(db, r), 'same');
  assert.equal(upsertReview(db, { ...r, replied: 1 }), 'changed');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reviews').get().n, 1);
  assert.equal(db.prepare('SELECT replied FROM reviews').get().replied, 1);
});

test('upsert keeps the view a review was first found in', () => {
  const db = openDb(':memory:');
  const r = toRow(sample);
  upsertReview(db, r, { brand: 'Joyberri', store: 'Joyberri LLC', code: 'CA' });
  upsertReview(db, { ...r, replied: 1 }, { brand: 'Lifepro', store: 'LIFEPRO OUTLET', code: 'US' });
  const row = db.prepare('SELECT sheet_brand, store, marketplace, replied FROM reviews').get();
  assert.deepEqual({ ...row }, { sheet_brand: 'Joyberri', store: 'Joyberri LLC', marketplace: 'CA', replied: 1 });
});
