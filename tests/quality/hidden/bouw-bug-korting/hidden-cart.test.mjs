// Hidden check for the quality test set: the volume discount at and around its limits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { discountRate, orderTotal } from './src/cart.js';

test('discount limits', () => {
  assert.equal(discountRate(0), 0);
  assert.equal(discountRate(4), 0);
  assert.equal(discountRate(5), 0.1);
  assert.equal(discountRate(9), 0.1);
  assert.equal(discountRate(10), 0.15);
  assert.equal(discountRate(25), 0.15);
});

test('order totals', () => {
  assert.equal(orderTotal([]), 0);
  assert.equal(orderTotal([{ priceCents: 999, qty: 1 }]), 999);
  assert.equal(orderTotal([{ priceCents: 2000, qty: 10 }]), 17000);
  assert.equal(orderTotal([{ priceCents: 1999, qty: 2 }, { priceCents: 1, qty: 3 }]), 3601);
});
