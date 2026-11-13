// Speak while the bot is still answering: the streaming sentence splitter, and the live voice job that follows a
// run's text (free call turn with speak: true, /voice/speak/run for read-aloud), with interruption and caching.
// The bot is a fake that streams its answer slowly (like a real model); Piper is a fake that records what it says.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp } from './helpers.js';
import { SpeechSplitter, speakPiece, splitForSpeech } from '../server/modules/voice/sentences.js';
import type { ChatRequest, ChatResult, StreamEvent } from '../server/core/types.js';
import { fakeTts, markInstalled } from './voice-fakes.js';

const tts = fakeTts({ msPerChar: 10, delayMs: 15 });
after(() => tts.restore());

test('sentence splitter: complete sentences as soon as they are there; same result for any delta size', () => {
  const text =
    '## Plan voor morgen\n\nGoedemorgen! Ik heb drie punten. 1. Eerst bellen met dr. Jansen, o.a. over de offerte van 3.500 euro.\n' +
    '- Daarna een **mail** naar J. de Vries (zie teambot.app).\n\nHier is de code:\n```ts\nconst x = 1. // geen zin\n```\nKlaar... Vragen?';
  const want = [
    'Plan voor morgen',
    'Goedemorgen!',
    'Ik heb drie punten.',
    '1. Eerst bellen met dr. Jansen, o.a. over de offerte van 3.500 euro.',
    'Daarna een mail naar J. de Vries (zie teambot.app).',
    'Hier is de code:',
    '(codevoorbeeld overgeslagen)',
    'Klaar...',
    'Vragen?',
  ];
  for (const size of [0, 1, 3, 8, 50]) assert.deepEqual(splitForSpeech(text, size), want, `delta size ${size}`);

  // Released the moment the next character shows the sentence is over; not before.
  const s = new SpeechSplitter();
  assert.deepEqual(s.push('Hallo daar.'), []);
  assert.deepEqual(s.push(' Hoe'), ['Hallo daar.']);
  assert.deepEqual(s.push(' gaat het?'), []);
  assert.deepEqual(s.push('\n'), ['Hoe gaat het?']);
  assert.deepEqual(s.end(), []);

  // A long first sentence is cut at a comma so the voice can start early; later ones may be longer.
  const long = 'Dit is een vrij lange openingszin die maar doorgaat, omdat de bot graag uitlegt wat hij gaat doen en waarom hij dat zo doet, en daarna nog meer';
  const first = new SpeechSplitter().push(long);
  assert.equal(first.length, 1);
  assert.match(first[0], /,$/);
  assert.ok(first[0].length >= 40 && first[0].length <= 130, first[0]);
  // Tables and stray markers stay pleasant to hear.
  assert.deepEqual(splitForSpeech('| Naam | Prijs |\n|---|---|\n| Appel | 2 |\n'), ['Naam, Prijs,', 'Appel, 2,']);
  assert.equal(speakPiece('**Let op'), 'Let op');
  assert.equal(speakPiece('---'), '');
  assert.deepEqual(splitForSpeech('```\nalleen code\n```'), ['(codevoorbeeld overgeslagen)']);
});

// ---------- a bot that streams like a real model: first token after `ttftMs`, then `cps` characters per second ----------
interface SlowStep {
  text: string;
  toolCalls?: { name: string; args: any }[];
}
function slowBot(t: TestApp, steps: SlowStep[], o: { ttftMs: number; cps: number }) {
  t.app.ctx.providers.registerKind({
    id: 'slowmock',
    label: 'Slow mock',
    type: 'api',
    needsKey: false,
    description: 'test',
    models: ['slow-1'],
    defaultModel: 'slow-1',
    create: () => ({
      kind: 'slowmock',
      async listModels() {
        return [{ id: 'slow-1' }];
      },
      async test() {
        return { ok: true, detail: 'slow' };
      },
      async chat(req: ChatRequest, signal: AbortSignal, onEvent: (e: StreamEvent) => void): Promise<ChatResult> {
        const step = steps.shift() || { text: 'Klaar.' };
        await new Promise((r) => setTimeout(r, o.ttftMs));
        const chunk = 6;
        for (let i = 0; i < step.text.length; i += chunk) {
          if (signal.aborted) throw new Error('Gestopt');
          onEvent({ type: 'text', delta: step.text.slice(i, i + chunk) });
          await new Promise((r) => setTimeout(r, (chunk / o.cps) * 1000));
        }
        const toolCalls = (step.toolCalls || []).map((c, i) => ({ id: `c${Date.now()}${i}`, name: c.name, args: c.args }));
        return { text: step.text, toolCalls, usage: { input: 1, output: 1 }, stop: toolCalls.length ? 'tool_use' : 'end', model: req.model };
      },
    }),
  });
}

