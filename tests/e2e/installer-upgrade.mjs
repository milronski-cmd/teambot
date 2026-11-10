// Installing over a running TeamBot, for real, on a copy (0.4.4). Found installing 0.4.3 over a running 0.4.2 on the
// owner's PC: `/S /currentuser` stopped with exit code 2 (TeamBot gone, files still 0.4.2), and a second silent run
// installed but did not start TeamBot.
//
// Isolated, so it can run on a PC with a TeamBot in use:
//  - The installers are built with npx electron-builder --win nsis into a temporary folder from a small stand-in app
//    with the real build/installer.nsh and build/teambot-close.ps1, but its own app id and name
//    ("TeamBotInstallTest"): other registry keys, no shortcuts, another program name. The real TeamBot is never built,
//    installed, started or ended here.
//  - Why a stand-in: the installer starts the app through the Windows shell, which does not pass this test's temporary
//    APPDATA on. A real TeamBot started that way would open the owner's %APPDATA%\TeamBot and port 4747. The stand-in
//    writes only to this test's own temporary folder, whoever starts it.
//  - Like TeamBot it keeps one instance, keeps running without a window (tray), and starts a long-running helper (as the
//    dictation PowerShell does). Version 1.0.0 behaves like 0.4.2 (helper in the install folder, no --quit); 1.0.1 and
//    1.0.2 like 0.4.4 (desktop/main.ts: works outside the install folder, quits cleanly on --quit).
//  - Installed per user with /D= into a temporary folder; at the end uninstalled silently (its registry keys go too).
//    Only processes this test started (or the installers started in its folder) are ended, by process number.
// Steps: 1. the old installer.nsh over the running old version: TeamBot gone and not started again (exit 2 itself
//           depends on what held a file on the owner's PC and is only reported here);
//        2. the fix, over the running old version: exit 0, new version, and it starts by itself (silent, no
//           --force-run); 3. again over the running new version (asked to quit, no force needed): starts again;
//        4. the app closed: installs and starts; 5. the automatic-update path (--updated /S --force-run): starts once;
//        6. silent uninstall with the app running.
// Usage: node tests/e2e/installer-upgrade.mjs   (a few minutes; needs electron and electron-builder from node_modules)
import { execFile, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.log('Alleen op Windows.');
  process.exit(0);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const step = (s) => console.log(`• ${s}`);
const fail = (s) => {
  console.error(`✗ ${s}`);
  process.exitCode = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-inst-'));
if (/\s/.test(tmp)) throw new Error('the temporary folder must not contain spaces (/D= is passed unquoted)');
const marks = path.join(tmp, 'marks');
const events = path.join(marks, 'events.log');
const inst = path.join(tmp, 'install', 'TeamBotInstallTest');
const home = path.join(tmp, 'home');
fs.mkdirSync(marks, { recursive: true });
fs.mkdirSync(home, { recursive: true });
const env = { ...process.env, APPDATA: path.join(home, 'Roaming'), LOCALAPPDATA: path.join(home, 'Local'), TEAMBOT_DATA: path.join(home, 'data'), TEAMBOT_PORT: '4824' };
delete env.ELECTRON_RUN_AS_NODE;
const electronVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
const APP_ID = 'app.teambot.installer-test.agent';
const NAME = 'TeamBotInstallTest';

/** The stand-in app. `fixed`: behaves like TeamBot 0.4.4 (works outside the install folder, quits on --quit). */
const mainJs = (fixed) => `const { app } = require('electron');
const fs = require('node:fs'), path = require('node:path'), { spawn } = require('node:child_process');
const MARKS = ${JSON.stringify(marks)};
const log = (s) => fs.appendFileSync(path.join(MARKS, 'events.log'), Date.now() + ' ' + process.pid + ' ' + s + '\\n');
const quitRequest = ${fixed} && process.argv.includes('--quit');
app.setPath('userData', path.join(MARKS, 'userdata'));
if (!app.requestSingleInstanceLock() || quitRequest) { log('second ' + process.argv.slice(1).join(' ')); app.quit(); process.exit(0); }
if (${fixed}) { try { process.chdir(app.getPath('home')); } catch {} }
log('start ' + app.getVersion() + ' args=' + process.argv.slice(1).join(' ') + ' cwd=' + process.cwd());
// A helper that outlives the app when the app is ended (started detached; a normal child is ended with Electron's job
// object), outside the install folder, keeping a file of the install folder in use (here app.asar, as an engine keeps
// its DLL or model). That is what makes the old uninstaller fail after electron-builder ended the app itself.
const helper = spawn(path.join(process.env.SystemRoot || 'C:\\\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ['-NoProfile', '-NonInteractive', '-Command', "$f = [IO.File]::Open($env:HOLD_FILE, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read); Start-Sleep -Seconds 3600"],
  { stdio: 'ignore', windowsHide: true, detached: true, env: { ...process.env, HOLD_FILE: path.join(process.resourcesPath, 'app.asar') } });
helper.unref();
log('helper ' + helper.pid);
app.on('second-instance', (_e, argv) => {
  log('second-instance ' + argv.slice(1).join(' '));
  if (${fixed} && argv.includes('--quit')) app.quit();
});
app.on('window-all-closed', () => {});
app.on('will-quit', () => { log('will-quit'); try { helper.kill(); } catch {} });
app.whenReady().then(() => log('ready'));
`;

function build(version, nsh, fixed, kind) {
  const proj = path.join(tmp, `proj-${version}-${kind}`);
  fs.mkdirSync(path.join(proj, 'build'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'build', 'installer.nsh'), nsh);
  fs.copyFileSync(path.join(root, 'build', 'teambot-close.ps1'), path.join(proj, 'build', 'teambot-close.ps1'));
  fs.writeFileSync(path.join(proj, 'main.js'), mainJs(fixed));
  const out = path.join(tmp, `out-${version}-${kind}`);
  fs.writeFileSync(
    path.join(proj, 'package.json'),
    JSON.stringify(
      {
        name: 'teambot-installer-test',
        productName: NAME,
        version,
        main: 'main.js',
        license: 'Apache-2.0',
        build: {
          appId: APP_ID,
          productName: NAME,
          electronVersion,
          electronDist: path.join(root, 'node_modules', 'electron', 'dist'),
          npmRebuild: false,
          compression: 'store',
          directories: { output: out, buildResources: 'build' },
          files: ['main.js', 'package.json'],
          publish: null,
          win: { target: [{ target: 'nsis', arch: ['x64'] }], signAndEditExecutable: false },
          nsis: {
            oneClick: true,
            perMachine: false,
            runAfterFinish: true,
            createDesktopShortcut: false,
            createStartMenuShortcut: false,
            shortcutName: NAME,
            deleteAppDataOnUninstall: false,
            include: 'build/installer.nsh',
          },
        },
      },
      null,
      1,
    ),
  );
  let r;
  // As scripts/electron-builder-retry.mjs: a virus scanner sometimes still holds the fresh uninstaller (makensis then
  // cannot run it); a next attempt succeeds.
  for (let attempt = 1; attempt <= 3; attempt++) {
    r = spawnSync(process.execPath, [path.join(root, 'node_modules', 'electron-builder', 'cli.js'), '--win', 'nsis', '--x64', '--projectDir', proj, '--publish', 'never'], {
      cwd: proj,
      encoding: 'utf8',
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
      timeout: 15 * 60_000,
    });
    if (r.status === 0 || !/ERR_ELECTRON_BUILDER_CANNOT_EXECUTE/.test(`${r.stdout}${r.stderr}`)) break;
    for (const f of fs.existsSync(out) ? fs.readdirSync(out) : []) if (f.endsWith('__uninstaller.exe')) fs.rmSync(path.join(out, f), { force: true });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
  }
  const exe = fs.existsSync(out) ? fs.readdirSync(out).find((f) => /Setup.*\.exe$/i.test(f) || /\.exe$/i.test(f)) : null;
  if (r.status !== 0 || !exe) {
    const all = `${r.stdout || ''}\n${r.stderr || ''}`;
    const why = all.split(/\r?\n/).filter((l) => /warning|error|!insertmacro|macro/i.test(l) && l.trim()).slice(-30).join('\n');
    throw new Error(`build ${version} (${fixed ? 'fix' : 'stock'}) failed:\n${why || all.slice(-3000)}`);
  }
  return path.join(out, exe);
}

const lines = () => (fs.existsSync(events) ? fs.readFileSync(events, 'utf8').trim().split(/\r?\n/).filter(Boolean) : []);
const pidsOf = (re) => lines().map((l) => re.exec(l)).filter(Boolean).map((m) => Number(m[1]));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/**
 * Every process this test knows of (apps and helpers from the log), and only while it is still that program (the
 * stand-in in the test's install folder, or a logged helper that is still that PowerShell): a process number can be
 * reused by another program.
 */
function endOwn() {
  const helpers = new Set(pidsOf(/ helper (\d+)$/));
  const own = [...new Set([...lines().map((l) => Number(l.split(' ')[1])), ...helpers])].filter((pid) => pid && pid !== process.pid && alive(pid));
  if (!own.length) return;
  const q = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-Process -Id ${own.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id)|$($_.Path)" }`], { encoding: 'utf8', windowsHide: true });
  const ps = path.join(process.env.SystemRoot || String.raw`C:\Windows`, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe').toLowerCase();
  for (const line of (q.stdout || '').split(/\r?\n/)) {
    const [id, file = ''] = line.trim().split('|');
    const f = file.toLowerCase();
    if (id && (f.startsWith(inst.toLowerCase() + path.sep) || (f === ps && helpers.has(Number(id))))) try { process.kill(Number(id)); } catch {}
  }
}
const install = (exe, args) =>
  new Promise((resolve) => {
    const t0 = Date.now();
    execFile(exe, [...args, `/D=${inst}`], { env, windowsHide: true, timeout: 5 * 60_000 }, (err) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, ms: Date.now() - t0 }));
  });
const startApp = () => {
  const p = spawn(path.join(inst, `${NAME}.exe`), [], { cwd: inst, env, detached: true, stdio: 'ignore', windowsHide: true });
  p.unref();
};
const waitFor = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(200);
  }
  fail(`time-out: ${what}`);
  return false;
};
const startsAfter = (n) => lines().slice(n).filter((l) => / start /.test(l));
const running = () => {
  const starts = lines().filter((l) => / start /.test(l));
  const last = starts.at(-1);
  return last && alive(Number(last.split(' ')[1])) ? last : null;
};
const version = (l) => / start (\S+)/.exec(l || '')?.[1];

