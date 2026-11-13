// The one planner on every kind of AI (12 nov 2026). "Doe dit elk uur" in the chat, then one sentence to change it and
// one to stop it: the bot's tools for making, changing and stopping a planned thing (routine_create, teambot_do) end
// in the same planner and the same list whatever engine the bot runs on, and the planner starts the run on that
// engine. One test per route, with the scripted engines of the tests:
//  - a model through an API key (the mock provider) and a local model (a fake Ollama): the model's own tool calls in
//    a chat turn the owner started;
//  - Claude Code, Codex and OpenCode/ACP (the fake CLIs): the tool calls through TeamBot's tool host of that engine
//    (what its MCP bridge passes on), and the planned run in the real fake CLI process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { startTestApp, type TestApp } from './helpers.js';
import { modules as allModules } from '../server/modules/index.js';
import { createRoutinesModule } from '../server/modules/routines/index.js';
import { makeScope } from '../server/modules/cli-agents/context.js';
import { teambotTools } from '../server/modules/cli-agents/toolhost.js';
import { CALL_NAME } from '../server/tools/selection.js';
import type { RoutineEngine } from '../server/modules/routines/engine.js';
import type { Planned } from '../server/modules/routines/planner.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(here, 'fixtures', 'cli-agents-fake-claude.mjs');
const FAKE_CODEX = path.join(here, 'fixtures', 'cli-agents-fake-codex.mjs');
const FAKE_ACP = path.join(here, 'fixtures', 'cli-agents-fake-acp.mjs');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
const NAME = 'Elk uur de post';
const TASK = 'Kijk of er post is en meld het kort.';

type Step = { text?: string; tool?: { name: string; args: any } };

