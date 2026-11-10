// Electron side of tests/e2e/status-check.mjs (B-69, B-67). Runs the real floating status window (desktop/status.ts)
// with Electron, TeamBot's server and the built UI, in a TEMPORARY data folder (TEAMBOT_DATA), with fake engines.
// Nothing reaches the owner's desktop: no main window and no tray icon; the status window is fully transparent,
// click-through and never focused (it is captured with webContents.capturePage(), not from the screen), and Windows
// notifications are recorded instead of shown. Buttons in the window are pressed in the page itself, never with the
// mouse or keyboard.
import { app, BrowserWindow, ipcMain, Notification } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../../server/app.js';
import { DesktopStatus } from '../../desktop/status.js';
import { captureWithRetry } from './capture-retry.js';

const dir = process.env.TEAMBOT_DATA!;
const shots = process.env.TB_STATUS_SHOTS || '';
const preload = process.env.TB_STATUS_PRELOAD!;
const out = (o: any) => process.stdout.write('@@' + JSON.stringify(o) + '\n');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
app.setPath('userData', path.join(dir, 'electron'));
// A window behind others (or transparent) keeps painting, so capturePage sees the live page.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
// Closing the sign-in window or hiding the status window must not end the check (Electron quits when none are left).
app.on('window-all-closed', () => {});

// The status window appears (showInactive), but invisible and click-through on this PC: it may be in use.
let shown = 0;
const showInactive = BrowserWindow.prototype.showInactive;
BrowserWindow.prototype.showInactive = function (this: BrowserWindow) {
  shown++;
  this.setOpacity(0);
  this.setIgnoreMouseEvents(true);
  this.setFocusable(false);
  return showInactive.call(this);
};
// Windows notifications (B-67): recorded with their buttons, never a real toast.
const toasts: Notification[] = [];
Notification.prototype.show = function (this: Notification) {
  toasts.push(this);
};

