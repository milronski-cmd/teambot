import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestApp, type TestApp } from './helpers.js';
import { buildClaudeArgs, claudeStatusText, readableReset, type ClaudeFeatures } from '../server/modules/cli-agents/claude.js';
import { acpPath, fatalStderrError, pickAcpMode } from '../server/modules/cli-agents/acp.js';
import { checkExtraArgs, defById, installLines } from '../server/modules/cli-agents/catalog.js';
import { claudeToolRisk, commandRisk, gate } from '../server/modules/cli-agents/permissions.js';
import { isHardline } from '../server/tools/builtin/command-risk.js';
import { CODEX_ASK_NOTE, codexExecArgs } from '../server/modules/cli-agents/codex.js';
import { cmdQuote } from '../server/modules/cli-agents/proc.js';
import { contextState, contextUpdate, promptSections } from '../server/modules/cli-agents/context.js';
import { cliModelList } from '../server/modules/cli-agents/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(here, 'fixtures', 'cli-agents-fake-claude.mjs');
const FAKE_ACP = path.join(here, 'fixtures', 'cli-agents-fake-acp.mjs');
const FAKE_CODEX = path.join(here, 'fixtures', 'cli-agents-fake-codex.mjs');

process.env.TEAMBOT_TEST_SECRET = 'mag-niet-lekken';
process.env.MY_API_KEY = 'sk-mag-ook-niet-lekken';

function useLog(t: TestApp) {
  const file = path.join(t.dir, 'fake-cli.log');
  process.env.FAKE_CLI_LOG = file;
  return () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
}

