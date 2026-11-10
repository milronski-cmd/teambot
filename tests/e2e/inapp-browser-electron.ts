// Electron side of tests/e2e/inapp-browser.mjs: the bots' own browsers INSIDE TeamBot (desktop/inapp-browser.ts) with
// real Electron, a temporary data folder and a local test site. Every check runs through the real tools, routes and
// the live view; nothing may appear on the screen (no visible window at any moment). Then the full browser-panel flow
// (tests/e2e/browser-dock.mjs: live view, "Neem over", typing, vault login, phone sheet) runs again on this engine.
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { setInAppBrowserHost } from '../../server/modules/browser/inapp.js';
import { createInAppBrowserHost } from '../../desktop/inapp-browser.js';
import type { ComputerService } from '../../server/modules/browser/service.js';

const dir = process.env.TB_INAPP_DIR!;
const out = (o: any) => process.stdout.write('@@' + JSON.stringify(o) + '\n');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
app.setPath('userData', path.join(dir, 'electron'));
// a TeamBot that is already installed may be running: this test is a separate app
app.setName('TeamBot-inapp-test');
// like the real app (desktop/main.ts): closing the last bot tab does not quit
app.on('window-all-closed', () => {});

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  out({ check: name, ok, detail: String(detail).slice(0, 400) });
};
/** Nothing of the bots may be on the screen: every window that exists is invisible (and offscreen). */
const visibleWindows = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isVisible()).length;
let everVisible = 0;
const watcher = setInterval(() => (everVisible = Math.max(everVisible, visibleWindows())), 50);

