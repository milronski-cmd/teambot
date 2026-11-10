// TeamBot 0.4, package L (voice): hold-to-talk by default on a computer, hands-free as an option, the bot's own voice
// from the speakers never interrupts it, and every call screen says which bot listens, thinks or speaks.
// The turn-taking runs with a fake microphone, a fake bot voice (with echo from the speakers), a fake clock and the
// same code as the call screen (halfduplex-core.ts, vad.ts, indicator.ts, talk.ts).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EnergyVad } from '../ui/src/modules/voice/vad.js';
import { HalfDuplexCore, type HdCapture, type HdDeps, type HdState } from '../ui/src/modules/voice/halfduplex-core.js';
import { RELEASE_TAIL_MS, isTalkKey, talkMode, type TalkMode } from '../ui/src/modules/voice/talk.js';
import { callIndicator, groupIndicator } from '../ui/src/modules/voice/indicator.js';
import { MIC_CONSTRAINTS, echoCancellationActive } from '../ui/src/modules/voice/mic.js';
import { botSpeechLanguage } from '../shared/voiceLanguage.js';

const flush = () => new Promise((r) => setImmediate(r));

/** mulberry32: a small seeded generator, so every run of this test is the same. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Your voice in the microphone `ms` into what you say: syllables with dips (0.06-0.36). */
const voice = (ms: number, r: () => number) => 0.06 + 0.3 * Math.abs(Math.sin(ms / 70)) * (0.6 + 0.4 * r());
/** The bot's voice as it is played (RMS of the samples the player scheduled): 0.08-0.2, syllables too. */
const botOut = (ms: number, r: () => number) => 0.08 + 0.12 * Math.abs(Math.sin(ms / 60)) * (0.7 + 0.3 * r());

interface Sim {
  talk: TalkMode;
  /** What you say (absolute ms). */
  user?: { at: number; len: number }[];
  /** Key presses (hold mode). */
  press?: { at: number; len: number }[];
  /** After a turn is sent: until the bot's first sound. */
  firstSound?: number;
  /** The bot's first answer, read aloud: sentences with pauses. */
  sentences?: { len: number; pause: number }[];
  /** How much of the bot's voice comes back into the microphone (0 = perfect echo cancellation, 1 = none, loud). */
  echo?: number;
  /** Give the detector the level of the bot's voice as it plays (player.ts outputLevel). */
  ref?: boolean;
  /** The bot asks for approval before it answers. */
  approval?: boolean;
  bargeIn?: boolean;
  /** Switch the talk mode at this time. */
  switchAt?: { at: number; to: TalkMode };
  until: number;
}

