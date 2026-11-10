import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { startTestApp, type TestApp } from './helpers.js';
import { checkAudio, chunkText, speakable, estimateSegments, toVtt } from '../server/modules/voice/audio.js';
import { realtimeUsageCost, realtimeEstimate, effective, OPENAI_STT_MODELS } from '../server/modules/voice/catalog.js';
import { sanitize } from '../server/modules/voice/settings.js';
import { runRetention } from '../server/modules/voice/retention.js';

const FIXED_KEY = 'sk-test-FIXEDKEY-0123456789abcdefghij';
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(400, 7)]);

interface Seen {
  path: string;
  auth: string;
  type: string;
  body: Buffer;
}

/** Local stand-in for the OpenAI API (no network to real services in tests). */
async function fakeOpenAI() {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ path: req.url || '', auth: String(req.headers.authorization || ''), type: String(req.headers['content-type'] || ''), body });
      if (req.headers.authorization !== `Bearer ${FIXED_KEY}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'bad key' } }));
      }
      if (req.url === '/v1/realtime/client_secrets') {
        const j = JSON.parse(body.toString('utf8'));
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ value: 'ek_fake_ephemeral_123', expires_at: Math.floor(Date.now() / 1000) + 120, session: { ...j.session, id: 'sess_1', object: 'realtime.session' } }));
      }
      if (req.url === '/v1/audio/transcriptions') {
        if (!String(req.headers['content-type']).startsWith('multipart/form-data')) {
          res.writeHead(400);
          return res.end('{}');
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ text: 'Hallo, dit is een test. Tweede zin.', usage: { type: 'duration', seconds: 3 } }));
      }
      if (req.url === '/v1/audio/speech') {
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        return res.end(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200, 1)]));
      }
      res.writeHead(404);
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  return { url: `http://127.0.0.1:${port}/v1`, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function setup() {
  const t = await startTestApp();
  const fake = await fakeOpenAI();
  const openai = await t.api('POST', '/providers', { kind: 'openai', base_url: fake.url, apiKey: FIXED_KEY });
  // Second user (friend on the same server) with their own session.
  const bea = t.app.ctx.auth.createUser({ name: 'Bea', email: 'bea@example.nl', password: 'wachtwoord123' });
  const beaToken = t.app.ctx.auth.createSession(bea.id).token;
  const as = (token: string) => async (method: string, p: string, body?: any) => {
    const res = await fetch(t.app.url + '/api' + p, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, json, text };
  };
  const raw = async (token: string | null, p: string, buf: Buffer, type: string) => {
    const res = await fetch(t.app.url + '/api' + p, { method: 'POST', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': type }, body: new Uint8Array(buf) });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
  };
  return { t, fake, openai, bea, beaToken, A: as(t.token), B: as(beaToken), raw, close: async () => (await fake.close(), await t.close()) };
}

async function threadFor(t: TestApp, agentId: string) {
  return t.api('POST', '/threads', { agentId });
}

test('realtime client secret: login + own bot required, fixed key never leaves the server', async () => {
  const s = await setup();
  try {
    const a = await s.t.agent({ name: 'Sam', instructions: 'Je bent behulpzaam.' });
    const th = await threadFor(s.t, a.id);

    const anon = await fetch(s.t.app.url + '/api/voice/realtime/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: a.id }) });
    assert.equal(anon.status, 401);

    const other = await s.B('POST', '/voice/realtime/session', { agentId: a.id, threadId: th.id });
    assert.equal(other.status, 404, 'another user cannot start a call with my bot');

    const r = await s.A('POST', '/voice/realtime/session', { agentId: a.id, threadId: th.id, mode: 'direct' });
    assert.equal(r.status, 200, r.text);
    assert.ok(!r.text.includes(FIXED_KEY), 'response must not contain the fixed API key');
    assert.ok(!r.text.includes('FIXEDKEY'));
    assert.equal(r.json.clientSecret, 'ek_fake_ephemeral_123');
    assert.equal(r.json.rtcUrl, s.fake.url + '/realtime/calls');
    assert.equal(r.json.provider.name, 'OpenAI (API)');
    assert.ok(r.json.estimate.low > 0 && r.json.estimate.high >= r.json.estimate.low);
    const sent = s.fake.seen.find((x) => x.path === '/v1/realtime/client_secrets')!;
    assert.equal(sent.auth, `Bearer ${FIXED_KEY}`, 'server authenticates with the fixed key');
    const session = JSON.parse(sent.body.toString('utf8')).session;
    assert.equal(session.model, 'gpt-realtime-2.1-mini');
    assert.match(session.instructions, /je stem is door AI gegenereerd/);
    assert.match(session.instructions, /Je bent behulpzaam/);
    // The same language rule as in the chat, for speech: the language the user speaks; never a fixed Dutch default.
    assert.match(session.instructions, /## Taal\n- Antwoord in de taal waarin de gebruiker spreekt/);
    assert.doesNotMatch(session.instructions, /standaard Nederlands/);
    assert.deepEqual(session.tools, []);
    assert.equal(JSON.parse(sent.body.toString('utf8')).expires_after.seconds, 120);

    const call = s.t.app.ctx.store.get<any>('voice_calls', r.json.call.id);
    assert.equal(call.thread_id, th.id);
    assert.equal(call.status, 'connecting');

    const agentMode = await s.A('POST', '/voice/realtime/session', { agentId: a.id, threadId: th.id, mode: 'agent', model: 'gpt-realtime-2.1' });
    assert.equal(agentMode.status, 200);
    const s2 = JSON.parse(s.fake.seen.filter((x) => x.path === '/v1/realtime/client_secrets').at(-1)!.body.toString('utf8')).session;
    assert.equal(s2.model, 'gpt-realtime-2.1');
    assert.equal(s2.tools[0].name, 'ask_agent');
    assert.doesNotMatch(s2.instructions, /Je bent behulpzaam/, 'agent mode does not need the full instructions');

    const bad = await s.A('POST', '/voice/realtime/session', { agentId: a.id, model: 'gpt-6-super' });
    assert.equal(bad.status, 400, 'models outside the server allowlist are refused');

    // Bea has no OpenAI provider of her own: clear message, no access to Sanne's key.
    const beaAgent = await s.B('POST', '/agents', { name: 'Bea-bot' });
    const noKey = await s.B('POST', '/voice/realtime/session', { agentId: beaAgent.json.id });
    assert.equal(noKey.status, 400);
    assert.equal(noKey.json.code, 'voice_no_openai');
    assert.match(noKey.json.error, /OpenAI API-sleutel/);
  } finally {
    await s.close();
  }
});

test('transcribe: provider call, mime + content check, size limit, memo with captions, isolation', async () => {
  const s = await setup();
  try {
    // The default is the free local engine; this test covers the (paid) provider path.
    await s.A('PUT', '/voice/settings', { stt: { engine: 'provider' } });
    await s.B('PUT', '/voice/settings', { stt: { engine: 'provider' } });
    const a = await s.t.agent();
    const th = await threadFor(s.t, a.id);
    const ok = await s.raw(s.t.token, `/voice/transcribe?threadId=${th.id}&durationMs=3000`, WEBM, 'audio/webm;codecs=opus');
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.text, 'Hallo, dit is een test. Tweede zin.');
    assert.equal(ok.json.model, 'gpt-transcribe');
    assert.equal(ok.json.attachment, null, 'dictation audio is not stored');
    const sent = s.fake.seen.find((x) => x.path === '/v1/audio/transcriptions')!;
    assert.match(sent.type, /^multipart\/form-data/);
    const form = sent.body.toString('latin1');
    assert.match(form, /name="model"\r\n\r\ngpt-transcribe/);
    assert.match(form, /name="languages\[\]"\r\n\r\nnl/, 'Dutch hint by default');
    assert.match(form, /name="keywords\[\]"\r\n\r\nTeamBot/, 'names as recognition hints');
    // The automatic hint follows the interface language (here: German).
    const owner = s.t.app.ctx.auth.owner()!.id;
    s.t.app.ctx.store.setSetting(owner, 'language', 'de');
    const okDe = await s.raw(s.t.token, '/voice/transcribe?durationMs=3000', WEBM, 'audio/webm;codecs=opus');
    assert.equal(okDe.status, 200, JSON.stringify(okDe.json));
    const formDe = s.fake.seen.filter((x) => x.path === '/v1/audio/transcriptions').pop()!.body.toString('latin1');
    assert.match(formDe, /name="languages\[\]"\r\n\r\nde\r\n/, 'German hint for a German interface');
    assert.match(formDe, /name="languages\[\]"\r\n\r\nen\r\n/, 'and English, as Dutch users always had');
    assert.doesNotMatch(formDe, /name="languages\[\]"\r\n\r\nnl\r\n/);
    s.t.app.ctx.store.setSetting(owner, 'language', 'nl');
    const usage = s.t.app.ctx.store.one<any>("SELECT * FROM usage_log WHERE model = 'gpt-transcribe'");
    assert.ok(Math.abs(usage.cost - (3 / 60) * 0.0045) < 1e-9, 'cost from server price list');

    assert.equal((await s.raw(s.t.token, '/voice/transcribe', WEBM, 'text/plain')).status, 415, 'non-audio mime refused');
    assert.equal((await s.raw(s.t.token, '/voice/transcribe', Buffer.from('dit is geen audio, echt niet'), 'audio/webm')).status, 415, 'content must match');
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(100)]);
    assert.equal((await s.raw(s.t.token, '/voice/transcribe', wav, 'audio/webm')).status, 415, 'declared type must match content');
    const big = Buffer.concat([WEBM, Buffer.alloc(25 * 1024 * 1024 + 70 * 1024)]);
    const tooBig = await s.raw(s.t.token, '/voice/transcribe', big, 'audio/webm');
    assert.equal(tooBig.status, 413);
    assert.match(tooBig.json.error, /25 MB/);
    assert.equal((await s.raw(null, '/voice/transcribe', WEBM, 'audio/webm')).status, 401);

    // Voice memo: audio stored as attachment + transcript with (estimated) captions.
    const memo = await s.raw(s.t.token, `/voice/transcribe?threadId=${th.id}&save=1&durationMs=3000`, WEBM, 'audio/webm');
    assert.equal(memo.status, 200);
    const attId = memo.json.attachment.id;
    assert.equal(memo.json.timing, 'estimated');
    assert.equal(memo.json.segments.length, 2);
    const clip = await s.A('GET', `/voice/clips/${attId}`);
    assert.equal(clip.json.transcript, 'Hallo, dit is een test. Tweede zin.');
    const vtt = await s.A('GET', `/voice/clips/${attId}/vtt`);
    assert.match(vtt.text, /^WEBVTT/);
    assert.match(vtt.text, /00:00:00\.000 --> /);
    const audio = await fetch(s.t.app.url + s.t.signed(`/api/voice/clips/${attId}/audio`), { headers: { range: 'bytes=0-3' } });
    assert.equal(audio.status, 206, 'range requests for iOS playback');

    // Bea: no access to Sanne's memo, thread or OpenAI key.
    assert.equal((await s.B('GET', `/voice/clips/${attId}`)).status, 404);
    assert.equal((await s.B('GET', `/voice/clips/${attId}/vtt`)).status, 404);
    assert.equal((await s.raw(s.beaToken, `/voice/transcribe?threadId=${th.id}`, WEBM, 'audio/webm')).status, 404);
    const beaNoKey = await s.raw(s.beaToken, '/voice/transcribe', WEBM, 'audio/webm');
    assert.equal(beaNoKey.status, 400);
    assert.equal(beaNoKey.json.code, 'voice_no_stt');
    assert.equal((await s.B('DELETE', `/voice/clips/${attId}`)).status, 404);

    // Deleting the audio keeps the transcript.
    assert.equal((await s.A('DELETE', `/voice/clips/${attId}`)).status, 200);
    assert.equal((await s.A('GET', `/voice/clips/${attId}`)).json.audio_deleted, true);
    assert.equal(s.t.app.ctx.store.get('attachments', attId), null);
  } finally {
    await s.close();
  }
});

test('text-to-speech: per-message cache, markdown cleaned, browser engine free, isolation, retention', async () => {
  const s = await setup();
  try {
    await s.A('PUT', '/voice/settings', { tts: { engine: 'provider', model: 'gpt-4o-mini-tts', voice: 'cedar' } });
    const a = await s.t.agent();
    const th = await threadFor(s.t, a.id);
    s.t.script.push({ text: '## Kop\nDit is **vet** en `code`.\n\n```js\nconsole.log(1)\n```\nZie [de site](https://example.com).' });
    const msgs = await s.t.say(th.id, 'vertel');
    const answer = msgs.at(-1)!;
    const first = await s.A('POST', '/voice/speak', { messageId: answer.id });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json.engine, 'provider');
    assert.equal(first.json.cached, false);
    assert.equal(first.json.voice, 'cedar');
    const speechCalls = () => s.fake.seen.filter((x) => x.path === '/v1/audio/speech');
    const body = JSON.parse(speechCalls()[0].body.toString('utf8'));
    assert.equal(body.input.includes('```'), false);
    assert.equal(body.input.includes('**'), false);
    assert.match(body.input, /Dit is vet en code/);
    assert.match(body.input, /codevoorbeeld overgeslagen/);
    assert.doesNotMatch(body.input, /example\.com/);

    const again = await s.A('POST', '/voice/speak', { messageId: answer.id });
    assert.equal(again.json.cached, true);
    assert.equal(again.json.id, first.json.id);
    assert.equal(speechCalls().length, 1, 'second play comes from the cache (no second charge)');

    const file = await fetch(s.t.app.url + s.t.signed(`/api${first.json.url}`));
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'audio/mpeg');
    assert.equal(Buffer.from(await file.arrayBuffer()).subarray(0, 3).toString(), 'ID3');

    assert.equal((await s.B('GET', first.json.url)).status, 404, 'cache is per user');
    assert.equal((await s.B('POST', '/voice/speak', { messageId: answer.id })).status, 404);

    // Per-bot browser voice: free, local, no provider call.
    await s.A('PATCH', `/agents/${a.id}`, { settings: { voice: { engine: 'browser', browserVoice: 'Microsoft Frank' } } });
    const local = await s.A('POST', '/voice/speak', { messageId: answer.id });
    assert.equal(local.json.engine, 'browser');
    assert.equal(local.json.browserVoice, 'Microsoft Frank');
    assert.equal(speechCalls().length, 1);

    // Retention: cached audio unused for longer than the setting is removed.
    const row = s.t.app.ctx.store.get<any>('voice_tts', first.json.id);
    assert.ok(fs.existsSync(row.path));
    s.t.app.ctx.store.exec('UPDATE voice_tts SET last_used_at = ? WHERE id = ?', new Date(Date.now() - 40 * 864e5).toISOString(), row.id);
    assert.equal(runRetention(s.t.app.ctx, s.t.app.ctx.store.agent(a.id)!.user_id).tts, 1);
    assert.equal(fs.existsSync(row.path), false);
    assert.equal(s.t.app.ctx.store.get('voice_tts', row.id), null);
  } finally {
    await s.close();
  }
});

