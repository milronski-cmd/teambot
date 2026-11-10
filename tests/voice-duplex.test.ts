// The free full-duplex live call on the PC (server/modules/voice/duplex): features for Smart Turn, the session state
// machine (turns, barge-in, what was heard, end_call) with a recorded WAV fixture, and the whole route + audio socket
// with the mock bot. No model downloads: VAD, turn detector, recogniser and voice are fakes here; the real models
// run in tests/e2e/voice-duplex.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startTestApp } from './helpers.js';
import { fakeStt, fakeTts, markInstalled } from './voice-fakes.js';
import { parseWav } from '../server/modules/voice/local/pcm.js';
import { logMel, lastEightSeconds, N_FRAMES } from '../server/modules/voice/duplex/mel.js';
import { DuplexSession, heardText, type Brain } from '../server/modules/voice/duplex/session.js';
import { energyVad } from '../server/modules/voice/duplex/vad.js';
import { silenceOnlyTurn, type TurnDetector } from '../server/modules/voice/duplex/turn.js';
import { setDuplexTestDeps } from '../server/modules/voice/duplex/index.js';
import { DUPLEX_MODELS } from '../server/modules/voice/duplex/catalog.js';
import { spokenWait } from '../server/modules/voice/calltools.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const question = parseWav(fs.readFileSync(path.join(here, 'fixtures', 'duplex-vraag.wav')));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('log-mel features: 80 × 800, last 8 s, a 1 kHz tone lands in the right mel band', () => {
  const tone = new Float32Array(16000).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / 16000));
  const f = logMel(tone);
  assert.equal(f.length, 80 * N_FRAMES);
  // Frame 750 is inside the tone (the tone is the last second of the window).
  let best = 0;
  for (let m = 1; m < 80; m++) if (f[m * N_FRAMES + 750] > f[best * N_FRAMES + 750]) best = m;
  // Slaney scale: 1000 Hz = 15 mel; 80 bands over 0-45.2 mel → band ≈ 15 / 45.25 * 81 - 1 ≈ 26.
  assert.ok(best >= 25 && best <= 27, `peak in band ${best}`);
  // Before the tone: the zero padding, at the floor (max - 8 dB·10, scaled) for every band.
  assert.ok(Math.abs(f[40 * N_FRAMES + 100] - f[10 * N_FRAMES + 100]) < 1e-6);
  assert.equal(lastEightSeconds(new Float32Array(200_000)).length, 128_000);
});

test('heardText: whole sentences up to the stop, the cut one by words', () => {
  const said = [
    { text: 'De bakker gaat om acht uur open.', start: 0, end: 1000, rate: 22050 },
    { text: 'Op zondag is hij dicht.', start: 1000, end: 2000, rate: 22050 },
  ];
  assert.equal(heardText(said, 0), '');
  assert.equal(heardText(said, 1000), 'De bakker gaat om acht uur open.');
  assert.equal(heardText(said, 1500), 'De bakker gaat om acht uur open. Op zondag…');
  assert.equal(heardText(said, 5000), 'De bakker gaat om acht uur open. Op zondag is hij dicht.');
  assert.ok(spokenWait('Wacht even') && spokenWait('nee, nog niet') && !spokenWait('Dank je, dat was het'));
});