async function runSim(sim: Sim, seed = 1) {
  const r = rng(seed);
  const t0 = Date.now();
  const now = () => Date.now() - t0;
  let audio: { start: number; end: number }[] = [];
  let playing: { resolve: (v: boolean) => void; heard: boolean } | null = null;
  const botTalking = (t: number) => audio.some((a) => t >= a.start && t < a.end);
  const levels: number[] = [];
  const outHist: number[] = [];
  const outNow = (t: number) => (botTalking(t) ? botOut(t, r) : 0);
  const level = () => {
    const t = now();
    let v = 0.002 + 0.002 * r();
    // The speakers: the bot's voice comes back about 40 ms later, as loud as the echo canceller leaves it.
    v += (sim.echo ?? 0) * outNow(t - 40);
    for (const u of sim.user || []) if (t >= u.at && t < u.at + u.len) v += voice(t - u.at, r);
    return v;
  };
  const recs: { start: number; cancelled: boolean }[] = [];
  const cap: HdCapture = {
    level: () => levels[levels.length - 1] ?? 0,
    record(pre: number) {
      const rec = { start: now() - pre, cancelled: false };
      recs.push(rec);
      return {
        stop: async () => ({ blob: new Blob([new Uint8Array(4000)]), durationMs: now() - rec.start }),
        cancel() {
          rec.cancelled = true;
        },
      };
    },
    recentLevels: (ms: number) => levels.slice(-Math.ceil(ms / 20)),
    close() {},
  };
  const frames = setInterval(() => {
    levels.push(level());
    outHist.push(outNow(now()));
    if (outHist.length > 50) outHist.shift();
  }, 20);
  const posts: any[] = [];
  const runs = new Map<string, { end: number; cancelled: boolean; approval: boolean }>();
  const states: { at: number; s: HdState }[] = [];
  const hints: string[] = [];
  let barge = 0;
  let stops = 0;
  let transcribes = 0;
  const stop = () => {
    stops++;
    const p = playing;
    playing = null;
    audio = audio.map((a) => (a.end > now() ? { ...a, end: Math.max(a.start, now()) } : a)).filter((a) => a.end > a.start);
    p?.resolve(p.heard);
  };
  const sentences = sim.sentences ?? [{ len: 2500, pause: 400 }, { len: 2500, pause: 0 }];
  const total = sentences.reduce((n, s) => n + s.len + s.pause, 0);
  const firstSound = sim.firstSound ?? 600;
  const deps: HdDeps = {
    async post<T>(_p: string, body: any) {
      posts.push({ body, at: now() });
      const n = posts.length;
      if (body.interrupt && runs.has(body.interrupt)) runs.get(body.interrupt)!.cancelled = true;
      const approval = !!sim.approval && n === 1;
      runs.set(`run${n}`, { end: now() + firstSound + total + 300, cancelled: false, approval });
      await new Promise((res) => setTimeout(res, 40));
      if (approval) return { status: 'waiting_approval', text: '', runId: `run${n}`, messageId: null } as T;
      return { status: 'working', text: '', runId: `run${n}`, messageId: null, speech: { id: `sp${n}`, stream: `/s${n}` } } as T;
    },
    async get<T>(p: string) {
      const id = p.split('/').pop()!;
      const run = runs.get(id)!;
      const status = run.cancelled ? 'cancelled' : run.approval ? 'waiting_approval' : now() >= run.end ? 'done' : 'working';
      return { status, text: status === 'done' ? 'Klaar.' : '', runId: id, messageId: status === 'done' ? `m_${id}` : null, model: 'mock-1' } as T;
    },
    on: () => () => {},
    transcribe: async () => {
      transcribes++;
      return { text: `Zin ${transcribes}.` };
    },
    playLive(_speech, o) {
      return new Promise<boolean>((resolve) => {
        const me = { resolve, heard: false };
        playing = me;
        // Only the first answer is long; later ones say one short sentence.
        const list = posts.length > 1 ? [{ len: 800, pause: 0 }] : sentences;
        let at = now() + firstSound - 40;
        const spans: { start: number; end: number }[] = [];
        for (const s of list) {
          spans.push({ start: at, end: at + s.len });
          at += s.len + s.pause;
        }
        audio = spans;
        setTimeout(() => {
          if (playing !== me) return;
          me.heard = true;
          o.onFirst(now());
        }, Math.max(0, spans[0].start - now()));
        setTimeout(() => {
          if (playing !== me) return;
          playing = null;
          resolve(true);
        }, Math.max(0, spans[spans.length - 1].end - now()));
      });
    },
    playMessage: async () => undefined,
    stopPlayback: stop,
    lastFirstAudioMs: () => null,
    openCapture: async () => cap,
    levelMeter: () => cap,
    recording: () => cap.record(0),
    recognizeOnce: () => ({ result: Promise.resolve(''), abort() {} }),
    // What the player knows: the level of what it plays, the loudest of the last 300 ms (the echo's tail).
    outputLevel: sim.ref ? () => Math.max(0, ...outHist.slice(-15)) : undefined,
    now,
  };
  const call = new HalfDuplexCore(
    {
      callId: 'vc_test',
      sttEngine: 'local',
      lang: 'nl',
      talk: sim.talk,
      bargeIn: sim.bargeIn ?? true,
      cb: { onState: (s) => states.push({ at: now(), s }), onCaption() {}, onLevel() {}, onError: (m) => assert.fail(m), onBargeIn: () => barge++, onHint: (h) => hints.push(h) },
    },
    deps,
  );
  await call.start({} as MediaStream);
  const pressed: { at: number; ok: boolean }[] = [];
  const events = [
    ...(sim.press || []).flatMap((p) => [
      { at: p.at, fn: () => pressed.push({ at: now(), ok: call.press() }) },
      { at: p.at + p.len, fn: () => call.release() },
    ]),
    ...(sim.switchAt ? [{ at: sim.switchAt.at, fn: () => call.setTalk(sim.switchAt!.to) }] : []),
  ].sort((a, b) => a.at - b.at);
  while (now() < sim.until) {
    while (events.length && events[0].at <= now()) events.shift()!.fn();
    mock.timers.tick(10);
    await flush();
  }
  // (hanging up stops the voice too: count only what happened during the call)
  const stopped = stops;
  call.close();
  clearInterval(frames);
  return { posts, barge, recs, runs, states, hints, stops: stopped, transcribes, pressed, call };
}

