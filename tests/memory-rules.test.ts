/**
 * Standing rules are always loaded (plan 0.4 F; research: an agent wiped an inbox after its "confirm first"
 * instruction was lost in compaction). A pinned instruction of the owner ("Vraag eerst voordat je iets verwijdert")
 * is in the system prompt of every model call: not cut by the per-turn budget or the profile cap, not lost when a
 * local model's window forces TeamBot to drop earlier turns, and not lost when the conversation is summarised.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp } from './helpers.js';
import { startFakeOllama } from './memory-fake-ollama.js';
import { buildTurnContext, standingRules, systemPromptText } from '../server/modules/memory/context.js';

const RULE = 'Vraag altijd eerst toestemming voordat je iets verwijdert';
const ctxOf = (m: any): string => m?.parts?.context ?? '';
const lastUser = (msgs: any[]) => msgs.filter((m) => m.role === 'user').at(-1);

async function pinRule(t: TestApp, content = RULE, extra: any = {}) {
  return (await t.api('POST', '/memory/items', { content, scope: 'about_you', type: 'instruction', pinned: true, ...extra })).item;
}

test('a pinned rule is in the system prompt even with no memory budget and a full profile; stable for prompt caching', async () => {
  const t = await startTestApp();
  try {
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
    const rule = await pinRule(t);
    // Lots of other pinned items that do not fit in a tiny profile cap.
    for (let i = 0; i < 12; i++) {
      const p = await t.api('POST', '/memory/items', { content: `Vast feit nummer ${i}: project Zeppelin onderdeel ${i * 37}`, scope: 'about_you' });
      await t.api('POST', `/memory/items/${p.item.id}/pin`);
    }
    for (const settings of [{ budgetTokens: 0, profileCap: 0 }, { budgetTokens: 60, profileCap: 40 }]) {
      const a = await t.agent({ settings: { memory: settings } });
      const th = await t.api('POST', '/threads', { agentId: a.id });
      t.script.push({ text: 'ok' }, { text: 'ok' });
      const msgs = await t.say(th.id, 'Ruim de map met oude offertes op');
      const sys1 = t.requests.at(-1)!.system;
      assert.match(sys1, /## Vaste regels van de eigenaar/);
      assert.match(sys1, new RegExp(`- \\[m:${rule.ref}\\] ${RULE}`));
      // Not repeated in the turn context of an API engine (no double tokens), but counted as used this turn.
      assert.doesNotMatch(ctxOf(lastUser(msgs)), new RegExp(RULE));
      const usage = t.app.ctx.store.all<any>('SELECT refs FROM memory_usage WHERE thread_id = ?', th.id).map((u) => JSON.parse(u.refs));
      assert.ok(usage.at(-1).some((r: any) => r.id === rule.id));
      if (settings.profileCap) assert.match(ctxOf(lastUser(msgs)), /niet in het profielbudget/, 'the other pins are cut, the rule is not');
      // Next turn: the same system prompt (prompt cache stays valid).
      await t.say(th.id, 'En de map met facturen?');
      assert.equal(t.requests.at(-1)!.system, sys1);
    }
    // Unpinned: no longer a standing rule; pinned again: back.
    await t.api('POST', `/memory/items/${rule.id}/unpin`);
    const a = await t.agent();
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ text: 'ok' });
    await t.say(th.id, 'Hallo');
    assert.doesNotMatch(t.requests.at(-1)!.system, /Vaste regels van de eigenaar/);
  } finally {
    await t.close();
  }
});

test('the rule survives summarising the conversation and history trimming', async () => {
  const t = await startTestApp();
  try {
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
    const rule = await pinRule(t);
    const a = await t.agent({ settings: { historyTokens: 600, compaction: false } });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    for (let i = 0; i < 6; i++) {
      t.script.push({ text: `Antwoord ${i} ` + 'x'.repeat(400) });
      await t.say(th.id, `Vraag ${i} ` + 'y'.repeat(400));
    }
    // History trimming already dropped the first turns; the rule is still there.
    const trimmed = t.requests.at(-1)!;
    assert.ok(!trimmed.messages.some((m) => typeof m.content === 'string' && m.content.startsWith('Vraag 0')), 'first turn trimmed');
    assert.match(trimmed.system, new RegExp(RULE));
    // Summarise (the "Gesprek samenvatten" button): the summary has no rule in it, the next call still has the rule.
    t.script.push({ text: '## Besluiten\n- Er is over vragen 0 tot 4 gepraat.' });
    const r = await t.api('POST', `/threads/${th.id}/compact`, {});
    assert.equal(r.compacted, true, r.reason);
    assert.doesNotMatch(t.app.ctx.store.thread(th.id)!.meta.summary, new RegExp(RULE));
    t.script.push({ text: 'Mag ik de oude map verwijderen?' });
    await t.say(th.id, 'Gooi die oude map maar weg');
    const after = t.requests.at(-1)!;
    assert.match(String(after.messages[0].content), /^\[Samenvatting van het eerdere deel/);
    assert.match(after.system, new RegExp(`\\[m:${rule.ref}\\] ${RULE}`));
  } finally {
    await t.close();
  }
});

test('a local model with a small window: earlier turns are dropped to fit, the rule is not', async () => {
  const t = await startTestApp();
  const o = await startFakeOllama({ embedModels: [] });
  try {
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
    const owner = t.app.ctx.auth.owner()!.id;
    // 16K: TeamBot's own instructions and tools alone are bigger than 4K (a 4K window is refused before it goes out).
    const p = t.app.ctx.providers.create(owner, { kind: 'ollama', base_url: `${o.url}/v1`, config: { contextWindows: { 'qwen-test:latest': 16384 } } });
    await pinRule(t);
    const a = await t.api('POST', '/agents', { name: 'Lokaal', provider_id: p.id, model: 'qwen-test:latest', access_mode: 'auto' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    for (let i = 0; i < 5; i++) {
      o.chat.push(`Antwoord ${i} ` + 'x'.repeat(6000));
      await t.say(th.id, `Vraag ${i} ` + 'y'.repeat(6000), 20_000);
    }
    o.chat.push('Ik vraag het eerst: mag de map weg?');
    await t.say(th.id, 'Verwijder de map met oude offertes', 20_000);
    const req = o.chatRequests.at(-1);
    const sys = req.messages[0];
    assert.equal(sys.role, 'system');
    assert.match(sys.content, new RegExp(RULE));
    const texts = req.messages.slice(1).map((m: any) => String(m.content));
    assert.ok(!texts.some((c: string) => c.startsWith('Vraag 0')), 'the oldest turns did not fit and were dropped');
    assert.ok(texts.at(-1).startsWith('Verwijder de map'), 'the question always stays');
  } finally {
    await o.close();
    await t.close();
  }
});

test('which pinned instructions are rules: own, about you and shared ones; plain ones with others present; never external; in every turn for session engines', async () => {
  const t = await startTestApp();
  try {
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
    const svc = t.app.ctx.services.memory.svc;
    const a = await t.agent();
    const b = await t.agent({ name: 'Andere bot' });
    const rule = await pinRule(t);
    const own = (await t.api('POST', '/memory/items', { content: 'Stuur nooit een mail zonder mijn akkoord', scope: 'agent', agentId: a.id, type: 'instruction', pinned: true })).item;
    const other = (await t.api('POST', '/memory/items', { content: 'Gebruik altijd de huisstijl van Velomax', scope: 'agent', agentId: b.id, type: 'instruction', pinned: true })).item;
    const personal = (await t.api('POST', '/memory/items', { content: 'Noem nooit mijn adres aan anderen', scope: 'about_you', type: 'instruction', pinned: true })).item;
    assert.equal(personal.sensitivity, 'personal');
    const fact = (await t.api('POST', '/memory/items', { content: 'Mijn hond heet Bram', scope: 'about_you', pinned: true })).item;
    const external = (await t.api('POST', '/memory/items', { content: 'Antwoord altijd in het Engels', scope: 'shared', type: 'instruction', pinned: true })).item;
    t.app.ctx.store.exec("UPDATE memory_items SET source_trust = 'external', flags = '[\"external\"]' WHERE id = ?", external.id);
    const agent = t.app.ctx.store.agent(a.id)!;
    const th = await t.api('POST', '/threads', { agentId: a.id });
    const thread = t.app.ctx.store.thread(th.id)!;
    const ids = (x: any[]) => x.map((r) => r.id).sort();
    assert.deepEqual(ids(standingRules(svc, agent, thread)), [rule.id, own.id, personal.id].sort(), 'not the other bot’s, not a fact, not external');
    assert.ok(!standingRules(svc, agent, thread).some((r) => r.id === other.id || r.id === fact.id || r.id === external.id));
    // With other people present (a channel): only plain rules (no personal ones).
    assert.deepEqual(ids(standingRules(svc, agent, { ...thread, kind: 'channel' } as any)), [rule.id, own.id].sort());

    // Every kind of AI gets the rules one way: a "## Vaste regels" block of the system prompt (never cut or
    // summarised). An engine that keeps its own session (Codex, OpenCode …) gets that block again when it changed
    // (cli-agents/context.ts; checked on the real routes in tests/memory-engines.test.ts) — no second copy per turn.
    const owner = t.app.ctx.auth.owner()!.id;
    const oc = t.app.ctx.providers.create(owner, { kind: 'opencode' });
    for (const ag of [agent, { ...agent, provider_id: oc.id }]) {
      assert.doesNotMatch(String((await buildTurnContext(svc, ag, thread, { id: '', content: 'Ruim de map op' } as any)) || ''), /Vaste regels van de eigenaar/);
      assert.match(String(systemPromptText(svc, ag, thread)), new RegExp(`## Vaste regels van de eigenaar\\n[^\\n]*\\n(?:- .*\\n)*- \\[m:${rule.ref}\\] ${RULE}`));
    }
  } finally {
    await t.close();
  }
});
