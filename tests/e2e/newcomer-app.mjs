// LIVE check of a brand-new user in the PACKAGED Windows app (0.4.5, "works right after the installer, like OpenBot"):
// the unpacked app (never the installer) with its own APPDATA, LOCALAPPDATA, TEMP, home folder, data folder and port.
// Through the real interface: the welcome screen → "Gratis starten" (OpenCode's free models, downloaded into the
// temporary data folder) → a ready first bot with its own werkplek and browser → "Later" → the chat; the bot answers,
// works in its own folder, opens a web page in its invisible browser, the live view shows it, and no window of a bot
// browser ever appears on the screen. Needs internet (the free models). Only the process this check starts is stopped.
//   node tests/e2e/newcomer-app.mjs --app <win-unpacked>     (TEAMBOT_APP_PORT, default 4872; debugging port +1)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argApp = process.argv.indexOf('--app');
const appDir = path.resolve(argApp > 0 ? process.argv[argApp + 1] : path.join(process.cwd(), 'release', 'win-unpacked'));
const exe = path.join(appDir, 'TeamBot.exe');
if (process.platform !== 'win32') process.exit(console.log('Alleen op Windows.') ?? 0);
if (!fs.existsSync(exe)) process.exit(console.error(`Geen ${exe}. Bouw eerst: npx electron-builder --win dir`) ?? 2);
if (fs.existsSync(path.join(appDir, 'Uninstall TeamBot.exe'))) process.exit(console.error(`${appDir} is een echte installatie. Gebruik een uitgepakte build.`) ?? 2);
const APP_PORT = Number(process.env.TEAMBOT_APP_PORT) || 4872;
const CDP_PORT = APP_PORT + 1;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-newcomer-app-'));
const home = path.join(work, 'home');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? '  ok  ' : '  FOUT'} ${what}`);
  if (!ok) failures.push(what);
  return ok;
};
const ps = (cmd) => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { encoding: 'utf8', windowsHide: true }).trim();
const WIN32 = `Add-Type 'using System; using System.Runtime.InteropServices; using System.Text; public static class TbN { public delegate bool P(IntPtr h, IntPtr l); [DllImport("user32.dll")] public static extern bool EnumWindows(P f, IntPtr l); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n); public static string Of(uint pid) { var r = new StringBuilder(); EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h)) { var c = new StringBuilder(64); GetClassName(h, c, 64); var t = new StringBuilder(128); GetWindowText(h, t, 128); r.Append(c + "[" + t + "];"); } return true; }, IntPtr.Zero); return r.ToString(); } }'; `;
/** Visible top-level windows of TeamBot.exe (the bot browsers live in that process too). */
const visibleOf = (pid) => ps(`${WIN32}[TbN]::Of(${pid})`).split(';').filter(Boolean);

// ---- raw CDP on the main window only (never on the bots' tabs) ----
let seq = 0;
async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
  const waiting = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && waiting.has(d.id)) (waiting.get(d.id)(d), waiting.delete(d.id));
  };
  const send = (method, params = {}) => new Promise((res) => ((seq += 1), waiting.set(seq, res), ws.send(JSON.stringify({ id: seq, method, params }))));
  return {
    ws,
    send,
    eval: async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result?.result?.value,
  };
}
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return (check(false, `time-out (${Math.round(ms / 1000)} s): ${what}`), null);
    await sleep(400);
  }
};
const clickText = (text, scope = 'document') => `(() => { const b = [...${scope}.querySelectorAll('button, a')].find((x) => x.innerText.trim() === ${JSON.stringify(text)} && x.offsetParent); if (!b) return false; b.click(); return true; })()`;

const env = { ...process.env, APPDATA: path.join(work, 'Roaming'), LOCALAPPDATA: path.join(work, 'Local'), TEMP: path.join(work, 'Temp'), TMP: path.join(work, 'Temp'), USERPROFILE: home, HOME: home, TEAMBOT_DATA: path.join(work, 'Roaming', 'TeamBot'), TEAMBOT_PORT: String(APP_PORT) };
for (const k of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'TEAMBOT_UPDATE_URL', 'TEAMBOT_UPDATE_TEST', 'TEAMBOT_HOST', 'TEAMBOT_MASTER_KEY', 'TEAMBOT_BROWSER_PATH']) delete env[k];
for (const d of ['Roaming', 'Local', 'Temp', path.join('home', 'Documents')]) fs.mkdirSync(path.join(work, d), { recursive: true });

const child = spawn(exe, [`--remote-debugging-port=${CDP_PORT}`], { env, stdio: 'ignore' });
let everBotWindow = 0;
const watch = setInterval(() => {
  try {
    const w = visibleOf(child.pid).filter((x) => !/^Chrome_WidgetWin_1\[TeamBot\]$/.test(x) && !/^#32770/.test(x));
    everBotWindow = Math.max(everBotWindow, w.length);
  } catch {
    /* busy */
  }
}, 1500);
const t0 = Date.now();
try {
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find((t) => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${APP_PORT}/`)), 40_000, 'het venster laadt de interface');
  if (!target) throw new Error('geen interface');
  const ui = await connect(target);
  const text = () => ui.eval('document.body ? document.body.innerText : ""');
  await until(async () => /Welkom bij TeamBot/.test(await text()), 30_000, 'het welkomstscherm');
  check(true, `welkomstscherm na ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const token = await ui.eval(`localStorage.getItem('tb_token')`);
  const api = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${APP_PORT}/api${p}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${j.error || ''}`);
    return j;
  };
  const caps = await api('GET', '/computers/capabilities');
  const bcap = caps.caps.find((c) => c.id === 'browser');
  check(bcap?.status === 'available' && caps.engine?.app === true, `eigen browser per bot meteen beschikbaar, zonder Docker of WSL: ${bcap?.detail}`);

  // ---- free AI in one click ----
  await until(() => ui.eval(clickText('Gratis starten')), 30_000, 'knop "Gratis starten"');
  const tFree = Date.now();
  await until(async () => /#\/start/.test(await ui.eval('location.hash')), 8 * 60_000, 'OpenCode gratis klaarzetten (download)');
  check(true, `gratis AI gekoppeld in ${((Date.now() - tFree) / 1000).toFixed(0)} s (OpenCode, gratis modellen)`);
  const ready = await until(() => ui.eval(`(() => { const r = document.querySelector('[data-testid="first-bot-ready"]'); return r ? r.innerText : ''; })()`), 30_000, 'de klaargezette eerste bot');
  check(!!ready && /staat klaar/.test(ready) && /Werkplek:/.test(ready), `eerste bot staat klaar: ${String(ready).split('\n').filter(Boolean).slice(0, 2).join(' / ')}`);
  const bots = await api('GET', '/agents');
  const bot = bots[0];
  const teamFolder = path.join(home, 'Documents', 'TeamBot', 'Teammap');
  check(bots.length === 1 && path.resolve(bot.workspace).startsWith(path.resolve(teamFolder)) && fs.existsSync(bot.workspace), `eigen werkplek onder de teammap: ${bot?.workspace}`);
  const comp = await api('GET', `/computers/${bot.id}`);
  check(comp.config.mode === 'browser', `eigen browser aan (computermodus ${comp.config.mode})`);
  await until(() => ui.eval(clickText('Begin met praten')), 10_000, '"Begin met praten"');
  await until(() => ui.eval(`!!document.querySelector('[data-testid="first-bot-phone"]')`), 10_000, 'de laatste stap "Koppel je telefoon"');
  check(/Koppel je telefoon/.test(await text()), 'laatste stap biedt "Koppel je telefoon" aan');
  await until(() => ui.eval(clickText('Later')), 10_000, '"Later"');
  await until(async () => /#\/t\//.test(await ui.eval('location.hash')), 15_000, 'het gesprek opent');
  const threadId = String(await ui.eval('location.hash')).match(/#\/t\/([^/?]+)/)?.[1];

  // ---- talk: through the real message box ----
  const say = async (msg) => {
    const before = (await api('GET', `/threads/${threadId}`)).messages.length;
    await until(() => ui.eval(`(() => { const b = document.querySelector('textarea[aria-label="Bericht"], [role="textbox"][aria-label="Bericht"]'); if (!b) return false; b.focus(); return true; })()`), 10_000, 'het berichtvak');
    await ui.send('Input.insertText', { text: msg });
    await ui.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await ui.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    // approve what the bot asks for (it works in "Vraagt toestemming"), and wait for its answer
    return until(
      async () => {
        for (const a of await api('GET', '/approvals')) if (a.agent_id === bot.id) await api('POST', `/approvals/${a.id}`, { decision: 'approve' }).catch(() => null);
        const th = await api('GET', `/threads/${threadId}`);
        const busy = th.runs.length > 0;
        const last = th.messages.slice(before).filter((m) => m.role === 'assistant' && String(m.content || '').trim()).at(-1);
        return !busy && last ? String(last.content) : null;
      },
      4 * 60_000,
      `antwoord op "${msg.slice(0, 40)}"`,
    );
  };
  const a1 = await say('Hoi! Wat is je werkmap? Noem alleen het volledige pad.');
  check(!!a1 && a1.length > 0, `de bot antwoordt (gratis model): ${String(a1).replace(/\s+/g, ' ').slice(0, 120)}`);
  check(!!a1 && path.normalize(a1).toLowerCase().includes(path.basename(bot.workspace).toLowerCase()), 'de bot kent zijn eigen werkplek');
  const a2 = await say('Maak in je werkmap een bestand notitie.txt met precies deze tekst: hallo werkplek. Zeg daarna alleen "klaar".');
  const note = path.join(bot.workspace, 'notitie.txt');
  await until(async () => fs.existsSync(note), 20_000, 'notitie.txt in de werkplek');
  check(fs.existsSync(note) && /hallo werkplek/i.test(fs.readFileSync(note, 'utf8')), `de bot schrijft in zijn eigen werkplek (${String(a2).replace(/\s+/g, ' ').slice(0, 60)})`);
  const a3 = await say('Open https://example.com in je eigen browser en vertel me de titel van de pagina.');
  const st = await api('GET', `/computers/${bot.id}`);
  check(st.status.browser.running && st.status.browser.engine === 'app' && !st.status.browser.headed, `de bot opende een pagina in zijn onzichtbare browser in TeamBot (${st.status.browser.url}); antwoord: ${String(a3).replace(/\s+/g, ' ').slice(0, 80)}`);
  check(/example/i.test(st.status.browser.url || '') || /Example Domain/i.test(String(a3)), 'de pagina is example.com');
  // the live view: the latest picture of the bot's tab
  const fr = await fetch(`http://127.0.0.1:${APP_PORT}/api/computers/${bot.id}/frame.jpg`, { headers: { authorization: `Bearer ${token}` } });
  const jpg = Buffer.from(await fr.arrayBuffer());
  check(fr.ok && jpg[0] === 0xff && jpg[1] === 0xd8 && jpg.length > 2000, `het live beeld toont de pagina (${jpg.length} bytes)`);
  fs.writeFileSync(path.join(work, 'live.jpg'), jpg);
  console.log(`        geheugen van de bot-browser: ${st.status.browser.memoryMb} MB`);
  check(everBotWindow === 0 && visibleOf(child.pid).filter((x) => !/^Chrome_WidgetWin_1\[TeamBot\]$/.test(x)).length === 0, `geen venster van een bot-browser op het scherm (alleen het TeamBot-venster: ${visibleOf(child.pid).join(' ')})`);
} catch (e) {
  check(false, `onverwachte fout: ${e?.stack || e?.message || e}`);
} finally {
  clearInterval(watch);
  child.kill(); // only the process this check started; Electron's helpers and the engines end with it
  await sleep(2500);
  try {
    const left = ps(`ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${work.replace(/'/g, "''")}*' } | ForEach-Object { [int]$_.ProcessId })`);
    for (const p of [].concat(JSON.parse(left || '[]'))) process.kill(p);
  } catch {
    /* none left */
  }
}
console.log(`\nMap van deze test (live.jpg): ${work}`);
if (failures.length) {
  console.error(`\n${failures.length} controle(s) mislukt.`);
  process.exit(1);
}
console.log('\nNieuwe gebruiker in de geïnstalleerde app: alles geslaagd.');
