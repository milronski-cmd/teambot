// Update the installed TeamBot on this computer in one command, safely (the owner, 25 Nov 2026: "tests moeten slagen,
// controle na installatie, automatisch terugzetten").
//
//   node scripts/update.mjs [--version 4.19.0] [--skip-build]
//
// 1. typecheck + the full test suite must pass (one rerun of failing files, for a flaky timing test);
// 2. version: --version, or the patch number + 1 (package.json);
// 3. npm run dist:win → release/TeamBot-Setup-<version>.exe;
// 4. TeamBot is closed and its data folder copied to %APPDATA%\TeamBot-backup-voor-<version> (the last 3 are kept);
// 5. silent install, TeamBot started, then checked: it answers on the new version, and POST /mcp/health says every
//    app still works;
// 6. if a check fails: TeamBot closed, the previous installer reinstalled, the data folder put back, TeamBot started.
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const args = process.argv.slice(2);
const opt = (n) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
const flag = (n) => args.includes(`--${n}`);
const APPDATA = process.env.APPDATA;
const DATA = path.join(APPDATA, 'TeamBot');
const EXE = path.join(process.env.LOCALAPPDATA, 'Programs', 'teambot', 'TeamBot.exe');
const PORT = 4747;
const KEEP_BACKUPS = 3;

const log = (s) => console.log(`[update] ${s}`);
const die = (s) => {
  console.error(`[update] STOP: ${s}`);
  process.exit(1);
};
const run = (cmd, a, o = {}) => spawnSync(cmd, a, { stdio: 'inherit', shell: true, cwd: root, ...o }).status === 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const vparts = (v) => v.split('.').map(Number);
const vcmp = (a, b) => {
  const x = vparts(a), y = vparts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

async function api(method, p, body) {
  const token = fs.readFileSync(path.join(DATA, 'local-token'), 'utf8').trim();
  const r = await fetch(`http://127.0.0.1:${PORT}/api${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status}`);
  return r.json();
}

async function waitFor(version, ms = 120_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const s = await api('GET', '/system');
      if (!version || s.version === version) return s;
    } catch {
      /* not up yet */
    }
    await sleep(2000);
  }
  return null;
}

function closeTeamBot() {
  spawnSync('taskkill', ['/IM', 'TeamBot.exe', '/T'], { stdio: 'ignore' });
  for (let i = 0; i < 20; i++) {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq TeamBot.exe'], { encoding: 'utf8' });
    if (!/TeamBot\.exe/i.test(r.stdout || '')) return;
    spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 500']);
  }
  spawnSync('taskkill', ['/IM', 'TeamBot.exe', '/T', '/F'], { stdio: 'ignore' });
  spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 2']);
}

