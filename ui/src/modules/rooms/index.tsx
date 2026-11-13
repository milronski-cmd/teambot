import { useEffect, useMemo, useState } from 'react';
import { AtSign, Building2, CircleStop, ClipboardList, Download, ExternalLink, GitFork, Play, Plus, Settings2, Trash2, UserPlus, Users, X } from 'lucide-react';
import type { UIModule } from '../types';
import { api, authUrl, on } from '../../lib/api';
import { useApp } from '../../lib/store';
import { navigate, query } from '../../lib/router';
import type { Agent } from '../../lib/types';
import { askConfirm, Badge, Button, Card, EmptyState, Field, Input, Modal, Page, PageHeader, Select, Spinner, Tabs, Textarea, Toggle, cx, timeAgo, toast, toastError, useAsync } from '../../components/ui';
import { BotAvatar } from '../../components/BotFace';
import { MoreInfo } from '../../components/MoreInfo';
import { Fold, Menu, Skeleton, SkeletonRows } from '../../components/overview';
import type { Mood } from '../../lib/botface';
import { t, uiLocale } from '../../lib/i18n';
import { formatUsd } from '../../lib/format';
import { initProposals, ProposalEvent, ProposalsInbox, ProposalsOnRoomsPage, useProposalCount } from './proposals';
import { MODES, NewRoomModal, type Mode } from './NewRoom';
import { RoomFiles } from './files';
import { OrgPage, RoomTeamField } from './org';
import { TasksPage } from '../../pages/Tasks';
import { useAdvanced } from '../../shell/advanced';
import { CheckBadge } from '../quality/parts';
import { useTeams } from '../teams/api';

// ---------------------------------------------------------------- types (mirror server/modules/rooms)
interface BotView {
  id: string;
  agentId: string;
  name: string;
  avatar: string;
  color: string;
  title: string;
  model: string;
  role: string;
  lead: boolean;
  owner: boolean;
  perms: { respond: 'auto' | 'mention'; files: 'none' | 'read' | 'write'; tasks: boolean; delegate: boolean };
  state: string;
  stateDetail: string;
  paused: boolean;
  /** Teams (B2): the bot's own team and its reach in the group's team (home / direct / read / none). */
  homeTeamId?: string | null;
  homeTeamName?: string;
  teamReach?: 'home' | 'direct' | 'read' | 'none';
}
interface PersonView {
  id: string;
  kind: 'user';
  userId?: string;
  ref_id?: string;
  name: string;
  role: 'member' | 'guest';
  accepted: boolean;
}
interface RoomView {
  id: string;
  thread_id: string;
  name: string;
  mode: Mode;
  modeLabel: string;
  status: 'active' | 'paused';
  status_reason: string;
  archived: boolean;
  lead_agent_id: string | null;
  team_id?: string | null;
  /** Teams (B2): the team this group belongs to, and whether bots of other teams may take part. */
  workspaceId?: string | null;
  workspaceName?: string | null;
  crossTeam?: boolean;
  foreignBots?: number;
  owner: { id: string; name: string };
  access: 'owner' | 'member' | 'guest' | null;
  bots: BotView[];
  people: PersonView[];
  last: { content: string; author_name: string; created_at: string } | null;
  instructions?: string;
  limits?: Record<string, any>;
  roomLimits?: Record<string, any>;
  defaults?: Record<string, any>;
  ledger?: { bots: { agentId: string; name: string; runs: number; tokens: number; cost: number; errors: number }[]; total: { tokens: number; cost: number; runs: number }; caps: { maxCostUsd: number; maxTokens: number } };
  activeRuns?: { id: string; agentId: string; status: string; kind: string }[];
  invited?: boolean;
  role?: string;
  updated_at: string;
}
const STATE_LABEL: Record<string, { label: string; tone: 'neutral' | 'ok' | 'warn' | 'danger' | 'accent' }> = {
  idle: { label: 'klaar', tone: 'neutral' },
  queued: { label: 'in wachtrij', tone: 'accent' },
  running: { label: 'bezig', tone: 'ok' },
  waiting: { label: 'wacht op jou', tone: 'warn' },
  paused: { label: 'gepauzeerd', tone: 'warn' },
  error: { label: 'fout', tone: 'danger' },
  timeout: { label: 'time-out', tone: 'danger' },
  limit: { label: 'daglimiet bereikt', tone: 'warn' },
};
/** A group member's state as the mood of its face (the state text stays in the tooltip/list next to it). */
function botMood(state: string, paused?: boolean): Mood {
  if (paused || state === 'paused') return 'paused';
  if (state === 'running' || state === 'queued') return 'working';
  if (state === 'waiting') return 'waiting';
  if (state === 'limit') return 'limit';
  if (state === 'error' || state === 'timeout') return 'error';
  return 'idle';
}