/** A session fed in 20 ms steps (faster than real time), with fakes that record what happened. */
function harness(o: { turn?: TurnDetector; answer?: string[]; brainDelayMs?: number; holdAfterFirst?: boolean } = {}) {
  const sent: any[] = [];
  const audio: { epoch: number; bytes: number }[] = [];
  const heard: string[] = [];
  const asked: string[] = [];
  let aborted = 0;
  const brain: Brain = {
    async reply(text, { onSentence, signal }) {
      asked.push(text);
      for (const s of o.answer || ['De bakker gaat om acht uur open.', 'Op zondag is hij dicht.']) {
        if (o.brainDelayMs) await sleep(o.brainDelayMs);
        if (signal.aborted) return void aborted++;
        onSentence(s);
        // Still writing after the first sentence until you interrupt it (whatever the machine's speed).
        if (o.holdAfterFirst) {
          await new Promise((r) => (signal.aborted ? r(null) : signal.addEventListener('abort', r, { once: true })));
          return void aborted++;
        }
      }
    },
    interrupted: (h) => heard.push(h),
  };
  const ended: string[] = [];
  const s = new DuplexSession({
    vad: energyVad({ minSilence: 0.2, minSpeech: 0.1, threshold: 0.5, level: 0.01 }),
    turn: o.turn || silenceOnlyTurn,
    stt: async (a) => (a.length > 8000 ? 'Hoe laat gaat de bakker morgen open?' : ''),
    voice: { synth: async (text) => ({ pcm: Buffer.alloc(text.length * 400), sampleRate: 22050 }) },
    brain,
    send: (m) => sent.push(m),
    sendAudio: (epoch, pcm) => audio.push({ epoch, bytes: pcm.length }),
    onEnd: (r) => ended.push(r),
    maxPauseMs: 600,
  });
  const feed = async (samples: Float32Array) => {
    for (let i = 0; i < samples.length; i += 320) {
      s.samples(samples.subarray(i, i + 320));
      if (i % 3200 === 0) await sleep(0);
    }
  };
  const until = async (f: () => boolean, ms = 3000) => {
    const t0 = Date.now();
    while (!f()) {
      if (Date.now() - t0 > ms) throw new Error('timeout; sent: ' + JSON.stringify(sent.map((m) => m.type)));
      await sleep(5);
    }
  };
  return { s, sent, audio, heard, asked, ended, feed, until, aborted: () => aborted };
}

test('a recorded question: one turn, the bot answers sentence by sentence, latency is reported', async () => {
  const h = harness();
  await h.s.start();
  await h.feed(question.samples);
  await h.until(() => h.sent.some((m) => m.type === 'answer-end'));
  assert.deepEqual(h.asked, ['Hoe laat gaat de bakker morgen open?']);
  const user = h.sent.find((m) => m.type === 'user');
  assert.equal(user.final, true);
  assert.deepEqual(h.sent.filter((m) => m.type === 'bot').map((m) => m.text), ['De bakker gaat om acht uur open.', 'Op zondag is hij dicht.']);
  assert.equal(h.audio.length, 2);
  const lat = h.sent.find((m) => m.type === 'latency');
  assert.ok(lat && lat.totalMs >= 0 && typeof lat.sttMs === 'number', JSON.stringify(lat));
  assert.ok(h.sent.some((m) => m.type === 'phase' && m.phase === 'speaking'));
  // The page played it all: back to listening.
  h.s.control({ type: 'played', epoch: h.audio[0].epoch, samples: 99999 });
  assert.equal(h.sent.filter((m) => m.type === 'phase').pop().phase, 'listening');
});

test('not done yet (Smart Turn says "wait"): no answer until the longer pause', async () => {
  const h = harness({ turn: { name: 'wait', predict: async () => 0.1 } });
  await h.s.start();
  await h.feed(question.samples.subarray(0, Math.round(2.2 * 16000)));
  await sleep(150);
  assert.equal(h.asked.length, 0, 'answered while you were still thinking');
  await h.until(() => h.asked.length === 1, 2000);
});

test('barge-in: talking over the bot stops it at once; only what you heard stays', async () => {
  const h = harness({ answer: ['Eerste zin van het antwoord.', 'Tweede zin.', 'Derde zin die je niet meer hoort.'], holdAfterFirst: true });
  await h.s.start();
  await h.feed(question.samples);
  await h.until(() => h.audio.length >= 1);
  const epoch = h.audio[0].epoch;
  // You start talking while the bot speaks.
  await h.feed(question.samples.subarray(4800, 4800 + 16000));
  await h.until(() => h.sent.some((m) => m.type === 'interrupt'));
  const int = h.sent.find((m) => m.type === 'interrupt');
  assert.equal(int.epoch, epoch);
  await h.until(() => h.aborted() === 1);
  // The page stopped in the first sentence (5000 of its 5600 samples: 4 of its 5 words).
  h.s.control({ type: 'played', epoch, samples: 5000, interrupted: true });
  assert.deepEqual(h.heard, ['Eerste zin van het…']);
  assert.ok(!h.audio.some((a) => a.epoch === epoch && h.audio.indexOf(a) > 1), 'no audio of the old answer after the interruption');
});

