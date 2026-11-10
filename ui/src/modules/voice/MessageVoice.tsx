import { useEffect, useRef, useState } from 'react';
import { Captions, Loader2, Square, Trash2, Volume2 } from 'lucide-react';
import { api, authUrl } from '../../lib/api';
import { useApp } from '../../lib/store';
import type { Message } from '../../lib/types';
import { askConfirm, Badge, Button, cx, toast, toastError } from '../../components/ui';
import type { Clip } from './api';
import { playMessage, stopPlayback, usePlayer } from './player';
import { unlockAudio } from './capture';

let hintedLocal = false;

const clipCache = new Map<string, Promise<Clip | null>>();

function loadClip(id: string): Promise<Clip | null> {
  let p = clipCache.get(id);
  if (!p) {
    p = api
      .get<Clip[]>(`/voice/clips?ids=${encodeURIComponent(id)}`)
      .then((l) => l[0] || null)
      .catch(() => null);
    clipCache.set(id, p);
  }
  return p;
}

/** Under each message: read-aloud for bot replies; transcript with synced captions for voice memos. */
export function MessageVoice({ message: m }: { message: Message }) {
  const audioAtts = (m.parts.attachments || []).filter((a) => a.mime.startsWith('audio/'));
  const canSpeak = m.role === 'assistant' && m.status === 'done' && !!m.content?.trim() && !m.parts.toolCalls?.length;
  if (!canSpeak && !audioAtts.length) return null;
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      {canSpeak && <SpeakButton message={m} />}
      {audioAtts.map((a) => (
        <MemoCaptions key={a.id} attachmentId={a.id} />
      ))}
    </div>
  );
}

function SpeakButton({ message: m }: { message: Message }) {
  const agent = useApp((s) => (m.author_id ? s.agents.find((a) => a.id === m.author_id) : undefined));
  const playing = usePlayer((s) => (s.messageId === m.id ? s.phase : 'idle'));
  if (agent?.settings?.voice?.engine === 'off') return null;
  const toggle = async () => {
    unlockAudio();
    if (playing !== 'idle') return stopPlayback();
    try {
      const r = await playMessage(m.id);
      if (r.engine === 'off') toast('Voorlezen staat uit voor deze bot (bot-instellingen › Spraak).');
      if (r.localMissing && !hintedLocal) {
        hintedLocal = true;
        toast(`Voorgelezen met de browserstem. ${r.localMissing}. Gratis lokale stemmen staan bij Instellingen › Spraak.`);
      }
      if (r.truncated) toast('Alleen het begin is voorgelezen; de rest staat in het gesprek.');
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <div>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs text-muted"
        aria-label={playing === 'idle' ? 'Voorlezen' : 'Voorlezen stoppen'}
        title={playing === 'idle' ? 'Voorlezen (AI-stem)' : 'Stoppen'}
        onClick={toggle}
        icon={playing === 'loading' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : playing === 'playing' ? <Square className="h-3.5 w-3.5 fill-current" /> : <Volume2 className="h-3.5 w-3.5" />}
      >
        {playing === 'playing' ? 'Stoppen' : playing === 'loading' ? 'Laden…' : null}
      </Button>
    </div>
  );
}

function MemoCaptions({ attachmentId }: { attachmentId: string }) {
  const me = useApp((s) => s.me);
  const [clip, setClip] = useState<Clip | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [t, setT] = useState(-1);
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    let alive = true;
    loadClip(attachmentId).then((c) => alive && setClip(c));
    return () => {
      alive = false;
    };
  }, [attachmentId]);
  if (!clip) return null;
  const current = clip.segments.findIndex((s) => t >= s.start && t < s.end);
  const del = async () => {
    if (!(await askConfirm('Audio van deze spraakmemo verwijderen? Het transcript blijft in het gesprek staan.', { ok: 'Verwijderen', danger: true }))) return;
    try {
      await api.del(`/voice/clips/${attachmentId}`);
      clipCache.delete(attachmentId);
      setClip({ ...clip, audio_deleted: true });
      toast('Audio verwijderd', 'ok');
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <div className="max-w-xl">
      <div className="flex flex-wrap items-center gap-1">
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted" aria-expanded={open} onClick={() => setOpen(!open)} icon={<Captions className="h-3.5 w-3.5" />}>
          {open ? 'Ondertiteling verbergen' : 'Meelezen'}
        </Button>
        {clip.audio_deleted && <Badge>audio verwijderd</Badge>}
        {me?.id === clip.user_id && !clip.audio_deleted && (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted" aria-label="Audio verwijderen" title="Audio verwijderen (transcript blijft)" onClick={del} icon={<Trash2 className="h-3.5 w-3.5" />} />
        )}
      </div>
      {open && (
        <div className="mt-1 space-y-2 rounded-lg border border-line bg-surface-2 p-2.5">
          {!clip.audio_deleted && (
            <audio ref={audio} controls preload="metadata" src={authUrl(`/voice/clips/${attachmentId}/audio`)} className="h-9 w-full" onTimeUpdate={(e) => setT(e.currentTarget.currentTime)} aria-label="Spraakmemo met ondertiteling" />
          )}
          <div className="space-y-0.5 text-sm" aria-live="off">
            {clip.segments.length ? (
              clip.segments.map((s, i) => (
                <button
                  key={i}
                  type="button"
                  className={cx('block w-full rounded px-1.5 py-0.5 text-start', i === current ? 'bg-accent-soft text-fg' : 'text-muted hover:text-fg')}
                  onClick={() => {
                    if (audio.current) {
                      audio.current.currentTime = s.start;
                      audio.current.play().catch(() => {});
                    }
                  }}
                >
                  {s.text}
                </button>
              ))
            ) : (
              <div className="text-muted">{clip.transcript || '(geen tekst herkend)'}</div>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted">
            <span>
              Transcript door {clip.provider_name || 'spraakprovider'} ({clip.model}){clip.timing === 'estimated' ? ' · tijden geschat' : ''}
            </span>
            <a className="underline" href={authUrl(`/voice/clips/${attachmentId}/vtt`)} download="ondertiteling.vtt">
              Ondertiteling (.vtt)
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