try {
  const fixedNsh = fs.readFileSync(path.join(root, 'build', 'installer.nsh'), 'utf8');
  // The installer.nsh of 0.4.3: the same file without the 0.4.4 section (electron-builder's own check and start), the
  // bug as the owner met it.
  const marker = '; ---------------------------------------------------------------- a running TeamBot';
  if (!fixedNsh.includes(marker)) throw new Error('build/installer.nsh: the section about a running TeamBot is missing');
  const stockNsh = fixedNsh.slice(0, fixedNsh.indexOf(marker));
  step(`bouwen in ${tmp} (electron ${electronVersion}, app-id ${APP_ID}, naam ${NAME})`);
  const newFixed = build('1.0.1', fixedNsh, true, 'nieuw');
  if (process.env.TEAMBOT_INSTALLER_BUILD_ONLY === '1') {
    console.log(`alleen gebouwd: ${newFixed}`);
    process.exit(0);
  }
  const newer = build('1.0.2', fixedNsh, true, 'nieuw');
  const oldStock = build('1.0.0', stockNsh, false, 'oud');
  const newStock = build('1.0.1', stockNsh, true, 'oud');
  // Each installer carries the installer.nsh it was built with (the new one says "TeamBot: started").
  const has = (f) => fs.readFileSync(f).includes(Buffer.from('TeamBot: started', 'utf16le'));
  if (!has(newFixed) || !has(newer) || has(oldStock) || has(newStock)) fail('de installers dragen niet de installer.nsh waarmee ze gebouwd zijn');
  step('vier installers gebouwd: 1.0.0 en 1.0.1 met de oude installer.nsh, 1.0.1 en 1.0.2 met de nieuwe');

  // ------------------------------------------------ 1. the bug
  let r = await install(oldStock, ['/S', '/currentuser']);
  if (r.code !== 0) fail(`1.0.0 installeren: code ${r.code}`);
  await sleep(1500);
  if (running()) fail('1.0.0 startte na een stille installatie met de oude installer.nsh (verwacht: niet, dat was de tweede fout)');
  startApp();
  await waitFor(() => version(running()) === '1.0.0' && pidsOf(/ helper (\d+)$/).some(alive), 20_000, '1.0.0 draait met helper');
  // The helper really keeps a file of the install folder in use (what made the old uninstaller fail).
  const asar = path.join(inst, 'resources', 'app.asar');
  let held = false;
  for (let i = 0; i < 20 && !held; i++) {
    try {
      fs.renameSync(asar, asar + '.x');
      fs.renameSync(asar + '.x', asar);
      await sleep(250);
    } catch {
      held = true;
    }
  }
  if (!held) fail('de helper houdt app.asar niet vast');
  r = await install(newStock, ['/S', '/currentuser']);
  await sleep(3000);
  const afterBug = running();
  // What the owner met: after a silent install nothing runs. (Code 2 itself depends on what kept a file in use on his
  // PC; with this stand-in electron-builder's own installer still gets through, so the code is only reported.)
  step(`1. de oude installer.nsh over een draaiende 1.0.0: code ${r.code}, draait daarna: ${afterBug ? version(afterBug) : 'niets'} (de tweede fout)`);
  if (afterBug) fail('1. de oude installer startte de app toch (de fout is niet nagespeeld)');
  endOwn();
  await sleep(1500);

  // ------------------------------------------------ 2. the fix, over the running old version
  // Back to 1.0.0 first, whatever step 1 left (all closed: the test's own processes only).
  r = await install(oldStock, ['/S', '/currentuser']);
  if (r.code !== 0) fail(`1.0.0 opnieuw installeren: code ${r.code}`);
  endOwn();
  await sleep(1500);
  startApp();
  await waitFor(() => version(running()) === '1.0.0' && pidsOf(/ helper (\d+)$/).some(alive), 20_000, '1.0.0 draait weer met helper');
  const oldHelper = pidsOf(/ helper (\d+)$/).at(-1);
  let n = lines().length;
  r = await install(newFixed, ['/S', '/currentuser']);
  if (r.code !== 0) fail(`2. nieuwe installer over draaiende 1.0.0: code ${r.code} (verwacht 0)`);
  await waitFor(() => startsAfter(n).some((l) => version(l) === '1.0.1'), 20_000, '2. 1.0.1 start vanzelf na een stille installatie');
  if (alive(oldHelper)) fail('2. de helper van de oude versie draait nog');
  step(`2. nieuwe installer over een draaiende 1.0.0 (die --quit niet kent): code ${r.code} in ${Math.round(r.ms / 1000)} s, 1.0.1 gestart, oude helper weg`);

  // ------------------------------------------------ 3. again, over the running new version: asked to quit
  n = lines().length;
  r = await install(newFixed, ['/S', '/currentuser']);
  if (r.code !== 0) fail(`3. opnieuw over draaiende 1.0.1: code ${r.code}`);
  const asked = lines().slice(n).some((l) => /second-instance .*--quit/.test(l)) && lines().slice(n).some((l) => /will-quit/.test(l));
  if (!asked) fail('3. de draaiende 1.0.1 is niet netjes gevraagd af te sluiten (--quit, will-quit)');
  await waitFor(() => startsAfter(n).some((l) => version(l) === '1.0.1'), 20_000, '3. 1.0.1 start weer');
  step(`3. opnieuw over een draaiende 1.0.1: netjes afgesloten (--quit, will-quit), code ${r.code} in ${Math.round(r.ms / 1000)} s, weer gestart`);

  // ------------------------------------------------ 4. the app closed: installs and starts (the second symptom)
  const cur = running();
  const quit = spawn(path.join(inst, `${NAME}.exe`), ['--quit'], { cwd: home, env, stdio: 'ignore', windowsHide: true });
  await new Promise((res) => quit.on('exit', res));
  await waitFor(() => !running() && !alive(Number(cur?.split(' ')[1])), 15_000, '4. app afgesloten');
  n = lines().length;
  r = await install(newFixed, ['/S', '/currentuser']);
  if (r.code !== 0) fail(`4. app dicht: code ${r.code}`);
  await waitFor(() => startsAfter(n).length === 1, 20_000, '4. start na stil installeren zonder --force-run');
  step(`4. app dicht, stil installeren: code ${r.code}, TeamBot start daarna vanzelf`);

  // ------------------------------------------------ 5. the automatic update path (electron-updater's arguments)
  n = lines().length;
  r = await install(newer, ['--updated', '/S', '--force-run']);
  if (r.code !== 0) fail(`5. automatische update: code ${r.code}`);
  await waitFor(() => startsAfter(n).some((l) => version(l) === '1.0.2'), 20_000, '5. 1.0.2 start na de update');
  await sleep(4000);
  const starts = startsAfter(n);
  if (starts.length !== 1) fail(`5. ${starts.length} keer gestart (verwacht precies 1): ${starts.join(' | ')}`);
  if (!/--updated/.test(starts[0] || '')) fail('5. niet met --updated gestart');
  step(`5. automatische update (--updated /S --force-run): code ${r.code}, 1.0.2 precies één keer gestart`);

  // ------------------------------------------------ 6. silent uninstall with the app running
  // In place (`_?=`: it runs from inside the install folder and returns when done). The close script must spare it.
  const un = fs.readdirSync(inst).find((f) => /^Uninstall .*\.exe$/i.test(f));
  const u = await new Promise((resolve) => execFile(path.join(inst, un), ['/S', `_?=${inst}`], { env, windowsHide: true, timeout: 120_000 }, (err) => resolve(err ? err.code : 0)));
  await sleep(1500);
  if (u !== 0) fail(`6. stil verwijderen: code ${u}`);
  if (running()) fail('6. de app draait nog na verwijderen');
  // The program of a process ended a moment ago is released a little later (a virus scanner may look at it first).
  for (let i = 0; i < 40 && fs.existsSync(path.join(inst, `${NAME}.exe`)); i++) await sleep(250);
  // Not part of the install fix: an in-place uninstall (`_?=`) can leave a file that was still held at that moment.
  if (fs.existsSync(path.join(inst, `${NAME}.exe`))) console.log(`  (let op: ${NAME}.exe bleef na verwijderen nog staan)`);
  const reg = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', NAME], { encoding: 'utf8' });
  if (/DisplayName\s+REG_SZ\s+TeamBotInstallTest/.test(reg.stdout || '')) fail('6. de testinstallatie staat nog in de lijst met programma\'s');
  step(`6. stil verwijderd terwijl de app draaide: code ${u}, app gesloten, registervermelding weg`);
} catch (e) {
  fail(String(e?.stack || e));
} finally {
  if (process.exitCode) console.log(`events.log (laatste regels):\n${lines().slice(-40).join('\n')}`);
  endOwn();
  // Leftovers of a failed run: the test's own uninstaller (only its registry keys and folder).
  try {
    const un = fs.existsSync(inst) && fs.readdirSync(inst).find((f) => /^Uninstall .*\.exe$/i.test(f));
    if (un) {
      fs.copyFileSync(path.join(inst, un), path.join(tmp, 'uninstall-copy.exe'));
      spawnSync(path.join(tmp, 'uninstall-copy.exe'), ['/S', `_?=${inst}`], { env, timeout: 120_000 });
    }
  } catch {}
  await sleep(1000);
  endOwn();
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (e) {
    console.log(`(tijdelijke map blijft staan: ${tmp})`);
  }
}
if (!process.exitCode) step('geslaagd');
