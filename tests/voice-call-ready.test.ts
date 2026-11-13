// A call that takes turns (POST /voice/calls, one bot or a group) starts only when it can hear you. Before, it was
// recorded as "active" without speech recognition, and the first turn failed with 409. Now the start itself says what
// is missing and which button fixes it, and no call is recorded. Every voice text names the current place of the
// voice settings (Instellingen › Meer mogelijkheden › Spraak). No downloads, no real models: a fake recogniser.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import AdmZip from 'adm-zip';
import { startTestApp, type TestApp } from './helpers.js';
import { fakeStt, fakeTts, markInstalled } from './voice-fakes.js';
import { getSettings } from '../server/modules/voice/settings.js';
import { localVoice, setLocalCatalog } from '../server/modules/voice/local/service.js';
import { LOCAL_MODELS, type LocalModel } from '../server/modules/voice/local/catalog.js';
import { pcmToWav } from '../server/modules/voice/audio.js';

const stt = fakeStt(() => 'Wat staat er vandaag op de planning?');
const tts = fakeTts();
after(() => {
  stt.restore();
  tts.restore();
  setLocalCatalog(null);
});

// A local "model server" with small fake files in place of the real downloads (670 MB and more).
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const files = new Map<string, Buffer>();
const server = http.createServer((req, res) => {
  const f = files.get(req.url || '');
  if (!f) return res.writeHead(404).end();
  res.writeHead(200, { 'content-length': f.length });
  res.end(f);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const serve = (name: string, body: Buffer) => (files.set('/' + name, body), { path: name, url: `${base}/${name}`, sha256: sha(body), size: body.length });
const zip = new AdmZip();
zip.addFile('piper/piper.exe', Buffer.from('nep'));
const real = (id: string) => LOCAL_MODELS.find((m) => m.id === id)!;
const testCatalog: LocalModel[] = LOCAL_MODELS.map((m) =>
  m.id === 'parakeet-tdt-0.6b-v3'
    ? { ...real(m.id), files: [serve('encoder.int8.onnx', crypto.randomBytes(200_000)), serve('tokens.txt', Buffer.from('a 0\nb 1\n'))] }
    : m.id === 'piper-runtime'
      ? { ...real(m.id), platforms: undefined, files: [{ ...serve('piper.zip', zip.toBuffer()), extract: 'zip' as const }] }
      : m.id === 'nl_NL-alex-medium'
        ? { ...real(m.id), files: [serve('alex.onnx', crypto.randomBytes(20_000)), serve('alex.onnx.json', Buffer.from('{}'))] }
        : m,
);

/** One and a half seconds of a speech-like tone at 16 kHz (the call screen and dictation record 16 kHz PCM). */
function speechPcm(): Buffer {
  const rate = 16000;
  const pcm = Buffer.alloc(rate * 2 * 2);
  for (let i = 0; i < rate * 1.5; i++) pcm.writeInt16LE(Math.round(9000 * Math.abs(Math.sin((Math.PI * 4 * i) / rate)) * Math.sin((2 * Math.PI * 220 * i) / rate)), i * 2);
  return pcm;
}

async function raw(t: TestApp, method: string, p: string, body?: any) {
  const res = await fetch(`${t.app.url}/api${p}`, {
    method,
    headers: { authorization: `Bearer ${t.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}

const calls = (t: TestApp) => t.app.ctx.store.all<any>('SELECT id, status FROM voice_calls');

test('POST /voice/calls: no "active" call without speech recognition; it says what is missing and which button fixes it', async () => {
  const t = await startTestApp();
  try {
    const owner = t.app.ctx.auth.owner()!.id;
    const bot = await t.agent({ name: 'Sam' });
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    const other = await t.agent({ name: 'Lot' });
    const room = await t.api('POST', '/rooms', { name: 'Groep', mode: 'lead', agentIds: [bot.id, other.id] });
    const roomThread = room.thread_id || room.threadId;

    // Fresh install: the free speech recognition is not downloaded.
    const one = await raw(t, 'POST', '/voice/calls', { agentId: bot.id, threadId: th.id });
    assert.equal(one.status, 409, JSON.stringify(one.json));
    assert.equal(one.json.code, 'voice_local_missing');
    assert.match(one.json.error, /gratis spraakherkenning is nog niet gedownload \(\d+ MB\)/);
    assert.match(one.json.error, /"Klaarmaken en bellen"/, 'names the button in the call screen');
    const group = await raw(t, 'POST', '/voice/calls', { threadId: roomThread, group: true });
    assert.equal(group.status, 409);
    assert.equal(group.json.code, 'voice_local_missing');
    assert.deepEqual(calls(t), [], 'no call recorded');

    // The reason the rest of the app shows names the current place of the voice settings.
    const model = getSettings(t.app.ctx, owner).stt.localModel;
    const reason = localVoice(t.app.ctx).sttProblem(model)!;
    assert.match(reason, /Instellingen › Meer mogelijkheden › Spraak/);
    const st = await t.api('GET', '/voice/settings');
    assert.equal(st.status.stt.ready, false);
    assert.match(st.status.stt.missing, /Meer mogelijkheden › Spraak/);
    assert.doesNotMatch(JSON.stringify(st.status), /Instellingen › Spraak/);

    // A speech service was chosen but there is none: 409 with where to fix it.
    await t.api('PUT', '/voice/settings', { stt: { engine: 'provider' } });
    const prov = await raw(t, 'POST', '/voice/calls', { agentId: bot.id, threadId: th.id });
    assert.equal(prov.status, 409);
    assert.equal(prov.json.code, 'voice_stt_missing');
    assert.match(prov.json.error, /Instellingen › Meer mogelijkheden › Spraak/);
    assert.match(prov.json.error, /Instellingen › AI-diensten/);
    assert.deepEqual(calls(t), []);

    // The browser's own recogniser: the page checks it, the server does not block.
    await t.api('PUT', '/voice/settings', { stt: { engine: 'browser' } });
    const browser = await raw(t, 'POST', '/voice/calls', { agentId: bot.id, threadId: th.id });
    assert.equal(browser.status, 200, JSON.stringify(browser.json));
    await t.api('POST', `/voice/calls/${browser.json.id}/end`, {});

    // After the download (marked installed here): the call starts and hears you.
    await t.api('PUT', '/voice/settings', { stt: { engine: 'local' } });
    markInstalled(t.dir, model);
    const ready = await raw(t, 'POST', '/voice/calls', { agentId: bot.id, threadId: th.id });
    assert.equal(ready.status, 200, JSON.stringify(ready.json));
    assert.equal(ready.json.status, 'active');
    const g = await raw(t, 'POST', '/voice/calls', { threadId: roomThread, group: true });
    assert.equal(g.status, 200, JSON.stringify(g.json));
    assert.equal(g.json.mode, 'group');
  } finally {
    await t.close();
  }
});

test('the download the call screen and the microphone button start: 409 before, then the call and dictation work', async () => {
  setLocalCatalog(testCatalog);
  const t = await startTestApp();
  try {
    const bot = await t.agent({ name: 'Sam' });
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    // Fresh install: dictation and the call say what is missing (no dead end, no fake call).
    const dict0 = await raw(t, 'POST', '/voice/stt/stream', { threadId: th.id });
    assert.equal(dict0.status, 409);
    assert.equal(dict0.json.code, 'voice_local_missing', 'the microphone button opens its download on this code');
    assert.match(dict0.json.error, /Instellingen › Meer mogelijkheden › Spraak/);
    assert.equal((await raw(t, 'POST', '/voice/calls', { agentId: bot.id, threadId: th.id })).status, 409);

    // What the buttons download: the models the page computes from the settings (as LocalModels.tsx does).
    const info = await t.api('GET', '/voice/settings');
    const sttId = info.settings.stt.localModel || info.effective.stt.localModel;
    const voiceId = info.settings.tts.localVoice || info.effective.tts.localVoice;
    assert.equal(sttId, 'parakeet-tdt-0.6b-v3');
    assert.equal(voiceId, 'nl_NL-alex-medium');
    for (const id of [sttId, voiceId]) await t.api('POST', `/voice/local/models/${id}/install`, {});
    for (let i = 0; i < 200; i++) {
      const v = await t.api('GET', '/voice/local');
      if (['parakeet-tdt-0.6b-v3', 'piper-runtime', 'nl_NL-alex-medium'].every((id) => v.models.find((m: any) => m.id === id)?.status === 'installed')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const after1 = await t.api('GET', '/voice/settings');
    assert.equal(after1.status.stt.ready, true, 'speech recognition works right after the download');
    assert.equal(after1.status.tts.engine, 'local', 'the free voice too');

    // The call: starts, hears a recording, the bot answers, the answer is spoken with the free voice.
    const call = await t.api('POST', '/voice/calls', { agentId: bot.id, threadId: th.id });
    assert.equal(call.status, 'active');
    const wav = pcmToWav(speechPcm(), 16000);
    const heardRes = await fetch(`${t.app.url}/api/voice/transcribe?callId=${call.id}&threadId=${th.id}`, { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'content-type': 'audio/wav' }, body: new Uint8Array(wav) });
    const heard: any = await heardRes.json();
    assert.equal(heardRes.status, 200, JSON.stringify(heard));
    assert.equal(heard.text, 'Wat staat er vandaag op de planning?');
    t.script.push({ text: 'Om tien uur is het overleg.' });
    const turn = await t.api('POST', `/voice/calls/${call.id}/turn`, { text: heard.text });
    assert.equal(turn.status, 'done', JSON.stringify(turn));
    assert.equal(turn.text, 'Om tien uur is het overleg.');
    tts.said.length = 0;
    const spoken = await t.api('POST', '/voice/speak', { messageId: turn.messageId, callId: call.id });
    assert.equal(spoken.engine, 'local');
    for (let i = 0; i < 100 && !tts.said.length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.match(tts.said.join(' '), /tien uur/, 'the free voice reads the answer');
    assert.equal((await t.api('POST', `/voice/calls/${call.id}/end`, {})).cost, 0);

    // Dictation with the microphone button: live stream of 16 kHz PCM, the text comes back.
    const st = await t.api('POST', '/voice/stt/stream', { threadId: th.id });
    const push = await fetch(`${t.app.url}/api/voice/stt/stream/${st.id}`, { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/octet-stream' }, body: new Uint8Array(speechPcm()) });
    assert.equal(push.status, 200);
    const fin = await t.api('POST', `/voice/stt/stream/${st.id}/end`, {});
    assert.match(fin.text, /Wat staat er vandaag op de planning\?/);
  } finally {
    await t.close();
    setLocalCatalog(null);
  }
});
