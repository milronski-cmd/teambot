// What TeamBot adds to every step of a bot stays small (12 nov 2026). A bot on Claude Code dragged about 18,600 tokens
// of tool definitions and a system prompt of 4,600 (fresh install) to 8,400 tokens (in use) into every step. Now a
// model is listed a small core of its tools, plus tools_find (which names every other tool it has) and tools_call
// (server/tools/selection.ts), and the prompt says things once. These tests keep it that way:
//  - the size of the listed tools and of TeamBot's own text for a default new bot stays under a ceiling;
//  - every tool outside the list is named where the bot looks, and is found and used within one run, through the same
//    gate, on the API and the CLI route; the first use of a part brings the rest of that part along;
//  - the main bot keeps every tool it had.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestApp, type TestApp } from './helpers.js';
import { estimateTokens } from '../server/core/tokens.js';
import { makeScope } from '../server/modules/cli-agents/context.js';
import { nativeExclusions, teambotTools } from '../server/modules/cli-agents/toolhost.js';
import { CALL_NAME, FIND_NAME, specTokens } from '../server/tools/selection.js';
import type { ChatRequest } from '../server/core/types.js';

const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-agents-fake-claude.mjs');

/**
 * Ceilings, in tokens by TeamBot's own estimate (core/tokens.ts), for a bot as a fresh install makes it ("Volledige
 * toegang", every part on, nothing of the owner in it yet). Measured 12 nov 2026: an ordinary bot on Claude Code is
 * listed 16 tools of about 3,420 tokens (was 102 tools, 18,660), of which about 580 are the names of the 88 tools it
 * finds on demand, and reads about 2,470 tokens of instructions (was 4,620). The main bot has TeamBot itself on top
 * (teambot_find, teambot_do and its job): about 3,960 and 3,840 (was 21,400 and 6,250). A new line or tool that does
 * not fit: say it shorter, or put the tool on demand.
 */
const MAX = { tools: 3500, system: 2500, mainTools: 4050, mainSystem: 3950, apiTools: 4400, apiSystem: 2350 };

const md = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nDoe het stap voor stap.\n`;
const count = (text: string, part: string) => text.split(part).length - 1;
/** Every part a new bot gets (a container or an own server is a computer the owner sets up first). */
const every = (ctx: { tools: { groups: Map<string, unknown> } }) => [...ctx.tools.groups.keys()].filter((g) => g !== 'container' && g !== 'remote');
const until = async <T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 10_000, what = 'voorwaarde'): Promise<T> => {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - start > ms) throw new Error(`time-out: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** One turn of a bot on the fake Claude Code: what the CLI was listed, found and used, and what it read as instructions. */
async function claudeTurn(t: TestApp, agentId: string, say = 'Welke tools heb je? SCENARIO:tools') {
  const th = await t.api('POST', '/threads', { agentId });
  const from = fs.existsSync(process.env.FAKE_CLI_LOG!) ? fs.readFileSync(process.env.FAKE_CLI_LOG!, 'utf8').split('\n').filter(Boolean).length : 0;
  await t.say(th.id, say, 60_000);
  const lines = fs.readFileSync(process.env.FAKE_CLI_LOG!, 'utf8').split('\n').filter(Boolean).slice(from).map((l) => JSON.parse(l));
  const run = lines.find((l) => Array.isArray(l.argv) && l.argv.includes('-p'))!;
  const seen = lines.find((l) => l.teambotListed)!;
  const msg = t.app.ctx.store.messages(th.id).filter((m) => m.role === 'assistant').at(-1)!;
  return { th, argv: run.argv as string[], system: String(run.system || ''), listed: seen.teambotListed as string[], deferred: (seen.teambotDeferred || []) as string[], found: seen.teambotFound as string[], used: seen.teambotUsed as { name: string; fields: boolean; ok: boolean; text: string } | null, msg };
}

/** The TeamBot tools of one CLI run of a bot, as the tool host serves them (what the MCP bridge passes on). */
async function hostFor(t: TestApp, agentId: string, engine: 'claude' | 'codex' | 'acp' = 'claude') {
  const ctx = t.app.ctx;
  const a = ctx.store.agent(agentId)!;
  const th = await t.api('POST', '/threads', { agentId });
  const input = ctx.store.createMessage({ thread_id: th.id, role: 'user', author_type: 'user', author_id: a.user_id, author_name: 'Ik', content: 'hoi' } as any);
  const run = ctx.store.createRun({ thread_id: th.id, agent_id: a.id, user_id: a.user_id, status: 'running', trigger: 'user', input_message_id: input.id, meta: {} });
  const events: any[] = [];
  const scope = makeScope(ctx, ctx.providers.config(t.providerId)!, { model: '', system: '', prompt: 'hoi', attachments: [], workspace: a.workspace, accessMode: a.access_mode, agentId: a.id, threadId: th.id, runId: run.id, userId: a.user_id }, new AbortController().signal, (e) => events.push(e));
  const host = teambotTools(scope, { engine });
  const call = async (name: string, args: any = {}) => {
    const r = await host.call(name, args, new AbortController().signal);
    return { isError: !!r.isError, text: String(r.content?.[0]?.text || '') };
  };
  return { a, th, run, host, call, events };
}

