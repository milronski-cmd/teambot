import type React from 'react';
import { formatBytes } from '../../lib/format';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, CheckCircle2, Download, Eye, FilePlus2, History, Pencil, Pin, PinOff, Power, Puzzle, RefreshCw, Share2, ShieldAlert, ShieldCheck, Trash2, Upload, ScanSearch, BadgeCheck, Lock } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Page, PageHeader, Spinner, Tabs, Textarea, Toggle, askConfirm, cx, timeAgo, toast, useAsync, CardHead } from '../../components/ui';
import { MoreInfo } from '../../components/MoreInfo';
import { Dropdown } from '../../components/SettingControls';
import { Fold, Menu, Skeleton, SkeletonRows } from '../../components/overview';
import { SearchBox, Signal, SkillsLinks } from './marketParts';
import { api, authUrl, on } from '../../lib/api';
import { navigate } from '../../lib/router';
import { t } from '../../lib/i18n';
import { useApp } from '../../lib/store';
import type { SkillDetail, SkillSummary, VersionView } from './api';
import { SOURCE_TYPES, fmtDate } from './api';
import { Confirm, DiffView, FileList, FindingsList, LabelBadges, Md, PermissionsView, ScanBadge, SignatureBadge, SignaturePanel, VerifiedBadge, bodyOf, shareToast } from './common';
import { ImportDialog } from './ImportDialog';
import { BotPicker } from '../../components/BotPicker';
import { UpdateDiffModal } from './Catalog';
import { PinUpdateNote, PinUpdatesBanner } from './PinUpdates';
import { useFollowTeam } from '../teams/follow';
import { TeamFilterNote } from '../teams/FilterNote';
import { ALL } from './TeamPlace';
import { TestsTab } from './SkillTests';
import { firstSentence } from '../../lib/sentence';

type Filter = 'all' | 'updates' | 'drafts' | 'scripts' | 'warnings' | 'disabled';

const hasUpdate = (s: SkillSummary) => !!(s.newerStoredRevision || s.catalogUpdate);

interface CheckResult {
  checked: number;
  sources: number;
  updates: { skillId: string; name: string; version: string | null; stored: boolean }[];
  errors: { source: string; error: string }[];
  checkedAt: string;
}

export function MySkillsPage({ params }: { params: string[] }) {
  const id = params[0] && params[0].startsWith('skl_') ? params[0] : null;
  if (id) return <SkillDetailView key={id} id={id} initialTab={params[1] === 'bots' ? 'usage' : 'instructions'} />;
  return <SkillList initialFilter={params[0] === 'concepten' ? 'drafts' : 'all'} />;
}

/** The owner's skills; `teamQuery` ('?teamId=…') = what one team has (its own and those for all teams). */
export function useSkills(teamQuery = '') {
  const [list, setList] = useState<SkillSummary[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api
      .get<SkillSummary[]>(`/skills${teamQuery}`)
      .then((l) => (setList(l), setError('')))
      .catch((e) => setError(e.message));
  }, [teamQuery]);
  useEffect(() => {
    load();
    const a = on('skills.updated', load);
    const b = on('skills.deleted', load);
    return () => (a(), b());
  }, [load]);
  return { list, error, reload: load };
}