/** A local model: an Ollama that answers with what the test scripted (text, or one tool call), over the OpenAI-compatible route. */
async function fakeOllama() {
  const steps: Step[] = [];
  const chats: string[] = [];
  const s = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      const send = (x: any) => (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify(x)));
      if (req.url === '/api/version') return send({ version: '0.40.15' });
      if (req.url === '/api/tags') return send({ models: [{ name: 'qwen3:4b', digest: 'q', details: { parameter_size: '4B', context_length: 40960 }, capabilities: ['completion', 'tools'] }] });
      if (req.url === '/api/ps') return send({ models: [{ name: 'qwen3:4b', context_length: 40960 }] });
      if (req.url === '/api/show') return send({ model_info: {}, capabilities: ['completion', 'tools'] });
      if (req.url === '/v1/models') return send({ data: [{ id: 'qwen3:4b' }] });
      if (req.url === '/v1/chat/completions') {
        chats.push(b);
        const step = steps.shift() || { text: 'ok' };
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (x: any) => res.write(`data: ${JSON.stringify(x)}\n\n`);
        if (step.tool) {
          chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${chats.length}`, type: 'function', function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }] } }] });
          chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 4 } });
        } else {
          chunk({ choices: [{ index: 0, delta: { content: step.text ?? 'ok' } }] });
          chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 4 } });
        }
        return res.end('data: [DONE]\n\n');
      }
      res.writeHead(404);
      res.end('{}');
    });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, steps, chats, close: () => new Promise<void>((r) => s.close(() => r())) };
}

interface Bot {
  agent: any;
  /** The bot uses one of its tools in a turn the owner started ("doe dit elk uur" …). Returns what the tool answered. */
  use(name: string, args: any): Promise<string>;
  /** Script the answer of the planned run. */
  answer(text: string): void;
  /** Everything this engine was sent (to find the routine's task in it). */
  sent(): string;
}

interface RouteDef {
  label: string;
  bot(t: TestApp, log: string, cleanup: (() => Promise<void>)[]): Promise<Bot>;
}

/** A model that calls tools itself (API key, local): the tool call is the model's, in a real chat turn of the owner. */
async function apiBot(t: TestApp, agent: any, push: (...s: Step[]) => void, sent: () => string): Promise<Bot> {
  const ctx = t.app.ctx;
  return {
    agent,
    async use(name, args) {
      const th = ctx.chat.threadForAgent(agent.user_id, agent.id);
      push({ tool: { name: CALL_NAME, args: { name, args } } }, { text: 'Gedaan.' });
      const msgs = await t.say(th.id, 'Doe dit voor mij.', 30_000);
      return String(msgs.filter((m: any) => m.role === 'tool').at(-1)?.content || '');
    },
    answer: (text) => push({ text }),
    sent,
  };
}

/** A CLI engine: its tool calls reach TeamBot through the tool host of that engine (what the MCP bridge passes on). */
async function cliBot(t: TestApp, kind: string, config: any, engine: 'claude' | 'codex' | 'acp', log: string): Promise<Bot> {
  const ctx = t.app.ctx;
  const p = await t.api('POST', '/providers', { kind, config });
  const agent = await t.api('POST', '/agents', { name: 'Postbode', provider_id: p.id, model: '', access_mode: 'full' });
  return {
    agent,
    async use(name, args) {
      // A turn the owner started in his chat with this bot; the engine calls the tool during it.
      const a = ctx.store.agent(agent.id)!;
      const th = ctx.chat.threadForAgent(a.user_id, a.id);
      const input = ctx.store.createMessage({ thread_id: th.id, role: 'user', author_type: 'user', author_id: a.user_id, author_name: 'Ik', content: 'Doe dit voor mij.' } as any);
      const run = ctx.store.createRun({ thread_id: th.id, agent_id: a.id, user_id: a.user_id, status: 'running', trigger: 'user', input_message_id: input.id, meta: {} });
      try {
        const scope = makeScope(ctx, ctx.providers.config(p.id)!, { model: '', system: '', prompt: 'Doe dit voor mij.', attachments: [], workspace: a.workspace, accessMode: a.access_mode, agentId: a.id, threadId: th.id, runId: run.id, userId: a.user_id }, new AbortController().signal, () => {});
        const r = await teambotTools(scope, { engine }).call(CALL_NAME, { name, args }, new AbortController().signal);
        return String(r.content?.[0]?.text || '');
      } finally {
        ctx.store.updateRun(run.id, { status: 'done', finished_at: new Date().toISOString() });
      }
    },
    answer: () => {},
    sent: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''),
  };
}

const ROUTES: RouteDef[] = [
  {
    label: 'a model through an API key',
    async bot(t) {
      const agent = await t.agent({ name: 'Postbode', access_mode: 'full' });
      return apiBot(t, agent, (...s) => void t.script.push(...s.map((x) => (x.tool ? { toolCalls: [{ name: x.tool.name, args: x.tool.args }] } : { text: x.text }))), () => JSON.stringify(t.requests));
    },
  },
  {
    label: 'a local model (Ollama)',
    async bot(t, _log, cleanup) {
      const ol = await fakeOllama();
      cleanup.push(ol.close);
      const p = await t.api('POST', '/providers', { kind: 'ollama', base_url: `${ol.url}/v1` });
      const agent = await t.api('POST', '/agents', { name: 'Postbode', provider_id: p.id, model: 'qwen3:4b', access_mode: 'full' });
      return apiBot(t, agent, (...s) => void ol.steps.push(...s), () => ol.chats.join('\n'));
    },
  },
  { label: 'Claude Code', bot: (t, log) => cliBot(t, 'claude-code', { path: FAKE_CLAUDE }, 'claude', log) },
  { label: 'Codex', bot: (t, log) => cliBot(t, 'codex-cli', { path: FAKE_CODEX }, 'codex', log) },
  { label: 'OpenCode/ACP', bot: (t, log) => cliBot(t, 'acp-custom', { command: FAKE_ACP, args: [] }, 'acp', log) },
];

for (const route of ROUTES) {
  test(`${route.label}: "doe dit elk uur" is planned and runs on that engine; one sentence changes it and one stops it; work that lies there starts on it too`, async () => {
    // A Monday on the planner's own clock, at least two days from now (every real timestamp is in the past on it).
    let day = Math.floor((Date.now() + 2 * DAY) / DAY) * DAY;
    while (new Date(day).getUTCDay() !== 1) day += DAY;
    const clock = { now: day + 5 * HOUR };
    const t = await startTestApp({ modules: allModules.map((m) => (m.id === 'routines' ? createRoutinesModule({ clock: () => clock.now, tickMs: 0 }) : m)) });
    const log = path.join(t.dir, 'fake-cli.log');
    process.env.FAKE_CLI_LOG = log;
    const cleanup: (() => Promise<void>)[] = [];
    try {
      const ctx = t.app.ctx;
      const userId = ctx.auth.owner()!.id;
      ctx.store.setSetting(userId, 'timezone', 'UTC');
      const engine: RoutineEngine = ctx.services.routines.engine;
      const bot = await route.bot(t, log, cleanup);
      // The same list also holds the memory's review of the bot's conversations (memory/index.ts) and the automatic backup
      // of the installation (backups/index.ts): not what this is about.
      const planned = async (): Promise<Planned[]> => (await t.api('GET', '/routines/planned')).planned.filter((p: Planned) => p.kind !== 'learning' && p.kind !== 'backup');
      const runs = () => ctx.store.all<any>("SELECT trigger, status, error FROM runs WHERE agent_id = ? AND trigger = 'routine' ORDER BY created_at, rowid", bot.agent.id);
      const to = async (ms: number) => {
        clock.now = ms;
        engine.tick();
        await engine.idle(60_000);
      };

      // "Doe dit elk uur": the bot makes the routine with its own tool. It is in the one list, with its first time.
      const made = await bot.use('routine_create', { name: NAME, prompt: TASK, schedule_kind: 'interval', every_minutes: 60 });
      assert.match(made, /Routine “Elk uur de post” staat aan/, made);
      let list = await planned();
      assert.deepEqual(list.map((p) => [p.kind, p.title, p.agentId, p.model]), [['routine', NAME, bot.agent.id, true]]);
      const first = Date.parse(list[0].at!);
      assert.ok(first > clock.now && first <= clock.now + HOUR, `within the hour: ${list[0].at}`);

      // Not before its time; at its time the one planner starts it, on this engine.
      await to(first - MIN);
      assert.deepEqual(runs(), []);
      bot.answer('Er is geen post.');
      await to(first + 1000);
      assert.deepEqual(runs().map((r) => [r.status, r.error]), [['done', null]], 'the planned run ran on this engine');
      assert.ok(bot.sent().includes('Kijk of er post is en meld het kort.'), 'the engine was given the task of the routine');
      assert.equal((await planned())[0].at, iso(first + HOUR), 'the next hour is planned');

      // One sentence to change it ("doe het voortaan elke twee uur"): the same list shows the new time.
      // (A bot changes and stops what is planned the way the owner does in the screens: teambot_do, teams/manage.ts.)
      const id = list[0].id;
      const changed = await bot.use('teambot_do', { method: 'PATCH', path: `/routines/${id}`, body: { schedule: { kind: 'interval', everyMinutes: 120, anchor: iso(first + 3 * HOUR) } } });
      list = await planned();
      assert.deepEqual(list.map((p) => [p.kind, p.at]), [['routine', iso(first + 3 * HOUR)]], changed);
      await to(first + HOUR + MIN);
      assert.equal(runs().length, 1, 'the old hour no longer starts it');

      // One sentence to stop it: it leaves the list and does not start again.
      const stopped = await bot.use('teambot_do', { method: 'POST', path: `/routines/${id}/pause` });
      assert.deepEqual(await planned(), [], stopped);
      await to(first + 3 * HOUR + MIN);
      await to(first + 5 * HOUR + MIN);
      assert.equal(runs().length, 1, 'stopped: nothing starts');
      assert.equal(ctx.store.one<any>("SELECT COUNT(*) n FROM routine_runs WHERE status NOT IN ('done')")!.n, 0, 'and nothing was missed, skipped or failed on the way');

      // Work that lies there (a task with this bot as its owner): the same planner starts that turn on this engine,
      // and the engine is given the list. (The board first hands the task over in a turn of its own; the bot does
      // not finish it there, so it is still open at the planner's next look.)
      const work = ctx.services.routines.work;
      const idle = async () => {
        for (let quiet = 0, i = 0; quiet < 3 && i < 2400; i++) {
          await work.idle();
          quiet = ctx.runs.activeRuns().length ? 0 : quiet + 1;
          await new Promise((r) => setTimeout(r, 25));
        }
      };
      work.enabled = true;
      await t.api('POST', '/rooms/tasks', { title: 'Sitemap nalopen', owner: 'Postbode' });
      await idle();
      const turns = () => ctx.store.all<any>("SELECT status FROM runs WHERE agent_id = ? AND trigger = 'work'", bot.agent.id).map((r) => r.status);
      assert.deepEqual(turns(), [], 'not before the planner looks');
      assert.deepEqual((await planned()).map((p) => [p.kind, p.agentId, p.model]), [['work', bot.agent.id, true]]);
      bot.answer('De sitemap mist twee pagina’s.');
      await to(clock.now + 2 * MIN);
      await idle();
      assert.deepEqual(turns(), ['done'], 'the work turn ran on this engine');
      const sent = bot.sent();
      assert.ok(sent.includes('Op jouw naam:') && sent.includes('Sitemap nalopen'), 'the engine was given the work that lies there');
    } finally {
      delete process.env.FAKE_CLI_LOG;
      await t.close();
      for (const c of cleanup) await c().catch(() => {});
    }
  });
}
