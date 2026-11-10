import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestApp } from './helpers.js';
import { spokenConsent, spokenHangUp, spokenWait } from '../server/modules/voice/calltools.js';

const OPENAI_KEY = 'sk-test-LIVEKEY-0123456789abcdefghij';
const GOOGLE_KEY = 'AIza-test-GOOGLEKEY-0123456789';

/** Local stand-ins for OpenAI (client secrets) and Google (ephemeral tokens): no network to real services. */
async function fakeClouds() {
  const seen: { path: string; headers: http.IncomingHttpHeaders; body: any }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body: any = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        /* not json */
      }
      seen.push({ path: req.url || '', headers: req.headers, body });
      const json = (code: number, j: any) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(j)));
      if (req.url === '/v1/realtime/client_secrets') {
        if (req.headers.authorization !== `Bearer ${OPENAI_KEY}`) return json(401, { error: { message: 'bad key' } });
        return json(200, { value: 'ek_fake_live', expires_at: Math.floor(Date.now() / 1000) + 120 });
      }
      if (req.url === '/v1beta/auth_tokens') {
        if (req.headers['x-goog-api-key'] !== GOOGLE_KEY) return json(403, { error: { message: 'API key not valid' } });
        return json(200, { name: 'auth_tokens/fake-gemini-123' });
      }
      json(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  return { port, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function setup() {
  const t = await startTestApp();
  const fake = await fakeClouds();
  await t.api('POST', '/providers', { kind: 'openai', base_url: `http://127.0.0.1:${fake.port}/v1`, apiKey: OPENAI_KEY });
  const raw = async (method: string, p: string, body?: any) => {
    const res = await fetch(t.app.url + '/api' + p, { method, headers: { authorization: `Bearer ${t.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return {}; } })() as any };
  };
  return { t, fake, raw, close: async () => (await fake.close(), await t.close()) };
}

const until = async <T>(fn: () => T | Promise<T>, ms = 8000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('time-out');
    await new Promise((r) => setTimeout(r, 30));
  }
};

test('spoken checks: hang up only on a clear request, never after "wacht"; consent only on a clear ja or nee', () => {
  for (const s of ['Hang maar op', 'Oké, dank je, hang maar op.', 'je mag ophangen', 'Beëindig het gesprek', 'hang up please', 'Nee bedankt, leg maar neer']) assert.equal(spokenHangUp(s), true, s);
  for (const s of ['niet ophangen', 'hoe hang ik op?', 'hang de poster op in de gang', 'wacht, hang nog niet op', '']) assert.equal(spokenHangUp(s), false, s);
  for (const s of ['Wacht even', 'momentje', 'nee', 'Nee nee', 'hang niet op', 'hold on', 'nog niet']) assert.equal(spokenWait(s), true, s);
  for (const s of ['Nee dank je, dat was het', 'doei!', 'bedankt, tot ziens', 'dat was alles']) assert.equal(spokenWait(s), false, s);
  for (const s of ['ja', 'Ja graag.', 'ja, doe maar', 'akkoord', 'yes please']) assert.equal(spokenConsent(s), 'yes', s);
  for (const s of ['nee', 'Nee, niet doen', 'liever niet', 'no']) assert.equal(spokenConsent(s), 'no', s);
  for (const s of ['oké', 'ja maar wacht', 'ja nee', 'misschien', 'ja, en zet het ook in mijn agenda voor morgen om negen uur']) assert.equal(spokenConsent(s), null, s);
});

test('cloud call tools: ask_agent does not block, ask_bot reaches another bot, tasks report the result', async () => {
  const s = await setup();
  try {
    const bot = await s.t.agent({ name: 'Ada' });
    const planner = await s.t.agent({ name: 'Planner' });
    const th = await s.t.api('POST', '/threads', { agentId: bot.id });
    const sess = await s.raw('POST', '/voice/realtime/session', { agentId: bot.id, threadId: th.id, mode: 'agent' });
    assert.equal(sess.status, 200, sess.text);
    // The Realtime session carries all call tools, and the voice is told to delegate and hang up itself.
    const sent = s.fake.seen.find((x) => x.path === '/v1/realtime/client_secrets')!.body.session;
    const names = sent.tools.map((x: any) => x.name);
    for (const n of ['ask_agent', 'ask_bot', 'task_status', 'approve', 'end_call']) assert.ok(names.includes(n), n);
    assert.match(sent.instructions, /end_call/);
    assert.match(sent.instructions, /Planner/);
    assert.ok(!JSON.stringify(sess.json).includes(OPENAI_KEY), 'key never in the answer');
    const callId = sess.json.call.id;

    // A quick answer comes back at once.
    s.t.script.push({ text: 'Het is 21 graden.' });
    const quick = await s.raw('POST', `/voice/calls/${callId}/tool`, { name: 'ask_agent', args: { request: 'Hoe warm is het?' }, heard: 'Hoe warm is het?' });
    assert.equal(quick.status, 200, quick.text);
    assert.equal(quick.json.output.status, 'klaar');
    assert.equal(quick.json.output.antwoord, 'Het is 21 graden.');

    // Not waiting at all: "bezig" with a task id; the result shows up in the task list.
    s.t.script.push({ text: 'Je hebt morgen twee afspraken.' });
    const slow = await s.raw('POST', `/voice/calls/${callId}/tool`, { name: 'ask_bot', args: { bot: 'planner', request: 'Wat staat er morgen?' }, quickMs: 0 });
    assert.equal(slow.json.output.status, 'bezig', slow.text);
    assert.equal(slow.json.output.bot, 'Planner');
    assert.ok(slow.json.taskId);
    const run = s.t.app.ctx.store.run(slow.json.taskId)!;
    assert.equal(run.agent_id, planner.id, 'the other bot does the work');
    assert.notEqual(run.thread_id, th.id, 'in its own chat');
    const tasks = await until(async () => {
      const r = await s.raw('GET', `/voice/calls/${callId}/tasks`);
      const t = r.json.find((x: any) => x.id === slow.json.taskId);
      return t?.status === 'done' ? r.json : null;
    });
    assert.equal(tasks.length, 2);
    assert.equal(tasks[1].text, 'Je hebt morgen twee afspraken.');
    assert.equal(tasks[1].request, 'Wat staat er morgen?');
    const status = await s.raw('POST', `/voice/calls/${callId}/tool`, { name: 'task_status', args: {} });
    assert.equal(status.json.output.taken.length, 2);

    // Unknown bot: a plain answer with the names, no run.
    const none = await s.raw('POST', `/voice/calls/${callId}/tool`, { name: 'ask_bot', args: { bot: 'Zorro', request: 'x' } });
    assert.equal(none.json.output.status, 'onbekend');
    assert.match(none.json.output.bericht, /Ada, Planner|Planner, Ada/);

    // Another user's call is not reachable; a direct-mode call has no bot tools.
    const direct = await s.raw('POST', '/voice/realtime/session', { agentId: bot.id, threadId: th.id, mode: 'direct' });
    assert.equal((await s.raw('POST', `/voice/calls/${direct.json.call.id}/tool`, { name: 'ask_agent', args: { request: 'x' } })).status, 400);
  } finally {
    await s.close();
  }
});

test('spoken approval: a clear "ja" approves once (never always); end_call waits for tasks and never follows "wacht"', async () => {
  const s = await setup();
  try {
    const bot = await s.t.agent({ name: 'Schrijver', access_mode: 'ask', tool_groups: ['files'] });
    const th = await s.t.api('POST', '/threads', { agentId: bot.id });
    const sess = await s.raw('POST', '/voice/realtime/session', { agentId: bot.id, threadId: th.id, mode: 'agent' });
    const callId = sess.json.call.id;
    s.t.script.push({ toolCalls: [{ name: 'write_file', args: { path: 'boodschappen.txt', content: 'melk' } }] }, { text: 'Het lijstje staat erin.' });
    const ask = await s.raw('POST', `/voice/calls/${callId}/tool`, { name: 'ask_agent', args: { request: 'Zet melk op het boodschappenlijstje' }, quickMs: 0 });
    const runId = ask.json.taskId;
    assert.ok(runId, ask.text);
    const ap = await until(() => s.t.app.ctx.store.one<any>("SELECT * FROM approvals WHERE run_id = ? AND status = 'pending'", runId));
    const t1 = (await s.raw('GET', `/voice/calls/${callId}/tasks`)).json[0];
    assert.equal(t1.status, 'waiting_approval');
    assert.equal(t1.approval.id, ap.id);

    // Hanging up mid-task is refused, and never right after "wacht".
    const mid = await s.raw('POST', `/voice/calls/${callId}/tool`, { name: 'end_call', args: { reason: 'klaar' }, heard: 'Dat was het, doei' });
    assert.equal(mid.json.output.ok, false);
    assert.notEqual(mid.json.hangup, true);
    assert.match(mid.json.output.bericht, /nog bezig/);
    const wait = await s.raw('POST', `/voice/calls/${callId}/tool`, { name: 'end_call', args: { reason: 'klaar' }, heard: 'Wacht even' });
    assert.equal(wait.json.output.ok, false);

    // "Oké" is no answer; the voice model cannot approve on its own.
    const vague = await s.raw('POST', `/voice/calls/${callId}/tool`, { name: 'approve', args: { decision: 'ja' }, heard: 'oké' });
    assert.equal(vague.json.output.ok, false);
    const self = await s.raw('POST', `/voice/calls/${callId}/tool`, { name: 'approve', args: { decision: 'ja' }, heard: '' });
    assert.equal(self.json.output.ok, false);
    assert.equal(s.t.app.ctx.store.get<any>('approvals', ap.id).status, 'pending');

    const yes = await s.raw('POST', `/voice/calls/${callId}/tool`, { name: 'approve', args: { decision: 'ja' }, heard: 'Ja, doe maar.' });
    assert.equal(yes.json.output.ok, true, yes.text);
    assert.equal(s.t.app.ctx.store.get<any>('approvals', ap.id).status, 'approved');
    assert.equal(s.t.app.ctx.store.agent(bot.id)!.tool_policy?.write_file, undefined, 'never "always allow"');
    await until(async () => (await s.raw('GET', `/voice/calls/${callId}/tasks`)).json[0].status === 'done');

    // Done and the user says goodbye: the bot may hang up; the call log lands in the chat.
    const bye = await s.raw('POST', `/voice/calls/${callId}/tool`, { name: 'end_call', args: { reason: 'de gebruiker nam afscheid', summary: 'Melk staat op het boodschappenlijstje.' }, heard: 'Nee dank je, dat was het.' });
    assert.equal(bye.json.output.ok, true, bye.text);
    assert.equal(bye.json.hangup, true);
    await s.raw('POST', `/voice/calls/${callId}/end`, {});
    const ev = s.t.app.ctx.store.messages(th.id).filter((m) => m.role === 'event' && m.parts?.kind === 'voice_call').at(-1)!;
    assert.match(ev.content, /Schrijver hing op: de gebruiker nam afscheid/);
    assert.match(ev.content, /Samenvatting: Melk staat op het boodschappenlijstje\./);
    assert.match(ev.content, /• Schrijver: Zet melk op het boodschappenlijstje \(klaar\)/);
    assert.equal(ev.parts.endedBy, 'bot');
    assert.equal(ev.parts.tasks.length, 1);
    // A spoken decision is audited as such.
    assert.equal(s.t.app.ctx.store.all("SELECT * FROM audit WHERE kind = 'voice.call.approval'").length, 1);
  } finally {
    await s.close();
  }
});

test('end_call: your own clear "hang op" ends even while a task runs; the user can always hang up', async () => {
  const s = await setup();
  try {
    const bot = await s.t.agent({ name: 'Ada', access_mode: 'ask', tool_groups: ['files'] });
    const th = await s.t.api('POST', '/threads', { agentId: bot.id });
    const sess = await s.raw('POST', '/voice/realtime/session', { agentId: bot.id, threadId: th.id, mode: 'agent' });
    const callId = sess.json.call.id;
    s.t.script.push({ toolCalls: [{ name: 'write_file', args: { path: 'a.txt', content: 'a' } }] });
    await s.raw('POST', `/voice/calls/${callId}/tool`, { name: 'ask_agent', args: { request: 'Schrijf a' }, quickMs: 0 });
    await until(() => s.t.app.ctx.store.one<any>("SELECT id FROM approvals WHERE thread_id = ? AND status = 'pending'", th.id));
    const r = await s.raw('POST', `/voice/calls/${callId}/tool`, { name: 'end_call', args: { reason: 'gevraagd' }, heard: 'Oké, hang maar op' });
    assert.equal(r.json.hangup, true, r.text);
    const ended = await s.raw('POST', `/voice/calls/${callId}/end`, {});
    assert.equal(ended.json.status, 'ended');
    const ev = s.t.app.ctx.store.messages(th.id).filter((m) => m.role === 'event' && m.parts?.kind === 'voice_call').at(-1)!;
    assert.match(ev.content, /wacht op goedkeuring/, 'the log says what is still open');
    // Tools of an ended call are refused.
    assert.equal((await s.raw('POST', `/voice/calls/${callId}/tool`, { name: 'task_status' })).status, 400);
  } finally {
    await s.close();
  }
});

test('Gemini Live: single-use token from the server, Google key stays there, NON_BLOCKING tools, Dutch-ready setup', async () => {
  const s = await setup();
  try {
    const bot = await s.t.agent({ name: 'Ada' });
    const th = await s.t.api('POST', '/threads', { agentId: bot.id });
    const before = await s.raw('GET', '/voice/settings');
    assert.equal(before.json.status.gemini.ready, false);
    const no = await s.raw('POST', '/voice/gemini/session', { agentId: bot.id, threadId: th.id });
    assert.equal(no.status, 400);
    assert.equal(no.json.code, 'voice_no_gemini');
    assert.match(no.json.error, /Google AI Studio/);

    await s.t.api('POST', '/providers', { kind: 'google', base_url: `http://127.0.0.1:${s.fake.port}/v1beta/openai`, apiKey: GOOGLE_KEY });
    assert.equal((await s.raw('GET', '/voice/settings')).json.status.gemini.ready, true);
    const r = await s.raw('POST', '/voice/gemini/session', { agentId: bot.id, threadId: th.id, mode: 'agent' });
    assert.equal(r.status, 200, r.text);
    assert.ok(!r.text.includes(GOOGLE_KEY), 'the Google key never reaches the browser');
    assert.equal(r.json.token, 'auth_tokens/fake-gemini-123');
    assert.equal(r.json.wsUrl, `ws://127.0.0.1:${s.fake.port}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=auth_tokens%2Ffake-gemini-123`);
    const minted = s.fake.seen.find((x) => x.path === '/v1beta/auth_tokens')!;
    assert.equal(minted.body.uses, 1);
    assert.equal(minted.body.liveConnectConstraints.model, 'models/gemini-3.8-live');
    const decl = r.json.setup.tools[0].functionDeclarations;
    assert.equal(decl.find((d: any) => d.name === 'ask_agent').behavior, 'NON_BLOCKING');
    assert.equal(decl.find((d: any) => d.name === 'end_call').behavior, undefined);
    assert.equal(decl.find((d: any) => d.name === 'task_status').parameters, undefined, 'no empty schema');
    assert.equal(r.json.setup.generationConfig.responseModalities[0], 'AUDIO');
    assert.ok(r.json.setup.inputAudioTranscription, 'your words are transcribed (approve and end_call check them)');
    assert.match(r.json.setup.systemInstruction.parts[0].text, /end_call/);
    assert.equal(r.json.call.model, 'gemini-3.8-live');

    // Usage reported in the shared shape is priced from Gemini's own list.
    const ev = await s.raw('POST', `/voice/calls/${r.json.call.id}/events`, { status: 'active', usage: [{ input_token_details: { audio_tokens: 100_000 }, output_token_details: { audio_tokens: 100_000 } }] });
    assert.ok(Math.abs(ev.json.cost - (0.3 + 1.2)) < 1e-6, String(ev.json.cost));
    await s.raw('POST', `/voice/calls/${r.json.call.id}/end`, {});
    const log = s.t.app.ctx.store.messages(th.id).filter((m) => m.role === 'event' && m.parts?.kind === 'voice_call').at(-1)!;
    assert.match(log.content, /Gemini gemini-3\.8-live/);

    // Only a Google provider can be chosen for Gemini Live.
    assert.equal((await s.raw('PUT', '/voice/settings', { gemini: { providerId: s.t.providerId } })).status, 400);
  } finally {
    await s.close();
  }
});
