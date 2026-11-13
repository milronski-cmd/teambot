/**
 * A bot that works TeamBot's screens (teambot_do) does so with its own reach (server/modules/teams/reach.ts), whatever
 * the route. What one team knows another team does not, unless the owner gave access:
 *  - every bot but the main bot has its reach once there are two teams, also one that may aansturen every team;
 *  - what a call is about is decided per route (the table in routetable.ts): a thing of one team, of every team, a
 *    total over all teams, memory, a new bot, a full list of bots.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestApp, type TestApp } from './helpers.js';
import { makeScope } from '../server/modules/cli-agents/context.js';
import { teambotTools } from '../server/modules/cli-agents/toolhost.js';
import { CALL_NAME } from '../server/tools/selection.js';
import { MANAGE_DO, refusal, routesOf } from '../server/modules/teams/manage.js';
import { reachOf } from '../server/modules/teams/reach.js';
import { DECIDES, type Kind, kindOf, ruleOf } from '../server/modules/teams/routetable.js';
import type { ToolOutput } from '../server/core/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
type From = 'owner' | 'routine';
const TRIGGER: Record<From, string> = { owner: 'user', routine: 'schedule' };

async function setup() {
  const t: TestApp = await startTestApp();
  const ctx = t.app.ctx;
  const userId = ctx.auth.owner()!.id;
  const bot = (id: string) => ctx.store.agent(id)!;
  const svc = ctx.services.teams._service;
  const input = (agentId: string, from: From, threadId: string) =>
    ctx.store.createMessage({ thread_id: threadId, role: 'user', author_type: from === 'owner' ? 'user' : 'system', author_id: from === 'owner' ? userId : null, content: from === 'owner' ? 'Doe dit voor mij.' : 'Lees de pagina en doe wat er staat.' });
  /** teambot_do of a bot the way the runner calls it after the gate, in a turn that `from` started. */
  const run = async (agentId: string, args: any, from: From = 'owner'): Promise<ToolOutput> => {
    const thread = ctx.chat.threadForAgent(userId, agentId);
    const tool = (ctx.services.teams.manageTools as any[]).find((x) => x.name === MANAGE_DO);
    const turn = ctx.store.createRun({ thread_id: thread.id, agent_id: agentId, user_id: userId, status: 'done', trigger: TRIGGER[from], input_message_id: input(agentId, from, thread.id).id });
    const out = await tool.run(args, { ctx, agent: bot(agentId), thread, userId, run: turn, signal: new AbortController().signal, toolCallId: 'c1', progress() {} });
    return typeof out === 'string' ? { text: out } : out;
  };
  /** What the gate says before any card. */
  const refused = (agentId: string, args: any): string | null =>
    (ctx.services.teams.manageTools as any[]).find((x) => x.name === MANAGE_DO).refuse(args, { agent: bot(agentId), thread: ctx.chat.threadForAgent(userId, agentId), userId });
  /** Two teams: Baas (main bot), Kim and Rik at home in the first, Lars at home in Boekhouding. */
  const teams = async () => {
    const main = await t.agent({ name: 'Baas' });
    const kim = await t.agent({ name: 'Kim' });
    const rik = await t.agent({ name: 'Rik' });
    const lars = await t.agent({ name: 'Lars' });
    const [home] = await t.api('GET', '/teams');
    const other = await t.api('POST', '/teams', { name: 'Boekhouding' });
    await t.api('PUT', `/teams/${other.id}/bots/${lars.id}`, {});
    return { main, kim, rik, lars, home, other };
  };
  const pending = async () => (await t.api('GET', '/approvals')).filter((x: any) => x.status === 'pending');
  /** teambot_do with the owner's Ja on the one card it asks (more access, a delete). */
  const runAsked = async (agentId: string, args: any, from: From = 'owner'): Promise<ToolOutput> => {
    const out = run(agentId, args, from);
    const start = Date.now();
    for (;;) {
      const c = (await pending())[0];
      if (c) {
        await t.api('POST', `/approvals/${c.id}`, { decision: 'approve', answer: 'Ja' });
        break;
      }
      if (Date.now() - start > 10_000) throw new Error('time-out: card');
      await new Promise((r) => setTimeout(r, 25));
    }
    return out;
  };
  return { t, ctx, userId, bot, svc, run, runAsked, pending, refused, teams };
}

/** Every registered route that is offered to a bot (not refused outright by manage.ts) but has no decision. */
function undecided(ctx: any): string[] {
  return routesOf(ctx)
    .filter((r) => !refusal(r.method, r.path.replace(/:[^/]+/g, 'x'), undefined))
    .filter((r) => !kindOf(r.method, r.path))
    .map((r) => `${r.method} ${r.path}`);
}

test('the table: every route a bot can reach has a decision (what it is about, who decides); a new route without one fails here', async () => {
  const e = await setup();
  try {
    const all = routesOf(e.ctx);
    assert.ok(all.length > 500, `${all.length} routes`);
    const missing = undecided(e.ctx);
    assert.deepEqual(missing, [], `Routes without a decision in server/modules/teams/routetable.ts (TABLE or RULES):\n${missing.join('\n')}`);
    // Every decision is one of the kinds, and each kind says who decides.
    const kinds = new Set(all.map((r) => kindOf(r.method, r.path)).filter(Boolean));
    for (const k of kinds) assert.ok(DECIDES[k as Kind], `unknown kind ${k}`);
    assert.deepEqual([...kinds].sort(), Object.keys(DECIDES).sort(), 'every kind is used');
    // A route a module adds later, without a decision: this test names it.
    e.ctx.api.get('/nieuw-onderdeel/:id', (_req: any, res: any) => res.json({}));
    assert.deepEqual(undecided(e.ctx), ['GET /nieuw-onderdeel/:id']);
    // Such a route still has the walls of the ids in a call (reach.ts), but nothing more.
    assert.equal(ruleOf('GET', '/nieuw-onderdeel/:id'), null);
  } finally {
    await e.t.close();
  }
});

