// Live calling with a bot through a cloud voice (Gemini Live), as a person does it, against a mocked Google: no real
// API calls, no keys. On the computer: the phone icon → the call dialog explains the choices in plain words (no grey
// buttons) → "Live met Gemini" → paste a key → "Klaarmaken en bellen" → the call runs over a WebSocket (fake
// microphone), the voice hands work to the bot (ask_agent, does not block), the bot answers, the voice says goodbye
// and calls end_call → TeamBot hangs up after the goodbye was played → the call log (summary + what the bot did) is
// in the chat. Then the same as a paired iPhone (WKWebView user agent, touch): start the call, say "hang maar op".
// axe-core WCAG 2.2 A/AA on the call dialog in both.
// Usage: npm run build:ui && node --import tsx tests/e2e/live-call.mjs   (TEAMBOT_E2E_SHOTS=<dir>, TEAMBOT_E2E_PORT=<port>,
//        TEAMBOT_E2E_BROWSER=chrome|msedge)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const { WebSocketServer } = require('ws');

const step = (s) => console.log(`• ${s}`);
const failures = [];
const fail = (s) => {
  failures.push(s);
  console.error(`✗ ${s}`);
  process.exitCode = 1;
};
const SHOTS = process.env.TEAMBOT_E2E_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if (await fn()) return true;
    } catch {
      /* not yet */
    }
    if (Date.now() > end) return fail(`time-out: ${what}`), false;
    await sleep(100);
  }
};
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const GOOGLE_KEY = 'AIza-e2e-not-a-real-key-000000';

const browser = await chromium.launch({
  channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'),
  headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-live-call-home-'));
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  XDG_DATA_HOME: path.join(home, 'xdg', 'data'),
  XDG_CONFIG_HOME: path.join(home, 'xdg', 'config'),
  XDG_CACHE_HOME: path.join(home, 'xdg', 'cache'),
  PATH: path.dirname(process.execPath),
});
delete process.env.Path;
delete process.env.TEAMBOT_DATA;

// ---------------------------------------------------------------- a mocked Google (token endpoint + Live WebSocket)
const google = { tokens: 0, sessions: [] };
const gserver = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/v1beta/auth_tokens') {
      if (req.headers['x-goog-api-key'] !== GOOGLE_KEY) return res.writeHead(403).end('{"error":{"message":"bad key"}}');
      google.tokens++;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ name: `auth_tokens/e2e-${google.tokens}` }));
    }
    res.writeHead(404).end('{}');
  });
});
const wss = new WebSocketServer({ server: gserver });
// 0.3 s of a quiet tone (24 kHz PCM16) as the bot's spoken goodbye.
const tone = (() => {
  const n = 7200;
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(1500 * Math.sin((2 * Math.PI * 330 * i) / 24000)), i * 2);
  return b.toString('base64');
})();
wss.on('connection', (ws, req) => {
  const s = { url: req.url || '', setup: null, audio: 0, toolResponses: [], informs: [], closed: false, script: google.next || 'ask' };
  google.sessions.push(s);
  const send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
  ws.on('close', () => (s.closed = true));
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.setup) {
      s.setup = m.setup;
      send({ setupComplete: {} });
      setTimeout(() => {
        if (s.script === 'ask') {
          send({ serverContent: { inputTranscription: { text: 'Hoe warm is het in Utrecht?' } } });
          send({ toolCall: { functionCalls: [{ id: 'fc_ask', name: 'ask_agent', args: { request: 'Hoe warm is het in Utrecht?' } }] } });
        } else {
          send({ serverContent: { inputTranscription: { text: 'Oké, hang maar op.' } } });
          send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: tone } }] }, outputTranscription: { text: 'Tot ziens!' } } });
          send({ toolCall: { functionCalls: [{ id: 'fc_bye', name: 'end_call', args: { reason: 'de gebruiker vroeg om op te hangen' } }] } });
          send({ serverContent: { turnComplete: true } });
        }
      }, 400);
      return;
    }
    if (m.realtimeInput?.audio?.data) s.audio++;
    if (m.toolResponse) {
      for (const r of m.toolResponse.functionResponses || []) {
        s.toolResponses.push(r);
        if (r.name === 'ask_agent') {
          // The voice speaks the answer, then the user says goodbye and the voice ends the call.
          setTimeout(() => {
            send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: tone } }] }, outputTranscription: { text: 'Het is 21 graden.' } } });
            send({ serverContent: { turnComplete: true } });
            send({ serverContent: { inputTranscription: { text: 'Nee dank je, dat was het.' } } });
            send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: tone } }] }, outputTranscription: { text: 'Graag gedaan, tot ziens!' } } });
            send({ toolCall: { functionCalls: [{ id: 'fc_end', name: 'end_call', args: { reason: 'de gebruiker nam afscheid', summary: 'Het is 21 graden in Utrecht.' } }] } });
            send({ serverContent: { turnComplete: true } });
          }, 300);
        }
      }
    }
    if (m.clientContent) s.informs.push(m.clientContent);
  });
});
await new Promise((r) => gserver.listen(0, '127.0.0.1', r));
const gport = gserver.address().port;