function useRooms() {
  const [rooms, setRooms] = useState<RoomView[] | null>(null);
  const [err, setErr] = useState('');
  const load = () =>
    api
      .get<RoomView[]>('/rooms')
      .then(setRooms)
      .catch((e) => setErr(e.message));
  useEffect(() => {
    load();
    return on('rooms.changed', () => load());
  }, []);
  return { rooms, err, reload: load };
}

/** Default limits for bot-to-bot work (also outside groups): depth, turns, and the asynchronous messages of ask_bot. */
const LIMIT_FIELDS: { key: string; label: string; hint: string; step?: number }[] = [
  { key: 'maxDelegationDepth', label: 'Max. ketendiepte', hint: 'A → B → C = 2. 0 = geen grens; -1 = bots geven elkaar geen werk.' },
  { key: 'maxTurnsPerMessage', label: 'Botbeurten per bericht', hint: 'Voor groepen, delegaties en vermeldingen. 0 = geen grens.' },
  { key: 'maxAskTurns', label: 'Botbeurten per keten met bot-berichten', hint: 'Eén keten met bot-berichten of bordtaken. 0 = geen grens.' },
  { key: 'maxAsksPerHour', label: 'Berichten per bot per uur', hint: 'Alle ontvangers samen. 0 = geen grens.' },
  { key: 'maxAsksPerPairPerHour', label: 'Berichten aan dezelfde bot per uur', hint: '0 = geen grens. Een echte lus zonder voortgang stopt TeamBot zelf.' },
  { key: 'maxChainCostUsd', label: 'Budget per keten (USD)', hint: 'Geschatte kosten; 0 = geen grens.', step: 0.5 },
  { key: 'maxChainTokens', label: 'Tokens per keten', hint: 'Telt ook abonnementen (Claude Code, Codex); 0 = geen grens.' },
];