test('ask_agent bridge posts into the real bot thread and returns the answer; costs and transcript records', async () => {
  const s = await setup();
  try {
    const a = await s.t.agent({ name: 'Weerman' });
    const th = await threadFor(s.t, a.id);
    const other = await threadFor(s.t, a.id);
    const sess = await s.A('POST', '/voice/realtime/session', { agentId: a.id, threadId: th.id, mode: 'agent' });
    const callId = sess.json.call.id;
    s.t.script.push({ text: 'Het is 21 graden in Utrecht.' });
    const r = await s.A('POST', `/voice/calls/${callId}/ask`, { request: 'Hoe warm is het in Utrecht?' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status, 'done');
    assert.equal(r.json.text, 'Het is 21 graden in Utrecht.');
    const msgs = s.t.app.ctx.store.messages(th.id);
    const req = msgs.find((m) => m.role === 'user' && m.content === 'Hoe warm is het in Utrecht?')!;
    assert.ok(req, 'request is a normal message in the call thread');
    assert.equal(req.parts.voice.via, 'live');
    assert.match(String(req.parts.context), /live spraakgesprek/);
    assert.equal(msgs.at(-1)!.content, 'Het is 21 graden in Utrecht.');
    assert.equal(s.t.app.ctx.store.messages(other.id).length, 0, 'nothing in other threads');
    const run = s.t.app.ctx.store.run(r.json.runId)!;
    assert.equal(run.thread_id, th.id);
    assert.equal(run.trigger, 'voice');

    assert.equal((await s.B('POST', `/voice/calls/${callId}/ask`, { request: 'x' })).status, 404, 'other users cannot use my call');
    assert.equal((await s.B('GET', `/voice/calls/${callId}`)).status, 404);
    assert.equal((await s.B('POST', `/voice/calls/${callId}/end`, {})).status, 404);

    const direct = await s.A('POST', '/voice/realtime/session', { agentId: a.id, threadId: th.id, mode: 'direct' });
    assert.equal((await s.A('POST', `/voice/calls/${direct.json.call.id}/ask`, { request: 'x' })).status, 400, 'direct mode has no bot bridge');

    // Usage priced on the server; warning and cap.
    const ev = await s.A('POST', `/voice/calls/${callId}/events`, {
      status: 'active',
      usage: [{ input_token_details: { text_tokens: 1000, audio_tokens: 600, cached_tokens_details: { text_tokens: 500, audio_tokens: 0 } }, output_token_details: { text_tokens: 100, audio_tokens: 1200 } }],
      lines: [{ role: 'user', text: 'Hoe warm is het?' }, { role: 'assistant', text: 'Ik vraag het aan Weerman.' }],
    });
    const expected = realtimeUsageCost('gpt-realtime-2.1-mini', { input_token_details: { text_tokens: 1000, audio_tokens: 600, cached_tokens_details: { text_tokens: 500 } }, output_token_details: { text_tokens: 100, audio_tokens: 1200 } });
    assert.ok(Math.abs(ev.json.cost - expected) < 1e-6);
    assert.equal(ev.json.overCap, false);
    const huge = await s.A('POST', `/voice/calls/${callId}/events`, { usage: [{ output_token_details: { audio_tokens: 60_000 } }] });
    assert.equal(huge.json.overCap, true, 'price cap reached');

    const end = await s.A('POST', `/voice/calls/${callId}/end`, {});
    assert.equal(end.json.status, 'ended');
    const end2 = await s.A('POST', `/voice/calls/${callId}/end`, {});
    assert.equal(end2.json.status, 'ended', 'idempotent');
    const events = s.t.app.ctx.store.messages(th.id).filter((m) => m.role === 'event');
    assert.ok(events.some((m) => m.parts.kind === 'voice_transcript' && /Ik vraag het aan Weerman/.test(m.content)));
    assert.equal(events.filter((m) => m.parts.kind === 'voice_call').length, 1);
    assert.equal(s.t.app.ctx.store.all("SELECT * FROM usage_log WHERE model = 'gpt-realtime-2.1-mini'").length, 1, 'cost logged once');
    assert.equal((await s.A('POST', `/voice/calls/${callId}/ask`, { request: 'nog iets' })).status, 400, 'ended call cannot be used');
  } finally {
    await s.close();
  }
});

test('direct mode: transcript kept in the thread only when chosen', async () => {
  const s = await setup();
  try {
    const a = await s.t.agent({ name: 'Kletsbot' });
    const th = await threadFor(s.t, a.id);
    const keep = await s.A('POST', '/voice/realtime/session', { agentId: a.id, threadId: th.id, mode: 'direct', keepTranscript: true });
    await s.A('POST', `/voice/calls/${keep.json.call.id}/events`, { status: 'active', lines: [{ role: 'user', text: 'Hoi!' }, { role: 'assistant', text: 'Hallo, ik ben een AI.' }] });
    await s.A('POST', `/voice/calls/${keep.json.call.id}/end`, {});
    let msgs = s.t.app.ctx.store.messages(th.id);
    assert.ok(msgs.some((m) => m.role === 'user' && m.content === 'Hoi!' && m.parts.voice?.transcript));
    assert.ok(msgs.some((m) => m.role === 'assistant' && m.author_id === a.id && m.content === 'Hallo, ik ben een AI.'));

    const th2 = await threadFor(s.t, a.id);
    const nokeep = await s.A('POST', '/voice/realtime/session', { agentId: a.id, threadId: th2.id, mode: 'direct', keepTranscript: false });
    await s.A('POST', `/voice/calls/${nokeep.json.call.id}/events`, { status: 'active', lines: [{ role: 'user', text: 'Geheim' }] });
    const full = await s.A('GET', `/voice/calls/${nokeep.json.call.id}`);
    assert.deepEqual(full.json.transcript, []);
    await s.A('POST', `/voice/calls/${nokeep.json.call.id}/end`, {});
    msgs = s.t.app.ctx.store.messages(th2.id);
    assert.ok(!msgs.some((m) => m.content.includes('Geheim')), 'nothing stored when not kept');
    assert.equal(msgs.filter((m) => m.parts.kind === 'voice_call').length, 1, 'only the call record');
    assert.ok(!JSON.stringify(s.t.app.ctx.store.get('voice_calls', nokeep.json.call.id)).includes('Geheim'));

    // A call that never connected is marked failed without messages.
    const never = await s.A('POST', '/voice/realtime/session', { agentId: a.id, threadId: th2.id });
    const fin = await s.A('POST', `/voice/calls/${never.json.call.id}/end`, {});
    assert.equal(fin.json.status, 'failed');
  } finally {
    await s.close();
  }
});

test('half-duplex call: turn waits for approval through the normal broker', async () => {
  const s = await setup();
  try {
    const a = await s.t.agent({ access_mode: 'ask', tool_groups: ['files'] });
    const th = await threadFor(s.t, a.id);
    const call = await s.A('POST', '/voice/calls', { agentId: a.id, threadId: th.id });
    assert.equal(call.json.kind, 'halfduplex');
    s.t.script.push({ toolCalls: [{ name: 'write_file', args: { path: 'notitie.txt', content: 'hoi' } }] }, { text: 'Opgeslagen.' });
    const turn = await s.A('POST', `/voice/calls/${call.json.id}/turn`, { text: 'Schrijf een notitie', waitMs: 400 });
    assert.equal(turn.json.status, 'waiting_approval', JSON.stringify(turn.json));
    const pending = await s.t.api('GET', '/approvals');
    assert.equal(pending.length, 1);
    assert.equal((await s.B('GET', `/voice/calls/${call.json.id}/runs/${turn.json.runId}`)).status, 404);
    await s.t.api('POST', `/approvals/${pending[0].id}`, { decision: 'approve' });
    await s.t.waitIdle(th.id);
    const res = await s.A('GET', `/voice/calls/${call.json.id}/runs/${turn.json.runId}`);
    assert.equal(res.json.status, 'done');
    assert.equal(res.json.text, 'Opgeslagen.');
    const user = s.t.app.ctx.store.messages(th.id).find((m) => m.role === 'user')!;
    assert.equal(user.parts.voice.via, 'call');
    assert.match(String(user.parts.context), /ingesproken/);
    await s.A('POST', `/voice/calls/${call.json.id}/end`, {});
    const list = await s.A('GET', '/voice/calls');
    assert.equal(list.json[0].status, 'ended');
    assert.equal((await s.B('GET', '/voice/calls')).json.length, 0);
  } finally {
    await s.close();
  }
});

test('settings are validated; realtime provider must be OpenAI; own providers only', async () => {
  const s = await setup();
  try {
    const r = await s.A('PUT', '/voice/settings', { priceCapUsd: 9999, realtime: { model: 'evil-model', voice: 'x' }, stt: { language: 'klingon' }, tts: { speed: 99 } });
    assert.equal(r.json.settings.priceCapUsd, 50);
    assert.equal(r.json.settings.realtime.model, 'gpt-realtime-2.1-mini');
    assert.equal(r.json.settings.stt.language, 'auto-app', 'unknown language: automatic (interface language as hint)');
    assert.equal(r.json.settings.tts.speed, 4);
    assert.equal((await s.A('PUT', '/voice/settings', { realtime: { providerId: s.t.providerId } })).status, 400, 'mock is not OpenAI');
    assert.equal((await s.B('PUT', '/voice/settings', { stt: { providerId: s.openai.id } })).status, 400, 'not your provider');
    const g = await s.A('GET', '/voice/settings');
    assert.equal(g.json.status.realtime.ready, true);
    assert.ok(!g.text.includes(FIXED_KEY));
    assert.equal((await s.B('GET', '/voice/settings')).json.status.realtime.ready, false);
    // generic /settings may hold junk under "voice": it is sanitized on read
    await s.t.api('PUT', '/settings', { voice: { tts: { engine: 'rm -rf' }, maxMinutes: -5 } });
    const after = await s.A('GET', '/voice/settings');
    assert.equal(after.json.settings.tts.engine, 'local', 'default = free local voice');
    assert.equal(after.json.settings.maxMinutes, 1);
  } finally {
    await s.close();
  }
});

test('audio helpers: sniffing, speakable text, chunking, captions, pricing', () => {
  assert.equal(checkAudio(WEBM, 'audio/webm;codecs=opus').ext, 'webm');
  assert.equal(checkAudio(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A '), Buffer.alloc(20)]), 'audio/mp4').ext, 'm4a');
  assert.throws(() => checkAudio(WEBM, 'image/png'), /niet ondersteund/);
  assert.equal(speakable('**Hallo** _wereld_ zie https://x.y/z'), 'Hallo wereld zie link');
  const chunks = chunkText('Zin een. '.repeat(1000), 4000);
  assert.ok(chunks.every((c) => c.length <= 4000) && chunks.length >= 2);
  const segs = estimateSegments('Een. Twee drie vier.', 4);
  assert.equal(segs.length, 2);
  assert.ok(Math.abs(segs[1].end - 4) < 0.01);
  assert.match(toVtt(segs), /00:00:04\.000/);
  const est = realtimeEstimate('gpt-realtime-2.1', 'gpt-4o-mini-transcribe')!;
  assert.ok(est.low > 0.02 && est.high < 0.5);
  assert.equal(realtimeEstimate('unknown', null), null);
  // after the announced shutdown date the server falls back automatically
  const real = Date.now;
  try {
    Date.now = () => Date.parse('2027-03-01T00:00:00Z');
    assert.equal(effective(OPENAI_STT_MODELS, 'whisper-1')!.id, 'gpt-transcribe');
  } finally {
    Date.now = real;
  }
  assert.equal(sanitize({ realtime: { transcribeModel: '' } }).realtime.transcribeModel, '');
});