/** Run with fake timers (the call's timers, intervals and clock). */
async function sim(s: Sim, seed = 1) {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  try {
    return await runSim(s, seed);
  } finally {
    mock.timers.reset();
  }
}

const statesOf = (o: { states: { s: HdState }[] }) => o.states.map((x) => x.s);

// ---------- hold-to-talk ----------

test('hold: nothing is recorded or sent until you press; a pause while you hold does not end your turn; letting go sends it', async () => {
  const out = await sim({
    talk: 'hold',
    // Someone talks in the room before you press: ignored. Then you press, talk, pause 1.5 s to think, talk on.
    user: [{ at: 800, len: 1200 }, { at: 2600, len: 900 }, { at: 5000, len: 900 }],
    press: [{ at: 2500, len: 3600 }],
    until: 14_000,
  });
  assert.equal(statesOf(out)[0], 'ready', 'hold: the call starts ready, not listening');
  assert.equal(out.posts.length, 1, 'one turn');
  assert.ok(out.posts[0].at >= 2500 + 3600 + RELEASE_TAIL_MS, `sent after letting go (+ tail): ${out.posts[0].at} ms`);
  assert.equal(out.posts[0].body.text, 'Zin 1.');
  assert.equal(out.transcribes, 1, 'the room talk before the press was never sent to speech recognition');
  const rec = out.recs.find((x) => !x.cancelled)!;
  assert.ok(rec.start >= 2500 - 250 && rec.start <= 2500, `recording starts at the press (with a little pre-roll): ${rec.start}`);
  // Back to "ready" after the answer.
  assert.equal(statesOf(out).at(-1), 'ready');
  assert.ok(statesOf(out).includes('speaking') && statesOf(out).includes('thinking'));
});

test('hold: the bot\'s own voice from the speakers never interrupts it, even without echo cancellation', async () => {
  for (let i = 0; i < 10; i++) {
    const out = await sim(
      {
        talk: 'hold',
        user: [{ at: 700, len: 1200 }],
        press: [{ at: 600, len: 1500 }],
        // Loud speakers, the echo canceller removes nothing: the microphone hears the bot as loud as it plays.
        echo: 1,
        sentences: [{ len: 3000, pause: 300 }, { len: 3000, pause: 0 }],
        until: 12_000,
      },
      100 + i,
    );
    assert.equal(out.barge, 0, `#${i}: the bot interrupted itself`);
    assert.equal(out.posts.length, 1, `#${i}: no turn from its own voice`);
    assert.equal(out.stops, 0, `#${i}: its voice played to the end`);
  }
});

test('hold: pressing while the bot speaks interrupts it, and what you then say stops that answer', async () => {
  const out = await sim({
    talk: 'hold',
    user: [{ at: 700, len: 1200 }, { at: 6100, len: 1500 }],
    press: [{ at: 600, len: 1500 }, { at: 6000, len: 1800 }],
    echo: 0.6,
    sentences: [{ len: 4000, pause: 300 }, { len: 4000, pause: 0 }],
    until: 14_000,
  });
  assert.deepEqual(out.pressed.map((p) => p.ok), [true, true]);
  assert.equal(out.barge, 1, 'one interruption, by the key');
  assert.ok(out.stops >= 1, 'the bot stopped talking');
  assert.equal(out.posts.length, 2);
  assert.equal(out.posts[1].body.interrupt, 'run1', 'the interrupted answer stops; the new turn does not wait behind it');
  assert.equal(out.runs.get('run1')!.cancelled, true);
});

