import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayment, formatAmount } from '../src/payments.js';

test('bedrag in euro met twee decimalen', () => {
  assert.equal(formatAmount(1050), '10.50');
});

test('maakt een testbetaling aan bij de betaalprovider', async () => {
  // Mock fetch voor een onafhankelijke test
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url.includes('/payments')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'pay_123', status: 'open', amount: 10, currency: 'EUR' }),
      };
    }
    return originalFetch(url, options);
  };

  const p = await createPayment(1000, 'Order 1043');
  assert.equal(p.status, 'open');
});