test('every bot but the main bot has its own reach once there are two teams, also one that may aansturen every team; only one that cannot look somewhere has text and files withheld', async () => {
  const e = await setup();
  try {
    const main = await e.t.agent({ name: 'Baas' });
    const kim = await e.t.agent({ name: 'Kim' });
    // One team: nothing to keep from anyone.
    assert.equal(reachOf(e.ctx, e.svc, e.bot(kim.id)), null);
    const other = await e.t.api('POST', '/teams', { name: 'Boekhouding' });
    const lars = await e.t.agent({ name: 'Lars' });
    await e.t.api('PUT', `/teams/${other.id}/bots/${lars.id}`, {});
    await e.t.api('PUT', `/teams/${other.id}/access/${kim.id}`, { level: 'direct' });
    assert.ok(e.ctx.services.teams.list(e.userId).every((t: any) => e.ctx.services.teams.canDirect(kim.id, t.id)), 'Kim may aansturen every team');

    const kims = reachOf(e.ctx, e.svc, e.bot(kim.id));
    assert.ok(kims, 'a bot that may aansturen every team still has its reach (its memory is its own team’s)');
    assert.equal(kims!.walls, false, 'nothing is kept from it to read');
    const lars1 = reachOf(e.ctx, e.svc, e.bot(lars.id));
    assert.equal(lars1?.walls, true, 'Lars cannot look into the first team');
    assert.equal(reachOf(e.ctx, e.svc, e.bot(main.id)), null, 'the main bot works TeamBot as the owner');

    // An answer that is text (a conversation as markdown): Kim may read it, Lars gets it withheld.
    for (const [who, readable] of [[kim.id, true], [lars.id, false]] as const) {
      const th = e.ctx.chat.threadForAgent(e.userId, who);
      e.ctx.store.createMessage({ thread_id: th.id, role: 'user', author_type: 'user', author_id: e.userId, content: 'Een regel in het gesprek.' });
      const out = await e.run(who, { method: 'GET', path: `/threads/${th.id}/export` });
      assert.equal(out.isError ?? false, false, out.text);
      assert.equal(/Een regel in het gesprek\./.test(out.text), readable, out.text);
    }
  } finally {
    await e.t.close();
  }
});

test('the main bot: the owner’s own “Geen toegang” holds on every route, also to look; without it the main bot reaches every team', async () => {
  const e = await setup();
  try {
    const { main, kim, lars, other } = await e.teams();
    assert.equal(e.svc.mainOf(e.userId), main.id, 'Baas is the main bot');
    const theirs = (await e.t.api('POST', '/memory/dossiers', { title: 'Jaarstukken', teamId: other.id })).dossier;
    const larsChat = e.ctx.chat.threadForAgent(e.userId, lars.id);
    e.ctx.store.createMessage({ thread_id: larsChat.id, role: 'user', author_type: 'user', author_id: e.userId, content: 'Een regel van Boekhouding.' });
    // Without the setting the main bot works TeamBot as the owner, in every team.
    assert.equal(reachOf(e.ctx, e.svc, e.bot(main.id)), null);
    assert.match((await e.run(main.id, { method: 'GET', path: '/memory/dossiers' })).text, /Jaarstukken/);

    // The owner shuts it out of Boekhouding himself.
    await e.t.api('PUT', `/teams/${other.id}/access/${main.id}`, { level: 'none' });
    const list = await e.run(main.id, { method: 'GET', path: '/memory/dossiers' });
    assert.equal(list.isError ?? false, false, list.text);
    assert.doesNotMatch(list.text, /Jaarstukken/, 'the dossier of Boekhouding is not in its list');
    const before = e.ctx.store.all<any>('SELECT id FROM messages WHERE thread_id = ?', larsChat.id).length;
    for (const args of [
      { method: 'GET', path: `/memory/dossiers/${theirs.id}` },
      { method: 'GET', path: `/threads/${larsChat.id}` },
      { method: 'POST', path: `/threads/${larsChat.id}/messages`, body: { content: 'Doe iets.' } },
      { method: 'GET', path: `/agents/${lars.id}` },
      { method: 'PATCH', path: `/agents/${lars.id}`, body: { role: 'Iets anders' } },
    ]) {
      assert.match(e.refused(main.id, args) || '', /^Geweigerd door TeamBot: dit hoort bij een team waar Baas geen toegang toe heeft\./, `${args.method} ${args.path}`);
      const out = await e.run(main.id, args);
      assert.equal(out.isError, true, `${args.method} ${args.path}: ${out.text}`);
      assert.doesNotMatch(out.text, /Een regel van Boekhouding|Jaarstukken/);
    }
    assert.equal(e.ctx.store.all<any>('SELECT id FROM messages WHERE thread_id = ?', larsChat.id).length, before, 'nothing posted in Lars’s chat');
    assert.equal(e.bot(lars.id).role, (await e.t.api('GET', `/agents/${lars.id}`)).role);
    assert.notEqual(e.bot(lars.id).role, 'Iets anders');
    // Its own team stays its own.
    const own = await e.run(main.id, { method: 'PATCH', path: `/agents/${kim.id}`, body: { role: 'Planner' } });
    assert.equal(own.isError ?? false, false, own.text);
    assert.equal(e.bot(kim.id).role, 'Planner');

    // The owner gives it back: everything again.
    await e.t.api('PUT', `/teams/${other.id}/access/${main.id}`, { level: 'direct' });
    assert.equal(reachOf(e.ctx, e.svc, e.bot(main.id)), null);
    assert.match((await e.run(main.id, { method: 'GET', path: '/memory/dossiers' })).text, /Jaarstukken/);
  } finally {
    await e.t.close();
  }
});