function TeamLimitsModal({ open, onClose }: { open: boolean; onClose(): void }) {
  const [v, setV] = useState<Record<string, any> | null>(null);
  const { busy, run } = useAsync();
  useEffect(() => {
    if (open) api.get<Record<string, any>>('/rooms/defaults').then(setV).catch(toastError);
  }, [open]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Grenzen voor samenwerkende bots"
      footer={
        <Button variant="primary" loading={busy} disabled={!v} onClick={() => run(async () => (setV(await api.put('/rooms/defaults', v)), onClose()), 'Grenzen opgeslagen')}>
          Opslaan
        </Button>
      }
    >
      {!v ? (
        <Spinner />
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted">Gelden voor delegeren, berichten tussen bots en groepen zonder eigen instelling.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {LIMIT_FIELDS.map((f) => (
              <Field key={f.key} label={f.label} hint={f.hint}>
                <Input type="number" inputMode="decimal" min={f.key === 'maxDelegationDepth' ? -1 : 0} step={f.step || 1} value={v[f.key] ?? ''} onChange={(e) => setV({ ...v, [f.key]: e.target.value === '' ? '' : Number(e.target.value) })} />
              </Field>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Up to five faces of a group, overlapping; the rest as "+3". */
function Faces({ bots }: { bots: BotView[] }) {
  const shown = bots.slice(0, 5);
  return (
    <span className="flex shrink-0 items-center" title={bots.map((b) => b.name).join(', ')}>
      <span className="flex -space-x-1.5">
        {shown.map((b) => (
          <BotAvatar key={b.id} bot={{ id: b.agentId, name: b.name, avatar: b.avatar }} size={26} />
        ))}
      </span>
      {bots.length > shown.length && <span className="ms-1.5 text-xs font-medium tabular-nums text-muted">+{bots.length - shown.length}</span>}
    </span>
  );
}

function RoomsPage() {
  const { rooms, err, reload } = useRooms();
  const [open, setOpen] = useState(false);
  const [limits, setLimits] = useState(false);
  // "Grenzen" (how far bots may pass work on) is an expert setting: only with Instellingen › Geavanceerd tonen.
  const advanced = useAdvanced();
  const invites = (rooms || []).filter((r) => r.invited);
  const mine = (rooms || []).filter((r) => !r.invited);
  return (
    <Page>
      <PageHeader
        title="Groepschats"
        subtitle="Meerdere bots in één gesprek."
        back={{ href: '#/', label: 'Chats' }}
        actions={
          <>
            {advanced && <Menu label="Meer opties" items={[{ label: 'Grenzen', icon: <Settings2 />, onSelect: () => setLimits(true) }]} />}
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>
              Nieuwe groepschat
            </Button>
          </>
        }
      />
      <TeamLimitsModal open={limits} onClose={() => setLimits(false)} />
      <div className="mx-auto max-w-4xl space-y-4 px-4 pb-8 pt-3 sm:px-6">
        <ProposalsOnRoomsPage />
        {err && !rooms ? (
          <EmptyState icon={<Users />} title="De groepschats konden niet laden" action={<Button onClick={reload}>Opnieuw</Button>}>
            {err}
          </EmptyState>
        ) : !rooms ? (
          <SkeletonRows n={3} avatar={false} />
        ) : rooms.length === 0 ? (
          <Card>
            <EmptyState icon={<Users />} title="Nog geen groepschats" action={<Button variant="primary" onClick={() => setOpen(true)}>Eerste groepschat maken</Button>}>
              Zet een paar bots bij elkaar, bijvoorbeeld een schrijver en een redacteur.
            </EmptyState>
          </Card>
        ) : (
          <>
            {invites.map((r) => (
              <Card key={r.id} className="tb-in flex flex-wrap items-center gap-x-3 gap-y-2 p-4">
                <div className="min-w-0 flex-1 basis-56">
                  <div className="text-sm font-semibold [overflow-wrap:anywhere]">{r.name}</div>
                  <div className="text-[13px] text-muted">{r.role === 'guest' ? t('{0} nodigt je uit als gast', r.owner.name) : t('{0} nodigt je uit als lid', r.owner.name)}</div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => api.post(`/rooms/${r.id}/decline`).then(reload).catch(toastError)}>
                  Weigeren
                </Button>
                <Button size="sm" variant="primary" onClick={() => api.post(`/rooms/${r.id}/accept`).then(reload).catch(toastError)}>
                  Accepteren
                </Button>
              </Card>
            ))}
            {mine.length > 0 && (
              <Card className="overflow-visible">
                <ul className="divide-y divide-line">
                  {mine.map((r) => (
                    <li key={r.id} className="tb-in flex items-center gap-2 pe-3">
                      <a href={`#/t/${r.thread_id}`} className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-card py-3 ps-4 hover:bg-surface-2">
                        <span className="min-w-0 flex-1 basis-48">
                          <span className="block text-sm font-semibold [overflow-wrap:anywhere]">{r.name}</span>
                          <span className="block text-[13px] text-muted">
                            {/* Teams (B2): a group with bots of other teams says so. */}
                            {[r.modeLabel, r.access !== 'owner' && t('van {0}', r.owner.name), r.access === 'owner' && !!r.foreignBots && t('met bots van andere teams'), r.last && timeAgo(r.last.created_at)].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                        <Faces bots={r.bots} />
                        {r.status === 'paused' && <Badge tone="warn">Gestopt</Badge>}
                      </a>
                      {r.access === 'owner' && (
                        <Menu
                          label={t('Meer opties voor {0}', r.name)}
                          items={[
                            { label: 'Gesprek openen', icon: <ExternalLink />, href: `#/t/${r.thread_id}` },
                            { label: 'Instellingen', icon: <Settings2 />, href: `#/m/rooms/groep/${r.id}` },
                          ]}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </>
        )}
      </div>
      <NewRoomModal open={open} onClose={() => setOpen(false)} />
    </Page>
  );
}

function RoomSettingsPage({ params }: { params: string[] }) {
  const id = params[0];
  const agents = useApp((s) => s.agents);
  const [r, setR] = useState<RoomView | null>(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState<'algemeen' | 'bots' | 'bestanden' | 'mensen' | 'kosten'>(() => (query().get('tab') === 'bestanden' ? 'bestanden' : 'algemeen'));
  const [draft, setDraft] = useState<any>(null);
  const [addBot, setAddBot] = useState('');
  const [people, setPeople] = useState<{ id: string; name: string; email: string | null }[]>([]);
  const [invite, setInvite] = useState({ userId: '', role: 'member' });
  const a = useAsync();
  // Teams (B2): from the second team on, the group's team and its bots' teams show.
  const { teams } = useTeams();
  const multiTeams = (teams?.length || 0) > 1;
  const teamOfBot = (agentId: string) => teams?.find((t) => t.bots.some((b) => b.id === agentId)) || null;
  const load = () =>
    api
      .get<RoomView>(`/rooms/${id}`)
      .then((v) => {
        setR(v);
        setDraft({ name: v.name, mode: v.mode, lead_agent_id: v.lead_agent_id, team_id: v.team_id || '', instructions: v.instructions || '', maxCostUsd: String(v.limits?.maxCostUsd ?? ''), maxTurnsPerMessage: String(v.limits?.maxTurnsPerMessage ?? '') });
      })
      .catch((e) => setErr(e.message));
  useEffect(() => {
    load();
    api.get<any[]>('/rooms/people').then(setPeople).catch(() => {});
    return on('rooms.changed', (d: any) => (!d?.roomId || d.roomId === id) && load());
  }, [id]);
  if (err)
    return (
      <EmptyState icon={<Users />} title="Groepschat niet gevonden" action={<Button onClick={() => navigate('/m/rooms/')}>Naar Groepschats</Button>}>
        {err}
      </EmptyState>
    );
  if (!r || !draft)
    return (
      <div className="mx-auto max-w-3xl space-y-4 px-4 pt-8 sm:px-6">
        <Skeleton className="h-7 w-48" />
        <SkeletonRows n={3} avatar={false} />
      </div>
    );
  const save = () =>
    a.run(
      async () =>
        setR(
          await api.patch<RoomView>(`/rooms/${id}`, {
            name: draft.name,
            mode: draft.mode,
            leadAgentId: draft.lead_agent_id,
            teamId: draft.team_id || null,
            instructions: draft.instructions,
            limits: { maxCostUsd: Number(String(draft.maxCostUsd).replace(',', '.')) || 0, maxTurnsPerMessage: Number(draft.maxTurnsPerMessage) || undefined },
          }),
        ),
      'Opgeslagen',
    );
  const notIn = agents.filter((x) => !x.archived && !r.bots.some((b) => b.agentId === x.id));
  return (
    <Page>
      <PageHeader
        width="3xl"
        title={r.name}
        subtitle={r.status === 'paused' ? t('{0} · gestopt', r.modeLabel) : r.modeLabel}
        back={{ href: `#/t/${r.thread_id}`, label: 'Naar de groepschat' }}
        actions={
          <>
            <Menu
              label="Meer opties"
              items={[
                r.status === 'paused'
                  ? { label: 'Hervatten', icon: <Play />, onSelect: () => void api.post(`/rooms/${id}/resume`, { continue: false }).then(load).catch(toastError) }
                  : { label: 'Alle bots stoppen', icon: <CircleStop />, onSelect: () => void api.post(`/rooms/${id}/stop`, {}).then(load).catch(toastError) },
                'sep',
                r.access === 'owner' && { label: 'Exporteren als team', icon: <Download />, href: authUrl(`/rooms/${id}/package`) },
                { label: 'Gesprek exporteren', icon: <Download />, href: authUrl(`/rooms/${id}/export?format=md`) },
                'sep',
                {
                  label: 'Groepschat verwijderen',
                  icon: <Trash2 />,
                  danger: true,
                  onSelect: async () => {
                    const from = location.hash;
                    if (!(await askConfirm('Deze groepschat verwijderen? De bots zelf blijven bestaan.', { ok: 'Verwijderen', danger: true }))) return;
                    await api.del(`/rooms/${id}`).then(() => (useApp.getState().refreshThreads(), navigate('/m/rooms/', { from }))).catch(toastError);
                  },
                },
              ]}
            />
            <Button icon={<ExternalLink className="h-4 w-4" />} onClick={() => navigate(`/t/${r.thread_id}`)}>
              Naar gesprek
            </Button>
          </>
        }
      />
      <div className="mx-auto max-w-3xl px-4 sm:px-6">
        {r.status === 'paused' && r.status_reason && <div className="mt-4 rounded-control bg-warn-soft px-3 py-2 text-sm text-warn">Gestopt: {r.status_reason}</div>}
        <Tabs
          value={tab}
          onChange={(v) => setTab(v as any)}
          tabs={[
            { id: 'algemeen', label: 'Algemeen' },
            { id: 'bots', label: `Bots (${r.bots.length})` },
            { id: 'bestanden', label: 'Bestanden' },
            // Other people only exist on a shared server; on your own computer the tab stays away.
            ...(people.length || r.people.length ? [{ id: 'mensen' as const, label: `Mensen (${r.people.length})` }] : []),
            { id: 'kosten', label: 'Kosten' },
          ]}
        />
        <div className="space-y-4 py-4">
          {tab === 'algemeen' && (
            <Card className="space-y-4 p-5">
              <Field label="Naam">
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </Field>
              <Field label="Werkwijze" hint={MODES.find((m) => m.id === draft.mode)?.text}>
                <Select value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value })}>
                  {MODES.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </Select>
              </Field>
              {draft.mode === 'lead' && (
                <Field label="Lead-bot">
                  <Select value={draft.lead_agent_id || ''} onChange={(e) => setDraft({ ...draft, lead_agent_id: e.target.value })}>
                    {r.bots.map((b) => (
                      <option key={b.agentId} value={b.agentId}>
                        {b.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              {r.access === 'owner' && <RoomTeamField value={draft.team_id} onChange={(v) => setDraft({ ...draft, team_id: v })} />}
              <Field label="Groepsinstructies">
                <Textarea rows={3} className="[field-sizing:content] max-h-80" value={draft.instructions} onChange={(e) => setDraft({ ...draft, instructions: e.target.value })} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Kostenplafond (USD)" hint="0 = geen plafond.">
                  <Input inputMode="decimal" value={draft.maxCostUsd} onChange={(e) => setDraft({ ...draft, maxCostUsd: e.target.value })} />
                </Field>
                <Field label="Max. beurten per bericht">
                  <Input inputMode="numeric" value={draft.maxTurnsPerMessage} onChange={(e) => setDraft({ ...draft, maxTurnsPerMessage: e.target.value })} />
                </Field>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" loading={a.busy} onClick={save}>
                  Opslaan
                </Button>
              </div>
            </Card>
          )}
          {tab === 'bots' && (
            <Card className="space-y-3 p-5">
              {multiTeams && r.access === 'owner' && r.workspaceName && (
                <div className="space-y-1 rounded-control border border-line bg-surface-2 p-3 text-sm">
                  <Toggle checked={!!r.crossTeam} onChange={(v) => api.patch(`/rooms/${id}`, { crossTeam: v }).then(load).catch(toastError)} label="Bots van andere teams toestaan" />
                  <p className="text-[13px] text-muted">
                    {t('Deze groep hoort bij team {0}.', r.workspaceName)} <MoreInfo>Alleen bots die bij dit team mogen meekijken of aansturen (Instellingen › Teams).</MoreInfo>
                  </p>
                </div>
              )}
              <ul className="divide-y divide-line">
                {r.bots.map((b) => {
                  const setPerms = (perms: Partial<BotView['perms']>) => void api.patch(`/rooms/${id}/bots/${b.agentId}`, { perms: { ...b.perms, ...perms } }).then(load).catch(toastError);
                  const state = b.paused ? { label: 'gepauzeerd', tone: 'warn' as const } : STATE_LABEL[b.state] || { label: b.state, tone: 'neutral' as const };
                  const foreign = multiTeams && b.teamReach && b.teamReach !== 'home';
                  return (
                    <li key={b.id} className="tb-in flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                      <BotAvatar bot={{ id: b.agentId, name: b.name, avatar: b.avatar }} size={32} mood={botMood(b.state, b.paused)} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold">
                          <span className="min-w-0 [overflow-wrap:anywhere]">{b.name}</span>
                          {b.lead && <Badge tone="accent">lead</Badge>}
                          {foreign && (
                            <Badge tone={b.teamReach === 'none' ? 'danger' : 'warn'}>
                              <span translate="no">{b.homeTeamName}</span> · {b.teamReach === 'none' ? 'geen toegang' : b.teamReach === 'direct' ? 'aansturen' : 'meekijken'}
                            </Badge>
                          )}
                        </div>
                        <div className="text-[13px] text-muted [overflow-wrap:anywhere]">
                          {[b.perms.respond === 'mention' ? t('alleen op @naam') : null, b.perms.files === 'write' ? t('schrijft bestanden') : b.perms.files === 'read' ? t('leest bestanden') : null, b.perms.delegate ? t('mag delegeren') : null, b.stateDetail].filter(Boolean).join(' · ') || b.title || b.model}
                        </div>
                      </div>
                      {state.label !== 'klaar' && <Badge tone={state.tone}>{state.label}</Badge>}
                      <Menu
                        label={t('Meer opties voor {0}', b.name)}
                        items={[
                          { heading: 'Antwoordt' },
                          { label: 'Volgens de werkwijze', checked: b.perms.respond === 'auto', onSelect: () => setPerms({ respond: 'auto' }) },
                          { label: 'Alleen op @naam', checked: b.perms.respond === 'mention', onSelect: () => setPerms({ respond: 'mention' }) },
                          { heading: 'Groepsbestanden' },
                          { label: 'Geen', checked: b.perms.files === 'none', onSelect: () => setPerms({ files: 'none' }) },
                          { label: 'Lezen', checked: b.perms.files === 'read', onSelect: () => setPerms({ files: 'read' }) },
                          { label: 'Lezen en schrijven', checked: b.perms.files === 'write', onSelect: () => setPerms({ files: 'write' }) },
                          'sep',
                          { label: 'Mag delegeren', checked: b.perms.delegate, onSelect: () => setPerms({ delegate: !b.perms.delegate }) },
                          { label: b.paused ? 'Hervatten' : 'Pauzeren', icon: b.paused ? <Play /> : <CircleStop />, onSelect: () => void api.post(b.paused ? `/rooms/${id}/resume` : `/rooms/${id}/stop`, { agentId: b.agentId }).then(load).catch(toastError) },
                          { label: 'Uit de groep halen', icon: <X />, danger: true, onSelect: () => void api.del(`/rooms/${id}/bots/${b.agentId}`).then(load).catch(toastError) },
                        ]}
                      />
                    </li>
                  );
                })}
              </ul>
              {notIn.length > 0 && (
                <div className="flex flex-wrap gap-2 border-t border-line pt-3">
                  <Select className="min-w-0 flex-1 basis-48" value={addBot} onChange={(e) => setAddBot(e.target.value)} aria-label="Bot toevoegen">
                    <option value="">Bot toevoegen…</option>
                    {notIn.map((x) => {
                      const home = multiTeams ? teamOfBot(x.id) : null;
                      return (
                        <option key={x.id} value={x.id}>
                          {home && home.id !== r.workspaceId ? `${x.name} (${home.name})` : x.name}
                        </option>
                      );
                    })}
                  </Select>
                  <Button disabled={!addBot} onClick={() => api.post(`/rooms/${id}/bots`, { agentId: addBot }).then(() => (setAddBot(''), load())).catch(toastError)}>
                    Toevoegen
                  </Button>
                </div>
              )}
            </Card>
          )}
          {tab === 'mensen' && (
            <Card className="space-y-3 p-5">
              {r.people.length === 0 && (
                <p className="text-sm text-muted">
                  Nog niemand uitgenodigd. <MoreInfo>Leden praten mee en zien het takenbord; gasten zien alleen deze groep.</MoreInfo>
                </p>
              )}
              {r.people.map((p) => {
                const uid = (p as any).userId || (p as any).refId || p.ref_id;
                return (
                  <div key={p.id} className="flex items-center gap-2 text-sm">
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{p.name}</span>
                    <Badge>{p.role === 'guest' ? 'gast' : 'lid'}</Badge>
                    {!p.accepted && <Badge tone="warn">uitgenodigd</Badge>}
                    <Button size="sm" variant="ghost" onClick={() => api.del(`/rooms/${id}/people/${uid}`).then(load).catch(toastError)}>
                      Verwijderen
                    </Button>
                  </div>
                );
              })}
              {people.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  <Select className="min-w-0 flex-1" value={invite.userId} onChange={(e) => setInvite({ ...invite, userId: e.target.value })} aria-label="Gebruiker">
                    <option value="">Kies iemand…</option>
                    {people.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} {p.email ? `(${p.email})` : ''}
                      </option>
                    ))}
                  </Select>
                  <Select className="w-32" value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })} aria-label="Rol">
                    <option value="member">Lid</option>
                    <option value="guest">Gast</option>
                  </Select>
                  <Button icon={<UserPlus className="h-4 w-4" />} disabled={!invite.userId} onClick={() => api.post(`/rooms/${id}/people`, invite).then(() => (setInvite({ userId: '', role: 'member' }), load(), toast('Uitnodiging verstuurd', 'ok'))).catch(toastError)}>
                    Uitnodigen
                  </Button>
                </div>
              ) : (
                <p className="text-[13px] text-muted">Er zijn geen andere gebruikers op deze server.</p>
              )}
            </Card>
          )}
          {tab === 'bestanden' && <RoomFiles roomId={id} manage />}
          {tab === 'kosten' && r.ledger && (
            <Card className="space-y-3 p-5">
              <div className="flex flex-wrap gap-6 text-sm">
                <div>
                  <div className="text-xs text-muted">Totaal</div>
                  <div className="text-xl font-semibold">{formatUsd(r.ledger.total.cost)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted">Tokens</div>
                  <div className="text-xl font-semibold">{r.ledger.total.tokens.toLocaleString(uiLocale())}</div>
                </div>
                <div>
                  <div className="text-xs text-muted">Plafond</div>
                  <div className="text-xl font-semibold">{r.ledger.caps.maxCostUsd ? formatUsd(r.ledger.caps.maxCostUsd) : 'geen'}</div>
                </div>
              </div>
              <div className="divide-y divide-line">
                {r.ledger.bots.map((b) => (
                  <div key={b.agentId} className="flex justify-between py-1.5 text-sm">
                    <span>
                      {b.name} <span className="text-muted">· {t('{0, plural, one {# beurt} other {# beurten}}', b.runs)}{b.errors ? ` · ${t('{0, plural, one {# fout} other {# fouten}}', b.errors)}` : ''}</span>
                    </span>
                    <span className="text-muted">{formatUsd(b.cost)}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    </Page>
  );
}

/**
 * The old link #/m/rooms/taken (Groepen › Takenbord, palette, notifications of older versions): the one task board of
 * TeamBot 0.4 (pages/Tasks.tsx, #/tasks), which shows these tasks together with the team database's.
 */
function TaskBoardPage() {
  return <TasksPage />;
}

// ---------------------------------------------------------------- chat extension points

function useRoomForThread(threadId: string) {
  const [info, setInfo] = useState<{ room: RoomView | null; isMain: boolean; delegation: any } | null>(null);
  const kind = useApp((s) => s.threads.find((t) => t.id === threadId)?.kind);
  useEffect(() => {
    if (kind !== 'room' && kind !== 'delegation') return setInfo(null);
    const load = () => api.get<any>(`/rooms/by-thread/${threadId}`).then(setInfo).catch(() => setInfo(null));
    load();
    const off1 = on('rooms.changed', load);
    const off2 = on('rooms.member', load);
    return () => (off1(), off2());
  }, [threadId, kind]);
  return info;
}

function RoomHeaderAction({ threadId }: { threadId: string }) {
  const info = useRoomForThread(threadId);
  if (!info?.room) return null;
  const r = info.room;
  const busy = r.bots.filter((b) => ['running', 'queued', 'waiting'].includes(b.state)).length;
  return (
    <div className="flex items-center gap-1">
      <div className="hidden -space-x-1.5 sm:flex" title={r.bots.map((b) => `${b.name}: ${STATE_LABEL[b.state]?.label || b.state}`).join('\n')}>
        {r.bots.slice(0, 5).map((b) => (
          <span key={b.id}>
            <BotAvatar bot={{ id: b.agentId, name: b.name, avatar: b.avatar }} size={26} mood={botMood(b.state, b.paused)} />
          </span>
        ))}
      </div>
      {busy > 0 && (
        <Button variant="ghost" size="icon" aria-label="Hele groep stoppen" title="Hele groep stoppen" onClick={() => api.post(`/rooms/${r.id}/stop`, {}).catch(toastError)}>
          <CircleStop className="h-4 w-4 text-danger" />
        </Button>
      )}
      {r.access === 'owner' && (
        <Button variant="ghost" size="icon" aria-label="Groepschat instellen" title="Groepschat instellen" onClick={() => navigate(`/m/rooms/groep/${r.id}`)}>
          <Users className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

function MentionAction({ threadId, insertText }: { threadId: string; agentId: string | null; insertText(t: string): void }) {
  const info = useRoomForThread(threadId);
  const [open, setOpen] = useState(false);
  if (!info?.room || !info.isMain) return null;
  return (
    <div className="relative">
      <Button variant="ghost" size="icon" aria-label="Iemand aanspreken (@)" title="Iemand aanspreken (@)" onClick={() => setOpen(!open)}>
        <AtSign className="h-4 w-4" />
      </Button>
      {open && (
        <div className="absolute bottom-11 end-0 z-20 w-56 rounded-xl border border-line bg-surface p-1 shadow-lg">
          {[{ name: 'iedereen', avatar: '👥', color: '#64748b', id: 'all' }, ...info.room.bots].map((b: any) => (
            <button
              key={b.id}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start text-sm hover:bg-surface-2"
              onClick={() => {
                insertText(`@${b.name.includes(' ') ? `"${b.name}"` : b.name} `);
                setOpen(false);
              }}
            >
              <BotAvatar bot={{ id: b.agentId, name: b.name, avatar: b.avatar }} size={24} />
              {b.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TeamInspectorTab({ threadId }: { threadId: string }) {
  const info = useRoomForThread(threadId);
  const [dels, setDels] = useState<any[] | null>(null);
  useEffect(() => {
    const load = () => api.get<any[]>(`/rooms/delegations?threadId=${threadId}`).then(setDels).catch(() => setDels([]));
    load();
    return on('rooms.delegation', load);
  }, [threadId]);
  return (
    <div className="space-y-4 text-sm">
      {info?.room ? (
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Leden</div>
          <div className="space-y-1.5">
            {info.room.bots.map((b) => (
              <div key={b.id} className="flex items-center gap-2">
                <BotAvatar bot={{ id: b.agentId, name: b.name, avatar: b.avatar }} size={26} mood={botMood(b.state, b.paused)} />
                <span className="min-w-0 flex-1 truncate">{b.name}</span>
                {b.lead && <Badge tone="accent">lead</Badge>}
                <Badge tone={STATE_LABEL[b.state]?.tone || 'neutral'}>{b.paused ? 'gepauzeerd' : STATE_LABEL[b.state]?.label || b.state}</Badge>
              </div>
            ))}
          </div>
        </div>
      ) : info?.delegation ? (
        <div className="rounded-lg border border-line p-3">
          <div className="font-medium">{t('Subtaak van {0} voor {1}', info.delegation.fromName, info.delegation.toName)}</div>
          <div className="text-xs text-muted">{info.delegation.statusLabel}</div>
        </div>
      ) : null}
      {info?.room && (
        <div>
          <div className="mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-muted">
            Groepsbestanden
            <a className="font-medium normal-case tracking-normal text-accent underline" href={`#/m/rooms/groep/${info.room.id}?tab=bestanden`}>
              Beheren
            </a>
          </div>
          <RoomFiles roomId={info.room.id} />
        </div>
      )}
      <div>
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Delegaties</div>
        {!dels ? (
          <Spinner />
        ) : dels.length === 0 ? (
          <p className="text-muted">Nog niets gedelegeerd in dit gesprek.</p>
        ) : (
          <ul className="space-y-1.5">
            {dels.map((d) => (
              <li key={d.id} className="rounded-lg border border-line p-2">
                <div className="flex items-center gap-2">
                  <GitFork className="h-3.5 w-3.5 text-muted" />
                  <span className="min-w-0 flex-1 truncate">
                    {d.fromName} → {d.toName}
                    {d.kind === 'ask' ? ' (bericht)' : ''}
                  </span>
                  <Badge tone={d.status === 'done' ? 'ok' : d.status === 'error' || d.status === 'cancelled' ? 'danger' : 'accent'}>{d.statusLabel}</Badge>
                </div>
                {d.task && (
                  <div className="mt-1 line-clamp-2 text-xs text-muted" translate="no">
                    {d.task}
                  </div>
                )}
                <div className="mt-0.5 flex items-center gap-3 text-xs">
                  {d.threadExists && (
                    <a className="text-accent underline" href={`#/t/${d.thread_id}`}>
                      {d.kind === 'ask' ? `Chat van ${d.toName}` : 'Subgesprek bekijken'}
                    </a>
                  )}
                  <CancelDelegation d={d} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const OPEN_DELEGATION = ['queued', 'running'];

/** Withdraw an open request (ask_bot, delegate_task, message_bot): the bot is not woken for it. */
function CancelDelegation({ d }: { d: any }) {
  const { busy, run } = useAsync();
  if (!OPEN_DELEGATION.includes(d.status)) return null;
  return (
    <button
      className="inline-flex items-center gap-0.5 text-danger hover:underline disabled:opacity-50"
      disabled={busy}
      title={d.kind === 'ask' ? 'Bericht intrekken' : 'Subtaak stoppen'}
      aria-label={d.kind === 'ask' ? `Bericht aan ${d.toName} intrekken` : `Subtaak van ${d.toName} stoppen`}
      onClick={() => run(() => api.post(`/rooms/delegations/${d.id}/cancel`, {}), d.kind === 'ask' ? 'Bericht ingetrokken' : 'Subtaak gestopt')}
    >
      <X className="h-3 w-3" /> {d.kind === 'ask' ? 'intrekken' : 'stoppen'}
    </button>
  );
}

function DelegationCard({ call }: { call: { id: string; name: string; args: any } }) {
  const [d, setD] = useState<any[] | null>(null);
  useEffect(() => {
    const load = () => api.get<any[]>(`/rooms/delegations/by-call/${call.id}`).then(setD).catch(() => setD([]));
    load();
    return on('rooms.delegation', load);
  }, [call.id]);
  if (!d?.length) return null;
  return (
    <div className="space-y-1">
      {d.map((x) => (
        <div key={x.id} className="space-y-0.5">
          <div className="flex items-center gap-2 text-xs">
            <GitFork className="h-3.5 w-3.5 text-muted" />
            <span className="min-w-0 flex-1 truncate">
              {/* What one bot asked another is that bot's words: never translated, also not in part ("Read alle oude berichten na"). */}
              {x.kind === 'ask' ? t('{0} vroeg {1}', x.fromName, x.toName) : `${x.fromName} → ${x.toName}`}: <span translate="no">{x.task}</span>
            </span>
            {x.check && (x.check.state === 'review' || x.check.state === 'cant') ? <CheckBadge state={x.check.state} /> : <Badge tone={x.status === 'done' ? 'ok' : x.status === 'error' || x.status === 'cancelled' || x.status === 'timeout' ? 'danger' : 'accent'}>{x.statusLabel}</Badge>}
            <CancelDelegation d={x} />
            {x.threadExists && (
              <a className="text-accent underline" href={`#/t/${x.thread_id}`}>
                open
              </a>
            )}
          </div>
          {x.kind === 'ask' && x.status === 'done' && x.result && (
            <div className="line-clamp-2 ps-5 text-xs text-muted">
              {x.toName} antwoordde: <span translate="no">{x.result}</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function AgentRoomsSection({ agent }: { agent: Agent }) {
  const { rooms } = useRooms();
  const mine = useMemo(() => (rooms || []).filter((r) => r.bots?.some((b) => b.agentId === agent.id)), [rooms, agent.id]);
  if (!agent.id) return <p className="text-sm text-muted">Sla de bot eerst op; daarna kun je hem aan groepschats toevoegen.</p>;
  return mine.length === 0 ? (
    <p className="text-sm text-muted">
      Deze bot zit nog in geen enkele groepschat.{' '}
      <a className="underline" href="#/m/rooms/">
        Groepschat maken
      </a>
    </p>
  ) : (
    <ul className="space-y-1 text-sm">
      {mine.map((r) => (
        <li key={r.id} className="flex items-center gap-2">
          <a className="min-w-0 flex-1 truncate underline" href={`#/t/${r.thread_id}`}>
            {r.name}
          </a>
          <Badge>{r.bots.find((b) => b.agentId === agent.id)?.lead ? 'lead' : 'lid'}</Badge>
        </li>
      ))}
    </ul>
  );
}

const mod: UIModule = {
  id: 'rooms',
  label: 'Groepschats',
  pages: [
    { path: '', title: 'Groepschats', icon: Users, nav: true, component: RoomsPage },
    { path: 'taken', title: 'Takenbord', icon: ClipboardList, component: TaskBoardPage },
    { path: 'organisatie', title: 'Organisatie', icon: Building2, component: OrgPage },
    { path: 'groep', title: 'Groep', component: RoomSettingsPage },
  ],
  chatHeaderActions: [RoomHeaderAction],
  composerActions: [MentionAction],
  inspectorTabs: [{ id: 'team', title: 'Team', component: TeamInspectorTab }],
  agentSections: [{ id: 'rooms', title: 'Groepschats', component: AgentRoomsSection }],
  toolRenderers: { delegate_task: DelegationCard, broadcast: DelegationCard, ask_bot: DelegationCard, message_bot: DelegationCard },
  // A lead's proposal to add a member: a card in the group chat and in Wacht op jou (approve or decline right there).
  eventRenderers: { proposal: ProposalEvent },
  inbox: { useCount: useProposalCount, component: ProposalsInbox },
  init: () => initProposals(),
};
export default mod;