function SkillList({ initialFilter }: { initialFilter: Filter }) {
  // Package B4: the list follows the team switcher (that team's own skills and those for all teams).
  const team = useFollowTeam();
  const { list, error, reload } = useSkills(team.query);
  const [filter, setFilter] = useState<Filter>(initialFilter);
  const [q, setQ] = useState('');
  const fromInternet = !!list?.some((s) => s.catalogRef?.startsWith('github/'));
  useEffect(() => {
    // Look at the sources of internet skills (the server caches this for an hour), so "Update beschikbaar" also shows
    // for skills from repositories you have not browsed in the marketplace lately.
    if (fromInternet) api.post('/skills/web/check-updates', {}).then(reload).catch(() => {});
  }, [fromInternet, reload]);
  const [importing, setImporting] = useState(false);
  const [checked, setChecked] = useState<CheckResult | null>(null);
  const check = useAsync();
  const checkUpdates = () =>
    check.run(async () => {
      const r = await api.post<CheckResult>('/skills/check-updates', {});
      setChecked(r);
      reload();
      if (r.updates.length) {
        toast(`${r.updates.length === 1 ? '1 update gevonden' : `${r.updates.length} updates gevonden`}: ${r.updates.slice(0, 3).map((u) => u.name).join(', ')}${r.updates.length > 3 ? ' …' : ''}`, 'ok');
        setFilter('updates');
      } else if (!r.errors.length) toast(r.sources ? 'Alles is bijgewerkt' : 'Geen skills uit een bron die TeamBot kan controleren', 'ok');
      if (r.errors.length) toast(`Niet bereikbaar: ${r.errors.map((e) => e.source).join(', ')}`, 'danger');
    });
  const counts = useMemo(() => {
    const l = list || [];
    return { all: l.length, updates: l.filter(hasUpdate).length, drafts: l.filter((s) => s.status === 'draft').length, scripts: l.filter((s) => s.kind === 'scripts').length, warnings: l.filter((s) => s.scanLevel === 'warn' || s.scanLevel === 'danger').length, disabled: l.filter((s) => s.status === 'disabled').length };
  }, [list]);
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (list || []).filter((s) => {
      if (filter === 'updates' && !hasUpdate(s)) return false;
      if (filter === 'drafts' && s.status !== 'draft') return false;
      if (filter === 'scripts' && s.kind !== 'scripts') return false;
      if (filter === 'warnings' && s.scanLevel !== 'warn' && s.scanLevel !== 'danger') return false;
      if (filter === 'disabled' && s.status !== 'disabled') return false;
      const hay = `${s.name} ${s.description} ${s.author}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [list, filter, q]);

  // The filter is a choice of what there is: only kinds that occur (and the one that is chosen).
  const filters: { value: Filter; label: string }[] = (
    [
      ['all', 'Alle skills'],
      ['updates', 'Met een update'],
      ['drafts', 'Concepten'],
      ['scripts', 'Met scripts'],
      ['warnings', 'Met een waarschuwing'],
      ['disabled', 'Uitgezet'],
    ] as [Filter, string][]
  )
    .filter(([id]) => id === 'all' || id === filter || counts[id] > 0)
    .map(([id, label]) => ({ value: id, label: id === 'all' ? label : `${label} (${counts[id]})` }));
  const act = useAsync();
  const toggle = (s: SkillSummary) => act.run(() => api.patch(`/skills/${s.id}`, { status: s.status === 'active' ? 'disabled' : 'active' }).then(reload), s.status === 'active' ? 'Uitgezet' : 'Aangezet');
  const remove = async (s: SkillSummary) => {
    if (!(await askConfirm(s.status === 'draft' ? t('Het concept “{0}” weggooien?', s.name) : t('De skill “{0}” verwijderen? Je bots hebben hem daarna niet meer.', s.name), { ok: s.status === 'draft' ? 'Weggooien' : 'Verwijderen', danger: true }))) return;
    act.run(() => api.del(`/skills/${s.id}`).then(reload), s.status === 'draft' ? 'Concept weggegooid' : 'Skill verwijderd');
  };

  return (
    <Page>
      <PageHeader
        width="5xl"
        title="Marktplaats"
        subtitle="Skills, apps en bots voor je team."
        actions={
          <>
            {/* Without its icon on a phone, so the links, this button and the menu stay on one line. */}
            <Button variant="primary" icon={<Upload className="h-4 w-4 max-sm:hidden" />} onClick={() => setImporting(true)}>
              Importeren
            </Button>
            <Menu label="Meer opties" variant="secondary" testId="myskills-more" items={[{ label: 'Controleer op updates', icon: <RefreshCw aria-hidden />, disabled: check.busy || !list?.length, onSelect: checkUpdates }]} />
          </>
        }
      />
      <div className="mx-auto max-w-5xl space-y-4 px-4 pb-8 pt-2 sm:px-6">
        <SkillsLinks current="installed" />
        <TeamFilterNote>Je ziet de skills van dit team en de skills voor alle teams.</TeamFilterNote>
        <PinUpdatesBanner onChanged={reload} onShowAll={() => setFilter('updates')} />
        {error ? (
          <EmptyState icon={<Puzzle />} title="De skills konden niet laden" action={<Button onClick={reload}>Opnieuw</Button>}>
            {error}
          </EmptyState>
        ) : !list ? (
          <SkeletonRows n={4} avatar={false} />
        ) : !list.length ? (
          <EmptyState
            icon={<Puzzle />}
            title="Nog geen skills"
            action={
              <Button variant="primary" onClick={() => navigate('/m/skills/skills')}>
                Bekijk de marktplaats
              </Button>
            }
          >
            Een skill leert je bot een vaste werkwijze.
          </EmptyState>
        ) : (
          <>
            {(list.length > 6 || filters.length > 1 || !!q) && (
              <div className="flex flex-wrap items-center gap-2">
                <SearchBox value={q} onChange={setQ} label="Zoek in je skills" />
                {filters.length > 1 && <Dropdown<Filter> className="w-full sm:w-auto" label="Welke skills" value={filter} onChange={setFilter} options={filters} />}
              </div>
            )}
            {checked && (
              <p className="text-xs text-muted" role="status">
                Gecontroleerd {timeAgo(checked.checkedAt)}: {checked.sources === 1 ? '1 bron' : `${checked.sources} bronnen`}, {checked.updates.length === 1 ? '1 update' : checked.updates.length ? `${checked.updates.length} updates` : 'geen updates'}
                {checked.errors.length > 0 && ` · niet bereikbaar: ${checked.errors.map((e) => e.source).join(', ')}`}.
              </p>
            )}
            {!shown.length ? (
              <EmptyState icon={<Puzzle />} title="Geen skills gevonden" action={<Button onClick={() => (setQ(''), setFilter('all'))}>Alles tonen</Button>} />
            ) : (
              <ul className="tb-in divide-y divide-line rounded-card border border-line bg-surface">
                {shown.map((s) => (
                  <li key={s.id} className="flex items-center gap-3 pe-2 first:rounded-t-card last:rounded-b-card hover:bg-surface-2">
                    <a href={`#/m/skills/mine/${s.id}`} className="flex min-w-0 flex-1 items-center gap-3 py-3.5 ps-4 outline-none focus-visible:underline">
                      <span className="min-w-0 flex-1">
                        <span className="block break-words font-semibold" translate="no">
                          {s.name}
                        </span>
                        <span className="line-clamp-1 break-words text-[13px] text-muted">{firstSentence(s.description)}</span>
                      </span>
                      <RowSignal s={s} />
                    </a>
                    <Menu
                      label={t('Meer bij {0}', s.name)}
                      testId="skill-menu"
                      items={[
                        { label: 'Openen', icon: <Eye aria-hidden />, href: `#/m/skills/mine/${s.id}` },
                        s.status !== 'draft' && { label: 'Vaste bots kiezen', icon: <Bot aria-hidden />, href: `#/m/skills/mine/${s.id}/bots` },
                        s.status !== 'draft' && { label: s.status === 'active' ? 'Uitzetten' : 'Aanzetten', icon: <Power aria-hidden />, disabled: act.busy, onSelect: () => toggle(s) },
                        { label: 'Downloaden', icon: <Download aria-hidden />, href: authUrl(`/skills/${s.id}/download`) },
                        'sep',
                        { label: s.status === 'draft' ? 'Weggooien' : 'Verwijderen', icon: <Trash2 aria-hidden />, danger: true, onSelect: () => remove(s) },
                      ]}
                    />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      <ImportDialog open={importing} onClose={() => setImporting(false)} />
    </Page>
  );
}

/** The one signal of a skill in the list: what needs attention first, else for whom it is on. */
function RowSignal({ s }: { s: SkillSummary }) {
  const sig = (tone: 'ok' | 'warn' | 'danger' | 'muted', icon: React.ReactNode, text: React.ReactNode) => (
    <Signal tone={tone} icon={icon} className="shrink-0 max-sm:max-w-[45%]">
      {text}
    </Signal>
  );
  if (s.blocked) return sig('danger', <ShieldAlert aria-hidden />, 'Geblokkeerd');
  if (s.scanLevel === 'danger' || s.scanLevel === 'warn') return sig(s.scanLevel === 'danger' ? 'danger' : 'warn', <ShieldAlert aria-hidden />, 'Waarschuwing');
  if (hasUpdate(s)) return sig('ok', <RefreshCw aria-hidden />, 'Update beschikbaar');
  if (s.status === 'draft') return sig('warn', <Pencil aria-hidden />, 'Concept');
  if (s.status === 'disabled') return sig('muted', <Power aria-hidden />, 'Uit');
  // Every bot of the team can load an active skill; a bot's own list only says what it names first.
  return sig('ok', <CheckCircle2 aria-hidden />, 'Aan voor het team');
}

// Four tabs; files, versions and the facts of a skill are folds under its instructions.
type DTab = 'instructions' | 'usage' | 'tests' | 'security';

function SkillDetailView({ id, initialTab }: { id: string; initialTab: DTab }) {
  const [s, setS] = useState<SkillDetail | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<DTab>(initialTab);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // The commit is kept while the dialog is open: after "Bijwerken" the update badge goes away, the dialog stays.
  const [diffCommit, setDiffCommit] = useState<string | null>(null);
  const act = useAsync();
  const teamView = useFollowTeam();
  const load = useCallback(() => {
    api
      .get<SkillDetail>(`/skills/${id}`)
      .then((x) => (setS(x), setError('')))
      .catch((e) => setError(e.message));
  }, [id]);
  useEffect(() => {
    load();
    const a = on('skills.updated', (d: { ids?: string[] }) => (!d?.ids || d.ids.includes(id)) && load());
    return a;
  }, [id, load]);

  if (error)
    return (
      <EmptyState title="Skill niet gevonden" action={<Button onClick={() => navigate('/m/skills/mine')}>Naar Mijn skills</Button>}>
        {error}
      </EmptyState>
    );
  if (!s)
    return (
      <Page>
        <div className="mx-auto max-w-5xl space-y-4 px-4 pt-8 sm:px-6" role="status" aria-label="Laden">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-2/3" />
          <SkeletonRows n={3} avatar={false} />
        </div>
      </Page>
    );

  const isDraft = s.status === 'draft';
  const remove = () =>
    act.run(async () => {
      const from = location.hash;
      await api.del(`/skills/${id}`);
      navigate('/m/skills/mine', { from });
    }, isDraft ? 'Concept weggegooid' : 'Skill verwijderd');
  // One signal next to the name: what needs attention first.
  const state: { tone: 'accent' | 'ok' | 'warn' | 'danger' | 'neutral'; text: string } | null = s.blocked
    ? { tone: 'danger', text: 'Geblokkeerd' }
    : isDraft
      ? { tone: 'warn', text: 'Concept' }
      : hasUpdate(s)
        ? { tone: 'ok', text: 'Update beschikbaar' }
        : s.status === 'disabled'
          ? { tone: 'neutral', text: 'Uit' }
          : s.pinned
            ? { tone: 'neutral', text: 'Vastgepind' }
            : null;

  return (
    <Page>
      <PageHeader
        width="5xl"
        back={{ href: '#/m/skills/mine', label: 'Mijn skills' }}
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="break-words" translate="no">
              {s.name}
            </span>
            {state && <Badge tone={state.tone}>{state.text}</Badge>}
          </span>
        }
        subtitle={s.description}
        actions={
          <>
            {!isDraft && <Toggle checked={s.status === 'active'} onChange={(v) => act.run(() => api.patch(`/skills/${id}`, { status: v ? 'active' : 'disabled' }).then(load))} label={s.status === 'active' ? 'Aan' : 'Uit'} />}
            <Menu
              label="Meer opties"
              variant="secondary"
              testId="skill-more"
              items={[
                !isDraft && { label: s.pinned ? 'Losmaken van deze versie' : 'Vastpinnen op deze versie', icon: s.pinned ? <PinOff aria-hidden /> : <Pin aria-hidden />, disabled: act.busy, onSelect: () => act.run(() => api.patch(`/skills/${id}`, { pinned: !s.pinned }).then(load), s.pinned ? 'Niet meer vastgepind' : 'Vastgepind op deze versie') },
                { label: 'Downloaden', icon: <Download aria-hidden />, href: authUrl(`/skills/${id}/download`) },
                !isDraft && { label: 'Delen op deze server', icon: <Share2 aria-hidden />, disabled: act.busy, onSelect: () => act.run(async () => toast(shareToast(await api.post<{ status: string }>('/skills/shares', { type: 'skill', skillId: id })), 'ok')) },
                'sep',
                { label: isDraft ? 'Weggooien' : 'Verwijderen', icon: <Trash2 aria-hidden />, danger: true, onSelect: () => setConfirmDelete(true) },
              ]}
            />
          </>
        }
      />
      <div className="mx-auto max-w-5xl px-4 sm:px-6">
        {isDraft && <DraftBanner s={s} onChanged={load} />}
        {!isDraft && teamView.multi && (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">Voor</span>
            <Dropdown
              className="!min-w-0 w-auto"
              label="Voor welk team"
              value={s.allTeams ? ALL : s.teamId || ''}
              disabled={act.busy}
              onChange={(v) => act.run(() => api.patch(`/skills/${id}`, { teamId: v }).then(load), v === ALL ? 'Nu voor alle teams' : 'Team gewijzigd')}
              options={[...teamView.teams.map((tm) => ({ value: tm.id, label: tm.name, attrs: { translate: 'no' } })), { value: ALL, label: 'Alle teams' }]}
            />
            <MoreInfo>Bots van andere teams zien deze skill niet; met meekijken mogen ze hem lezen.</MoreInfo>
          </div>
        )}
        {s.blocked && <p className="mt-3 rounded-control bg-danger-soft px-3 py-2 text-sm text-danger">De beheerder heeft deze skill geblokkeerd.</p>}
        {s.catalogUpdate && s.curated?.update ? (
          <p className="mt-3 rounded-lg bg-accent-soft px-3 py-2 text-sm">
            {s.curated.update.origin === 'catalogus' ? 'De TeamBot-catalogus heeft een nieuwere versie van deze skill.' : 'De bron heeft een nieuwere versie van deze skill (nog niet door TeamBot bekeken).'}
            <PinUpdateNote update={s.curated.update} />{' '}
            <button type="button" className="font-medium text-accent underline" onClick={() => setDiffCommit(s.curated!.update!.to)}>
              Bekijk het verschil
            </button>
          </p>
        ) : s.catalogUpdate && (
          <p className="mt-3 rounded-lg bg-accent-soft px-3 py-2 text-sm">
            Versie {s.catalogUpdate.version} staat in de marktplaats.{' '}
            <a className="font-medium text-accent underline" href={`#/m/skills/skills?item=${encodeURIComponent(s.catalogUpdate.catalogId + '/' + s.catalogUpdate.itemId)}`}>
              Bekijken en bijwerken
            </a>
          </p>
        )}
      </div>
      <div className="mx-auto max-w-5xl space-y-4 px-4 pb-8 pt-4 sm:px-6">
        <Tabs
          value={isDraft && (tab === 'usage' || tab === 'tests') ? 'instructions' : tab}
          onChange={(v) => setTab(v as DTab)}
          tabs={[
            { id: 'instructions', label: 'Instructies' },
            ...(!isDraft ? [{ id: 'usage' as DTab, label: 'Bots' }, { id: 'tests' as DTab, label: 'Testen' }] : []),
            { id: 'security', label: 'Veiligheid' },
          ]}
        />
        {(tab === 'instructions' || (isDraft && tab !== 'security')) && (
          <div className="tb-in space-y-4">
            <InstructionsTab s={s} onSaved={load} onTest={() => setTab('tests')} />
            <Fold title="Bestanden" hint={String(s.files.length)} testId="skill-files">
              <FilesTab s={s} onSaved={load} />
            </Fold>
            <Fold title="Versies" hint={String(s.versions.length)} testId="skill-versions">
              <VersionsTab s={s} onChanged={load} />
            </Fold>
            <Fold title="Gegevens" testId="skill-info">
              <InfoTab s={s} />
            </Fold>
          </div>
        )}
        {!isDraft && tab === 'tests' && <TestsTab s={s} />}
        {tab === 'security' && <SecurityTab s={s} onChanged={load} />}
        {!isDraft && tab === 'usage' && <UsageTab s={s} onChanged={load} />}
      </div>
      {diffCommit && <UpdateDiffModal skillId={s.id} commit={diffCommit} onClose={() => (setDiffCommit(null), load())} />}
      <Confirm open={confirmDelete} onClose={() => setConfirmDelete(false)} title={isDraft ? 'Concept weggooien?' : `Skill ${s.name} verwijderen?`} confirmLabel={isDraft ? 'Weggooien' : 'Verwijderen'} danger busy={act.busy} onConfirm={remove}>
        <p>Dit wordt verwijderd:</p>
        <ul className="list-disc space-y-0.5 ps-5">
          <li>{t('{0, plural, one {de skill en zijn enige versie in je bibliotheek;} other {de skill en alle # versies in je bibliotheek;}}', s.versions.length)}</li>
          {s.agents.length > 0 && <li>de koppeling met {s.agents.map((a) => a.name).join(', ')};</li>}
          <li>
            de map van de skill in de werkmap van elke bot (<code>.claude/skills/{s.name}</code> en <code>.agents/skills/{s.name}</code>). Een map waarin je zelf iets hebt veranderd, laat TeamBot staan.
          </li>
        </ul>
        <p className="text-muted">Blijft bestaan: de oorspronkelijke bron en gesprekken waarin de skill gebruikt is.</p>
      </Confirm>
    </Page>
  );
}

