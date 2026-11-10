/**
 * Teams isolation (0.4, package B): two teams, each with a bot, a folder and a team-only key. A bot of team A without
 * access must not be able to read or write team B's folder, run on B's team-only key, use B's team-only app or login,
 * or give work to B's bots — the probes below actively try each of those through the real tool loop. With meekijken
 * (read) it reads but never writes; with aansturen (direct) it gives B's lead a task. A shared key works in both.
 *
 * Package C adds the organisation: team A also has a leader (aansturen on B), a bot with meekijken on B and the main bot
 * (aansturen on every team); A's bot may never get around B's wall by giving work to one of them.
 *
 * Extending (wave 2): add a probe to PROBES for every new way team data can be reached (memory, dossiers, channels,
 * skills, routines, budget, search). A probe gets the scenario and the bot that tries, and resolves to true when it
 * succeeded in reaching team B. Each probe runs once without access (must fail), once with meekijken and once with
 * aansturen, and states what it expects there (`read` / `direct`): 'blocked' | 'allowed'.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestApp, type TestApp } from './helpers.js';
import { startFakeOllama, type FakeOllama } from './memory-fake-ollama.js';
import { agentRootList, extraRootsOf, resolveInWorkspace } from '../server/tools/builtin/files.js';
import { createApp } from '../server/app.js';
import { modules as allModules } from '../server/modules/index.js';
import { analyze as analyzeSkill } from '../server/modules/skills/library.js';

interface Side {
  team: any;
  bot: any;
  folder: string;
  /** Provider (AI key) that is "alleen dit team". */
  key: string;
}
interface Scenario {
  t: TestApp;
  A: Side;
  B: Side & { lead: any; helper: any };
  root: string;
  /** Team B's data for the wave-2 probes (seedB): its database rows, a group, a chat and a routine. */
  b2?: { groupId: string; groupThread: string };
  /** Team B's memory (made by the first memory probe): see memB. */
  mem?: MemB;
  ollama?: FakeOllama;
  /** Package B4: a channel per team, team B's skills and a routine of A (seedB4). */
  b4?: B4;
}

/** Team B's memory: shared knowledge (also one only findable by meaning), a dossier with a document, a rule, a summary. */
interface MemB {
  shared: any;
  meaning: any;
  dossier: any;
  rule: any;
  episodeRef: string;
}

const SECRET_B = 'Klantenlijst van B: alleen voor team B';

async function scenario(): Promise<Scenario> {
  const t = await startTestApp();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-teams-'));
  const fa = path.join(root, 'TeamA');
  const fb = path.join(root, 'TeamB');
  fs.mkdirSync(fa, { recursive: true });
  fs.mkdirSync(fb, { recursive: true });
  fs.writeFileSync(path.join(fa, 'a.md'), 'Notities van A\n');
  fs.writeFileSync(path.join(fb, 'klanten.md'), SECRET_B + '\n');

  // Memory learns with the fixed patterns here (no learning model in this test).
  await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
  // The first bot makes the default team ("Mijn team"); it becomes team A.
  const ada = await t.agent({ name: 'Ada', tool_groups: ['files', 'team', 'memory'] });
  const teams = await t.api('GET', '/teams');
  assert.equal(teams.length, 1);
  const teamA = await t.api('PATCH', `/teams/${teams[0].id}`, { name: 'Team A', profile: { company: 'Bedrijf A', about: 'Verkoopt fietsen.' } });
  const teamB0 = await t.api('POST', '/teams', { name: 'Team B', color: '#ef4444', profile: { company: 'Bedrijf B', rules: 'Noem nooit prijzen.' } });
  const bo = await t.agent({ name: 'Bo', tool_groups: ['files', 'team', 'memory'], settings: { homeTeam: teamB0.id } });
  const kim = await t.agent({ name: 'Kim', tool_groups: ['files', 'team', 'memory'], settings: { homeTeam: teamB0.id } });
  const teamB = await t.api('PATCH', `/teams/${teamB0.id}`, { leadAgentId: bo.id });
  assert.equal(teamB.leadName, 'Bo');
  assert.deepEqual(teamB.bots.map((b: any) => b.name).sort(), ['Bo', 'Kim']);

  await t.api('PUT', '/folders/team', { teamId: teamA.id, path: fa });
  await t.api('PUT', '/folders/team', { teamId: teamB.id, path: fb });

  const keyA = await t.api('POST', '/providers', { kind: 'mock', name: 'Sleutel A' });
  const keyB = await t.api('POST', '/providers', { kind: 'mock', name: 'Sleutel B' });
  await t.api('PUT', `/teams/keys/provider/${keyA.id}`, { teamId: teamA.id });
  await t.api('PUT', `/teams/keys/provider/${keyB.id}`, { teamId: teamB.id });

  // Package C: bots of team A that reach further than Ada (a leader with aansturen on B, a bot with meekijken on B) and
  // the main bot (aansturen on every team). Ada may never get around B's wall through them.
  const leo = await t.agent({ name: 'Leo', tool_groups: ['files', 'team'] });
  const mia = await t.agent({ name: 'Mia', tool_groups: ['files', 'team'] });
  await t.api('PUT', `/teams/${teamB.id}/access/${leo.id}`, { level: 'direct' });
  await t.api('PUT', `/teams/${teamB.id}/access/${mia.id}`, { level: 'read' });
  const { token } = await t.api('POST', '/teams/main/intent', {});
  const max = await t.agent({ name: 'Max', tool_groups: ['files', 'team'], settings: { mainBot: token } });
  assert.equal((await t.api('GET', '/teams/main')).main?.id, max.id);
  return { t, root, A: { team: teamA, bot: ada, folder: fa, key: keyA.id }, B: { team: teamB, bot: bo, lead: bo, helper: kim, folder: fb, key: keyB.id } };
}

async function done(s: Scenario) {
  await s.t.close();
  await s.ollama?.close();
  fs.rmSync(s.root, { recursive: true, force: true });
}

const MEM = {
  shared: 'Webshop B levert alleen in België',
  meaning: 'Team B rijdt in een Volvo',
  doc: 'Het contract met Zwaluw loopt tot december en de korting is twaalf procent.',
  rule: 'Regel van team B: noem nooit de levertijd',
  episode: 'Gesprek over de offerte voor Pelikaan, besproken met de klant',
};

/**
 * Team B's memory, made once by the owner (and B's own bot), with search by meaning on (a fake local Ollama): shared
 * knowledge, a fact only findable by meaning ("wagen" → Volvo), a dossier with a document, a team rule and a
 * conversation summary of a conversation A also took part in (a group), which belongs to team B.
 */
async function memB(s: Scenario): Promise<MemB> {
  if (s.mem) return s.mem;
  const { t } = s;
  s.ollama = await startFakeOllama();
  t.app.ctx.providers.create(t.app.ctx.auth.owner()!.id, { kind: 'ollama', base_url: `${s.ollama.url}/v1` });
  const teamB = s.B.team.id;
  const shared = (await t.api('POST', '/memory/items', { content: MEM.shared, scope: 'shared', teamId: teamB })).item;
  const meaning = (await t.api('POST', '/memory/items', { content: MEM.meaning, scope: 'shared', teamId: teamB })).item;
  const rule = (await t.api('POST', '/memory/items', { content: MEM.rule, scope: 'shared', teamId: teamB, type: 'instruction', pinned: true })).item;
  const dossier = (await t.api('POST', '/memory/dossiers', { title: 'Klant Zwaluw', summary: 'Grootste klant van team B', teamId: teamB })).dossier;
  await t.api('POST', `/memory/dossiers/${dossier.id}/sources`, { kind: 'note', title: 'Contract Zwaluw', text: MEM.doc });
  assert.equal(shared.team?.id, teamB, 'the owner put it in team B');
  // A conversation of B's bot (its summary is team B's); A took part as well (as in a group).
  const th = await t.api('POST', '/threads', { agentId: s.B.bot.id });
  t.script.push({ text: 'Prima, genoteerd.' });
  await t.say(th.id, 'We hebben de offerte besproken');
  const store = t.app.ctx.store;
  const ep = store.one<any>('SELECT * FROM memory_episodes WHERE thread_id = ?', th.id);
  assert.ok(ep, 'B’s bot has a conversation summary');
  assert.equal(ep.team_id, teamB, 'the summary is in team B');
  store.exec('UPDATE memory_episodes SET summary = ?, agent_ids = ? WHERE id = ?', MEM.episode, JSON.stringify([s.B.bot.id, s.A.bot.id]), ep.id);
  t.app.ctx.services.memory.svc.syncIndex('episode', ep.id);
  await t.app.ctx.services.memory.drain();
  assert.ok(store.one('SELECT 1 FROM memory_vectors WHERE rid = ?', meaning.id), 'B’s knowledge is searchable by meaning');
  s.mem = { shared, meaning, dossier, rule, episodeRef: ep.ref };
  return s.mem;
}

/** A's tool output (memory tools), as one string. */
async function memTool(s: Scenario, name: string, args: any) {
  await memB(s);
  const { msg } = await tool(s.t, s.A.bot.id, name, args);
  return String(msg?.content || '');
}

const ctxOf = (msgs: any[]) => String(msgs.filter((m: any) => m.role === 'user').at(-1)?.parts?.context || '');

/** Run one tool call as `agentId` through the real tool loop and return the tool message. */
async function tool(t: TestApp, agentId: string, name: string, args: any, extra: any[] = []) {
  const th = await t.api('POST', '/threads', { agentId });
  t.script.push({ toolCalls: [{ name, args }] }, ...extra, { text: 'ok' });
  const msgs = await t.say(th.id, 'doe het');
  return { msg: msgs.find((m: any) => m.role === 'tool'), thread: th };
}

const setAccess = (s: Scenario, level: 'none' | 'read' | 'direct') => s.t.api('PUT', `/teams/${s.B.team.id}/access/${s.A.bot.id}`, { level });

// ---- wave 2 (package B2): team B's own database, group, chat and routine ----
const DECISION_B = 'Prijs van de fietsen van team B verhogen?';
const LOG_B = 'Webshop B: prijzen aangepast';
const EVENT_B = 'Klant van team B klaagt over de levering';
const TABLE_B = 'klanten_b';
const ROW_B = 'Jansen BV (klant van team B)';
const GROUP_B = 'Tulpenveld is het groepsgeheim van team B';
const CHAT_B = 'Zonnebloemcode van Bo';

/** Fill team B's database (decision, log line, event, Bo's own table), B's group, Bo's chat and Bo's routine, once. */
async function seedB(s: Scenario) {
  if (s.b2) return s.b2;
  const { t } = s;
  const td = t.app.ctx.services.teamdata;
  const owner = s.A.bot.user_id;
  await td.write(
    owner,
    [
      { sql: 'INSERT INTO beslissingen (vraag, opties, gevraagd_door) VALUES (?, ?, ?)', params: [DECISION_B, '["Ja","Nee"]', 'Bo'] },
      { sql: 'INSERT INTO logboek (agent, wat) VALUES (?, ?)', params: ['Bo', LOG_B] },
      { sql: 'INSERT INTO gebeurtenissen (soort, samenvatting) VALUES (?, ?)', params: ['klantbericht', EVENT_B] },
    ],
    s.B.team.id,
  );
  // Bo's own table: a bot of B writes in B's database without naming a team.
  const bo = { type: 'agent' as const, id: s.B.bot.id, name: 'Bo' };
  await td.run(owner, bo, `CREATE TABLE ${TABLE_B} (naam TEXT)`, [], 'execute');
  await td.run(owner, bo, `INSERT INTO ${TABLE_B} (naam) VALUES (?)`, [ROW_B], 'execute');
  const g = await t.api('POST', '/rooms', { name: 'Groep van B', agentIds: [s.B.bot.id, s.B.helper.id], mode: 'mention' });
  await t.say(g.threadId, GROUP_B);
  const th = await t.api('POST', '/threads', { agentId: s.B.bot.id });
  t.script.push({ text: 'Genoteerd.' });
  await t.say(th.id, CHAT_B);
  await t.api('POST', '/routines', { name: 'Klantenrapport B', agent_id: s.B.bot.id, prompt: 'Maak het klantenrapport.', schedule: { kind: 'none' } });
  s.b2 = { groupId: g.room.id, groupThread: g.threadId };
  return s.b2;
}

