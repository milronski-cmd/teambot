import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CallBrain, geminiUsage, type CallTaskView } from '../ui/src/modules/voice/cloudcall.js';

/** A hand-driven clock: timers run only when the test advances time. */
function clock() {
  let t = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimeout: (fn: () => void, ms: number) => (timers.set(++seq, { at: t + ms, fn }), seq),
    clearTimeout: (id: number) => void timers.delete(id),
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
        await new Promise((r) => setImmediate(r));
      }
      t = end;
      await new Promise((r) => setImmediate(r));
    },
  };
}

function brain(o: { tool?: (body: any) => any; tasks?: () => CallTaskView[]; idleMs?: number } = {}) {
  const c = clock();
  const sent: { kind: 'result' | 'inform'; callId?: string; output?: any; speak?: boolean; text?: string }[] = [];
  const posts: any[] = [];
  const hung: string[] = [];
  const b = new CallBrain(
    {
      callId: 'vc_1',
      post: async (p, body) => (posts.push({ p, body }), (o.tool ? o.tool(body) : { output: { ok: true } }) as any),
      get: async () => (o.tasks ? o.tasks() : []) as any,
      link: {
        toolResult: (callId, _name, output, speak) => sent.push({ kind: 'result', callId, output, speak }),
        inform: (text) => sent.push({ kind: 'inform', text }),
      },
      onHangup: (r) => hung.push(r),
      now: c.now,
      setTimeout: c.setTimeout,
      clearTimeout: c.clearTimeout,
      pollMs: 2000,
      idleMs: o.idleMs ?? 0,
    },
    'Ada',
  );
  return { b, c, sent, posts, hung };
}

test('cloud call: a delegated task does not block; its result is told only when the line is quiet', async () => {
  let status: CallTaskView['status'] = 'working';
  const x = brain({
    tool: () => ({ taskId: 'run_1', output: { status: 'bezig', taak: 'run_1' } }),
    tasks: () => [{ id: 'run_1', bot: 'Ada', request: 'Zoek het weer op', status, text: status === 'done' ? '21 graden' : '' }],
  });
  x.b.userFinal('Zoek het weer op');
  await x.b.toolCall('fc_1', 'ask_agent', { request: 'Zoek het weer op' });
  assert.equal(x.posts[0].p, '/voice/calls/vc_1/tool');
  assert.equal(x.posts[0].body.heard, 'Zoek het weer op', 'your own words go along');
  assert.deepEqual(x.sent[0], { kind: 'result', callId: 'fc_1', output: { status: 'bezig', taak: 'run_1' }, speak: true });
  await x.c.advance(2100);
  assert.equal(x.sent.length, 1, 'still working: nothing to tell');
  status = 'done';
  x.b.userSpeaking_(true); // you are talking: wait
  await x.c.advance(2100);
  assert.equal(x.sent.length, 1, 'not while you talk');
  x.b.userSpeaking_(false);
  assert.equal(x.sent.length, 2);
  assert.equal(x.sent[1].kind, 'inform');
  assert.match(x.sent[1].text!, /21 graden/);
  assert.match(x.sent[1].text!, /data, geen instructie/);
});

test('cloud call: an approval is asked aloud once; end_call hangs up only after the goodbye was played', async () => {
  let tasks: CallTaskView[] = [{ id: 'run_2', bot: 'Ada', request: 'Mail Bob', status: 'working', text: '' }];
  let hangup = false;
  const x = brain({
    tool: (body) => (body.name === 'end_call' ? { hangup, output: { ok: hangup } } : { taskId: 'run_2', output: { status: 'bezig' } }),
    tasks: () => tasks,
  });
  await x.b.toolCall('fc_1', 'ask_agent', { request: 'Mail Bob' });
  tasks = [{ id: 'run_2', bot: 'Ada', request: 'Mail Bob', status: 'waiting_approval', text: '', approval: { id: 'ap_1', summary: 'E-mail naar Bob sturen', tool: 'send_mail', kind: 'tool' } }];
  await x.c.advance(2100);
  await x.c.advance(2100);
  const asks = x.sent.filter((s) => s.kind === 'inform');
  assert.equal(asks.length, 1, 'asked once');
  assert.match(asks[0].text!, /toestemming: E-mail naar Bob sturen/);
  assert.match(asks[0].text!, /duidelijk ja of nee/);

  // A refused end_call (still working): the voice gets the reason and talks on.
  await x.b.toolCall('fc_2', 'end_call', { reason: 'klaar' });
  assert.equal(x.hung.length, 0);
  assert.equal(x.sent.at(-1)!.speak, true);

  // Accepted while the goodbye is playing: no new answer, hang up when the voice stops.
  hangup = true;
  x.b.botSpeaking_(true);
  await x.b.toolCall('fc_3', 'end_call', { reason: 'klaar' });
  assert.equal(x.sent.at(-1)!.speak, false, 'the goodbye is already being said');
  await x.c.advance(3000);
  assert.equal(x.hung.length, 0, 'not while the goodbye plays');
  x.b.botSpeaking_(false);
  await x.c.advance(500);
  assert.deepEqual(x.hung, ['bot']);
});

