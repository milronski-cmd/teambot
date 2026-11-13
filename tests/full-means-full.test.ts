import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startTestApp, type TestApp } from './helpers.js';
import { Broker, callRisk } from '../server/tools/broker.js';
import { resolveInWorkspace, wholeComputer } from '../server/tools/builtin/files.js';
import { fullHardline, isHardline, shellCommandImpact } from '../server/tools/builtin/command-risk.js';
import { shellTools } from '../server/tools/builtin/shell.js';
import { claudeToolRisk, gate } from '../server/modules/cli-agents/permissions.js';
import { buildClaudeArgs, claudeDenyRules, CLAUDE_KEPT_OUT, type ClaudeFeatures } from '../server/modules/cli-agents/claude.js';
import { cliOptions } from '../server/modules/cli-agents/context.js';
import { startProc } from '../server/modules/cli-agents/proc.js';
import { toolSpec, mcpTokens } from '../server/modules/cli-agents/toolhost.js';
import { reviewStep, ruleTopics } from '../server/modules/botrules/review.js';
import { classifySideEffect } from '../server/modules/browser/screen-policy.js';
import { classifyAction } from '../server/modules/browser/policy.js';
import { STARTER_RULES } from '../server/modules/teams/service.js';
import { CALL_NAME, FIND_NAME, onDemand } from '../server/tools/selection.js';
import { SAVER_DEFAULTS } from '../server/agent/context-budget.js';
import { DEFAULT_LIMITS } from '../server/modules/rooms/routing.js';
import { loopLimits, maxSteps } from '../server/agent/loops.js';
import type { Agent } from '../server/core/types.js';

/**
 * "Volledige toegang" is really full (the owner, 12 nov): no built-in block, limit or question. What stays: his own
 * rules and paying, and the real key store (key files, the folders he closed, TeamBot's own data).
 */

