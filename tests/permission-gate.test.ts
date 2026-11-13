import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownerTurn, startTestApp, type TestApp } from './helpers.js';
import { executeTool } from '../server/tools/execute.js';
import { acpAppTool, claudeToolRisk, commandOf, gate, otherToolRisk, pathsOf, type GateRequest } from '../server/modules/cli-agents/permissions.js';
import { STARTER_RULES } from '../server/modules/teams/service.js';
import { resetCodexReadGuard } from '../server/modules/cli-agents/codex-sandbox.js';
import { refuseReadOf } from '../server/tools/builtin/files.js';
import type { Agent, ToolDef } from '../server/core/types.js';

/**
 * The permission gate as one table: what happens to the same step, whichever way it arrives.
 *
 * Ways in: a tool call of a model over an API key or a local model (`executeTool`, also the way TeamBot's own tools
 * arrive from a CLI engine), the permission prompt of Claude Code, the approval request of Codex and the permission
 * request of an ACP engine (OpenCode and the like). The first two columns are called here directly; the engines are
 * run for real with the scripted CLIs of tests/fixtures, which ask for every step of the table in one turn: their own
 * tools, Codex's elicitation, and TeamBot's tools through TeamBot's MCP server. A model over an API key (the same way
 * in as a local model) runs a real turn that calls every tool of the table.
 *
 * One letter per access level, in the order chat, readonly, ask, auto, full:
 *   R = runs without asking        X = refused        A = asks the owner on a card
 *   C = the reviewer model reads the step first (the answer in these tests is "allow", so it then runs)
 * A `-` in an engine row: on that level the engine never asks TeamBot (its own flags or sandbox decide).
 *
 * `geen`: no rule of the owner. `regel`: a fixed rule of his that names the step (OWN_RULES). `start`: the two rules
 * every new team starts with (money, an important message to someone else); those are read by the reviewer.
 *
 * Every way in ends in the one function `passGate` (server/tools/gate.ts). A cell with a pair `[API, CLI bridge]` is
 * a step the two still describe differently to that gate; each says why.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = {
  'claude-code': { kind: 'claude-code', config: { path: path.join(here, 'fixtures', 'cli-agents-fake-claude.mjs') } },
  codex: { kind: 'codex-cli', config: { path: path.join(here, 'fixtures', 'cli-agents-fake-codex.mjs') } },
  acp: { kind: 'acp-custom', config: { command: path.join(here, 'fixtures', 'cli-agents-fake-acp.mjs'), args: [] } },
} as const;
type Engine = keyof typeof FAKE;

const LEVELS = ['chat', 'readonly', 'ask', 'auto', 'full'] as const;
type Level = (typeof LEVELS)[number];
const RULESETS = ['geen', 'regel', 'start'] as const;
type RuleSet = (typeof RULESETS)[number];

const OWN_RULES = [
  'Vraag eerst voordat je iets wijzigt in de map notities',
  'Vraag eerst voordat je iets wijzigt in de map elders',
  'Vraag eerst voordat je een opdracht uitvoert',
  'Vraag eerst voordat je iets leest',
  'Betaal nooit iets',
  'Mail nooit naar klanten',
];

/** Never made: only named. Outside the temp folder on purpose (a command may always use the temp folder). */
const ELDERS = path.join(os.homedir(), 'tb-poort-bestaat-niet', 'elders', 'b.txt');
const SLEUTEL = path.join(os.homedir(), '.ssh', 'tb-poort-bestaat-niet');
const DICHT = path.join(os.homedir(), 'tb-poort-bestaat-niet', 'dicht');
const WEB = 'https://93.184.216.34/pagina';

interface Places {
  /** The bot's work folder. */
  ws: string;
  dataDir: string;
}

/** A step as each way in gets it. */
interface Step {
  /** The tool of TeamBot for this step; none for a step only a CLI engine has (a tool of its own TeamBot does not know). */
  api?: { name: string; args: any };
  /** Claude Code's permission prompt; the direct call of the CLI bridge is built from it the way claude.ts does. */
  claude?: { name: string; input: any };
  /** The direct call of the CLI bridge when no engine can say it (a step an engine marks as a payment). */
  bridge?: Partial<GateRequest> & { tool: string; risk: GateRequest['risk'] };
  codex?: any;
  acp?: any;
}

/** `[api, bridge]`, or one string when both give the same. */
type Want = string | [string, string];

interface Row {
  id: string;
  step(p: Places): Step;
  want: Record<RuleSet, Want>;
  /** Where an engine's own way in gives something else than the bridge column: the full five letters. */
  engines?: Partial<Record<Engine, Partial<Record<RuleSet, string>>>>;
  /**
   * The rule of the owner that forbids this step outright. On "Vragen", "Automatisch" and "Volledige toegang" the bot
   * reads the same refusal with that rule in it on every way in that hands it words: a tool of TeamBot called by a
   * model over an API key and by a CLI engine (also a tool that is not in the engine's list), and Claude Code's prompt.
   */
  says?: Partial<Record<RuleSet, string>>;
  /** Only called directly, not in a real turn (the tool needs something the bots of this file do not have). */
  direct?: boolean;
}

/** The refusal a bot reads when a rule of its owner forbids a step (tools/gate.ts). */
const BY_RULE = (rule: string) => `Geweigerd door een regel van je eigenaar: “${rule}”. Doe dit niet; vraag je eigenaar als het echt nodig is.`;
/** The levels on which the level itself does not refuse a step of impact (so the rule is what refuses). */
const RULE_LEVELS: Level[] = ['ask', 'auto', 'full'];

const cmd = (command: string): ((p: Places) => Step) => (p) => ({
  api: { name: 'run_command', args: { command } },
  claude: { name: 'Bash', input: { command } },
  codex: { command, cwd: p.ws },
  acp: { kind: 'execute', title: 'Voer uit', rawInput: { command } },
});
const write = (file: (p: Places) => string, rel?: string): ((p: Places) => Step) => (p) => ({
  api: { name: 'write_file', args: { path: rel || file(p), content: 'x' } },
  claude: { name: 'Write', input: { file_path: file(p), content: 'x' } },
  codex: { changes: [{ path: file(p), kind: { type: 'add' }, diff: '' }] },
  acp: { kind: 'edit', title: 'Schrijf bestand', locations: [{ path: file(p) }] },
});
const read = (file: (p: Places) => string): ((p: Places) => Step) => (p) => ({
  api: { name: 'read_file', args: { path: file(p) } },
  claude: { name: 'Read', input: { file_path: file(p) } },
  acp: { kind: 'read', title: 'Lees bestand', locations: [{ path: file(p) }] },
});

