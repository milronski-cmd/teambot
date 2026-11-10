import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { AlertTriangle, Download, Hand, KeyRound, Mic, MicOff, Phone, PhoneOff, Radio, ShieldCheck } from 'lucide-react';
import { api, on, postOnUnload } from '../../lib/api';
import { stripRefs } from '../../lib/preview';
import { t } from '../../lib/i18n';
import { formatSeconds } from '../../lib/format';
import { prettyModel } from '../../lib/modelLabel';
import { agentById, useApp } from '../../lib/store';
import { Badge, Button, Field, Input, Modal, Select, Spinner, Toggle, cx, toastError } from '../../components/ui';
import { BotAvatar } from '../../components/BotFace';
import { type CallView, type LiveMode, type SttEngine, type VoiceInfo, clock, loadVoice, mb, money, range, saveVoice, useVoice } from './api';
import { browserSttNote, browserSttSupported, closeMic, echoCancellationActive, micProblem, openMic } from './audio';
import { unlockAudio } from './capture';
import { RealtimeClient } from './realtime';
import { GeminiLiveClient } from './gemini';
import { CallBrain, type VoiceLink } from './cloudcall';
import { HalfDuplexCall, type HdTiming } from './halfduplex';
import { LocalSetupModal, freeCallDownload } from './LocalModels';
import { stopPlayback, usePlayer } from './player';
import { type CallPhase, callIndicator } from './indicator';
import { type TalkMode, type TalkSetting, talkMode, touchDevice } from './talk';
import { TalkButton, TalkFace, useTalkKey } from './TalkUI';
import { langName } from './VoiceFields';
import { botSpeechLanguage } from './language';
import { DuplexCallView } from './DuplexCall';
import { type DuplexStatus, duplexStatus } from './duplex';

/**
 * Kinds of call, the mode contract of server/modules/voice/duplex/mode.ts: cloud OpenAI ('realtime'), cloud Gemini
 * ('gemini') and the free live call on this PC ('duplex', talk and listen at the same time). 'halfduplex': taking turns
 * (hold to talk, or a browser/OpenAI recogniser), offered as well once it works.
 */
type Kind = 'realtime' | 'gemini' | 'duplex' | 'halfduplex';
type Stage = 'setup' | 'call' | 'summary';
type CallState = CallPhase;

interface Caption {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  final: boolean;
}

interface SessionInfo {
  call: CallView;
  clientSecret?: string;
  rtcUrl?: string;
  /** Gemini Live: WebSocket address with the single-use token, and the setup message. */
  wsUrl?: string;
  setup?: any;
  model?: string;
  mode: LiveMode;
  transcribeModel?: string | null;
  estimate?: { low: number; high: number } | null;
  priceCapUsd: number;
  maxMinutes: number;
  provider?: { id: string; name: string };
}

