import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Check, Loader2, Mic, Send, Trash2, X, AudioLines } from 'lucide-react';
import { api } from '../../lib/api';
import { Button, Field, Modal, Textarea, cx, toast, toastError } from '../../components/ui';
import { clock, transcribeBlob, useVoice } from './api';
import { LevelMeter, Recording, browserSttSupported, closeMic, micProblem, openMic, recognizeOnce } from './audio';
import { PcmCapture, unlockAudio, wavBlob } from './capture';
import { LiveDictation } from './localstt';
import { LocalSetupModal, isLocalMissing } from './LocalModels';
import { stopPlayback } from './player';

type Phase = 'idle' | 'starting' | 'recording' | 'working';
const MAX_MS = 5 * 60_000;
const HOLD_MS = 350;

interface Props {
  threadId: string;
  agentId: string | null;
  insertText(text: string): void;
  send(text: string, opts?: { voice?: boolean; attachments?: string[] }): Promise<void>;
}

/** Last measured delay between "stop" and the text (local engine), shown in Settings › Spraak. */
export let lastDictation: { seconds: number; clientMs: number; finalMs: number } | null = null;

const onThisComputer = () => ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);

/**
 * Push-to-talk / dictation in the composer. Hold to talk (release = done, slide left = cancel), tap to start and
 * use the controls, or hold Ctrl+Space on a keyboard. The transcript lands in the text box so it can be edited
 * before sending. With the free local engine the text appears live while you talk. "Memo" sends the audio itself
 * as a voice memo with transcript.
 */
