// The free spoken call with barge-in (B-52), many times with a fake microphone, a fake bot and a fake clock.
// voice:live with a real Claude Code bot lost the interruption in 1 of 3 runs: no "(onderbroken)" and no second
// message. Measured in a real browser: while the bot talks, the echo canceller turns your voice down in a jumpy way
// (about every other 50 ms step under the barge threshold), and the detector wanted 350 ms of voice almost without a
// gap, so a short "Wacht even, ik heb een andere vraag" could end before it was sure. Also: while a slow engine was
// still silent (thinking) the microphone did not listen at all, and the new question then waited behind the old
// answer in the run queue.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EnergyVad } from '../ui/src/modules/voice/vad.js';
import { HalfDuplexCore, type HdCapture, type HdDeps } from '../ui/src/modules/voice/halfduplex-core.js';

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

/** Microphone level of one utterance at `ms` into it: syllables with dips, and the pause after a comma. */
function voice(ms: number, r: () => number, commaAt = -1) {
  if (commaAt > 0 && ms > commaAt && ms < commaAt + 350) return 0.004;
  const syll = Math.abs(Math.sin(ms / 70));
  return 0.06 + 0.3 * syll * (0.6 + 0.4 * r());
}

/** The same voice while the bot talks: the echo canceller turns it down, jumpily (measured: 0.02-0.16). */
function ducked(v: number, r: () => number) {
  return v < 0.01 ? v : r() < 0.5 ? 0.015 + 0.028 * r() : 0.05 + 0.11 * r();
}

interface Scenario {
  /** When the question starts and how long it is. */
  qAt: number;
  qLen: number;
  /** After the turn was sent: until the bot's first sound (a slow engine thinks for seconds). */
  firstSound: number;
  /** The bot's voice: sentences with pauses (it is still writing). */
  sentences: { len: number; pause: number }[];
  /** The interruption starts at this time (absolute) and lasts this long. */
  iAt: number;
  iLen: number;
}

