/**
 * A bot never gets stuck on a setting, and the owner answers in the chat instead of opening a settings screen:
 *  - request_part: Ja switches the part on and the bot goes on in a next turn; Nee does not; already on; unknown name;
 *    a part that needs an account first is not asked;
 *  - propose_rule: Ja stores the bot's rule through the botrules service; a looser rule about money is refused;
 *  - the main bot's bot_settings and bot_rules: only the main bot; settings change without a question, wider access
 *    asks; rules are added, listed and removed, and a rule about money is never removed by a bot;
 *  - a new team starts with the two starting rules, once: a removed rule stays away.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownerTurn, startTestApp, type TestApp } from './helpers.js';
import { PART_TOOL, RULE_TOOL } from '../server/tools/builtin/selfserve.js';
import { STARTER_RULES } from '../server/modules/teams/service.js';
import { callRisk } from '../server/tools/broker.js';
import type { ToolDef, ToolOutput } from '../server/core/types.js';
import { fillWords } from '../shared/i18n-core.js';

async function setup() {
  const t: TestApp = await startTestApp();
  const ctx = t.app.ctx;
  const userId = ctx.auth.owner()!.id;
  /** Run a tool as a bot, the way the runner calls it (without the gate: `approved` is not set). */
  const run = async (agentId: string, tool: ToolDef, args: any = {}): Promise<ToolOutput> => {
    const agent = ctx.store.agent(agentId)!;
    const out = await tool.run(args, { ctx, agent, thread: ctx.chat.threadForAgent(userId, agentId), userId, run: ownerTurn(ctx, userId, agentId), signal: new AbortController().signal, toolCallId: 'c1', progress() {} });
    return typeof out === 'string' ? { text: out } : out;
  };
  /** The open card, as the owner sees it in the chat. */
  const card = async (): Promise<any> => {
    for (let i = 0; i < 200; i++) {
      const c = (await t.api('GET', '/approvals')).find((x: any) => x.status === 'pending');
      if (c) return c;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('no card');
  };
  const answer = async (text: string) => {
    const c = await card();
    await t.api('POST', `/approvals/${c.id}`, { decision: 'approve', answer: text });
    return c;
  };
  const noCard = async () => assert.equal((await t.api('GET', '/approvals')).filter((x: any) => x.status === 'pending').length, 0);
  return { t, ctx, userId, run, card, answer, noCard, part: ctx.tools.get(PART_TOOL)!, rule: ctx.tools.get(RULE_TOOL)! };
}

test('request_part: Ja switches the part on and the bot goes on in a next turn with the new tools', async () => {
  const e = await setup();
  try {
    const a = await e.t.agent({ name: 'Rik', tool_groups: ['files'] });
    const th = e.ctx.chat.threadForAgent(e.userId, a.id);
    const tools = async () => (await e.ctx.tools.forAgent(e.ctx.store.agent(a.id)!, th)).map((x) => x.name);
    assert.ok((await tools()).includes(PART_TOOL), 'every bot has it');
    assert.ok(!(await tools()).includes('run_command'));
    e.t.script.push({ toolCalls: [{ name: PART_TOOL, args: { part: 'shell', why: 'Ik moet een script draaien' } }] }, { text: 'Ik ga zo verder.' }, { text: 'Klaar: het script heeft gedraaid.' });
    await e.t.api('POST', `/threads/${th.id}/messages`, { content: 'Draai het script' });
    const c = await e.answer('Ja');
    assert.deepEqual([c.kind, c.options, c.summary], ['question', ['Ja', 'Nee'], 'Rik heeft Terminal nodig: Ik moet een script draaien. Aanzetten?']);
    await e.t.waitIdle(th.id);
    assert.ok(e.ctx.store.agent(a.id)!.tool_groups.includes('shell'));
    assert.ok((await tools()).includes('run_command'));
    // Written the way the bot editor saves a bot (the one way a tool writes a bot): logged, and the bot as it was is
    // kept as a version the owner can put back.
    assert.equal(e.ctx.store.all<any>("SELECT * FROM audit WHERE kind = 'agent.updated' AND agent_id = ? AND data LIKE '%tool_groups%'", a.id).length, 1, 'logged');
    const versions = await e.t.api('GET', `/agents/${a.id}/versions`);
    assert.deepEqual([versions.length, versions[0].changed, versions[0].data.tool_groups.includes('shell')], [1, ['tool_groups'], false], 'the bot as it was (without the part) is kept as a version');
    const msgs = e.ctx.store.messages(th.id);
    assert.match(msgs.find((m) => m.role === 'tool')!.content, /Terminal staat nu aan voor jou/);
    // TeamBot started the next turn itself: the bot went on.
    assert.ok(msgs.some((m) => m.role === 'system' && /Terminal staat nu aan voor Rik\. Ga verder waar je gebleven was\./.test(m.content)));
    assert.equal(msgs.at(-1)!.content, 'Klaar: het script heeft gedraaid.');
    // The one line in the system prompt.
    assert.match(JSON.stringify(e.t.requests.at(-1)), /Staat een onderdeel dat je nodig hebt uit, vraag het dan aan \(request_part\)/);
  } finally {
    await e.t.close();
  }
});

