import { useCallback, useEffect, useMemo, useState } from 'react';
import { Globe, MessageSquare, Plus, RadioTower } from 'lucide-react';
import { api, on } from '../../lib/api';
import { t } from '../../lib/i18n';
import { useApp } from '../../lib/store';
import { navigate, query, useRoute } from '../../lib/router';
import { Button, Card, EmptyState, Page, PageHeader, Spinner, timeAgo, useAsync } from '../../components/ui';
import { ConnectCard, ConnectResult, type ConnectState } from '../../components/ConnectCard';
import { healthBadge } from './health';
import { AddChannel, useRooms } from './AddChannel';
import { BindingDetailPage } from './BindingDetail';
import { GUIDES } from './guides';
import { useAdvanced } from '../../shell/advanced';
import { ADAPTER_ICON, BotAddresses, type AdaptersInfo, type BindingView } from './shared';
import { useFollowTeam } from '../teams/follow';
import { TeamFilterNote } from '../teams/FilterNote';
import { MoreInfo } from '../../components/MoreInfo';

export function useAdaptersInfo() {
  const [info, setInfo] = useState<AdaptersInfo | null>(null);
  useEffect(() => {
    api.get<AdaptersInfo>('/channels/adapters').then(setInfo, () => setInfo(null));
  }, []);
  return info;
}

export function ChannelsPage({ params }: { params: string[] }) {
  const info = useAdaptersInfo();
  // Read our own sub-route (#/m/channels/<id>) so we do not depend on how the shell slices params.
  const route = useRoute();
  const id = route[0] === 'm' && route[1] === 'channels' ? route[2] : params[0];
  if (id && id !== 'nieuw') return <BindingDetailPage id={id} info={info} />;
  return <ChannelList info={info} openNew={id === 'nieuw'} />;
}

/** The four connect states from the channel's health; "gekoppeld" only with proof (no green tick from a login alone). */
function connectState(b: BindingView): { state: ConnectState; label: string } {
  const h = healthBadge(b);
  const label = h.label.toLowerCase();
  if (h.tone === 'ok') return { state: 'on', label: 'gekoppeld' };
  if (h.tone === 'danger') return { state: 'error', label };
  if (h.tone === 'warn' && !/^verbonden/.test(label)) return { state: 'busy', label };
  return { state: 'off', label };
}

/** One channel in the list: the shared connect card, with a test that says "Verbinding werkt" or what to do. */
function ChannelCard({ b, who, team }: { b: BindingView; who: string; team?: string }) {
  const Icon = ADAPTER_ICON[b.adapter] || MessageSquare;
  const [test, setTest] = useState<{ ok: boolean; detail: string } | null>(null);
  const act = useAsync();
  const run = () =>
    act.run(async () => {
      const r = await api.post<{ ok: boolean; detail: string }>(`/channels/bindings/${b.id}/test`).catch((e) => ({ ok: false, detail: String(e?.message || e) }));
      setTest({ ok: r.ok, detail: r.detail });
    });
  const c = connectState(b);
  const problem = b.health?.reason && b.health.state !== 'ok' ? b.health.reason : b.last_error;
  return (
    <ConnectCard
      data-testid="channel-card"
      icon={<Icon aria-hidden />}
      title={
        <a href={`#/m/channels/${b.id}`} className="hover:underline">
          {b.name}
        </a>
      }
      line={
        <>
          {GUIDES[b.adapter]?.title || b.adapterLabel} · {who}
          {team ? (
            <>
              {' · '}
              <span translate="no">{team}</span>
            </>
          ) : null}
          {b.health && b.health.state !== 'off' ? <> · {b.health.inAt ? t('Laatst ontvangen {0}', timeAgo(b.health.inAt)) : 'Nog niets ontvangen'}</> : null}
        </>
      }
      state={c.state}
      stateLabel={c.label}
      action={
        <>
          <Button size="sm" loading={act.busy} onClick={run}>
            Test
          </Button>
          <Button size="sm" variant="ghost" onClick={() => navigate(`/m/channels/${b.id}`)}>
            Openen
          </Button>
        </>
      }
      result={
        test ? (
          <ConnectResult ok={test.ok} next={test.ok ? undefined : 'Open het kanaal om het te herstellen.'}>
            {test.ok ? t('Verbinding werkt: {0}', test.detail) : test.detail}
          </ConnectResult>
        ) : c.state === 'error' && problem ? (
          <ConnectResult ok={false} next="Open het kanaal om het te herstellen.">
            {problem}
          </ConnectResult>
        ) : undefined
      }
    >
      {b.botAddresses?.length ? <BotAddresses list={b.botAddresses} /> : undefined}
    </ConnectCard>
  );
}

