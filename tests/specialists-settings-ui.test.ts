import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';

/** Instellingen › bot › Specialisme: "Internet" and "Leert van je eigen bedrijf" come back in the view and are saved. */
test('specialist view carries web and learnFrom, and a save keeps only known values', async () => {
  const t = await startTestApp();
  try {
    const bot = await t.agent({ name: 'Inkoop' });
    const v0 = await t.api('GET', `/specialists/${bot.id}`);
    assert.equal(v0.web, 'off');
    assert.deepEqual(v0.learnFrom, []);
    const v1 = await t.api('PUT', `/specialists/${bot.id}`, { web: 'products', learnFrom: ['products', 'onzin', 'sales'] });
    assert.equal(v1.web, 'products');
    assert.deepEqual(v1.learnFrom, ['products', 'sales']);
    const v2 = await t.api('PUT', `/specialists/${bot.id}`, { web: 'alles' });
    assert.equal(v2.web, 'off', 'an unknown mode is off');
    assert.deepEqual(v2.learnFrom, ['products', 'sales'], 'untouched');
  } finally {
    await t.close();
  }
});
