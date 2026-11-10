// Hidden check for the quality test set: formatPrice against the README, plus a few cases the README implies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPrice } from './src/format.js';

test('README examples', () => {
  assert.equal(formatPrice(1250), '€ 12,50');
  assert.equal(formatPrice(123456), '€ 1.234,56');
  assert.equal(formatPrice(0), '€ 0,00');
  assert.equal(formatPrice(-300), '-€ 3,00');
});

test('small, large and negative amounts', () => {
  assert.equal(formatPrice(5), '€ 0,05');
  assert.equal(formatPrice(99), '€ 0,99');
  assert.equal(formatPrice(100000), '€ 1.000,00');
  assert.equal(formatPrice(100000000), '€ 1.000.000,00');
  assert.equal(formatPrice(-123456), '-€ 1.234,56');
});