test('request_part: Nee leaves it off; already on, an unknown name and a part without an account do not ask', async () => {
  const e = await setup();
  try {
    const a = await e.t.agent({ name: 'Rik', tool_groups: ['files'] });
    const p = e.run(a.id, e.part, { part: 'Browser', why: 'Ik wil de site bekijken' });
    assert.match((await e.answer('Nee')).summary, /^Rik heeft Browser nodig: Ik wil de site bekijken\. Aanzetten\?$/);
    assert.match((await p).text, /De eigenaar zet Browser niet aan\. Ga verder zonder dit onderdeel/);
    assert.ok(!e.ctx.store.agent(a.id)!.tool_groups.includes('browser'));

    assert.match((await e.run(a.id, e.part, { part: 'files', why: 'x' })).text, /Bestanden staat al aan voor jou/);
    const bad = await e.run(a.id, e.part, { part: 'toverstaf', why: 'x' });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /Er is geen onderdeel “toverstaf”\. Onderdelen: .*shell \(Terminal\)/);
    // Needs the owner's account first: said to the bot, not asked.
    assert.match((await e.run(a.id, e.part, { part: 'channels', why: 'Ik wil de klant mailen' })).text, /nog geen chat-app of e-mailadres gekoppeld/);
    await e.noCard();
    assert.ok(!e.ctx.store.agent(a.id)!.tool_groups.includes('channels'));
    assert.ok(fillWords(e.part.summarize!({ part: 'shell', why: 'x' })).length > 5);
  } finally {
    await e.t.close();
  }
});

test('propose_rule: Ja stores the rule for that bot; never a looser rule about money', async () => {
  const e = await setup();
  try {
    const a = await e.t.agent({ name: 'Rik', access_mode: 'ask' });
    const text = 'Mag altijd bestanden maken in de map Offertes';
    const p = e.run(a.id, e.rule, { rule: text, why: 'Ik vraag dit elke dag' });
    const c = await e.answer('Ja');
    assert.equal(c.summary, `Rik stelt een regel voor: “${text}” (mag zonder vragen). Ik vraag dit elke dag. Instellen?`);
    assert.match((await p).text, /De regel staat er nu/);
    const rules = (await e.t.api('GET', `/bot-rules?agentId=${a.id}`)).rules;
    assert.deepEqual(rules.map((r: any) => [r.text, r.effect, r.match.folder]), [[text, 'allow', 'Offertes']]);
    assert.match((await e.run(a.id, e.rule, { rule: text })).text, /staat er al/);

    const no = e.run(a.id, e.rule, { rule: 'Vraag altijd eerst voordat je iets in Shopify verandert' });
    await e.answer('Nee');
    assert.match((await no).text, /De eigenaar wil deze regel niet/);
    assert.equal((await e.t.api('GET', `/bot-rules?agentId=${a.id}`)).rules.length, 1);

    const money = await e.run(a.id, e.rule, { rule: 'Mag altijd het budget aanpassen in Shopify' });
    assert.equal(money.isError, true);
    assert.match(money.text, /een regel over geld .* Dat doet de eigenaar zelf/);
    const vague = await e.run(a.id, e.rule, { rule: 'Mag altijd standaardantwoorden versturen naar klanten' });
    assert.equal(vague.isError, true, 'what the rules cannot free is said in plain words');
    await e.noCard();
  } finally {
    await e.t.close();
  }
});

