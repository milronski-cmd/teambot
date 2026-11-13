import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startTestApp, type TestApp } from './helpers.js';
import { appToolImpact, appToolRisk, claudeToolSummary } from '../server/modules/cli-agents/permissions.js';
import { cliActivity } from '../server/modules/cli-agents/activity-labels.js';
import { buildClaudeArgs, type ClaudeFeatures } from '../server/modules/cli-agents/claude.js';
import { codexIsolation } from '../server/modules/cli-agents/codex.js';
import { acpModelEnv } from '../server/modules/cli-agents/index.js';
import { defById } from '../server/modules/cli-agents/catalog.js';
import { PermissionBridge } from '../server/modules/cli-agents/bridge.js';
import { makeScope } from '../server/modules/cli-agents/context.js';
import { teambotTools } from '../server/modules/cli-agents/toolhost.js';

/**
 * The engine's own apps (the owner's claude.ai connectors on Claude Code, the MCP servers of Codex and OpenCode):
 * they stay on, show with the bot's apps with a switch per bot, and go through TeamBot's one permission gate: reading,
 * searching and drafting run by themselves, sending to other people asks the owner, like TeamBot's own channels.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = { kind: 'claude-code', config: { path: path.join(here, 'fixtures', 'cli-agents-fake-claude.mjs') } };
const FAKE_CODEX = { kind: 'codex-cli', config: { path: path.join(here, 'fixtures', 'cli-agents-fake-codex.mjs') } };
const FAKE_ACP = { kind: 'acp-custom', config: { command: path.join(here, 'fixtures', 'cli-agents-fake-acp.mjs'), args: [] } };
const enc = (v: any) => Buffer.from(JSON.stringify(v)).toString('base64url');
const logLines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/** Claude Code's init with the owner's claude.ai connectors (names as Claude Code 2.1.322 lists them, 12 nov). */
const INIT = {
  mcp_servers: [
    { name: 'teambot', status: 'connected', source: 'dynamic' },
    { name: 'claude.ai Gmail', status: 'connected', source: 'claudeai' },
    { name: 'claude.ai Google Calendar', status: 'needs-auth', source: 'claudeai' },
  ],
  tools: ['Read', 'Write', 'Bash', 'mcp__teambot__tools_find', 'mcp__claude_ai_Gmail__search_threads', 'mcp__claude_ai_Gmail__create_draft', 'mcp__claude_ai_Gmail__send_message', 'mcp__claude_ai_Google_Calendar__authenticate'],
};

/** Post a message and answer every approval card of that chat with `decide` until the turn is over. */
async function turn(t: TestApp, threadId: string, content: string, decide: (ap: any) => 'approve' | 'deny' = () => 'deny') {
  const cards: any[] = [];
  await t.api('POST', `/threads/${threadId}/messages`, { content });
  const start = Date.now();
  await new Promise((r) => setTimeout(r, 50));
  while (Date.now() - start < 60_000) {
    for (const ap of (await t.api('GET', '/approvals')).filter((x: any) => x.status === 'pending' && x.thread_id === threadId)) {
      cards.push(ap);
      await t.api('POST', `/approvals/${ap.id}`, { decision: decide(ap) });
    }
    if (!t.app.ctx.store.all("SELECT id FROM runs WHERE thread_id = ? AND status IN ('queued','running','waiting')", threadId).length) break;
    await new Promise((r) => setTimeout(r, 40));
  }
  return cards;
}

