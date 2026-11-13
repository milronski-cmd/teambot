import { useMemo, useState } from 'react';
import { AlarmClock, ArrowRight, Bot, Brain, CheckCircle2, ChevronDown, ClipboardList, FolderOpen, Info, MessageCircle, Puzzle, SquareKanban, Upload, Users } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Page, PageHeader, Select, Spinner, Tabs, cx } from '../../components/ui';
import { BotAvatar } from '../../components/BotFace';
import { useApp } from '../../lib/store';
import { navigate, query } from '../../lib/router';
import { type Detect, type ImportResult, type ImportSource, type Plan, type PlanBot, type UndoResult, type WorkspaceChoice, obApi } from './api';
import { HermesImport } from './HermesImport';
import { t } from '../../lib/i18n';
import { formatBytes, formatNumber, tText } from '../../lib/format';
import { prettyModel } from '../../lib/modelLabel';
import { AfterImport, AllNone, Check, EngineBadge, ErrorNote, ImportBar, PlanTop, Promises, ProviderNotes, ReadRow, ResultTiles, RoutineList, Section, SourceFound, toggleIn, useImportFlow } from './parts';
import { type RolePick, type TeamPick, RolesSection, TeamSection, teamProblem } from './TeamRoles';
import { UndoButton, UndoneCard } from './Undo';

/** "1.234 bestanden, 1,5 GB" in the reader's notation (the server's sizeLabel is Dutch notation, kept as a fallback). */
function workspaceSize(w: PlanBot['workspace']): string {
  if (typeof w.files !== 'number' || typeof w.bytes !== 'number') return w.sizeLabel;
  return w.capped
    ? t('meer dan {0, plural, one {# bestand} other {# bestanden}}, ≥ {1}', formatNumber(w.files), formatBytes(w.bytes))
    : t('{0, plural, one {# bestand} other {# bestanden}}, {1}', formatNumber(w.files), formatBytes(w.bytes));
}

/** OpenBot's thinking level in words ("denkniveau Middel"), not its code ("medium"). */
const LEVEL: Record<string, string> = { low: 'Laag', medium: 'Middel', high: 'Hoog' };

const ACCESS_LABEL: Record<string, string> = { chat: 'Alleen chat', readonly: 'Alleen lezen', ask: 'Vraagt toestemming', auto: 'Automatisch', full: 'Volledige toegang' };
const SKILL_LABEL: Record<string, string> = { own: 'eigen skill', permissive: '', openbot: 'van OpenBot', unknown: 'licentie onbekend' };
const ROLE_LABEL: Record<string, string> = { main: 'hoofdbot', lead: 'teamleider', specialist: 'specialist' };

