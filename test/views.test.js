import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadViews, pickViews, waitingViews, reviewLink, sitesFor } from '../lib/views.js';

const data = loadViews(fileURLToPath(new URL('../views.json', import.meta.url)));

test('Monday is Lifepro North America, Tuesday is Joyberri and Sunello', () => {
  const mon = pickViews(data, ['--day=monday']);
  assert.deepEqual(mon.map((v) => `${v.brand} ${v.code}`), ['Lifepro US', 'Lifepro CA', 'Lifepro MX']);
  const wed = pickViews(data, ['--day=wednesday']);
  assert.deepEqual(wed.map((v) => `${v.brand} ${v.code}`), ['Lifepro UK', 'Lifepro SA', 'Lifepro TR']);
  const tue = pickViews(data, ['--day=tuesday']);
  assert.ok(tue.every((v) => v.brand === 'Joyberri' || v.brand === 'Sunello'));
  assert.deepEqual(pickViews(data, ['--day=thursday']).map((v) => `${v.brand} ${v.code}`), ['Lifepro US']);
  assert.equal(pickViews(data, ['--day=friday']).length, 0);
});

test('today is used when no day is given', () => {
  const monday = new Date('2026-11-23T12:00:00');
  assert.equal(pickViews(data, [], monday)[0].brand, 'Lifepro');
});

test('--view picks one view, even a disabled one', () => {
  assert.equal(pickViews(data, ['--view=joyberri llc/ca'])[0].marketplace, 'Canada');
  assert.equal(pickViews(data, ['--view=LIFEPRO OUTLET/DE'])[0].enabled, false);
  assert.throws(() => pickViews(data, ['--view=Nope/US']));
});

test('rest of Europe still waits; UK, Saudi Arabia and Turkey are on', () => {
  const waiting = waitingViews(data, 'monday').map((v) => v.code);
  assert.ok(waiting.includes('DE'));
  assert.ok(!waiting.includes('UK') && !waiting.includes('SA') && !waiting.includes('TR'));
});

test('each view knows its Seller Central site', () => {
  const by = Object.fromEntries(pickViews(data, ['--day=monday']).concat(pickViews(data, ['--day=wednesday'])).map((v) => [v.code, v]));
  assert.equal(by.US.site, 'NA');
  assert.match(by.UK.url, /^https:\/\/sellercentral\.amazon\.co\.uk\/brand-customer-reviews\//);
  assert.match(by.SA.url, /sellercentral\.amazon\.sa\//);
  assert.match(by.TR.url, /sellercentral\.amazon\.com\.tr\//);
  assert.deepEqual(sitesFor(data, Object.values(by)).map((s) => s.site), ['NA', 'UK', 'SA', 'TR']);
  assert.equal(data.home.site, 'NA');
});

test('review links go to the right Amazon site', () => {
  assert.equal(reviewLink('R1', 'CA'), 'https://www.amazon.ca/gp/customer-reviews/R1');
  assert.equal(reviewLink('R1', 'MX'), 'https://www.amazon.com.mx/gp/customer-reviews/R1');
  assert.equal(reviewLink('R1', 'TR'), 'https://www.amazon.com.tr/gp/customer-reviews/R1');
  assert.equal(reviewLink('R1', null), 'https://www.amazon.com/gp/customer-reviews/R1');
});
