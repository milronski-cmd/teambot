import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Mic, MicOff, PhoneOff } from 'lucide-react';
import { api } from '../../lib/api';
import { t } from '../../lib/i18n';
import { useApp } from '../../lib/store';
import type { Message } from '../../lib/types';
import { Badge, Button, Modal, Toggle, cx } from '../../components/ui';
import { EnergyVad, LevelMeter, Recording, closeMic, micProblem, openMic, plainForSpeech } from './audio';
import { loadVoice, saveVoice, transcribeBlob, useVoice } from './api';
import { PcmCapture, type PcmRecording, unlockAudio } from './capture';
import { playMessage, stopPlayback } from './player';
import { addressed, confirmAnswer, matchSpokenName } from './names';
import { type GroupPhase, groupIndicator } from './indicator';
import { PRESS_PRE_ROLL_MS, RELEASE_TAIL_MS, type TalkMode, talkMode, touchDevice } from './talk';
import { TalkButton, TalkFace, useTalkKey } from './TalkUI';
import { LocalSetupModal, sttDownload } from './LocalModels';

type State = GroupPhase;

/** A name that was heard but not clearly: "Ik hoorde “Onderzoeken”. Bedoel je Onderzoeker?" */
interface Confirm {
  heard: string;
  candidates: string[];
  rest: string;
  original: string;
}

/**
 * "Peter, wat vind jij?" → "@Peter wat vind jij?" so spoken names address bots like @mentions do. A name that speech
 * recognition got slightly wrong still counts when it clearly sounds like one bot; when unsure, null + a question.
 */
export function addressByName(text: string, names: string[]): { content: string; confirm: Confirm | null } {
  const m = matchSpokenName(text, names);
  if (m.kind === 'unsure') return { content: text.trim(), confirm: { heard: m.heard, candidates: m.candidates, rest: m.rest, original: text.trim() } };
  if (m.kind === 'everyone') return { content: addressed('iedereen', m.rest, text), confirm: null };
  if (m.kind === 'exact' || m.kind === 'close') return { content: addressed(m.name, m.rest, text), confirm: null };
  return { content: text.trim(), confirm: null };
}

/** Shorter than this is a tap on the talk button, not a turn. */
const MIN_HOLD_MS = 300;

/**
 * Group voice call (VOX-04): talk to a whole group. Your words go into the group chat as a spoken message, the
 * group's routing decides who answers (start with a name to address one bot), and every bot's answer is read
 * aloud in that bot's own voice, one after the other. Each bot's face says what it does (listens, thinks, speaks)
 * and one line says it for the group. Then it listens again.
 * Hold-to-talk (default on a computer): you hold the space bar or the button; pressing while a bot speaks stops its
 * voice and lets you talk. Hands-free: it never listens while a bot speaks (half-duplex), so a bot's voice from the
 * speakers cannot start a turn. Works with any provider; costs = speech-to-text per utterance + text-to-speech per
 * answer.
 */