const A = (t: TestApp, id: string) => t.app.ctx.store.agent(id) as Agent;
const gs = (t: TestApp, agent: Agent) => ({ ctx: t.app.ctx, agent, thread: null, run: null, userId: agent.user_id, signal: new AbortController().signal, ns: 'claude-code' });
const cards = (t: TestApp) => t.api('GET', '/approvals?status=all') as Promise<any[]>;
const pending = async (t: TestApp) => {
  for (let i = 0; i < 80; i++) {
    const x = (await t.api('GET', '/approvals')).find((y: any) => y.status === 'pending');
    if (x) return x;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
};
const reviews = (t: TestApp) => t.requests.filter((q: any) => /regels van de eigenaar/.test(String(q.system)));
/** The two rules every team starts with, on this bot, exactly as teams/service.ts stores them. */
function starterRules(t: TestApp, agent: Agent) {
  const rules = t.app.ctx.services.botRules._service;
  for (const d of STARTER_RULES) {
    const r = rules.parse(agent.user_id, d.text);
    rules.add(agent.user_id, { agentId: agent.id }, d.text, { ...r, ...(d.match ? { match: d.match } : {}), ...(d.review !== undefined ? { review: d.review } : {}) });
  }
}

const F: ClaudeFeatures = { partial: true, appendFile: true, restricted: true, permissionPrompts: true, tools: true, effort: true, settingSources: true, settings: true, modes: ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'] };
const flag = (a: string[], f: string) => (a.includes(f) ? a[a.indexOf(f) + 1] : undefined);

test('files on full: everywhere outside the work folder, a project .env too; a key file, a closed folder and TeamBot data stay refused', async () => {
  const t = await startTestApp();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-vol-'));
  const dicht = path.join(base, 'Sleutels');
  try {
    fs.mkdirSync(dicht);
    fs.writeFileSync(path.join(dicht, 'BANK_KEY'), 'geheim');
    fs.writeFileSync(path.join(base, 'notitie.txt'), 'van de eigenaar');
    await t.api('PUT', '/settings', { closedFolders: [dicht] });
    const a = await t.agent({ access_mode: 'full', tool_groups: ['files'] });
    const agent = A(t, a.id);
    const g = gs(t, agent);
    // the CLI's own tools (Read/Write/Bash reach the gate when they leave the work folder)
    for (const [tool, risk, p] of [
      ['Read', 'read', path.join(base, 'notitie.txt')],
      ['Write', 'write', path.join(base, 'nieuw', 'antwoord.txt')],
      ['Write', 'write', path.join(base, 'app', '.env')],
      ['Edit', 'write', path.join(a.workspace, 'app', '.env.local')],
    ] as const) {
      const r = await gate(g, { tool, risk, summary: 'x', input: { file_path: p }, paths: [p] });
      assert.deepEqual([r.allow, r.asked], [true, false], `${tool} ${p}`);
    }
    for (const p of [path.join(dicht, 'BANK_KEY'), path.join(os.homedir(), '.ssh', 'id_rsa'), path.join(t.app.ctx.config.dataDir, 'teambot.db'), path.join(t.app.ctx.config.dataDir, 'master.key')]) {
      const r = await gate(g, { tool: 'Read', risk: 'read', summary: 'x', input: { file_path: p }, paths: [p] });
      assert.equal(r.allow, false, `refused: ${p}`);
      assert.equal((await gate(g, { tool: 'Bash', risk: 'exec', summary: 'x', input: {}, command: `cat "${p}"` })).allow, false, `refused in a command: ${p}`);
    }
    // a closed folder inside one of the bot's own folders stays closed too
    const inside = path.join(a.workspace, 'kluis');
    await t.api('PUT', '/settings', { closedFolders: [dicht, inside] });
    assert.throws(() => resolveInWorkspace(A(t, a.id), path.join(inside, 'x.txt')), /dicht voor bots/);
    assert.equal((await cards(t)).length, 0, 'nothing was asked');

    // the same on TeamBot's own engine, in a real turn
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push(
      { toolCalls: [{ name: 'write_file', args: { path: path.join(base, 'project', '.env'), content: 'PORT=3000' } }] },
      { toolCalls: [{ name: 'read_file', args: { path: path.join(dicht, 'BANK_KEY') } }] },
      { text: 'Klaar.' },
    );
    await t.say(th.id, 'zet de poort in .env');
    assert.equal(fs.readFileSync(path.join(base, 'project', '.env'), 'utf8'), 'PORT=3000');
    const log = JSON.stringify(t.app.ctx.store.messages(th.id, { limit: 40 }));
    assert.match(log, /dicht voor bots/);
    assert.doesNotMatch(log, /geheim"/);
    assert.equal((await cards(t)).length, 0);
  } finally {
    await t.close();
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('Claude Code flags on full: no --restricted, the terminal always, own settings and apps, deny rules for closed folders; little stays off', () => {
  const base = { maxTurns: 10_000, addDirs: [], allowedTools: [], disallowedTools: [], extraArgs: [], mcpConfigFile: 'x.json', cwd: path.resolve('werk') };
  const dicht = process.platform === 'win32' ? 'C:\\Users\\eigenaar\\Sleutels' : '/home/eigenaar/Sleutels';
  const full = buildClaudeArgs(F, { ...base, mode: 'auto', full: true, whole: true, loadUserSettings: true, useUserMcp: true, ownerMemory: false, denyPaths: [dicht] });
  assert.ok(!full.includes('--restricted'), 'the file tools are not confined to the work folder');
  assert.ok(!full.includes('--tools'), 'every built-in tool');
  assert.ok(!full.includes('--strict-mcp-config'), "the owner's own apps (MCP servers)");
  assert.ok(!full.includes('--setting-sources'), "the owner's own settings and skills");
  assert.equal(flag(full, '--permission-prompt-tool'), 'mcp__teambot__permission_prompt', 'what leaves the work folder reaches the gate');
  const deny = flag(full, '--disallowedTools')!.split(',');
  assert.deepEqual(deny.sort(), [...CLAUDE_KEPT_OUT].sort(), 'only what breaks a TeamBot turn stays off');
  for (const tool of ['Bash', 'PowerShell', 'Monitor', 'TaskStop', 'Workflow', 'SendMessage', 'EnterWorktree']) assert.ok(!deny.includes(tool), `${tool} is the bot's`);
  const settings = JSON.parse(flag(full, '--settings')!);
  const want = process.platform === 'win32' ? '//c/Users/eigenaar/Sleutels' : '//home/eigenaar/Sleutels';
  assert.deepEqual(settings.permissions.deny, [`Read(${want})`, `Read(${want}/**)`, `Edit(${want})`, `Edit(${want}/**)`]);
  assert.ok(Array.isArray(settings.claudeMdExcludes), "the owner's own CLAUDE.md is not the bot's instruction");
  assert.deepEqual(claudeDenyRules(['relatief', '']), []);

  // without the terminal part ticked: still a terminal on full
  const noGroup = buildClaudeArgs(F, { ...base, mode: 'auto', full: true, whole: true, loadUserSettings: true, useUserMcp: true, shell: false });
  assert.doesNotMatch(flag(noGroup, '--disallowedTools')!, /\bBash\b|\bPowerShell\b/);
  // a full bot that stays in its own folders (a member's bot): still confined, still with a terminal
  const own = buildClaudeArgs(F, { ...base, mode: 'auto', full: true, whole: false, loadUserSettings: false, useUserMcp: false });
  assert.ok(own.includes('--restricted'));
  assert.match(flag(own, '--tools')!, /\bBash\b/);
  // "Automatisch" is unchanged
  const auto = buildClaudeArgs(F, { ...base, mode: 'auto', loadUserSettings: false, useUserMcp: false });
  assert.ok(auto.includes('--restricted') && auto.includes('--strict-mcp-config'));
  assert.match(flag(auto, '--disallowedTools')!, /\bBash\b.*\bMonitor\b|\bMonitor\b.*\bBash\b/);
  for (const tool of ['TaskStop', 'Workflow', 'SendMessage', 'EnterWorktree']) assert.notEqual(claudeToolRisk(tool, {}), 'danger', `${tool} is ordinary work`);
});

test('the fixed blocklist on full: only wiping the drive or the whole profile; shutdown, registry and bcdedit run', () => {
  const o = { home: process.platform === 'win32' ? 'C:\\Users\\sam' : '/home/sam', systemDrive: 'C:' };
  const wipes = ['format C:', 'format c: /q', 'cmd /c format c: /fs:ntfs', 'rm -rf /', 'rm -rf ~', 'sudo rm -rf /*', 'rm -rf $HOME', 'cd /tmp && rm -rf ~/', 'Remove-Item -Recurse -Force C:\\', 'Remove-Item C:\\ -Recurse -Force', 'Remove-Item -Recurse $env:USERPROFILE', 'rd /s /q C:\\', 'del /s /q C:\\*', 'Format-Volume -DriveLetter C', 'Clear-Disk -Number 0', 'mkfs.ext4 /dev/sda1', 'dd if=/dev/zero of=/dev/sda bs=1M'];
  for (const c of wipes) assert.equal(fullHardline(c, o), true, `refused: ${c}`);
  if (process.platform === 'win32') assert.equal(fullHardline('Remove-Item -Recurse -Force C:\\Users\\sam', o), true, 'the whole user profile');
  const fine = [
    'shutdown /r /t 0',
    'Restart-Computer -Force',
    'reg delete HKLM\\Software\\Oud /f',
    'bcdedit /set testsigning on',
    'vssadmin delete shadows /all',
    'rm -rf build',
    'rm -rf ./node_modules /tmp/cache',
    'Remove-Item -Recurse -Force C:\\Users\\sam\\Projecten\\oud',
    'Remove-Item -Recurse -Force .\\dist',
    'rd /s /q C:\\temp\\x',
    'echo "format c: is gevaarlijk"',
    'git commit -m "shutdown van de oude server"',
    'format D:',
    'npx prettier --write . && echo format klaar',
  ];
  for (const c of fine) assert.equal(fullHardline(c, o), false, `runs: ${c}`);
  // below full the old list still holds
  assert.equal(isHardline('shutdown /r /t 0', false), true);
  assert.equal(isHardline('shutdown /r /t 0', true), false);
});

test('git push, deploy and an API call run without a question on full; a payment still asks; this computer (127.0.0.1) is allowed', async () => {
  const t = await startTestApp();
  const server = http.createServer((_q, r) => r.end('<html><body><h1>lokale app</h1></body></html>'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const local = `http://127.0.0.1:${(server.address() as any).port}/`;
  try {
    // no fullAccessExternal at all: going live is the bot's own work, not "sending to others"
    const a = await t.agent({ access_mode: 'full', tool_groups: ['files', 'web'] });
    const agent = A(t, a.id);
    for (const c of ['git push origin main', 'vercel --prod', 'gh pr create --fill', 'npm publish', 'curl -X POST https://api.example.com/deploy -d a=1', 'ssh root@server.nl "systemctl restart app"', 'rm -rf build']) {
      const r = await gate(gs(t, agent), { tool: 'Bash', risk: claudeToolRisk('Bash', { command: c }), summary: c, input: { command: c }, command: c });
      assert.deepEqual([r.allow, r.asked], [true, false], c);
      assert.equal(shellCommandImpact(c), 'local');
    }
    const run = shellTools()[0];
    assert.equal(t.app.ctx.broker.decide(agent, { name: 'run_command', risk: callRisk(run, { command: 'git push' }, { agent, thread: {} as any, userId: agent.user_id }), impact: run.impact }, { command: 'git push' }), 'allow', "TeamBot's own terminal");
    // an unknown tool of Claude Code itself is local work; an app of the owner (MCP) is "to others"
    assert.equal((await gate(gs(t, agent), { tool: 'NieuweTool', risk: 'danger', summary: 'x', input: {} })).allow, true);
    const b = new Broker(() => null as any);
    assert.equal(b.decide(agent, { name: 'claude-code:mcp__gmail__send:danger', risk: 'danger', impact: 'external' }), 'ask', 'sending without "ook versturen naar anderen"');
    assert.equal(b.decide({ ...agent, settings: { fullAccessExternal: true } }, { name: 'browser_submit', risk: 'danger', impact: 'payment' }), 'ask', 'a payment always asks');

    // this computer and the home network
    const fetchLocal = await gate(gs(t, agent), { tool: 'WebFetch', risk: 'read', summary: 'x', input: { url: local }, url: local });
    assert.equal(fetchLocal.allow, true, 'the CLI may read http://127.0.0.1');
    const auto = A(t, (await t.agent({ access_mode: 'auto', tool_groups: ['files', 'web'] })).id);
    assert.equal((await gate(gs(t, auto), { tool: 'WebFetch', risk: 'read', summary: 'x', input: { url: local }, url: local })).allow, false, 'other levels: unchanged');
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ toolCalls: [{ name: 'web_fetch', args: { url: local } }] }, { text: 'Gelezen.' });
    await t.say(th.id, 'kijk of de app draait');
    assert.match(JSON.stringify(t.app.ctx.store.messages(th.id, { limit: 20 })), /lokale app/);
    assert.equal(t.app.ctx.services.computers.config(a.id).allow_private, true, "the bot's own browser too");
    assert.equal(t.app.ctx.services.computers.config(auto.id).allow_private, false);
    assert.equal((await cards(t)).length, 0, 'no card anywhere');

    // a payment in a real turn: the card comes
    t.app.ctx.tools.register({ name: 'pay_invoice', group: 'files', risk: 'danger', impact: 'payment', description: 'test', parameters: { type: 'object', properties: { amount: { type: 'number' } } }, run: async () => 'betaald' });
    await t.api('PATCH', `/agents/${a.id}`, { settings: { fullAccessExternal: true } });
    t.script.push({ toolCalls: [{ name: 'pay_invoice', args: { amount: 49 } }] }, { text: 'Niet betaald.' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'betaal de factuur' });
    const card = await pending(t);
    assert.ok(card, 'a payment asks, also on full with sending allowed');
    assert.equal(card.tool, 'pay_invoice');
    await t.api('POST', `/approvals/${card.id}`, { decision: 'deny' });
    await t.waitIdle(th.id);
  } finally {
    server.close();
    await t.close();
  }
});

test('the starting rules: no reviewer call for a file write or a command; a message to a customer is checked and asks; a reviewer that is down does not stop work', async () => {
  // which steps can pay or send at all
  const step = (name: string, risk: any, args: any = {}, extra: any = {}) => reviewStep({ name, risk, args, ...extra });
  for (const [n, r, a] of [
    ['write_file', 'write', { path: 'a.txt', content: 'betaling binnen' }],
    ['run_command', 'exec', { command: 'npm run build' }],
    ['run_command', 'danger', { command: 'git push origin main' }],
    ['run_command', 'danger', { command: 'vercel --prod' }],
    ['run_command', 'exec', { command: 'curl -X POST http://127.0.0.1:3000/api/orders -d a=1' }],
    ['claude-code:Write', 'write', { paths: ['C:/x/prijzen.md'] }],
    ['claude-code:Bash', 'exec', { command: 'grep -r payment src/' }],
    ['claude-code:SendMessage', 'write', {}],
    ['browser_click', 'write', { ref: 'e1' }],
    ['mcp_notion_update_page', 'write', { title: 'Planning' }],
  ] as const)
    assert.equal(step(n, r, a), null, `no review: ${n} ${JSON.stringify(a)}`);
  assert.deepEqual(step('channel_send', 'danger', { text: 'hoi' }, { impact: 'external' }), { pay: false, send: true, strong: true });
  assert.equal(step('channel_send', 'danger', { text: 'hoi' }, { impact: 'local' }), null, 'to the owner himself');
  assert.equal(step('browser_submit', 'danger', { description: 'bestelling' }, { impact: 'payment' })?.strong, true);
  assert.equal(step('mcp_shopify_create_refund', 'write', { order: 1 })?.pay, true);
  assert.equal(step('claude-code:mcp__gmail__send_email', 'danger', {})?.send, true);
  assert.deepEqual(step('claude-code:Bash', 'danger', { command: 'curl -X POST https://api.stripe.com/v1/refunds -d charge=ch_1' }), { pay: true, send: true, strong: true });
  assert.deepEqual(step('run_command', 'danger', { command: 'curl -X POST https://api.example.com/hook -d a=1' }), { pay: true, send: true, strong: false }, 'possible, not certain');
  assert.equal(step('run_command', 'danger', { command: 'Send-MailMessage -To klant@example.com -Subject Klacht' })?.strong, true);
  assert.deepEqual(ruleTopics({ text: STARTER_RULES[0].text, match: { verb: 'any' } }), { pay: true, send: false });
  assert.deepEqual(ruleTopics({ text: STARTER_RULES[1].text, match: STARTER_RULES[1].match as any }), { pay: false, send: true });
  assert.equal(ruleTopics({ text: 'Wees altijd beleefd', match: { verb: 'any' } }), null, 'another rule: every changing step, as before');

  const t = await startTestApp();
  try {
    const a = await t.agent({ access_mode: 'full', tool_groups: ['files', 'shell'], settings: { fullAccessExternal: true } });
    starterRules(t, A(t, a.id));
    assert.equal(t.app.ctx.services.botRules.forAgent(A(t, a.id)).filter((r: any) => r.review).length, 2);
    const th = await t.api('POST', '/threads', { agentId: a.id });
    const audits = () => t.app.ctx.store.all<any>("SELECT kind FROM audit WHERE kind LIKE 'autoreview.%'").map((x) => x.kind);

    // ordinary work: instantly, no model call, no card
    t.script.push({ toolCalls: [{ name: 'write_file', args: { path: 'plan.md', content: 'budget en betaling uitwerken' } }] }, { toolCalls: [{ name: 'run_command', args: { command: 'echo klaar' } }] }, { text: 'Klaar.' });
    await t.say(th.id, 'schrijf het plan');
    assert.equal(fs.readFileSync(path.resolve(a.workspace, 'plan.md'), 'utf8'), 'budget en betaling uitwerken');
    assert.equal(reviews(t).length, 0, 'no reviewer call for a plain file write or command');
    assert.deepEqual(audits(), []);
    assert.equal(t.requests.length, 3, 'only the three model calls of the turn itself');
    for (const c of ['git push origin main', 'npm run build']) assert.equal((await gate(gs(t, A(t, a.id)), { tool: 'Bash', risk: claudeToolRisk('Bash', { command: c }), summary: c, input: { command: c }, command: c })).allow, true, c);
    const edit = await gate(gs(t, A(t, a.id)), { tool: 'Write', risk: 'write', summary: 'x', input: {}, paths: [path.join(a.workspace, 'b.txt')] });
    assert.deepEqual([edit.allow, edit.asked], [true, false], 'a CLI file write: no reviewer, no question');
    assert.equal((await cards(t)).length, 0);

    // a message to a customer: the reviewer reads it, and an important one asks the owner (his rule)
    t.app.ctx.tools.register({ name: 'send_mail', group: 'files', risk: 'danger', impact: 'external', description: 'test', parameters: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } } }, run: async () => 'verstuurd' });
    t.script.push({ toolCalls: [{ name: 'send_mail', args: { to: 'klant@example.com', body: 'Over uw klacht en de terugbetaling' } }] }, { text: '{"verdict":"ask","reason":"Een klacht van een klant, met geld"}' }, { text: 'Ik wacht op je akkoord.' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'beantwoord de klacht' });
    const card = await pending(t);
    assert.ok(card, 'the important message asks');
    assert.match(card.summary, /Automatische controle: Een klacht van een klant/);
    assert.equal(reviews(t).length, 1);
    assert.match(JSON.stringify(reviews(t)[0].messages), /belangrijk bericht aan anderen/);
    await t.api('POST', `/approvals/${card.id}`, { decision: 'deny' });
    await t.waitIdle(th.id);

    // an ordinary reply: checked, runs, no card
    t.script.push({ toolCalls: [{ name: 'send_mail', args: { to: 'klant@example.com', body: 'De afspraak staat op dinsdag.' } }] }, { text: '{"verdict":"allow","reason":"Gewoon antwoord"}' }, { text: 'Verstuurd.' });
    await t.say(th.id, 'bevestig de afspraak');
    assert.equal((await t.api('GET', '/approvals')).length, 0);
    assert.equal(reviews(t).length, 2);

    // the reviewer is down (unreadable twice) on a step that only might pay or send: the work goes on
    t.script.push({ toolCalls: [{ name: 'run_command', args: { command: 'Write-Output "curl -X POST https://api.example.invalid/hook -d a=1"' } }] }, { text: 'geen json' }, { text: '' }, { text: 'Gedaan.' });
    await t.say(th.id, 'roep de webhook aan');
    assert.equal((await t.api('GET', '/approvals')).length, 0, 'a failed check does not turn ordinary work into a question');
    assert.ok(audits().includes('autoreview.skipped'));
    // … but on a real message it asks
    t.script.push({ toolCalls: [{ name: 'send_mail', args: { to: 'nieuw@example.com', body: 'Eerste kennismaking' } }] }, { text: 'geen json' }, { text: '' }, { text: 'Ik wacht.' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'mail het nieuwe contact' });
    const card2 = await pending(t);
    assert.ok(card2, 'a message with a failed check asks');
    assert.match(card2.summary, /gaf geen leesbaar antwoord/);
    await t.api('POST', `/approvals/${card2.id}`, { decision: 'deny' });
    await t.waitIdle(th.id);
  } finally {
    await t.close();
  }
});

test('every part on full: terminal and desktop without ticking them, desktop in all apps without a question per action, request_part at once', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent({ access_mode: 'full', tool_groups: ['files', 'web', 'browser', 'memory', 'team', 'skills', 'routines'] });
    const auto = await t.agent({ access_mode: 'auto', tool_groups: ['files', 'web', 'browser'] });
    const tools = t.app.ctx.tools;
    for (const g of ['shell', 'desktop', 'browser', 'channels', 'rehearsal']) assert.equal(tools.groupEnabled(A(t, a.id), g), true, `${g} on full`);
    for (const g of ['container', 'remote']) assert.equal(tools.groupEnabled(A(t, a.id), g), false, `${g} needs a setup first`);
    assert.equal(tools.groupEnabled(A(t, auto.id), 'shell'), false, 'other levels: what is ticked');
    assert.equal(tools.groupEnabled({ ...A(t, a.id), settings: { sharedRun: {} } } as Agent, 'shell'), false, 'never a shared run');
    assert.equal(tools.groupEnabled({ ...A(t, a.id), settings: { partsNarrowed: true } } as Agent, 'shell'), false, 'a routine that narrowed the parts');
    const th0 = await t.api('POST', '/threads', { agentId: a.id });
    const names = (await tools.forAgent(A(t, a.id), t.app.ctx.store.thread(th0.id)!)).map((x) => x.name);
    for (const n of ['run_command', 'desktop_computer', 'desktop_windows', 'browser_open']) assert.ok(names.includes(n), `${n} is offered`);

    // the desktop: one switch
    const cfg = t.app.ctx.services.computers.config(a.id);
    if (process.platform === 'win32') {
      assert.equal(cfg.mode, 'host');
      assert.equal(cfg.host_control, true);
      assert.equal(cfg.host_options.allApps, true, 'every app, no list of allowed windows to fill in');
      assert.equal(cfg.host_level, 'auto', 'no question per action');
    } else assert.equal(cfg.mode, 'browser');
    const other = t.app.ctx.services.computers.config(auto.id);
    assert.equal(other.host_control, false);
    assert.ok(!t.app.ctx.store.get('computer_configs', a.id, 'agent_id'), 'nothing was stored: lowering the level takes it away again');
    // what still asks on the desktop and in the browser: paying and sending
    const click = (name: string, full: boolean) => classifySideEffect({ action: 'click', target: { process: 'chrome', elementName: name } }, { full }).danger;
    assert.deepEqual([click('Verwijderen', true), click('Install', true), click('Publiceren', true), click('Bevestigen', true)], [false, false, false, false]);
    assert.deepEqual([click('Nu betalen', true), click('Bestellen', true), click('Versturen', true)], [true, true, true]);
    assert.equal(click('Verwijderen', false), true, 'other levels: unchanged');
    assert.equal(classifySideEffect({ action: 'key', keys: [['enter']], target: { process: 'whatsapp' } }, { full: true }).danger, true, 'a message in a chat app');
    assert.equal(classifyAction({ tag: 'button', name: 'Delete repository' }, { full: true }).risk, 'write');
    assert.equal(classifyAction({ tag: 'button', name: 'Sign in', submits: true, formMethod: 'post' }, { full: true }).risk, 'write');
    assert.equal(classifyAction({ tag: 'button', name: 'Pay now' }, { full: true }).risk, 'danger');
    assert.equal(classifyAction({ tag: 'button', name: 'Delete repository' }).risk, 'danger');

    // request_part: a part that needs a setup is switched on at once, no card
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ toolCalls: [{ name: 'request_part', args: { part: 'remote', why: 'de server bijwerken' } }] }, { text: 'Ik ga verder.' }, { text: 'Verder.' });
    await t.say(th.id, 'werk de server bij');
    assert.ok(A(t, a.id).tool_groups.includes('remote'));
    assert.equal((await cards(t)).length, 0, 'no question');

    // a routine the bot makes simply runs
    t.script.push({ toolCalls: [{ name: 'routine_create', args: { name: 'Ochtendronde', prompt: 'Kijk de mail na', schedule_kind: 'daily', times: ['08:00'] } }] }, { text: 'Staat aan.' });
    await t.say(th.id, 'doe dit elke ochtend');
    const routine = t.app.ctx.store.all<any>('SELECT name, status FROM routines');
    assert.deepEqual(routine.map((r) => [r.name, r.status]), [['Ochtendronde', 'active']], 'not a draft that waits for the owner');
    assert.equal((await cards(t)).length, 0);
  } finally {
    await t.close();
  }
});