const TABLE: Row[] = [
  { id: 'bestand schrijven in de werkmap', step: write((p) => path.join(p.ws, 'notities', 'a.txt'), 'notities/a.txt'), want: { geen: 'XXARR', regel: 'XXAAA', start: 'XXARR' } },
  { id: 'bestand schrijven buiten de werkmap', step: write(() => ELDERS), want: { geen: 'XXXXR', regel: 'XXXXA', start: 'XXXXR' } },
  { id: 'opdracht: onschuldig (npm test)', step: cmd('npm test'), want: { geen: 'XXARR', regel: 'XXAAA', start: 'XXARR' } },
  { id: 'opdracht: lokaal wissen (rm -rf build)', step: cmd('rm -rf build'), want: { geen: 'XXAAR', regel: 'XXAAA', start: 'XXAAR' } },
  { id: 'opdracht: git push', step: cmd('git push origin main'), want: { geen: 'XXAAR', regel: 'XXAAA', start: 'XXAAR' } },
  { id: 'opdracht: npm publish', step: cmd('npm publish'), want: { geen: 'XXAAR', regel: 'XXAAA', start: 'XXAAR' } },
  { id: 'opdracht: POST naar een API', step: cmd('curl -X POST https://api.example.com/hook -d a=1'), want: { geen: 'XXAAR', regel: 'XXAAA', start: 'XXAAC' } },
  { id: 'opdracht: ssh naar een server', step: cmd('ssh beheer@server.example.com uptime'), want: { geen: 'XXAAR', regel: 'XXAAA', start: 'XXAAR' } },
  { id: 'opdracht: iemand mailen', step: cmd('Send-MailMessage -To klant@example.com -Subject Offerte'), want: { geen: 'XXAAA', regel: 'XXAAA', start: 'XXAAA' } },
  { id: 'opdracht: pad buiten de mappen van de bot', step: cmd(`cat "${ELDERS}"`), want: { geen: 'XXAAR', regel: 'XXAAA', start: 'XXAAR' } },
  // A script of a skill the owner trusts is a command like any other: it asks on "Vragen", runs from "Automatisch" on,
  // and asks where his rule about commands names it (it asked on every level below "Volledige toegang" itself, after the
  // gate). An engine that runs it in its own terminal: a command.
  {
    id: 'skillscript van een vertrouwde skill',
    step: () => ({ api: { name: 'skill_run_script', args: { name: 'vertrouwd', script: 'scripts/doe.mjs' } }, claude: { name: 'Bash', input: { command: 'node scripts/doe.mjs' } } }),
    want: { geen: 'XXARR', regel: 'XXAAA', start: 'XXARR' },
    direct: true,
  },
  {
    id: 'webpagina lezen',
    step: () => ({ api: { name: 'web_fetch', args: { url: WEB } }, claude: { name: 'WebFetch', input: { url: WEB, prompt: 'x' } }, acp: { kind: 'fetch', title: 'webfetch', rawInput: { url: WEB } } }),
    want: { geen: 'XRRRR', regel: 'XAAAA', start: 'XRRRR' },
  },
  {
    id: 'betaling',
    step: () => ({ api: { name: 'pay_invoice', args: { amount: 49 } }, bridge: { tool: 'mcp__kassa__pay_invoice', risk: 'danger', impact: 'payment', input: { amount: 49 } } }),
    want: { geen: 'XXAAA', regel: 'XXXXX', start: 'XXAAA' },
    says: { regel: 'Betaal nooit iets' },
  },
  {
    id: 'bericht aan een ander',
    step: () => ({
      api: { name: 'send_mail', args: { to: 'klant@example.com', body: 'De afspraak staat op dinsdag.' } },
      claude: { name: 'mcp__gmail__send_email', input: { to: 'klant@example.com', body: 'De afspraak staat op dinsdag.' } },
      codex: { elicitation: { serverName: 'gmail', mode: 'form', message: 'gmail.send_email' } },
      acp: { kind: 'other', title: 'gmail_send_email', rawInput: { to: 'klant@example.com', body: 'De afspraak staat op dinsdag.' } },
    }),
    want: { geen: 'XXAAA', regel: 'XXXXX', start: 'XXAAA' },
    says: { regel: 'Mail nooit naar klanten' },
    // An ACP engine names a tool of one of its own apps only in a title, as kind "other": acp.ts hands it to the gate
    // as that app's tool ("mcp__gmail__send_email", permissions.ts acpAppTool), the way claude.ts does.
    // NOT THROUGH THE GATE for Codex: before it uses a tool of one of its own apps, Codex asks with an "elicitation".
    // codex.ts says no to every one that is not for TeamBot's own server, whatever the level or the rules.
    engines: { codex: { geen: '--X--', regel: '--X--', start: '--X--' } },
  },
  // A tool of an engine itself that TeamBot has no line for (not a command, not a tool of an app): an ordinary step on
  // this computer, for every engine alike (permissions.ts otherToolRisk). It asks on "Vragen" and runs from
  // "Automatisch" on; the owner's rule about commands names it.
  {
    id: 'onbekende eigen tool van een engine',
    step: () => ({ claude: { name: 'NieuweTool', input: { wat: 'iets' } }, acp: { kind: 'other', title: 'Nieuwe tool', rawInput: { wat: 'iets' } } }),
    want: { geen: 'XXARR', regel: 'XXAAA', start: 'XXARR' },
  },
  // A read that can never succeed is refused at once on every way in, also with a rule "vraag eerst voordat je iets
  // leest": TeamBot's own read tools name the path before anything is asked (`refuse`, tools/builtin/files.ts), the
  // way the CLI bridge does. No card for what is refused anyway.
  // An ACP engine that writes a file through TeamBot itself (fs/write_text_file) without asking first: that write passes
  // the gate on every level as the engine's own "edit", so the owner's rule about a folder and a closed folder hold.
  {
    id: 'bestand schrijven door een ACP-engine zelf (fs/write)',
    step: (p) => ({ bridge: { tool: 'edit', risk: 'write', paths: [path.join(p.ws, 'notities', 'b.txt')], input: {} }, acp: { fswrite: path.join(p.ws, 'notities', 'b.txt') } }),
    want: { geen: 'XXARR', regel: 'XXAAA', start: 'XXARR' },
  },
  {
    id: 'bestand schrijven in een dichte map door een ACP-engine zelf (fs/write)',
    step: () => ({ bridge: { tool: 'edit', risk: 'write', paths: [path.join(DICHT, 'BANK.txt')], input: {} }, acp: { fswrite: path.join(DICHT, 'BANK.txt') } }),
    want: { geen: 'XXXXX', regel: 'XXXXX', start: 'XXXXX' },
  },
  { id: 'sleutelbestand lezen', step: read(() => SLEUTEL), want: { geen: 'XXXXX', regel: 'XXXXX', start: 'XXXXX' } },
  { id: 'sleutelbestand in een opdracht', step: cmd(`cat "${SLEUTEL}"`), want: { geen: 'XXXXX', regel: 'XXXXX', start: 'XXXXX' } },
  { id: 'gegevens van TeamBot lezen', step: read((p) => path.join(p.dataDir, 'teambot.db')), want: { geen: 'XXXXX', regel: 'XXXXX', start: 'XXXXX' } },
  { id: 'bestand in een dichte map lezen', step: read(() => path.join(DICHT, 'BANK.txt')), want: { geen: 'XXXXX', regel: 'XXXXX', start: 'XXXXX' } },
];