test('een app van de engine zelf: lezen, zoeken en een concept gaan vanzelf; versturen naar een ander vraagt (naam en velden)', () => {
  const read = ['mcp__claude_ai_Gmail__search_threads', 'mcp__claude_ai_Gmail__get_thread', 'mcp__claude_ai_Gmail__list_messages', 'mcp__claude_ai_Google_Calendar__list_events', 'mcp__claude_ai_Google_Calendar__find_free_time', 'mcp__claude_ai_Claude_Docs__query', 'mcp__shop__get_order'];
  for (const n of read) assert.equal(appToolRisk(n, { query: 'factuur', to: 'iemand@example.com' }), 'read', n);
  assert.equal(appToolRisk('mcp__claude_ai_Gmail__create_draft', { to: 'klant@example.com', subject: 'Offerte', body: 'x' }), 'write', 'een concept is geen bericht aan een ander');
  assert.equal(appToolRisk('mcp__claude_ai_Claude_Docs__update', { id: 'd1' }), 'write');
  assert.equal(appToolRisk('mcp__claude_ai_Google_Calendar__create_event', { summary: 'Lunch' }), 'write', 'een afspraak voor de eigenaar zelf');
  const out: [string, any][] = [
    ['mcp__claude_ai_Gmail__send_message', { to: 'klant@example.com' }],
    ['mcp__claude_ai_Gmail__send_draft', { id: 'r1' }],
    ['mcp__claude_ai_Google_Calendar__create_event', { summary: 'Overleg', attendees: [{ email: 'klant@example.com' }] }],
    ['mcp__slack__post_message', { channel: 'C1', text: 'hoi' }],
    ['mcp__claude_ai_Claude_Docs__delete', { id: 'd1' }],
    ['mcp__stripe__create_refund', { amount: 10 }],
    ['mcp__gmail__search_and_reply', { q: 'x' }],
  ];
  for (const [n, input] of out) assert.equal(appToolRisk(n, input), 'danger', n);
  assert.equal(appToolImpact('mcp__stripe__create_refund'), 'payment');
  assert.equal(appToolImpact('mcp__kassa__pay_invoice'), 'payment');
  assert.equal(appToolImpact('mcp__claude_ai_Gmail__send_message'), 'external');
  // The card says which app, what, and to whom.
  assert.equal(claudeToolSummary('mcp__claude_ai_Gmail__send_message', { to: ['klant@example.com'], subject: 'Uw offerte' }), 'Gmail: send message — aan klant@example.com — onderwerp: Uw offerte');
  // The step in the chat names the app as the owner knows it, not "claude ai Gmail".
  assert.equal(cliActivity('mcp__claude_ai_Gmail__search_threads', {}), 'Gebruikte Gmail');
});

const F: ClaudeFeatures = { partial: true, appendFile: true, restricted: true, permissionPrompts: true, tools: true, effort: true, modes: ['acceptEdits', 'bypassPermissions', 'default', 'plan', 'dontAsk'], settingSources: true, settings: true };
const BASE = { maxTurns: 10, addDirs: [], allowedTools: [], disallowedTools: [], extraArgs: [], loadUserSettings: true, useUserMcp: true, mcpConfigFile: 'mcp.json', teambotTools: ['tools_find'] };
const settingsOf = (a: string[]) => (a.includes('--settings') ? JSON.parse(a[a.indexOf('--settings') + 1]) : {});
const denied = (a: string[]) => (a.includes('--disallowedTools') ? a[a.indexOf('--disallowedTools') + 1].split(',') : []);

test('Claude Code: elke app van de eigenaar gaat langs de poort, ook als zijn eigen instellingen hem toestaan; uit per bot = niet in de lijst', () => {
  for (const mode of ['ask', 'auto'] as const) {
    const a = buildClaudeArgs(F, { ...BASE, mode, appsGated: ['claude_ai_Gmail', 'claude_ai_Google_Calendar'], appsOff: ['claude_ai_Google_Calendar'] });
    assert.deepEqual(settingsOf(a).permissions?.ask, ['mcp__claude_ai_Gmail', 'mcp__claude_ai_Google_Calendar'], mode);
    assert.ok(denied(a).includes('mcp__claude_ai_Google_Calendar'), `${mode}: uitgezet = geweigerd`);
    assert.ok(!denied(a).includes('mcp__claude_ai_Gmail'), mode);
    assert.ok(a.includes('--permission-prompt-tool'), mode);
  }
  // Without the owner's own apps nothing of this is needed; no ask rule outside a mode with the permission prompt.
  assert.equal(settingsOf(buildClaudeArgs(F, { ...BASE, mode: 'auto', useUserMcp: false, appsGated: ['claude_ai_Gmail'] })).permissions, undefined);
  assert.equal(settingsOf(buildClaudeArgs(F, { ...BASE, mode: 'readonly', appsGated: ['claude_ai_Gmail'] })).permissions, undefined);
  // A server of the owner's own settings that is off for this bot is not started at all (no tools, no instructions);
  // a claude.ai connector's name cannot be matched there (it goes out with all connectors at once, runClaude).
  const out = buildClaudeArgs(F, { ...BASE, mode: 'auto', appsOff: ['mail', 'claude_ai_Gmail'], appsOffServers: ['mail', 'claude.ai Gmail', 'teambot'] });
  assert.deepEqual(settingsOf(out).deniedMcpServers, [{ serverName: 'mail' }]);
  assert.ok(denied(out).includes('mcp__mail') && denied(out).includes('mcp__claude_ai_Gmail'));
  assert.equal(settingsOf(buildClaudeArgs(F, { ...BASE, mode: 'auto', useUserMcp: false, appsOffServers: ['mail'] })).deniedMcpServers, undefined);
  // A strange id never becomes a rule.
  assert.deepEqual(settingsOf(buildClaudeArgs(F, { ...BASE, mode: 'auto', appsGated: ['ok_app', 'kwaad)(*'] })).permissions?.ask, ['mcp__ok_app']);
});

