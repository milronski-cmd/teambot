import { useEffect, useMemo, useState } from 'react';
import { Building2, MessagesSquare, Pencil, Plus, Trash2, UserPlus, X } from 'lucide-react';
import { api, on } from '../../lib/api';
import { useApp } from '../../lib/store';
import { navigate } from '../../lib/router';
import { askConfirm, Button, Card, EmptyState, Field, Input, Modal, Page, PageHeader, Select, Spinner, Textarea, cx, toast, toastError } from '../../components/ui';
import { BotAvatar } from '../../components/BotFace';

/**
 * Organisatie (A-60, TEAM-06): teams as departments in a tree, each with a chief of staff, members with a title and
 * who they report to, and the groups that work for the team. Bots in a group of a team get this org chart in their
 * instructions, so the chief knows who does what and a member knows whom to ask.
 */
export interface TeamMember {
  id: string;
  agent_id: string;
  role: 'chief' | 'lead' | 'member';
  title: string;
  reports_to: string | null;
  reportsToName: string | null;
  name: string;
  avatar: string;
}
export interface TeamView {
  id: string;
  name: string;
  description: string;
  parent_id: string | null;
  chief_agent_id: string | null;
  chiefName: string | null;
  members: TeamMember[];
  rooms: { id: string; name: string; thread_id: string; archived: number | boolean }[];
}

const ROLE_LABEL: Record<TeamMember['role'], string> = { chief: 'Chief of staff', lead: 'Lead', member: 'Lid' };

export function useTeams() {
  const [teams, setTeams] = useState<TeamView[] | null>(null);
  const [err, setErr] = useState('');
  const load = () =>
    api
      .get<TeamView[]>('/rooms/teams')
      .then((t) => (setTeams(t), setErr('')))
      .catch((e) => setErr(e.message));
  useEffect(() => {
    load();
    const a = on('rooms.team', () => load());
    const b = on('rooms.changed', () => load());
    return () => (a(), b());
  }, []);
  return { teams, err, reload: load };
}