export function DictateButton({ threadId, insertText, send }: Props) {
  const { info } = useVoice();
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [holding, setHolding] = useState(false);
  const [partial, setPartial] = useState('');
  const [setup, setSetup] = useState(false);
  const [memo, setMemo] = useState<{ url: string; text: string; attachmentId: string; provider: string } | null>(null);
  const r = useRef<{
    stream?: MediaStream;
    rec?: Recording;
    meter?: LevelMeter | PcmCapture;
    cap?: PcmCapture;
    live?: LiveDictation;
    sr?: ReturnType<typeof recognizeOnce>;
    timer?: number;
    downAt: number;
    startX: number;
    tapMode: boolean;
    byKey?: boolean;
    finishWhenReady?: boolean;
  }>({ downAt: 0, startX: 0, tapMode: false });

  const engine = info?.settings.stt.engine;
  const browserMode = engine === 'browser';
  const localMode = engine === 'local';
  const ready = !!info && (browserMode ? browserSttSupported() : info.status.stt.ready);

  const release = () => {
    const s = r.current;
    if (s.timer) clearInterval(s.timer);
    if (s.meter instanceof LevelMeter) s.meter.close();
    s.cap?.close();
    closeMic(s.stream);
    r.current = { downAt: 0, startX: 0, tapMode: false };
    setLevel(0);
    setElapsed(0);
    setPartial('');
    setHolding(false);
  };

  useEffect(
    () => () => {
      r.current.sr?.abort();
      r.current.rec?.cancel();
      r.current.live?.cancel();
      release();
    },
    [],
  );

  // The microphone never stays on in the background.
  useEffect(() => {
    if (phase !== 'recording' && phase !== 'starting') return;
    const f = () => {
      if (document.visibilityState !== 'hidden') return;
      cancel();
      toast('Opname gestopt: de app ging naar de achtergrond.');
    };
    document.addEventListener('visibilitychange', f);
    return () => document.removeEventListener('visibilitychange', f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const explainMissing = () => {
    const p = micProblem();
    if (p) return toast(p, 'danger');
    if (browserMode) return toast('Deze browser heeft geen eigen spraakherkenning. Kies lokale spraakherkenning bij Instellingen › Meer mogelijkheden › Spraak.', 'danger');
    if (localMode && info?.local.canManage) return setSetup(true);
    toast(info?.status.stt.missing ? `Spraakherkenning: ${info.status.stt.missing}` : 'Spraakherkenning is nog niet ingesteld (Instellingen › Meer mogelijkheden › Spraak).', 'danger');
  };

  const start = async () => {
    if (phase !== 'idle') return;
    unlockAudio();
    if (!ready || micProblem()) return explainMissing();
    stopPlayback();
    setPhase('starting');
    try {
      const s = r.current;
      const t0 = Date.now();
      if (browserMode) {
        s.sr = recognizeOnce(info!.settings.stt.language, setPartial);
        s.sr.result.catch((e) => {
          toastError(e);
          release();
          setPhase('idle');
        });
      } else {
        const stream = await openMic();
        if (r.current !== s) {
          // cancelled while the permission prompt was open
          closeMic(stream);
          return;
        }
        s.stream = stream;
        if (localMode) {
          s.cap = await PcmCapture.open(stream);
          s.meter = s.cap;
          s.live = new LiveDictation(s.cap, {
            threadId,
            onText: setPartial,
            onError: (e) => {
              if (isLocalMissing(e) && info?.local.canManage) setSetup(true);
              else toastError(e);
              cancel();
            },
          });
        } else {
          s.rec = new Recording(s.stream);
          s.meter = new LevelMeter(s.stream);
        }
      }
      s.timer = window.setInterval(() => {
        const ms = Date.now() - t0;
        setElapsed(ms);
        if (s.meter) setLevel(s.meter.level());
        if (ms > MAX_MS) finish('text');
      }, 100);
      setPhase('recording');
      if (s.finishWhenReady) finish('text');
    } catch (e) {
      toastError(e);
      release();
      setPhase('idle');
    }
  };

  const cancel = () => {
    const s = r.current;
    s.sr?.abort();
    s.rec?.cancel();
    s.live?.cancel();
    release();
    setPhase('idle');
  };

  const finish = async (kind: 'text' | 'memo') => {
    const s = r.current;
    if (!s.rec && !s.sr && !s.live) return;
    setPhase('working');
    try {
      if (s.sr) {
        s.sr.stop();
        const text = await s.sr.result;
        release();
        if (text) insertText(text);
        else toast('Er is niets verstaan. Probeer het nog eens.');
        return;
      }
      if (s.live) {
        const live = s.live;
        const seconds = live.pcm().length / 16000;
        if (seconds < 0.4) {
          live.cancel();
          release();
          return toast('Opname te kort. Houd de knop ingedrukt terwijl je praat, of tik één keer om te starten.');
        }
        if (kind === 'memo') {
          const pcm = live.pcm();
          live.cancel();
          release();
          const blob = wavBlob(pcm);
          const res = await transcribeBlob(blob, { threadId, durationMs: seconds * 1000, save: true });
          if (res.attachment) setMemo({ url: URL.createObjectURL(blob), text: res.text, attachmentId: res.attachment.id, provider: res.provider });
          return;
        }
        // Keep the level meter/indicator until the last audio is sent, then close the microphone.
        const res = await live.stop();
        release();
        lastDictation = { seconds: res.seconds, clientMs: res.clientMs, finalMs: res.finalMs };
        if (res.text) insertText(res.text);
        else toast('Er is niets verstaan. Probeer het nog eens.');
        return;
      }
      const { blob, durationMs } = await s.rec!.stop();
      release();
      if (durationMs < 400 || blob.size < 1000) return toast('Opname te kort. Houd de knop ingedrukt terwijl je praat, of tik één keer om te starten.');
      const res = await transcribeBlob(blob, { threadId, durationMs, save: kind === 'memo' });
      if (kind === 'memo' && res.attachment) setMemo({ url: URL.createObjectURL(blob), text: res.text, attachmentId: res.attachment.id, provider: res.provider });
      else if (res.text) insertText(res.text);
      else toast('Er is niets verstaan. Probeer het nog eens.');
    } catch (e) {
      if (isLocalMissing(e) && info?.local.canManage) setSetup(true);
      else toastError(e);
      release();
    } finally {
      setPhase('idle');
    }
  };

  const discardMemo = async () => {
    if (!memo) return;
    URL.revokeObjectURL(memo.url);
    const id = memo.attachmentId;
    setMemo(null);
    try {
      await api.del(`/voice/clips/${id}`);
    } catch {
      /* already gone */
    }
  };

  const sendMemo = async () => {
    if (!memo) return;
    try {
      await send(memo.text.trim() || '(spraakmemo)', { voice: true, attachments: [memo.attachmentId] });
      URL.revokeObjectURL(memo.url);
      setMemo(null);
    } catch (e) {
      toastError(e);
    }
  };

  // Keyboard push-to-talk: hold Ctrl+Space, release to insert the text.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (!(e.ctrlKey && e.code === 'Space') || e.repeat || e.altKey || e.metaKey) return;
      e.preventDefault();
      if (phaseRef.current === 'idle') {
        r.current.byKey = true;
        r.current.downAt = Date.now();
        setHolding(true);
        start();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (!r.current.byKey || (e.code !== 'Space' && e.key !== 'Control')) return;
      r.current.byKey = false;
      setHolding(false);
      if (phaseRef.current === 'starting') r.current.finishWhenReady = true;
      else if (phaseRef.current === 'recording') finish('text');
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info]);

  // Pointer: hold-to-talk with slide-to-cancel; a short tap switches to tap mode.
  const onDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    unlockAudio();
    if (phase === 'recording') {
      if (r.current.tapMode) finish('text');
      return;
    }
    if (phase !== 'idle') return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    r.current.downAt = Date.now();
    r.current.startX = e.clientX;
    setHolding(true);
    start();
  };
  const onUp = () => {
    if (!holding || r.current.byKey) return;
    setHolding(false);
    const long = Date.now() - r.current.downAt >= HOLD_MS;
    if (long && phase === 'starting') r.current.finishWhenReady = true;
    else if (long) finish('text');
    else r.current.tapMode = true;
  };
  const onMove = (e: PointerEvent) => {
    if (holding && !r.current.byKey && r.current.startX - e.clientX > 80) cancel();
  };

  const recording = phase === 'recording' || phase === 'starting';
  const label = recording ? 'Opname stoppen en tekst invoegen' : phase === 'working' ? 'Bezig met omzetten' : 'Dicteren (ingedrukt houden, tikken of Ctrl+Spatie)';
  const where = browserMode
    ? 'Herkenning door je browser'
    : localMode
      ? onThisComputer()
        ? 'Gratis herkenning op deze computer; je audio gaat niet naar internet en wordt niet bewaard.'
        : 'Je audio wordt op je eigen pc omgezet; niets gaat naar internet.'
      : `Audio gaat naar ${info?.status.stt.provider || 'je spraakprovider'} om om te zetten naar tekst; dicteeraudio wordt niet bewaard.`;

  return (
    <>
      <Button
        variant={recording ? 'danger' : 'ghost'}
        size="icon"
        aria-label={label}
        aria-pressed={recording}
        title={ready ? label : localMode ? 'Dicteren — lokaal spraakmodel nog downloaden' : 'Dicteren — nog niet ingesteld'}
        style={{ touchAction: 'none', userSelect: 'none' }}
        onPointerDown={onDown}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerMove={onMove}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          if (e.ctrlKey) return;
          e.preventDefault();
          unlockAudio();
          if (phase === 'idle') {
            r.current.tapMode = true;
            start();
          } else if (phase === 'recording') finish('text');
        }}
        className={cx(!ready && 'opacity-60')}
      >
        {phase === 'working' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mic className="h-4 w-4" />}
      </Button>

      {(recording || phase === 'working') && (
        <div role="status" aria-live="polite" className="fixed bottom-24 left-1/2 z-40 w-[min(92vw,420px)] -translate-x-1/2 rounded-2xl border border-line bg-surface p-3 shadow-xl">
          <div className="flex items-center gap-2">
            <span className={cx('h-2.5 w-2.5 shrink-0 rounded-full', phase === 'working' ? 'bg-muted' : 'animate-pulse bg-danger')} aria-hidden />
            <span className="text-sm font-medium">{phase === 'working' ? 'Omzetten naar tekst…' : 'Microfoon aan'}</span>
            <span className="font-mono text-xs text-muted">{clock(elapsed / 1000)}</span>
            <div className="ms-1 h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2" aria-hidden>
              <div className="h-full rounded-full bg-accent transition-[width] duration-100" style={{ width: `${Math.min(100, level * 600)}%` }} />
            </div>
          </div>
          {partial && <div className="mt-2 line-clamp-4 text-sm text-muted">{partial}</div>}
          {phase !== 'working' && (
            <>
              {holding ? (
                <div className="mt-2 text-xs text-muted">{r.current.byKey ? 'Loslaten = klaar' : 'Loslaten = klaar · naar links schuiven = annuleren'}</div>
              ) : (
                <div className="mt-2 flex flex-wrap justify-end gap-2">
                  <Button size="sm" variant="ghost" icon={<X className="h-4 w-4" />} onClick={cancel}>
                    Annuleren
                  </Button>
                  {!browserMode && (
                    <Button size="sm" variant="secondary" icon={<AudioLines className="h-4 w-4" />} onClick={() => finish('memo')} title="Verstuur de opname zelf, met transcript">
                      Als memo
                    </Button>
                  )}
                  <Button size="sm" variant="primary" icon={<Check className="h-4 w-4" />} onClick={() => finish('text')}>
                    Klaar
                  </Button>
                </div>
              )}
              <div className="mt-1.5 text-[11px] text-muted">{where}</div>
            </>
          )}
        </div>
      )}

      {setup && <LocalSetupModal need={['stt']} onClose={() => setSetup(false)} />}

      <Modal
        open={!!memo}
        onClose={discardMemo}
        title="Spraakmemo versturen"
        footer={
          <>
            <Button variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={discardMemo}>
              Weggooien
            </Button>
            <Button variant="primary" icon={<Send className="h-4 w-4" />} onClick={sendMemo}>
              Versturen
            </Button>
          </>
        }
      >
        {memo && (
          <div className="space-y-3">
            <audio controls src={memo.url} className="w-full" aria-label="Opname terugluisteren" />
            <Field label="Transcript" hint={`Omgezet door ${memo.provider}. Pas het aan als er iets verkeerd verstaan is; de bot leest het transcript.`}>
              <Textarea rows={5} value={memo.text} onChange={(e) => setMemo({ ...memo, text: e.target.value })} />
            </Field>
            <div className="text-xs text-muted">Audio en transcript worden in dit gesprek bewaard (Instellingen › Meer mogelijkheden › Spraak).</div>
          </div>
        )}
      </Modal>
    </>
  );
}