function ChannelList({ info, openNew }: { info: AdaptersInfo | null; openNew: boolean }) {
  const advanced = useAdvanced();
  const agents = useApp((s) => s.agents);
  const agentName = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents]);
  const groups = useRooms();
  const roomName = useMemo(() => new Map(groups.map((r) => [r.id, r.name])), [groups]);
  const [list, setList] = useState<BindingView[] | null>(null);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(openNew);
  // Package B4: each channel belongs to one team; the list follows the team switcher (from two teams on).
  const team = useFollowTeam();
  const load = useCallback(() => api.get<BindingView[]>(`/channels/bindings${team.query}`).then((r) => (setList(r), setErr('')), (e) => setErr(e.message)), [team.query]);
  useEffect(() => {
    load();
    const offs = [
      on('channels.status', (d: any) => setList((x) => x?.map((b) => (b.id === d.id ? { ...b, status: d.status, last_error: d.last_error } : b)) ?? x)),
      on('channels.health', (d: any) => setList((x) => x?.map((b) => (b.id === d.id ? { ...b, health: d.health } : b)) ?? x)),
      on('channels.updated', () => load()),
      on('channels.deleted', (d: any) => setList((x) => x?.filter((b) => b.id !== d.id) ?? x)),
    ];
    return () => offs.forEach((f) => f());
  }, [load]);

  const preAgent = openNew ? query().get('agent') || undefined : undefined;
  const closeAdd = () => {
    setAdding(false);
    if (openNew) navigate('/m/channels');
  };

  return (
    <Page>
      <PageHeader width="4xl"
        title="Kanalen"
        subtitle={
          <>
            Praat met je bots via Telegram, WhatsApp, e-mail, Discord of Slack. <MoreInfo>Alles wat binnenkomt lees je hier live mee. Berichten komen binnen zolang TeamBot draait.</MoreInfo>
          </>
        }
        actions={
          <Button variant="primary" onClick={() => setAdding(true)} icon={<Plus className="h-4 w-4" />}>
            Kanaal toevoegen
          </Button>
        }
      />
      <div className="mx-auto max-w-4xl space-y-4 px-4 py-4 sm:px-6">
        <TeamFilterNote>Je ziet de kanalen van dit team. Alleen bots van dit team antwoorden en versturen via deze kanalen.</TeamFilterNote>
        {/* The public-address details only for experts (the add dialog explains it for the few channels that need one). */}
        {info && !info.publicUrl && advanced && (
          <Card className="flex gap-3 bg-surface-2 p-3 text-sm">
            <Globe className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
            <div>
              <b>Geen publiek adres ingesteld.</b> Telegram, e-mail, Discord, Slack (Socket Mode), WhatsApp via QR-code en webhooks op je eigen netwerk werken gewoon. WhatsApp Business, Slack via de Events API en Telegram
              in webhookmodus hebben een publiek https-adres nodig: vul dat in bij de koppeling.
            </div>
          </Card>
        )}
        {err && <div className="rounded-lg bg-danger-soft p-3 text-sm text-danger">{err}</div>}
        {!list && !err && (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        )}
        {list && list.length === 0 && (
          <EmptyState
            icon={<RadioTower className="h-10 w-10" />}
            title="Nog geen kanalen"
            action={
              <Button variant="primary" onClick={() => setAdding(true)} icon={<Plus className="h-4 w-4" />}>
                Eerste kanaal koppelen
              </Button>
            }
          >
            Begin met Telegram: het makkelijkst en het veiligst.
          </EmptyState>
        )}
        {list && list.length > 0 && (
          <div className="space-y-3">
            {list.map((b) => (
              <ChannelCard key={b.id} b={b} who={b.agent_id ? agentName.get(b.agent_id) || 'bot' : b.room_id ? `groep ${roomName.get(b.room_id) || ''}`.trim() : 'geen bot gekozen'} team={team.multi && !team.activeId ? b.teamName : undefined} />
            ))}
          </div>
        )}
      </div>
      <AddChannel open={adding} onClose={closeAdd} info={info} initialAgentId={preAgent} onCreated={() => load()} />
    </Page>
  );
}