test('a default new bot: the listed tools and TeamBot’s own text stay under the ceiling (Claude Code and API), and a skill is named once', async (tt) => {
  const log = path.join(fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || '.', 'tb-light-')), 'cli.log');
  process.env.FAKE_CLI_LOG = log;
  const t = await startTestApp();
  try {
    const ctx = t.app.ctx;
    const p = await t.api('POST', '/providers', { kind: 'claude-code', config: { path: FAKE_CLAUDE } });
    // As the app makes them: only a name and an engine. The first bot of a fresh install is the main bot.
    const main = await t.api('POST', '/agents', { name: 'Eerste', provider_id: p.id, model: '' });
    const bot = await t.api('POST', '/agents', { name: 'Tweede', provider_id: p.id, model: '' });
    assert.equal(ctx.store.agent(bot.id)!.access_mode, 'full', 'a new bot of the owner: Volledige toegang');
    assert.equal(ctx.services.teams.mainOf(bot.user_id), main.id);

    const b = await claudeTurn(t, bot.id);
    const bs = b.msg.parts.contextStats!;
    // Without the path of the bot's folder on this computer (the temp folder of a test differs per machine).
    const fixed = (system: string, id: string) => system.replace(ctx.store.agent(id)!.workspace, 'C:\\werkmap');
    assert.ok(b.system.includes(ctx.store.agent(bot.id)!.workspace));
    const sysTokens = estimateTokens(fixed(b.system, bot.id));
    tt.diagnostic(`bot on Claude Code: ${b.listed.length - 1} TeamBot tools listed of ${bs.tools.of}, ~${bs.parts.tools} tokens; instructions ~${sysTokens} tokens (TeamBot's shared prompt ~${bs.parts.system})`);
    assert.ok(bs.parts.tools <= MAX.tools, `the listed tools of a default bot: ~${bs.parts.tools} tokens, ceiling ${MAX.tools}`);
    assert.ok(sysTokens <= MAX.system, `the instructions a default bot reads on Claude Code: ~${sysTokens} tokens, ceiling ${MAX.system}`);
    assert.ok(bs.tools.sent <= 20 && bs.tools.of > 80 && bs.tools.leftOut.length > 5, JSON.stringify(bs.tools));
    assert.ok(bs.shortened.savedTokens > 10_000, 'the answer says what was saved');
    // Claude Code is allowed exactly what it is listed (the rest goes through tools_call, gated inside TeamBot).
    const allowed = b.argv[b.argv.indexOf('--allowedTools') + 1].split(',');
    assert.deepEqual(allowed.sort(), b.listed.filter((n) => n !== 'permission_prompt').map((n) => `mcp__teambot__${n}`).sort());

    const m = await claudeTurn(t, main.id);
    const ms = m.msg.parts.contextStats!;
    const mainTokens = estimateTokens(fixed(m.system, main.id));
    tt.diagnostic(`main bot on Claude Code: ${m.listed.length - 1} listed of ${ms.tools.of}, ~${ms.parts.tools} tokens; instructions ~${mainTokens} tokens`);
    assert.ok(ms.parts.tools <= MAX.mainTools, `main bot tools ~${ms.parts.tools}, ceiling ${MAX.mainTools}`);
    assert.ok(mainTokens <= MAX.mainSystem, `main bot instructions ~${mainTokens}, ceiling ${MAX.mainSystem}`);

    // The same for a model over an API (it also needs TeamBot's file, terminal and web tools: a CLI has those itself).
    const api = await t.api('POST', '/agents', { name: 'Derde', provider_id: t.providerId, model: 'mock-1' });
    const ath = await t.api('POST', '/threads', { agentId: api.id });
    t.script.push({ text: 'Hoi.' });
    await t.say(ath.id, 'hoi');
    const req = t.requests.at(-1)!;
    const apiTools = specTokens(req.tools);
    const apiSystem = estimateTokens(fixed(req.system, api.id));
    tt.diagnostic(`bot on an API model: ${req.tools.length} tools listed, ~${apiTools} tokens; system ~${apiSystem} tokens`);
    assert.ok(apiTools <= MAX.apiTools, `API bot tools ~${apiTools}, ceiling ${MAX.apiTools}`);
    assert.ok(apiSystem <= MAX.apiSystem, `API bot system ~${apiSystem}, ceiling ${MAX.apiSystem}`);
    for (const n of ['read_file', 'write_file', 'run_command', 'web_search', 'memory_search', 'dossier_write', 'ask_user', FIND_NAME, CALL_NAME]) assert.ok(req.tools.some((x) => x.name === n), `${n} listed for an API bot`);

    // Nothing twice: a skill of the team is named once (the list stood in the prompt twice), and Claude Code gets
    // TeamBot's note once (it was also sent as the MCP server's instructions).
    for (const [name, text] of [['weekrapport', 'Maakt het weekrapport.'], ['offerte-check', 'Kijkt een offerte na.']]) {
      const pv = await t.api('POST', '/skills/import/preview', { kind: 'paste', text: md(name, text) });
      await t.api('POST', '/skills/import/commit', { stagingId: pv.stagingId });
    }
    const withSkills = await ctx.services.runner.systemPrompt(ctx.store.agent(bot.id)!, ctx.store.thread(b.th.id)!);
    assert.equal(count(withSkills, '- weekrapport: Maakt het weekrapport.'), 1, 'a skill is in the prompt once');
    assert.equal(count(withSkills, '- offerte-check: Kijkt een offerte na.'), 1);
    assert.doesNotMatch(withSkills, /Ook van je team/, 'a bot without a list of its own has no second list');
    assert.equal(count(b.system, '## TeamBot-tools'), 1);
    assert.equal(((await hostFor(t, bot.id)).host as any).instructions, undefined, 'the MCP server sends no second copy of the note');
  } finally {
    delete process.env.FAKE_CLI_LOG;
    await t.close();
    fs.rmSync(path.dirname(log), { recursive: true, force: true });
  }
});

