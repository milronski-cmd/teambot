// LIVE desktop-control test (CMP-05 + computer use) on Windows: really moves the mouse, clicks and types.
// Run only when nobody is using the PC:  npm run desktop:live
//
// It compiles and opens its own small test window (tbtestwin.exe: text box, password box, "Opslaan" and "Verzenden"
// buttons, a list and a slider) and drives ONLY that window. The bot's allowlist contains nothing but "tbtestwin", and
// every input re-checks window handle + process id right before it is sent, so no other application is touched.
// Takes about 1-2 minutes. Do not touch mouse or keyboard meanwhile: moving the mouse pauses the bot (that is one of
// the things being tested, with a simulated owner) and would make other checks fail. Ctrl+C aborts.
//
// Options: TB_DEBUG=1 prints tool output. TB_LIVE_SKIP_UIA=1 skips the window-scoped UI Automation part.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

if (process.platform !== 'win32') {
  console.log('Alleen op Windows.');
  process.exit(0);
}

console.log('LET OP: over 5 seconden bedient deze test muis en toetsenbord in een eigen testvenster. Raak ze niet aan tot de test klaar is. Ctrl+C breekt af.');
await new Promise((r) => setTimeout(r, 5000));

const { createApp } = await import('../../server/app.ts');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-desktop-'));
const exe = path.join(dir, 'tbtestwin.exe');

// ---------- the dedicated test window ----------
const WIN_SRC = `
using System; using System.Drawing; using System.IO; using System.Windows.Forms;
public static class TbTestWin {
  [STAThread] public static void Main(string[] args) {
    string outFile = args[0]; string title = args[1];
    Application.EnableVisualStyles();
    var f = new Form(); f.Text = title; f.Width = 540; f.Height = 340; f.TopMost = true; f.StartPosition = FormStartPosition.Manual;
    var wa = Screen.PrimaryScreen.WorkingArea; f.Left = wa.Left + (wa.Width - f.Width) / 2; f.Top = wa.Top + (wa.Height - f.Height) / 2;
    var t = new TextBox(); t.AccessibleName = "Invoer"; t.Left = 20; t.Top = 20; t.Width = 480;
    var save = new Button(); save.Text = "Opslaan"; save.Left = 20; save.Top = 60; save.Width = 140;
    var pw = new TextBox(); pw.UseSystemPasswordChar = true; pw.AccessibleName = "Wachtwoord"; pw.Left = 180; pw.Top = 62; pw.Width = 320;
    var send = new Button(); send.Text = "Verzenden"; send.Left = 20; send.Top = 100; send.Width = 140;
    var list = new ListBox(); list.AccessibleName = "Lijst"; list.Left = 20; list.Top = 140; list.Width = 220; list.Height = 120;
    for (int i = 1; i <= 60; i++) list.Items.Add("Regel " + i);
    var track = new TrackBar(); track.AccessibleName = "Schuif"; track.Left = 260; track.Top = 150; track.Width = 240; track.Minimum = 0; track.Maximum = 100; track.TickFrequency = 10;
    save.Click += (s, e) => { File.WriteAllText(outFile, t.Text + "|" + pw.Text + "|" + list.TopIndex + "|" + track.Value); f.Close(); };
    send.Click += (s, e) => { File.WriteAllText(outFile + ".sent", "verzonden"); };
    var timer = new Timer(); timer.Interval = 240000; timer.Tick += (s, e) => f.Close(); timer.Start();
    f.Controls.AddRange(new Control[] { t, save, pw, send, list, track });
    f.Shown += (s, e) => f.Activate();
    Application.Run(f);
  }
}`;
fs.writeFileSync(path.join(dir, 'win.cs'), WIN_SRC, 'utf8');
execFileSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `Add-Type -TypeDefinition ([IO.File]::ReadAllText('${path.join(dir, 'win.cs').replace(/'/g, "''")}')) -ReferencedAssemblies System.Windows.Forms,System.Drawing -OutputAssembly '${exe.replace(/'/g, "''")}' -OutputType WindowsApplication`,
  ],
  { stdio: 'inherit', timeout: 120_000 },
);
const windows = [];
function openWindow(tag) {
  const out = path.join(dir, `resultaat-${tag}.txt`);
  const title = `Bureaubladproef ${tag} ${Math.random().toString(36).slice(2, 7)}`;
  const p = spawn(exe, [out, title], { stdio: 'ignore' });
  windows.push(p);
  return { out, title, proc: p };
}

