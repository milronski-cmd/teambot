import { formatPrice } from '../src/format.js';

export function test_formatPrice() {
  const tests = [
    { input: 1250, expected: "€ 12,50" },
    { input: 123456, expected: "€ 1.234,56" },
    { input: 0, expected: "€ 0,00" },
    { input: -300, expected: "-€ 3,00" },
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    const actual = formatPrice(test.input);
    if (actual === test.expected) {
      passed++;
    } else {
      console.log(`MIS: formatPrice(${test.input}) gaf ${actual}, maar verwachtte ${test.expected}`);
      failed++;
    }
  }

  console.log(`Geslaagd: ${passed} | Mislukt: ${failed}`);
}

test_formatPrice();
