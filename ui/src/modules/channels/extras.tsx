import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Clock, Headset, MessageSquare, Pause, Play, Plus, Reply, RotateCw, Trash2, TriangleAlert } from 'lucide-react';
import { api, on } from '../../lib/api';
import { useApp } from '../../lib/store';
import { navigate } from '../../lib/router';
import type { Agent, Message } from '../../lib/types';
import { Badge, Button, Field, Input, Select, Spinner, Toggle, toast, toastError, useAsync } from '../../components/ui';
import { ReplyModal } from './BindingDetail';
import { t } from '../../lib/i18n';
import { ADAPTER_ICON, StatusBadge, type BindingView } from './shared';

/** Bot editor section: the channels of this bot + the channel_send tool group. */
export function AgentChannels({ agent, onChange }: { agent: Agent; onChange(p: Partial<Agent>): void }) {
  const [list, setList] = useState<BindingView[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!agent.id) return;
    // This bot's own channels, plus the owner's linked WhatsApp (shared by all bots: "@Naam …").
    const load = () => api.get<BindingView[]>('/channels/bindings').then((all) => setList(all.filter((b) => b.agent_id === agent.id || b.adapter === 'whatsapp-web')), (e) => setErr(e.message));
    load();
    const offs = [on('channels.status', load), on('channels.updated', load), on('channels.deleted', load)];
    return () => offs.forEach((f) => f());
  }, [agent.id]);
  const groups = agent.tool_groups || [];
  const canSend = groups.includes('channels');
  if (!agent.id) return <p className="text-sm text-muted">Sla de bot eerst op; daarna kun je hem koppelen aan Telegram, Discord, Slack, e-mail of WhatsApp.</p>;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">Waar is deze bot bereikbaar? Antwoorden gaan altijd terug naar hetzelfde gesprek.</p>
      {err && <div className="text-sm text-danger">{err}</div>}
      {!list && !err && <Spinner />}
      {list && list.length === 0 && <div className="rounded-lg bg-surface-2 p-3 text-sm text-muted">Nog geen kanalen voor deze bot.</div>}
      {list && list.length > 0 && (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {list.map((b) => {
            const Icon = ADAPTER_ICON[b.adapter] || MessageSquare;
            return (
              <li key={b.id}>
                <a href={`#/m/channels/${b.id}`} className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-surface-2">
                  <Icon className="h-4 w-4 text-accent" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{b.name}</span>
                  {b.agent_id !== agent.id && <Badge>gedeeld: @{agent.name}</Badge>}
                  <StatusBadge status={b.status} enabled={b.enabled} link={b.link} health={b.health} />
                </a>
              </li>
            );
          })}
        </ul>
      )}
      <Button size="sm" variant="secondary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => navigate(`/m/channels/nieuw?agent=${encodeURIComponent(agent.id)}`)}>
        Kanaal toevoegen
      </Button>
      <div>
        <Toggle
          checked={canSend}
          onChange={(v) => onChange({ tool_groups: v ? [...groups.filter((g) => g !== 'channels'), 'channels'] : groups.filter((g) => g !== 'channels') })}
          label="Mag zelf berichten en bestanden sturen"
        />
        <div className="mt-1 ps-11 text-xs text-muted">
          Bijvoorbeeld een pdf-rapport naar je WhatsApp. Elk zo’n bericht vraagt eerst jouw toestemming, behalve voor ontvangers die je hieronder vrijgeeft.
          
        </div>
      </div>
      {canSend && list && <SendRules agentId={agent.id} agentName={agent.name} bindings={list} />}
    </div>
  );
}

interface RulesView {
  ownerWithoutApproval: boolean;
  contacts: { id: string; binding_id: string | null; binding: string | null; target: string; label: string }[];
}

