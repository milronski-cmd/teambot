import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestApp, type TestApp } from './helpers.js';
import { codexKeyPaths, codexProfileArgs, codexReadText, probeCodexReadGuard, resetCodexReadGuard, type CodexReadGuard, type SandboxRunner } from '../server/modules/cli-agents/codex-sandbox.js';
import { codexExecArgs } from '../server/modules/cli-agents/codex.js';
import { gate, hardBlocks } from '../server/modules/cli-agents/permissions.js';
import { isInside, KEY_PATH, keyPlaces } from '../server/tools/builtin/files.js';
import { commandPaths } from '../server/tools/builtin/command-risk.js';

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

  // Confined: what lies outside the bot's folders is unreadable anyway; a closed folder inside its folder is denied.
  const ws = win ? 'C:\\tb\\data\\workspaces\\ag_1' : '/tb/data/workspaces/ag_1';
  const inWs = path.join(ws, 'dicht');
  const ssh = win ? 'C:\\Users\\x\\.ssh' : '/home/x/.ssh';
  const conf = codexProfileArgs({ guard: MXC, write: true, network: false, workspace: ws, roots: [], deny: [ssh, inWs], platform: 'win32' })!.join(' ');
  assert.ok(conf.includes(`${JSON.stringify(inWs)}="deny"`) && !conf.includes(`${JSON.stringify(ssh)}="deny"`), conf);

  // "Volledige toegang" on the whole computer: the whole disk writable with every deny entry, only where that held.
  const deny = [ssh, win ? 'C:\\tb\\data\\teambot.db' : '/tb/data/teambot.db', win ? 'D:\\Bank' : '/srv/bank'];
  assert.equal(codexProfileArgs({ guard: MXC, write: true, network: true, root: true, workspace: ws, roots: [], deny, platform: 'win32' }), null, 'not checked to hold: no profile');
  const whole = codexProfileArgs({ guard: { ...MXC, root: true }, write: true, network: true, root: true, workspace: ws, roots: [{ path: ro, mode: 'ro' }], deny, platform: 'win32' })!.join(' ');
  assert.match(whole, /":root"="write"/);
  assert.doesNotMatch(whole, /":minimal"/);
  for (const d of deny) assert.ok(whole.includes(`${JSON.stringify(d)}="deny"`), d);
  assert.ok(whole.includes(`${JSON.stringify(ro)}="read"`), 'a read-only folder of the bot stays read-only');

  const ex = codexExecArgs({ sandbox: 'workspace-write', cwd: 'C:/w', addDirs: ['C:/x'], images: [], extra: [], network: true, profile: full });
  assert.equal(flag(ex, '-s'), undefined, '--sandbox would switch Codex back to the legacy (write-only) settings');
  assert.ok(!ex.includes('--add-dir') && !ex.some((a) => a.includes('sandbox_workspace_write')), 'folders and network come from the profile');
  assert.ok(ex.includes('default_permissions="teambot"') && ex.includes('approval_policy="never"'));
  const legacy = codexExecArgs({ sandbox: 'workspace-write', cwd: 'C:/w', addDirs: ['C:/x'], images: [], extra: [], network: true, profile: null });
  assert.equal(flag(legacy, '-s'), 'workspace-write');
  assert.equal(flag(legacy, '--add-dir'), 'C:/x');
});

