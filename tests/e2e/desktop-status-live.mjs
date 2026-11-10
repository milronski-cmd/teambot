// LIVE check of the desktop shell's notifications and floating status window (Windows), in a temporary data folder.
// Starts the real Electron app (a window and a tray icon appear for ~20 seconds), with a fake OpenAI-compatible model:
//   - Settings › floating status window "always" (via the same IPC as the UI) → the status window opens;
//   - a bot in "vraagt toestemming" wants to write a file → a Windows notification with Goedkeuren / Weigeren /
//     Bekijken appears and the status window lists it; pressing "Weigeren" (simulated button event) is the owner's
//     decision: the approval is denied and no file is written;
//   - mode "auto" hides the window again once nothing runs or waits.
// Usage: npm run build && npm run desktop:status
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _electron } = require('playwright-core');
const root = process.cwd();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-desktop-status-'));
// Fake OpenAI-compatible model: the first turn wants to write a file (needs approval in "ask" mode), then answers.
const model = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'nep-model' }] }));
    const j = JSON.parse(body || '{}');
    // A tool result last: answer; a new message from the owner: want to write a file again.
    const after = (j.messages || []).at(-1)?.role === 'tool';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (!after) {
      send({ id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'eiland.txt', content: 'x' }) } }] } }] });
      send({ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    } else {
      send({ id: 'c2', choices: [{ index: 0, delta: { content: 'Begrepen.' } }] });
      send({ id: 'c2', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 2 } });
    }
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((r) => model.listen(0, '127.0.0.1', r));
const modelUrl = `http://127.0.0.1:${model.address().port}/v1`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(!!ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const until = async (fn, ms = 15_000) => {
  const t = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t > ms) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
};

