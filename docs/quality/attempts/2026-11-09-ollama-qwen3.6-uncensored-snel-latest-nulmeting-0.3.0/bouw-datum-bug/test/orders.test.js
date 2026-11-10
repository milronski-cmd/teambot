import test from 'node:test';
import assert from 'node:assert/strict';
import { monthRevenue, ordersInMonth } from '../src/orders.js';

test('orders van oktober bevat ook 31 oktober', () => {
  const orders = [
    { date: '2026-10-05', cents: 1000 },
    { date: '2026-10-31', cents: 5990 },
    { date: '2026-11-02', cents: 750 },
  ];
  assert.deepEqual(
    ordersInMonth(orders, 2026, 10).map((o) => o.date),
    ['2026-10-05', '2026-10-31', '2026-11-02'],
  );
});

test('omzet van een maand', () => {
  const orders = [
    { date: '2026-09-10', cents: 3495 },
    { date: '2026-09-12', cents: 1500 },
  ];
  assert.equal(monthRevenue(orders, 2026, 9), 4995);
});