test('memory through teambot_do: a bot writes only its own team’s dossiers and knowledge, also where it may aansturen; all of memory at once is the owner’s', async () => {
  const e = await setup();
  try {
    const { kim, lars, home, other } = await e.teams();
    // Kim may aansturen Boekhouding: she may change its bots and routines, not write its memory.
    await e.t.api('PUT', `/teams/${other.id}/access/${kim.id}`, { level: 'direct' });
    const theirs = (await e.t.api('POST', '/memory/dossiers', { title: 'Jaarrekening', teamId: other.id })).dossier;
    const ours = (await e.t.api('POST', '/memory/dossiers', { title: 'Klant Jansen', teamId: home.id })).dossier;
    const mem = e.ctx.services.memory.svc;
    const wall = /^Geweigerd door TeamBot: dit hoort bij team “Boekhouding”, en Kim mag daar alleen meelezen, niet schrijven\./;
    for (const args of [
      { method: 'PATCH', path: `/memory/dossiers/${theirs.id}`, body: { title: 'Van Kim' } },
      { method: 'POST', path: `/memory/dossiers/${theirs.id}/records`, body: { kind: 'event', title: 'Gezien' } },
      { method: 'POST', path: `/memory/dossiers/${theirs.id}/forget` },
      { method: 'POST', path: '/memory/items', body: { scope: 'shared', teamId: other.id, content: 'De btw gaat omhoog.' } },
      { method: 'POST', path: '/memory/items', body: { scope: 'dossier', dossierId: theirs.id, content: 'Deadline 1 juni.' } },
      { method: 'POST', path: '/memory/dossiers', body: { title: 'Nieuw bij Boekhouding', teamId: other.id } },
    ]) {
      assert.match(e.refused(kim.id, args) || '', wall, `${args.method} ${args.path}`);
      assert.equal((await e.run(kim.id, args)).isError, true, `${args.method} ${args.path}: also when the owner asked`);
    }
    assert.equal(e.ctx.store.get<any>('memory_dossiers', theirs.id).title, 'Jaarrekening');
    // "Alle teams" is the owner's.
    assert.match(e.refused(kim.id, { method: 'POST', path: '/memory/items', body: { scope: 'shared', teamId: '*', content: 'Voor iedereen.' } }) || '', /dit geldt voor alle teams/);

    // In her own team she writes; without a team named it is her own team, not the default team.
    assert.equal((await e.run(kim.id, { method: 'PATCH', path: `/memory/dossiers/${ours.id}`, body: { title: 'Klant Jansen BV' } })).isError ?? false, false);
    const lars1 = await e.run(lars.id, { method: 'POST', path: '/memory/items', body: { scope: 'shared', content: 'Facturen gaan op vrijdag de deur uit.' } });
    assert.equal(lars1.isError ?? false, false, lars1.text);
    const note = e.ctx.store.one<any>("SELECT * FROM memory_items WHERE scope = 'shared' AND status != 'forgotten' ORDER BY created_at DESC LIMIT 1");
    assert.equal(mem.itemTeam(note), other.id, 'Lars’s knowledge is Boekhouding’s, not the default team’s');
    const dossier = await e.run(lars.id, { method: 'POST', path: '/memory/dossiers', body: { title: 'Leverancier Pietersen' } });
    assert.equal(dossier.isError ?? false, false, dossier.text);
    assert.equal(mem.resolveTeam(e.userId, e.ctx.store.one<any>("SELECT team_id FROM memory_dossiers WHERE title = 'Leverancier Pietersen'").team_id), other.id);
    // Memory of the default team is a team's like any other: Lars cannot look into it.
    assert.match(e.refused(lars.id, { method: 'GET', path: `/memory/dossiers/${ours.id}` }) || '', /geen toegang/);

    // All of memory at once: never through a bot when it cannot be kept to its own team.
    for (const [path, body] of [
      ['/memory/delete-all', { confirm: 'WISSEN' }],
      ['/memory/trash/empty', {}],
      ['/memory/consolidate', {}],
      ['/memory/maintenance', {}],
    ] as const) assert.match(e.refused(kim.id, { method: 'POST', path, body }) || '', /gaat over het geheugen van alle teams; dat doet alleen je eigenaar zelf/, path);
    // An import into its own team: only when the owner himself asked, in a chain he began; not on a card.
    const imp = { method: 'POST', path: '/memory/import', body: { text: 'Wij leveren op dinsdag.\nDe winkel sluit om 17:00.', scope: 'shared' } };
    assert.equal(e.refused(kim.id, imp), null);
    const byRoutine = await e.run(kim.id, imp, 'routine');
    assert.match(byRoutine.text, /^Geweigerd door TeamBot: dit gaat over het geheugen als geheel/);
    assert.equal((await e.pending()).length, 0, 'no card');
    assert.match(e.refused(kim.id, { ...imp, body: { text: 'x', scope: 'about_you' } }) || '', /niet in "Over jou"/);
    const done = await e.run(kim.id, imp, 'owner');
    assert.equal(done.isError ?? false, false, done.text);
    const imported = e.ctx.store.all<any>("SELECT * FROM memory_items WHERE scope = 'shared' AND status != 'forgotten'").filter((x) => /dinsdag|17:00/.test(mem.contentOf(x)));
    assert.ok(imported.length && imported.every((x) => mem.itemTeam(x) === home.id), 'in Kim’s own team');
  } finally {
    await e.t.close();
  }
});

