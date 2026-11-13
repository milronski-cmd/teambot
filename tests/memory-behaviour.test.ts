/**
 * What the owner wants from memory, as he would try it (scripted engines; no real model):
 * - he tells a bot in the chat what it must do from now on; in a NEW conversation the bot has it in front of it,
 *   without being told again — on a model through an API key, on a local model and on Claude Code;
 * - what bot A learns, bot B of the same team knows in its next conversation; a bot of another team does not;
 * - he corrects a bot; next time the bot has the corrected line, and the old one is out of what it reads.
 * Both ways memory is kept are covered: the bot's own dossier_write in the same turn, and the one background review of
 * the conversation when the bot did not write it down itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockAdapter, startTestApp, type MockStep, type TestApp } from './helpers.js';
import type { ChatRequest } from '../server/core/types.js';
import { setShortCallFake } from '../server/agent/short-call.js';
import { standingIntent } from '../server/modules/memory/text.js';

process.env.TEAMBOT_TEST_NO_AUTO_MAIN = '1';

/** The answer of the background review: these lines when it reads a conversation, else nothing. */
const review = (answer: () => string) => setShortCallFake((system) => (/Je bent het geheugen van TeamBot/.test(system) ? answer() : ''));

/** Three bots of the owner, each on another kind of AI; `systemOf` = what the bot's engine got as instructions last. */
async function threeKinds(t: TestApp) {
  // A local model (Ollama-like, free).
  const script: MockStep[] = [];
  const calls: ChatRequest[] = [];
  t.app.ctx.providers.registerKind({ id: 'mock-local', label: 'Lokaal testmodel', type: 'api', group: 'local', billing: 'local', needsKey: false, description: 'test', models: ['lokaal-1'], defaultModel: 'lokaal-1', create: () => mockAdapter(script, calls) });
  const local = await t.api('POST', '/providers', { kind: 'mock-local' });
  // Claude Code (its own engine; TeamBot hands it the instructions with every turn).
  t.app.ctx.services['cli-agents'] = { status: async () => ({ installed: true, loggedIn: true, path: process.execPath, billing: 'subscription' }) };
  const runs: any[] = [];
  t.app.ctx.providers.registerKind({ id: 'claude-code', label: 'Claude Code', type: 'cli', needsKey: false, description: 'test', models: ['default'], defaultModel: 'default', create: () => ({ kind: 'claude-code', async listModels() { return [{ id: 'default' }]; }, async test() { return { ok: true, detail: 'nep' }; }, async runAgent(req: any) { runs.push(req); return { text: 'Goed.', usage: { input: 1, output: 1 } }; } }) as any });
  const cc = await t.api('POST', '/providers', { kind: 'claude-code' });
  const api = await t.agent({ name: 'Api' });
  const loc = await t.api('POST', '/agents', { name: 'Lokaal', provider_id: local.id, model: 'lokaal-1' });
  const cla = await t.api('POST', '/agents', { name: 'Claudia', provider_id: cc.id, model: 'default' });
  const bots = [
    { kind: 'API-sleutel', bot: api, push: (s: MockStep) => t.script.push(s), system: () => t.requests.at(-1)!.system as string },
    { kind: 'lokaal model', bot: loc, push: (s: MockStep) => script.push(s), system: () => calls.at(-1)!.system as string },
    { kind: 'Claude Code', bot: cla, push: (_s: MockStep) => {}, system: () => String(runs.at(-1)!.system) },
  ];
  return bots;
}

/** One message in a NEW conversation; returns the instructions the bot's engine got for it. */
async function fresh(t: TestApp, b: { bot: any; push: (s: MockStep) => void; system: () => string }, say: string) {
  const th = await t.api('POST', '/threads', { agentId: b.bot.id });
  b.push({ text: 'Goed.' });
  await t.say(th.id, say);
  return { th, system: b.system() };
}

/** The text of a bot's own dossier as its engine reads it ("Werknotities van <naam>"). */
const ownBlock = (system: string, name: string) => /<dossier [^>]*naam="Werknotities van ([^"]+)"[^>]*>([\s\S]*?)<\/dossier>/g.exec(system) && [...system.matchAll(/<dossier [^>]*naam="Werknotities van ([^"]+)"[^>]*>([\s\S]*?)<\/dossier>/g)].find((m) => m[1] === name)?.[2];

test('what counts as an order for this bot from now on (his words kept), and what does not', () => {
  assert.equal(standingIntent('Vanaf nu is dit je vaste taak: je beantwoordt vragen over bestellingen. Antwoord altijd kort.'), 'Vanaf nu is dit je vaste taak: je beantwoordt vragen over bestellingen. Antwoord altijd kort.');
  assert.equal(standingIntent('Top. Voortaan sluit je elke mail af met Groet, Sam.'), 'Voortaan sluit je elke mail af met Groet, Sam.');
  assert.equal(standingIntent('Nee, voortaan stuur je offertes als PDF.'), 'voortaan stuur je offertes als PDF.');
  assert.equal(standingIntent('From now on you answer in English.'), 'From now on you answer in English.');
  assert.equal(standingIntent('Voortaan vergaderen we op dinsdag.'), null, 'news about the work, not about this bot');
  assert.equal(standingIntent('Heet je voortaan Max?'), null, 'a question');
  assert.equal(standingIntent('Voortaan heet je Max.'), null, 'only a new name: its own setting');
  assert.equal(standingIntent('Hoe gaat het met je?'), null);
});