function BotRow({ b, role, selected, workspace, onSelect, onWorkspace }: { b: PlanBot; role: string; selected: boolean; workspace: WorkspaceChoice; onSelect(v: boolean): void; onWorkspace(v: WorkspaceChoice): void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cx('px-4 py-3', !selected && 'opacity-70')}>
      <div className="flex items-start gap-3">
        <Check checked={selected} disabled={!!b.existing} onChange={onSelect} label={`${b.name} overnemen`} />
        <BotAvatar bot={{ id: b.key, name: b.name, avatar: b.face }} size={40} />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{b.name}</span>
            {role && selected && <Badge tone="accent">{ROLE_LABEL[role]}</Badge>}
            {b.existing && <Badge tone="ok">al overgenomen</Badge>}
            {b.pinned && <Badge>vastgepind</Badge>}
            <EngineBadge engine={b.engine} />
          </div>
          {b.description && <p className="line-clamp-2 text-xs text-muted">{b.description}</p>}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            <span>
              Model: <span className="text-fg">{b.model ? prettyModel(b.model) : 'standaard'}</span>
              {b.reasoning ? ` · ${t('denkniveau {0}', LEVEL[b.reasoning] ? t(LEVEL[b.reasoning]) : b.reasoning)}` : ''}
            </span>
            <span>Toegang: {ACCESS_LABEL[b.access.to] || b.access.to}</span>
            {b.backups.length > 0 && <span>Reserves: {b.backups.map((x) => (x.model ? prettyModel(x.model) : x.label)).join(' → ')}</span>}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            <span>{t('{0, plural, one {# skill} other {# skills}}', b.skills.length)}</span>
            <span>{t('{0, plural, one {# routine} other {# routines}}', b.routines)}</span>
            <span>{t('{0, plural, one {# herinnering} other {# herinneringen}}', b.memories)}</span>
            <span>{b.instructions.chars ? `instructies uit ${b.instructions.source}` : 'geen instructies'}</span>
          </div>
          {!b.existing && (
            <div className="flex flex-col gap-1 pt-1 sm:flex-row sm:items-center sm:gap-2">
              <span className="text-xs font-medium">Werkmap</span>
              <Select className="sm:max-w-xs" value={workspace} disabled={!selected} onChange={(e) => onWorkspace(e.target.value as WorkspaceChoice)} aria-label={tText('Werkmap voor {0}', b.name)}>
                {b.workspace.exists && <option value="reference">Bestaande map gebruiken (aanbevolen)</option>}
                {b.workspace.exists && (
                  <option value="copy" disabled={!b.workspace.canCopy}>
                    Kopiëren naar TeamBot{b.workspace.canCopy ? '' : ' (te groot)'}
                  </option>
                )}
                <option value="new">Nieuwe lege werkmap</option>
              </Select>
              <span className="truncate text-xs text-muted" title={b.workspace.path}>
                {b.workspace.exists ? workspaceSize(b.workspace) : 'map niet gevonden'}
              </span>
            </div>
          )}
          {(b.notes.length > 0 || b.skippedSkills.length > 0) && (
            <button type="button" onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 text-xs text-accent" aria-expanded={open}>
              <ChevronDown className={cx('h-3.5 w-3.5 transition', open && 'rotate-180')} /> Details
            </button>
          )}
          {open && (
            <ul className="list-disc space-y-0.5 ps-5 text-xs text-muted">
              <li className="break-all">Map: {b.workspace.path}</li>
              {b.engine.note && <li>{b.engine.note}</li>}
              {b.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
              {b.skippedSkills.length > 0 && <li>Niet overgenomen (van OpenBot): {b.skippedSkills.join(', ')}</li>}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/** "Wat er gebeurt": exactly what the import button makes with the current choices, and what does not come over. */
function WhatHappens({ plan, team, roles, selected, routineCount, channelCount, skills, shared, teamData, memories }: { plan: Plan; team: TeamPick; roles: RolePick; selected: Set<string>; routineCount: number; channelCount: number; skills: number; shared: boolean; teamData: boolean; memories: 'active' | 'review' | 'off' }) {
  const name = (k: string) => plan.bots.find((b) => b.key === k)?.name || '';
  const chosen = team.mode === 'existing' ? plan.team.existing.find((x) => x.id === team.id) || null : null;
  const items: string[] = [];
  if (plan.team.available && (selected.size || shared || teamData)) items.push(team.mode === 'new' ? t('Een nieuw team “{0}”', team.name.trim()) : t('Alles komt in het team “{0}”', chosen?.name || ''));
  if (roles.main && selected.has(roles.main)) items.push(t('{0} wordt je hoofdbot', name(roles.main)));
  if (roles.lead && selected.has(roles.lead) && roles.lead !== roles.main && !chosen?.lead) items.push(t('{0} wordt teamleider', name(roles.lead)));
  if (selected.size)
    items.push(
      t(
        '{0, plural, one {# bot} other {# bots}}: {1}',
        selected.size,
        plan.bots
          .filter((b) => selected.has(b.key))
          .map((b) => b.name)
          .join(', '),
      ),
    );
  for (const s of plan.roles.specialists) {
    if (!selected.has(s.key)) continue;
    const pick = roles.specialists[s.key];
    if (plan.roles.specialistsAvailable && pick?.selected) items.push(t('{0} wordt specialist in: {1}', s.name, pick.field || s.field));
    else if (!plan.roles.specialistsAvailable) items.push(t('{0} komt als gewone bot; vakgebied en bronnen worden bewaard', s.name));
  }
  if (routineCount) items.push(t('{0, plural, one {# routine (staat uit)} other {# routines (staan uit)}}', routineCount));
  if (channelCount) items.push(t('{0, plural, one {# kanaal (staat uit)} other {# kanalen (staan uit)}}', channelCount));
  if (shared) items.push(t('Teammap: {0} (dezelfde map als in OpenBot)', plan.shared.path));
  if (teamData && plan.teamData) items.push(t('Teamtabellen: {0, plural, one {# rij} other {# rijen}}', plan.teamData.tables.reduce((n, x) => n + Math.max(0, x.rows - x.imported), 0)));
  if (skills) items.push(t('{0, plural, one {# skill} other {# skills}}', skills));
  if (memories !== 'off' && plan.memories.total) items.push(memories === 'review' ? t('{0, plural, one {# herinnering als voorstel} other {# herinneringen als voorstel}}', plan.memories.total) : t('{0, plural, one {# herinnering} other {# herinneringen}}', plan.memories.total));
  return (
    <Section icon={<ClipboardList className="h-4 w-4" />} title="Wat er gebeurt">
      <Card className="space-y-4 px-4 py-4">
        <div className="space-y-1.5">
          <div className="text-sm font-medium">Als je op Importeren drukt, maakt TeamBot:</div>
          {items.length ? (
            <ul className="list-disc space-y-0.5 ps-5 text-sm">
              {items.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">Niets: er is niets aangevinkt.</p>
          )}
        </div>
        <div className="space-y-1.5 border-t border-line pt-3">
          <div className="text-sm font-medium">Wat niet meekomt</div>
          <ul className="space-y-1 text-sm">
            {plan.notImported.map((x, i) => (
              <li key={i}>
                <span className="font-medium">{x.what}</span> <span className="text-muted">— {x.why}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-muted">Tot je op Importeren drukt, verandert er niets. Daarna kun je alles ongedaan maken.</p>
      </Card>
    </Section>
  );
}

function Summary({ r, onAgain, onUndone }: { r: ImportResult; onAgain(): void; onUndone(x: UndoResult): void }) {
  const errors = [...r.bots.filter((b) => b.status === 'error').map((b) => `${b.name}: ${b.error}`), ...r.routines.filter((x) => x.status === 'error').map((x) => `Routine ${x.name}: ${x.error}`)];
  const tiles = [
    { n: r.counts.bots, label: 'bots', href: '#/agents' },
    { n: r.counts.routines, label: 'routines (uit)', href: '#/m/routines' },
    { n: r.counts.skills, label: 'skills', href: '#/m/skills/mine' },
    { n: r.counts.memories, label: 'herinneringen', href: r.memories.proposed ? '#/m/memory/beoordelen' : '#/m/memory/bots' },
    ...(r.counts.channels ? [{ n: r.counts.channels, label: 'kanalen (uit)', href: '#/m/channels' }] : []),
  ];
  const roles = r.roles;
  return (
    <div className="space-y-5">
      <Card className="space-y-4 p-5">
        <div className="flex items-center gap-2 text-base font-semibold">
          <CheckCircle2 className="h-5 w-5 text-ok" /> Je team is overgenomen
        </div>
        {r.team && (
          <p className="flex items-start gap-2 text-sm">
            <Users className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
            <span>
              {r.team.created ? t('Nieuw team: {0}.', r.team.name) : t('In het team {0}.', r.team.name)}{' '}
              <a className="font-semibold underline underline-offset-2" href={`#/m/teams/${r.team.id}`}>
                Naar het team
              </a>
            </span>
          </p>
        )}
        <ResultTiles tiles={tiles} />
        {roles && (roles.main || roles.lead || roles.specialists.length > 0) && (
          <ul className="space-y-1 text-sm">
            {roles.main && <li>{roles.main.note}</li>}
            {roles.lead && roles.lead.status === 'set' && <li>{roles.lead.note}</li>}
            {roles.lead && roles.lead.status === 'skipped' && <li className="text-muted">{roles.lead.note}</li>}
            {roles.specialists.map((s) => (
              <li key={s.name}>
                <span className="font-medium">{s.name}</span>: <span className="text-muted">{s.note}</span>
              </li>
            ))}
          </ul>
        )}
        {!!r.teamData?.length && (
          <p className="flex items-start gap-2 text-sm">
            <SquareKanban className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
            <span>
              Teamtabellen: {r.teamData.filter((x) => x.inserted).map((x) => `${x.name} ${x.inserted}`).join(', ') || 'niets nieuws'}
              {r.teamData.some((x) => x.skipped) ? ` (${t('{0, plural, one {# rij stond er al} other {# rijen stonden er al}}', r.teamData.reduce((n, x) => n + x.skipped, 0))})` : ''}.{' '}
              <a className="font-semibold underline underline-offset-2" href="#/m/teamdata/">
                Naar Teamwerk
              </a>
            </span>
          </p>
        )}
        {r.shared && r.shared.status !== 'skipped' && (
          <p className="flex items-start gap-2 text-sm">
            <FolderOpen className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
            <span>
              Teammap: <code className="break-all">{r.shared.path}</code> (dezelfde map als in OpenBot, niet gekopieerd).
            </span>
          </p>
        )}
        <ProviderNotes providers={r.providers} />
      </Card>
      {!!r.routinesOff?.length && (
        <Section icon={<AlarmClock className="h-4 w-4" />} title="Staan uit tot jij ze aanzet">
          <Card className="divide-y divide-line">
            {r.routinesOff.map((x, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
                <span className="font-medium">{x.name}</span>
                <span className="text-xs text-muted">· {x.bot}</span>
                {x.customer && <Badge tone="warn">eerst een testrun</Badge>}
              </div>
            ))}
          </Card>
        </Section>
      )}
      <AfterImport
        errors={errors}
        attention={r.attention}
        onAgain={onAgain}
        next={
          <Button variant="primary" icon={<ArrowRight className="h-4 w-4" />} onClick={() => navigate('/settings/openbot-import-overstappen')}>
            Verder met overstappen
          </Button>
        }
        undo={r.undo && <UndoButton onDone={onUndone} />}
      />
    </div>
  );
}

/** Grok Bot: nothing to read (no export, no data on this computer), said plainly with what you can do instead. */
function GrokNote() {
  return (
    <Card className="space-y-3 p-5">
      <div className="flex items-start gap-3">
        <Info className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
        <div className="space-y-2 text-sm">
          <p className="font-medium">Grok Bot kun je niet importeren.</p>
          <p className="text-muted">Grok Bot heeft geen exportfunctie en bewaart niets op je computer: je gesprekken en instellingen staan alleen bij Grok online. Er is dus niets dat TeamBot kan inlezen.</p>
          <p className="text-muted">Een Grok-bot nadoen? Maak een nieuwe bot en plak je instructies erin.</p>
        </div>
      </div>
      <Button icon={<Bot className="h-4 w-4" />} onClick={() => navigate('/agents/new')}>
        Nieuwe bot maken
      </Button>
    </Card>
  );
}

const TITLE: Record<ImportSource, string> = { openbot: 'Overstappen uit OpenBot', hermes: 'Overstappen uit Hermes Agent', grok: 'Overstappen uit Grok Bot' };
const SUBTITLE: Record<ImportSource, string> = {
  openbot: 'Neem je team mee: bots, rollen, teammap, teamtabellen, skills en routines. OpenBot zelf blijft ongewijzigd.',
  hermes: 'Neem je Hermes-profielen mee als bots. Hermes zelf blijft ongewijzigd.',
  grok: 'Grok Bot heeft geen export en geen gegevens op je computer.',
};

/** #/m/openbot-import (?bron=hermes | grok): where you come from, then that import. */
export function ImportPage() {
  const me = useApp((s) => s.me);
  const [from, setFrom] = useState<ImportSource>(() => {
    const q = query().get('bron');
    return q === 'hermes' || q === 'grok' ? q : 'openbot';
  });
  if (me && me.role !== 'owner') {
    return (
      <Page>
        <PageHeader title="Overstappen" />
        <EmptyState title="Alleen voor de eigenaar">Overstappen leest mappen op deze computer; dat kan alleen de eigenaar van deze installatie.</EmptyState>
      </Page>
    );
  }
  return (
    <Page>
      <PageHeader title={TITLE[from]} subtitle={SUBTITLE[from]} />
      <div className="mx-auto max-w-4xl space-y-6 px-4 py-5 pb-28 sm:px-6">
        <div className="space-y-1.5">
          <div className="text-sm font-medium">Waar kom je vandaan?</div>
          <Tabs<ImportSource>
            value={from}
            onChange={setFrom}
            tabs={[
              { id: 'openbot', label: 'OpenBot' },
              { id: 'hermes', label: 'Hermes Agent' },
              { id: 'grok', label: 'Grok Bot' },
            ]}
          />
        </div>
        {from === 'openbot' && <OpenBotImport />}
        {from === 'hermes' && <HermesImport />}
        {from === 'grok' && <GrokNote />}
      </div>
    </Page>
  );
}

function OpenBotImport() {
  const [bots, setBots] = useState<Record<string, { selected: boolean; workspace: WorkspaceChoice }>>({});
  const [routines, setRoutines] = useState<Set<string>>(new Set());
  const [channels, setChannels] = useState<Set<string>>(new Set());
  const [skills, setSkills] = useState<Set<string>>(new Set());
  const [shared, setShared] = useState(false);
  const [teamData, setTeamData] = useState(false);
  const [memories, setMemories] = useState<'active' | 'review' | 'off'>('active');
  const [ack, setAck] = useState(false);
  const [team, setTeam] = useState<TeamPick>({ mode: 'new', id: '', name: '' });
  const [roles, setRoles] = useState<RolePick>({ main: '', lead: '', specialists: {} });

  const flow = useImportFlow<Detect, Plan, ImportResult>({
    detect: obApi.detect,
    notFound: { available: false, found: false },
    preview: () => obApi.preview(),
    onPlan: (p) => {
      setBots(Object.fromEntries(p.bots.map((b) => [b.key, { selected: b.selected, workspace: b.workspace.default }])));
      setRoutines(new Set(p.routines.filter((r) => r.selected).map((r) => r.key)));
      setChannels(new Set((p.channels || []).filter((c) => c.selected).map((c) => c.key)));
      setSkills(new Set(p.skills.filter((s) => s.selected).map((s) => s.key)));
      setShared(p.shared.selected);
      setTeamData(!!p.teamData?.selected);
      setMemories(p.memories.total > 0 ? 'active' : 'off');
      setAck(false);
      const c = p.team.choice;
      setTeam(c?.mode === 'existing' ? { mode: 'existing', id: c.id, name: p.team.name } : { mode: 'new', id: '', name: c?.mode === 'new' ? c.name : p.team.name });
      setRoles({ main: p.roles.main || '', lead: p.roles.lead || '', specialists: Object.fromEntries(p.roles.specialists.map((s) => [s.key, { selected: s.selected, field: s.field }])) });
    },
  });
  const { det, setDet, plan, result, undone, busy, error, loadDetect, read, afterUndo } = flow;

  const selectedBots = useMemo(() => new Set(Object.entries(bots).filter(([, v]) => v.selected).map(([k]) => k)), [bots]);
  const botKnown = (key: string) => selectedBots.has(key) || !!plan?.bots.find((b) => b.key === key)?.existing;
  const routineCount = plan ? plan.routines.filter((r) => routines.has(r.key) && botKnown(r.botKey)).length : 0;
  const keepChannels = plan ? (plan.channels || []).filter((c) => channels.has(c.key) && !!c.adapter && !!c.botKey && botKnown(c.botKey)).map((c) => c.key) : [];
  const dangerSkills = plan ? plan.skills.filter((s) => skills.has(s.key) && s.scan === 'danger') : [];
  const problem = plan ? teamProblem(plan, team) : '';
  const roleOf = (key: string) => (roles.main === key ? 'main' : roles.lead === key ? 'lead' : plan?.roles.specialistsAvailable && roles.specialists[key]?.selected ? 'specialist' : '');

  const doImport = () =>
    plan &&
    flow.doImport(() =>
      obApi.commit({
        stagingId: plan.stagingId,
        bots,
        routines: plan.routines.filter((r) => routines.has(r.key) && botKnown(r.botKey)).map((r) => r.key),
        channels: keepChannels,
        skills: [...skills],
        memories,
        shared,
        teamData,
        acknowledgeSkills: ack,
        ...(plan.team.available ? { team: team.mode === 'new' ? { mode: 'new', name: team.name.trim() } : { mode: 'existing', id: team.id } } : {}),
        mainBot: roles.main && selectedBots.has(roles.main) ? roles.main : null,
        lead: roles.lead && selectedBots.has(roles.lead) && roles.lead !== roles.main ? roles.lead : null,
        specialists: Object.fromEntries(plan.roles.specialists.map((s) => [s.key, { selected: !!roles.specialists[s.key]?.selected, field: roles.specialists[s.key]?.field ?? s.field, sources: s.sources }])),
      }),
    );

  return (
    <>
      <div className="space-y-6">
        {undone && <UndoneCard r={undone} />}
        {result && <Summary r={result} onAgain={read} onUndone={afterUndo} />}

        {!plan && !result && (
          <Card className="space-y-4 p-5">
            {det === null ? (
              <Spinner />
            ) : det.found ? (
              <>
                <SourceFound title="OpenBot gevonden op deze computer" imported={det.imported}>
                  <p className="break-all text-sm text-muted">
                    {det.dataDir}
                    {det.workspaces ? ` · ${t('{0, plural, one {# werkmap} other {# werkmappen}}', det.workspaces)}` : ''}
                  </p>
                </SourceFound>
                <Promises
                  items={[
                    'Alleen lezen: OpenBot en zijn bestanden blijven precies zoals ze zijn.',
                    'Geen sleutels of tokens: koppelingen die een sleutel nodig hebben, verbind je straks opnieuw.',
                    'Routines komen uit te staan, zodat niets dubbel draait naast OpenBot.',
                    'Spijt? Met één knop maak je de import weer ongedaan.',
                  ]}
                />
                <ReadRow reading={busy === 'read'} onRead={read} undo={det.undoable && <UndoButton onDone={afterUndo} label="Eerdere import ongedaan maken" />}>
                  OpenBot inlezen
                </ReadRow>
              </>
            ) : (
              <EmptyState
                icon={<Upload className="h-8 w-8" />}
                title="Geen OpenBot gevonden"
                action={
                  <Button size="sm" onClick={() => (setDet(null), void loadDetect())}>
                    Opnieuw zoeken
                  </Button>
                }
              >
                Op deze computer staat geen OpenBot-installatie{det.dataDir ? ` (gezocht in ${det.dataDir})` : ''}.
              </EmptyState>
            )}
            <ErrorNote text={error} />
          </Card>
        )}

        {plan && (
          <>
            <PlanTop path={plan.source.dataDir} attention={plan.attention} reading={busy === 'read'} onRead={read} />

            <TeamSection plan={plan} team={team} onTeam={setTeam} shared={shared} onShared={setShared} teamData={teamData} onTeamData={setTeamData} />

            <RolesSection plan={plan} roles={roles} onRoles={setRoles} selected={selectedBots} team={team} />

            <Section icon={<Bot className="h-4 w-4" />} title="Bots" count={`${selectedBots.size} van ${plan.bots.length}`} actions={<AllNone onAll={() => setBots((b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, { ...v, selected: !plan.bots.find((x) => x.key === k)?.existing }])))} onNone={() => setBots((b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, { ...v, selected: false }])))} />}>
              <Card className="divide-y divide-line">
                {plan.bots.map((b) => (
                  <BotRow
                    key={b.key}
                    b={b}
                    role={roleOf(b.key)}
                    selected={!!bots[b.key]?.selected}
                    workspace={bots[b.key]?.workspace || b.workspace.default}
                    onSelect={(v) => setBots((x) => ({ ...x, [b.key]: { ...x[b.key], selected: v } }))}
                    onWorkspace={(v) => setBots((x) => ({ ...x, [b.key]: { ...x[b.key], workspace: v } }))}
                  />
                ))}
              </Card>
            </Section>

            <Section icon={<Puzzle className="h-4 w-4" />} title="Skills" count={`${skills.size} van ${plan.skills.filter((s) => s.importable).length} over te nemen`} actions={<AllNone onAll={() => setSkills(new Set(plan.skills.filter((s) => s.importable).map((s) => s.key)))} onNone={() => setSkills(new Set())} />}>
              {!plan.skills.some((s) => s.importable) ? (
                <p className="text-sm text-muted">Geen eigen skills gevonden.</p>
              ) : (
                <Card className="divide-y divide-line">
                  {plan.skills
                    .filter((s) => s.importable)
                    .map((s) => (
                      <div key={s.key} className="flex items-start gap-3 px-4 py-2.5">
                        <Check checked={skills.has(s.key)} disabled={!s.importable} onChange={(v) => setSkills((x) => toggleIn(x, s.key, v))} label={`Skill ${s.name}`} />
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-sm font-medium">{s.name}</span>
                            {(SKILL_LABEL[s.klass] || s.license) && <Badge tone={s.klass === 'openbot' ? 'neutral' : s.klass === 'unknown' ? 'warn' : 'accent'}>{SKILL_LABEL[s.klass] || s.license}</Badge>}
                            {s.scope === 'team' && <Badge>teamskill</Badge>}
                            {s.scan === 'danger' && <Badge tone="danger">waarschuwingen</Badge>}
                            {s.scan === 'warn' && <Badge tone="warn">let op</Badge>}
                            {s.action === 'unchanged' && <Badge tone="ok">staat er al</Badge>}
                            {s.action === 'update' && <Badge tone="accent">nieuwere versie</Badge>}
                          </div>
                          {s.description && <p className="line-clamp-2 text-xs text-muted">{s.description}</p>}
                          <p className="text-xs text-muted">
                            {s.reason ? `${s.reason} ` : ''}
                            {s.usedBy.length ? `Bij: ${s.usedBy.join(', ')}.` : ''}
                            {s.variants > 1 ? ` ${s.variants} verschillende versies gevonden; de ${s.scope === 'team' ? 'teamversie' : 'nieuwste'} wordt gebruikt.` : ''}
                          </p>
                        </div>
                      </div>
                    ))}
                </Card>
              )}
              {plan.skills.some((s) => !s.importable) && (
                <details className="rounded-xl border border-line bg-surface px-4 py-2.5 text-sm">
                  <summary className="cursor-pointer text-muted">{t('{0, plural, one {# skill van OpenBot zelf blijft achter} other {# skills van OpenBot zelf blijven achter}}', plan.skills.filter((s) => !s.importable).length)}</summary>
                  <ul className="mt-2 space-y-1 text-xs text-muted">
                    {plan.skills
                      .filter((s) => !s.importable)
                      .map((s) => (
                        <li key={s.key}>
                          <span className="font-medium text-fg">{s.name}</span>
                          {s.usedBy.length ? ` · bij ${s.usedBy.join(', ')}` : ''}
                          {s.reason ? ` · ${s.reason}` : ''}
                        </li>
                      ))}
                  </ul>
                </details>
              )}
              {dangerSkills.length > 0 && (
                <label className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm">
                  <Check checked={ack} onChange={setAck} label="Waarschuwingen bekeken" />
                  <span>Ik heb de waarschuwingen bij {dangerSkills.map((s) => s.name).join(', ')} bekeken (zie Skills → Mijn skills voor de scan). Zonder dit vinkje worden ze overgeslagen.</span>
                </label>
              )}
            </Section>

            <Section icon={<AlarmClock className="h-4 w-4" />} title="Routines" count={`${routineCount} van ${plan.routines.length}`} actions={<AllNone onAll={() => setRoutines(new Set(plan.routines.filter((r) => r.ok && !r.existing).map((r) => r.key)))} onNone={() => setRoutines(new Set())} />}>
              <p className="text-xs text-muted">
                Alle routines komen binnen en <strong className="text-fg">staan uit tot jij ze aanzet</strong>. Zet ze aan wanneer je OpenBot stopt, anders draaien ze twee keer (bijvoorbeeld klantmails).
              </p>
              <RoutineList routines={plan.routines} chosen={routines} setChosen={setRoutines} known={botKnown} empty="Geen routines gevonden." />
            </Section>

            <Section icon={<MessageCircle className="h-4 w-4" />} title="Kanalen" count={plan.channels?.length ? `${keepChannels.length} van ${plan.channels.length}` : undefined}>
              <p className="text-xs text-muted">
                Kanalen komen binnen <strong className="text-fg">op pauze en zonder token</strong>: TeamBot maakt geen verbinding, zodat OpenBot gewoon blijft werken. Je zet elk kanaal later om, één voor één: eerst uit in OpenBot, dan aan in TeamBot.
              </p>
              {!plan.channels?.length ? (
                <p className="text-sm text-muted">Geen kanalen gevonden in OpenBot.</p>
              ) : (
                <Card className="divide-y divide-line">
                  {plan.channels.map((c) => {
                    const can = !!c.adapter && !!c.botKey && botKnown(c.botKey) && !c.existing;
                    return (
                      <div key={c.key} className="flex items-start gap-3 px-4 py-3">
                        <Check checked={can && channels.has(c.key)} disabled={!can} onChange={(v) => setChannels((x) => toggleIn(x, c.key, v))} label={t('Kanaal {0}', c.label)} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{c.label}</span>
                            {c.bot && <span className="text-xs text-muted">{t('antwoordt als {0}', c.bot)}</span>}
                            <Badge tone={c.adapter ? 'neutral' : 'warn'}>{c.existing ? 'al overgenomen' : c.adapter ? 'op pauze' : 'opnieuw koppelen'}</Badge>
                          </div>
                          <p className="mt-0.5 text-xs text-muted">{c.note}</p>
                        </div>
                      </div>
                    );
                  })}
                </Card>
              )}
            </Section>

            {plan.memories.total > 0 && (
              <Section icon={<Brain className="h-4 w-4" />} title="Herinneringen">
                <Card className="space-y-2 px-4 py-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <span className="text-sm">
                      {t('{0, plural, one {# herinnering} other {# herinneringen}}', plan.memories.total)} ({plan.memories.essential} vaste)
                    </span>
                    <Select className="sm:ms-auto sm:max-w-xs" value={memories} onChange={(e) => setMemories(e.target.value as typeof memories)} aria-label="Herinneringen">
                      <option value="active">Direct gebruiken, zoals in OpenBot</option>
                      <option value="review">Eerst zelf controleren</option>
                      <option value="off">Niet meenemen</option>
                    </Select>
                  </div>
                  <p className="text-xs text-muted">
                    {memories === 'review'
                      ? 'Ze komen als voorstel onder Geheugen → Te beoordelen.'
                      : 'Per bot. Wat op een wachtwoord of sleutel lijkt, wordt nooit opgeslagen.'}
                  </p>
                </Card>
              </Section>
            )}

            <WhatHappens plan={plan} team={team} roles={roles} selected={selectedBots} routineCount={routineCount} channelCount={keepChannels.length} skills={skills.size} shared={shared} teamData={teamData} memories={memories} />

            <ImportBar importing={busy === 'import'} disabled={!!problem || (!selectedBots.size && !skills.size && !routineCount && !shared && !teamData)} onImport={doImport}>
              {t('{0, plural, one {# bot} other {# bots}}', selectedBots.size)} · {t('{0, plural, one {# skill} other {# skills}}', skills.size)} · {t('{0, plural, one {# routine (uit)} other {# routines (uit)}}', routineCount)}
              {shared ? ' · teammap' : ''}
              {teamData ? ' · teamtabellen' : ''}
              {memories !== 'off' && plan.memories.total ? ' · herinneringen' : ''}
            </ImportBar>
          </>
        )}
      </div>
    </>
  );
}
