#!/usr/bin/env node
// Fake "claude" CLI for tests: mimics `claude -p --output-format stream-json` incl. the
// MCP permission-prompt tool round trip. Scenario is picked from keywords in the prompt.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const scen = (t) => [...String(t).matchAll(/SCENARIO:(\w+)/g)].map((m) => m[1]).at(-1);
const log = (o) => process.env.FAKE_CLI_LOG && fs.appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ cli: 'claude', ...o }) + '\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const arg = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);

if (argv[0] === '--version') {
  console.log('2.1.999 (Claude Code)');
  process.exit(0);
}
if (argv[0] === '--help') {
  console.log(`Usage: claude [options]
  --append-system-prompt-file <file>
  --include-partial-messages   Include partial message chunks
  --permission-mode <mode>     Permission mode (choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")
  --permission-prompts <target>  "host" or "none"
  --restricted                 Restricted mode
  --tools <tools...>           Specify the list of available tools
  --effort <level>             Effort level
  --setting-sources <sources>  Comma-separated list of setting sources to load (user, project, local).
  --settings <file-or-json>    Path to a settings JSON file or a JSON string`);
  process.exit(0);
}
// FAKE_CLAUDE_LOGIN_FILE: logged out until `auth login` succeeded (it writes that file).
const loginFile = process.env.FAKE_CLAUDE_LOGIN_FILE;
if (argv[0] === 'auth' && argv[1] === 'status') {
  const fs1 = await import('node:fs');
  if (loginFile && !fs1.existsSync(loginFile)) {
    console.log(JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }));
    process.exit(1);
  }
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: 'geheim@example.com', orgName: 'Geheime Org' }));
  process.exit(0);
}
// Like Claude Code 2.1.319 without a terminal (checked live, isolated): it runs $BROWSER <url> (or rundll32/open),
// prints the sign-in link and waits for the code from the sign-in page on its input.
if (argv[0] === 'auth' && argv[1] === 'login') {
  const fs2 = await import('node:fs');
  if (process.env.FAKE_CLI_LOG) fs2.appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ cli: 'claude', mode: 'login', argv, browser: process.env.BROWSER || null }) + '\n');
  process.stdout.write('Opening browser to sign in…\n');
  process.stdout.write("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=fake&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s123\nPaste code here if prompted > ");
  let input = '';
  process.stdin.on('data', (d) => {
    input += d;
    if (!input.includes('\n')) return;
    const code = input.trim();
    if (process.env.FAKE_CLI_LOG) fs2.appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ cli: 'claude', mode: 'login-code', ok: code === 'goede-code#s123' }) + '\n');
    if (code === 'goede-code#s123') {
      if (loginFile) fs2.writeFileSync(loginFile, 'ingelogd');
      process.stdout.write('\nLogin successful.\n');
      process.exit(0);
    }
    process.stdout.write('\nOAuth error: Invalid code. Please make sure the full code was copied\n');
    process.exit(1);
  });
  await new Promise(() => {});
}

// One-shot answer without tools (`claude -p <prompt> --output-format text`), e.g. "maak een profiel".
if (arg('--output-format') === 'text') {
  log({ mode: 'complete', argv });
  // "Gesprek samenvatten" with a TeamBot summary (agent/compaction.ts) asks for a summary of the older part.
  if (String(arg('-p') || '').includes('Nieuw gespreksdeel om op te nemen')) {
    console.log('## Besluiten\n- SAMENVATTING-VAN-FAKE-CLAUDE: Velomax zit in Arnhem');
    process.exit(0);
  }
  console.log('Hier is het profiel:\n' + JSON.stringify({ name: 'Fietshulp', role: 'Klantenservice', description: 'Beantwoordt klantvragen.', instructions: '- Kort en vriendelijk', avatar: '🚲', color: '#336699', tool_groups: ['memory'], access_mode: 'ask' }));
  process.exit(0);
}

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', main);

