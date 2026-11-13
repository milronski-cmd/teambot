import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { Agent, Ctx, Thread } from '../../core/types.js';
import { HttpError, ah, bad, notFound, own, sendOwnFile, str, user } from '../../core/http.js';
import { newId, now } from '../../core/db.js';
import { canSeeThread } from '../../api/threads.js';
import {
  GEMINI_ESTIMATE,
  GEMINI_LIVE_MODELS,
  GEMINI_VOICES,
  OPENAI_STT_MODELS,
  OPENAI_TTS_MODELS,
  PRICES_CHECKED,
  REALTIME_MODELS,
  REALTIME_TRANSCRIBE_MODELS,
  REALTIME_VOICES,
  STT_LANGUAGES,
  SPEECH_CHARS_PER_MIN,
  isPast,
  realtimeEstimate,
  ttsCost,
} from './catalog.js';
import { MAX_AUDIO_BYTES, checkAudio, toVtt } from './audio.js';
import { getSettings, sanitizeAgentVoice, saveSettings, storedSettings, voiceLanguage } from './settings.js';
import { PIPER_RUNTIME, needsPiper, recommendedSttId, recommendedVoices, totalSize } from './local/catalog.js';
import { sttBackend } from './local/engine.js';
import { sttModelLanguage } from '../../../shared/voiceLanguage.js';
import { providerSummary, resolveEndpoint } from './providers.js';
import { LOCAL_PROVIDER_NAME, defaultSttModel, transcribe } from './stt.js';
import { fixedBotLanguage, resolveTts, speak } from './tts.js';
import { localVoice, mb } from './local/service.js';
import { STT_RATE } from './local/pcm.js';
import { createRealtimeSession } from './realtime.js';
import { createGeminiSession, geminiEndpoint } from './gemini.js';
import { callTasks, runCallTool } from './calltools.js';
import { runSpeech } from './follow.js';
import { HOTKEY_PRESETS, hotkeyLabel } from './hotkey.js';
import { addCallCost, askAgent, createCall, endCall, ownCall, recordEvents, runResult, view } from './calls.js';
import { deleteClipAudio, deleteTtsRows, runRetention } from './retention.js';
import { rateLimit } from './usage.js';
import { PLACE } from '../../../shared/places.js';

/** What works right now for this user, and who receives the audio. */
export function voiceStatus(ctx: Ctx, userId: string) {
  const s = getSettings(ctx, userId);
  const lv = localVoice(ctx);
  const openai = resolveEndpoint(ctx, userId, null, { openaiOnly: true });
  const sttEp = resolveEndpoint(ctx, userId, s.stt.providerId);
  const rtEp = resolveEndpoint(ctx, userId, s.realtime.providerId, { openaiOnly: true });
  let gmEp: ReturnType<typeof geminiEndpoint> = null;
  try {
    gmEp = geminiEndpoint(ctx, userId, s.gemini.providerId);
  } catch {
    gmEp = null;
  }
  let tts: any;
  try {
    const r = resolveTts(ctx, userId, null);
    tts = {
      engine: r.engine,
      provider: r.engine === 'local' ? LOCAL_PROVIDER_NAME : r.ep?.label || null,
      model: r.engine === 'provider' ? r.model : r.engine === 'local' ? r.localVoice : null,
      voice: r.engine === 'provider' ? r.voice : r.engine === 'local' ? lv.models.model(r.localVoice)?.label || r.localVoice : null,
      localMissing: r.localMissing,
    };
  } catch (e: any) {
    tts = { engine: 'error', error: e?.message };
  }
  const localProblem = s.stt.engine === 'local' ? lv.sttProblem(s.stt.localModel) : null;
  const stt =
    s.stt.engine === 'local'
      ? { engine: 'local', ready: !localProblem, provider: LOCAL_PROVIDER_NAME, kind: 'local', model: s.stt.localModel, missing: localProblem, warm: lv.stt.isLoaded(s.stt.localModel, s.stt.language) }
      : {
          engine: s.stt.engine,
          ready: s.stt.engine === 'browser' || !!sttEp,
          provider: sttEp?.label || null,
          kind: sttEp?.kind || null,
          model: sttEp ? s.stt.model || defaultSttModel(sttEp.kind) : null,
          missing: s.stt.engine === 'provider' && !sttEp ? (s.stt.providerId ? 'Gekozen spraakprovider niet beschikbaar' : 'Geen OpenAI-sleutel of eigen spraakserver') : null,
        };
  return {
    openai: openai ? { id: openai.cfg.id, name: openai.label, hasKey: !!openai.key } : null,
    stt,
    tts,
    realtime: { ready: !!rtEp?.key, provider: rtEp?.label || null },
    gemini: { ready: !!gmEp, provider: gmEp?.label || null },
    call: { engine: s.call.engine, localReady: stt.ready },
    providers: providerSummary(ctx, userId),
  };
}