test('Claude Code met Volledige toegang: de koppelingen staan bij de apps van de bot, lezen gaat vanzelf, versturen vraagt de eigenaar', async () => {
  const t = await startTestApp();
  process.env.FAKE_CLI_LOG = path.join(t.dir, 'fake-cli.log');
  process.env.FAKE_CLAUDE_INIT = JSON.stringify(INIT);
  process.env.FAKE_CLAUDE_MCP_LIST = ['Checking MCP server health…', '', 'claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected', 'claude.ai Google Calendar: https://calendarmcp.googleapis.com/mcp/v1 - ! Needs authentication'].join('\n');
  try {
    const p = await t.api('POST', '/providers', FAKE_CLAUDE);
    const bot = await t.api('POST', '/agents', { name: 'Mailbot', provider_id: p.id, model: '', access_mode: 'full' });
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    // Before any run Claude Code itself names its apps (`claude mcp list`, no model call); their tools come with a run.
    const first = (await t.api('GET', `/cli-agents/agents/${bot.id}/apps`)).apps;
    assert.deepEqual(first.map((a: any) => [a.name, a.state, a.tools, a.on]), [['Gmail', 'verbonden', 0, true], ['Google Calendar', 'inloggen nodig in Claude Code', 0, true]]);
    // (2) through the gate, already in the very first run: a search and a draft go by themselves, a mail to someone
    // else asks (and is refused here).
    const steps = [
      { name: 'mcp__claude_ai_Gmail__search_threads', input: { query: 'factuur' } },
      { name: 'mcp__claude_ai_Gmail__create_draft', input: { to: 'klant@example.com', subject: 'Offerte', body: 'Beste klant' } },
      { name: 'mcp__claude_ai_Gmail__send_message', input: { to: 'klant@example.com', subject: 'Offerte', body: 'Beste klant' } },
    ];
    const cards = await turn(t, th.id, `SCENARIO:stappen STAPPEN:${enc(steps)}`);
    // (1) visible: what Claude Code loaded of the owner's own shows as apps of this bot, each on.
    const apps = (await t.api('GET', `/cli-agents/agents/${bot.id}/apps`)).apps;
    assert.deepEqual(apps.map((a: any) => [a.id, a.name, a.engine, a.state, a.tools, a.on]), [
      ['claude_ai_Gmail', 'Gmail', 'Claude Code', 'verbonden', 3, true],
      ['claude_ai_Google_Calendar', 'Google Calendar', 'Claude Code', 'inloggen nodig in Claude Code', 1, true],
    ]);
    assert.match(apps[0].note, /^Bewaakt door TeamBot: .*versturen naar anderen.*vraagt eerst jou/);

    const told = logLines(process.env.FAKE_CLI_LOG).filter((l) => l.stappen).at(-1)?.stappen;
    assert.deepEqual(told, ['allow', 'allow', 'deny'], 'zoeken en concept: ja; versturen: geweigerd door de eigenaar');
    assert.equal(cards.length, 1, `één kaart: ${cards.map((c) => c.summary).join(' | ')}`);
    assert.equal(cards[0].tool, 'claude-code:mcp__claude_ai_Gmail__send_message');
    assert.equal(cards[0].risk, 'danger');
    assert.match(cards[0].summary, /Gmail: send message — aan klant@example\.com/);
    // Every app of the owner reaches the gate even where his own Claude Code settings would allow it (an ask rule).
    const argv: string[] = logLines(process.env.FAKE_CLI_LOG).filter((l) => l.argv && l.prompt?.includes('STAPPEN')).at(-1).argv;
    assert.deepEqual(settingsOf(argv).permissions?.ask, ['mcp__claude_ai_Gmail', 'mcp__claude_ai_Google_Calendar']);

    // (3) switched off for this bot: off on the page, and Claude Code keeps its tools out of the bot's list.
    const off = (await t.api('PUT', `/cli-agents/agents/${bot.id}/apps/claude_ai_Gmail`, { enabled: false })).apps;
    assert.equal(off.find((a: any) => a.id === 'claude_ai_Gmail').on, false);
    assert.deepEqual(t.app.ctx.store.agent(bot.id)!.settings.cli.appsOff, ['claude_ai_Gmail']);
    await turn(t, th.id, 'Nog eens');
    const run2 = logLines(process.env.FAKE_CLI_LOG).filter((l) => l.argv && l.prompt?.includes('Nog eens')).at(-1);
    const argv2: string[] = run2.argv;
    assert.ok(denied(argv2).includes('mcp__claude_ai_Gmail'));
    // Another connector is still on: Claude Code still connects the claude.ai connectors, and the page says what that means.
    assert.equal(run2.claudeAiOff, false);
    assert.match(off.find((a: any) => a.id === 'claude_ai_Gmail').note, /^Uit voor deze bot: Claude Code laat zijn tools weg; zijn korte uitleg/);
    // Every connector off for this bot: none of them loads in its runs at all (ENABLE_CLAUDEAI_MCP_SERVERS=false).
    await t.api('PUT', `/cli-agents/agents/${bot.id}/apps/claude_ai_Google_Calendar`, { enabled: false });
    await turn(t, th.id, 'Alles uit');
    assert.equal(logLines(process.env.FAKE_CLI_LOG).filter((l) => l.argv && l.prompt?.includes('Alles uit')).at(-1).claudeAiOff, true);
    assert.match((await t.api('GET', `/cli-agents/agents/${bot.id}/apps`)).apps.find((a: any) => a.id === 'claude_ai_Gmail').note, /^Bewaakt door TeamBot/);
    await t.api('PUT', `/cli-agents/agents/${bot.id}/apps/claude_ai_Google_Calendar`, { enabled: true });
    // Its tools stay known while off (Claude Code lists none of them now).
    assert.equal((await t.api('GET', `/cli-agents/agents/${bot.id}/apps`)).apps.find((a: any) => a.id === 'claude_ai_Gmail').tools, 3);
    await t.api('PUT', `/cli-agents/agents/${bot.id}/apps/claude_ai_Gmail`, { enabled: true });
    assert.equal(t.app.ctx.store.agent(bot.id)!.settings.cli.appsOff, undefined);
    // Without "Je eigen apps van het programma gebruiken" the engine loads none: nothing to show.
    await t.api('PATCH', `/agents/${bot.id}`, { settings: { ...t.app.ctx.store.agent(bot.id)!.settings, cli: { useUserMcp: false } } });
    assert.deepEqual((await t.api('GET', `/cli-agents/agents/${bot.id}/apps`)).apps, []);
  } finally {
    delete process.env.FAKE_CLAUDE_INIT;
    delete process.env.FAKE_CLAUDE_MCP_LIST;
    await t.close();
  }
});

