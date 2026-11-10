import { formatPrice } from '../src/format.js';

// Tests voor formatPrice

// Basisgevallen
const test1 = formatPrice(1250);
if (test1 !== '€ 12,50') throw new Error(`Test 1 faalde: ${test1} is niet '€ 12,50'`);

const test2 = formatPrice(123456);
if (test2 !== '€ 1.234,56') throw new Error(`Test 2 faalde: ${test2} is niet '€ 1.234,56'`);

const test3 = formatPrice(0);
if (test3 !== '€ 0,00') throw new Error(`Test 3 faalde: ${test3} is niet '€ 0,00'`);

const test4 = formatPrice(-300);
if (test4 !== '-€ 3,00') throw new Error(`Test 4 faalde: ${test4} is niet '-€ 3,00'`);