test('told once in the chat what to do from now on: kept the first time, before the bot answers, and in a new conversation the bot has it — on an API model, a local model and Claude Code', async () => {
  const t = await startTestApp();
  try {
    const bots = await threeKinds(t);
    review(() => 'NIETS');
    for (const b of bots) {
      // He says it once, as a person would ("vanaf nu …"). No tool call of the bot and no model needed: kept at once.
      const order = `Vanaf nu is dit je vaste taak: je beantwoordt vragen over bestellingen (${b.kind}). Antwoord altijd in korte zinnen en eindig elk antwoord met een vraag.`;
      const th = await t.api('POST', '/threads', { agentId: b.bot.id });
      b.push({ text: 'Begrepen.' });
      const msgs = await t.say(th.id, order);
      // The bot is told in that same turn that it is kept (so it confirms and does not store it again).
      const own = msgs.find((m: any) => m.role === 'user');
      assert.match(String(own?.parts?.context || b.system()), /Opdrachten van de eigenaar|werknotities/i, `${b.kind}: the bot is told`);
      // A new conversation, about something else: the order is in its own dossier, under the owner's orders.
      const { system } = await fresh(t, b, 'Er is een vraag binnengekomen over bestelling 1042.');
      const block = ownBlock(system, b.bot.name) || '';
      assert.match(block, new RegExp(`## Opdrachten van de eigenaar\\n- Vanaf nu is dit je vaste taak: je beantwoordt vragen over bestellingen \\(${b.kind}\\)\\. Antwoord altijd in korte zinnen`), `${b.kind}: the order is in its own dossier in the new conversation`);
      assert.match(system, /opdrachten van de eigenaar in je werknotities/, `${b.kind}: and it is told to follow them`);
      // Only that bot's: a colleague does not get it.
      const other = bots.find((x) => x !== b)!;
      assert.doesNotMatch((await fresh(t, other, 'Hoi')).system, new RegExp(`vragen over bestellingen \\(${b.kind}\\)`), `${b.kind}: not in a colleague's instructions`);
    }
    // Said without those words: the background review catches it (one call when the conversation has gone quiet).
    for (const b of bots) {
      const rule = `Sluit elke mail af met Groet, Sam (${b.kind})`;
      review(() => `Werknotities: ${rule}`);
      await fresh(t, b, `Mails sluit jij af met Groet, Sam (${b.kind}), dat wil ik zo.`);
      await t.app.ctx.services.memory.drain();
      const block = ownBlock((await fresh(t, b, 'Schrijf een mail aan de leverancier.')).system, b.bot.name) || '';
      assert.match(block, new RegExp(`## Opdrachten van de eigenaar[\\s\\S]*${rule.replace(/[()]/g, '\\$&')}`), `${b.kind}: the review kept it with his other orders`);
    }
    // The bot that writes it down itself, in the same turn (an API model with dossier_write): the same place.
    const api = bots[0];
    review(() => 'NIETS');
    const th = await t.api('POST', '/threads', { agentId: api.bot.id });
    t.script.push({ toolCalls: [{ name: 'dossier_write', args: { dossier: 'Werknotities', section: 'Opdrachten van de eigenaar', content: '- Noem prijzen altijd inclusief btw.' } }] }, { text: 'Doe ik.' });
    await t.say(th.id, 'Noem prijzen altijd inclusief btw.');
    assert.match(ownBlock((await fresh(t, api, 'Wat kost de reparatie?')).system, api.bot.name) || '', /## Opdrachten van de eigenaar[\s\S]*Noem prijzen altijd inclusief btw\./);
    // One place for the owner: Geheugen › Bots › this bot shows its instructions and its working notes together.
    const place = await t.api('GET', `/memory/place?scope=agent&agentId=${api.bot.id}`);
    assert.ok(place.instructions);
    assert.match(place.dossiers[0].body, /## Opdrachten van de eigenaar[\s\S]*Noem prijzen altijd inclusief btw/);
  } finally {
    setShortCallFake(null);
    await t.close();
  }
});

test('what bot A learns, bot B of the same team (on Claude Code) knows in its next conversation; a bot of another team does not, and cannot find it', async () => {
  const t = await startTestApp();
  try {
    const [api, , cla] = await threeKinds(t);
    const B = await t.api('POST', '/teams', { name: 'Team B', starterRules: false });
    const other = await t.agent({ name: 'Bo', settings: { homeTeam: B.id } });
    t.app.ctx.services.teams.setHome(t.app.ctx.auth.owner()!.id, B.id, other.id);
    // A hears it from the owner; the review files it in the team's overview.
    review(() => 'Overzicht: De groothandel levert de frames voortaan op donderdag');
    await fresh(t, api, 'De groothandel levert de frames voortaan op donderdag.');
    await t.app.ctx.services.memory.drain();
    // B, same team, new conversation (Claude Code): in its instructions.
    assert.match((await fresh(t, cla, 'Wanneer komen de frames?')).system, /naam="Overzicht[^"]*"[\s\S]*De groothandel levert de frames voortaan op donderdag/);
    // A bot of another team: not in its instructions, and its own search does not find it.
    const th = await t.api('POST', '/threads', { agentId: other.id });
    t.script.push({ toolCalls: [{ name: 'memory_search', args: { query: 'groothandel frames donderdag' } }] }, { text: 'Weet ik niet.' });
    const n = t.requests.length;
    const msgs = await t.say(th.id, 'Wanneer komen de frames?');
    assert.doesNotMatch(t.requests[n].system, /groothandel/);
    assert.doesNotMatch(String(msgs.find((m: any) => m.role === 'tool')?.content || ''), /donderdag/);
  } finally {
    setShortCallFake(null);
    await t.close();
  }
});

test('the owner corrects a bot: next time it has the corrected line and the old one is out of what it reads (in the archive, with undo) — by the review and by the bot itself', async () => {
  const t = await startTestApp();
  try {
    const [api, loc] = await threeKinds(t);
    const mem = t.app.ctx.services.memory;
    // The local-model bot learned something wrong; the owner corrects it; the review takes the old line's place.
    review(() => 'Werknotities: Offertes gaan per post naar de klant');
    await fresh(t, loc, 'Offertes gaan per post naar de klant.');
    await mem.drain();
    assert.match(ownBlock((await fresh(t, loc, 'Hoi')).system, loc.bot.name) || '', /Offertes gaan per post/);
    review(() => 'Werknotities: Offertes gaan per mail naar de klant (vervangt: Offertes gaan per post naar de klant)');
    await fresh(t, loc, 'Nee, dat klopt niet: offertes gaan per mail naar de klant, niet meer per post.');
    await mem.drain();
    const block = ownBlock((await fresh(t, loc, 'Stuur de offerte voor de bakker.')).system, loc.bot.name) || '';
    assert.match(block, /Offertes gaan per mail naar de klant/);
    assert.doesNotMatch(block, /per post/, 'the old line is out of what it reads');
    const archived = t.app.ctx.store.one<any>("SELECT body FROM memory_records WHERE kind = 'event' AND body LIKE '%per post%'");
    assert.ok(archived, 'the old line is in the archive of its dossier');
    // The bot corrects its own note in the same turn (dossier_write replace): the same result.
    review(() => 'NIETS');
    const th = await t.api('POST', '/threads', { agentId: api.bot.id });
    t.script.push({ toolCalls: [{ name: 'dossier_write', args: { dossier: 'Werknotities', content: '- Facturen gaan op vrijdag de deur uit.' } }] }, { text: 'Genoteerd.' });
    await t.say(th.id, 'Facturen gaan op vrijdag de deur uit.');
    t.script.push({ toolCalls: [{ name: 'dossier_write', args: { dossier: 'Werknotities', mode: 'replace', old_text: '- Facturen gaan op vrijdag de deur uit.', content: '- Facturen gaan op maandag de deur uit.' } }] }, { text: 'Aangepast.' });
    await t.say(th.id, 'Nee, facturen gaan op maandag de deur uit.');
    const own = ownBlock((await fresh(t, api, 'Wanneer gaan de facturen weg?')).system, api.bot.name) || '';
    assert.match(own, /maandag/);
    assert.doesNotMatch(own, /vrijdag/);
  } finally {
    setShortCallFake(null);
    await t.close();
  }
});

test('no built-in brake: background memory calls have no daily limit by default; a limit the owner sets still holds', async () => {
  const t = await startTestApp();
  try {
    const { modelBudgetOk } = await import('../server/modules/memory/pipeline.js');
    const svc = t.app.ctx.services.memory.svc;
    const me = t.app.ctx.auth.owner()!.id;
    assert.equal((await t.api('GET', '/memory/settings')).modelDailyCap, 0, 'off by default');
    svc.bumpMeta(me, { model_day: new Date().toISOString().slice(0, 10), model_calls: 9000 });
    assert.equal(modelBudgetOk(svc, me, false), true, '9000 calls today: still no brake');
    await t.api('PUT', '/memory/settings', { modelDailyCap: 50 });
    assert.equal(modelBudgetOk(svc, me, false), false, 'the owner’s own limit holds');
  } finally {
    await t.close();
  }
});