function DraftBanner({ s, onChanged }: { s: SkillDetail; onChanged(): void }) {
  const agents = useApp((st) => st.agents);
  const [enable, setEnable] = useState(true);
  const [confirm, setConfirm] = useState<null | 'update'>(null);
  const [ok, setOk] = useState(false);
  const { busy, run } = useAsync();
  const draftBot = agents.find((a) => a.id === s.draftAgentId);
  const publish = (mode?: 'update', confirmPermissions?: boolean) =>
    run(async () => {
      const from = location.hash;
      const r = await api.post<SkillSummary>(`/skills/${s.id}/publish`, { mode, confirmPermissions, enableFor: enable && s.draftAgentId ? [s.draftAgentId] : [] });
      toast('Gepubliceerd', 'ok');
      if (r.id !== s.id) navigate(`/m/skills/mine/${r.id}`, { from });
      else onChanged();
    });
  return (
    <div className="tb-in mt-3 space-y-3 rounded-card border border-line bg-accent-soft p-4 text-sm">
      <p>
        <span className="font-semibold">Concept</span> van {s.draftAgent || s.source.label || 'een bot'}
        {s.draftThreadId && (
          <>
            {' '}
            uit{' '}
            <a className="text-accent underline" href={`#/t/${s.draftThreadId}`}>
              dit gesprek
            </a>
          </>
        )}
        . Lees het na; het werkt pas na publiceren.
      </p>
      {s.nameConflict && <p className="text-warn">Je hebt al een skill met de naam “{s.name}”. Geef het concept een andere naam (Bewerken) of publiceer het als nieuwe versie.</p>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {draftBot ? <Toggle checked={enable} onChange={setEnable} label={`Daarna aanzetten bij ${draftBot.name}`} /> : <span />}
        {s.nameConflict ? (
          <Button variant="primary" loading={busy} onClick={() => setConfirm('update')}>
            Publiceren als nieuwe versie
          </Button>
        ) : (
          <Button variant="primary" loading={busy} onClick={() => publish()}>
            Publiceren
          </Button>
        )}
      </div>
      <Confirm
        open={confirm === 'update'}
        onClose={() => setConfirm(null)}
        title="Als nieuwe versie publiceren?"
        confirmLabel={ok ? 'Publiceren' : 'Eerst bevestigen'}
        busy={busy}
        onConfirm={() => ok && publish('update', true)}
      >
        <p>De bestaande skill “{s.name}” krijgt de inhoud van dit concept als nieuwe versie. De vorige versie blijft bewaard; je kunt altijd terugdraaien.</p>
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={ok} onChange={(e) => setOk(e.target.checked)} />
          <span>Ik heb de inhoud en de rechten van het concept bekeken (tabblad Veiligheid).</span>
        </label>
      </Confirm>
    </div>
  );
}

function InstructionsTab({ s, onSaved, onTest }: { s: SkillDetail; onSaved(): void; onTest(): void }) {
  const [editing, setEditing] = useState(false);
  const [changed, setChanged] = useState(false);
  const [text, setText] = useState(s.skillMd);
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState(false);
  const { busy, run } = useAsync();
  useEffect(() => {
    if (!editing) setText(s.skillMd);
  }, [s.skillMd, editing]);
  const save = () =>
    run(async () => {
      const r = await api.put<{ status: string; warnings: string[]; scan: { level: string } }>(`/skills/${s.id}/content`, { skillMd: text, note });
      if (r.status === 'unchanged') toast('Geen wijzigingen');
      else {
        toast(r.warnings.length ? `Opgeslagen als nieuwe versie. Let op: ${r.warnings[0]}` : 'Opgeslagen als nieuwe versie', 'ok');
        setChanged(true);
      }
      setEditing(false);
      setNote('');
      onSaved();
    });
  if (!editing)
    return (
      <Card className="space-y-3 p-4">
        {changed && (
          <p className="rounded-lg bg-accent-soft px-3 py-2 text-sm">
            Nieuwe versie opgeslagen. Werkt hij nog zoals je wilt?{' '}
            <button type="button" className="font-medium text-accent underline" onClick={onTest}>
              Test deze versie
            </button>
          </p>
        )}
        <div className="flex justify-end">
          <Button size="sm" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(true)}>
            Bewerken
          </Button>
        </div>
        <Md text={bodyOf(s.skillMd)} />
      </Card>
    );
  return (
    <Card className="space-y-3 p-4">
      <p className="text-sm text-muted">Opslaan maakt een nieuwe versie; de vorige blijft bewaard.</p>
      <div className="flex gap-2 lg:hidden">
        <Button size="sm" variant={!preview ? 'soft' : 'ghost'} onClick={() => setPreview(false)}>
          Bewerken
        </Button>
        <Button size="sm" variant={preview ? 'soft' : 'ghost'} icon={<Eye className="h-4 w-4" />} onClick={() => setPreview(true)}>
          Voorbeeld
        </Button>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <Textarea aria-label="SKILL.md" className={cx('min-h-[420px] font-mono text-xs', preview && 'hidden lg:block')} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
        <div className={cx('max-h-[520px] overflow-y-auto rounded-lg border border-line p-3', !preview && 'hidden lg:block')}>
          <Md text={bodyOf(text)} />
        </div>
      </div>
      <Field label="Wat heb je veranderd? (optioneel)">
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Bijv. stap 3 verduidelijkt" />
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => (setEditing(false), setText(s.skillMd))}>
          Annuleren
        </Button>
        <Button variant="primary" loading={busy} onClick={save}>
          Opslaan
        </Button>
      </div>
    </Card>
  );
}

