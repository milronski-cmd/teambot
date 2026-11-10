// The judge of the quality test set (scripts/quality-judge.mjs) with a stubbed Ollama: a strict verdict from a
// streamed answer, answers without numbers by position, and an empty answer is "no verdict" (skipped), never a "no".
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeJudge } from '../../scripts/quality-judge.mjs';

function stub(content: string, opts: { status?: number } = {}) {
  const real = globalThis.fetch;
  let body: any = null;
  globalThis.fetch = (async (_url: any, init: any) => {
    body = JSON.parse(init.body);
    // Streamed NDJSON like Ollama: the JSON answer in small pieces, then done.
    const lines = (content.match(/.{1,7}/gs) || []).map((c) => JSON.stringify({ message: { content: c } })).concat(JSON.stringify({ done: true }));
    return new Response(lines.join('\n') + '\n', { status: opts.status ?? 200 });
  }) as typeof fetch;
  return { restore: () => (globalThis.fetch = real), body: () => body };
}

const rubric = ['Is het vriendelijk?', 'Belooft het niets?'];

test('judge: all yes is ok, any no fails with the reason; the request is strict and streamed', async () => {
  let s = stub(JSON.stringify({ antwoorden: [{ nr: 1, reden: 'ja', ja: true }, { nr: 2, reden: 'prima', ja: true }] }));
  try {
    const { judge, stats } = makeJudge('m');
    assert.deepEqual(await judge({ rubric, material: 'tekst' }), { ok: true, detail: 'alle vragen ja' });
    assert.equal(s.body().stream, true);
    assert.equal(s.body().options.temperature, 0);
    assert.equal(s.body().think, true);
    assert.equal(stats.calls, 1);
  } finally {
    s.restore();
  }
  s = stub(JSON.stringify({ antwoorden: [{ nr: 1, reden: 'ja', ja: true }, { nr: 2, reden: 'belooft korting', ja: false }] }));
  try {
    const v = await makeJudge('m').judge({ rubric, material: 'tekst' });
    assert.equal(v.ok, false);
    assert.match(v.detail, /belooft korting/);
  } finally {
    s.restore();
  }
});

test('judge: answers without numbers count by position', async () => {
  const s = stub(JSON.stringify({ antwoorden: [{ reden: 'a', ja: true }, { reden: 'b', ja: true }] }));
  try {
    assert.equal((await makeJudge('m').judge({ rubric, material: 'tekst' })).ok, true);
  } finally {
    s.restore();
  }
});

test('judge: an empty answer while thinking is asked once more without thinking', async () => {
  const real = globalThis.fetch;
  const thinks: any[] = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    const b = JSON.parse(init.body);
    thinks.push(b.think);
    const content = b.think ? '' : JSON.stringify({ antwoorden: [{ nr: 1, reden: 'a', ja: true }, { nr: 2, reden: 'b', ja: true }] });
    return new Response(JSON.stringify({ message: { content } }) + '\n' + JSON.stringify({ done: true }) + '\n');
  }) as typeof fetch;
  try {
    assert.equal((await makeJudge('m').judge({ rubric, material: 'tekst' })).ok, true);
    assert.deepEqual(thinks, [true, false]);
  } finally {
    globalThis.fetch = real;
  }
});

test('judge: an empty or broken answer, or an error, is no verdict (skipped)', async () => {
  for (const [content, status] of [['{}', 200], ['{"antwoorden":[]}', 200], ['geen json', 200], ['', 500]] as const) {
    const s = stub(content, { status });
    try {
      const { judge, stats } = makeJudge('m');
      const v = await judge({ rubric, material: 'tekst' });
      assert.equal(v.skipped, true, content);
      assert.equal(v.ok, false);
      assert.equal(stats.errors, 1);
    } finally {
      s.restore();
    }
  }
});