/** Chat header: "Live praten" — opens the call dialog. Only for chats with one bot. */
export function LiveCallButton({ threadId, agentId }: { threadId: string; agentId: string | null }) {
  const [open, setOpen] = useState(false);
  if (!agentId) return null;
  return (
    <>
      <Button variant="ghost" size="icon" aria-label="Live praten" title="Live praten (spraak)" onClick={() => setOpen(true)}>
        <Phone className="h-4 w-4" />
      </Button>
      {open && <CallDialog threadId={threadId} agentId={agentId} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Is a kind of call usable now? (cloud: a key; free: speech recognition on this pc or in the browser). */
function readiness(info: VoiceInfo | null, dx: DuplexStatus | null) {
  const rt = !!info?.status.realtime.ready;
  const gm = !!info?.status.gemini?.ready;
  const hd = !!info && (info.settings.stt.engine === 'browser' ? browserSttSupported() : info.status.stt.ready);
  return { realtime: rt, gemini: gm, duplex: !!dx?.ready, halfduplex: hd } as Record<Kind, boolean>;
}

/**
 * The first call kind that works: the one chosen in Settings ("local" = the free live call), else the free live call
 * once it is ready, else a cloud voice with a key; nothing ready: the free live call with "Klaarmaken en bellen".
 */
function defaultKind(info: VoiceInfo, dx: DuplexStatus | null): Kind {
  const ready = readiness(info, dx);
  const chosen: Kind = info.settings.call.engine === 'local' ? 'duplex' : info.settings.call.engine;
  if (ready[chosen]) return chosen;
  return (['duplex', 'realtime', 'gemini'] as Kind[]).find((k) => ready[k]) || 'duplex';
}

function CallDialog({ threadId, agentId, onClose }: { threadId: string; agentId: string; onClose(): void }) {
  const { info, error, reload } = useVoice();
  const agent = useApp((s) => s.agents.find((a) => a.id === agentId));
  const userBotLang = useApp((s) => (s.settings as any)?.botLanguage);
  const [stage, setStage] = useState<Stage>('setup');
  const [kind, setKind] = useState<Kind>('realtime');
  const [mode, setMode] = useState<LiveMode>('direct');
  const [model, setModel] = useState('');
  const [keep, setKeep] = useState(true);
  const [summary, setSummary] = useState<{ call?: CallView; reason?: string; error?: string; kind: Kind } | null>(null);
  const [inited, setInited] = useState(false);
  const [setup, setSetup] = useState(false);
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  // The free live call (full duplex on this PC): its status (speech recognition, a voice and the 35 MB call parts).
  const [dx, setDx] = useState<DuplexStatus | null>(null);
  const [dxLoaded, setDxLoaded] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const loadDx = () =>
    duplexStatus()
      .then((s) => (setDx(s), s))
      .catch(() => null)
      .finally(() => setDxLoaded(true));
  useEffect(() => {
    void loadDx();
    return on('voice.duplex.progress', () => void loadDx());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!info || inited || !dxLoaded) return;
    const av = agent?.settings?.voice || {};
    setMode(av.liveMode && av.liveMode !== 'default' ? av.liveMode : info.settings.realtime.mode);
    setModel(info.settings.realtime.model);
    setKeep(info.settings.keepTranscripts);
    setKind(defaultKind(info, dx));
    setInited(true);
  }, [info, inited, agent, dxLoaded, dx]);

  const begin = (k: Kind = kind) => {
    unlockAudio();
    setKind(k);
    setStage('call');
  };

  if (stage === 'call' && kind === 'duplex' && agent)
    return (
      <DuplexCallView
        threadId={threadId}
        agentId={agentId}
        onEnded={(s) => {
          setSummary({ ...s, kind });
          setStage('summary');
        }}
      />
    );
  if (stage === 'call' && info && agent)
    return (
      <ActiveCall
        threadId={threadId}
        agentId={agentId}
        kind={kind}
        mode={mode}
        model={model}
        keep={keep}
        sttEngine={info.settings.stt.engine}
        lang={info.settings.stt.language}
        bargeIn={info.settings.call.bargeIn}
        silenceMs={info.settings.call.silenceMs}
        talk={info.settings.call.talk}
        onEnded={(s) => {
          setSummary({ ...s, kind });
          setStage('summary');
        }}
      />
    );

  const mic = micProblem();
  const ready = readiness(info, dx);
  const hdReady = ready.halfduplex;
  const modelInfo = info?.catalog.realtimeModels.find((m) => m.id === model);
  const localStt = info?.settings.stt.engine === 'local';
  const cloud = kind === 'realtime' || kind === 'gemini';
  // A bot with a fixed language: the call is in that language (its voice and the speech recognition follow it).
  const agentLang = botSpeechLanguage(agent?.settings?.language, userBotLang);
  // A voice to download exists (for some languages there is no free local voice: then the browser voice speaks).
  const ttsLocalMissing = !!info?.status.tts.localMissing && !!(info.settings.tts.localVoice || info.effective?.tts.localVoice);
  const download = freeCallDownload(info);
  const canManage = !!info?.local.canManage;

  /** Step 0 for a cloud voice: paste your own key, then the call starts right away. */
  const saveKey = async () => {
    const v = key.trim();
    if (!v) return setKeyError(t('Plak eerst je sleutel.'));
    setSaving(true);
    setKeyError(null);
    try {
      const k = kind === 'gemini' ? 'google' : 'openai';
      await api.post('/providers', { kind: k, name: k === 'google' ? 'Google Gemini' : 'OpenAI (API)', apiKey: v });
      setKey('');
      await useApp.getState().refreshProviders?.().catch(() => {});
      const fresh = await loadVoice(true).catch(() => null);
      if (fresh && readiness(fresh, dx)[kind]) begin(kind);
      else setKeyError(t('De sleutel is opgeslagen, maar de dienst is nog niet klaar. Kijk bij Instellingen › AI-diensten.'));
    } catch (e: any) {
      setKeyError(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  if (stage === 'summary' && summary)
    return (
      <Modal
        open
        onClose={onClose}
        title="Gesprek beëindigd"
        footer={
          <>
            {(summary.kind === 'realtime' || summary.kind === 'gemini') && summary.error && (ready.duplex || hdReady) && (
              <Button
                onClick={() => {
                  setKind(ready.duplex ? 'duplex' : 'halfduplex');
                  setSummary(null);
                  setStage('setup');
                }}
              >
                Gratis gesprek proberen
              </Button>
            )}
            <Button variant="primary" onClick={onClose}>
              {summary.error ? 'Verder in tekst' : 'Sluiten'}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          {summary.error && (
            <div className="flex gap-2 rounded-lg bg-danger-soft p-3 text-danger">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{summary.error}</span>
            </div>
          )}
          {summary.reason && <div className="rounded-lg bg-surface-2 p-3">{summary.reason}</div>}
          {summary.call && (
            <div className="text-muted">
              Duur {clock(summary.call.duration_sec)} · kosten {summary.call.kind === 'realtime' ? `≈ ${money(summary.call.cost)}` : summary.call.cost ? `≈ ${money(summary.call.cost)} (spraak)` : 'alleen de gewone botkosten'}
              {summary.call.asks ? ` · ${t('{0, plural, one {# verzoek} other {# verzoeken}} aan {1}', summary.call.asks, agent?.name || '')}` : ''}
            </div>
          )}
          {summary.call?.summary && <div>{summary.call.summary}</div>}
          {summary.call?.kind === 'realtime' && (
            <div className="text-muted">
              {summary.call.keep_transcript ? 'Het transcript staat in dit gesprek.' : 'Het transcript is niet bewaard.'} {summary.call.mode === 'agent' ? 'Het verslag en wat de bot deed staan in de chat.' : ''}
            </div>
          )}
        </div>
      </Modal>
    );

  /**
   * "Klaarmaken en bellen" for the free live call, only after this tap: first the free speech (recognition and a voice)
   * when it is missing, then the small call parts; the call starts as soon as everything is there.
   */
  const prepareDuplex = async (fresh?: DuplexStatus | null) => {
    const cur = fresh || dx;
    if (!cur) return;
    if (cur.sttProblem || cur.ttsProblem) return setSetup(true);
    setPreparing(true);
    try {
      let s: DuplexStatus | null = cur.parts.some((p) => p.status !== 'installed') ? await api.post<DuplexStatus>('/voice/duplex/install') : cur;
      for (let i = 0; s && !s.ready && i < 1200; i++) {
        if (s.parts.some((p) => p.status === 'error')) throw new Error(s.parts.map((p) => p.error).filter(Boolean).join('; ') || 'Downloaden mislukt');
        await new Promise((r) => setTimeout(r, 500));
        s = await loadDx();
      }
      if (s?.ready) begin('duplex');
      else if (s?.problem) throw new Error(s.problem);
    } catch (e) {
      toastError(e);
    } finally {
      setPreparing(false);
    }
  };
  const needKey = cloud && !ready[kind];
  const needDownload = kind === 'halfduplex' && !hdReady && localStt;
  const needDuplex = kind === 'duplex' && !ready.duplex;
  const dxDownload = (dx?.sttProblem || dx?.ttsProblem ? download || 0 : 0) + (dx?.download || 0);
  const dxGot = dx ? dx.parts.reduce((n, p) => n + (p.status === 'installed' ? 0 : p.received || 0), 0) : 0;
  const primary = needKey ? (
    <Button variant="primary" icon={<KeyRound className="h-4 w-4" />} disabled={saving || !inited || !!mic} onClick={saveKey}>
      {saving ? 'Bezig…' : 'Klaarmaken en bellen'}
    </Button>
  ) : needDownload ? (
    <Button variant="primary" icon={<Download className="h-4 w-4" />} disabled={!inited || !canManage || !!mic} onClick={() => setSetup(true)}>
      Klaarmaken en bellen
    </Button>
  ) : needDuplex ? (
    <Button variant="primary" icon={<Download className="h-4 w-4" />} disabled={!inited || !dx || !dx.canManage || !!mic || preparing} onClick={() => void prepareDuplex()}>
      {preparing ? (dxGot ? t('Downloaden… {0}%', Math.round((100 * dxGot) / Math.max(1, dx?.download || 1))) : 'Bezig…') : 'Klaarmaken en bellen'}
    </Button>
  ) : (
    <Button variant="primary" icon={<Mic className="h-4 w-4" />} disabled={!inited || !!mic || !ready[kind]} onClick={() => begin()}>
      {kind === 'halfduplex' ? 'Start gesprek' : 'Start live gesprek'}
    </Button>
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={`Praten met ${agent?.name || 'bot'}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuleren
          </Button>
          {primary}
        </>
      }
    >
      {/* The choices only once the default kind is known (voice info and the free call's status), so the dialog
          never first shows a placeholder kind as chosen. */}
      {!info || !inited ? (
        error ? <div className="text-sm text-danger">{error}</div> : <Spinner />
      ) : (
        <div className="space-y-4 text-sm">
          <div className="flex items-center gap-3">
            <BotAvatar bot={agent || { name: '?' }} size={48} />
            <div>
              <div className="font-medium">{agent?.name}</div>
              <div className="flex items-center gap-1 text-xs text-muted">
                <ShieldCheck className="h-3.5 w-3.5" /> Je praat met een AI. De microfoon gaat pas aan na “Start”.
              </div>
            </div>
          </div>
          {mic && (
            <div className="rounded-lg bg-warn-soft p-3 text-warn" role="alert">
              {mic}
            </div>
          )}
          {!ready.realtime && !ready.gemini && !ready.duplex && !ready.halfduplex && (
            <div className="rounded-lg bg-surface-2 p-3 text-xs">Kies hoe je wilt bellen: met een eigen sleutel, of gratis op je pc.</div>
          )}

          <div role="radiogroup" aria-label="Soort gesprek" className="space-y-2">
            <Choice checked={kind === 'realtime'} onSelect={() => setKind('realtime')} title="Live met OpenAI" icon={<Radio className="h-4 w-4" />}>
              {ready.realtime ? (
                <>Vloeiend praten en onderbreken. Je audio gaat rechtstreeks naar {info.status.realtime.provider} via je eigen API-sleutel; betaald per gebruik, niet via ChatGPT Plus.</>
              ) : (
                <>Met je eigen OpenAI-sleutel (betaald per gebruik).</>
              )}
            </Choice>
            <Choice checked={kind === 'gemini'} onSelect={() => setKind('gemini')} title="Live met Gemini (Google)" icon={<Radio className="h-4 w-4" />}>
              {ready.gemini ? (
                <>Vloeiend praten en onderbreken, ook in het Nederlands. Je audio gaat rechtstreeks naar {info.status.gemini?.provider} via je eigen sleutel; ongeveer 1 tot 3 cent per minuut.</>
              ) : (
                <>Met een Google AI Studio-sleutel (gratis laag: Google mag je gesprekken gebruiken).</>
              )}
            </Choice>
            <Choice checked={kind === 'duplex'} onSelect={() => setKind('duplex')} title="Live gesprek, gratis (op je eigen pc)" icon={<Radio className="h-4 w-4" />}>
              {ready.duplex ? (
                <>Tegelijk praten en luisteren met {agent?.name} zelf, zonder sleutel en zonder abonnement. Onderbreken door te praten; {agent?.name} kan zelf ophangen. Alles blijft op deze computer.</>
              ) : (
                <>
                  {dx?.problem ? t('Nog niet klaar: {0}', dx.problem) + ' ' : ''}
                  {dxDownload
                    ? t('Gratis en privé op je pc. Eénmalige download ({0}).', mb(dxDownload))
                    : 'Gratis en privé op je pc. Eénmalige download.'}
                </>
              )}
            </Choice>
            {hdReady && (
            <Choice checked={kind === 'halfduplex'} onSelect={() => setKind('halfduplex')} title={localStt ? 'Gratis gesprek, om de beurt (op je eigen pc)' : 'Bellen zonder Realtime'} icon={<Phone className="h-4 w-4" />}>
              {hdReady ? (
                <>
                  Om de beurt praten met {agent?.name} zelf: hetzelfde model, dezelfde tools en engine als in de chat (ook Claude Code, Codex of OpenCode); hij kan werk doorgeven aan andere bots.{' '}
                  {talkMode(info.settings.call.talk, touchDevice()) === 'hold' ? 'Houd de spatiebalk of de knop ingedrukt terwijl je praat.' : info.settings.call.bargeIn ? 'Handsfree: praat gewoon, onderbreken door te praten kan.' : 'Handsfree: praat gewoon.'}{' '}
                  {agentLang ? t('Taal: {0}, zoals in de chat.', langName(agentLang)) + ' ' : ''}
                  Herkenning: {localStt ? 'gratis op je pc' : info.settings.stt.engine === 'browser' ? 'je browser' : info.status.stt.provider}. Stem:{' '}
                  {info.status.tts.engine === 'local' ? 'gratis op je pc' : info.status.tts.engine === 'browser' ? 'browserstem (gratis)' : info.status.tts.provider || 'uit'}. Je berichten komen gewoon in het gesprek.
                </>
              ) : localStt ? (
                <>
                  {download
                    ? t('Gratis en privé op je pc. Eénmalige download ({0}).', mb(download))
                    : 'Gratis en privé op je pc. Eénmalige download.'}
                </>
              ) : (
                <>Kies eerst spraakherkenning (lokaal, OpenAI, een eigen spraakserver of de browser) bij Instellingen › Spraak.</>
              )}
            </Choice>
            )}
          </div>

          {needKey && (
            <div className="space-y-2 rounded-xl border border-line p-3">
              <Field
                label={kind === 'gemini' ? 'Je Google AI Studio-sleutel' : 'Je OpenAI API-sleutel'}
                hint={
                  kind === 'gemini'
                    ? 'Maak hem aan op aistudio.google.com/apikey. De sleutel blijft op je pc.'
                    : 'Maak hem aan op platform.openai.com/api-keys. De sleutel blijft op je pc.'
                }
              >
                <Input
                  type="password"
                  autoComplete="off"
                  value={key}
                  placeholder={kind === 'gemini' ? 'AIza…' : 'sk-…'}
                  onChange={(e) => setKey(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && saveKey()}
                  aria-label={kind === 'gemini' ? 'Google AI Studio-sleutel' : 'OpenAI API-sleutel'}
                />
              </Field>
              {keyError && (
                <div className="text-xs text-danger" role="alert">
                  {keyError}
                </div>
              )}
            </div>
          )}
          {needDuplex && dx && !dx.canManage && <div className="rounded-lg bg-warn-soft p-3 text-xs text-warn">Alleen de eigenaar van de TeamBot-pc kan de gesprekshulp downloaden.</div>}
          {needDownload && !canManage && <div className="rounded-lg bg-warn-soft p-3 text-xs text-warn">Alleen de eigenaar van de TeamBot-pc kan de gratis spraak downloaden.</div>}
          {kind === 'halfduplex' && hdReady && ttsLocalMissing && canManage && (
            <Button size="sm" variant="secondary" icon={<Download className="h-4 w-4" />} onClick={() => setSetup(true)}>
              Gratis stem downloaden
            </Button>
          )}
          {kind === 'halfduplex' && info.settings.stt.engine === 'browser' && <div className="text-xs text-muted">{browserSttNote}</div>}
          {setup && (
            <LocalSetupModal
              need={!hdReady || kind === 'duplex' ? ['stt', 'tts'] : ['tts']}
              onClose={() => setSetup(false)}
              onReady={
                kind === 'duplex'
                  ? () => {
                      setSetup(false);
                      // The free speech is there: now the call parts, then the live call starts.
                      void reload()
                        .then(() => loadDx())
                        .then((s) => prepareDuplex(s));
                    }
                  : !hdReady
                    ? () => {
                        setSetup(false);
                        void reload().then(() => begin('halfduplex'));
                      }
                    : undefined
              }
            />
          )}

          {cloud && ready[kind] && (
            <div className="space-y-3 rounded-xl border border-line p-3">
              <Field label="Modus">
                <div className="grid gap-2 sm:grid-cols-2">
                  <Choice small checked={mode === 'agent'} onSelect={() => setMode('agent')} title="Bot bedienen">
                    Een snel spraakmodel praat; {agent?.name} doet het werk erachter met zijn eigen model, tools en jouw goedkeuringen. Het gesprek loopt door terwijl hij werkt, en hij kan zelf ophangen.
                  </Choice>
                  <Choice small checked={mode === 'direct'} onSelect={() => setMode('direct')} title="Direct praten">
                    Het spraakmodel praat met de persoonlijkheid en instructies van {agent?.name}, zonder tools. Let op: dat is een ander model dan {agent?.name} in de chat.
                  </Choice>
                </div>
              </Field>
              {kind === 'realtime' && (
                <Field label="Spraakmodel" hint={modelInfo ? `${range(modelInfo.estimate)} (schatting; prijzen gecontroleerd ${info.catalog.pricesChecked}).` : undefined}>
                  <Select value={model} onChange={(e) => setModel(e.target.value)}>
                    {info.catalog.realtimeModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <div className="text-xs text-muted">
                {t('Stopt automatisch bij {0} of na {1, plural, one {# minuut} other {# minuten}}.', money(info.settings.priceCapUsd), info.settings.maxMinutes)}
              </div>
              <Toggle checked={keep} onChange={setKeep} label={<span>Transcript bewaren in dit gesprek</span>} />
              {info.settings.realtime.sendContext && <div className="text-xs text-muted">De laatste berichten gaan mee naar de spraakdienst (uit te zetten bij Instellingen › Spraak).</div>}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function Choice({ checked, onSelect, disabled, title, icon, children, small }: { checked: boolean; onSelect(): void; disabled?: boolean; title: string; icon?: ReactNode; children: ReactNode; small?: boolean }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onSelect}
      className={cx('w-full rounded-xl border p-3 text-start transition disabled:cursor-not-allowed disabled:opacity-60', checked ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-surface-2', small && 'p-2.5')}
    >
      <div className="flex items-center gap-2 font-medium">
        {icon}
        {title}
      </div>
      <div className="mt-0.5 text-xs text-muted">{children}</div>
    </button>
  );
}

function ActiveCall(props: {
  threadId: string;
  agentId: string;
  kind: Kind;
  mode: LiveMode;
  model: string;
  keep: boolean;
  sttEngine: SttEngine;
  lang: string;
  bargeIn: boolean;
  silenceMs: number;
  talk: TalkSetting;
  onEnded(s: { call?: CallView; reason?: string; error?: string }): void;
}) {
  const { threadId, agentId, kind } = props;
  const agent = agentById(agentId);
  const name = agent?.name || 'Bot';
  const [touch] = useState(() => touchDevice());
  // Hold-to-talk on a computer, hands-free on a phone, unless chosen otherwise (Realtime has its own turn detection).
  const [talk, setTalk] = useState<TalkMode>(() => talkMode(props.talk, touch));
  const [holding, setHolding] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [state, setState] = useState<CallState>('connecting');
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [cost, setCost] = useState(0);
  const [cap, setCap] = useState(0);
  const [warn, setWarn] = useState(false);
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  const [paused, setPaused] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [timing, setTiming] = useState<HdTiming>({});
  // Cloud calls: a bot works behind the voice, or waits for your approval (the call goes on meanwhile).
  const [work, setWork] = useState<'bot' | 'waiting_approval' | null>(null);
  const approvals = useApp(useShallow((s) => s.approvals.filter((a) => a.thread_id === threadId && a.status === 'pending')));
  const box = useRef<HTMLDivElement>(null);
  const cloud = kind === 'realtime' || kind === 'gemini';
  const ref = useRef<{
    stream?: MediaStream;
    client?: RealtimeClient;
    gemini?: GeminiLiveClient;
    /** Cloud calls in "Bot bedienen": the bot behind the voice (tools, tasks, approvals, hanging up). */
    brain?: CallBrain;
    hd?: HalfDuplexCall;
    speaker?: HTMLAudioElement;
    session?: SessionInfo;
    usage: any[];
    transcription: any[];
    lines: { role: string; text: string; at: string }[];
    flushTimer?: number;
    ended: boolean;
    connectedAt?: number;
    watching: Set<string>;
    started?: boolean;
    pendingEnd?: number;
  }>({ usage: [], transcription: [], lines: [], ended: false, watching: new Set() });

  const flush = async () => {
    const r = ref.current;
    if (!r.session || r.session.call.kind !== 'realtime') return null;
    if (r.flushTimer) clearTimeout(r.flushTimer);
    r.flushTimer = undefined;
    const body = { status: 'active', usage: r.usage.splice(0), transcription: r.transcription.splice(0), lines: r.lines.splice(0), transcribeModel: r.session.transcribeModel };
    try {
      const res = await api.post<{ cost: number; capUsd: number; warn: boolean; overCap: boolean; overTime: boolean }>(`/voice/calls/${r.session.call.id}/events`, body);
      setCost(res.cost);
      setCap(res.capUsd);
      setWarn(res.warn);
      if (res.overCap) hangup(`Prijsplafond van ${money(res.capUsd)} bereikt; het gesprek is automatisch beëindigd.`);
      else if (res.overTime) hangup('De maximale gespreksduur is bereikt.');
      return res;
    } catch {
      return null;
    }
  };
  const scheduleFlush = () => {
    const r = ref.current;
    if (!r.flushTimer) r.flushTimer = window.setTimeout(flush, 800);
  };

  const hangup = async (reason?: string, error?: string) => {
    const r = ref.current;
    if (r.ended) return;
    r.ended = true;
    r.brain?.close();
    r.client?.close();
    r.gemini?.close();
    r.hd?.close();
    closeMic(r.stream);
    if (r.speaker) r.speaker.srcObject = null;
    stopPlayback();
    usePlayer.setState({ inCall: false });
    let call: CallView | undefined;
    if (r.session) {
      await flush().catch(() => null);
      call = await api.post<CallView>(`/voice/calls/${r.session.call.id}/end`, { error: error || undefined }).catch(() => undefined);
    }
    props.onEnded({ call, reason, error });
  };

  // Start right after the explicit tap on "Start". (StrictMode-safe: runs once; a simulated unmount does not hang up.)
  const start = async () => {
    const r = ref.current;
    usePlayer.setState({ inCall: true });
    stopPlayback();
    {
      try {
        const speaker = new Audio();
        speaker.autoplay = true;
        r.speaker = speaker;
        r.stream = await openMic();
        if (r.ended) return closeMic(r.stream);
        if (cloud) {
          const s = await api.post<SessionInfo>(kind === 'gemini' ? '/voice/gemini/session' : '/voice/realtime/session', { agentId, threadId, mode: props.mode, model: props.model, keepTranscript: props.keep });
          r.session = s;
          setSession(s);
          setCap(s.priceCapUsd);
          // Shared by both voices: captions into the transcript, usage to the server (it prices it), and in
          // "Bot bedienen" the bot behind the voice (CallBrain: tools that do not block, approvals, hanging up).
          const onCaption = (c: Caption) => {
            upsertCaption(c);
            if (c.final && c.text && c.role === 'user') r.brain?.userFinal(c.text);
            if (c.final && c.text && s.call.keep_transcript) {
              r.lines.push({ role: c.role, text: c.text, at: new Date().toISOString() });
              scheduleFlush();
            }
          };
          const onUsage = (u: any) => {
            r.usage.push(u);
            scheduleFlush();
          };
          const onConnected = () => {
            r.connectedAt = Date.now();
            flush();
          };
          const onError = (msg: string, fatal: boolean) => (fatal ? hangup(undefined, msg) : setNotice(msg));
          const onState = (st: CallState) => setState((cur) => (cur === 'bot' || cur === 'waiting_approval' ? cur : st));
          const onFunctionCall = (c: { name: string; callId: string; args: any }) => {
            if (!r.brain) return;
            void r.brain.toolCall(c.callId, c.name, c.args);
          };
          if (kind === 'gemini') {
            const g = new GeminiLiveClient({
              onConnected,
              onState,
              onCaption,
              onUsage,
              onFunctionCall,
              onSpeaking: (on) => r.brain?.botSpeaking_(on),
              onUserSpeaking: (on) => r.brain?.userSpeaking_(on),
              onLevel: setLevel,
              onError,
            });
            r.gemini = g;
            if (s.mode === 'agent') r.brain = makeBrain(s, { toolResult: (id, n, out, speak) => g.functionResult(id, n, out, speak), inform: (text) => g.inform(text) });
            await g.connect(r.stream, s.wsUrl!, s.setup);
          } else {
            const client = new RealtimeClient({
              onState,
              onConnected,
              onCaption,
              onUsage,
              onTranscriptionUsage: (u) => {
                r.transcription.push(u);
                scheduleFlush();
              },
              onFunctionCall,
              onSpeaking: (on) => r.brain?.botSpeaking_(on),
              onUserSpeaking: (on) => r.brain?.userSpeaking_(on),
              onError,
            });
            r.client = client;
            if (s.mode === 'agent') r.brain = makeBrain(s, { toolResult: (id, _n, out, speak) => client.functionResult(id, out, speak), inform: (text) => client.inform(text) });
            await client.connect(r.stream, s.clientSecret!, s.rtcUrl!, speaker);
          }
        } else {
          const call = await api.post<CallView>('/voice/calls', { agentId, threadId });
          const s: SessionInfo = { call, mode: 'agent', priceCapUsd: call.price_cap, maxMinutes: 30 };
          r.session = s;
          setSession(s);
          r.connectedAt = Date.now();
          // Echo cancellation keeps the bot's own voice from the speakers out of the microphone. Where the browser
          // cannot switch it on, talking over the bot no longer interrupts it (only the key or the hand button does).
          const echoOff = echoCancellationActive(r.stream) === false;
          if (echoOff) setHint(t('Geen echo-onderdrukking: onderbreken staat uit. Gebruik oortjes of houd de knop ingedrukt.'));
          const hd = new HalfDuplexCall({
            callId: call.id,
            sttEngine: props.sttEngine,
            lang: props.lang,
            bargeIn: props.bargeIn && !echoOff,
            silenceMs: props.silenceMs,
            talk,
            cb: {
              onState: (st) => setState(st),
              onCaption: (c) => upsertCaption({ id: c.final ? `${c.role}_${Date.now()}` : 'partial', role: c.role, text: c.text, final: c.final }),
              onLevel: setLevel,
              onError: (msg, fatal) => (fatal ? hangup(undefined, msg) : setNotice(msg)),
              onTiming: (t) => setTiming((x) => ({ ...x, ...t })),
              onBargeIn: () => upsertCaption({ id: `barge_${Date.now()}`, role: 'assistant', text: '(onderbroken — ik luister)', final: true }),
              onHint: (text) => setHint(t(text)),
            },
          });
          r.hd = hd;
          await hd.start(r.stream);
        }
      } catch (e: any) {
        if (!r.ended) hangup(undefined, e?.message || String(e));
      }
    }
  };

  useEffect(() => {
    const r = ref.current;
    if (r.pendingEnd) clearTimeout(r.pendingEnd);
    r.pendingEnd = undefined;
    if (!r.started) {
      r.started = true;
      start();
    }
    const onUnload = () => {
      const s = ref.current.session;
      if (s && !ref.current.ended) postOnUnload(`/voice/calls/${s.call.id}/end`);
    };
    // On a computer the call goes on while the window is hidden (the tray, another program): you started it and the
    // bar at the top says the microphone is on. On a phone the system stops the microphone of a hidden app anyway:
    // pause there, and go on by itself as soon as the app is open again.
    const onVis = () => {
      const r = ref.current;
      if (r.ended || !touch) return;
      if (document.visibilityState === 'hidden') {
        r.client?.mute(true);
        r.gemini?.mute(true);
        r.hd?.pause(true);
        setPaused(true);
      } else if (document.visibilityState === 'visible') {
        setPaused(false);
        r.client?.mute(mutedRef.current);
        r.gemini?.mute(mutedRef.current);
        r.hd?.pause(false);
        setHint(t('Weer terug: het gesprek loopt door.'));
      }
    };
    window.addEventListener('beforeunload', onUnload);
    document.addEventListener('visibilitychange', onVis);
    const tick = window.setInterval(() => {
      const c = ref.current.connectedAt;
      if (!c) return;
      const sec = (Date.now() - c) / 1000;
      setElapsed(sec);
      const max = ref.current.session?.maxMinutes || 30;
      if (sec >= max * 60) hangup('De maximale gespreksduur is bereikt.');
    }, 1000);
    return () => {
      clearInterval(tick);
      window.removeEventListener('beforeunload', onUnload);
      document.removeEventListener('visibilitychange', onVis);
      // Leaving the chat/closing the dialog hangs up immediately.
      r.pendingEnd = window.setTimeout(() => !r.ended && hangup(), 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [captions]);

  const upsertCaption = (c: Caption) =>
    setCaptions((prev) => {
      const list = c.final ? prev.filter((x) => x.id !== 'partial') : prev;
      const i = list.findIndex((x) => x.id === c.id);
      const next = i >= 0 ? list.map((x, j) => (j === i ? c : x)) : [...list, c];
      return next.filter((x) => x.final || x.text || x.id === c.id).slice(-40);
    });

  /**
   * The bot behind the cloud voice: its tools do not block the call, results are told when the line is quiet, a
   * spoken "ja" approves once, and an accepted end_call hangs up after the goodbye (cloudcall.ts).
   */
  const makeBrain = (s: SessionInfo, link: VoiceLink) =>
    new CallBrain(
      {
        callId: s.call.id,
        post: (p, b) => api.post(p, b),
        get: (p) => api.get(p),
        link,
        onHangup: (why) => void hangup(why === 'bot' ? t('{0} heeft opgehangen.', name) : t('Opgehangen na een lange stilte.')),
        // While a bot works the call goes on: show it, but keep listening (the voice model can still talk).
        onWork: (w) => setWork(w),
      },
      name,
    );

  const toggleMute = () => {
    const on = !muted;
    setMuted(on);
    mutedRef.current = on;
    ref.current.client?.mute(on);
    ref.current.gemini?.mute(on);
    ref.current.hd?.mute(on);
    if (cloud) setState((s) => (on ? 'muted' : s === 'muted' ? 'listening' : s));
  };
  const resume = () => {
    setPaused(false);
    ref.current.client?.mute(muted);
    ref.current.gemini?.mute(muted);
    ref.current.hd?.pause(false);
  };
  const interrupt = () => {
    ref.current.client?.interrupt();
    ref.current.gemini?.interrupt();
    ref.current.hd?.interrupt();
  };

  // Hold-to-talk: the space bar or the big button. press() says whether you are talking now (not while your last
  // words are recognised or the bot waits for your approval).
  const holdTalk = kind === 'halfduplex' && talk === 'hold';
  const press = () => {
    setHint(null);
    setHolding(!!ref.current.hd?.press());
  };
  const release = () => {
    ref.current.hd?.release();
    setHolding(false);
  };
  useTalkKey(holdTalk && !muted && !paused, press, release);
  const changeTalk = (m: TalkMode) => {
    setTalk(m);
    setHolding(false);
    setHint(null);
    ref.current.hd?.setTalk(m);
    // Remembered for the next call (Instellingen › Spraak shows the same choice).
    saveVoice({ call: { talk: m } }).catch(() => {});
  };

  useEffect(() => {
    const f = (e: KeyboardEvent) => e.key === 'Escape' && hangup();
    window.addEventListener('keydown', f);
    // The space bar talks here: a text field that still had the focus would get the spaces instead.
    (document.activeElement as HTMLElement | null)?.blur?.();
    return () => window.removeEventListener('keydown', f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const live = state !== 'connecting' && !paused;
  const shownState: CallState = paused ? 'paused' : muted && cloud ? 'muted' : state;
  const ind = callIndicator(shownState, name, { keyboard: !touch, t });
  // The same model as in the chat: a spoken turn is a normal run of the bot (the last answer says which model wrote it).
  const shownModel = kind === 'halfduplex' ? timing.model || agent?.model || '' : '';

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/50 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={`Gesprek met ${name}`}>
      <div className="flex max-h-full w-full flex-col bg-surface sm:max-w-md sm:rounded-2xl sm:border sm:border-line sm:shadow-xl">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-xs text-muted">
          <Badge tone="accent">AI</Badge>
          <span className="min-w-0 flex-1 truncate">
            {cloud
              ? `${kind === 'gemini' ? 'Live via Gemini' : 'Live via OpenAI Realtime'}${session?.model ? ` · ${session.model}` : ''} · ${props.mode === 'agent' ? 'bot bedienen' : 'direct'}`
              : `${props.sttEngine === 'local' ? 'Gratis gesprek' : 'Bellen zonder Realtime'} · ${talk === 'hold' ? 'ingedrukt houden om te praten' : props.bargeIn ? 'handsfree, onderbreken door te praten' : 'handsfree'}`}
          </span>
          <span className="flex items-center gap-1 font-medium text-danger" aria-label={muted || paused ? 'Microfoon uit' : 'Microfoon aan'}>
            <span className={cx('h-2 w-2 rounded-full', muted || paused ? 'bg-muted' : 'animate-pulse bg-danger')} />
            {muted || paused ? 'mic uit' : 'mic aan'}
          </span>
        </div>

        <div className="flex flex-col items-center gap-2 px-4 pt-6">
          <TalkFace bot={agent || { name }} status={ind.status} size={104} level={level} showWord={false} />
          <div className="text-lg font-semibold">{name}</div>
          {/* Who listens, thinks or speaks: always in words, next to the bot's own name and face. */}
          <div className={cx('flex min-h-6 items-center gap-2 text-center text-base font-medium', ind.status === 'listening' ? 'text-ok' : ind.status === 'waiting' ? 'text-warn' : 'text-fg')} role="status" aria-live="polite">
            {shownState === 'connecting' || ind.status === 'thinking' ? <Spinner /> : null}
            {ind.text}
          </div>
          {shownModel && <div className="text-[11px] text-muted">{t('Model: {0}, hetzelfde als in de chat', prettyModel(shownModel))}</div>}
          <div className="font-mono text-xs text-muted">
            {clock(elapsed)}
            {cloud ? ` · ${t('≈ {0} van max {1}', money(cost), money(cap))}` : ''}
          </div>
          {kind === 'halfduplex' && (timing.sttMs !== undefined || timing.botMs !== undefined) && (
            <div className="text-[11px] text-muted" aria-label="Vertraging">
              {[
                timing.sttMs !== undefined ? t('herkenning {0}', formatSeconds(timing.sttMs)) : null,
                timing.firstSoundMs !== undefined ? t('eerste klank na {0}', formatSeconds(timing.firstSoundMs)) : null,
                timing.botMs !== undefined ? t('{0} klaar na {1}', name, formatSeconds(timing.botMs)) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
          )}
        </div>

        <div className="space-y-2 px-4 pt-3">
          {warn && cloud && (
            <div className="flex items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
              <AlertTriangle className="h-4 w-4 shrink-0" /> Bijna bij het prijsplafond ({money(cap)}). Het gesprek stopt daar automatisch.
            </div>
          )}
          {work === 'bot' && !approvals.length && (
            <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-xs" role="status">
              <Spinner /> {t('{0} werkt eraan. Praat gerust door; het resultaat komt vanzelf.', name)}
            </div>
          )}
          {paused && (
            <div className="flex items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2 text-xs">
              <span>Gepauzeerd: de app was op de achtergrond, de microfoon staat uit.</span>
              <Button size="sm" variant="primary" onClick={resume}>
                Doorgaan
              </Button>
            </div>
          )}
          {notice && (
            <div className="flex items-start justify-between gap-2 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">
              <span>{notice}</span>
              <button className="underline" onClick={() => setNotice(null)}>
                Sluiten
              </button>
            </div>
          )}
          {hint && (
            <div className="flex items-start justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted" role="status">
              <span>{hint}</span>
              <button className="underline" onClick={() => setHint(null)}>
                Sluiten
              </button>
            </div>
          )}
          {approvals.map((a) => (
            <div key={a.id} className="rounded-lg border border-warn bg-warn-soft p-2.5 text-xs">
              <div className="font-medium text-warn">{a.kind === 'question' ? `${name} heeft een vraag` : `${name} vraagt toestemming`}</div>
              <div className="mt-0.5 line-clamp-3 text-fg">{stripRefs(a.summary)}</div>
              {a.kind === 'tool' && cloud && props.mode === 'agent' && <div className="mt-1 text-muted">{t('Zeg duidelijk “ja” of “nee”, of tik hieronder. Een ja geldt één keer.')}</div>}
              {a.kind === 'tool' ? (
                <div className="mt-2 flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={() => api.post(`/approvals/${a.id}`, { decision: 'deny' }).catch(toastError)}>
                    Weigeren
                  </Button>
                  <Button size="sm" variant="primary" onClick={() => api.post(`/approvals/${a.id}`, { decision: 'approve' }).catch(toastError)}>
                    Eén keer toestaan
                  </Button>
                </div>
              ) : (
                <div className="mt-1 text-muted">Beantwoord de vraag in het chatgesprek.</div>
              )}
            </div>
          ))}
        </div>

        <div ref={box} className="scroll-thin mx-4 mt-3 min-h-28 flex-1 space-y-1.5 overflow-y-auto rounded-xl bg-surface-2 p-3 text-sm sm:max-h-64" aria-label="Live ondertiteling">
          {!captions.length && <div className="text-center text-xs text-muted">{live ? 'Ondertiteling verschijnt hier.' : 'Even geduld…'}</div>}
          {captions.map((c) => (
            <div key={c.id} className={cx(!c.final && 'opacity-60')}>
              <span className="font-medium">{c.role === 'user' ? 'Jij' : name}: </span>
              {c.text}
            </div>
          ))}
        </div>

        {holdTalk && (
          <div className="flex flex-col items-center gap-1 px-4 pt-4">
            <TalkButton holding={holding} disabled={muted || paused || state === 'connecting'} onPress={press} onRelease={release} keyboard={!touch} />
            <div className="text-[11px] text-muted">{holding ? t('Laat los als je klaar bent') : touch ? t('Ingedrukt houden en praten') : t('Ingedrukt houden of de spatiebalk')}</div>
          </div>
        )}
        <div className="flex items-center justify-center gap-3 px-4 pb-[max(1rem,var(--safe-bottom))] pt-4">
          <Button variant="secondary" className="h-12 w-12 justify-center rounded-full" aria-label={muted ? 'Microfoon aanzetten' : 'Dempen'} title={muted ? 'Microfoon aanzetten' : 'Dempen'} aria-pressed={muted} onClick={toggleMute}>
            {muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
          </Button>
          <Button variant="secondary" className="h-12 w-12 justify-center rounded-full" aria-label="Onderbreken" title="Onderbreken (stopt het antwoord)" onClick={interrupt}>
            <Hand className="h-5 w-5" />
          </Button>
          <Button variant="danger" className="h-14 w-14 justify-center rounded-full" aria-label="Ophangen" title="Ophangen" onClick={() => hangup()}>
            <PhoneOff className="h-6 w-6" />
          </Button>
        </div>
        {kind === 'halfduplex' && (
          <div className="flex justify-center px-4 pb-2">
            <Toggle checked={talk === 'handsfree'} onChange={(x) => changeTalk(x ? 'handsfree' : 'hold')} label={<span className="text-xs">Handsfree (zonder knop: een pauze beëindigt je beurt)</span>} />
          </div>
        )}
        <div className="px-4 pb-3 text-center text-[11px] text-muted">
          {cloud
            ? `Je stem gaat rechtstreeks naar ${session?.provider?.name || (kind === 'gemini' ? 'Google' : 'OpenAI')} (je eigen API-sleutel). De stem die je hoort is door AI gegenereerd.`
            : props.sttEngine === 'local'
              ? 'Je stem wordt op je pc omgezet in tekst; de bot antwoordt zoals in de chat. De stem is door AI gemaakt.'
              : `Je stem gaat naar ${props.sttEngine === 'browser' ? 'de spraakdienst van je browser' : 'je spraakprovider'} voor tekst; de bot antwoordt zoals in de chat.`}
        </div>
      </div>
    </div>
  );
}