test('API route: a tool outside the list is found and used in one run, as itself: same gate, same log, the list never changes', async () => {
  process.env.TEAMBOT_TEST_NO_AUTO_MAIN = '1';
  const t = await startTestApp();
  try {
    const ctx = t.app.ctx;
    const a = await t.agent({ name: 'Rik', access_mode: 'ask', tool_groups: every(ctx) });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push(
      { toolCalls: [{ name: FIND_NAME, args: { query: 'routine' } }] },
      { toolCalls: [{ name: CALL_NAME, args: { name: 'routine_list', args: {} } }] },
      // A write tool through tools_call: the owner is asked, as for a listed tool.
      { toolCalls: [{ name: CALL_NAME, args: { name: 'memory_remember', args: { content: 'De eigenaar drinkt thee zonder suiker' } } }] },
      { text: 'Klaar.' },
    );
    const from = t.requests.length;
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Welke routines heb ik? En onthoud mijn thee.' });
    const ap = await until(async () => (await t.api('GET', '/approvals')).find((x: any) => x.status === 'pending' && x.thread_id === th.id), 15_000, 'approval');
    assert.equal(ap.tool, 'memory_remember', 'the approval card is about the tool itself, not about tools_call');
    assert.equal(ap.input.content, 'De eigenaar drinkt thee zonder suiker');
    await t.api('POST', `/approvals/${ap.id}`, { decision: 'approve' });
    await t.waitIdle(th.id, 15_000);
    const reqs: ChatRequest[] = t.requests.slice(from);
    assert.equal(reqs.length, 4, 'one run: find, use, use, answer');
    const names = reqs[0].tools.map((x) => x.name);
    assert.ok(names.includes(FIND_NAME) && names.includes(CALL_NAME) && !names.includes('routine_list') && !names.includes('memory_remember') && !names.includes('browser_click'), names.join(', '));
    // Findable: every tool outside the list is named in the description of tools_find (never a guess whether it exists).
    const whole0 = (await ctx.tools.forAgent(ctx.store.agent(a.id)!, ctx.store.thread(th.id)!)).map((x) => x.name);
    const finder = reqs[0].tools.find((x) => x.name === FIND_NAME)!.description;
    assert.deepEqual(whole0.filter((n) => !names.includes(n) && !new RegExp(`\\b${n}\\b`).test(finder)), [], 'named in tools_find');
    assert.ok(whole0.length > 100 && names.length <= 30, `${names.length} of ${whole0.length} listed`);
    assert.equal(new Set(reqs.map((r) => JSON.stringify(r.tools))).size, 1, 'the same list in every step (prompt caching)');
    assert.equal(new Set(reqs.map((r) => r.system)).size, 1);
    assert.match(reqs[0].system, /zoek je met tools_find en gebruik je met tools_call/);

    const msgs = ctx.store.messages(th.id);
    const results = msgs.filter((m) => m.role === 'tool');
    assert.match(results[0].content, /### routine_list\n[\s\S]*velden: \{/, 'found: the description and the fields');
    assert.match(results[0].content, /### routine_create/);
    assert.equal(results[1].parts.toolResult!.name, 'routine_list', 'stored as the tool it is');
    assert.equal(results[1].parts.toolResult!.via, CALL_NAME);
    assert.equal(results[1].parts.toolResult!.isError, false, results[1].content);
    const call = msgs.find((m) => m.role === 'assistant' && m.parts.toolCalls?.some((c) => c.name === 'routine_list'))!.parts.toolCalls![0];
    assert.deepEqual({ name: call.name, args: call.args, via: call.via, status: call.status }, { name: 'routine_list', args: {}, via: CALL_NAME, status: 'done' });
    assert.equal(results[2].parts.toolResult!.name, 'memory_remember');
    assert.equal(results[2].parts.toolResult!.isError, false, results[2].content);
    assert.ok(ctx.store.all<any>("SELECT content FROM memory_items WHERE status != 'deleted'").some((r) => /thee zonder suiker/.test(r.content || '')), 'it ran after the approval');
    // The log names the tools themselves.
    const audit = ctx.store.all<any>("SELECT data FROM audit WHERE kind = 'tool.call'").map((r) => JSON.parse(r.data));
    assert.ok(audit.some((x) => x.tool === 'routine_list' && !x.error) && audit.some((x) => x.tool === 'memory_remember' && x.approved), JSON.stringify(audit));
    assert.ok(!audit.some((x) => x.tool === CALL_NAME), 'never as tools_call');
    // The model reads its own steps back as it wrote them: every call names a tool in its list.
    const back = reqs[3].messages.filter((m) => m.role === 'assistant').flatMap((m) => m.toolCalls || []);
    assert.deepEqual(back.map((c) => c.name), [FIND_NAME, CALL_NAME, CALL_NAME]);
    assert.deepEqual(back[1].args, { name: 'routine_list', args: {} });

    // Refused is refused: the owner says no, and a tool the owner switched off for this bot.
    const before = ctx.store.all('SELECT id FROM memory_items').length;
    t.script.push({ toolCalls: [{ name: CALL_NAME, args: { name: 'memory_remember', args: { content: 'De eigenaar woont op de maan' } } }] }, { text: 'Dan niet.' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'En dit?' });
    const ap2 = await until(async () => (await t.api('GET', '/approvals')).find((x: any) => x.status === 'pending' && x.thread_id === th.id), 15_000, 'approval 2');
    await t.api('POST', `/approvals/${ap2.id}`, { decision: 'deny' });
    await t.waitIdle(th.id, 15_000);
    assert.equal(ctx.store.all('SELECT id FROM memory_items').length, before, 'deny: nothing saved');
    assert.match(ctx.store.messages(th.id).filter((m) => m.role === 'tool').at(-1)!.content, /geweigerd/i);

    const strict = await t.agent({ name: 'Strak', access_mode: 'auto', tool_groups: every(ctx), tool_policy: { routine_list: 'deny' } });
    const sth = await t.api('POST', '/threads', { agentId: strict.id });
    t.script.push(
      { toolCalls: [{ name: CALL_NAME, args: { name: 'routine_list', args: {} } }] },
      // Wrong fields: the correction comes with the fields. An unknown name: what it might be.
      { toolCalls: [{ name: CALL_NAME, args: { name: 'reminder_set', args: { text: 5, in_minutes: 'straks' } } }] },
      { toolCalls: [{ name: CALL_NAME, args: { name: 'reminder_maken', args: {} } }] },
      // A model that calls an unlisted tool by its own name gets it too (and fields beside the name are read).
      { toolCalls: [{ name: 'reminder_set', args: { text: 'Bel de tandarts', in_minutes: 30 } }, { name: CALL_NAME, args: { name: 'mcp__teambot__reminder_set', text: 'Bel de garage', in_minutes: 45 } }] },
      { text: 'Zo.' },
    );
    await t.say(sth.id, 'Probeer het.');
    const out = ctx.store.messages(sth.id).filter((m) => m.role === 'tool');
    assert.match(out[0].content, /geen toestemming voor routine_list/, 'the tool policy of the bot counts');
    assert.equal(out[0].parts.toolResult!.isError, true);
    assert.match(out[1].content, /Velden van reminder_set: \{"type":"object"/, out[1].content);
    assert.match(out[2].content, /Onbekend hulpmiddel: reminder_maken\..*reminder_set/s);
    assert.equal(out[3].parts.toolResult!.isError, false, out[3].content);
    assert.equal(out[4].parts.toolResult!.name, 'reminder_set');
    assert.equal(out[4].parts.toolResult!.isError, false, out[4].content);

    // "Fewer tools" off for a bot: everything is listed, as before, and nothing is said about finding tools.
    const whole = await t.agent({ name: 'Alles', access_mode: 'auto', tool_groups: every(ctx), settings: { contextSaver: { selectTools: false } } });
    const wth = await t.api('POST', '/threads', { agentId: whole.id });
    t.script.push({ text: 'ok' });
    await t.say(wth.id, 'hoi');
    const all = t.requests.at(-1)!;
    assert.ok(all.tools.some((x) => x.name === 'routine_list') && all.tools.some((x) => x.name === 'browser_click') && !all.tools.some((x) => x.name === FIND_NAME || x.name === CALL_NAME));
    assert.doesNotMatch(all.system, /tools_find/);
  } finally {
    delete process.env.TEAMBOT_TEST_NO_AUTO_MAIN;
    await t.close();
  }
});

test('what a bot must know about a part comes with the part: not in every step, once per run when it is found or used', async () => {
  process.env.TEAMBOT_TEST_NO_AUTO_MAIN = '1';
  const t = await startTestApp();
  try {
    const ctx = t.app.ctx;
    const a = await t.agent({ name: 'Rik', access_mode: 'auto', tool_groups: every(ctx) });
    await t.api('PUT', `/computers/${a.id}`, { mode: 'browser' }).catch(() => null);
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push(
      { toolCalls: [{ name: FIND_NAME, args: { query: 'teamdatabase' } }] },
      { toolCalls: [{ name: FIND_NAME, args: { query: 'team_query' } }] },
      { toolCalls: [{ name: CALL_NAME, args: { name: 'team_tables', args: {} } }] },
      { text: 'Klaar.' },
    );
    await t.say(th.id, 'Wat staat er in de teamdatabase?');
    const sys = t.requests.at(-1)!.system;
    assert.doesNotMatch(sys, /## Teamdatabase/, 'not in the prompt of every step');
    const out = ctx.store.messages(th.id).filter((m) => m.role === 'tool');
    assert.match(out[0].content, /### team_query/);
    assert.match(out[0].content, /## Teamdatabase\nJe team deelt één database/, 'with what tools_find finds');
    assert.doesNotMatch(out[1].content, /## Teamdatabase/, 'once per run');
    assert.doesNotMatch(out[2].content, /## Teamdatabase/);
    assert.equal(out[2].parts.toolResult!.isError, false, out[2].content);
    // One tool of a part used and the rest of the part is known: the fields of the other team database tools come
    // with the first use, so the bot needs no search step per tool.
    assert.match(out[2].content, /Bij dit onderdeel horen ook \(gebruik ze met tools_call\):\n\n### team_query\n[\s\S]*velden: \{[\s\S]*### team_execute\n/);
    assert.doesNotMatch(out[2].content, /### team_tables\n/, 'not the tool it just used');

    // Used without looking it up first (a name from its instructions or an earlier run): the guide comes with the result.
    t.script.push({ toolCalls: [{ name: CALL_NAME, args: { name: 'team_tables', args: {} } }] }, { text: 'Klaar.' });
    await t.say(th.id, 'Nog eens.');
    const again = ctx.store.messages(th.id).filter((m) => m.role === 'tool').at(-1)!;
    assert.match(again.content, /## Teamdatabase/, 'a new run: said once more, with the first use');
    assert.match(again.content, /### team_execute\n/);

    // The way into the browser is in the list; the first page brings the other browser tools and the browser's rules.
    const browse = t.requests.at(-1)!.tools.map((x) => x.name);
    assert.ok(browse.includes('browser_open') && browse.includes('browser_snapshot') && !browse.includes('browser_click'));
    const demand = (await import('../server/tools/selection.js')).onDemand;
    const all = await ctx.tools.forAgent(ctx.store.agent(a.id)!, ctx.store.thread(th.id)!);
    const d = demand({ tools: all, groups: ctx.tools.groups, guides: ctx.tools.guides, who: { agent: ctx.store.agent(a.id)!, thread: ctx.store.thread(th.id)!, userId: a.user_id }, on: true, told: new Set() });
    const first = await d.after(all.find((x) => x.name === 'browser_open'), { url: 'https://example.com' }, { text: 'Pagina geopend.' }, false);
    for (const n of ['browser_click', 'browser_type', 'browser_navigate', 'browser_submit', 'browser_request_login']) assert.match(first.text, new RegExp(`### ${n}\\n[^\\n]+\\nvelden: \\{`), `${n} comes with the first browser result`);
    assert.match(first.text, /## Je browser\n/);
    assert.ok(first.text.length < 14_000, `${first.text.length} characters`);
    assert.deepEqual(await d.after(all.find((x) => x.name === 'browser_snapshot'), {}, { text: 'Pagina.' }, false), { text: 'Pagina.' }, 'once');
    // The guides of older turns are part of the conversation the model gets back.
    assert.match(JSON.stringify(t.requests.at(-1)!.messages), /## Teamdatabase/);

    // Listed tools: the guide is in the prompt, as it always was.
    const whole = await t.agent({ name: 'Alles', access_mode: 'auto', tool_groups: every(ctx), settings: { contextSaver: { selectTools: false } } });
    const wth = await t.api('POST', '/threads', { agentId: whole.id });
    assert.match(await ctx.services.runner.systemPrompt(ctx.store.agent(whole.id)!, ctx.store.thread(wth.id)!), /## Teamdatabase\nJe team deelt één database/);
  } finally {
    delete process.env.TEAMBOT_TEST_NO_AUTO_MAIN;
    await t.close();
  }
});

test('CLI route (Claude Code, Codex, ACP): the same small list, and a tool outside it runs through the gate as itself', async () => {
  process.env.TEAMBOT_TEST_NO_AUTO_MAIN = '1';
  const t = await startTestApp();
  try {
    const ctx = t.app.ctx;
    const groups = every(ctx);
    const bot = await t.agent({ name: 'Rik', access_mode: 'ask', tool_groups: groups });
    const lists: Record<string, string[]> = {};
    for (const engine of ['claude', 'codex', 'acp'] as const) {
      const h = await hostFor(t, bot.id, engine);
      const specs = await h.host.list();
      lists[engine] = specs.map((x) => x.name);
      assert.deepEqual(await h.host.names(), lists[engine], `${engine}: the CLI is allowed what it is listed`);
      assert.ok(lists[engine].length <= 20 && lists[engine].includes(FIND_NAME) && lists[engine].includes(CALL_NAME), `${engine}: ${lists[engine].join(', ')}`);
      for (const n of ['ask_user', 'notify_user', 'memory_search', 'dossier_get', 'dossier_write', 'skill_load', 'delegate_task', 'ask_bot', 'plan_update', 'share_file', 'browser_open']) assert.ok(lists[engine].includes(n), `${engine}: ${n} listed`);
      for (const n of [...nativeExclusions(engine, 'ask')]) assert.ok(!lists[engine].includes(n), `${engine}: ${n} is the CLI's own`);
      // Claude Code never hides the small list behind its own tool search.
      assert.ok(specs.every((x) => x._meta?.['anthropic/alwaysLoad'] === true));
      assert.deepEqual((await h.host.list()).map((x) => x.name), lists[engine], 'the same list when asked again');
    }
    assert.ok(lists.codex.includes('web_search') && !lists.claude.includes('web_search'), 'Codex and ACP have no search of their own');
    // A bot whose computer is its own server works there: those tools are in its list.
    const far = await t.agent({ name: 'Ver', access_mode: 'ask', tool_groups: [...groups, 'remote'] });
    assert.ok((await (await hostFor(t, far.id)).host.names()).includes('remote_exec'));

    const h = await hostFor(t, bot.id);
    const found = await h.call(FIND_NAME, { query: 'herinnering' });
    assert.equal(found.isError, false);
    assert.match(found.text, /### reminder_set\n[\s\S]*velden: \{/);
    // A write tool: the approval is about the tool itself; approve runs it, with the run's bot, thread and run.
    const p1 = h.call(CALL_NAME, { name: 'memory_remember', args: { content: 'De eigenaar fietst naar zijn werk' } });
    const ap = await until(async () => (await t.api('GET', '/approvals')).find((x: any) => x.status === 'pending'), 10_000, 'approval');
    assert.deepEqual([ap.tool, ap.agent_id, ap.thread_id, ap.run_id], ['memory_remember', bot.id, h.th.id, h.run.id]);
    await t.api('POST', `/approvals/${ap.id}`, { decision: 'approve' });
    const r1 = await p1;
    assert.equal(r1.isError, false, r1.text);
    assert.ok(ctx.store.all<any>("SELECT content FROM memory_items WHERE status != 'deleted'").some((r) => /fietst naar zijn werk/.test(r.content || '')));
    // The step in the chat is the tool's own ("Onthouden …"), on the engine's step for its tools_call.
    assert.ok(h.events.some((e) => e.type === 'activity' && /^TeamBot · Onthouden/.test(e.item.title)), JSON.stringify(h.events.map((e) => e.item?.title)));
    const p2 = h.call(CALL_NAME, { name: 'memory_remember', args: { content: 'De eigenaar is een robot' } });
    const ap2 = await until(async () => (await t.api('GET', '/approvals')).find((x: any) => x.status === 'pending'), 10_000, 'approval 2');
    await t.api('POST', `/approvals/${ap2.id}`, { decision: 'deny' });
    const r2 = await p2;
    assert.equal(r2.isError, true);
    assert.match(r2.text, /geweigerd/i);
    assert.ok(!ctx.store.all<any>('SELECT content FROM memory_items').some((r) => /robot/.test(r.content || '')), 'deny: nothing happens');
    const audit = ctx.store.all<any>("SELECT data FROM audit WHERE kind = 'tool.call'").map((r) => JSON.parse(r.data));
    assert.ok(audit.some((x) => x.tool === 'memory_remember' && x.approved) && audit.some((x) => x.tool === 'memory_remember' && x.denied));
    assert.ok(!audit.some((x) => x.tool === CALL_NAME));

    // What a first use brought along stays in the engine's session: the next turn of that session does not get it again;
    // a new session does.
    const again = async (sessionId?: string) => {
      const scope = makeScope(ctx, ctx.providers.config(t.providerId)!, { model: '', system: '', prompt: 'x', attachments: [], workspace: h.a.workspace, accessMode: h.a.access_mode, agentId: bot.id, threadId: h.th.id, runId: h.run.id, userId: h.a.user_id, sessionId }, new AbortController().signal, () => {});
      const r = await teambotTools(scope, { engine: 'claude' }).call(CALL_NAME, { name: 'team_tables', args: {} }, new AbortController().signal);
      return String(r.content[0].text);
    };
    assert.match(await again('sessie-1'), /### team_query\n[\s\S]*## Teamdatabase/, 'first use in this session');
    assert.doesNotMatch(await again('sessie-1'), /### team_query|## Teamdatabase/, 'the same session: not again');
    assert.match(await again(undefined), /### team_query\n[\s\S]*## Teamdatabase/, 'a new session starts empty');

    // A read-only bot: what it may not use is not there to find or to call.
    const ro = await t.agent({ name: 'Lezer', access_mode: 'readonly', tool_groups: groups });
    const hr = await hostFor(t, ro.id);
    const all = await hr.call(FIND_NAME, { query: '' });
    assert.match(all.text, /routine_list/);
    assert.doesNotMatch(all.text, /memory_remember|routine_create|browser_click/);
    const no = await hr.call(CALL_NAME, { name: 'memory_remember', args: { content: 'x' } });
    assert.equal(no.isError, true);
    assert.match(no.text, /^Geweigerd door TeamBot: .* heeft in modus "readonly" geen toestemming voor memory_remember/);
    assert.equal((await hr.call(CALL_NAME, { name: 'routine_list', args: {} })).isError, false);
  } finally {
    delete process.env.TEAMBOT_TEST_NO_AUTO_MAIN;
    await t.close();
  }
});

test('one turn on Claude Code: the CLI finds and uses a tool outside its list in the same run', async () => {
  const log = path.join(fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || '.', 'tb-light-')), 'cli.log');
  process.env.FAKE_CLI_LOG = log;
  const t = await startTestApp();
  try {
    const p = await t.api('POST', '/providers', { kind: 'claude-code', config: { path: FAKE_CLAUDE } });
    const main = await t.api('POST', '/agents', { name: 'Eerste', provider_id: p.id, model: '' });
    const bot = await t.api('POST', '/agents', { name: 'Tweede', provider_id: p.id, model: '' });
    const b = await claudeTurn(t, bot.id);
    assert.ok(b.found.length > 80 && b.found.includes('routine_list') && b.found.includes('browser_click') && b.found.includes('my_settings'), `${b.found.length} tools found outside the list`);
    assert.deepEqual({ name: b.used?.name, fields: b.used?.fields, ok: b.used?.ok }, { name: 'routine_list', fields: true, ok: true }, JSON.stringify(b.used));
    assert.match(b.msg.content, /tools_call routine_list: gelukt/);
    // In the steps of the answer: what it looked for and what it did, in words.
    const steps = (b.msg.parts.activity || []).map((x: any) => x.title);
    assert.ok(steps.some((s: string) => /^TeamBot · Hulpmiddel zoeken: routine_list/.test(s)), steps.join(' | '));
    assert.ok(steps.some((s: string) => /^TeamBot · /.test(s) && !/Hulpmiddel/.test(s)), steps.join(' | '));
    assert.ok(!steps.some((s: string) => /tools_call|tools_find/.test(s)), 'never an internal name');

    // The main bot keeps everything it had: TeamBot itself in its list, every other tool within reach.
    const m = await claudeTurn(t, main.id, 'Welke tools heb je? SCENARIO:tools SCENARIO_CALL:team_templates');
    for (const n of ['teambot_find', 'teambot_do', 'delegate_task', 'ask_user', 'memory_search', 'dossier_write']) assert.ok(m.listed.includes(n), `the main bot is listed ${n}`);
    const ctx = t.app.ctx;
    const whole = (await ctx.tools.forAgent(ctx.store.agent(main.id)!, ctx.store.thread(m.th.id)!)).map((x) => x.name).filter((n) => !nativeExclusions('claude', 'full').has(n));
    // (109: skill_prepare_scripts was taken out on purpose with the one skills sync, commit 810f9838.)
    assert.ok(whole.length >= 109, `${whole.length} tools`);
    const reach = new Set([...m.listed, ...m.found]);
    assert.deepEqual(whole.filter((n) => !reach.has(n)), [], 'every tool of the main bot is listed or found');
    for (const n of ['bot_settings', 'bot_rules', 'team_add_bot', 'team_from_template', 'team_templates', 'team_profile', 'my_settings', 'my_routines', 'routine_create', 'browser_click', 'desktop_computer']) assert.ok(reach.has(n), `${n} within reach`);
    // The message names team_templates: listed for this run (tools/selection.ts `wanted`), not looked up.
    assert.ok(m.listed.includes('team_templates') && !m.found.includes('team_templates'));
    assert.deepEqual({ name: m.used?.name, ok: m.used?.ok }, { name: 'team_templates', ok: true }, JSON.stringify(m.used));
    // Only the main bot: the same call by another bot is refused by the tool itself, also through tools_call.
    const other = await claudeTurn(t, bot.id, 'SCENARIO:tools SCENARIO_CALL:team_templates');
    // teambot_do is in its list by name only (its instructions name it; Claude Code loads it when called), not loaded.
    assert.ok(!other.found.includes('team_templates') && other.deferred.includes('teambot_do') && !other.listed.filter((n) => !other.deferred.includes(n)).includes('teambot_do'));
    assert.equal(other.used?.ok, false, JSON.stringify(other.used));
  } finally {
    delete process.env.FAKE_CLI_LOG;
    await t.close();
    fs.rmSync(path.dirname(log), { recursive: true, force: true });
  }
});

// 12 nov: a bot set up to work in its browser had only browser_open and browser_snapshot in its list, also when the
// message named browser_click; a small model did not get there through tools_call and gave no answer, twice.
test('what a bot is set up for, and a tool the message names, is in its list (API and CLI); the default list stays the same', async () => {
  process.env.TEAMBOT_TEST_NO_AUTO_MAIN = '1';
  const t = await startTestApp();
  try {
    const ctx = t.app.ctx;
    const browse = ['browser_navigate', 'browser_click', 'browser_type', 'browser_select', 'browser_press', 'browser_submit', 'browser_request_login'];
    const listedIn = async (threadId: string, say: string) => {
      t.script.push({ text: 'Goed.' });
      await t.say(threadId, say);
      return t.requests.at(-1)!;
    };

    // Set up for its browser (its own instructions say so): the browser part is in its list, in every conversation.
    const web = await t.agent({ name: 'Surfer', access_mode: 'auto', tool_groups: every(ctx), instructions: 'Je werkt in je browser: log in op het portaal van de klant en verwerk de nieuwe aanvragen.' });
    await t.api('PUT', `/computers/${web.id}`, { mode: 'browser' }).catch(() => null);
    const wth = await t.api('POST', '/threads', { agentId: web.id });
    const req = await listedIn(wth.id, 'hoi');
    const names = req.tools.map((x) => x.name);
    for (const n of browse) assert.ok(names.includes(n), `${n} listed for a bot set up for its browser`);
    assert.ok(!names.includes('team_query') && !names.includes('desktop_computer') && !names.includes('routine_create'), 'only what it is set up for');
    assert.doesNotMatch(req.tools.find((x) => x.name === FIND_NAME)!.description, /browser_click/, 'listed, so not among what tools_find names');
    // Its rules are in its prompt, as for every part in the list, and do not come a second time with its first use.
    assert.match(req.system, /## Je browser\n/);
    const { onDemand } = await import('../server/tools/selection.js');
    const demandOf = async (id: string, threadId: string, asked?: string) => {
      const agent = ctx.store.agent(id)!;
      const thread = ctx.store.thread(threadId)!;
      const all = await ctx.tools.forAgent(agent, thread);
      const d = onDemand({ tools: all, groups: ctx.tools.groups, guides: ctx.tools.guides, who: { agent, thread, userId: agent.user_id }, on: true, told: new Set(), asked });
      return { d, tool: (n: string) => all.find((x) => x.name === n) };
    };
    const w = await demandOf(web.id, wth.id);
    assert.deepEqual(await w.d.after(w.tool('browser_click'), { ref: 'e1' }, { text: 'Geklikt.' }, false), { text: 'Geklikt.' });
    // The CLI route lists the same.
    const cli = await (await hostFor(t, web.id)).host.names();
    for (const n of browse) assert.ok(cli.includes(n), `CLI: ${n} listed`);

    // A bot without instructions: a tool the message names is listed for that run; a part whose tools belong together
    // comes whole, another tool alone. The next message without names has the default list again.
    const a = await t.agent({ name: 'Rik', access_mode: 'auto', tool_groups: every(ctx) });
    await t.api('PUT', `/computers/${a.id}`, { mode: 'browser' }).catch(() => null);
    const th = await t.api('POST', '/threads', { agentId: a.id });
    const plain = (await listedIn(th.id, 'hoi')).tools.map((x) => x.name);
    assert.ok(!plain.includes('browser_click') && !plain.includes('routine_list'));
    const said = 'Open example.com en klik met browser_click op de knop Verder.';
    const asked = await listedIn(th.id, said);
    for (const n of browse) assert.ok(asked.tools.some((x) => x.name === n), `${n} listed when the message names browser_click`);
    assert.doesNotMatch(asked.system, /## Je browser/, 'the prompt stays the same for every message');
    // ... so the browser's rules come with its first use in that run, without fields of tools it already has.
    const r = await demandOf(a.id, th.id, said);
    const first = await r.d.after(r.tool('browser_click'), { ref: 'e1' }, { text: 'Geklikt.' }, false);
    assert.match(first.text, /^Geklikt\.\n\n## Je browser\n/);
    assert.doesNotMatch(first.text, /Bij dit onderdeel horen ook/);
    assert.deepEqual(await r.d.after(r.tool('browser_type'), {}, { text: 'Getypt.' }, false), { text: 'Getypt.' }, 'once');
    const one = (await listedIn(th.id, 'Gebruik routine_list.')).tools.map((x) => x.name);
    assert.ok(one.includes('routine_list') && !one.includes('routine_create') && !one.includes('browser_click'), one.join(', '));
    assert.deepEqual((await listedIn(th.id, 'Dank je.')).tools.map((x) => x.name), plain, 'the default list again');
  } finally {
    delete process.env.TEAMBOT_TEST_NO_AUTO_MAIN;
    await t.close();
  }
});
