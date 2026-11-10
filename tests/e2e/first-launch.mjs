// LIVE check of the first start of the packaged Windows app (release 0.4.2), without the installer and without touching
// an installed TeamBot. It starts the unpacked app (electron-builder's win-unpacked, never the NSIS installer: that
// one shares the app id and registry key with an installed TeamBot) with its own APPDATA, LOCALAPPDATA, TEMP, data folder
// and port, and checks what a person sees:
//   1. the very first start after installing ("Uninstall TeamBot.exe" next to TeamBot.exe, as the installer leaves it):
//      the window is there within a few seconds on the start page "TeamBot is geïnstalleerd", then the first-run screen;
//   2. no other window appears (no console flashing, no dialog), every child process runs hidden;
//   3. TeamBot listens on 127.0.0.1 only and has no UDP socket (so Windows never asks about the firewall);
//   4. closing the window (the X) shows one message, once ever; after it TeamBot keeps running in the tray;
//   5. a second start: the start page without the "installed" line, the window in its saved place, closing is silent.
// A window and a tray icon appear for ~40 seconds; only the process this check starts is stopped.
// Usage: npm run dist:win (or: npx electron-builder --win dir) && npm run first-launch:check [-- --app <win-unpacked>]
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const argApp = process.argv.indexOf('--app');
const app = path.resolve(argApp > 0 ? process.argv[argApp + 1] : path.join(root, 'release', 'win-unpacked'));
const exe = path.join(app, 'TeamBot.exe');
if (process.platform !== 'win32') {
  console.log('Alleen op Windows.');
  process.exit(0);
}
if (!fs.existsSync(exe)) {
  console.error(`Geen ${exe}. Bouw eerst: npx electron-builder --win dir (of npm run dist:win).`);
  process.exit(2);
}
const marker = path.join(app, 'Uninstall TeamBot.exe');
if (fs.existsSync(marker) && fs.statSync(marker).size > 0) {
  console.error(`${app} is a real installation (it has an uninstaller). Use an unpacked build folder.`);
  process.exit(2);
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-first-launch-'));
// TEAMBOT_FIRST_LAUNCH_PORT: another pair of ports (app, app + 1 for the debugging port) when several checks run at once.
const APP_PORT = Number(process.env.TEAMBOT_FIRST_LAUNCH_PORT) || 47913;
const CDP_PORT = APP_PORT + 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (cmd) => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { encoding: 'utf8', windowsHide: true }).trim();
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? '  ok  ' : '  FOUT'} ${what}`);
  if (!ok) failures.push(what);
};

// Win32 helpers: visible top-level windows of a process (class[title]), optionally sending WM_CLOSE to one class.
const WIN32 = `Add-Type 'using System; using System.Runtime.InteropServices; using System.Text; public static class TbW { public delegate bool P(IntPtr h, IntPtr l); [DllImport("user32.dll")] public static extern bool EnumWindows(P f, IntPtr l); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n); [DllImport("user32.dll")] public static extern IntPtr PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l); public static string Of(uint pid, string closeClass) { var r = new StringBuilder(); EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); var c = new StringBuilder(64); GetClassName(h, c, 64); var t = new StringBuilder(128); GetWindowText(h, t, 128); if (p == pid && IsWindowVisible(h)) { r.Append(c + "[" + t + "];"); if (c.ToString() == closeClass) PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); } return true; }, IntPtr.Zero); return r.ToString(); } }'; `;
const windowsOf = (pid, closeClass = '-') => ps(`${WIN32}[TbW]::Of(${pid}, '${closeClass}')`);

// The watcher: new visible windows on the whole desktop (process name and class only, never other programs' titles)
// and the processes under TeamBot.exe (parent and creation time must match: Windows reuses process ids).
const WATCHER = `param([int]$RootPid, [int]$Seconds, [string]$Out)
Add-Type 'using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text; public static class TbV { public delegate bool P(IntPtr h, IntPtr l); [DllImport("user32.dll")] public static extern bool EnumWindows(P f, IntPtr l); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n); public static List<string> All() { var r = new List<string>(); EnumWindows((h, l) => { if (IsWindowVisible(h)) { uint p; GetWindowThreadProcessId(h, out p); var c = new StringBuilder(64); GetClassName(h, c, 64); r.Add(h.ToInt64() + "|" + p + "|" + c); } return true; }, IntPtr.Zero); return r; } }'
$base = @{}; foreach ($w in [TbV]::All()) { $base[$w.Split('|')[0]] = 1 }
$tree = @{ $RootPid = (Get-CimInstance Win32_Process -Filter "ProcessId=$RootPid").CreationDate }
$seen = @{}; $end = (Get-Date).AddSeconds($Seconds); $i = 0
while ((Get-Date) -lt $end) {
  if ($i % 4 -eq 0) {
    $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CreationDate
    $by = @{}; foreach ($p in $all) { $by[[int]$p.ProcessId] = $p }
    $grew = $true
    while ($grew) { $grew = $false; foreach ($p in $all) { $par = $by[[int]$p.ParentProcessId]; if ($tree.ContainsKey([int]$p.ParentProcessId) -and $par -and $tree[[int]$p.ParentProcessId] -eq $par.CreationDate -and -not $tree.ContainsKey([int]$p.ProcessId)) { $tree[[int]$p.ProcessId] = $p.CreationDate; $grew = $true; Add-Content $Out "proc|$($p.ProcessId)|$($p.Name)" } } }
  }
  foreach ($w in [TbV]::All()) { $f = $w.Split('|'); if ($base.ContainsKey($f[0]) -or $seen.ContainsKey($f[0])) { continue }; $seen[$f[0]] = 1; $n = try { (Get-Process -Id ([int]$f[1]) -ErrorAction Stop).ProcessName } catch { '?' }; Add-Content $Out "window|$($f[1])|$n|$($f[2])|$($tree.ContainsKey([int]$f[1]))" }
  Start-Sleep -Milliseconds 150; $i++
}
Add-Content $Out 'done'`;
fs.writeFileSync(path.join(work, 'watch.ps1'), WATCHER);

async function pages() {
  try {
    return (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  } catch {
    return [];
  }
}
async function cdp(target, method, params = {}) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
  const out = await Promise.race([
    new Promise((res) => {
      ws.onmessage = (m) => {
        const d = JSON.parse(m.data);
        if (d.id === 1) res(d.result);
      };
      ws.send(JSON.stringify({ id: 1, method, params }));
    }),
    sleep(4000).then(() => null),
  ]);
  ws.close();
  return out;
}
const text = async (t) => (await cdp(t, 'Runtime.evaluate', { expression: 'document.body ? document.body.innerText : ""', returnByValue: true }))?.result?.value ?? null;
const shot = async (t, file) => {
  const r = await cdp(t, 'Page.captureScreenshot', { format: 'png' });
  if (r?.data) fs.writeFileSync(path.join(work, file), Buffer.from(r.data, 'base64'));
};

async function run(name, { installed }) {
  console.log(`\n${name}`);
  const env = { ...process.env, APPDATA: path.join(work, 'Roaming'), LOCALAPPDATA: path.join(work, 'Local'), TEMP: path.join(work, 'Temp'), TMP: path.join(work, 'Temp'), TEAMBOT_DATA: path.join(work, 'Roaming', 'TeamBot'), TEAMBOT_PORT: String(APP_PORT) };
  for (const k of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'TEAMBOT_UPDATE_URL', 'TEAMBOT_UPDATE_TEST', 'TEAMBOT_HOST', 'TEAMBOT_MASTER_KEY']) delete env[k];
  for (const d of ['Roaming', 'Local', 'Temp']) fs.mkdirSync(path.join(work, d), { recursive: true });
  if (installed) fs.writeFileSync(marker, '');
  const log = path.join(work, `${name}-watch.log`);
  fs.writeFileSync(log, '');
  const t0 = Date.now();
  const child = spawn(exe, [`--remote-debugging-port=${CDP_PORT}`], { env, stdio: 'ignore' });
  const spawned = Date.now() - t0; // a virus scanner can hold the very first start of a new exe for seconds
  const watcher = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(work, 'watch.ps1'), '-RootPid', String(child.pid), '-Seconds', '30', '-Out', log], { windowsHide: true, stdio: 'ignore' });
  try {
    let start = null;
    let ui = null;
    let startText = null;
    for (const until = Date.now() + 30_000; Date.now() < until && !ui; await sleep(80)) {
      for (const t of await pages()) {
        if (!start && t.url.startsWith('data:text/html')) {
          start = Date.now() - t0 - spawned;
          for (let i = 0; i < 20 && !startText; i++) (startText = await text(t)) || (await sleep(100));
          await shot(t, `${name}-start-page.png`);
        }
        if (t.url.startsWith(`http://127.0.0.1:${APP_PORT}/`)) ui = { t, at: Date.now() - t0 - spawned };
      }
    }
    check(start !== null && start < 5000, `the window opens on the start page (${start} ms after the process started)`);
    check(!!startText && (installed ? /TeamBot is geïnstalleerd/.test(startText) && /Startmenu/.test(startText) : /^TeamBot\b/.test(startText) && !/geïnstalleerd/.test(startText)), `start page says ${JSON.stringify(startText)}`);
    check(!!ui, `then the interface loads in the same window (${ui?.at} ms)`);
    if (!ui) return;
    let body = '';
    for (let i = 0; i < 80 && body.length < 40; i++) (await sleep(150), (body = (await text(ui.t)) || ''));
    check(body.length >= 40, 'the first screen is drawn');
    await sleep(600);
    await shot(ui.t, `${name}-first-screen.png`);

    const pids = JSON.parse(ps(`$a = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId; $t = @(${child.pid}); do { $n = $t.Count; $t = @($t + ($a | Where-Object { $t -contains $_.ParentProcessId -and $t -notcontains $_.ProcessId } | ForEach-Object { [int]$_.ProcessId })) } while ($t.Count -gt $n); $t | ConvertTo-Json -Compress`));
    const list = [].concat(pids).join(',');
    const tcp = ps(`Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { @(${list}) -contains $_.OwningProcess -and $_.LocalPort -ne ${CDP_PORT} } | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort)" } | Sort-Object -Unique`).split(/\s+/).filter(Boolean);
    const udp = ps(`Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Where-Object { @(${list}) -contains $_.OwningProcess } | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort)" } | Sort-Object -Unique`).split(/\s+/).filter(Boolean);
    check(tcp.length > 0 && tcp.every((a) => /^(127\.0\.0\.1|::1):/.test(a)), `listens on 127.0.0.1 only: ${tcp.join(' ') || '(nothing)'}`);
    check(udp.length === 0, `no UDP sockets (${udp.join(' ') || 'none'})`);

    const shellJson = path.join(work, 'Roaming', 'TeamBot', 'electron', 'shell.json');
    const shell = () => (fs.existsSync(shellJson) ? JSON.parse(fs.readFileSync(shellJson, 'utf8')) : {});
    const tipBefore = !!shell().closeTipAt;
    windowsOf(child.pid, 'Chrome_WidgetWin_1'); // the X
    await sleep(1500);
    const afterX = windowsOf(child.pid, '#32770'); // closes the message like Esc: "Op de achtergrond verder"
    check(tipBefore ? !afterX.includes('#32770') : afterX.includes('#32770[TeamBot]'), tipBefore ? 'closing again: no message' : 'closing the first time: one message about the tray');
    await sleep(1500);
    check(windowsOf(child.pid) === '' && child.exitCode === null, 'the window is gone, TeamBot keeps running in the tray');
    check(!!shell().closeTipAt && !!shell().window, 'the message is remembered, and where the window was');

    await new Promise((r) => watcher.on('exit', r));
    const lines = fs.readFileSync(log, 'utf8').split(/\r?\n/).filter((l) => l.startsWith('window|'));
    const strange = lines.filter((l) => {
      const [, pid, proc, cls] = l.split('|');
      return !(Number(pid) === child.pid && (cls === 'Chrome_WidgetWin_1' || cls === '#32770'));
    });
    check(strange.length === 0, `no other window appeared (console, dialog)${strange.length ? `: ${strange.map((l) => l.split('|').slice(2, 4).join(' ')).join(', ')}` : ''}`);
    const kids = fs.readFileSync(log, 'utf8').split(/\r?\n/).filter((l) => l.startsWith('proc|')).map((l) => l.split('|')[2]);
    console.log(`        child processes: ${[...new Set(kids)].join(', ') || 'none'}`);
  } finally {
    child.kill(); // only the process this check started; Electron's helpers end with it
    watcher.kill();
    await sleep(800);
    if (installed) fs.rmSync(marker, { force: true });
  }
}

try {
  await run('1-first-start-after-install', { installed: true });
  await run('2-next-start', { installed: false });
} finally {
  fs.rmSync(marker, { force: true });
}
console.log(`\nScreenshots: ${work}`);
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log('\nFirst start: all checks passed.');