test('a bot named by its name or role, an id inside another id, an id as a key: the same wall as a plain id', async () => {
  const e = await setup();
  try {
    const { kim, rik, lars, other } = await e.teams();
    await e.t.api('PATCH', `/agents/${lars.id}`, { role: 'Boekhouder' });
    const larsThread = e.ctx.chat.threadForAgent(e.userId, lars.id);
    const larsRun = e.ctx.store.createRun({ thread_id: larsThread.id, agent_id: lars.id, user_id: e.userId, status: 'error', trigger: 'user', input_message_id: null });
    const closed = /^Geweigerd door TeamBot: dit hoort bij een team waar Kim geen toegang toe heeft\./;
    for (const args of [
      { method: 'GET', path: '/usage/estimate', query: { agentId: 'Lars' } },
      { method: 'POST', path: '/rooms/tasks', body: { title: 'Btw-aangifte', owner: 'Lars' } },
      { method: 'POST', path: '/rooms/tasks', body: { title: 'Btw-aangifte', owner: 'Boekhouder' } },
      { method: 'POST', path: '/workflows', body: { name: 'Maandwerk', steps: [{ kind: 'bot', bot: 'lars', prompt: 'Sluit de maand af.' }] } },
      { method: 'POST', path: '/proactive/projects', body: { naam: 'Nieuwe site', eigenaar: 'Lars' } },
      { method: 'GET', path: '/teamdata/log', query: { agent: 'Lars' } },
      { method: 'POST', path: '/voice/calls/vc_0123456789abcdef/tool', body: { name: 'ask_bot', args: { bot: 'lar' } } },
      // An id inside another: a team's task "<team>:3", a run "run:<id>".
      { method: 'PATCH', path: `/teamdata/tasks/${other.id}:3`, body: { status: 'klaar' } },
      { method: 'POST', path: '/teams/stuck/retry', body: { messageId: 'x', ref: `run:${larsRun.id}` } },
      // An id as the key of a map: the owner's notification choice per bot.
      { method: 'PUT', path: '/notifications/prefs', body: { bots: { [lars.id]: 'none' } } },
    ]) assert.match(e.refused(kim.id, args) || '', closed, `${args.method} ${args.path} ${JSON.stringify(args.body || args.query)}`);
    // The same by name for a bot of her own team goes through.
    for (const args of [
      { method: 'GET', path: '/usage/estimate', query: { agentId: 'Rik' } },
      { method: 'POST', path: '/rooms/tasks', body: { title: 'Nieuwsbrief', owner: 'Rik' } },
      { method: 'PUT', path: '/notifications/prefs', body: { bots: { [rik.id]: 'none' } } },
    ]) assert.equal(e.refused(kim.id, args), null, `${args.method} ${args.path}`);
    // A workflow step by name becomes the bot's id (what the engine would have picked by that name).
    const wf = await e.run(kim.id, { method: 'POST', path: '/workflows', body: { name: 'Week', steps: [{ kind: 'bot', bot: 'Rik', prompt: 'Schrijf de nieuwsbrief.' }] } });
    assert.equal(wf.isError ?? false, false, wf.text);
    assert.match(wf.text, new RegExp(`"agentId": "${rik.id}"`));
  } finally {
    await e.t.close();
  }
});

test('totals over all teams: a bot that cannot look into every team gets its own teams’ numbers, the answer without the totals, or a plain refusal', async () => {
  const e = await setup();
  try {
    const { kim, lars, home, other } = await e.teams();
    const spend = (agentId: string, cost: number) =>
      e.ctx.store.exec('INSERT INTO usage_log (user_id, agent_id, provider_id, model, input, output, cost, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', e.userId, agentId, e.t.providerId, 'mock-1', 100, 50, cost, new Date().toISOString());
    spend(kim.id, 1);
    spend(lars.id, 7);
    const json = async (who: string, path: string, query?: any) => {
      const out = await e.run(who, { method: 'GET', path, query });
      assert.equal(out.isError ?? false, false, `${path}: ${out.text}`);
      return JSON.parse(out.text.slice(out.text.indexOf('\n') + 1));
    };
    const usage = await json(kim.id, '/usage');
    assert.deepEqual([usage.byDay, usage.byModel, usage.today?.spent], [undefined, undefined, undefined], 'no sums over all teams');
    assert.deepEqual(usage.byAgent.map((x: any) => [x.name, x.cost]), [['Kim', 1]]);
    assert.match(usage.alleenEigenaar, /alleen de eigenaar/);
    assert.equal((await json(kim.id, '/usage/breakdown')).total.today.cost, 1, 'the total of the bots Kim may look into');
    assert.ok((await json(kim.id, '/usage/limits')).engines.every((x: any) => x.spend === undefined));
    assert.equal((await json(kim.id, '/system')).stats.agents, 3, 'Baas, Kim and Rik; not Lars');
    assert.equal((await json(kim.id, '/memory/overview')).byScope, undefined);
    assert.equal((await json(kim.id, '/power')).reason, undefined);
    assert.match(e.refused(kim.id, { method: 'GET', path: '/proactive/briefing' }) || '', /gaat over alle teams samen/);
    const reach = reachOf(e.ctx, e.svc, e.bot(kim.id))!;
    for (const [route, key] of [['/routines/runs/summary', 'teamId'], ['/teamdata/summary', 'team'], ['/proactive/kansen', 'team']] as const)
      assert.equal(new URLSearchParams((reach.check({ method: 'GET', path: route, query: '', body: undefined, route }) as any).query).get(key), home.id, route);

    // The owner gives Kim meekijken on Boekhouding: she may look into every team, so the totals are hers to see.
    await e.t.api('PUT', `/teams/${other.id}/access/${kim.id}`, { level: 'read' });
    assert.equal((await json(kim.id, '/usage/breakdown')).total.today.cost, 8);
    assert.equal((await json(kim.id, '/usage')).today.spent, 8);
    // Lars still cannot look into the default team.
    assert.equal((await json(lars.id, '/usage/breakdown')).total.today.cost, 7);
  } finally {
    await e.t.close();
  }
});

