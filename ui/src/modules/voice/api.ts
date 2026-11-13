import { useEffect, useRef, useState } from 'react';
import { api, on, request } from '../../lib/api';
import { t } from '../../lib/i18n';
import { formatNumber, formatUsd, formatUsdRange } from '../../lib/format';
import type { CallEngine, LiveMode, VoiceSettings } from '../../../../shared/voiceSettings.js';

export type { AgentVoice, LiveMode, SttEngine, VoiceSettings } from '../../../../shared/voiceSettings.js';

export interface VoiceStatus {
  openai: { id: string; name: string; hasKey: boolean } | null;
  stt: { engine: string; ready: boolean; provider: string | null; kind: string | null; model: string | null; missing: string | null; warm?: boolean };
  tts: { engine: string; provider: string | null; model: string | null; voice: string | null; error?: string; localMissing?: string | null };
  realtime: { ready: boolean; provider: string | null };
  gemini?: { ready: boolean; provider: string | null };
  call: { engine: CallEngine; localReady: boolean };
  providers: { id: string; name: string; kind: string; kindLabel: string; own: boolean; hasKey: boolean }[];
}

export interface RealtimeModelInfo {
  id: string;
  label: string;
  text: { in: number; cached: number; out: number };
  audio: { in: number; cached: number; out: number };
  estimate: { low: number; high: number } | null;
}

export interface Catalog {
  pricesChecked: string;
  realtimeModels: RealtimeModelInfo[];
  realtimeVoices: string[];
  geminiModels?: { id: string; label: string; estimate: { low: number; high: number } }[];
  geminiVoices?: string[];
  transcribeModels: { id: string; label: string; perMin: number; deprecatedAfter?: string; deprecated: boolean }[];
  sttModels: { id: string; label: string; perMin: number; deprecatedAfter?: string; deprecated: boolean }[];
  ttsModels: { id: string; label: string; voices: string[]; instructions?: boolean; realtime?: boolean; maxSpeed: number; deprecatedAfter?: string; deprecated: boolean; perMinEstimate: number | null }[];
  languages: { id: string; label: string }[];
}

export interface LocalModelView {
  id: string;
  kind: 'stt' | 'tts-runtime' | 'tts-voice';
  /** Voices: 'piper' needs the Piper program, 'vits' runs in TeamBot itself. */
  voiceEngine: 'piper' | 'vits' | null;
  label: string;
  description: string;
  licence: string;
  licenceNote: string | null;
  source: string;
  languages: string[];
  lang: string | null;
  speakers: { id: number; label: string }[] | null;
  speedHint: string | null;
  recommended: boolean;
  recommendedFor: string[] | null;
  size: number;
  status: 'missing' | 'downloading' | 'verifying' | 'installed' | 'error' | 'unsupported';
  received: number;
  total: number;
  error: string | null;
}

export interface LocalView {
  platform: string;
  licencesChecked: string;
  /** ttsSupported: the Piper program exists for this system; vitsProblem: why voices that run in TeamBot itself cannot. */
  runtime: { stt: string; sttProblem: string | null; tts: string; ttsSupported: boolean; vitsProblem?: string | null };
  models: LocalModelView[];
  canManage: boolean;
}

/** What the automatic choices ('' / 'auto-app' in the settings) are right now, and what fits the interface language. */
export interface EffectiveVoice {
  language: string;
  /** modelLanguage: the language the automatic speech model is chosen for (the dictation language). */
  stt: { language: string; localModel: string; modelLanguage?: string };
  /** '' = there is no free local voice for the interface language (the browser voice reads aloud). */
  tts: { localVoice: string };
  recommended: { stt: string; voices: string[] };
}

export interface VoiceInfo {
  /** As saved: stt.language 'auto-app', stt.localModel '' and tts.localVoice '' are automatic (see `effective`). */
  settings: VoiceSettings;
  effective: EffectiveVoice;
  status: VoiceStatus;
  catalog: Catalog;
  mode: 'desktop' | 'server';
  local: LocalView;
  hotkey?: HotkeyView;
}

/** Global dictation hotkey (only the desktop app has it). */
export interface HotkeyView {
  available: boolean;
  presets: { accel: string; label: string }[];
  enabled?: boolean;
  accelerator?: string;
  label?: string;
  registered?: boolean;
  error?: string | null;
  hold?: boolean;
  paste?: boolean;
  last?: { at: string; chars: number; how: string; seconds: number } | null;
}

export interface Clip {
  attachment_id: string;
  transcript: string;
  duration: number | null;
  segments: { start: number; end: number; text: string }[];
  timing: 'real' | 'estimated';
  model: string;
  provider_name: string;
  audio_deleted: boolean;
  user_id: string;
}

export interface TranscribeResult {
  text: string;
  language: string | null;
  durationSec: number | null;
  segments: Clip['segments'];
  timing: 'real' | 'estimated';
  model: string;
  provider: string;
  cost: number | null;
  attachment: { id: string; name: string; mime: string; size: number } | null;
}