test('"Wacht even," on its own is no turn: the bot stays quiet and it goes in front of the rest', async () => {
  let n = 0;
  const h = harness();
  (h.s as any).d.stt = async () => (n++ === 0 ? 'Wacht even.' : 'Ik heb een andere vraag.');
  await h.s.start();
  await h.feed(question.samples);
  await h.until(() => h.sent.some((m) => m.type === 'user' && !m.final));
  await sleep(100);
  assert.equal(h.asked.length, 0, 'the bot answered "wacht even"');
  await h.feed(question.samples);
  await h.until(() => h.asked.length === 1);
  assert.deepEqual(h.asked, ['Wacht even. Ik heb een andere vraag.']);
});

test('talking on while the words are still being recognised: one turn, nothing of the start lost', async () => {
  const lens: number[] = [];
  const h = harness();
  (h.s as any).d.stt = async (a: Float32Array) => (lens.push(a.length), await sleep(400), a.length > 3 * 16000 ? 'Wacht even, ik heb een andere vraag.' : 'Wacht even.');
  await h.s.start();
  await h.feed(question.samples);
  await sleep(60);
  await h.feed(question.samples);
  await h.until(() => h.asked.length === 1, 4000);
  assert.deepEqual(h.asked, ['Wacht even, ik heb een andere vraag.']);
  assert.ok(lens[lens.length - 1] > 4 * 16000, `last recognised turn ${lens[lens.length - 1] / 16000} s`);
});

test('end_call: refused right after "wacht", else goodbye first and hang up after it was played', async () => {
  const h = harness();
  await h.s.start();
  (h.s as any).lastUser = 'Wacht even';
  assert.match(await h.s.endCall({ reason: 'klaar', goodbye: 'Tot ziens!' }), /Niet ophangen/);
  (h.s as any).lastUser = 'Dank je, dat was het';
  assert.match(await h.s.endCall({ reason: 'klaar', goodbye: 'Tot ziens!' }), /Afscheid/);
  await h.until(() => h.sent.some((m) => m.type === 'answer-end'));
  assert.equal(h.sent.filter((m) => m.type === 'bot').pop().text, 'Tot ziens!');
  assert.equal(h.ended.length, 0, 'hung up before the goodbye was heard');
  const end = h.sent.find((m) => m.type === 'answer-end');
  h.s.control({ type: 'played', epoch: end.epoch, samples: end.samples });
  assert.deepEqual(h.ended, ['klaar']);
});

test('end_call: talking over the goodbye means you are not done: no hang-up', async () => {
  const h = harness();
  await h.s.start();
  (h.s as any).lastUser = 'Dat was alles';
  await h.s.endCall({ reason: 'klaar', goodbye: 'Tot ziens!' });
  await h.until(() => h.audio.length === 1);
  await h.feed(question.samples);
  await h.until(() => h.sent.some((m) => m.type === 'interrupt'));
  await sleep(4500);
  assert.deepEqual(h.ended, [], 'hung up although you were talking');
});