// ---------------------------------------------------------------- TeamBot with an empty data folder
const { createApp } = await import('../../server/app.ts');
const { mockAdapter } = await import('../helpers.ts');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-live-call-'));
const app = await createApp({ dataDir: dir, port: Number(process.env.TEAMBOT_E2E_PORT) || 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const pcToken = app.ctx.auth.ensureLocalOwner();
for (const k of app.ctx.providers.kinds.values()) if (k.detect) k.detect = async () => ({ installed: false, detail: 'e2e' });
// The Google provider of this run points to the mocked Google (as a self-hosted proxy would).
const gkind = app.ctx.providers.kind('google');
gkind.baseUrl = `http://127.0.0.1:${gport}/v1beta/openai`;
const script = [];
const requests = [];
app.ctx.providers.registerKind({ id: 'mock', label: 'Testmodel', type: 'api', needsKey: false, description: 'e2e', models: ['mock-1'], defaultModel: 'mock-1', create: () => mockAdapter(script, requests) });
const call = async (token, method, p, body, headers = {}) => {
  const r = await fetch(app.url + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const pc = async (method, p, body) => {
  const r = await call(pcToken, method, p, body);
  if (r.status >= 400) throw new Error(`${method} ${p} → ${r.status}: ${r.body.error}`);
  return r.body;
};
const prov = await pc('POST', '/providers', { kind: 'mock' });
const ada = await pc('POST', '/agents', { name: 'Ada', provider_id: prov.id, model: 'mock-1', access_mode: 'auto' });
const thread = await pc('POST', '/threads', { agentId: ada.id });
step(`TeamBot op ${app.url}, nep-Google op poort ${gport} (lege datamap)`);

async function axe(page, what) {
  await page.addScriptTag({ content: axeSource });
  const r = await page.evaluate(async () => {
    const res = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
    return res.violations.map((v) => `${v.id}: ${v.nodes.length}× ${v.nodes[0]?.target?.join(' ')}`);
  });
  if (r.length) fail(`a11y ${what}: ${r.join('; ')}`);
}

const watch = (page, label) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text()) && errors.push(m.text()));
  return () => errors.length && fail(`${label}: fouten in de pagina: ${errors.slice(0, 3).join(' | ')}`);
};

try {
  // ================================================================ the computer
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'nl-NL', permissions: ['microphone'], bypassCSP: true });
  const page = await ctx.newPage();
  const errorsPc = watch(page, 'pc');
  await page.goto(`${app.url}/#token=${pcToken}`);
  await page.goto(`${app.url}/#/t/${thread.id}`);
  await page.getByRole('button', { name: 'Live praten' }).first().click({ timeout: 20000 });
  const dlg = page.getByRole('dialog', { name: 'Praten met Ada' });
  await dlg.waitFor({ timeout: 10000 });
  // Step 0: no voice service yet. The choices are explained in words and none is greyed out.
  await dlg.getByText('Om te bellen is één ding nodig', { exact: false }).waitFor({ timeout: 8000 }).catch(() => fail('stap 0: geen uitleg zonder spraakdienst'));
  for (const name of ['Live met OpenAI', 'Live met Gemini (Google)', 'Live gesprek, gratis (op je eigen pc)']) {
    const c = dlg.getByRole('radio', { name: new RegExp(name.replace(/[()]/g, '\\$&')) });
    if (!(await c.count())) fail(`stap 0: keuze "${name}" ontbreekt`);
    else if (await c.isDisabled()) fail(`stap 0: keuze "${name}" is grijs`);
  }
  if (!(await dlg.getByText('dat gebeurt pas als jij ja zegt', { exact: false }).count())) fail('stap 0: het gratis pad noemt niet dat downloaden pas na een ja gebeurt');
  if (!(await page.getByRole('button', { name: 'Klaarmaken en bellen' }).count())) fail('stap 0: geen knop "Klaarmaken en bellen"');
  if (await page.getByRole('button', { name: /^Start/ }).count()) fail('stap 0: een startknop die niet kan werken');
  await axe(page, 'belscherm stap 0 (pc)');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'pc-stap0.png') });
  step('stap 0: drie keuzes in gewone woorden, niets grijs, "Klaarmaken en bellen", download pas na een ja');

  await dlg.getByRole('radio', { name: /Live met Gemini/ }).click();
  await dlg.getByLabel('Google AI Studio-sleutel').fill(GOOGLE_KEY);
  script.push({ text: 'Het is 21 graden in Utrecht.' });
  await page.getByRole('button', { name: 'Klaarmaken en bellen' }).click();
  await page.getByRole('dialog', { name: 'Gesprek met Ada' }).waitFor({ timeout: 15000 }).catch(() => fail('het gesprek start niet na de sleutel'));
  step('sleutel geplakt → Klaarmaken en bellen → het gesprek loopt');

  const s1 = await until(() => google.sessions[0]?.setup, 10000, 'Gemini krijgt geen setup') && google.sessions[0];
  if (s1) {
    if (!/access_token=auth_tokens%2Fe2e-1/.test(s1.url)) fail(`websocket zonder tijdelijk token: ${s1.url}`);
    if (s1.url.includes(GOOGLE_KEY)) fail('de Google-sleutel staat in het websocket-adres');
    const names = (s1.setup.tools?.[0]?.functionDeclarations || []).map((d) => d.name);
    for (const n of ['ask_agent', 'task_status', 'approve', 'end_call']) if (!names.includes(n)) fail(`setup mist tool ${n}`);
    await until(() => s1.audio > 3, 8000, 'geen microfoonaudio naar Gemini (16 kHz PCM)');
    await until(() => s1.toolResponses.some((r) => r.name === 'ask_agent'), 10000, 'geen antwoord op ask_agent');
    const ask = s1.toolResponses.find((r) => r.name === 'ask_agent');
    if (ask && (ask.response?.status !== 'klaar' || ask.response?.antwoord !== 'Het is 21 graden in Utrecht.')) fail(`ask_agent gaf ${JSON.stringify(ask.response).slice(0, 160)}`);
    if (ask && ask.response?.scheduling !== 'WHEN_IDLE') fail('het resultaat wordt niet "als het stil is" gemeld (WHEN_IDLE)');
    step('Gemini krijgt microfoonaudio, de tools en een tijdelijk token; ask_agent → Ada antwoordt, zonder het gesprek te blokkeren');
  }
  const summary = page.getByRole('dialog', { name: 'Gesprek beëindigd' });
  await summary.waitFor({ timeout: 20000 }).catch(() => fail('de bot hangt niet zelf op na zijn afscheid'));
  if (!(await summary.getByText('Ada heeft opgehangen.').count())) fail('het slotscherm zegt niet dat Ada ophing');
  if (!(await summary.getByText('Het is 21 graden in Utrecht.').count())) fail('het slotscherm toont de samenvatting niet');
  await until(() => s1?.closed, 5000, 'de websocket naar Gemini blijft open na ophangen');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'pc-einde.png') });
  await summary.getByRole('button', { name: 'Sluiten', exact: true }).last().click();
  const log = page.getByText('Ada hing op: de gebruiker nam afscheid', { exact: false });
  await log.first().waitFor({ timeout: 8000 }).catch(() => fail('geen gespreksverslag in de chat'));
  if (!(await page.getByText('• Ada: Hoe warm is het in Utrecht? (klaar)', { exact: false }).count())) fail('het verslag noemt niet wat Ada deed');
  const call1 = app.ctx.store.all("SELECT * FROM voice_calls WHERE thread_id = ? ORDER BY started_at", thread.id)[0];
  if (call1?.ended_by !== 'bot' || call1?.status !== 'ended') fail(`gesprek in de database: ${call1?.status} / ${call1?.ended_by}`);
  step('Ada nam afscheid en hing op na het afspelen; verslag met samenvatting en wat Ada deed staat in de chat');
  errorsPc();
  await ctx.close();

  // ================================================================ the paired iPhone (WKWebView)
  const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TeamBotiOS/0.4.4';
  const ticket = await pc('POST', '/mobile/pair', { baseUrl: app.url });
  const secret = new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('t');
  const claimed = await fetch(app.url + '/api/public/mobile/claim', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': IOS_UA }, body: JSON.stringify({ secret, name: 'iPhone', platform: 'ios', client: 'ios-app' }) }).then((r) => r.json());
  const phoneToken = claimed.token;
  if (!phoneToken) throw new Error('koppelen mislukt');
  const pctx = await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IOS_UA, locale: 'nl-NL', permissions: ['microphone'], bypassCSP: true });
  await pctx.addInitScript((t) => {
    try {
      localStorage.setItem('tb_token', t);
    } catch {}
  }, phoneToken);
  const ph = await pctx.newPage();
  const errorsPh = watch(ph, 'telefoon');
  google.next = 'bye';
  await ph.goto(`${app.url}/#/t/${thread.id}`);
  await ph.getByRole('button', { name: 'Live praten' }).first().tap({ timeout: 20000 });
  const pdlg = ph.getByRole('dialog', { name: 'Praten met Ada' });
  await pdlg.waitFor({ timeout: 10000 });
  await pdlg.getByRole('radio', { name: /Live met Gemini/ }).waitFor({ timeout: 8000 });
  if ((await pdlg.getByRole('radio', { name: /Live met Gemini/ }).getAttribute('aria-checked')) !== 'true') fail('telefoon: Gemini (met sleutel) is niet de keuze');
  await axe(ph, 'belscherm (telefoon)');
  await ph.getByRole('button', { name: 'Start live gesprek' }).tap();
  await ph.getByRole('dialog', { name: 'Gesprek met Ada' }).waitFor({ timeout: 15000 }).catch(() => fail('telefoon: het gesprek start niet'));
  const s2 = (await until(() => google.sessions[1]?.setup, 10000, 'telefoon: Gemini krijgt geen setup')) && google.sessions[1];
  if (s2) await until(() => s2.audio > 3, 8000, 'telefoon: geen microfoonaudio');
  const psum = ph.getByRole('dialog', { name: 'Gesprek beëindigd' });
  await psum.waitFor({ timeout: 20000 }).catch(() => fail('telefoon: "hang maar op" hangt niet op'));
  if (!(await psum.getByText('Ada heeft opgehangen.').count())) fail('telefoon: het slotscherm zegt niet dat Ada ophing');
  if (SHOTS) await ph.screenshot({ path: path.join(SHOTS, 'telefoon-einde.png') });
  step('gekoppelde iPhone: gesprek start met de bewaarde sleutel, "hang maar op" → Ada hangt op na het afscheid');
  errorsPh();
  await pctx.close();
} catch (e) {
  fail(`onverwacht: ${e?.stack || e}`);
} finally {
  await browser.close().catch(() => {});
  await app.close?.().catch?.(() => {});
  wss.close();
  gserver.close();
}
if (failures.length) console.error(`\n${failures.length} fout(en).`);
else console.log('\nLive bellen (cloud): alles in orde.');
process.exit(process.exitCode || 0);