test('hold: a short tap is not a turn (a calm hint), and pressing while the bot waits for your approval does nothing', async () => {
  const tap = await sim({ talk: 'hold', press: [{ at: 1000, len: 120 }], user: [{ at: 1000, len: 120 }], until: 3000 });
  assert.equal(tap.posts.length, 0);
  assert.equal(tap.transcribes, 0);
  assert.equal(tap.hints.length, 1);
  assert.match(tap.hints[0], /ingedrukt/);
  assert.equal(statesOf(tap).at(-1), 'ready');

  const appr = await sim({ talk: 'hold', approval: true, user: [{ at: 700, len: 1000 }], press: [{ at: 600, len: 1300 }, { at: 4000, len: 1000 }], until: 6000 });
  assert.equal(appr.posts.length, 1);
  assert.deepEqual(appr.pressed.map((p) => p.ok), [true, false], 'the approval card is for your hands');
  assert.ok(appr.hints.some((h) => /goed/.test(h)), appr.hints.join(' | '));
  assert.ok(statesOf(appr).includes('waiting_approval'));
});

test('hold: holding for more than a minute still sends what you said', async () => {
  const out = await sim({ talk: 'hold', user: [{ at: 600, len: 61_000 }], press: [{ at: 500, len: 70_000 }], until: 63_000 });
  assert.equal(out.posts.length, 1, 'sent after the 60 s limit');
  assert.ok(out.posts[0].at >= 60_000 && out.posts[0].at < 62_000, String(out.posts[0].at));
});

test('hold with the browser\'s speech recognition: it listens while you hold the key and the text goes out when you let go', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  try {
    const t0 = Date.now();
    const now = () => Date.now() - t0;
    const started: boolean[] = [];
    const posts: any[] = [];
    const states: HdState[] = [];
    const deps = {
      post: async (_p: string, body: any) => (posts.push(body), { status: 'done', text: 'Prima.', runId: 'r1', messageId: null }),
      get: async () => ({ status: 'done', text: 'Prima.', runId: 'r1', messageId: null }),
      on: () => () => {},
      transcribe: async () => assert.fail('the browser recognises the speech itself'),
      playLive: async () => true,
      playMessage: async () => undefined,
      stopPlayback() {},
      lastFirstAudioMs: () => null,
      openCapture: async () => assert.fail('no capture with the browser engine'),
      levelMeter: () => ({ level: () => 0.01, close() {} }),
      recording: () => assert.fail('no recording'),
      recognizeOnce(_lang: string, _partial: (t: string) => void, continuous?: boolean) {
        started.push(!!continuous);
        let resolve!: (t: string) => void;
        const result = new Promise<string>((r) => (resolve = r));
        return { result, abort: () => resolve(''), stop: () => resolve('Hoe laat is het?') };
      },
      now,
    } as unknown as HdDeps;
    const call = new HalfDuplexCore({ callId: 'vc', sttEngine: 'browser', lang: 'nl', talk: 'hold', cb: { onState: (s) => states.push(s), onCaption() {}, onLevel() {}, onError: (m) => assert.fail(m) } }, deps);
    await call.start({} as MediaStream);
    const run = async (ms: number) => {
      for (const end = now() + ms; now() < end; ) {
        mock.timers.tick(10);
        await flush();
      }
    };
    await run(500);
    assert.deepEqual(started, [], 'no recognition before you press');
    assert.equal(states.at(-1), 'ready');
    assert.equal(call.press(), true);
    assert.deepEqual(started, [true], 'continuous while you hold');
    await run(1500);
    call.release();
    await run(800);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].text, 'Hoe laat is het?');
    assert.equal(states.at(-1), 'ready');
    call.close();
  } finally {
    mock.timers.reset();
  }
});

// ---------- hands-free ----------

test('hands-free: a pause ends your turn; talking over the bot interrupts it', async () => {
  const out = await sim({
    talk: 'handsfree',
    user: [{ at: 800, len: 1500 }, { at: 6500, len: 2000 }],
    // Good echo cancellation: almost nothing of the bot comes back.
    echo: 0.05,
    ref: true,
    sentences: [{ len: 4000, pause: 300 }, { len: 4000, pause: 0 }],
    until: 15_000,
  });
  assert.equal(statesOf(out)[0], 'listening');
  assert.equal(out.posts.length, 2, out.posts.map((p) => `${p.at}:${p.body.text}`).join(' | '));
  assert.ok(out.posts[0].at > 800 + 1500 && out.posts[0].at < 800 + 1500 + 1500, 'the pause after your sentence ended the turn');
  assert.equal(out.barge, 1);
  assert.equal(out.posts[1].body.interrupt, 'run1');
});

