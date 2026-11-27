import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeModel } from '../server/modules/memory/builtin-embed.js';

// The built-in search model is first loaded in a process of its own: a model that fails or crashes ONNX Runtime there
// never takes TeamBot down (24 Nov 2026: an access violation in onnxruntime-node 1.30.0 closed TeamBot at every turn).
test('probeModel: a model that does not load gives a reason, outside this process, and the answer is kept', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-probe-'));
  try {
    fs.writeFileSync(path.join(dir, 'model.onnx'), Buffer.from('geen echt model'));
    const first = await probeModel(dir, 60_000);
    assert.ok(first, 'a broken model is not OK');
    assert.match(first!, /Zoeken op woorden werkt gewoon/);
    const kept = JSON.parse(fs.readFileSync(path.join(dir, 'probe.json'), 'utf8'));
    assert.equal(kept.ok, false);
    // Kept: the second call reads it back instead of starting another process.
    fs.rmSync(path.join(dir, 'model.onnx'));
    assert.equal(await probeModel(dir, 60_000), first);
    assert.ok(process.pid > 0, 'this process is still here');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