/** As if the owner put bot A in B's group earlier (with other teams allowed) and its access changed since. */
async function asGroupMember<T>(s: Scenario, fn: (b2: { groupId: string; groupThread: string }) => Promise<T>): Promise<T> {
  const b2 = await seedB(s);
  const store = s.t.app.ctx.store;
  const ts = new Date().toISOString();
  const id = `rm_probe_${Date.now()}`;
  store.insert('room_members', { id, room_id: b2.groupId, kind: 'agent', ref_id: s.A.bot.id, role: 'member', perms: { files: 'write', tasks: true }, state: 'idle', state_detail: '', last_run_id: null, paused: false, accepted: true, invited_by: s.A.bot.user_id, sort: 9, created_at: ts, updated_at: ts });
  store.update('rooms', b2.groupId, { settings: { crossTeam: true } });
  try {
    return await fn(b2);
  } finally {
    await waitIdleAll(s.t);
    s.t.script.length = 0;
    store.remove('room_members', id);
    store.update('rooms', b2.groupId, { settings: {} });
  }
}

const teamRows = (s: Scenario, sql: string) => s.t.app.ctx.services.teamdata.rows(s.A.bot.user_id, sql, [], false, s.B.team.id);

type Expect = 'blocked' | 'allowed';
interface Probe {
  name: string;
  /** Expected with meekijken and with aansturen (without access it must always be blocked). */
  read: Expect;
  direct: Expect;
  /** Try to reach team B as bot A; true = it got through. */
  run(s: Scenario): Promise<boolean>;
}

