// TeamBot 0.4, package L (voice): in voice a bot is exactly as smart as in text (the same run, model, instructions and
// tools), and it speaks its own language: the voice follows the bot's language, a Dutch voice for a Dutch bot, Arabic
// keeps the system voice; in a call the speech recognition follows the bot's language too. No real models: the voice
// engines are small fakes (tests/voice-fakes.ts), the bots the mock provider.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { fakeTts, markInstalled } from './voice-fakes.js';
import { setSttBackend } from '../server/modules/voice/local/engine.js';
import { pcmToWav } from '../server/modules/voice/audio.js';
import { sanitize } from '../server/modules/voice/settings.js';
import { sttSettingsForBot } from '../server/modules/voice/stt.js';
import { fixedBotLanguage } from '../server/modules/voice/tts.js';

const tts = fakeTts();
/** Which model recognised each recording, with which language setting (models stay loaded: recorded per decode). */
const loaded: { model: string; language: string }[] = [];
setSttBackend({
  name: 'fake-stt',
  problem: () => null,
  async create(model, _dir, opts) {
    return {
      decode: async () => {
        loaded.push({ model: model.id, language: opts.language });
        return 'Merhaba, nasılsın?';
      },
    };
  },
});
after(() => {
  tts.restore();
  setSttBackend(null);
});

/** One and a half seconds of a speech-like tone, as the call screen records it (16 kHz WAV). */
function speechWav(): Buffer {
  const rate = 16000;
  const pcm = Buffer.alloc(rate * 3);
  for (let i = 0; i < rate * 1.5; i++) pcm.writeInt16LE(Math.round(9000 * Math.abs(Math.sin((Math.PI * 4 * i) / rate)) * Math.sin((2 * Math.PI * 220 * i) / rate)), i * 2);
  return pcmToWav(pcm, rate);
}

test('same brain in voice as in text: a spoken turn is the same run with the same model, instructions and tools', async () => {
  const t = await startTestApp();
  try {
    const bot = await t.agent({ name: 'Ada', model: 'mock-groot', instructions: 'Je bent Ada, een zorgvuldige onderzoeker.' });
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    // Typed.
    const msgs = await t.say(th.id, 'Wat is de hoofdstad van Frankrijk?');
    const typed = msgs.filter((m: any) => m.role === 'assistant').at(-1);
    assert.equal(typed.parts.model, 'mock-groot');
    // Spoken, in a free call with the same bot.
    const call = await t.api('POST', '/voice/calls', { agentId: bot.id, threadId: th.id });
    const turn = await t.api('POST', `/voice/calls/${call.id}/turn`, { text: 'En die van Duitsland?' });
    assert.equal(turn.status, 'done');
    assert.equal(turn.model, 'mock-groot', 'the spoken answer says which model wrote it: the bot\'s own');
    assert.equal((await t.api('GET', `/voice/calls/${call.id}/runs/${turn.runId}`)).model, 'mock-groot');
    assert.equal(t.requests.length, 2);
    const [text, spoken] = t.requests;
    assert.equal(spoken.model, text.model, 'same model');
    assert.equal(spoken.system, text.system, 'same instructions (the voice note is per turn, in the message)');
    assert.deepEqual(
      (spoken.tools || []).map((x: any) => x.name),
      (text.tools || []).map((x: any) => x.name),
      'same tools',
    );
    assert.equal(spoken.reasoning, text.reasoning, 'same thinking level');
    // The spoken message is marked as a transcript for the bot, nothing else changes.
    const said = [...spoken.messages].reverse().find((m: any) => m.role === 'user');
    assert.match(JSON.stringify(said?.content), /En die van Duitsland/);
    const run = t.app.ctx.store.run(turn.runId)!;
    assert.equal(run.trigger, 'voice');
    assert.equal(run.meta?.override, undefined, 'no per-run engine or model override in voice');
    await t.api('POST', `/voice/calls/${call.id}/end`, {});
  } finally {
    await t.close();
  }
});

