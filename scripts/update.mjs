// Update the installed TeamBot on this computer in one command, safely (the owner, 25 Nov 2026: "tests moeten slagen,
// controle na installatie, automatisch terugzetten").
//
//   node scripts/update.mjs [--version 4.19.0] [--skip-build]
//
// 1. version: --version, or the patch number + 1 (package.json), and a CHANGELOG entry from the commits (unless written);
// 2. typecheck + the full test suite must pass (one rerun of failing files, for a flaky timing test); else 1. is undone;
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
  // A channel's own browser (WhatsApp Web) can outlive TeamBot and keep its cookie file locked: the backup would fail.
  const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${DATA.replace(/'/g, "''")}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Seconds 1`;
  spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
}

const startTeamBot = () => spawn(EXE, [], { detached: true, stdio: 'ignore' }).unref();
const install = (exe) => spawnSync(`"${exe}"`, ['/S', '/currentuser'], { stdio: 'inherit', shell: true }).status === 0;
/** robocopy: exit codes below 8 are success. */
const mirror = (from, to) => (spawnSync('robocopy', [from, to, '/MIR', '/R:2', '/W:2', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { stdio: 'inherit' }).status ?? 16) < 8;

// 1. Version and changelog first (the tests check that the running version has a "what is new" entry); both are
// put back when a test or the build fails.
const pkgFile = path.join(root, 'package.json');
const lockFile = path.join(root, 'package-lock.json');
const logFile = path.join(root, 'CHANGELOG.md');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
let version = pkg.version;
if (!flag('skip-build')) {
  const saved = [pkgFile, lockFile, logFile].map((f) => [f, fs.readFileSync(f)]);
  const restore = () => saved.forEach(([f, b]) => fs.writeFileSync(f, b));
  const fail = (why) => {
    restore();
    die(why);
  };
  const [a, b, c] = vparts(pkg.version);
  version = opt('version') || `${a}.${b}.${c + 1}`;
  if (!/^\d+\.\d+\.\d+$/.test(version)) die(`ongeldige versie ${version}`);
  pkg.version = version;
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
  run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund']);
  // Changelog: the commit subjects since the last version bump, unless the entry is already written by hand.
  const cl = fs.readFileSync(logFile, 'utf8');
  if (!cl.includes(`## [${version}]`)) {
    const since = spawnSync('git', ['log', '-1', '--format=%H', '--', 'package.json'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const subjects = spawnSync('git', ['log', '--format=%s', since ? `${since}..HEAD` : '-5'], { cwd: root, encoding: 'utf8' }).stdout.split('\n').map((x) => x.trim()).filter(Boolean);
    const items = (subjects.length ? subjects : ['Kleine verbeteringen']).map((x) => `- ${x}`).join('\n');
    const entry = `## [${version}] — ${new Date().toISOString().slice(0, 10)}\n\n### Nieuw\n${items}\n\n`;
    const at = cl.indexOf('## [');
    fs.writeFileSync(logFile, at >= 0 ? cl.slice(0, at) + entry + cl.slice(at) : cl + '\n' + entry);
  }
  log(`versie ${version}`);

  // 2. Tests.
  log('typecheck…');
  if (!run('npm', ['run', 'typecheck'])) fail('typecheck faalt');
  log('alle tests…');
  const out = spawnSync('node', ['--import', 'tsx', '--test', 'tests/**/*.test.ts'], { cwd: root, encoding: 'utf8', shell: true, maxBuffer: 256 * 1024 * 1024 });
  const text = (out.stdout || '') + (out.stderr || '');
  if (out.status !== 0) {
    const files = [...new Set([...text.matchAll(/^test at (tests[\\/][\w.-]+\.test\.ts)/gm)].map((m) => m[1]))];
    if (!files.length) fail(`tests falen (geen bestand gevonden in de uitvoer)\n${text.slice(-3000)}`);
    log(`opnieuw, alleen: ${files.join(' ')}`);
    if (!run('node', ['--import', 'tsx', '--test', ...files])) fail(`tests falen: ${files.join(', ')}`);
  }
  log('tests OK');

  // 3. Build.
  if (!run('npm', ['run', 'dist:win'])) fail('bouwen mislukt');
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