const PROBES: Probe[] = [
  {
    name: 'read_file in B’s folder',
    read: 'allowed',
    direct: 'allowed',
    async run(s) {
      const { msg } = await tool(s.t, s.A.bot.id, 'read_file', { path: path.join(s.B.folder, 'klanten.md') });
      return msg.content.includes(SECRET_B);
    },
  },
  {
    name: 'list_files of B’s folder',
    read: 'allowed',
    direct: 'allowed',
    async run(s) {
      const { msg } = await tool(s.t, s.A.bot.id, 'list_files', { path: s.B.folder });
      return msg.content.includes('klanten.md');
    },
  },
  {
    name: 'search_files in B’s folder',
    read: 'allowed',
    direct: 'allowed',
    async run(s) {
      const { msg } = await tool(s.t, s.A.bot.id, 'search_files', { query: 'Klantenlijst', path: s.B.folder });
      return msg.content.includes(SECRET_B);
    },
  },
  {
    name: 'write_file in B’s folder',
    read: 'blocked',
    direct: 'blocked',
    async run(s) {
      const f = path.join(s.B.folder, `van-a-${Date.now()}.md`);
      await tool(s.t, s.A.bot.id, 'write_file', { path: f, content: 'x' });
      return fs.existsSync(f);
    },
  },
  {
    name: 'edit_file in B’s folder',
    read: 'blocked',
    direct: 'blocked',
    async run(s) {
      await tool(s.t, s.A.bot.id, 'edit_file', { path: path.join(s.B.folder, 'klanten.md'), old_text: 'alleen', new_text: 'ook' });
      return !fs.readFileSync(path.join(s.B.folder, 'klanten.md'), 'utf8').includes(SECRET_B);
    },
  },
  {
    name: 'B’s folder added as an extra read-write folder of bot A',
    read: 'allowed',
    direct: 'allowed',
    async run(s) {
      const a = s.t.app.ctx.store.updateAgent(s.A.bot.id, { settings: { ...s.t.app.ctx.store.agent(s.A.bot.id)!.settings, folders: [{ path: s.B.folder, mode: 'rw', label: 'B' }] } });
      try {
        const roots = agentRootList(a);
        const r = roots.find((x) => path.resolve(x.path) === path.resolve(s.B.folder));
        // Never writable for A, and never passed to a CLI engine as a writable --add-dir.
        assert.ok(!r || r.mode === 'ro');
        assert.ok(!extraRootsOf(a, { writableOnly: true }).some((p) => path.resolve(p) === path.resolve(s.B.folder)));
        assert.throws(() => resolveInWorkspace(a, path.join(s.B.folder, 'nieuw.md'), { write: true }));
        try {
          return fs.readFileSync(resolveInWorkspace(a, path.join(s.B.folder, 'klanten.md')), 'utf8').includes(SECRET_B);
        } catch {
          return false;
        }
      } finally {
        s.t.app.ctx.store.updateAgent(s.A.bot.id, { settings: { ...a.settings, folders: [] } });
      }
    },
  },
  {
    name: 'a work folder that contains B’s folder',
    read: 'allowed',
    direct: 'allowed',
    async run(s) {
      const a0 = s.t.app.ctx.store.agent(s.A.bot.id)!;
      const a = s.t.app.ctx.store.updateAgent(a0.id, { workspace: s.root });
      try {
        assert.throws(() => resolveInWorkspace(a, path.join(s.B.folder, 'nieuw.md'), { write: true }));
        try {
          return fs.readFileSync(resolveInWorkspace(a, path.join('TeamB', 'klanten.md')), 'utf8').includes(SECRET_B);
        } catch {
          return false;
        }
      } finally {
        s.t.app.ctx.store.updateAgent(a0.id, { workspace: a0.workspace });
      }
    },
  },
  {
    name: 'run on B’s team-only AI key',
    read: 'blocked',
    direct: 'blocked',
    async run(s) {
      const a0 = s.t.app.ctx.store.agent(s.A.bot.id)!;
      s.t.app.ctx.store.updateAgent(a0.id, { provider_id: s.B.key });
      try {
        const th = await s.t.api('POST', '/threads', { agentId: a0.id });
        const before = s.t.requests.length;
        await s.t.say(th.id, 'hallo');
        const run = s.t.app.ctx.store.one<any>('SELECT * FROM runs WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1', th.id);
        const got = s.t.requests.length > before;
        // Refused before any model call, with the reason in words for the owner.
        const shown = String(run.error || '') + s.t.app.ctx.store.messages(th.id).map((m) => `${m.content} ${m.parts?.error || ''}`).join('\n');
        if (!got) assert.match(shown, /"Sleutel B" is alleen voor team “Team B”, en Ada hoort bij team “Team A”/);
        return got;
      } finally {
        s.t.app.ctx.store.updateAgent(a0.id, { provider_id: a0.provider_id });
      }
    },
  },
  {
    name: 'B’s team-only key as reserve engine',
    read: 'blocked',
    direct: 'blocked',
    async run(s) {
      const store = s.t.app.ctx.store;
      const a0 = store.agent(s.A.bot.id)!;
      // The main engine (A's own key) has an outage; a reserve takes over only when the bot may use it. Only the bot's
      // own reserves here: the default chain (engine-chain) would otherwise go on to the local model the memory probes
      // connect (and say nothing about the skipped reserve, because another engine answered).
      const attempt = async (reserve: string) => {
        store.updateAgent(a0.id, { provider_id: s.A.key, fallback: { provider_id: reserve, model: 'mock-1' }, settings: { ...a0.settings, freeChain: false, fallbacks: [{ provider_id: reserve, model: 'mock-1' }] } });
        const th = await s.t.api('POST', '/threads', { agentId: a0.id });
        s.t.script.push({ error: { message: 'storing bij de aanbieder', status: 503 } }, { text: 'antwoord van de reserve' });
        await s.t.say(th.id, 'hallo');
        s.t.script.length = 0;
        return store.messages(th.id);
      };
      try {
        // Sanity: the shared key does take over, so this probe can see a switch.
        const shared = await attempt(s.t.providerId);
        assert.ok(shared.some((m) => m.role === 'assistant' && m.parts?.providerId === s.t.providerId && m.content === 'antwoord van de reserve'), 'the shared key takes over as reserve');
        const msgs = await attempt(s.B.key);
        const used = msgs.some((m) => m.role === 'assistant' && !m.deleted && m.parts?.providerId === s.B.key);
        if (!used) assert.ok(msgs.some((m) => /Reserve Sleutel B niet gebruikt: "Sleutel B" is alleen voor team “Team B”/.test(m.content)), 'the skipped reserve is said in the chat');
        return used;
      } finally {
        store.updateAgent(a0.id, { provider_id: a0.provider_id, fallback: null, settings: a0.settings });
      }
    },
  },
  {
    name: 'B’s team-only app (MCP)',
    read: 'blocked',
    direct: 'blocked',
    async run(s) {
      const store = s.t.app.ctx.store;
      const id = 'mcpc_teamb';
      if (!store.get('mcp_connections', id)) {
        const ts = new Date().toISOString();
        store.insert('mcp_connections', { id, user_id: s.A.bot.user_id, name: 'Webshop B', slug: 'webshopb', transport: 'http', url: 'https://example.invalid/mcp', verified_at: ts, created_at: ts, updated_at: ts });
        for (const aid of [s.A.bot.id, s.B.bot.id]) store.insert('mcp_bindings', { agent_id: aid, connection_id: id, user_id: s.A.bot.user_id, created_at: ts });
        await s.t.api('PUT', `/teams/keys/app/${id}`, { teamId: s.B.team.id });
      }
      const mcp = s.t.app.ctx.services.mcp;
      assert.ok(mcp.forAgent(s.B.bot.id).some((c: any) => c.id === id), 'B’s own bot still has the app');
      return mcp.forAgent(s.A.bot.id).some((c: any) => c.id === id);
    },
  },
  {
    name: 'B’s team-only website login (Kluis)',
    read: 'blocked',
    direct: 'blocked',
    async run(s) {
      const vault = s.t.app.ctx.services.computers?._service?.vault;
      assert.ok(vault, 'the login vault is loaded');
      let e = s.t.app.ctx.store.one<any>("SELECT id FROM vault_logins WHERE label = 'Webshop B'");
      if (!e) {
        e = await s.t.api('POST', '/computers/vault', { label: 'Webshop B', origins: 'shop-b.example.com', username: 'b@example.com', password: 'geheim-wachtwoord-b' });
        await s.t.api('PUT', `/teams/keys/login/${e.id}`, { teamId: s.B.team.id });
      }
      const url = 'https://shop-b.example.com/login';
      assert.equal(vault.matchesFor(s.t.app.ctx.store.agent(s.B.bot.id), url).length, 1, 'B’s own bot still gets the login');
      return vault.matchesFor(s.t.app.ctx.store.agent(s.A.bot.id), url).length > 0;
    },
  },
  ...(['delegate_task', 'message_bot', 'ask_bot', 'handoff'] as const).map(
    (name): Probe => ({
      name: `${name} to a bot of team B`,
      read: 'blocked',
      direct: 'allowed',
      async run(s) {
        const args: any = name === 'delegate_task' ? { bot: 'Kim', task: 'Zoek iets op', expected_output: 'één zin' } : name === 'handoff' ? { bot: 'Kim', reason: 'jij bent beter' } : { bot: 'Kim', message: 'Hoi Kim', wait: false };
        const runsBefore = s.t.app.ctx.store.all('SELECT id FROM runs WHERE agent_id = ?', s.B.helper.id).length;
        // When the hop is allowed, Kim answers with the next step of the script.
        const { msg } = await tool(s.t, s.A.bot.id, name, args, [{ text: 'Kim is klaar.' }]);
        await waitIdleAll(s.t);
        s.t.script.length = 0;
        const blocked = /Geweigerd door TeamBot: Kim hoort bij team “Team B”/.test(msg.content);
        const runs = s.t.app.ctx.store.all('SELECT id FROM runs WHERE agent_id = ?', s.B.helper.id).length;
        assert.equal(blocked, runs === runsBefore, `${name}: refused exactly when Kim did not run (${msg.content})`);
        return !blocked;
      },
    }),
  ),
  // Package C: around the wall through another bot. Giving work to a bot of the own team that reaches further than the
  // sender (directs B, looks into B) or to the main bot would get work done in B, or B's knowledge back, after all.
  ...(
    [
      { bot: 'Leo', what: 'a bot of team A that directs team B (a leader)', read: 'blocked', direct: 'allowed', why: /Leo mag team “Team B” aansturen en Ada niet/ },
      { bot: 'Mia', what: 'a bot of team A that looks into team B', read: 'allowed', direct: 'allowed', why: /Mia mag meekijken bij team “Team B” en Ada niet/ },
      { bot: 'Max', what: 'the main bot', read: 'blocked', direct: 'blocked', why: /Max is de hoofdbot en krijgt alleen opdrachten van de eigenaar/ },
    ] as const
  ).map(
    (x): Probe => ({
      name: `delegate_task to ${x.what}`,
      read: x.read,
      direct: x.direct,
      async run(s) {
        const target = s.t.app.ctx.store.agents(s.A.bot.user_id).find((a) => a.name === x.bot)!;
        const runsBefore = s.t.app.ctx.store.all('SELECT id FROM runs WHERE agent_id = ?', target.id).length;
        const { msg } = await tool(s.t, s.A.bot.id, 'delegate_task', { bot: x.bot, task: 'Vraag het aan team B', expected_output: 'één zin' }, [{ text: `${x.bot} is klaar.` }]);
        await waitIdleAll(s.t);
        s.t.script.length = 0;
        const blocked = /Geweigerd door TeamBot/.test(msg.content);
        const runs = s.t.app.ctx.store.all('SELECT id FROM runs WHERE agent_id = ?', target.id).length;
        assert.equal(blocked, runs === runsBefore, `${x.bot}: refused exactly when it did not run (${msg.content})`);
        if (blocked) assert.match(msg.content, x.why);
        return !blocked;
      },
    }),
  ),
  {
    name: 'broadcast to bots of team B',
    read: 'blocked',
    direct: 'allowed',
    async run(s) {
      const { msg } = await tool(s.t, s.A.bot.id, 'broadcast', { bots: ['Bo', 'Kim'], message: 'Wie weet dit?', follow_up: false }, [{ text: 'Bo hier.' }, { text: 'Kim hier.' }]);
      await waitIdleAll(s.t);
      s.t.script.length = 0;
      return !/Niemand kon worden aangesproken/.test(msg.content);
    },
  },
  {
    name: 'task_create with a bot of team B as owner',
    read: 'blocked',
    direct: 'allowed',
    async run(s) {
      const { msg } = await tool(s.t, s.A.bot.id, 'task_create', { title: `Taak voor Kim ${Date.now()}`, owner: 'Kim' });
      return /Taak aangemaakt/.test(msg.content);
    },
  },
  // Specialists (package S): Bo's knowledge base lives in his home team B. Meekijken/aansturen may read it (through
  // knowledge_search); only bots of team B may add to it; memory itself never shows it to another bot.
  {
    name: 'knowledge_search in the knowledge base of B’s specialist',
    read: 'allowed',
    direct: 'allowed',
    async run(s) {
      await specialistB(s);
      const { msg } = await withGroup(s, 'specialist', () => tool(s.t, s.A.bot.id, 'knowledge_search', { query: 'inkoopprijs fietsen', specialist: 'Bo' }));
      const got = msg.content.includes(KB_SECRET_B);
      if (!got) assert.match(msg.content, /Geweigerd door TeamBot: de kennisbank van Bo hoort bij een ander team/);
      return got;
    },
  },
  {
    name: 'knowledge_search without naming a specialist (all readable knowledge bases)',
    read: 'allowed',
    direct: 'allowed',
    async run(s) {
      await specialistB(s);
      const { msg } = await withGroup(s, 'specialist', () => tool(s.t, s.A.bot.id, 'knowledge_search', { query: 'inkoopprijs fietsen' }));
      return msg.content.includes(KB_SECRET_B);
    },
  },
  {
    name: 'knowledge_add to the knowledge base of B’s specialist',
    read: 'blocked',
    direct: 'blocked',
    async run(s) {
      await specialistB(s);
      const fact = `Team A zegt: fietsen kosten nu 1 euro (${Date.now()}).`;
      await withGroup(s, 'specialist', () => tool(s.t, s.A.bot.id, 'knowledge_add', { fact, specialist: 'Bo' }));
      return !!s.t.app.ctx.store.one('SELECT id FROM memory_items WHERE content = ?', fact);
    },
  },
  {
    name: 'memory_search for B’s specialist knowledge',
    read: 'blocked',
    direct: 'blocked',
    async run(s) {
      await specialistB(s);
      const { msg } = await withGroup(s, 'memory', () => tool(s.t, s.A.bot.id, 'memory_search', { query: 'inkoopprijs fietsen' }));
      return msg.content.includes(KB_SECRET_B);
    },
  },
  {
    name: 'the turn context of A never carries B’s knowledge base',
    read: 'blocked',
    direct: 'blocked',
    async run(s) {
      await specialistB(s);
      return withGroup(s, 'specialist', async () => {
        const th = await s.t.api('POST', '/threads', { agentId: s.A.bot.id });
        s.t.script.push({ text: 'ok' });
        await s.t.say(th.id, 'Wat is de inkoopprijs van fietsen?');
        const req = s.t.requests.at(-1)!;
        // Without access B's specialist is not even named; with meekijken A is told it exists (and may search it).
        const level = s.t.app.ctx.services.teams.access(s.A.bot.id, s.B.team.id);
        if (level === 'none') assert.doesNotMatch(req.system, /Inkoop van fietsen|\bBo\b/);
        else assert.match(req.system, /Specialisten met een eigen kennisbank die je kunt raadplegen: Bo \(Inkoop van fietsen\)/);
        return JSON.stringify(req.messages).includes(KB_SECRET_B) || req.system.includes(KB_SECRET_B);
      });
    },
  },

  // ---- wave 2 (package B2): the team database (decisions, log, events, tables), groups and search ----
  ...(
    [
      ['beslissingen', 'SELECT vraag AS v FROM beslissingen', DECISION_B],
      ['logboek', 'SELECT wat AS v FROM logboek', LOG_B],
      ['gebeurtenissen', 'SELECT samenvatting AS v FROM gebeurtenissen', EVENT_B],
      [TABLE_B, `SELECT naam AS v FROM ${TABLE_B}`, ROW_B],
    ] as const
  ).map(
    ([table, sql, secret]): Probe => ({
      name: `team_query on B’s ${table} (team “Team B”)`,
      read: 'allowed',
      direct: 'allowed',
      async run(s) {
        await seedB(s);
        const { msg } = await tool(s.t, s.A.bot.id, 'team_query', { sql, team: 'Team B' });
        if (!msg.content.includes(secret)) assert.match(msg.content, /Geen team “Team B” waarvan Ada de teamdatabase mag lezen/, 'refused in words, without saying whether team B exists');
        return msg.content.includes(secret);
      },
    }),
  ),
  {
    name: 'team_tables of B (team “Team B”)',
    read: 'allowed',
    direct: 'allowed',
    async run(s) {
      await seedB(s);
      const { msg } = await tool(s.t, s.A.bot.id, 'team_tables', { team: 'Team B' });
      return msg.content.includes(TABLE_B);
    },
  },
  {
    name: 'A’s own team database holds nothing of B',
    read: 'blocked',
    direct: 'blocked',
    async run(s) {
      await seedB(s);
      const { msg } = await tool(s.t, s.A.bot.id, 'team_query', { sql: 'SELECT vraag FROM beslissingen UNION ALL SELECT wat FROM logboek UNION ALL SELECT samenvatting FROM gebeurtenissen' });
      const tables = (await tool(s.t, s.A.bot.id, 'team_tables', {})).msg.content;
      return [DECISION_B, LOG_B, EVENT_B].some((x) => msg.content.includes(x)) || tables.includes(TABLE_B);
    },
  },
  {
    name: 'team_execute: a line in B’s logboek',
    read: 'blocked',
    direct: 'blocked',
    async run(s) {
      await seedB(s);
      const count = async () => Number((await teamRows(s, 'SELECT COUNT(*) AS n FROM logboek'))[0].n);
      const before = await count();
      const { msg } = await tool(s.t, s.A.bot.id, 'team_execute', { sql: 'INSERT INTO logboek (agent, wat) VALUES (?, ?)', params: ['Ada', 'van team A'], team: 'Team B' });
      const changed = (await count()) !== before;
      if (!changed) {
        assert.match(msg.content, /Geweigerd door TeamBot: in de teamdatabase van team “Team B” mag Ada alleen meekijken|Geen team “Team B”/);
        // The refused attempt is in the change log of A's own team database.
        const audit = await s.t.api('GET', `/teamdata/audit?team=${s.A.team.id}`);
        assert.ok(audit.some((x: any) => x.actor_name === 'Ada' && x.error === msg.content), 'the refused write is logged in team A');
      }
      return changed;
    },
  },
  {
    name: 'team_execute: deciding B’s decision, or dropping Bo’s table',
    read: 'blocked',
    direct: 'blocked',
    async run(s) {
      await seedB(s);
      await tool(s.t, s.A.bot.id, 'team_execute', { sql: "UPDATE beslissingen SET status = 'gekozen', antwoord = 'door A' WHERE vraag = ?", params: [DECISION_B], team: 'Team B' });
      await tool(s.t, s.A.bot.id, 'team_execute', { sql: `DROP TABLE ${TABLE_B}`, team: 'Team B' });
      const [d] = await teamRows(s, `SELECT status FROM beslissingen WHERE vraag = '${DECISION_B}'`);
      const t = await teamRows(s, `SELECT name FROM sqlite_master WHERE name = '${TABLE_B}'`);
      return d.status !== 'open' || !t.length;
    },
  },
  {
    name: 'the owner’s answer to a decision of B reaches bot A (gevraagd_door = Ada)',
    read: 'allowed',
    direct: 'allowed',
    async run(s) {
      await seedB(s);
      const td = s.t.app.ctx.services.teamdata;
      const [w] = await td.write(s.A.bot.user_id, [{ sql: 'INSERT INTO beslissingen (vraag, opties, gevraagd_door) VALUES (?, ?, ?)', params: [`Vraag van B voor Ada ${Date.now()}?`, '["Ja","Nee"]', 'Ada'] }], s.B.team.id);
      const r = await s.t.api('POST', `/teamdata/decisions/${w.lastInsertRowid}/answer`, { choice: 0, teamId: s.B.team.id });
      await waitIdleAll(s.t);
      if (!r.woke) assert.match(r.notice, /vond geen bot met de naam “Ada”/);
      return r.woke?.agentId === s.A.bot.id;
    },
  },
  {
    name: 'bot A joins a group of team B',
    read: 'allowed',
    direct: 'allowed',
    async run(s) {
      const { groupId } = await seedB(s);
      try {
        // Never silently: without the explicit choice "Bots van andere teams toestaan" it is refused, also with access.
        await assert.rejects(s.t.api('POST', `/rooms/${groupId}/bots`, { agentId: s.A.bot.id }), /Ada hoort bij team “Team A”/);
        const v = await s.t.api('POST', `/rooms/${groupId}/bots`, { agentId: s.A.bot.id, crossTeam: true }).catch((e: Error) => {
          assert.match(e.message, /heeft geen toegang tot team “Team B”, waar deze groep bij hoort/);
          return null;
        });
        if (!v) return false;
        // Visible as such: the group lets other teams in, and Ada shows with her own team and read-only files.
        assert.equal(v.crossTeam, true);
        assert.equal(v.workspaceName, 'Team B');
        assert.equal(v.foreignBots, 1);
        const ada = v.bots.find((b: any) => b.agentId === s.A.bot.id);
        assert.equal(ada.homeTeamName, 'Team A');
        assert.equal(ada.perms.files, 'read');
        const chat = s.t.app.ctx.store.messages(v.thread_id).map((m) => m.content).join('\n');
        assert.match(chat, /Deze groep staat nu bots van andere teams toe/);
        assert.match(chat, /Ada \(team “Team A”, (meekijken|aansturen)\) is aan de groep van team “Team B” toegevoegd/);
        return true;
      } finally {
        await s.t.api('DELETE', `/rooms/${groupId}/bots/${s.A.bot.id}`).catch(() => {});
        await s.t.api('PATCH', `/rooms/${groupId}`, { crossTeam: false });
      }
    },
  },
  {
    name: 'bot A as a member of B’s group sees the group conversation',
    read: 'allowed',
    direct: 'allowed',
    async run(s) {
      return asGroupMember(s, async ({ groupThread }) => {
        const before = s.t.requests.length;
        s.t.script.push({ text: 'Ada hier.' });
        const msgs = await s.t.say(groupThread, '@Ada wat staat er hierboven?');
        const got = s.t.requests.slice(before).some((r) => JSON.stringify(r.messages).includes(GROUP_B));
        if (!got) assert.ok(msgs.some((m: any) => /Ada hoort bij team “Team A” en heeft geen toegang \(meer\) tot team “Team B”/.test(m.content)), 'the group says why Ada sits out');
        return got;
      });
    },
  },
  {
    name: 'bot A writes a file in B’s group (as a member)',
    read: 'blocked',
    direct: 'blocked',
    async run(s) {
      return asGroupMember(s, async ({ groupId, groupThread }) => {
        const f = path.join(s.t.dir, 'rooms', groupId, 'files', 'van-ada.md');
        s.t.script.push({ toolCalls: [{ name: 'room_file_write', args: { path: 'van-ada.md', content: 'x' } }] }, { text: 'klaar' });
        await s.t.say(groupThread, '@Ada schrijf een bestand');
        return fs.existsSync(f);
      });
    },
  },
  {
    name: 'search for bot A: file names in B’s team folder',
    read: 'allowed',
    direct: 'allowed',
    async run(s) {
      return s.t.app.ctx.services.search.forAgent(s.A.bot.id, 'klanten').some((h: any) => h.kind === 'file' && h.title === 'klanten.md');
    },
  },
  {
    name: 'search for bot A: B’s routines',
    read: 'allowed',
    direct: 'allowed',
    async run(s) {
      await seedB(s);
      return s.t.app.ctx.services.search.forAgent(s.A.bot.id, 'Klantenrapport').some((h: any) => h.kind === 'routine');
    },
  },
  {
    name: 'search for bot A: Bo’s own conversation and B’s group conversation',
    read: 'blocked',
    direct: 'blocked',
    async run(s) {
      await seedB(s);
      const search = s.t.app.ctx.services.search;
      // The owner does find both (so "nothing found" for A is the wall, not missing data).
      for (const q of ['Zonnebloemcode', 'Tulpenveld']) assert.ok(search.all(s.A.bot.user_id, q).some((h: any) => h.kind === 'message'), `the owner finds ${q}`);
      return ['Zonnebloemcode', 'Tulpenveld'].some((q) => search.forAgent(s.A.bot.id, q).some((h: any) => h.kind === 'message'));
    },
  },
  // ---- memory (wave 2): team knowledge is read with meekijken (and aansturen), never written; team rules stay home.
  {
    name: 'memory_search (words) finds B’s shared knowledge',
    read: 'allowed',
    direct: 'allowed',
    async run(s) {
      return (await memTool(s, 'memory_search', { query: 'België levert' })).includes(MEM.shared);
    },
  },
  {
    name: 'memory_search (meaning, vectors) finds B’s knowledge in other words',
    read: 'allowed',
    direct: 'allowed',
    async run(s) {
      // "wagen" shares no word with "Volvo": only the vectors can find it.
      return (await memTool(s, 'memory_search', { query: 'wagen' })).includes(MEM.meaning);
    },
  },
  {
    name: 'memory_get of B’s knowledge by its id',
    read: 'allowed',
    direct: 'allowed',
    async run(s) {
      const m = await memB(s);
      return (await memTool(s, 'memory_get', { id: `m:${m.shared.ref}` })).includes(MEM.shared);
    },
  },
  {
    name: 'B’s knowledge in A’s per-turn memory block',
    read: 'allowed',
    direct: 'allowed',
    async run(s) {
      await memB(s);
      const th = await s.t.api('POST', '/threads', { agentId: s.A.bot.id });
      s.t.script.push({ text: 'ok' });
      const msgs = await s.t.say(th.id, 'Waar levert de webshop? Alleen in België?');
      const req = JSON.stringify(s.t.requests.at(-1)!.messages);
      return ctxOf(msgs).includes(MEM.shared) || req.includes(MEM.shared);
    },
  },
  {
    name: 'dossier_search lists B’s dossier',
    read: 'allowed',
    direct: 'allowed',
    async run(s) {
      return (await memTool(s, 'dossier_search', { query: 'Zwaluw' })).includes('Grootste klant van team B');
    },
  },
  {
    name: 'dossier_get reads B’s dossier and searches its documents',
    read: 'allowed',
    direct: 'allowed',
    async run(s) {
      const m = await memB(s);
      return (await memTool(s, 'dossier_get', { dossier: `d:${m.dossier.ref}`, query: 'korting' })).includes('twaalf procent');
    },
  },
  {
    name: 'memory_search finds B’s documents (dossier sources)',
    read: 'allowed',
    direct: 'allowed',
    async run(s) {
      return (await memTool(s, 'memory_search', { query: 'korting contract', scope: 'dossier' })).includes('twaalf procent');
    },
  },
  {
    name: 'B’s documents in A’s per-turn memory block',
    read: 'allowed',
    direct: 'allowed',
    async run(s) {
      await memB(s);
      const th = await s.t.api('POST', '/threads', { agentId: s.A.bot.id });
      s.t.script.push({ text: 'ok' });
      const msgs = await s.t.say(th.id, 'Hoeveel korting staat er in het contract met Zwaluw?');
      return ctxOf(msgs).includes('twaalf procent');
    },
  },
  {
    name: 'memory_search finds a conversation summary of team B',
    read: 'allowed',
    direct: 'allowed',
    async run(s) {
      return (await memTool(s, 'memory_search', { query: 'Pelikaan offerte', scope: 'episode' })).includes('Pelikaan');
    },
  },
  {
    name: 'B’s team rule in A’s system prompt',
    read: 'blocked',
    direct: 'blocked',
    async run(s) {
      await memB(s);
      const th = await s.t.api('POST', '/threads', { agentId: s.A.bot.id });
      s.t.script.push({ text: 'ok' });
      await s.t.say(th.id, 'Hallo');
      // A team's rules are for its own bots; a bot that only looks in does not get them (nor their wording).
      return s.t.requests.at(-1)!.system.includes(MEM.rule);
    },
  },
  {
    name: 'memory_remember into B’s dossier',
    read: 'blocked',
    direct: 'blocked',
    async run(s) {
      const m = await memB(s);
      const text = `Notitie van Ada voor Zwaluw ${Date.now()}`;
      await memTool(s, 'memory_remember', { content: text, scope: 'dossier', dossier: `d:${m.dossier.ref}` });
      return !!s.t.app.ctx.store.one("SELECT 1 FROM memory_items WHERE dossier_id = ? AND content = ? AND status != 'forgotten'", m.dossier.id, text);
    },
  },
  {
    name: 'dossier_add to B’s dossier',
    read: 'blocked',
    direct: 'blocked',
    async run(s) {
      const m = await memB(s);
      const title = `Besluit van Ada ${Date.now()}`;
      await memTool(s, 'dossier_add', { dossier: `d:${m.dossier.ref}`, kind: 'decision', title });
      return !!s.t.app.ctx.store.one('SELECT 1 FROM memory_records WHERE dossier_id = ? AND title = ?', m.dossier.id, title);
    },
  },
  {
    name: 'dossier_update of B’s dossier',
    read: 'blocked',
    direct: 'blocked',
    async run(s) {
      const m = await memB(s);
      const summary = `Overschreven door Ada ${Date.now()}`;
      await memTool(s, 'dossier_update', { id: `d:${m.dossier.ref}`, summary });
      return s.t.app.ctx.store.one<any>('SELECT summary FROM memory_dossiers WHERE id = ?', m.dossier.id)?.summary === summary;
    },
  },
  {
    name: 'memory_update of B’s shared knowledge (not even a proposal)',
    read: 'blocked',
    direct: 'blocked',
    async run(s) {
      const m = await memB(s);
      const content = `Webshop B levert ook in Duitsland ${Date.now()}`;
      await memTool(s, 'memory_update', { id: `m:${m.shared.ref}`, content });
      return !!s.t.app.ctx.store.one("SELECT 1 FROM memory_items WHERE content = ? AND status IN ('active','proposed')", content);
    },
  },
  {
    name: 'memory_forget of B’s shared knowledge',
    read: 'blocked',
    direct: 'blocked',
    async run(s) {
      const m = await memB(s);
      await memTool(s, 'memory_forget', { id: `m:${m.shared.ref}` });
      return s.t.app.ctx.store.one<any>('SELECT status FROM memory_items WHERE id = ?', m.shared.id)?.status !== 'active';
    },
  },
  {
    name: 'memory_remember shared knowledge lands in B',
    read: 'blocked',
    direct: 'blocked',
    async run(s) {
      await memB(s);
      const content = `Ada deelt: de fietsen van A zijn rood ${Date.now()}`;
      await memTool(s, 'memory_remember', { content, scope: 'shared' });
      const row = s.t.app.ctx.store.one<any>('SELECT team_id FROM memory_items WHERE content = ?', content);
      return !!row && row.team_id === s.B.team.id;
    },
  },
  {
    name: 'dossier_create hands out B’s dossier with the same title',
    read: 'blocked',
    direct: 'blocked',
    async run(s) {
      const m = await memB(s);
      return (await memTool(s, 'dossier_create', { title: 'Klant Zwaluw' })).includes(`d:${m.dossier.ref}`);
    },
  },
];