/** Bot sentences with pauses, from a seed. */
const sentencesFrom = (r: () => number) => Array.from({ length: 4 }, () => ({ len: 1500 + Math.round(r() * 2000), pause: r() < 0.4 ? Math.round(r() * 800) : 0 }));

test('hands-free over speakers with weak or no echo cancellation: the bot\'s own echo never interrupts it (self-voice gate), your voice still does', async () => {
  const r = rng(77);
  let withoutGate = 0;
  for (let i = 0; i < 12; i++) {
    const sentences = sentencesFrom(r);
    const echo = 0.4 + 0.6 * r();
    // Only your question; the bot then talks for ~8-14 s with its echo in the microphone.
    const base: Sim = { talk: 'handsfree', user: [{ at: 800, len: 1500 }], echo, sentences, until: 20_000 };
    const gated = await sim({ ...base, ref: true }, 500 + i);
    assert.equal(gated.barge, 0, `#${i} (echo ${echo.toFixed(2)}): its own echo interrupted the bot`);
    assert.equal(gated.posts.length, 1, `#${i}: a turn from its own echo`);
    const plain = await sim({ ...base, ref: false }, 500 + i);
    withoutGate += plain.barge;
  }
  // The same echo without the gate (only the higher barge-in threshold): the bot does interrupt itself.
  assert.ok(withoutGate >= 6, `control: without the gate the echo interrupted ${withoutGate} of 12 calls`);

  // You talk over that echo: still an interruption, every time, and your words become the next turn.
  const lost: string[] = [];
  for (let i = 0; i < 12; i++) {
    const sentences = sentencesFrom(r);
    const echo = 0.4 + 0.6 * r();
    const at = 800 + 1500 + 1100 + 1200 + Math.round(r() * 4000);
    const out = await sim({ talk: 'handsfree', user: [{ at: 800, len: 1500 }, { at, len: 2000 }], echo, ref: true, sentences, firstSound: 400, until: at + 6000 }, 900 + i);
    if (out.barge !== 1 || out.posts.length !== 2 || out.posts[1].body.interrupt !== 'run1') lost.push(`#${i} at ${at} ms, echo ${echo.toFixed(2)}: barge ${out.barge}, turns ${out.posts.length}`);
  }
  assert.deepEqual(lost, []);
});

test('switching during the call: hands-free → hold stops listening by itself; hold → hands-free listens again', async () => {
  const toHold = await sim({ talk: 'handsfree', switchAt: { at: 300, to: 'hold' }, user: [{ at: 1000, len: 1500 }], until: 5000 });
  assert.equal(toHold.posts.length, 0, 'no turn without the key after switching to hold');
  assert.equal(statesOf(toHold).at(-1), 'ready');
  assert.equal(toHold.call.talkMode, 'hold');

  const toFree = await sim({ talk: 'hold', switchAt: { at: 300, to: 'handsfree' }, user: [{ at: 1000, len: 1500 }], until: 6000 });
  assert.equal(toFree.posts.length, 1, 'hands-free: your sentence went out by itself');
  assert.ok(statesOf(toFree).includes('listening'));
});

// ---------- the detector itself ----------