test('route + audio socket: free live call with the mock bot, end_call by the bot, phone policy', async () => {
  const t = await startTestApp();
  const stt = fakeStt(() => 'Hoe laat gaat de bakker morgen open?');
  const tts = fakeTts();
  try {
    markInstalled(t.dir, 'parakeet-tdt-0.6b-v3');
    markInstalled(t.dir, 'piper-runtime');
    markInstalled(t.dir, 'nl_NL-alex-medium');
    const agent = await t.agent({ name: 'Baas' });

    // Without the call parts: an honest "download first" with the size, and no call.
    let st = await t.api('GET', '/voice/duplex');
    assert.equal(st.ready, false);
    assert.match(st.problem, /gesprekshulp downloaden \(35 MB\)/);
    assert.deepEqual(st.parts.map((p: any) => [p.licence, p.size]), DUPLEX_MODELS.map((m) => [m.licence, m.files[0].size]));
    await assert.rejects(t.api('POST', '/voice/duplex/calls', { agentId: agent.id }), /409/);

    setDuplexTestDeps({ partsReady: true, vad: () => energyVad({ minSilence: 0.2, minSpeech: 0.1, threshold: 0.5, level: 0.01 }), turn: silenceOnlyTurn });
    st = await t.api('GET', '/voice/duplex');
    assert.equal(st.ready, true, st.problem);
    const { call, socket } = await t.api('POST', '/voice/duplex/calls', { agentId: agent.id });
    assert.equal(call.mode, 'duplex');
    // A socket for someone else's call, or unsigned: refused.
    await assert.rejects(
      new Promise((res, rej) => {
        const w = new WebSocket(t.app.url.replace('http', 'ws') + socket);
        w.on('open', res);
        w.on('error', rej);
      }),
    );

    t.script.push({ text: 'De bakker gaat om acht uur open. Op zondag is hij dicht.' });
    t.script.push({ toolCalls: [{ name: 'end_call', args: { reason: 'Gebruiker is klaar', goodbye: 'Tot ziens!' } }] }, { text: 'Fijne dag.' });
    const ws = new WebSocket(t.app.url.replace('http', 'ws') + t.signed(socket));
    const msgs: any[] = [];
    const bins: Buffer[] = [];
    ws.on('message', (d: Buffer, bin: boolean) => (bin ? bins.push(d) : msgs.push(JSON.parse(String(d)))));
    await new Promise((r) => ws.on('open', r));
    const until = async (f: () => boolean, ms = 8000) => {
      const t0 = Date.now();
      while (!f()) {
        if (Date.now() - t0 > ms) throw new Error('timeout: ' + JSON.stringify(msgs.map((m) => m.type + (m.text ? ':' + m.text : ''))));
        await sleep(10);
      }
    };
    await until(() => msgs.some((m) => m.type === 'ready'));
    const pcm = Buffer.alloc(question.samples.length * 2);
    question.samples.forEach((v, i) => pcm.writeInt16LE(Math.round(v * 32767), i * 2));
    for (let i = 0; i < pcm.length; i += 640 * 5) ws.send(pcm.subarray(i, i + 640 * 5));
    await until(() => msgs.some((m) => m.type === 'answer-end'));
    assert.equal(msgs.find((m) => m.type === 'user').text, 'Hoe laat gaat de bakker morgen open?');
    assert.deepEqual(msgs.filter((m) => m.type === 'bot').map((m) => m.text), ['De bakker gaat om acht uur open.', 'Op zondag is hij dicht.']);
    assert.ok(bins.length >= 2 && bins[0].readUInt32LE(0) === msgs.find((m) => m.type === 'answer').epoch);
    assert.deepEqual(tts.said, ['De bakker gaat om acht uur open.', 'Op zondag is hij dicht.']);
    assert.ok(stt.calls.length >= 1);
    // The turn is a normal message in the bot's chat, the answer too.
    const thread = t.app.ctx.store.thread(call.thread_id)!;
    const chat = t.app.ctx.store.messages(thread.id);
    assert.ok(chat.some((m) => m.role === 'user' && m.content === 'Hoe laat gaat de bakker morgen open?' && m.parts?.voice?.duplex));
    const ep = msgs.find((m) => m.type === 'answer-end');
    ws.send(JSON.stringify({ type: 'played', epoch: ep.epoch, samples: ep.samples }));

    // "Dat was het": the bot calls end_call → goodbye spoken, hang up after the page played it.
    for (let i = 0; i < pcm.length; i += 640 * 5) ws.send(pcm.subarray(i, i + 640 * 5));
    await until(() => msgs.some((m) => m.type === 'bot' && m.text === 'Tot ziens!'));
    await until(() => msgs.filter((m) => m.type === 'answer-end').length >= 2);
    const closed = new Promise((r) => ws.on('close', r));
    const last = msgs.filter((m) => m.type === 'answer-end').pop();
    ws.send(JSON.stringify({ type: 'played', epoch: last.epoch, samples: last.samples }));
    await closed;
    assert.ok(msgs.some((m) => m.type === 'ended'));
    await until(() => t.app.ctx.store.get<any>('voice_calls', call.id)?.status === 'ended');

    // Phone policy: the start route is allowed for a paired device; the gateway lets /ws/voice through.
    const allowed = (t.app.ctx.services.mobileRoutes as { method: string; path: string }[]).map((r) => `${r.method} ${r.path}`);
    assert.ok(allowed.includes('POST /voice/duplex/calls') && allowed.includes('GET /voice/duplex'));
  } finally {
    setDuplexTestDeps(null);
    stt.restore();
    tts.restore();
    await t.close();
  }
});
