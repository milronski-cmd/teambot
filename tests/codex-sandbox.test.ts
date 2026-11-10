import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestApp, type TestApp } from './helpers.js';
import { codexKeyPaths, codexProfileArgs, codexReadText, probeCodexReadGuard, resetCodexReadGuard, type CodexReadGuard, type SandboxRunner } from '../server/modules/cli-agents/codex-sandbox.js';
import { codexExecArgs } from '../server/modules/cli-agents/codex.js';
import { commandPaths, gate } from '../server/modules/cli-agents/permissions.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CODEX = path.join(here, 'fixtures', 'cli-agents-fake-codex.mjs');
const win = process.platform === 'win32';
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const flag = (a: string[], f: string) => (a.includes(f) ? a[a.indexOf(f) + 1] : undefined);
const MXC: CodexReadGuard = { level: 'confined', backend: 'mxc', detail: '' };
const ELEVATED: CodexReadGuard = { level: 'keyfolders', backend: 'elevated', detail: '' };

// ---------------------------------------------------------------- profile arguments

test('codex profile: confined reads only the bot folders + :minimal, writes and network only when allowed, no --sandbox', () => {
  const extra = win ? 'D:\\Gedeeld' : '/srv/gedeeld';
  const ro = win ? 'D:\\Alleen lezen' : '/srv/alleen lezen';
  const full = codexProfileArgs({ guard: MXC, write: true, network: true, roots: [{ path: extra, mode: 'rw' }, { path: ro, mode: 'ro' }], platform: 'win32' })!;
  assert.deepEqual(full.slice(0, 2), ['-c', 'windows.sandbox="mxc"']);
  assert.equal(full.at(-1), 'default_permissions="teambot"');
  const prof = full.find((a) => a.startsWith('permissions.teambot='))!;
  assert.match(prof, /":minimal"="read"/);
  assert.doesNotMatch(prof, /":root"/, 'confined never reads the whole disk');
  assert.match(prof, /":workspace_roots"=\{"\."="write"\}/);
  assert.doesNotMatch(prof, /tmpdir/, "MXC gives each process its own temp folder: the owner's %TEMP% stays closed");
  assert.match(codexProfileArgs({ guard: { level: 'confined', backend: 'platform', detail: '' }, write: true, network: false, roots: [], platform: 'linux' })!.join(' '), /":tmpdir"="write".*":slash_tmp"="write"/);
  assert.ok(prof.includes(`${JSON.stringify(extra)}="write"`));
  assert.ok(prof.includes(`${JSON.stringify(ro)}="read"`), 'a read-only folder stays read-only');
  assert.match(prof, /network=\{enabled=true\}/);

  const readonly = codexProfileArgs({ guard: MXC, write: false, network: false, roots: [{ path: extra, mode: 'rw' }], platform: 'win32' })!.join(' ');
  assert.match(readonly, /":workspace_roots"=\{"\."="read"\}/);
  assert.ok(readonly.includes(`${JSON.stringify(extra)}="read"`), 'nothing is writable in a read-only run');
  assert.doesNotMatch(readonly, /tmpdir|network|"write"/);

  const keys = codexProfileArgs({ guard: ELEVATED, write: true, network: false, roots: [], deny: [win ? 'C:\\Users\\x\\.ssh' : '/home/x/.ssh'], platform: 'win32' })!.join(' ');
  assert.match(keys, /":root"="read"/);
  assert.match(keys, /\.ssh"="deny"/);
  assert.doesNotMatch(keys, /windows\.sandbox/, 'the owner\'s own Windows sandbox (elevated) is used as is');
  assert.equal(codexProfileArgs({ guard: { level: 'open', backend: null, detail: '' }, write: true, network: true, roots: [] }), null);

  const ex = codexExecArgs({ sandbox: 'workspace-write', cwd: 'C:/w', addDirs: ['C:/x'], images: [], extra: [], network: true, profile: full });
  assert.equal(flag(ex, '-s'), undefined, '--sandbox would switch Codex back to the legacy (write-only) settings');
  assert.ok(!ex.includes('--add-dir') && !ex.some((a) => a.includes('sandbox_workspace_write')), 'folders and network come from the profile');
  assert.ok(ex.includes('default_permissions="teambot"') && ex.includes('approval_policy="never"'));
  const legacy = codexExecArgs({ sandbox: 'workspace-write', cwd: 'C:/w', addDirs: ['C:/x'], images: [], extra: [], network: true, profile: null });
  assert.equal(flag(legacy, '-s'), 'workspace-write');
  assert.equal(flag(legacy, '--add-dir'), 'C:/x');
});

test('codex key paths: only existing key folders and TeamBot data, never a folder of the bot', () => {
  const home = tmp('tb-home-');
  const data = tmp('tb-data-');
  try {
    fs.mkdirSync(path.join(home, '.ssh'));
    fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'x');
    fs.mkdirSync(path.join(home, '.config', 'gh'), { recursive: true });
    fs.writeFileSync(path.join(data, 'master.key'), 'k');
    fs.writeFileSync(path.join(data, 'teambot.db'), 'd');
    fs.mkdirSync(path.join(data, 'backups'));
    const ws = path.join(data, 'workspaces', 'ag_1');
    fs.mkdirSync(ws, { recursive: true });
    const keys = codexKeyPaths({ home, dataDir: data, keep: [ws], env: { APPDATA: path.join(home, 'r'), LOCALAPPDATA: path.join(home, 'l') }, codexHome: path.join(home, '.codex') });
    const has = (p: string) => keys.some((k) => path.resolve(k) === path.resolve(p));
    assert.ok(has(path.join(home, '.ssh')) && has(path.join(home, '.config', 'gh')));
    assert.ok(has(path.join(data, 'master.key')) && has(path.join(data, 'teambot.db')) && has(path.join(data, 'backups')));
    assert.ok(!has(path.join(home, '.gnupg')), 'a missing path is never listed (Codex would create it as a folder)');
    assert.ok(!keys.some((k) => ws.toLowerCase().startsWith(path.resolve(k).toLowerCase())), "never the bot's folder or a folder around it");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the check on this computer

test('codex read check: a level counts only when the canary outside the folder stayed unreadable', async () => {
  const data = tmp('tb-probe-');
  const codexHome = tmp('tb-codexhome-');
  try {
    const calls: string[][] = [];
    // A sandbox that leaks everything except with an MXC profile.
    const mxcRun: SandboxRunner = async (_bin, args, cwd) => {
      calls.push(args);
      const inside = fs.readFileSync(path.join(cwd, 'binnen.txt'), 'utf8');
      const canary = String(args.at(-1)).match(/["']([^"']+kanarie\.txt)["']/)![1];
      const confined = args.includes('windows.sandbox="mxc"') && args.some((a) => a.includes('":minimal"'));
      return { code: 0, stdout: inside + (confined ? '' : fs.readFileSync(canary, 'utf8')), stderr: confined ? 'Toegang geweigerd.' : '' };
    };
    const g = await probeCodexReadGuard('codex', data, { platform: 'win32', run: mxcRun, codexHome });
    assert.equal(g.level, 'confined');
    assert.equal(g.backend, 'mxc');
    assert.equal(calls[0][0], 'sandbox');
    assert.ok(calls[0].includes('-P'), 'uses a named permission profile');
    assert.ok(!fs.readdirSync(path.join(data, 'cli-agents', 'sandbox-probe')).length, 'the probe folder is removed');
    assert.match(codexReadText(g), /alleen in de mappen van deze bot/);

    // Elevated Windows sandbox: only deny entries hold (MXC refuses), and only when the owner set it up.
    const elevatedRun: SandboxRunner = async (_bin, args, cwd) => {
      if (args.some((a) => a.includes('":minimal"'))) return { code: 1, stdout: '', stderr: 'elevated Windows sandbox requires effective `:root` read access' };
      const inside = fs.readFileSync(path.join(cwd, 'binnen.txt'), 'utf8');
      const canary = String(args.at(-1)).match(/["']([^"']+kanarie\.txt)["']/)![1];
      const denied = args.some((a) => a.includes(JSON.stringify(path.dirname(canary)) + '="deny"'));
      return { code: 0, stdout: inside + (denied ? '' : fs.readFileSync(canary, 'utf8')), stderr: '' };
    };
    assert.equal((await probeCodexReadGuard('codex', data, { platform: 'win32', run: elevatedRun, codexHome })).level, 'open', 'no elevated setup → not probed (would start Codex\'s admin setup)');
    fs.mkdirSync(path.join(codexHome, '.sandbox'));
    fs.writeFileSync(path.join(codexHome, '.sandbox', 'setup_marker.json'), '{}');
    const k = await probeCodexReadGuard('codex', data, { platform: 'win32', run: elevatedRun, codexHome });
    assert.equal(k.level, 'keyfolders');
    assert.match(codexReadText(k), /ook buiten de werkmap lezen/);

    // A sandbox that lets the canary through, an old Codex without `sandbox`, a crash: legacy flags, honest text.
    const leak: SandboxRunner = async (_b, args, cwd) => ({ code: 0, stdout: fs.readFileSync(path.join(cwd, 'binnen.txt'), 'utf8') + fs.readFileSync(String(args.at(-1)).match(/["']([^"']+kanarie\.txt)["']/)![1], 'utf8'), stderr: '' });
    assert.equal((await probeCodexReadGuard('codex', data, { platform: 'win32', run: leak, codexHome })).level, 'open');
    assert.equal((await probeCodexReadGuard('codex', data, { platform: 'win32', run: async () => ({ code: 2, stdout: '', stderr: "error: unrecognized subcommand 'sandbox'" }), codexHome })).level, 'open');
    const crash = await probeCodexReadGuard('codex', data, { platform: 'win32', run: async () => Promise.reject(new Error('boom')), codexHome });
    assert.equal(crash.level, 'open');
    assert.match(codexReadText(crash), /alles lezen wat jij kunt lezen/);
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- commands that reach outside the bot's folders

test('command paths: outside the bot folders asks, key folders and TeamBot data are refused', () => {
  const ws = win ? 'C:\\tb\\data\\workspaces\\ag_1' : '/tb/data/workspaces/ag_1';
  const home = win ? 'C:\\Users\\eigenaar' : '/home/eigenaar';
  const o = { roots: [ws], dataDir: win ? 'C:\\tb\\data' : '/tb/data', home };
  const c = (cmd: string) => commandPaths(cmd, o);
  assert.deepEqual(c('npm test && git status').outside, []);
  assert.deepEqual(c(`type ${path.join(ws, 'notities.txt')}`).outside, [], 'inside the workspace');
  assert.deepEqual(c('type ..\\..\\..\\master.key').keys.length, 1, '.. escapes out of the workspace into TeamBot data');
  assert.equal(c('cat ~/.ssh/id_ed25519').keys.length, 1);
  assert.equal(c('Get-Content "$env:USERPROFILE\\.ssh\\id_rsa"').keys.length, 1, 'PowerShell home variable');
  assert.equal(c('"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-Content -LiteralPath \'C:\\Users\\eigenaar\\Documents\\geheim.txt\'"').outside.length, win ? 1 : 0, 'a path inside -Command "…"');
  if (win) {
    assert.deepEqual(c('type C:\\Windows\\win.ini').outside, [], 'system folders are readable for every program');
    assert.equal(c('type C:\\Users\\eigenaar\\Documents\\geheim.txt').outside.length, 1);
    assert.equal(c('type C:\\Users\\eigenaar\\Documents\\geheim.txt').keys.length, 0);
    assert.equal(c('type "C:\\Users\\eigenaar\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Login Data"').keys.length, 1);
    assert.equal(c('copy x.txt --out=D:\\elders\\x.txt').outside.length, 1);
  }
  assert.deepEqual(c('curl https://example.com/a/b').outside, [], 'a URL is not a path');
});

test('gate: in "Volledige toegang" a command outside the folders goes to a human, a key folder is refused', async () => {
  const ws = tmp('tb-gate-');
  const calls: string[] = [];
  const ctx: any = {
    config: { dataDir: path.join(ws, 'data') },
    audit() {},
    broker: {
      decide: () => 'allow',
      request: async (o: any) => {
        calls.push(o.summary);
        return { approved: false };
      },
    },
  };
  const agent: any = { id: 'a1', name: 'Bot', access_mode: 'full', workspace: path.join(ws, 'w'), settings: {} };
  const scope: any = { ctx, agent, thread: null, run: null, userId: 'u', signal: new AbortController().signal, ns: 'claude-code' };
  try {
    const inside = await gate(scope, { tool: 'Bash', risk: 'exec', summary: 'Opdracht: npm test', input: {}, command: 'npm test' });
    assert.equal(inside.allow, true);
    assert.equal(calls.length, 0, 'normal work in the folder does not ask');
    const outsidePath = win ? 'D:\\elders\\plan.txt' : '/home/iemand/plan.txt';
    const out = await gate(scope, { tool: 'Bash', risk: 'exec', summary: `Opdracht: cat ${outsidePath}`, input: {}, command: `cat ${outsidePath}` });
    assert.equal(out.allow, false);
    assert.equal(calls.length, 1, 'asked a human');
    assert.match(calls[0], /buiten de mappen van de bot/);
    const key = await gate(scope, { tool: 'Bash', risk: 'exec', summary: 'Opdracht: cat ~/.ssh/id_rsa', input: {}, command: 'cat ~/.ssh/id_rsa' });
    assert.equal(key.allow, false);
    assert.equal(calls.length, 1, 'a key folder is refused without asking');
    assert.match(key.message, /beschermde map/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- end to end with a fake Codex

function useLog(t: TestApp) {
  const file = path.join(t.dir, 'fake-cli.log');
  process.env.FAKE_CLI_LOG = file;
  return () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
}

test('codex bot: where the sandbox can confine reads, every mode runs with TeamBot\'s profile (exec and app-server)', async () => {
  const t = await startTestApp();
  const logs = useLog(t);
  process.env.CODEX_HOME = t.dir;
  process.env.FAKE_CODEX_SANDBOX = 'mxc';
  resetCodexReadGuard();
  try {
    const p = await t.api('POST', '/providers', { kind: 'codex-cli', config: { path: FAKE_CODEX } });
    const a = await t.api('POST', '/agents', { name: 'CodexBot', provider_id: p.id, model: '', access_mode: 'full' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    const access = await t.api('GET', `/cli-agents/read-access/${p.id}`);
    assert.equal(access.level, 'confined');
    assert.match(access.text, /alleen in de mappen van deze bot/);

    await t.say(th.id, 'werk');
    let run = logs().filter((l) => l.argv?.[0] === 'exec').at(-1)!;
    assert.equal(flag(run.argv, '-s'), undefined);
    const prof = run.argv.find((x: string) => x.startsWith('permissions.teambot='));
    assert.match(prof, /":minimal"="read"/);
    assert.match(prof, /":workspace_roots"=\{"\."="write"\}/);
    assert.match(prof, /network=\{enabled=true\}/, '"Volledige toegang" has network');
    assert.ok(run.argv.includes('default_permissions="teambot"'));
    if (win) assert.ok(run.argv.includes('windows.sandbox="mxc"'));

    await t.api('PATCH', `/agents/${a.id}`, { access_mode: 'readonly' });
    await t.say(th.id, 'lees');
    run = logs().filter((l) => l.argv?.[0] === 'exec').at(-1)!;
    assert.match(run.argv.find((x: string) => x.startsWith('permissions.teambot=')), /":workspace_roots"=\{"\."="read"\}/);

    await t.api('PATCH', `/agents/${a.id}`, { access_mode: 'ask' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'met goedkeuring' });
    const ap = await (async () => {
      for (let i = 0; i < 400; i++) {
        const x = (await t.api('GET', '/approvals')).find((y: any) => y.status === 'pending');
        if (x) return x;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('geen goedkeuring');
    })();
    await t.api('POST', `/approvals/${ap.id}`, { decision: 'deny' });
    await t.waitIdle(th.id);
    const L = logs();
    const resume = L.find((l) => l.method === 'thread/resume');
    assert.equal(resume.params.sandbox, undefined, 'no legacy sandbox on the thread: the profile from the command line applies');
    assert.equal(resume.params.approvalPolicy, 'on-request');
    const probes = L.filter((l) => l.mode === 'sandbox');
    assert.equal(probes.length, 1, 'checked once per Codex binary');
  } finally {
    delete process.env.CODEX_HOME;
    delete process.env.FAKE_CODEX_SANDBOX;
    resetCodexReadGuard();
    await t.close();
  }
});