async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 10_000, what = 'voorwaarde'): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - start > ms) throw new Error(`time-out: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function cliBot(t: TestApp, kind: string, config: any, agent: any = {}) {
  const p = await t.api('POST', '/providers', { kind, config });
  const a = await t.api('POST', '/agents', { name: 'CliBot', provider_id: p.id, model: '', access_mode: 'ask', ...agent });
  const th = await t.api('POST', '/threads', { agentId: a.id });
  return { p, a, th };
}

const lastMsg = (t: TestApp, threadId: string) => t.app.ctx.store.messages(threadId).filter((m) => m.role === 'assistant').at(-1)!;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------- unit

const F: ClaudeFeatures = { partial: true, appendFile: true, restricted: true, permissionPrompts: true, tools: true, effort: true, modes: ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'] };
const base = { maxTurns: 10, addDirs: [], allowedTools: [], disallowedTools: [], extraArgs: [], loadUserSettings: false, useUserMcp: false };
const flag = (a: string[], f: string) => (a.includes(f) ? a[a.indexOf(f) + 1] : undefined);

test('access modes map strictly to Claude Code flags', () => {
  const chat = buildClaudeArgs(F, { ...base, mode: 'chat' });
  assert.equal(flag(chat, '--tools'), '');
  assert.equal(flag(chat, '--permission-prompts'), 'none');
  assert.ok(chat.includes('--strict-mcp-config'));
  assert.ok(!chat.includes('--mcp-config'));

  const ro = buildClaudeArgs(F, { ...base, mode: 'readonly', mcpConfigFile: 'x.json', allowedTools: ['Bash'] });
  assert.equal(flag(ro, '--permission-mode'), 'plan');
  assert.equal(flag(ro, '--permission-prompts'), 'none');
  assert.ok(!ro.includes('--mcp-config'), 'readonly never gets an approval channel');
  assert.ok(!ro.includes('--allowedTools'), 'readonly ignores extra allowed tools');
  assert.match(flag(ro, '--disallowedTools')!, /Bash/);
  assert.ok(ro.includes('--restricted'));

  const ask = buildClaudeArgs(F, { ...base, mode: 'ask', mcpConfigFile: 'x.json', sessionId: 's1', model: 'opus', systemFile: 'sys.md' });
  assert.equal(flag(ask, '--permission-mode'), 'default');
  assert.equal(flag(ask, '--permission-prompt-tool'), 'mcp__teambot__permission_prompt');
  assert.equal(flag(ask, '--resume'), 's1');
  assert.equal(flag(ask, '--model'), 'opus');
  assert.equal(flag(ask, '--append-system-prompt-file'), 'sys.md');
  assert.ok(!ask.includes('--dangerously-skip-permissions') && !ask.includes('bypassPermissions'));

  const auto = buildClaudeArgs(F, { ...base, mode: 'auto', mcpConfigFile: 'x.json' });
  assert.equal(flag(auto, '--permission-mode'), 'acceptEdits');

  // --restricted with "--tools default" silently dropped Bash/PowerShell: tools are named explicitly, and the shell
  // only for bots with terminal rights (found while dogfooding: Claude Code bots could not run commands).
  const withShell = buildClaudeArgs(F, { ...base, mode: 'auto', mcpConfigFile: 'x.json', shell: true });
  assert.match(flag(withShell, '--tools')!, /\bBash\b/);
  assert.match(flag(withShell, '--tools')!, /\bPowerShell\b/);
  assert.doesNotMatch(flag(withShell, '--disallowedTools') || '', /\bBash\b/);
  const noShell = buildClaudeArgs(F, { ...base, mode: 'ask', mcpConfigFile: 'x.json' });
  assert.doesNotMatch(flag(noShell, '--tools')!, /\bBash\b/);
  assert.match(flag(noShell, '--disallowedTools')!, /\bBash\b/);
  assert.match(flag(noShell, '--tools')!, /\bRead\b.*\bWebSearch\b/);
  const old = buildClaudeArgs({ ...F, restricted: false, permissionPrompts: false, tools: false, modes: ['default', 'plan'] }, { ...base, mode: 'chat' });
  assert.match(flag(old, '--disallowedTools')!, /Read/);
  for (const mode of ['chat', 'readonly', 'ask', 'auto'] as const) assert.ok(!buildClaudeArgs(F, { ...base, mode }).some((x) => /bypass|dangerously/i.test(x)));
  // "Internet" off for the bot: Claude Code's own WebFetch/WebSearch are off too (acceptance round 3: a bot with only
  // memory tools still read example.com through a sub-agent).
  for (const mode of ['readonly', 'ask', 'auto'] as const) {
    assert.match(flag(buildClaudeArgs(F, { ...base, mode, mcpConfigFile: 'x.json', web: false }), '--disallowedTools')!, /\bWebFetch\b.*\bWebSearch\b|\bWebSearch\b.*\bWebFetch\b/, mode);
    assert.doesNotMatch(flag(buildClaudeArgs(F, { ...base, mode, mcpConfigFile: 'x.json', web: true }), '--disallowedTools') || '', /WebFetch|WebSearch/, mode);
  }
});

test('Claude Code usage limit: the reset is shown in words and still read by reserves and routines', async () => {
  const { resetTimeFrom } = await import('../server/agent/fallback.js');
  const { parseLimitReset, isQuotaWindow } = await import('../server/modules/routines/limits.js');
  const now = Date.parse('2026-11-07T08:00:00Z');
  const at = now + 3600_000;
  const shown = 'Gebruikslimiet van je Claude-abonnement of account bereikt. Probeer het later opnieuw. ' + readableReset(`Claude AI usage limit reached|${at / 1000}`, now);
  assert.doesNotMatch(shown, /\|\d{10}/, 'no raw Unix time for the user');
  assert.match(shown, /opnieuw mogelijk over 60 minuten, rond \d\d:\d\d/);
  assert.ok(Math.abs(resetTimeFrom(shown, now)! - at) < 60_000, 'reserve engines know when to go back');
  assert.ok(Math.abs(parseLimitReset(shown, now)! - at) < 60_000, 'a routine waits for the same reset');
  assert.ok(isQuotaWindow(shown));
  assert.equal(readableReset('Iets anders ging mis', now), 'Iets anders ging mis');
});

test('gate: a web page fetched by the CLI itself is refused when "Internet" is off for the bot', async () => {
  const audits: any[] = [];
  const ctx: any = {
    config: {},
    audit: (_u: string, kind: string, d: any) => audits.push({ kind, ...d }),
    tools: { groupEnabled: (a: any, g: string) => a.tool_groups.includes(g) },
    broker: { decide: () => 'allow', request: async () => ({ approved: true }) },
  };
  const mk = (groups: string[]) => ({ ctx, agent: { id: 'a1', name: 'Bot', access_mode: 'ask', workspace: os.tmpdir(), tool_groups: groups, settings: {} }, thread: null, run: null, userId: 'u', signal: new AbortController().signal, ns: 'claude-code' }) as any;
  const req = { tool: 'WebFetch', risk: 'read' as const, summary: 'Webpagina lezen: https://example.com', input: { url: 'https://example.com' }, url: 'https://example.com' };
  const off = await gate(mk(['memory']), req);
  assert.equal(off.allow, false);
  assert.match(off.message, /Internet staat uit/);
  assert.equal(audits.at(-1).allowed, false);
  const on = await gate(mk(['memory', 'web']), req);
  assert.equal(on.allow, true);
  // Not a web fetch (no url): the web group does not matter.
  assert.equal((await gate(mk(['memory']), { tool: 'Read', risk: 'read', summary: 'Lezen', input: {} })).allow, true);
});

test('risk classification, hard blocklist and argument allowlists', () => {
  assert.equal(claudeToolRisk('Read', {}), 'read');
  assert.equal(claudeToolRisk('Write', {}), 'write');
  assert.equal(claudeToolRisk('Bash', { command: 'npm test' }), 'exec');
  assert.equal(claudeToolRisk('Bash', { command: 'git push origin main' }), 'danger');
  assert.equal(claudeToolRisk('mcp__other__send_email', {}), 'danger');
  assert.equal(commandRisk('curl -X POST https://x.test -d a=1'), 'danger');
  assert.ok(isHardline('rm -rf /'));
  const claude = defById('claude-code')!;
  assert.deepEqual(checkExtraArgs(claude, ['--fallback-model', 'sonnet']), ['--fallback-model', 'sonnet']);
  assert.throws(() => checkExtraArgs(claude, ['--dangerously-skip-permissions']), /niet toegestaan/);
  assert.throws(() => checkExtraArgs(claude, ['--fallback-model', 'a;rm']), /Ongeldige/);
  assert.throws(() => checkExtraArgs(defById('codex-cli')!, ['--dangerously-bypass-approvals-and-sandbox']), /niet toegestaan/);
  assert.throws(() => cmdQuote('a & calc'), /cmd\.exe/);
  const ex = codexExecArgs({ sandbox: 'read-only', cwd: 'C:/w', addDirs: ['C:/x'], images: [], sessionId: 'sid', extra: [] });
  assert.equal(flag(ex, '-s'), 'read-only');
  assert.ok(!ex.includes('--add-dir'), 'read-only never gets writable dirs');
  assert.deepEqual(ex.slice(-3), ['resume', 'sid', '-']);
});

test('install instructions that are no command are marked as text (shown translated, not as code to copy)', () => {
  // Acceptance round 5 (C-15): "Op Windows alleen via WSL." and the Goose download note stood in Dutch in the English
  // interface, inside a code box with a copy button.
  for (const id of ['goose', 'auggie', 'antigravity']) {
    const lines = installLines(defById(id)!);
    assert.ok(lines.some((l) => l.note), id);
    assert.ok(lines.every((l) => (l.label === 'Let op') === !!l.note), id);
  }
  assert.ok(installLines(defById('auggie')!).some((l) => l.note && /WSL/.test(l.cmd)));
  assert.ok(!installLines(defById('opencode')!).some((l) => l.note), 'commands stay commands');
});

test('ACP mode picking is never broader than the bot mode', () => {
  const modes = [{ id: 'default' }, { id: 'plan' }, { id: 'yolo' }];
  assert.deepEqual(pickAcpMode('readonly', 'default', modes), { set: 'plan' });
  assert.deepEqual(pickAcpMode('ask', 'yolo', modes), { set: 'default' });
  assert.deepEqual(pickAcpMode('auto', 'default', modes), {});
  assert.ok(pickAcpMode('ask', 'yolo', [{ id: 'yolo' }]).refuse);
});

test('OpenCode usage stats: --standalone on 2.x (no shared background service), retried without it for 1.x', async () => {
  const { readOpencodeStats } = await import('../server/modules/cli-agents/usage.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-oc-stats-'));
  try {
    assert.deepEqual(await readOpencodeStats(FAKE_ACP, dir), { input: 1200, output: 300, cost: 0, sessions: 3 });
    process.env.FAKE_OC_V1 = '1';
    assert.deepEqual(await readOpencodeStats(FAKE_ACP, dir), { input: 1200, output: 300, cost: 0, sessions: 3 }, '1.x: again without the flag');
  } finally {
    delete process.env.FAKE_OC_V1;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('OpenCode model list: --standalone (2.x shared service port may be taken by another OpenCode), older versions retried without', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-oc-models-'));
  try {
    const v2 = path.join(dir, 'oc-v2.mjs');
    fs.writeFileSync(v2, "if (!process.argv.includes('--standalone')) { console.error('Managed service port 28894 is already in use'); process.exit(1); }\nconsole.log('opencode/big-pickle\\nopencode/beam-free');\n");
    const v1 = path.join(dir, 'oc-v1.mjs');
    fs.writeFileSync(v1, "if (process.argv.includes('--standalone')) { console.error('unknown flag --standalone'); process.exit(1); }\nconsole.log('opencode/big-pickle');\n");
    const list = await cliModelList(v2, ['models', '--standalone']);
    const ids = list.map((m: any) => m.id);
    assert.deepEqual(ids.sort(), ['opencode/beam-free', 'opencode/big-pickle']);
    // In words in the model picker, never the raw id (acceptance round 4).
    assert.deepEqual(list.map((m: any) => m.label).sort(), ['Beam · gratis', 'Big Pickle · gratis']);
    assert.deepEqual((await cliModelList(v1, ['models', '--standalone'])).map((m: any) => m.id), ['opencode/big-pickle']);
    assert.deepEqual(defById('opencode')?.modelsArgs, ['models', '--standalone']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude Code states are shown in plain Dutch, never the raw English code', () => {
  assert.equal(claudeStatusText('requesting'), 'Denkt na…');
  assert.equal(claudeStatusText('compacting'), 'Vat het gesprek samen…');
  assert.equal(claudeStatusText('some_new_state'), 'Bezig…');
  assert.equal(claudeStatusText(null), 'Bezig…');
});

// ---------------------------------------------------------------- Claude Code (fake CLI)

test('claude: streams text/reasoning, stores session, resumes, keeps secrets and system prompt out of argv/env', async () => {
  const t = await startTestApp();
  const logs = useLog(t);
  try {
    const { a, th } = await cliBot(t, 'claude-code', { path: FAKE_CLAUDE }, { instructions: 'GEHEIME INSTRUCTIE' });
    const deltas: string[] = [];
    const off = t.app.ctx.events.subscribe((e) => e.type === 'message.delta' && deltas.push(e.data.text));
    await t.say(th.id, 'Hallo daar');
    off?.();
    const m = lastMsg(t, th.id);
    assert.equal(m.status, 'done');
    assert.equal(m.content, 'Hallo van Claude', 'text from partial deltas, not duplicated by the final assistant message');
    assert.equal(m.parts.reasoning, 'even denken');
    assert.ok(m.parts.activity?.some((x: any) => x.kind === 'session'));
    assert.equal(m.usage?.cost, 0, 'subscription login → no extra cost');
    assert.equal(m.usage?.input, 14);
    const sid = t.app.ctx.store.thread(th.id)!.provider_state[a.provider_id].sessionId;
    assert.ok(sid);
    let L = logs();
    assert.equal(L[0].prompt.includes('Hallo daar'), true, 'prompt via stdin');
    assert.ok(!L[0].argv.join(' ').includes('Hallo daar'));
    assert.ok(!L[0].argv.join(' ').includes('GEHEIME INSTRUCTIE'), 'system prompt not in argv');
    assert.match(L[0].system, /GEHEIME INSTRUCTIE/);
    assert.equal(L[0].leakedSecret, false);
    assert.equal(path.resolve(L[0].cwd).toLowerCase(), path.resolve(a.workspace).toLowerCase());
    await t.say(th.id, 'Nog een vraag');
    L = logs();
    assert.equal(flag(L[1].argv, '--resume'), sid);
    const runDir = path.join(t.dir, 'cli-agents', 'runs');
    assert.equal(fs.existsSync(runDir) ? fs.readdirSync(runDir).length : 0, 0, 'temp files cleaned up');
  } finally {
    await t.close();
  }
});

test('"maak een profiel" works with a CLI engine (Claude Code) as well: one-shot answer without tools', async () => {
  const t = await startTestApp();
  const logs = useLog(t);
  try {
    const p = await t.api('POST', '/providers', { kind: 'claude-code', config: { path: FAKE_CLAUDE } });
    const r = await t.api('POST', '/agents/generate', { description: 'Een bot die klantvragen beantwoordt', provider_id: p.id });
    assert.equal(r.draft.name, 'Fietshulp');
    // The model chose only memory; every bot also gets the team tools (ask and delegate), like the starters and templates.
    assert.deepEqual(r.draft.tool_groups, ['memory', 'team']);
    assert.equal(r.provider_id, p.id);
    const call = logs().find((l: any) => l.mode === 'complete');
    assert.ok(call, 'ran claude -p once');
    assert.equal(flag(call.argv, '--max-turns'), '1');
    assert.equal(flag(call.argv, '--permission-mode'), 'plan', 'no tools may change anything');
  } finally {
    await t.close();
  }
});

test('"maak een profiel" with a CLI that disappeared: a clear error with a way out, and no bot is created', async () => {
  const t = await startTestApp();
  try {
    const tmp = path.join(t.dir, 'weg-claude.mjs');
    fs.copyFileSync(FAKE_CLAUDE, tmp);
    const p = await t.api('POST', '/providers', { kind: 'claude-code', config: { path: tmp } });
    fs.rmSync(tmp);
    const before = (await t.api('GET', '/agents')).length;
    await assert.rejects(t.api('POST', '/agents/generate', { description: 'Een bot die klantvragen beantwoordt', provider_id: p.id }), /niet gevonden op deze computer\. Installeer de CLI of stel het pad in/);
    assert.equal((await t.api('GET', '/agents')).length, before);
  } finally {
    await t.close();
  }
});

test('claude ask mode: permission prompt → Broker → approve writes, deny does not', async () => {
  const t = await startTestApp();
  const logs = useLog(t);
  try {
    const { a, th } = await cliBot(t, 'claude-code', { path: FAKE_CLAUDE }, { access_mode: 'ask' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'SCENARIO:perm schrijf' });
    const ap = await until(async () => (await t.api('GET', '/approvals')).find((x: any) => x.status === 'pending'), 10_000, 'approval');
    assert.equal(ap.tool, 'claude-code:Write');
    assert.equal(ap.risk, 'write');
    assert.equal(ap.thread_id, th.id);
    // Q-12: while the card waits, the step says what the bot wants to do — not "Schreef perm.txt".
    const steps = () => (lastMsg(t, th.id).parts.activity || []).map((x: any) => x.title);
    await until(() => steps().includes('Wil perm.txt schrijven'), 5000, 'stap "Wil perm.txt schrijven"');
    assert.ok(!steps().includes('Schreef perm.txt'), JSON.stringify(steps()));
    await t.api('POST', `/approvals/${ap.id}`, { decision: 'approve' });
    await t.waitIdle(th.id);
    assert.equal(fs.readFileSync(path.join(a.workspace, 'perm.txt'), 'utf8'), 'hallo');
    assert.match(lastMsg(t, th.id).content, /Gedaan/);
    assert.ok(steps().includes('Schreef perm.txt') && !steps().includes('Wil perm.txt schrijven'), 'one step, past tense once done: ' + JSON.stringify(steps()));
    fs.rmSync(path.join(a.workspace, 'perm.txt'));

    await t.api('POST', `/threads/${th.id}/messages`, { content: 'SCENARIO:perm nog eens' });
    const ap2 = await until(async () => (await t.api('GET', '/approvals')).find((x: any) => x.status === 'pending'), 10_000, 'approval 2');
    await t.api('POST', `/approvals/${ap2.id}`, { decision: 'deny' });
    await t.waitIdle(th.id);
    assert.equal(fs.existsSync(path.join(a.workspace, 'perm.txt')), false);
    assert.match(lastMsg(t, th.id).content, /geweigerd/i);
    assert.equal(logs().filter((l) => l.decision).at(-1).decision.behavior, 'deny');
  } finally {
    await t.close();
  }
});

test('claude auto mode: writes auto-approved, danger still asks, outside workspace always denied', async () => {
  const t = await startTestApp();
  const logs = useLog(t);
  try {
    const { a, th } = await cliBot(t, 'claude-code', { path: FAKE_CLAUDE }, { access_mode: 'auto' });
    await t.say(th.id, 'SCENARIO:perm');
    assert.equal(fs.readFileSync(path.join(a.workspace, 'perm.txt'), 'utf8'), 'hallo');
    assert.equal((await t.api('GET', '/approvals?status=all')).length, 0, 'no human needed for a write in auto mode');

    await t.say(th.id, 'SCENARIO:outside');
    assert.equal(logs().filter((l) => l.decision).at(-1).decision.behavior, 'deny');
    assert.match(logs().filter((l) => l.decision).at(-1).decision.message, /buiten/);
    assert.equal((await t.api('GET', '/approvals?status=all')).length, 0);

    await t.api('POST', `/threads/${th.id}/messages`, { content: 'SCENARIO:danger' });
    const ap = await until(async () => (await t.api('GET', '/approvals')).find((x: any) => x.status === 'pending'), 10_000, 'danger approval');
    assert.equal(ap.risk, 'danger');
    assert.equal(ap.tool, 'claude-code:Bash', 'one name per tool: what the owner chose for Bash holds for every command');
    await t.api('POST', `/approvals/${ap.id}`, { decision: 'deny' });
    await t.waitIdle(th.id);
    const audit = t.app.ctx.store.all<any>("SELECT * FROM audit WHERE kind = 'cli.permission'");
    assert.ok(audit.length >= 3);
  } finally {
    await t.close();
  }
});

test('claude readonly/chat: no approval channel, prompts denied in print mode', async () => {
  const t = await startTestApp();
  const logs = useLog(t);
  try {
    const { a, th } = await cliBot(t, 'claude-code', { path: FAKE_CLAUDE }, { access_mode: 'readonly' });
    await t.say(th.id, 'SCENARIO:perm');
    const L = logs();
    assert.equal(flag(L[0].argv, '--permission-mode'), 'plan');
    assert.ok(!L[0].argv.includes('--permission-prompt-tool'), 'readonly: no approval channel (only TeamBot read tools over MCP)');
    assert.equal(fs.existsSync(path.join(a.workspace, 'perm.txt')), false);
    assert.equal((await t.api('GET', '/approvals?status=all')).length, 0);
    await t.api('PATCH', `/agents/${a.id}`, { access_mode: 'chat' });
    await t.say(th.id, 'gewoon praten');
    assert.equal(flag(logs().filter((l) => l.argv)[1].argv, '--tools'), '');
  } finally {
    await t.close();
  }
});

test('claude: stop kills the whole process tree', async () => {
  const t = await startTestApp();
  const logs = useLog(t);
  try {
    const { th } = await cliBot(t, 'claude-code', { path: FAKE_CLAUDE });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'SCENARIO:hang' });
    const info = await until(() => logs().find((l) => l.grandchild), 10_000, 'grandchild');
    assert.ok(alive(info.self) && alive(info.grandchild));
    const r = await t.api('POST', `/threads/${th.id}/stop`, {});
    assert.equal(r.stopped, 1);
    await t.waitIdle(th.id);
    await until(() => !alive(info.self) && !alive(info.grandchild), 10_000, 'processes gone');
    const run = t.app.ctx.store.all<any>('SELECT status FROM runs WHERE thread_id = ?', th.id)[0];
    assert.equal(run.status, 'cancelled');
    assert.equal(lastMsg(t, th.id).status, 'cancelled');
  } finally {
    await t.close();
  }
});

test('claude: crash, idle time-out and login errors end up as clear chat errors', async () => {
  const t = await startTestApp();
  useLog(t);
  try {
    const { a, th } = await cliBot(t, 'claude-code', { path: FAKE_CLAUDE }, { settings: { cli: { idleMin: 0.02 } } });
    await t.say(th.id, 'SCENARIO:crash');
    let m = lastMsg(t, th.id);
    assert.equal(m.status, 'error');
    // Q-03: a plain sentence with what to do; the exit code and the last output only behind "Details".
    assert.match(m.parts.error!, /^Claude Code stopte onverwacht\. Probeer het opnieuw\./);
    assert.doesNotMatch(m.parts.error!, /exitcode|boom/);
    assert.match(m.parts.errorDetail, /onverwacht.*exitcode 3.*boom/s);
    await t.say(th.id, 'SCENARIO:login');
    m = lastMsg(t, th.id);
    assert.match(m.parts.error!, /claude auth login/);
    await t.say(th.id, 'SCENARIO:silent', 15_000);
    m = lastMsg(t, th.id);
    assert.equal(m.status, 'error');
    assert.match(m.parts.error!, /geen uitvoer/);
    assert.ok(a);
  } finally {
    await t.close();
  }
});

test('claude: lost session falls back to a new session with earlier context', async () => {
  const t = await startTestApp();
  const logs = useLog(t);
  try {
    const { a, th } = await cliBot(t, 'claude-code', { path: FAKE_CLAUDE });
    await t.say(th.id, 'eerste vraag over appels');
    await t.say(th.id, 'SCENARIO:badresume tweede');
    const m = lastMsg(t, th.id);
    assert.equal(m.status, 'done');
    assert.ok(m.parts.activity?.some((x: any) => /niet gevonden/.test(x.title)));
    const L = logs();
    assert.equal(L.length, 3);
    assert.ok(!L[2].argv.includes('--resume'));
    assert.match(L[2].prompt, /eerder_gesprek[\s\S]*appels/);
    assert.ok(t.app.ctx.store.thread(th.id)!.provider_state[a.provider_id].sessionId);
  } finally {
    await t.close();
  }
});

test('sessions are kept per bot and thread; reset and provider switch are visible in the chat', async () => {
  const t = await startTestApp();
  const logs = useLog(t);
  try {
    const p = await t.api('POST', '/providers', { kind: 'claude-code', config: { path: FAKE_CLAUDE } });
    const a1 = await t.api('POST', '/agents', { name: 'Een', provider_id: p.id, access_mode: 'ask' });
    const a2 = await t.api('POST', '/agents', { name: 'Twee', provider_id: p.id, access_mode: 'ask' });
    const s = t.app.ctx.store;
    const th = s.createThread({ user_id: a1.user_id, agent_id: a1.id, kind: 'room' });
    const round = async (text: string, agents: any[]) => {
      const um = s.createMessage({ thread_id: th.id, role: 'user', author_type: 'user', author_id: a1.user_id, author_name: 'Sanne', content: text });
      for (const a of agents) t.app.ctx.runs.enqueue({ threadId: th.id, agentId: a.id, userId: a1.user_id, inputMessageId: um.id });
      await t.waitIdle(th.id);
    };
    await round('hoi allebei', [a1, a2]);
    let sessions = await t.api('GET', `/cli-agents/threads/${th.id}/sessions`);
    assert.equal(sessions.length, 2);
    assert.notEqual(sessions[0].sessionId, sessions[1].sessionId);
    await round('nog een keer', [a1, a2]);
    const resumed = logs().filter((l) => l.argv).slice(-2).map((l) => flag(l.argv, '--resume')).sort();
    assert.deepEqual(resumed, sessions.map((x: any) => x.sessionId).sort(), 'each bot resumes its own session');

    const r = await t.api('POST', `/cli-agents/threads/${th.id}/sessions/reset`, { agentId: a1.id });
    assert.equal(r.reset, 1);
    sessions = await t.api('GET', `/cli-agents/threads/${th.id}/sessions`);
    assert.equal(sessions.length, 1);
    assert.ok(s.messages(th.id).some((m) => m.role === 'event' && /Nieuwe CLI-sessie voor Een/.test(m.content)));
    await round('na reset', [a1]);
    const last = logs().filter((l) => l.argv).at(-1);
    assert.ok(!last.argv.includes('--resume'));
    assert.match(last.prompt, /eerder_gesprek/);

    const pa = await t.api('POST', '/providers', { kind: 'acp-custom', config: { command: FAKE_ACP } });
    await t.api('PATCH', `/agents/${a2.id}`, { provider_id: pa.id });
    await round('na wissel', [a2]);
    const switched = s.messages(th.id).find((m) => m.role === 'event' && /Twee werkt nu met Eigen ACP-agent/.test(m.content));
    assert.ok(switched);
    // Acceptance round 3 (C-09): the event stood under the answer it explains.
    const answer = s.messages(th.id).filter((m) => m.role === 'assistant' && m.author_id === a2.id).at(-1)!;
    assert.ok(switched!.seq < answer.seq, 'the switch event comes before the answer');
    assert.match(logs().filter((l) => l.method === 'session/prompt').at(-1).params.text, /eerder_gesprek/);
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------- ACP

test('acp: streaming, plan/tool activity, session load and edit permission via Broker + fs inside workspace', async () => {
  const t = await startTestApp();
  const logs = useLog(t);
  try {
    const { a, th, p } = await cliBot(t, 'acp-custom', { command: FAKE_ACP, args: [] }, { access_mode: 'ask' });
    await t.say(th.id, 'hallo acp');
    let m = lastMsg(t, th.id);
    assert.equal(m.content, 'Hoi van ACP');
    assert.equal(m.parts.reasoning, 'nadenken');
    assert.deepEqual(m.parts.plan?.steps, [{ text: 'Stap 1', status: 'in_progress' }], 'the ACP plan is the plan card');
    assert.ok(m.parts.activity?.some((x: any) => x.title === 'Lees README'));
    assert.equal(m.usage?.output, 7);
    const sid = t.app.ctx.store.thread(th.id)!.provider_state[p.id].sessionId;
    assert.match(sid, /^acp-/);

    await t.api('POST', `/threads/${th.id}/messages`, { content: 'SCENARIO:edit' });
    const ap = await until(async () => (await t.api('GET', '/approvals')).find((x: any) => x.status === 'pending'), 10_000, 'acp approval');
    assert.equal(ap.tool, 'acp-custom:edit');
    await t.api('POST', `/approvals/${ap.id}`, { decision: 'approve' });
    await t.waitIdle(th.id);
    m = lastMsg(t, th.id);
    assert.equal(m.content, 'Bestand geschreven.', 'replayed history from session/load is not shown again');
    assert.equal(fs.readFileSync(path.join(a.workspace, 'acp.txt'), 'utf8'), 'via acp');
    const L = logs();
    assert.ok(L.some((l) => l.method === 'session/load' && l.params.sessionId === sid));
    assert.equal(L.find((l) => l.permission).permission.outcome.optionId, 'ok1', 'allow_once, never allow_always');
    const prompt = L.filter((l) => l.method === 'session/prompt');
    assert.match(prompt[0].params.text, /teambot_instructies/, 'system prompt in first prompt of a new session');
    assert.doesNotMatch(prompt[1].params.text, /teambot_instructies/, 'not repeated on a loaded session');
  } finally {
    await t.close();
  }
});

test('acp readonly: plan mode, reads only inside workspace, writes and execute denied without asking', async () => {
  const t = await startTestApp();
  const logs = useLog(t);
  try {
    const { a, th } = await cliBot(t, 'acp-custom', { command: FAKE_ACP }, { access_mode: 'readonly' });
    fs.writeFileSync(path.join(a.workspace, 'lees.txt'), 'inhoud');
    await t.say(th.id, 'SCENARIO:read');
    const L = logs();
    assert.ok(L.some((l) => l.method === 'session/set_mode' && l.params.modeId === 'plan'));
    const r = L.find((l) => l.inside);
    assert.equal(r.inside.result.content, 'inhoud');
    assert.ok(r.outside.error, 'outside workspace refused');
    assert.ok(r.write.error, 'write refused in readonly');
    assert.equal(fs.existsSync(path.join(a.workspace, 'stiekem.txt')), false);
    await t.say(th.id, 'SCENARIO:exec');
    assert.equal(logs().filter((l) => l.permission).at(-1).permission.outcome.optionId, 'r');
    assert.equal((await t.api('GET', '/approvals?status=all')).length, 0);
  } finally {
    await t.close();
  }
});

test('acp: yolo start mode is switched back, auto mode auto-approves exec but asks for danger, crash and auth errors', async () => {
  const t = await startTestApp();
  const logs = useLog(t);
  try {
    const { a, th } = await cliBot(t, 'acp-custom', { command: FAKE_ACP, args: ['--start-yolo'] }, { access_mode: 'auto' });
    await t.say(th.id, 'SCENARIO:exec');
    assert.ok(logs().some((l) => l.method === 'session/set_mode' && l.params.modeId === 'default'));
    assert.equal(logs().filter((l) => l.permission).at(-1).permission.outcome.optionId, 'a');
    assert.equal((await t.api('GET', '/approvals?status=all')).length, 0);

    await t.api('POST', `/threads/${th.id}/messages`, { content: 'SCENARIO:exec git push' });
    const ap = await until(async () => (await t.api('GET', '/approvals')).find((x: any) => x.status === 'pending'), 10_000, 'danger approval');
    assert.equal(ap.risk, 'danger');
    await t.api('POST', `/approvals/${ap.id}`, { decision: 'deny' });
    await t.waitIdle(th.id);
    assert.equal(logs().filter((l) => l.permission).at(-1).permission.outcome.optionId, 'r');

    await t.say(th.id, 'SCENARIO:crash');
    assert.equal(lastMsg(t, th.id).status, 'error');

    await t.api('PATCH', `/agents/${a.id}`, { access_mode: 'chat' });
    await t.say(th.id, 'chat');
    assert.match(lastMsg(t, th.id).parts.error!, /Chatmodus/);

    const b = await cliBot(t, 'acp-custom', { command: FAKE_ACP, args: ['--need-auth'] });
    await t.say(b.th.id, 'hoi');
    assert.match(lastMsg(t, b.th.id).parts.error!, /inloggen|log zelf in/i);
  } finally {
    await t.close();
  }
});

test('acp: stop sends session/cancel (graceful), and kills an agent that ignores it', async () => {
  const t = await startTestApp();
  const logs = useLog(t);
  try {
    for (const args of [[], ['--ignore-cancel']]) {
      const { th } = await cliBot(t, 'acp-custom', { command: FAKE_ACP, args });
      const before = logs().filter((l) => l.method === 'session/cancel').length;
      await t.api('POST', `/threads/${th.id}/messages`, { content: 'SCENARIO:hang' });
      await until(() => logs().filter((l) => l.method === 'session/prompt').length > (args.length ? 1 : 0), 10_000, 'prompt');
      const started = Date.now();
      await t.api('POST', `/threads/${th.id}/stop`, {});
      await t.waitIdle(th.id, 15_000);
      assert.equal(logs().filter((l) => l.method === 'session/cancel').length, before + 1);
      assert.equal(t.app.ctx.store.all<any>('SELECT status FROM runs WHERE thread_id = ?', th.id)[0].status, 'cancelled');
      assert.equal(lastMsg(t, th.id).status, 'cancelled');
      if (!args.length) assert.ok(Date.now() - started < 2500, 'cooperative agent stops quickly');
    }
  } finally {
    await t.close();
  }
});

test('acp: OpenCode 1.x that only logs a model error (free usage limit) ends the turn with that error, no 10-minute wait', async () => {
  // Acceptance round 4: TeamBot's own OpenCode 1.19.5 logged "Free usage limit reached" and never answered the turn;
  // the chat showed "Denkt na…" for 10 minutes and then only "Time-out: de CLI gaf 10 min geen uitvoer".
  const line = 'timestamp=x level=ERROR run=1 message="stream error" providerID=opencode modelID=big-pickle small=false agent=build error.error="AI_APICallError: Free usage limit reached. Free models work in OpenCode"';
  assert.match(fatalStderrError(line)!, /^Free usage limit reached\. Free models work in OpenCode/);
  assert.equal(fatalStderrError(line.replace('small=false', 'small=true')), null, 'the title agent does not end the turn');
  assert.equal(fatalStderrError('timestamp=x level=INFO message="stream" small=false'), null);
  process.env.FAKE_ACP_VERSION = '1.19.5';
  const t = await startTestApp();
  const logs = useLog(t);
  try {
    const { th } = await cliBot(t, 'opencode', { path: FAKE_ACP });
    const started = Date.now();
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Hallo SCENARIO:loggedlimit' });
    await t.waitIdle(th.id, 20_000);
    assert.ok(Date.now() - started < 15_000, 'ends at once, not at the idle time-out');
    const launch = logs().find((l) => Array.isArray(l.argv) && l.argv.includes('acp'))?.argv || [];
    assert.ok(launch.includes('--print-logs'), 'OpenCode 1.x runs with its log on stderr: ' + JSON.stringify(launch));
    const m = lastMsg(t, th.id);
    assert.match(JSON.stringify(m.parts?.error || '') + m.content, /gratis limiet van OpenCode is bereikt/);
    // The agent writes its log line itself, a moment after TeamBot sent the cancel (robust under load: wait for it).
    await until(() => logs().some((l) => l.method === 'session/cancel'), 10_000, 'the waiting turn is cancelled');
  } finally {
    delete process.env.FAKE_ACP_VERSION;
    await t.close();
  }
});

test('acp: OpenCode 2.x (TeamBot\'s own copy) starts as plain "opencode acp" and its free-limit error ends the turn in seconds', async () => {
  // OpenCode 2.2.6 refuses 1.x's "--log-level ERROR" (it only prints its help and exits) and answers the free limit
  // as an error of session/prompt (errorName "provider.free-limit", live).
  const t = await startTestApp();
  const logs = useLog(t);
  try {
    const { th } = await cliBot(t, 'opencode', { path: FAKE_ACP });
    const started = Date.now();
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Hallo SCENARIO:loggedlimit' });
    await t.waitIdle(th.id, 20_000);
    assert.ok(Date.now() - started < 15_000, 'ends at once');
    const launch = logs().find((l) => Array.isArray(l.argv) && l.argv.includes('acp'))?.argv || [];
    assert.ok(!launch.includes('--log-level') && !launch.includes('--print-logs'), 'plain acp for 2.x: ' + JSON.stringify(launch));
    const m = lastMsg(t, th.id);
    assert.equal(m.status, 'error');
    assert.match(JSON.stringify(m.parts?.error || ''), /gratis limiet van OpenCode is bereikt/);
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------- Codex

test('codex: exec for readonly/auto with strict sandbox, app-server approvals for ask, chat refused', async () => {
  const t = await startTestApp();
  const logs = useLog(t);
  process.env.CODEX_HOME = t.dir;
  fs.writeFileSync(path.join(t.dir, 'config.toml'), ['[mcp_servers.demo]', 'command = "x"', ''].join('\n'));
  try {
    const { a, th, p } = await cliBot(t, 'codex-cli', { path: FAKE_CODEX }, { access_mode: 'readonly' });
    await t.say(th.id, 'lees iets');
    let m = lastMsg(t, th.id);
    assert.equal(m.content, 'Hallo van Codex');
    assert.equal(m.parts.reasoning, 'denken');
    assert.ok(m.parts.activity?.some((x: any) => /Voerde uit: ls/.test(x.title)));
    // An older Codex without permission profiles (the fake has no `codex sandbox`): the legacy sandbox flags.
    const execs = () => logs().filter((l) => l.argv?.[0] === 'exec');
    let L = execs();
    assert.equal(flag(L[0].argv, '-s'), 'read-only');
    assert.ok(L[0].argv.includes('approval_policy="never"'));
    assert.ok(L[0].argv.includes('mcp_servers.demo.enabled=false'), "user's own Codex MCP servers are off for TeamBot runs");
    assert.match(L[0].prompt, /teambot_instructies/);
    assert.equal(t.app.ctx.store.thread(th.id)!.provider_state[p.id].sessionId, '019a0000-0000-7000-8000-000000000001');

    await t.api('PATCH', `/agents/${a.id}`, { access_mode: 'auto' });
    await t.say(th.id, 'schrijf iets');
    L = execs();
    assert.equal(flag(L[1].argv, '-s'), 'workspace-write');
    assert.ok(L[1].argv.includes('resume'));
    assert.doesNotMatch(L[1].prompt, /<teambot_instructies>/);
    assert.match(L[1].prompt, /<teambot_instructies_update>[\s\S]*dossier_write/, 'readonly → auto: the resumed session learns it may save to memory now');
    assert.doesNotMatch(L[0].prompt, /dossier_write/, 'readonly never named dossier_write');

    await t.api('PATCH', `/agents/${a.id}`, { access_mode: 'ask' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'met goedkeuring' });
    const ap = await until(async () => (await t.api('GET', '/approvals')).find((x: any) => x.status === 'pending'), 10_000, 'codex approval');
    assert.equal(ap.tool, 'codex-cli:bestanden');
    await t.api('POST', `/approvals/${ap.id}`, { decision: 'approve' });
    await t.waitIdle(th.id);
    m = lastMsg(t, th.id);
    assert.equal(m.content, 'Klaar met schrijven');
    assert.equal(fs.readFileSync(path.join(a.workspace, 'codex.txt'), 'utf8'), 'via codex');
    L = logs();
    const resume = L.find((l) => l.method === 'thread/resume');
    assert.equal(resume.params.sandbox, 'read-only');
    assert.equal(resume.params.approvalPolicy, 'on-request');
    assert.equal(resume.hasJsonrpc, false);
    assert.deepEqual(L.find((l) => l.approval).approval, { decision: 'accept' });

    await t.api('PATCH', `/agents/${a.id}`, { access_mode: 'chat' });
    await t.say(th.id, 'chat');
    assert.match(lastMsg(t, th.id).parts.error!, /Chatmodus/);
  } finally {
    delete process.env.CODEX_HOME;
    await t.close();
  }
});

// ---------------------------------------------------------------- instructions of a running session

test('instruction updates: only changed sections, removed headings, full text when the session state is unknown', () => {
  const v1 = 'Je bent Bot.\nWerkmap: /x\n\n## Jouw instructies\nWees kort.\n\n## Skills\n- a: doe a\n\n### Sub\nblijft in Skills\n\n## TeamBot-tools\nmemory_search';
  assert.deepEqual(promptSections(v1).map((s) => s.key), ['(begin)', '## Jouw instructies', '## Skills', '## TeamBot-tools']);
  assert.match(promptSections(v1)[2].text, /blijft in Skills/, '### stays inside its section');
  const st = contextState(v1);
  assert.deepEqual(contextUpdate(st, v1), { text: '', changed: [] }, 'unchanged → nothing to send');

  const v2 = v1.replace('Wees kort.', 'Wees heel uitgebreid en noem altijd je bronnen.').replace('\n\n## Skills\n- a: doe a\n\n### Sub\nblijft in Skills', '');
  const u = contextUpdate(st, v2);
  assert.match(u.text, /^<teambot_instructies_update>/);
  assert.match(u.text, /## Jouw instructies\nWees heel uitgebreid/);
  assert.match(u.text, /Vervallen \(geldt niet meer\): ## Skills/);
  assert.doesNotMatch(u.text, /memory_search|Je bent Bot/, 'unchanged sections are not repeated');
  assert.deepEqual(u.changed, ['Jouw instructies', 'Skills (vervallen)']);

  const full = contextUpdate(null, v1);
  assert.match(full.text, /volledige nieuwe versie/);
  assert.ok(full.text.includes(v1.trim()), 'unknown session state → the whole text');
  const most = contextUpdate(st, 'Je bent Andere Bot.\n\n## Jouw instructies\nIets totaal anders en veel langer dan eerst, zodat bijna alles nieuw is.');
  assert.match(most.text, /volledige nieuwe versie/, 'most of it changed → the whole text');
});

// Acceptance round 3 (A-16): Codex in "Vraagt toestemming" wrote with PowerShell, the read-only sandbox refused it and
// no card came (3 of 3 tries); asked to use apply_patch it got a card and wrote after approval.
test('codex ask: a new app-server session is told to write with apply_patch (that asks the owner); exec modes are not', async () => {
  const t = await startTestApp();
  const logs = useLog(t);
  process.env.CODEX_HOME = t.dir;
  try {
    const { th } = await cliBot(t, 'codex-cli', { path: FAKE_CODEX }, { access_mode: 'ask' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'maak een bestand' });
    const start = await until(() => logs().find((l) => l.method === 'thread/start'), 10_000, 'thread/start');
    assert.ok(String(start.params.developerInstructions).includes(CODEX_ASK_NOTE));
    const ap = await until(async () => (await t.api('GET', '/approvals')).find((x: any) => x.status === 'pending'), 10_000, 'codex approval');
    await t.api('POST', `/approvals/${ap.id}`, { decision: 'deny' });
    await t.waitIdle(th.id);
    const ro = await cliBot(t, 'codex-cli', { path: FAKE_CODEX }, { access_mode: 'readonly' });
    await t.say(ro.th.id, 'hallo');
    const exec = logs().filter((l) => l.argv).at(-1);
    assert.ok(!String(exec.prompt).includes('apply_patch'), 'not for "Alleen lezen" (exec)');
  } finally {
    await t.close();
  }
});

// Acceptance round 4 (B-46): in "Vraagt toestemming" Codex sometimes wrote with PowerShell Set-Content without
// asking; the read-only sandbox refused it, no card came and the bot only said "geweigerd".
test('codex ask: a write by command that the sandbox refuses is shown, and the turn is told to use apply_patch → a card', async () => {
  const t = await startTestApp();
  const logs = useLog(t);
  process.env.CODEX_HOME = t.dir;
  try {
    const { a, th } = await cliBot(t, 'codex-cli', { path: FAKE_CODEX }, { access_mode: 'ask' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'schrijf hallo in notities.txt SCENARIO:setcontent' });
    const ap = await until(async () => (await t.api('GET', '/approvals')).find((x: any) => x.status === 'pending'), 15_000, 'card after the steer');
    assert.match(ap.summary, /^Bestanden wijzigen: .*notities\.txt/);
    await t.api('POST', `/approvals/${ap.id}`, { decision: 'approve' });
    await t.waitIdle(th.id, 20_000);
    assert.equal(fs.readFileSync(path.join(a.workspace, 'notities.txt'), 'utf8'), 'hallo');
    const steer = logs().find((l) => l.method === 'turn/steer');
    assert.equal(steer?.params.expectedTurnId, 'turn-s', 'into the running turn');
    assert.match(steer.params.input[0].text, /^TeamBot: je terminalopdracht om notities\.txt te schrijven is geweigerd door de alleen-lezen sandbox[\s\S]*apply_patch/);
    const m = lastMsg(t, th.id);
    assert.ok(m.parts.activity?.some((x: any) => x.kind === 'tool_error' && x.title === 'Mocht notities.txt niet met een terminalopdracht schrijven'), JSON.stringify(m.parts.activity));
    assert.match(m.content, /Geschreven met apply_patch/);
    assert.equal(logs().filter((l) => l.method === 'turn/start').length, 1, 'no second turn needed');
  } finally {
    await t.close();
  }
});

test('codex ask: when the turn already ended, one short follow-up turn takes the note (the bot does it the proper way)', async () => {
  const t = await startTestApp();
  const logs = useLog(t);
  process.env.CODEX_HOME = t.dir;
  process.env.FAKE_CODEX_FAST_END = '1';
  try {
    const { a, th } = await cliBot(t, 'codex-cli', { path: FAKE_CODEX }, { access_mode: 'ask' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'schrijf iets SCENARIO:setcontent' });
    const ap = await until(async () => (await t.api('GET', '/approvals')).find((x: any) => x.status === 'pending'), 15_000, 'card in the follow-up turn');
    await t.api('POST', `/approvals/${ap.id}`, { decision: 'approve' });
    await t.waitIdle(th.id, 20_000);
    assert.equal(fs.readFileSync(path.join(a.workspace, 'codex.txt'), 'utf8'), 'via codex', 'written through the card');
    const starts = logs().filter((l) => l.method === 'turn/start');
    assert.equal(starts.length, 2);
    assert.match(starts[1].params.input[0].text, /^TeamBot: je terminalopdracht om notities\.txt te schrijven is geweigerd/);
    const m = lastMsg(t, th.id);
    assert.ok(m.parts.activity?.some((x: any) => x.title === 'Codex probeert het opnieuw via een goedkeuringskaart'));
    assert.match(m.content, /Het schrijven werd geweigerd\.[\s\S]*Klaar met schrijven/);
  } finally {
    delete process.env.FAKE_CODEX_FAST_END;
    await t.close();
  }
});

test('codex + acp: changed instructions reach a resumed session on the next turn, once', async () => {
  const t = await startTestApp();
  const logs = useLog(t);
  process.env.CODEX_HOME = t.dir;
  try {
    // Codex exec (readonly)
    const { a, th, p } = await cliBot(t, 'codex-cli', { path: FAKE_CODEX }, { access_mode: 'readonly', instructions: 'Antwoord altijd in het Engels.' });
    await t.say(th.id, 'een');
    await t.say(th.id, 'twee');
    let L = logs().filter((l) => l.argv);
    assert.match(L[0].prompt, /<teambot_instructies>[\s\S]*Antwoord altijd in het Engels/);
    assert.doesNotMatch(L[1].prompt, /teambot_instructies/, 'nothing changed → nothing sent');
    await t.api('PATCH', `/agents/${a.id}`, { instructions: 'Antwoord altijd in het Frans.' });
    await t.say(th.id, 'drie');
    L = logs().filter((l) => l.argv);
    assert.ok(L[2].argv.includes('resume'), 'same session, not restarted');
    assert.match(L[2].prompt, /<teambot_instructies_update>[\s\S]*## Jouw instructies\nAntwoord altijd in het Frans\.[\s\S]*<\/teambot_instructies_update>\n\ndrie/);
    assert.doesNotMatch(L[2].prompt, /Je bent CliBot/, 'only the changed section');
    assert.ok(lastMsg(t, th.id).parts.activity?.some((x: any) => x.title === 'Bijgewerkte instructies meegegeven' && /Jouw instructies/.test(x.detail)));
    await t.say(th.id, 'vier');
    assert.doesNotMatch(logs().filter((l) => l.argv)[3].prompt, /teambot_instructies/, 'sent once');

    // A session from before this version (no stored state) gets the full text once.
    t.app.ctx.store.exec('UPDATE cli_sessions SET context_state = NULL WHERE thread_id = ?', th.id);
    await t.say(th.id, 'vijf');
    assert.match(logs().filter((l) => l.argv)[4].prompt, /volledige nieuwe versie[\s\S]*Je bent CliBot[\s\S]*Antwoord altijd in het Frans/);
    // …said as such, not as a list of sections that all "changed".
    const again = lastMsg(t, th.id).parts.activity?.find((x: any) => x.kind === 'session' && /instructies/i.test(x.title));
    assert.equal(again?.title, 'Instructies opnieuw meegegeven');
    assert.equal(again?.detail, undefined);

    // Codex app-server (ask): the thread keeps its developerInstructions, the update goes in the turn.
    await t.api('PATCH', `/agents/${a.id}`, { access_mode: 'ask', instructions: 'Antwoord altijd in het Duits.' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'zes' });
    const ap = await until(async () => (await t.api('GET', '/approvals')).find((x: any) => x.status === 'pending'), 10_000, 'codex approval');
    await t.api('POST', `/approvals/${ap.id}`, { decision: 'deny' });
    await t.waitIdle(th.id);
    const turn = logs().filter((l) => l.method === 'turn/start').at(-1);
    assert.match(turn.params.input[0].text, /<teambot_instructies_update>[\s\S]*Antwoord altijd in het Duits/);
    assert.equal(logs().some((l) => l.method === 'thread/start'), false, 'resumed, not a new thread');
    const row = t.app.ctx.store.one<any>('SELECT context_state FROM cli_sessions WHERE thread_id = ? AND provider_id = ?', th.id, p.id);
    assert.ok(JSON.parse(row.context_state)['## Jouw instructies'], 'state saved per section');

    // ACP (session/load): same rule.
    const acp = await cliBot(t, 'acp-custom', { command: FAKE_ACP, args: [] }, { access_mode: 'ask', instructions: 'Gebruik korte zinnen.' });
    await t.say(acp.th.id, 'hallo');
    await t.say(acp.th.id, 'nog eens');
    await t.api('PATCH', `/agents/${acp.a.id}`, { instructions: 'Gebruik lange zinnen.' });
    await t.say(acp.th.id, 'en nu');
    await t.say(acp.th.id, 'laatste');
    const P = logs().filter((l) => l.cli !== 'codex' && l.method === 'session/prompt').map((l) => l.params.text);
    assert.match(P[0], /<teambot_instructies>[\s\S]*Gebruik korte zinnen/);
    assert.doesNotMatch(P[1], /teambot_instructies/);
    assert.match(P[2], /<teambot_instructies_update>[\s\S]*Gebruik lange zinnen\.?\n[\s\S]*<\/teambot_instructies_update>\n\nen nu/);
    assert.doesNotMatch(P[3], /teambot_instructies/);
  } finally {
    delete process.env.CODEX_HOME;
    await t.close();
  }
});

// ---------------------------------------------------------------- API / multi-user

test('status, path setting and owner-only, never-shared CLI providers', async () => {
  const t = await startTestApp();
  useLog(t);
  try {
    await t.api('PUT', '/cli-agents/paths/claude-code', { path: FAKE_CLAUDE });
    const st = await t.api('GET', '/cli-agents/status?fresh=1');
    assert.equal(st.canUse, true);
    const c = st.items.find((x: any) => x.id === 'claude-code');
    assert.equal(c.installed, true);
    assert.equal(c.version, '2.1.999');
    assert.equal(c.loggedIn, true);
    assert.equal(c.billing, 'subscription');
    assert.match(c.billingPath, /abonnement \(max\)/);
    // Acceptance round 4: OpenCode (free models) showed "Actief pad: Onbekend" right after "Gratis starten".
    await t.api('PUT', '/cli-agents/paths/opencode', { path: FAKE_ACP });
    const oc = (await t.api('GET', '/cli-agents/status?fresh=1')).items.find((x: any) => x.id === 'opencode');
    assert.equal(oc.installed, true);
    assert.match(oc.billingPath, /^Gratis modellen/);
    assert.ok(!JSON.stringify(st).includes('geheim@example.com') && !JSON.stringify(st).includes('Geheime Org'), 'no email/org leaks');
    assert.ok(st.items.find((x: any) => x.id === 'pi-agent').unsupported);
    assert.ok(c.install.length > 0);

    const con = await t.api('POST', '/cli-agents/claude-code/connect', {});
    assert.equal(con.created, true);
    assert.equal(con.provider.type, 'cli');
    const test = await t.api('POST', `/providers/${con.provider.id}/test`, {});
    assert.equal(test.ok, true);
    await assert.rejects(t.api('POST', '/providers', { kind: 'claude-code', shared: true }), /niet gedeeld/);
    await assert.rejects(t.api('PATCH', `/providers/${con.provider.id}`, { shared: true }), /niet gedeeld/);
    await assert.rejects(t.api('POST', '/providers', { kind: 'acp-custom', config: { command: 'bestaat-niet-xyz' } }), /niet gevonden/);
    await assert.rejects(t.api('PUT', '/cli-agents/paths/claude-code', { path: 'relatief/pad' }), /volledig pad/);

    // a member (friend on a server install) cannot use the owner's CLI login
    const friend = t.app.ctx.auth.createUser({ name: 'Vriend', role: 'member' });
    const { token } = t.app.ctx.auth.createSession(friend.id);
    const asFriend = (method: string, p: string, body?: any) =>
      fetch(t.app.url + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const r1 = await asFriend('POST', '/providers', { kind: 'claude-code' });
    assert.equal(r1.status, 403);
    const s2: any = await (await asFriend("GET", "/cli-agents/status")).json();
    assert.equal(s2.canUse, false);
    assert.equal(s2.items.length, 0);
    // even if a CLI provider row were shared, the adapter refuses other users
    t.app.ctx.store.update('providers', con.provider.id, { shared: 1 });
    const fa = t.app.ctx.store.createAgent(friend.id, { name: 'Stiekem', provider_id: con.provider.id, access_mode: 'auto' });
    const fth = t.app.ctx.store.createThread({ user_id: friend.id, agent_id: fa.id, kind: 'chat' });
    await asFriend('POST', `/threads/${fth.id}/messages`, { content: 'hoi' });
    await t.waitIdle(fth.id);
    const run = t.app.ctx.store.all<any>('SELECT status, error FROM runs WHERE thread_id = ?', fth.id)[0];
    assert.equal(run.status, 'error');
    assert.match(run.error, /niet gedeeld|eigenaar/);
  } finally {
    await t.close();
  }
});

// Found live with OpenCode 1.19.5 on Windows: paths without drive letter, and edits allowed without asking by default.
test('acp: drive-less Windows paths from an agent map back to the workspace; OpenCode is told to ask for every action', () => {
  const W = path.win32;
  const cwd = W.join('C:' + W.sep, 'Users', 'sanne', 'ws', 'ag_1');
  assert.equal(acpPath('Users/sanne/ws/ag_1/hallo.txt', cwd, true), W.join(cwd, 'hallo.txt'));
  assert.equal(acpPath('users/SANNE/ws/ag_1', cwd, true), W.join('C:' + W.sep, 'users', 'SANNE', 'ws', 'ag_1'));
  assert.equal(acpPath('sub/x.txt', cwd, true), 'sub/x.txt', 'ordinary relative paths stay relative to the workspace');
  assert.equal(acpPath('Users/other/x.txt', cwd, true), 'Users/other/x.txt', 'only the own workspace is mapped');
  assert.equal(acpPath(W.join(cwd, 'a.txt'), cwd, true), W.join(cwd, 'a.txt'));
  assert.equal(acpPath('Users/sanne/ws/ag_1/a.txt', '/home/x/ws', false), 'Users/sanne/ws/ag_1/a.txt', 'no change off Windows');
  const oc = defById('opencode')!;
  const cfg = JSON.parse(oc.acpEnv!.OPENCODE_CONFIG_CONTENT);
  // external_directory: OpenCode 2.2.5 read files outside its folder without asking (found in the acceptance test)
  assert.deepEqual(cfg.permission, { edit: 'ask', bash: 'ask', webfetch: 'ask', external_directory: 'ask' });
});

test('acp: a second permission request for the same tool call (OpenCode external_directory + edit) needs no second card', async () => {
  const t = await startTestApp();
  const logs = useLog(t);
  try {
    const { th } = await cliBot(t, 'acp-custom', { command: FAKE_ACP }, { access_mode: 'ask' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'SCENARIO:asktwice' });
    const ap = await until(async () => (await t.api('GET', '/approvals')).find((x: any) => x.status === 'pending'), 10_000, 'acp approval');
    assert.match(ap.summary, /^Bestand schrijven: twee\.txt$/, 'the card says what in words');
    // Q-12: while the card waits the step is a wish, once the call is completed it is past tense (one line).
    const steps = () => (lastMsg(t, th.id).parts.activity || []).filter((x: any) => x.kind === 'tool').map((x: any) => x.title);
    await until(() => steps().includes('Wil twee.txt aanpassen'), 5000, 'stap "Wil twee.txt aanpassen"');
    await t.api('POST', `/approvals/${ap.id}`, { decision: 'approve' });
    await t.waitIdle(th.id);
    assert.deepEqual(steps(), ['Paste twee.txt aan']);
    assert.deepEqual(logs().find((l) => l.asktwice).asktwice, ['a', 'a']);
    assert.equal((await t.api('GET', '/approvals?status=all')).length, 1, 'one card for one write');
  } finally {
    await t.close();
  }
});

test('acp: reading outside the folder (OpenCode "external_directory") is refused, the bot\'s own extra folders stay readable', async () => {
  const t = await startTestApp();
  const logs = useLog(t);
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-acp-extra-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-acp-outside-'));
  try {
    const { a, th } = await cliBot(t, 'acp-custom', { command: FAKE_ACP }, { access_mode: 'ask' });
    fs.writeFileSync(path.join(extra, 'prijs.txt'), '49 euro');
    fs.writeFileSync(path.join(outside, 'geheim.txt'), 'niet voor de bot');
    await t.api('PATCH', `/agents/${a.id}`, { settings: { ...a.settings, folders: [{ path: extra, mode: 'ro', label: 'extra' }] } });
    await t.say(th.id, `SCENARIO:extdir ${path.join(extra, 'prijs.txt')} ${path.join(outside, 'geheim.txt')}`);
    const r = logs().find((l) => l.extdir)!.extdir;
    assert.equal(r[0].option, 'a', 'a read-only extra folder of the bot is readable without a card');
    assert.equal(r[1].option, 'r', 'a file outside every folder of the bot is refused');
    assert.equal((await t.api('GET', '/approvals?status=all')).length, 0, 'no approval card for either');
  } finally {
    await t.close();
    fs.rmSync(extra, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('acp safety net: a CLI that changes something without asking is stopped and blocked for ask/readonly until reset', async () => {
  const t = await startTestApp();
  useLog(t);
  try {
    const { a, th } = await cliBot(t, 'acp-custom', { command: FAKE_ACP }, { access_mode: 'ask' });
    await t.say(th.id, 'SCENARIO:sneaky');
    const run = t.app.ctx.store.all<any>('SELECT status, error FROM runs WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1', th.id)[0];
    assert.match(String(run.error || lastMsg(t, th.id).parts?.error || ''), /zonder TeamBot om toestemming te vragen/);
    assert.ok(t.app.ctx.store.all<any>("SELECT id FROM audit WHERE kind = 'cli.unapproved_action'").length === 1);
    // Next run in ask mode is refused before the CLI starts.
    await t.say(th.id, 'hallo acp');
    const again = t.app.ctx.store.all<any>('SELECT error FROM runs WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1', th.id)[0];
    assert.match(String(again.error), /draait deze CLI niet meer/);
    const st = (await t.api('GET', '/cli-agents/status')).custom;
    assert.equal(st.unsafe?.kind, 'edit');
    // Auto mode keeps working (TeamBot's Broker decides there anyway). Fresh threads: the earlier transcript would
    // otherwise be passed on as context and replay the scenario.
    await t.api('PATCH', `/agents/${a.id}`, { access_mode: 'auto' });
    const th2 = await t.api('POST', '/threads', { agentId: a.id });
    await t.say(th2.id, 'hallo acp');
    assert.equal(lastMsg(t, th2.id).content, 'Hoi van ACP');
    // The owner resets after checking the CLI settings.
    await t.api('PUT', '/cli-agents/safety/acp-custom', {});
    await t.api('PATCH', `/agents/${a.id}`, { access_mode: 'ask' });
    const th3 = await t.api('POST', '/threads', { agentId: a.id });
    await t.say(th3.id, 'hallo acp');
    assert.equal(lastMsg(t, th3.id).content, 'Hoi van ACP');
    assert.equal((await t.api('GET', '/cli-agents/status')).custom.unsafe, undefined);
  } finally {
    await t.close();
  }
});

test('Claude Code bots never get Claude Code tools that act outside TeamBot (cloud schedules, other sessions, push)', async () => {
  const { buildClaudeArgs, CLAUDE_OUTSIDE_TOOLS } = await import('../server/modules/cli-agents/claude.js');
  for (const mode of ['readonly', 'ask', 'auto'] as const) {
    const a = buildClaudeArgs(F, { ...base, mode, mcpConfigFile: 'x.json', shell: true });
    const deny = (a[a.indexOf('--disallowedTools') + 1] || '').split(',');
    for (const t of ['RemoteTrigger', 'CronCreate', 'ScheduleWakeup', 'Skill(schedule)', 'SendMessage']) assert.ok(deny.includes(t), `${mode}: ${t} denied`);
    assert.ok(CLAUDE_OUTSIDE_TOOLS.every((t: string) => deny.includes(t)), mode);
  }
});

test('opencode: the daily free limit that OpenCode only logs ends the turn with a clear error instead of "Denkt na…" for good', async () => {
  // The log line format of OpenCode 1.19.5 (live, 7 Nov 2026); title generation (small=true) does not count.
  const build =
    'timestamp=2026-11-07T11:04:09.849Z level=ERROR run=cd9b71f1 message="stream error" providerID=opencode modelID=big-pickle session.id=s small=false agent=build mode=primary error.error="AI_APICallError: Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go"';
  assert.match(fatalStderrError(build)!, /^Free usage limit reached\./);
  assert.equal(fatalStderrError(build.replace('small=false agent=build', 'small=true agent=title')), null);
  assert.equal(fatalStderrError(build.replace(/error\.error="[^"]*"/, 'error.error="AI_APICallError: Overloaded"')), null, "a temporary error is left to the engine's own retries");
  assert.equal(fatalStderrError('Error: something else'), null);
  assert.deepEqual(defById('opencode')!.acpArgs, ['acp'], 'OpenCode 2.x');
  assert.deepEqual(defById('opencode')!.legacy, { below: 2, acpArgs: ['acp', '--print-logs', '--log-level', 'ERROR'] }, 'OpenCode 1.x');

  const t = await startTestApp();
  useLog(t);
  try {
    const { th } = await cliBot(t, 'opencode', { path: FAKE_ACP });
    const t0 = Date.now();
    await t.say(th.id, 'SCENARIO:freelimit', 20_000);
    const m = lastMsg(t, th.id);
    assert.equal(m.status, 'error');
    assert.ok(Date.now() - t0 < 15_000, 'ends right away, not after the run time-out');
    assert.match(m.parts.error!, /limiet/i);
  } finally {
    await t.close();
  }
});

test('opencode one-shot answers ("Maak een profiel"): an older OpenCode without --standalone, and the free limit', async () => {
  const { cliComplete } = await import('../server/modules/cli-agents/complete.js');
  const def = defById('opencode')!;
  delete process.env.FAKE_CLI_LOG; // may still point at an earlier test's (removed) folder
  process.env.FAKE_OC_V1 = '1';
  try {
    // 1.19.5 prints only the help of "run" for --standalone: TeamBot tries again without it.
    assert.equal(await cliComplete(def, FAKE_ACP, { system: 's', prompt: 'maak een profiel' }), 'ok');
  } finally {
    delete process.env.FAKE_OC_V1;
  }
  // 2.x: `run --standalone`, and the free limit is "Error: …" on stderr with exit 1.
  const t0 = Date.now();
  await assert.rejects(cliComplete(def, FAKE_ACP, { system: 's', prompt: 'SCENARIO:freelimit', timeoutMs: 60_000 }), /OpenCode gaf een fout: Free usage limit reached\. Connect a provider/);
  assert.ok(Date.now() - t0 < 20_000, 'stops at once');
  // 1.x: no --standalone, the log on stderr, stopped as soon as the limit is logged (not at the time-out).
  process.env.FAKE_OC_V1 = '1';
  try {
    const t1 = Date.now();
    await assert.rejects(cliComplete(def, FAKE_ACP, { system: 's', prompt: 'SCENARIO:freelimit', timeoutMs: 60_000 }), /OpenCode gaf een fout: Free usage limit reached/);
    assert.ok(Date.now() - t1 < 20_000, 'stops as soon as OpenCode logs the limit, not at the time-out');
  } finally {
    delete process.env.FAKE_OC_V1;
  }
});