test('what belongs to no team: every bot may look, but a workflow that sets a bot of a closed team to work is not its to change or start; a key of another team is hidden under any field name', async () => {
  const e = await setup();
  try {
    const { kim, rik, lars, other } = await e.teams();
    // A workflow of the owner with a step for Lars, and one Kim may run (only Rik).
    const theirs = (await e.t.api('POST', '/workflows', { name: 'Maandafsluiting', steps: [{ kind: 'bot', agentId: lars.id, prompt: 'Sluit de maand af.' }] })).workflow ?? null;
    const list = async () => (await e.t.api('GET', '/workflows')).workflows as any[];
    const wfTheirs = theirs || (await list()).find((w) => w.name === 'Maandafsluiting');
    const wfOurs = (await e.t.api('POST', '/workflows', { name: 'Nieuwsbrief', steps: [{ kind: 'bot', agentId: rik.id, prompt: 'Schrijf de nieuwsbrief.' }] })).workflow ?? (await list()).find((w) => w.name === 'Nieuwsbrief');
    const seen = await e.run(kim.id, { method: 'GET', path: '/workflows' });
    assert.equal(seen.isError ?? false, false);
    assert.match(seen.text, /Maandafsluiting/, 'a workflow is of no team: Kim may look');
    assert.ok(!seen.text.includes(lars.id), 'but not at the step of a team she cannot look into');
    for (const args of [
      { method: 'POST', path: `/workflows/${wfTheirs.id}/run`, body: {} },
      { method: 'PATCH', path: `/workflows/${wfTheirs.id}`, body: { name: 'Van Kim' } },
      { method: 'DELETE', path: `/workflows/${wfTheirs.id}` },
    ]) assert.match(e.refused(kim.id, args) || '', /deze workflow zet ook een bot aan het werk van een team dat Kim niet aanstuurt/, `${args.method} ${args.path}`);
    assert.equal(e.refused(kim.id, { method: 'POST', path: `/workflows/${wfOurs.id}/run`, body: {} }), null);
    // The memory's blocks and reports say what was forgotten or tidied in every team.
    assert.match(e.refused(kim.id, { method: 'GET', path: '/memory/blocks' }) || '', /gaat over alle teams samen/);

    // A key for Boekhouding only: hidden from Kim whatever the field that names it.
    const key = await e.t.api('POST', '/providers', { kind: 'mock', name: 'AI van Boekhouding' });
    await e.t.api('PUT', `/teams/keys/provider/${key.id}`, { teamId: other.id });
    const reach = reachOf(e.ctx, e.svc, e.bot(kim.id))!;
    assert.deepEqual(reach.filter([{ providerId: key.id, model: 'm' }, { providerId: e.t.providerId, model: 'm' }]), [{ providerId: e.t.providerId, model: 'm' }]);
    assert.deepEqual(reach.filter({ id: kim.id, name: 'Kim', provider_id: key.id }), { id: kim.id, name: 'Kim', provider_id: '[sleutel van een ander team]' }, 'a bot that uses it stays; which key is not said');
  } finally {
    await e.t.close();
  }
});