/**
 * The same steps with a setting of the bot that changes the answer. These are the cases where a tool of an API model
 * and a CLI engine's own step got different answers while each had its own gate (the first version of this file has
 * them as pairs); what the one gate answers now, and why:
 *  - "Automatische controle" of the bot read a step of an API model, never a CLI engine's own step. Now both, as the
 *    switch says ("elke wijzigende actie"). It also still read every step on "Volledige toegang" when it had been left
 *    on, although its switch is only shown on "Automatisch": it counts where the switch is.
 *  - The owner's "nooit" or "eerst vragen" for one tool did not hold for a deleting or outward command of a CLI engine
 *    (that one was looked up under another name, "…:danger"). One name per tool: his choice holds for every command.
 *  - A bot kept to its own folders that may also send to others: TeamBot's terminal ran a command that names a path
 *    outside its folders without asking, the CLI bridge asked. Both ask: sending to others is not leaving its folders.
 *  - A command that wipes the disk: TeamBot's terminal refused it only when it ran, on "Vragen" after a card. Refused
 *    at once, like for a CLI engine.
 */
interface Special {
  id: string;
  level: Level;
  settings?: Record<string, any>;
  /** Per-tool choice of the owner, on the name each way in uses for this tool. */
  policy?: 'ask' | 'deny';
  row: string;
  want: Want;
}
const SPECIAL: Special[] = [
  { id: 'full + ook versturen naar anderen: bericht', level: 'full', settings: { fullAccessExternal: true }, row: 'bericht aan een ander', want: 'R' },
  { id: 'full + ook versturen naar anderen: betaling', level: 'full', settings: { fullAccessExternal: true }, row: 'betaling', want: 'A' },
  { id: 'auto + automatische controle: bestand schrijven', level: 'auto', settings: { autoReview: true }, row: 'bestand schrijven in de werkmap', want: 'C' },
  { id: 'auto + automatische controle: opdracht', level: 'auto', settings: { autoReview: true }, row: 'opdracht: onschuldig (npm test)', want: 'C' },
  { id: 'full + automatische controle nog aan van vroeger: bestand schrijven', level: 'full', settings: { autoReview: true }, row: 'bestand schrijven in de werkmap', want: 'R' },
  { id: 'ask + automatische controle nog aan van vroeger: bestand schrijven', level: 'ask', settings: { autoReview: true }, row: 'bestand schrijven in de werkmap', want: 'A' },
  { id: 'auto + deze tool nooit: onschuldige opdracht', level: 'auto', policy: 'deny', row: 'opdracht: onschuldig (npm test)', want: 'X' },
  { id: 'auto + deze tool nooit: wissen', level: 'auto', policy: 'deny', row: 'opdracht: lokaal wissen (rm -rf build)', want: 'X' },
  { id: 'full + deze tool nooit: wissen', level: 'full', policy: 'deny', row: 'opdracht: lokaal wissen (rm -rf build)', want: 'X' },
  { id: 'full + deze tool eerst vragen: onschuldige opdracht', level: 'full', policy: 'ask', row: 'opdracht: onschuldig (npm test)', want: 'A' },
  { id: 'full + deze tool eerst vragen: wissen', level: 'full', policy: 'ask', row: 'opdracht: lokaal wissen (rm -rf build)', want: 'A' },
  { id: 'full, alleen eigen mappen: opdracht met pad daarbuiten', level: 'full', settings: { ownFoldersOnly: true }, row: 'opdracht: pad buiten de mappen van de bot', want: 'A' },
  { id: 'full, alleen eigen mappen + ook versturen: opdracht met pad daarbuiten', level: 'full', settings: { ownFoldersOnly: true, fullAccessExternal: true }, row: 'opdracht: pad buiten de mappen van de bot', want: 'A' },
  { id: 'ask: opdracht die de schijf wist (format c:)', level: 'ask', row: 'format', want: 'X' },
  { id: 'full: opdracht die de schijf wist (format c:)', level: 'full', row: 'format', want: 'X' },
];
const FORMAT: Row = { id: 'format', step: cmd('format c:'), want: { geen: '', regel: '', start: '' } };

// ---------------------------------------------------------------------------------------------------------------

type Ev = { k: string; d: any };

/** Everything the gate does that a test can see: the log lines and the cards (a card is answered "no" at once). */
function record(t: TestApp): Ev[] {
  const ctx = t.app.ctx as any;
  const ev: Ev[] = [];
  const audit = ctx.audit;
  ctx.audit = (u: string, kind: string, d: any, agentId?: string) => {
    ev.push({ k: kind, d });
    return audit(u, kind, d, agentId);
  };
  ctx.broker.request = async (o: any) => {
    ev.push({ k: 'card', d: { tool: o.tool, summary: o.summary, risk: o.risk } });
    return { approved: false };
  };
  return ev;
}

const reviewed = (ev: Ev[]) => ev.some((e) => e.k.startsWith('autoreview.'));
const carded = (ev: Ev[]) => ev.some((e) => e.k === 'card');
const REFUSED = /Geweigerd|Dit pad is beschermd|dicht voor bots|Pad valt buiten/;