test('OpenCode (ACP): een app van de engine zelf gaat langs dezelfde poort; lezen vanzelf, versturen vraagt', async () => {
  const t = await startTestApp();
  process.env.FAKE_CLI_LOG = path.join(t.dir, 'fake-cli.log');
  try {
    const p = await t.api('POST', '/providers', FAKE_ACP);
    const bot = await t.api('POST', '/agents', { name: 'AcpBot', provider_id: p.id, model: '', access_mode: 'full' });
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    const steps = [
      { kind: 'other', title: 'gmail_search_threads', rawInput: { query: 'factuur' } },
      { kind: 'other', title: 'gmail_create_draft', rawInput: { to: 'klant@example.com', body: 'x' } },
      { kind: 'other', title: 'gmail_send_message', rawInput: { to: 'klant@example.com', body: 'x' } },
    ];
    const cards = await turn(t, th.id, `SCENARIO:stappen STAPPEN:${enc(steps)}`);
    assert.deepEqual(logLines(process.env.FAKE_CLI_LOG).filter((l) => l.stappen).at(-1)?.stappen, ['a', 'a', 'r']);
    assert.deepEqual(cards.map((c) => c.tool), [`${p.kind}:mcp__gmail__send_message`]);
  } finally {
    await t.close();
  }
});

