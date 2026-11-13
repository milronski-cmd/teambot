import type { Ctx, User } from '../../core/types.js';
import { HttpError } from '../../core/http.js';
import { OPENAI_STT_MODELS, effective, sttCost, LOCAL_KINDS } from './catalog.js';
import { type CheckedAudio, type Segment, estimateSegments } from './audio.js';
import { type VoiceSettings, getSettings, storedSettings, voiceLanguage } from './settings.js';
import { AUTO_APP, baseLang, sttHint, sttModelsFor } from '../../../shared/voiceLanguage.js';
import { NO_OPENAI, authHeaders, endpointUrl, providerError, resolveEndpoint } from './providers.js';
import { checkBudget, logUsage } from './usage.js';
import { localVoice } from './local/service.js';
import { OpusFormatError } from './local/opus.js';
import { PLACE } from '../../../shared/places.js';

export interface SttResult {
  text: string;
  language: string | null;
  durationSec: number | null;
  segments: Segment[];
  timing: 'real' | 'estimated';
  model: string;
  providerId: string;
  providerName: string;
  kind: string;
  cost: number | null;
}

export const LOCAL_PROVIDER_NAME = 'Lokaal (deze computer)';

/** Free, on-device recognition. The audio never leaves this computer and is not stored. */
export async function transcribeLocal(ctx: Ctx, modelId: string, language: string, buf: Buffer, audio: CheckedAudio): Promise<SttResult> {
  const lv = localVoice(ctx);
  const problem = lv.sttProblem(modelId);
  if (problem) throw new HttpError(409, problem, 'voice_local_missing');
  if (audio.container !== 'wav' && audio.container !== 'ogg')
    throw new HttpError(
      415,
      `Lokale spraakherkenning verwacht WAV- of Ogg/Opus-audio (TeamBot neemt zelf in WAV op; spraakberichten van WhatsApp en Telegram zijn Ogg/Opus). Kies bij ${PLACE.voice} een spraakprovider voor andere bestandstypen.`,
      'voice_local_format',
    );
  let r;
  try {
    r = audio.container === 'ogg' ? await lv.transcribeOggOpus(buf, modelId, language) : await lv.transcribeWav(buf, modelId, language);
  } catch (e: any) {
    if (e instanceof OpusFormatError) throw new HttpError(415, e.message, 'voice_local_format');
    throw new HttpError(500, `Lokale spraakherkenning mislukte: ${String(e?.message || e).slice(0, 200)}`, 'voice_local_error');
  }
  const durationSec = Math.round(r.durationSec * 100) / 100;
  return {
    text: r.text,
    language: null,
    durationSec,
    segments: estimateSegments(r.text, durationSec),
    timing: 'estimated',
    model: modelId,
    providerId: 'local',
    providerName: LOCAL_PROVIDER_NAME,
    kind: 'local',
    cost: 0,
  };
}

export function defaultSttModel(kind: string): string {
  if (kind === 'openai') return 'gpt-transcribe';
  if (kind === 'groq') return 'whisper-large-v3-turbo';
  return 'whisper-1';
}

/**
 * Speech recognition in a call with a bot that speaks a fixed language: you most likely talk to it in that language.
 * The automatic dictation language ('auto-app') then prefers the bot's language ('auto-de', with English), and the
 * automatic local model is one that knows that language when one is installed (a Turkish bot: Whisper, Parakeet
 * knows no Turkish). A dictation language or a model you chose yourself stays as it is.
 */
export function sttSettingsForBot(ctx: Ctx, userId: string, botLang: string | null | undefined): VoiceSettings {
  const s = getSettings(ctx, userId);
  if (!botLang) return s;
  const stored = storedSettings(ctx, userId);
  const stt = { ...s.stt };
  if (stored.stt.language === AUTO_APP) stt.language = `auto-${baseLang(botLang)}`;
  if (!stored.stt.localModel) {
    const lv = localVoice(ctx);
    const best = sttModelsFor(botLang, lv.models.list()).find((m) => lv.models.installed(m.id));
    if (best) stt.localModel = best.id;
  }
  return { ...s, stt };
}