app.whenReady().then(async () => {
  let code = 0;
  const check = (name: string, ok: boolean, detail = '') => {
    if (!ok) code = 1;
    out({ check: name, ok, detail });
  };
  const handle = await createApp({ dataDir: path.join(dir, 'data'), mode: 'desktop', host: '127.0.0.1', port: 0, quiet: true });
  const ctx = handle.ctx;
  const token = ctx.auth.ensureLocalOwner();
  const owner = ctx.auth.owner()!;
  const shows: (string | undefined)[] = [];
  const status = new DesktopStatus({
    handle: () => handle,
    baseUrl: () => handle.url,
    icon: () => '',
    preload,
    show: (hash) => shows.push(hash),
    isAppUrl: (u) => {
      try {
        return new URL(u).origin === new URL(handle.url).origin;
      } catch {
        return false;
      }
    },
    mainFocused: () => false,
    onModeChange: () => {},
  });
  // The same bridge handlers as the desktop app (desktop/main.ts), for the window's own buttons.
  ipcMain.handle('teambot:show', (_e, hash?: string) => (shows.push(hash), true));
  ipcMain.handle('teambot:status:get', () => ({ mode: status.mode() }));
  ipcMain.handle('teambot:status:set', (_e, m: string) => ({ mode: status.setMode(m) }));
  ipcMain.handle('teambot:status:hide', () => (status.hide(), true));
  const win = () => (status as any).win as BrowserWindow | null;
  const visible = () => !!win() && !win()!.isDestroyed() && win()!.isVisible();
  const page = async () => (visible() ? String(await win()!.webContents.executeJavaScript('document.body.innerText')) : '');
  const until = async (fn: () => Promise<boolean> | boolean, ms = 15_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await fn()) return true;
      await sleep(150);
    }
    return false;
  };
  const shot = async (name: string) => {
    if (!shots || !visible()) return;
    await sleep(500);
    const img = await captureWithRetry(() => win()!.webContents.capturePage(), {
      onRetry: (n) => out({ note: `schermafdruk ${name}: UnknownVizError (GPU startte nog), opnieuw (${n})` }),
    });
    fs.writeFileSync(path.join(shots, `${name}.png`), img.toPNG());
    out({ note: `schermafdruk ${name}.png (${img.getSize().width}×${img.getSize().height})` });
  };
  const click = (text: string) =>
    win()!.webContents.executeJavaScript(
      `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`,
    );

  try {
    // ---- fake engines: a CLI bot that reports its steps, an API bot that asks before it writes ----
    let cliStep: (() => void) | null = null;
    ctx.providers.registerKind({
      id: 'statuscli',
      label: 'Nep-CLI',
      type: 'cli',
      needsKey: false,
      description: 'test',
      models: ['c-1'],
      defaultModel: 'c-1',
      create: () => ({
        kind: 'statuscli',
        async listModels() {
          return [{ id: 'c-1' }];
        },
        async test() {
          return { ok: true, detail: 'ok' };
        },
        async runAgent(req, signal, onEvent) {
          onEvent({ type: 'activity', item: { kind: 'files', title: 'Leest notities.md', ts: new Date().toISOString() } });
          await new Promise<void>((r) => (cliStep = r));
          onEvent({ type: 'activity', item: { kind: 'files', title: 'Schrijft verslag.md', ts: new Date().toISOString() } });
          await sleep(1500);
          if (signal.aborted) throw new Error('Gestopt');
          onEvent({ type: 'text', delta: 'Het verslag staat klaar.' });
          return { text: 'Het verslag staat klaar.', usage: { input: 1, output: 1, cost: 0 } };
        },
      }),
    });
    const apiSteps: any[] = [];
    ctx.providers.registerKind({
      id: 'statusapi',
      label: 'Nep-API',
      type: 'api',
      needsKey: false,
      description: 'test',
      models: ['a-1'],
      defaultModel: 'a-1',
      create: () => ({
        kind: 'statusapi',
        async listModels() {
          return [{ id: 'a-1' }];
        },
        async test() {
          return { ok: true, detail: 'ok' };
        },
        async chat(req: any, _signal: AbortSignal, onEvent: any) {
          const s = apiSteps.shift() || { text: 'Klaar.' };
          if (s.text) onEvent({ type: 'text', delta: s.text });
          const toolCalls = (s.toolCalls || []).map((c: any, i: number) => ({ id: `c${Date.now()}${i}`, name: c.name, args: c.args }));
          return { text: s.text || '', toolCalls, usage: { input: 1, output: 1 }, stop: toolCalls.length ? 'tool_use' : 'end', model: req.model };
        },
      }),
    });
    const cliP = ctx.providers.create(owner.id, { kind: 'statuscli', name: 'Nep-CLI' });
    const apiP = ctx.providers.create(owner.id, { kind: 'statusapi', name: 'Nep-API' });
    const schrijver = ctx.store.createAgent(owner.id, { name: 'Schrijver', provider_id: cliP.id, model: 'c-1', access_mode: 'auto' });
    const planner = ctx.store.createAgent(owner.id, { name: 'Planner', provider_id: apiP.id, model: 'a-1', access_mode: 'ask', tool_groups: ['files'] });
    const thS = ctx.store.createThread({ user_id: owner.id, agent_id: schrijver.id, kind: 'chat' });
    const thP = ctx.store.createThread({ user_id: owner.id, agent_id: planner.id, kind: 'chat' });
    const say = (t: any, text: string) => ctx.chat.postUserMessage({ thread: t, user: owner, content: text });

    // The page in the status window signs in like the main window does: with the token, once, in this session.
    const login = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, sandbox: true } });
    await login.loadURL(`${handle.url}/#token=${encodeURIComponent(token)}`);
    await sleep(800);
    login.destroy();

    // ---- auto: nothing to show while idle ----
    ctx.store.setSetting(owner.id, 'desktopStatusWindow', 'auto');
    ctx.store.setSetting(owner.id, 'onboarded', true);
    status.start();
    await sleep(1200);
    check('auto: geen venster zolang er niets loopt', !visible() && shown === 0);

    // ---- a bot at work: the window appears with its face, name and what it does, live ----
    await say(thS, 'Schrijf het verslag.');
    check('auto: het venster verschijnt als een bot werkt (zonder focus te pakken)', await until(() => visible() && shown > 0), `zichtbaar=${visible()} getoond=${shown}`);
    const first = await until(async () => /Schrijver/.test(await page()) && /Leest notities\.md/.test(await page()));
    check('toont de bot met wat hij doet ("Leest notities.md")', first, (await page()).slice(0, 300));
    const faces = await win()!.webContents.executeJavaScript(`document.querySelectorAll('section[aria-label="Aan het werk"] li svg').length`);
    check('met het gezicht van de bot', faces > 0, `svg's: ${faces}`);
    check('telt mee in de kop ("1 bot aan het werk")', /1 bot aan het werk/.test(await page()), (await page()).slice(0, 120));
    await shot('f2-status-1-werkt');
    (cliStep as (() => void) | null)?.();
    check('werkt live bij ("Schrijft verslag.md")', await until(async () => /Schrijft verslag\.md/.test(await page()), 10_000), (await page()).slice(0, 300));
    await shot('f2-status-2-live');

    // ---- an approval: shown with the bot's face, approved from the window; a Windows notification is asked for ----
    apiSteps.push({ toolCalls: [{ name: 'write_file', args: { path: 'planning.md', content: 'Maandag: overleg' } }] }, { text: 'De planning staat klaar.' });
    const before = toasts.length;
    await say(thP, 'Maak de planning.');
    check('wacht op jou: in het venster met naam en wat de bot wil', await until(async () => /Wacht op jou/i.test(await page()) && /Planner/.test(await page()) && /planning\.md/.test(await page())), (await page()).slice(0, 300));
    check('wacht op jou: telt in de kop ("1 wacht op jou")', /1 wacht op jou/.test(await page()));
    await shot('f2-status-3-wacht');
    const toast = toasts.slice(before).find((n: any) => /Planner/.test(n.title));
    const acts = ((toast as any)?.actions || []).map((a: any) => a.text);
    check('B-67: Windows-melding gevraagd voor de goedkeuring (niet echt getoond)', !!toast, toasts.map((n: any) => n.title).join(' | '));
    check('B-67: met de knoppen Goedkeuren / Weigeren / Bekijken', acts.join(',') === 'Goedkeuren,Weigeren,Bekijken', acts.join(','));
    const apr1 = ctx.store.one<any>("SELECT id FROM approvals WHERE status = 'pending' AND agent_id = ?", planner.id);
    check('goedkeuren vanuit het statusvenster', !!(await click('Goedkeuren')) && (await until(() => ctx.store.get<any>('approvals', apr1?.id)?.status === 'approved')));
    check('de bot gaat verder en schrijft', await until(() => fs.existsSync(path.join(planner.workspace, 'planning.md'))));

    // ---- a second approval, decided from the Windows notification's button ----
    apiSteps.push({ toolCalls: [{ name: 'write_file', args: { path: 'lijst.md', content: 'Koffie' } }] }, { text: 'De lijst staat klaar.' });
    const before2 = toasts.length;
    await say(thP, 'Maak ook een boodschappenlijst.');
    await until(() => toasts.length > before2);
    const toast2 = toasts.slice(before2).find((n: any) => /Planner/.test(n.title));
    const apr2 = ctx.store.one<any>("SELECT id FROM approvals WHERE status = 'pending' AND agent_id = ?", planner.id);
    (toast2 as any)?.emit('action', { actionIndex: 0 }, 0);
    check('B-67: "Goedkeuren" in de Windows-melding keurt goed', !!apr2 && (await until(() => ctx.store.get<any>('approvals', apr2.id)?.status === 'approved')));

    // ---- a question with choices, answered in the window ----
    apiSteps.push({ toolCalls: [{ name: 'ask_user', args: { question: 'Welke dag wordt het overleg?', options: ['Maandag', 'Dinsdag'] } }] }, { text: 'Dinsdag dus.' });
    await say(thP, 'Plan het overleg.');
    check('vraag: met de keuzes in het venster', await until(async () => /Welke dag/.test(await page()) && /Dinsdag/.test(await page())), (await page()).slice(0, 300));
    await shot('f2-status-4-vraag');
    const covered = await win()!.webContents.executeJavaScript(`document.querySelector('[aria-live="polite"]')?.children.length || 0`);
    check('geen meldingen (toasts) over de kaarten in het kleine venster', covered === 0, `toasts: ${covered}`);
    const q = ctx.store.one<any>("SELECT id FROM approvals WHERE status = 'pending' AND kind = 'question'");
    await click('Dinsdag');
    check('vraag: beantwoord met een klik in het venster', await until(() => /Dinsdag/.test(String(ctx.store.get<any>('approvals', q?.id)?.answer || ''))));

    // ---- everything done: new answers shown for a moment, then the window goes away by itself ----
    await until(() => !ctx.runs.activeRuns(owner.id).length, 15_000);
    check('klaar: "Nieuw voor jou" met wat de bots antwoordden', await until(async () => /Nieuw voor jou/i.test(await page()) && /verslag staat klaar/.test(await page()), 4000), (await page()).slice(0, 300));
    await shot('f2-status-5-klaar');
    check('auto: verbergt zichzelf als alles rustig is', await until(() => !visible(), 12_000));

    // ---- the window's own close button and "uit" ----
    apiSteps.push({ text: 'Nog iets.' });
    ctx.store.setSetting(owner.id, 'desktopStatusWindow', 'always');
    status.setMode('always');
    check('altijd: blijft zichtbaar, ook zonder werk', await until(() => visible(), 8000));
    await until(async () => /Alles rustig|Nieuw voor jou/i.test(await page()), 6000);
    await win()!.webContents.executeJavaScript(`document.querySelector('[aria-label="Statusvenster verbergen"]').click()`);
    check('de sluitknop van het venster verbergt het', await until(() => !visible(), 5000));
    status.setMode('off');
    await sleep(800);
    check('uit: geen venster meer', !win());
    check('nooit het hoofdvenster naar voren gehaald zonder klik', shows.length === 0, JSON.stringify(shows));
  } catch (e: any) {
    check('onverwachte fout', false, String(e?.stack || e));
  } finally {
    status.stop();
    await handle.close().catch(() => {});
    app.exit(code);
  }
});