function addRules(t: TestApp, agent: Agent, set: RuleSet) {
  const rules = t.app.ctx.services.botRules._service;
  if (set === 'regel')
    for (const text of OWN_RULES) {
      const r = rules.parse(agent.user_id, text);
      assert.ok(!r.error, `${text}: ${r.error}`);
      assert.equal(r.review, false, `${text}: a fixed rule`);
      rules.add(agent.user_id, { agentId: agent.id }, text, r);
    }
  if (set === 'start')
    for (const d of STARTER_RULES) {
      const r = rules.parse(agent.user_id, d.text);
      rules.add(agent.user_id, { agentId: agent.id }, d.text, { ...r, ...(d.match ? { match: d.match } : {}), ...(d.review !== undefined ? { review: d.review } : {}) });
    }
}

/** The reviewer always answers "allow" here; what counts is whether it was asked. */
function reviewerSaysAllow(t: TestApp, n = 1) {
  t.script.length = 0;
  for (let i = 0; i < n; i++) t.script.push({ text: '{"verdict":"allow","reason":"In orde"}' });
}

/** The tools of the API way in: the real definitions; nothing is really run, except reading a file. */
function apiTools(t: TestApp): ToolDef[] {
  const ctx = t.app.ctx;
  for (const [name, impact] of [
    ['pay_invoice', 'payment'],
    ['send_mail', 'external'],
  ] as const)
    if (!ctx.tools.list().some((x) => x.name === name)) ctx.tools.register({ name, group: 'files', risk: 'danger', impact, description: 'test', parameters: { type: 'object', properties: {} }, run: async () => 'gedaan' });
  return ['write_file', 'read_file', 'run_command', 'web_fetch', 'pay_invoice', 'send_mail', 'skill_run_script'].map((n) => {
    const def = ctx.tools.list().find((x) => x.name === n);
    assert.ok(def, `tool ${n}`);
    // skill_run_script: as for a skill the owner trusts (its own `refuse` says why any other skill can never run).
    return n === 'read_file' ? def : { ...def, run: async () => 'UITGEVOERD', ...(n === 'skill_run_script' ? { refuse: undefined } : {}) };
  });
}

/** The CLI bridge called directly, filled the way Claude Code's permission prompt fills it (cli-agents/claude.ts). */
function bridgeRequest(s: Step): GateRequest {
  if (s.bridge) return { summary: 'x', input: {}, ...s.bridge } as GateRequest;
  const { name, input } = s.claude!;
  return { tool: name, risk: claudeToolRisk(name, input), summary: 'x', input, paths: pathsOf(input), url: name === 'WebFetch' ? input.url : undefined, command: commandOf(input), impact: commandOf(input) ? undefined : name.startsWith('mcp__') ? 'external' : 'local' };
}

interface Bot {
  agent: Agent;
  places: Places;
  thread: any;
  run: any;
}

async function mockBot(t: TestApp, level: Level, o: { settings?: Record<string, any>; rules?: RuleSet; tool_policy?: Record<string, string> } = {}): Promise<Bot> {
  const ctx = t.app.ctx;
  const a = await t.agent({ access_mode: level, tool_groups: ['files', 'shell', 'web'], ...(o.settings ? { settings: o.settings } : {}), ...(o.tool_policy ? { tool_policy: o.tool_policy } : {}) });
  const agent = ctx.store.agent(a.id) as Agent;
  addRules(t, agent, o.rules || 'geen');
  return { agent, places: { ws: agent.workspace, dataDir: ctx.config.dataDir }, thread: ctx.chat.threadForAgent(agent.user_id, agent.id), run: ownerTurn(ctx, agent.user_id, agent.id) };
}

/** What the bot read after the last direct call of each way in. */
const said = { api: '', bridge: '' };

async function viaApi(t: TestApp, ev: Ev[], tools: ToolDef[], b: Bot, s: Step): Promise<string> {
  ev.length = 0;
  reviewerSaysAllow(t);
  const r = await executeTool({ ctx: t.app.ctx, agent: b.agent, thread: b.thread, run: b.run, tools, name: s.api!.name, args: s.api!.args, callId: 'c1', signal: new AbortController().signal });
  said.api = r.out.text;
  if (carded(ev)) return 'A';
  if (reviewed(ev)) return 'C';
  return r.denied || (r.out.isError && REFUSED.test(r.out.text)) ? 'X' : 'R';
}

async function viaBridge(t: TestApp, ev: Ev[], b: Bot, s: Step): Promise<string> {
  ev.length = 0;
  reviewerSaysAllow(t);
  const r = await gate({ ctx: t.app.ctx, agent: b.agent, thread: b.thread, run: b.run, userId: b.agent.user_id, signal: new AbortController().signal, ns: 'claude-code' }, bridgeRequest(s));
  said.bridge = r.message;
  if (carded(ev)) return 'A';
  if (reviewed(ev)) return 'C';
  return r.allow ? 'R' : 'X';
}

const both = (w: Want): [string, string] => (typeof w === 'string' ? [w, w] : w);
const PRINT = !!process.env.POORT_PRINT;

test('de poort, rechtstreeks: een tool van een API-model en de brug van een CLI geven voor dezelfde stap hetzelfde', async () => {
  const t = await startTestApp();
  try {
    const ev = record(t);
    await t.api('PUT', '/settings', { closedFolders: [DICHT] });
    const tools = apiTools(t);
    const got: Record<string, Record<string, [string, string]>> = {};
    for (const set of RULESETS) {
      const bots: Bot[] = [];
      for (const level of LEVELS) bots.push(await mockBot(t, level, { rules: set }));
      for (const row of TABLE) {
        let api = '';
        let bridge = '';
        for (const b of bots) {
          const s = row.step(b.places);
          const viaCli = await viaBridge(t, ev, b, s);
          // A step only a CLI engine has: one column.
          api += s.api ? await viaApi(t, ev, tools, b, s) : viaCli;
          bridge += viaCli;
          // A step a rule forbids outright: the same words on both ways in, with the rule in them.
          const rule = row.says?.[set];
          if (rule && s.api && RULE_LEVELS.includes(b.agent.access_mode as Level)) assert.deepEqual([said.api, said.bridge], [BY_RULE(rule), BY_RULE(rule)], `${row.id} (${set}) op ${b.agent.access_mode}: de weigering, [API, CLI-brug]`);
        }
        (got[row.id] ||= {})[set] = [api, bridge];
      }
    }
    if (PRINT) return console.log('TABLE\n' + TABLE.map((r) => `${r.id}\n` + RULESETS.map((s) => `    ${s}: ${got[r.id][s][0] === got[r.id][s][1] ? `'${got[r.id][s][0]}'` : `['${got[r.id][s][0]}', '${got[r.id][s][1]}']`}`).join('\n')).join('\n'));
    for (const row of TABLE) for (const set of RULESETS) assert.deepEqual(got[row.id][set], both(row.want[set]), `${row.id} (${set}): [API, CLI-brug] over ${LEVELS.join(', ')}`);
  } finally {
    await t.close();
  }
});