/** Per bot: send to me without asking; trusted contacts. Saved immediately (owner-only REST, never by a bot). */
function SendRules({ agentId, agentName, bindings }: { agentId: string; agentName: string; bindings: BindingView[] }) {
  const [rules, setRules] = useState<RulesView | null>(null);
  const [bid, setBid] = useState('');
  const [target, setTarget] = useState('');
  const [label, setLabel] = useState('');
  const act = useAsync();
  const load = useCallback(() => api.get<RulesView>(`/channels/agents/${agentId}/send-rules`).then(setRules, () => setRules(null)), [agentId]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!bid && bindings[0]) setBid(bindings[0].id);
  }, [bindings, bid]);
  if (!rules) return null;
  const setOwner = (v: boolean) =>
    act.run(async () => setRules(await api.put<RulesView>(`/channels/agents/${agentId}/send-rules/owner`, { enabled: v })), v ? `${agentName} mag jou nu zonder vragen berichten sturen` : 'Vraagt weer toestemming');
  const add = () =>
    act.run(async () => {
      setRules(await api.post<RulesView>(`/channels/agents/${agentId}/send-rules`, { binding_id: bid, target, label }));
      setTarget('');
      setLabel('');
    }, 'Vrijgegeven');
  const remove = (id: string) => act.run(async () => setRules(await api.del<RulesView>(`/channels/agents/${agentId}/send-rules/${id}`)));
  return (
    <div className="space-y-3 rounded-lg border border-line p-3">
      <div className="text-sm font-medium">Versturen zonder te vragen</div>
      <div>
        <Toggle checked={rules.ownerWithoutApproval} onChange={setOwner} label={`${agentName} mag míj zonder te vragen berichten en bestanden sturen`} />
        <div className="mt-1 ps-11 text-xs text-muted">Alleen naar jouw eigen, geverifieerde gesprek op een kanaal.</div>
      </div>
      <div className="space-y-2">
        <div className="text-xs text-muted">
          Anderen (bijv. klanten) krijgen alleen zonder vragen een bericht als je ze hier vrijgeeft. Doe dat alleen als je {agentName} daar volledig in vertrouwt.
        </div>
        {rules.contacts.length > 0 && (
          <ul className="divide-y divide-line rounded-lg border border-line text-sm">
            {rules.contacts.map((c) => (
              <li key={c.id} className="flex items-center gap-2 px-3 py-1.5">
                <span className="min-w-0 flex-1 truncate">
                  {c.label} <span className="font-mono text-xs text-muted">{c.target}</span> <span className="text-xs text-muted">· {c.binding || 'kanaal verwijderd'}</span>
                </span>
                <Button size="icon" variant="ghost" aria-label={`${c.label} niet meer vrijgeven`} onClick={() => remove(c.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {bindings.length > 0 && (
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
            <Field label="Kanaal">
              <Select value={bid} onChange={(e) => setBid(e.target.value)} aria-label="Kanaal">
                {bindings.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Nummer, adres of gesprek-id">
              <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="31612345678" />
            </Field>
            <Field label="Naam">
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="bijv. Klant Jansen" />
            </Field>
            <Button onClick={add} disabled={!target.trim() || !bid} loading={act.busy} icon={<Plus className="h-4 w-4" />}>
              Vrijgeven
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

interface ThreadChannel {
  conversationId: string;
  title: string;
  paused: boolean;
  /** Handed off to the owner (customer mode). */
  handoff?: { at: string; reason: string } | null;
  is_private: boolean;
  bindingId: string;
  bindingName: string;
  adapter: string;
  adapterLabel: string;
  status: BindingView['status'];
  sender: { label: string; is_owner: boolean } | null;
  access: 'none' | 'readonly' | 'agent';
}

/** Chat header: shows that a thread is an external channel conversation, with pause + take-over. */
export function ChannelHeader({ threadId }: { threadId: string; agentId: string | null }) {
  const thread = useApp((s) => s.threads.find((t) => t.id === threadId));
  const isChannel = thread?.kind === 'channel';
  const [ch, setCh] = useState<ThreadChannel | null>(null);
  const [reply, setReply] = useState(false);
  const act = useAsync();
  useEffect(() => {
    if (!isChannel) return;
    const load = () => api.get<{ channel: ThreadChannel | null }>(`/channels/threads/${threadId}`).then((r) => setCh(r.channel), () => setCh(null));
    load();
    const offs = [on('channels.conversation', (c: any) => c.thread_id === threadId && load()), on('channels.status', load)];
    return () => offs.forEach((f) => f());
  }, [threadId, isChannel]);
  if (!isChannel || !ch) return null;
  const Icon = ADAPTER_ICON[ch.adapter] || MessageSquare;
  const togglePause = () =>
    act.run(async () => {
      await api.patch(`/channels/conversations/${ch.conversationId}`, { paused: !ch.paused });
      setCh({ ...ch, paused: !ch.paused, handoff: ch.paused ? null : ch.handoff });
    }, ch.paused ? 'Bot antwoordt weer' : 'Bot gepauzeerd in dit gesprek');
  return (
    <div className="flex items-center gap-1">
      <a href={`#/m/channels/${ch.bindingId}`} className="hidden items-center gap-1 sm:inline-flex" title={`${ch.bindingName} — ${ch.title}`}>
        <Badge tone={ch.status === 'error' ? 'danger' : 'accent'}>
          <Icon className="h-3 w-3" aria-hidden /> {ch.adapterLabel}
          {ch.sender ? ` · ${ch.sender.label}` : ''}
          {ch.sender?.is_owner ? ' (jij)' : ''}
        </Badge>
      </a>
      {ch.handoff && (
        <span className="hidden sm:inline-flex" title={ch.handoff.reason}>
          <Badge tone="warn">
            <Headset className="h-3 w-3" aria-hidden /> Doorgezet naar jou
          </Badge>
        </span>
      )}
      <Button
        size="icon"
        variant="ghost"
        aria-label={ch.handoff ? 'Gesprek vrijgeven aan de bot' : ch.paused ? 'Bot hervatten in dit gesprek' : 'Bot pauzeren in dit gesprek'}
        title={ch.handoff ? 'Vrijgeven: de bot antwoordt weer' : ch.paused ? 'Bot hervatten' : 'Bot pauzeren (zelf overnemen)'}
        onClick={togglePause}
        loading={act.busy}
      >
        {ch.paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
      </Button>
      <Button size="icon" variant="ghost" aria-label={`Zelf antwoorden via ${ch.adapterLabel}`} title={`Zelf antwoorden via ${ch.adapterLabel}`} onClick={() => setReply(true)}>
        <Reply className="h-4 w-4" />
      </Button>
      {reply && <ReplyModal open conversationId={ch.conversationId} title={ch.title} onClose={() => setReply(false)} />}
    </div>
  );
}

/** Under a bot message in a channel thread: was it delivered to the external chat? */
export function DeliveryExtra({ message }: { message: Message }) {
  const d = message.parts?.channelDelivery as { status: 'sent' | 'failed' | 'held' | 'handoff' | 'blocked' | 'rejected'; label?: string; error?: string; reason?: string; reasons?: string[]; edited?: boolean; approved?: boolean; at?: string } | undefined;
  const ext = message.author_type === 'external' ? (message.parts?.channel as any) : null;
  const [busy, setBusy] = useState(false);
  const label = useMemo(() => d?.label || 'kanaal', [d?.label]);
  if (ext)
    return (
      <div className="mt-1 text-xs text-muted">
        via {ext.adapterLabel}
        {ext.isOwner ? ' · geverifieerd als jij' : ' · externe afzender (onbetrouwbare inhoud)'}
        {ext.refused ? ' · niet naar de bot gestuurd' : ext.access === 'none' ? ' · zonder tools' : ext.access === 'readonly' ? ' · alleen lezen' : ''}
        {Array.isArray(ext.routines) && ext.routines.length ? ` · startte ${ext.routines.length === 1 ? 'een routine' : `${ext.routines.length} routines`}` : ''}
      </div>
    );
  if (!d) return null;
  if (d.status === 'sent')
    return (
      <div className="mt-1 inline-flex items-center gap-1 text-xs text-muted">
        <Check className="h-3 w-3 text-ok" aria-hidden />{' '}
        {d.approved ? (
          d.edited ? (
            t('Na jouw goedkeuring verstuurd via {0}, met jouw aanpassing', label)
          ) : (
            t('Na jouw goedkeuring verstuurd via {0}', label)
          )
        ) : (
          <>Verstuurd via {label}</>
        )}
      </div>
    );
  // Customer mode: the draft did not go out (yet).
  if (d.status === 'held')
    return (
      <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-warn">
        <Clock className="h-3 w-3" aria-hidden /> {t('Wacht op jouw goedkeuring: {0}', (d.reasons || []).join('; '))}
        <a className="font-medium underline" href="#/inbox">
          Bekijken
        </a>
      </div>
    );
  if (d.status === 'handoff' || d.status === 'blocked' || d.status === 'rejected')
    return (
      <div className="mt-1 inline-flex items-center gap-1 text-xs text-warn">
        <Headset className="h-3 w-3" aria-hidden />
        {d.status === 'rejected' ? 'Niet verstuurd: jij hield dit antwoord tegen' : d.status === 'handoff' ? t('Niet verstuurd, doorgezet naar jou: {0}', d.reason || '') : t('Niet verstuurd: {0}', d.reason || '')}
      </div>
    );
  const resend = async () => {
    setBusy(true);
    try {
      await api.post(`/channels/messages/${message.id}/resend`);
      toast('Opnieuw verstuurd', 'ok');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-danger">
      <TriangleAlert className="h-3 w-3" aria-hidden /> Niet verstuurd via {label}
      {d.error ? `: ${d.error}` : ''}
      <Button size="sm" variant="ghost" className="h-6 px-1.5 text-xs" onClick={resend} loading={busy} icon={<RotateCw className="h-3 w-3" />}>
        Opnieuw
      </Button>
    </div>
  );
}