const app = await _electron.launch({ executablePath: require('electron'), args: [root], cwd: root, env: { ...process.env, TEAMBOT_DATA: dataDir, APPDATA: dataDir, TEAMBOT_PORT: '0' } });
try {
  // The first window can be the start page (a data: URL) until the server is up: wait for the app itself.
  await app.firstWindow();
  const main = await until(async () => app.windows().find((w) => /^https?:/.test(w.url())), 60_000);
  if (!main) throw new Error('het hoofdvenster van TeamBot kwam niet');
  await main.waitForFunction(() => !!window.teambotDesktop && !!localStorage.getItem('tb_token'), null, { timeout: 30_000 });
  check('desktop-app start in een tijdelijke datamap', true, dataDir);
  check('preload meldt eigen Windows-meldingen (geen dubbele webmeldingen)', await main.evaluate(() => window.teambotDesktop.nativeNotifications === true));
  const base = new URL(main.url()).origin;
  const token = await main.evaluate(() => localStorage.getItem('tb_token'));
  const api = async (method, p, body) => {
    const r = await fetch(base + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return r.json();
  };
  // Record notifications the main process shows (the real ones still appear on screen).
  await app.evaluate(({ Notification }) => {
    globalThis.__notes = [];
    const show = Notification.prototype.show;
    Notification.prototype.show = function () {
      globalThis.__notes.push(this);
      return show.call(this);
    };
    const close = Notification.prototype.close;
    Notification.prototype.close = function () {
      this.__closed = true;
      return close.call(this);
    };
  });

  // 1. Status window via the same IPC as Settings › Limieten.
  const set = await main.evaluate(() => window.teambotDesktop.statusWindow.set('always'));
  check('statusvenster aanzetten via IPC', set?.mode === 'always');
  const island = await until(async () => app.windows().find((w) => w.url().includes('#/m/usage/eiland')));
  check('zwevend statusvenster geopend', !!island);
  const props = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('#/m/usage/eiland'));
    return w ? { onTop: w.isAlwaysOnTop(), visible: w.isVisible(), taskbar: false, bounds: w.getBounds() } : null;
  });
  check('statusvenster staat altijd bovenop en is zichtbaar', props?.onTop && props?.visible, JSON.stringify(props?.bounds));
  await island.waitForSelector('text=Alles rustig', { timeout: 10_000 });
  check('statusvenster toont "Alles rustig" zonder werk', true);

  // 2. A bot asks permission while TeamBot is in the background → notification with buttons.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('eiland'))?.hide());
  const p = await api('POST', '/providers', { kind: 'openai-compatible', name: 'Nep-model', base_url: modelUrl });
  const a = await api('POST', '/agents', { name: 'Schrijver', provider_id: p.id, model: 'nep-model', access_mode: 'ask' });
  const th = await api('POST', '/threads', { agentId: a.id });
  await api('POST', `/threads/${th.id}/messages`, { content: 'Schrijf een bestand' });
  const note = await until(() => app.evaluate(() => globalThis.__notes.map((n) => ({ title: n.title, body: n.body, actions: (n.actions || []).map((x) => x.text) })).find((n) => /toestemming/.test(n.title))));
  check('Windows-melding bij een goedkeuring', !!note, note ? `"${note.title}"` : 'geen melding');
  check('melding heeft knoppen Goedkeuren / Weigeren / Bekijken', JSON.stringify(note?.actions) === JSON.stringify(['Goedkeuren', 'Weigeren', 'Bekijken']), JSON.stringify(note?.actions));
  const listed = await until(() => island.locator('text=Wacht op jou').count());
  check('statusvenster toont wat op je wacht', !!listed);

  // 3. "Weigeren" on the notification is the owner's decision and reaches the bot.
  await app.evaluate(() => {
    const n = globalThis.__notes.find((x) => /toestemming/.test(x.title));
    n.emit('action', { actionIndex: 1, selectionIndex: -1 }, 1, -1);
  });
  const denied = await until(async () => (await api('GET', '/approvals?status=all')).find((x) => x.status === 'denied'), 20_000);
  check('"Weigeren" in de melding is de beslissing van de eigenaar (verzoek geweigerd)', !!denied, denied ? `beslist door ${denied.decided_by}` : '');
  const finished = await until(async () => ((await api('GET', '/runs')).length === 0 ? true : null), 20_000);
  check('de bot gaat verder en is klaar; niets meer in afwachting', finished && (await api('GET', '/approvals')).length === 0);
  check('het bestand is niet geschreven', !fs.existsSync(path.join(a.workspace, 'eiland.txt')));

  // 3b. Decided elsewhere (the phone, another window: here the API, as the phone uses it) → the notification goes away.
  const before = await app.evaluate(() => globalThis.__notes.length);
  await api('POST', `/threads/${th.id}/messages`, { content: 'Schrijf het bestand toch' });
  const second = await until(() => app.evaluate((n) => globalThis.__notes.slice(n).some((x) => /toestemming/.test(x.title)), before));
  check('nieuwe Windows-melding bij een tweede goedkeuring', !!second);
  const pending = await until(async () => (await api('GET', '/approvals'))[0]);
  const open = await app.evaluate((n) => globalThis.__notes.slice(n).filter((x) => /toestemming/.test(x.title)).map((x) => !!x.__closed), before);
  check('melding blijft staan zolang het verzoek wacht (één open melding)', open.filter((c) => !c).length === 1, JSON.stringify(open));
  await api('POST', `/approvals/${pending.id}`, { decision: 'approve' });
  const gone = await until(() => app.evaluate((n) => globalThis.__notes.slice(n).filter((x) => /toestemming/.test(x.title)).every((x) => x.__closed === true) || null, before), 10_000);
  check('elders goedgekeurd: de Windows-melding verdwijnt', !!gone);
  await until(async () => ((await api('GET', '/runs')).length === 0 ? true : null), 20_000);

  // 4. Mode "auto": nothing runs or waits → the window goes away by itself.
  await main.evaluate(() => window.teambotDesktop.statusWindow.set('auto'));
  const hidden = await until(() => app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('#/m/usage/eiland'));
    return !w || !w.isVisible();
  }), 15_000);
  check('modus "alleen als er iets loopt": venster verdwijnt als alles klaar is', !!hidden);
} catch (e) {
  check('onverwachte fout', false, e.message);
} finally {
  await app.close().catch(() => {});
  model.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} geslaagd`);
process.exit(failed ? 1 : 0);
