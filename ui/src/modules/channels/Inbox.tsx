import { useState, useSyncExternalStore } from 'react';
import { Headset, MessageSquare, Reply, Send, Undo2, X } from 'lucide-react';
import { api, on } from '../../lib/api';
import { t } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { Badge, Button, Card, Field, Textarea, timeAgo, toast, useAsync } from '../../components/ui';
import { ReplyModal } from './BindingDetail';

export interface HeldReply {
  id: string;
  binding_id: string;
  binding_name: string;
  adapter: string;
  adapter_label: string;
  conversation_id: string;
  conversation_title: string;
  thread_id: string | null;
  kind: string;
  status: 'held' | 'sending';
  question: string | null;
  text: string | null;
  reasons: string[];
  files: { name: string; size: number }[];
  error: string | null;
  created_at: string;
}

export interface Handoff {
  conversation_id: string;
  binding_id: string;
  binding_name: string;
  adapter: string;
  adapter_label: string;
  title: string;
  thread_id: string | null;
  reason: string;
  question: string;
  at: string;
}

interface InboxState {
  held: HeldReply[];
  handoffs: Handoff[];
}

// One shared copy for the sidebar badge, the phone tab bar and the page (several hooks, one request).
let state: InboxState = { held: [], handoffs: [] };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

async function refresh() {
  try {
    state = await api.get<InboxState>('/channels/inbox');
    for (const l of listeners) l();
  } catch {
    /* offline or not allowed: keep what we have */
  }
}

function soon() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void refresh(), 150);
}

/** Start after login (UI module init): load, then follow the server's events. */
export function startCustomerInbox(): () => void {
  void refresh();
  const offs = [on('channels.outbox', soon), on('channels.conversation', soon), on('channels.deleted', soon)];
  return () => offs.forEach((f) => f());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useCustomerInbox(): InboxState {
  return useSyncExternalStore(subscribe, () => state);
}

/** How many customer replies and handed-off conversations wait for the owner (added to the "Wacht op jou" badge). */
export function useCustomerInboxCount(): number {
  const s = useCustomerInbox();
  return s.held.length + s.handoffs.length;
}

function HeldCard({ h }: { h: HeldReply }) {
  const [text, setText] = useState(h.text || '');
  const act = useAsync();
  const edited = text.trim() !== (h.text || '').trim();
  const approve = () =>
    act.run(async () => {
      await api.post(`/channels/outbox/${h.id}/approve`, edited ? { text } : {});
      await refresh();
    }, edited ? 'Aangepast antwoord verstuurd' : 'Verstuurd');
  const reject = () =>
    act.run(async () => {
      await api.post(`/channels/outbox/${h.id}/reject`);
      await refresh();
      toast('Niet verstuurd. Het gesprek staat nu bij jou.', 'ok');
    });
  return (
    <Card className="space-y-3 p-4" data-testid="held-reply">
      <div className="flex flex-wrap items-center gap-2">
        <Headset className="h-4 w-4 text-accent" aria-hidden />
        <div className="min-w-0 flex-1 font-semibold">{t('Antwoord aan {0}', h.conversation_title || 'klant')}</div>
        <Badge tone="warn">Wacht op jou</Badge>
      </div>
      <div className="text-xs text-muted">
        {h.adapter_label} · {h.binding_name} · {timeAgo(h.created_at)}
      </div>
      {h.question && (
        <div className="rounded-lg bg-surface-2 p-2 text-sm">
          <div className="text-xs text-muted">Vraag van de klant</div>
          <div translate="no" className="line-clamp-4 whitespace-pre-wrap break-words">
            {h.question}
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {h.reasons.map((r) => (
          <Badge key={r} tone="warn">
            {r}
          </Badge>
        ))}
      </div>
      <Field label="Dit gaat naar de klant (je kunt het aanpassen)" hint={edited ? 'Jouw aangepaste tekst wordt verstuurd.' : 'Precies deze tekst wordt verstuurd.'}>
        <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      {h.files.length > 0 && <div className="text-xs text-muted">{t('{0, plural, one {Met # bestand} other {Met # bestanden}}', h.files.length)}</div>}
      {h.error && <div className="rounded-lg bg-danger-soft p-2 text-sm text-danger">{t('Vorige poging mislukte: {0}', h.error)}</div>}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={approve} loading={act.busy} disabled={!text.trim() || h.status === 'sending'} icon={<Send className="h-4 w-4" />}>
          {edited ? 'Aangepast versturen' : 'Versturen'}
        </Button>
        <Button variant="ghost" className="text-danger" onClick={reject} loading={act.busy} icon={<X className="h-4 w-4" />}>
          Niet versturen, ik antwoord zelf
        </Button>
        {h.thread_id && (
          <Button variant="ghost" onClick={() => navigate(`/t/${h.thread_id}`)} icon={<MessageSquare className="h-4 w-4" />}>
            Naar gesprek
          </Button>
        )}
      </div>
    </Card>
  );
}

function HandoffCard({ h }: { h: Handoff }) {
  const [reply, setReply] = useState(false);
  const act = useAsync();
  const release = () =>
    act.run(async () => {
      await api.post(`/channels/conversations/${h.conversation_id}/release`);
      await refresh();
    }, 'De bot antwoordt weer in dit gesprek');
  return (
    <Card className="space-y-3 p-4" data-testid="handoff">
      <div className="flex flex-wrap items-center gap-2">
        <Headset className="h-4 w-4 text-accent" aria-hidden />
        <div className="min-w-0 flex-1 font-semibold">{t('{0} wacht op jouw antwoord', h.title || 'Een klant')}</div>
        <Badge tone="warn">Doorgezet naar jou</Badge>
      </div>
      <div className="text-xs text-muted">
        {h.adapter_label} · <bdi translate="no">{h.binding_name}</bdi> · {timeAgo(h.at)} · <span translate="no">{h.reason}</span>
      </div>
      {h.question && (
        <div translate="no" className="line-clamp-4 whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-2 text-sm">
          {h.question}
        </div>
      )}
      <p className="text-xs text-muted">De klant weet dat er een mens antwoordt. De bot zwijgt in dit gesprek tot jij antwoordt of het vrijgeeft.</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => setReply(true)} icon={<Reply className="h-4 w-4" />}>
          Zelf antwoorden
        </Button>
        <Button variant="ghost" onClick={release} loading={act.busy} icon={<Undo2 className="h-4 w-4" />}>
          Vrijgeven aan de bot
        </Button>
        {h.thread_id && (
          <Button variant="ghost" onClick={() => navigate(`/t/${h.thread_id}`)} icon={<MessageSquare className="h-4 w-4" />}>
            Naar gesprek
          </Button>
        )}
      </div>
      {reply && (
        <ReplyModal
          open
          conversationId={h.conversation_id}
          title={h.title}
          onClose={() => {
            setReply(false);
            void refresh();
          }}
        />
      )}
    </Card>
  );
}

/** Section in "Wacht op jou": customer replies that wait for approval, and conversations handed off to the owner. */
export function CustomerInbox() {
  const s = useCustomerInbox();
  if (!s.held.length && !s.handoffs.length) return null;
  return (
    <section className="space-y-3" aria-label="Klanten">
      <h2 className="pt-2 text-sm font-semibold text-muted">Klanten</h2>
      {s.held.map((h) => (
        <HeldCard key={h.id} h={h} />
      ))}
      {s.handoffs.map((h) => (
        <HandoffCard key={h.conversation_id} h={h} />
      ))}
    </section>
  );
}