const startTeamBot = () => spawn(EXE, [], { detached: true, stdio: 'ignore' }).unref();
const install = (exe) => spawnSync(`"${exe}"`, ['/S', '/currentuser'], { stdio: 'inherit', shell: true }).status === 0;
/** robocopy: exit codes below 8 are success. */
const mirror = (from, to) => (spawnSync('robocopy', [from, to, '/MIR', '/R:2', '/W:2', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { stdio: 'inherit' }).status ?? 16) < 8;

// 1. Tests.
if (!flag('skip-build')) {
  log('typecheck…');
  if (!run('npm', ['run', 'typecheck'])) die('typecheck faalt');
  log('alle tests…');
  const out = spawnSync('node', ['--import', 'tsx', '--test', 'tests/**/*.test.ts'], { cwd: root, encoding: 'utf8', shell: true, maxBuffer: 256 * 1024 * 1024 });
  const text = (out.stdout || '') + (out.stderr || '');
  if (out.status !== 0) {
    const files = [...new Set([...text.matchAll(/^test at (tests[\\/][\w.-]+\.test\.ts)/gm)].map((m) => m[1]))];
    if (!files.length) die(`tests falen (geen bestand gevonden in de uitvoer)\n${text.slice(-3000)}`);
    log(`opnieuw, alleen: ${files.join(' ')}`);
    if (!run('node', ['--import', 'tsx', '--test', ...files])) die(`tests falen: ${files.join(', ')}`);
  }
  log('tests OK');
}

// 2. Version.
const pkgFile = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
let version = pkg.version;
if (!flag('skip-build')) {
  const [a, b, c] = vparts(pkg.version);
  version = opt('version') || `${a}.${b}.${c + 1}`;
  if (!/^\d+\.\d+\.\d+$/.test(version)) die(`ongeldige versie ${version}`);
  pkg.version = version;
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
  run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund']);
  log(`versie ${version}`);
  // 3. Build.
  if (!run('npm', ['run', 'dist:win'])) die('bouwen mislukt');
}
const setup = path.join(root, 'release', `TeamBot-Setup-${version}.exe`);
if (!fs.existsSync(setup)) die(`${setup} bestaat niet`);

// The installer to go back to: the version that runs now.
const before = (await waitFor(null, 5000))?.version || null;
const prev = before && path.join(root, 'release', `TeamBot-Setup-${before}.exe`);
if (!prev || !fs.existsSync(prev)) die(`geen installer van de huidige versie (${before ?? 'onbekend'}) om naar terug te gaan`);
const appsBefore = await api('POST', '/mcp/health').catch(() => null);
const brokenBefore = new Set((appsBefore?.results || []).filter((r) => !r.ok).map((r) => r.id));
if (brokenBefore.size) log(`let op, werkten al niet: ${appsBefore.results.filter((r) => !r.ok).map((r) => r.name).join(', ')}`);

// 4. Backup.
const backup = path.join(APPDATA, `TeamBot-backup-voor-${version}`);
log(`TeamBot sluiten en back-up naar ${backup}…`);
closeTeamBot();
if (!mirror(DATA, backup)) {
  startTeamBot();
  die('back-up mislukt; niets geïnstalleerd');
}
for (const d of fs.readdirSync(APPDATA).filter((n) => /^TeamBot-backup-voor-\d+\.\d+\.\d+$/.test(n)).sort((x, y) => vcmp(y.split('-').pop(), x.split('-').pop())).slice(KEEP_BACKUPS)) {
  log(`oude back-up weg: ${d}`);
  fs.rmSync(path.join(APPDATA, d), { recursive: true, force: true });
}

// 5. Install and check.
async function check() {
  const s = await waitFor(version);
  if (!s) return `TeamBot ${version} start niet (geen antwoord binnen 2 minuten)`;
  await sleep(5000);
  const h = await api('POST', '/mcp/health').catch((e) => ({ ok: false, results: [], error: String(e) }));
  if (h.error) return `appcontrole mislukt: ${h.error}`;
  const broken = (h.results || []).filter((r) => !r.ok && !brokenBefore.has(r.id));
  if (broken.length) return `apps werken niet meer: ${broken.map((r) => `${r.name} (${r.error})`).join('; ')}`;
  return null;
}

log(`installeren: ${path.basename(setup)}…`);
let problem = install(setup) ? null : 'installer gaf een fout';
if (!problem) {
  startTeamBot();
  problem = await check();
}
if (!problem) {
  log(`KLAAR: TeamBot ${version} draait, alle apps werken.`);
  process.exit(0);
}

// 6. Roll back.
log(`PROBLEEM: ${problem}`);
log(`terugzetten naar ${before}…`);
closeTeamBot();
const reinstalled = install(prev);
const restored = mirror(backup, DATA);
startTeamBot();
const back = await waitFor(before);
console.error(`[update] TERUGGEZET naar ${before}: installer ${reinstalled ? 'ok' : 'FOUT'}, gegevens ${restored ? 'ok' : 'FOUT'}, draait ${back ? 'ja' : 'NEE'}. Reden: ${problem}`);
process.exit(2);
