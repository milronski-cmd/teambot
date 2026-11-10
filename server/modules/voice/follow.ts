/**
 * Speak while the bot is still answering: follow a run's assistant text as it streams in, cut it into sentences and
 * synthesise each one with the local voice as soon as it is complete. The audio goes out through the same streaming
 * PCM endpoint as normal read-aloud (/voice/tts/:id/pcm), so the first sentence plays while the bot writes the rest.
 * When the listener disconnects (interrupted by talking, stop button, hang up) the job stops synthesising.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Agent, Ctx, Run } from '../../core/types.js';
import type { TBEvent } from '../../core/events.js';
import { newId, now } from '../../core/db.js';
import { MAX_TTS_CHARS, pcmToWav } from './audio.js';
import { SpeechSplitter } from './sentences.js';
import { localVoice, type TtsJob } from './local/service.js';
import { int16ToFloat, floatToInt16, resample } from './local/pcm.js';
import { baseLang } from '../../../shared/voiceLanguage.js';
import { detectTextLanguage } from './textlang.js';
import { type ResolvedTts, localVoiceChoice, resolveTts, speechText, ttsDir } from './tts.js';
import { getSettings } from './settings.js';
import { tr } from '../../core/i18n.js';
import { LOCAL_PROVIDER_NAME } from './stt.js';

export type RunSpeech =
  | { engine: 'local'; id: string; stream: string; sampleRate: number; voice: string; model: string; provider: string }
  | { engine: string; stream: null; reason: string };

/**
 * Speech for a run that is (about to be) answering: with the local voice and "voorlezen terwijl de bot schrijft" on,
 * a live job; otherwise `stream: null` and the caller reads the finished answer the normal way.
 */
export function runSpeech(ctx: Ctx, userId: string, run: Run): RunSpeech {
  if (!getSettings(ctx, userId).tts.streaming) return { engine: 'off', stream: null, reason: 'Voorlezen terwijl de bot schrijft staat uit' };
  const a = run.agent_id ? ctx.store.agent(run.agent_id) : null;
  const agent = a && a.user_id === userId ? a : null;
  let r: ResolvedTts;
  try {
    r = resolveTts(ctx, userId, agent);
  } catch (e: any) {
    return { engine: 'error', stream: null, reason: String(e?.message || e) };
  }
  if (r.engine !== 'local') return { engine: r.engine, stream: null, reason: r.localMissing || 'Alleen de lokale stem leest voor terwijl de bot schrijft' };
  const f = followRun(ctx, { userId, run, agent, r });
  return { engine: 'local', id: f.job.id, stream: `/voice/tts/${f.job.id}/pcm`, sampleRate: f.job.sampleRate, voice: f.voice, model: f.model, provider: LOCAL_PROVIDER_NAME };
}

const MAX_LIFE_MS = 15 * 60_000;
const IDLE_MS = 10 * 60_000;
const ACTIVE_RUN = new Set(['queued', 'running', 'waiting']);

/**
 * Text of assistant messages that are being written right now, kept from the owner's own event stream (each delta
 * once). Lets a follow job that starts a little late pick up exactly where the bot is, without a gap.
 */
export class LiveText {
  private map = new Map<string, { userId: string; runId: string | null; text: string; at: number }>();
  private off: () => void;
  constructor(ctx: Ctx) {
    this.off = ctx.events.subscribe((e) => this.on(e));
  }
  private on(e: TBEvent) {
    const d = e.data;
    if (e.type === 'message.created' && d?.role === 'assistant' && d.status === 'streaming') {
      if (this.map.size > 500) for (const [id, m] of this.map) if (Date.now() - m.at > 3600_000) this.map.delete(id);
      if (!this.map.has(d.id)) this.map.set(d.id, { userId: e.userId, runId: d.run_id ?? null, text: d.content || '', at: Date.now() });
    } else if (e.type === 'message.delta') {
      const m = this.map.get(d?.messageId);
      if (m && m.userId === e.userId && d.text) m.text += d.text;
    } else if (e.type === 'message.updated' && d?.status && d.status !== 'streaming') {
      const m = this.map.get(d.id);
      if (m && m.userId === e.userId) this.map.delete(d.id);
    }
  }
  /** Streaming messages of a run, with the text so far. */
  forRun(userId: string, runId: string): { id: string; text: string }[] {
    return [...this.map.entries()].filter(([, m]) => m.userId === userId && m.runId === runId).map(([id, m]) => ({ id, text: m.text }));
  }
  close() {
    this.off();
    this.map.clear();
  }
}