const COLORS: Record<string, string> = { '/rood': '#dc2626', '/blauw': '#2563eb' };
const site = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    if (url.pathname === '/upload' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><title>Ontvangen</title><p id=r>${body.includes('werkplek-bestand') ? 'bestand ontvangen' : 'leeg'}</p>`);
    }
    if (url.pathname === '/file.txt') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="rapport.txt"' });
      return res.end('inhoud van het rapport');
    }
    if (url.pathname === '/cookie') {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': `bot=${url.searchParams.get('v')}; Path=/; Max-Age=3600` });
      return res.end('<!doctype html><title>Koekje</title>ok');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (COLORS[url.pathname]) return res.end(`<!doctype html><title>Kleur</title><body style="margin:0;height:100vh;background:${COLORS[url.pathname]}"></body>`);
    if (url.pathname === '/form')
      return res.end(`<!doctype html><html lang="nl"><head><title>Formulier</title></head><body>
        <h1>Bestelling</h1>
        <label for="n">Naam</label><input id="n" name="naam">
        <label for="k">Kleur</label><select id="k"><option value="r">Rood</option><option value="g">Groen</option></select>
        <button id="b" type="button" onclick="document.getElementById('o').textContent='Gedrukt: '+document.getElementById('n').value+' / '+document.getElementById('k').value">Toon</button>
        <p id="o"></p>
        <a href="/rood" target="_blank">Nieuw venster</a>
        <button id="al" type="button" onclick="alert('hallo'); document.getElementById('o').textContent='na alert'">Melding</button>
        <a href="/file.txt">Rapport downloaden</a>
        <form method="post" action="/upload" enctype="multipart/form-data"><label for="f">Bestand</label><input id="f" type="file" name="f"></form>
      </body></html>`);
    res.end(`<!doctype html><html lang="nl"><head><title>Startpagina</title></head><body><h1>Hallo bot</h1><p>Een rustige pagina.</p></body></html>`);
  });
});

async function focused() {
  const { createApp } = await import('../../server/app.js');
  await new Promise<void>((r) => site.listen(4873, '127.0.0.1', () => r()));
  const base = 'http://127.0.0.1:4873';
  const data = path.join(dir, 'data');
  const h = await createApp({ dataDir: data, port: 4872, host: '127.0.0.1', mode: 'desktop', quiet: true });
  try {
    const ctx = h.ctx;
    const token = ctx.auth.ensureLocalOwner();
    const owner = ctx.auth.owner()!;
    const call = async (method: string, p: string, body?: any) => {
      const r = await fetch(h.url + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${j.error || ''}`);
      return j;
    };
    const caps = await call('GET', '/computers/capabilities');
    const bcap = caps.caps.find((c: any) => c.id === 'browser');
    check('eigen browser per bot is er meteen (ingebouwd, geen Edge/Chrome nodig)', bcap?.status === 'available' && /Ingebouwd/.test(bcap.detail) && caps.engine?.app === true && caps.engine.choice === 'app', JSON.stringify({ bcap, engine: caps.engine }));
    const svc: ComputerService = ctx.services.computers._service;
    const mk = async (name: string) => {
      const a = ctx.store.createAgent(owner.id, { name, tool_groups: ['files'], access_mode: 'auto' });
      await call('PUT', `/computers/${a.id}/config`, { mode: 'browser', allow_private: true });
      return ctx.store.agent(a.id)!;
    };
    const bot = await mk('Mila');
    const bot2 = await mk('Noor');
    const th = ctx.store.createThread({ user_id: owner.id, agent_id: bot.id, kind: 'chat' });
    let n = 0;
    const tool = async (agent: any, name: string, args: any) => {
      const run = ctx.store.createRun({ thread_id: th.id, agent_id: agent.id, user_id: owner.id, status: 'running' });
      const r: any = await ctx.tools.get(name)!.run(args, { ctx, agent: ctx.store.agent(agent.id)!, thread: ctx.store.thread(th.id)!, run, userId: owner.id, signal: new AbortController().signal, toolCallId: 'e2e' + ++n, progress: () => {}, approved: true } as any);
      svc.leases.releaseHolder(run.id);
      return typeof r === 'string' ? { text: r } : r;
    };

    const t0 = Date.now();
    let r = await tool(bot, 'browser_open', { url: base + '/' });
    const s = svc.sessionOf(bot);
    check('browser_open: pagina geopend in de ingebouwde browser', !r.isError && /Hallo bot/.test(r.text) && s?.engine === 'app', `${Date.now() - t0} ms; ${r.text.slice(0, 160)}`);
    check('niets op het scherm: geen zichtbaar venster', visibleWindows() === 0);
    r = await tool(bot, 'browser_navigate', { url: base + '/form' });
    const ref = (label: string) => r.text.match(new RegExp(`\\[(e\\d+)\\][^\\n]*${label}`))?.[1] || r.text.match(new RegExp(`${label}[^\\n]*\\[(e\\d+)\\]`))?.[1];
    const naam = ref('Naam');
    const kleur = ref('Kleur');
    const toon = ref('Toon');
    check('browser_snapshot: velden met referenties', !!(naam && kleur && toon), r.text.slice(0, 600));
    r = await tool(bot, 'browser_type', { ref: naam, text: 'Sanne' });
    check('browser_type', !r.isError, r.text.slice(0, 120));
    r = await tool(bot, 'browser_select', { ref: kleur, values: ['Groen'] });
    check('browser_select', !r.isError && /g/.test(r.text), r.text.slice(0, 120));
    r = await tool(bot, 'browser_click', { ref: toon });
    r = await tool(bot, 'browser_snapshot', { mode: 'text' });
    check('browser_click: de knop werkte (typen + kiezen + klikken)', /Gedrukt: Sanne \/ g/.test(r.text), r.text.slice(0, 300));
    r = await tool(bot, 'browser_press', { key: 'Tab' });
    check('browser_press', !r.isError, r.text.slice(0, 100));
    r = await tool(bot, 'browser_scroll', { direction: 'down', amount: 200 });
    check('browser_scroll', !r.isError, r.text.slice(0, 100));
    // a JavaScript dialog: no window on the screen, the page goes on
    r = await tool(bot, 'browser_snapshot', {});
    const melding = ref('Melding');
    r = await tool(bot, 'browser_click', { ref: melding });
    await sleep(300);
    r = await tool(bot, 'browser_snapshot', { mode: 'text' });
    check('alert(): geen venster, de pagina loopt door', /na alert/.test(r.text) && visibleWindows() === 0, r.text.slice(0, 200));
    // target=_blank: a new tab of the same browser
    r = await tool(bot, 'browser_snapshot', {});
    const nieuw = ref('Nieuw venster');
    await tool(bot, 'browser_click', { ref: nieuw });
    await sleep(800);
    r = await tool(bot, 'browser_tabs', { action: 'list' });
    check('nieuw venster van een pagina wordt een tabblad (onzichtbaar)', s!.pages().length === 2 && /\/rood/.test(r.text) && visibleWindows() === 0, r.text);
    r = await tool(bot, 'browser_tabs', { action: 'close', index: 1 });
    check('browser_tabs close', s!.pages().length === 1, r.text);
    r = await tool(bot, 'browser_screenshot', {});
    check('browser_screenshot', !r.isError && (r.attachments || []).length === 1, r.text.slice(0, 100));
    // a download through the browser (link without an address the tool can fetch itself: the button path)
    r = await tool(bot, 'browser_snapshot', {});
    const dl = ref('Rapport downloaden');
    r = await tool(bot, 'browser_download', { ref: dl });
    const dlFile = path.join(ctx.store.agent(bot.id)!.workspace, 'downloads', 'rapport.txt');
    check('browser_download: bestand in de werkmap, geen opslaan-venster', !r.isError && fs.existsSync(dlFile) && visibleWindows() === 0, r.text.slice(0, 160));
    // upload a file from the bot's folder (no file picker on the screen)
    fs.writeFileSync(path.join(ctx.store.agent(bot.id)!.workspace, 'notitie.txt'), 'werkplek-bestand');
    r = await tool(bot, 'browser_snapshot', {});
    const up = ref('Bestand');
    r = await tool(bot, 'browser_upload', { ref: up, path: 'notitie.txt' });
    const val = await s!.active.evaluate(`document.getElementById('f').files[0]?.name || ''`);
    check('browser_upload: bestand gekozen zonder bestandsvenster', !r.isError && val === 'notitie.txt' && visibleWindows() === 0, `${r.text.slice(0, 120)} → ${val}`);

    // live view: frame.jpg and the MJPEG stream show this page
    await tool(bot, 'browser_navigate', { url: base + '/rood' });
    const frameRes = await fetch(`${h.url}/api/computers/${bot.id}/frame.jpg`, { headers: { authorization: `Bearer ${token}` } });
    const frame = Buffer.from(await frameRes.arrayBuffer());
    check('live beeld: frame.jpg', frameRes.ok && frame.length > 1000 && frame[0] === 0xff && frame[1] === 0xd8, `${frameRes.status} ${frame.length} bytes`);
    const frames: Buffer[] = [];
    const unsub = s!.subscribe((b) => frames.push(b));
    await sleep(400);
    await tool(bot, 'browser_navigate', { url: base + '/blauw' });
    await sleep(1200);
    unsub();
    const { nativeImage } = await import('electron');
    const colorOf = (b: Buffer) => {
      const img = nativeImage.createFromBuffer(b);
      const { width, height } = img.getSize();
      const px = img.crop({ x: width - 40, y: height - 40, width: 1, height: 1 }).toBitmap();
      // BGRA
      return { r: px[2], g: px[1], b: px[0] };
    };
    const last = frames.length ? colorOf(frames[frames.length - 1]) : null;
    check('live beeld volgt de bot (stream, laatste beeld is de blauwe pagina)', frames.length >= 2 && !!last && last.b > 180 && last.r < 90, `${frames.length} beelden, laatste ${JSON.stringify(last)}`);

    // takeover through the live view: the owner clicks and types in the invisible tab
    await call('POST', `/computers/${bot.id}/takeover`, {});
    await call('POST', `/computers/${bot.id}/input`, { type: 'navigate', url: base + '/form' });
    await sleep(500);
    const box: any = await s!.active.evaluate(`(() => { const r = document.getElementById('n').getBoundingClientRect(); return { x: (r.x + r.width / 2) / innerWidth, y: (r.y + r.height / 2) / innerHeight }; })()`);
    await call('POST', `/computers/${bot.id}/input`, { type: 'click', x: box.x, y: box.y });
    await call('POST', `/computers/${bot.id}/input`, { type: 'type', text: 'Overgenomen' });
    const typed = await s!.active.evaluate(`document.getElementById('n').value`);
    check('"Neem over" via het live beeld: klikken en typen werken', typed === 'Overgenomen' && visibleWindows() === 0, String(typed));
    await call('POST', `/computers/${bot.id}/release`, {});

    // the network policy still holds: a private address without permission is blocked
    await call('PUT', `/computers/${bot2.id}/config`, { mode: 'browser', allow_private: false });
    r = await tool(bot2, 'browser_open', { url: base + '/' });
    check('netwerkbeleid: privé-adres geblokkeerd zonder toestemming', r.isError || /geblokkeerd|niet toegestaan|privé/i.test(r.text), r.text.slice(0, 200));
    await call('PUT', `/computers/${bot2.id}/config`, { mode: 'browser', allow_private: true });

    // two bots, two profiles: cookies never cross
    await tool(bot, 'browser_navigate', { url: base + '/cookie?v=mila' });
    await tool(bot2, 'browser_open', { url: base + '/cookie?v=noor' });
    const s2 = svc.sessionOf(bot2)!;
    const c1 = (await s!.context.cookies()).map((c) => c.value).join(',');
    const c2 = (await s2.context.cookies()).map((c) => c.value).join(',');
    check('elke bot een eigen profiel: koekjes gescheiden', c1 === 'mila' && c2 === 'noor', `${c1} | ${c2}`);
    const sites = await call('GET', `/computers/profiles`);
    check('profielen staan in de datamap van TeamBot', sites.length >= 2 && fs.existsSync(path.join(data, 'browser', 'profiles', svc.findProfile(bot)!.id, 'app')));

    // memory per bot (own renderer processes)
    await sleep(500);
    const st1 = svc.statusOf(ctx.store.agent(bot.id)!);
    const st2 = svc.statusOf(ctx.store.agent(bot2.id)!);
    const m1 = (st1.browser as any).memoryMb;
    const m2 = (st2.browser as any).memoryMb;
    check('geheugen per bot gemeten', m1 > 5 && m2 > 5, `Mila ${m1} MB, Noor ${m2} MB`);
    out({ memory: { [bot.name]: m1, [bot2.name]: m2 } });

    // "Uitloggen bij deze site", close, start again: the profile remembers
    await call('POST', `/computers/${bot.id}/browser/close`, {});
    check('browser sluiten', !svc.sessionOf(bot));
    r = await tool(bot, 'browser_open', { url: base + '/' });
    const again = (await svc.sessionOf(bot)!.context.cookies()).map((c) => c.value).join(',');
    check('opnieuw starten: het profiel onthoudt de koekjes', again === 'mila', again);
    await call('POST', `/computers/${bot.id}/browser/logout-site`, { site: '127.0.0.1' });
    const after = (await svc.sessionOf(bot)!.context.cookies()).length;
    check('uitloggen bij een site wist de koekjes', after === 0, String(after));

    // Edge/Chrome stays the alternative when the owner picks it (and is installed)
    const eng = await call('PUT', '/computers/engine', { engine: 'external' });
    if (eng.external) {
      await call('POST', `/computers/${bot2.id}/browser/close`, {});
      r = await tool(bot2, 'browser_open', { url: base + '/' });
      check(`keuze Edge/Chrome werkt nog (${eng.external})`, !r.isError && svc.sessionOf(bot2)?.engine === 'external', r.text.slice(0, 120));
      await call('POST', `/computers/${bot2.id}/browser/close`, {});
    }
    await call('PUT', '/computers/engine', { engine: 'app' });
    check('nooit iets zichtbaar op het scherm tijdens alle stappen', everVisible === 0, `max zichtbaar: ${everVisible}`);
  } finally {
    await h.close();
    await new Promise<void>((r) => site.close(() => r()));
  }
}

app.whenReady().then(async () => {
  setInAppBrowserHost(createInAppBrowserHost());
  try {
    await focused();
  } catch (e: any) {
    check('onverwachte fout (ingebouwde browser)', false, e?.stack || e?.message);
  }
  if (process.env.TB_INAPP_DOCK !== '0') {
    // the whole browser-panel flow of browser-dock.mjs, now with the in-app engine (it sets HEADLESS_ONLY itself)
    try {
      out({ section: 'browser-dock op de ingebouwde browser' });
      process.exitCode = 0;
      // @ts-expect-error a plain e2e script without types
      await import('./browser-dock.mjs');
      if (process.exitCode) failures++;
    } catch (e: any) {
      check('onverwachte fout (browser-dock)', false, e?.stack || e?.message);
    }
    check('browser-dock: nooit iets zichtbaar op het scherm', everVisible === 0, `max zichtbaar: ${everVisible}`);
  }
  clearInterval(watcher);
  app.exit(failures ? 1 : 0);
});