test('same brain in a group voice call: every bot answers a spoken message with its own model', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent({ name: 'Ada', model: 'mock-a' });
    const b = await t.agent({ name: 'Bo', model: 'mock-b' });
    const room = await t.api('POST', '/rooms', { name: 'Team', mode: 'everyone', agentIds: [a.id, b.id] });
    const threadId = room.thread_id || room.threadId;
    await t.api('POST', `/threads/${threadId}/messages`, { content: 'Wat vinden jullie van het plan?', voice: true });
    await t.waitIdle(threadId);
    const answers = t.app.ctx.store.messages(threadId).filter((m) => m.role === 'assistant' && m.content);
    const byBot = new Map(answers.map((m) => [m.author_id, m.parts?.model]));
    assert.equal(byBot.get(a.id), 'mock-a');
    assert.equal(byBot.get(b.id), 'mock-b');
  } finally {
    await t.close();
  }
});

test('live (Realtime) starts in "Bot bedienen" by default: the bot itself answers, not another model', () => {
  assert.equal(sanitize({}).realtime.mode, 'agent');
  assert.equal(sanitize({ realtime: { mode: 'direct' } }).realtime.mode, 'direct', 'direct stays a choice');
  assert.equal(sanitize({}).call.talk, 'auto', 'hold on a computer, hands-free on a phone');
  assert.equal(sanitize({ call: { talk: 'handsfree' } }).call.talk, 'handsfree');
  assert.equal(sanitize({ call: { talk: 'shout' } }).call.talk, 'auto');
});

test('voice per bot language: Dutch bot → Dutch voice, German bot → German voice, Arabic → system voice, own voice kept', async () => {
  const t = await startTestApp();
  try {
    const ctx = t.app.ctx;
    const owner = ctx.auth.owner()!.id;
    for (const id of ['nl_NL-alex-medium', 'en_US-ljspeech-medium', 'de_DE-mls-medium']) markInstalled(t.dir, id);
    // An English interface: before 0.4 every bot then spoke with the English voice, also a Dutch one.
    ctx.store.setSetting(owner, 'language', 'en');
    const nl = await t.agent({ name: 'Noor', settings: { language: 'nl' } });
    const de = await t.agent({ name: 'Dieter', settings: { language: 'de' } });
    const ar = await t.agent({ name: 'Amira', settings: { language: 'ar' } });
    const tr = await t.agent({ name: 'Tolga', settings: { language: 'tr' } });
    const auto = await t.agent({ name: 'Sam' });
    const own = await t.agent({ name: 'Eigen', settings: { language: 'de', voice: { localVoice: 'nl_NL-alex-medium' } } });
    const speak = (agentId: string, text: string) => t.api('POST', '/voice/speak', { text, agentId });

    // A Dutch bot speaks Dutch with the Dutch voice (Alex, a native Dutch voice), also in an English interface.
    const n = await speak(nl.id, 'Goedemorgen! Ik heb je agenda voor vandaag klaargezet.');
    assert.equal(n.engine, 'local');
    assert.equal(n.model, 'nl_NL-alex-medium');
    // Even a short text the language guess cannot place ("OK.") gets the bot's language, not the interface's.
    assert.equal((await speak(nl.id, 'OK.')).model, 'nl_NL-alex-medium');
    assert.equal((await speak(de.id, 'OK.')).model, 'de_DE-mls-medium');
    assert.equal((await speak(de.id, 'Guten Morgen! Hier ist deine Übersicht für heute.')).model, 'de_DE-mls-medium');
    // A bot without a fixed language follows you (the interface: English here).
    assert.equal((await speak(auto.id, 'OK.')).model, 'en_US-ljspeech-medium');
    // A bot with its own voice keeps it.
    assert.equal((await speak(own.id, 'Guten Morgen! Hier ist deine Übersicht für heute.')).model, 'nl_NL-alex-medium');
    // Arabic: no free local voice: the browser/system voice, in Arabic, and it says why (known limitation).
    const a = await speak(ar.id, 'مرحبا، كيف يمكنني مساعدتك اليوم؟');
    assert.equal(a.engine, 'browser');
    assert.equal(a.lang, 'ar');
    assert.match(a.localMissing, /Arabisch/);
    // Turkish: there is a free voice, not downloaded yet: the browser voice (Turkish) meanwhile, and which voice to get.
    const tk = await speak(tr.id, 'Merhaba! Bugün için özetin hazır, teşekkürler.');
    assert.equal(tk.engine, 'browser');
    assert.equal(tk.lang, 'tr');
    assert.match(tk.localMissing, /Antalia.*nog niet gedownload/);
    markInstalled(t.dir, 'tr_TR-antalia-medium');
    assert.equal((await speak(tr.id, 'Merhaba! Bugün için özetin hazır, teşekkürler.')).model, 'tr_TR-antalia-medium');

    // Your choice for all bots ("bots answer in German") counts too; a bot set to "auto" follows you.
    ctx.store.setSetting(owner, 'botLanguage', 'de');
    assert.equal((await speak(auto.id, 'OK.')).model, 'de_DE-mls-medium');
    const free = await t.agent({ name: 'Vrij', settings: { language: 'auto' } });
    assert.equal(fixedBotLanguage(ctx, owner, ctx.store.agent(free.id)), null);
    assert.equal((await speak(free.id, 'OK.')).model, 'en_US-ljspeech-medium');
    ctx.store.setSetting(owner, 'botLanguage', 'auto');

    // A Dutch interface and a Dutch user: exactly as before (Alex for everything Dutch).
    ctx.store.setSetting(owner, 'language', 'nl');
    assert.equal((await speak(auto.id, 'Ik heb de afspraak met de tandarts voor je gemaakt.')).model, 'nl_NL-alex-medium');
  } finally {
    await t.close();
  }
});