test('de poort, rechtstreeks: instellingen van de bot die het antwoord veranderen', async () => {
  const t = await startTestApp();
  try {
    const ev = record(t);
    const tools = apiTools(t);
    const lines: string[] = [];
    for (const c of SPECIAL) {
      const row = c.row === 'format' ? FORMAT : TABLE.find((r) => r.id === c.row)!;
      const b = await mockBot(t, c.level, { settings: c.settings, tool_policy: c.policy ? { run_command: c.policy, 'claude-code:Bash': c.policy } : undefined });
      const s = row.step(b.places);
      const got: [string, string] = [await viaApi(t, ev, tools, b, s), await viaBridge(t, ev, b, s)];
      lines.push(`${c.id}: ${got[0] === got[1] ? `'${got[0]}'` : `['${got[0]}', '${got[1]}']`}`);
      if (!PRINT) assert.deepEqual(got, both(c.want), `${c.id}: [API, CLI-brug]`);
    }
    if (PRINT) console.log('SPECIAL\n' + lines.join('\n'));
  } finally {
    await t.close();
  }
});

test('de poort, rechtstreeks: de kaart voor een opdracht met een pad buiten de mappen heeft geen "Altijd toestaan"', async () => {
  const t = await startTestApp();
  try {
    const ev = record(t);
    const tools = apiTools(t);
    const row = TABLE.find((r) => r.id === 'opdracht: pad buiten de mappen van de bot')!;
    for (const [level, settings] of [['ask'], ['auto'], ['full', { ownFoldersOnly: true }]] as [Level, Record<string, any>?][]) {
      const b = await mockBot(t, level, { settings });
      const s = row.step(b.places);
      for (const [way, go] of [['API', () => viaApi(t, ev, tools, b, s)], ['CLI-brug', () => viaBridge(t, ev, b, s)]] as const) {
        assert.equal(await go(), 'A', `${way} op ${level}`);
        const card = ev.find((e) => e.k === 'card')!.d;
        // risk "danger": the card offers only this once (broker.ts resolve never stores "always" for it).
        assert.equal(card.risk, 'danger', `${way} op ${level}: ${card.summary}`);
        assert.match(card.summary, / — buiten de (werkplek|mappen) van de bot: /, `${way} op ${level}`);
      }
    }
  } finally {
    await t.close();
  }
});