test('limits: nothing that stops real work; a silent CLI with a step still running is alive, a silent one without is stopped', async () => {
  const full = { id: 'a', user_id: 'u', access_mode: 'full', settings: {}, tool_groups: [] } as any as Agent;
  const auto = { ...full, access_mode: 'auto' } as Agent;
  const o = cliOptions(full);
  assert.deepEqual([o.maxTurns, o.idleMin, o.busyIdleMin, o.timeoutMin], [10_000, 30, 720, 4320]);
  assert.deepEqual([o.loadUserSettings, o.useUserMcp, o.ownerMemory], [true, true, false], "the owner's Claude settings, skills and apps; not his own CLAUDE.md");
  assert.deepEqual([cliOptions(auto).loadUserSettings, cliOptions(auto).useUserMcp, cliOptions(auto).maxTurns], [false, false, 40]);
  const off = cliOptions({ ...full, settings: { cli: { loadUserSettings: false, useUserMcp: false, maxTurns: 25 } } } as Agent);
  assert.deepEqual([off.loadUserSettings, off.useUserMcp, off.maxTurns], [false, false, 25], "the owner's own choice per bot wins");
  assert.equal(cliOptions({ ...full, settings: { cli: { loadUserSettings: true } } } as Agent).ownerMemory, true);
  assert.equal(maxSteps(full), 10_000);
  assert.equal(maxSteps(auto), 40);
  assert.equal(maxSteps({ ...full, settings: { maxTurns: 12 } } as Agent), 12);
  assert.deepEqual(loopLimits(full), { repeat: 10, idle: 20 });
  assert.deepEqual([DEFAULT_LIMITS.maxCostUsd, DEFAULT_LIMITS.maxChainCostUsd, DEFAULT_LIMITS.maxTokens, DEFAULT_LIMITS.maxChainTokens], [0, 0, 0, 0], 'no money or token cap on bot-to-bot work');
  assert.ok(DEFAULT_LIMITS.delegationTimeoutSec === 0 && DEFAULT_LIMITS.turnTimeoutSec === 0 && DEFAULT_LIMITS.maxStepsPerTurn === 0 && DEFAULT_LIMITS.maxTurnsPerMessage === 0 && DEFAULT_LIMITS.maxDelegationDepth === 0, "0 = no time-out, step cap, turn cap or depth cap (tests/rooms-loop.test.ts)");
  const run = shellTools()[0];
  assert.match(JSON.stringify(run.parameters), /standaard 600.*86400/);

  // liveness: 1.2 s of silence with an idle limit of 300 ms
  const silent = (busy: boolean) => {
    const ctl = new AbortController();
    const p = startProc({ bin: process.execPath, args: ['-e', 'setTimeout(() => console.log("klaar"), 1200)'], cwd: os.tmpdir(), signal: ctl.signal, timeoutMs: 60_000, idleMs: 300, busy: () => busy, busyIdleMs: 30_000, onLine: () => {} });
    return p.done.then((r) => ({ code: r.code, killed: p.killedReason }));
  };
  const working = await silent(true);
  assert.deepEqual(working, { code: 0, killed: null }, 'a step is running: not stopped');
  const hung = await silent(false);
  assert.match(String(hung.killed), /gaf .* geen uitvoer/, 'nothing is running: stopped');
});

