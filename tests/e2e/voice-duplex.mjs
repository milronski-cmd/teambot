// LIVE test of the free full-duplex call on this PC (no paid service, no key): real Silero VAD, Smart Turn v3.2,
// Parakeet and the Piper voice "Alex", the mock bot (Testmodel) as the brain. Temp data folder, any free port.
//  1. the two call parts are downloaded through the real route (pinned SHA-256, ~11 MB) after the "yes";
//  2. latency, measured from a client that streams a spoken question in real time over the audio socket: from the end
//     of your sentence to the first audio of the bot (5 rounds, median and worst), split up as the server reports it;
//  3. barge-in: talking over the bot stops it, how fast, and the answer in the chat keeps only what was heard;
//  4. the bot hangs up itself (end_call): goodbye first, then the call ends;
//  5. the real call screen in headless Edge with a fake microphone, on the computer and as a paired phone.
//   npm run build:ui && TEAMBOT_VOICE_MODELS=<…/voice/models with Parakeet, piper-runtime, nl_NL-alex-medium> npm run voice:duplex
// Env: TEAMBOT_DUPLEX_MODELS=<dir with silero-vad-v5 and smart-turn-v3.2 already installed> to skip the download;
//      TEAMBOT_E2E_BROWSER=chrome|msedge; TEAMBOT_TEST_PORT=<port>.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright-core');
const WebSocket = require('ws');
const { startTestApp } = await import('../helpers.ts');
const { parseWav, resample } = await import('../../server/modules/voice/local/pcm.ts');

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const info = (s) => console.log(`  ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

/** 48 kHz mono WAV for the browser's fake microphone. */
function micWav(parts) {
  const rate = 48000;
  const chunks = parts.map((p) => (p.silence ? new Float32Array(Math.round(p.silence * rate)) : resample(p.samples, p.rate, rate)));
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const pcm = Buffer.alloc(n * 2);
  let o = 0;
  for (const c of chunks) for (let i = 0; i < c.length; i++, o++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(c[i] * 32767))), o * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8, 'latin1'); h.write('fmt ', 12, 'latin1');
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1'); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-voice-duplex-'));
const builtUi = path.resolve('dist/ui');
if (!process.env.TEAMBOT_UI_DIR && builtUi.split(path.sep).some((p) => p.startsWith('.'))) {
  fs.cpSync(builtUi, path.join(work, 'ui'), { recursive: true });
  process.env.TEAMBOT_UI_DIR = path.join(work, 'ui');
}
const t = await startTestApp({ mode: 'desktop' });
const browsers = [];
try {
  // ---------- models: speech recognition + voice from a seed folder (hard links), the call parts downloaded ----------
  const modelsDir = path.join(t.dir, 'voice', 'models');
  const link = (from, to) => {
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const a = path.join(from, e.name);
      const b = path.join(to, e.name);
      if (e.isDirectory()) fs.mkdirSync(b, { recursive: true }), link(a, b);
      else {
        try {
          fs.linkSync(a, b);
        } catch {
          fs.copyFileSync(a, b);
        }
      }
    }
  };
  for (const [seed, ids] of [
    [process.env.TEAMBOT_VOICE_MODELS, ['parakeet-tdt-0.6b-v3', 'piper-runtime', 'nl_NL-alex-medium']],
    [process.env.TEAMBOT_DUPLEX_MODELS, ['silero-vad-v5', 'smart-turn-v3.2']],
  ])
    for (const id of ids) if (seed && fs.existsSync(path.join(seed, id))) fs.mkdirSync(path.join(modelsDir, id), { recursive: true }), link(path.join(seed, id), path.join(modelsDir, id));
  for (const id of ['parakeet-tdt-0.6b-v3', 'nl_NL-alex-medium']) await t.api('POST', `/voice/local/models/${id}/install`);
  let st = await t.api('GET', '/voice/duplex');
  info(`gesprekshulp: ${st.parts.map((p) => `${p.label} ${p.licence} ${(p.size / 1e6).toFixed(1)} MB ${p.status}`).join('; ')}`);
  const d0 = Date.now();
  if (st.parts.some((p) => p.status !== 'installed')) {
    check('zonder downloaden geen gesprek, met een eerlijke reden en grootte', !st.ready && /gesprekshulp downloaden \(\d+ MB\)/.test(st.problem || ''), st.problem);
    await t.api('POST', '/voice/duplex/install');
  }
  for (let i = 0; ; i++) {
    st = await t.api('GET', '/voice/duplex');
    if (st.ready) break;
    if (st.parts.some((p) => p.status === 'error')) throw new Error('download: ' + st.parts.map((p) => p.error).filter(Boolean).join('; '));
    if (i > 600) throw new Error('niet klaar: ' + st.problem);
    await sleep(500);
  }
  check('alles klaar voor het gratis live gesprek (SHA-256 gecontroleerd)', st.ready, `${((Date.now() - d0) / 1000).toFixed(1)} s`);

  // ---------- spoken fixtures, made with the local voice ----------
  const H = { authorization: `Bearer ${t.token}` };
  const tts = async (text) => {
    const r = await t.api('POST', '/voice/speak', { text });
    // The cached file is there once the voice has finished (a busy pc can take a moment).
    for (let i = 0; ; i++) {
      const buf = Buffer.from(await (await fetch(`${t.app.url}/api/voice/tts/${r.id}`, { headers: H })).arrayBuffer());
      if (buf.toString('latin1', 0, 4) === 'RIFF' || i > 40) {
        const p = parseWav(buf);
        return { samples: p.samples, rate: p.sampleRate };
      }
      await sleep(250);
    }
  };
  const Q = await tts('Hoe laat gaat de bakker morgen open?');
  const STOP = await tts('Wacht even, ik heb een andere vraag.');
  // No comma: the voice pauses after one as long as after a full stop (see the limits in docs/modules/voice.md).
  const BYE = await tts('Dat was alles voor vandaag.');
  const ANSWER = 'De bakker gaat morgen om acht uur open. Op zondag is hij de hele dag dicht, en op zaterdag sluit hij om vier uur. Wil je dat ik een herinnering zet?';
  const bot = await t.agent({ name: 'Sam' });
  const th = await t.api('POST', '/threads', { agentId: bot.id });

  /** A client on the audio socket that streams audio in real time (40 ms steps). */
  async function client() {
    const { socket, call } = await t.api('POST', '/voice/duplex/calls', { agentId: bot.id, threadId: th.id });
    const ws = new WebSocket(t.app.url.replace('http', 'ws') + t.signed(socket));
    ws.binaryType = 'nodebuffer';
    const c = { ws, call, msgs: [], audio: [], firstAudioAt: 0, onMsg: null };
    ws.on('message', (d, bin) => {
      if (bin) {
        if (!c.firstAudioAt) c.firstAudioAt = performance.now();
        c.audio.push({ epoch: d.readUInt32LE(0), n: (d.length - 4) / 2, at: performance.now() });
      } else {
        const m = JSON.parse(String(d));
        m.at = performance.now();
        c.msgs.push(m);
      }
    });
    await new Promise((r, j) => (ws.on('open', r), ws.on('error', j)));
    c.until = async (f, ms = 20000) => {
      const t0 = Date.now();
      while (!f()) {
        if (Date.now() - t0 > ms) throw new Error('timeout: ' + c.msgs.map((m) => m.type).join(','));
        await sleep(5);
      }
    };
    /** Stream 16 kHz audio paced like a microphone; resolves with the time the last sample left. */
    c.stream = async (samples, rate) => {
      const s16 = resample(samples, rate, 16000);
      const step = 640;
      const t0 = performance.now();
      for (let i = 0, k = 0; i < s16.length; i += step, k++) {
        const part = s16.subarray(i, i + step);
        const b = Buffer.alloc(part.length * 2);
        for (let j = 0; j < part.length; j++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(part[j] * 32767))), j * 2);
        ws.send(b);
        const due = t0 + ((k + 1) * step * 1000) / 16000;
        const wait = due - performance.now();
        if (wait > 0) await sleep(wait);
      }
      return performance.now();
    };
    c.silence = (sec) => c.stream(new Float32Array(Math.round(sec * 16000)), 16000);
    return c;
  }

  // ---------- 2. latency: end of your sentence → first bot audio ----------
  {
    const c = await client();
    await c.until(() => c.msgs.some((m) => m.type === 'ready'));
    await c.silence(0.5);
    // The voice ends its clip with a short pause: the sentence really ended that much before the last sample.
    let last = Q.samples.length - 1;
    while (last > 0 && Math.abs(Q.samples[last]) < 0.01) last--;
    const tailMs = Math.round(((Q.samples.length - 1 - last) * 1000) / Q.rate);
    // Wait until the recogniser is loaded (it starts loading when the call opens), as in a call after the hello.
    await sleep(4000);
    const rounds = [];
    for (let i = 0; i < 5; i++) {
      t.script.push({ text: ANSWER });
      c.firstAudioAt = 0;
      const before = c.msgs.length;
      const endAt = await c.stream(Q.samples, Q.rate);
      const silence = c.silence(2.5);
      await c.until(() => c.firstAudioAt > 0);
      await silence;
      const lat = c.msgs.slice(before).find((m) => m.type === 'latency');
      const heard = c.msgs.slice(before).find((m) => m.type === 'user')?.text || '';
      rounds.push({ client: Math.round(c.firstAudioAt - (endAt - tailMs)), ...lat, heard });
      const end = await (async () => (await c.until(() => c.msgs.slice(before).some((m) => m.type === 'answer-end')), c.msgs.slice(before).find((m) => m.type === 'answer-end')))();
      c.ws.send(JSON.stringify({ type: 'played', epoch: end.epoch, samples: end.samples }));
      await sleep(300);
    }
    for (const r of rounds) info(`ronde: ${r.client} ms gemeten bij de client · server ${r.totalMs} ms (herkenning ${r.sttMs}, beurt ${r.turnMs}, bot ${r.brainMs}, stem ${r.ttsMs}) · "${r.heard}"`);
    const med = median(rounds.map((r) => r.client));
    const worst = Math.max(...rounds.map((r) => r.client));
    check('vraag verstaan (Parakeet)', rounds.every((r) => /bak/i.test(r.heard) && /open/i.test(r.heard)), rounds[0].heard);
    check('eerste klank ≤ 1,5 s na het einde van je zin (mediaan van 5)', med <= 1500, `mediaan ${med} ms, slechtste ${worst} ms (vanaf het echte einde van je zin; inclusief de 200 ms stilte die de VAD nodig heeft)`);
    c.ws.close();
    await sleep(300);
  }

  // ---------- 3. barge-in ----------
  {
    const c = await client();
    await c.until(() => c.msgs.some((m) => m.type === 'ready'));
    t.script.push({ text: ANSWER });
    t.script.push({ text: 'Natuurlijk, vraag maar.' });
    await c.silence(0.3);
    await c.stream(Q.samples, Q.rate);
    const s1 = c.silence(1.2);
    await c.until(() => c.firstAudioAt > 0);
    await s1;
    const startedAt = performance.now();
    const talk = c.stream(STOP.samples, STOP.rate);
    await c.until(() => c.msgs.some((m) => m.type === 'interrupt'));
    const bargeMs = Math.round(c.msgs.find((m) => m.type === 'interrupt').at - startedAt);
    check('onderbreken: de bot stopt zodra je praat', bargeMs < 700, `${bargeMs} ms na het begin van je zin`);
    const int = c.msgs.find((m) => m.type === 'interrupt');
    const rate = c.msgs.find((m) => m.type === 'speech')?.sampleRate || 22050;
    c.ws.send(JSON.stringify({ type: 'played', epoch: int.epoch, samples: Math.round(1.2 * rate), interrupted: true }));
    await talk;
    await c.silence(2);
    await c.until(() => c.msgs.some((m) => m.type === 'interrupted'));
    const heard = c.msgs.find((m) => m.type === 'interrupted').heard;
    const lateAudio = c.audio.filter((a) => a.epoch === int.epoch && a.at > int.at + 50).length;
    check('na het onderbreken komt er geen audio van het oude antwoord meer', lateAudio === 0, `${lateAudio} stukken`);
    await c.until(() => c.msgs.filter((m) => m.type === 'user' && m.final).length >= 2, 15000);
    const second = c.msgs.filter((m) => m.type === 'user' && m.final)[1].text;
    check('je onderbreking wordt verstaan (begin niet kwijt)', /wacht/i.test(second) && /vraag/i.test(second), second);
    await sleep(1500);
    const cut = t.app.ctx.store.messages(th.id).filter((m) => m.role === 'assistant' && m.parts?.voiceHeardOnly).pop();
    check('in de chat staat alleen wat je hoorde van het onderbroken antwoord', !!cut && cut.content.length < ANSWER.length && ANSWER.startsWith(cut.content.replace(/…$/, '').split(' ').slice(0, 3).join(' ')), `"${cut?.content}" (gehoord: "${heard}")`);
    c.ws.close();
    await sleep(300);
  }

  // ---------- 4. the bot hangs up itself ----------
  {
    const c = await client();
    await c.until(() => c.msgs.some((m) => m.type === 'ready'));
    t.script.push({ toolCalls: [{ name: 'end_call', args: { reason: 'Gebruiker is klaar', goodbye: 'Graag gedaan, tot ziens!' } }] }, { text: '' });
    await c.silence(0.3);
    await c.stream(BYE.samples, BYE.rate);
    const s = c.silence(1);
    await c.until(() => c.msgs.some((m) => m.type === 'bot' && /tot ziens/i.test(m.text)));
    await s;
    await c.until(() => c.msgs.some((m) => m.type === 'answer-end'));
    check('end_call: nog niet opgehangen voordat het afscheid gespeeld is', !c.msgs.some((m) => m.type === 'ended'));
    const end = c.msgs.filter((m) => m.type === 'answer-end').pop();
    const closed = new Promise((r) => c.ws.on('close', r));
    c.ws.send(JSON.stringify({ type: 'played', epoch: end.epoch, samples: end.samples }));
    await closed;
    await sleep(200);
    check('end_call: de bot hing op na het afscheid', c.msgs.some((m) => m.type === 'ended') && t.app.ctx.store.get('voice_calls', c.call.id)?.status === 'ended');
  }

  // ---------- 5. the real call screen in headless Edge, on the computer and as a paired phone ----------
  const micFile = path.join(work, 'mic.wav');
  fs.writeFileSync(micFile, micWav([{ silence: 1.5 }, Q, { silence: 20 }]));
  const launch = async (phoneToken) => {
    const b = await chromium.launch({
      channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'),
      headless: true,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${micFile}%noloop`, '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
    });
    browsers.push(b);
    // bypassCSP: only so axe-core can be injected for the accessibility check.
    const ctx = await b.newContext(phoneToken ? { ...devices['iPhone 13'], permissions: ['microphone'], locale: 'nl-NL', bypassCSP: true } : { viewport: { width: 1280, height: 900 }, permissions: ['microphone'], locale: 'nl-NL', bypassCSP: true });
    if (phoneToken) await ctx.addInitScript((tok) => localStorage.setItem('tb_token', tok), phoneToken);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_CONNECTION_REFUSED|ERR_ABORTED/.test(m.text()) && errors.push(m.text()));
    return { page, errors };
  };
  const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  const a11y = async (page, label) => {
    await page.addScriptTag({ content: axeSource });
    const v = await page.evaluate(async () => {
      // @ts-ignore
      const r = await window.axe.run(document.querySelector('[role="dialog"]') || document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
      return r.violations.map((x) => `${x.id}: ${x.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`);
    });
    check(`${label}: toegankelijk (axe-core WCAG 2.2 AA)`, !v.length, v.join(' | '));
  };
  const ui = async (label, phoneToken) => {
    t.script.push({ text: ANSWER });
    const { page, errors } = await launch(phoneToken);
    await page.goto(phoneToken ? `${t.app.url}/#/t/${th.id}` : `${t.app.url}/#token=${t.token}`);
    if (!phoneToken) await page.goto(`${t.app.url}/#/t/${th.id}`);
    await page.getByRole('button', { name: 'Live praten' }).click({ timeout: 15000 });
    const choice = page.getByRole('radio', { name: /Live gesprek, gratis/ });
    await choice.waitFor({ timeout: 10000 });
    check(`${label}: het gratis live gesprek is de standaard`, (await choice.getAttribute('aria-checked')) === 'true');
    await a11y(page, `${label}, belscherm`);
    await page.getByRole('button', { name: 'Start live gesprek' }).click();
    const dlg = page.getByRole('dialog', { name: 'Live gesprek met Sam' });
    await dlg.waitFor({ timeout: 10000 });
    const t0 = Date.now();
    let text = '';
    while (Date.now() - t0 < 40000) {
      text = await dlg.innerText().catch(() => '');
      if (/eerste klank na/.test(text) && /acht uur/.test(text)) break;
      await sleep(300);
    }
    check(`${label}: vraag verstaan, antwoord gesproken, eerste klank getoond`, /bakker/i.test(text) && /acht uur/.test(text) && /eerste klank na/.test(text), (text.match(/eerste klank na [\d,]+\s?s/) || [''])[0]);
    await a11y(page, `${label}, live gesprek`);
    await dlg.getByRole('button', { name: 'Ophangen' }).click();
    await page.getByText('Gesprek beëindigd').waitFor({ timeout: 10000 });
    check(`${label}: ophangen werkt`, true);
    check(`${label}: geen fouten in de console`, !errors.length, errors.join(' | ').slice(0, 300));
  };
  await ui('computer');
  // Pair a phone through the real flow (QR ticket, claimed as the iPhone app does).
  const ticket = await t.api('POST', '/mobile/pair', { baseUrl: t.app.url });
  const secret = new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('t');
  const claim = await (await fetch(`${t.app.url}/api/public/mobile/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret, name: 'iPhone', platform: 'ios', client: 'ios-app' }) })).json();
  await ui('gekoppelde telefoon', claim.token);
} finally {
  for (const b of browsers) await b.close().catch(() => {});
  await t.close();
  fs.rmSync(work, { recursive: true, force: true });
}
const bad = results.filter((r) => !r).length;
console.log(bad ? `\n${bad} van ${results.length} controles mislukt` : `\nAlle ${results.length} controles geslaagd`);
process.exit(bad ? 1 : 0);