const live = new WeakMap<Ctx, LiveText>();
export function liveText(ctx: Ctx): LiveText {
  let l = live.get(ctx);
  if (!l) live.set(ctx, (l = new LiveText(ctx)));
  return l;
}
export function closeLiveText(ctx: Ctx) {
  live.get(ctx)?.close();
  live.delete(ctx);
}

interface Followed {
  seen: string;
  splitter: SpeechSplitter;
  done: boolean;
  spoken: number;
}

export interface FollowInfo {
  job: TtsJob;
  voice: string;
  model: string;
}

/** Start speaking a run's answer as it is written. `r` must be a local engine (see resolveTts). */
export function followRun(ctx: Ctx, o: { userId: string; run: Run; agent: Agent | null; r: ResolvedTts }): FollowInfo {
  const lv = localVoice(ctx);
  const { userId, run, r } = o;
  const def = localVoiceChoice(ctx, r, '', null);
  const home = baseLang(def.model.lang);
  const choices = new Map<string, typeof def>();
  const choiceFor = (lang: string) => {
    let c = choices.get(lang);
    if (!c) choices.set(lang, (c = localVoiceChoice(ctx, r, '', lang)));
    return c;
  };
  const en = choiceFor('en');
  const rate = def.model.sampleRate || 22050;
  const job: TtsJob = { id: newId('tts_'), userId, sampleRate: rate, chunks: [], bytes: 0, done: false, error: null, finished: Promise.resolve(), listeners: new Set(), firstChunkMs: null };
  const notify = () => job.listeners.forEach((l) => l());
  const t0 = Date.now();
  const msgs = new Map<string, Followed>();
  const queue: { text: string; voice: typeof def }[] = [];
  let all = '';
  /** The language of the answer once it is clear (then it sticks: no switching voices back and forth). */
  let spoken: string | null = null;
  let chars = 0;
  let truncated = false;
  let busy = false;
  let runEnded = !ACTIVE_RUN.has(ctx.store.run(run.id)?.status || 'done');
  let cancelled = false;
  let lastActivity = Date.now();
  const voicesUsed = new Set<string>();
  let resolveFinished: () => void = () => {};
  job.finished = new Promise<void>((res) => (resolveFinished = res));

  // Ask the voice to load now; the bot usually needs longer than that to write its first sentence. English is the
  // most common other language in answers, so its voice is warmed as well.
  const tts = lv.tts();
  for (const v of en.voiceId === def.voiceId ? [def] : [def, en]) tts.warm?.(lv.synthRequest(v.voiceId, '', v.speaker, v.speed));

  const enqueue = (sentence: string) => {
    if (truncated || cancelled) return;
    if (chars + sentence.length > MAX_TTS_CHARS) {
      truncated = true;
      sentence = tr(r.lang, 'De rest staat in het gesprek.');
    }
    chars += sentence.length;
    all += ' ' + sentence;
    // Language is decided on everything so far and then sticks (no voice switching back and forth).
    if (!spoken) {
      const g = detectTextLanguage(all, home);
      if (g && g !== home) spoken = g;
    }
    queue.push({ text: sentence, voice: spoken ? choiceFor(spoken) : def });
    void pump();
  };

  const feed = (id: string, f: Followed, delta: string) => {
    if (!delta) return;
    f.seen += delta;
    lastActivity = Date.now();
    for (const s of f.splitter.push(delta)) (f.spoken++, enqueue(s));
  };

  const finishMessage = (id: string, f: Followed, content: string | null | undefined) => {
    if (f.done) return;
    const c = String(content ?? '');
    // Text that never came as deltas (engines that answer in one go, or the final result of a CLI bot).
    if (c.startsWith(f.seen)) feed(id, f, c.slice(f.seen.length));
    f.done = true;
    for (const s of f.splitter.end()) (f.spoken++, enqueue(s));
    maybeFinish();
  };

  const track = (id: string, text = ''): Followed => {
    let f = msgs.get(id);
    if (!f) {
      f = { seen: '', splitter: new SpeechSplitter(r.lang), done: false, spoken: 0 };
      msgs.set(id, f);
      feed(id, f, text);
    }
    return f;
  };

  const onEvent = (e: TBEvent) => {
    if (e.userId !== userId || cancelled) return;
    const d = e.data;
    if (e.type === 'message.delta') {
      const f = msgs.get(d?.messageId);
      if (f && !f.done) feed(d.messageId, f, String(d.text || ''));
    } else if ((e.type === 'message.created' || e.type === 'message.updated') && d?.run_id === run.id && d.role === 'assistant') {
      const f = track(d.id, e.type === 'message.created' ? d.content || '' : '');
      if (d.status !== 'streaming') finishMessage(d.id, f, d.content);
    }
  };

  async function pump() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length && !cancelled) {
        const item = queue.shift()!;
        const res = await tts.synth(lv.synthRequest(item.voice.voiceId, item.text, item.voice.speaker, item.voice.speed));
        if (cancelled) break;
        voicesUsed.add(item.voice.voiceId);
        const pcm = res.sampleRate === job.sampleRate ? res.pcm : Buffer.from(floatToInt16(resample(int16ToFloat(res.pcm), res.sampleRate, job.sampleRate)).buffer);
        job.chunks.push(pcm);
        job.bytes += pcm.length;
        if (job.firstChunkMs === null) job.firstChunkMs = Date.now() - t0;
        lastActivity = Date.now();
        notify();
      }
    } catch (e: any) {
      job.error = String(e?.message || e).slice(0, 300);
      cancelled = true;
    } finally {
      busy = false;
    }
    maybeFinish();
  }

  // Subscribe and pick up what was already written in one synchronous step: no delta can slip in between.
  const off = ctx.events.subscribe(onEvent);
  const streaming = new Map(liveText(ctx).forRun(userId, run.id).map((m) => [m.id, m.text]));
  for (const row of ctx.store.all<any>("SELECT id, content, status FROM messages WHERE run_id = ? AND role = 'assistant' AND deleted = 0 ORDER BY seq", run.id)) {
    const f = track(row.id, streaming.get(row.id) ?? (row.status === 'streaming' ? row.content || '' : ''));
    if (row.status !== 'streaming') finishMessage(row.id, f, row.content);
  }

  ctx.runs.waitFor(run.id, MAX_LIFE_MS).then(
    () => {
      runEnded = true;
      // Messages whose final update we did not see (or that ended without one): take the stored text.
      for (const [id, f] of msgs) if (!f.done) finishMessage(id, f, ctx.store.message(id)?.content);
      maybeFinish();
    },
    () => stop('Het antwoord duurde te lang'),
  );
  const timer = setInterval(() => {
    // Nobody listening (the player never connected), too old, or nothing happened for a long time.
    if (!job.listeners.size || Date.now() - t0 > MAX_LIFE_MS || Date.now() - lastActivity > IDLE_MS) stop(null);
  }, 30_000);
  timer.unref?.();

  function stop(error: string | null) {
    if (job.done) return;
    cancelled = true;
    if (error && !job.error) job.error = error;
    maybeFinish();
  }
  job.cancel = () => stop(null);

  let finished = false;
  function maybeFinish() {
    if (finished) return;
    const complete = runEnded && [...msgs.values()].every((f) => f.done) && !busy && !queue.length;
    if (!cancelled && !complete) return;
    if (busy) return; // the running synthesis ends first, then calls us again
    finished = true;
    off();
    clearInterval(timer);
    job.done = true;
    if (!cancelled) cacheFinished();
    notify();
    resolveFinished();
    setTimeout(() => lv.jobs.delete(job.id), 120_000).unref?.();
  }

  /** One answer read completely in one voice: keep it like normal read-aloud, so replaying costs nothing. */
  function cacheFinished() {
    try {
      const spoken = [...msgs.entries()].filter(([, f]) => f.spoken > 0);
      if (spoken.length !== 1 || !job.bytes || voicesUsed.size !== 1) return;
      const [messageId] = spoken[0];
      const m = ctx.store.message(messageId);
      if (!m || m.parts?.toolCalls?.length) return;
      const { text } = speechText(m.content || '', r.lang);
      const key = localVoiceChoice(ctx, r, text);
      if (!text || !voicesUsed.has(key.voiceId)) return;
      if (ctx.store.one('SELECT id FROM voice_tts WHERE user_id = ? AND hash = ?', userId, key.hash)) return;
      const wav = pcmToWav(Buffer.concat(job.chunks), job.sampleRate);
      const dir = ttsDir(ctx, userId);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${job.id}.wav`);
      fs.writeFileSync(file, wav);
      ctx.store.insert('voice_tts', {
        id: job.id,
        user_id: userId,
        message_id: messageId,
        agent_id: o.agent?.id ?? null,
        hash: key.hash,
        provider_id: 'local',
        model: key.voiceId,
        voice: key.voiceLabel,
        path: file,
        mime: 'audio/wav',
        size: wav.length,
        chars: text.length,
        cost: 0,
        created_at: now(),
        last_used_at: now(),
      });
    } catch (e) {
      ctx.log.warn('[voice] caching streamed speech failed', String(e));
    }
  }

  lv.jobs.set(job.id, job);
  maybeFinish();
  return { job, voice: def.voiceLabel, model: def.voiceId };
}
