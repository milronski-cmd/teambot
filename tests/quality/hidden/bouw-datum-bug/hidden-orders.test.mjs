// Hidden check for the quality test set: every day of a month counts, and only that month.
import test from 'node:test';
import assert from 'node:assert/strict';
import { monthRevenue, ordersInMonth } from './src/orders.js';

const dates = (list) => list.map((o) => o.date);

test('last day of the month is included', () => {
  const orders = [
    { date: '2026-09-30', cents: 1 },
    { date: '2026-10-01', cents: 10 },
    { date: '2026-10-30', cents: 100 },
    { date: '2026-10-31', cents: 1000 },
    { date: '2026-11-01', cents: 10000 },
  ];
  assert.deepEqual(dates(ordersInMonth(orders, 2026, 10)), ['2026-10-01', '2026-10-30', '2026-10-31']);
  assert.equal(monthRevenue(orders, 2026, 10), 1110);
  assert.deepEqual(dates(ordersInMonth(orders, 2026, 9)), ['2026-09-30']);
  assert.deepEqual(dates(ordersInMonth(orders, 2026, 11)), ['2026-11-01']);
});

test('short and long months, year boundary', () => {
  const orders = [
    { date: '2028-02-28', cents: 1 },
    { date: '2028-02-29', cents: 2 },
    { date: '2028-03-01', cents: 4 },
    { date: '2026-12-31', cents: 8 },
    { date: '2027-01-01', cents: 16 },
    { date: '2027-01-31', cents: 32 },
  ];
  assert.deepEqual(dates(ordersInMonth(orders, 2028, 2)), ['2028-02-28', '2028-02-29']);
  assert.deepEqual(dates(ordersInMonth(orders, 2026, 12)), ['2026-12-31']);
  assert.equal(monthRevenue(orders, 2027, 1), 48);
});