function GroupCallDialog({ threadId, onClose }: { threadId: string; onClose(): void }) {
  const { info } = useVoice();
  const thread = useApp((s) => s.threads.find((t) => t.id === threadId));
  // Bots with a run in this group chat: they are thinking (working on an answer).
  const working = useApp(useShallow((s) => [...new Set(s.runs.filter((x) => x.thread_id === threadId).map((x) => x.agent_id))]));
  const [bots, setBots] = useState<{ agentId: string; name: string; avatar: string; color: string }[]>([]);
  const [state, setStateRaw] = useState<State>('connecting');
  const [speaker, setSpeaker] = useState<string | null>(null);
  const [log, setLog] = useState<{ who: string; text: string }[]>([]);
  const [err, setErr] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [muted, setMuted] = useState(false);
  const [touch] = useState(() => touchDevice());
  const [talk, setTalkState] = useState<TalkMode>(() => talkMode(info?.settings.call.talk, touch));
  const [holding, setHolding] = useState(false);
  const [confirm, setConfirmState] = useState<Confirm | null>(null);
  const confirmRef = useRef<Confirm | null>(null);
  const setConfirm = (c: Confirm | null) => {
    confirmRef.current = c;
    setConfirmState(c);
  };
  const names = useRef<string[]>([]);
  names.current = bots.map((b) => b.name);
  const r = useRef({
    stream: null as MediaStream | null,
    meter: null as LevelMeter | PcmCapture | null,
    cap: null as PcmCapture | null,
    vad: null as EnergyVad | null,
    rec: null as Recording | PcmRecording | null,
    stopped: false,
    busy: false,
    spoken: new Set<string>(),
    since: '',
    callId: null as string | null,
    turns: 0,
    talk: 'hold' as TalkMode,
    muted: false,
    state: 'connecting' as State,
    /** A new turn or a cut-in: an older loop that reads answers aloud stops. */
    gen: 0,
    holding: false,
    /** This press stopped a bot that was speaking (or the group's turn). */
    barged: false,
    pressedAt: 0,
    tail: null as ReturnType<typeof setTimeout> | null,
  });
  r.current.talk = talk;
  r.current.muted = muted;
  const setState = (s: State) => {
    r.current.state = s;
    setStateRaw(s);
  };

  // The saved choice once the settings are there (the dialog can open before they load).
  const inited = useRef(false);
  useEffect(() => {
    if (!info || inited.current) return;
    inited.current = true;
    const m = talkMode(info.settings.call.talk, touch);
    if (m === r.current.talk) return;
    setTalkState(m);
    r.current.talk = m;
    if (!r.current.busy && r.current.state !== 'user') listen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, touch]);

  useEffect(() => {
    api.get<any>(`/rooms/by-thread/${threadId}`).then((v) => setBots((v.room?.bots || []).map((b: any) => ({ agentId: b.agentId, name: b.name, avatar: b.avatar, color: b.color })))).catch(() => {});
  }, [threadId]);

  const listen = () => {
    const s = r.current;
    if (s.stopped || s.busy || !s.stream) return;
    if (s.muted) return setState('muted');
    s.rec?.cancel();
    s.rec = null;
    if (s.talk === 'hold') {
      // The microphone stays open (level meter) but nothing is recorded until you press.
      if (s.vad) s.vad.paused = true;
      return setState('ready');
    }
    setState('listening');
    s.rec = s.cap ? s.cap.record(300) : new Recording(s.stream);
    s.vad!.reset();
    s.vad!.paused = false;
  };

  /** Speak every new, finished bot message in this thread, oldest first; return when the group is idle. */
  const speakAnswers = async (gen: number) => {
    const s = r.current;
    for (let idle = 0; !s.stopped && s.gen === gen && idle < 3; ) {
      const st = useApp.getState();
      const msgs = (st.messages[threadId] || []) as Message[];
      const next = msgs.find((m) => m.role === 'assistant' && m.author_type === 'agent' && m.status === 'done' && m.content?.trim() && !m.parts?.toolCalls?.length && m.created_at >= s.since && !s.spoken.has(m.id));
      if (next) {
        s.spoken.add(next.id);
        setState('speaking');
        setSpeaker(next.author_id);
        setLog((l) => [...l, { who: next.author_name, text: plainForSpeech(next.content).slice(0, 400) }]);
        await playMessage(next.id).catch((e) => setErr(e?.message || String(e)));
        if (s.gen !== gen) return;
        // Done speaking: nobody speaks now (the next answer, or listening again, follows).
        setSpeaker(null);
        setState('waiting');
        idle = 0;
        continue;
      }
      const busy = st.runs.some((x) => x.thread_id === threadId);
      if (busy) {
        setState('waiting');
        idle = 0;
      } else idle++;
      await new Promise((res) => setTimeout(res, 700));
    }
  };

  /** Put a sentence in the group chat and read the answers aloud. */
  const send = async (content: string, gen: number) => {
    const s = r.current;
    setLog((l) => [...l, { who: 'Jij', text: content }]);
    s.since = new Date(Date.now() - 2000).toISOString();
    await api.post(`/threads/${threadId}/messages`, { content, voice: true });
    s.turns++;
    if (s.gen !== gen) return;
    setState('waiting');
    await new Promise((res) => setTimeout(res, 1200));
    await speakAnswers(gen);
  };

  /** The answer to "Bedoel je …?": a bot's name (yes) or null (no: to the whole group, as said). */
  const resolveConfirm = (c: Confirm, name: string | null) => {
    setConfirm(null);
    return addressed(name, c.rest, c.original);
  };

  /**
   * One turn of yours: listening pauses while `work` runs (with the turn's number), an error shows in the call, and
   * afterwards listening starts again.
   */
  const turn = async (work: (gen: number) => Promise<unknown>) => {
    const s = r.current;
    s.busy = true;
    const gen = ++s.gen;
    if (s.vad) s.vad.paused = true;
    try {
      await work(gen);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      // A cut-in (you pressed while the group spoke) already started your next turn: leave it alone.
      if (s.gen === gen) {
        s.busy = false;
        if (!s.stopped) listen();
      }
    }
  };

  /** A tap on one of the confirm buttons (instead of saying "ja" or "nee"). */
  const choose = async (name: string | null) => {
    const s = r.current;
    const c = confirmRef.current;
    if (!c || s.busy) return;
    await turn(async (gen) => {
      s.rec?.cancel();
      s.rec = null;
      await send(resolveConfirm(c, name), gen);
    });
  };

  const onSpeechEnd = async () => {
    const s = r.current;
    if (s.busy || !s.rec || s.stopped) return;
    const rec = s.rec;
    await turn(async (gen) => {
      const { blob, durationMs } = await rec.stop();
      s.rec = null;
      if (durationMs < 500 || blob.size < 1500) return;
      setState('transcribing');
      const tr = await transcribeBlob(blob, { durationMs, threadId });
      const text = tr.text.trim();
      if (!text || s.stopped || s.gen !== gen) return;
      const pending = confirmRef.current;
      if (pending) {
        const ans = confirmAnswer(text, pending.candidates);
        if (ans) return await send(resolveConfirm(pending, ans.kind === 'yes' ? pending.candidates[0] : ans.kind === 'name' ? ans.name : null), gen);
        // Something else was said: forget the question and take this as a new sentence.
        setConfirm(null);
      }
      const { content, confirm: ask } = addressByName(text, names.current);
      if (ask) {
        setLog((l) => [...l, { who: 'Jij', text }]);
        return setConfirm(ask);
      }
      await send(content, gen);
    });
  };

  /**
   * Hold-to-talk: the key or button went down. While a bot speaks (or the group still works) this stops the voice
   * and starts your turn; their answers stay in the chat. Not while your words are being turned into text.
   */
  const press = () => {
    const s = r.current;
    setHint(null);
    if (s.stopped || s.muted || s.talk !== 'hold' || !s.stream || s.holding) return;
    if (s.tail) {
      clearTimeout(s.tail);
      s.tail = null;
      s.holding = true;
      return setHolding(true);
    }
    if (s.state === 'transcribing') return;
    s.barged = s.busy;
    if (s.busy) {
      // Cut in: the loop that reads answers aloud stops; the answers stay in the chat.
      s.gen++;
      s.busy = false;
      stopPlayback();
      setSpeaker(null);
    }
    s.holding = true;
    s.pressedAt = performance.now();
    s.rec?.cancel();
    s.rec = s.cap ? s.cap.record(PRESS_PRE_ROLL_MS) : new Recording(s.stream);
    setHolding(true);
    setState('user');
  };

  const release = () => {
    const s = r.current;
    if (!s.holding) return;
    s.holding = false;
    setHolding(false);
    if (s.state !== 'user') return;
    if (performance.now() - s.pressedAt < MIN_HOLD_MS) {
      s.rec?.cancel();
      s.rec = null;
      // (a tap while a bot spoke did stop it: a fine way to say "stop")
      if (!s.barged) setHint(t('Houd de knop of de spatiebalk ingedrukt zolang je praat.'));
      return listen();
    }
    s.tail = setTimeout(() => {
      s.tail = null;
      if (!s.holding && r.current.state === 'user') void onSpeechEnd();
    }, RELEASE_TAIL_MS);
  };
  useTalkKey(talk === 'hold' && !muted, press, release);

  const changeTalk = (m: TalkMode) => {
    const s = r.current;
    setTalkState(m);
    s.talk = m;
    s.holding = false;
    setHolding(false);
    setHint(null);
    if (s.tail) clearTimeout(s.tail);
    s.tail = null;
    if (!s.busy && s.state !== 'user') listen();
    saveVoice({ call: { talk: m } }).catch(() => {});
  };

  useEffect(() => {
    const s = r.current;
    s.stopped = false;
    (document.activeElement as HTMLElement | null)?.blur?.();
    (async () => {
      try {
        unlockAudio();
        const local = (await loadVoice()).settings.stt.engine === 'local';
        s.stream = await openMic();
        if (local) s.cap = await PcmCapture.open(s.stream);
        s.meter = s.cap || new LevelMeter(s.stream);
        s.vad = new EnergyVad(s.meter, { onStart: () => !s.busy && s.talk === 'handsfree' && setState('user'), onEnd: () => s.talk === 'handsfree' && void onSpeechEnd(), onLevel: setLevel, silenceMs: 1100 });
        s.vad.start();
        listen();
        // A record for the call history (Instellingen › Meer mogelijkheden › Spraakgesprekken: duration and turns), like a call with one bot.
        if (!s.stopped) s.callId = (await api.post<{ id: string }>('/voice/calls', { threadId, group: true }).catch(() => null))?.id || null;
        if (s.stopped && s.callId) void api.post(`/voice/calls/${s.callId}/end`, { turns: s.turns }).catch(() => {});
      } catch (e: any) {
        setErr(e?.message || String(e));
      }
    })();
    return () => {
      s.stopped = true;
      if (s.tail) clearTimeout(s.tail);
      if (s.callId) void api.post(`/voice/calls/${s.callId}/end`, { turns: s.turns }).catch(() => {});
      stopPlayback();
      s.rec?.cancel();
      s.vad?.stop();
      if (s.meter instanceof LevelMeter) s.meter.close();
      s.cap?.close();
      closeMic(s.stream);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!muted) listen();
    else {
      r.current.rec?.cancel();
      r.current.rec = null;
      r.current.holding = false;
      setHolding(false);
      if (r.current.vad) r.current.vad.paused = true;
      setState('muted');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [muted]);

  const ind = groupIndicator({ state, bots: bots.map((b) => ({ id: b.agentId, name: b.name })), speaking: speaker, working, keyboard: !touch, t });
  const sttReady = info?.status.stt.ready;
  return (
    <Modal open onClose={onClose} title={thread?.title ? t('Groepsgesprek · {0}', thread.title) : 'Groepsgesprek · groep'}>
      <div className="space-y-4 text-sm">
        {!sttReady && info && <p className="text-warn">{info.status.stt.missing || 'Spraak-naar-tekst is nog niet ingesteld (Instellingen › Meer mogelijkheden › Spraak).'}</p>}
        {micProblem() && <p className="text-danger">{micProblem()}</p>}
        <div className="flex flex-wrap justify-center gap-3" aria-label="Wie luistert, denkt na of spreekt">
          {bots.map((b) => {
            const st = ind.bots.find((x) => x.id === b.agentId)?.status || 'idle';
            return (
              <div key={b.agentId} className={cx('flex flex-col items-center gap-1 rounded-xl p-2', st === 'speaking' && 'bg-accent-soft')}>
                <TalkFace bot={{ id: b.agentId, name: b.name, avatar: b.avatar }} status={st} size={48} level={st === 'listening' ? level : 0} />
                <span className="text-xs font-medium">{b.name}</span>
              </div>
            );
          })}
        </div>
        <div className="flex items-center justify-center gap-2" role="status" aria-live="polite">
          <span className={cx('h-2.5 w-2.5 rounded-full', state === 'user' || state === 'listening' ? 'bg-danger' : 'bg-line')} style={{ transform: `scale(${1 + Math.min(1.5, level * 6)})` }} />
          <span className="font-medium">{ind.text}</span>
          {(state === 'listening' || state === 'user') && <Badge>microfoon aan</Badge>}
        </div>
        {talk === 'hold' && (
          <div className="flex flex-col items-center gap-1">
            <TalkButton holding={holding} disabled={muted || state === 'connecting' || !!micProblem()} onPress={press} onRelease={release} keyboard={!touch} />
            <span className="text-[11px] text-muted">{holding ? t('Laat los als je klaar bent') : touch ? t('Ingedrukt houden en praten') : t('Ingedrukt houden of de spatiebalk')}</span>
          </div>
        )}
        {hint && (
          <p className="text-center text-xs text-muted" role="status">
            {hint}
          </p>
        )}
        <p className="text-center text-xs text-muted">
          Begin met een naam om één bot aan te spreken ("{bots[0]?.name || 'Naam'}, …") of zeg "iedereen". Verstaat TeamBot een naam niet goed, dan vraagt hij eerst wie je bedoelt. Je praat met AI. Audio gaat naar {info?.status.stt.provider || 'je transcriptiedienst'}; antwoorden worden voorgelezen met de stem van elke bot.
        </p>
        {confirm && (
          <div role="group" aria-label="Wie bedoel je?" className="space-y-2 rounded-xl border border-warn/40 bg-warn-soft p-3 text-center">
            <p aria-live="assertive">
              Ik hoorde “{confirm.heard}”. Bedoel je {confirm.candidates.map((c, i) => (
                <span key={c}>
                  {i > 0 && (i === confirm.candidates.length - 1 ? ' of ' : ', ')}
                  <strong>{c}</strong>
                </span>
              ))}
              ?
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {confirm.candidates.map((c) => (
                <Button key={c} size="sm" variant="primary" onClick={() => void choose(c)}>
                  {confirm.candidates.length === 1 ? `Ja, ${c}` : c}
                </Button>
              ))}
              <Button size="sm" onClick={() => void choose(null)}>
                Nee, aan de hele groep
              </Button>
            </div>
            <p className="text-xs text-muted">Of zeg “ja” of “nee”.</p>
          </div>
        )}
        {err && <p className="text-xs text-danger">{err}</p>}
        <div className="scroll-thin max-h-56 space-y-1.5 overflow-y-auto rounded-lg bg-surface-2 p-3 text-xs">
          {log.length === 0 ? (
            <span className="text-muted">Ondertiteling verschijnt hier.</span>
          ) : (
            log.map((l, i) => (
              <div key={i}>
                <span className="font-semibold">{l.who}:</span> {l.text}
              </div>
            ))
          )}
        </div>
        <div className="flex justify-center gap-2">
          <Button icon={muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />} onClick={() => setMuted(!muted)}>
            {muted ? 'Microfoon aan' : 'Dempen'}
          </Button>
          {state === 'speaking' && <Button onClick={() => stopPlayback()}>Onderbreken</Button>}
          <Button variant="danger" icon={<PhoneOff className="h-4 w-4" />} onClick={onClose}>
            Ophangen
          </Button>
        </div>
        <div className="flex justify-center">
          <Toggle checked={talk === 'handsfree'} onChange={(x) => changeTalk(x ? 'handsfree' : 'hold')} label={<span className="text-xs">Handsfree (zonder knop: een pauze beëindigt je beurt)</span>} />
        </div>
      </div>
    </Modal>
  );
}

export function GroupCallButton({ threadId }: { threadId: string; agentId: string | null }) {
  const kind = useApp((s) => s.threads.find((t) => t.id === threadId)?.kind);
  const { info } = useVoice();
  const [open, setOpen] = useState(false);
  // The free speech recognition is not on this computer yet: first its download ("Downloaden en bellen"), then the call.
  const [setup, setSetup] = useState(false);
  if (kind !== 'room') return null;
  return (
    <>
      <Button variant="ghost" size="icon" aria-label="Groepsgesprek (spraak)" title="Groepsgesprek met spraak" onClick={() => (sttDownload(info) ? setSetup(true) : setOpen(true))}>
        <Mic className="h-4 w-4" />
      </Button>
      {setup && (
        <LocalSetupModal
          need={['stt']}
          onClose={() => setSetup(false)}
          onReady={() => {
            setSetup(false);
            setOpen(true);
          }}
        />
      )}
      {open && <GroupCallDialog threadId={threadId} onClose={() => setOpen(false)} />}
    </>
  );
}
