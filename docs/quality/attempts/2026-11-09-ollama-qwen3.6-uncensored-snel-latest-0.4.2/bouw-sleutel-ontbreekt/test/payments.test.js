import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayment, formatAmount } from '../src/payments.js';

test('bedrag in euro met twee decimalen', () => {
  assert.equal(formatAmount(1050), '10.50');
});

test('maakt een testbetaling aan bij de betaalprovider', async () => {
  const mockResponse = { status: 'open', id: 'pay_12345' };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Promise.resolve({
    ok: true,
    json: async () => mockResponse
  });
  
  try {
    const result = await createPayment(1000, 'Order 1043');
    assert.equal(result.status, 'open');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