test('speech recognition in a call follows the bot\'s language (Turkish bot → Whisper); dictation stays yours', async () => {
  const t = await startTestApp();
  try {
    const ctx = t.app.ctx;
    const owner = ctx.auth.owner()!.id;
    markInstalled(t.dir, 'parakeet-tdt-0.6b-v3');
    markInstalled(t.dir, 'whisper-large-v3-turbo');
    const tr = await t.agent({ name: 'Tolga', settings: { language: 'tr' } });
    const th = await t.api('POST', '/threads', { agentId: tr.id });
    const call = await t.api('POST', '/voice/calls', { agentId: tr.id, threadId: th.id });
    const post = (q: string) =>
      fetch(`${t.app.url}/api/voice/transcribe?${q}`, { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'content-type': 'audio/wav' }, body: new Uint8Array(speechWav()) }).then(async (r) => {
        assert.equal(r.status, 200, await r.clone().text());
        return r.json();
      });
    loaded.length = 0;
    // Dictating in the chat: your own dictation language (Dutch interface → Parakeet).
    await post(`threadId=${th.id}`);
    assert.equal(loaded.at(-1)?.model, 'parakeet-tdt-0.6b-v3');
    // A turn of the call with the Turkish bot: a model that knows Turkish (Parakeet does not).
    await post(`callId=${call.id}`);
    assert.equal(loaded.at(-1)?.model, 'whisper-large-v3-turbo');
    // The hint for engines that take one: the bot's language first (and English), when your setting is automatic.
    assert.equal(sttSettingsForBot(ctx, owner, 'tr').stt.language, 'auto-tr');
    assert.equal(sttSettingsForBot(ctx, owner, null).stt.language, 'auto-nl');
    // A dictation language you chose yourself stays.
    await t.api('PUT', '/voice/settings', { stt: { language: 'nl' } });
    assert.equal(sttSettingsForBot(ctx, owner, 'tr').stt.language, 'nl');
    // Another user's call id gives nothing extra (and no error): the bot of the call must be yours.
    await t.api('PUT', '/voice/settings', { stt: { language: 'auto-app' } });
    await post('callId=vc_niet_van_jou');
    assert.equal(loaded.at(-1)?.model, 'parakeet-tdt-0.6b-v3');
    await t.api('POST', `/voice/calls/${call.id}/end`, {});
  } finally {
    await t.close();
  }
});
