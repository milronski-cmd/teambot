// Electron side of `npm run dictation:live` (bundled and started by dictation-live.mjs). Runs the real dictation
// controller (pill window + microphone, local recognition, Windows helper, clipboard + Ctrl+V) against a DEDICATED
// test window. Keys are only ever sent to this process (expectPid), the real global key is not registered (the test
// presses it in code), and the clipboard the owner had is checked to come back.
import { app, BrowserWindow, clipboard, ClipboardItem } from 'electron';
import path from 'node:path';
import { createApp } from '../../server/app.js';
import { DictationHotkey, electronClipboard } from '../../desktop/dictation.js';
import { DictationHelper } from '../../desktop/dictation-helper.js';
import { PRIVATE_FORMATS, rawType } from '../../desktop/dictation-clipboard.js';

const dir = process.env.TB_DICT_DIR!;
const wav = process.env.TB_DICT_WAV!;
const out = (o: any) => process.stdout.write('@@' + JSON.stringify(o) + '\n');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-file-for-fake-audio-capture', `${wav}%noloop`);
app.setPath('userData', path.join(dir, 'electron'));
// Diagnostics from the pill window (console + preload errors) end up in the test output.
app.on('web-contents-created', (_e, wc) => {
  wc.on('console-message', (ev: any) => out({ info: `[venster] ${ev?.message ?? ''}` }));
  wc.on('preload-error', (_ev, p, err) => out({ info: `[preload] ${p}: ${err?.message}` }));
});

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>TeamBot dicteertest</title></head>
<body style="font:14px Segoe UI;margin:12px"><div>Dicteertest (venster sluit vanzelf)</div>
<textarea id="t" style="width:95%;height:70px"></textarea><br><input id="pw" type="password" style="width:95%"></body></html>`;

async function until(fn: () => boolean | Promise<boolean>, ms: number) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
}

app.whenReady().then(async () => {
  let code = 0;
  const helper = new DictationHelper(path.join(dir, 'helper'));
  let handle: Awaited<ReturnType<typeof createApp>> | null = null;
  let d: DictationHotkey | null = null;
  try {
    handle = await createApp({ dataDir: path.join(dir, 'data'), port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
    const ctx = handle.ctx;
    ctx.auth.ensureLocalOwner();
    const owner = ctx.auth.owner()!;
    const { saveSettings } = await import('../../server/modules/voice/settings.js');
    saveSettings(ctx, owner.id, { hotkey: { enabled: true, accelerator: 'Control+Alt+Space' } });

    const win = new BrowserWindow({ width: 560, height: 220, show: false, title: 'TeamBot dicteertest', alwaysOnTop: true });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));
    win.show();
    win.focus();
    await win.webContents.executeJavaScript(`document.getElementById('t').focus()`);
    const t0 = Date.now();
    await helper.start();
    out({ info: `helper ready in ${Date.now() - t0} ms` });
    const fg = async () => (await helper.call('probe')).pid === process.pid;
    if (!(await until(fg, 3000))) {
      win.minimize();
      win.restore();
      win.focus();
    }
    const focused = await until(fg, 3000);
    out({ check: 'testvenster heeft de focus (anders wordt er niets geplakt)', ok: focused, detail: focused ? '' : JSON.stringify(await helper.call('probe')) });

    // The owner's clipboard (text + html) must come back.
    const owners = electronClipboard();
    const before = await owners.snapshot();
    if (!before.restorable) throw new Error('Op het klembord staat iets dat niet exact terug kan (bijv. gekopieerde bestanden); test niet gestart om het niet kwijt te raken.');
    const sentinel = `TB-sentinel-${Date.now()}`;
    await clipboard.write([new ClipboardItem({ 'text/plain': sentinel, 'text/html': `<b>${sentinel}</b>` })]);

    d = new DictationHotkey({ ctx: () => ctx, preload: path.join(dir, 'dictation-preload.cjs'), helperDir: path.join(dir, 'helper'), expectPid: process.pid, noGlobalKey: true });
    d.start();
    out({ check: 'sneltoets aan (status)', ok: d.status().enabled && d.status().registered, detail: JSON.stringify(d.status()) });

    // 1. Dictate: tap (the helper sees the key is up → hands-free), talk, tap again.
    const tPress = Date.now();
    d.press();
    const rec = await until(() => d!.phase === 'recording', 10_000);
    out({ check: 'microfoon open na de sneltoets', ok: rec, detail: `${Date.now() - tPress} ms (incl. model laden)` });
    const wavSec = Number(process.env.TB_DICT_WAV_SEC || 5);
    await sleep(wavSec * 1000 + 300);
    const tStop = Date.now();
    d.press();
    const done = await until(async () => (await win.webContents.executeJavaScript(`document.getElementById('t').value`)).length > 5, 10_000);
    const text = await win.webContents.executeJavaScript(`document.getElementById('t').value`);
    out({ check: 'tekst geplakt in het testvenster', ok: done && focused, detail: `${Date.now() - tStop} ms na stoppen: “${text}”`, text });
    await until(() => d!.phase === 'idle', 5000);
    await sleep(300);
    const back = await clipboard.readText();
    const html = (await clipboard.read())[0];
    const htmlText = html?.types.includes('text/html') ? await (await html.getType('text/html') as Blob).text() : '';
    out({ check: 'klembord teruggezet (tekst + opmaak)', ok: back === sentinel && htmlText.includes(sentinel), detail: `${back.slice(0, 40)} | ${htmlText.slice(0, 60)}` });
    const hidden = PRIVATE_FORMATS.every((f) => html?.types.includes(rawType(f)));
    out({ check: 'teruggezet zonder nieuw item in de klembordgeschiedenis (Win+V) of de cloud', ok: hidden, detail: html?.types.join(', ') });

    // 2. Esc throws it away.
    d.press();
    await until(() => d!.phase === 'recording', 5000);
    await sleep(800);
    d.escape();
    await sleep(800);
    const after = await win.webContents.executeJavaScript(`document.getElementById('t').value`);
    out({ check: 'Esc: niets geplakt', ok: d.phase === 'idle' && after === text });

    // 3. Password field: refused before the microphone opens.
    await win.webContents.executeJavaScript(`document.getElementById('pw').focus()`);
    await sleep(300);
    const probe = await helper.call('probe');
    await sleep(400);
    d.press();
    await sleep(1500);
    const pw = await win.webContents.executeJavaScript(`document.getElementById('pw').value`);
    out({ check: 'wachtwoordveld herkend door de hulp (UI Automation/MSAA, zoals in andere Chromium-apps)', ok: !!probe.password, detail: JSON.stringify(probe) });
    out({ check: 'wachtwoordveld: niet gedicteerd', ok: d.phase !== 'recording' && pw === '' });

    // Put the owner's clipboard back exactly as it was before the test.
    await owners.restore(before);
    win.destroy();
  } catch (e: any) {
    out({ check: 'onverwachte fout', ok: false, detail: String(e?.stack || e) });
    code = 1;
  } finally {
    d?.stop();
    helper.kill();
    await Promise.race([handle?.close().catch(() => {}), sleep(4000)]);
    out({ end: true });
    app.exit(code);
  }
});