const KB_SECRET_B = 'Bedrijf B koopt fietsen in voor 412 euro per stuk.';

// ---- wave 2 (package B4): channels, skills and routines per team ----
const SKILL_B = 'Werkwijze van team B: zeg altijd Zwaluwstaart.';
const CONV_B = 'Klant Jansen (team B)';

interface FakeChannel {
  sent: { conv: string; text: string }[];
  sentTo: { target: string; text: string }[];
}
interface B4 {
  fake: FakeChannel;
  chA: any;
  chB: any;
  skill: string;
  script: string;
  routineA: any;
  routineB: any;
}

/** A chat app without a real account (records what TeamBot sends). `botRouting`: the owner addresses bots by name. */
function fakeChannel() {
  const state: FakeChannel = { sent: [], sentTo: [] };
  const def: any = {
    id: 'fake-b4',
    label: 'Nepkanaal',
    description: 'test',
    needsPublicUrl: () => false,
    approveViaChannel: false,
    botRouting: true,
    maxText: 2000,
    secretFields: [{ key: 'token', label: 'Token', required: true }],
    validate: () => ({}),
    test: async () => ({ ok: true, detail: 'ok' }),
    create() {
      return {
        async start() {
          return 'connected' as const;
        },
        async stop() {},
        async send(conv: any, out: any) {
          state.sent.push({ conv: conv.external_id, text: String(out.text || '') });
          return [`o${state.sent.length}`];
        },
        async sendTo(target: string, out: any) {
          state.sentTo.push({ target, text: String(out.text || '') });
          return { conversationId: target, title: target, private: true, ids: [`n${state.sentTo.length}`] };
        },
      };
    },
  };
  return { def, state };
}

