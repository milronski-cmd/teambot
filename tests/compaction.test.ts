import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';

test('compaction summarises older turns and history sends the summary instead', async () => {
  const t = await startTestApp({ modules: [] });
  try {
    const a = await t.agent({ settings: { historyTokens: 400, compaction: false } });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    for (let i = 0; i < 6; i++) {
      t.script.push({ text: `Antwoord ${i} ` + 'x'.repeat(300) });
      await t.say(th.id, `Vraag ${i} ` + 'y'.repeat(300));
    }
    // Automatic compaction is off for this bot; the button (force) still works.
    assert.equal(t.app.ctx.store.thread(th.id)!.meta.summary, undefined);
    t.script.push({ text: '## Besluiten\n- Samenvatting van vraag 0 tot en met 3' });
    const r = await t.api('POST', `/threads/${th.id}/compact`, {});
    assert.equal(r.compacted, true, r.reason);
    const thread = t.app.ctx.store.thread(th.id)!;
    assert.match(thread.meta.summary, /Samenvatting/);
    assert.ok(thread.meta.summaryUpTo > 0);
    const events = t.app.ctx.store.messages(th.id).filter((m: any) => m.role === 'event' && m.parts?.compaction);
    assert.ok(events.length >= 1);

    t.script.push({ text: 'ok' });
    await t.say(th.id, 'Nieuwe vraag');
    const last = t.requests[t.requests.length - 1];
    const first = last.messages[0];
    assert.equal(first.role, 'user');
    assert.match(String(first.content), /^\[Samenvatting van het eerdere deel/);
    assert.ok(!last.messages.some((m) => typeof m.content === 'string' && m.content.startsWith('Vraag 0')), 'summarised turns are not resent');
    // Originals are kept and searchable.
    assert.ok(t.app.ctx.store.messages(th.id).some((m: any) => m.content.startsWith('Vraag 0')));
    // Usage of the compaction call is logged for cost transparency.
    assert.ok(t.app.ctx.store.all('SELECT * FROM usage_log WHERE agent_id = ?', a.id).length >= 7);
  } finally {
    await t.close();
  }
});

test('a thinking model that returns no text: asked once more with thinking off and more room (round 5: "lege samenvatting")', async () => {
  const t = await startTestApp({ modules: [] });
  try {
    const a = await t.agent({ settings: { compaction: false } });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    for (let i = 0; i < 4; i++) {
      t.script.push({ text: `A${i}` });
      await t.say(th.id, `V${i}`);
    }
    const n = t.requests.length;
    t.script.push({ text: '' }, { text: '## Besluiten\n- V0 en V1 besproken' });
    const r = await t.api('POST', `/threads/${th.id}/compact`, {});
    assert.equal(r.compacted, true, r.reason);
    assert.equal(t.requests.length, n + 2);
    assert.equal(t.requests[n].reasoning, undefined, 'the first try is the bot\'s usual request');
    assert.equal(t.requests[n + 1].reasoning, 'none');
    assert.ok(Number(t.requests[n + 1].maxTokens) > Number(t.requests[n].maxTokens));
    assert.match(t.app.ctx.store.thread(th.id)!.meta.summary, /V0 en V1 besproken/);
    // Still nothing: a plain reason, no "lege samenvatting".
    t.script.push({ text: 'A4' });
    await t.say(th.id, 'V4');
    t.script.push({ text: '' }, { text: '' });
    const r2 = await t.api('POST', `/threads/${th.id}/compact`, {});
    assert.equal(r2.compacted, false);
    assert.equal(r2.reason, 'het model gaf geen samenvatting terug; probeer het later nog eens');
  } finally {
    await t.close();
  }
});

test('automatic compaction kicks in after a run when the history is near the budget', async () => {
  const t = await startTestApp({ modules: [] });
  try {
    const a = await t.agent({ settings: { historyTokens: 300 } });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ text: 'A ' + 'x'.repeat(400) });
    await t.say(th.id, 'B ' + 'y'.repeat(400));
    t.script.push({ text: 'C ' + 'x'.repeat(400) });
    await t.say(th.id, 'D ' + 'y'.repeat(400));
    let summary: string | undefined;
    for (let i = 0; i < 100 && !summary; i++) {
      await new Promise((r) => setTimeout(r, 20));
      summary = t.app.ctx.store.thread(th.id)!.meta.summary;
    }
    assert.ok(summary, 'summary written automatically');
  } finally {
    await t.close();
  }
});

test('manual summarise works on a short conversation that fits the budget', async () => {
  const t = await startTestApp({ modules: [] });
  try {
    const a = await t.agent({ settings: { compaction: false } });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    for (let i = 0; i < 4; i++) {
      t.script.push({ text: `A${i}` });
      await t.say(th.id, `V${i}`);
    }
    t.script.push({ text: 'Samenvatting: V0-V1 besproken' });
    const r = await t.api('POST', `/threads/${th.id}/compact`, {});
    assert.equal(r.compacted, true, r.reason);
    t.script.push({ text: 'ok' });
    await t.say(th.id, 'V5');
    const msgs = t.requests[t.requests.length - 1].messages;
    assert.match(String(msgs[0].content), /Samenvatting: V0-V1/);
    assert.ok(msgs.some((m) => m.content === 'V3' || String(m.content).includes('V3')), 'recent turns kept verbatim');
  } finally {
    await t.close();
  }
});
