import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { Client, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import { startTestApp, type TestApp } from './helpers.js';
import { BRIDGE_PROTOCOL_VERSIONS, PermissionBridge, type BridgeRegistration, type StdioServer } from '../server/modules/cli-agents/bridge.js';
import { makeScope } from '../server/modules/cli-agents/context.js';
import { nativeExclusions, servedTools, teambotTools, toolsNote } from '../server/modules/cli-agents/toolhost.js';
import { CALL_NAME, FIND_NAME } from '../server/tools/selection.js';
import { codexMcpArgs } from '../server/modules/cli-agents/codex.js';
import { acpMcpServer, isTeambotToolCall } from '../server/modules/cli-agents/acp.js';

// These tests are about bots that are not the main bot: without this the first bot would be it (teams `autoMain`,
// covered in works-right-away.test.ts).
process.env.TEAMBOT_TEST_NO_AUTO_MAIN = '1';

const children = new Set<ReturnType<typeof spawn>>();
/** Minimal MCP stdio client for the generated bridge script (what Claude Code / Codex / an ACP agent would do). */
function mcpClient(srv: StdioServer, o: { relist?: boolean } = {}) {
  const child = spawn(srv.command, srv.args, { env: { ...process.env, ...srv.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  children.add(child);
  const pending = new Map<number, (m: any) => void>();
  /** Every line from the server in order: a notification's method, or "response:<id>". */
  const seen: string[] = [];
  readline.createInterface({ input: child.stdout! }).on('line', (l) => {
    const m = JSON.parse(l);
    seen.push(m.method && m.id === undefined ? m.method : `response:${m.id}`);
    // Like Claude Code for a server with tools.listChanged: list again at once.
    if (o.relist && m.method === 'notifications/tools/list_changed') void req('tools/list');
    pending.get(m.id)?.(m);
  });
  let id = 0;
  const req = (method: string, params: any = {}) =>
    new Promise<any>((resolve) => {
      const i = ++id;
      pending.set(i, resolve);
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
    });
  return {
    req,
    seen,
    notify: (method: string, params: any) => child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'),
    lastId: () => id,
    async list(): Promise<string[]> {
      const r = await req('tools/list');
      return (r.result?.tools || []).map((t: any) => t.name);
    },
    call: (name: string, args: any = {}) => req('tools/call', { name, arguments: args }),
    close: () => {
      child.kill();
      children.delete(child);
    },
  };
}
const killAll = () => {
  for (const c of children) c.kill();
  children.clear();
};

async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 10_000, what = 'voorwaarde'): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - start > ms) throw new Error(`time-out: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const GROUPS = ['files', 'web', 'memory', 'team', 'skills', 'routines', 'browser'];

/** Tool names (from `known`) that a prompt text mentions. */
const toolWords = (text: string, known: Set<string>) => [...new Set((text.match(/\b[a-z]+_[a-z_]+\b/g) || []).filter((w) => known.has(w)))];

/**
 * A bot + thread + run, and the TeamBot tools of that run registered on the bridge (as a CLI run would). `o.system`: the
 * bot's real system prompt (as a run gets it); `o.reuse`: the next turn of the same bot in the same chat.
 */
async function runWithTools(t: TestApp, bridge: PermissionBridge, agentData: any = {}, engine: 'claude' | 'codex' | 'acp' = 'claude', runMeta: any = {}, o: { prompt?: string; system?: boolean; reuse?: { a: any; th: any } } = {}) {
  const a = o.reuse?.a ?? (await t.agent({ access_mode: 'ask', tool_groups: GROUPS, ...agentData }));
  const th = o.reuse?.th ?? (await t.api('POST', '/threads', { agentId: a.id }));
  const ctx = t.app.ctx;
  const content = o.prompt ?? 'onthoud dat mijn favoriete kleur groen is';
  const input = ctx.store.createMessage({ thread_id: th.id, role: 'user', author_type: 'user', author_id: a.user_id, author_name: 'Ik', content } as any);
  const run = ctx.store.createRun({ thread_id: th.id, agent_id: a.id, user_id: a.user_id, status: 'running', trigger: 'user', input_message_id: input.id, meta: runMeta });
  const ac = new AbortController();
  const events: any[] = [];
  const cfg = ctx.providers.config(t.providerId)!;
  const system = o.system ? await ctx.services.runner.systemPrompt(ctx.store.agent(a.id)!, ctx.store.thread(th.id)!) : '';
  const scope = makeScope(ctx, cfg, { model: '', system, prompt: content, attachments: [], workspace: a.workspace, accessMode: a.access_mode, agentId: a.id, threadId: th.id, runId: run.id, userId: a.user_id }, ac.signal, (e) => events.push(e));
  const holds: boolean[] = [];
  const host = teambotTools(scope, { engine, hold: (on) => holds.push(on) });
  await bridge.ensure();
  const dir = path.join(t.dir, 'cli-agents', 'runs', run.id);
  const reg = bridge.register({ tools: host }, dir);
  return { a, th, run, ac, events, holds, host, reg, system, cfg, srv: bridge.stdioServer(reg, { tools: true }) };
}

test('TeamBot MCP server: tools scoped to the run, native duplicates left out, policy-filtered, prompt matches tools', async () => {
  const t = await startTestApp();
  const bridge = new PermissionBridge(t.dir);
  try {
    // The whole set in the list ("fewer tools" off); the small list with tools_find and tools_call has its own test
    // below (and tests/light-step.test.ts).
    const whole = { settings: { contextSaver: { selectTools: false } } };
    const r = await runWithTools(t, bridge, whole);
    assert.ok(!r.srv.args.join(' ').includes(r.reg.token), 'token never in argv');
    assert.ok(!Object.values(r.srv.env).includes(r.reg.token), 'token never in env (only the per-run file)');
    assert.equal(fs.readFileSync(r.reg.tokenFile, 'utf8'), r.reg.token);
    const c = mcpClient(r.srv);
    const init = await c.req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'teambot');
    const names = await c.list();
    for (const n of ['memory_search', 'memory_remember', 'message_bot', 'delegate_task', 'share_file', 'browser_open', 'skill_save', 'routine_create', 'ask_user', 'notify_user']) assert.ok(names.includes(n), `${n} offered`);
    for (const n of ['write_file', 'read_file', 'run_command', 'edit_file', 'web_search']) assert.ok(!names.includes(n), `${n} left out for Claude Code (native)`);
    // Claude Code has no WebFetch (not in current versions, and --restricted drops it): TeamBot's web_fetch stays.
    assert.ok(names.includes('web_fetch'), 'web_fetch offered to Claude Code');
    assert.ok(!names.includes('permission_prompt'), 'no permission gate unless asked for');
    // Every TeamBot tool the system prompt names is really there (or a native CLI tool covers it).
    const agent = t.app.ctx.store.agent(r.a.id)!;
    const sys = await t.app.ctx.services.runner.systemPrompt(agent, t.app.ctx.store.thread(r.th.id)!);
    const known = new Set([...t.app.ctx.tools.list().map((x) => x.name), ...(await t.app.ctx.tools.forAgent(agent, t.app.ctx.store.thread(r.th.id)!)).map((x) => x.name)]);
    const mentioned = toolWords(sys + '\n\n' + toolsNote(names, 'claude'), known);
    assert.ok(mentioned.includes('memory_search') && mentioned.includes('dossier_write'), 'the memory prompt names its tools');
    const native = nativeExclusions('claude', 'ask');
    for (const m of mentioned) assert.ok(names.includes(m) || native.has(m), `prompt names ${m}, but the CLI bot does not have it`);
    assert.match(toolsNote(names, 'claude'), /mcp__teambot__/);
    c.close();
    r.reg.dispose();
    assert.equal(fs.existsSync(r.reg.tokenFile), false, 'token file removed when the run ends');

    // readonly: only reads (the Broker would deny the rest anyway)
    const ro = await runWithTools(t, bridge, { access_mode: 'readonly', ...whole });
    const c2 = mcpClient(ro.srv);
    const rn = await c2.list();
    assert.ok(rn.includes('memory_search') && !rn.includes('memory_remember') && !rn.includes('message_bot'));
    const denied = await c2.call('memory_remember', { content: 'x' });
    assert.equal(denied.result.isError, true, 'a tool outside the list is refused');
    // ...and the prompt (memory brief, other modules, TeamBot tool note) names only those tools.
    const roAgent = t.app.ctx.store.agent(ro.a.id)!;
    const roSys = (await t.app.ctx.services.runner.systemPrompt(roAgent, t.app.ctx.store.thread(ro.th.id)!)) + '\n\n' + toolsNote(rn, 'claude');
    const roMentioned = toolWords(roSys, known);
    assert.ok(roMentioned.includes('memory_search'), 'readonly still explains how to look things up');
    const nativeRo = nativeExclusions('claude', 'readonly');
    for (const m of roMentioned) assert.ok(rn.includes(m) || nativeRo.has(m), `readonly prompt names ${m}, but the bot does not have it`);
    assert.match(roSys, /Zelf iets opslaan, wijzigen of vergeten kan in deze modus niet/);
    c2.close();
    ro.reg.dispose();

    // readonly API bot: offered tools are filtered by the Broker the same way; "vergeet …" does not point to memory_forget.
    const api = await t.agent({ access_mode: 'readonly', tool_groups: GROUPS });
    const ath = await t.api('POST', '/threads', { agentId: api.id });
    t.script.push({ text: 'ok' });
    await t.say(ath.id, 'vergeet mijn oude adres');
    const sent = t.requests.at(-1)!;
    const allowed = new Set((await t.app.ctx.tools.forAgent(t.app.ctx.store.agent(api.id)!, t.app.ctx.store.thread(ath.id)!)).filter((x) => t.app.ctx.broker.decide(t.app.ctx.store.agent(api.id)!, x) !== 'deny').map((x) => x.name));
    for (const m of toolWords(sent.system + '\n' + JSON.stringify(sent.messages), known)) assert.ok(allowed.has(m), `readonly API prompt or turn context names ${m}`);
    assert.match(JSON.stringify(sent.messages), /iets te vergeten/, 'the forget notice is there, without the tool');

    // chat: no tools at all, so no tool names in the prompt.
    const chat = await t.agent({ access_mode: 'chat', tool_groups: GROUPS });
    const cth = await t.api('POST', '/threads', { agentId: chat.id });
    const chatAgent = t.app.ctx.store.agent(chat.id)!;
    assert.deepEqual(await t.app.ctx.tools.forAgent(chatAgent, t.app.ctx.store.thread(cth.id)!), []);
    assert.deepEqual(toolWords(await t.app.ctx.services.runner.systemPrompt(chatAgent, t.app.ctx.store.thread(cth.id)!), known), [], 'chat prompt names no tools');

    // per-bot tool policy deny → not offered; run override (routine) narrows the mode for the CLI run too
    const pol = await runWithTools(t, bridge, { tool_policy: { message_bot: 'deny' } }, 'codex', { override: { access_mode: 'readonly' } });
    const pn = await pol.host.names();
    assert.ok(!pn.includes('message_bot') && !pn.includes('memory_remember'), 'policy deny and override narrowing apply');
    assert.ok(pn.includes('web_fetch') && pn.includes('web_search'), 'Codex keeps TeamBot web tools');
    // …also for what is outside the list: not there to find, refused when called.
    const hidden = await pol.host.call(FIND_NAME, { query: '' }, new AbortController().signal);
    assert.match(hidden.content[0].text, /routine_list/);
    assert.doesNotMatch(hidden.content[0].text, /message_bot|memory_remember/);
    for (const n of ['message_bot', 'memory_remember']) assert.equal((await pol.host.call(CALL_NAME, { name: n, args: {} }, new AbortController().signal)).isError, true, `${n} refused through tools_call`);
    pol.reg.dispose();
  } finally {
    killAll();
    bridge.stop();
    await t.close();
  }
});

test('TeamBot MCP server: write tool → TeamBot approval (approve runs it, deny = nothing happens); idle timer held', async () => {
  const t = await startTestApp();
  const bridge = new PermissionBridge(t.dir);
  try {
    const r = await runWithTools(t, bridge);
    const c = mcpClient(r.srv);
    await c.req('initialize', {});
    const p1 = c.call('memory_remember', { content: 'De favoriete kleur van de gebruiker is groen' });
    const ap = await until(async () => (await t.api('GET', '/approvals')).find((x: any) => x.status === 'pending'), 10_000, 'approval');
    assert.equal(ap.tool, 'memory_remember');
    assert.equal(ap.thread_id, r.th.id);
    assert.equal(ap.agent_id, r.a.id);
    assert.equal(ap.run_id, r.run.id);
    assert.ok(r.events.some((e) => e.type === 'activity' && /Wacht op toestemming: iets onthouden/.test(e.item.title)), 'in words, not the tool id memory_remember');
    await t.api('POST', `/approvals/${ap.id}`, { decision: 'approve' });
    const res1 = await p1;
    assert.equal(res1.result.isError, false, res1.result.content[0].text);
    assert.ok(r.holds[0] === true && r.holds.at(-1) === false, 'idle timer paused while the tool ran');
    const mem = t.app.ctx.store.all<any>("SELECT * FROM memory_items WHERE created_by_agent = ? AND status != 'deleted'", r.a.id);
    assert.ok(mem.some((m) => /groen/.test(m.body || m.content || m.text || JSON.stringify(m))), 'saved in TeamBot memory');

    const before = t.app.ctx.store.all<any>('SELECT id FROM memory_items').length;
    const p2 = c.call('memory_remember', { content: 'De favoriete kleur van de gebruiker is paars' });
    const ap2 = await until(async () => (await t.api('GET', '/approvals')).find((x: any) => x.status === 'pending'), 10_000, 'approval 2');
    await t.api('POST', `/approvals/${ap2.id}`, { decision: 'deny' });
    const res2 = await p2;
    assert.equal(res2.result.isError, true);
    assert.match(res2.result.content[0].text, /geweigerd/i);
    assert.equal(t.app.ctx.store.all<any>('SELECT id FROM memory_items').length, before, 'deny: nothing saved');
    const audit = t.app.ctx.store.all<any>("SELECT * FROM audit WHERE kind = 'tool.call'");
    assert.ok(audit.some((x) => JSON.parse(x.data).tool === 'memory_remember' && JSON.parse(x.data).denied === true));

    // read tool: automatic, result back to the CLI
    const s = await c.call('memory_search', { query: 'kleur' });
    assert.equal(s.result.isError, false);
    assert.match(s.result.content[0].text, /groen/);

    // the CLI cancels a call that waits for a human → approval expires, nothing runs
    const p3 = c.call('memory_remember', { content: 'iets anders' });
    const reqId = c.lastId();
    const ap3 = await until(async () => (await t.api('GET', '/approvals')).find((x: any) => x.status === 'pending'), 10_000, 'approval 3');
    c.notify('notifications/cancelled', { requestId: reqId });
    const res3 = await p3;
    assert.equal(res3.result.isError, true);
    await until(() => t.app.ctx.store.get<any>('approvals', ap3.id)?.status === 'expired', 5000, 'expired');
    c.close();
    r.reg.dispose();
  } finally {
    killAll();
    bridge.stop();
    await t.close();
  }
});

test('TeamBot MCP server: token isolation between runs, unknown/ended tokens get nothing', async () => {
  const t = await startTestApp();
  const bridge = new PermissionBridge(t.dir);
  try {
    const A = await runWithTools(t, bridge, { name: 'BotA', access_mode: 'auto' });
    const B = await runWithTools(t, bridge, { name: 'BotB', access_mode: 'auto' });
    const ca = mcpClient(A.srv);
    const cb = mcpClient(B.srv);
    const saved = await ca.call('memory_remember', { content: 'De codenaam van het project van bot A is Zonnebloem', scope: 'agent' });
    assert.equal(saved.result.isError, false, saved.result.content[0].text);
    const fromB = await cb.call('memory_search', { query: 'codenaam Zonnebloem' });
    assert.doesNotMatch(fromB.result.content[0].text, /Zonnebloem/, "run B cannot see bot A's own memory");
    const fromA = await ca.call('memory_search', { query: 'codenaam Zonnebloem' });
    assert.match(fromA.result.content[0].text, /Zonnebloem/);
    const remembered = (ev: any[]) => ev.some((e) => e.type === 'activity' && /Onthouden/.test(e.item.title));
    assert.ok(remembered(A.events) && !remembered(B.events), 'activity goes to the run that called');

    // a forged/unknown token and an ended run's token get no tools
    const forged = mcpClient({ ...A.srv, env: { ...A.srv.env, TEAMBOT_BRIDGE_TOKEN_FILE: '', TEAMBOT_BRIDGE_TOKEN: 'f'.repeat(48) } });
    const fl = await forged.req('tools/list');
    assert.ok(fl.error, 'unknown token → error');
    const fc = await forged.call('memory_search', { query: 'x' });
    assert.equal(fc.result.isError, true);
    forged.close();
    A.reg.dispose();
    const late = await ca.call('memory_search', { query: 'kluis' });
    assert.equal(late.result.isError, true, 'token of an ended run stops working');
    const permission = await cb.call('permission_prompt', { tool_name: 'Bash', input: { command: 'echo x' } });
    assert.equal(permission.result.isError, true, 'a tools-only run cannot use the permission gate');
    ca.close();
    cb.close();
    B.reg.dispose();
  } finally {
    killAll();
    bridge.stop();
    await t.close();
  }
});

test('engine wiring helpers: Codex -c overrides and ACP mcpServers carry no token; TeamBot tool calls are recognised safely', () => {
  const reg: BridgeRegistration = { token: 'geheim-token', tokenFile: 'C:\\data\\run\\bridge.token', dispose() {} };
  const srv: StdioServer = { command: 'C:\\Program Files\\node.exe', args: ['C:\\data\\teambot-mcp-bridge.mjs'], env: { TEAMBOT_BRIDGE: '\\\\.\\pipe\\x', TEAMBOT_BRIDGE_TOKEN_FILE: reg.tokenFile, TEAMBOT_BRIDGE_TOOLS: '1' } };
  const a = codexMcpArgs(srv);
  assert.ok(!a.join(' ').includes('geheim-token'));
  assert.ok(a.includes('mcp_servers.teambot.default_tools_approval_mode="approve"'));
  assert.ok(a.includes('mcp_servers.teambot.tool_timeout_sec=86400'));
  assert.equal(a[a.indexOf('-c') + 1], 'mcp_servers.teambot.command="C:\\\\Program Files\\\\node.exe"', 'TOML-escaped path');
  const m = acpMcpServer(srv);
  assert.equal(m.name, 'teambot');
  assert.deepEqual(m.env.find((e) => e.name === 'TEAMBOT_BRIDGE_TOOLS'), { name: 'TEAMBOT_BRIDGE_TOOLS', value: '1' });
  const names = new Set(['memory_search']);
  assert.equal(isTeambotToolCall({ title: 'teambot_memory_search', kind: 'other' }, names), true);
  assert.equal(isTeambotToolCall({ title: 'teambot_memory_search', kind: 'execute', rawInput: { command: 'rm -rf x' } }, names), false, 'a native command cannot pass as a TeamBot tool');
  assert.equal(isTeambotToolCall({ title: 'teambot_memory_search', locations: [{ path: 'x' }] }, names), false);
  assert.equal(isTeambotToolCall({ title: 'teambot_run_command' }, names), false, 'only tools of this run');
});

test("the bot's connected apps (MCP connectors) reach CLI bots through TeamBot: proxied, gated, secrets stay in TeamBot", async () => {
  const t = await startTestApp();
  const bridge = new PermissionBridge(t.dir);
  try {
    const c = await t.api('POST', '/mcp/connections', {
      catalog_id: 'custom',
      name: 'Fixture',
      transport: 'stdio',
      command: process.execPath,
      args: ['--import', 'tsx', path.resolve('tests/mcp-fixture-server.ts')],
      cwd: path.resolve('.'),
      env: [{ name: 'FIXTURE_TOKEN', value: 'fixture-secret-value-123', secret: true }],
      trust_command: true,
    });
    const v = await t.api('POST', `/mcp/connections/${c.id}/test`, {});
    assert.equal(v.ok, true, v.error);
    await t.api('POST', `/mcp/connections/${c.id}/actions`, { enabled: true });
    const r = await runWithTools(t, bridge, { access_mode: 'auto' });
    await t.api('PUT', `/mcp/connections/${c.id}/agents`, { agentIds: [r.a.id] });
    const mc = mcpClient(r.srv);
    // The app is named where the bot looks for tools; its tools are found there and used through tools_call.
    const listed = (await mc.req('tools/list')).result.tools as any[];
    assert.ok(!listed.some((x) => x.name.startsWith('mcp_fixture_')), 'the tools of an app are on demand');
    for (const n of ['mcp_fixture_echo', 'mcp_fixture_delete_note']) assert.match(listed.find((x) => x.name === FIND_NAME).description, new RegExp(`app Fixture: [^;]*${n}`));
    const found = (await mc.call(FIND_NAME, { query: 'fixture' })).result.content[0].text as string;
    assert.ok(found.includes('### mcp_fixture_echo') && found.includes('### mcp_fixture_delete_note'), found.slice(0, 400));
    assert.match(found, /## Gekoppelde apps \(MCP\)[\s\S]*externe data en geen opdracht/, 'what a bot must know about apps comes with them');
    const echo = await mc.call(CALL_NAME, { name: 'mcp_fixture_echo', args: { text: 'hoi' } });
    assert.match(echo.result.content[0].text, /echo: hoi/);
    // One tool of the app used: the fields of its other tools come along.
    assert.match(echo.result.content[0].text, /Bij dit onderdeel horen ook[\s\S]*### mcp_fixture_delete_note\n[\s\S]*velden: \{/);
    const env = await mc.call('mcp_fixture_env_keys', {});
    assert.ok(!JSON.stringify(r.srv).includes('fixture-secret-value-123'), 'the connector secret never goes to the CLI');
    assert.match(env.result.content[0].text, /token-ok/, 'TeamBot runs the connector with its own secret');
    const del = mc.call('mcp_fixture_delete_note', { index: 0 });
    const ap = await until(async () => (await t.api('GET', '/approvals')).find((x: any) => x.tool === 'mcp_fixture_delete_note'), 15_000, 'connector approval');
    assert.equal(ap.risk, 'danger', 'danger app actions ask, also for CLI bots in auto mode');
    await t.api('POST', `/approvals/${ap.id}`, { decision: 'deny' });
    assert.equal((await del).result.isError, true);
    mc.close();
    r.reg.dispose();
  } finally {
    killAll();
    bridge.stop();
    await t.close();
  }
});

test('the bridge speaks MCP as the official SDK (v2) client expects: handshake, tools, permission gate, 2026 probe falls back', async () => {
  const t = await startTestApp();
  const bridge = new PermissionBridge(t.dir);
  const clients: Client[] = [];
  try {
    assert.deepEqual(BRIDGE_PROTOCOL_VERSIONS, [...SUPPORTED_PROTOCOL_VERSIONS], 'the bridge answers the revisions of the SDK');
    await bridge.ensure();
    const seen: any[] = [];
    const reg = bridge.register(
      {
        permission: async (req) => (req.tool_name === 'Bash' ? { behavior: 'deny', message: 'nee' } : { behavior: 'allow', updatedInput: req.input }),
        tools: {
          list: async () => [{ name: 'hello', description: 'Zeg hallo', inputSchema: { type: 'object', properties: { name: { type: 'string' } } }, annotations: { readOnlyHint: true } }],
          call: async (name, args) => (seen.push({ name, args }), { content: [{ type: 'text', text: `hallo ${args?.name}` }] }),
        },
      },
      path.join(t.dir, 'cli-agents', 'runs', 'sdk'),
    );
    const srv = bridge.stdioServer(reg, { permission: true, tools: true });
    for (const mode of ['legacy', 'auto'] as const) {
      const client = new Client({ name: 'sdk-test', version: '1' }, { versionNegotiation: { mode } });
      clients.push(client);
      await client.connect(new StdioClientTransport({ command: srv.command, args: srv.args, env: { ...(process.env as Record<string, string>), ...srv.env }, stderr: 'ignore' }), { timeout: 15_000 });
      assert.equal(client.getProtocolEra(), 'legacy', `${mode}: the bridge is a 2025-era server`);
      const negotiated = client.getNegotiatedProtocolVersion() || '';
      assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes(negotiated), negotiated);
      assert.equal(client.getServerVersion()?.name, 'teambot');
      // What a bot must know about the tools is in the instructions TeamBot gives every engine, not sent a second time.
      assert.equal(client.getInstructions(), undefined);
      const tools = (await client.listTools()).tools.map((x) => x.name);
      assert.deepEqual(tools, ['permission_prompt', 'hello']);
      const r: any = await client.callTool({ name: 'hello', arguments: { name: mode } });
      assert.equal(r.content[0].text, `hallo ${mode}`);
      const allow: any = await client.callTool({ name: 'permission_prompt', arguments: { tool_name: 'Read', input: { path: 'x' } } });
      assert.deepEqual(JSON.parse(allow.content[0].text), { behavior: 'allow', updatedInput: { path: 'x' } });
      const deny: any = await client.callTool({ name: 'permission_prompt', arguments: { tool_name: 'Bash', input: {} } });
      assert.equal(JSON.parse(deny.content[0].text).behavior, 'deny');
      await client.close();
    }
    assert.deepEqual(seen.map((x) => x.args.name), ['legacy', 'auto']);
    // An old revision is answered with that revision; an unknown one with the bridge's latest.
    const raw = mcpClient(srv);
    assert.equal((await raw.req('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'x', version: '1' } })).result.protocolVersion, '2024-11-05');
    assert.equal((await raw.req('initialize', { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 'x', version: '1' } })).result.protocolVersion, SUPPORTED_PROTOCOL_VERSIONS[0]);
    raw.close();
    reg.dispose();
  } finally {
    for (const c of clients) await c.close().catch(() => {});
    killAll();
    bridge.stop();
    await t.close();
  }
});

test('a small list for every CLI engine: the core, tools_find and tools_call over the bridge; the same list every turn', async (tt) => {
  const t = await startTestApp();
  const bridge = new PermissionBridge(t.dir);
  try {
    const groups = [...GROUPS, 'rehearsal'];
    const q = 'Wat staat er vandaag op mijn planning?';
    const r = await runWithTools(t, bridge, { name: 'Baas', tool_groups: groups }, 'claude', {}, { prompt: q, system: true });
    const c = mcpClient(r.srv);
    const init = await c.req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.capabilities.tools.listChanged, undefined, 'the list never changes within a run');
    assert.equal(init.result.instructions, undefined);
    const specs = async () => (await c.req('tools/list')).result.tools as any[];
    const first = await specs();
    const listed = first.map((x) => x.name);
    assert.deepEqual(await r.host.names(), listed, 'the names for --allowedTools and the tool note are the list');
    for (const n of ['memory_search', 'dossier_get', 'dossier_write', 'ask_user', 'notify_user', 'plan_update', 'share_file', 'skill_load', 'delegate_task', FIND_NAME, CALL_NAME]) assert.ok(listed.includes(n), `${n} always listed`);
    for (const n of ['routine_create', 'browser_click', 'memory_remember', 'task_create', 'rehearsal_start']) assert.ok(!listed.includes(n), `${n} is found on demand`);
    assert.ok(listed.includes('browser_open') && listed.includes('ask_bot'), 'the way into the browser and a question for a colleague are in the list');
    // What the prompt says a bot has: every TeamBot tool it names is listed, native to the CLI, or found by that name.
    const agent = t.app.ctx.store.agent(r.a.id)!;
    const all = (await t.app.ctx.tools.forAgent(agent, t.app.ctx.store.thread(r.th.id)!)).map((x) => x.name);
    const known = new Set([...t.app.ctx.tools.list().map((x) => x.name), ...all]);
    const native = nativeExclusions('claude', 'ask');
    const everything = (await c.call(FIND_NAME, { query: '' })).result.content[0].text as string;
    const named = toolWords(r.system + '\n\n' + toolsNote(listed, 'claude'), known);
    for (const m of named) assert.ok(listed.includes(m) || native.has(m) || new RegExp(`\\b${m}\\b`).test(everything), `the prompt names ${m}, but the bot cannot reach it`);
    assert.ok(named.includes('dossier_write') && named.includes('memory_search'), named.join(', '));
    assert.match(r.system, /zoek je met tools_find en gebruik je met tools_call/);
    assert.match(toolsNote(listed, 'claude'), /mcp__teambot__/);
    // Every tool outside the list is named in the description of tools_find.
    const find = first.find((x) => x.name === FIND_NAME);
    for (const n of all.filter((x) => !listed.includes(x) && !native.has(x))) assert.ok(new RegExp(`\\b${n}\\b`).test(find.description), `${n} is named in tools_find`);
    assert.equal(find.annotations.readOnlyHint, true);
    // Claude Code never hides the list behind its own tool search (ENABLE_TOOL_SEARCH): it is small on purpose. Only a
    // tool outside it that the instructions name goes along by name (teambot_find for a bot that is not the main bot):
    // Claude Code calls nothing that is not in its list.
    const byName = first.filter((x) => x._meta?.['anthropic/alwaysLoad'] === false).map((x) => x.name);
    assert.ok(first.every((x) => x._meta?.['anthropic/alwaysLoad'] === true || byName.includes(x.name)));
    assert.ok(byName.includes('teambot_find') && byName.includes('teambot_do'), byName.join(', '));
    for (const n of byName) assert.ok(new RegExp(`\\b${n}\\b`).test(r.system), `${n}: by name only because the instructions name it`);
    for (const n of named.filter((m) => !native.has(m) && all.includes(m))) assert.ok(listed.includes(n), `the instructions name ${n}: Claude Code can call it by that name`);
    // Measured as the model sees the definitions (name, description, schema).
    const s1 = servedTools(r.run.id)!;
    tt.diagnostic(`Claude Code, ${groups.join(',')}: ${s1.sent}/${s1.of} tools listed, ~${s1.tokens} of ~${s1.full} tokens`);
    assert.ok(s1.tokens < s1.full * 0.4, `~${s1.tokens} of ~${s1.full} tokens`);
    assert.equal(s1.sent, listed.length - 2 - byName.length);
    assert.ok(s1.leftOut.includes('Routines') && s1.leftOut.includes('Browser'), s1.leftOut.join(', '));

    // Found and used in the same run, over the bridge, as the tool itself.
    const found = await c.call(FIND_NAME, { query: 'routine_list' });
    assert.match(found.result.content[0].text, /### routine_list\n[\s\S]*velden: \{/);
    const used = await c.call(CALL_NAME, { name: 'routine_list', args: {} });
    assert.equal(used.result.isError, false, used.result.content[0].text);
    assert.ok(r.events.some((e) => e.type === 'activity' && /^TeamBot · /.test(e.item.title) && !/Hulpmiddel/.test(e.item.title)), 'the step is the tool’s own');
    // A tool the CLI still knows from an earlier session and calls by its own name works too.
    const direct = await c.call('routine_list', {});
    assert.equal(direct.result.isError, false, direct.result.content[0].text);
    const unknown = await c.call(CALL_NAME, { name: 'bestaat_niet', args: {} });
    assert.equal(unknown.result.isError, true, 'only tools the bot has');
    assert.ok(!c.seen.includes('notifications/tools/list_changed'), 'nothing changes: no notification');
    assert.deepEqual((await specs()).map((x) => x.name), listed, 'the same list after using tools outside it');
    assert.equal(t.app.ctx.store.thread(r.th.id)!.provider_state?.[r.cfg.id]?.teambotParts, undefined, 'nothing is kept per session');
    c.close();
    r.reg.dispose();

    // The next turn of the same chat: the same list, byte for byte (prompt caching).
    const r2 = await runWithTools(t, bridge, {}, 'claude', {}, { prompt: 'Dank je', system: true, reuse: { a: r.a, th: r.th } });
    const c2 = mcpClient(r2.srv);
    assert.equal(JSON.stringify((await c2.req('tools/list')).result.tools), JSON.stringify(first));
    c2.close();
    r2.reg.dispose();

    // Codex and OpenCode get the same small list (they needed the whole set before: they do not list again).
    for (const engine of ['codex', 'acp'] as const) {
      const x = await runWithTools(t, bridge, { tool_groups: groups }, engine, {}, { prompt: q, system: true });
      const xl = (await x.host.list()).map((s) => s.name);
      assert.deepEqual(xl, await x.host.names());
      assert.deepEqual(xl.filter((n) => n !== 'web_search'), listed.filter((n) => !byName.includes(n)), `${engine}: the same list, plus the search a Claude Code has itself`);
      x.reg.dispose();
    }
    // "Fewer tools" off (contextSaver.selectTools): the whole set in the list, on every engine.
    const off = await runWithTools(t, bridge, { tool_groups: groups, settings: { contextSaver: { selectTools: false } } }, 'claude', {}, { prompt: q, system: true });
    const ol = (await off.host.list()).map((s) => s.name);
    assert.ok(!ol.includes(FIND_NAME) && !ol.includes(CALL_NAME) && ol.includes('routine_create') && ol.includes('browser_click'));
    off.reg.dispose();
  } finally {
    killAll();
    bridge.stop();
    await t.close();
  }
});

test('one turn of a Claude Code main bot: the answer counts the TeamBot tools it was listed; the CLI reaches the rest in the same run', async (tt) => {
  const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-agents-fake-claude.mjs');
  const t = await startTestApp();
  try {
    const p = await t.api('POST', '/providers', { kind: 'claude-code', config: { path: FAKE_CLAUDE } });
    const turn = async (settings: any) => {
      const a = await t.api('POST', '/agents', { name: settings ? 'BaasVoor' : 'BaasNa', provider_id: p.id, model: '', access_mode: 'ask', tool_groups: GROUPS, ...(settings ? { settings } : {}) });
      const th = await t.api('POST', '/threads', { agentId: a.id });
      await t.say(th.id, 'Welke tools heb je? SCENARIO:tools', 60_000);
      return t.app.ctx.store.messages(th.id).filter((m) => m.role === 'assistant').at(-1)!;
    };
    const before = await turn({ contextSaver: { selectTools: false } });
    const after = await turn(null);
    const b = before.parts.contextStats!;
    const n = after.parts.contextStats!;
    tt.diagnostic(`TeamBot tools per turn: everything ~${b.parts.tools} tokens (${b.tools.sent}/${b.tools.of}), the small list ~${n.parts.tools} tokens (${n.tools.sent}/${n.tools.of})`);
    assert.equal(b.tools.sent, b.tools.of, 'off: every tool');
    assert.ok(n.tools.sent < n.tools.of && n.tools.leftOut.length > 0, JSON.stringify(n.tools));
    assert.ok(n.parts.tools < b.parts.tools * 0.4, `${n.parts.tools} vs ${b.parts.tools}`);
    assert.ok(n.shortened.savedTokens > 0);
    // The fake Claude Code looked up everything outside its list and used one of them: nothing is out of reach.
    assert.match(after.content, /via tools_find: /);
    const [listed, rest = ''] = after.content.replace('TeamBot-tools: ', '').split(' · via tools_find: ');
    const [found] = rest.split(' · tools_call ');
    const all = new Set([...listed.split(', '), ...found.split(', ')].filter(Boolean));
    for (const w of before.content.replace('TeamBot-tools: ', '').split(', ')) assert.ok(all.has(w), `${w} listed or found`);
    assert.ok(found.split(', ').includes('routine_create'), after.content);
    assert.match(after.content, /tools_call routine_list: gelukt/);
  } finally {
    await t.close();
  }
});
