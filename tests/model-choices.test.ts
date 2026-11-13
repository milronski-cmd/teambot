// The model switcher on top of a chat: one list of every model of every connected AI (GET /api/model-catalog/choices),
// a pick stored on the bot as AI and model together (PATCH /api/agents/:id) that counts from the next message, also
// from a paired phone; and the parts of the list without a screen (ui/src/shell/modelSwitch.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestApp, type TestApp } from './helpers.js';
import type { ChatRequest, ModelInfo, ProviderAdapter } from '../server/core/types.js';
import { modelChoices, type ModelGroup } from '../server/modules/model-catalog/index.js';
import { AUTO, controlText, filterSections, fitReasoning, isCurrent, levelsOfPick, modelSections, rowCount, rowText } from '../ui/src/shell/modelSwitch.js';

/** A second kind of AI next to the test app's "mock": its own model list, and every request it gets is kept. */
function addKind(t: TestApp, id: string, o: { type?: 'api' | 'cli'; models?: ModelInfo[]; fixed?: string[]; fail?: string; slowMs?: number; billing?: 'free' | 'subscription' | 'paid' | 'local'; defaultModel?: string }, requests: ChatRequest[] = []) {
  t.app.ctx.providers.registerKind({
    id,
    label: id,
    type: o.type || 'api',
    needsKey: false,
    description: 'test',
    billing: o.billing,
    models: o.fixed,
    defaultModel: o.defaultModel,
    create: (): ProviderAdapter => ({
      kind: id,
      async listModels() {
        if (o.slowMs) await new Promise((r) => setTimeout(r, o.slowMs));
        if (o.fail) throw new Error(o.fail);
        return o.models || [];
      },
      async test() {
        return { ok: true, detail: id };
      },
      async chat(req) {
        requests.push(req);
        return { text: `antwoord van ${id}`, toolCalls: [], usage: { input: 1, output: 1 }, stop: 'end', model: req.model };
      },
    }),
  });
  return requests;
}

