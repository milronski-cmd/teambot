import assert from 'node:assert/strict';
import { formatPrice } from '../src/format.js';

// Test cases based on README.md specifications
assert.strictEqual(formatPrice(1250), '€ 12,50');
assert.strictEqual(formatPrice(123456), '€ 1.234,56');
assert.strictEqual(formatPrice(0), '€ 0,00');
assert.strictEqual(formatPrice(-300), '-€ 3,00');

// Additional edge cases
assert.strictEqual(formatPrice(100), '€ 1,00');
assert.strictEqual(formatPrice(99), '€ 0,99');
assert.strictEqual(formatPrice(5050), '€ 50,50');
assert.strictEqual(formatPrice(-1), '-€ 0,01');
assert.strictEqual(formatPrice(1), '€ 0,01');

console.log('Alle tests geslaagd ✅');
