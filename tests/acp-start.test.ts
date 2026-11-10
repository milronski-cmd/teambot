import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestApp, type TestApp } from './helpers.js';
import { STARTUP_RACE, startLock } from '../server/modules/cli-agents/acp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = path.join(here, 'fixtures', 'cli-agents-fake-acp.mjs');
const last = (t: TestApp, th: string) => t.app.ctx.store.messages(th).filter((m) => m.role === 'assistant').at(-1)!;

async function bots(t: TestApp, n: number) {
  const p = await t.api('POST', '/providers', { kind: 'acp-custom', config: { command: FAKE_ACP, args: [] } });
  const out: { a: any; th: any }[] = [];
  for (let i = 0; i < n; i++) {
    const a = await t.api('POST', '/agents', { name: `Acp ${i}`, provider_id: p.id, model: '', access_mode: 'ask' });
    out.push({ a, th: await t.api('POST', '/threads', { agentId: a.id }) });
  }
  return out;
}

test('start lock: one start at a time per key, a released or stopped start lets the next one go', async () => {
  const order: string[] = [];
  const first = await startLock('k');
  const second = startLock('k').then((rel) => (order.push('tweede'), rel));
  const other = await startLock('ander');
  order.push('ander');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(order, ['ander'], 'another CLI does not wait');
  first();
  first();
  (await second)();
  other();
  assert.deepEqual(order, ['ander', 'tweede']);
  assert.ok(STARTUP_RACE.test('Error: Standalone server exited before reporting readiness'));
  assert.ok(!STARTUP_RACE.test('Error: not logged in'));
});

test('two ACP bots starting at the same moment both work (OpenCode shares one database while booting)', async () => {
  const t = await startTestApp();
  const lock = path.join(t.dir, 'boot.lock');
  const log = path.join(t.dir, 'fake-cli.log');
  process.env.FAKE_ACP_BOOT_LOCK = lock;
  process.env.FAKE_CLI_LOG = log;
  try {
    const [x, y, z] = await bots(t, 3);
    await Promise.all([x, y, z].map((b) => t.api('POST', `/threads/${b.th.id}/messages`, { content: 'hallo' })));
    for (const b of [x, y, z]) await t.waitIdle(b.th.id, 30_000);
    for (const b of [x, y, z]) {
      const m = last(t, b.th.id);
      assert.equal(m.status, 'done', String(m.parts?.error || ''));
      assert.ok(m.content.length > 0);
    }
    assert.ok(!fs.readFileSync(log, 'utf8').includes('"boot":"locked"'), 'never started while another one was booting');
  } finally {
    delete process.env.FAKE_ACP_BOOT_LOCK;
    delete process.env.FAKE_CLI_LOG;
    await t.close();
  }
});

test('an ACP start that lost a race is retried; after the last try a clear message', async () => {
  const t = await startTestApp();
  const counter = path.join(t.dir, 'starts.txt');
  process.env.FAKE_ACP_FAIL_STARTS = counter;
  process.env.FAKE_ACP_FAIL_N = '2';
  try {
    const [b] = await bots(t, 1);
    await t.say(b.th.id, 'hallo', 30_000);
    let m = last(t, b.th.id);
    assert.equal(m.status, 'done', String(m.parts?.error || ''));
    assert.equal(fs.readFileSync(counter, 'utf8'), '3', 'two failed starts, the third worked');
    assert.equal(m.parts.activity!.filter((a: any) => /startte niet meteen/.test(a.title)).length, 2);

    fs.writeFileSync(counter, '0');
    process.env.FAKE_ACP_FAIL_N = '99';
    await t.say(b.th.id, 'nog eens', 30_000);
    m = last(t, b.th.id);
    assert.equal(m.status, 'error');
    assert.match(m.parts.error!, /kon niet starten: een ander .*database bezet \(4 pogingen\)/);
    assert.doesNotMatch(m.parts.error!, /BUN|chunk-/, 'no stack trace');
  } finally {
    delete process.env.FAKE_ACP_FAIL_STARTS;
    delete process.env.FAKE_ACP_FAIL_N;
    await t.close();
  }
});