test('the list: every connected AI with its models, in the order they were connected; off, missing and logged-out AIs are left out', async () => {
  const t = await startTestApp();
  try {
    const ctx = t.app.ctx;
    addKind(t, 'duo', { billing: 'paid', models: [{ id: 'duo-small', reasoningLevels: ['low', 'high'] }, { id: 'duo-big', reasoningLevels: [] }], defaultModel: 'duo-small' });
    addKind(t, 'thuis', { billing: 'local', fail: 'ECONNREFUSED 127.0.0.1:11434 sk-geheim-1234567890abcdef' });
    addKind(t, 'kapot-met-lijst', { billing: 'paid', fail: 'boem', fixed: ['vast-1'] });
    addKind(t, 'cli-weg', { type: 'cli', billing: 'subscription', models: [{ id: 'default' }] });
    addKind(t, 'cli-uit', { type: 'cli', billing: 'subscription', models: [{ id: 'default' }] });
    addKind(t, 'cli-ok', { type: 'cli', billing: 'subscription', models: [{ id: 'default', label: 'Standaard van Cli (nu Groot 2)' }, { id: 'groot', label: 'Groot · altijd de nieuwste (nu Groot 2)', billing: 'subscription' }] });
    // What the CLI module says about a program on this computer (never the real Claude Code or Codex of this pc).
    ctx.services['cli-agents'] = { ...(ctx.services['cli-agents'] || {}), status: async (kind: string) => (kind === 'cli-weg' ? { installed: false } : kind === 'cli-uit' ? { installed: true, loggedIn: false } : { installed: true, loggedIn: true }) };
    const duo = await t.api('POST', '/providers', { kind: 'duo', name: 'Duo' });
    const thuis = await t.api('POST', '/providers', { kind: 'thuis', name: 'Thuis' });
    const vast = await t.api('POST', '/providers', { kind: 'kapot-met-lijst', name: 'Vast' });
    await t.api('POST', '/providers', { kind: 'cli-weg', name: 'Niet geïnstalleerd' });
    await t.api('POST', '/providers', { kind: 'cli-uit', name: 'Uitgelogd' });
    const cli = await t.api('POST', '/providers', { kind: 'cli-ok', name: 'Cli' });
    const uit = await t.api('POST', '/providers', { kind: 'duo', name: 'Staat uit' });
    await t.api('PATCH', `/providers/${uit.id}`, { enabled: false });

    const { groups } = (await t.api('GET', '/model-catalog/choices')) as { groups: ModelGroup[] };
    assert.deepEqual(groups.map((g) => g.provider.name), ['Mock', 'Duo', 'Thuis', 'Vast', 'Cli']);
    const by = (id: string) => groups.find((g) => g.provider.id === id)!;
    assert.deepEqual(by(t.providerId).models.map((m) => m.id), ['mock-1']);
    assert.deepEqual(by(duo.id).provider, { id: duo.id, name: 'Duo', kind: 'duo', kindLabel: 'duo', type: 'api', billing: 'paid', own: true, defaultModel: 'duo-small' });
    assert.deepEqual(by(duo.id).models.map((m) => [m.id, m.reasoningLevels]), [['duo-small', ['low', 'high']], ['duo-big', []]]);
    // A local server that is off: the AI stays in the list, without models, and its error never shows a key.
    assert.deepEqual(by(thuis.id).models, []);
    assert.match(by(thuis.id).error || '', /ECONNREFUSED/);
    assert.doesNotMatch(JSON.stringify(groups), /secret_id|sk-geheim-1234567890abcdef/);
    // A list that fails falls back on the kind's own list, as GET /providers/:id/models does.
    assert.deepEqual(by(vast.id).models.map((m) => m.id), ['vast-1']);
    assert.equal(by(vast.id).error, undefined);
    assert.deepEqual(by(cli.id).models.map((m) => m.id), ['default', 'groot']);
    assert.equal(by(cli.id).provider.type, 'cli');

    // The same list as the existing route per AI gives (prices, levels).
    assert.deepEqual(by(duo.id).models, await t.api('GET', `/providers/${duo.id}/models`));

    // An AI this bot may not use (a key for another team) is left out for that bot only.
    const bot = await t.agent();
    const off = ctx.providers.addBotGuard((a, cfg) => (a.id === bot.id && cfg.id === duo.id ? 'alleen voor een ander team' : null));
    assert.ok(!((await t.api('GET', `/model-catalog/choices?agentId=${bot.id}`)).groups as ModelGroup[]).some((g) => g.provider.id === duo.id));
    off();
    assert.ok(((await t.api('GET', `/model-catalog/choices?agentId=${bot.id}`)).groups as ModelGroup[]).some((g) => g.provider.id === duo.id));

    // A slow AI does not hold up the others: it comes back empty with a reason.
    addKind(t, 'traag', { slowMs: 400, models: [{ id: 'ooit' }] });
    const traag = await t.api('POST', '/providers', { kind: 'traag', name: 'Traag' });
    const quick = await modelChoices(ctx, bot.user_id, { fresh: true, timeoutMs: 40 });
    assert.match(quick.find((g) => g.provider.id === traag.id)?.error || '', /binnen de tijd/);
    assert.equal(quick.find((g) => g.provider.id === duo.id)?.models.length, 2);
    // Not kept: the next look has it.
    assert.deepEqual((await modelChoices(ctx, bot.user_id)).find((g) => g.provider.id === traag.id)?.models.map((m) => m.id), ['ooit']);

    // "soft" (what the chat header asks first): the answer does not wait for a slow AI. It comes back as still being
    // read, and the next call gets it from that same reading (the AI is asked once).
    let asked = 0;
    addKind(t, 'bedachtzaam', { slowMs: 300, models: [{ id: 'straks' }], type: 'cli' });
    const real = ctx.providers.kinds.get('bedachtzaam')!.create;
    ctx.providers.kinds.get('bedachtzaam')!.create = (...a) => {
      const adapter = real(...a);
      return { ...adapter, listModels: () => (asked++, adapter.listModels()) };
    };
    const slow = await t.api('POST', '/providers', { kind: 'bedachtzaam', name: 'Bedachtzaam' });
    const at = Date.now();
    const soft = await modelChoices(ctx, bot.user_id, { softMs: 60 });
    assert.ok(Date.now() - at < 250, 'the soft answer did not wait for the slow AI');
    assert.deepEqual(soft.find((g) => g.provider.id === slow.id), { provider: { id: slow.id, name: 'Bedachtzaam', kind: 'bedachtzaam', kindLabel: 'bedachtzaam', type: 'cli', billing: undefined, own: true, defaultModel: undefined }, models: [], pending: true });
    assert.equal(soft.find((g) => g.provider.id === duo.id)?.pending, undefined);
    assert.equal(soft.find((g) => g.provider.id === duo.id)?.models.length, 2);
    assert.deepEqual((await modelChoices(ctx, bot.user_id)).find((g) => g.provider.id === slow.id)?.models.map((m) => m.id), ['straks']);
    assert.equal(asked, 1);
    // Over the route: the first answer comes at once, the list is there on the next look.
    const viaRoute = (await t.api('GET', '/model-catalog/choices?soft=1')).groups as ModelGroup[];
    assert.deepEqual(viaRoute.find((g) => g.provider.id === slow.id)?.models.map((m) => m.id), ['straks']);
  } finally {
    await t.close();
  }
});

