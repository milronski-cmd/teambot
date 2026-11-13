import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowUp, CornerUpLeft, FileText, Loader2, Paperclip, Plus, Settings2, Square, X } from 'lucide-react';
import { upload } from '../lib/api';
import { navigate } from '../lib/router';
import type { AttachmentRef, Message } from '../lib/types';
import { uiModules } from '../modules';
import { Button, cx, toast, toastError } from '../components/ui';
import { t } from '../lib/i18n';
import { attachmentNotice } from './attachmentNotice';
import { type ComposerCommand, useSlashMenu } from './SlashMenu';
import { asQuote } from './PagePanel';

const DRAFT_KEY = (t: string) => `tb_draft_${t}`;
/** Files per pick, and the size the server takes per file (express.raw limit of POST /attachments, server/api/threads.ts). */
const MAX_FILES = 10;
const MAX_BYTES = 200 * 1024 * 1024;

export interface ComposerProps {
  threadId: string;
  agentId: string | null;
  busy: boolean;
  disabled?: string | null;
  replyTo: Message | null;
  onCancelReply(): void;
  onSend(text: string, opts: { attachments: string[]; voice?: boolean; replyTo?: string | null }): Promise<void>;
  onStop(): void;
  placeholder?: string;
  /** What sending does while the bot works (its busy policy), for the send button's tooltip. */
  busyHint?: string;
  /** Extra commands in the "/" menu (from the chat: new conversation, find, stop). */
  commands?: ComposerCommand[];
  /** Something quiet inside the bar, before the microphone and the send button (the chat's context ring and model). */
  accessory?: React.ReactNode;
}

/**
 * A button in the chat bar that must not take the focus from the message field: on a phone that closes the keyboard,
 * and after sending it came back a moment later (owner, 0.4.4). Mouse: keep the focus; touch: act on the finger
 * lifting inside the button and skip the browser's own focus change and click.
 */
function keepsFocus(run: () => void) {
  return {
    onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
    onTouchEnd: (e: React.TouchEvent<HTMLButtonElement>) => {
      const p = e.changedTouches[0];
      const r = e.currentTarget.getBoundingClientRect();
      if (e.currentTarget.disabled || !p || p.clientX < r.left || p.clientX > r.right || p.clientY < r.top || p.clientY > r.bottom) return;
      e.preventDefault();
      run();
    },
    onClick: () => run(),
  };
}