async function setup(steps: SlowStep[], o = { ttftMs: 300, cps: 120 }) {
  const t = await startTestApp();
  markInstalled(t.dir, 'nl_NL-alex-medium');
  // A call starts only when it can hear you (the turns below are already text).
  markInstalled(t.dir, 'parakeet-tdt-0.6b-v3');
  slowBot(t, steps, o);
  const prov = await t.api('POST', '/providers', { kind: 'slowmock' });
  const bot = await t.api('POST', '/agents', { name: 'Sam', provider_id: prov.id, model: 'slow-1', access_mode: 'auto' });
  const th = await t.api('POST', '/threads', { agentId: bot.id });
  return { t, bot, th };
}

/** Read a PCM stream; returns when it ends (or after `stopAfterBytes`), with the time of the first byte. */
async function readStream(t: TestApp, path: string, o: { stopAfterBytes?: number } = {}) {
  const ac = new AbortController();
  const t0 = Date.now();
  const res = await fetch(`${t.app.url}/api${path}`, { headers: { authorization: `Bearer ${t.token}` }, signal: ac.signal });
  const reader = res.body!.getReader();
  let bytes = 0;
  let firstMs: number | null = null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (firstMs === null) firstMs = Date.now() - t0;
      bytes += value.length;
      if (o.stopAfterBytes && bytes >= o.stopAfterBytes) {
        ac.abort();
        break;
      }
    }
  } catch (e: any) {
    if (e?.name !== 'AbortError') throw e;
  }
  return { status: res.status, rate: Number(res.headers.get('x-sample-rate')), bytes, firstMs, totalMs: Date.now() - t0 };
}

const ANSWER = 'De hoofdstad van Frankrijk is Parijs. Parijs ligt aan de Seine en heeft ruim twee miljoen inwoners. Bekende plekken zijn de Eiffeltoren en het Louvre. Wil je nog meer weten?';

test('free call: the voice starts after the first sentence while the bot is still writing; replay is cached', async () => {
  const { t, bot, th } = await setup([{ text: ANSWER }]);
  try {
    const c = await t.api('POST', '/voice/calls', { agentId: bot.id, threadId: th.id });
    tts.said.length = 0;
    const tTurn = Date.now();
    const turn = await t.api('POST', `/voice/calls/${c.id}/turn`, { text: 'Wat is de hoofdstad van Frankrijk?', speak: true });
    assert.equal(turn.status, 'working', 'returns at once');
    assert.equal(turn.speech.engine, 'local');
    assert.match(turn.speech.stream, /^\/voice\/tts\/tts_[\w-]+\/pcm$/);
    const s = await readStream(t, turn.speech.stream);
    const runMs = Date.parse(t.app.ctx.store.run(turn.runId)!.finished_at!) - tTurn;
    assert.equal(s.status, 200);
    assert.equal(s.rate, 22050);
    assert.ok(s.firstMs !== null && s.firstMs < runMs - 500, `first sound after ${s.firstMs} ms, the bot needed ${runMs} ms`);
    assert.deepEqual(tts.said, splitForSpeech(ANSWER), 'every sentence once, in order');
    const expected = tts.said.reduce((n, x) => n + Math.round((x.length * 10 * 22050) / 1000) * 2, 0);
    assert.equal(s.bytes, expected, 'all audio arrived');

    // Replaying that answer from the chat costs nothing: it was kept like normal read-aloud.
    const msg = t.app.ctx.store.messages(th.id).find((m) => m.role === 'assistant')!;
    const made = tts.said.length;
    const again = await t.api('POST', '/voice/speak', { messageId: msg.id });
    assert.equal(again.cached, true);
    assert.equal(tts.said.length, made);
    assert.equal(again.id, turn.speech.id);
  } finally {
    await t.close();
  }
});

test('interrupting stops the voice job (no more synthesis), the bot keeps writing its answer into the chat', async () => {
  const long = Array.from({ length: 12 }, (_, i) => `Dit is zin nummer ${i + 1} van een lang antwoord.`).join(' ');
  const { t, bot, th } = await setup([{ text: long }], { ttftMs: 100, cps: 150 });
  try {
    const c = await t.api('POST', '/voice/calls', { agentId: bot.id, threadId: th.id });
    tts.said.length = 0;
    const turn = await t.api('POST', `/voice/calls/${c.id}/turn`, { text: 'Vertel eens wat', speak: true });
    const s = await readStream(t, turn.speech.stream, { stopAfterBytes: 1 });
    assert.ok(s.bytes >= 1);
    await new Promise((r) => setTimeout(r, 150));
    const atStop = tts.said.length;
    await t.waitIdle(th.id, 15_000);
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(tts.said.length <= atStop + 1, `stopped synthesising (${atStop} → ${tts.said.length} of 12)`);
    assert.ok(tts.said.length < 12);
    const msg = t.app.ctx.store.messages(th.id).find((m) => m.role === 'assistant')!;
    assert.equal(msg.content, long, 'the answer itself is complete in the chat');
  } finally {
    await t.close();
  }
});