/** One call: question, the bot answers (slowly, with pauses), you interrupt. `trace` collects the call's states. */
async function runCall(sc: Scenario, seed: number, trace?: string[]) {
  const r = rng(seed);
  const t0 = Date.now();
  const now = () => Date.now() - t0;
  // Bot audio: absolute [start, end] spans once it starts.
  let audio: { start: number; end: number }[] = [];
  let playing: { resolve: (v: boolean) => void; heard: boolean } | null = null;
  const botTalking = (t: number) => audio.some((a) => t >= a.start && t < a.end);
  const levels: number[] = [];
  const level = () => {
    const t = now();
    let v = 0.002 + 0.002 * r();
    if (t >= sc.qAt && t < sc.qAt + sc.qLen) v = voice(t - sc.qAt, r);
    if (t >= sc.iAt && t < sc.iAt + sc.iLen) {
      v = voice(t - sc.iAt, r, 600);
      if (botTalking(t)) v = ducked(v, r);
    }
    return v;
  };
  const recs: { start: number }[] = [];
  const cap: HdCapture = {
    level: () => levels[levels.length - 1] ?? 0,
    record(pre: number) {
      const rec = { start: now() - pre, stopped: false };
      recs.push(rec);
      return {
        stop: async () => ({ blob: new Blob([new Uint8Array(4000)]), durationMs: now() - rec.start }),
        cancel() {},
      };
    },
    recentLevels: (ms: number) => levels.slice(-Math.ceil(ms / 20)),
    close() {},
  };
  // 20 ms microphone frames, like the capture worklet.
  const frames = setInterval(() => levels.push(level()), 20);
  const posts: any[] = [];
  const runs = new Map<string, { end: number; cancelled: boolean }>();
  let barge = 0;
  const stop = () => {
    const p = playing;
    playing = null;
    audio = audio.map((a) => (a.end > now() ? { ...a, end: Math.max(a.start, now()) } : a)).filter((a) => a.end > a.start);
    p?.resolve(p.heard);
  };
  const deps: HdDeps = {
    async post<T>(p: string, body: any) {
      posts.push({ p, body, at: now() });
      const n = posts.length;
      if (body.interrupt && runs.has(body.interrupt)) runs.get(body.interrupt)!.cancelled = true;
      runs.set(`run${n}`, { end: now() + sc.firstSound + 20_000, cancelled: false });
      await new Promise((res) => setTimeout(res, 60));
      return { status: 'working', text: '', runId: `run${n}`, messageId: null, speech: { id: `sp${n}`, stream: `/s${n}` } } as T;
    },
    async get<T>(p: string) {
      const id = p.split('/').pop()!;
      const run = runs.get(id)!;
      const status = run.cancelled ? 'cancelled' : now() >= run.end ? 'done' : 'working';
      return { status, text: status === 'done' ? 'Klaar.' : '', runId: id, messageId: status === 'done' ? `m_${id}` : null } as T;
    },
    on: () => () => {},
    transcribe: async () => {
      return { text: barge > 0 ? 'Wacht even, ik heb een andere vraag.' : 'Wat is de hoofdstad van Frankrijk?' };
    },
    playLive(_speech, o) {
      return new Promise<boolean>((resolve) => {
        const me = { resolve, heard: false };
        playing = me;
        // The second answer is not played in this test: one interruption per call.
        if (posts.length > 1) return;
        let at = now() + sc.firstSound - 60;
        const spans: { start: number; end: number }[] = [];
        for (const s of sc.sentences) {
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
    now,
  };
  const call = new HalfDuplexCore(
    {
      callId: 'vc_test',
      sttEngine: 'local',
      lang: 'nl',
      cb: { onState: (st) => trace?.push(`${now()} ${st}`), onCaption() {}, onLevel() {}, onError: (m) => assert.fail(m), onBargeIn: () => barge++ },
    },
    deps,
  );
  await call.start({} as MediaStream);
  const end = sc.iAt + sc.iLen + 4000;
  while (now() < end) {
    mock.timers.tick(10);
    await flush();
  }
  call.close();
  clearInterval(frames);
  return { posts, barge, recs, runs };
}

function scenario(r: () => number): Scenario {
  const qAt = 800;
  const qLen = 1800;
  // The turn goes out ~1.2 s after the question (900 ms silence + speech-to-text).
  const sent = qAt + qLen + 900 + 150;
  const firstSound = 300 + Math.round(r() * 6000);
  const sentences = Array.from({ length: 6 }, () => ({ len: 1500 + Math.round(r() * 2500), pause: r() < 0.4 ? Math.round(r() * 1500) : 0 }));
  // Anywhere from "still thinking" to "talking", or in a pause between two sentences.
  const iAt = sent + 400 + Math.round(r() * (firstSound + 9000));
  return { qAt, qLen, firstSound, sentences, iAt, iLen: 2000 };
}

test('free call: an interruption is never lost, while the bot talks, pauses or is still silent (60 calls)', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  try {
    const r = rng(52);
    const lost: string[] = [];
    for (let i = 0; i < 60; i++) {
      const sc = scenario(r);
      const trace: string[] = [];
      const out = await runCall(sc, 1000 + i, trace);
      const second = out.posts[1];
      const ok = out.barge === 1 && out.posts.length === 2 && /andere vraag/.test(second?.body?.text) && second?.body?.interrupt === 'run1';
      if (!ok) lost.push(`#${i}: interruption at ${sc.iAt} ms, first sound ${sc.firstSound} ms after the turn — barge ${out.barge}, turns ${out.posts.map((p) => p.body.text).join(' | ')}${process.env.TRACE ? `\n  ${trace.join('\n  ')}\n  ${JSON.stringify(sc.sentences)}` : ''}`);
      else {
        // The recording starts where you started talking ("Wacht even" is kept), not where the detector was sure.
        const rec = out.recs[out.recs.length - 1];
        assert.ok(rec.start <= sc.iAt + 150, `#${i}: recording starts ${rec.start - sc.iAt} ms after you started`);
        assert.equal(out.posts[0].body.interrupt, undefined, 'the first turn interrupts nothing');
        assert.equal(out.runs.get('run1')!.cancelled, true, 'the interrupted answer stops, the new turn does not wait behind it');
      }
    }
    assert.deepEqual(lost, [], `${lost.length} of 60 interruptions lost:\n${lost.join('\n')}`);
  } finally {
    mock.timers.reset();
  }
});

test('barge-in detector: your voice turned down by the echo canceller while the bot talks still counts', () => {
  // Levels per 50 ms step of "…ik heb een andere vraag" over the bot (measured in Edge, run 4 of the experiment:
  // the old detector reached 300 of its 350 ms and the interruption was lost).
  const steps = [0.043, 0.02, 0.075, 0.03, 0.135, 0.12, 0.02, 0.159, 0.112, 0.03, 0.111, 0.117, 0.03, 0.09, 0.02, 0.065, 0.04, 0.05, 0.02, 0.06, 0.004, 0.004, 0.004];
  let sure = -1;
  const vad = new EnergyVad({ level: () => 0 }, { onStart: () => (sure = sure < 0 ? n : sure), onEnd: () => {} });
  let n = 0;
  for (let i = 0; i < 12; i++) vad.tick(0.002);
  vad.barge = true;
  for (const v of steps) {
    n++;
    vad.tick(v);
  }
  assert.ok(sure > 0 && sure <= 16, `sure after ${sure} steps`);
  // The old rule (350 ms in a row, minus 50 ms per quiet step) on the same steps: never sure.
  let loud = 0;
  let oldSure = false;
  for (const v of steps) {
    if (v > 0.045) loud += 50;
    else loud = Math.max(0, loud - 50);
    if (loud >= 350) oldSure = true;
  }
  assert.equal(oldSure, false, 'the old rule lost it');
  // The bot's own echo after echo cancellation (~0.006-0.03, now and then a peak) never counts as you.
  const echo = new EnergyVad({ level: () => 0 }, { onStart: () => assert.fail('echo counted as you'), onEnd: () => {} });
  for (let i = 0; i < 12; i++) echo.tick(0.002);
  echo.barge = true;
  const r = rng(7);
  for (let i = 0; i < 2000; i++) echo.tick(r() < 0.03 ? 0.05 + 0.03 * r() : 0.006 + 0.024 * r());
});
