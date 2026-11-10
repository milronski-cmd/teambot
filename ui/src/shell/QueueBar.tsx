import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, GripVertical, ListOrdered, Paperclip, Pause, Pencil, Play, Trash2, Zap } from 'lucide-react';
import { api, on } from '../lib/api';
import { useApp } from '../lib/store';
import type { AttachmentRef } from '../lib/types';
import { Button, cx, Textarea, toast, toastError } from '../components/ui';

/**
 * Chat queue + steering (server: server/agent/queue.ts).
 *
 * While the bot works, the owner's messages wait in a queue outside the transcript (edit, reorder, delete) and are
 * sent one per turn when the bot is free. "Bijsturen" puts a message into the running turn: API engines take it at the
 * next safe point; CLI engines (Claude Code, Codex …) are interrupted and continue their session with the message.
 *
 * Placement (for the composer): use `useMessageQueue(threadId)`, send through `queue.send(...)` instead of POST
 * /threads/:id/messages (it posts directly when the bot is idle and queues otherwise), and render
 * `<QueueBar queue={queue} />` right above the composer. Steering a typed message: `queue.send(text, { mode: 'steer' })`.
 */

export interface QueueItem {
  id: string;
  thread_id: string;
  content: string;
  attachments: AttachmentRef[];
  reply_to: string | null;
  created_at: string;
  updated_at: string;
}

export interface QueueState {
  threadId: string;
  items: QueueItem[];
  paused: boolean;
  pausedReason: string;
  busy: boolean;
  runStatus: string | null;
  engine: 'api' | 'cli' | null;
  /** The running turn can take a message mid-turn (API engines). CLI engines are interrupted instead. */
  canSteer: boolean;
}

export type SendMode = 'auto' | 'queue' | 'steer' | 'interrupt';

export interface SendResult {
  /** sent = posted now; queued = waits; steered = taken into the running turn; answered = answered the bot's open
   *  question; interrupted = the turn was stopped and the message sent now. */
  mode: 'sent' | 'queued' | 'steered' | 'answered' | 'interrupted';
  reason?: string;
  queue?: QueueState;
}

const RESULT_TEXT: Record<SendResult['mode'], string> = {
  sent: 'Verstuurd',
  queued: 'In de wachtrij gezet',
  steered: 'Meegegeven aan de lopende beurt',
  answered: 'Gebruikt als antwoord op de vraag van de bot',
  interrupted: 'Beurt onderbroken; je bericht is verstuurd',
};

/** Threads with a queue: a chat (or routine thread) with exactly one bot. */
export function supportsQueue(t: { agent_id: string | null; room_id: string | null; kind: string } | undefined | null): boolean {
  return !!t && !!t.agent_id && !t.room_id && (t.kind === 'chat' || t.kind === 'routine');
}