/**
 * A call that takes turns has to hear you first: null when its speech recognition works, otherwise a 409 that says
 * what is missing and which button fixes it (no call is recorded as "active" that cannot hear you). The browser's own
 * recogniser is checked by the page; the voice falls back to the browser's, so it never blocks a call.
 */
export function callSttProblem(ctx: Ctx, userId: string): HttpError | null {
  const s = getSettings(ctx, userId);
  if (s.stt.engine === 'browser') return null;
  if (s.stt.engine === 'local') {
    const lv = localVoice(ctx);
    const p = lv.sttProblem(s.stt.localModel);
    if (!p) return null;
    const m = lv.models.model(s.stt.localModel);
    // Not downloaded yet: the call screen's own button fetches it, then the call starts.
    if (m && !lv.models.installed(m.id) && !sttBackend().problem())
      return new HttpError(
        409,
        `Het gesprek kan nog niet starten: de gratis spraakherkenning is nog niet gedownload (${mb(totalSize(m))}). Tik in het belscherm op "Klaarmaken en bellen": dat downloadt hem en start daarna het gesprek.`,
        'voice_local_missing',
      );
    return new HttpError(409, `Het gesprek kan nog niet starten: ${p}`, 'voice_local_missing');
  }
  if (resolveEndpoint(ctx, userId, s.stt.providerId)) return null;
  return new HttpError(
    409,
    s.stt.providerId
      ? `Het gesprek kan nog niet starten: de gekozen spraakprovider is niet (meer) beschikbaar. Kies een andere bij ${PLACE.voice}.`
      : `Het gesprek kan nog niet starten: spraakherkenning via een spraakdienst is gekozen, maar er is geen OpenAI-sleutel of eigen spraakserver. Kies de gratis spraakherkenning bij ${PLACE.voice}, of koppel een dienst bij ${PLACE.ai}.`,
    'voice_stt_missing',
  );
}

/**
 * What the automatic voice choices are for this user right now, and what TeamBot recommends (the settings page shows
 * those first; the first-use download offers the effective ones). Dictation follows the dictation language (a fixed
 * language, or the hint of an automatic one), voices the interface language.
 */
export function effectiveView(ctx: Ctx, userId: string) {
  const s = getSettings(ctx, userId);
  const lang = voiceLanguage(ctx, userId);
  const sttLanguage = sttModelLanguage(s.stt.language, lang);
  const models = localVoice(ctx).models.list();
  return {
    language: lang,
    stt: { language: s.stt.language, localModel: s.stt.localModel, modelLanguage: sttLanguage },
    tts: { localVoice: s.tts.localVoice },
    recommended: { stt: recommendedSttId(sttLanguage, models), voices: recommendedVoices(lang, models) },
  };
}

/**
 * Downloading/removing local models changes the shared app data: the desktop owner or a server admin. Since 0.4.2 also
 * from their paired phone (0.4.1: the owner's phone may do what the computer can, except the computer-only list in
 * server/modules/mobile/policy.ts); before, the phone was told to "ask the owner of the TeamBot pc" — himself.
 */
const canManageLocal = (ctx: Ctx, req: express.Request) => ctx.config.mode === 'desktop' || user(req).role !== 'member';

export function catalogView() {
  const nowMs = Date.now();
  return {
    pricesChecked: PRICES_CHECKED,
    realtimeModels: REALTIME_MODELS.map((m) => ({ ...m, estimate: realtimeEstimate(m.id, 'gpt-4o-mini-transcribe') })),
    realtimeVoices: REALTIME_VOICES,
    geminiModels: GEMINI_LIVE_MODELS.map((m) => ({ id: m.id, label: m.label, estimate: GEMINI_ESTIMATE })),
    geminiVoices: GEMINI_VOICES,
    transcribeModels: REALTIME_TRANSCRIBE_MODELS.map((m) => ({ ...m, deprecated: isPast(m.deprecatedAfter, nowMs) })),
    sttModels: OPENAI_STT_MODELS.map((m) => ({ ...m, deprecated: isPast(m.deprecatedAfter, nowMs) })),
    ttsModels: OPENAI_TTS_MODELS.map((m) => ({ ...m, perMinEstimate: ttsCost(m.id, SPEECH_CHARS_PER_MIN, 'openai'), deprecated: isPast(m.deprecatedAfter, nowMs) })),
    languages: STT_LANGUAGES,
  };
}