test('interrupting by talking, then speaking: the interrupted answer stops, the new turn does not wait behind it (B-52)', async () => {
  const long = Array.from({ length: 20 }, (_, i) => `Dit is zin nummer ${i + 1} van een lang antwoord.`).join(' ');
  const { t, bot, th } = await setup([{ text: long }, { text: 'Natuurlijk, vraag maar.' }], { ttftMs: 100, cps: 60 });
  try {
    const c = await t.api('POST', '/voice/calls', { agentId: bot.id, threadId: th.id });
    const first = await t.api('POST', `/voice/calls/${c.id}/turn`, { text: 'Vertel eens wat', speak: true });
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(t.app.ctx.store.run(first.runId)!.status, 'running', 'still writing its long answer');
    // A run of another call is never stopped this way.
    const other = await t.api('POST', '/voice/calls', { agentId: bot.id, threadId: th.id });
    const t0 = Date.now();
    const second = await t.api('POST', `/voice/calls/${other.id}/turn`, { text: 'Wacht even, ik heb een andere vraag.', speak: true, interrupt: first.runId });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(t.app.ctx.store.run(first.runId)!.status, 'running', 'not this call');
    t.app.ctx.runs.cancel(second.runId);
    const third = await t.api('POST', `/voice/calls/${c.id}/turn`, { text: 'Wacht even, ik heb een andere vraag.', speak: true, interrupt: first.runId });
    const done = await t.app.ctx.runs.waitFor(third.runId, 10_000);
    assert.equal(done.status, 'done');
    assert.ok(Date.now() - t0 < 4000, `the new question was answered after ${Date.now() - t0} ms, not after the old answer (~10 s)`);
    const old = t.app.ctx.store.run(first.runId)!;
    assert.equal(old.status, 'cancelled');
    assert.equal(old.error, 'Onderbroken: je begon te praten');
    await new Promise((r) => setTimeout(r, 100));
    const oldMsg = t.app.ctx.store.messages(th.id).find((m) => m.run_id === first.runId && m.role === 'assistant')!;
    assert.equal(oldMsg.status, 'cancelled');
    assert.equal(oldMsg.parts.voiceInterrupted, true, 'the chat says why it stopped');
    assert.match(oldMsg.content, /^Dit is zin nummer 1/, 'what it wrote so far stays in the chat');
    assert.equal(t.app.ctx.store.messages(th.id).filter((m) => m.role === 'assistant' && m.content === 'Natuurlijk, vraag maar.').length, 1);
    assert.ok(t.app.ctx.store.one("SELECT 1 FROM audit WHERE kind = 'voice.call.interrupted'"));
  } finally {
    await t.close();
  }
});

test('/voice/speak/run (read-aloud while writing): picks up mid-answer without a gap, follows tool steps, respects the setting', async () => {
  const { t, bot, th } = await setup(
    [
      { text: 'Even kijken in je agenda.', toolCalls: [{ name: 'list_files', args: { path: '.' } }] },
      { text: 'Je hebt morgen om tien uur een afspraak met Sanne. Daarna is je dag vrij.' },
    ],
    { ttftMs: 150, cps: 100 },
  );
  try {
    tts.said.length = 0;
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Wat staat er morgen?' });
    // Start late: the first message is already partly written.
    let runId = '';
    for (let i = 0; i < 100 && !runId; i++) {
      const m = t.app.ctx.store.messages(th.id).find((x) => x.role === 'assistant' && x.status === 'streaming');
      if (m) runId = m.run_id!;
      else await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 120));
    const sp = await t.api('POST', '/voice/speak/run', { runId });
    assert.equal(sp.engine, 'local');
    const s = await readStream(t, sp.stream);
    assert.ok(s.bytes > 0);
    assert.deepEqual(tts.said, ['Even kijken in je agenda.', 'Je hebt morgen om tien uur een afspraak met Sanne.', 'Daarna is je dag vrij.']);

    // Someone else's run: not found. Setting off: no live stream (the client reads the finished answer instead).
    assert.equal((await fetch(`${t.app.url}/api/voice/speak/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId }) })).status, 401);
    await t.api('PUT', '/voice/settings', { tts: { streaming: false } });
    const off = await t.api('POST', '/voice/speak/run', { runId });
    assert.equal(off.stream, null);
    const c = await t.api('POST', '/voice/calls', { agentId: bot.id, threadId: th.id });
    const turn = await t.api('POST', `/voice/calls/${c.id}/turn`, { text: 'En overmorgen?', speak: true });
    assert.equal(turn.speech.stream, null);
    await t.waitIdle(th.id, 15_000);
  } finally {
    await t.close();
  }
});
