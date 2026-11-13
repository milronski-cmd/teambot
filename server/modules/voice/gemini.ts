import type { Agent, Ctx, ProviderConfig, Thread, User } from '../../core/types.js';
import { HttpError } from '../../core/http.js';
import { GEMINI_ESTIMATE, GEMINI_LIVE_MODELS, GEMINI_VOICES } from './catalog.js';
import { type LiveMode, getSettings } from './settings.js';
import { endpointUrl, providerError } from './providers.js';
import { buildInstructions, liveCallStart, recordLiveCall } from './realtime.js';
import { geminiTools, specsFor } from './calltools.js';
import { PLACE } from '../../../shared/places.js';

/**
 * Gemini Live (Google AI Studio API key): the server mints a single-use ephemeral token with the user's own key (the
 * key never leaves the server) and gives the browser the token, the WebSocket address and the setup message. Audio
 * goes browser ↔ Google directly over that WebSocket (16 kHz PCM up, 24 kHz PCM down). Tools are NON_BLOCKING: the
 * voice keeps talking while the bot works.
 */

export const NO_GEMINI =
  `Gemini Live heeft een Google Gemini API-sleutel nodig (gratis aan te maken in Google AI Studio; plak hem bij ${PLACE.ai}).`;

export interface GeminiEndpoint {
  cfg: ProviderConfig;
  label: string;
  /** e.g. https://generativelanguage.googleapis.com */
  origin: string;
  key: string;
}

/** A Google Gemini provider with a key: the chosen one, else the user's own first, else one shared with them. */
export function geminiEndpoint(ctx: Ctx, userId: string, id: string | null | undefined): GeminiEndpoint | null {
  const usable = (c: ProviderConfig | null | undefined) => !!c && c.enabled && c.kind === 'google' && ctx.providers.canUse(userId, c);
  let cfg: ProviderConfig | null = null;
  if (id) {
    const c = ctx.providers.config(id);
    cfg = usable(c) ? c : null;
    if (!cfg) return null;
  } else
    cfg =
      ctx.providers
        .list(userId)
        .filter((p) => usable(p) && p.secret_id)
        .sort((a, b) => Number(b.user_id === userId) - Number(a.user_id === userId))[0] || null;
  if (!cfg) return null;
  const key = ctx.secrets.get(cfg.secret_id);
  if (!key) return null;
  const base = (cfg.base_url || ctx.providers.kind(cfg.kind)?.baseUrl || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/+$/, '');
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    return null;
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new HttpError(400, 'Gemini Live vereist een https-adres voor de Gemini-provider', 'voice_realtime_https');
  return { cfg, label: cfg.name || 'Google Gemini', origin: u.origin, key };
}

export interface GeminiSessionResult {
  call: any;
  token: string;
  wsUrl: string;
  setup: any;
  model: string;
  voice: string;
  mode: LiveMode;
  estimate: { low: number; high: number };
  priceCapUsd: number;
  maxMinutes: number;
  provider: { id: string; name: string };
}

export async function createGeminiSession(
  ctx: Ctx,
  user: Pick<User, 'id' | 'role'>,
  agent: Agent,
  thread: Thread,
  o: { mode?: string; voice?: string; keepTranscript?: boolean },
): Promise<GeminiSessionResult> {
  const settings = getSettings(ctx, user.id);
  const ep = geminiEndpoint(ctx, user.id, settings.gemini.providerId);
  if (!ep) throw new HttpError(400, NO_GEMINI, 'voice_no_gemini');
  const { mode, priceCapUsd } = liveCallStart(ctx, user.id, agent, settings, o.mode);
  const model = GEMINI_LIVE_MODELS.some((m) => m.id === settings.gemini.model) ? settings.gemini.model : GEMINI_LIVE_MODELS[0].id;
  const voice = o.voice && GEMINI_VOICES.includes(o.voice) ? o.voice : settings.gemini.voice;

  const specs = specsFor(ctx, agent);
  const setup = {
    model: `models/${model}`,
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
    systemInstruction: { parts: [{ text: buildInstructions(ctx, agent, thread, mode, settings, specs) }] },
    ...(mode === 'agent' ? { tools: geminiTools(specs) } : {}),
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: Math.max(500, Math.min(1500, settings.call.silenceMs)) } },
    contextWindowCompression: { slidingWindow: {} },
  };
  const url = await endpointUrl(ctx, user, { cfg: ep.cfg, kind: 'google', label: ep.label, baseUrl: ep.origin, key: ep.key }, '/v1beta/auth_tokens');
  const at = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'x-goog-api-key': ep.key, 'content-type': 'application/json' },
      body: JSON.stringify({
        uses: 1,
        expireTime: new Date(at + 35 * 60_000).toISOString(),
        newSessionExpireTime: new Date(at + 60_000).toISOString(),
        liveConnectConstraints: { model: `models/${model}` },
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e: any) {
    throw new HttpError(502, `Google is niet bereikbaar (${String(e?.cause?.code || e?.message || e).slice(0, 120)})`, 'voice_unreachable');
  }
  if (!res.ok) throw await providerError(res, 'Gemini Live starten bij Google');
  const j: any = await res.json().catch(() => ({}));
  const token = typeof j?.name === 'string' ? j.name : '';
  if (!token || token.includes(ep.key)) throw new HttpError(502, 'Google gaf geen geldig tijdelijk sleutelbewijs terug', 'voice_provider_error');
  const wsBase = ep.origin.replace(/^http/, 'ws');
  const wsUrl = `${wsBase}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(token)}`;
  const call = recordLiveCall(ctx, { userId: user.id, agent, thread, settings, kind: 'gemini', mode, provider: { id: ep.cfg.id, name: ep.label }, model, voice, keepTranscript: o.keepTranscript, priceCap: priceCapUsd });
  return {
    call,
    token,
    wsUrl,
    setup,
    model,
    voice,
    mode,
    estimate: GEMINI_ESTIMATE,
    priceCapUsd: Math.round(priceCapUsd * 100) / 100,
    maxMinutes: settings.maxMinutes,
    provider: { id: ep.cfg.id, name: ep.label },
  };
}