function rawAudio(limit: number) {
  const parser = express.raw({ type: () => true, limit });
  return (req: express.Request, res: express.Response, next: express.NextFunction) =>
    parser(req, res, (err?: any) => {
      if (err) return next(err?.type === 'entity.too.large' ? new HttpError(413, 'De opname is te groot (max. 25 MB). Neem een kortere opname op.', 'too_large') : err);
      next();
    });
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{4})$/, '$1-$2');

export function routes(ctx: Ctx) {
  const api = ctx.api;

  const visibleThread = (userId: string, id: any): Thread | null => {
    if (!id) return null;
    const t = ctx.store.thread(String(id));
    if (!canSeeThread(userId, t)) throw notFound('Gesprek niet gevonden');
    return t;
  };

  /** A thread that belongs to the user and to this bot (or the bot's latest chat). */
  const callThread = (userId: string, agent: Agent, threadId: any): Thread => {
    if (!threadId) return ctx.chat.threadForAgent(userId, agent.id);
    const t = ctx.store.thread(String(threadId));
    if (!t || t.user_id !== userId) throw notFound('Gesprek niet gevonden');
    if (t.agent_id !== agent.id) throw bad('Dit gesprek hoort niet bij deze bot');
    return t;
  };

  /** Global dictation hotkey: only the desktop app has it (the shell registers ctx.services.voiceHotkey). */
  const hotkeyView = (req: express.Request) => {
    const presets = HOTKEY_PRESETS.map((accel) => ({ accel, label: hotkeyLabel(accel) }));
    const svc = ctx.services.voiceHotkey;
    if (!svc?.status || (req as any).session?.kind === 'device') return { available: false, presets };
    return { available: true, presets, ...svc.status() };
  };

  // ---------------- settings ----------------
  api.get(
    '/voice/settings',
    ah(async (req) => {
      const u = user(req);
      return {
        // As saved ('' / 'auto-app' = automatic); `effective` says what the automatic choices are right now.
        settings: storedSettings(ctx, u.id),
        effective: effectiveView(ctx, u.id),
        status: voiceStatus(ctx, u.id),
        catalog: catalogView(),
        mode: ctx.config.mode,
        local: { ...localVoice(ctx).view(), canManage: canManageLocal(ctx, req) },
        hotkey: hotkeyView(req),
      };
    }),
  );

  // ---------------- local (free, on-device) models ----------------
  api.get(
    '/voice/local',
    ah(async (req) => {
      const u = user(req);
      const lv = localVoice(ctx);
      lv.watch(u.id);
      return { ...lv.view(), canManage: canManageLocal(ctx, req) };
    }),
  );

  const managedModel = (req: express.Request) => {
    const u = user(req);
    if (!canManageLocal(ctx, req)) throw new HttpError(403, 'Alleen de eigenaar van deze computer of een beheerder kan spraakmodellen downloaden of verwijderen.', 'forbidden');
    const lv = localVoice(ctx);
    const id = str(req.params.id, 80);
    if (!lv.models.model(id)) throw notFound('Onbekend spraakmodel');
    return { u, lv, id };
  };

  api.post(
    '/voice/local/models/:id/install',
    ah(async (req) => {
      const { u, lv, id } = managedModel(req);
      lv.watch(u.id);
      const m = lv.models.model(id)!;
      // A Piper voice needs the Piper program too: fetch both in one go (voices that run in TeamBot itself do not).
      const ids = needsPiper(m) && lv.models.supported(PIPER_RUNTIME) ? [PIPER_RUNTIME, id] : [id];
      (async () => {
        for (const x of ids) await lv.models.install(x);
      })().then(
        () => ctx.audit(u.id, 'voice.local.installed', { ids }),
        (e) => ctx.log.warn('[voice] model download failed', id, String(e?.message || e)),
      );
      return lv.models.state(id);
    }),
  );

  api.post(
    '/voice/local/models/:id/cancel',
    ah(async (req) => {
      const { lv, id } = managedModel(req);
      lv.models.cancel(id);
      const m = lv.models.model(id);
      if (m && needsPiper(m)) lv.models.cancel(PIPER_RUNTIME);
      return lv.models.state(id);
    }),
  );

  api.delete(
    '/voice/local/models/:id',
    ah(async (req) => {
      const { u, lv, id } = managedModel(req);
      lv.models.remove(id);
      lv.stt.sweep(Number.MAX_SAFE_INTEGER);
      ctx.audit(u.id, 'voice.local.removed', { id });
      return lv.models.state(id);
    }),
  );

  // ---------------- live dictation (local engine, PCM over HTTP) ----------------
  api.post(
    '/voice/stt/stream',
    ah(async (req) => {
      const u = user(req);
      rateLimit(u.id, 'stt-stream', 60);
      const s = getSettings(ctx, u.id);
      if (s.stt.engine !== 'local') throw bad(`Live dicteren werkt met de lokale spraakherkenning (${PLACE.voice}).`);
      const lv = localVoice(ctx);
      const problem = lv.sttProblem(s.stt.localModel);
      if (problem) throw new HttpError(409, problem, 'voice_local_missing');
      const thread = visibleThread(u.id, req.body?.threadId);
      const sess = lv.sessions.open(u.id, s.stt.localModel, s.stt.language, thread?.id ?? null);
      return { id: sess.id, sampleRate: STT_RATE, format: 's16le', model: s.stt.localModel, warm: lv.stt.isLoaded(s.stt.localModel, s.stt.language) };
    }),
  );

  const session = (req: express.Request) => {
    const u = user(req);
    const sess = localVoice(ctx).sessions.get(u.id, String(req.params.id));
    if (!sess) throw notFound('Dicteersessie niet gevonden (verlopen na een minuut stilte)');
    return sess;
  };

  api.post(
    '/voice/stt/stream/:id',
    rawAudio(2 * 1024 * 1024),
    ah(async (req) => {
      const sess = session(req);
      const buf: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      try {
        return sess.push(buf);
      } catch (e: any) {
        throw new HttpError(413, e?.message || String(e), 'too_large');
      }
    }),
  );

  api.post(
    '/voice/stt/stream/:id/end',
    ah(async (req) => {
      const sess = session(req);
      const r = await sess.end();
      localVoice(ctx).sessions.close(sess.id);
      return { ...r, model: sess.modelId, provider: LOCAL_PROVIDER_NAME };
    }),
  );

  api.delete(
    '/voice/stt/stream/:id',
    ah(async (req) => {
      const sess = session(req);
      localVoice(ctx).sessions.close(sess.id);
      return { ok: true };
    }),
  );

  api.put(
    '/voice/settings',
    ah(async (req) => {
      const u = user(req);
      const b = req.body || {};
      for (const k of ['stt', 'tts', 'realtime', 'gemini']) {
        const id = b?.[k]?.providerId;
        if (!id) continue;
        const cfg = ctx.providers.config(String(id));
        if (!ctx.providers.canUse(u.id, cfg)) throw bad('Onbekende provider');
        if (k === 'realtime' && cfg!.kind !== 'openai') throw bad('Live praten werkt alleen met een OpenAI-provider');
        if (k === 'gemini' && cfg!.kind !== 'google') throw bad('Gemini Live werkt alleen met een Google Gemini-provider');
      }
      const s = saveSettings(ctx, u.id, b);
      ctx.audit(u.id, 'voice.settings.updated', { fields: Object.keys(b) });
      ctx.events.emit(u.id, 'voice.settings.updated', s);
      return { settings: s, effective: effectiveView(ctx, u.id), status: voiceStatus(ctx, u.id) };
    }),
  );

  // ---------------- speech to text ----------------
  api.post(
    '/voice/transcribe',
    rawAudio(MAX_AUDIO_BYTES + 64 * 1024),
    ah(async (req) => {
      const u = user(req);
      rateLimit(u.id, 'stt', 60);
      const buf: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!buf.length) throw bad('Lege opname');
      if (buf.length > MAX_AUDIO_BYTES) throw new HttpError(413, 'De opname is te groot (max. 25 MB). Neem een kortere opname op.', 'too_large');
      let audio;
      try {
        audio = checkAudio(buf, req.headers['content-type']);
      } catch (e: any) {
        throw new HttpError(415, e.message, 'bad_audio');
      }
      const thread = visibleThread(u.id, req.query.threadId);
      const durationMs = Math.min(3_600_000, Math.max(0, Number(req.query.durationMs) || 0)) || undefined;
      // A turn of a call with one bot: its name helps recognition, and a bot with a fixed language is talked to in it.
      const callId = str(req.query.callId, 60);
      const call = callId ? ctx.store.get<any>('voice_calls', callId) : null;
      const callBot = call && call.user_id === u.id && call.mode !== 'group' ? ctx.store.agent(call.agent_id) : null;
      const callAgent = callBot && callBot.user_id === u.id ? callBot : null;
      const r = await transcribe(ctx, u, buf, audio, { durationMs, agentId: thread?.agent_id ?? callAgent?.id, botLanguage: callAgent ? fixedBotLanguage(ctx, u.id, callAgent) : null });
      addCallCost(ctx, u.id, callId, r.cost);
      let attachment = null;
      if (req.query.save === '1') {
        const id = newId('att_');
        const dir = path.join(ctx.config.dataDir, 'attachments', u.id);
        fs.mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, `${id}.${audio.ext}`);
        fs.writeFileSync(dest, buf);
        const name = `spraakmemo-${stamp()}.${audio.ext}`;
        ctx.store.insert('attachments', { id, user_id: u.id, thread_id: thread?.id ?? null, name, mime: audio.mime, size: buf.length, path: dest, created_at: now() });
        ctx.store.insert('voice_clips', {
          attachment_id: id,
          user_id: u.id,
          thread_id: thread?.id ?? null,
          transcript: r.text,
          language: r.language,
          duration: r.durationSec,
          segments: r.segments,
          timing: r.timing,
          model: r.model,
          provider_id: r.providerId,
          provider_name: r.providerName,
          cost: r.cost ?? 0,
          audio_deleted: false,
          created_at: now(),
        });
        attachment = { id, name, mime: audio.mime, size: buf.length };
      }
      return { text: r.text, language: r.language, durationSec: r.durationSec, segments: r.segments, timing: r.timing, model: r.model, provider: r.providerName, cost: r.cost, attachment };
    }),
  );

  // ---------------- voice memos (audio + transcript) ----------------
  const visibleClip = (userId: string, id: string) => {
    const c = ctx.store.get<any>('voice_clips', id, 'attachment_id');
    if (!c) throw notFound('Spraakmemo niet gevonden');
    if (c.user_id === userId) return c;
    const att = ctx.store.get<any>('attachments', id);
    const t = ctx.store.thread(att?.thread_id || c.thread_id);
    if (!canSeeThread(userId, t)) throw notFound('Spraakmemo niet gevonden');
    return c;
  };

  api.get(
    '/voice/clips',
    ah(async (req) => {
      const u = user(req);
      const ids = str(req.query.ids, 2000).split(',').filter(Boolean).slice(0, 50);
      const out: any[] = [];
      for (const id of ids) {
        try {
          out.push(visibleClip(u.id, id));
        } catch {
          /* not visible: skip */
        }
      }
      return out;
    }),
  );

  api.get('/voice/clips/:id', ah(async (req) => visibleClip(user(req).id, req.params.id as string)));

  api.get(
    '/voice/clips/:id/vtt',
    ah(async (req, res) => {
      const c = visibleClip(user(req).id, req.params.id as string);
      res.setHeader('content-type', 'text/vtt; charset=utf-8');
      res.send(toVtt(c.segments || []));
    }),
  );

  /** Range-capable playback (iOS Safari needs byte ranges for <audio>). */
  api.get(
    '/voice/clips/:id/audio',
    ah(async (req, res) => {
      const c = visibleClip(user(req).id, req.params.id as string);
      const att = ctx.store.get<any>('attachments', c.attachment_id);
      if (!att || c.audio_deleted || !fs.existsSync(att.path)) throw notFound('De audio is verwijderd (het transcript blijft bewaard)');
      await sendOwnFile(res, att.path, { headers: { 'content-type': att.mime, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' } });
    }),
  );

  api.delete(
    '/voice/clips/:id',
    ah(async (req) => {
      const u = user(req);
      const c = ctx.store.get<any>('voice_clips', req.params.id as string, 'attachment_id');
      if (!c || c.user_id !== u.id) throw notFound('Spraakmemo niet gevonden');
      deleteClipAudio(ctx, c.attachment_id);
      ctx.audit(u.id, 'voice.clip.audio_deleted', { attachmentId: c.attachment_id });
      return { ok: true };
    }),
  );

  // ---------------- text to speech ----------------
  api.post(
    '/voice/speak',
    ah(async (req) => {
      const u = user(req);
      rateLimit(u.id, 'tts', 60);
      const b = req.body || {};
      let text = '';
      let agent: Agent | null = null;
      let messageId: string | null = null;
      let override;
      if (b.messageId) {
        const m = ctx.store.message(String(b.messageId));
        const t = m ? ctx.store.thread(m.thread_id) : null;
        if (!m || m.deleted || !canSeeThread(u.id, t)) throw notFound('Bericht niet gevonden');
        text = m.content;
        agent = m.author_type === 'agent' ? ctx.store.agent(m.author_id) : null;
        messageId = m.id;
      } else {
        text = str(b.text, 600);
        if (b.agentId) agent = own(req, ctx.store.agent(String(b.agentId)), 'Bot niet gevonden');
        if (b.override) override = sanitizeAgentVoice(b.override);
      }
      const r = await speak(ctx, u, { text, agent, messageId, override });
      if (r.engine === 'provider') addCallCost(ctx, u.id, str(b.callId, 60), r.cost);
      return r.engine === 'provider' ? { ...r, url: `/voice/tts/${r.id}` } : r;
    }),
  );

  /** Read a bot's answer aloud while it is being written (local voice): returns a live PCM stream, or stream: null. */
  api.post(
    '/voice/speak/run',
    ah(async (req) => {
      const u = user(req);
      rateLimit(u.id, 'tts', 60);
      const run = ctx.store.run(str(req.body?.runId, 80));
      if (!run || run.user_id !== u.id || !canSeeThread(u.id, ctx.store.thread(run.thread_id))) throw notFound('Taak niet gevonden');
      return runSpeech(ctx, u.id, run);
    }),
  );

  /** Local voice: raw 16-bit PCM, streamed sentence by sentence while Piper makes it (x-sample-rate header). */
  api.get(
    '/voice/tts/:id/pcm',
    ah(async (req, res) => {
      const u = user(req);
      const id = req.params.id as string;
      const job = localVoice(ctx).jobs.get(id);
      if (!job || job.userId !== u.id) {
        const row = ctx.store.get<any>('voice_tts', id);
        if (!row || row.user_id !== u.id || !fs.existsSync(row.path) || row.mime !== 'audio/wav') throw notFound('Audio niet gevonden');
        const wav = fs.readFileSync(row.path);
        res.setHeader('content-type', 'application/octet-stream');
        res.setHeader('x-sample-rate', String(wav.readUInt32LE(24)));
        res.setHeader('cache-control', 'no-store');
        return void res.end(wav.subarray(44));
      }
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('x-sample-rate', String(job.sampleRate));
      res.setHeader('cache-control', 'no-store');
      res.setHeader('x-content-type-options', 'nosniff');
      res.flushHeaders?.();
      let sent = 0;
      await new Promise<void>((resolve) => {
        const pump = () => {
          while (sent < job.chunks.length) res.write(job.chunks[sent++]);
          if (job.done) {
            job.listeners.delete(pump);
            if (job.error && !sent) res.destroy(new Error(job.error));
            else res.end();
            resolve();
          }
        };
        job.listeners.add(pump);
        req.on('close', () => {
          job.listeners.delete(pump);
          // A live job (reading while the bot writes) stops when its player goes away (interrupted, stopped).
          if (!job.done && job.cancel && !job.listeners.size) job.cancel();
          resolve();
        });
        pump();
      });
    }),
  );

  api.get(
    '/voice/tts/:id',
    ah(async (req, res) => {
      const u = user(req);
      const job = localVoice(ctx).jobs.get(req.params.id as string);
      if (job && job.userId === u.id && !job.done) await job.finished;
      const row = ctx.store.get<any>('voice_tts', req.params.id as string);
      if (!row || row.user_id !== u.id || !fs.existsSync(row.path)) throw notFound('Audio niet gevonden');
      ctx.store.exec('UPDATE voice_tts SET last_used_at = ? WHERE id = ?', now(), row.id);
      await sendOwnFile(res, row.path, { headers: { 'content-type': row.mime, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' } });
    }),
  );

  api.get(
    '/voice/tts-cache',
    ah(async (req) => {
      const u = user(req);
      return ctx.store.one('SELECT COUNT(*) AS count, COALESCE(SUM(size),0) AS bytes, COALESCE(SUM(cost),0) AS cost FROM voice_tts WHERE user_id = ?', u.id);
    }),
  );

  api.delete(
    '/voice/tts-cache',
    ah(async (req) => {
      const u = user(req);
      const n = deleteTtsRows(ctx, ctx.store.all('SELECT id, path FROM voice_tts WHERE user_id = ?', u.id));
      ctx.audit(u.id, 'voice.tts_cache.cleared', { files: n });
      return { deleted: n };
    }),
  );

  api.post('/voice/cleanup', ah(async (req) => runRetention(ctx, user(req).id)));

  // ---------------- live calls ----------------
  api.post(
    '/voice/realtime/session',
    ah(async (req) => {
      const u = user(req);
      const b = req.body || {};
      const agent = own(req, ctx.store.agent(str(b.agentId, 60)), 'Bot niet gevonden');
      const thread = callThread(u.id, agent, b.threadId);
      rateLimit(u.id, 'realtime', 10);
      return createRealtimeSession(ctx, u, agent, thread, {
        mode: b.mode,
        model: b.model ? str(b.model, 80) : undefined,
        voice: b.voice ? str(b.voice, 40) : undefined,
        keepTranscript: b.keepTranscript === undefined ? undefined : !!b.keepTranscript,
      });
    }),
  );

  /** Gemini Live: a single-use token for the browser's WebSocket; the Google key stays on the server. */
  api.post(
    '/voice/gemini/session',
    ah(async (req) => {
      const u = user(req);
      const b = req.body || {};
      const agent = own(req, ctx.store.agent(str(b.agentId, 60)), 'Bot niet gevonden');
      const thread = callThread(u.id, agent, b.threadId);
      rateLimit(u.id, 'realtime', 10);
      return createGeminiSession(ctx, u, agent, thread, {
        mode: b.mode,
        voice: b.voice ? str(b.voice, 40) : undefined,
        keepTranscript: b.keepTranscript === undefined ? undefined : !!b.keepTranscript,
      });
    }),
  );

  /**
   * A tool the cloud voice model called (ask_agent, ask_team, ask_bot, task_status, approve, end_call). `heard` is your
   * last finished sentence from the speech recognition; approve and end_call check it (calltools.ts).
   */
  api.post(
    '/voice/calls/:id/tool',
    ah(async (req) => {
      const u = user(req);
      const c = ownCall(ctx, u.id, req.params.id as string);
      if (c.kind !== 'realtime' || c.mode !== 'agent') throw bad('Dit gesprek bedient geen bot');
      const b = req.body || {};
      const quick = b.quickMs === undefined ? undefined : Math.min(20_000, Math.max(0, Number(b.quickMs) || 0));
      return runCallTool(ctx, u, c, { name: str(b.name, 40), args: b.args && typeof b.args === 'object' ? b.args : {}, heard: typeof b.heard === 'string' ? str(b.heard, 500) : '' }, { quickMs: quick });
    }),
  );

  /** The tasks this call gave to bots, with status and (when done) the answer: the page reports new results. */
  api.get('/voice/calls/:id/tasks', ah(async (req) => callTasks(ctx, ownCall(ctx, user(req).id, req.params.id as string))));

  /** Half-duplex call without Realtime: works with every bot/provider (also local). */
  api.post(
    '/voice/calls',
    ah(async (req) => {
      const u = user(req);
      const b = req.body || {};
      const s = getSettings(ctx, u.id);
      const notReady = callSttProblem(ctx, u.id);
      if (b.group) {
        // Group voice call: recorded on the group thread (for the history), with the lead (or first bot) as bot.
        const t = ctx.store.thread(str(b.threadId, 60));
        if (!t || t.user_id !== u.id) throw notFound('Gesprek niet gevonden');
        const room = ctx.services.rooms?.roomForThread(t);
        if (!room) throw bad('Dit is geen groepsgesprek');
        // A group without a lead (mode "op vermelding", "iedereen", …): its first bot. Bots are room members of kind
        // "agent" with their id in ref_id (round 6: such a group call was never recorded, 404 "Deze groep heeft geen bot").
        const botId = room.lead_agent_id || ctx.store.find<any>('room_members', { room_id: room.id, kind: 'agent' }, { order: 'sort' }).find((m) => m.ref_id)?.ref_id;
        const lead = own(req, botId ? ctx.store.agent(botId) : null, 'Deze groep heeft geen bot');
        if (notReady) throw notReady;
        const call = createCall(ctx, { userId: u.id, agentId: lead.id, threadId: t.id, kind: 'halfduplex', mode: 'group', keepTranscript: true, priceCap: s.priceCapUsd });
        ctx.audit(u.id, 'voice.call.started', { callId: call.id, kind: 'halfduplex', group: room.id }, lead.id);
        return call;
      }
      const agent = own(req, ctx.store.agent(str(b.agentId, 60)), 'Bot niet gevonden');
      const thread = callThread(u.id, agent, b.threadId);
      if (notReady) throw notReady;
      const call = createCall(ctx, { userId: u.id, agentId: agent.id, threadId: thread.id, kind: 'halfduplex', mode: 'agent', keepTranscript: true, priceCap: s.priceCapUsd });
      ctx.audit(u.id, 'voice.call.started', { callId: call.id, kind: 'halfduplex' }, agent.id);
      return call;
    }),
  );

  api.get(
    '/voice/calls',
    ah(async (req) => {
      const u = user(req);
      const agentId = str(req.query.agentId, 60);
      const rows = ctx.store.all<any>(`SELECT * FROM voice_calls WHERE user_id = ? ${agentId ? 'AND agent_id = ?' : ''} ORDER BY started_at DESC LIMIT 100`, ...(agentId ? [u.id, agentId] : [u.id]));
      // A group call shows the group's name instead of its lead bot.
      return rows.map((r) => ({ ...view(ctx.store.decode('voice_calls', r)), ...(r.mode === 'group' ? { group: ctx.services.rooms?.roomForThread(ctx.store.thread(r.thread_id))?.name || 'Groep' } : {}) }));
    }),
  );

  api.get('/voice/calls/:id', ah(async (req) => view(ownCall(ctx, user(req).id, req.params.id as string), true)));

  api.post('/voice/calls/:id/events', ah(async (req) => recordEvents(ctx, ownCall(ctx, user(req).id, req.params.id as string), req.body)));

  /** Realtime "ask_agent" function: the voice model hands the request to the real bot. */
  api.post(
    '/voice/calls/:id/ask',
    ah(async (req) => {
      const u = user(req);
      const c = ownCall(ctx, u.id, req.params.id as string);
      if (c.kind !== 'realtime' || c.mode !== 'agent') throw bad('Dit gesprek bedient geen bot');
      const waitMs = Math.min(120_000, Math.max(0, Number(req.body?.waitMs ?? 60_000)));
      return askAgent(ctx, { user: u, call: c, text: str(req.body?.request, 8000), via: 'live', waitMs });
    }),
  );

  /** One spoken turn of a half-duplex call (already transcribed). */
  api.post(
    '/voice/calls/:id/turn',
    ah(async (req) => {
      const u = user(req);
      const c = ownCall(ctx, u.id, req.params.id as string);
      if (c.kind !== 'halfduplex') throw bad('Dit is geen spraakgesprek zonder Realtime');
      // speak: start the voice right away and read the answer while the bot writes it (returns at once with runId).
      const speakNow = req.body?.speak === true;
      const waitMs = speakNow ? 0 : Math.min(180_000, Math.max(0, Number(req.body?.waitMs ?? 120_000)));
      let speech: ReturnType<typeof runSpeech> | null = null;
      // interrupt: the run you just interrupted by talking; it stops, so this turn does not wait behind it.
      const interruptRunId = typeof req.body?.interrupt === 'string' ? str(req.body.interrupt, 60) : null;
      const r = await askAgent(ctx, { user: u, call: c, text: str(req.body?.text, 8000), via: 'call', waitMs, interruptRunId, onRun: speakNow ? (run) => void (speech = runSpeech(ctx, u.id, run)) : undefined });
      return speech ? { ...r, speech } : r;
    }),
  );

  api.get(
    '/voice/calls/:id/runs/:runId',
    ah(async (req) => {
      const u = user(req);
      const c = ownCall(ctx, u.id, req.params.id as string);
      const run = ctx.store.run(req.params.runId as string);
      if (!run || run.user_id !== u.id || run.meta?.voiceCallId !== c.id) throw notFound('Taak niet gevonden');
      return runResult(ctx, run.id);
    }),
  );

  api.post('/voice/calls/:id/end', ah(async (req) => endCall(ctx, ownCall(ctx, user(req).id, req.params.id as string), typeof req.body === 'object' ? req.body : {})));

  api.delete(
    '/voice/calls/:id',
    ah(async (req) => {
      const u = user(req);
      const c = ownCall(ctx, u.id, req.params.id as string);
      if (c.status === 'active' || c.status === 'connecting') endCall(ctx, c);
      ctx.store.remove('voice_calls', c.id);
      ctx.audit(u.id, 'voice.call.deleted', { callId: c.id }, c.agent_id);
      return { ok: true };
    }),
  );
}