/** Message composer: Enter sends, Shift+Enter new line, paste/drop files, module actions (e.g. push-to-talk). */
export function Composer({ threadId, agentId, busy, disabled, replyTo, onCancelReply, onSend, onStop, placeholder, busyHint, commands = [], accessory }: ComposerProps) {
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(DRAFT_KEY(threadId)) || '';
    } catch {
      return '';
    }
  });
  const [files, setFiles] = useState<(AttachmentRef & { uploading?: boolean })[]>([]);
  const [sending, setSending] = useState(false);
  const [drag, setDrag] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const actions = uiModules.flatMap((m) => m.composerActions || []);

  useEffect(() => {
    try {
      if (text) localStorage.setItem(DRAFT_KEY(threadId), text);
      else localStorage.removeItem(DRAFT_KEY(threadId));
    } catch {
      /* ignore */
    }
  }, [text, threadId]);

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(240, el.scrollHeight) + 'px';
  }, [text]);

  useEffect(() => {
    if (replyTo) ta.current?.focus();
  }, [replyTo]);

  // "Citeren" in a page the bot made (PagePanel): the selected text lands here as a quote, for the user to add to.
  useEffect(() => {
    const f = (e: Event) => {
      const d = (e as CustomEvent<{ threadId: string; text: string }>).detail;
      if (!d || d.threadId !== threadId || !d.text?.trim()) return;
      setText((x) => (x.trim() ? x.replace(/\s*$/, '\n\n') : '') + asQuote(d.text));
      requestAnimationFrame(() => {
        const el = ta.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
    };
    window.addEventListener('tb:quote', f);
    return () => window.removeEventListener('tb:quote', f);
  }, [threadId]);

  const addFiles = async (list: FileList | File[]) => {
    // Never a silent drop: what does not fit (more than 10 at once, or bigger than the server takes) is said.
    const all = Array.from(list);
    if (all.length > MAX_FILES) toast(t('{0, plural, one {# bestand is niet toegevoegd} other {# bestanden zijn niet toegevoegd}}: je kunt 10 bestanden tegelijk toevoegen.', all.length - MAX_FILES), 'danger');
    const fits = all.slice(0, MAX_FILES).filter((f) => {
      if (f.size <= MAX_BYTES) return true;
      toast(`${f.name || 'Dit bestand'} is groter dan 200 MB en is niet toegevoegd.`, 'danger');
      return false;
    });
    for (const f of fits) {
      const tmp = { id: 'tmp_' + Math.random(), name: f.name || 'plakbestand', mime: f.type, size: f.size, uploading: true };
      setFiles((x) => [...x, tmp]);
      try {
        const a = await upload(f, f.name || `plakbestand-${Date.now()}.${(f.type.split('/')[1] || 'bin').replace(/[^\w]/g, '')}`, threadId);
        setFiles((x) => x.map((y) => (y.id === tmp.id ? a : y)));
      } catch (e) {
        toastError(e);
        setFiles((x) => x.filter((y) => y.id !== tmp.id));
      }
    }
  };

  const send = async (override?: string, opts: { voice?: boolean; attachments?: string[] } = {}) => {
    const content = (override ?? text).trim();
    const atts = opts.attachments ?? files.filter((f) => !f.uploading).map((f) => f.id);
    if ((!content && !atts.length) || sending || disabled) return;
    // Phone: the keyboard stays as it was. Up when the user was typing, and not popping up after a spoken message.
    const hadFocus = document.activeElement === ta.current;
    const touch = window.matchMedia('(pointer: coarse)').matches;
    setSending(true);
    try {
      await onSend(content, { attachments: atts, voice: opts.voice, replyTo: replyTo?.id || null });
      if (override === undefined) setText('');
      setFiles([]);
      onCancelReply();
    } catch (e) {
      toastError(e);
    } finally {
      setSending(false);
      if (hadFocus || !touch) ta.current?.focus();
    }
  };

  const uploading = files.some((f) => f.uploading);
  // Files TeamBot cannot show or hand to the bot as content: say so before sending, grouped per kind.
  const notices = new Map<string, { text: string; names: string[] }>();
  for (const f of files) {
    const n = f.uploading ? null : attachmentNotice(f);
    if (!n) continue;
    const cur = notices.get(n.kind) || { text: n.text, names: [] };
    cur.names.push(f.name);
    notices.set(n.kind, cur);
  }

  // "/" and "$": pick a skill (stays in the message) or run a command.
  const allCommands = useMemo<ComposerCommand[]>(
    () => [
      ...commands,
      { id: 'bestand', label: 'Bestand toevoegen', description: 'Een bestand of foto meesturen', keywords: ['bijlage', 'upload', 'foto'], icon: <Paperclip className="h-4 w-4" />, run: () => fileInput.current?.click() },
      { id: 'skills', label: 'Skills beheren', description: agentId ? 'Skills voor deze bot aanzetten of uit de marktplaats halen' : 'Skills in de marktplaats', keywords: ['skill', 'marktplaats'], icon: <Settings2 className="h-4 w-4" />, run: () => navigate(agentId ? `/agents/${agentId}` : '/m/skills') },
    ],
    [commands, agentId],
  );
  const slash = useSlashMenu({ threadId, text, setText, textarea: ta, commands: allCommands, disabled: !!disabled });

  return (
    <div
      className={cx('px-3 pb-[max(0.75rem,var(--safe-bottom))] pt-1 desk:px-6 desk:pb-4', drag && 'ring-2 ring-inset ring-fg/40')}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDrag(true);
        }
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
      }}
    >
      {replyTo && (
        <div className="mb-2 flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-xs">
          <CornerUpLeft className="h-3.5 w-3.5 shrink-0 text-muted" />
          <span className="min-w-0 flex-1 truncate">
            Antwoord op <span className="font-semibold">{replyTo.author_name}</span>: {replyTo.content.slice(0, 100)}
          </span>
          <button onClick={onCancelReply} aria-label="Antwoord annuleren" className="rounded-md p-0.5 text-muted hover:text-fg">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {disabled && <div className="mb-2 rounded-xl bg-warn-soft px-3 py-2 text-xs font-medium text-warn">{disabled}</div>}
      <div className="relative rounded-bubble border border-line bg-surface px-2 py-1.5 transition-colors focus-within:border-muted">
        {slash.menu}
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2 px-1.5 pb-1 pt-1.5">
            {files.map((f) => (
              <div key={f.id} className="flex items-center gap-1.5 rounded-lg bg-surface-3 px-2 py-1 text-xs">
                {f.uploading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : attachmentNotice(f) ? (
                  <AlertTriangle className="h-3.5 w-3.5 text-warn" aria-label="Geen voorbeeld" />
                ) : (
                  <FileText className="h-3.5 w-3.5 text-muted" />
                )}
                <span className="max-w-[160px] truncate">{f.name}</span>
                <button aria-label={t('{0} verwijderen', f.name)} onClick={() => setFiles((x) => x.filter((y) => y.id !== f.id))} className="text-muted hover:text-fg">
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        {notices.size > 0 && (
          <div className="space-y-1 px-1.5 pb-1" role="status">
            {[...notices.entries()].map(([kind, n]) => (
              <p key={kind} className="flex items-start gap-1.5 rounded-lg bg-warn-soft px-2 py-1.5 text-[12px] leading-snug text-warn">
                <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>
                  <span className="font-semibold">{n.names.join(', ')}</span>: {n.text}
                </span>
              </p>
            ))}
          </div>
        )}
        <div className="flex items-end gap-1">
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => e.target.files && (addFiles(e.target.files), (e.target.value = ''))} />
          <Button variant="ghost" size="icon" className="rounded-full" aria-label="Bestand toevoegen" title="Bestand toevoegen (of sleep/plak een bestand)" onClick={() => fileInput.current?.click()}>
            <Plus className="h-5 w-5" />
          </Button>
          <textarea
            ref={ta}
            value={text}
            rows={1}
            {...slash.textareaProps}
            onChange={(e) => {
              setText(e.target.value);
              slash.setCaret(e.target.selectionStart ?? e.target.value.length);
            }}
            onPaste={(e) => {
              const fl = Array.from(e.clipboardData.files || []);
              if (fl.length) {
                e.preventDefault();
                addFiles(fl);
              }
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (slash.onKeyDown(e)) return;
              // On a phone the Enter of the on-screen keyboard is a new line (there is no Shift+Enter); the button sends.
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !window.matchMedia('(pointer: coarse)').matches) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={placeholder || 'Typ een bericht…'}
            aria-label="Bericht"
            title="Enter = versturen · Shift+Enter = nieuwe regel · / of $ = skills en opdrachten"
            className="max-h-60 min-h-9 min-w-0 flex-1 resize-none bg-transparent px-1 py-2 text-[15px] leading-snug outline-none placeholder:text-muted coarse:min-h-11 coarse:py-2.5"
          />
          {accessory}
          {actions.map((A, i) => (
            <A
              key={i}
              threadId={threadId}
              agentId={agentId}
              insertText={(t) => setText((x) => (x ? x + (x.endsWith(' ') ? '' : ' ') + t : t))}
              send={(t, o) => send(t, { voice: o?.voice, attachments: o?.attachments })}
            />
          ))}
          {busy && (
            // Stopping the bot while you type your next message leaves the keyboard up, like sending does.
            <Button variant="soft" size="icon" className="rounded-full" aria-label="Stoppen" title="Stoppen" {...keepsFocus(onStop)}>
              <Square className="h-3.5 w-3.5 fill-current" />
            </Button>
          )}
          <Button
            variant="primary"
            size="icon"
            className="rounded-full"
            aria-label="Versturen"
            title={busy ? `Versturen (${busyHint || 'komt in de wachtrij'})` : 'Versturen'}
            loading={sending}
            disabled={uploading || (!text.trim() && !files.length) || !!disabled}
            {...keepsFocus(() => send())}
          >
            <ArrowUp className="h-[18px] w-[18px]" strokeWidth={2.4} />
          </Button>
        </div>
      </div>
    </div>
  );
}