/** Teams in tree order (a department right under its parent), with their depth. */
function treeOrder(teams: TeamView[]): { t: TeamView; depth: number }[] {
  const ids = new Set(teams.map((t) => t.id));
  const kids = new Map<string | null, TeamView[]>();
  for (const t of teams) {
    const parent = t.parent_id && ids.has(t.parent_id) ? t.parent_id : null;
    kids.set(parent, [...(kids.get(parent) || []), t]);
  }
  const out: { t: TeamView; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const t of kids.get(parent) || []) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push({ t, depth });
      walk(t.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** All teams below `id` (they cannot become its parent). */
function descendants(teams: TeamView[], id: string): Set<string> {
  const out = new Set<string>([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of teams) if (t.parent_id && out.has(t.parent_id) && !out.has(t.id)) (out.add(t.id), (grew = true));
  }
  return out;
}

function TeamModal({ team, teams, parentId, onClose }: { team: TeamView | null; teams: TeamView[]; parentId?: string | null; onClose(): void }) {
  const agents = useApp((s) => s.agents).filter((a) => !a.archived);
  const [name, setName] = useState(team?.name || '');
  const [description, setDescription] = useState(team?.description || '');
  const [parent, setParent] = useState(team?.parent_id || parentId || '');
  const [chief, setChief] = useState(team?.chief_agent_id || '');
  const [members, setMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const blocked = team ? descendants(teams, team.id) : new Set<string>();
  const save = async () => {
    if (!name.trim()) return toast('Geef de afdeling een naam.', 'danger');
    setBusy(true);
    try {
      if (team) await api.patch(`/rooms/teams/${team.id}`, { name: name.trim(), description, parentId: parent || null, chiefAgentId: chief || null });
      else await api.post('/rooms/teams', { name: name.trim(), description, parentId: parent || undefined, chiefAgentId: chief || undefined, agentIds: members });
      toast(team ? 'Afdeling opgeslagen' : 'Afdeling gemaakt');
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={team ? `${team.name} bewerken` : 'Nieuwe afdeling'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuleren
          </Button>
          <Button variant="primary" loading={busy} onClick={save}>
            {team ? 'Opslaan' : 'Afdeling maken'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Naam">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Bijvoorbeeld Marketing" />
        </Field>
        <Field label="Waar deze afdeling voor is" hint="De bots in de groepen van deze afdeling lezen dit mee.">
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Valt onder" hint="Zet hem onder een andere afdeling, of laat hem bovenaan staan.">
          <Select value={parent} onChange={(e) => setParent(e.target.value)}>
            <option value="">Niets (bovenaan)</option>
            {teams
              .filter((t) => !blocked.has(t.id))
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Chief of staff" hint="Deze bot houdt het overzicht, verdeelt het werk en mag nieuwe leden voorstellen.">
          <Select value={chief} onChange={(e) => setChief(e.target.value)}>
            <option value="">Nog niemand</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        {!team && (
          <Field label="Leden" hint="Ze rapporteren aan de chief of staff; je past dit later per lid aan.">
            <div className="flex flex-wrap gap-2" role="group" aria-label="Leden kiezen">
              {agents
                .filter((a) => a.id !== chief)
                .map((a) => {
                  const on = members.includes(a.id);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setMembers(on ? members.filter((x) => x !== a.id) : [...members, a.id])}
                      className={cx('flex items-center gap-2 rounded-full border py-1 pe-3 ps-1 text-sm', on ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2')}
                    >
                      <BotAvatar bot={a} size={24} />
                      {a.name}
                    </button>
                  );
                })}
              {agents.length === 0 && <span className="text-sm text-muted">Je hebt nog geen bots.</span>}
            </div>
          </Field>
        )}
      </div>
    </Modal>
  );
}

function MemberRow({ team, m }: { team: TeamView; m: TeamMember }) {
  const [title, setTitle] = useState(m.title);
  useEffect(() => setTitle(m.title), [m.title]);
  const put = (patch: Partial<{ role: string; title: string; reportsTo: string | null }>) =>
    api.put(`/rooms/teams/${team.id}/members`, { agentId: m.agent_id, role: m.role, title: m.title, reportsTo: m.reports_to, ...patch }).catch(toastError);
  return (
    <li className="grid gap-2 rounded-xl border border-line p-2.5 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center">
      <div className="flex min-w-0 items-center gap-2.5">
        <BotAvatar bot={{ id: m.agent_id, name: m.name, avatar: m.avatar }} size={34} />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{m.name}</div>
          <Input
            className="mt-0.5 h-7 text-xs"
            value={title}
            placeholder="Functie, bijvoorbeeld Copywriter"
            aria-label={`Functie van ${m.name}`}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title !== m.title && put({ title })}
          />
        </div>
      </div>
      <Select className="h-8 text-xs" value={m.role} aria-label={`Rol van ${m.name}`} onChange={(e) => put({ role: e.target.value })}>
        {(Object.keys(ROLE_LABEL) as TeamMember['role'][]).map((r) => (
          <option key={r} value={r}>
            {ROLE_LABEL[r]}
          </option>
        ))}
      </Select>
      <Select className="h-8 text-xs" value={m.reports_to || ''} aria-label={`${m.name} rapporteert aan`} onChange={(e) => put({ reportsTo: e.target.value || null })}>
        <option value="">Rapporteert aan niemand</option>
        {team.members
          .filter((x) => x.agent_id !== m.agent_id)
          .map((x) => (
            <option key={x.agent_id} value={x.agent_id}>
              Rapporteert aan {x.name}
            </option>
          ))}
      </Select>
      <Button size="iconSm" variant="ghost" aria-label={`${m.name} uit het team halen`} onClick={() => api.del(`/rooms/teams/${team.id}/members/${m.agent_id}`).catch(toastError)}>
        <X className="h-4 w-4" />
      </Button>
    </li>
  );
}

function TeamCard({ team, depth, teams, onEdit, onSub }: { team: TeamView; depth: number; teams: TeamView[]; onEdit(): void; onSub(): void }) {
  const agents = useApp((s) => s.agents).filter((a) => !a.archived);
  const [add, setAdd] = useState('');
  const [busy, setBusy] = useState(false);
  const parent = teams.find((t) => t.id === team.parent_id);
  const outside = agents.filter((a) => !team.members.some((m) => m.agent_id === a.id));
  const rooms = team.rooms.filter((r) => !r.archived);
  const chiefFirst = [...team.members].sort((a, b) => (a.role === 'chief' ? -1 : b.role === 'chief' ? 1 : 0));
  const addMember = () =>
    add &&
    api
      .put(`/rooms/teams/${team.id}/members`, { agentId: add, role: 'member', reportsTo: team.chief_agent_id || null })
      .then(() => setAdd(''))
      .catch(toastError);
  const newGroup = async () => {
    if (!team.members.length) return toast('Voeg eerst bots aan de afdeling toe.', 'danger');
    setBusy(true);
    try {
      const r = await api.post<{ threadId: string }>(`/rooms/teams/${team.id}/room`, {});
      await useApp.getState().refreshThreads();
      navigate(`/t/${r.threadId}`);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!(await askConfirm(`Afdeling “${team.name}” verwijderen? De bots, groepen en taken blijven bestaan; afdelingen eronder komen bovenaan.`, { ok: 'Verwijderen', danger: true }))) return;
    api.del(`/rooms/teams/${team.id}`).catch(toastError);
  };
  return (
    <Card className="space-y-3 p-4" style={{ marginInlineStart: Math.min(depth, 4) * 24 }}>
      <div className="flex flex-wrap items-start gap-2">
        <Building2 className="mt-0.5 h-5 w-5 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">{team.name}</h2>
          <div className="text-xs text-muted">
            {parent ? `Afdeling van ${parent.name}` : 'Bovenaan'}
            {team.chiefName ? ` · chief of staff: ${team.chiefName}` : ' · nog geen chief of staff'}
          </div>
          {team.description && <p className="mt-1 text-sm text-muted">{team.description}</p>}
        </div>
        <div className="flex gap-1">
          <Button size="iconSm" variant="ghost" aria-label={`${team.name} bewerken`} onClick={onEdit}>
            <Pencil className="h-4 w-4" />
          </Button>
          <Button size="iconSm" variant="ghost" aria-label={`${team.name} verwijderen`} onClick={remove}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {chiefFirst.length > 0 ? (
        <ul className="space-y-2" aria-label={`Leden van ${team.name}`}>
          {chiefFirst.map((m) => (
            <MemberRow key={m.agent_id} team={team} m={m} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">Nog geen leden.</p>
      )}
      {outside.length > 0 && (
        <div className="flex gap-2">
          <Select className="min-w-0 flex-1" value={add} onChange={(e) => setAdd(e.target.value)} aria-label={`Bot toevoegen aan ${team.name}`}>
            <option value="">Bot toevoegen…</option>
            {outside.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
          <Button icon={<UserPlus className="h-4 w-4" />} disabled={!add} onClick={addMember}>
            Toevoegen
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        {rooms.map((r) => (
          <a key={r.id} href={`#/t/${r.thread_id}`} className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-xs hover:bg-surface-3">
            <MessagesSquare className="h-3.5 w-3.5" aria-hidden /> {r.name}
          </a>
        ))}
        <Button size="sm" loading={busy} icon={<MessagesSquare className="h-3.5 w-3.5" />} onClick={newGroup}>
          Groepsgesprek met deze afdeling
        </Button>
        <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={onSub}>
          Afdeling eronder
        </Button>
      </div>
    </Card>
  );
}

export function OrgPage() {
  const { teams, err } = useTeams();
  const [edit, setEdit] = useState<{ team: TeamView | null; parentId?: string | null } | null>(null);
  const ordered = useMemo(() => treeOrder(teams || []), [teams]);
  return (
    <Page>
      <PageHeader
        width="4xl"
        title="Organisatie"
        subtitle="Zet je bots in afdelingen, met functies en wie aan wie rapporteert."
        actions={
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEdit({ team: null })}>
            Nieuwe afdeling
          </Button>
        }
      />
      <div className="mx-auto max-w-4xl space-y-3 px-4 py-4 sm:px-6">
        {err && <p className="text-sm text-danger">{err}</p>}
        {!teams ? (
          <Spinner />
        ) : teams.length === 0 ? (
          <Card>
            <EmptyState icon={<Building2 className="h-6 w-6" />} title="Nog geen afdelingen" action={<Button variant="primary" onClick={() => setEdit({ team: null })}>Eerste afdeling maken</Button>}>
              Bijvoorbeeld “Marketing” met een copywriter en een ontwerper.
            </EmptyState>
          </Card>
        ) : (
          ordered.map(({ t, depth }) => <TeamCard key={t.id} team={t} depth={depth} teams={teams} onEdit={() => setEdit({ team: t })} onSub={() => setEdit({ team: null, parentId: t.id })} />)
        )}
      </div>
      {edit && teams && <TeamModal team={edit.team} teams={teams} parentId={edit.parentId} onClose={() => setEdit(null)} />}
    </Page>
  );
}

/** "Hoort bij afdeling" on the group's settings page. */
export function RoomTeamField({ value, onChange }: { value: string; onChange(v: string): void }) {
  const { teams } = useTeams();
  if (!teams || teams.length === 0)
    return (
      <p className="text-xs text-muted">
        Afdelingen maak je in{' '}
        <a className="underline" href="#/m/rooms/organisatie">
          Organisatie
        </a>
        .
      </p>
    );
  return (
    <Field label="Hoort bij afdeling" hint="De bots in deze groep krijgen het organigram van die afdeling mee.">
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Geen afdeling</option>
        {treeOrder(teams).map(({ t, depth }) => (
          <option key={t.id} value={t.id}>
            {'— '.repeat(depth)}
            {t.name}
          </option>
        ))}
      </Select>
    </Field>
  );
}
