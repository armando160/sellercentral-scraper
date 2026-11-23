import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadViews, pickViews, waitingViews, reviewLink } from '../lib/views.js';

const data = loadViews(fileURLToPath(new URL('../views.json', import.meta.url)));

test('Monday is Lifepro North America, Tuesday is Joyberri and Sunello', () => {
  const mon = pickViews(data, ['--day=monday']);
  assert.deepEqual(mon.map((v) => `${v.brand} ${v.code}`), ['Lifepro US', 'Lifepro CA', 'Lifepro MX']);
  const tue = pickViews(data, ['--day=tuesday']);
  assert.ok(tue.every((v) => v.brand === 'Joyberri' || v.brand === 'Sunello'));
  assert.equal(pickViews(data, ['--day=friday']).length, 0);
});

test('today is used when no day is given', () => {
  const monday = new Date('2026-11-23T12:00:00');
  assert.equal(pickViews(data, [], monday)[0].brand, 'Lifepro');
});

test('--view picks one view, even a disabled one', () => {
  assert.equal(pickViews(data, ['--view=joyberri llc/ca'])[0].marketplace, 'Canada');
  assert.equal(pickViews(data, ['--view=LIFEPRO OUTLET/UK'])[0].enabled, false);
  assert.throws(() => pickViews(data, ['--view=Nope/US']));
});

test('Europe waits for access', () => {
  assert.ok(waitingViews(data, 'monday').some((v) => v.code === 'UK'));
});

test('review links go to the right Amazon site', () => {
  assert.equal(reviewLink('R1', 'CA'), 'https://www.amazon.ca/gp/customer-reviews/R1');
  assert.equal(reviewLink('R1', 'MX'), 'https://www.amazon.com.mx/gp/customer-reviews/R1');
  assert.equal(reviewLink('R1', null), 'https://www.amazon.com/gp/customer-reviews/R1');
});