test('Codex en OpenCode: hun eigen apps staan bij de bot, uit per bot, en de pagina zegt eerlijk dat TeamBot ze daar niet bewaakt', async () => {
  // The switch per bot reaches the engine: Codex `-c mcp_servers.<id>.enabled=false`, OpenCode its inline config.
  assert.deepEqual(await codexIsolation('codex-bestaat-niet', true, ['gmail', 'kwaad;rm']), ['-c', 'mcp_servers.gmail.enabled=false']);
  const oc = defById('opencode')!;
  const env = JSON.parse(acpModelEnv(oc, undefined, ['gmail']).OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(env.mcp, { gmail: { enabled: false } });
  assert.ok(env.permission, 'de vaste toestemmingen blijven');
  assert.equal(JSON.parse(acpModelEnv(oc, 'opencode/big-pickle', []).OPENCODE_CONFIG_CONTENT).mcp, undefined);

  const t = await startTestApp();
  const home = path.join(t.dir, 'codex-home');
  const cfgDir = path.join(t.dir, 'xdg', 'opencode');
  const old = { CODEX_HOME: process.env.CODEX_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.toml'), '[mcp_servers.gmail]\ncommand = "gmail-mcp"\n\n[mcp_servers.agenda]\ncommand = "agenda-mcp"\n');
  fs.writeFileSync(path.join(cfgDir, 'opencode.json'), JSON.stringify({ mcp: { notion: { type: 'remote', url: 'https://example.com/mcp' } } }));
  process.env.CODEX_HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(t.dir, 'xdg');
  process.env.FAKE_CLI_LOG = path.join(t.dir, 'fake-cli.log');
  try {
    const cx = await t.api('POST', '/providers', FAKE_CODEX);
    const bot = await t.api('POST', '/agents', { name: 'CodexBot', provider_id: cx.id, model: '', access_mode: 'full' });
    const apps = (await t.api('GET', `/cli-agents/agents/${bot.id}/apps`)).apps;
    assert.deepEqual(apps.map((a: any) => [a.id, a.on]), [['gmail', true], ['agenda', true]]);
    assert.match(apps[0].note, /^Niet bewaakt door TeamBot: .*Codex.*versturen/);
    await t.api('PUT', `/cli-agents/agents/${bot.id}/apps/gmail`, { enabled: false });
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    await turn(t, th.id, 'Hallo');
    const argv: string[] = logLines(process.env.FAKE_CLI_LOG).filter((l) => Array.isArray(l.argv) && l.argv[0] === 'exec').at(-1)?.argv || [];
    assert.ok(argv.join(' ').includes('mcp_servers.gmail.enabled=false'), argv.join(' '));
    assert.ok(!argv.join(' ').includes('mcp_servers.agenda.enabled=false'));

    const op = await t.api('POST', '/providers', { kind: 'opencode', config: { path: path.join(here, 'fixtures', 'cli-agents-fake-acp.mjs') } }).catch(() => null);
    if (op) {
      const ob = await t.api('POST', '/agents', { name: 'OcBot', provider_id: op.id, model: '', access_mode: 'auto' });
      const oa = (await t.api('GET', `/cli-agents/agents/${ob.id}/apps`)).apps;
      assert.deepEqual(oa.map((a: any) => a.id), ['notion']);
      assert.match(oa[0].note, /^Niet bewaakt door TeamBot: OpenCode/);
    }
  } finally {
    for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    await t.close();
  }
});

test('Claude Code: een TeamBot-tool die de instructies van de bot noemen, staat bij naam in de lijst en werkt meteen bij een directe aanroep', async () => {
  const t = await startTestApp();
  const bridge = new PermissionBridge(t.dir);
  try {
    const ctx = t.app.ctx;
    const p = await t.api('POST', '/providers', FAKE_CLAUDE);
    // The first bot is the main bot (it has teambot_find in its list); the second one reaches it on demand.
    await t.api('POST', '/agents', { name: 'Hoofd', provider_id: p.id, model: '', access_mode: 'full' });
    const a = await t.api('POST', '/agents', { name: 'Collega', provider_id: p.id, model: '', access_mode: 'full' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    const input = ctx.store.createMessage({ thread_id: th.id, role: 'user', author_type: 'user', author_id: a.user_id, author_name: 'Ik', content: 'zet mijn meldingen uit' } as any);
    const run = ctx.store.createRun({ thread_id: th.id, agent_id: a.id, user_id: a.user_id, status: 'running', trigger: 'user', input_message_id: input.id } as any);
    const system = await ctx.services.runner.systemPrompt(ctx.store.agent(a.id)!, ctx.store.thread(th.id)!);
    assert.match(system, /teambot_find/, 'de instructies noemen teambot_find');
    const scope = makeScope(ctx, ctx.providers.config(p.id)!, { model: '', system, prompt: 'x', attachments: [], workspace: a.workspace, accessMode: a.access_mode, agentId: a.id, threadId: th.id, runId: run.id, userId: a.user_id } as any, new AbortController().signal, () => {});
    const host = teambotTools(scope, { engine: 'claude' });
    const specs = await host.list();
    const find = specs.find((x) => x.name === 'teambot_find');
    // Claude Code calls only names in its list: the tool is there, by name only (its own tool search loads the rest).
    assert.ok(find, `teambot_find staat in de lijst: ${specs.map((x) => x.name).join(', ')}`);
    assert.equal(find._meta?.['anthropic/alwaysLoad'], false);
    assert.ok((await host.names()).includes('teambot_find'), 'en mag zonder vraag van Claude Code (allowedTools)');
    assert.ok(specs.filter((x) => x._meta?.['anthropic/alwaysLoad'] === false).every((x) => system.includes(x.name)), 'alleen wat de instructies noemen');
    // The direct call, as Claude Code makes it, over the bridge: it works the first time.
    await bridge.ensure();
    const reg = bridge.register({ tools: host }, path.join(t.dir, 'cli-agents', 'runs', run.id));
    const srv = bridge.stdioServer(reg, { tools: true });
    const child = spawn(srv.command, srv.args, { env: { ...process.env, ...srv.env }, stdio: ['pipe', 'pipe', 'inherit'] });
    const pending = new Map<number, (m: any) => void>();
    readline.createInterface({ input: child.stdout! }).on('line', (l) => {
      const m = JSON.parse(l);
      pending.get(m.id)?.(m);
    });
    let id = 0;
    const req = (method: string, params: any) => new Promise<any>((r) => (pending.set(++id, r), child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')));
    await req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.ok((await req('tools/list', {})).result.tools.some((x: any) => x.name === 'teambot_find'));
    const r = await req('tools/call', { name: 'teambot_find', arguments: { query: 'meldingen' } });
    child.kill();
    reg.dispose();
    assert.equal(r.result?.isError, false, JSON.stringify(r.result?.content?.[0]?.text || r).slice(0, 300));
    assert.doesNotMatch(r.result.content[0].text, /Onbekend hulpmiddel/);
  } finally {
    bridge.stop();
    await t.close();
  }
});

test('een routine op Claude Code: de samenvatting is het eindantwoord, niet de werktekst die de engine tussen zijn stappen schreef', async () => {
  const t = await startTestApp();
  process.env.FAKE_CLI_LOG = path.join(t.dir, 'fake-cli.log');
  try {
    const p = await t.api('POST', '/providers', FAKE_CLAUDE);
    const bot = await t.api('POST', '/agents', { name: 'Notitiebot', provider_id: p.id, model: '', access_mode: 'auto' });
    const r = await t.api('POST', '/routines', { name: 'Notities', agent_id: bot.id, prompt: 'Kijk de notities na. SCENARIO:werktekst', schedule: { kind: 'none' } });
    const rr = await t.api('POST', `/routines/${r.id}/run`, {});
    const row = () => t.app.ctx.store.get<any>('routine_runs', rr.id);
    for (let i = 0; i < 400 && !['done', 'failed', 'no_update'].includes(row()?.status); i++) await new Promise((res) => setTimeout(res, 25));
    // The chat keeps everything the engine said; the routine's result is the answer.
    const msg = t.app.ctx.store.all<any>("SELECT content FROM messages WHERE run_id = ? AND role = 'assistant'", row().run_id).at(-1);
    assert.match(msg.content, /The timestamp came out as 19:21/);
    assert.equal(row().status, 'done');
    assert.equal(row().summary, 'Om 19:21 stonden er geen nieuwe notities.');
    assert.equal(t.app.ctx.store.get<any>('routines', r.id).last_summary, 'Om 19:21 stonden er geen nieuwe notities.');
  } finally {
    await t.close();
  }
});