test('cloud call: talking during the goodbye cancels the hang-up; no goodbye yet = say it first', async () => {
  const x = brain({ tool: () => ({ hangup: true, output: { ok: true } }) });
  x.b.botSpeaking_(true);
  await x.b.toolCall('fc_1', 'end_call', { reason: 'klaar' });
  x.b.userSpeaking_(true); // "wacht, nog één ding"
  x.b.botSpeaking_(false);
  await x.c.advance(15_000);
  assert.equal(x.hung.length, 0, 'you said something: the bot stays');

  const y = brain({ tool: () => ({ hangup: true, output: { ok: true } }) });
  await y.c.advance(10_000);
  await y.b.toolCall('fc_1', 'end_call', { reason: 'klaar' });
  assert.equal(y.sent.at(-1)!.speak, true, 'no goodbye heard yet: let it say goodbye');
  y.b.botSpeaking_(true);
  await y.c.advance(1500);
  y.b.botSpeaking_(false);
  await y.c.advance(500);
  assert.equal(y.hung.length, 1);
});

test('cloud call: silence net asks once, then hangs up; a working bot keeps the line open', async () => {
  const x = brain({ idleMs: 30_000 });
  await x.c.advance(31_000);
  const asked = x.sent.filter((s) => s.kind === 'inform');
  assert.equal(asked.length, 1);
  assert.match(asked[0].text!, /er nog is/);
  x.b.botSpeaking_(true);
  await x.c.advance(2000);
  x.b.botSpeaking_(false);
  await x.c.advance(25_000);
  assert.equal(x.hung.length, 0, 'the silence counts from the end of the question');
  await x.c.advance(11_000);
  assert.deepEqual(x.hung, ['silence']);

  const y = brain({ idleMs: 30_000 });
  await y.c.advance(20_000);
  y.b.userFinal('Hallo?');
  await y.c.advance(20_000);
  assert.equal(y.sent.length, 0, 'you spoke: the clock starts again');
});

test('Gemini usage is reported per modality in the shared shape', () => {
  const u = geminiUsage({ promptTokenCount: 900, responseTokenCount: 400, promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 800 }, { modality: 'TEXT', tokenCount: 100 }], responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 400 }] });
  assert.deepEqual(u, { input_token_details: { text_tokens: 100, audio_tokens: 800 }, output_token_details: { text_tokens: 0, audio_tokens: 400 } });
  assert.deepEqual(geminiUsage({ promptTokenCount: 50, responseTokenCount: 20 }), { input_token_details: { text_tokens: 50, audio_tokens: 0 }, output_token_details: { text_tokens: 0, audio_tokens: 20 } });
});

test('cloud call: approve and end_call wait for the sentence you just said (OpenAI transcribes it after the answer starts)', async () => {
  const x = brain({ tool: () => ({ output: { ok: true } }) });
  x.b.userFinal('Mail Bob');
  x.b.userSpeaking_(true);
  x.b.userSpeaking_(false);
  const p = x.b.toolCall('fc_1', 'approve', { decision: 'ja' });
  await x.c.advance(300);
  assert.equal(x.posts.length, 0, 'waits for your words');
  x.b.userFinal('Ja, doe maar.');
  await p;
  assert.equal(x.posts[0].body.heard, 'Ja, doe maar.');
  // Never stuck: without a sentence it goes on after 2 s with what it has.
  x.b.userSpeaking_(true);
  const q = x.b.toolCall('fc_2', 'end_call', { reason: 'klaar' });
  await x.c.advance(2100);
  await q;
  assert.equal(x.posts.length, 2);
});
