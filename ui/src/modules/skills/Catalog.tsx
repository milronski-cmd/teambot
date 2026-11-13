import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ExternalLink, GitCompare, Link2, Plus, Puzzle, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Modal, Page, PageHeader, Spinner, cx, toast, useAsync } from '../../components/ui';
import { MoreInfo } from '../../components/MoreInfo';
import { api, on } from '../../lib/api';
import { navigate } from '../../lib/router';
import { t } from '../../lib/i18n';
import { Words } from '../../components/Words';
import type { CuratedCard, CuratedDetail, CuratedDiff, CuratedList, FileDiffView, StagingView } from './api';
import { formatBytes } from './api';
import { ErrorCard, LoadingCards, Meta, SearchBox, useList, useMarketMenu } from './marketParts';
import { CandidatesReview, Collapse, DiffView, FileList, FindingsList, Md, PermissionsView, ScanBadge, ThinSkillWarning, bodyOf } from './common';
import { ImportDialog } from './ImportDialog';
import { TeamPlacePicker, useSkillPlace } from './TeamPlace';
import { TestRunPanel } from './SkillTests';
import { CategoryTiles, SkillCard, SkillIcon, SourceLine, niceName, skillHref, useAddSkill } from './ClearMarket';
import { tileIdOf, tilesFor } from './marketGroups';

/**
 * TeamBot's own skill catalogue: known publishers, each skill pinned to one commit, licence checked per folder.
 * Installing fetches exactly that version; scripts stay off until the owner trusts the skill. A newer version is only
 * ever shown as a difference that the owner approves.
 */

const short = (c: string | null | undefined) => (c ? c.slice(0, 7) : '');
/** A pin as people read it: "commit 1a2b3c4" (GitHub) or "versie 1.2.0" (a skill library with versions). */
const pinLabel = (c: string | null | undefined) => (!c ? '' : /^[0-9a-f]{40}$/.test(c) ? `commit ${short(c)}` : `versie ${c}`);

const WINDOWS_LABEL: Record<string, string> = { ja: 'Windows: werkt', deels: 'Windows: deels', 'niet-getest': 'Windows: scripts niet getest' };

function ScriptsBadge({ c }: { c: Pick<CuratedCard, 'scripts' | 'installed'> }) {
  if (!c.scripts) return null;
  if (c.installed?.trusted) return <Badge tone="ok">scripts: vertrouwd</Badge>;
  return (
    <Badge tone="neutral" className="whitespace-nowrap">
      scripts: uit
    </Badge>
  );
}

