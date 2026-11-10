import test from 'node:test';
import assert from 'node:assert/strict';
import { orderTotal } from '../src/cart.js';

test('geen korting onder de 5 stuks', () => {
  assert.equal(orderTotal([{ priceCents: 1000, qty: 4 }]), 4000);
});