/** Send audio to the configured speech-to-text endpoint. The audio is not stored here. */
export async function transcribe(
  ctx: Ctx,
  user: Pick<User, 'id' | 'role'>,
  buf: Buffer,
  audio: CheckedAudio,
  opts: { durationMs?: number; agentId?: string | null; signal?: AbortSignal; botLanguage?: string | null } = {},
): Promise<SttResult> {
  const settings = sttSettingsForBot(ctx, user.id, opts.botLanguage);
  if (settings.stt.engine === 'local') return transcribeLocal(ctx, settings.stt.localModel, settings.stt.language, buf, audio);
  const ep = resolveEndpoint(ctx, user.id, settings.stt.providerId);
  if (!ep)
    throw new HttpError(
      400,
      settings.stt.providerId ? `De gekozen spraakprovider is niet (meer) beschikbaar. Kies een andere bij ${PLACE.voice}.` : NO_OPENAI,
      'voice_no_stt',
    );
  if (!LOCAL_KINDS.has(ep.kind)) checkBudget(ctx, user.id);
  let model = settings.stt.model || defaultSttModel(ep.kind);
  if (ep.kind === 'openai') model = effective(OPENAI_STT_MODELS, model)?.id || model;
  const wantSegments = /whisper/i.test(model);
  // Names are the classic misheard words ("TeamBot" → "Timbot"): pass them as hints.
  const keywords = [...new Set(['TeamBot', ctx.store.user(user.id)?.name, opts.agentId ? ctx.store.agent(opts.agentId)?.name : null])]
    .filter((k): k is string => typeof k === 'string' && k.trim().length >= 2 && k.length <= 60 && !/[<>]/.test(k) && !/\s{2,}|[\r\n]/.test(k))
    .map((k) => k.trim());
  const url = await endpointUrl(ctx, user, ep, '/audio/transcriptions');

  const send = async (format: 'json' | 'verbose_json') => {
    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array(buf)], { type: audio.mime }), `opname.${audio.ext}`);
    fd.append('model', model);
    fd.append('response_format', format);
    // Automatic: the interface language (and English) as hint; Whisper-style APIs take one language.
    const hint = sttHint(settings.stt.language, voiceLanguage(ctx, user.id));
    if (model === 'gpt-transcribe') {
      for (const l of hint.prefer) fd.append('languages[]', l);
      for (const k of keywords) fd.append('keywords[]', k);
    } else if (hint.fixed || hint.prefer[0]) fd.append('language', hint.fixed || hint.prefer[0]);
    return fetch(url, { method: 'POST', headers: authHeaders(ep), body: fd, redirect: 'error', signal: opts.signal || AbortSignal.timeout(120_000) });
  };

  let res: Response;
  try {
    res = await send(wantSegments ? 'verbose_json' : 'json');
    if (!res.ok && wantSegments && res.status === 400) res = await send('json');
  } catch (e: any) {
    throw new HttpError(502, `${ep.label} is niet bereikbaar voor spraakherkenning (${String(e?.cause?.code || e?.message || e).slice(0, 120)})`, 'voice_unreachable');
  }
  if (!res.ok) throw await providerError(res, `Spraakherkenning via ${ep.label}`);
  const ct = res.headers.get('content-type') || '';
  const j: any = ct.includes('json') ? await res.json().catch(() => ({})) : { text: await res.text() };
  const text = String(j?.text ?? '').trim();
  const usageSec = j?.usage?.type === 'duration' ? Number(j.usage.seconds) : NaN;
  const durationSec = Number.isFinite(usageSec) && usageSec > 0 ? usageSec : Number(j?.duration) > 0 ? Number(j.duration) : opts.durationMs ? opts.durationMs / 1000 : null;
  const realSegs: Segment[] = Array.isArray(j?.segments)
    ? j.segments
        .filter((s: any) => typeof s?.text === 'string' && Number.isFinite(Number(s.start)))
        .slice(0, 2000)
        .map((s: any) => ({ start: Number(s.start), end: Number(s.end) || Number(s.start), text: String(s.text).trim() }))
    : [];
  const language = typeof j?.language === 'string' ? j.language : Array.isArray(j?.languages) && j.languages[0]?.code ? String(j.languages[0].code) : null;
  const cost = sttCost(model, durationSec ?? 0, ep.kind);
  const tokIn = j?.usage?.type === 'tokens' ? Number(j.usage.input_tokens) || 0 : 0;
  const tokOut = j?.usage?.type === 'tokens' ? Number(j.usage.output_tokens) || 0 : 0;
  logUsage(ctx, { userId: user.id, agentId: opts.agentId, providerId: ep.cfg.id, model, input: tokIn, output: tokOut, cost });
  return {
    text,
    language,
    durationSec: durationSec ? Math.round(durationSec * 100) / 100 : null,
    segments: realSegs.length ? realSegs : estimateSegments(text, durationSec),
    timing: realSegs.length ? 'real' : 'estimated',
    model,
    providerId: ep.cfg.id,
    providerName: ep.label,
    kind: ep.kind,
    cost,
  };
}
