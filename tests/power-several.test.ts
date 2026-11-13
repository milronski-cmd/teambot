import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { createPowerModule } from '../server/modules/power/index.js';

/**
 * One module object serves every TeamBot in a process (the newcomer check starts eleven): closing one TeamBot stops its
 * own clock, never another's, and no clock keeps reading a closed database ("statement has been finalized" after the
 * check had passed).
 */
test('pc wakker houden: each TeamBot in one process has its own clock, stopped when it closes', async () => {
  const power = createPowerModule({ tickMs: 25 });
  const errors: unknown[] = [];
  const catchAll = (e: unknown) => errors.push(e);
  process.on('uncaughtException', catchAll);
  try {
    const a = await startTestApp({ modules: [power] });
    const b = await startTestApp({ modules: [power] });
    await a.close();
    await new Promise((r) => setTimeout(r, 150));
    // The other TeamBot still looks: its state is read fresh.
    assert.equal(typeof b.app.ctx.services.power.state().enabled, 'boolean');
    await b.close();
    await new Promise((r) => setTimeout(r, 150));
  } finally {
    process.off('uncaughtException', catchAll);
  }
  assert.deepEqual(errors.map((e: any) => e?.message || String(e)), []);
});
