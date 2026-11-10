// The screenshot step of the Electron checks (npm run status:check): a first-run GPU hiccup ("UnknownVizError" from
// capturePage) is tried again; every other error, and one that keeps coming, still fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureWithRetry, isVizHiccup } from './e2e/capture-retry.js';

const noSleep = async () => {};

test('screenshot: UnknownVizError is tried again (with a growing pause); the picture comes through', async () => {
  let calls = 0;
  const pauses: number[] = [];
  const retries: number[] = [];
  const img = await captureWithRetry(
    async () => {
      if (++calls < 3) throw new Error('UnknownVizError');
      return 'png';
    },
    { sleep: async (ms) => void pauses.push(ms), onRetry: (n) => retries.push(n) },
  );
  assert.equal(img, 'png');
  assert.equal(calls, 3);
  assert.deepEqual(retries, [1, 2]);
  assert.deepEqual(pauses, [500, 1000]);
});

test('screenshot: other capture errors fail at once; a lasting UnknownVizError fails after 4 tries', async () => {
  for (const msg of ['Frame Gone', 'Timeout', 'VizSentEmptyBitmap', 'Not implemented']) {
    let calls = 0;
    await assert.rejects(
      captureWithRetry(async () => (calls++, Promise.reject(new Error(msg))), { sleep: noSleep }),
      new RegExp(msg),
    );
    assert.equal(calls, 1, `${msg}: not tried again`);
  }
  let calls = 0;
  await assert.rejects(captureWithRetry(async () => (calls++, Promise.reject(new Error('UnknownVizError'))), { sleep: noSleep }), /UnknownVizError/);
  assert.equal(calls, 4);
  assert.equal(isVizHiccup('UnknownVizError'), true, 'also when rejected with a bare string');
  assert.equal(isVizHiccup(new Error('NotUnknownVizErrorish')), false);
});