test('self-voice gate: learns how loud the bot comes back, ignores that echo, still hears you; without a reference nothing changes', () => {
  let started = 0;
  let out = 0;
  const vad = new EnergyVad({ level: () => 0 }, { onStart: () => started++, onEnd: () => {}, echoRef: () => out });
  for (let i = 0; i < 12; i++) vad.tick(0.003);
  vad.barge = true;
  const r = rng(3);
  // The bot speaks (output 0.08-0.2), the echo is half as loud (0.04-0.1: above the plain barge threshold 0.045).
  for (let i = 0; i < 400; i++) {
    out = botOut(i * 50, r);
    vad.tick(0.5 * out + 0.003 * r());
  }
  assert.equal(started, 0, 'echo is not you');
  assert.ok(Math.abs((vad.echoRatio() ?? 0) - 0.5) < 0.1, `learned ratio ${vad.echoRatio()}`);
  // You talk over it: detected within a second.
  let n = 0;
  for (; n < 40 && !started; n++) {
    out = botOut(20_000 + n * 50, r);
    vad.tick(0.5 * out + voice(n * 50, r));
  }
  assert.equal(started, 1);
  assert.ok(n <= 20, `sure after ${n * 50} ms`);
  // The first 300 ms of bot audio are for learning: even a loud start is not counted.
  let early = 0;
  const fresh = new EnergyVad({ level: () => 0 }, { onStart: () => early++, onEnd: () => {}, echoRef: () => 0.2 });
  for (let i = 0; i < 12; i++) fresh.tick(0.003);
  fresh.barge = true;
  for (let i = 0; i < 6; i++) fresh.tick(0.3);
  assert.equal(early, 0);
  // Without a reference (browser voice, audio file): exactly the old barge rule (350 ms of voice within a second).
  let plain = 0;
  const old = new EnergyVad({ level: () => 0 }, { onStart: () => plain++, onEnd: () => {} });
  for (let i = 0; i < 12; i++) old.tick(0.003);
  old.barge = true;
  for (let i = 0; i < 7; i++) old.tick(0.1);
  assert.equal(plain, 1);
  assert.equal(old.echoRatio(), null);
});

// ---------- defaults, keys, microphone ----------

test('talk mode: hold on a computer, hands-free on a phone, unless chosen; the talk key is a plain space bar outside text fields', () => {
  assert.equal(talkMode('auto', false), 'hold');
  assert.equal(talkMode('auto', true), 'handsfree');
  assert.equal(talkMode(undefined, false), 'hold');
  assert.equal(talkMode('handsfree', false), 'handsfree');
  assert.equal(talkMode('hold', true), 'hold');
  assert.equal(talkMode('nonsense', false), 'hold');
  assert.equal(isTalkKey({ key: ' ', code: 'Space', target: { tagName: 'BUTTON' } }), true);
  assert.equal(isTalkKey({ key: ' ', code: 'Space', target: { tagName: 'DIV' } }), true);
  assert.equal(isTalkKey({ key: ' ', code: 'Space', ctrlKey: true }), false, 'Ctrl+Space is dictation');
  assert.equal(isTalkKey({ key: ' ', code: 'Space', ctrlKey: true, altKey: true }), false, 'Ctrl+Alt+Space is the desktop hotkey');
  assert.equal(isTalkKey({ key: ' ', code: 'Space', target: { tagName: 'TEXTAREA' } }), false);
  assert.equal(isTalkKey({ key: ' ', code: 'Space', target: { tagName: 'INPUT', type: 'text' } }), false);
  assert.equal(isTalkKey({ key: ' ', code: 'Space', target: { tagName: 'INPUT', type: 'checkbox' } }), true);
  assert.equal(isTalkKey({ key: ' ', code: 'Space', target: { tagName: 'DIV', isContentEditable: true } }), false);
  assert.equal(isTalkKey({ key: 'Enter', code: 'Enter' }), false);
});

