import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Download, Mic, MicOff, PhoneOff } from 'lucide-react';
import { api, on } from '../../lib/api';
import { t } from '../../lib/i18n';
import { clock } from './api';
import { formatSeconds } from '../../lib/format';
import { agentById } from '../../lib/store';
import { Button, Modal, toastError } from '../../components/ui';
import { BotAvatar } from '../../components/BotFace';
import { DuplexCall, type DuplexLatency, type DuplexPhase, type DuplexStatus } from './duplex';

/** Download of the two small call parts (voice activity + turn detection), only after this tap; sizes are shown. */
export function DuplexPartsButton({ status, onChange }: { status: DuplexStatus; onChange(s: DuplexStatus): void }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => on('voice.duplex.progress', () => void api.get<DuplexStatus>('/voice/duplex').then(onChange).catch(() => {})), [onChange]);
  const missing = status.parts.filter((p) => p.status !== 'installed');
  if (!missing.length || !status.canManage) return null;
  const downloading = missing.some((p) => p.status === 'downloading' || p.status === 'verifying');
  const got = missing.reduce((n, p) => n + (p.received || 0), 0);
  return (
    <div className="space-y-1">
      <Button
        size="sm"
        variant="secondary"
        icon={<Download className="h-4 w-4" />}
        disabled={busy || downloading}
        onClick={async () => {
          setBusy(true);
          try {
            onChange(await api.post<DuplexStatus>('/voice/duplex/install'));
          } catch (e) {
            toastError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        {downloading ? t('Downloaden… {0}%', Math.round((100 * got) / Math.max(1, status.download))) : t('Gesprekshulp downloaden ({0})', status.downloadText)}
      </Button>
      <div className="text-xs text-muted">{missing.map((p) => `${p.label} · ${p.licence}`).join(' · ')}</div>
    </div>
  );
}

interface Line {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  cut?: boolean;
  /** "Wacht even…": the rest of the sentence follows. */
  partial?: boolean;
}

/** The free live call in progress: talk and listen at the same time, interrupt by talking. */
export function DuplexCallView({ threadId, agentId, onEnded }: { threadId: string; agentId: string; onEnded(s: { reason?: string; error?: string }): void }) {
  const agent = agentById(agentId);
  const name = agent?.name || 'Bot';
  const [phase, setPhase] = useState<DuplexPhase>('connecting');
  const [lines, setLines] = useState<Line[]>([]);
  const [latency, setLatency] = useState<DuplexLatency | null>(null);
  const [muted, setMuted] = useState(false);
  const [echoOff, setEchoOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const call = useRef<DuplexCall | null>(null);
  const seq = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const done = useRef(false);

  useEffect(() => {
    let disposed = false;
    const end = (s: { reason?: string; error?: string }) => {
      if (done.current || disposed) return;
      done.current = true;
      onEnded(s);
    };
    const c = new DuplexCall({
      phase: setPhase,
      user: (text, final) =>
        setLines((l) => {
          const last = l[l.length - 1];
          const line = { id: last?.partial ? last.id : ++seq.current, role: 'user' as const, text, partial: !final };
          return [...(last?.partial ? l.slice(0, -1) : l), line].slice(-30);
        }),
      bot: (text) =>
        setLines((l) => {
          const last = l[l.length - 1];
          // Sentences of one answer form one line.
          if (last?.role === 'assistant' && !last.cut) return [...l.slice(0, -1), { ...last, text: `${last.text} ${text}` }];
          return [...l, { id: ++seq.current, role: 'assistant' as const, text }].slice(-30);
        }),
      interrupted: (heard) =>
        setLines((l) => {
          const i = l.map((x) => x.role).lastIndexOf('assistant');
          if (i < 0) return l;
          return l.map((x, k) => (k === i ? { ...x, text: heard || '…', cut: true } : x));
        }),
      latency: setLatency,
      error: setError,
      ended: (reason) => end({ reason }),
      echo: (a) => setEchoOff(a === false),
    });
    call.current = c;
    // Started a tick later: React's development double mount (mount, unmount, mount) then never opens a call it
    // hangs up at once.
    const starter = window.setTimeout(() => void c.start({ agentId, threadId }).catch((e) => end({ error: String(e?.message || e) })), 0);
    const t0 = Date.now();
    const tick = window.setInterval(() => setElapsed((Date.now() - t0) / 1000), 1000);
    // A phone that goes to the background mutes the microphone: hang up instead of half listening.
    const onVis = () => document.visibilityState === 'hidden' && navigator.maxTouchPoints > 0 && c.hangup();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      disposed = true;
      window.clearTimeout(starter);
      window.clearInterval(tick);
      document.removeEventListener('visibilitychange', onVis);
      c.hangup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [lines]);

  const label =
    phase === 'connecting' ? 'Verbinden…' : phase === 'listening' ? 'Ik luister' : phase === 'thinking' ? t('{0} denkt na…', name) : phase === 'speaking' ? t('{0} praat. Praat gerust door hem heen.', name) : 'Opgehangen';

  return (
    <Modal
      open
      onClose={() => call.current?.hangup()}
      title={t('Live gesprek met {0}', name)}
      footer={
        <>
          <Button
            variant="secondary"
            icon={muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            aria-pressed={muted}
            onClick={() => {
              call.current?.setMuted(!muted);
              setMuted(!muted);
            }}
          >
            {muted ? 'Microfoon aan' : 'Microfoon uit'}
          </Button>
          <Button variant="danger" icon={<PhoneOff className="h-4 w-4" />} onClick={() => call.current?.hangup()}>
            Ophangen
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="flex items-center gap-3">
          <BotAvatar bot={agent || { name: '?' }} size={48} />
          <div className="min-w-0">
            <div className="font-medium" role="status" aria-live="polite">
              {label}
            </div>
            <div className="text-xs text-muted">
              {clock(elapsed)} · gratis, op je eigen pc
              {latency ? ` · ${t('eerste klank na {0}', formatSeconds(latency.totalMs))}` : ''}
            </div>
          </div>
        </div>
        {echoOff && (
          <div className="flex gap-2 rounded-lg bg-warn-soft p-2 text-xs text-warn">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Je browser zet de echo-onderdrukking niet aan. Gebruik een koptelefoon, anders hoort de bot zichzelf.</span>
          </div>
        )}
        {error && <div className="rounded-lg bg-danger-soft p-2 text-xs text-danger">{error}</div>}
        <div ref={box} className="max-h-64 space-y-2 overflow-y-auto" aria-label="Wat er gezegd is">
          {!lines.length && <div className="text-muted">Praat gewoon. Je kunt {name} onderbreken door te praten; zeg “dat was het” om op te hangen.</div>}
          {lines.map((l) => (
            <div key={l.id} className={l.role === 'user' ? 'text-end' : ''}>
              <span className={l.role === 'user' ? 'inline-block rounded-xl bg-accent-soft px-3 py-1.5' : 'inline-block rounded-xl bg-surface-2 px-3 py-1.5'}>
                {l.text}
                {l.cut && <span className="ms-1 text-xs text-muted">(onderbroken)</span>}
              </span>
            </div>
          ))}
        </div>
        {latency && (
          <div className="text-xs text-muted">
            {t('Herkenning {0} ms · beurt {1} ms · bot {2} ms · stem {3} ms', latency.sttMs, latency.turnMs, latency.brainMs, latency.ttsMs)}
          </div>
        )}
      </div>
    </Modal>
  );
}
