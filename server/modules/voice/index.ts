import type { Ctx, Module } from '../../core/types.js';
import { migrations } from './schema.js';
import { routes } from './routes.js';
import { getSettings, storedSettings } from './settings.js';
import { checkAudioLoose } from './audio.js';
import { transcribe, transcribeLocal } from './stt.js';
import { speak, ttsDir } from './tts.js';
import { deleteTtsRows, runRetention } from './retention.js';
import { endCall } from './calls.js';
import { closeLocalVoice, localVoice } from './local/service.js';
import { closeLiveText, liveText } from './follow.js';
import { openDictation } from './dictation.js';
import { spokenNamesHint } from './names-hint.js';
import { closeDuplex, duplex } from './duplex/index.js';

const timers = new WeakMap<Ctx, NodeJS.Timeout>();

/**
 * Spraak: dictation (speech-to-text), spoken replies per bot (text-to-speech with cache), voice memos with
 * captions, live calls via the OpenAI Realtime API (WebRTC, short-lived client secret) in two modes, and a
 * half-duplex call mode that works with every bot. Microphone access only ever starts in the browser after an
 * explicit tap; this module never records anything itself.
 */
const mod: Module = {
  id: 'voice',
  label: 'Spraak',
  migrations,
  init(ctx: Ctx) {
    // Voice is a core phone feature: allow the phone-safe routes for paired devices (mobile module, default deny).
    if (!Array.isArray(ctx.services.mobileRoutes)) ctx.services.mobileRoutes = [];
    for (const [method, path] of [
      ['GET', '/voice/settings'], ['POST', '/voice/transcribe'], ['GET', '/voice/clips'], ['GET', '/voice/clips/:id'], ['GET', '/voice/clips/:id/vtt'], ['GET', '/voice/clips/:id/audio'],
      ['POST', '/voice/speak'], ['POST', '/voice/speak/run'], ['GET', '/voice/tts/:id'], ['POST', '/voice/realtime/session'], ['POST', '/voice/calls'], ['GET', '/voice/calls'], ['GET', '/voice/calls/:id'],
      ['POST', '/voice/calls/:id/events'], ['POST', '/voice/calls/:id/ask'], ['POST', '/voice/calls/:id/turn'], ['GET', '/voice/calls/:id/runs/:runId'], ['POST', '/voice/calls/:id/end'],
      // Free, local speech on the PC: the phone streams its microphone audio to the PC and plays the PC's voice.
      // The free live call (full duplex): status and start; its audio socket /ws/voice is let through by the gateway.
      ['GET', '/voice/duplex'], ['POST', '/voice/duplex/calls'],
      ['GET', '/voice/local'], ['POST', '/voice/stt/stream'], ['POST', '/voice/stt/stream/:id'], ['POST', '/voice/stt/stream/:id/end'], ['DELETE', '/voice/stt/stream/:id'], ['GET', '/voice/tts/:id/pcm'],
    ])
      ctx.services.mobileRoutes.push({ method, path });
    routes(ctx);
    duplex(ctx);
    // Keeps the text of answers that are being written, so reading aloud can start mid-answer without a gap.
    liveText(ctx);

    // A spoken message: tell the bot (per turn, frozen into the message) that the text is a transcript.
    ctx.hooks.turnContext.push(({ agent, input }) => {
      const v = input?.parts?.voice;
      if (!v) return null;
      const base =
        v.via === 'live' && input?.parts?.voice?.callId
          ? 'Dit verzoek komt via een live spraakgesprek (doorgegeven door de spraakassistent). Houd je antwoord kort en goed uit te spreken; geen tabellen of lange lijsten.'
          : 'De gebruiker heeft dit bericht ingesproken; het is een automatisch transcript en kan herkenningsfouten bevatten. Houd je antwoord goed uit te spreken.';
      // Handing work to another bot by voice: the bot must recognise a misheard colleague name.
      const names = agent?.tool_groups?.includes('team') ? spokenNamesHint(agent.id, ctx.store.agents(agent.user_id)) : null;
      return names ? `${base}\n${names}` : base;
    });

    ctx.hooks.agentDeleted.push(({ agentId, userId }) => {
      for (const c of ctx.store.all<any>("SELECT * FROM voice_calls WHERE agent_id = ? AND user_id = ? AND status IN ('connecting','active')", agentId, userId)) {
        try {
          endCall(ctx, ctx.store.decode('voice_calls', c));
        } catch {
          /* thread may be gone already */
        }
      }
      ctx.store.exec('DELETE FROM voice_calls WHERE agent_id = ? AND user_id = ?', agentId, userId);
      deleteTtsRows(ctx, ctx.store.all('SELECT id, path FROM voice_tts WHERE agent_id = ? AND user_id = ?', agentId, userId));
    });

    ctx.services.voice = {
      settings: (userId: string) => getSettings(ctx, userId),
      /** For other modules (e.g. channels): transcribe a voice note with the user's own STT settings. */
      async transcribe(userId: string, buf: Buffer, mime: string, opts: { agentId?: string | null; durationMs?: number } = {}) {
        const u = ctx.store.user(userId);
        if (!u) throw new Error('Onbekende gebruiker');
        return transcribe(ctx, u, buf, checkAudioLoose(buf, mime), opts);
      },
      /**
       * An audio or video file attached to a chat (agent/attachments.ts). On this computer by default: an upload never
       * costs money or leaves the pc by itself. Only when the owner chose it for attachments (setting
       * attachmentSpeech: 'provider') the speech service of Instellingen › Meer mogelijkheden › Spraak is used; 'off' = never (null).
       */
      async transcribeAttachment(userId: string, buf: Buffer, mime: string, opts: { agentId?: string | null; signal?: AbortSignal } = {}) {
        const u = ctx.store.user(userId);
        if (!u) throw new Error('Onbekende gebruiker');
        const choice = ctx.store.getSetting<string>(userId, 'attachmentSpeech', 'local');
        if (choice === 'off') return null;
        const audio = checkAudioLoose(buf, mime);
        if (choice === 'provider') return transcribe(ctx, u, buf, audio, opts);
        const s = getSettings(ctx, userId);
        return transcribeLocal(ctx, s.stt.localModel, s.stt.language, buf, audio);
      },
      /** Desktop shell, global dictation hotkey: push 16 kHz PCM, get the text (see dictation.ts). */
      openDictation: (userId: string) => openDictation(ctx, userId),
      async speak(userId: string, text: string, agentId?: string | null) {
        const u = ctx.store.user(userId);
        if (!u) throw new Error('Onbekende gebruiker');
        const agent = agentId ? ctx.store.agent(agentId) : null;
        const r = await speak(ctx, u, { text, agent: agent && agent.user_id === userId ? agent : null, wait: true });
        if (r.engine !== 'provider' && r.engine !== 'local') return r;
        const row = ctx.store.get<any>('voice_tts', r.id);
        return { ...r, path: row?.path };
      },
      exportUser(userId: string) {
        return {
          voice: {
            settings: storedSettings(ctx, userId),
            calls: ctx.store
              .all<any>('SELECT * FROM voice_calls WHERE user_id = ? ORDER BY started_at', userId)
              .map((r) => ctx.store.decode<any>('voice_calls', r))
              .map((c) => ({ ...c, transcript: c.keep_transcript ? c.transcript : [] })),
            clips: ctx.store.all<any>('SELECT * FROM voice_clips WHERE user_id = ? ORDER BY created_at', userId).map((r) => ctx.store.decode('voice_clips', r)),
            ttsCacheFiles: ctx.store.one<any>('SELECT COUNT(*) AS n FROM voice_tts WHERE user_id = ?', userId)?.n ?? 0,
            ttsCacheDir: ttsDir(ctx, userId),
            localModels: localVoice(ctx).models.states().filter((m) => m.status === 'installed').map((m) => m.id),
          },
        };
      },
    };
  },
  start(ctx: Ctx) {
    // Calls that were open when the server stopped cannot continue (the browser held the connection).
    for (const c of ctx.store.all<any>("SELECT * FROM voice_calls WHERE status IN ('connecting','active')")) {
      try {
        endCall(ctx, ctx.store.decode('voice_calls', c), { error: c.status === 'active' ? 'Server herstart tijdens het gesprek' : '' });
      } catch (e) {
        ctx.log.warn('[voice] closing stale call failed', String(e));
      }
    }
    const tick = () => {
      try {
        runRetention(ctx);
      } catch (e) {
        ctx.log.warn('[voice] retention failed', String(e));
      }
    };
    tick();
    const timer = setInterval(tick, 6 * 3600_000);
    timer.unref?.();
    timers.set(ctx, timer);
  },
  stop(ctx: Ctx) {
    closeDuplex(ctx);
    closeLocalVoice(ctx);
    closeLiveText(ctx);
    const timer = timers.get(ctx);
    if (timer) clearInterval(timer);
    timers.delete(ctx);
  },
};

export default mod;