test('microphone: always with echo cancellation, noise suppression and automatic gain; says when the browser could not switch it on', () => {
  assert.deepEqual(MIC_CONSTRAINTS, { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const stream = (s: any) => ({ getAudioTracks: () => [{ getSettings: () => s }] });
  assert.equal(echoCancellationActive(stream({ echoCancellation: true })), true);
  assert.equal(echoCancellationActive(stream({ echoCancellation: false })), false);
  assert.equal(echoCancellationActive(stream({ echoCancellation: 'all' })), true);
  assert.equal(echoCancellationActive(stream({ echoCancellation: 'remote-only' })), false, 'only for WebRTC audio, not the bot voice this page plays');
  assert.equal(echoCancellationActive(stream({})), null);
  assert.equal(echoCancellationActive(null), null);
});

// ---------- who listens, thinks, speaks ----------

test('call indicator: the bot\'s name with what it does, in plain words', () => {
  assert.deepEqual(callIndicator('listening', 'Ada'), { status: 'listening', text: 'Ada luistert' });
  assert.deepEqual(callIndicator('user', 'Ada'), { status: 'listening', text: 'Ada luistert naar je' });
  assert.deepEqual(callIndicator('transcribing', 'Ada'), { status: 'thinking', text: 'Ada denkt na…' });
  assert.deepEqual(callIndicator('thinking', 'Ada'), { status: 'thinking', text: 'Ada denkt na…' });
  assert.deepEqual(callIndicator('speaking', 'Ada'), { status: 'speaking', text: 'Ada spreekt' });
  assert.deepEqual(callIndicator('waiting_approval', 'Ada'), { status: 'waiting', text: 'Ada wacht op je goedkeuring' });
  assert.equal(callIndicator('ready', 'Ada').text, 'Houd de spatiebalk of de knop ingedrukt om te praten');
  assert.equal(callIndicator('ready', 'Ada', { keyboard: false }).text, 'Houd de knop ingedrukt om te praten', 'a phone has no space bar');
  assert.equal(callIndicator('ready', 'Ada').status, 'idle', 'nobody listens until you press');
  assert.equal(callIndicator('muted', 'Ada').text, 'Microfoon gedempt');
});

test('group indicator: which bot speaks, which ones think, all listen to you; one line for the group', () => {
  const bots = [
    { id: 'a', name: 'Ada' },
    { id: 'b', name: 'Bo' },
    { id: 'c', name: 'Cas' },
  ];
  const st = (o: ReturnType<typeof groupIndicator>) => Object.fromEntries(o.bots.map((b) => [b.name, b.status]));
  // Listening: every face listens.
  let g = groupIndicator({ state: 'listening', bots, speaking: null, working: [] });
  assert.equal(g.text, 'De groep luistert');
  assert.deepEqual(st(g), { Ada: 'listening', Bo: 'listening', Cas: 'listening' });
  g = groupIndicator({ state: 'user', bots, speaking: null, working: [] });
  assert.equal(g.text, 'De groep luistert naar je');
  // Hold mode, nobody pressed: nobody listens.
  g = groupIndicator({ state: 'ready', bots, speaking: null, working: [] });
  assert.equal(g.text, 'Houd de spatiebalk of de knop ingedrukt om te praten');
  assert.deepEqual(st(g), { Ada: 'idle', Bo: 'idle', Cas: 'idle' });
  // Two bots work on an answer.
  g = groupIndicator({ state: 'waiting', bots, speaking: null, working: ['b', 'c'] });
  assert.equal(g.text, 'Bo en Cas denken na…');
  assert.deepEqual(st(g), { Ada: 'idle', Bo: 'thinking', Cas: 'thinking' });
  g = groupIndicator({ state: 'waiting', bots, speaking: null, working: ['a'] });
  assert.equal(g.text, 'Ada denkt na…');
  g = groupIndicator({ state: 'waiting', bots, speaking: null, working: ['a', 'b', 'c'] });
  assert.equal(g.text, '3 bots denken na…');
  // Ada's answer is read aloud while Bo still works: "Ada spreekt", Bo thinks.
  g = groupIndicator({ state: 'speaking', bots, speaking: 'a', working: ['b'] });
  assert.equal(g.text, 'Ada spreekt');
  assert.deepEqual(st(g), { Ada: 'speaking', Bo: 'thinking', Cas: 'idle' });
  // You press to talk while Bo still works: the group listens to you, Bo's face still says it thinks.
  g = groupIndicator({ state: 'user', bots, speaking: null, working: ['b'] });
  assert.equal(g.text, 'De groep luistert naar je');
  assert.deepEqual(st(g), { Ada: 'listening', Bo: 'thinking', Cas: 'listening' });
  // A bot speaks and works at once (its next step): speaking wins.
  assert.equal(st(groupIndicator({ state: 'speaking', bots, speaking: 'b', working: ['b'] })).Bo, 'speaking');
  assert.equal(groupIndicator({ state: 'transcribing', bots, speaking: null, working: [] }).text, 'Omzetten naar tekst…');
});

test('bot language for voice: the bot\'s own choice, else the owner\'s for all bots; "auto" follows you', () => {
  assert.equal(botSpeechLanguage('nl', undefined), 'nl');
  assert.equal(botSpeechLanguage('de', 'nl'), 'de');
  assert.equal(botSpeechLanguage(undefined, 'ar'), 'ar');
  assert.equal(botSpeechLanguage('auto', 'de'), null, 'the bot follows the language you use');
  assert.equal(botSpeechLanguage(undefined, 'auto'), null);
  assert.equal(botSpeechLanguage('xx', undefined), null);
});