function FilesTab({ s, onSaved }: { s: SkillDetail; onSaved(): void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [content, setContent] = useState<{ text: string | null; binary: boolean; type: string; size: number } | null>(null);
  const [edit, setEdit] = useState<string | null>(null);
  const [newPath, setNewPath] = useState('');
  const [adding, setAdding] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const { busy, run } = useAsync();
  useEffect(() => {
    if (!open) return;
    setContent(null);
    api
      .get(`/skills/${s.id}/file?path=${encodeURIComponent(open)}`)
      .then(setContent)
      .catch((e) => (toast(e.message, 'danger'), setOpen(null)));
  }, [open, s.id]);
  const saveFile = (p: string, text: string | null) =>
    run(async () => {
      await api.put(`/skills/${s.id}/content`, { files: { [p]: text }, note: text === null ? `${p} verwijderd` : `${p} bewerkt` });
      setEdit(null);
      setOpen(null);
      setAdding(false);
      setConfirmDel(null);
      onSaved();
    }, 'Opgeslagen als nieuwe versie');
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" icon={<FilePlus2 className="h-4 w-4" />} onClick={() => (setAdding(true), setNewPath(''), setEdit(''))}>
          Nieuw bestand
        </Button>
      </div>
      <FileList files={s.files} onOpen={setOpen} />
      <Modal
        open={!!open && !adding}
        onClose={() => (setOpen(null), setEdit(null))}
        wide
        title={open}
        footer={
          open && open !== 'SKILL.md' && content && !content.binary ? (
            edit === null ? (
              <>
                <Button variant="ghost" icon={<Trash2 className="h-4 w-4 text-danger" />} onClick={() => setConfirmDel(open)}>
                  Verwijderen
                </Button>
                <Button icon={<Pencil className="h-4 w-4" />} onClick={() => setEdit(content.text || '')}>
                  Bewerken
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" onClick={() => setEdit(null)}>
                  Annuleren
                </Button>
                <Button variant="primary" loading={busy} onClick={() => saveFile(open, edit)}>
                  Opslaan
                </Button>
              </>
            )
          ) : undefined
        }
      >
        {!content ? (
          <Spinner />
        ) : content.binary ? (
          <p className="text-sm text-muted">Binair bestand ({formatBytes(content.size)}); kan niet als tekst getoond worden.</p>
        ) : edit !== null ? (
          <Textarea aria-label="Inhoud" className="min-h-[360px] font-mono text-xs" value={edit} onChange={(e) => setEdit(e.target.value)} spellCheck={false} />
        ) : open?.toLowerCase().endsWith('.md') ? (
          <Md text={open === 'SKILL.md' ? bodyOf(content.text || '') : content.text || ''} />
        ) : (
          <pre className="overflow-auto whitespace-pre-wrap break-words text-xs">{content.text}</pre>
        )}
        {open === 'SKILL.md' && <p className="mt-3 text-xs text-muted">SKILL.md bewerk je bij Instructies.</p>}
      </Modal>
      <Modal
        open={adding}
        onClose={() => (setAdding(false), setEdit(null))}
        wide
        title="Nieuw bestand"
        footer={
          <Button variant="primary" loading={busy} disabled={!newPath.trim()} onClick={() => saveFile(newPath.trim(), edit || '')}>
            Opslaan
          </Button>
        }
      >
        <div className="space-y-3">
          <Field label="Pad binnen de skill" hint="Bijv. voorbeelden/offerte.md">
            <Input value={newPath} onChange={(e) => setNewPath(e.target.value)} />
          </Field>
          <Textarea aria-label="Inhoud" className="min-h-[260px] font-mono text-xs" value={edit || ''} onChange={(e) => setEdit(e.target.value)} />
        </div>
      </Modal>
      <Confirm open={!!confirmDel} onClose={() => setConfirmDel(null)} title={t('{0} verwijderen?', confirmDel ?? '')} confirmLabel="Verwijderen" danger busy={busy} onConfirm={() => confirmDel && saveFile(confirmDel, null)}>
        <p>Er komt een nieuwe versie zonder dit bestand. De vorige versie blijft bewaard.</p>
      </Confirm>
    </div>
  );
}