test('a full list of bots (an app, a skill, a shared browser profile): a bot that sends its own team’s list does not take it away from the bots of teams it cannot see', async () => {
  const e = await setup();
  try {
    const { kim, rik, lars } = await e.teams();
    // An app for all teams, used by Kim and Lars.
    const app = await e.t.api('POST', '/mcp/connections', { catalog_id: 'custom', name: 'Agenda', transport: 'stdio', command: process.execPath, args: ['-e', '0'], cwd: process.cwd(), trust_command: true, agentIds: [kim.id, lars.id] });
    const bound = () => e.ctx.store.all<any>('SELECT agent_id FROM mcp_bindings WHERE connection_id = ?', app.id).map((x) => x.agent_id).sort();
    assert.deepEqual(bound(), [kim.id, lars.id].sort());
    // A skill for all teams, on Kim and Lars.
    const lib = e.ctx.services.skills.library;
    const files = new Map([['SKILL.md', Buffer.from('---\nname: offerte\ndescription: Maakt een offerte\n---\nSchrijf een offerte.\n', 'utf8')]]);
    const { analyze } = await import('../server/modules/skills/library.js');
    const skill = lib.create(e.userId, files, analyze(files, 'offerte'), { source: { type: 'paste' }, createdBy: 'test' });
    e.ctx.store.exec("UPDATE skills SET install_scope = 'user', team_id = NULL, status = 'active' WHERE id = ?", skill.id);
    await e.t.api('PUT', `/skills/${skill.id}/agents`, { agentIds: [kim.id, lars.id] });
    const holders = () => e.ctx.store.agents(e.userId).filter((a) => lib.enabledFor(a).some((s: any) => s.id === skill.id)).map((a) => a.id).sort();
    assert.deepEqual(holders(), [kim.id, lars.id].sort());

    // Kim sends the list of her own team: Rik on, herself on. Lars, whom she cannot see, keeps both.
    for (const [path, body] of [
      [`/mcp/connections/${app.id}/agents`, { agentIds: [kim.id, rik.id] }],
      [`/skills/${skill.id}/agents`, { agentIds: [kim.id, rik.id] }],
    ] as const) {
      const out = await e.run(kim.id, { method: 'PUT', path, body });
      assert.equal(out.isError ?? false, false, `${path}: ${out.text}`);
      assert.ok(!out.text.includes(lars.id), `${path}: Lars is not shown to Kim`);
    }
    assert.deepEqual(bound(), [kim.id, rik.id, lars.id].sort());
    assert.deepEqual(holders(), [kim.id, rik.id, lars.id].sort());
    // Taking someone off in her own team still works.
    await e.run(kim.id, { method: 'PUT', path: `/skills/${skill.id}/agents`, body: { agentIds: [kim.id] } });
    assert.deepEqual(holders(), [kim.id, lars.id].sort());
    // A shared browser profile (its logins) the same way.
    const profile = await e.t.api('POST', '/computers/profiles', { name: 'Webwinkel' });
    await e.t.api('PUT', `/computers/profiles/${profile.id}/members`, { agent_ids: [kim.id, lars.id] });
    const members = async () => ((await e.t.api('GET', '/computers/profiles')) as any[]).find((p) => p.id === profile.id).members.sort();
    assert.deepEqual(await members(), [kim.id, lars.id].sort());
    assert.equal((await e.run(kim.id, { method: 'PUT', path: `/computers/profiles/${profile.id}/members`, body: { agent_ids: [rik.id] } })).isError ?? false, false);
    assert.deepEqual(await members(), [rik.id, lars.id].sort());
    // Naming Lars herself is a change in a team she cannot see: refused.
    assert.match(e.refused(kim.id, { method: 'PUT', path: `/mcp/connections/${app.id}/agents`, body: { agentIds: [kim.id] } }) || 'ok', /^ok$/);
    assert.match(e.refused(kim.id, { method: 'PUT', path: `/skills/${skill.id}/agents`, body: { agentIds: [lars.id] } }) || '', /geen toegang/);
  } finally {
    await e.t.close();
  }
});

test('no team named is the bot’s own team, not the default team: team data, projects, folders, skills, chat folders, departments', async () => {
  const e = await setup();
  try {
    const { lars, home, other } = await e.teams();
    const reach = reachOf(e.ctx, e.svc, e.bot(lars.id))!;
    const check = (method: string, route: string, o: { path?: string; query?: Record<string, string>; body?: any } = {}) =>
      reach.check({ method, path: o.path || route, query: new URLSearchParams(o.query || {}).toString(), body: o.body, route }) as any;
    const q = (x: any, k: string) => new URLSearchParams(x.query).get(k);
    assert.equal(q(check('GET', '/teamdata/tasks'), 'team'), other.id);
    assert.equal(q(check('GET', '/teamdata/tables', { query: { team: 'all' } }), 'team'), other.id, '"all" falls back to the default team there');
    assert.equal(q(check('GET', '/teamdata/log', { query: { agent: 'Lars' } }), 'team'), other.id);
    assert.equal(check('POST', '/teamdata/import', { body: { rows: [] } }).body.teamId, other.id);
    assert.equal(check('PATCH', '/teamdata/tasks/:id', { path: `/teamdata/tasks/${other.id}:2`, body: { status: 'klaar' } }).body.teamId, undefined, 'the team is in the id itself');
    assert.equal(check('POST', '/proactive/projects', { body: { naam: 'Site' } }).body.teamId, other.id);
    assert.equal(check('POST', '/proactive/kansen/:id/decide', { path: '/proactive/kansen/3/decide', body: { besluit: 'ja' } }).body.teamId, other.id);
    assert.equal(q(check('GET', '/folders/roots'), 'teamId'), other.id);
    assert.equal(q(check('GET', '/folders/browse', { query: { agentId: lars.id } }), 'teamId'), null, 'a bot named: its folders');
    assert.equal(check('PUT', '/folders/team', { body: { path: 'C:/Boekhouding' } }).body.teamId, other.id);
    assert.equal(q(check('DELETE', '/folders/team'), 'teamId'), other.id);
    assert.equal(check('POST', '/skills/import/zip', { body: { name: 'x.zip' } }).body.teamId, other.id);
    assert.match(check('POST', '/skills/curated/install', { body: { teamId: '*' } }).no, /iets voor alle teams regelt alleen de eigenaar/);
    assert.match(check('PATCH', '/skills/:id', { path: '/skills/sk_0123456789abcdef', body: { teamId: null } }).no, /vaardigheid voor alle teams/);
    // A team named outright is walled like any id.
    assert.match(check('GET', '/teamdata/tables', { query: { team: home.id } }).no, /geen toegang/);

    // Through teambot_do: a chat folder and a department land in Lars's own team.
    assert.equal((await e.run(lars.id, { method: 'GET', path: '/teamdata/tables' })).isError ?? false, false);
    const f = await e.run(lars.id, { method: 'POST', path: '/chat-folders', body: { name: 'Lopend' } });
    assert.equal(f.isError ?? false, false, f.text);
    assert.equal((await e.t.api('GET', '/chat-folders')).folders.find((x: any) => x.name === 'Lopend').teamId, other.id);
    const d = await e.run(lars.id, { method: 'POST', path: '/rooms/teams', body: { name: 'Afdeling Inkoop' } });
    assert.equal(d.isError ?? false, false, d.text);
    assert.equal(e.ctx.store.one<any>("SELECT workspace_id FROM room_teams WHERE name = 'Afdeling Inkoop'").workspace_id, other.id);
  } finally {
    await e.t.close();
  }
});