test('a pick is the AI and the model together, counts from the next message, and works from a paired phone', async () => {
  const t = await startTestApp();
  try {
    const other: ChatRequest[] = [];
    addKind(t, 'duo', { billing: 'paid', models: [{ id: 'duo-small' }, { id: 'duo-big' }], defaultModel: 'duo-small' }, other);
    const duo = await t.api('POST', '/providers', { kind: 'duo', name: 'Duo' });
    const bot = await t.agent({ reasoning: 'high' });
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    await t.say(th.id, 'eerste vraag');
    assert.equal(t.requests.at(-1)!.model, 'mock-1');

    // Another AI and its model in one change.
    const a = await t.api('PATCH', `/agents/${bot.id}`, { provider_id: duo.id, model: 'duo-big' });
    assert.deepEqual([a.provider_id, a.model, a.reasoning], [duo.id, 'duo-big', 'high']);
    await t.say(th.id, 'tweede vraag');
    assert.equal(other.at(-1)!.model, 'duo-big');
    assert.equal(t.requests.length, 1, 'the first AI is not asked again');
    // The new AI gets the conversation so far (an API engine reads the stored messages).
    const seen = other.at(-1)!.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
    assert.match(seen, /eerste vraag/);
    assert.match(seen, /echo: eerste vraag/);
    assert.match(seen, /tweede vraag/);

    // "Automatisch": no model stored, the AI's own default runs.
    await t.api('PATCH', `/agents/${bot.id}`, { provider_id: duo.id, model: '' });
    await t.say(th.id, 'derde vraag');
    assert.equal(other.at(-1)!.model, 'duo-small');

    // An AI that is not connected for this user is refused.
    await assert.rejects(t.api('PATCH', `/agents/${bot.id}`, { provider_id: 'prv_bestaat_niet', model: 'x' }), /Onbekende provider/);

    // The owner's paired phone: the same list and the same change.
    const ticket = await t.api('POST', '/mobile/pair', { baseUrl: 'http://192.168.1.5:4748' });
    const secret = new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('t');
    const claim = await fetch(`${t.app.url}/api/public/mobile/claim`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' }, body: JSON.stringify({ secret, name: 'Test-iPhone' }) });
    const phone = ((await claim.json()) as any).token as string;
    const asPhone = async (method: string, p: string, body?: any) => {
      const r = await fetch(`${t.app.url}/api${p}`, { method, headers: { authorization: `Bearer ${phone}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
    };
    assert.equal((await asPhone('GET', '/me')).body.session?.kind, 'device');
    const list = await asPhone('GET', `/model-catalog/choices?agentId=${bot.id}`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.groups.map((g: ModelGroup) => g.provider.name), ['Mock', 'Duo']);
    const put = await asPhone('PATCH', `/agents/${bot.id}`, { provider_id: t.providerId, model: 'mock-1' });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    await t.say(th.id, 'vierde vraag');
    assert.equal(t.requests.at(-1)!.model, 'mock-1');
  } finally {
    await t.close();
  }
});

test('back on a CLI engine the bot used before in this chat: its session there is kept and is told what the other AI answered', async () => {
  const t = await startTestApp();
  // The repo's fake Claude Code: it writes its arguments and its prompt to this log (never the real CLI of this pc).
  const file = path.join(t.dir, 'fake-cli.log');
  process.env.FAKE_CLI_LOG = file;
  const runs = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((l: any) => l.argv);
  const resumed = (l: any): string | undefined => (l.argv.includes('--resume') ? l.argv[l.argv.indexOf('--resume') + 1] : undefined);
  try {
    const cc = await t.api('POST', '/providers', { kind: 'claude-code', config: { path: path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-agents-fake-claude.mjs') } });
    const bot = await t.api('POST', '/agents', { name: 'Wissel', provider_id: cc.id, model: '', access_mode: 'ask' });
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    const session = async () => (await t.api('GET', `/cli-agents/threads/${th.id}/sessions`)).map((s: any) => s.sessionId).join(',');
    await t.say(th.id, 'Mijn lievelingskleur is paars.', 30_000);
    const first = await session();
    assert.ok(first && !resumed(runs().at(-1)));

    // To another AI and back with nothing said in between: the session is still current and is resumed.
    await t.api('PATCH', `/agents/${bot.id}`, { provider_id: t.providerId, model: 'mock-1' });
    await t.api('PATCH', `/agents/${bot.id}`, { provider_id: cc.id, model: '' });
    assert.equal(await session(), first);
    await t.say(th.id, 'En mijn lievelingsdier is een otter.', 30_000);
    assert.equal(resumed(runs().at(-1)), first);
    assert.doesNotMatch(runs().at(-1).prompt, /eerder_gesprek|<gemist>/);

    // A turn on the other AI (it reads the stored conversation), then back.
    await t.api('PATCH', `/agents/${bot.id}`, { provider_id: t.providerId, model: 'mock-1' });
    t.script.push({ text: 'Genoteerd: 4471.' });
    await t.say(th.id, 'Onthoud: de code is 4471.');
    assert.match(t.requests.at(-1)!.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n'), /lievelingskleur is paars[\s\S]*otter/);
    await t.api('PATCH', `/agents/${bot.id}`, { provider_id: cc.id, model: '' });
    // The session is kept (what the CLI itself remembers of the chat is not lost) and gets the turn it missed.
    assert.equal(await session(), first, 'the session is kept');
    await t.say(th.id, 'Wat was de code?', 30_000);
    const back = runs().at(-1);
    assert.equal(resumed(back), first, 'the same session, resumed');
    assert.match(back.prompt, /<gemist>[\s\S]*\]: Onthoud: de code is 4471\.\n\[jij, via een andere AI\]: Genoteerd: 4471\.\n<\/gemist>[\s\S]*Wat was de code\?/);
    assert.doesNotMatch(back.prompt, /eerder_gesprek|lievelingskleur/, 'not the turns the session already had');
    assert.equal(await session(), first);
  } finally {
    delete process.env.FAKE_CLI_LOG;
    await t.close();
  }
});

test("someone else's shared AI: only the models its owner allows, the first one as its default", async () => {
  const t = await startTestApp({ mode: 'server' });
  try {
    const m = t.app.ctx.auth.createUser({ name: 'Vriend', email: 'vriend@test.local', password: 'geheim1234', role: 'member' });
    await t.api('PATCH', `/providers/${t.providerId}`, { shared: true, config: { memberModels: 'mock-2, mock-3' } });
    const mine = await modelChoices(t.app.ctx, t.app.ctx.auth.owner()!.id, { fresh: true });
    assert.deepEqual(mine[0].models.map((x) => x.id), ['mock-1']);
    const theirs = await modelChoices(t.app.ctx, m.id);
    assert.deepEqual(theirs.map((g) => [g.provider.own, g.provider.defaultModel, g.models.map((x) => x.id)]), [[false, 'mock-2', ['mock-2', 'mock-3']]]);
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------- the list without a screen

const G = (id: string, name: string, type: 'api' | 'cli', models: ModelInfo[], extra: Partial<ModelGroup['provider']> = {}, error?: string): ModelGroup => ({ provider: { id, name, kind: id, kindLabel: name, type, own: true, ...extra }, models, error });
const groups: ModelGroup[] = [
  G('claude', 'Claude Code', 'cli', [
    { id: 'default', label: 'Standaard van Claude Code (nu Opus 5.5)', billing: 'subscription', reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'opus', label: 'Opus · altijd de nieuwste (nu Opus 5.5)', billing: 'subscription', reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'haiku', label: 'Haiku · altijd de nieuwste (nu Haiku 4.5)', billing: 'subscription', reasoningLevels: [] },
    { id: 'claude-opus-5-5', label: 'Opus 5.5 · vaste versie (claude-opus-5-5)', billing: 'subscription' },
  ], { billing: 'subscription', defaultModel: 'default' }),
  G('opencode', 'OpenCode', 'cli', [
    { id: 'default', label: 'Standaard (instelling van de CLI)' },
    { id: 'opencode/big-pickle', label: 'Big Pickle · gratis', billing: 'free' },
    { id: 'anthropic/claude-sonnet-4-5', label: 'Sonnet 4.5 (anthropic) · eigen provider in OpenCode' },
  ], { billing: 'free', defaultModel: 'opencode/big-pickle' }),
  G('ollama', 'Ollama (lokaal)', 'api', [{ id: 'qwen3.6:latest', billing: 'local', free: true }], { billing: 'local', defaultModel: 'qwen3.6:latest' }),
  G('openai', 'OpenAI', 'api', [{ id: 'gpt-5.4-mini', reasoningLevels: ['none', 'low', 'medium', 'high'] }, { id: 'gpt-4.1', reasoningLevels: [] }], { billing: 'paid' }),
  G('lmstudio', 'LM Studio (lokaal)', 'api', [], { billing: 'local' }, 'ECONNREFUSED'),
];

test('rows: the AI the bot is on first with "Automatisch" on top, cost on the AI or on the row, the current choice always in view', () => {
  const s = modelSections(groups, { provider_id: 'opencode', model: '' });
  assert.deepEqual(s.map((x) => x.provider.id), ['opencode', 'claude', 'ollama', 'openai', 'lmstudio']);
  assert.deepEqual(s[0].rows.map((r) => [r.model, r.name, r.hint, r.now, r.billing]), [
    ['', AUTO, undefined, 'Big Pickle', undefined],
    ['opencode/big-pickle', 'Big Pickle', undefined, undefined, 'free'],
    ['anthropic/claude-sonnet-4-5', 'Sonnet 4.5 (anthropic)', 'eigen provider in OpenCode', undefined, undefined],
  ]);
  assert.equal(s[0].billing, undefined, 'OpenCode: the cost differs per model');
  assert.ok(isCurrent(s[0], s[0].rows[0], { provider_id: 'opencode', model: '' }) && isCurrent(s[0], s[0].rows[0], { provider_id: 'opencode', model: 'default' }));
  assert.ok(!isCurrent(s[1], s[1].rows[0], { provider_id: 'opencode', model: '' }), '"Automatisch" of another AI is not the current row');
  // Claude Code: one cost for the whole AI, the engine's "default" entry is the Automatisch row and says what it is now.
  assert.equal(s[1].billing, 'subscription');
  assert.deepEqual(s[1].rows.map((r) => [r.model, r.name, r.hint || r.now]), [
    ['', AUTO, 'Opus 5.5'],
    ['opus', 'Opus', 'altijd de nieuwste (nu Opus 5.5)'],
    ['haiku', 'Haiku', 'altijd de nieuwste (nu Haiku 4.5)'],
    ['claude-opus-5-5', 'Opus 5.5', 'vaste versie (claude-opus-5-5)'],
  ]);
  assert.ok(s[1].rows.every((r) => !r.billing));
  // An API without a default model has no "Automatisch"; a model without a label is said in words.
  assert.deepEqual(s[3].rows.map((r) => r.name), ['gpt-5.4-mini', 'gpt-4.1']);
  assert.equal(s[3].billing, 'paid');
  assert.deepEqual(s[2].rows.map((r) => [r.name, r.now]), [[AUTO, 'qwen3.6'], ['qwen3.6', undefined]]);
  // An AI whose list could not be read keeps its place, with the reason.
  assert.deepEqual([s[4].rows.length, s[4].error, s[4].billing], [0, 'ECONNREFUSED', 'local']);
  // A model typed in on the bot's page is not in the list: it gets a row of its own.
  const own = modelSections(groups, { provider_id: 'openai', model: 'gpt-9-preview' });
  assert.deepEqual(own[0].rows.map((r) => r.model), ['gpt-9-preview', 'gpt-5.4-mini', 'gpt-4.1']);
  assert.ok(isCurrent(own[0], own[0].rows[0], { provider_id: 'openai', model: 'gpt-9-preview' }));
  // A bot without an AI: the order they were connected in.
  assert.deepEqual(modelSections(groups, { provider_id: null, model: '' }).map((x) => x.provider.id), ['claude', 'opencode', 'ollama', 'openai', 'lmstudio']);
  assert.equal(rowCount(s), 11);
  assert.deepEqual(rowText({ id: 'claude-haiku-4-5-20251001' }), { name: 'Haiku 4.5', hint: undefined });
});

test('search: every word, in the name of the AI, the model, its id or what it costs', () => {
  const s = modelSections(groups, { provider_id: 'claude', model: 'opus' });
  const found = (q: string) => filterSections(s, q, (b) => ({ free: 'gratis', subscription: 'abonnement', paid: 'betaald', local: 'lokaal, gratis' })[b]).flatMap((x) => x.rows.map((r) => `${x.provider.id}:${r.model}`));
  assert.deepEqual(found('haiku'), ['claude:haiku']);
  assert.deepEqual(found('claude opus'), ['claude:opus', 'claude:claude-opus-5-5'], 'not "Automatisch (nu Opus 5.5)": Enter picks the first hit');
  assert.deepEqual(found('OLLAMA'), ['ollama:', 'ollama:qwen3.6:latest']);
  assert.deepEqual(found('betaald'), ['openai:gpt-5.4-mini', 'openai:gpt-4.1']);
  assert.deepEqual(found('gratis pickle'), ['opencode:opencode/big-pickle']);
  assert.deepEqual(found('abonnement automatisch'), ['claude:']);
  assert.deepEqual(found('bestaat-niet'), []);
  assert.equal(filterSections(s, '  ').length, s.length);
});

test('the control: the AI and the model in short words, "Automatisch" when the AI picks', () => {
  assert.deepEqual(controlText({ provider_id: 'claude', model: 'sonnet' }, { name: 'Claude Code' }), { ai: 'Claude Code', model: 'Sonnet' });
  assert.deepEqual(controlText({ provider_id: 'claude', model: 'claude-opus-5-5' }, { name: 'Claude Code' }), { ai: 'Claude Code', model: 'Opus 5.5' });
  assert.deepEqual(controlText({ provider_id: 'claude', model: '' }, { name: 'Claude Code' }), { ai: 'Claude Code', model: AUTO });
  assert.deepEqual(controlText({ provider_id: 'claude', model: 'default' }, { name: 'Claude Code' }), { ai: 'Claude Code', model: AUTO });
  assert.deepEqual(controlText({ provider_id: 'oc', model: 'opencode/big-pickle' }, { name: 'OpenCode' }), { ai: 'OpenCode', model: 'Big Pickle' });
  assert.deepEqual(controlText({ provider_id: null, model: '' }, null), { ai: '', model: AUTO });
});

test('thinking level on a new model: kept when it fits or nothing is known, else the nearest it takes, never deeper on a tie', () => {
  assert.equal(fitReasoning('', ['low', 'high']), '', 'standaard stays standaard');
  assert.equal(fitReasoning('high', undefined), 'high', 'unknown model: kept');
  assert.equal(fitReasoning('high', ['low', 'medium', 'high']), 'high');
  assert.equal(fitReasoning('max', ['low', 'medium', 'high']), 'high');
  assert.equal(fitReasoning('xhigh', ['none', 'low', 'medium', 'high', 'xhigh', 'max']), 'xhigh');
  assert.equal(fitReasoning('minimal', ['low', 'medium', 'high']), 'low');
  assert.equal(fitReasoning('none', ['low', 'medium', 'high']), 'low');
  assert.equal(fitReasoning('medium', ['low', 'high']), 'low', 'equally near: the lighter one');
  assert.equal(fitReasoning('high', ['none', 'on']), 'on');
  assert.equal(fitReasoning('on', ['low', 'medium', 'high']), 'medium');
  assert.equal(fitReasoning('high', []), '', 'a model without levels: standaard');
  assert.equal(fitReasoning('raar', ['low']), '');
  // The levels come from the list the pick was made in; "Automatisch" takes those of the AI's default model.
  assert.deepEqual(levelsOfPick(groups, { provider_id: 'claude', model: 'haiku' }), []);
  assert.deepEqual(levelsOfPick(groups, { provider_id: 'claude', model: '' }), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(levelsOfPick(groups, { provider_id: 'openai', model: 'gpt-5.4-mini' }), ['none', 'low', 'medium', 'high']);
  assert.equal(levelsOfPick(groups, { provider_id: 'claude', model: 'claude-opus-5-5' }), undefined);
  assert.equal(levelsOfPick(groups, { provider_id: 'ollama', model: '' }), undefined);
  assert.equal(levelsOfPick(groups, { provider_id: 'weg', model: 'x' }), undefined);
});