export interface CallView {
  id: string;
  agent_id: string;
  thread_id: string;
  kind: 'realtime' | 'halfduplex';
  /** Cloud calls: 'bot' when the bot hung up itself (end_call). */
  ended_by?: string | null;
  end_reason?: string | null;
  summary?: string | null;
  /** 'group': a group voice call (half-duplex) on a group thread; `group` is then the group's name. */
  mode: LiveMode | 'group';
  group?: string;
  model: string;
  voice: string;
  status: 'connecting' | 'active' | 'ended' | 'failed';
  keep_transcript: boolean;
  cost: number;
  price_cap: number;
  asks: number;
  error: string | null;
  started_at: string;
  ended_at: string | null;
  duration_sec: number;
  lines: number;
  transcript?: { role: 'user' | 'assistant'; text: string; at: string }[];
}

// ---------- settings cache (shared by all voice components) ----------

let cache: Promise<VoiceInfo> | null = null;
const listeners = new Set<(v: VoiceInfo) => void>();

export function loadVoice(force = false): Promise<VoiceInfo> {
  if (!cache || force) {
    cache = api.get<VoiceInfo>('/voice/settings');
    cache.then((v) => listeners.forEach((l) => l(v))).catch(() => (cache = null));
  }
  return cache;
}

let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  for (const ev of ['voice.settings.updated', 'provider.updated', 'provider.deleted']) on(ev, () => loadVoice(true).catch(() => {}));
  // A finished (or failed) model download changes what works.
  on('voice.local.progress', (s: { status: string }) => (s.status === 'installed' || s.status === 'error' || s.status === 'missing') && loadVoice(true).catch(() => {}));
}

/** Voice settings + status + catalog, refreshed when settings or providers change. */
export function useVoice() {
  const [info, setInfo] = useState<VoiceInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    wire();
    let alive = true;
    const l = (v: VoiceInfo) => alive && setInfo(v);
    listeners.add(l);
    loadVoice()
      .then((v) => alive && setInfo(v))
      .catch((e) => alive && setError(e?.message || String(e)));
    return () => {
      alive = false;
      listeners.delete(l);
    };
  }, []);
  return { info, error, reload: () => loadVoice(true).then(setInfo).catch((e) => setError(e?.message || String(e))) };
}

export async function saveVoice(patch: Partial<VoiceSettings> | any): Promise<VoiceInfo> {
  await api.put('/voice/settings', patch);
  return loadVoice(true);
}

export function transcribeBlob(blob: Blob, o: { threadId?: string | null; save?: boolean; durationMs?: number; callId?: string | null }): Promise<TranscribeResult> {
  const q = new URLSearchParams();
  if (o.threadId) q.set('threadId', o.threadId);
  if (o.save) q.set('save', '1');
  if (o.durationMs) q.set('durationMs', String(Math.round(o.durationMs)));
  if (o.callId) q.set('callId', o.callId);
  return request(`/voice/transcribe?${q}`, { method: 'POST', raw: blob, headers: { 'content-type': blob.type || 'audio/webm' } });
}

/** Live download progress of local models (starts/joins downloads too). */
export function useLocalModels() {
  const [view, setView] = useState<LocalView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<LocalView | null>(null);
  current.current = view;
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .get<LocalView>('/voice/local')
        .then((v) => alive && setView(v))
        .catch((e) => alive && setError(e?.message || String(e)));
    load();
    const off = on('voice.local.progress', (s: Partial<LocalModelView> & { id: string }) =>
      setView((v) => (v ? { ...v, models: v.models.map((m) => (m.id === s.id ? { ...m, ...s } : m)) } : v)),
    );
    // Events can be missed (phone asleep, reconnect): poll gently while something downloads.
    const t = window.setInterval(() => {
      if (current.current?.models.some((m) => m.status === 'downloading' || m.status === 'verifying')) load();
    }, 2500);
    return () => {
      alive = false;
      off();
      clearInterval(t);
    };
  }, []);
  const act = async (id: string, what: 'install' | 'cancel' | 'remove') => {
    if (what === 'remove') await api.del(`/voice/local/models/${id}`);
    else await api.post(`/voice/local/models/${id}/${what}`, {});
    setView(await api.get<LocalView>('/voice/local'));
    loadVoice(true).catch(() => {});
  };
  return { view, error, act };
}

/** Model sizes as the download pages give them (decimal): "670 MB", "1,2 GB". */
export const mb = (b: number) =>
  b >= 1e9
    ? formatNumber(b / 1e9, { style: 'unit', unit: 'gigabyte', unitDisplay: 'short', minimumFractionDigits: 1, maximumFractionDigits: 1 })
    : formatNumber(Math.max(1, Math.round(b / 1e6)), { style: 'unit', unit: 'megabyte', unitDisplay: 'short' });

export const money = (v: number | null | undefined) => (v == null ? 'onbekend' : v > 0 && v < 0.01 ? `< ${formatUsd(0.01)}` : formatUsd(v));
export const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
export const range = (e: { low: number; high: number } | null | undefined) => (e ? t('≈ {0} per minuut', formatUsdRange(e.low, e.high)) : 'prijs onbekend');