function mcpCall(cfgFile, toolName, input) {
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  const srv = cfg.mcpServers.teambot;
  const child = spawn(srv.command, srv.args, { env: { ...process.env, ...srv.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  rl.on('line', (l) => {
    const m = JSON.parse(l);
    pending.get(m.id)?.(m);
  });
  let id = 0;
  const req = (method, params) =>
    new Promise((resolve) => {
      const i = ++id;
      pending.set(i, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
    });
  return (async () => {
    await req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } });
    const tools = await req('tools/list', {});
    const gate = tools.result.tools.find((t) => t.name === 'permission_prompt');
    if (!gate) {
      child.kill();
      return { behavior: 'deny', message: 'geen permission tool (print-modus weigert)' };
    }
    const r = await req('tools/call', { name: gate.name, arguments: { tool_name: toolName, input, tool_use_id: 'tu_1' } });
    child.kill();
    return JSON.parse(r.result.content[0].text);
  })();
}

/**
 * The tool names TeamBot's MCP server offers this run (SCENARIO:tools), like Claude Code sees them. When the list leaves
 * parts out (tools_load), this loads every part and lists again after `notifications/tools/list_changed`, as Claude Code
 * does for a server with `capabilities.tools.listChanged`: `{ listed, loaded }`.
 */
async function mcpToolLists(cfgFile) {
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  const srv = cfg.mcpServers.teambot;
  const child = spawn(srv.command, srv.args, { env: { ...process.env, ...srv.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  // Like Claude Code: on list_changed, list again at once (TeamBot holds the call's result until then).
  let relist = null;
  rl.on('line', (l) => {
    const m = JSON.parse(l);
    if (m.method === 'notifications/tools/list_changed') relist = req('tools/list', {});
    else pending.get(m.id)?.(m);
  });
  let id = 0;
  const req = (method, params) =>
    new Promise((resolve) => {
      const i = ++id;
      pending.set(i, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
    });
  const init = await req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } });
  const first = (await req('tools/list', {})).result?.tools || [];
  const listed = first.map((t) => t.name);
  let loaded = [];
  const loader = first.find((t) => t.name === 'tools_load');
  if (loader && init.result?.capabilities?.tools?.listChanged) {
    const parts = loader.inputSchema?.properties?.names?.items?.enum || [];
    const r = await req('tools/call', { name: 'tools_load', arguments: { names: parts } });
    if (!r.result?.isError && relist) loaded = ((await relist).result?.tools || []).map((t) => t.name).filter((n) => !listed.includes(n));
  }
  child.kill();
  return { listed, loaded };
}

async function main() {
  const resume = arg('--resume');
  const sysFile = arg('--append-system-prompt-file');
  log({ argv, prompt, cwd: process.cwd(), system: sysFile && fs.existsSync(sysFile) ? fs.readFileSync(sysFile, 'utf8') : null, leakedSecret: !!process.env.TEAMBOT_TEST_SECRET || !!process.env.MY_API_KEY, autoMemoryOff: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === '1' });
  if (scen(prompt) === 'badresume' && resume) {
    process.stderr.write(`No conversation found with session ID: ${resume}\n`);
    process.exit(1);
  }
  if (scen(prompt) === 'crash') {
    process.stderr.write('boom: interne fout in fake claude\n');
    process.exit(3);
  }
  const sid = resume || crypto.randomUUID();
  // Local commands (Claude Code 2.1.x print mode): /usage answers without a model call, /compact compacts the session.
  if (prompt.trim() === '/usage') {
    out({ type: 'system', subtype: 'init', session_id: sid, model: 'fake-sonnet', slash_commands: ['compact', 'usage'] });
    const text =
      process.env.FAKE_CLAUDE_USAGE ||
      ['You are currently using your subscription to power your Claude Code usage', '', 'Current session: 12% used · resets 3:59pm (Europe/Amsterdam)', 'Current week (all models): 86% used · resets Nov 13, 5:59am (Europe/Amsterdam)'].join('\n');
    out({ type: 'result', subtype: 'success', is_error: false, num_turns: 0, session_id: sid, total_cost_usd: 0, result: text, local_command: 'usage' });
    return;
  }
  // `/model` (local, no model call): the current model and the aliases; --model picks what the init event names.
  if (prompt.trim() === '/model') {
    log({ mode: 'model', argv });
    const ids = { opus: ['claude-opus-9-9', 'Opus 9.9'], sonnet: ['claude-sonnet-9-9', 'Sonnet 9.9'], haiku: ['claude-haiku-9-9', 'Haiku 9.9'], 'opus[1m]': ['claude-opus-9-9', 'Opus 9.9'] };
    const [id, name] = ids[arg('--model') || 'opus'] || ids.opus;
    out({ type: 'system', subtype: 'init', session_id: sid, model: id, slash_commands: ['compact', 'usage', 'model'] });
    out({ type: 'result', subtype: 'success', is_error: false, num_turns: 0, session_id: sid, total_cost_usd: 0, local_command: 'model', result: `Current model: \`${name}\`\nUsage: /model <name>. Available: sonnet, opus, haiku, opus[1m], default, or a full model ID.` });
    return;
  }
  if (prompt.trim() === '/compact') {
    out({ type: 'system', subtype: 'status', status: 'compacting', session_id: sid });
    out({ type: 'system', subtype: 'status', status: null, compact_result: 'success', session_id: sid });
    out({ type: 'system', subtype: 'init', session_id: sid, model: 'fake-sonnet' });
    out({ type: 'system', subtype: 'compact_boundary', session_id: sid, compact_metadata: { trigger: 'manual', pre_tokens: 120000, post_tokens: 9000 } });
    out({ type: 'result', subtype: 'success', is_error: false, num_turns: 0, session_id: sid, total_cost_usd: 0.01, result: '' });
    return;
  }
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'fake-sonnet', permissionMode: arg('--permission-mode'), tools: ['Read', 'Write', 'Bash'] });
  if (scen(prompt) === 'limithit') {
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: 'five_hour', utilization: 1, unifiedWindows: { five_hour: { utilization: 1, resetsAt: Math.floor(Date.now() / 1000) + 3600, status: 'rejected' } } }, session_id: sid });
    out({ type: 'result', subtype: 'success', is_error: true, result: `Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + 3600}`, session_id: sid });
    return;
  }
  if (scen(prompt) === 'halfhang') {
    // Streams the start of an answer, then hangs (stopped mid-answer).
    for (const t of ['Er was eens ', 'een vuurtorenwachter ', 'die HALVERWEGE-ZIN']) out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }, parent_tool_use_id: null, session_id: sid });
    setInterval(() => {}, 1000);
    return;
  }
  if (scen(prompt) === 'hang') {
    const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    log({ grandchild: g.pid, self: process.pid });
    setInterval(() => {}, 1000);
    return;
  }
  if (scen(prompt) === 'silent') {
    setInterval(() => {}, 1000);
    return;
  }
  if (scen(prompt) === 'login') {
    out({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login', session_id: sid });
    return;
  }
  if (scen(prompt) === 'tools') {
    const cfgFile = arg('--mcp-config');
    const { listed, loaded } = cfgFile ? await mcpToolLists(cfgFile).catch((e) => (log({ toolsError: String(e?.stack || e) }), { listed: [], loaded: [] })) : { listed: [], loaded: [] };
    log({ teambotListed: listed, teambotLoaded: loaded });
    const text = `TeamBot-tools: ${listed.sort().join(', ') || 'geen'}${loaded.length ? ` · na tools_load: ${loaded.sort().join(', ')}` : ''}`;
    out({ type: 'assistant', message: { id: 'msg_1', model: 'fake-sonnet', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: sid });
    out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid, num_turns: 1, usage: { input_tokens: 10, output_tokens: 6 }, total_cost_usd: 0.01 });
    return;
  }
  const tool = scen(prompt) === 'danger'
    ? { name: 'Bash', input: { command: 'git push origin main' } }
    : scen(prompt) === 'outside'
      ? { name: 'Write', input: { file_path: path.resolve(process.cwd(), '..', '..', 'buiten.txt'), content: 'x' } }
      : scen(prompt) === 'perm'
        ? { name: 'Write', input: { file_path: path.join(process.cwd(), 'perm.txt'), content: 'hallo' } }
        : null;
  if (tool) {
    const cfgFile = arg('--mcp-config');
    // Like Claude Code: the tool call is in the stream first, then it asks for permission, then the result follows.
    out({ type: 'assistant', message: { id: 'msg_t', content: [{ type: 'tool_use', id: 'tu_1', name: tool.name, input: tool.input }] }, parent_tool_use_id: null, session_id: sid });
    let decision;
    if (!cfgFile) decision = { behavior: 'deny', message: 'geen permission tool (print-modus weigert)' };
    else decision = await mcpCall(cfgFile, tool.name, tool.input);
    log({ decision });
    if (decision.behavior === 'allow') {
      if (tool.name === 'Write') fs.writeFileSync(tool.input.file_path, tool.input.content);
      out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] }, session_id: sid });
      out({ type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: 'Gedaan.' }] }, parent_tool_use_id: null, session_id: sid });
    } else {
      out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: decision.message, is_error: true }] }, session_id: sid });
      out({ type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: `Niet gelukt: ${decision.message}` }] }, parent_tool_use_id: null, session_id: sid });
    }
    out({ type: 'result', subtype: 'success', is_error: false, result: 'klaar', session_id: sid, usage: { input_tokens: 5, output_tokens: 3 }, total_cost_usd: 0.5 });
    return;
  }
  // default: streamed text
  out({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1' } }, parent_tool_use_id: null, session_id: sid });
  for (const t of ['Hallo ', 'van ', 'Claude']) out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }, parent_tool_use_id: null, session_id: sid });
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'even denken' } }, parent_tool_use_id: null, session_id: sid });
  // SCENARIO:fullcontext: the session is at 80% of its 200k window afterwards (automatic compaction next turn).
  const cacheRead = scen(prompt) === 'fullcontext' ? 160000 : 4000;
  out({ type: 'assistant', message: { id: 'msg_1', model: 'fake-sonnet', content: [{ type: 'text', text: 'Hallo van Claude' }], usage: { input_tokens: 10, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 990, output_tokens: 6 } }, parent_tool_use_id: null, session_id: sid });
  const used = scen(prompt) === 'limitwarn' ? 0.91 : 0.2;
  out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: Math.floor(Date.now() / 1000) + 7200, rateLimitType: 'five_hour', utilization: used, unifiedWindows: { five_hour: { utilization: used, resetsAt: Math.floor(Date.now() / 1000) + 7200, status: 'allowed' } } }, session_id: sid });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Hallo van Claude', session_id: sid, num_turns: 1, usage: { input_tokens: 10, cache_read_input_tokens: 4, output_tokens: 6 }, total_cost_usd: 0.25, modelUsage: { 'fake-sonnet': { contextWindow: 200000, costUSD: 0.25, costBasis: 'list' } } });
}