const app = await createApp({ dataDir: path.join(dir, 'data'), port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const owner = app.ctx.auth.owner();
const api = async (method, p, body) => {
  const r = await fetch(`${app.url}/api${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(j)}`);
  return j;
};
const agent = app.ctx.store.createAgent(owner.id, { name: 'Bureaubladbot', tool_groups: ['desktop'], access_mode: 'auto' });
const svc = app.ctx.services.computers._service;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};
let thread = null;
const call = async (name, args, o = {}) => {
  const th = o.sameThread && thread ? thread : app.ctx.store.createThread({ user_id: owner.id, agent_id: agent.id });
  thread = th;
  const run = app.ctx.store.createRun({ thread_id: th.id, agent_id: agent.id, user_id: owner.id, status: 'running' });
  const ac = new AbortController();
  const tc = { ctx: app.ctx, agent: app.ctx.store.agent(agent.id), thread: th, run, userId: owner.id, signal: ac.signal, toolCallId: 'live_' + Math.random().toString(36).slice(2), progress: () => {}, abort: () => ac.abort() };
  try {
    const r = await app.ctx.tools.get(name).run(args, tc);
    const out = typeof r === 'string' ? { text: r } : r;
    if (process.env.TB_DEBUG) console.log(`--- ${name} ${JSON.stringify(args)}\n${out.text}`);
    return out;
  } catch (e) {
    return { text: String(e.message), isError: true };
  } finally {
    svc.leases.releaseHolder(run.id);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pending = async (tool) => {
  for (let i = 0; i < 100; i++) {
    const a = (await api('GET', '/approvals')).find((x) => x.tool === tool && x.status === 'pending');
    if (a) return a;
    await sleep(100);
  }
  return null;
};
const waitFile = async (f, ms = 5000) => {
  for (let i = 0; i < ms / 100 && !fs.existsSync(f); i++) await sleep(100);
  return fs.existsSync(f);
};

try {
  const caps = await api('GET', '/computers/capabilities?refresh=1');
  const host = (Array.isArray(caps.caps) ? caps.caps : Object.values(caps.caps || {})).find((c) => c.id === 'host');
  check('bureaubladbediening beschikbaar op dit apparaat', host?.status === 'available', host?.detail);
  // full access within the allowlist, so the test does not wait for approvals (side effects still ask: tested below)
  await api('PUT', `/computers/${agent.id}/config`, { host_control: true, confirmHost: true, mode: 'host', host_apps: ['tbtestwin'], host_level: 'auto', host_options: { pauseOnInput: true, screen: 'apps' } });

  // =============== part 1: full-screen computer use (desktop_computer) ===============
  const B = openWindow('B');
  let shot = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    shot = await call('desktop_computer', { action: 'screenshot', elements: true });
    if (shot.text.includes(B.title) && /Edit "Invoer" @/.test(shot.text)) break;
    // visible but not active (Windows refused the focus switch): click its own title bar once
    const bar = i === 10 && shot.text.split('\n').find((l) => l.includes(B.title))?.match(/\((\d+),(\d+)\)–\((\d+),(\d+)\)/);
    if (bar) await call('desktop_computer', { action: 'left_click', coordinate: [Number(bar[1]) + 80, Number(bar[2]) + 6] });
  }
  check('schermafbeelding is een echte afbeelding voor het model', shot?.attachments?.[0]?.mime === 'image/jpeg', shot?.attachments?.[0]?.name);
  check('testvenster zichtbaar in de schermafbeelding (alleen toegestane apps)', !!shot?.text.includes(B.title), shot?.text.split('\n').slice(0, 2).join(' | '));
  check('andere vensters niet beschreven', !/msedge|chrome|explorer|TeamBot/i.test(shot?.text.split('Bedieningselementen')[0] || ''));
  const mons = await svc.screen.monitors(true);
  console.log(`  beeldschermen: ${mons.map((m) => `${m.index}:${m.w}x${m.h}@${m.x},${m.y} ${Math.round((m.dpi / 96) * 100)}%`).join('  ')}`);
  const at = (re) => {
    const m = shot.text.match(re);
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  const sliderW = Number(shot.text.match(/Slider "Schuif" @ \(\d+, \d+\) (\d+)×/)?.[1] || 0);
  const invoer = at(/Edit "Invoer" @ \((\d+), (\d+)\)/);
  const wachtwoord = at(/Edit "Wachtwoord" \(wachtwoordveld[^@]*@ \((\d+), (\d+)\)/);
  const verzenden = at(/Button "Verzenden" @ \((\d+), (\d+)\)/);
  const opslaan = at(/Button "Opslaan" @ \((\d+), (\d+)\)/);
  const regel = at(/ListItem "Regel 2" @ \((\d+), (\d+)\)/);
  const schuif = at(/Slider "Schuif" @ \((\d+), (\d+)\)/);
  check('UI Automation-elementen met coördinaten in de schermafbeelding', !!(invoer && verzenden && opslaan && regel && schuif), JSON.stringify({ invoer, wachtwoord, verzenden, opslaan, regel, schuif }));
  check('wachtwoordveld herkend en gemarkeerd', !!wachtwoord);

  let r = await call('desktop_computer', { action: 'left_click', coordinate: invoer });
  check('klik in het tekstvak (coördinaten uit de schermafbeelding)', !r.isError, r.text.split('\n')[0]);
  r = await call('desktop_computer', { action: 'type', text: 'Hallo computer' });
  check('typen', !r.isError, r.text.split('\n')[0]);
  r = await call('desktop_computer', { action: 'key', text: 'BackSpace' });
  check('toets (BackSpace, alias zoals bij Claude computer use)', !r.isError, r.text.split('\n')[0]);
  if (wachtwoord) {
    r = await call('desktop_computer', { action: 'left_click', coordinate: wachtwoord });
    r = await call('desktop_computer', { action: 'type', text: 'geheim' });
    check('typen in wachtwoordveld geweigerd', r.isError && /wachtwoord/i.test(r.text), r.text.slice(0, 120));
  }
  r = await call('desktop_computer', { action: 'scroll', coordinate: regel, scroll_direction: 'down', scroll_amount: 5 });
  check('scrollen in de lijst', !r.isError, r.text.split('\n')[0]);
  if (schuif && sliderW) {
    // thumb at value 0 sits ~6% from the left end of the track
    const half = Math.round(sliderW / 2 - sliderW * 0.06);
    r = await call('desktop_computer', { action: 'left_click_drag', start_coordinate: [schuif[0] - half, schuif[1]], coordinate: [schuif[0] + half, schuif[1]] });
    check('slepen (schuifregelaar)', !r.isError, r.text.split('\n')[0]);
  }
  r = await call('desktop_computer', { action: 'zoom', region: [Math.max(0, invoer[0] - 100), Math.max(0, invoer[1] - 30), invoer[0] + 100, invoer[1] + 30] });
  check('inzoomen geeft een afbeelding', !r.isError && r.attachments?.[0]?.mime === 'image/jpeg');

  // outside the test window: refused, nothing happens
  r = await call('desktop_computer', { action: 'left_click', coordinate: [2, 2] });
  check('klik buiten toegestane apps geweigerd', r.isError && /niet op de lijst|geen venster|nooit/i.test(r.text), r.text.slice(0, 120));

  // side effect: "Verzenden" asks even at full access; deny = nothing sent, approve = sent
  let p = call('desktop_computer', { action: 'left_click', coordinate: verzenden });
  let ap = await pending('desktop_computer');
  check('"Verzenden" vraagt altijd toestemming (risico danger)', ap?.risk === 'danger', ap?.summary?.split('\n')[0]);
  if (ap) await api('POST', `/approvals/${ap.id}`, { decision: 'deny' });
  r = await p;
  await sleep(500);
  check('geweigerd = niets verzonden', r.isError && !fs.existsSync(B.out + '.sent'));
  p = call('desktop_computer', { action: 'left_click', coordinate: verzenden });
  ap = await pending('desktop_computer');
  if (ap) await api('POST', `/approvals/${ap.id}`, { decision: 'approve' });
  r = await p;
  check('goedgekeurd = verzonden', !r.isError && (await waitFile(B.out + '.sent')), r.text.split('\n')[0]);

  // the owner moves the mouse (simulated): the bot pauses until control is handed back
  await svc.screen.driver.call('move', { x: mons[0].x + 40, y: mons[0].y + 40 });
  r = await call('desktop_computer', { action: 'left_click', coordinate: invoer });
  check('muis bewegen door de eigenaar pauzeert de bot', r.isError && /Gepauzeerd/.test(r.text), r.text.slice(0, 100));
  await api('POST', `/computers/${agent.id}/screen/resume`, {});

  // emergency stop and resume
  await api('POST', '/computers/desktop/stop', { source: 'live-test' });
  r = await call('desktop_computer', { action: 'screenshot' });
  check('noodstop: bediening gepauzeerd', r.isError && /noodstop/i.test(r.text));
  await api('POST', `/computers/${agent.id}/screen/resume`, {});

  r = await call('desktop_computer', { action: 'left_click', coordinate: opslaan });
  check('klik op Opslaan', !r.isError, r.text.split('\n')[0]);
  const gotB = (await waitFile(B.out)) ? fs.readFileSync(B.out, 'utf8') : '(geen resultaat)';
  const [txt, pw, top, val] = gotB.split('|');
  check('het venster ontving precies de getypte tekst', txt === 'Hallo compute', JSON.stringify(txt));
  check('niets in het wachtwoordveld', pw === '', JSON.stringify(pw));
  check('de lijst is gescrold', Number(top) > 0, `TopIndex ${top}`);
  if (schuif) check('de schuifregelaar is versleept', Number(val) > 30, `waarde ${val}`);
  const log = await api('GET', `/computers/${agent.id}/actions?limit=100`);
  check('stappenlog met schermbeelden', log.filter((x) => x.tool === 'desktop_computer' && x.frame).length >= 5, `${log.length} stappen`);

  // =============== part 2: window-scoped UI Automation tools (desktop_inspect/click/type/key) ===============
  if (!process.env.TB_LIVE_SKIP_UIA) {
    const A = openWindow('A');
    let list = '';
    let num = null;
    for (let i = 0; i < 40 && num === null; i++) {
      await sleep(500);
      list = (await call('desktop_windows', {})).text;
      const line = list.split('\n').find((l) => l.includes(A.title));
      const m = line?.match(/\[venster (\d+)\]/);
      if (m) num = Number(m[1]);
    }
    check('testvenster zichtbaar voor desktop_windows', num !== null, num === null ? list.slice(0, 300) : `venster ${num}`);
    if (num === null) throw new Error('testvenster A niet gevonden');
    check('TeamBot-vensters en niet-toegestane apps ontbreken in de lijst', !/TeamBot|msedge|explorer/i.test(list));
    const ins = (await call('desktop_inspect', { window: num })).text;
    const editRef = ins.split('\n').filter((l) => / Edit/.test(l) && !/wachtwoord/.test(l)).map((l) => l.match(/\[([0-9a-f]{6}\.e\d+)\]/)?.[1])[0];
    const pwRef = ins.split('\n').filter((l) => / Edit/.test(l) && /wachtwoord/.test(l)).map((l) => l.match(/\[([0-9a-f]{6}\.e\d+)\]/)?.[1])[0];
    check('klassiek wachtwoordveld herkend (ES_PASSWORD)', !!pwRef);
    const pwTry = pwRef ? (await call('desktop_type', { ref: pwRef, text: '1234' })).text : '';
    check('typen in wachtwoordveld geweigerd', /wachtwoord/i.test(pwTry), pwTry.slice(0, 100));
    const btnRef = ins.match(/\[([0-9a-f]{6}\.e\d+)\] Button "Opslaan"/)?.[1];
    check('UI Automation vindt tekstvak en knop', !!editRef && !!btnRef, `${editRef} / ${btnRef}`);
    const snap = [...(await import('../../server/modules/browser/host.ts')).desktopSnapshots.values()].pop();
    const el = snap.elements.find((e) => e.type === 'Edit' && !e.password);
    const rx = el.x - snap.window.x + Math.round(el.w / 2);
    const ry = el.y - snap.window.y + Math.round(el.h / 2);
    const c1 = await call('desktop_click', { window: num, x: rx, y: ry });
    check('echte muisklik in het tekstvak', !c1.isError, c1.text.slice(0, 120));
    const t1 = await call('desktop_type', { window: num, text: 'Hallo van de bot 123' });
    check('typen in het gefocuste veld', !t1.isError, t1.text.slice(0, 120));
    const k1 = await call('desktop_key', { window: num, keys: 'Backspace' });
    check('toets Backspace', !k1.isError, k1.text.slice(0, 120));
    const c2 = await call('desktop_click', { ref: btnRef });
    check('klik op de knop via UI Automation', !c2.isError, c2.text.slice(0, 120));
    const gotA = (await waitFile(A.out)) ? fs.readFileSync(A.out, 'utf8') : '(geen resultaat)';
    check('het venster ontving precies de getypte tekst', gotA.startsWith('Hallo van de bot 12||'), JSON.stringify(gotA));
    const after = await call('desktop_type', { window: num, text: 'x' });
    check('venster weg → actie geweigerd', after.isError && /bestaat niet|niet gevonden|opnieuw|geen venster|niet op de lijst/i.test(after.text), after.text.slice(0, 120));
  }
} catch (e) {
  check('onverwachte fout', false, e.message);
} finally {
  for (const w of windows) {
    try {
      w.kill();
    } catch {
      /* already closed */
    }
  }
  await app.close();
  await sleep(300);
  fs.rmSync(dir, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} geslaagd`);
process.exit(failed ? 1 : 0);