export function CatalogSkills({ initialItem, initialQuery }: { initialItem?: string | null; initialQuery?: string }) {
  // Package B4: installs go to one team or to all teams; "Toegevoegd" is what that team has.
  const place = useSkillPlace();
  const { data, error, reload } = useList<CuratedList>(`/skills/curated${place.query}`);
  const [q, setQ] = useState(initialQuery || '');
  const [tile, setTile] = useState('');
  const [review, setReview] = useState<StagingView | null>(null);
  const [diff, setDiff] = useState<{ skillId: string; commit: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const check = useAsync();
  const adder = useAddSkill({ teamId: place.teamId, onReview: setReview, onDone: reload });
  useEffect(() => on('skills.updated', reload), [reload]);
  // An old link to one skill (`?item=curated/<id>`): its own page.
  useEffect(() => {
    if (initialItem) navigate(skillHref(initialItem));
  }, [initialItem]);
  const installedCount = data?.items.filter((i) => i.installed).length || 0;
  const checkUpdates = () =>
    check.run(async () => {
      const r = await api.post<{ checked: number; updates: { name: string }[]; errors: { repo: string; error: string }[] }>('/skills/curated/check-updates', { force: true, ...(place.query ? { teamId: place.teamId } : {}) });
      reload();
      if (r.updates.length) toast(r.updates.length === 1 ? `Nieuwe versie bij de bron: ${r.updates[0].name}. Bekijk eerst het verschil.` : `${r.updates.length} skills hebben een nieuwe versie. Bekijk eerst het verschil.`, 'ok');
      else if (!r.errors.length) toast('Alles is bijgewerkt', 'ok');
      if (r.errors.length) toast(`Niet bereikbaar: ${[...new Set(r.errors.map((e) => e.repo))].join(', ')}`, 'danger');
    });
  const searched = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (data?.items || []).filter((i) => words.every((w) => `${i.name} ${niceName(i.name)} ${i.note} ${i.publisher} ${i.repo} ${i.category} ${i.pack}`.toLowerCase().includes(w)));
  }, [data, q]);
  const tiles = useMemo(() => tilesFor(searched, (i) => i), [searched]);
  const activeTile = tiles.some((x) => x.id === tile) ? tile : '';
  const shown = useMemo(() => (activeTile ? searched.filter((i) => tileIdOf(i.category, i.pack) === activeTile) : searched), [searched, activeTile]);
  // Rarely needed: in the page's "Meer opties".
  useMarketMenu('catalog', [installedCount > 0 && { label: 'Controleer op nieuwe versies', icon: <RefreshCw aria-hidden />, disabled: check.busy, onSelect: checkUpdates }], [installedCount, check.busy, place.teamId]);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={setQ} label="Zoek een skill" />
        <TeamPlacePicker place={place} label="Team" />
        <Button className="sm:ms-auto" icon={<Link2 className="h-4 w-4" />} onClick={() => setImporting(true)} data-testid="market-add-link">
          Toevoegen via link
        </Button>
      </div>
      {/* The row of subjects keeps its height while the list loads, so the cards never move down. */}
      {data ? <CategoryTiles tiles={tiles} value={activeTile} onChange={setTile} /> : !error && <div className="h-9 coarse:h-11" aria-hidden />}
      {error ? (
        <ErrorCard error={error} retry={reload} />
      ) : !data ? (
        <LoadingCards n={6} />
      ) : !shown.length ? (
        <EmptyState
          icon={<Puzzle />}
          title="Geen skills gevonden"
          action={
            <span className="flex flex-wrap justify-center gap-2">
              {(q || activeTile) && <Button onClick={() => (setQ(''), setTile(''))}>Alles tonen</Button>}
              <Button icon={<Link2 className="h-4 w-4" />} onClick={() => setImporting(true)}>
                Toevoegen via link
              </Button>
            </span>
          }
        >
          Probeer een ander zoekwoord (ook in het Engels). Heb je de skill elders gevonden, bijvoorbeeld op GitHub? Voeg hem toe via de link.
        </EmptyState>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((c) => (
            <li key={c.id} className="min-w-0">
              <SkillCard c={c} adder={adder} onDiff={setDiff} />
            </li>
          ))}
        </ul>
      )}
      {data && shown.length > 0 && (
        <p className="text-xs text-muted">
          {t('{0, plural, one {# skill} other {# skills}}, de meeste sterren op GitHub eerst. Gratis, met een open licentie en op een vaste versie.', shown.length)}{' '}
          <MoreInfo>
            Toevoegen is één klik: de skill werkt meteen voor alle bots van je team, scripts inbegrepen. Een script draait zoals elke opdracht op het niveau van de bot. Bronnen ({data.sources[0]?.verifiedAt || '—'}): {data.sources.map((s) => `${s.repo} (${s.license})`).join(', ')}.
          </MoreInfo>
        </p>
      )}
      <ImportDialog open={importing} onClose={() => (setImporting(false), reload())} initialTab="url" />
      {review && <ReviewModal staging={review} onClose={() => (setReview(null), reload())} />}
      {diff && <UpdateDiffModal skillId={diff.skillId} commit={diff.commit} onClose={() => (setDiff(null), reload())} />}
    </div>
  );
}

/** A catalogue skill that needs a confirmation first (scan warning, publisher): the regular review. */
export function ReviewModal({ staging, onClose }: { staging: StagingView; onClose(): void }) {
  return (
    <Modal open wide onClose={onClose} title="Controleren en toevoegen">
      <p className="mb-3 text-sm text-muted">Deze skill vraagt een bevestiging. Lees de punten hieronder en voeg hem daarna toe.</p>
      <CandidatesReview staging={staging} doneLabel="Toegevoegd. Je bots kunnen de skill meteen gebruiken." />
    </Modal>
  );
}

/**
 * One skill as a page of its own (with the way back): what it does, where it comes from and why it is here (stars,
 * repository, licence), one button "Toevoegen", then the instructions the bot gets and the details of the check. The
 * same page for a skill of the checked catalogue and for an open result (`checked: false`), which says so.
 */
