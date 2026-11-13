// LIVE test of free, local speech (no paid service): real models, real UI in headless Edge/Chrome with a fake
// microphone that plays generated Dutch speech. Measures dictation delay + accuracy, local read-aloud, time to first
// sound with and without reading while the bot writes, and the free call loop with barge-in. Then the voices for
// Portuguese, Polish and Turkish: time to first sound, real (non-silent) audio, understood again by the local
// dictation model for that language, numbers spoken, reading while a bot writes in that language, a bot's own voice,
// and the settings page (which model dictates which language, licences and sizes). Temp data dir only.
//   npm run build:ui && npm run voice:live
// Env: TEAMBOT_VOICE_MODELS=<dir with already installed models (…/voice/models)> to reuse them (hard links) instead
//      of downloading ~820 MB (+ ~1,2 GB for Whisper and the three voices); CLAUDE_BIN=<path to claude(.exe)> to
//      also call a real Claude Code bot (else a mock bot); VOICE_LIVE_LANGS=pt,pl,tr (default) or '' to skip the
//      other languages; TEAMBOT_TEST_PORT=<port> for a fixed server port.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright-core');
const { startTestApp } = await import('../helpers.ts');
const { parseWav, resample } = await import('../../server/modules/voice/local/pcm.ts');

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const info = (s) => console.log(`  ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function norm(s) {
  // Letters of every alphabet count (Turkish ı, Polish ł); accents are ignored.
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
}
function wer(ref, hyp) {
  const r = norm(ref).split(' ').filter(Boolean);
  const h = norm(hyp).split(' ').filter(Boolean);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return d[r.length][h.length] / Math.max(1, r.length);
}

/** 48 kHz mono 16-bit WAV for Chrome's fake microphone. `recorded` adds echo, low-pass and room noise. */
function micWav(parts, recorded) {
  const rate = 48000;
  const total = parts.reduce((n, p) => n + (p.silence ? Math.round(p.silence * rate) : Math.round((p.samples.length * rate) / p.rate)), 0);
  const y = new Float32Array(total);
  let o = 0;
  for (const p of parts) {
    if (p.silence) {
      o += Math.round(p.silence * rate);
      continue;
    }
    const s = resample(p.samples, p.rate, rate);
    y.set(s, o);
    o += s.length;
  }
  if (recorded) {
    let seed = 3;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;
    const d1 = Math.round(0.023 * rate), d2 = Math.round(0.051 * rate);
    for (let i = y.length - 1; i >= 0; i--) y[i] += 0.35 * (y[i - d1] || 0) + 0.2 * (y[i - d2] || 0);
    let lp = 0, brown = 0;
    for (let i = 0; i < y.length; i++) {
      lp = lp * 0.75 + y[i] * 0.25;
      brown = brown * 0.995 + rnd() * 0.02;
      y[i] = 0.55 * lp + 0.004 * rnd() + 0.01 * brown;
    }
  }
  const pcm = Buffer.alloc(y.length * 2);
  for (let i = 0; i < y.length; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(y[i] * 32767))), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8, 'latin1'); h.write('fmt ', 12, 'latin1');
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1'); h.writeUInt32LE(pcm.length, 40);
  return { buf: Buffer.concat([h, pcm]), seconds: y.length / rate };
}

/**
 * Voices for the languages that used to have none (Arabic still has none: the browser voice reads it). `sentences`:
 * eight everyday sentences to understand again, one by one (no digits: those would be compared as words; the same
 * set as the measurement in docs/modules/voice.md); `digits`: a sentence with a clock time that must be spoken, not
 * skipped (`heard`); `answer`: what a slow bot writes, for reading while it writes.
 */
const LANG_TESTS = [
  {
    lang: 'pt',
    name: 'Portugees',
    voice: 'pt-cv-vits',
    stt: 'parakeet-tdt-0.6b-v3',
    sentences: [
      'Bom dia, como posso ajudar você hoje?',
      'Amanhã às dez horas temos uma reunião com a equipe na sala de conferências.',
      'Por favor, leia este documento e escreva um resumo curto.',
      'A fatura foi paga ontem e agora está na pasta.',
      'Eu marquei a consulta com o dentista para você na próxima semana.',
      'Você pode me dizer como vai estar o tempo no fim de semana?',
      'Enviei uma mensagem para o cliente e estou esperando a resposta.',
      'O relatório está quase pronto, só falta revisar as conclusões.',
    ],
    digits: 'A reunião começa às 10:30 na sala principal.',
    heard: /\b10\b|dez/i,
    ask: 'O que eu faço amanhã?',
    answer: 'Amanhã o seu dia começa com a reunião da equipe. Depois você liga para o fornecedor sobre o orçamento. À tarde você tem tempo para terminar o relatório. Quer que eu crie um lembrete para a reunião?',
  },
  {
    lang: 'pl',
    name: 'Pools',
    voice: 'pl_PL-mai_female-vits',
    stt: 'parakeet-tdt-0.6b-v3',
    sentences: [
      'Dzień dobry, jak mogę ci dzisiaj pomóc?',
      'Jutro o dziesiątej mamy spotkanie z zespołem w sali konferencyjnej.',
      'Proszę, przeczytaj ten dokument i napisz krótkie podsumowanie.',
      'Rachunek został zapłacony wczoraj i teraz jest w folderze.',
      'Umówiłem ci wizytę u dentysty na przyszły tydzień.',
      'Czy możesz mi powiedzieć, jaka będzie pogoda w weekend?',
      'Wysłałem wiadomość do klienta i czekam na odpowiedź.',
      'Trzy drzewa rosną przy ulicy obok szkoły.',
    ],
    digits: 'Spotkanie zaczyna się o 10:30 w dużej sali.',
    heard: /\b10\b|dziesi/i,
    ask: 'Co robię jutro?',
    answer: 'Jutro zaczynasz dzień od spotkania z zespołem. Potem dzwonisz do dostawcy w sprawie oferty. Po obiedzie masz czas, żeby skończyć raport. Czy mam ustawić przypomnienie o spotkaniu?',
  },
  {
    lang: 'tr',
    name: 'Turks',
    voice: 'tr_TR-antalia-medium',
    stt: 'whisper-large-v3-turbo',
    sentences: [
      'Günaydın, bugün sana nasıl yardımcı olabilirim?',
      'Yarın saat onda ekiple toplantı odasında bir toplantımız var.',
      'Lütfen bu belgeyi oku ve kısa bir özet yaz.',
      'Fatura dün ödendi ve şimdi klasörde duruyor.',
      'Senin için gelecek hafta dişçiden randevu aldım.',
      'Bana hafta sonu havanın nasıl olacağını söyleyebilir misin?',
      'Müşteriye bir mesaj gönderdim ve cevap bekliyorum.',
      'Rapor neredeyse hazır, sadece sonuçları gözden geçirmem gerekiyor.',
    ],
    digits: 'Toplantı saat 10:30 da başlıyor.',
    heard: /\b10\b|\bon\b/i,
    ask: 'Yarın ne yapıyorum?',
    answer: 'Yarın güne ekip toplantısıyla başlıyorsun. Sonra teklif hakkında tedarikçiyi arıyorsun. Öğleden sonra raporu bitirmek için zamanın var. Toplantı için bir hatırlatıcı kurayım mı?',
  },
];
const LANGS = (process.env.VOICE_LIVE_LANGS ?? 'pt,pl,tr').split(',').map((s) => s.trim()).filter(Boolean);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-voice-live-'));
// res.sendFile refuses paths with a dot-folder (e.g. a git worktree under .claude/): serve a copy of the UI then.
const builtUi = path.resolve('dist/ui');
if (!process.env.TEAMBOT_UI_DIR && builtUi.split(path.sep).some((p) => p.startsWith('.'))) {
  fs.cpSync(builtUi, path.join(work, 'ui'), { recursive: true });
  process.env.TEAMBOT_UI_DIR = path.join(work, 'ui');
}
const t = await startTestApp({ mode: 'desktop' });
const browsers = [];
try {
  // ---------- models ----------
  const modelsDir = path.join(t.dir, 'voice', 'models');
  const langTests = LANG_TESTS.filter((x) => LANGS.includes(x.lang));
  const extra = [...new Set(langTests.flatMap((x) => [x.voice, x.stt]))];
  const want = [...new Set(['parakeet-tdt-0.6b-v3', 'piper-runtime', 'nl_NL-alex-medium', ...extra])];
  const seed = process.env.TEAMBOT_VOICE_MODELS;
  if (seed && fs.existsSync(seed)) {
    for (const id of want) {
      const from = path.join(seed, id);
      if (!fs.existsSync(from)) continue;
      fs.cpSync(from, path.join(modelsDir, id), { recursive: true, force: true });
    }
    info(`modellen gekopieerd uit ${seed}`);
  }
  const t0 = Date.now();
  for (const id of ['parakeet-tdt-0.6b-v3', 'nl_NL-alex-medium', ...extra]) await t.api('POST', `/voice/local/models/${id}/install`);
  for (;;) {
    const v = await t.api('GET', '/voice/local');
    const ms = v.models.filter((m) => want.includes(m.id));
    if (ms.some((m) => m.status === 'error')) throw new Error('download: ' + ms.map((m) => m.error).filter(Boolean).join('; '));
    if (ms.every((m) => m.status === 'installed')) break;
    await sleep(1000);
  }
  check('lokale modellen geïnstalleerd en gecontroleerd (SHA-256)', true, `${((Date.now() - t0) / 1000).toFixed(1)} s`);

  // ---------- test speech, made with the local voice ----------
  const H = { authorization: `Bearer ${t.token}` };
  const tts = async (text) => {
    const r = await t.api('POST', '/voice/speak', { text });
    const wav = Buffer.from(await (await fetch(`${t.app.url}/api/voice/tts/${r.id}`, { headers: H })).arrayBuffer());
    const p = parseWav(wav);
    return { samples: p.samples, rate: p.sampleRate };
  };
  const DICT = 'Goedemorgen. Kun je vandaag om drie uur een afspraak maken met de tandarts en mij daar een herinnering voor sturen?';
  const Q = 'Wat is de hoofdstad van Frankrijk?';
  const STOP = 'Wacht even, ik heb een andere vraag.';
  const dict = await tts(DICT);
  const q = await tts(Q);
  const stop = await tts(STOP);
  const dictFile = path.join(work, 'dicteren.wav');
  const dictMic = micWav([{ silence: 0.6 }, dict, { silence: 3 }], true);
  fs.writeFileSync(dictFile, dictMic.buf);
  const callFile = path.join(work, 'gesprek.wav');
  // question … silence (bot answers, long) … interruption while the bot is still talking … silence
  fs.writeFileSync(callFile, micWav([{ silence: 0.8 }, q, { silence: 5.5 }, stop, { silence: 12 }], false).buf);

  const launch = async (wav, phone = false) => {
    const b = await chromium.launch({
      channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'),
      headless: true,
      // --mute-audio: the page still plays (and measures) everything, but nothing comes out of the pc's speakers.
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}%noloop`, '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
    });
    browsers.push(b);
    const ctx = await b.newContext(
      phone
        ? { ...devices['iPhone 13'], permissions: ['microphone'] }
        : { viewport: { width: 1280, height: 900 }, permissions: ['microphone'] },
    );
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_CONNECTION_REFUSED|ERR_ABORTED/.test(m.text()) && errors.push(m.text()));
    return { page, errors };
  };

  // ---------- 1. dictation in the composer (live text, then editable text) ----------
  const bot = await t.agent({ name: 'Sam' });
  const th = await t.api('POST', '/threads', { agentId: bot.id });
  {
    const { page, errors } = await launch(dictFile);
    await page.goto(`${t.app.url}/#token=${t.token}`);
    await page.goto(`${t.app.url}/#/t/${th.id}`);
    const mic = page.getByRole('button', { name: /Dicteren/ });
    await mic.waitFor({ timeout: 15000 });
    await page.waitForTimeout(500);
    await mic.click();
    const status = page.getByRole('status').filter({ hasText: 'Microfoon aan' });
    await status.waitFor({ timeout: 10000 });
    let partialSeen = '';
    const until = Date.now() + (dictMic.seconds - 2.2) * 1000;
    while (Date.now() < until) {
      const txt = await status.innerText().catch(() => '');
      const extra = txt.split('\n').find((l) => /[a-z]{4,}/i.test(l) && !/Microfoon|Annuleren|memo|Klaar|computer|internet/.test(l));
      if (extra) partialSeen = extra;
      await sleep(250);
    }
    check('live tekst tijdens het praten', !!partialSeen, partialSeen.slice(0, 80));
    const tStop = Date.now();
    await status.getByRole('button', { name: 'Klaar' }).click();
    const box = page.getByLabel('Bericht');
    await page.waitForFunction(() => (document.querySelector('textarea')?.value || '').length > 10, null, { timeout: 15000 });
    const ms = Date.now() - tStop;
    const text = await box.inputValue();
    const w = wer(DICT, text);
    check('dicteren: tekst bewerkbaar in het tekstvak', text.length > 10, text);
    check('dicteren: < 1,5 s na stoppen', ms < 1500, `${ms} ms (in de browser gemeten, inclusief netwerk)`);
    check('dicteren: nauwkeurig (WER ≤ 20 %, opname met ruis en galm)', w <= 0.2, `WER ${(w * 100).toFixed(0)} %`);
    check('geen fouten in de console (dicteren)', !errors.length, errors.join(' | ').slice(0, 300));
  }

  // ---------- 1b. same on a phone-sized touch screen (iPhone emulation in Chromium; layout + touch flow) ----------
  {
    const { page, errors } = await launch(dictFile, true);
    await page.goto(`${t.app.url}/#token=${t.token}`);
    await page.goto(`${t.app.url}/#/t/${th.id}`);
    const mic = page.getByRole('button', { name: /Dicteren/ });
    await mic.waitFor({ timeout: 15000 });
    await page.waitForTimeout(500);
    await mic.tap();
    const status = page.getByRole('status').filter({ hasText: 'Microfoon aan' });
    await status.waitFor({ timeout: 10000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await sleep((dictMic.seconds - 2.2) * 1000);
    await status.getByRole('button', { name: 'Klaar' }).tap();
    await page.waitForFunction(() => (document.querySelector('textarea')?.value || '').length > 10, null, { timeout: 15000 });
    const text = await page.getByLabel('Bericht').inputValue();
    check('telefoon (iPhone-weergave): tikken, praten, tekst in het tekstvak', wer(DICT, text) <= 0.2, text.slice(0, 60));
    check('telefoon: geen horizontale scroll met de opname-indicator', overflow <= 1, `${overflow}px`);
    check('geen fouten in de console (telefoon)', !errors.length, errors.join(' | ').slice(0, 300));
  }

  // ---------- 2. read aloud (local voice, streaming) ----------
  {
    const { page, errors } = await launch(dictFile);
    t.script.push({ text: 'Het is vandaag zonnig in Utrecht. Morgen wordt het bewolkt met kans op regen.' });
    await t.say(th.id, 'Hoe wordt het weer?');
    await page.goto(`${t.app.url}/#token=${t.token}`);
    await page.goto(`${t.app.url}/#/t/${th.id}`);
    const speakBtn = page.getByRole('button', { name: 'Voorlezen' }).last();
    await speakBtn.waitFor({ timeout: 15000 });
    const pcm = page.waitForResponse((r) => /\/voice\/tts\/[^/]+\/pcm/.test(r.url()), { timeout: 15000 });
    const t1 = Date.now();
    await speakBtn.click();
    const res = await pcm;
    const body = await res.body();
    check('lees voor: lokale stem gestreamd', res.ok() && body.length > 20000, `${(body.length / 2 / Number(res.headers()['x-sample-rate'] || 22050)).toFixed(1)} s audio, eerste respons na ${Date.now() - t1} ms`);
    check('geen fouten in de console (voorlezen)', !errors.length, errors.join(' | ').slice(0, 300));
  }

  // ---------- 2b. speak while the bot answers: time to first sound, before (whole answer, then voice) and after ----------
  {
    // A bot that writes like a real model: first text after 0.8 s, then ~150 characters per second.
    const steps = [];
    t.app.ctx.providers.registerKind({
      id: 'slowmock', label: 'Slow mock', type: 'api', needsKey: false, description: 'live test', models: ['slow-1'], defaultModel: 'slow-1',
      create: () => ({
        kind: 'slowmock',
        async listModels() { return [{ id: 'slow-1' }]; },
        async test() { return { ok: true, detail: 'slow' }; },
        async chat(req, signal, onEvent) {
          const text = steps.shift() || 'Klaar.';
          await sleep(800);
          for (let i = 0; i < text.length; i += 6) {
            onEvent({ type: 'text', delta: text.slice(i, i + 6) });
            await sleep(40);
          }
          return { text, toolCalls: [], usage: { input: 1, output: 1 }, stop: 'end', model: req.model };
        },
      }),
    });
    const sp = await t.api('POST', '/providers', { kind: 'slowmock' });
    const slow = await t.api('POST', '/agents', { name: 'Traag', provider_id: sp.id, model: 'slow-1', access_mode: 'auto' });
    const sth = await t.api('POST', '/threads', { agentId: slow.id });
    const firstByte = async (p) => {
      const t0 = Date.now();
      const res = await fetch(`${t.app.url}/api${p}`, { headers: H });
      const reader = res.body.getReader();
      let first = null;
      let bytes = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (first === null) first = Date.now() - t0;
        bytes += value.length;
      }
      return { first, bytes };
    };
    const answer = (i) =>
      `Goed dat je het vraagt, nummer ${i}. Morgen begint de dag om negen uur met het teamoverleg. Om elf uur bel je met de leverancier over de offerte. ` +
      `Na de lunch heb je tijd om het rapport af te maken. Wil je dat ik een herinnering zet voor het overleg?`;
    const before = [];
    const after = [];
    const c = await t.api('POST', '/voice/calls', { agentId: slow.id, threadId: sth.id });
    for (let i = 0; i < 3; i++) {
      // before: wait for the whole answer, then ask for the voice (what the call did until now)
      steps.push(answer(2 * i + 1));
      let t0 = Date.now();
      const done = await t.api('POST', `/voice/calls/${c.id}/turn`, { text: 'Wat doe ik morgen?' });
      const botMs = Date.now() - t0;
      const spk = await t.api('POST', '/voice/speak', { messageId: done.messageId });
      const tReq = Date.now();
      const b = await firstByte(spk.stream || `/voice/tts/${spk.id}/pcm`);
      before.push({ firstSound: tReq - t0 + b.first, botMs, bytes: b.bytes });
      // after: speak while the bot writes
      steps.push(answer(2 * i + 2));
      t0 = Date.now();
      const live = await t.api('POST', `/voice/calls/${c.id}/turn`, { text: 'En overmorgen?', speak: true });
      const tStream = Date.now();
      const a = await firstByte(live.speech.stream);
      after.push({ firstSound: tStream - t0 + a.first, botMs: Date.parse(t.app.ctx.store.run(live.runId).finished_at) - t0, bytes: a.bytes });
    }
    await t.api('POST', `/voice/calls/${c.id}/end`, {});
    const med = (xs) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];
    const fmt = (ms) => `${(ms / 1000).toFixed(2).replace('.', ',')} s`;
    const b0 = med(before.map((x) => x.firstSound));
    const a0 = med(after.map((x) => x.firstSound));
    info(`bot (traag als een echt model: 0,8 s tot de eerste tekst, ~150 tekens/s): klaar na ${fmt(med(before.map((x) => x.botMs)))}`);
    info(`eerste klank VOOR (heel antwoord, dan stem): ${before.map((x) => fmt(x.firstSound)).join(' / ')} → mediaan ${fmt(b0)}`);
    info(`eerste klank NA (stem na de eerste zin):    ${after.map((x) => fmt(x.firstSound)).join(' / ')} → mediaan ${fmt(a0)}`);
    check('voorlezen terwijl de bot schrijft: eerste klank vóór het antwoord klaar is', after.every((x) => x.firstSound < x.botMs - 500), `${fmt(a0)} i.p.v. ${fmt(b0)}`);
    check('voorlezen terwijl de bot schrijft: hele antwoord voorgelezen', after.every((x, i) => Math.abs(x.bytes - before[i].bytes) / before[i].bytes < 0.25), after.map((x) => `${Math.round(x.bytes / 44100)} s`).join(', '));
  }

  // ---------- 3. free call with barge-in (hands-free; on a computer hold-to-talk is the default, see 3b) ----------
  {
    await t.api('PUT', '/voice/settings', { call: { talk: 'handsfree' } });
    let bot2 = bot;
    if (process.env.CLAUDE_BIN) {
      const p = await t.api('POST', '/providers', { kind: 'claude-code', config: { path: process.env.CLAUDE_BIN } });
      bot2 = await t.api('POST', '/agents', { name: 'Baas', provider_id: p.id, model: 'haiku', access_mode: 'auto', instructions: 'Je bent een behulpzame Nederlandse assistent. Antwoord altijd in vijf of zes volle zinnen, met wat achtergrond.' });
      // A long answer, so the bot is still speaking when the fake microphone interrupts (a one-line answer from a
      // real engine ends before that, and then there is nothing to interrupt).
    } else {
      t.script.push({ text: 'De hoofdstad van Frankrijk is Parijs. Parijs ligt aan de Seine en heeft ruim twee miljoen inwoners. Bekende plekken zijn de Eiffeltoren, het Louvre en de Notre-Dame. Wil je nog meer weten over Frankrijk of over een andere hoofdstad in Europa?' });
      t.script.push({ text: 'Natuurlijk, vraag maar.' });
    }
    const th2 = await t.api('POST', '/threads', { agentId: bot2.id });
    const { page, errors } = await launch(callFile);
    await page.goto(`${t.app.url}/#token=${t.token}`);
    await page.goto(`${t.app.url}/#/t/${th2.id}`);
    await page.getByRole('button', { name: 'Live praten' }).click({ timeout: 15000 });
    await page.getByRole('radio', { name: /Gratis gesprek/ }).click();
    await page.getByRole('button', { name: 'Start gesprek' }).click();
    // The call is a compact bar above the message field; the subtitles open on request.
    await page.getByRole('button', { name: 'Ondertiteling tonen' }).click({ timeout: 15000 });
    const caps = page.getByLabel('Live ondertiteling');
    const tCall = Date.now();
    let captions = '';
    while (Date.now() - tCall < 60000) {
      captions = await caps.innerText().catch(() => '');
      if (/onderbroken/.test(captions) && /andere vraag/i.test(captions)) break;
      await sleep(300);
    }
    const timing = await page.getByLabel('Vertraging').innerText().catch(() => '');
    check('gesprek: vraag verstaan', /hoofdstad/i.test(captions) && /frankrijk/i.test(captions), captions.split('\n')[0]);
    check('gesprek: bot antwoordde (via de gewone run)', /parijs/i.test(captions), timing);
    check('gesprek: onderbreken door te praten', /onderbroken/.test(captions) && /andere vraag/i.test(captions));
    check('gesprek: stem al tijdens het schrijven (eerste klank gemeten)', /eerste klank/.test(timing), timing);
    // The interruption must not cut off "Wacht even": the pre-roll goes back to where you started talking.
    const heardStop = t.app.ctx.store.messages(th2.id).filter((m) => m.role === 'user' && m.parts?.voice).map((m) => m.content).find((x) => /andere vraag/i.test(x)) || '';
    check('gesprek: begin van de onderbreking niet kwijt', /wacht/i.test(heardStop), heardStop);
    info(captions.replace(/\n/g, ' | ').slice(0, 400));
    await page.getByRole('button', { name: 'Ophangen' }).click();
    await page.getByText('Gesprek beëindigd').waitFor({ timeout: 10000 });
    const userMsgs = t.app.ctx.store.messages(th2.id).filter((m) => m.role === 'user' && m.parts?.voice);
    check('gesprek: ingesproken berichten in de chat (via de Broker/run)', userMsgs.length >= 2, `${userMsgs.length} berichten`);
    check('geen fouten in de console (gesprek)', !errors.length, errors.join(' | ').slice(0, 300));
  }

  // ---------- 3b. hold-to-talk, the default on a computer: only what you say while you hold the space bar counts ----------
  // The same microphone file: the question, and 5.5 s later "Wacht even, ik heb een andere vraag" while the bot talks.
  // Without the key that second sentence must not interrupt the bot; pressing the key does.
  {
    await t.api('PUT', '/voice/settings', { call: { talk: 'auto' } });
    t.script.push({ text: 'De hoofdstad van Frankrijk is Parijs. Parijs ligt aan de Seine en heeft ruim twee miljoen inwoners. Bekende plekken zijn de Eiffeltoren, het Louvre en de Notre-Dame. Wil je nog meer weten over Frankrijk of over een andere hoofdstad in Europa?' });
    const th3 = await t.api('POST', '/threads', { agentId: bot.id });
    const { page, errors } = await launch(callFile);
    await page.goto(`${t.app.url}/#token=${t.token}`);
    await page.goto(`${t.app.url}/#/t/${th3.id}`);
    await page.getByRole('button', { name: 'Live praten' }).click({ timeout: 15000 });
    await page.getByRole('radio', { name: /Gratis gesprek/ }).click();
    await page.getByRole('button', { name: 'Start gesprek' }).click();
    const call = page.getByRole('dialog', { name: /Gesprek met/ });
    await call.getByRole('button', { name: 'Ondertiteling tonen' }).click({ timeout: 15000 });
    const ready = await call.getByText('Houd de spatiebalk of de knop ingedrukt om te praten').waitFor({ timeout: 15000 }).then(() => true, () => false);
    check('ingedrukt houden: standaard op de pc ("Houd de spatiebalk … ingedrukt")', ready);
    const tReady = Date.now();
    const seen = new Set();
    const watch = async (until) => {
      while (Date.now() < until) {
        const s = await call.getByRole('status').first().innerText().catch(() => '');
        if (s) seen.add(s.trim());
        await sleep(150);
      }
    };
    await page.keyboard.down('Space');
    await watch(tReady + 3400);
    await page.keyboard.up('Space');
    check('ingedrukt houden: "Sam luistert naar je" zolang je de spatiebalk vasthoudt', seen.has('Sam luistert naar je'), [...seen].join(' | '));
    // The bot answers and speaks; the microphone plays "Wacht even, …" meanwhile: nobody holds the key.
    await watch(tReady + 13_000);
    const caps = page.getByLabel('Live ondertiteling');
    const before = await caps.innerText().catch(() => '');
    const sent = () => t.app.ctx.store.messages(th3.id).filter((m) => m.role === 'user' && m.parts?.voice).map((m) => m.content);
    check('ingedrukt houden: vraag verstaan en beantwoord', /hoofdstad/i.test(sent()[0] || '') && /parijs/i.test(before), (sent()[0] || '') + ' → ' + before.split('\n').slice(-1)[0]);
    check('ingedrukt houden: "Sam denkt na…" en "Sam spreekt" in beeld', seen.has('Sam denkt na…') && seen.has('Sam spreekt'), [...seen].join(' | '));
    check('ingedrukt houden: praten zonder de toets onderbreekt de bot niet', !/onderbroken/.test(before) && sent().length === 1, `${sent().length} beurten`);
    // Now press while it still speaks: that interrupts it.
    await page.keyboard.down('Space');
    await sleep(1200);
    await page.keyboard.up('Space');
    await sleep(1500);
    const after = await caps.innerText().catch(() => '');
    check('ingedrukt houden: de toets indrukken onderbreekt de bot', /onderbroken/.test(after), after.replace(/\n/g, ' | ').slice(-160));
    await page.getByRole('button', { name: 'Ophangen' }).click();
    await page.getByText('Gesprek beëindigd').waitFor({ timeout: 10000 });
    check('geen fouten in de console (ingedrukt houden)', !errors.length, errors.join(' | ').slice(0, 300));
  }

  // ---------- 3c. group call with voice: it is always visible which bot listens, thinks and speaks ----------
  {
    // Bots that write like a real model (first text after 0.8 s), so "thinks" is visible for a moment.
    const groupSteps = [];
    t.app.ctx.providers.registerKind({
      id: 'slowgroup', label: 'Slow mock (group)', type: 'api', needsKey: false, description: 'live test', models: ['slow-1'], defaultModel: 'slow-1',
      create: () => ({
        kind: 'slowgroup',
        async listModels() { return [{ id: 'slow-1' }]; },
        async test() { return { ok: true, detail: 'slow' }; },
        async chat(req, signal, onEvent) {
          const text = groupSteps.shift() || 'Goed idee.';
          await sleep(1500);
          for (let i = 0; i < text.length; i += 6) {
            onEvent({ type: 'text', delta: text.slice(i, i + 6) });
            await sleep(40);
          }
          return { text, toolCalls: [], usage: { input: 1, output: 1 }, stop: 'end', model: req.model };
        },
      }),
    });
    const gp = await t.api('POST', '/providers', { kind: 'slowgroup' });
    const lead = await t.api('POST', '/agents', { name: 'Lotte', provider_id: gp.id, model: 'slow-1', access_mode: 'auto' });
    const other = await t.api('POST', '/agents', { name: 'Bram', provider_id: gp.id, model: 'slow-1', access_mode: 'auto' });
    const room = await t.api('POST', '/rooms', { name: 'Reisteam', mode: 'lead', agentIds: [lead.id, other.id] });
    const rt = room.thread_id || room.threadId;
    groupSteps.push('De hoofdstad van Frankrijk is Parijs, aan de Seine.');
    const { page, errors } = await launch(callFile);
    await page.goto(`${t.app.url}/#token=${t.token}`);
    await page.goto(`${t.app.url}/#/t/${rt}`);
    await page.getByRole('button', { name: 'Groepsgesprek (spraak)' }).click({ timeout: 15000 });
    const dlg = page.getByRole('dialog');
    const ready = await dlg.getByText('Houd de spatiebalk of de knop ingedrukt om te praten').waitFor({ timeout: 15000 }).then(() => true, () => false);
    check('groepsgesprek: ingedrukt houden op de pc', ready);
    const tReady = Date.now();
    const lines = new Set();
    const faces = new Set();
    const watch = async (until) => {
      while (Date.now() < until) {
        const s = await dlg.getByRole('status').first().innerText().catch(() => '');
        if (s) lines.add(s.trim().replace(/\s*microfoon aan$/, ''));
        const f = await dlg.getByLabel('Wie luistert, denkt na of spreekt').innerText().catch(() => '');
        if (f) faces.add(f.replace(/\s+/g, ' ').trim());
        await sleep(120);
      }
    };
    await page.keyboard.down('Space');
    await watch(tReady + 3400);
    await page.keyboard.up('Space');
    await watch(tReady + 16_000);
    const said = t.app.ctx.store.messages(rt).filter((m) => m.role === 'user').map((m) => m.content);
    check('groepsgesprek: je vraag ging naar de groep', said.some((x) => /hoofdstad/i.test(x)), said.join(' | '));
    check('groepsgesprek: "De groep luistert naar je" terwijl je de toets vasthoudt', lines.has('De groep luistert naar je'), [...lines].join(' | '));
    check('groepsgesprek: "Lotte denkt na…" terwijl die bot werkt', lines.has('Lotte denkt na…'), [...lines].join(' | '));
    check('groepsgesprek: "Lotte spreekt" terwijl haar antwoord wordt voorgelezen', lines.has('Lotte spreekt'), [...lines].join(' | '));
    check('groepsgesprek: het gezicht van Lotte zegt "spreekt", dat van Bram niet', [...faces].some((f) => /spreekt Lotte/.test(f) && !/spreekt Bram/.test(f)), [...faces].join(' | ').slice(0, 300));
    await dlg.getByRole('button', { name: 'Ophangen' }).click();
    check('geen fouten in de console (groepsgesprek)', !errors.length, errors.join(' | ').slice(0, 300));
  }

  // ---------- 4. voices for Portuguese, Polish and Turkish ----------
  if (langTests.length) {
    const owner = t.app.ctx.auth.owner().id;
    const fmt = (ms) => `${(ms / 1000).toFixed(2).replace('.', ',')} s`;
    /** Read a PCM stream; first = ms from `t0` until the first bytes. */
    const readPcm = async (p, t0) => {
      const res = await fetch(`${t.app.url}/api${p}`, { headers: H });
      const reader = res.body.getReader();
      const parts = [];
      let first = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (first === null) first = Date.now() - t0;
        parts.push(Buffer.from(value));
      }
      return { first, pcm: Buffer.concat(parts), rate: Number(res.headers.get('x-sample-rate') || 22050) };
    };
    const stats = (pcm, rate) => {
      const n = pcm.length / 2;
      let sq = 0;
      let loud = 0;
      for (let i = 0; i < n; i++) {
        const v = pcm.readInt16LE(i * 2) / 32768;
        sq += v * v;
        if (Math.abs(v) > 0.05) loud++;
      }
      return { seconds: n / rate, rms: Math.sqrt(sq / Math.max(1, n)), loud: loud / Math.max(1, n) };
    };
    const { pcmToWav } = await import('../../server/modules/voice/audio.ts');
    const hear = async (pcm, rate) => {
      const res = await fetch(`${t.app.url}/api/voice/transcribe`, { method: 'POST', headers: { ...H, 'content-type': 'audio/wav' }, body: pcmToWav(pcm, rate) });
      const j = await res.json();
      if (!res.ok) throw new Error(`transcribe ${res.status}: ${j?.error || JSON.stringify(j)}`);
      return j;
    };
    // A bot that writes like a real model (first text after 0.8 s, ~150 characters/s), for reading while it writes.
    const steps = [];
    t.app.ctx.providers.registerKind({
      id: 'slowlang', label: 'Slow mock (languages)', type: 'api', needsKey: false, description: 'live test', models: ['slow-1'], defaultModel: 'slow-1',
      create: () => ({
        kind: 'slowlang',
        async listModels() { return [{ id: 'slow-1' }]; },
        async test() { return { ok: true, detail: 'slow' }; },
        async chat(req, signal, onEvent) {
          const text = steps.shift() || 'OK.';
          await sleep(800);
          for (let i = 0; i < text.length; i += 6) {
            onEvent({ type: 'text', delta: text.slice(i, i + 6) });
            await sleep(40);
          }
          return { text, toolCalls: [], usage: { input: 1, output: 1 }, stop: 'end', model: req.model };
        },
      }),
    });
    const sp = await t.api('POST', '/providers', { kind: 'slowlang' });
    const slowBot = await t.api('POST', '/agents', { name: 'Talen', provider_id: sp.id, model: 'slow-1', access_mode: 'auto' });
    const summary = [];
    for (const L of langTests) {
      t.app.ctx.store.setSetting(owner, 'language', L.lang);
      // Automatic choices for this interface language; dictation in this language.
      await t.api('PUT', '/voice/settings', { stt: { engine: 'local', language: L.lang, localModel: '' }, tts: { engine: 'local', localVoice: '', streaming: true } });
      const s = await t.api('GET', '/voice/settings');
      check(`${L.name}: automatische stem en dicteermodel`, s.effective.tts.localVoice === L.voice && s.effective.stt.localModel === L.stt && s.status.tts.engine === 'local', `${s.effective.tts.localVoice} · ${s.effective.stt.localModel} · ${s.status.tts.engine}`);
      // Read aloud: first sound (the voice is not loaded yet), real audio, and every sentence understood again by the
      // local model for this language (one by one, as dictation would hear it).
      let t0 = Date.now();
      const r = await t.api('POST', '/voice/speak', { text: L.sentences[0] });
      const a = await readPcm(r.stream || `/voice/tts/${r.id}`, t0);
      check(`${L.name}: lokale stem gestreamd (${r.model})`, r.engine === 'local' && r.model === L.voice && !!r.stream, `eerste klank na ${a.first} ms (stem nog niet geladen)`);
      let errs = 0;
      let words = 0;
      let seconds = 0;
      let quiet = 0;
      let sttModel = '';
      const misheard = [];
      for (const [i, s] of L.sentences.entries()) {
        const one = i === 0 ? a : await t.api('POST', '/voice/speak', { text: s }).then((x) => readPcm(x.stream || `/voice/tts/${x.id}`, Date.now()));
        const st = stats(one.pcm, one.rate);
        seconds += st.seconds;
        if (!(st.rms > 0.02 && st.loud > 0.05)) quiet++;
        const h = await hear(one.pcm, one.rate);
        sttModel = h.model;
        const n = norm(s).split(' ').length;
        const e = Math.round(wer(s, h.text) * n);
        errs += e;
        words += n;
        if (e) misheard.push(`“${h.text}”`);
      }
      const w = errs / words;
      check(`${L.name}: echte spraak, geen stilte`, !quiet && seconds > 15, `${seconds.toFixed(1)} s audio voor ${L.sentences.length} zinnen`);
      check(`${L.name}: verstaan door ${sttModel} (WER ≤ 25 %)`, sttModel === L.stt && w <= 0.25, `WER ${(w * 100).toFixed(1)} % (${errs}/${words} woorden) · ${misheard.slice(0, 3).join(' ')}`);
      const h = { model: sttModel };
      // A clock time is spoken (the in-process voices cannot read digits: TeamBot writes them out). The voice is
      // loaded now: this also measures the first sound with a warm voice.
      const tWarm = Date.now();
      const d = await t.api('POST', '/voice/speak', { text: L.digits });
      const dp = await readPcm(d.stream || `/voice/tts/${d.id}`, tWarm);
      const dh = await hear(dp.pcm, dp.rate);
      check(`${L.name}: getallen uitgesproken`, L.heard.test(dh.text), `“${dh.text}” · eerste klank (stem geladen) na ${dp.first} ms`);
      // Reading while the bot writes, in this language: first sound before the bot is done.
      const th = await t.api('POST', '/threads', { agentId: slowBot.id });
      const c = await t.api('POST', '/voice/calls', { agentId: slowBot.id, threadId: th.id });
      steps.push(L.answer);
      t0 = Date.now();
      const live = await t.api('POST', `/voice/calls/${c.id}/turn`, { text: L.ask, speak: true });
      const lp = await readPcm(live.speech.stream, t0);
      const botMs = Date.parse(t.app.ctx.store.run(live.runId).finished_at) - t0;
      const firstSound = lp.first; // measured from sending the turn
      await t.api('POST', `/voice/calls/${c.id}/end`, {});
      check(`${L.name}: voorlezen terwijl de bot schrijft (eerste klank vóór de bot klaar is)`, live.speech.model === L.voice && firstSound < botMs - 500, `eerste klank ${fmt(firstSound)}, bot klaar na ${fmt(botMs)}, ${stats(lp.pcm, lp.rate).seconds.toFixed(1)} s audio`);
      summary.push(`${L.lang}: ${L.voice} · eerste klank ${a.first} ms (koud) / ${dp.first} ms (warm), ${fmt(firstSound)} vanaf de beurt (bot schrijft nog) · WER ${(w * 100).toFixed(1).replace('.', ',')} % via ${h.model}`);
    }
    for (const line of summary) info(line);

    // A bot with its own voice: a Dutch user, a bot that speaks Polish (or the first language tested).
    t.app.ctx.store.setSetting(owner, 'language', 'nl');
    await t.api('PUT', '/voice/settings', { stt: { language: 'auto-app', localModel: '' } });
    const own = langTests.find((x) => x.lang === 'pl') || langTests[0];
    const polBot = await t.api('POST', '/agents', { name: 'Stem', provider_id: sp.id, model: 'slow-1', settings: { voice: { engine: 'local', localVoice: own.voice } } });
    const ownSpeak = await t.api('POST', '/voice/speak', { text: own.sentences[1], agentId: polBot.id });
    check('eigen stem per bot (in een Nederlandse app)', ownSpeak.engine === 'local' && ownSpeak.model === own.voice, `${ownSpeak.model}`);

    // ---------- 5. the settings page: which model dictates which language, voices with licence and size ----------
    await t.api('PUT', '/voice/settings', { stt: { language: 'tr', localModel: '' } });
    const { page, errors } = await launch(dictFile);
    await page.goto(`${t.app.url}/#token=${t.token}`);
    await page.goto(`${t.app.url}/#/settings/voice-spraak`);
    // Which model, the model list and the voices with their licences are behind "Meer opties" (the first view is simple).
    await page.getByTestId('more-options').locator('summary').first().click({ timeout: 15000 });
    const trLine = page.getByRole('status').filter({ hasText: 'Voor het Turks gebruikt TeamBot Whisper large-v3 turbo.' });
    const sawTr = await trLine.waitFor({ timeout: 15000 }).then(() => true, () => false);
    check('instellingen: Turks dicteren → Whisper (staat erbij)', sawTr);
    // (the model list loads after the page)
    const parakeetNote = await page.getByText('Herkent geen Turks.').first().waitFor({ timeout: 10000 }).then(() => true, () => false);
    check('instellingen: Parakeet zegt dat het geen Turks kent', parakeetNote);
    const shots = process.env.VOICE_LIVE_SHOTS;
    if (shots) await page.locator('div.rounded-xl, div.rounded-2xl').filter({ hasText: 'Spraak naar tekst' }).first().screenshot({ path: path.join(shots, 'dicteren-turks.png') }).catch(() => {});
    // Change the language without saving: the line follows at once.
    // The language (card Dicteren) is TeamBot's own dropdown, not a <select>: open it and pick Polish.
    await page.locator('[role="combobox"][data-value="tr"]').first().click();
    await page.locator('[role="option"][data-value="pl"]').click();
    const sawPl = await page.getByRole('status').filter({ hasText: 'Voor het Pools gebruikt TeamBot Parakeet v3.' }).waitFor({ timeout: 5000 }).then(() => true, () => false);
    check('instellingen: andere dicteertaal → meteen het passende model', sawPl);
    await page.getByText('Lokale stemmen downloaden of verwijderen').click();
    const rows = [];
    for (const L of langTests) {
      const label = { pt: 'Common Voice (Portugees, man)', pl: 'M-AILABS (Pools, vrouw)', tr: 'Antalia (Turks, vrouw)' }[L.lang];
      const row = page.locator('div.rounded-xl').filter({ hasText: label }).first();
      const txt = (await row.innerText().catch(() => '')).replace(/\s+/g, ' ');
      rows.push(txt);
      const lic = L.lang === 'tr' ? 'CC-BY-4.0' : 'BSD-3-Clause';
      check(`instellingen: ${label} met grootte, licentie en bron`, txt.includes(`licentie ${lic}`) && /\d+ MB/.test(txt) && txt.includes('op deze computer') && (await row.getByRole('link', { name: 'bron' }).count()) > 0, txt.slice(0, 160));
      if (shots) await row.screenshot({ path: path.join(shots, `stem-${L.lang}.png`) }).catch(() => {});
    }
    // The bot editor offers the new voices too.
    await page.goto(`${t.app.url}/#/agents/${polBot.id}/edit`);
    await page.waitForTimeout(1500);
    let offered = await page.locator('option', { hasText: 'M-AILABS (Pools, vrouw)' }).count();
    // The bot page has three tabs; Spraak is a section behind "Meer opties" on one of them.
    for (const tab of offered ? [] : await page.getByRole('tab').all()) {
      await tab.click();
      await page.evaluate(() => document.querySelectorAll('details').forEach((x) => (x.open = true)));
      await page.waitForTimeout(300);
      const sec = page.locator('#inhoud').getByRole('button', { name: /^Spraak/ }).first();
      if (!(await sec.isVisible().catch(() => false))) continue;
      if ((await sec.getAttribute('aria-expanded').catch(() => 'true')) === 'false') await sec.click();
      await page.waitForTimeout(800);
      offered = await page.locator('option', { hasText: 'M-AILABS (Pools, vrouw)' }).count();
      if (offered) break;
    }
    check('bot-instellingen: de nieuwe stemmen staan in de keuzelijst', offered > 0);
    check('geen fouten in de console (instellingen)', !errors.length, errors.join(' | ').slice(0, 300));
  }
} catch (e) {
  check('onverwachte fout', false, e?.stack || e?.message || String(e));
} finally {
  for (const b of browsers) await b.close().catch(() => {});
  await t.close();
  fs.rmSync(work, { recursive: true, force: true });
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} geslaagd`);
process.exit(failed ? 1 : 0);