function VersionsTab({ s, onChanged }: { s: SkillDetail; onChanged(): void }) {
  const [view, setView] = useState<null | (VersionView & { skillMd: string })>(null);
  const [confirm, setConfirm] = useState<VersionView | null>(null);
  const [ok, setOk] = useState(false);
  const { busy, run } = useAsync();
  const activate = (v: VersionView, confirmPermissions = false) =>
    run(async () => {
      await api.post(`/skills/${s.id}/versions/${v.rev}/activate`, { confirmPermissions });
      setConfirm(null);
      setView(null);
      onChanged();
    }, `Versie ${v.version || 'r' + v.rev} is nu actief`);
  return (
    <div className="space-y-3">
      {s.pinned && <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm">Vastgepind: updates uit een bron worden bewaard als nieuwe versie, maar niet automatisch actief.</p>}
      <ul className="space-y-2">
        {s.versions.map((v) => (
          <li key={v.rev}>
            <Card className="flex flex-wrap items-center gap-3 p-3">
              <History className="h-4 w-4 text-muted" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{v.version ? `v${v.version}` : `Versie ${v.rev}`}</span>
                  <span className="text-xs text-muted">r{v.rev}</span>
                  {v.active && <Badge tone="ok">Actief</Badge>}
                  {v.diffFromActive?.elevated && !v.active && <Badge tone="warn">Meer rechten</Badge>}
                  {v.signature && <SignatureBadge sig={v.signature} />}
                  <LabelBadges labels={v.labels.filter((l) => l !== 'prompt-only')} />
                </div>
                <div className="text-xs text-muted">
                  {fmtDate(v.createdAt)} · {SOURCE_TYPES[v.source?.type] || v.createdBy}
                  {v.note ? ` · ${v.note}` : ''}
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => run(async () => setView(await api.get(`/skills/${s.id}/versions/${v.rev}`)))}>
                  Bekijken
                </Button>
                <a className="inline-flex h-8 items-center rounded-lg px-2.5 text-sm hover:bg-surface-2" href={authUrl(`/skills/${s.id}/download?rev=${v.rev}`)} aria-label={t('Versie {0} downloaden', v.rev)}>
                  <Download className="h-4 w-4" />
                </a>
                {!v.active && (
                  <Button size="sm" onClick={() => (v.diffFromActive?.elevated ? (setOk(false), setConfirm(v)) : activate(v))} loading={busy}>
                    {v.rev < s.activeRev ? 'Terugdraaien' : 'Gebruiken'}
                  </Button>
                )}
              </div>
            </Card>
          </li>
        ))}
      </ul>
      {s.catalogItem && s.catalogItem.changelog.length > 0 && (
        <Card className="space-y-2 p-4">
          <CardHead icon={History} title={<>Wijzigingen volgens de uitgever ({s.catalogItem.publisher})</>} />
          <ul className="space-y-1 text-sm">
            {s.catalogItem.changelog.map((c, i) => (
              <li key={i}>
                <span className="font-medium">{c.version}</span> {c.date && <span className="text-muted">({c.date})</span>} — {c.notes}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Modal open={!!view} onClose={() => setView(null)} wide title={view ? `${view.version ? 'v' + view.version : 'Versie ' + view.rev} (r${view.rev})` : ''}>
        {view && (
          <div className="space-y-3">
            {view.diffFromActive && !view.active && (
              <div className="rounded-lg border border-line p-3">
                <div className="mb-1 text-sm font-medium">Rechten ten opzichte van de actieve versie</div>
                <DiffView d={view.diffFromActive} />
              </div>
            )}
            <Md text={bodyOf(view.skillMd)} />
          </div>
        )}
      </Modal>
      <Confirm open={!!confirm} onClose={() => setConfirm(null)} title="Deze versie vraagt meer rechten" confirmLabel="Versie gebruiken" busy={busy} onConfirm={() => confirm && ok && activate(confirm, true)}>
        {confirm?.diffFromActive && <DiffView d={confirm.diffFromActive} />}
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={ok} onChange={(e) => setOk(e.target.checked)} />
          <span>Ik heb de extra rechten bekeken en wil deze versie gebruiken.</span>
        </label>
      </Confirm>
    </div>
  );
}

function SecurityTab({ s, onChanged }: { s: SkillDetail; onChanged(): void }) {
  const [ask, setAsk] = useState(false);
  const [ok, setOk] = useState(false);
  const { busy, run } = useAsync();
  const setTrust = (trusted: boolean) =>
    run(async () => {
      await api.post(`/skills/${s.id}/trust`, { trusted });
      setAsk(false);
      onChanged();
    }, trusted ? 'Scripts vertrouwd' : 'Vertrouwen ingetrokken');
  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <CardHead icon={ScanSearch} tone="rose" title="Veiligheidsscan" />
          <ScanBadge level={s.scan.level} />
          <LabelBadges labels={s.scan.labels} />
        </div>
        <p className="text-sm text-muted">
          Een schone scan is geen garantie: lees een skill van een ander altijd na. <MoreInfo>De scan zoekt naar scripts, verdachte instructies, datalekken en geheimen.</MoreInfo>
        </p>
        <FindingsList findings={s.scan.findings} />
      </Card>
      <Card className="space-y-3 p-4">
        <CardHead icon={BadgeCheck} tone="amber" title="Uitgever en handtekening" />
        <SignaturePanel sig={s.signature} onTrusted={onChanged} />
        {s.signature.state === 'unsigned' && <p className="text-sm text-muted">Een eigen of bewerkte skill is nooit ondertekend: na een bewerking hoort de inhoud niet meer bij de handtekening van de uitgever.</p>}
      </Card>
      <Card className="space-y-3 p-4">
        <CardHead icon={Lock} tone="rose" title="Rechten en externe aanroepen" />
        <PermissionsView p={s.permissions} />
      </Card>
      {s.kind === 'scripts' && (
        <Card className="space-y-3 p-4">
          <CardHead icon={ShieldCheck} tone="rose" title="Scripts vertrouwen" />
          <p className="text-sm text-muted">
            Scripts: {s.trusted ? 'vertrouwd' : 'niet vertrouwd'}. Een vertrouwd script krijgt geen sleutels van deze computer, maar wel de sleutels voor scripts die je de bot hebt gegeven.{' '}
            <MoreInfo>
              Bij toevoegen staan de scripts meteen aan. Trek je het vertrouwen in, dan kunnen alleen bots op “Volledige toegang” de scripts lezen en uitvoeren; andere bots niet. Of een bot eerst om toestemming vraagt, hangt af van zijn toegang: op “Vraagt toestemming” vraagt hij het bij elk script, op “Automatisch” en “Volledige toegang” voert hij het zelf uit, tenzij een eigen regel van jou zegt dat hij moet vragen. Het script draait vanuit een verse kopie, in de werkmap van de bot, met een eigen tijdelijke thuismap en alleen de sleutels van Bot › Sleutels voor scripts. Dat is geen volledige afscherming: een script kan nog steeds andere mappen lezen als het daar zelf naartoe gaat. Een nieuwe versie die je toevoegt, neemt over wat je hier koos.
            </MoreInfo>
          </p>
          {s.trusted ? (
            <Button variant="secondary" loading={busy} onClick={() => setTrust(false)}>
              Vertrouwen intrekken
            </Button>
          ) : (
            <Button variant="secondary" disabled={s.status === 'draft'} onClick={() => (setOk(false), setAsk(true))}>
              Vertrouw deze skill…
            </Button>
          )}
          {s.status === 'draft' && <p className="text-xs text-muted">Publiceer het concept eerst.</p>}
        </Card>
      )}
      <Confirm open={ask} onClose={() => setAsk(false)} title={t('Scripts van {0} vertrouwen?', s.name)} confirmLabel="Vertrouwen" danger={s.scan.level === 'danger'} busy={busy} onConfirm={() => ok && setTrust(true)}>
        <p>Deze bestanden worden uitvoerbaar voor bots die de skill hebben:</p>
        <ul className="list-disc ps-5">
          {s.permissions.scripts.map((x) => (
            <li key={x.path}>
              <code>{x.path}</code>
            </li>
          ))}
        </ul>
        <p>Let op: een vertrouwd script krijgt ook de sleutels voor scripts van de bot, en kan die naar buiten sturen.</p>
        {s.scan.level === 'danger' && <p className="text-danger">De scan gaf ernstige waarschuwingen. Vertrouw deze skill alleen als je de scripts zelf hebt gelezen.</p>}
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={ok} onChange={(e) => setOk(e.target.checked)} />
          <span>Ik heb de scripts bekeken en vertrouw de bron.</span>
        </label>
      </Confirm>
    </div>
  );
}

function UsageTab({ s, onChanged }: { s: SkillDetail; onChanged(): void }) {
  const agents = useApp((st) => st.agents);
  const list = useMemo(() => agents.filter((a) => !a.archived), [agents]);
  // The bots that have the skill now (the server's answer: every bot of the team, minus the ones it was taken from).
  const value = list.filter((a) => s.agents.some((x) => x.id === a.id)).map((a) => a.id);
  const { busy, run } = useAsync();
  // Saved at once (one request for "Alle bots"); a bot left out can no longer load the skill.
  const change = (ids: string[]) => {
    const added = ids.filter((x) => !value.includes(x)).length;
    const removed = value.filter((x) => !ids.includes(x)).length;
    run(
      async () => {
        await api.put(`/skills/${s.id}/agents`, { agentIds: ids });
        onChanged();
      },
      added && !removed ? (added === 1 ? 'Aan bij 1 bot' : `Aan bij ${added} bots`) : 'Opgeslagen',
    );
  };
  if (!list.length) return <EmptyState title="Nog geen bots">Zodra je een bot hebt, kan hij deze skill meteen gebruiken.</EmptyState>;
  return (
    <Card className="space-y-3 p-4">
      <BotPicker
        value={value}
        onChange={change}
        disabled={busy || s.status !== 'active'}
        label="Bots die deze skill hebben"
        hint={
          <>
            Een nieuwe skill heeft elke bot van het team meteen. Vink je hier een bot uit, dan kan die bot de skill niet meer laden; vink je hem weer aan, dan heeft hij hem weer. Wijzigingen worden direct opgeslagen. Gebruikt: {s.useCount}× {s.lastUsedAt ? `(laatst ${timeAgo(s.lastUsedAt)})` : ''}. {s.status !== 'active' && 'De skill staat uit: geen bot kan hem nu laden.'}
          </>
        }
      />
    </Card>
  );
}

function InfoTab({ s }: { s: SkillDetail }) {
  const m = s.meta;
  const rows: [string, React.ReactNode][] = [
    ['Bron', `${SOURCE_TYPES[s.source.type] || s.source.type}${s.source.label ? ` — ${s.source.label}` : ''}`],
    ...(s.source.url ? [['Adres', <span className="break-all">{s.source.url}</span>] as [string, React.ReactNode]] : []),
    ...(s.source.path ? [['Map', <code className="break-all">{s.source.path}</code>] as [string, React.ReactNode]] : []),
    ...(s.source.type === 'catalog' ? [['Marktplaats', <VerifiedBadge verified={!!s.source.verified} />] as [string, React.ReactNode]] : []),
    // A skill from GitHub on a pinned commit: of the checked catalogue, or added from the open search (not checked).
    ...(s.source.type === 'curated' || s.source.commit
      ? ([
          ...(s.source.type !== 'curated' ? [['Controle', 'Niet door TeamBot gecontroleerd (toegevoegd uit Open in de marktplaats)']] : []),
          ['Vastgezette versie', <span className="break-all font-mono text-xs">{`${s.source.repo || ''} @ ${/^[0-9a-f]{40}$/.test(s.source.commit || '') ? (s.source.commit || '').slice(0, 7) : s.source.commit || ''}${s.source.commitDate ? ` (${s.source.commitDate})` : ''}`}</span>],
          ['Licentie (bestand)', `${s.source.license || '—'}${s.source.licenseFile ? ` · ${s.source.licenseFile}` : ''}`],
          ...(s.source.dropped?.length ? [['Weggelaten', s.source.dropped.map((d) => d.path).join(', ')]] : []),
        ] as [string, React.ReactNode][])
      : []),
    ['Uitgever / auteur', s.source.publisher || m.author || '—'],
    ['Licentie', m.license || '—'],
    ['Versie', m.version || '—'],
    ['Afhankelijkheden', m.dependencies.length ? m.dependencies.join(', ') : '—'],
    ['Platform', m.platforms.length ? m.platforms.join(', ') : m.compatibility || 'Niet opgegeven'],
    ['Verwachte tools', m.allowedTools.length ? m.allowedTools.join(', ') : '—'],
    ['Website', m.homepage ? <span className="break-all">{m.homepage}</span> : '—'],
    ['Checksum (sha256)', <code className="break-all text-xs">{s.checksum}</code>],
    ['Toegevoegd', fmtDate(s.createdAt)],
    ['Bijgewerkt', fmtDate(s.updatedAt)],
  ];
  return (
    <Card className="p-4">
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[12rem_1fr]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="min-w-0">{v}</dd>
          </div>
        ))}
        {Object.keys(m.metadata || {}).length > 0 && (
          <>
            <dt className="text-muted">Metadata</dt>
            <dd className="min-w-0 text-xs">
              {Object.entries(m.metadata).map(([k, v]) => (
                <div key={k} className="break-all">
                  <span className="font-medium">{k}</span>: {v}
                </div>
              ))}
            </dd>
          </>
        )}
      </dl>
      {s.warnings.length > 0 && (
        <ul className="mt-3 list-disc ps-5 text-sm text-warn">
          {s.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}
