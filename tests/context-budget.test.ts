// TeamBot 0.4, package Y (efficiënter): measure the context per part, shorten it safely for every provider, send fewer
// tool definitions, keep prompt caching effective and delegated work lean. See server/agent/context-budget.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockAdapter, startTestApp, type TestApp } from './helpers.js';
import { modules } from '../server/modules/index.js';
import { FIXTURES, fixtureModule, runFixture, type Fixture } from './fixtures/context-conversations.js';
import { buildHistory } from '../server/agent/history.js';
import { carryBlock, cliContextStats, cliRecord, editsKey, measure, ownerRules, pinnedLines, SAVER_DEFAULTS, saverSettings, stripStaleThinking, sumParts } from '../server/agent/context-budget.js';
import { LOADER_NAME, selectTools } from '../server/tools/selection.js';
import { cacheParams } from '../server/providers/anthropic.js';
import type { ChatMsg, ChatRequest, ToolDef } from '../server/core/types.js';

const tokensOf = (reqs: ChatRequest[]) => reqs.reduce((n, r) => n + sumParts(measure(r.system, r.tools, r.messages)), 0);
const json = (x: any) => JSON.stringify(x);
const textOf = (m: ChatMsg) => (typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n'));
const withFixtures = () => startTestApp({ modules: [...modules, fixtureModule()] });

/** Which turn each request belongs to: every scripted step is one model call. */
function turnOfRequests(fx: Fixture): number[] {
  return fx.turns.flatMap((t, i) => t.steps.map(() => i));
}

async function both(fx: Fixture, settings?: Record<string, any>) {
  const out: Record<'off' | 'on', { requests: ChatRequest[]; t: TestApp; threadId: string; agentId: string }> = {} as any;
  for (const mode of ['off', 'on'] as const) {
    const t = await withFixtures();
    const r = await runFixture(t, fx, { saver: mode === 'on', settings });
    out[mode] = { ...r, t };
  }
  return out;
}

test('fixture conversations: at least 30% fewer input tokens than 0.3.0, with the question, pinned rules and facts kept', async () => {
  const report: string[] = [];
  let offAll = 0;
  let onAll = 0;
  for (const fx of FIXTURES) {
    const r = await both(fx);
    try {
      const off = tokensOf(r.off.requests);
      const on = tokensOf(r.on.requests);
      offAll += off;
      onAll += on;
      const drop = 1 - on / off;
      report.push(`${fx.id}: ${r.on.requests.length} model calls, ${off} → ${on} tokens (−${Math.round(drop * 100)}%)`);
      assert.equal(r.on.requests.length, r.off.requests.length, `${fx.id}: same conversation`);
      assert.ok(drop >= 0.3, `${fx.id}: ${Math.round(drop * 100)}% fewer tokens, expected at least 30%`);

      const turnOf = turnOfRequests(fx);
      r.on.requests.forEach((req, i) => {
        const question = fx.turns[turnOf[i]].user;
        const lastUser = req.messages.findLast((m) => m.role === 'user')!;
        assert.ok(textOf(lastUser).includes(question), `${fx.id} call ${i}: the current question is sent as it is`);
        // The output of the current turn is never cut as "older output" (a very long run cuts only far-back steps).
        const after = req.messages.slice(req.messages.lastIndexOf(lastUser) + 1).filter((m) => m.role === 'tool');
        for (const m of after) assert.doesNotMatch(textOf(m), /oudere uitvoer van/, `${fx.id} call ${i}: tool output of this turn is complete`);
        // Since package F the owner's pinned instructions are standing rules in the system prompt (never cut).
        for (const p of fx.pinned || []) assert.ok(req.system.includes(p) || json(req.messages).includes(p), `${fx.id} call ${i}: pinned rule "${p}" is in the context`);
        // (the id of a pinned rule differs per test app: [m:…])
        const noPath = (x: string) => x.replace(/Je werkmap is [^\n]*/, '').replace(/\[m:[a-z0-9]+\]/g, '[m:…]');
        assert.equal(noPath(req.system), noPath(r.off.requests[i].system), `${fx.id} call ${i}: system prompt untouched`);
      });
      const last = json(r.on.requests.at(-1)!.messages) + r.on.requests.at(-1)!.system;
      for (const f of fx.facts) assert.ok(last.includes(f), `${fx.id}: "${f}" is still there at the end`);

      // Nothing silent: whatever was shortened says so, to the bot and in the stats on the answer.
      const all = r.on.requests.map((x) => json(x.messages)).join('\n');
      const answers = r.on.t.app.ctx.store.messages(r.on.threadId).filter((m) => m.role === 'assistant');
      const stats = answers.map((m) => m.parts.contextStats).filter(Boolean);
      assert.equal(stats.length, answers.length, `${fx.id}: every answer has its context stats`);
      for (const s of stats) {
        assert.equal(s.total, s.parts.system + s.parts.tools + s.parts.memory + s.parts.history + s.parts.toolOutputs + s.parts.attachments);
        assert.ok(s.reported?.input > 0, 'the engine count is stored next to the estimate');
      }
      const shortenedHere = stats.reduce((n, s) => n + s.shortened.toolOutputs + s.shortened.duplicates, 0);
      if (fx.id !== 'service') {
        assert.ok(shortenedHere > 0, `${fx.id}: older tool output was shortened`);
        assert.match(all, /Ingekort door TeamBot om ruimte te sparen/);
      }
      const lastStats = stats.at(-1)!;
      assert.ok(lastStats.tools.sent < lastStats.tools.of && lastStats.tools.leftOut.length, `${fx.id}: fewer tool definitions, and which ones were left out`);
      assert.ok(r.on.requests.every((x) => x.tools.some((s) => s.name === LOADER_NAME)), `${fx.id}: the bot can always load the rest`);
      assert.ok(r.off.requests.every((x) => !x.tools.some((s) => s.name === LOADER_NAME)), `${fx.id}: 0.3.0 sends everything`);
      assert.doesNotMatch(r.off.requests.map((x) => json(x.messages)).join('\n'), /Ingekort door TeamBot/, `${fx.id}: off is the 0.3.0 history`);
    } finally {
      await r.off.t.close();
      await r.on.t.close();
    }
  }
  report.push(`all: ${offAll} → ${onAll} tokens (−${Math.round((1 - onAll / offAll) * 100)}%)`);
  console.log(report.join('\n'));
  assert.ok(1 - onAll / offAll >= 0.3);
});

test('prompt caching: system prompt and tool list byte-identical across turns; the history only grows between cut moves', async () => {
  for (const fx of FIXTURES) {
    const t = await withFixtures();
    try {
      const { requests } = await runFixture(t, fx, { saver: true });
      assert.equal(new Set(requests.map((r) => r.system)).size, 1, `${fx.id}: one system prompt for the whole conversation`);
      // The tool list changes only when a part is added (the webshop names Google Sheets in turn 3), never back.
      const lists = requests.map((r) => json(r.tools));
      let changes = 0;
      for (let i = 1; i < lists.length; i++) if (lists[i] !== lists[i - 1]) changes++;
      assert.ok(changes <= (fx.id === 'webshop' ? 1 : 0), `${fx.id}: ${changes} tool-list changes`);
      // Between consecutive calls the previous request is a prefix of the next one, except where a cut point moved
      // (every few turns) — 0.3.0 had no such moves, but sent the full output every time.
      let breaks = 0;
      for (let i = 1; i < requests.length; i++) {
        const prev = requests[i - 1].messages;
        if (json(requests[i].messages.slice(0, prev.length)) !== json(prev)) breaks++;
      }
      assert.ok(breaks <= Math.ceil(fx.turns.length / SAVER_DEFAULTS.step) + 1, `${fx.id}: ${breaks} history changes in ${requests.length} calls`);
      // Within one turn (one run of tool calls) the history is append-only unless a block of old steps is shortened.
      console.log(`${fx.id}: ${requests.length} calls, ${breaks} history changes, ${changes} tool-list changes`);
    } finally {
      await t.close();
    }
  }
});

test("pinned memory rules and the owner's own rules survive when older turns are dropped (and 0.3.0 lost them)", async () => {
  const fx = FIXTURES.find((f) => f.id === 'service')!;
  const r = await both(fx, { historyTokens: 1500 });
  try {
    const lastOn = r.on.requests.at(-1)!;
    const on = json(lastOn.messages);
    const has = (req: ChatRequest, x: string) => json(req.messages).includes(x);
    const PIN = 'Vraag eerst toestemming voordat je iets naar een klant stuurt.';
    const RULE = 'noem nooit prijzen zonder btw';
    // 0.3.0: the first turn fell off, and with it the pinned rule (the memory block names an item again only after 10
    // turns) and the owner's own words (until the memory learner happened to store them as a note). Since package F
    // the owner's pinned instructions are standing rules in the system prompt, in every call; the saver carries the
    // owner's own words (and other pinned lines of the memory block, see the carryBlock unit test).
    assert.ok([...r.off.requests, ...r.on.requests].every((x) => x.system.includes(PIN)), 'the pinned rule is in every call (system prompt)');
    assert.ok(r.on.requests.every((x) => has(x, RULE)), 'with the saver every call has the owner rule');
    assert.match(on, /Afspraken van de eigenaar[^"]*\\n- “Voortaan: noem nooit prijzen zonder btw tegen klanten\.”/);
    assert.match(on, /TeamBot heeft \d+ oudere berichten van dit gesprek weggelaten om ruimte te sparen/);
    assert.ok(textOf(lastOn.messages.at(-1)!).includes(fx.turns.at(-1)!.user), 'the question stays');
    // The cut is stable: it moves in blocks of turns, so most calls start the same way.
    // (Also the memory module's running summary in front stays the same while the cut does.)
    const firsts = r.on.requests.map((x) => textOf(x.messages[0]));
    assert.ok(new Set(firsts).size <= Math.ceil(fx.turns.length / SAVER_DEFAULTS.step) + 1, `the start changed ${new Set(firsts).size} times in ${firsts.length} calls`);
    const offFirsts = r.off.requests.map((x) => textOf(x.messages[0]));
    assert.ok(new Set(firsts).size < new Set(offFirsts).size, `0.3.0 changed its start more often (${new Set(offFirsts).size}×)`);
    const st = r.on.t.app.ctx.store.messages(r.on.threadId).filter((m) => m.role === 'assistant').at(-1)!.parts.contextStats;
    assert.ok(st.shortened.dropped > 0 && st.shortened.carried >= 1, 'the stats say what was dropped and carried');
  } finally {
    await r.off.t.close();
    await r.on.t.close();
  }
});

test('a compaction summary in front keeps the pinned rule and the owner rule of the summarised part', async () => {
  const fx = FIXTURES.find((f) => f.id === 'service')!;
  const t = await withFixtures();
  try {
    const short: Fixture = { ...fx, turns: fx.turns.slice(0, 8) };
    const { threadId } = await runFixture(t, short, { saver: true });
    t.script.push({ text: '## Besluiten\n- Klantvragen 1 tot 6 besproken' });
    const c = await t.api('POST', `/threads/${threadId}/compact`, {});
    assert.equal(c.compacted, true, c.reason);
    t.script.push({ text: 'Zeker, ik zet het klaar.' });
    await t.say(threadId, 'Zet het antwoord op vraag 7 klaar.');
    const first = textOf(t.requests.at(-1)!.messages[0]);
    assert.match(first, /^\[Samenvatting van het eerdere deel van dit gesprek\]\n## Besluiten/, 'the summary stays first');
    assert.ok(t.requests.at(-1)!.system.includes('Vraag eerst toestemming voordat je iets naar een klant stuurt.'), 'the pinned rule: a standing rule in the system prompt (package F)');
    assert.ok(first.includes('Voortaan: noem nooit prijzen zonder btw tegen klanten.'));
  } finally {
    await t.close();
  }
});

test('the current question is never dropped, also when this turn alone is larger than the history budget', async () => {
  const t = await withFixtures();
  try {
    const a = await t.agent({ settings: { historyTokens: 600, compaction: false }, tool_groups: ['files', 'web'] });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ text: 'Eerste antwoord.' });
    await t.say(th.id, 'Eerste vraag over iets anders.');
    t.script.push({ toolCalls: [{ name: 'web_fetch', args: { url: 'https://www.fietsentest.nl/lang' } }] }, { text: 'Klaar.' });
    await t.say(th.id, 'Wat staat er op de testpagina over accu’s?');
    const req = t.requests.at(-1)!;
    assert.ok(req.messages.some((m) => m.role === 'user' && textOf(m).includes('Wat staat er op de testpagina over accu’s?')), 'the question is in the request');
    assert.equal(req.messages.findIndex((m) => m.role === 'tool') > req.messages.findIndex((m) => m.role === 'user'), true);
  } finally {
    await t.close();
  }
});

test('tools_load: a left-out part is named, loads in one step and stays for the rest of the conversation', async () => {
  const t = await withFixtures();
  try {
    const groups = [...t.app.ctx.tools.groups.keys()];
    const a = await t.agent({ tool_groups: groups, access_mode: 'auto' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ toolCalls: [{ name: LOADER_NAME, args: { names: ['routines'] } }] }, { toolCalls: [{ name: 'routine_list', args: {} }] }, { text: 'Je hebt nog geen routines.' });
    await t.say(th.id, 'Wat staat er klaar?');
    const [r1, r2, r3] = t.requests.slice(-3);
    const loader = r1.tools.find((x) => x.name === LOADER_NAME)!;
    assert.ok(loader, 'tools_load is offered');
    assert.match(loader.description, /- routines: Routines/, 'the left-out parts are named');
    assert.ok(!r1.tools.some((x) => x.name === 'routine_create'), 'routines are left out at first');
    assert.ok(r2.tools.some((x) => x.name === 'routine_create') && r2.tools.some((x) => x.name === 'routine_list'), 'loaded from the next step on');
    assert.ok(r3.tools.some((x) => x.name === 'routine_list'));
    const result = t.app.ctx.store.messages(th.id).find((m) => m.role === 'tool' && m.parts.toolResult?.name === LOADER_NAME)!;
    assert.match(result.content, /^Geladen: Routines \(/);
    // It stays: the next turn still has it (the call is in the conversation).
    t.script.push({ text: 'ok' });
    await t.say(th.id, 'Dank je.');
    assert.ok(t.requests.at(-1)!.tools.some((x) => x.name === 'routine_create'));
    // Never more than the bot has: a part it does not have cannot be loaded.
    const none = await t.agent({ name: 'Klein', tool_groups: ['files', 'web', 'memory', 'team', 'skills', 'routines'] });
    const loaderDef = (await import('../server/tools/selection.js')).loaderTool(await t.app.ctx.tools.forAgent(t.app.ctx.store.agent(none.id)!, t.app.ctx.store.thread(th.id)!), t.app.ctx.tools.groups);
    const out: any = await loaderDef.run({ names: ['browser'] }, {} as any);
    assert.equal(out.isError, true);
  } finally {
    await t.close();
  }
});

test('a delegated task gets a small, clean context: the task and its expected output, not the conversation', async () => {
  const t = await withFixtures();
  try {
    const lead = await t.agent({ name: 'Leider', tool_groups: ['files', 'web', 'memory', 'team'] });
    const helper = await t.agent({ name: 'Helper', tool_groups: ['files', 'web', 'memory', 'team'] });
    const th = await t.api('POST', '/threads', { agentId: lead.id });
    t.script.push({ text: 'Goed, ik help je met de blog.' });
    await t.say(th.id, 'Hoi, we werken vandaag aan de blog.');
    for (let i = 0; i < 6; i++) {
      t.script.push({ toolCalls: [{ name: 'web_fetch', args: { url: `https://www.ebikeweb.nl/bron-${i}` } }] }, { text: `Samenvatting ${i}: Project Zeemeeuw loopt.` });
      await t.say(th.id, `Onderzoek bron ${i} voor Project Zeemeeuw.`);
    }
    const task = 'Schrijf drie korte koppen voor een blog over e-bikes voor woon-werkverkeer.';
    t.script.push({ toolCalls: [{ name: 'delegate_task', args: { bot: 'Helper', task, expected_output: 'Drie koppen van hoogstens 8 woorden' } }] }, { text: 'Uitgezet bij Helper.' });
    const before = t.requests.length;
    t.script.push({ text: '1. Fluitend naar je werk\n2. De e-bike wint\n3. Nooit meer file' });
    await t.say(th.id, 'Laat Helper koppen bedenken.');
    for (let i = 0; i < 100 && !t.requests.slice(before).some((r) => json(r.messages).includes(task) && r.messages.length <= 2); i++) await new Promise((res) => setTimeout(res, 50));
    const sub = t.requests.slice(before).find((r) => r.messages.some((m) => m.role === 'user' && textOf(m).includes(task)) && !json(r.messages).includes('Laat Helper koppen bedenken'))!;
    assert.ok(sub, "the helper's request");
    const subJson = json(sub.messages);
    assert.ok(subJson.includes('Drie koppen van hoogstens 8 woorden'), 'its "klaar als" (expected output) goes along');
    assert.ok(!subJson.includes('Project Zeemeeuw'), 'nothing of the leader’s conversation');
    const p = measure(sub.system, sub.tools, sub.messages);
    assert.ok(p.history + p.toolOutputs + p.attachments < 1500, `small: ${p.history + p.toolOutputs} tokens of conversation`);

    // A question in the helper's own long chat (ask_bot): the history is limited to the delegation budget.
    const own = t.app.ctx.chat.threadForAgent(helper.user_id, helper.id);
    for (let i = 0; i < 20; i++) {
      t.script.push({ text: `Antwoord ${i}: ` + 'lange uitleg over fietsen '.repeat(120) });
      await t.say(own.id, `Vraag ${i}: ` + 'context over de webshop '.repeat(120));
    }
    const full = measure('', [], buildHistory(t.app.ctx, t.app.ctx.store.agent(helper.id)!, t.app.ctx.store.thread(own.id)!).messages);
    assert.ok(full.history > 25_000, `the helper’s own chat is long (${full.history})`);
    const n = t.requests.length;
    t.script.push({ toolCalls: [{ name: 'ask_bot', args: { bot: 'Helper', message: 'Hoeveel koppen heb je al bedacht?' } }] }, { text: 'Gevraagd.' }, { text: 'Drie.' }, { text: 'Helper zegt: drie.' });
    await t.say(th.id, 'Vraag het Helper even.');
    for (let i = 0; i < 100 && !t.requests.slice(n).some((r) => json(r.messages).includes('Hoeveel koppen heb je al bedacht?') && r.messages.at(-1)?.role === 'user'); i++) await new Promise((res) => setTimeout(res, 50));
    await t.waitIdle(own.id, 10_000);
    const ask = t.requests.slice(n).find((r) => r.messages.at(-1)?.role === 'user' && textOf(r.messages.at(-1)!).includes('Hoeveel koppen heb je al bedacht?'))!;
    assert.ok(ask, "the helper's request in its own chat");
    const q = measure('', [], ask.messages);
    assert.ok(q.history < SAVER_DEFAULTS.delegationTokens + 2000, `bounded: ${q.history} tokens (own chat ${full.history})`);
    const st = t.app.ctx.store.messages(own.id).filter((m) => m.role === 'assistant').at(-1)!.parts.contextStats;
    assert.equal(st.delegation, SAVER_DEFAULTS.delegationTokens, 'the stats say the history was limited for a bot message');
  } finally {
    await t.close();
  }
});

test("Claude's thinking blocks are only replayed while everything before them is unchanged (preserved thinking)", async () => {
  const t = await withFixtures();
  try {
    let n = 0;
    t.app.ctx.providers.registerKind({
      id: 'mockthink',
      label: 'Mock met denkstappen',
      type: 'api',
      needsKey: false,
      description: 'test',
      models: ['mock-1'],
      defaultModel: 'mock-1',
      create: () => {
        const base = mockAdapter(t.script, t.requests);
        return {
          ...base,
          async chat(req, signal, onEvent) {
            const r = await base.chat!(req, signal, onEvent);
            const sig = `sig-${n++}`;
            return { ...r, raw: { provider: 'anthropic', data: [{ type: 'thinking', thinking: `denken ${sig}`, signature: sig }, ...(r.text ? [{ type: 'text', text: r.text }] : []), ...r.toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args }))] } };
          },
        };
      },
    });
    const prov = await t.api('POST', '/providers', { kind: 'mockthink' });
    const fx = FIXTURES.find((f) => f.id === 'code')!;
    const from = t.requests.length;
    const { requests, threadId } = await runFixture(t, { ...fx, agent: { ...fx.agent, provider_id: prov.id, model: 'mock-1' } }, { saver: true });
    assert.equal(requests.length, t.requests.length - from);
    // The API's check: a thinking block written in request p is valid in request j only when system, tools and every
    // message before it are exactly what request p sent.
    let replayed = 0;
    requests.forEach((req, j) => {
      req.messages.forEach((m, k) => {
        const block = m.role === 'assistant' && m.raw?.provider === 'anthropic' ? m.raw.data.find((b: any) => b.type === 'thinking') : null;
        if (!block) return;
        const p = Number(String(block.signature).slice(4)) - 0;
        const prod = requests[p];
        assert.ok(prod, 'produced by an earlier request');
        assert.equal(req.system, prod.system);
        assert.equal(json(req.tools), json(prod.tools), `call ${j}: a thinking block from call ${p} with a changed tool list`);
        assert.equal(json(req.messages.slice(0, k)), json(prod.messages), `call ${j}: thinking from call ${p} after a changed history`);
        replayed++;
      });
    });
    assert.ok(replayed > 10, `thinking blocks are kept where valid (${replayed})`);
    const stripped = t.app.ctx.store.messages(threadId).filter((m) => m.role === 'assistant').reduce((s, m) => s + (m.parts.contextStats?.shortened.thinking || 0), 0);
    assert.ok(stripped > 0, 'and left out where the history before them changed');
  } finally {
    await t.close();
  }
});