test('de poort, rechtstreeks: een tool buiten files.ts die een bestand leest, weigert een sleutelbestand, de gegevens van TeamBot of een dichte map meteen', async () => {
  const t = await startTestApp();
  try {
    const ev = record(t);
    await t.api('PUT', '/settings', { closedFolders: [DICHT] });
    const tools: [string, (file: string) => any][] = [
      ['read_document', (file) => ({ path: file })],
      ['browser_upload', (file) => ({ ref: 'e1', path: file })],
      ['team_import_file', (file) => ({ path: file })],
      ['remote_upload', (file) => ({ local_path: file })],
    ];
    for (const level of ['ask', 'full'] as Level[]) {
      // "Vraag eerst voordat je iets leest": a card for a read that is refused anyway would only waste the owner's time.
      const b = await mockBot(t, level, { rules: 'regel' });
      for (const [name, args] of tools) {
        const def = t.app.ctx.tools.get(name);
        assert.ok(def, name);
        for (const file of [SLEUTEL, path.join(b.places.dataDir, 'teambot.db'), path.join(DICHT, 'BANK.txt')]) {
          ev.length = 0;
          const r = await executeTool({ ctx: t.app.ctx, agent: b.agent, thread: b.thread, run: b.run, tools: [{ ...def!, run: async () => 'UITGEVOERD' }], name, args: args(file), callId: 'c', signal: new AbortController().signal });
          assert.equal(carded(ev), false, `${name} op ${level}: ${file}: geen kaart`);
          assert.match(r.out.text, /^Geweigerd door TeamBot: /, `${name} op ${level}: ${file}`);
        }
      }
    }
    // channel_send exists only for a bot with a channel: its files go through the same check.
    const b = await mockBot(t, 'ask');
    assert.match(refuseReadOf('files')({ files: ['rapport.pdf', SLEUTEL] }, b) || '', /^Geweigerd door TeamBot: /);
    assert.equal(refuseReadOf('files')({ files: ['rapport.pdf'] }, b), null);
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------

/** On which levels an engine asks TeamBot at all. */
const ASKS: Record<Engine, Level[]> = {
  // chat and readonly: no approval channel, Claude Code's own flags refuse.
  'claude-code': ['ask', 'auto', 'full'],
  // readonly, auto and full run `codex exec` with approvals off: the sandbox decides, not TeamBot.
  codex: ['ask'],
  acp: ['readonly', 'ask', 'auto', 'full'],
};

const enc = (steps: any[]) => Buffer.from(JSON.stringify(steps)).toString('base64url');

/** What an engine asks TeamBot in its turn: its own step of a row, or one of TeamBot's own tools. */
interface EngineCase {
  id: string;
  row: Row;
  step: any;
  /** A TeamBot tool the engine uses through TeamBot's MCP server: the answer is that of the API column. */
  teambot: boolean;
}
const VIA_MCP = new Set(['web_fetch', 'pay_invoice', 'send_mail']);

function engineCases(engine: Engine, p: Places): EngineCase[] {
  const key = engine === 'claude-code' ? 'claude' : engine;
  const steps = TABLE.map((row) => ({ row, s: row.step(p) }));
  return [
    ...steps.filter((x) => x.s[key]).map((x) => ({ id: x.row.id, row: x.row, step: x.s[key], teambot: false })),
    // The scripted Codex has no MCP client; TeamBot's tools arrive from Codex the same way as from the other two.
    // Twice: the way a model finds the tool (in its list, else through tools_call), and by its own name whatever the
    // list says (a tool a rule forbids outright is not in the list of a CLI engine, toolhost.ts).
    ...(engine === 'codex'
      ? []
      : steps
          .filter((x) => x.s.api && VIA_MCP.has(x.s.api.name))
          .flatMap((x) => [
            { id: `${x.row.id}, met de tool van TeamBot`, row: x.row, step: { teambot: { name: x.s.api!.name, arguments: x.s.api!.args } }, teambot: true },
            { id: `${x.row.id}, met de tool van TeamBot bij naam`, row: x.row, step: { teambot: { name: x.s.api!.name, arguments: x.s.api!.args }, direct: true }, teambot: true },
          ])),
  ];
}

/** One turn of a scripted engine that asks for every step of the table: the outcome per step. */
async function viaEngine(t: TestApp, ev: Ev[], engine: Engine, providerId: string, level: Level, set: RuleSet): Promise<Record<string, string>> {
  const ctx = t.app.ctx;
  // The reviewer is the scripted API model, not a one-shot of the CLI itself.
  const a = await t.api('POST', '/agents', { name: 'CliBot', provider_id: providerId, model: '', access_mode: level, tool_groups: ['files', 'shell', 'web'], settings: { autoReviewProviderId: t.providerId, autoReviewModel: 'mock-1' } });
  const agent = ctx.store.agent(a.id) as Agent;
  addRules(t, agent, set);
  const cases = engineCases(engine, { ws: agent.workspace, dataDir: ctx.config.dataDir });
  const th = await t.api('POST', '/threads', { agentId: a.id });
  ev.length = 0;
  reviewerSaysAllow(t, 40);
  await t.say(th.id, `SCENARIO:stappen STAPPEN:${enc(cases.map((c) => c.step))}`, 120_000);
  const where = `${engine} op ${level} (${set})`;
  // What the engine itself was told per step: yes or no, and (where the engine gets words) in which words.
  const logged = fs.readFileSync(process.env.FAKE_CLI_LOG!, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.stappen).at(-1);
  const told: boolean[] = (logged?.stappen || []).map((x: any) => x === 'allow' || x === 'accept' || x === 'a');
  const words: string[] = logged?.teksten || [];
  assert.equal(told.length, cases.length, `${where}: de engine vroeg ${told.length} van de ${cases.length} stappen: ${JSON.stringify(ctx.store.messages(th.id).at(-1)?.content)}`);
  // One log line per step that reaches the gate, in order: "cli.permission" for the engine's own tool, "tool.call" for
  // a tool of TeamBot. What came before it belongs to that step.
  const gated: { e: Ev; seg: Ev[] }[] = [];
  let seg: Ev[] = [];
  for (const e of ev) {
    if (e.k !== 'cli.permission' && e.k !== 'tool.call') {
      seg.push(e);
      continue;
    }
    gated.push({ e, seg });
    seg = [];
  }
  const out: Record<string, string> = {};
  let g = 0;
  cases.forEach((c, i) => {
    // A step TeamBot answers without the gate (Codex's elicitation for an app of its own).
    if (c.step.elicitation) out[c.id] = told[i] ? 'R' : 'X';
    else {
      const x = gated[g++];
      assert.equal(x?.e.k, c.teambot ? 'tool.call' : 'cli.permission', `${where}: ${c.id} kwam niet bij de poort`);
      const ok = c.teambot ? !x.e.d.denied && !x.e.d.error : x.e.d.allowed;
      // A tool of TeamBot reaches the gate as itself, also one that is not in the engine's list because a rule of the
      // owner forbids it outright or "Alleen lezen" leaves it out (toolhost.ts), and whether it was called by its name
      // or through tools_call: refused before anything is asked, in the words a model over an API key reads.
      if (c.teambot) assert.equal(x.e.d.tool, c.step.teambot.name, `${where}: ${c.id} kwam niet als zichzelf bij de poort`);
      out[c.id] = carded(x.seg) ? 'A' : reviewed(x.seg) ? 'C' : ok ? 'R' : 'X';
      // Forbidden by a rule: the engine reads the same refusal as a model over an API key, with the rule in it.
      const rule = c.row.says?.[set];
      if (rule && RULE_LEVELS.includes(level) && (c.teambot || engine === 'claude-code')) assert.equal(words[i], BY_RULE(rule), `${where}: ${c.id}: de weigering`);
    }
    // The engine goes on exactly when the gate let the step through (a card is answered "no" in this test).
    assert.equal(told[i], out[c.id] === 'R' || out[c.id] === 'C', `${where}: ${c.id}: de engine kreeg ${told[i] ? 'ja' : 'nee'} bij ${out[c.id]}`);
  });
  assert.equal(g, gated.length, `${where}: ${gated.length} verzoeken bij de poort voor ${g} stappen`);
  return out;
}

for (const engine of Object.keys(FAKE) as Engine[])
  test(`de poort via ${engine}: elke stap die de engine aan TeamBot vraagt, krijgt het antwoord van de tabel`, async () => {
    const t = await startTestApp();
    process.env.FAKE_CLI_LOG = path.join(t.dir, 'fake-cli.log');
    try {
      const ev = record(t);
      await t.api('PUT', '/settings', { closedFolders: [DICHT] });
      apiTools(t);
      // Nothing is really fetched.
      for (const def of t.app.ctx.tools.list()) if (def.name === 'web_fetch') def.run = async () => 'UITGEVOERD';
      const p = await t.api('POST', '/providers', FAKE[engine]);
      const cases = engineCases(engine, { ws: '', dataDir: '' });
      const lines: string[] = [];
      for (const set of RULESETS) {
        const got: Record<string, string> = {};
        for (const level of LEVELS) {
          const one = ASKS[engine].includes(level) ? await viaEngine(t, ev, engine, p.id, level, set) : {};
          for (const c of cases) got[c.id] = (got[c.id] || '') + (one[c.id] || '-');
        }
        for (const c of cases) {
          // The engine's own step: the CLI-bridge column. A tool of TeamBot: the API column.
          const column = both(c.row.want[set])[c.teambot ? 0 : 1];
          const want = (!c.teambot && c.row.engines?.[engine]?.[set]) || [...column].map((x, i) => (ASKS[engine].includes(LEVELS[i]) ? x : '-')).join('');
          lines.push(`${c.id} (${set}): '${got[c.id]}'${got[c.id] === want ? '' : `   <> tabel '${want}'`}`);
          if (!PRINT) assert.equal(got[c.id], want, `${engine}: ${c.id} (${set}) over ${LEVELS.join(', ')}`);
        }
      }
      if (PRINT) console.log(`ENGINE ${engine}
` + lines.join('\n'));
    } finally {
      await t.close();
    }
  });

/**
 * The three hard blocks on Codex, on every level. Codex asks TeamBot only on "Vragen", and then only for what leaves its
 * sandbox; for the rest its own sandbox holds them, with what the gate refuses as deny entries (the key places of
 * KEY_PATH, TeamBot's data, the folders the owner closed), or the bot's page says plainly that they are not guarded
 * there and the bot's instructions carry them. Which sandbox a computer has, TeamBot checks once per Codex binary.
 * One letter per level, in the order readonly, ask, auto, full (the whole computer):
 *   B = the sandbox holds them: reads only in the bot's folders, or the deny entries are in the profile
 *   N = not guarded: no profile; the page says "Niet bewaakt door TeamBot" and the instructions name the blocks
 * NOT PROVEN ON CODEX ITSELF: the scripted Codex plays what the check would see; whether Codex 0.167 takes `:root`
 * write with deny entries, and holds it, only a check on a computer with Codex shows.
 */
const CODEX_SANDBOXES: { id: string; env: Record<string, string>; elevated?: boolean; want: string }[] = [
  { id: 'Windows-MXC of de sandbox van het systeem, hele schijf schrijfbaar met weigerregels', env: { FAKE_CODEX_SANDBOX: 'mxc', FAKE_CODEX_ROOT: 'held' }, want: 'BBBB' },
  { id: 'Windows-MXC of de sandbox van het systeem, hele schijf niet', env: { FAKE_CODEX_SANDBOX: 'mxc' }, want: 'BBBN' },
  ...(process.platform === 'win32' ? [{ id: 'Windows-sandbox "elevated" (alleen weigerregels)', env: { FAKE_CODEX_SANDBOX: 'elevated' }, elevated: true, want: 'BBBN' }] : []),
  { id: 'een Codex zonder profielen', env: {}, want: 'NNNN' },
];

test('de harde blokkades via codex: op elk niveau bewaakt door de sandbox, of op de pagina en in de instructies', async () => {
  const t = await startTestApp();
  process.env.FAKE_CLI_LOG = path.join(t.dir, 'fake-cli.log');
  process.env.FAKE_CODEX_LOG_START = '1';
  const keep = { ...process.env };
  const closed = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-poort-dicht-'));
  try {
    record(t);
    await t.api('PUT', '/settings', { closedFolders: [closed] });
    const p = await t.api('POST', '/providers', FAKE.codex);
    const dataDir = t.app.ctx.config.dataDir;
    const lines: string[] = [];
    for (const sb of CODEX_SANDBOXES) {
      for (const k of ['FAKE_CODEX_SANDBOX', 'FAKE_CODEX_ROOT']) delete process.env[k];
      Object.assign(process.env, sb.env);
      // The elevated sandbox is only checked once the owner set it up (a marker in Codex's home).
      const home = fs.mkdtempSync(path.join(t.dir, 'codexhome-'));
      if (sb.elevated) {
        fs.mkdirSync(path.join(home, '.sandbox'));
        fs.writeFileSync(path.join(home, '.sandbox', 'setup_marker.json'), '{}');
      }
      process.env.CODEX_HOME = home;
      resetCodexReadGuard();
      let got = '';
      for (const level of ['readonly', 'ask', 'auto', 'full'] as Level[]) {
        const a = await t.api('POST', '/agents', { name: 'CodexBot', provider_id: p.id, model: '', access_mode: level });
        const page = (await t.api('GET', `/cli-agents/hard-blocks/${p.id}?agentId=${a.id}`)).levels[level];
        const th = await t.api('POST', '/threads', { agentId: a.id });
        const before = fs.existsSync(process.env.FAKE_CLI_LOG!) ? fs.readFileSync(process.env.FAKE_CLI_LOG!, 'utf8').length : 0;
        await t.say(th.id, 'werk', 60_000);
        const logged: any[] = fs.readFileSync(process.env.FAKE_CLI_LOG!, 'utf8').slice(before).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
        const argv: string[] = logged.find((l) => l.argv?.[0] === 'exec' || l.mode === 'app-server')?.argv || [];
        const told = String(logged.find((l) => l.argv?.[0] === 'exec')?.prompt || logged.find((l) => l.method === 'thread/start')?.params?.developerInstructions || '');
        const profile = argv.find((x) => x.startsWith('permissions.teambot=')) || '';
        const confined = /":minimal"="read"/.test(profile) && !/":root"/.test(profile);
        const shut = profile.includes(`${JSON.stringify(closed)}="deny"`) && fs.readdirSync(dataDir).some((n) => profile.includes(`${JSON.stringify(path.join(dataDir, n))}="deny"`));
        const guarded = !!profile && (confined || shut);
        const where = `${sb.id} op ${level}`;
        // What the page says is what the run did.
        assert.equal(page.guarded, guarded, `${where}: de pagina zegt ${page.text}`);
        assert.match(page.text, guarded ? /^Bewaakt door TeamBot/ : /^Niet bewaakt door TeamBot: .*sleutelbestanden.*de mappen die je dicht zette.*de gegevens van TeamBot/, where);
        if (!guarded) assert.match(told, level === 'full' ? /Dicht blijven: bestanden met sleutels en wachtwoorden, de gegevens van TeamBot zelf/ : /## Wat dicht blijft\n.*sleutels en wachtwoorden.*de gegevens van TeamBot/, `${where}: de instructies`);
        if (!guarded) assert.ok(told.includes(closed), `${where}: de dichte map staat in de instructies`);
        got += guarded ? 'B' : 'N';
      }
      lines.push(`${sb.id}: '${got}'`);
      if (!PRINT) assert.equal(got, sb.want, `${sb.id} over readonly, ask, auto, full`);
    }
    if (PRINT) console.log('CODEX\n' + lines.join('\n'));
  } finally {
    for (const k of ['FAKE_CODEX_SANDBOX', 'FAKE_CODEX_ROOT', 'FAKE_CODEX_LOG_START', 'CODEX_HOME']) if (keep[k] === undefined) delete process.env[k];
    resetCodexReadGuard();
    fs.rmSync(closed, { recursive: true, force: true });
    await t.close();
  }
});

test('de poort via een API-model of lokaal model, in een echte beurt: elke toolaanroep krijgt het antwoord van de tabel', async () => {
  const t = await startTestApp();
  try {
    const ctx = t.app.ctx;
    const ev = record(t);
    await t.api('PUT', '/settings', { closedFolders: [DICHT] });
    apiTools(t);
    // Nothing is really run in this turn either, except reading a file.
    for (const def of ctx.tools.list()) if (['write_file', 'run_command', 'web_fetch'].includes(def.name)) def.run = async () => 'UITGEVOERD';
    // Chat and readonly: the model is not offered these tools at all, so nothing reaches the gate.
    const levels: Level[] = ['ask', 'auto', 'full'];
    for (const set of RULESETS) {
      const got: Record<string, string> = {};
      for (const level of levels) {
        const b = await mockBot(t, level, { rules: set });
        const th = await t.api('POST', '/threads', { agentId: b.agent.id });
        const rows = TABLE.filter((r) => r.step(b.places).api && !r.direct);
        const calls = rows.map((r) => r.step(b.places).api!);
        ev.length = 0;
        // One step of the model with every call of the table; a reviewer that is asked answers "allow".
        t.script.length = 0;
        t.script.push({ toolCalls: calls.map((c) => ({ name: c.name, args: c.args })) }, { text: '{"verdict":"allow","reason":"In orde"}' }, { text: '{"verdict":"allow","reason":"In orde"}' }, { text: 'Klaar.' });
        await t.say(th.id, 'doe de stappen', 60_000);
        const results = ctx.store.messages(th.id).filter((m) => m.role === 'tool');
        assert.equal(results.length, rows.length, `${level} (${set}): every call has a result`);
        let seg: Ev[] = [];
        let i = 0;
        for (const e of ev) {
          if (e.k !== 'tool.call') {
            seg.push(e);
            continue;
          }
          const row = rows[i];
          assert.equal(e.d.tool, calls[i].name);
          const rule = row.says?.[set];
          if (rule) assert.equal(results[i].content, BY_RULE(rule), `${row.id} (${set}) op ${level}: de weigering`);
          got[row.id] = (got[row.id] || '') + (carded(seg) ? 'A' : reviewed(seg) ? 'C' : e.d.denied || (e.d.error && REFUSED.test(results[i].content)) ? 'X' : 'R');
          i++;
          seg = [];
        }
        assert.equal(i, rows.length, `${level} (${set}): every call went through the gate`);
      }
      for (const row of TABLE) if (got[row.id] !== undefined) assert.equal(got[row.id], both(row.want[set])[0].slice(2), `${row.id} (${set}) over ${levels.join(', ')}`);
    }
  } finally {
    await t.close();
  }
});

test('een tool van een eigen app van een ACP-engine: herkend aan zijn naam, onder de naam die Claude Code geeft', () => {
  const app = (tc: any) => acpAppTool(tc);
  // OpenCode: "<app>_<tool>"; Gemini CLI and Qwen Code: "<tool> (<app> MCP Server)"; or already Claude Code's name
  assert.equal(app({ kind: 'other', title: 'gmail_send_email', rawInput: { to: 'klant@example.com' } }), 'mcp__gmail__send_email');
  assert.equal(app({ title: 'send_email (gmail MCP Server)' }), 'mcp__gmail__send_email');
  assert.equal(app({ kind: 'other', title: 'mcp__gmail__send_email' }), 'mcp__gmail__send_email');
  assert.equal(app({ kind: 'other', title: 'Stuur de mail', _meta: { toolName: 'stripe.create_refund' } }), 'mcp__stripe__create_refund');
  for (const name of ['mcp__gmail__send_email', 'mcp__stripe__create_refund']) assert.equal(otherToolRisk(name), 'danger', name);
  // not a tool of an app: the engine's own tools, a command, a program, a file, TeamBot's own tools
  for (const title of ['todo_write', 'external_directory', 'web_search', 'apply_patch', 'activate_skill', 'execute', 'task', 'Nieuwe tool', 'Plan opstellen'])
    assert.equal(app({ kind: 'other', title }), null, title);
  assert.equal(app({ kind: 'execute', title: 'gmail_send_email', rawInput: { command: 'npm test' } }), null);
  assert.equal(app({ kind: 'other', title: 'gmail_send_email', rawInput: { command: 'npm test' } }), null);
  assert.equal(app({ kind: 'other', title: 'execute', rawInput: { code: 'return 1' } }), null);
  assert.equal(app({ kind: 'other', title: 'gmail_send_email', locations: [{ path: 'a.txt' }] }), null);
  assert.equal(app({ kind: 'edit', title: 'gmail_send_email' }), null);
  assert.equal(app({ kind: 'other', title: 'teambot_memory_search' }), null);
  assert.equal(otherToolRisk('other'), 'exec');
});

test('één poort: geen tweede kopie van de controles in de code', () => {
  const root = path.join(here, '..', 'server');
  const files = (fs.readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts')).map((f) => f.split(path.sep).join('/'));
  /** The files that call `name(…)`, without the file that defines it. */
  const callers = (name: string) => files.filter((f) => new RegExp(`(?<![.\\w])${name}\\(`).test(fs.readFileSync(path.join(root, f), 'utf8').replace(new RegExp(`function ${name}\\(`), ''))).sort();
  // the gate is entered from two places: a call of a TeamBot tool, and a CLI engine's request for its own tool
  assert.deepEqual(callers('passGate'), ['modules/cli-agents/permissions.ts', 'tools/execute.ts']);
  // a TeamBot tool is called by the loop of an API or local model and by TeamBot's MCP server for the CLI engines
  assert.deepEqual(callers('executeTool'), ['agent/chat-loop.ts', 'modules/cli-agents/toolhost.ts']);
  // the reviewer model is reached from the gate only
  assert.deepEqual(callers('autoReview'), ['tools/gate.ts']);
  // the checks of a command: the gate only; the terminal tool reads its paths for the line on the card, nothing more
  assert.deepEqual(callers('isHardline'), ['tools/gate.ts']);
  assert.deepEqual(callers('commandPaths'), ['tools/builtin/shell.ts', 'tools/gate.ts']);
  const shell = fs.readFileSync(path.join(root, 'tools/builtin/shell.ts'), 'utf8');
  assert.doesNotMatch(shell, /\brefuse\s*[:(]|\.keys\b/, 'the terminal tool refuses nothing itself');
  // the owner's rules for a concrete step are read in the gate only
  const uses = (re: RegExp) => files.filter((f) => !f.startsWith('modules/botrules/') && re.test(fs.readFileSync(path.join(root, f), 'utf8'))).sort();
  assert.deepEqual(uses(/botRules\?*\.reviewFor|botRules\?*\.reason/), ['tools/gate.ts']);
});