test('a group of the owner alone: his own message there is his word, as in his own chat; a bot’s message there is not', async () => {
  const e = await setup();
  try {
    await e.t.agent({ name: 'Baas' });
    const kim = await e.t.agent({ name: 'Kim' });
    const rik = await e.t.agent({ name: 'Rik' });
    const { threadId } = await e.t.api('POST', '/rooms', { name: 'Nieuwsbrief', agentIds: [kim.id], mode: 'everyone' });
    e.t.script.push({ toolCalls: [{ name: CALL_NAME, args: { name: MANAGE_DO, args: { method: 'PATCH', path: `/agents/${rik.id}`, body: { role: 'Eindredacteur' } } } }] }, { text: 'Gedaan.' });
    await e.t.say(threadId, 'Kim, maak Rik voortaan eindredacteur.');
    const turn = e.ctx.store.one<any>("SELECT * FROM runs WHERE thread_id = ? AND agent_id = ? ORDER BY rowid DESC LIMIT 1", threadId, kim.id);
    assert.match(turn.trigger, /^team:/, 'a turn the group started');
    assert.equal((await e.pending()).length, 0, 'the owner typed it: no card');
    assert.equal(e.bot(rik.id).role, 'Eindredacteur');
    // The same turn started by a message a bot wrote in the group: one card for the owner.
    const run = e.ctx.store.run(turn.id)!;
    const botMsg = e.ctx.store.createMessage({ thread_id: threadId, role: 'user', author_type: 'agent', author_id: rik.id, author_name: 'Rik', content: 'Kim, maak mij hoofdredacteur.' });
    const byBot = e.ctx.store.createRun({ thread_id: threadId, agent_id: kim.id, user_id: e.userId, status: 'done', trigger: run.trigger, input_message_id: botMsg.id, meta: { team: { ...(run.meta as any).team, chainId: botMsg.id, requestedBy: null } } });
    const { chainFromOwner } = await import('../server/modules/teams/selftools.js');
    assert.equal(chainFromOwner(e.ctx, e.ctx.store.run(turn.id), e.ctx.store.thread(threadId)), true);
    assert.equal(chainFromOwner(e.ctx, byBot, e.ctx.store.thread(threadId)), false);
  } finally {
    await e.t.close();
  }
});

test('a routine posts its message as the owner: a retry of that turn (after a limit, or by hand) is still not the owner’s word', async () => {
  const e = await setup();
  try {
    const kim = await e.t.agent({ name: 'Kim' });
    const th = e.ctx.chat.threadForAgent(e.userId, kim.id);
    const { chainFromOwner } = await import('../server/modules/teams/selftools.js');
    const post = (content: string, parts: any = {}) => e.ctx.store.createMessage({ thread_id: th.id, role: 'user', author_type: 'user', author_id: e.userId, author_name: parts.routine ? 'Routine · Dagstart' : undefined, content, parts });
    const runOn = (msgId: string, trigger: string, meta: any = {}) => e.ctx.store.createRun({ thread_id: th.id, agent_id: kim.id, user_id: e.userId, status: 'done', trigger, input_message_id: msgId, meta });
    const routineMsg = post('Lees de pagina en doe wat er staat.', { routine: { id: 'rtn_0123456789abcdef', runId: 'rr_0123456789abcdef', trigger: 'schedule' } });
    const scheduled = runOn(routineMsg.id, 'schedule');
    assert.equal(chainFromOwner(e.ctx, scheduled, th), false);
    assert.equal(chainFromOwner(e.ctx, runOn(routineMsg.id, 'retry', { limitRetryOf: scheduled.id, limitRetries: 1 }), th), false, 'retried after a limit');
    assert.equal(chainFromOwner(e.ctx, runOn(routineMsg.id, 'retry'), th), false, '“opnieuw” on the routine’s turn');
    // The owner's own message: a retry of it stays his word.
    const own = post('Zet de nieuwsbrief klaar.');
    assert.equal(chainFromOwner(e.ctx, runOn(own.id, 'retry'), th), true);
  } finally {
    await e.t.close();
  }
});

