// Voice notes from channels (WhatsApp/Telegram send Ogg/Opus): Ogg demuxing, Opus decoding to 16 kHz and the free
// local recogniser behind /voice/transcribe and services.voice.transcribe. The fixtures are real libopus output
// (tests/fixtures/make-voice-notes.ts); the recogniser is a fake that reports what audio it received.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestApp } from './helpers.js';
import { decodeOggOpus, demuxOggOpus, OpusFormatError } from '../server/modules/voice/local/opus.js';
import { frameRms } from '../server/modules/voice/local/pcm.js';
import { oggMux, opusHead, opusTags } from './ogg.js';
import { fakeStt, markInstalled } from './voice-fakes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TONE = fs.readFileSync(path.join(here, 'fixtures', 'toon-16k.ogg'));
const SPEECH = fs.readFileSync(path.join(here, 'fixtures', 'spraakbericht-nl.ogg'));

const stt = fakeStt((s) => `Hoi, dit was ${s.toFixed(1)} seconden.`);
after(() => stt.restore());

test('ogg/opus: fixtures decode to 16 kHz mono with pre-skip and end padding trimmed', async () => {
  const tone = await decodeOggOpus(TONE, 16000);
  assert.equal(tone.sampleRate, 16000);
  assert.ok(Math.abs(tone.seconds - 1.5) < 0.03, `tone length ${tone.seconds}`);
  assert.equal(tone.corruptPackets, 0);
  const rms = frameRms(tone.samples, 16000, 100);
  const loud = rms.slice(1, 11);
  const quiet = rms.slice(13);
  assert.ok(Math.min(...loud) > 0.05, 'the tone is there');
  assert.ok(Math.max(...quiet) < 0.01, 'the silence at the end stays silent');

  const speech = await decodeOggOpus(SPEECH, 16000);
  assert.ok(Math.abs(speech.seconds - 4.36) < 0.05, `speech length ${speech.seconds}`);
  const at48 = await decodeOggOpus(SPEECH, 48000);
  assert.ok(Math.abs(at48.samples.length - speech.samples.length * 3) <= 3, 'same length at another output rate');
});

test('ogg demuxer: packets across pages, lacing, other streams, damage', async () => {
  const src = demuxOggOpus(TONE);
  assert.equal(src.head.channels, 1);
  assert.equal(src.head.preSkip, 312);
  assert.equal(src.packets.length, 75);
  const ref = await decodeOggOpus(TONE, 16000);

  // Same packets, one per page, and a lacing table so small that packets continue on the next page.
  let g = src.head.preSkip;
  const list = [
    { data: opusHead({ channels: 1, preSkip: 312, inputRate: 16000 }), granule: 0 },
    { data: opusTags(), granule: 0 },
    ...src.packets.map((p) => ({ data: p, granule: (g += 960) })),
  ];
  list[list.length - 1].granule = src.lastGranule;
  for (const layout of [{ perPage: 1 }, { perPage: 7, maxSegments: 1 }]) {
    const re = oggMux(list, layout);
    const d = demuxOggOpus(re);
    assert.equal(d.packets.length, 75, JSON.stringify(layout));
    assert.deepEqual(d.packets.map((p) => p.length), src.packets.map((p) => p.length));
    const dec = await decodeOggOpus(re, 16000);
    assert.equal(dec.samples.length, ref.samples.length);
  }

  // A big packet (> 255 bytes) uses 255-lacing; it must come out whole.
  const big = new Uint8Array(700).map((_, i) => i % 251);
  const withBig = demuxOggOpus(oggMux([list[0], list[1], { data: big, granule: 1272 }], { maxSegments: 2 }));
  assert.equal(withBig.packets[0].length, 700);
  assert.deepEqual([...withBig.packets[0].subarray(0, 5)], [0, 1, 2, 3, 4]);

  // A second, non-Opus logical stream in front is skipped (Opus stream is found by its header).
  const vorbisHead = Buffer.concat([Buffer.from([1]), Buffer.from('vorbis'), Buffer.alloc(23)]);
  const other = oggMux([{ data: vorbisHead, granule: 0 }, { data: Buffer.from([3, 1, 2, 3]), granule: 0 }], { serial: 99 });
  assert.equal(demuxOggOpus(Buffer.concat([other, TONE])).packets.length, 75);
  assert.throws(() => demuxOggOpus(other), OpusFormatError, 'Ogg Vorbis is not Opus');
  assert.throws(() => demuxOggOpus(Buffer.from('dit is geen ogg-bestand, echt niet')), OpusFormatError);

  // Cut off in the middle (download interrupted): decode what is there instead of failing.
  const cut = await decodeOggOpus(SPEECH.subarray(0, Math.floor(SPEECH.length * 0.6)), 16000);
  assert.ok(cut.seconds > 1.5 && cut.seconds < 3.5, `partial ${cut.seconds}`);
});

test('local STT accepts Ogg/Opus: /voice/transcribe and services.voice.transcribe (voice notes from channels)', async () => {
  const t = await startTestApp();
  try {
    markInstalled(t.dir, 'parakeet-tdt-0.6b-v3');
    const owner = t.app.ctx.auth.owner()!;
    const post = async (body: Buffer, mime: string) => {
      const res = await fetch(`${t.app.url}/api/voice/transcribe`, { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'content-type': mime }, body: new Uint8Array(body) });
      return { status: res.status, json: (await res.json()) as any };
    };
    stt.calls.length = 0;
    const r = await post(SPEECH, 'audio/ogg; codecs=opus');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.provider, 'Lokaal (deze computer)');
    assert.equal(r.json.cost, 0);
    assert.match(r.json.text, /Hoi, dit was 4\.\d seconden/);
    assert.equal(stt.calls.length, 1);
    assert.equal(stt.calls[0].rate, 16000);
    assert.ok(stt.calls[0].rms > 0.01, 'real audio reached the recogniser');
    assert.ok(Math.abs(r.json.durationSec - 4.36) < 0.05);

    // Telegram declares audio/opus sometimes; same container.
    assert.equal((await post(TONE, 'audio/opus')).status, 200);
    // Ogg that is not Opus: clear 415, not a 500.
    const vorbis = oggMux([{ data: Buffer.concat([Buffer.from([1]), Buffer.from('vorbis'), Buffer.alloc(23)]), granule: 0 }]);
    const bad = await post(vorbis, 'audio/ogg');
    assert.equal(bad.status, 415);
    assert.match(bad.json.error, /Opus/);

    // The service the channels module uses for voice notes.
    const svc = await t.app.ctx.services.voice.transcribe(owner.id, SPEECH, 'audio/ogg');
    assert.match(svc.text, /^Hoi/);
    assert.equal(svc.providerName, 'Lokaal (deze computer)');
    // A channel that only says "some file": the content decides.
    assert.match((await t.app.ctx.services.voice.transcribe(owner.id, SPEECH, 'application/octet-stream')).text, /^Hoi/);
    await assert.rejects(t.app.ctx.services.voice.transcribe(owner.id, Buffer.from('geen audio hier, alleen tekst'), 'application/octet-stream'));
  } finally {
    await t.close();
  }
});