test('Anthropic prompt caching: a fixed breakpoint after tools and system, automatic or explicit for the conversation', () => {
  const msgs: any[] = [
    { role: 'user', content: [{ type: 'text', text: 'hoi' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 's' }, { type: 'text', text: 'hallo' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'uit' }, { type: 'text', text: 'verder' }] },
  ];
  const own = cacheParams('Je bent een bot.', msgs, false);
  assert.deepEqual(own.system, [{ type: 'text', text: 'Je bent een bot.', cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(own.cache_control, { type: 'ephemeral' }, "Anthropic's own API: automatic caching of the conversation");
  assert.equal(own.messages, msgs, 'messages untouched');
  const compat = cacheParams('Je bent een bot.', msgs, true);
  assert.equal(compat.cache_control, undefined, 'a compatible endpoint gets no top-level field it may not know');
  assert.deepEqual(compat.messages.at(-1).content.at(-1), { type: 'text', text: 'verder', cache_control: { type: 'ephemeral' } });
  assert.equal(msgs[2].content[1].cache_control, undefined, 'the caller’s messages are not changed');
  assert.equal(compat.messages[1], msgs[1], 'only the last message is copied');
  assert.equal(cacheParams('', msgs, false).system, undefined);
});

test('settings: on by default, off per bot or per user, numbers clamped', async () => {
  const t = await startTestApp();
  try {
    const a = t.app.ctx.store.agent((await t.agent()).id)!;
    assert.equal(saverSettings(t.app.ctx, a).on, true);
    assert.equal(saverSettings(t.app.ctx, { ...a, settings: { contextSaver: false } }).on, false);
    assert.equal(saverSettings(t.app.ctx, { ...a, settings: { contextSaver: { on: false } } }).on, false);
    const s = saverSettings(t.app.ctx, { ...a, settings: { contextSaver: { keepTurns: 999, toolTokens: 'x', duplicates: false } } });
    assert.equal(s.keepTurns, 50);
    assert.equal(s.toolTokens, SAVER_DEFAULTS.toolTokens);
    assert.equal(s.duplicates, false);
    t.app.ctx.store.setSetting(a.user_id, 'contextSaver', { on: false });
    assert.equal(saverSettings(t.app.ctx, a).on, false, 'off for all bots of this owner');
    assert.equal(saverSettings(t.app.ctx, { ...a, settings: { contextSaver: true } }).on, true, 'a bot can still switch it on');
  } finally {
    await t.close();
  }
});

test('measure: the parts add up and land in the right place', () => {
  const msgs: ChatMsg[] = [
    { role: 'user', content: `Vraag\n\n<context>\n${'g'.repeat(350)}\n</context>\n\n<bijlage naam="a.txt" pad="uploads/a.txt">\n${'b'.repeat(700)}\n</bijlage>` },
    { role: 'assistant', content: 'antwoord', toolCalls: [{ id: '1', name: 'read_file', args: { path: 'x' } }] },
    { role: 'tool', toolCallId: '1', toolName: 'read_file', content: [{ type: 'text', text: 'u'.repeat(3500) }, { type: 'image', mime: 'image/png', data: 'x' }] },
  ];
  const p = measure('s'.repeat(35), [{ name: 'x', description: 'y', parameters: {} }], msgs);
  assert.equal(p.system, 10);
  assert.ok(p.memory >= 100 && p.memory <= 110);
  assert.ok(p.attachments >= 210 && p.attachments <= 220);
  assert.equal(p.toolOutputs, 1000 + 1600);
  assert.ok(p.history > 10 && p.history < 60);
});

test('tool selection: all under the budget; named, used and asked-for parts stay; deterministic', () => {
  const tool = (name: string, group: string, app?: string): ToolDef => ({ name, group, app, risk: 'read', description: `${name} `.repeat(60), parameters: { type: 'object', properties: { q: { type: 'string', description: 'x'.repeat(200) } } }, run: async () => '' });
  const tools = [tool('read_file', 'files'), tool('web_fetch', 'web'), tool('routine_create', 'routines'), tool('task_create', 'team'), tool('browser_open', 'browser'), tool('mcp_notion_search', 'mcp', 'Notion'), tool('mcp_shop_orders', 'mcp', 'Shop')];
  const groups = new Map([['routines', { id: 'routines', label: 'Routines', description: 'Op vaste tijden' }]]);
  const base = { tools, groups, system: 'Je bent een bot.', about: '', messages: [] as ChatMsg[], budget: 100_000 };
  assert.equal(selectTools(base).key, '', 'under the budget: everything, no tools_load');
  const tight = { ...base, budget: 1 };
  const s0 = selectTools(tight);
  assert.deepEqual(s0.specs.map((x) => x.name), ['read_file', 'web_fetch', LOADER_NAME], 'only the basics');
  assert.equal(json(selectTools(tight)), json(s0), 'deterministic');
  assert.ok(selectTools({ ...tight, system: 'Gebruik browser_open voor websites.' }).specs.some((x) => x.name === 'browser_open'), 'named in the system prompt');
  assert.ok(selectTools({ ...tight, messages: [{ role: 'user', content: 'Zoek het op in Notion' }] }).specs.some((x) => x.name === 'mcp_notion_search'), 'an app named in the question');
  assert.ok(!selectTools({ ...tight, messages: [{ role: 'user', content: 'hoi\n\n<context>\nNotion staat in je geheugen\n</context>' }] }).specs.some((x) => x.name === 'mcp_notion_search'), 'memory notes are no request');
  assert.ok(selectTools({ ...tight, messages: [{ role: 'user', content: 'Herinner me er elke ochtend aan' }] }).specs.some((x) => x.name === 'routine_create'), 'a hint in the question');
  assert.ok(selectTools({ ...tight, messages: [{ role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'mcp_shop_orders', args: {} }] }] }).specs.some((x) => x.name === 'mcp_shop_orders'), 'used earlier');
  assert.ok(selectTools({ ...tight, messages: [{ role: 'user', content: 'Vraag het aan Sanne' }], botNames: ['Sanne'] }).specs.some((x) => x.name === 'task_create'), 'another bot named');
  assert.ok(selectTools({ ...tight, room: true }).specs.some((x) => x.name === 'task_create'), 'team tools in a group chat');
  const order = selectTools({ ...tight, messages: [{ role: 'user', content: 'Zoek het op in Notion' }] }).specs.map((x) => x.name);
  assert.deepEqual(order, ['read_file', 'web_fetch', 'mcp_notion_search', LOADER_NAME], 'the bot’s own order, tools_load last');
});

test('shortening: long runs in blocks of steps, duplicates only while the first copy is complete, decisions only grow', async () => {
  const { shortenItems } = await import('../server/agent/context-budget.js');
  const big = (i: number) => `uitvoer ${i} ` + 'x'.repeat(7000);
  const run = (n: number, turn = 1) => {
    const items: any[] = [{ msg: { role: 'user', content: 'vraag' }, seq: 1, turn, kind: 'user' }];
    for (let i = 1; i <= n; i++) items.push({ msg: { role: 'tool', toolName: 'read_file', toolCallId: `c${i}`, content: big(i) }, seq: 1 + i, turn, kind: 'tool', toolOrdinal: i, callKey: `read_file:{"path":"f${i}"}` });
    return items;
  };
  const marked = (items: any[]) => items.filter((it) => /stappen geleden/.test(String(it.msg.content))).map((it) => it.toolOrdinal);
  const s = SAVER_DEFAULTS;
  const r14 = run(14);
  shortenItems(r14, s, { questionTurn: 1 });
  assert.deepEqual(marked(r14), [], 'the newest 10 steps (and a partial block) stay complete');
  const r17 = run(17);
  shortenItems(r17, s, { questionTurn: 1 });
  assert.deepEqual(marked(r17), [1, 2, 3, 4, 5], 'a whole block of 5 old steps at once');
  const r19 = run(19);
  shortenItems(r19, s, { questionTurn: 1 });
  assert.deepEqual(marked(r19), [1, 2, 3, 4, 5], 'the same block until the next one is due: the history only grows');
  // The same call with the same output twice: the second is a reference while the first is complete.
  const dup = (questionTurn: number) => {
    const items: any[] = [
      { msg: { role: 'user', content: 'v1' }, seq: 1, turn: 1, kind: 'user' },
      { msg: { role: 'tool', toolName: 'read_file', toolCallId: 'a', content: 'inhoud '.repeat(400) }, seq: 2, turn: 1, kind: 'tool', toolOrdinal: 1, callKey: 'read_file:{"path":"a"}' },
      { msg: { role: 'user', content: 'v2' }, seq: 3, turn: 2, kind: 'user' },
      { msg: { role: 'tool', toolName: 'read_file', toolCallId: 'b', content: 'inhoud '.repeat(400) }, seq: 4, turn: 2, kind: 'tool', toolOrdinal: 2, callKey: 'read_file:{"path":"a"}' },
      { msg: { role: 'user', content: 'v' }, seq: 5, turn: questionTurn, kind: 'user' },
    ];
    const r = shortenItems(items, s, { questionTurn });
    return { first: String(items[1].msg.content), second: String(items[3].msg.content), r };
  };
  const early = dup(3);
  assert.match(early.second, /^\[Zelfde uitvoer als de eerdere aanroep van read_file/);
  assert.equal(early.r.duplicates, 1);
  const later = dup(5);
  assert.match(later.first, /oudere uitvoer van read_file/, 'the first copy is old now');
  assert.doesNotMatch(later.second, /Zelfde uitvoer/, 'never a reference to a copy that was shortened');
});

test('carry block: pinned lines and owner rules of the dropped part, not what is still there', () => {
  const ctx = '<geheugen info="x">\nVastgezet:\n- [m:a1] (instructie) Vraag eerst voordat je iets verstuurt.\n- [m:b2] (voorkeur) Korte antwoorden.\nRelevant:\n- [m:c3] iets anders\n</geheugen>';
  assert.deepEqual(pinnedLines(ctx), ['- [m:a1] (instructie) Vraag eerst voordat je iets verstuurt.', '- [m:b2] (voorkeur) Korte antwoorden.']);
  assert.deepEqual(ownerRules('Hoi. Voortaan wil ik altijd een samenvatting. Wat denk je?\n> nooit dit citaat'), ['Voortaan wil ik altijd een samenvatting.']);
  const c = carryBlock([{ context: ctx, ownText: 'Stuur nooit iets zonder mijn toestemming.' }], 'nog in beeld: [m:b2]');
  assert.match(c.text, /\[m:a1\]/);
  assert.doesNotMatch(c.text, /\[m:b2\]/, 'still in the kept part');
  assert.match(c.text, /“Stuur nooit iets zonder mijn toestemming\.”/);
  assert.equal(c.pinned + c.rules, 2);
});

test('thinking binding: a block is left out exactly when something before it changed since it was written', () => {
  const raw = (sig: string) => ({ provider: 'anthropic', data: [{ type: 'thinking', thinking: 't', signature: sig }, { type: 'text', text: 'a' }] });
  const msgs: ChatMsg[] = [
    { role: 'user', content: 'v1' },
    { role: 'assistant', content: 'a', raw: raw('s1') },
    { role: 'user', content: 'v2' },
    { role: 'assistant', content: 'a', raw: raw('s2') },
  ];
  const edits = [{ seq: 5, kind: 'old' as const }];
  // Answer 1 (seq 2) was written before the edit at seq 5 existed but nothing before it changed; answer 2 (seq 8) was
  // written with no edits, and now an edit before it exists.
  const metas = [{ seq: 1, key: '' }, { seq: 2, key: '' }, { seq: 6, key: '' }, { seq: 8, key: '' }];
  const out = msgs.slice();
  assert.equal(stripStaleThinking(out, metas, '', '', edits), 1);
  assert.equal(out[1].raw!.data.length, 2, 'unchanged before it: kept');
  assert.deepEqual(out[3].raw!.data.map((b: any) => b.type), ['text'], 'changed before it: thinking left out, the text stays');
  // Written under the same edits: kept.
  const same = msgs.slice();
  assert.equal(stripStaleThinking(same, [metas[0], metas[1], metas[2], { seq: 8, key: editsKey('', '', edits) }], '', '', edits), 0);
  // A tool list that changed since: every older block goes.
  const tools = msgs.slice();
  assert.equal(stripStaleThinking(tools, metas, 'sel:x', '', []), 2);
});

test('CLI engines: an estimate of what TeamBot hands over, and what the engine added itself', async () => {
  const t = await startTestApp();
  try {
    const a = t.app.ctx.store.agent((await t.agent()).id)!;
    const th = t.app.ctx.chat.threadForAgent(a.user_id, a.id);
    const s = await cliContextStats(t.app.ctx, a, th, { system: 'x'.repeat(3500), prompt: `Nieuwe vraag\n\n<context>\n${'m'.repeat(700)}\n</context>`, attachments: [{ mime: 'image/png' }, { mime: 'text/plain', size: 3500 }] });
    assert.equal(s.engine, 'cli');
    assert.equal(s.parts.system, 1000);
    assert.ok(s.parts.memory >= 200 && s.parts.memory < 215);
    assert.equal(s.parts.attachments, 1600 + 1000);
    assert.ok(s.parts.tools > 1000 && s.tools.of > 10, 'TeamBot tools over MCP (without the engine’s own file and shell tools)');
    const r = cliRecord(t.app.ctx, a, s, { input: s.total + 25_000, output: 10, cacheRead: 20_000 });
    assert.equal(r.engineOwn, 25_000);
    assert.deepEqual(r.reported, { input: s.total + 25_000, cacheRead: 20_000 });
  } finally {
    await t.close();
  }
});