test('the main bot sets a bot for the owner: settings without a question, wider access asks', async () => {
  const e = await setup();
  try {
    const main = await e.t.agent({ name: 'Baas' });
    await e.t.api('PUT', `/teams/main/${main.id}`);
    const rik = await e.t.agent({ name: 'Rik', tool_groups: ['files'] });
    const tool = (e.ctx.services.teams.mainTools as ToolDef[]).find((x) => x.name === 'bot_settings')!;
    const baas = e.ctx.store.agent(main.id)!;
    const th = e.ctx.chat.threadForAgent(e.userId, main.id);

    const refused = await e.run(rik.id, tool, { bot: 'Rik', access: 'auto' });
    assert.match(refused.text, /alleen de hoofdbot/);
    assert.match((await e.run(main.id, tool, { bot: 'Rik' })).text, /Toegang \(access\): auto — Automatisch[\s\S]*Onderdelen uit: .*shell \(Terminal\)/);

    const args = { bot: 'Rik', access: 'ask', parts_on: ['shell', 'Browser'], parts_off: ['files'], model: 'mock-2' };
    assert.equal(callRisk(tool, args, { agent: baas, thread: th, userId: e.userId }), 'write');
    const out = await e.run(main.id, tool, args);
    assert.ok(!out.isError, out.text);
    let r = e.ctx.store.agent(rik.id)!;
    assert.deepEqual([r.access_mode, r.tool_groups.sort(), r.model], ['ask', ['browser', 'shell'], 'mock-2']);
    await e.noCard();
    assert.match(fillWords(tool.summarize!(args)), /Rik instellen: toegang wordt “Vraagt toestemming”; aan: shell, Browser; uit: files; model: mock-2/);

    // Wider than now: the gate asks at every level, and the tool asks itself when the gate did not.
    const wide = { bot: 'Rik', access: 'full', send_to_others: true };
    const call = { name: tool.name, risk: callRisk(tool, wide, { agent: baas, thread: th, userId: e.userId }), impact: tool.impact };
    assert.equal(call.risk, 'danger');
    assert.equal(e.ctx.broker.decide(baas, call, wide), 'ask');
    assert.equal(e.ctx.broker.decide({ ...baas, access_mode: 'full' }, call, wide), 'ask');
    let p = e.run(main.id, tool, wide);
    assert.equal((await e.answer('Nee')).summary, 'Baas wil Rik meer toegang geven: Volledige toegang (doet zijn werk zonder te vragen) en ook versturen naar anderen zonder te vragen. Goed?');
    assert.equal((await p).isError, true);
    assert.equal(e.ctx.store.agent(rik.id)!.access_mode, 'ask');
    p = e.run(main.id, tool, wide);
    await e.answer('Ja');
    assert.ok(!(await p).isError);
    r = e.ctx.store.agent(rik.id)!;
    assert.deepEqual([r.access_mode, r.settings.fullAccessExternal], ['full', true]);
    assert.equal(e.ctx.store.all<any>("SELECT * FROM audit WHERE kind = 'agent.full_access' AND agent_id = ?", rik.id).length, 1);
    // Narrower again needs no question.
    assert.ok(!(await e.run(main.id, tool, { bot: 'Rik', access: 'auto', send_to_others: false })).isError);
    await e.noCard();
    assert.equal(e.ctx.store.agent(rik.id)!.access_mode, 'auto');
    assert.match((await e.run(main.id, tool, { bot: 'Rik', parts_on: ['toverstaf'] })).text, /Er is geen onderdeel “toverstaf”/);
  } finally {
    await e.t.close();
  }
});