/** Minimal hook: queue state for one thread plus the actions. `enabled` is false for groups and bot-to-bot threads. */
export function useMessageQueue(threadId: string | null) {
  const thread = useApp((s) => (threadId ? s.threads.find((t) => t.id === threadId) : undefined));
  const enabled = !!threadId && supportsQueue(thread);
  const [state, setState] = useState<QueueState | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    if (!enabled || !threadId) return setState(null);
    try {
      const v = await api.get<QueueState>(`/threads/${threadId}/queue`);
      if (alive.current) setState(v);
    } catch {
      if (alive.current) setState(null);
    }
  }, [enabled, threadId]);

  useEffect(() => {
    alive.current = true;
    setState(null);
    refresh();
    const off1 = on('queue.updated', (v: QueueState) => v?.threadId === threadId && setState(v));
    const off2 = on('run.updated', (r: { thread_id?: string }) => r?.thread_id === threadId && refresh());
    return () => {
      alive.current = false;
      off1();
      off2();
    };
  }, [threadId, refresh]);

  const apply = (v?: QueueState) => v && setState(v);

  /** Send a message: posted now when the bot is idle, otherwise queued (mode auto). */
  const send = async (content: string, o: { attachments?: string[]; replyTo?: string | null; voice?: boolean; mode?: SendMode } = {}): Promise<SendResult> => {
    if (!threadId) throw new Error('Geen gesprek');
    if (!enabled) {
      await api.post(`/threads/${threadId}/messages`, { content, attachments: o.attachments, replyTo: o.replyTo, voice: o.voice });
      return { mode: 'sent' };
    }
    const r = await api.post<SendResult>(`/threads/${threadId}/queue`, { content, attachments: o.attachments, replyTo: o.replyTo, voice: o.voice, mode: o.mode || 'auto' });
    apply(r.queue);
    if (r.mode !== 'sent') toast(r.reason || RESULT_TEXT[r.mode], r.reason ? 'neutral' : 'ok');
    return r;
  };
  const edit = async (id: string, content: string) => apply(await api.patch<QueueState>(`/threads/${threadId}/queue/${id}`, { content }));
  const move = async (id: string, to: number) => apply(await api.post<QueueState>(`/threads/${threadId}/queue/${id}/move`, { to }));
  const remove = async (id: string) => apply(await api.del<QueueState>(`/threads/${threadId}/queue/${id}`));
  /** Put a queued message into the running turn now (CLI engines: interrupt + continue the session). */
  const steer = async (id: string, interrupt?: boolean): Promise<SendResult> => {
    const r = await api.post<SendResult>(`/threads/${threadId}/queue/${id}/steer`, { interrupt: interrupt ?? state?.engine === 'cli' });
    apply(r.queue);
    toast(r.reason || RESULT_TEXT[r.mode], r.reason ? 'neutral' : 'ok');
    return r;
  };
  const pause = async () => apply(await api.post<QueueState>(`/threads/${threadId}/queue/pause`, {}));
  const resume = async () => apply(await api.post<QueueState>(`/threads/${threadId}/queue/resume`, {}));

  return { enabled, state, items: state?.items || [], refresh, send, edit, move, remove, steer, pause, resume };
}

export type MessageQueue = ReturnType<typeof useMessageQueue>;

function Item({ q, it, index, count, onDragStart, onDrop }: { q: MessageQueue; it: QueueItem; index: number; count: number; onDragStart(): void; onDrop(): void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(it.content);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<any>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const cli = q.state?.engine === 'cli';
  const running = !!q.state?.busy;
  // The bot waits for an answer to its question card: a queued message can be that answer (never an interrupt).
  const asking = useApp((s) => s.approvals.some((a) => a.thread_id === q.state?.threadId && a.kind === 'question' && a.status === 'pending'));
  const steerLabel = asking ? 'Gebruiken als antwoord op de vraag van de bot' : !running ? 'Nu versturen' : cli ? 'Nu sturen (onderbreekt de beurt)' : 'Bijsturen: meegeven aan de lopende beurt';
  return (
    <li
      className="group flex items-start gap-1.5 rounded-lg border border-line bg-surface px-2 py-1.5 text-sm"
      draggable={!editing}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
    >
      <GripVertical className="mt-0.5 h-4 w-4 shrink-0 cursor-grab text-muted" aria-hidden />
      <span className="mt-0.5 w-4 shrink-0 text-xs text-muted">{index + 1}</span>
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="space-y-1.5">
            <Textarea
              value={draft}
              rows={Math.min(6, draft.split('\n').length + 1)}
              autoFocus
              aria-label="Bericht in de wachtrij bewerken"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') (setEditing(false), setDraft(it.content));
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  act(async () => (await q.edit(it.id, draft), setEditing(false)));
                }
              }}
            />
            <div className="flex justify-end gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => (setEditing(false), setDraft(it.content))}>
                Annuleren
              </Button>
              <Button size="sm" variant="primary" loading={busy} disabled={!draft.trim() && !it.attachments.length} onClick={() => act(async () => (await q.edit(it.id, draft), setEditing(false)))}>
                Opslaan
              </Button>
            </div>
          </div>
        ) : (
          <button type="button" className="block w-full text-start" title="Klik om te bewerken" onClick={() => (setDraft(it.content), setEditing(true))}>
            <span className="line-clamp-2 whitespace-pre-wrap break-words">{it.content || <span className="italic text-muted">(alleen bijlagen)</span>}</span>
            {it.attachments.length > 0 && (
              <span className="mt-0.5 flex items-center gap-1 text-xs text-muted">
                <Paperclip className="h-3 w-3" /> {it.attachments.map((a) => a.name).join(', ')}
              </span>
            )}
          </button>
        )}
      </div>
      {!editing && (
        <div className="flex shrink-0 items-center opacity-70 transition group-hover:opacity-100 focus-within:opacity-100">
          <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={steerLabel} title={steerLabel} loading={busy} onClick={() => act(() => q.steer(it.id, asking ? false : undefined))}>
            <Zap className="h-3.5 w-3.5" />
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Bewerken" title="Bewerken" onClick={() => (setDraft(it.content), setEditing(true))}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Omhoog" title="Omhoog" disabled={index === 0} onClick={() => act(() => q.move(it.id, index - 1))}>
            <ChevronUp className="h-3.5 w-3.5" />
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Omlaag" title="Omlaag" disabled={index === count - 1} onClick={() => act(() => q.move(it.id, index + 1))}>
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7 text-danger" aria-label="Uit de wachtrij halen" title="Uit de wachtrij halen" onClick={() => act(() => q.remove(it.id))}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </li>
  );
}