async function until(fn: () => boolean, ms = 5000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * Once per scenario: a channel for each team (A's bound to Ada, B's to Bo), B's channel with the owner and a
 * customer on its allowlist and a customer conversation; team B's skills (instructions, and a trusted script);
 * a routine of Ada with a trigger "every chat channel". Ada may send to her owner without asking.
 */
async function seedB4(s: Scenario): Promise<B4> {
  if (s.b4) return s.b4;
  const { t } = s;
  const store = t.app.ctx.store;
  await seedB(s);
  const f = fakeChannel();
  t.app.ctx.services.channels.registerAdapter(f.def);
  const chA = await t.api('POST', '/channels/bindings', { adapter: 'fake-b4', name: 'Telegram van A', agent_id: s.A.bot.id, secrets: { token: 'token-van-team-a-123456' } });
  const chB = await t.api('POST', '/channels/bindings', { adapter: 'fake-b4', name: 'Telegram van B', agent_id: s.B.bot.id, secrets: { token: 'token-van-team-b-123456' } });
  assert.deepEqual([chA.team_id, chB.team_id, chB.teamName], [s.A.team.id, s.B.team.id, 'Team B'], 'each channel is in the team of its bot');
  await until(() => [chA.id, chB.id].every((id) => store.get<any>('channel_bindings', id)?.status === 'connected'));
  await t.api('POST', `/channels/bindings/${chB.id}/senders`, { external_id: 'eigenaar-b', label: 'Ik', is_owner: true });
  await t.api('POST', `/channels/bindings/${chB.id}/senders`, { external_id: 'klant-b', label: 'Jansen' });
  const ts = new Date().toISOString();
  // Paused, so a message in it does not wake Bo (the probes only look at who else would act on it).
  store.insert('channel_conversations', { id: 'cv_klant_b', binding_id: chB.id, user_id: s.A.bot.user_id, external_id: 'klant-b', thread_id: null, title: CONV_B, is_private: true, meta: {}, paused: true, last_sender_id: 'klant-b', last_inbound_at: ts, last_outbound_at: null, created_at: ts });
  await t.api('PUT', `/channels/agents/${s.A.bot.id}/send-rules/owner`, { enabled: true });

  const install = async (body: any) => {
    const p = await t.api('POST', '/skills/import/preview', { ...body, teamId: s.B.team.id });
    assert.equal(p.teamId, s.B.team.id, 'the preview says where it goes');
    const c = await t.api('POST', '/skills/import/commit', { stagingId: p.stagingId, teamId: s.B.team.id, enableFor: [s.B.bot.id], acknowledge: true });
    assert.equal(c.results[0].status, 'created', JSON.stringify(c.results[0]));
    return c.results[0].skillId as string;
  };
  const skill = await install({ kind: 'paste', text: `---\nname: klant-b\ndescription: Klantenservice van team B\n---\n${SKILL_B}\n` });
  const script = await install({
    kind: 'files',
    label: 'script-b',
    files: [
      { path: 'SKILL.md', text: '---\nname: script-b\ndescription: Script van team B\n---\nVoer scripts/b.mjs uit.\n' },
      { path: 'scripts/b.mjs', text: "import fs from 'node:fs';\nfs.writeFileSync('van-script-b.txt', 'B');\n" },
    ],
  });
  await t.api('POST', `/skills/${script}/trust`, { trusted: true });
  // As if the owner enabled B's skills for Ada earlier (enabling them now without access is refused, see below).
  const a = store.agent(s.A.bot.id)!;
  store.updateAgent(a.id, { skills: [...(a.skills || []), skill, script] });

  const routineA = await t.api('POST', '/routines', { name: 'Weekrapport A', agent_id: s.A.bot.id, prompt: 'Maak het weekrapport.', schedule: { kind: 'none' } });
  await t.api('POST', `/routines/${routineA.id}/triggers`, { kind: 'chat', name: 'Elk chatbericht', config: { bindingId: '', senders: 'allowlist', match: 'any', botReplies: true } });
  const routineB = store.one<any>("SELECT * FROM routines WHERE name = 'Klantenrapport B'");
  assert.ok(routineB, 'B’s routine (seedB)');
  s.b4 = { fake: f.state, chA, chB, skill, script, routineA, routineB };
  return s.b4;
}

const B4_PROBES: Probe[] = [
  {
    name: 'channel_list lists B’s channel and its conversations',
    read: 'allowed',
    direct: 'allowed',
    async run(s) {
      await seedB4(s);
      const { msg } = await withGroup(s, 'channels', () => tool(s.t, s.A.bot.id, 'channel_list', {}));
      const got = msg.content.includes('Telegram van B') && msg.content.includes(CONV_B);
      if (got) assert.match(msg.content, /alleen meekijken: versturen via dit kanaal kan niet/);
      return got;
    },
  },
  {
    name: 'channel_send through B’s channel',
    read: 'blocked',
    direct: 'blocked',
    async run(s) {
      const b4 = await seedB4(s);
      const before = b4.fake.sent.length + b4.fake.sentTo.length;
      const { msg } = await withGroup(s, 'channels', () => tool(s.t, s.A.bot.id, 'channel_send', { binding: 'Telegram van B', to: 'eigenaar', text: 'Hoi van Ada' }));
      const sent = b4.fake.sent.length + b4.fake.sentTo.length > before;
      if (!sent) {
        // Refused before any approval card; without access it does not even say the channel exists.
        const level = s.t.app.ctx.services.teams.access(s.A.bot.id, s.B.team.id);
        assert.match(msg.content, level === 'none' ? /Geen kanaal “Telegram van B” dat Ada mag gebruiken/ : /Geweigerd door TeamBot: kanaal “Telegram van B” hoort bij team “Team B”, en Ada hoort bij team “Team A” \((alleen meekijken|aansturen: werk geven aan dat team, niet zelf versturen)\)/);
        assert.equal(s.t.app.ctx.store.all("SELECT id FROM approvals WHERE status = 'pending'").length, 0, 'no approval card');
      }
      return sent;
    },
  },
  {
    name: 'the owner names bot A on B’s channel (“@Ada …”): A answers there',
    read: 'blocked',
    direct: 'blocked',
    async run(s) {
      const b4 = await seedB4(s);
      const runs = () => s.t.app.ctx.store.all('SELECT id FROM runs WHERE agent_id = ?', s.A.bot.id).length;
      const before = runs();
      const r = await s.t.app.ctx.services.channels.manager.receive(b4.chB.id, { messageId: `own-${Date.now()}`, conversation: { id: 'eigenaar-b', title: 'Ik', private: true }, sender: { id: 'eigenaar-b', name: 'Ik' }, text: '@Ada wat staat er in de klantenlijst?' });
      await waitIdleAll(s.t);
      const answered = runs() > before;
      if (!answered) {
        assert.equal(r.status, 'command');
        assert.match(b4.fake.sent.at(-1)?.text || '', /kanaal “Telegram van B” hoort bij team “Team B”, en Ada hoort bij team “Team A”/);
      }
      return answered;
    },
  },
  {
    name: 'skill_load of a skill of team B (enabled for A by the owner)',
    read: 'allowed',
    direct: 'allowed',
    async run(s) {
      await seedB4(s);
      const { msg } = await withGroup(s, 'skills', () => tool(s.t, s.A.bot.id, 'skill_load', { name: 'klant-b' }));
      if (!msg.content.includes(SKILL_B)) assert.match(msg.content, /niet ingeschakeld/);
      return msg.content.includes(SKILL_B);
    },
  },
  {
    name: 'B’s skill named in A’s system prompt',
    read: 'allowed',
    direct: 'allowed',
    async run(s) {
      await seedB4(s);
      return withGroup(s, 'skills', async () => {
        const th = await s.t.api('POST', '/threads', { agentId: s.A.bot.id });
        s.t.script.push({ text: 'ok' });
        await s.t.say(th.id, 'Hallo');
        return /klant-b: Klantenservice van team B/.test(s.t.requests.at(-1)!.system);
      });
    },
  },
  {
    name: 'skill_run_script of a trusted script of team B',
    read: 'blocked',
    direct: 'blocked',
    async run(s) {
      const b4 = await seedB4(s);
      const work = s.t.app.ctx.store.agent(s.A.bot.id)!.workspace;
      const marker = path.join(work, 'van-script-b.txt');
      const audits = () => s.t.app.ctx.store.all("SELECT id FROM audit WHERE kind = 'skill.script_run' AND agent_id = ?", s.A.bot.id).length;
      const before = audits();
      const { msg } = await withGroup(s, 'skills', () => tool(s.t, s.A.bot.id, 'skill_run_script', { name: 'script-b', script: 'scripts/b.mjs' }));
      const ran = audits() > before || fs.existsSync(marker);
      if (!ran) {
        const level = s.t.app.ctx.services.teams.access(s.A.bot.id, s.B.team.id);
        assert.match(msg.content, level === 'none' ? /niet ingeschakeld/ : /Geweigerd door TeamBot: skill script-b hoort bij team “Team B”\. Ada mag hem lezen \(meekijken\), maar zijn scripts niet uitvoeren/);
        assert.ok(!s.t.app.ctx.store.one("SELECT id FROM approvals WHERE status = 'pending' AND tool = 'skill_run_script'"), 'refused before an approval card');
      }
      void b4;
      return ran;
    },
  },
  {
    name: 'skill_draft by bot A with the name of B’s skill lands in team B',
    read: 'blocked',
    direct: 'blocked',
    async run(s) {
      await seedB4(s);
      await withGroup(s, 'skills', () => tool(s.t, s.A.bot.id, 'skill_draft', { name: 'klant-b', description: 'Voorstel van Ada', instructions: 'Zeg altijd hallo.' }));
      const row = s.t.app.ctx.store.one<any>("SELECT * FROM skills WHERE status = 'draft' AND name = 'klant-b' AND draft_agent_id = ? ORDER BY created_at DESC LIMIT 1", s.A.bot.id);
      assert.ok(row, 'the draft exists');
      assert.equal(row.team_id, s.A.team.id, 'a bot drafts for its own team');
      return row.team_id === s.B.team.id;
    },
  },
  {
    name: 'routine_list shows B’s routine',
    read: 'allowed',
    direct: 'allowed',
    async run(s) {
      await seedB4(s);
      const { msg } = await withGroup(s, 'routines', () => tool(s.t, s.A.bot.id, 'routine_list', {}));
      assert.match(msg.content, /Weekrapport A/, 'A’s own routine is listed');
      const got = msg.content.includes('Klantenrapport B');
      if (got) assert.match(msg.content, /Klantenrapport B \(bot: Bo\) · team “Team B” \(alleen meekijken\)/);
      return got;
    },
  },
  {
    name: 'a chat message on B’s channel starts A’s routine (trigger “every chat channel”)',
    read: 'blocked',
    direct: 'blocked',
    async run(s) {
      const b4 = await seedB4(s);
      const r = await s.t.app.ctx.services.channels.manager.receive(b4.chB.id, { messageId: `klant-${Date.now()}-${Math.random()}`, conversation: { id: 'klant-b', title: CONV_B, private: true }, sender: { id: 'klant-b', name: 'Jansen' }, text: 'Waar blijft mijn bestelling?' });
      await waitIdleAll(s.t);
      return (r.routines || []).includes('Weekrapport A');
    },
  },
  {
    name: 'a routine of A sends its result through B’s channel',
    read: 'blocked',
    direct: 'blocked',
    async run(s) {
      const b4 = await seedB4(s);
      const made = await s.t.api('POST', '/routines', { name: `Naar B ${Date.now()}`, agent_id: s.A.bot.id, prompt: 'x', schedule: { kind: 'none' }, options: { deliver: { bindingId: b4.chB.id, to: 'owner' } } }).catch((e: Error) => {
        assert.match(e.message, /Kanaal “Telegram van B” hoort bij team “Team B”, en deze routine van Ada bij team “Team A”/);
        return null;
      });
      if (made) await s.t.api('DELETE', `/routines/${made.id}`);
      // The run-time door too (old data, or a bot that moved): the channels module refuses on behalf of A's bot.
      const before = b4.fake.sentTo.length + b4.fake.sent.length;
      const sent = await s.t.app.ctx.services.channels
        .deliver({ userId: s.A.bot.user_id, bindingId: b4.chB.id, owner: true, text: 'Rapport van A', agentId: s.A.bot.id })
        .then(() => true)
        .catch((e: Error) => {
          assert.match(e.message, /Geweigerd door TeamBot: kanaal “Telegram van B” hoort bij team “Team B”/);
          return false;
        });
      return !!made || sent || b4.fake.sentTo.length + b4.fake.sent.length > before;
    },
  },
  {
    name: 'a routine of A starts B’s routine afterwards (chain)',
    read: 'blocked',
    direct: 'blocked',
    async run(s) {
      const b4 = await seedB4(s);
      const r = await s.t.api('PATCH', `/routines/${b4.routineA.id}`, { options: { then: { routineId: b4.routineB.id, on: 'always' } } }).catch((e: Error) => {
        assert.match(e.message, /Routine “Klantenrapport B” hoort bij team “Team B”/);
        return null;
      });
      if (r) await s.t.api('PATCH', `/routines/${b4.routineA.id}`, { options: { then: null } });
      return !!r?.options?.then;
    },
  },
];

/** Bo (team B) becomes a specialist with one fact in his knowledge base (once per scenario). */
async function specialistB(s: Scenario) {
  const v = await s.t.api('GET', `/specialists/${s.B.bot.id}`);
  if (v.enabled) return;
  await s.t.api('PUT', `/specialists/${s.B.bot.id}`, { enabled: true, field: 'Inkoop van fietsen' });
  await s.t.api('POST', `/specialists/${s.B.bot.id}/knowledge`, { content: KB_SECRET_B, source: 'https://b.example/inkoop' });
  // B's own bots read it: the specialist itself and Kim (same home team).
  for (const id of [s.B.bot.id, s.B.helper.id]) {
    const { msg } = await withGroup(s, 'specialist', () => tool(s.t, id, 'knowledge_search', { query: 'inkoopprijs fietsen', specialist: 'Bo' }), id);
    assert.ok(msg.content.includes(KB_SECRET_B), 'B’s own bots read the knowledge base');
  }
}

/** Run with an extra tool group on a bot (default bot A), restored afterwards. */
async function withGroup<T>(s: Scenario, group: string, fn: () => Promise<T>, agentId = s.A.bot.id): Promise<T> {
  const store = s.t.app.ctx.store;
  const a0 = store.agent(agentId)!;
  if (!a0.tool_groups.includes(group)) store.updateAgent(agentId, { tool_groups: [...a0.tool_groups, group] });
  try {
    return await fn();
  } finally {
    store.updateAgent(agentId, { tool_groups: a0.tool_groups });
  }
}

async function waitIdleAll(t: TestApp, ms = 10_000) {
  const start = Date.now();
  await new Promise((r) => setTimeout(r, 40));
  while (Date.now() - start < ms) {
    if (!t.app.ctx.store.all("SELECT id FROM runs WHERE status IN ('queued','running','waiting')").length) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('teams isolation: a bot of team A without access reaches nothing of team B; meekijken reads, aansturen directs', async () => {
  const s = await scenario();
  try {
    for (const level of ['none', 'read', 'direct'] as const) {
      await setAccess(s, level);
      for (const p of [...PROBES, ...B4_PROBES]) {
        const want: Expect = level === 'none' ? 'blocked' : p[level];
        const got = await p.run(s);
        assert.equal(got ? 'allowed' : 'blocked', want, `${p.name} with access "${level}"`);
      }
    }
  } finally {
    await done(s);
  }
});

test('teams isolation: B’s own bots work in B, the shared key works in both teams, nothing of B in A’s prompt', async () => {
  const s = await scenario();
  try {
    const { t } = s;
    // B's bot reads and writes its own folder and runs on its own team-only key.
    const r = await tool(t, s.B.bot.id, 'read_file', { path: path.join(s.B.folder, 'klanten.md') });
    assert.match(r.msg.content, /Klantenlijst van B/);
    await tool(t, s.B.bot.id, 'write_file', { path: path.join(s.B.folder, 'van-bo.md'), content: 'Bo' });
    assert.equal(fs.readFileSync(path.join(s.B.folder, 'van-bo.md'), 'utf8'), 'Bo');
    // B's lead gives its own team member work without any extra access.
    const d = await tool(t, s.B.bot.id, 'delegate_task', { bot: 'Kim', task: 'Tel tot drie', expected_output: 'getallen', wait: true }, [{ text: '1 2 3' }]);
    assert.match(d.msg.content, /1 2 3/);

    // The shared key (the default mock provider, no scope) works for a bot of each team.
    for (const bot of [s.A.bot, s.B.bot]) {
      const th = await t.api('POST', '/threads', { agentId: bot.id });
      t.script.push({ text: `antwoord voor ${bot.name}` });
      const msgs = await t.say(th.id, 'hallo');
      assert.ok(msgs.some((m: any) => m.role === 'assistant' && m.content === `antwoord voor ${bot.name}`), `${bot.name} answers on the shared key`);
    }
    // A team-only key works for its own team: A runs on "Sleutel A".
    const a0 = t.app.ctx.store.agent(s.A.bot.id)!;
    t.app.ctx.store.updateAgent(a0.id, { provider_id: s.A.key });
    const th = await t.api('POST', '/threads', { agentId: a0.id });
    t.script.push({ text: 'op sleutel A' });
    assert.ok((await t.say(th.id, 'hallo')).some((m: any) => m.content === 'op sleutel A'));
    t.app.ctx.store.updateAgent(a0.id, { provider_id: a0.provider_id });

    // A's prompt: its own business profile, never B's; B is not named while A has no access.
    const req = t.requests.at(-1)!;
    const lastUser = JSON.stringify(req.messages.filter((m) => m.role === 'user').at(-1)?.content);
    assert.match(lastUser, /Bedrijf A/);
    assert.doesNotMatch(lastUser + req.system, /Bedrijf B|Noem nooit prijzen/);
    assert.match(req.system, /## Teams\nJe hoort bij team “Team A”\./);
    assert.doesNotMatch(req.system, /Team B/);

    // With aansturen, A's prompt names team B and its lead.
    await setAccess(s, 'direct');
    const th2 = await t.api('POST', '/threads', { agentId: a0.id });
    t.script.push({ text: 'ok' });
    await t.say(th2.id, 'hallo');
    assert.match(t.requests.at(-1)!.system, /Je mag team “Team B” aansturen: geef de teamleider \(Bo\)/);
    // Still never B's business profile or B's team-only key in A's view.
    assert.doesNotMatch(JSON.stringify(t.requests.at(-1)!.messages), /Bedrijf B/);
  } finally {
    await done(s);
  }
});

test('teams isolation (B2): the owner sees every team, with a team filter (Teamwerk, groups, search)', async () => {
  const s = await scenario();
  try {
    const { t } = s;
    await seedB(s);
    const A = s.A.team.id;
    const B = s.B.team.id;
    // Decisions: every team by default ("Wacht op jou"), each with its team; one team with ?team=.
    const all = await t.api('GET', '/teamdata/decisions');
    const d = all.find((x: any) => x.vraag === DECISION_B);
    assert.equal(d.teamId, B);
    assert.equal(d.teamName, 'Team B');
    assert.equal(d.asker.name, 'Bo');
    assert.equal((await t.api('GET', `/teamdata/decisions?team=${A}`)).length, 0);
    assert.equal((await t.api('GET', '/teamdata/summary')).openDecisions, 1, 'the badge counts every team');
    assert.equal((await t.api('GET', `/teamdata/summary?team=${A}`)).openDecisions, 0);
    assert.equal((await t.api('GET', `/teamdata/summary?team=${B}`)).openDecisions, 1);
    // Log, events, tables and the change log per team (default: the default team, here team A).
    assert.ok((await t.api('GET', `/teamdata/log?team=${B}`)).rows.some((r: any) => r.wat === LOG_B));
    assert.ok(!(await t.api('GET', '/teamdata/log')).rows.some((r: any) => r.wat === LOG_B));
    assert.ok((await t.api('GET', `/teamdata/events?team=${B}`)).rows.some((r: any) => r.samenvatting === EVENT_B));
    const tables = await t.api('GET', `/teamdata/tables?team=${B}`);
    assert.equal(tables.find((x: any) => x.name === TABLE_B).owner.name, 'Bo');
    assert.ok(!(await t.api('GET', '/teamdata/tables')).some((x: any) => x.name === TABLE_B));
    assert.ok((await t.api('GET', `/teamdata/audit?team=${B}`)).some((x: any) => x.actor_name === 'Bo' && /CREATE/.test(x.verb)));
    await assert.rejects(t.api('GET', '/teamdata/log?team=tm_bestaat_niet'), /404/);
    // Answering: with the decision's team; without it the default team is meant (where #id does not exist).
    await assert.rejects(t.api('POST', `/teamdata/decisions/${d.id}/answer`, { choice: 0 }), /404/);
    const r = await t.api('POST', `/teamdata/decisions/${d.id}/answer`, { choice: 0, teamId: B });
    assert.equal(r.decision.status, 'gekozen');
    assert.equal(r.woke.name, 'Bo', 'B’s own bot gets the answer');
    await waitIdleAll(t);
    // Two team databases on disk: the original one for the default team, a file of its own for team B.
    const td = t.app.ctx.services.teamdata;
    assert.equal(path.basename(td.file(s.A.bot.user_id, A)), `${s.A.bot.user_id}.db`);
    assert.equal(path.basename(td.file(s.A.bot.user_id, B)), `${s.A.bot.user_id}.${B}.db`);

    // Groups: per team, and each group says whose it is.
    const groupsB = await t.api('GET', `/rooms?team=${B}`);
    assert.deepEqual(groupsB.map((g: any) => g.name), ['Groep van B']);
    assert.equal(groupsB[0].workspaceName, 'Team B');
    assert.equal(groupsB[0].crossTeam, false);
    assert.equal((await t.api('GET', `/rooms?team=${A}`)).length, 0);
    // A group can not be made with a bot of another team without the explicit choice, and with it only with access.
    await assert.rejects(t.api('POST', '/rooms', { name: 'Gemengd', agentIds: [s.B.bot.id, s.A.bot.id] }), /Ada hoort bij team “Team A” en heeft geen toegang tot team “Team B”/);
    await setAccess(s, 'read');
    await assert.rejects(t.api('POST', '/rooms', { name: 'Gemengd', agentIds: [s.B.bot.id, s.A.bot.id] }), /Zet eerst “Bots van andere teams toestaan” aan/);
    const mixed = await t.api('POST', '/rooms', { name: 'Gemengd', agentIds: [s.B.bot.id, s.A.bot.id], crossTeam: true });
    assert.equal(mixed.room.workspaceName, 'Team B', 'the lead’s team');
    assert.equal(mixed.room.crossTeam, true);
    // Other teams can not be switched off while a bot of another team takes part; taking access away makes it sit out.
    await assert.rejects(t.api('PATCH', `/rooms/${mixed.room.id}`, { crossTeam: false }), /Er doen nog bots van andere teams mee \(Ada\)/);
    await setAccess(s, 'none');
    const view = await t.api('GET', `/rooms/${mixed.room.id}`);
    assert.equal(view.bots.find((b: any) => b.agentId === s.A.bot.id).teamReach, 'none');
    // The system prompt of the group names its team (two or more teams).
    t.script.push({ text: 'Bo hier.' });
    await t.say(mixed.threadId, '@Bo hallo');
    assert.match(t.requests.at(-1)!.system, /Deze groep hoort bij team “Team B”; er doen ook bots van andere teams mee/);

    // Search: every team for the owner, one with ?team=.
    const hit = (await t.api('GET', '/search/all?q=Zonnebloemcode')).hits.find((h: any) => h.kind === 'message');
    assert.equal(hit.teamId, B);
    assert.ok((await t.api('GET', `/search/all?q=Zonnebloemcode&team=${B}`)).hits.some((h: any) => h.kind === 'message'));
    assert.ok(!(await t.api('GET', `/search/all?q=Zonnebloemcode&team=${A}`)).hits.some((h: any) => h.kind === 'message'));
    // Team folders of every team, each with its own link.
    const files = (await t.api('GET', '/search/all?q=klanten')).hits.filter((h: any) => h.kind === 'file');
    assert.ok(files.some((h: any) => h.title === 'klanten.md' && h.teamId === B && h.href.startsWith(`#/m/folders/team:${B}?`)));
  } finally {
    await done(s);
  }
});

test('teams isolation (B2): a team’s daily budget stops its run before the step that would pass it; other teams go on', async () => {
  const s = await scenario();
  try {
    const { t } = s;
    const store = t.app.ctx.store;
    // A paid mock engine: US$ 0,10 per model call (see tests/budget.test.ts).
    const priced = await t.api('POST', '/providers', { kind: 'mock', name: 'Prijsmodel', config: { prices: { '*': [6000, 8000] } } });
    for (const id of [s.A.bot.id, s.B.bot.id, s.B.helper.id]) store.updateAgent(id, { provider_id: priced.id });
    await assert.rejects(t.api('PATCH', `/teams/${s.B.team.id}`, { dailyBudgetUsd: -1 }), /400/);
    const teamB = await t.api('PATCH', `/teams/${s.B.team.id}`, { dailyBudgetUsd: 0.25 });
    assert.equal(teamB.dailyBudgetUsd, 0.25);

    // Three tool steps and an answer: two calls fit (US$ 0,20); the third would make US$ 0,30 and does not start.
    const th = await t.api('POST', '/threads', { agentId: s.B.bot.id });
    t.script.push({ toolCalls: [{ name: 'list_files', args: {} }] }, { toolCalls: [{ name: 'list_files', args: {} }] }, { toolCalls: [{ name: 'list_files', args: {} }] }, { text: 'Klaar' });
    const before = t.requests.length;
    const msgs = await t.say(th.id, 'Doe drie stappen');
    assert.equal(t.requests.length - before, 2, 'stopped before the step that would pass the team budget');
    t.script.length = 0;
    const stop = msgs.at(-1)!;
    assert.equal(stop.status, 'error');
    assert.match(stop.parts.error, /^Daglimiet van het team “Team B” bereikt: het dagbudget is US\$\s?0,25, vandaag is US\$\s?0,20 gebruikt en de volgende stap kost naar schatting US\$\s?0,10/);
    assert.match(stop.parts.error, /verhoog het dagbudget van het team dan in Instellingen › Teams\./);
    assert.equal(stop.parts.budget.team.name, 'Team B');
    assert.equal(stop.parts.budget.midRun, true);
    const run = store.one<any>('SELECT meta FROM runs WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1', th.id);
    assert.equal(JSON.parse(run.meta).budget.limit, 0.25, 'a limit, not a failure (the face says daglimiet bereikt)');
    assert.ok(Math.abs((await t.api('GET', `/teams/${s.B.team.id}`)).spentToday - 0.2) < 1e-9);

    // Another bot of team B: US$ 0,05 left, so its first call (no estimate yet) runs; then the team budget is used up.
    store.insert('usage_log', { user_id: s.A.bot.user_id, agent_id: s.B.helper.id, provider_id: priced.id, model: 'x', input: 0, output: 0, cost: 0.05, created_at: new Date().toISOString() });
    const thk = await t.api('POST', '/threads', { agentId: s.B.helper.id });
    const n = t.requests.length;
    const k = await t.say(thk.id, 'hallo');
    assert.equal(t.requests.length, n, 'no model call for team B any more');
    assert.match(k.at(-1)!.parts.error, /^Daglimiet van het team “Team B” bereikt: vandaag is US\$\s?0,25 van US\$\s?0,25 gebruikt\./);

    // Team A has no budget of its own: its bot goes on, on the same engine, the same day.
    const tha = await t.api('POST', '/threads', { agentId: s.A.bot.id });
    t.script.push({ text: 'A werkt door' });
    assert.ok((await t.say(tha.id, 'hallo')).some((m: any) => m.role === 'assistant' && m.content === 'A werkt door'));
    // Raising the team budget lets team B go on at once.
    await t.api('PATCH', `/teams/${s.B.team.id}`, { dailyBudgetUsd: 5 });
    t.script.push({ text: 'Bo weer aan het werk' });
    assert.ok((await t.say(th.id, 'verder')).some((m: any) => m.content === 'Bo weer aan het werk'));
  } finally {
    await done(s);
  }
});

test('teams isolation (memory): B’s own bots read and write B’s memory; rules per team; “alle teams” for every bot; the owner sees all', async () => {
  const s = await scenario();
  try {
    const { t } = s;
    const m = await memB(s);
    const store = t.app.ctx.store;
    // B's own bot (not the lead): reads B's knowledge, by words and by meaning, and B's documents.
    const kimTool = async (name: string, args: any) => String((await tool(t, s.B.helper.id, name, args)).msg?.content || '');
    assert.match(await kimTool('memory_search', { query: 'België' }), /levert alleen in België/);
    assert.match(await kimTool('memory_search', { query: 'wagen' }), /Volvo/);
    assert.match(await kimTool('dossier_get', { dossier: `d:${m.dossier.ref}`, query: 'korting' }), /twaalf procent/);
    // … and writes there: a note and a decision in B's dossier, shared knowledge in team B.
    await kimTool('dossier_add', { dossier: `d:${m.dossier.ref}`, kind: 'decision', title: 'Zwaluw krijgt voorrang' });
    assert.ok(store.one('SELECT 1 FROM memory_records WHERE dossier_id = ? AND title = ?', m.dossier.id, 'Zwaluw krijgt voorrang'));
    await kimTool('memory_remember', { content: 'Kim weet: de levering naar Zwaluw gaat op vrijdag', scope: 'dossier', dossier: `d:${m.dossier.ref}` });
    assert.ok(store.one("SELECT 1 FROM memory_items WHERE dossier_id = ? AND content LIKE '%op vrijdag%'", m.dossier.id));
    await kimTool('memory_remember', { content: 'Kim deelt: magazijn B sluit om vijf uur', scope: 'shared' });
    assert.equal(store.one<any>("SELECT team_id FROM memory_items WHERE content LIKE 'Kim deelt%'")?.team_id, s.B.team.id, 'a bot shares within its own team');

    // Rules: B's rule for B's bots only; a rule "voor alle teams" and the owner's own ("Over jou") for every bot.
    await t.api('POST', '/memory/items', { content: 'Regel voor alle teams: schrijf altijd in het Nederlands', scope: 'shared', teamId: '*', type: 'instruction', pinned: true });
    await t.api('POST', '/memory/items', { content: 'Vraag eerst voordat je iets verwijdert', scope: 'about_you', type: 'instruction', pinned: true });
    const systemOf = async (bot: any) => {
      const th = await t.api('POST', '/threads', { agentId: bot.id });
      t.script.push({ text: 'ok' });
      await t.say(th.id, 'Hallo');
      return t.requests.at(-1)!.system;
    };
    const sysB = await systemOf(s.B.helper);
    assert.ok(sysB.includes(MEM.rule) && sysB.includes('schrijf altijd in het Nederlands') && sysB.includes('Vraag eerst voordat je iets verwijdert'));
    for (const level of ['none', 'read', 'direct'] as const) {
      await setAccess(s, level);
      const sysA = await systemOf(s.A.bot);
      assert.ok(!sysA.includes(MEM.rule), `B’s rule is not A’s (${level})`);
      assert.ok(sysA.includes('schrijf altijd in het Nederlands') && sysA.includes('Vraag eerst voordat je iets verwijdert'), `owner-wide rules apply to A (${level})`);
      if (level === 'none') assert.doesNotMatch(sysA, /Team B/, 'without access team B is not named at all');
    }
    // Knowledge "voor alle teams": both read it; neither bot may change it (that is the owner's).
    const all = (await t.api('POST', '/memory/items', { content: 'Alle teams: de huisstijlkleur is groen', scope: 'shared', teamId: '*' })).item;
    await setAccess(s, 'none');
    assert.match(String((await tool(t, s.A.bot.id, 'memory_search', { query: 'huisstijlkleur' })).msg.content), /huisstijlkleur is groen/);
    assert.match(await kimTool('memory_search', { query: 'huisstijlkleur' }), /huisstijlkleur is groen/);
    assert.match(String((await tool(t, s.A.bot.id, 'memory_update', { id: `m:${all.ref}`, content: 'Alle teams: de huisstijlkleur is paars' })).msg.content), /geldt voor alle teams/);
    assert.equal(store.one<any>("SELECT COUNT(*) AS n FROM memory_items WHERE content LIKE '%huisstijlkleur is paars%'")?.n, 0);

    // The owner sees everything, and can filter on a team.
    const listB = await t.api('GET', `/memory/items?teamId=${s.B.team.id}`);
    assert.ok(listB.items.some((i: any) => i.content === MEM.shared) && listB.items.every((i: any) => i.team?.id === s.B.team.id), 'team filter B');
    const listA = await t.api('GET', `/memory/items?teamId=${s.A.team.id}`);
    assert.ok(!listA.items.some((i: any) => i.content === MEM.shared), 'B’s knowledge is not under team A');
    const ds = await t.api('GET', `/memory/dossiers?teamId=${s.A.team.id}`);
    assert.ok(!ds.some((d: any) => d.id === m.dossier.id));
    const search = await t.api('GET', `/memory/search?q=${encodeURIComponent('België')}`);
    assert.ok(search.items.some((i: any) => i.content === MEM.shared), 'the owner finds all');
    const searchA = await t.api('GET', `/memory/search?q=${encodeURIComponent('België')}&teamId=${s.A.team.id}`);
    assert.ok(!searchA.items.length);
  } finally {
    await done(s);
  }
});

test('teams isolation (B2): usage per team, with the bots of each team as children', async () => {
  const s = await scenario();
  try {
    const { t } = s;
    const owner = s.A.bot.user_id;
    const log = (agent: string | null, tokens: number, cost: number) =>
      t.app.ctx.store.insert('usage_log', { user_id: owner, agent_id: agent, provider_id: t.providerId, model: 'm', input: tokens, output: 0, cost, value: null, created_at: new Date().toISOString() });
    log(s.A.bot.id, 100, 0.01);
    log(s.B.bot.id, 200, 0.02);
    log(s.B.helper.id, 300, 0.03);
    log(null, 5, 0);
    const r = await t.api('GET', '/usage/breakdown?by=team');
    assert.equal(r.by, 'team');
    assert.deepEqual(r.groupings, ['bot', 'team']);
    assert.deepEqual(
      r.rows.map((x: any) => [x.kind, x.name]),
      [
        ['team', 'Team A'],
        ['team', 'Team B'],
        ['none', null],
      ],
    );
    const [a, b, none] = r.rows;
    assert.deepEqual(a.children.map((c: any) => c.name), ['Ada']);
    assert.deepEqual(b.children.map((c: any) => c.name).sort(), ['Bo', 'Kim']);
    assert.equal(b.today.tokens, 500);
    assert.ok(Math.abs(b.week.cost - 0.05) < 1e-9);
    assert.deepEqual(b.engines.map((e: any) => [e.providerId, e.today.tokens]), [[t.providerId, 500]]);
    assert.equal(none.today.tokens, 5);
    assert.equal(r.total.today.tokens, 605);
    // The same shape as per bot.
    for (const k of ['key', 'kind', 'id', 'name', 'today', 'week', 'engines']) assert.ok(k in b, k);
    await assert.rejects(t.api('GET', '/usage/breakdown?by=afdeling'), /400/);
  } finally {
    await done(s);
  }
});

test('teams isolation (B2): an update from 0.3 files the team database and the groups under the default team', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-b2-up-'));
  // 0.3: the same app without the teams module.
  const old = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true, modules: allModules.filter((m) => m.id !== 'teams') });
  const token = old.ctx.auth.ensureLocalOwner();
  const owner = old.ctx.store.users()[0].id;
  const chef = old.ctx.store.createAgent(owner, { name: 'Chef' });
  const helper = old.ctx.store.createAgent(owner, { name: 'Helper' });
  const td0 = old.ctx.services.teamdata;
  await td0.write(owner, [{ sql: 'INSERT INTO beslissingen (vraag, opties, gevraagd_door) VALUES (?, ?, ?)', params: ['Oude vraag?', '["Ja","Nee"]', 'Chef'] }]);
  await td0.run(owner, { type: 'agent', id: chef.id, name: 'Chef' }, 'CREATE TABLE eigen (x TEXT)', [], 'execute');
  const res = await fetch(old.url + '/api/rooms', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Oude groep', agentIds: [chef.id, helper.id] }) });
  const room = ((await res.json()) as any).room;
  assert.equal(old.ctx.store.one<any>('SELECT workspace_id FROM rooms WHERE id = ?', room.id).workspace_id, null);
  await old.close();

  let app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
  try {
    const st = app.ctx.store;
    const teams = st.find<any>('teams', { user_id: owner });
    assert.equal(teams.length, 1);
    const mine = teams[0].id;
    // The team database from before teams is the default team's, with everything TeamBot kept about it.
    assert.equal(st.getSetting(owner, 'teamdata.legacyTeam', null), mine);
    const td = app.ctx.services.teamdata;
    assert.equal(path.basename(td.file(owner)), `${owner}.db`);
    const ds = await td.decisions(owner);
    assert.deepEqual(
      ds.map((x: any) => [x.vraag, x.teamName, x.asker?.name]),
      [['Oude vraag?', 'Mijn team', 'Chef']],
    );
    assert.equal((await td.tables(owner)).find((x: any) => x.name === 'eigen').owner.name, 'Chef');
    for (const tbl of ['teamdata_tables', 'teamdata_audit']) assert.equal(st.one<any>(`SELECT COUNT(*) AS n FROM ${tbl} WHERE team_id = ''`).n, 0, `${tbl}: nothing left without a team`);
    // Chef still owns his table in his team (only he may drop it).
    const drop = await td.run(owner, { type: 'agent', id: chef.id, name: 'Chef' }, 'DROP TABLE eigen', [], 'execute');
    assert.deepEqual(drop.dropped, ['eigen']);
    // The group belongs to the default team, without other teams.
    const r = st.get<any>('rooms', room.id);
    assert.equal(r.workspace_id, mine);
    assert.notEqual(r.settings?.crossTeam, true);
    // A second start changes nothing.
    await app.close();
    app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
    assert.equal(app.ctx.store.getSetting(owner, 'teamdata.legacyTeam', null), mine);
    assert.equal(app.ctx.store.get<any>('rooms', room.id).workspace_id, mine);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('teams isolation (B4): B’s own bots use B’s channel, skill and routine; the owner filters per team; “voor alle teams”; the chain per team; a channel moves with its bot', async () => {
  const s = await scenario();
  try {
    const { t } = s;
    const store = t.app.ctx.store;
    const b4 = await seedB4(s);
    const A = s.A.team.id;
    const B = s.B.team.id;
    await setAccess(s, 'none');

    // B's own bot sends through B's channel and loads B's skill.
    await t.api('PUT', `/channels/agents/${s.B.bot.id}/send-rules/owner`, { enabled: true });
    const before = b4.fake.sentTo.length + b4.fake.sent.length;
    const sent = await withGroup(s, 'channels', () => tool(t, s.B.bot.id, 'channel_send', { binding: 'Telegram van B', to: 'eigenaar', text: 'Rapport van Bo' }), s.B.bot.id);
    assert.match(sent.msg.content, /^Verstuurd via Nepkanaal naar je eigenaar/);
    assert.equal(b4.fake.sentTo.length + b4.fake.sent.length, before + 1);
    const load = await withGroup(s, 'skills', () => tool(t, s.B.bot.id, 'skill_load', { name: 'klant-b' }), s.B.bot.id);
    assert.ok(load.msg.content.includes(SKILL_B));
    // A chat trigger of B's routine on "every chat channel" does fire on B's channel.
    const rb = await t.api('POST', '/routines', { name: 'Bij elk bericht B', agent_id: s.B.bot.id, prompt: 'Lees het bericht.', schedule: { kind: 'none' } });
    await t.api('POST', `/routines/${rb.id}/triggers`, { kind: 'chat', name: 'Elk chatbericht', config: { bindingId: '', senders: 'allowlist', match: 'any', botReplies: true } });
    const got = await t.app.ctx.services.channels.manager.receive(b4.chB.id, { messageId: `klant-ok-${Date.now()}`, conversation: { id: 'klant-b', title: CONV_B, private: true }, sender: { id: 'klant-b', name: 'Jansen' }, text: 'Hallo' });
    await waitIdleAll(t);
    assert.deepEqual(got.routines, ['Bij elk bericht B'], 'B’s routine, never A’s');
    // A chat trigger for A's routine on B's channel itself is refused when it is set up.
    await assert.rejects(t.api('POST', `/routines/${b4.routineA.id}/triggers`, { kind: 'chat', config: { bindingId: b4.chB.id, match: 'any' } }), /Kanaal “Telegram van B” hoort bij team “Team B”/);
    // Enabling B's skill for A without access is not possible; the owner's list for A's bot leaves it out.
    const forA = await t.api('GET', `/skills/agents/${s.A.bot.id}`);
    assert.ok(!forA.skills.some((x: any) => x.name === 'klant-b'), 'A’s bot does not see B’s skill in its list');
    const put = await t.api('PUT', `/skills/agents/${s.A.bot.id}`, { skillIds: [b4.skill] });
    assert.ok(!put.enabled.includes(b4.skill));

    // The owner sees everything, with a team filter.
    assert.deepEqual((await t.api('GET', '/channels/bindings')).map((b: any) => b.name).sort(), ['Telegram van A', 'Telegram van B']);
    assert.deepEqual((await t.api('GET', `/channels/bindings?teamId=${A}`)).map((b: any) => b.name), ['Telegram van A']);
    assert.deepEqual((await t.api('GET', `/channels/bindings?teamId=${B}`)).map((b: any) => b.name), ['Telegram van B']);
    const skillsA = (await t.api('GET', `/skills?teamId=${A}`)).map((x: any) => x.name);
    const skillsB = (await t.api('GET', `/skills?teamId=${B}`)).map((x: any) => x.name);
    assert.ok(!skillsA.includes('klant-b') && skillsB.includes('klant-b') && skillsB.includes('script-b'));
    assert.equal((await t.api('GET', '/skills')).find((x: any) => x.name === 'klant-b').teamName, 'Team B');
    const routinesA = (await t.api('GET', `/routines?teamId=${A}`)).map((r: any) => r.name);
    assert.ok(routinesA.includes('Weekrapport A') && !routinesA.includes('Klantenrapport B'));
    assert.equal((await t.api('GET', `/routines?teamId=${B}`)).find((r: any) => r.name === 'Klantenrapport B').teamName, 'Team B');
    // A failed run of B's routine is in B's overview, not in A's.
    store.insert('routine_runs', { id: 'rr_b4_err', routine_id: b4.routineB.id, user_id: s.A.bot.user_id, run_key: `rr_b4_err@${Date.now()}`, trigger: 'manual', status: 'error', attempt: 1, max_attempts: 1, error: 'kapot', meta: {}, created_at: new Date().toISOString() });
    assert.ok((await t.api('GET', `/routines/attention?teamId=${B}`)).items.some((x: any) => x.id === 'rr_b4_err'));
    assert.ok(!(await t.api('GET', `/routines/attention?teamId=${A}`)).items.some((x: any) => x.id === 'rr_b4_err'));
    assert.equal((await t.api('GET', `/routines/runs/summary?teamId=${A}`)).counts.error ?? 0, 0);
    assert.equal((await t.api('GET', `/routines/runs/summary?teamId=${B}`)).counts.error, 1);
    assert.ok(!(await t.api('GET', `/routines/runs?teamId=${A}`)).some((x: any) => x.id === 'rr_b4_err'));
    await assert.rejects(t.api('GET', '/routines?teamId=tm_bestaat_niet'), /404/);
    // A routine result of A can only go to A's channels.
    const targets = await t.api('GET', `/routines/channel-targets?agentId=${s.A.bot.id}`);
    assert.deepEqual(targets.bindings.map((b: any) => b.name), ['Telegram van A']);

    // "Voor alle teams": the owner's choice; then A's bot (without access to B) uses it too.
    const moved = await t.api('PATCH', `/skills/${b4.skill}`, { teamId: '*' });
    assert.deepEqual([moved.allTeams, moved.teamId], [true, null]);
    // Now the owner can give it to A's bot (refused above while it was team B's).
    assert.ok((await t.api('PUT', `/skills/agents/${s.A.bot.id}`, { skillIds: [b4.skill] })).enabled.includes(b4.skill));
    const loadA = await withGroup(s, 'skills', () => tool(t, s.A.bot.id, 'skill_load', { name: 'klant-b' }));
    assert.ok(loadA.msg.content.includes(SKILL_B), 'a skill for all teams reaches every team');
    await t.api('PATCH', `/skills/${b4.skill}`, { teamId: B });
    assert.equal((await t.api('GET', `/skills/${b4.skill}`)).teamId, B);

    // Customer mode: the approved knowledge can include the channel's own team profile, never another team's.
    const m = t.app.ctx.services.channels.manager;
    const items = m.knowledgeFor(m.binding(b4.chB.id), { knowledge: 'Levering binnen 2 werkdagen.', profile: true }).map((k: any) => `${k.id} ${k.text}`);
    assert.deepEqual(items, ['K1 Levering binnen 2 werkdagen.', 'K2 Bedrijf: Bedrijf B', 'K3 Regel: Noem nooit prijzen.']);
    assert.equal(m.knowledgeFor(m.binding(b4.chB.id), { knowledge: 'Levering binnen 2 werkdagen.', profile: false }).length, 1, 'off by default');

    // The engine chain per team: team B's own setting counts for B's bots (no group: the bot's home team).
    const ec = t.app.ctx.services.engineChain;
    assert.equal(ec.teamOf(null, s.B.bot), B);
    const r = await t.api('PUT', `/engine-chain/settings/teams/${B}`, { enabled: false });
    assert.deepEqual([r.settings.enabled, r.override], [false, { enabled: false }]);
    assert.equal(ec.chainOn(store.agent(s.B.bot.id)), false);
    assert.equal(ec.chainOn(store.agent(s.A.bot.id)), true, 'team A keeps the general setting');
    assert.deepEqual((await t.api('GET', '/engine-chain/settings')).teams, { [B]: { enabled: false } });
    await t.api('DELETE', `/engine-chain/settings/teams/${B}`);
    assert.equal(ec.chainOn(store.agent(s.B.bot.id)), true);
    await assert.rejects(t.api('PUT', '/engine-chain/settings/teams/tm_bestaat_niet', { enabled: false }), /404/);

    // A bot that moves to another team takes its channel along.
    await t.api('PUT', `/teams/${A}/bots/${s.B.bot.id}`);
    await until(() => store.get<any>('channel_bindings', b4.chB.id)?.team_id === A);
    assert.equal((await t.api('GET', `/channels/bindings/${b4.chB.id}`)).teamName, 'Team A');
  } finally {
    await done(s);
  }
});

test('teams isolation (B4): an update files channels and skills under their team, with the same visibility as before', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-b4-up-'));
  // Before B4: the app without the teams module and without the skills migration of B4 (skills-005).
  const oldModules = allModules.filter((m) => m.id !== 'teams').map((m) => (m.id === 'skills' ? { ...m, migrations: (m.migrations || []).filter((x) => x.id !== 'skills-005') } : m));
  const old = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true, modules: oldModules });
  old.ctx.auth.ensureLocalOwner();
  const owner = old.ctx.store.users()[0].id;
  const chef = old.ctx.store.createAgent(owner, { name: 'Chef' });
  const ts = new Date().toISOString();
  old.ctx.store.insert('channel_bindings', { id: 'ch_oud', user_id: owner, adapter: 'telegram', name: 'Oude Telegram', agent_id: chef.id, room_id: null, config: {}, secret_ids: {}, state: {}, enabled: false, status: 'stopped', last_error: null, last_ok_at: null, health: {}, created_at: ts, updated_at: ts });
  const lib0 = old.ctx.services.skills.library;
  const files = new Map([['SKILL.md', Buffer.from('---\nname: oude-skill\ndescription: Van voor teams\n---\nDoe het zo.\n', 'utf8')]]);
  const sk = lib0.create(owner, files, analyzeSkill(files, 'oude-skill'), { source: { type: 'paste' }, createdBy: 'test' });
  assert.equal(sk.install_scope, 'user', 'before B4 every install was for the whole user');
  old.ctx.store.updateAgent(chef.id, { skills: [sk.id] });
  assert.equal(old.ctx.store.get<any>('channel_bindings', 'ch_oud').team_id ?? null, null);
  await old.close();

  const app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
  try {
    const st = app.ctx.store;
    const mine = st.find<any>('teams', { user_id: owner })[0].id;
    assert.equal(st.get<any>('channel_bindings', 'ch_oud').team_id, mine, 'the channel is in the team of its bot');
    const row = st.get<any>('skills', sk.id);
    assert.deepEqual([row.install_scope, row.team_id], ['team', mine], 'the skill is in the default team');
    const lib = app.ctx.services.skills.library;
    assert.deepEqual(lib.enabledFor(st.agent(chef.id)!).map((x: any) => x.name), ['oude-skill'], 'Chef keeps his skill');
    // A second team whose bot already used a skill from before (dev builds of 0.4 had teams before B4): that skill
    // becomes "voor alle teams", so no bot loses one.
    const two = app.ctx.services.teams.create(owner, { name: 'Tweede team' });
    const bo = st.createAgent(owner, { name: 'Bo' });
    app.ctx.services.teams.setHome(owner, two.id, bo.id);
    const f2 = new Map([['SKILL.md', Buffer.from('---\nname: gedeeld\ndescription: Door twee teams gebruikt\n---\nSamen.\n', 'utf8')]]);
    const shared = lib.create(owner, f2, analyzeSkill(f2, 'gedeeld'), { source: { type: 'paste' }, createdBy: 'test' });
    st.exec("UPDATE skills SET install_scope = 'team', team_id = NULL WHERE id = ?", shared.id);
    st.updateAgent(chef.id, { skills: [sk.id, shared.id] });
    st.updateAgent(bo.id, { skills: [shared.id] });
    assert.equal(lib.upgradeTeams(), 1);
    assert.deepEqual([st.get<any>('skills', shared.id).install_scope, st.get<any>('skills', shared.id).team_id], ['user', null]);
    assert.deepEqual(lib.enabledFor(st.agent(bo.id)!).map((x: any) => x.name), ['gedeeld']);
    assert.equal(lib.upgradeTeams(), 0, 'nothing changes twice');
    // Names are per team now: the second team may have its own "oude-skill", but not one for all teams next to them.
    const own = lib.create(owner, files, analyzeSkill(files, 'oude-skill'), { source: { type: 'paste' }, createdBy: 'test', placement: { scope: 'team', teamId: two.id } });
    assert.equal(own.team_id, two.id);
    assert.throws(() => lib.create(owner, files, analyzeSkill(files, 'oude-skill'), { source: { type: 'paste' }, createdBy: 'test' }), /al een skill met de naam "oude-skill"/);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
