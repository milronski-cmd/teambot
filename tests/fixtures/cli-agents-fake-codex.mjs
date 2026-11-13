#!/usr/bin/env node
// Fake "codex" CLI for tests: `exec --json` JSONL events and a tiny `app-server` (JSON-RPC without "jsonrpc").
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const log = (o) => process.env.FAKE_CLI_LOG && fs.appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ cli: 'codex', ...o }) + '\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

if (argv[0] === '--version') {
  console.log('codex-cli 0.999.0');
  process.exit(0);
}
if (argv[0] === 'login' && argv[1] === 'status') {
  console.log('Logged in using ChatGPT');
  process.exit(0);
}
if (argv[0] === 'sandbox') {
  // `codex sandbox -c permissions.<p>={…} -P <p> -C <dir> -- <cmd>` (TeamBot's read check, codex-sandbox.ts).
  // FAKE_CODEX_SANDBOX: "mxc" = reads limited with windows.sandbox="mxc" (or any platform sandbox off Windows),
  // "elevated" = only deny entries hold, unset = an older Codex without the subcommand.
  const kind = process.env.FAKE_CODEX_SANDBOX;
  log({ mode: 'sandbox', argv });
  if (!kind) process.exit(2);
  const profile = argv.find((a) => a.startsWith('permissions.')) || '';
  const dir = argv[argv.indexOf('-C') + 1];
  const cmd = argv.slice(argv.indexOf('--') + 1).join(' ');
  const canary = (cmd.match(/["']([^"']+kanarie\.txt)["']/) || [])[1];
  const mxc = process.platform !== 'win32' || argv.includes('windows.sandbox="mxc"');
  // The whole disk writable with a deny entry (TeamBot's check for "Volledige toegang"). FAKE_CODEX_ROOT=held: it holds
  // (the file outside is written, the denied folder is neither read nor written); unset: Codex refuses the write rule.
  if (profile.includes('":root"="write"')) {
    if (process.env.FAKE_CODEX_ROOT !== 'held') {
      console.error('error: permission profile has a write rule the active runtime cannot enforce: ":root"');
      process.exit(1);
    }
    process.stdout.write(fs.readFileSync(path.join(dir, 'binnen.txt'), 'utf8') + '\n');
    const token = (cmd.match(/TB-SCHRIJF-[0-9a-f]+/) || [])[0];
    const target = (cmd.match(/["']([^"']+geschreven\.txt)["']/) || [])[1];
    if (token && target) fs.writeFileSync(target, token);
    console.error('Toegang geweigerd.');
    process.exit(1);
  }
  if (profile.includes('":minimal"') && !(kind === 'mxc' && mxc)) {
    console.error('windows sandbox failed: elevated Windows sandbox requires effective `:root` read access');
    process.exit(1);
  }
  process.stdout.write(fs.readFileSync(path.join(dir, 'binnen.txt'), 'utf8') + '\n');
  const denied = profile.includes('":minimal"') || (canary && profile.includes(JSON.stringify(path.dirname(canary)) + '="deny"'));
  if (denied) console.error('Toegang geweigerd.');
  else if (canary) process.stdout.write(fs.readFileSync(canary, 'utf8') + '\n');
  process.exit(denied ? 1 : 0);
}
if (argv[0] === 'exec' && argv.includes('-o')) {
  // One answer without tools (`codex exec … -o <file> <prompt>`), e.g. a TeamBot summary for "Gesprek samenvatten".
  const file = argv[argv.indexOf('-o') + 1];
  log({ mode: 'complete', argv });
  fs.writeFileSync(file, String(argv.at(-1)).includes('Nieuw gespreksdeel om op te nemen') ? '## Besluiten\n- SAMENVATTING-VAN-FAKE-CODEX' : 'ok');
  process.exit(0);
} else if (argv[0] === 'exec') {
  let prompt = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (prompt += d));
  process.stdin.on('end', () => {
    const ri = argv.indexOf('resume');
    const resume = ri >= 0 ? argv[argv.length - 2] : undefined;
    log({ argv, prompt, cwd: process.cwd() });
    const id = resume || '019a0000-0000-7000-8000-000000000001';
    out({ type: 'thread.started', thread_id: id });
    out({ type: 'turn.started' });
    out({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'ls', status: 'in_progress' } });
    out({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'ls', aggregated_output: 'a.txt', exit_code: 0, status: 'completed' } });
    out({ type: 'item.completed', item: { id: 'i2', type: 'reasoning', text: 'denken' } });
    out({ type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'Hallo van Codex' } });
    out({ type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 8 } });
  });
} else if (argv[0] === 'app-server') {
  // The arguments TeamBot started the app-server with (its permission profile), for tests/permission-gate.test.ts.
  if (process.env.FAKE_CODEX_LOG_START) log({ mode: 'app-server', argv });
  const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  let nextId = 500;
  let activeTurn = null;
  let steerWaiter = null;
  const waiting = new Map();
  const call = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      send({ id, method, params });
    });
  readline.createInterface({ input: process.stdin }).on('line', async (line) => {
    const m = JSON.parse(line);
    if (m.id !== undefined && !m.method) return waiting.get(m.id)?.(m);
    log({ method: m.method, params: m.params, hasJsonrpc: 'jsonrpc' in m });
    const p = m.params || {};
    if (m.method === 'initialize') return send({ id: m.id, result: { userAgent: 'fake', codexHome: '/x', platformFamily: 'windows', platformOs: 'windows' } });
    if (m.method === 'initialized') return;
    if (m.method === 'account/read') return send({ id: m.id, result: { account: { type: 'chatgpt', email: 'geheim@example.com', planType: 'plus' }, requiresOpenaiAuth: true } });
    if (m.method === 'account/rateLimits/read') {
      const now = Math.floor(Date.now() / 1000);
      const snap = { limitId: 'codex', primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: now + 3600 }, secondary: { usedPercent: 97, windowDurationMins: 10080, resetsAt: now + 4 * 86400 }, credits: null, planType: 'plus', rateLimitReachedType: null };
      return send({ id: m.id, result: { ordinaryUsageAllowed: true, rateLimits: snap, rateLimitsByLimitId: { codex: snap }, rateLimitResetCredits: null, accountId: 'acc-geheim', rateLimitUpsell: null } });
    }
    // FAKE_CODEX_MODELS (comma-separated): the models this login has (`model/list`); unset: an older Codex without it.
    if (m.method === 'model/list' && process.env.FAKE_CODEX_MODELS)
      return send({ id: m.id, result: { data: process.env.FAKE_CODEX_MODELS.split(',').map((id, i) => ({ id, model: id, displayName: id, isDefault: i === 0, supportedReasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium', inputModalities: ['text'] })) } });
    if (m.method === 'thread/start') return send({ id: m.id, result: { thread: { id: 'th-new' }, model: 'gpt-fake' } });
    if (m.method === 'thread/resume') return send({ id: m.id, result: { thread: { id: p.threadId }, model: 'gpt-fake' } });
    if (m.method === 'turn/interrupt') return send({ id: m.id, result: {} });
    if (m.method === 'thread/compact/start') {
      // Codex's own compaction: runs as a turn with a contextCompaction item (FAKE_CODEX_NO_COMPACT: an older Codex).
      if (process.env.FAKE_CODEX_NO_COMPACT) return send({ id: m.id, error: { code: -32601, message: 'unknown method thread/compact/start' } });
      const threadId = p.threadId;
      send({ id: m.id, result: {} });
      send({ method: 'turn/started', params: { threadId, turn: { id: 'turn-c' } } });
      send({ method: 'item/started', params: { threadId, turnId: 'turn-c', item: { id: 'cc1', type: 'contextCompaction' } } });
      send({ method: 'thread/tokenUsage/updated', params: { threadId, turnId: 'turn-c', tokenUsage: { total: { inputTokens: 0, outputTokens: 0 }, last: { totalTokens: 4000, inputTokens: 4000, outputTokens: 0 }, modelContextWindow: 258400 } } });
      send({ method: 'item/completed', params: { threadId, turnId: 'turn-c', item: { id: 'cc1', type: 'contextCompaction' } } });
      send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-c', status: 'completed', error: null } } });
      return;
    }
    if (m.method === 'turn/steer') {
      // Accepted only while that turn runs, like Codex ("expectedTurnId" must be the active turn).
      if (activeTurn && p.expectedTurnId === activeTurn) {
        send({ id: m.id, result: { turnId: activeTurn } });
        steerWaiter?.(String(p.input?.[0]?.text || ''));
      } else send({ id: m.id, error: { code: -32600, message: 'no active turn to steer' } });
      return;
    }
    const inputText = String(p.input?.[0]?.text || '');
    // Like Codex on Windows in "Vraagt toestemming" (B-46): it writes with PowerShell Set-Content without asking for
    // approval, and the read-only sandbox refuses it. FAKE_CODEX_FAST_END: the turn ends before TeamBot can steer it.
    if (m.method === 'turn/start' && /SCENARIO:setcontent/.test(inputText)) {
      const threadId = p.threadId;
      const target = path.join(process.cwd(), 'notities.txt');
      activeTurn = 'turn-s';
      send({ id: m.id, result: { turn: { id: 'turn-s', status: 'inProgress', items: [] } } });
      send({ method: 'turn/started', params: { threadId, turn: { id: 'turn-s' } } });
      const command = '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "Set-Content -Path notities.txt -Value hallo"';
      send({ method: 'item/started', params: { threadId, turnId: 'turn-s', item: { id: 'ce1', type: 'commandExecution', command, status: 'inProgress' } } });
      const steered = new Promise((r) => (steerWaiter = r));
      send({ method: 'item/completed', params: { threadId, turnId: 'turn-s', item: { id: 'ce1', type: 'commandExecution', command, status: 'failed', exitCode: 1, aggregatedOutput: `Set-Content: Access to the path '${target}' is denied.\r\n` } } });
      const finish = (t) => {
        send({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn-s', itemId: 'am-s', delta: t } });
        activeTurn = null;
        send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-s', status: 'completed', error: null } } });
      };
      if (process.env.FAKE_CODEX_FAST_END) return finish('Het schrijven werd geweigerd.');
      const note = await Promise.race([steered, new Promise((r) => setTimeout(() => r(''), 3000))]);
      log({ steered: note });
      if (!note) return finish('Het schrijven werd geweigerd.');
      send({ method: 'item/started', params: { threadId, turnId: 'turn-s', item: { id: 'fc-s', type: 'fileChange', changes: [{ path: target, kind: { type: 'add' }, diff: '' }], status: 'inProgress' } } });
      const r = await call('item/fileChange/requestApproval', { threadId, turnId: 'turn-s', itemId: 'fc-s', startedAtMs: Date.now() });
      if (r.result?.decision === 'accept') fs.writeFileSync(target, 'hallo');
      send({ method: 'item/completed', params: { threadId, turnId: 'turn-s', item: { id: 'fc-s', type: 'fileChange', changes: [{ path: target, kind: { type: 'add' } }], status: r.result?.decision === 'accept' ? 'completed' : 'declined' } } });
      return finish('Geschreven met apply_patch.');
    }
    // SCENARIO:stappen STAPPEN:<base64url JSON>: asks approval for every step and does none of them (the case table of
    // tests/permission-gate.test.ts). A step is { command, cwd? }, { changes: [{ path, kind }] }, { permissions } or
    // { elicitation: { serverName, mode } } (Codex's own question before it uses a tool of an MCP server).
    if (m.method === 'turn/start' && /SCENARIO:stappen/.test(inputText)) {
      const steps = JSON.parse(Buffer.from(/STAPPEN:([\w-]+)/.exec(inputText)[1], 'base64url').toString('utf8'));
      const threadId = p.threadId;
      const turnId = 'turn-st';
      send({ id: m.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
      send({ method: 'turn/started', params: { threadId, turn: { id: turnId } } });
      const got = [];
      for (const [i, st] of steps.entries()) {
        const itemId = `st${i}`;
        let r;
        if (st.changes) {
          send({ method: 'item/started', params: { threadId, turnId, item: { id: itemId, type: 'fileChange', changes: st.changes, status: 'inProgress' } } });
          r = await call('item/fileChange/requestApproval', { threadId, turnId, itemId, startedAtMs: Date.now() });
        } else if (st.permissions) r = await call('item/permissions/requestApproval', { threadId, turnId, itemId, permissions: st.permissions });
        else if (st.elicitation) r = await call('mcpServer/elicitation/request', { threadId, turnId, ...st.elicitation });
        else r = await call('item/commandExecution/requestApproval', { threadId, turnId, itemId, command: st.command, cwd: st.cwd });
        got.push(r.result?.decision || (r.result?.action === 'accept' || (r.result?.permissions && Object.keys(r.result.permissions).length) ? 'accept' : 'decline'));
      }
      log({ stappen: got });
      send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'am-st', delta: 'Stappen gevraagd.' } });
      send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', error: null } } });
      return;
    }
    if (m.method === 'turn/start') {
      const threadId = p.threadId;
      if (/^TeamBot: je terminalopdracht/.test(inputText)) log({ followUp: inputText });
      send({ id: m.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } });
      send({ method: 'turn/started', params: { threadId, turn: { id: 'turn-1' } } });
      const target = path.join(process.cwd(), 'codex.txt');
      send({ method: 'item/started', params: { threadId, turnId: 'turn-1', item: { id: 'fc1', type: 'fileChange', changes: [{ path: target, kind: { type: 'add' }, diff: '' }], status: 'inProgress' } } });
      const r = await call('item/fileChange/requestApproval', { threadId, turnId: 'turn-1', itemId: 'fc1', startedAtMs: Date.now() });
      log({ approval: r.result });
      if (r.result?.decision === 'accept') fs.writeFileSync(target, 'via codex');
      send({ method: 'item/completed', params: { threadId, turnId: 'turn-1', item: { id: 'fc1', type: 'fileChange', changes: [{ path: target, kind: { type: 'add' } }], status: r.result?.decision === 'accept' ? 'completed' : 'declined' } } });
      for (const d of ['Klaar ', r.result?.decision === 'accept' ? 'met schrijven' : 'zonder schrijven']) send({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn-1', itemId: 'am1', delta: d } });
      send({ method: 'thread/tokenUsage/updated', params: { threadId, turnId: 'turn-1', tokenUsage: { total: { inputTokens: 30, cachedInputTokens: 0, outputTokens: 9, reasoningOutputTokens: 1 }, last: { totalTokens: 25000, inputTokens: 24000, cachedInputTokens: 0, outputTokens: 1000, reasoningOutputTokens: 0 }, modelContextWindow: 258400 } } });
      send({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', primary: { usedPercent: 43, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3500 }, secondary: null, planType: 'plus' } } });
      send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', status: 'completed', error: null } } });
      return;
    }
    if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: 'unknown' } });
  });
} else {
  process.exit(2);
}
