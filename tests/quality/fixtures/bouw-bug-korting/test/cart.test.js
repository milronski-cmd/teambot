import test from 'node:test';
import assert from 'node:assert/strict';
import { discountRate, orderTotal } from '../src/cart.js';

test('geen korting onder de 5 stuks', () => {
  assert.equal(orderTotal([{ priceCents: 1000, qty: 4 }]), 4000);
});

test('10% korting vanaf 5 stuks', () => {
  assert.equal(orderTotal([{ priceCents: 1000, qty: 5 }]), 4500);
});

test('15% korting vanaf 10 stuks', () => {
  assert.equal(discountRate(10), 0.15);
});

test('regels samen tellen voor de korting', () => {
  assert.equal(orderTotal([{ priceCents: 1250, qty: 3 }, { priceCents: 500, qty: 3 }]), 4725);
});