export function CuratedDetailPage({ id }: { id: string }) {
  const [d, setD] = useState<CuratedDetail | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const [review, setReview] = useState<StagingView | null>(null);
  const [diff, setDiff] = useState<{ skillId: string; commit: string } | null>(null);
  const reload = () => setTick((x) => x + 1);
  const adder = useAddSkill({ onReview: setReview, onDone: reload });
  useEffect(() => {
    setError('');
    api
      .get<CuratedDetail>(`/skills/curated/item?id=${encodeURIComponent(id)}`)
      .then(setD)
      .catch((e) => setError(e.message));
  }, [id, tick]);
  const back = { href: '#/m/skills/skills', label: 'Marktplaats' };
  if (error)
    return (
      <Page>
        <PageHeader width="4xl" title="Skill" back={back} />
        <div className="mx-auto max-w-4xl px-4 pb-8 sm:px-6">
          <ErrorCard error={error} retry={reload} />
        </div>
      </Page>
    );
  if (!d)
    return (
      <Page>
        <PageHeader width="4xl" title="Skill" back={back} />
        <div className="mx-auto flex max-w-4xl items-center gap-2 px-4 pb-8 text-sm text-muted sm:px-6">
          <Spinner /> Ophalen en controleren (er wordt niets uitgevoerd)…
        </div>
      </Page>
    );
  // An open result: public on GitHub, looked at by nobody at TeamBot; the checks are the ones at install.
  const open = d.checked === false;
  return (
    <Page>
      <PageHeader
        width="4xl"
        back={back}
        title={<span translate="no">{niceName(d.name)}</span>}
        subtitle={open ? <span translate="no">{d.note}</span> : d.note}
        actions={
          d.installed ? (
            d.installed.update ? (
              <Button variant="primary" icon={<GitCompare className="h-4 w-4" />} onClick={() => setDiff({ skillId: d.installed!.skillId, commit: d.installed!.update!.to })}>
                Nieuwe versie: bekijk verschil
              </Button>
            ) : (
              <Button onClick={() => navigate(`/m/skills/mine/${d.installed!.skillId}`)}>Beheren</Button>
            )
          ) : (
            <Button variant="primary" loading={adder.busyId === d.id} disabled={!d.installable} onClick={() => adder.add(d)} icon={<Plus className="h-4 w-4" />} data-testid="skill-add">
              Toevoegen
            </Button>
          )
        }
      />
      <div className="mx-auto max-w-4xl space-y-4 px-4 pb-8 pt-2 sm:px-6" data-skill-page={d.id}>
        <Card className="space-y-3 p-4">
          <div className="flex min-w-0 items-start gap-3">
            <SkillIcon c={d} size="lg" />
            <div className="min-w-0 flex-1 space-y-1">
              <a className="inline-flex max-w-full items-center gap-1.5 text-sm font-medium hover:underline" href={d.url} target="_blank" rel="noopener noreferrer">
                <SourceLine c={d} className="text-sm" />
                <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
              </a>
              <div className="flex flex-wrap items-center gap-1.5">
                {d.installed && (
                  <Badge tone="ok">
                    <CheckCircle2 className="h-3 w-3" /> Toegevoegd
                  </Badge>
                )}
                {open ? (
                  <Badge tone="warn">
                    <ShieldAlert className="h-3 w-3" /> Niet gecontroleerd
                  </Badge>
                ) : (
                  <Badge tone="ok">
                    <ShieldCheck className="h-3 w-3" /> Gecontroleerd
                  </Badge>
                )}
                <Badge>{d.licenseFound.spdx || d.license || 'geen licentie gevonden'}</Badge>
                <ScriptsBadge c={d} />
                {(d.scan.level === 'warn' || d.scan.level === 'danger') && <ScanBadge level={d.scan.level} />}
              </div>
            </div>
          </div>
          <p className="text-sm text-muted">
            {d.installed
              ? 'Alle bots van je team kunnen deze skill gebruiken. Een bot laadt hem zelf zodra een taak erbij past.'
              : 'Na toevoegen kunnen alle bots van je team deze skill meteen gebruiken. Een bot laadt hem zelf zodra een taak erbij past; je hoeft niets in te stellen.'}
          </p>
          {open && (
            <p className="rounded-control bg-surface-2 px-3 py-2 text-sm text-muted" data-testid="skill-open-note">
              {d.host === 'clawhub' ? 'Van ClawHub' : 'Van GitHub'}, niet door TeamBot gecontroleerd. TeamBot heeft de bestanden nu gelezen en gescand; er is niets uitgevoerd. Je krijgt de versie van dit moment (<span className="font-mono">{pinLabel(d.commit)}</span>); een latere wijziging bij de bron zie je eerst als verschil.
            </p>
          )}
          {d.publisherStatus === 'lookalike' && d.publisherNote && <p className="rounded-control bg-warn-soft px-3 py-2 text-sm text-warn">{d.publisherNote} TeamBot vraagt bij toevoegen eerst je bevestiging.</p>}
          {d.needs && (
            <p className="text-sm text-muted">
              <span className="font-medium text-fg">Nodig:</span> {d.needs}
            </p>
          )}
          {d.windows && d.windows.status !== 'ja' && (
            <p className="text-sm text-muted">
              <span className="font-medium text-fg">{WINDOWS_LABEL[d.windows.status]}.</span> {d.windows.note}
            </p>
          )}
          {d.problems.length > 0 && (
            <div className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
              <div className="font-medium">Niet toe te voegen: deze versie voldoet niet aan de importregels.</div>
              <ul className="mt-1 list-disc ps-5">
                {d.problems.map((p) => (
                  <li key={p} className="break-words">
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <ThinSkillWarning s={d.substance} />
          {d.scripts && (
            <p className="rounded-control bg-surface-2 px-3 py-2 text-sm text-muted">
              Deze skill bevat scripts: {d.files.filter((f) => f.type === 'script' || f.type === 'executable').map((f) => f.path).slice(0, 6).join(', ') || '—'}. Ze staan na toevoegen uit en er wordt niets uitgevoerd.{' '}
              <MoreInfo>
                Vertrouw je de skill (Geïnstalleerd › de skill › Veiligheid), dan vraagt de bot nog steeds bij elk script om toestemming, en draait het script in de werkmap met een eigen tijdelijke thuismap. Het krijgt geen sleutels van deze computer, alleen de sleutels voor scripts die je de bot zelf hebt gegeven.
              </MoreInfo>
            </p>
          )}
        </Card>

        <Card className="space-y-2 p-4">
          <h2 className="text-sm font-semibold">Wat de bot leest</h2>
          <p className="break-words text-xs text-muted" translate="no">
            {d.meta.description}
          </p>
          <div className="max-h-[28rem] overflow-y-auto rounded-lg border border-line p-3">
            <Md text={bodyOf(d.skillMd)} />
          </div>
        </Card>

        <Card className="space-y-3 p-4">
          <h2 className="text-sm font-semibold">Herkomst en controle</h2>
          <Meta
            items={[
              ['Uitgever', <span translate="no">{d.publisher}</span>],
              ['Sterren', d.stars ? `${d.stars.toLocaleString('nl-NL')} op GitHub${d.verifiedAt ? ` (geteld op ${d.verifiedAt})` : ''}` : ''],
              [
                'Bron',
                <a className="inline-flex items-center gap-1 break-all text-accent underline" href={d.url} target="_blank" rel="noopener noreferrer">
                  {d.repo}
                  {d.path ? `/${d.path}` : ''} <ExternalLink className="h-3 w-3" />
                </a>,
              ],
              ['Versie', `${pinLabel(d.commit)}${d.commitDate ? ` (${d.commitDate})` : ''}${d.meta.version && d.meta.version !== d.commit ? ` · v${d.meta.version}` : ''}`],
              ['Licentie', `${d.licenseFound.spdx || (open ? 'Geen licentie gevonden' : '—')}${d.licenseFound.file ? ` (bestand ${d.licenseFound.file}${d.licenseFound.storedAs && d.licenseFound.storedAs !== d.licenseFound.file?.split('/').pop() ? `, bewaard als ${d.licenseFound.storedAs}` : ''})` : ''}`],
              ['Omvang', `${d.files.length === 1 ? '1 bestand' : `${d.files.length} bestanden`}, ${formatBytes(d.size)}`],
            ]}
          />
          <section className="space-y-2">
            <div className="text-sm font-semibold">Wat de skill mag en aanroept</div>
            <PermissionsView p={d.permissions} />
          </section>
          {(d.dropped.length > 0 || d.sourceFiles.length > 0 || d.description.changed) && (
            <Collapse title="Wat TeamBot aanpaste of wegliet">
              <ul className="list-disc space-y-1 ps-5 text-sm text-muted">
                {d.dropped.map((x) => (
                  <li key={x.path} className="break-words">
                    Weggelaten: <span className="font-mono text-xs">{x.path}</span> — {x.reason}
                  </li>
                ))}
                {d.sourceFiles.length > 0 && (
                  <li>
                    {t('{0, plural, one {# bestand van buiten de skillmap meegenomen} other {# bestanden van buiten de skillmap meegenomen}}', d.sourceFiles.length)} (de skill verwijst ernaar), in de map <span className="font-mono text-xs">{d.sourceDir}/</span>.
                  </li>
                )}
                {d.description.changed && <li>De beschrijving in SKILL.md is aangepast naar geldig formaat; de inhoud is gelijk gebleven.</li>}
              </ul>
            </Collapse>
          )}
          <Collapse title={d.scan.findings.length === 1 ? 'Veiligheidsscan (1 bevinding)' : `Veiligheidsscan (${d.scan.findings.length} bevindingen)`} defaultOpen={d.scan.level === 'warn' || d.scan.level === 'danger'}>
            <FindingsList findings={d.scan.findings} />
          </Collapse>
          <Collapse title={d.files.length === 1 ? 'Bestanden (1)' : `Bestanden (${d.files.length})`}>
            <FileList files={d.files} />
          </Collapse>
        </Card>
      </div>
      {review && <ReviewModal staging={review} onClose={() => (setReview(null), reload())} />}
      {diff && <UpdateDiffModal skillId={diff.skillId} commit={diff.commit} onClose={() => (setDiff(null), reload())} />}
    </Page>
  );
}

function FileDiff({ f }: { f: FileDiffView }) {
  const label = f.status === 'added' ? 'nieuw' : f.status === 'removed' ? 'verwijderd' : 'gewijzigd';
  return (
    <div className="rounded-lg border border-line">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-1.5 text-xs">
        <span className="min-w-0 flex-1 break-all font-mono">{f.path}</span>
        <Badge tone={f.status === 'removed' ? 'danger' : f.status === 'added' ? 'accent' : 'warn'}>{label}</Badge>
        <span className="text-ok">+{f.diff.added}</span>
        <span className="text-danger">−{f.diff.removed}</span>
      </div>
      {f.diff.tooLarge ? (
        <p className="p-3 text-xs text-muted">Te veel verschillen om regel voor regel te tonen; open de vergelijking bij de bron.</p>
      ) : (
        <div className="max-h-96 overflow-y-auto font-mono text-xs">
          {f.diff.hunks.map((h, i) => (
            <div key={i} className={cx(i > 0 && 'border-t border-dashed border-line')}>
              {h.lines.map((l, j) => (
                <div key={j} className={cx('flex gap-2 px-2', l.op === '+' ? 'bg-ok-soft text-ok' : l.op === '-' ? 'bg-danger-soft text-danger' : 'text-muted')}>
                  <span className="w-4 shrink-0 select-none text-center" aria-hidden>
                    {l.op === ' ' ? '' : l.op === '-' ? '−' : '+'}
                  </span>
                  <span className="sr-only">{l.op === '+' ? 'toegevoegd: ' : l.op === '-' ? 'verwijderd: ' : ''}</span>
                  <span className="min-w-0 flex-1 whitespace-pre-wrap break-words" translate="no">{l.text || ' '}</span>
                </div>
              ))}
            </div>
          ))}
          {f.diff.truncated && <p className="px-3 py-2 text-muted">Ingekort; de rest staat in de vergelijking bij de bron.</p>}
        </div>
      )}
    </div>
  );
}

/** What an update of a catalogue skill changes, file by file; applied only when the owner says so. */
export function UpdateDiffModal({ skillId, commit, onClose }: { skillId: string; commit: string; onClose(): void }) {
  const [d, setD] = useState<CuratedDiff | null>(null);
  const [error, setError] = useState('');
  const [ack, setAck] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [done, setDone] = useState('');
  const { busy, run } = useAsync();
  useEffect(() => {
    api
      .get<CuratedDiff>(`/skills/curated/diff?skillId=${encodeURIComponent(skillId)}&commit=${encodeURIComponent(commit)}`)
      .then(setD)
      .catch((e) => setError(e.message));
  }, [skillId, commit]);
  const needAck = d?.scan.level === 'danger';
  const needConfirm = !!d?.permissions.elevated;
  const apply = () =>
    run(async () => {
      const r = await api.post<{ status: string; error?: string }>('/skills/curated/update', { skillId, commit, acknowledge: ack, confirmPermissions: confirm });
      if (['updated', 'version-added', 'unchanged'].includes(r.status)) {
        setDone(r.status === 'version-added' ? 'De nieuwe versie is bewaard; de skill is vastgepind en blijft op de huidige versie.' : 'Bijgewerkt. De vorige versie staat nog onder Versies.');
        toast('Skill bijgewerkt', 'ok');
      } else throw new Error(r.error || 'Bijwerken lukte niet');
    });
  return (
    <Modal open onClose={onClose} wide title={d ? <Words text="Nieuwe versie van {0}" values={[d.name]} /> : 'Nieuwe versie'}>
      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : !d ? (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Spinner /> Verschil ophalen (er wordt niets uitgevoerd of geïnstalleerd)…
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm">
            Van <span className="font-mono">{pinLabel(d.from.commit)}</span> naar <span className="font-mono">{pinLabel(d.to.commit)}</span> {d.to.inCatalog ? '(nieuwe versie in de TeamBot-catalogus).' : '(nieuwste versie bij de bron, nog niet door TeamBot bekeken).'} Er verandert niets tot jij op Bijwerken klikt.
          </p>
          {d.compare && (
            <a className="inline-flex items-center gap-1 text-sm text-accent underline" href={d.compare} target="_blank" rel="noopener noreferrer">
              Vergelijking bij de bron <ExternalLink className="h-3 w-3" />
            </a>
          )}
          {d.problems.length > 0 && (
            <div className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
              <div className="font-medium">Deze versie voldoet niet aan de importregels en kan niet worden geïnstalleerd.</div>
              <ul className="mt-1 list-disc ps-5">
                {d.problems.map((p) => (
                  <li key={p} className="break-words">
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-sm text-muted">
            {d.identical
              ? 'De bestanden van deze skill zijn niet veranderd.'
              : [
                  d.files.changed ? t('{0, plural, one {# bestand gewijzigd} other {# bestanden gewijzigd}}', d.files.changed) : '',
                  d.files.added ? t('{0, plural, one {# bestand nieuw} other {# bestanden nieuw}}', d.files.added) : '',
                  d.files.removed ? t('{0, plural, one {# bestand verwijderd} other {# bestanden verwijderd}}', d.files.removed) : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
          </p>
          <div className={cx('rounded-lg border p-3', d.permissions.elevated ? 'border-warn/40 bg-warn-soft' : 'border-line')}>
            <div className="mb-1 text-sm font-medium">{d.permissions.elevated ? 'Deze versie vraagt meer rechten' : 'Rechten'}</div>
            <DiffView d={d.permissions} />
          </div>
          {d.scriptsChange && <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">De scripts veranderen in deze versie. Na bijwerken gebruiken de bots de nieuwe scripts; bekijk hieronder wat er anders is.</p>}
          {d.scan.findings.length > 0 && (
            <Collapse title={d.scan.findings.length === 1 ? 'Waarschuwingen in deze versie (1)' : `Waarschuwingen in deze versie (${d.scan.findings.length})`} defaultOpen={d.scan.level === 'danger'}>
              <FindingsList findings={d.scan.findings} />
            </Collapse>
          )}
          <div className="space-y-2">
            {d.files.files.map((f) => (
              <FileDiff key={f.path} f={f} />
            ))}
          </div>
          {!d.identical && d.problems.length === 0 && (
            <div className="rounded-lg border border-line p-3">
              {/* The saved test questions on this new version, next to the difference; updating stays a separate click. */}
              <TestRunPanel skillId={skillId} target={`commit:${commit}`} title="Test eerst deze versie" />
            </div>
          )}
          {done ? (
            <p className="flex items-center gap-2 text-sm text-ok">
              <CheckCircle2 className="h-4 w-4" /> {done}
            </p>
          ) : (
            <div className="space-y-2 border-t border-line pt-3">
              {needAck && (
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-0.5 h-4 w-4" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                  <span>Ik heb de ernstige waarschuwingen gelezen en wil deze versie toch.</span>
                </label>
              )}
              {needConfirm && (
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-0.5 h-4 w-4" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
                  <span>Ik heb de extra rechten bekeken en ga akkoord.</span>
                </label>
              )}
              <div className="flex flex-wrap justify-end gap-2">
                <Button onClick={onClose}>Niet nu</Button>
                <Button variant="primary" loading={busy} disabled={d.problems.length > 0 || d.identical || (needAck && !ack) || (needConfirm && !confirm)} onClick={apply}>
                  Bijwerken
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
