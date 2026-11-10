import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPrice } from '../src/format.js';

test('voorbeelden uit de README', () => {
  assert.equal(formatPrice(1250), '€ 12,50');
  assert.equal(formatPrice(123456), '€ 1.234,56');
  assert.equal(formatPrice(0), '€ 0,00');
  assert.equal(formatPrice(-300), '-€ 3,00');
});