test('codex deny list: the gate\'s own list (key places, TeamBot data, closed folders), never a folder of the bot', () => {
  const home = tmp('tb-home-');
  const data = tmp('tb-data-');
  const closed = tmp('tb-dicht-');
  try {
    // Every place a key can be, made on disk.
    const places = ['.ssh/id_ed25519', '.gnupg/x', '.aws/credentials', '.azure/x', '.kube/config', '.password-store/x', '.terraform.d/credentials.tfrc.json', '.vault-token', '.git-credentials', '.netrc', '_netrc', '.pgpass', '.docker/config.json', '.config/gh/hosts.yml', '.config/gcloud/x', '.claude/.credentials.json', '.local/share/opencode/auth.json', '.codex/auth.json'];
    const winPlaces = ['AppData/Roaming/Microsoft/Credentials/x', 'AppData/Roaming/Microsoft/Protect/x', 'AppData/Local/Microsoft/Credentials/x', 'AppData/Roaming/Bitwarden/data.json', 'AppData/Local/1Password/x', 'AppData/Local/Google/Chrome/User Data/Local State', 'AppData/Local/Google/Chrome/User Data/Default/Login Data', 'AppData/Local/Google/Chrome/User Data/Default/Login Data For Account', 'AppData/Local/Google/Chrome/User Data/Default/Network/Cookies', 'AppData/Local/Google/Chrome/User Data/Profile 1/Web Data', 'AppData/Roaming/Mozilla/Firefox/Profiles/abc.default/logins.json', 'AppData/Roaming/Mozilla/Firefox/Profiles/abc.default/signons.sqlite'];
    for (const p of [...places, ...winPlaces]) {
      fs.mkdirSync(path.dirname(path.join(home, ...p.split('/'))), { recursive: true });
      fs.writeFileSync(path.join(home, ...p.split('/')), 'x');
    }
    const env = { APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') };
    const found = keyPlaces({ home, env, platform: 'win32', codexHome: path.join(home, '.codex') });
    // One source: every place the sandbox shuts is a key file for the gate too.
    for (const p of found) assert.ok(KEY_PATH.test(p), `${p}: KEY_PATH`);
    const under = (p: string) => found.some((k) => isInside(path.join(home, ...p.split('/')), k));
    for (const p of [...places, ...winPlaces]) assert.ok(under(p), `${p}: a place of the deny list`);
    // TeamBot's data around the bot's workspace, another bot's workspace and the owner's closed folder.
    fs.writeFileSync(path.join(data, 'master.key'), 'k');
    fs.writeFileSync(path.join(data, 'teambot.db'), 'd');
    fs.mkdirSync(path.join(data, 'backups'));
    const ws = path.join(data, 'workspaces', 'ag_1');
    const other = path.join(data, 'workspaces', 'ag_2');
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    fs.mkdirSync(path.join(ws, 'eigen-dicht'));
    const keys = codexKeyPaths({ home, shut: [data, closed, path.join(ws, 'eigen-dicht'), path.join(home, 'bestaat-niet')], keep: [ws], env, platform: 'win32', codexHome: path.join(home, '.codex') });
    const has = (p: string) => keys.some((k) => path.resolve(k).toLowerCase() === path.resolve(p).toLowerCase());
    assert.ok(has(path.join(home, '.ssh')) && has(path.join(home, '.config', 'gh')));
    assert.ok(has(path.join(data, 'master.key')) && has(path.join(data, 'teambot.db')) && has(path.join(data, 'backups')));
    assert.ok(has(other), "another bot's workspace is TeamBot's data too");
    assert.ok(has(closed), 'a folder the owner closed');
    assert.ok(has(path.join(ws, 'eigen-dicht')), "a closed folder inside the bot's own folder stays shut, as in the gate");
    assert.ok(!has(path.join(home, 'bestaat-niet')), 'a missing path is never listed (Codex would create it as a folder)');
    assert.ok(!keys.some((k) => isInside(ws, k)), "never the bot's folder or a folder around it");
  } finally {
    for (const d of [home, data, closed]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('the hard blocks per kind of AI and level: guarded by TeamBot, or said plainly what is not', () => {
  const lv = ['chat', 'readonly', 'ask', 'auto', 'full'];
  const g = (o: any) => lv.map((level) => (hardBlocks({ ...o, level, whole: true }).guarded ? 'B' : 'N')).join('');
  assert.equal(g({ engine: 'api' }), 'BBBBB', 'a model over an API key: every step passes the gate');
  assert.equal(g({ engine: 'claude' }), 'BBBBB');
  assert.equal(g({ engine: 'acp', cli: 'opencode', label: 'OpenCode' }), 'BBBBB', 'OpenCode asks for every edit, command, page and outside path');
  assert.equal(g({ engine: 'acp', cli: 'gemini-cli', label: 'Gemini CLI' }), 'BNNNN', 'another ACP engine reads without asking');
  assert.equal(g({ engine: 'codex', codex: MXC }), 'BBBBN', 'the whole computer only where :root write with deny held');
  assert.equal(g({ engine: 'codex', codex: { ...MXC, root: true } }), 'BBBBB');
  assert.equal(g({ engine: 'codex', codex: { ...ELEVATED, root: true } }), 'BBBBB');
  assert.equal(g({ engine: 'codex', codex: { level: 'open', backend: null, detail: '' } }), 'BNNNN');
  assert.equal(g({ engine: 'codex', codex: null }), 'BNNNN', 'Codex not found or not checked: not guarded');
  assert.equal(hardBlocks({ engine: 'codex', codex: MXC, level: 'full', whole: false }).guarded, true, '"alleen eigen mappen": the profile of the bot\'s folders');
  const t = (o: any) => hardBlocks(o).text;
  assert.match(t({ engine: 'api', level: 'full' }), /^Bewaakt door TeamBot: sleutelbestanden \(zoals ~\/\.ssh\), de mappen die je dicht zette en de gegevens van TeamBot blijven dicht/);
  assert.match(t({ engine: 'codex', codex: MXC, level: 'full', whole: true }), /^Niet bewaakt door TeamBot: met Volledige toegang draait Codex hier zonder sandbox .*sleutelbestanden.*dicht zette.*gegevens van TeamBot.*; alleen de instructies van de bot verbieden het\.$/);
  assert.match(t({ engine: 'acp', cli: 'gemini-cli', label: 'Gemini CLI', level: 'auto' }), /^Niet bewaakt door TeamBot: Gemini CLI kan in deze stand/);
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
    assert.equal(g.root, false, 'the whole disk writable with deny entries was not shown to hold');
    // "Volledige toegang": the file outside is written, the denied folder neither read nor written.
    const rootRun = (alsoDenied: boolean): SandboxRunner => async (bin, args, cwd) => {
      if (!args.some((a) => a.includes('":root"="write"'))) return mxcRun(bin, args, cwd);
      const cmd = String(args.at(-1));
      fs.writeFileSync(cmd.match(/["']([^"']+geschreven\.txt)["']/)![1], cmd.match(/TB-SCHRIJF-[0-9a-f]+/)![0]);
      if (alsoDenied) fs.writeFileSync(cmd.match(/["']([^"']+poging\.txt)["']/)![1], 'x');
      return { code: 1, stdout: fs.readFileSync(path.join(cwd, 'binnen.txt'), 'utf8'), stderr: 'Toegang geweigerd.' };
    };
    const held = await probeCodexReadGuard('codex', data, { platform: 'win32', run: rootRun(false), codexHome });
    assert.deepEqual([held.level, held.root], ['confined', true]);
    assert.ok(calls.some((a) => a.some((x) => x.includes('":root"="write"')) && a.some((x) => x.includes('"="deny"'))), 'checked with a deny entry');
    assert.equal((await probeCodexReadGuard('codex', data, { platform: 'win32', run: rootRun(true), codexHome })).root, false, 'a denied folder that can be written does not hold');

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

    // "Volledige toegang" on the owner's own computer = the whole computer. Where the whole disk writable with deny
    // entries was not shown to hold: no sandbox and no profile (or Codex, approvals "never", fails silently on
    // everything outside the bot's folders), the instructions carry the blocks, and the bot's page says so.
    const blocks = await t.api('GET', `/cli-agents/hard-blocks/${p.id}?agentId=${a.id}`);
    assert.deepEqual(Object.fromEntries(Object.entries(blocks.levels).map(([k, v]: any) => [k, v.guarded])), { chat: true, readonly: true, ask: true, auto: true, full: false });
    assert.match(blocks.levels.full.text, /^Niet bewaakt door TeamBot: met Volledige toegang draait Codex hier zonder sandbox/);
    assert.match(blocks.levels.auto.text, /^Bewaakt door TeamBot/);
    await t.say(th.id, 'werk');
    let run = logs().filter((l) => l.argv?.[0] === 'exec').at(-1)!;
    assert.equal(flag(run.argv, '-s'), 'danger-full-access');
    assert.equal(run.argv.find((x: string) => x.startsWith('permissions.teambot=')), undefined, 'no profile that confines the bot');
    assert.ok(run.argv.includes('approval_policy="never"'));

    // Where it holds: the whole disk writable in the sandbox, with key files, TeamBot's data and the closed folders denied.
    process.env.FAKE_CODEX_ROOT = 'held';
    resetCodexReadGuard();
    const closed = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-dicht-'));
    await t.api('PUT', '/settings', { closedFolders: [closed] });
    assert.equal((await t.api('GET', `/cli-agents/hard-blocks/${p.id}?agentId=${a.id}`)).levels.full.guarded, true);
    await t.say(th.id, 'werk');
    run = logs().filter((l) => l.argv?.[0] === 'exec').at(-1)!;
    assert.equal(flag(run.argv, '-s'), undefined);
    const whole = run.argv.find((x: string) => x.startsWith('permissions.teambot='));
    assert.match(whole, /":root"="write"/);
    assert.ok(whole.includes(`${JSON.stringify(closed)}="deny"`), 'the folder the owner closed');
    const dataDir = t.app.ctx.config.dataDir;
    const dataDenied = fs.readdirSync(dataDir).filter((n) => whole.includes(JSON.stringify(path.join(dataDir, n)) + '="deny"'));
    assert.ok(dataDenied.length > 0, `TeamBot's data: ${whole}`);
    assert.ok(!whole.includes(JSON.stringify(a.workspace ?? '') + '="deny"'), "never the bot's own folder");
    assert.ok(run.argv.includes('default_permissions="teambot"'));
    fs.rmSync(closed, { recursive: true, force: true });
    delete process.env.FAKE_CODEX_ROOT;
    resetCodexReadGuard();

    // "Automatisch" (and a full bot that stays in its own folders): TeamBot's profile.
    await t.api('PATCH', `/agents/${a.id}`, { access_mode: 'auto' });
    await t.say(th.id, 'werk');
    run = logs().filter((l) => l.argv?.[0] === 'exec').at(-1)!;
    assert.equal(flag(run.argv, '-s'), undefined);
    const prof = run.argv.find((x: string) => x.startsWith('permissions.teambot='));
    assert.match(prof, /":minimal"="read"/);
    assert.match(prof, /":workspace_roots"=\{"\."="write"\}/);
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
    // Checked once per Codex binary (after the reset above): the reads, and the whole disk writable.
    const probes = L.filter((l) => l.mode === 'sandbox');
    assert.equal(probes.length, 6, 'three checks of two runs each: before, with FAKE_CODEX_ROOT, after it');
  } finally {
    delete process.env.CODEX_HOME;
    delete process.env.FAKE_CODEX_SANDBOX;
    delete process.env.FAKE_CODEX_ROOT;
    resetCodexReadGuard();
    await t.close();
  }
});
