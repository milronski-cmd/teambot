import { useEffect, useState } from 'react';
import { ArrowLeft, Mail as MailIcon, PenLine, RefreshCw, Search, Send } from 'lucide-react';
import { api } from '../../lib/api';
import { useApp } from '../../lib/store';
import { navigate } from '../../lib/router';
import { t } from '../../lib/i18n';
import { Button, Card, Field, Input, SectionTitle, Spinner, Textarea, timeAgo, toast, toastError } from '../../components/ui';
import { Segmented } from '../../components/SettingControls';

interface Row {
  id: string;
  thread: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  unread: boolean;
  snippet: string;
}
interface Full extends Row {
  cc?: string;
  messageId?: string;
  attachments: string[];
  body: string;
}

/** "Jan de Vries <jan@voorbeeld.nl>" → the name, or the address when there is none. */
export const senderName = (from: string) => (/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(from)?.[1] || from).trim();
/** … → the address to answer to. */
export const senderAddress = (from: string) => (/<([^>]+)>/.exec(from)?.[1] || from).trim();
const when = (date: string) => {
  const d = new Date(date);
  return Number.isFinite(d.getTime()) ? t('{0} geleden', timeAgo(d.toISOString())) : '';
};
/** HTML entities in Gmail's short fragment ("&#39;"). */
const plain = (s: string) => {
  const el = document.createElement('textarea');
  el.innerHTML = s;
  return el.value;
};

/**
 * The owner's own mail on the dashboard (Gmail through the Google app): read, answer himself, or hand a mail to a bot.
 * A bot's own way to the same mailbox is its Gmail tools; this is the owner's screen.
 */