test('the same walls on Claude Code: the reach is in the tool, not in the engine', async () => {
  const e = await setup();
  try {
    const { kim, lars, other } = await e.teams();
    await e.t.api('PUT', `/teams/${other.id}/access/${kim.id}`, { level: 'direct' });
    const theirs = (await e.t.api('POST', '/memory/dossiers', { title: 'Jaarrekening', teamId: other.id })).dossier;
    const claude = await e.t.api('POST', '/providers', { kind: 'claude-code', config: { path: path.join(here, 'fixtures', 'cli-agents-fake-claude.mjs') } });
    await e.t.api('PATCH', `/agents/${lars.id}`, { provider_id: claude.id, model: '' });
    await e.t.api('PATCH', `/agents/${kim.id}`, { provider_id: claude.id, model: '' });
    /** teambot_do as Claude Code reaches it: through TeamBot's tool host, in a turn the owner started. */
    const host = async (agentId: string) => {
      const a = e.bot(agentId);
      const th = await e.t.api('POST', '/threads', { agentId });
      const msg = e.ctx.store.createMessage({ thread_id: th.id, role: 'user', author_type: 'user', author_id: e.userId, content: 'Doe dit voor mij.' });
      const turn = e.ctx.store.createRun({ thread_id: th.id, agent_id: a.id, user_id: a.user_id, status: 'running', trigger: 'user', input_message_id: msg.id, meta: {} });
      const scope = makeScope(e.ctx, e.ctx.providers.config(claude.id)!, { model: '', system: '', prompt: 'hoi', attachments: [], workspace: a.workspace, accessMode: a.access_mode, agentId: a.id, threadId: th.id, runId: turn.id, userId: a.user_id }, new AbortController().signal, () => {});
      const tools = teambotTools(scope, { engine: 'claude' });
      return async (args: any) => {
        const r = await tools.call(CALL_NAME, { name: MANAGE_DO, args }, new AbortController().signal);
        return { isError: !!r.isError, text: String(r.content?.[0]?.text || '') };
      };
    };
    const kimDo = await host(kim.id);
    const wrote = await kimDo({ method: 'PATCH', path: `/memory/dossiers/${theirs.id}`, body: { title: 'Van Kim' } });
    assert.equal(wrote.isError, true);
    assert.match(wrote.text, /Kim mag daar alleen meelezen, niet schrijven/);
    const larsDo = await host(lars.id);
    const made = await larsDo({ method: 'POST', path: '/agents', body: { name: 'Via Claude' } });
    assert.equal(made.isError, false, made.text);
    assert.equal(e.ctx.services.teams.teamOf(e.ctx.store.agents(e.userId).find((a) => a.name === 'Via Claude')!.id), other.id);
    assert.match((await larsDo({ method: 'GET', path: '/proactive/briefing' })).text, /gaat over alle teams samen/);
  } finally {
    await e.t.close();
  }
});

test('a bot that makes a bot: it lands in its own team, never in a team it may not aansturen, also through an import or a copy', async () => {
  const e = await setup();
  try {
    const { kim, rik, lars, home, other } = await e.teams();
    const byName = (name: string) => e.ctx.store.agents(e.userId).find((a) => a.name === name);
    const teamOf = (name: string) => e.ctx.services.teams.teamOf(byName(name)!.id);
    assert.equal(e.ctx.services.teams.defaultTeam(e.userId).id, home.id, 'the first team is the default team');

    // Lars (Boekhouding) makes bots: they land in Boekhouding, not in the default team he cannot look into.
    for (const [path, body, name, asks] of [
      ['/agents', { name: 'Nieuw' }, 'Nieuw', false],
      // An imported bot brings its own access: the owner says Ja first.
      ['/agents/import', { format: 'teambot.agent/v1', name: 'Uit sjabloon' }, 'Uit sjabloon', true],
      ['/import/agents', { agents: [{ format: 'teambot.agent/v1', name: 'Uit lijst' }] }, 'Uit lijst', true],
    ] as const) {
      const out = asks ? await e.runAsked(lars.id, { method: 'POST', path, body }) : await e.run(lars.id, { method: 'POST', path, body });
      assert.equal(out.isError ?? false, false, `${path}: ${out.text}`);
      assert.equal(teamOf(name), other.id, `${path}: in Lars's own team`);
    }
    // A team he may not aansturen: refused before any card, with what would work.
    const elsewhere = { method: 'POST', path: '/agents', body: { name: 'Elders', settings: { homeTeam: home.id } } };
    assert.match(e.refused(lars.id, elsewhere) || '', /^Geweigerd door TeamBot: Lars maakt alleen bots in zijn eigen team of in een team dat hij aanstuurt\. Laat het team weg/);
    assert.equal((await e.run(lars.id, elsewhere)).isError, true);
    assert.equal(byName('Elders'), undefined);
    // A copy lands where its source was made for (here the default team): Lars may not aansturen that team.
    const copy = { method: 'POST', path: `/agents/${lars.id}/duplicate` };
    assert.match(e.refused(lars.id, copy) || '', /^Geweigerd door TeamBot: een kopie van deze bot komt in een team dat Lars niet aanstuurt[^.]*\. Maak de bot met POST \/agents/);
    assert.equal(byName('Lars (kopie)'), undefined);
    // A team package and a hire proposal land in the default team too: refused for Lars.
    assert.match(e.refused(lars.id, { method: 'POST', path: '/rooms/packages/install', body: { templateId: 'x' } }) || '', /^Geweigerd door TeamBot: een team uit een pakket komt in een team dat Lars niet aanstuurt/);
    // A skills install says its team in teamId: Lars's own team when he names none, never "alle teams".
    const reach = reachOf(e.ctx, e.svc, e.bot(lars.id))!;
    const install = (body: any) => reach.check({ method: 'POST', path: '/skills/templates/install', query: '', body, route: '/skills/templates/install' }) as any;
    assert.equal(install({ template: { name: 'T' } }).body.teamId, other.id);
    assert.match(install({ teamId: '*' }).no, /iets voor alle teams installeert alleen de eigenaar/);
    assert.ok(install({ teamId: home.id }).no);

    // Kim (the default team) copies Rik: the copy stays in her team.
    const out = await e.run(kim.id, { method: 'POST', path: `/agents/${rik.id}/duplicate` });
    assert.equal(out.isError ?? false, false, out.text);
    assert.equal(teamOf('Rik (kopie)'), home.id);
    // With aansturen on Boekhouding, Kim may make a bot there by naming it.
    await e.t.api('PUT', `/teams/${other.id}/access/${kim.id}`, { level: 'direct' });
    assert.equal((await e.run(kim.id, { method: 'POST', path: '/agents', body: { name: 'Voor Boekhouding', settings: { homeTeam: other.id } } })).isError ?? false, false);
    assert.equal(teamOf('Voor Boekhouding'), other.id);
  } finally {
    await e.t.close();
  }
});