test('the main bot keeps the owner’s rules: add, list, remove asks, and a rule about money is never removed by a bot', async () => {
  const e = await setup();
  try {
    const main = await e.t.agent({ name: 'Baas' });
    await e.t.api('PUT', `/teams/main/${main.id}`);
    const rik = await e.t.agent({ name: 'Rik' });
    const tool = (e.ctx.services.teams.mainTools as ToolDef[]).find((x) => x.name === 'bot_rules')!;
    const baas = e.ctx.store.agent(main.id)!;
    const th = e.ctx.chat.threadForAgent(e.userId, main.id);
    const risk = (a: any) => callRisk(tool, a, { agent: baas, thread: th, userId: e.userId });
    const texts = async () => (await e.t.api('GET', `/bot-rules?agentId=${rik.id}`)).rules.map((r: any) => r.text);

    assert.match((await e.run(rik.id, tool, { action: 'add', bot: 'Rik', text: 'Verwijder nooit bestanden' })).text, /alleen de hoofdbot/);
    const shop = 'Vraag altijd eerst voordat je iets in Shopify verandert';
    const add = { action: 'add', bot: 'Rik', text: shop };
    assert.equal(risk(add), 'write', 'a stricter rule needs no question');
    assert.match((await e.run(main.id, tool, add)).text, /Regel toegevoegd bij Rik: “Vraag altijd eerst voordat je iets in Shopify verandert” \(eerst vragen\)/);
    const money = 'Vraag altijd eerst voordat je geld uitgeeft';
    assert.ok(!(await e.run(main.id, tool, { action: 'add', bot: 'Rik', text: money })).isError, 'a rule about money can be added');
    await e.noCard();
    assert.deepEqual(await texts(), [shop, money]);
    assert.match((await e.run(main.id, tool, { bot: 'Rik' })).text, /Regels van Rik:\n- “Vraag altijd eerst voordat je iets in Shopify verandert” \(eerst vragen; id rule_/);

    // Stricter in place: no question. Removing: the owner is asked.
    const never = 'Verander nooit iets in Shopify';
    const change = { action: 'change', bot: 'Rik', rule: shop, text: never };
    assert.equal(risk(change), 'write');
    assert.ok(!(await e.run(main.id, tool, change)).isError);
    assert.deepEqual(await texts(), [money, never]);
    const remove = { action: 'remove', bot: 'Rik', rule: never };
    assert.equal(risk(remove), 'danger');
    assert.equal(e.ctx.broker.decide({ ...baas, access_mode: 'full' }, { name: tool.name, risk: 'danger', impact: tool.impact }, remove), 'ask');
    assert.equal(fillWords(tool.summarize!(remove, { agent: baas })), 'Regel weghalen bij Rik: “Verander nooit iets in Shopify”');
    let p = e.run(main.id, tool, remove);
    assert.equal((await e.answer('Nee')).summary, 'Baas wil een regel weghalen bij Rik: “Verander nooit iets in Shopify” (nooit). Goed?');
    assert.equal((await p).isError, true);
    assert.deepEqual(await texts(), [money, never]);
    p = e.run(main.id, tool, remove);
    await e.answer('Ja');
    assert.match((await p).text, /Regel weggehaald bij Rik/);
    assert.deepEqual(await texts(), [money]);

    // Money: never removed or weakened by a bot, refused before any card.
    for (const a of [{ action: 'remove', bot: 'Rik', rule: money }, { action: 'change', bot: 'Rik', rule: money, text: 'Vraag altijd eerst voordat je iets in Shopify verandert' }]) {
      assert.match(tool.refuse!(a, { agent: baas, thread: th, userId: e.userId }) || '', /een regel over geld haalt een bot nooit weg/);
      assert.equal((await e.run(main.id, tool, a)).isError, true);
    }
    await e.noCard();
    assert.deepEqual(await texts(), [money]);
    // A team's rules too.
    const team = e.ctx.services.teams.list(e.userId)[0];
    assert.ok(!(await e.run(main.id, tool, { action: 'add', team: team.name, text: 'Verwijder nooit bestanden' })).isError);
    assert.equal((await e.t.api('GET', `/bot-rules?teamId=${team.id}`)).rules.length, 1);
  } finally {
    await e.t.close();
  }
});

test('a new team starts with the two starting rules, once: a removed rule stays away', async () => {
  const e = await setup();
  try {
    const team = await e.t.api('POST', '/teams', { name: 'Winkel' });
    const rules = async (id: string) => (await e.t.api('GET', `/bot-rules?teamId=${id}`)).rules;
    const first = await rules(team.id);
    assert.deepEqual(first.map((r: any) => r.text), STARTER_RULES.map((r) => r.text));
    assert.match(first[0].text, /^Vraag altijd eerst voordat je geld uitgeeft/);
    assert.match(first[1].text, /^Vraag eerst bij een belangrijk bericht aan anderen/);
    // Both go to the reviewer: an ordinary reply is not stopped in code.
    assert.deepEqual(first.map((r: any) => [r.effect, r.match, r.review]), [['ask', { verb: 'any' }, true], ['ask', { verb: 'send', others: true }, true]]);
    // Ordinary rules: the owner removes one, and it never comes back.
    await e.t.api('DELETE', `/bot-rules/loosen/${first[0].id}`);
    await e.t.api('PATCH', `/teams/${team.id}`, { name: 'Winkel 2' });
    const bot = await e.t.agent({ name: 'Rik' });
    e.ctx.services.teams.setHome(e.userId, team.id, bot.id);
    const other = await e.t.api('POST', '/teams', { name: 'Ander' });
    assert.deepEqual((await rules(team.id)).map((r: any) => r.text), [STARTER_RULES[1].text]);
    assert.equal((await rules(other.id)).length, 2, 'every new team gets its own');
    // They hold for the team's bots, like any rule.
    assert.equal(e.ctx.services.botRules.forAgent(e.ctx.store.agent(bot.id)!).length, 1);
  } finally {
    await e.t.close();
  }
});