export function MailSection() {
  const agents = useApp((s) => s.agents);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [off, setOff] = useState('');
  const [open, setOpen] = useState<Full | null>(null);
  const [loading, setLoading] = useState('');
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  // Which mail he looks at (what came in, what went out), what he searches for, and a new mail he writes himself.
  const [box, setBox] = useState<'inbox' | 'sent'>('inbox');
  const [query, setQuery] = useState('');
  const [asked, setAsked] = useState('');
  const [fresh, setFresh] = useState<{ to: string; subject: string; body: string } | null>(null);

  const load = () =>
    api.get<{ messages: Row[] }>(`/mcp/google/mail?limit=12&q=${encodeURIComponent(`${box === 'sent' ? 'in:sent' : 'in:inbox'}${asked ? ` ${asked}` : ''}`)}`).then(
      (r) => (setRows(r.messages), setOff('')),
      (e) => (setRows([]), setOff(String(e?.message || e))),
    );
  useEffect(() => {
    setRows(null);
    void load();
  }, [box, asked]);

  const sendFresh = async () => {
    if (!fresh) return;
    setBusy(true);
    try {
      await api.post('/mcp/google/mail/send', { to: fresh.to.trim(), subject: fresh.subject.trim(), body: fresh.body });
      toast('Je mail is verstuurd', 'ok');
      setFresh(null);
      if (box === 'sent') void load();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const read = async (id: string) => {
    setLoading(id);
    try {
      setOpen(await api.get<Full>(`/mcp/google/mail/${encodeURIComponent(id)}`));
      setReply('');
      setRows((l) => (l || []).map((r) => (r.id === id ? { ...r, unread: false } : r)));
    } catch (e) {
      toastError(e);
    } finally {
      setLoading('');
    }
  };

  const send = async () => {
    if (!open) return;
    setBusy(true);
    try {
      await api.post('/mcp/google/mail/send', { to: senderAddress(open.from), subject: /^re:/i.test(open.subject) ? open.subject : `Re: ${open.subject}`, body: reply, thread: open.thread, inReplyTo: open.messageId });
      toast('Je antwoord is verstuurd', 'ok');
      setOpen(null);
      setReply('');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  /** Give this mail to a bot: a new chat with that bot, with the mail named, so it reads it with its own Gmail tools. */
  const toBot = async (agentId: string) => {
    if (!open) return;
    setBusy(true);
    try {
      const th = await api.post<{ id: string }>('/threads', { agentId });
      await api.post(`/threads/${th.id}/messages`, { content: t('Lees deze mail in Gmail en stel een antwoord voor: “{0}” van {1} (id {2}).', open.subject, senderName(open.from), open.id) });
      navigate(`/t/${th.id}`);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-2" data-testid="dashboard-mail">
      <SectionTitle
        icon={MailIcon}
        tone="blue"
        action={
          !off && (
            <span className="flex items-center gap-1">
              <Button size="sm" variant="ghost" icon={<PenLine className="h-4 w-4" />} onClick={() => (setOpen(null), setFresh({ to: '', subject: '', body: '' }))} data-testid="dashboard-mail-new">
                Nieuwe mail
              </Button>
              <Button size="sm" variant="ghost" icon={<RefreshCw className="h-4 w-4" />} onClick={() => (setRows(null), void load())}>
                Verversen
              </Button>
            </span>
          )
        }
      >
        Post
      </SectionTitle>
      {!off && !open && !fresh && (
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<'inbox' | 'sent'>
            label="Welke post"
            value={box}
            onChange={setBox}
            options={[
              { value: 'inbox', label: 'Inbox' },
              { value: 'sent', label: 'Verzonden' },
            ]}
          />
          <form
            className="flex min-w-0 flex-1 basis-48 items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              setAsked(query.trim());
            }}
          >
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('Zoek in je post')} aria-label={t('Zoek in je post')} data-testid="dashboard-mail-search" />
            <Button size="sm" variant="ghost" type="submit" icon={<Search className="h-4 w-4" />} aria-label={t('Zoeken')} />
          </form>
        </div>
      )}
      <Card className="p-0">
        {fresh ? (
          <div className="space-y-3 p-4" data-testid="dashboard-mail-compose">
            <Field label="Aan">
              <Input value={fresh.to} onChange={(e) => setFresh({ ...fresh, to: e.target.value })} placeholder="naam@voorbeeld.nl" inputMode="email" />
            </Field>
            <Field label="Onderwerp">
              <Input value={fresh.subject} onChange={(e) => setFresh({ ...fresh, subject: e.target.value })} />
            </Field>
            <Field label="Bericht">
              <Textarea rows={7} value={fresh.body} onChange={(e) => setFresh({ ...fresh, body: e.target.value })} />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" icon={<Send className="h-4 w-4" />} loading={busy} disabled={!fresh.to.trim() || !fresh.body.trim()} onClick={sendFresh} data-testid="dashboard-mail-send-new">
                Versturen
              </Button>
              <Button variant="secondary" onClick={() => setFresh(null)}>
                Annuleren
              </Button>
            </div>
          </div>
        ) : rows === null ? (
          <div className="flex justify-center p-6">
            <Spinner />
          </div>
        ) : off ? (
          <div className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
            <span className="min-w-0 flex-1 basis-56 text-muted">{off}</span>
            <Button size="sm" onClick={() => navigate('/m/mcp')}>
              Naar Apps
            </Button>
          </div>
        ) : open ? (
          <div className="space-y-3 p-4" data-testid="dashboard-mail-open">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <Button size="sm" variant="ghost" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => setOpen(null)}>
                Terug naar de lijst
              </Button>
              <span className="text-xs text-muted">{when(open.date)}</span>
            </div>
            <div>
              <div className="text-[15px] font-bold [overflow-wrap:anywhere]" translate="no">
                {open.subject || t('(geen onderwerp)')}
              </div>
              <div className="text-sm text-muted [overflow-wrap:anywhere]" translate="no">
                {open.from}
              </div>
            </div>
            <div className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-3 text-sm [overflow-wrap:anywhere]" translate="no">
              {open.body || open.snippet}
            </div>
            {open.attachments?.length > 0 && <div className="text-xs text-muted">{t('Bijlagen: {0}', open.attachments.join(', '))}</div>}
            <Field label={t('Je antwoord aan {0}', senderName(open.from))}>
              <Textarea rows={4} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Typ je antwoord…" />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" icon={<Send className="h-4 w-4" />} loading={busy} disabled={!reply.trim()} onClick={send} data-testid="dashboard-mail-send">
                Versturen
              </Button>
              {agents.length > 0 && (
                <label className="flex items-center gap-2 text-sm text-muted">
                  Of laat een bot het doen:
                  <select className="h-9 rounded-lg border border-line bg-surface px-2 text-sm text-fg" value="" onChange={(e) => e.target.value && void toBot(e.target.value)} aria-label="Bot die deze mail oppakt">
                    <option value="">Kies een bot</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          </div>
        ) : !rows.length ? (
          <div className="p-4 text-sm text-muted">{asked ? t('Niets gevonden.') : box === 'sent' ? t('Je hebt nog niets verstuurd.') : t('Je inbox is leeg.')}</div>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => read(r.id)} className="flex w-full items-start gap-3 px-4 py-2.5 text-start hover:bg-surface-2" data-testid="dashboard-mail-row">
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${r.unread ? 'bg-accent' : 'bg-transparent'}`} aria-label={r.unread ? t('ongelezen') : undefined} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className={`truncate text-sm ${r.unread ? 'font-bold' : 'font-medium'}`} translate="no">
                        {box === 'sent' ? t('Aan {0}', senderName(r.to || '')) : senderName(r.from)}
                      </span>
                      <span className="shrink-0 text-xs text-muted">{loading === r.id ? <Spinner /> : when(r.date)}</span>
                    </span>
                    <span className={`block truncate text-sm ${r.unread ? 'font-semibold' : ''}`} translate="no">
                      {r.subject || t('(geen onderwerp)')}
                    </span>
                    <span className="block truncate text-xs text-muted" translate="no">
                      {plain(r.snippet || '')}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}

/** A new mail from the dashboard (not an answer): kept apart so the list stays the first thing in view. */
export function NewMail({ onSent }: { onSent?(): void }) {
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      await api.post('/mcp/google/mail/send', { to, subject, body });
      toast('Je mail is verstuurd', 'ok');
      setTo('');
      setSubject('');
      setBody('');
      onSent?.();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <Field label="Aan">
        <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="naam@voorbeeld.nl" />
      </Field>
      <Field label="Onderwerp">
        <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
      </Field>
      <Field label="Bericht">
        <Textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>
      <Button variant="primary" icon={<Send className="h-4 w-4" />} loading={busy} disabled={!to.trim() || !body.trim()} onClick={send}>
        Versturen
      </Button>
    </div>
  );
}