test('tools: a full bot reaches every tool it has: in its list, or found by its name and used', async (tt) => {
  const t = await startTestApp();
  try {
    const a = await t.agent({ access_mode: 'full', tool_groups: ['files', 'web', 'browser', 'memory', 'team', 'skills', 'routines'] });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    const all = await t.app.ctx.tools.forAgent(A(t, a.id), t.app.ctx.store.thread(th.id)!);
    const d = onDemand({ tools: all, groups: t.app.ctx.tools.groups, guides: [], who: { agent: A(t, a.id), thread: t.app.ctx.store.thread(th.id)!, userId: a.user_id }, on: SAVER_DEFAULTS.selectTools, told: new Set() });
    tt.diagnostic(`a bot on Volledige toegang: ${all.length} TeamBot tools (about ${mcpTokens(all.map(toolSpec))} tokens of definitions), ${d.listed.length} in its list (about ${mcpTokens(d.listed.map(toolSpec))} tokens per model call)`);
    assert.ok(d.active && d.listed.length <= 26, `${d.listed.length} listed`);
    assert.equal(d.listed.length - 2 + d.rest.length, all.length, 'every tool is in the list or outside it, none lost');
    const find = d.listed.find((x) => x.name === FIND_NAME)!;
    for (const tool of d.rest) {
      assert.ok(new RegExp(`\\b${tool.name}\\b`).test(find.description), `${tool.name} is named in tools_find`);
      assert.deepEqual(d.resolve(CALL_NAME, { name: tool.name, args: {} }), { name: tool.name, args: {} }, `${tool.name} is used by its name`);
    }
    for (const n of ['browser_click', 'routine_create', 'task_create', 'my_settings']) assert.match(((await find.run({ query: n }, {} as any)) as any).text, new RegExp(`### ${n}\\n[\\s\\S]*velden: `), `${n}: found with its fields`);
  } finally {
    await t.close();
  }
});

test('whole computer is the owner\'s own bots only', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent({ access_mode: 'full' });
    assert.ok(wholeComputer(A(t, a.id)));
    assert.equal(wholeComputer({ ...A(t, a.id), settings: { ownFoldersOnly: true } } as Agent), null);
    assert.equal(wholeComputer({ ...A(t, a.id), settings: { sharedRun: {} } } as Agent), null);
  } finally {
    await t.close();
  }
});