/**
 * The queue above the composer: queued messages (edit, drag or arrows to reorder, delete, steer now) and the paused
 * state. Renders nothing when the queue is empty. Pass the hook from the composer's owner, or let it use its own.
 */
export function QueueBar({ threadId, queue, className }: { threadId?: string; queue?: MessageQueue; className?: string }) {
  const own = useMessageQueue(queue ? null : threadId || null);
  const q = queue || own;
  const drag = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!q.enabled || !q.state || !q.items.length) return null;
  const s = q.state;
  const act = async (fn: () => Promise<any>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Wachtrij" className={cx('rounded-xl border border-line bg-surface-2 p-2', className)}>
      <div className="mb-1.5 flex flex-wrap items-center gap-2 px-1 text-xs">
        <ListOrdered className="h-3.5 w-3.5 text-muted" aria-hidden />
        <span className="font-medium">
          In de wachtrij ({q.items.length})
        </span>
        <span className="text-muted">{s.paused ? '' : s.busy ? '· gaan één voor één naar de bot zodra hij klaar is' : ''}</span>
        <span className="ms-auto flex items-center gap-1">
          {s.paused ? (
            <Button size="sm" variant="soft" className="h-7" icon={<Play className="h-3.5 w-3.5" />} loading={busy} onClick={() => act(q.resume)}>
              Doorgaan
            </Button>
          ) : (
            <Button size="sm" variant="ghost" className="h-7" icon={<Pause className="h-3.5 w-3.5" />} loading={busy} onClick={() => act(q.pause)} title="Wachtrij pauzeren: niets wordt verstuurd tot je op Doorgaan klikt">
              Pauzeren
            </Button>
          )}
        </span>
      </div>
      {s.paused && (
        <div className="mb-1.5 rounded-lg bg-warn-soft px-2.5 py-1.5 text-xs text-warn" role="status">
          {s.pausedReason || 'De wachtrij staat stil.'}
        </div>
      )}
      <ol className="max-h-48 space-y-1 overflow-y-auto">
        {q.items.map((it, i) => (
          <Item
            key={it.id}
            q={q}
            it={it}
            index={i}
            count={q.items.length}
            onDragStart={() => (drag.current = it.id)}
            onDrop={() => {
              const id = drag.current;
              drag.current = null;
              if (id && id !== it.id) act(() => q.move(id, i));
            }}
          />
        ))}
      </ol>
    </section>
  );
}
