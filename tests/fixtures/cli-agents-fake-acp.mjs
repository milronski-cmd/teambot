#!/usr/bin/env node
// Fake ACP agent for tests (JSON-RPC 2.0 over stdio, newline delimited).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const scen = (t) => [...String(t).matchAll(/SCENARIO:(\w+)/g)].map((m) => m[1]).at(-1);
// Like OpenCode: 2.x by default (TeamBot's own copy), 1.x with FAKE_OC_V1 (the npm line) or any FAKE_ACP_VERSION.
const V1 = !!process.env.FAKE_OC_V1 || /^1\./.test(process.env.FAKE_ACP_VERSION || '');
if (argv[0] === '--version') {
  console.log(`opencode v${process.env.FAKE_ACP_VERSION || (V1 ? '1.19.5' : '2.2.6')}`);
  process.exit(0);
}
// `opencode stats … --json`: 1.x does not know --standalone (prints its help), 2.x does.
if (argv[0] === 'stats') {
  if (process.env.FAKE_CLI_LOG) fs.appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ cli: 'acp', mode: 'stats', argv }) + '\n');
  if (V1 && argv.includes('--standalone')) {
    console.log('opencode stats\n\nshow token usage and cost statistics');
    process.exit(1);
  }
  console.log(JSON.stringify({ sessions: 3, cost: 0, tokens: { input: 1200, output: 300, reasoning: 0, cache: { read: 0, write: 0 } } }));
  process.exit(0);
}
// `opencode models --standalone`: one "provider/model" per line, the free ones included.
if (argv[0] === 'models') {
  console.log('opencode/big-pickle\nopencode/beam-free\nanthropic/claude-sonnet-4-5');
  process.exit(0);
}
// 2.x refuses 1.x's upper-case log level and only prints its help (verified live with 2.2.6).
if (!V1 && argv.includes('--log-level') && argv[argv.indexOf('--log-level') + 1] !== argv[argv.indexOf('--log-level') + 1].toLowerCase()) {
  console.log('DESCRIPTION\n  Start an Agent Client Protocol server');
  process.stderr.write(`ERROR\n  Invalid value for flag --log-level: "${argv[argv.indexOf('--log-level') + 1]}". Expected: "all" | "trace" | "debug" | "info" | "warn" | "warning" | "error" | "fatal" | "none"\n`);
  process.exit(1);
}
// One answer without a session, like `opencode run --standalone <prompt>` (a TeamBot summary for "Gesprek samenvatten").
if (argv[0] === 'run') {
  if (process.env.FAKE_CLI_LOG) fs.appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ cli: 'acp', mode: 'complete', argv }) + '\n');
  // OpenCode 1.19.5 does not know --standalone: it prints only the help of "run" and exits 1.
  if (V1 && argv.includes('--standalone')) {
    process.stderr.write('opencode run [message..]\n\nrun opencode with a message\n\nPositionals:\n  message  message to send  [array] [default: []]\n');
    process.exit(1);
  }
  if (argv.some((a) => String(a).includes('SCENARIO:freelimit'))) {
    // 2.x: the error on stderr and exit 1, within a second (live, 2.2.6).
    if (!V1) {
      process.stderr.write('\x1b[0m\n> build · big-pickle\n\x1b[91m\x1b[1mError: \x1b[0mFree usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.\n');
      process.exit(1);
    }
    // 1.x: at the daily free limit the error only goes to the log (stderr with --print-logs) and `run` never ends.
    if (argv.includes('--print-logs')) process.stderr.write('timestamp=2026-11-07T11:04:09.849Z level=ERROR run=a1 message="stream error" providerID=opencode modelID=big-pickle session.id=x small=false agent=build mode=primary error.error="AI_APICallError: Free usage limit reached. Free models work in OpenCode."\n');
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  console.log(argv.some((a) => String(a).includes('Nieuw gespreksdeel om op te nemen')) ? '## Besluiten\n- SAMENVATTING-VAN-FAKE-OPENCODE' : 'ok');
  process.exit(0);
}
const log = (o) => process.env.FAKE_CLI_LOG && fs.appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ cli: 'acp', ...o }) + '\n');
const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');
// Like OpenCode 2.x: two `opencode acp` booting at the same time share one SQLite database; the one that finds it
// locked exits with "Standalone server exited before reporting readiness" (FAKE_ACP_BOOT_LOCK = lock file).
// FAKE_ACP_FAIL_STARTS = counter file: the first N starts fail that way (N in FAKE_ACP_FAIL_N, default 1).
const bootFail = () => {
  process.stderr.write('Error: Standalone server exited before reporting readiness\n    at <anonymous> (B:/~BUN/root/chunk-d288gyy1.js:2:1020)\n');
  process.exit(1);
};
if (process.env.FAKE_ACP_FAIL_STARTS) {
  const f = process.env.FAKE_ACP_FAIL_STARTS;
  const n = Number(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : 0);
  fs.writeFileSync(f, String(n + 1));
  if (n < Number(process.env.FAKE_ACP_FAIL_N || 1)) bootFail();
}
if (process.env.FAKE_ACP_BOOT_LOCK) {
  const lock = process.env.FAKE_ACP_BOOT_LOCK;
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  } catch {
    log({ boot: 'locked' });
    bootFail();
  }
  // booting (migrations, readiness) takes a moment; the lock goes when the server is ready
  await new Promise((r) => setTimeout(r, 400));
  fs.rmSync(lock, { force: true });
}
let nextId = 1000;
const waiting = new Map();
const call = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
let sessions = 0;
// MCP servers TeamBot handed to each session (session/new|load: `mcpServers`), and a tiny MCP stdio client for them.
const sessionMcp = new Map();
const mcpClients = new Map();
function mcp(srv, method, params) {
  let c = mcpClients.get(srv);
  if (!c) {
    const env = { ...process.env, ...Object.fromEntries((srv.env || []).map((e) => [e.name, e.value])) };
    const child = spawn(srv.command, srv.args || [], { env, stdio: ['pipe', 'pipe', 'inherit'] });
    const pending = new Map();
    readline.createInterface({ input: child.stdout }).on('line', (l) => {
      try {
        const msg = JSON.parse(l);
        pending.get(msg.id)?.(msg);
      } catch {
        /* not JSON */
      }
    });
    let id = 0;
    const req = (mth, prm) =>
      new Promise((resolve) => {
        const i = ++id;
        pending.set(i, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method: mth, params: prm }) + '\n');
      });
    c = { req, ready: req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-acp', version: '1' } }), child };
    mcpClients.set(srv, c);
    process.on('exit', () => child.kill());
  }
  return c.ready.then(() => c.req(method, params));
}
let mode = 'default';
let cancelled = false;
// The owner's last prompt per session (a follow-up turn of TeamBot continues that scenario).
const lastPrompt = new Map();
const initialMode = argv.includes('--start-yolo') ? 'yolo' : 'default';
log({ argv, cwd: process.cwd() });
process.stdout.write('dit is een logregel en geen JSON\n');

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const m = JSON.parse(line);
  if (m.id !== undefined && !m.method) {
    waiting.get(m.id)?.(m);
    return;
  }
  log({ method: m.method, params: m.method === 'session/prompt' ? { text: m.params.prompt[0].text, blocks: m.params.prompt.map((b) => b.type) } : m.params });
  const p = m.params || {};
  switch (m.method) {
    case 'initialize':
      return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } }, authMethods: [{ id: 'login', name: 'Inloggen' }] } });
    case 'session/new': {
      if (argv.includes('--need-auth')) return send({ id: m.id, error: { code: -32000, message: 'Authentication required' } });
      sessions++;
      const sidNew = `acp-${Date.now()}-${sessions}`;
      sessionMcp.set(sidNew, p.mcpServers || []);
      return send({ id: m.id, result: { sessionId: sidNew, modes: { currentModeId: initialMode, availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }, { id: 'yolo', name: 'YOLO' }] } } });
    }
    case 'session/load':
      sessionMcp.set(p.sessionId, p.mcpServers || []);
      if (p.sessionId === 'kwijt') return send({ id: m.id, error: { code: -32002, message: 'session not found' } });
      update(p.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OUDE GESCHIEDENIS' } });
      return send({ id: m.id, result: { modes: { currentModeId: 'default', availableModes: [{ id: 'default' }, { id: 'plan' }] } } });
    case 'session/set_mode':
      mode = p.modeId;
      return send({ id: m.id, result: {} });
    case 'session/cancel':
      cancelled = true;
      return;
    case 'session/prompt': {
      const sid = p.sessionId;
      let text = p.prompt[0].text;
      // TeamBot's follow-up turn after it refused an action and this agent ended its turn (see acp.ts FOLLOW_UPS): the
      // same scenario goes on, marked VERVOLG.
      if (/^\[TeamBot\] TeamBot heeft deze actie geweigerd/.test(text) && lastPrompt.has(sid)) text = `${lastPrompt.get(sid)} VERVOLG`;
      else lastPrompt.set(sid, text);
      if (scen(text) === 'crash') {
        process.stderr.write('acp crash\n');
        process.exit(5);
      }
      if (!V1 && (scen(text) === 'freelimit' || scen(text) === 'loggedlimit')) {
        // Like OpenCode 2.2.6 at the daily free limit (live): the turn ends with this error after about a second.
        return setTimeout(() => send({ id: m.id, error: { code: -32603, message: 'Internal error: Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.', data: { service: 'session', errorName: 'provider.free-limit' } } }), 100);
      }
      if (scen(text) === 'freelimit') {
        // Like OpenCode 1.19 at the daily free limit: the error only goes to its log (stderr), the turn never ends.
        process.stderr.write('timestamp=2026-11-07T11:04:06.201Z level=ERROR run=a1 message="stream error" providerID=opencode modelID=big-pickle session.id=x small=true agent=title mode=primary error.error="AI_RetryError: Failed after 3 attempts. Last error: Free usage limit reached."\n');
        process.stderr.write('timestamp=2026-11-07T11:04:09.849Z level=ERROR run=a1 message="stream error" providerID=opencode modelID=big-pickle session.id=x small=false agent=build mode=primary error.error="AI_APICallError: Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go"\n');
        return;
      }
      if (scen(text) === 'loggedlimit') {
        // Like OpenCode 1.19.5: the model refuses (free limit), the error only goes to the log (stderr with
        // --print-logs) and the turn is never answered.
        const line = (small) => `timestamp=${new Date().toISOString()} level=ERROR run=abc message="stream error" providerID=opencode modelID=big-pickle session.id=${sid} small=${small} agent=build mode=primary error.error="AI_APICallError: Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go"\n`;
        if (argv.includes('--print-logs')) {
          process.stderr.write(line(true));
          setTimeout(() => process.stderr.write(line(false)), 50);
        }
        return;
      }
      if (scen(text) === 'hang') {
        const t = setInterval(() => {
          if (cancelled && !argv.includes('--ignore-cancel')) {
            clearInterval(t);
            send({ id: m.id, result: { stopReason: 'cancelled' } });
          }
        }, 20);
        return;
      }
      update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'nadenken' } });
      update(sid, { sessionUpdate: 'plan', entries: [{ content: 'Stap 1', priority: 'high', status: 'in_progress' }] });
      if (scen(text) === 'sneaky') {
        // Like a CLI that approves its own edits: writes directly, never asks TeamBot.
        const target = path.join(process.cwd(), 'stiekem.txt');
        update(sid, { sessionUpdate: 'tool_call', toolCallId: 's1', title: 'Schrijf stiekem.txt', kind: 'edit', status: 'pending', locations: [{ path: target }] });
        fs.writeFileSync(target, 'zonder te vragen');
        update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 's1', status: 'completed' });
        await new Promise((r) => setTimeout(r, 300));
        update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Klaar.' } });
        return send({ id: m.id, result: { stopReason: 'end_turn' } });
      }
      if (scen(text) === 'edit') {
        const target = path.join(process.cwd(), 'acp.txt');
        update(sid, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Schrijf acp.txt', kind: 'edit', status: 'pending', locations: [{ path: target }] });
        const r = await call('session/request_permission', {
          sessionId: sid,
          toolCall: { toolCallId: 't1' },
          options: [
            { optionId: 'ok1', name: 'Allow', kind: 'allow_once' },
            { optionId: 'okall', name: 'Always', kind: 'allow_always' },
            { optionId: 'no', name: 'Reject', kind: 'reject_once' },
          ],
        });
        log({ permission: r.result });
        if (r.result?.outcome?.optionId === 'ok1') {
          const w = await call('fs/write_text_file', { sessionId: sid, path: target, content: 'via acp' });
          log({ write: w });
          update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
          update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Bestand geschreven.' } });
        } else {
          update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed' });
          update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Geweigerd.' } });
        }
        return send({ id: m.id, result: { stopReason: 'end_turn' } });
      }
      if (scen(text) === 'exec') {
        // TeamBot's follow-up after a refusal: do the rest without the command (KOPPIG: try the same command again).
        if (/VERVOLG/.test(text) && !/KOPPIG/.test(text)) {
          update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'De rest is klaar; npm test mocht niet.' } });
          return send({ id: m.id, result: { stopReason: 'end_turn' } });
        }
        const r = await call('session/request_permission', {
          sessionId: sid,
          toolCall: { toolCallId: 't2', title: 'Voer uit', kind: 'execute', rawInput: { command: /git push/.test(text) ? 'git push origin main' : 'npm test' } },
          options: [
            { optionId: 'a', name: 'Allow', kind: 'allow_once' },
            { optionId: 'r', name: 'Reject', kind: 'reject_once' },
          ],
        });
        log({ permission: r.result });
        // Like OpenCode 2.x: after a refused action it ends the turn itself, empty, as "cancelled" (with STOPNAWEIGERING).
        if (/STOPNAWEIGERING/.test(text) && r.result?.outcome?.optionId !== 'a') return send({ id: m.id, result: { stopReason: 'cancelled' } });
        update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: r.result?.outcome?.optionId === 'a' ? 'uitgevoerd' : 'niet uitgevoerd' } });
        return send({ id: m.id, result: { stopReason: 'end_turn' } });
      }
      if (scen(text) === 'paralleldrop' || scen(text) === 'eerstgoed') {
        // Like OpenCode 2.x writing two files at once (live, round 6): one lands outside the bot's folders and is
        // refused; OpenCode then drops the other call (failed) and ends the turn, while that call still waits for a card
        // (paralleldrop) or after the owner had approved it (eerstgoed: asked first and answered before the refusal).
        const outside = path.join(path.dirname(process.cwd()), '..', 'buiten-parallel.txt');
        const inside = path.join(process.cwd(), 'binnen-parallel.txt');
        const opts = [
          { optionId: 'a', name: 'Allow', kind: 'allow_once' },
          { optionId: 'r', name: 'Reject', kind: 'reject_once' },
        ];
        const rawInside = { filePath: inside, content: 'prijs 49 euro' };
        if (/VERVOLG/.test(text)) {
          // TeamBot's follow-up turn: only the write that may happen, the very same action again.
          update(sid, { sessionUpdate: 'tool_call', toolCallId: 'pi2', title: 'write', kind: 'edit', status: 'pending', locations: [{ path: inside }], rawInput: rawInside });
          const r = await call('session/request_permission', { sessionId: sid, toolCall: { toolCallId: 'pi2' }, options: opts });
          log({ parallel: { retry: r.result?.outcome } });
          if (r.result?.outcome?.optionId !== 'a') {
            update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'pi2', status: 'failed' });
            return send({ id: m.id, result: { stopReason: 'cancelled' } });
          }
          await call('fs/write_text_file', { sessionId: sid, path: inside, content: rawInside.content });
          update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'pi2', status: 'completed' });
          update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Binnen geschreven; buiten mocht niet.' } });
          return send({ id: m.id, result: { stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 3 } } });
        }
        if (scen(text) === 'eerstgoed') {
          update(sid, { sessionUpdate: 'tool_call', toolCallId: 'pi', title: 'write', kind: 'edit', status: 'pending', locations: [{ path: inside }], rawInput: rawInside });
          update(sid, { sessionUpdate: 'tool_call', toolCallId: 'pb', title: 'write', kind: 'edit', status: 'pending', locations: [{ path: outside }] });
          const rIn = await call('session/request_permission', { sessionId: sid, toolCall: { toolCallId: 'pi' }, options: opts });
          const rOut = await call('session/request_permission', { sessionId: sid, toolCall: { toolCallId: 'pb' }, options: opts });
          log({ parallel: { inside: rIn.result?.outcome, outside: rOut.result?.outcome } });
          update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'pb', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'The user declined this tool call' } }] });
          update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'pi', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'The user declined this tool call' } }] });
          return send({ id: m.id, result: { stopReason: 'cancelled', usage: { inputTokens: 10, outputTokens: 2 } } });
        }
        update(sid, { sessionUpdate: 'tool_call', toolCallId: 'pb', title: 'write', kind: 'edit', status: 'pending', locations: [{ path: outside }] });
        update(sid, { sessionUpdate: 'tool_call', toolCallId: 'pi', title: 'write', kind: 'edit', status: 'pending', locations: [{ path: inside }] });
        const pInside = call('session/request_permission', { sessionId: sid, toolCall: { toolCallId: 'pi' }, options: opts });
        const rOut = await call('session/request_permission', { sessionId: sid, toolCall: { toolCallId: 'pb' }, options: opts });
        log({ parallel: { outside: rOut.result?.outcome } });
        update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'pb', status: 'failed' });
        update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'pi', status: 'failed' });
        const rIn = await pInside;
        log({ parallel: { inside: rIn.result?.outcome } });
        return send({ id: m.id, result: { stopReason: 'cancelled' } });
      }
      if (scen(text) === 'asktwice') {
        // Like OpenCode 2.x writing outside its folder: "external_directory" and then "edit", same tool call.
        const target = path.join(process.cwd(), 'twee.txt');
        update(sid, { sessionUpdate: 'tool_call', toolCallId: 'w2', title: target, kind: 'edit', status: 'pending', locations: [{ path: target }] });
        const opts = [
          { optionId: 'a', name: 'Allow', kind: 'allow_once' },
          { optionId: 'r', name: 'Reject', kind: 'reject_once' },
        ];
        const first = await call('session/request_permission', { sessionId: sid, toolCall: { toolCallId: 'w2' }, options: opts });
        const second = await call('session/request_permission', { sessionId: sid, toolCall: { toolCallId: 'w2' }, options: opts });
        log({ asktwice: [first.result?.outcome?.optionId, second.result?.outcome?.optionId] });
        update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'w2', status: 'completed' });
        update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'klaar' } });
        return send({ id: m.id, result: { stopReason: 'end_turn' } });
      }
      if (scen(text) === 'extdir') {
        // Like OpenCode 2.x with permission.external_directory "ask": reading a file outside its folder asks first.
        // The paths come after the scenario word: "SCENARIO:extdir <path1> <path2> …".
        const outcomes = [];
        const rest = text.slice(text.lastIndexOf('SCENARIO:extdir') + 'SCENARIO:extdir'.length).split('\n')[0];
        for (const [i, p] of rest.split(/\s+/).filter(Boolean).entries()) {
          const r = await call('session/request_permission', {
            sessionId: sid,
            toolCall: { toolCallId: `x${i}`, title: 'read', kind: 'read', locations: [{ path: p }], rawInput: { filepath: p, parentDir: path.dirname(p) } },
            options: [
              { optionId: 'a', name: 'Allow', kind: 'allow_once' },
              { optionId: 'r', name: 'Reject', kind: 'reject_once' },
            ],
          });
          outcomes.push({ path: p, option: r.result?.outcome?.optionId || null });
        }
        log({ extdir: outcomes });
        update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: outcomes.map((o) => o.option).join(',') } });
        return send({ id: m.id, result: { stopReason: 'end_turn' } });
      }
      if (scen(text) === 'codemode') {
        // Like OpenCode 2.2.6 code mode (live): one "execute" step whose program arrives only after it ran (the TeamBot
        // call comes first). ECHTECODE: a program that also does something else (fetch).
        const srv = (sessionMcp.get(sid) || []).find((x) => x.name === 'teambot');
        const code = /ECHTECODE/.test(text)
          ? 'const page = await fetch("https://example.com");\nreturn await tools.teambot.memory_search({ query: "fiets" });'
          : 'const r = await tools.teambot.memory_search({ query: "fiets" });\nreturn r;';
        update(sid, { sessionUpdate: 'tool_call', toolCallId: 'cm1', name: 'execute', title: 'execute', kind: 'other', status: 'pending', locations: [], rawInput: {} });
        const out = srv ? await mcp(srv, 'tools/call', { name: 'memory_search', arguments: { query: 'fiets' } }) : null;
        const body = out?.result?.content?.map((c) => c.text || '').join('') || '';
        update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'cm1', status: 'in_progress', kind: 'other', title: 'execute', locations: [], rawInput: { code } });
        update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'cm1', status: 'completed', locations: [], content: [{ type: 'content', content: { type: 'text', text: body } }] });
        log({ codemode: { read: body.slice(0, 200) } });
        update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: body ? 'Gezocht.' : 'Geen TeamBot.' } });
        return send({ id: m.id, result: { stopReason: 'end_turn' } });
      }
      if (scen(text) === 'codemode3') {
        // Like OpenCode 2.2.5 live (practice test 0.4.4): three different code-mode steps in a row (a lookup, then two
        // TeamBot tools). Each starts as the same bare "execute" step; only later updates say what it did.
        const srv = (sessionMcp.get(sid) || []).find((x) => x.name === 'teambot');
        const steps = [
          { code: 'return await search("taak");' },
          { code: 'return await tools.teambot.memory_search({ query: "fiets" });', tool: 'memory_search', args: { query: 'fiets' } },
          { code: 'return await tools.teambot.memory_search({ query: "winkel" });', tool: 'memory_search', args: { query: 'winkel' } },
        ];
        const ran = [];
        for (const [i, st] of steps.entries()) {
          const id = `cm3-${i}`;
          update(sid, { sessionUpdate: 'tool_call', toolCallId: id, name: 'execute', title: 'execute', kind: 'other', status: 'pending', locations: [], rawInput: {} });
          await new Promise((r) => setTimeout(r, 30));
          const out = st.tool && srv ? await mcp(srv, 'tools/call', { name: st.tool, arguments: st.args }) : null;
          const body = out?.result?.content?.map((c) => c.text || '').join('') || 'search: 1 tool';
          update(sid, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress', kind: 'other', title: 'execute', locations: [], rawInput: { code: st.code } });
          update(sid, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', locations: [], content: [{ type: 'content', content: { type: 'text', text: body } }] });
          ran.push(i);
          await new Promise((r) => setTimeout(r, 30));
        }
        log({ codemode3: { ran } });
        update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Drie stappen gedaan.' } });
        return send({ id: m.id, result: { stopReason: 'end_turn' } });
      }
      if (scen(text) === 'webfetch') {
        // Reads the page in the prompt with TeamBot's own "Pagina lezen" (web_fetch over MCP), like a CLI that uses it.
        const url = (text.match(/https?:\/\/[^\s)]+/) || [])[0];
        const srv = (sessionMcp.get(sid) || []).find((x) => x.name === 'teambot');
        const out = srv && url ? await mcp(srv, 'tools/call', { name: 'web_fetch', arguments: { url } }) : null;
        const body = out?.result?.content?.map((c) => c.text || '').join('') || '';
        log({ webfetch: { url, read: body.slice(0, 400) } });
        update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: body ? 'De pagina is gelezen.' : 'Niet gelezen.' } });
        return send({ id: m.id, result: { stopReason: 'end_turn' } });
      }
      if (scen(text) === 'pdf') {
        // Like OpenCode with a pdf attachment: its own read tool cannot read a pdf. With TeamBot's read_document (named
        // in the prompt and offered over MCP) it reads once through TeamBot; without it, it falls back to two Python
        // commands in the terminal (pdfplumber, then pypdf) — each a shell approval (acceptance round 3, A-39).
        const pdf = (text.match(/(uploads[\\/][^\s()]+\.pdf)/) || [])[1];
        const srv = (sessionMcp.get(sid) || []).find((x) => x.name === 'teambot');
        const tools = srv ? await mcp(srv, 'tools/list', {}) : null;
        const reader = tools?.result?.tools?.find((t) => t.name === 'read_document');
        const permissions = [];
        if (pdf && reader && /read_document/.test(text)) {
          update(sid, { sessionUpdate: 'tool_call', toolCallId: 'd1', title: 'teambot_read_document', kind: 'other', status: 'pending', rawInput: { path: pdf } });
          const r = await call('session/request_permission', { sessionId: sid, toolCall: { toolCallId: 'd1' }, options: [{ optionId: 'a', name: 'Allow', kind: 'allow_once' }, { optionId: 'r', name: 'Reject', kind: 'reject_once' }] });
          permissions.push({ kind: 'mcp', option: r.result?.outcome?.optionId || null });
          const out = r.result?.outcome?.optionId === 'a' ? await mcp(srv, 'tools/call', { name: 'read_document', arguments: { path: pdf } }) : null;
          const body = out?.result?.content?.map((c) => c.text || '').join('') || '';
          update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'd1', status: out?.result?.isError ? 'failed' : 'completed' });
          log({ pdf: { permissions, read: body.slice(0, 400) } });
          update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Samenvatting: ${body.replace(/\s+/g, ' ').slice(0, 300)}` } });
          return send({ id: m.id, result: { stopReason: 'end_turn' } });
        }
        for (const [i, code] of ["import pdfplumber; print(pdfplumber.open('x').pages)", "from pypdf import PdfReader; print(PdfReader('x').pages)"].entries()) {
          const r = await call('session/request_permission', {
            sessionId: sid,
            toolCall: { toolCallId: `py${i}`, title: 'bash', kind: 'execute', rawInput: { command: `python -c "${code}"` } },
            options: [{ optionId: 'a', name: 'Allow', kind: 'allow_once' }, { optionId: 'r', name: 'Reject', kind: 'reject_once' }],
          });
          permissions.push({ kind: 'execute', option: r.result?.outcome?.optionId || null });
        }
        log({ pdf: { permissions, read: '' } });
        update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'via de terminal' } });
        return send({ id: m.id, result: { stopReason: 'end_turn' } });
      }
      if (scen(text) === 'read') {
        const inside = await call('fs/read_text_file', { sessionId: sid, path: path.join(process.cwd(), 'lees.txt') });
        const outside = await call('fs/read_text_file', { sessionId: sid, path: path.resolve(process.cwd(), '..', '..', 'master.key') });
        const w = await call('fs/write_text_file', { sessionId: sid, path: path.join(process.cwd(), 'stiekem.txt'), content: 'x' });
        log({ inside, outside, write: w });
        update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `gelezen: ${inside.result?.content}` } });
        return send({ id: m.id, result: { stopReason: 'end_turn' } });
      }
      update(sid, { sessionUpdate: 'tool_call', toolCallId: 'r1', title: 'Lees README', kind: 'read', status: 'completed' });
      for (const t of ['Hoi ', 'van ', 'ACP']) update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } });
      return send({ id: m.id, result: { stopReason: 'end_turn', usage: { inputTokens: 12, outputTokens: 7 } } });
    }
    default:
      if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: 'nope' } });
  }
});
