// Barge-in without losing your first words: the voice detector (same code as in the call screen) becomes sure you
// are interrupting only after ≥ 350 ms above a high threshold; when you start softly over the bot that is a second or
// more after you started. The pre-roll goes back to where your speech started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EnergyVad } from '../ui/src/modules/voice/vad.js';
import { FRAME_MS, bargePreRollMs, voiceLevel } from '../ui/src/modules/voice/preroll.js';

/** Simulate 20 ms microphone levels; the detector samples every 50 ms. Returns the detection time and the levels. */
function interrupt(levelAt: (ms: number) => number, totalMs = 6000) {
  const levels: number[] = [];
  let detectedAt: number | null = null;
  const vad = new EnergyVad({ level: () => levels[levels.length - 1] ?? 0 }, { onStart: () => (detectedAt ??= levels.length * FRAME_MS), onEnd: () => {} });
  // Calibrate on the room before the bot talks (as in a call), then barge mode while the bot speaks.
  for (let i = 0; i < 12; i++) vad.tick(0.003);
  vad.barge = true;
  for (let t = 0; t < totalMs && detectedAt === null; t += FRAME_MS) {
    levels.push(levelAt(t));
    if (t % EnergyVad.STEP_MS < FRAME_MS) vad.tick(levels[levels.length - 1]);
  }
  assert.ok(detectedAt !== null, 'barge-in detected');
  return { vad, detectedAt: detectedAt as number, ring: levels.slice(-150) };
}

const wobble = (t: number, a: number) => a * (0.75 + 0.25 * Math.abs(Math.sin(t / 37)));

test('pre-roll: a soft start over the bot is not lost (fixed 1 s pre-roll lost ~0.8 s and more)', (tc) => {
  const start = 2000;
  // Bot echo after echo cancellation ~0.006; you start softly (0.02-0.03) for 1.5 s, then talk normally.
  const { vad, detectedAt, ring } = interrupt((t) => (t < start ? wobble(t, 0.006) : t < start + 1500 ? wobble(t, 0.03) : wobble(t, 0.08)));
  const late = detectedAt - start;
  assert.ok(late >= 1000, `detector sure after ${late} ms`);
  const pre = bargePreRollMs(ring, { threshold: voiceLevel(vad.baseThreshold, vad.threshold) });
  const startsAt = detectedAt - pre;
  assert.ok(startsAt <= start - 150, `recording starts ${start - startsAt} ms before you did (margin)`);
  assert.ok(startsAt >= start - 600, 'not much of the bot echo in front');
  const oldLoss = detectedAt - 1000 - start;
  assert.ok(oldLoss >= 700, `the old fixed 1 s pre-roll missed ${oldLoss} ms`);
  tc.diagnostic(`detector sure ${late} ms after you started; old pre-roll lost ${oldLoss} ms; new pre-roll ${pre} ms starts ${start - startsAt} ms early`);
});

test('pre-roll: loud interruption, syllable pauses, and limits', () => {
  // Starts loud: detector after ~350 ms; pre-roll covers that plus margin, at least 600 ms.
  const loud = interrupt((t) => (t < 1500 ? 0.006 : wobble(t, 0.09)));
  const preLoud = bargePreRollMs(loud.ring, { threshold: voiceLevel(loud.vad.baseThreshold, loud.vad.threshold) });
  assert.ok(loud.detectedAt - preLoud <= 1500 - 200, `${preLoud} ms`);
  // Short pauses between words (< 300 ms) belong to the same stretch.
  const levels = [...Array(50).fill(0.005), ...Array(10).fill(0.03), ...Array(10).fill(0.005), ...Array(30).fill(0.08)];
  const pre = bargePreRollMs(levels, { threshold: 0.016 });
  assert.equal(pre, (50 + 300 / FRAME_MS) * FRAME_MS, 'back to the first word, plus margin');
  // A longer pause (> 600 ms): only the last stretch.
  const apart = [...Array(10).fill(0.03), ...Array(40).fill(0.005), ...Array(30).fill(0.08)];
  assert.equal(bargePreRollMs(apart, { threshold: 0.016 }), 30 * FRAME_MS + 300);
  // Loud echo everywhere (speakers, no echo cancellation): capped, never the whole 3 s.
  assert.equal(bargePreRollMs(Array(150).fill(0.05), { threshold: 0.016 }), 2500);
  assert.equal(bargePreRollMs([], { threshold: 0.016 }), 600);
});

test('pre-roll: "Wacht even, ik heb een andere vraag." keeps "Wacht even" (pause after the comma)', (tc) => {
  // Levels per 20 ms of the local Dutch voice saying it ('.' quiet, '-' soft, '#' loud; measured with frameRms):
  // the detector only becomes sure during "andere vraag", 1.46 s after you started, behind a 340 ms comma pause.
  const said = '......-#####--...########-....##--.................-##-.#######################-..-#######-..................';
  const level = { '.': 0.004, '-': 0.03, '#': 0.08 } as Record<string, number>;
  const start = 1000;
  const { vad, detectedAt, ring } = interrupt((t) => (t < start ? 0.004 : level[said[Math.floor((t - start) / FRAME_MS)] ?? '.'] ?? 0.004));
  const words = start + said.indexOf('-') * FRAME_MS;
  const pre = bargePreRollMs(ring, { threshold: voiceLevel(vad.baseThreshold, vad.threshold) });
  assert.ok(detectedAt - pre <= words, `recording starts at ${detectedAt - pre} ms, "Wacht" at ${words} ms`);
  const narrow = bargePreRollMs(ring, { threshold: voiceLevel(vad.baseThreshold, vad.threshold), gapMs: 300 });
  assert.ok(detectedAt - narrow > words, 'with a 300 ms gap the comma pause would cut it off');
  tc.diagnostic(`detector sure ${detectedAt - words} ms after "Wacht"; pre-roll ${pre} ms (fixed 1 s would start ${detectedAt - 1000 - words} ms too late)`);
});
