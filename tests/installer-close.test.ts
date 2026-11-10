// Closing a running TeamBot before installing (build/teambot-close.ps1, used by build/installer.nsh
// customCheckAppRunning). Found installing 0.4.3 over a running 0.4.2: electron-builder ended TeamBot.exe only, a
// helper it had started kept running with the install folder in use, the old uninstaller failed and the installer
// stopped with code 2 (the full installer run: tests/e2e/installer-upgrade.mjs). Here with stand-ins in a temporary
// "install folder" (a copy of node.exe as TeamBot.exe, a helper that holds the folder, and a bystander that must
// survive). Only processes this test starts; nothing is installed. Windows only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (fn: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return fn();
};

test('installer: a running TeamBot and the helpers it started are ended, by folder, never anything else', { skip: process.platform !== 'win32' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-close-'));
  // A folder name with a space and an apostrophe (C:\Users\O'Brien\…): the script must not trip over either.
  const inst = path.join(tmp, "Programs O'Brien", 'TeamBot');
  fs.mkdirSync(inst, { recursive: true });
  const exe = path.join(inst, 'TeamBot.exe');
  fs.copyFileSync(process.execPath, exe);
  // The stand-in TeamBot: starts a helper (a system program, outside the folder) that inherits the install folder as
  // its working folder, like the dictation PowerShell did, and keeps running.
  const app = path.join(tmp, 'app.js');
  const helperPidFile = path.join(tmp, 'helper.pid');
  fs.writeFileSync(
    app,
    `const { spawn } = require('node:child_process');
const h = spawn(process.env.SystemRoot + '\\\\System32\\\\PING.EXE', ['-n', '120', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
require('node:fs').writeFileSync(${JSON.stringify(helperPidFile)}, String(h.pid));
setInterval(() => {}, 1000);`,
  );
  const tb = spawn(exe, [app], { cwd: inst, stdio: 'ignore', windowsHide: true });
  // Not TeamBot's: a program of the same kind, started elsewhere. It must survive.
  const bystander = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'PING.EXE'), ['-n', '120', '127.0.0.1'], { cwd: tmp, stdio: 'ignore', windowsHide: true });
  try {
    assert.ok(await waitFor(() => fs.existsSync(helperPidFile), 10_000), 'helper started');
    const helper = Number(fs.readFileSync(helperPidFile, 'utf8'));
    assert.ok(alive(tb.pid!) && alive(helper) && alive(bystander.pid!));
    // While the helper runs, the folder cannot go (the reason the old uninstaller failed).
    assert.throws(() => fs.renameSync(inst, inst + '-weg'), 'the folder is in use');

    const r = await new Promise<{ code: number; out: string }>((resolve) =>
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'build', 'teambot-close.ps1')],
        { windowsHide: true, timeout: 90_000, env: { ...process.env, TEAMBOT_INSTDIR: inst, TEAMBOT_EXE: 'TeamBot.exe', TEAMBOT_CLOSE_WAIT_MS: '1500' } },
        (err: any, stdout) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout) }),
      ),
    );
    assert.equal(r.code, 0, r.out);
    assert.ok(await waitFor(() => !alive(tb.pid!) && !alive(helper), 5000), 'TeamBot and its helper are gone');
    assert.ok(alive(bystander.pid!), 'a program that is not TeamBot\'s keeps running');
    assert.ok(alive(process.pid));
    fs.renameSync(inst, inst + '-weg');
    fs.renameSync(inst + '-weg', inst);

    // Nothing running: nothing to do, at once.
    const t0 = Date.now();
    const again = await new Promise<number>((resolve) =>
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'build', 'teambot-close.ps1')], { windowsHide: true, env: { ...process.env, TEAMBOT_INSTDIR: inst, TEAMBOT_EXE: 'TeamBot.exe' } }, (err: any) =>
        resolve(err ? 1 : 0),
      ),
    );
    assert.equal(again, 0);
    assert.ok(Date.now() - t0 < 15_000);
  } finally {
    for (const p of [tb, bystander]) if (p.pid && alive(p.pid)) p.kill();
    try {
      const h = Number(fs.readFileSync(helperPidFile, 'utf8'));
      if (h && alive(h)) process.kill(h);
    } catch {
      /* not started */
    }
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('installer: the hooks close TeamBot by folder, retry the old uninstall, and always start TeamBot (static)', () => {
  const nsh = fs.readFileSync(path.join(root, 'build', 'installer.nsh'), 'utf8');
  const ps = fs.readFileSync(path.join(root, 'build', 'teambot-close.ps1'), 'utf8');
  const body = (name: string) => new RegExp(`!macro ${name}\\r?\\n([\\s\\S]*?)!macroend`).exec(nsh)?.[1] || '';
  // Closing: the script, by folder, in installer and uninstaller.
  const close = body('customCheckAppRunning');
  assert.match(close, /File "\/oname=\$PLUGINSDIR\\teambot-close\.ps1" "\$\{BUILD_RESOURCES_DIR\}\\teambot-close\.ps1"/);
  assert.match(close, /TEAMBOT_INSTDIR", t "\$INSTDIR"/, 'the folder goes in through the environment (an apostrophe in a path cannot break it)');
  assert.doesNotMatch(nsh + ps, /taskkill|\/IM |Stop-Process -Name|Get-Process -Name/i, 'never by program name');
  assert.match(ps, /StartsWith\(\$dir/, 'by folder');
  assert.match(ps, /'--quit'/, 'asks TeamBot to quit first');
  assert.match(ps, /\$skip/, 'never itself or the installer above it');
  // The old uninstaller failing: once more, else the old TeamBot starts again.
  const check = body('customUnInstallCheck');
  assert.match(check, /Call uninstallOldVersion/);
  assert.match(check, /ExecShellAsUser\} \$R9 "\$appExe"/);
  assert.match(check, /SetErrorLevel 2/);
  // Starting: silent without --force-run only (electron-builder starts it otherwise: never twice).
  const start = body('customInstall');
  assert.match(start, /\$\{If\} \$\{Silent\}\s*\n\s*\$\{AndIfNot\} \$\{isForceRun\}/);
  assert.match(start, /ExecShellAsUser\} \$R9 "\$launchLink" "open" "--updated"/);
  assert.match(nsh, /!ifndef BUILD_UNINSTALLER\r?\n\s*; After the old version's uninstaller ran/, 'the install-only hooks are not in the uninstaller');
  // The app side: --quit is honoured, and the install folder is never the working folder of TeamBot or its helpers.
  const main = fs.readFileSync(path.join(root, 'desktop', 'main.ts'), 'utf8');
  assert.match(main, /argv\.includes\('--quit'\)/);
  assert.match(main, /forInstaller = true/);
  assert.match(main, /!forInstaller && updater\?\.state\.phase === 'ready'/, 'no downloaded update starts while an installer is about to run');
  assert.match(main, /process\.chdir\(app\.getPath\('home'\)\)/);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.build.directories.buildResources, 'build', 'teambot-close.ps1 is found in the build resources');
  assert.match(pkg.scripts['installer:check'], /tests\/e2e\/installer-upgrade\.mjs/);
});
