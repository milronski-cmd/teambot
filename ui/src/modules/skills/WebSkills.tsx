import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ExternalLink, Globe, Puzzle, ShieldAlert, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import { Badge, Button, EmptyState, Input, Modal, Spinner, cx, timeAgo, useAsync } from '../../components/ui';
import { MoreInfo } from '../../components/MoreInfo';
import { Fold, Menu, Skeleton } from '../../components/overview';
import { api } from '../../lib/api';
import { t, uiLocale } from '../../lib/i18n';
import { formatNumber } from '../../lib/format';
import type { LicenseView, StagingView, StarterSkill, WebSkillDetail, WebSkillItem, WebSkillList, WebSources } from './api';
import { formatBytes } from './api';
import { CARD, ErrorCard, LoadingCards, Meta, RefreshNote, ReportButton, SearchBox, Signal, qs, useFillingList } from './marketParts';
import { refreshLabel } from './merge';
import { CandidatesReview, Collapse, FileList, FindingsList, LabelBadges, Md, PermissionsView, ScanBadge, ThinSkillWarning, bodyOf } from './common';
import { firstSentence } from '../../lib/sentence';

/** Where a skill on the internet lives: a folder in a GitHub repository, or a skills.sh result still to be resolved. */
export type WebTarget = { repo: string; path: string } | { source: string; skillId: string };

export function targetOf(i: WebSkillItem): WebTarget | null {
  if (i.unresolved) return i.repo && i.skillId ? { source: i.repo, skillId: i.skillId } : null;
  return i.repo ? { repo: i.repo, path: i.path || '' } : null;
}

/** "github/<owner>/<repo>/<path>" (catalog_ref / ?item=) → target. */
export function targetFromRef(ref: string): WebTarget | null {
  const p = ref.replace(/^github\//, '').split('/');
  if (p.length < 2) return null;
  return { repo: `${p[0]}/${p[1]}`, path: p.slice(2).join('/') };
}

const LICENSE_SOURCE: Record<LicenseView['source'], string> = {
  'skill-file': 'licentiebestand in de skill',
  frontmatter: 'SKILL.md',
  'repo-file': 'licentiebestand van de repository',
  github: 'GitHub (repository)',
  registry: 'register',
  none: '',
};

export function LicenseBadge({ l, installable }: { l: LicenseView; installable?: boolean | null }) {
  if (l.status === 'open') return <Badge tone="ok">{l.spdx || l.label}</Badge>;
  if (l.status === 'restricted') return <Badge tone="danger">Niet installeerbaar · {l.label.slice(0, 30)}</Badge>;
  if (installable === null) return <Badge>Licentie: bekijk details</Badge>;
  return <Badge tone="warn">{l.label === 'Nog niet bekeken' ? 'Licentie nog onbekend' : 'Geen open licentie'}</Badge>;
}

/** The one signal of a skill from the internet: added, why it cannot be added, or that nobody checked it. */
function WebSignal({ i }: { i: WebSkillItem }) {
  if (i.installed)
    return (
      <Signal tone="ok" icon={<CheckCircle2 aria-hidden />}>
        {i.installed.updateAvailable ? 'Toegevoegd · update beschikbaar' : 'Toegevoegd'}
      </Signal>
    );
  if (i.license.status === 'restricted')
    return (
      <Signal tone="danger" icon={<ShieldAlert aria-hidden />}>
        Niet te installeren (licentie)
      </Signal>
    );
  if (i.license.status !== 'open' && i.installable !== null)
    return (
      <Signal tone="warn" icon={<ShieldAlert aria-hidden />}>
        Geen open licentie
      </Signal>
    );
  return (
    <Signal tone="warn" icon={<ShieldAlert aria-hidden />}>
      {i.kind === 'scripts' ? 'Niet gecontroleerd · bevat scripts' : 'Niet gecontroleerd'}
    </Signal>
  );
}

function useDebounced<T>(v: T, ms = 350) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

/**
 * Skills from the internet: curated GitHub collections + skills.sh search. The first view comes from the cache at
 * once (or, on the very first start, TeamBot's own skills while the collections download); new results are added
 * below the cards already shown, so nothing moves while it fills in.
 */
export function InternetSkills({ initialTarget, onOpenCatalog, onShowCatalog }: { initialTarget?: WebTarget | null; onOpenCatalog?: (catalogId: string, id: string) => void; onShowCatalog?: () => void }) {
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [repo, setRepo] = useState('');
  const [onlyInstallable, setOnlyInstallable] = useState(false);
  const [sources, setSources] = useState<WebSources | null>(null);
  const [open, setOpen] = useState<WebTarget | null>(initialTarget || null);
  const dq = useDebounced(q.trim());
  useEffect(() => {
    api.get<WebSources>('/skills/web/sources').then(setSources).catch(() => setSources(null));
  }, []);
  const path = `/skills/web/skills${qs({ q: dq, category, repo, installable: onlyInstallable ? '1' : '' })}`;
  const { data, error, reload } = useFillingList<WebSkillItem, WebSkillList>(path, (i) => i.id);
  // TeamBot's own skills, shown on the very first start while nothing from the internet is in yet; they stay in place
  // (above the internet results) until another search or filter is chosen.
  const [starter, setStarter] = useState<{ path: string; items: StarterSkill[]; total: number } | null>(null);
  useEffect(() => {
    if (data?.starter?.length && (!starter || starter.path !== path)) setStarter({ path, items: data.starter, total: data.starterTotal || data.starter.length });
  }, [data]);
  const showStarter = starter?.path === path ? starter : null;
  const cats = useMemo(() => data?.categories || [], [data]);
  const note = refreshLabel(data, data?.collections ? { ...data.collections, noun: 'collecties' } : undefined);
  const loadingInternet = !!data && !data.items.length && (data.pending.length > 0 || data.refreshing?.length > 0);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={setQ} label="Zoek skills op internet" />
        <Menu
          label="Filter"
          variant="secondary"
          align="start"
          icon={<SlidersHorizontal className="h-4 w-4" aria-hidden />}
          items={[
            { heading: 'Collectie' },
            { label: 'Alle collecties', checked: !repo, onSelect: () => setRepo('') },
            ...(sources?.collections || []).map((c) => ({ label: <span translate="no">{c.repo}</span>, checked: repo === c.repo, onSelect: () => setRepo(c.repo) })),
            'sep',
            { label: 'Alleen installeerbaar', checked: onlyInstallable, onSelect: () => setOnlyInstallable(!onlyInstallable) },
          ]}
        >
          Filter
        </Menu>
      </div>
      {/* One fixed-height row that scrolls sideways, so categories arriving later never push the cards down. */}
      <div className="scroll-thin -mx-1 flex h-7 items-center gap-1.5 overflow-x-auto px-1" role="group" aria-label="Categorieën">
        {cats.length > 1
          ? ['', ...cats].map((c) => (
              <button
                key={c || 'alle'}
                type="button"
                aria-pressed={category === c}
                onClick={() => setCategory(c)}
                className={cx('shrink-0 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs', category === c ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-surface text-muted hover:border-accent')}
              >
                {c || 'Alles'}
              </button>
            ))
          : !data || data.pending.length > 0
            ? [56, 88, 72, 96, 64].map((w, i) => (
                <span key={i} className="shrink-0" style={{ width: w }}>
                  <Skeleton className="h-5 rounded-full" />
                </span>
              ))
            : null}
      </div>
      <div className="flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span>
          {!data
            ? 'Skills van internet ophalen…'
            : data.items.length
              ? [data.total === 1 ? '1 skill' : `${data.total} skills`, data.skillsSh.used ? 'inclusief resultaten uit skills.sh' : '', data.total > data.items.length ? `eerste ${data.items.length} getoond` : ''].filter(Boolean).join(' · ')
              : ''}
          {data?.offline ? `${data.items.length ? ' · ' : ''}Offline: laatst opgehaalde gegevens.` : data?.stale ? `${data.items.length ? ' · ' : ''}deels uit de cache (bron tijdelijk niet bereikbaar of limiet bereikt)` : ''}
        </span>
        <RefreshNote label={!data ? '' : note} resetKey={path} />
      </div>
      {showStarter && (
        <section aria-labelledby="starter-skills" className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h2 id="starter-skills" className="text-[15px] font-bold tracking-tight">
              Van TeamBot
            </h2>
            {onShowCatalog && (
              <button type="button" className="text-sm font-medium text-accent hover:underline" onClick={onShowCatalog}>
                Alle {showStarter.total} bekijken
              </button>
            )}
          </div>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {showStarter.items.map((s) => (
              <li key={s.id} className="min-w-0">
                <button type="button" data-card="starter" className={cx(CARD, 'w-full text-start')} onClick={() => onOpenCatalog?.(s.catalogId, s.id)}>
                  <span className="break-words font-semibold">{s.title}</span>
                  <p className="mt-1 line-clamp-1 flex-1 break-words text-sm text-muted">{firstSentence(s.description)}</p>
                  <div className="mt-3 flex min-h-8 items-center">
                    <Signal tone="ok" icon={<ShieldCheck aria-hidden />}>
                      Gecontroleerd door TeamBot
                    </Signal>
                  </div>
                </button>
              </li>
            ))}
          </ul>
          <h2 className="pt-3 text-[15px] font-bold tracking-tight">Van internet</h2>
        </section>
      )}
      {error ? (
        <ErrorCard error={error} retry={reload} />
      ) : !data || loadingInternet ? (
        <LoadingCards n={showStarter ? 3 : 6} />
      ) : !data.items.length ? (
        <EmptyState icon={<Puzzle />} title="Geen skills gevonden" action={(q || category || repo || onlyInstallable) && <Button onClick={() => (setQ(''), setCategory(''), setRepo(''), setOnlyInstallable(false))}>Alles tonen</Button>}>
          {data.offline && !dq ? 'TeamBot werkt offline en heeft nog niets van internet opgehaald.' : 'Probeer een ander zoekwoord.'}
        </EmptyState>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.items.map((i) => {
            const tgt = targetOf(i);
            return (
              <li key={i.id} className="min-w-0">
                <button type="button" disabled={!tgt} className={cx(CARD, 'w-full text-start disabled:opacity-60')} onClick={() => tgt && setOpen(tgt)}>
                  {/* A skill from the internet: its name, source and description are the author's own words. */}
                  <span className="font-semibold [overflow-wrap:anywhere]" translate="no">
                    {i.title}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted [overflow-wrap:anywhere]" translate={i.repo ? 'no' : undefined}>
                    {i.repo || i.sourceLabel}
                  </span>
                  <p className="mt-1 line-clamp-1 flex-1 break-words text-sm text-muted" translate={i.description ? 'no' : undefined}>
                    {firstSentence(i.description) || (i.unresolved || i.partial ? 'Open voor de beschrijving, licentie en scan.' : '')}
                  </p>
                  <span className="mt-3 flex min-h-8 items-center">
                    <WebSignal i={i} />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {/* Problems with a source go under the list, so a late error never pushes the cards down. */}
      {data && !data.offline && (data.skillsSh.error || data.errors.length > 0) && (
        <div className="space-y-1 rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
          <div className="font-medium text-fg">Niet alles kon worden opgehaald</div>
          {data.skillsSh.error && <div>skills.sh: {data.skillsSh.error}</div>}
          {data.errors.map((e) => (
            <div key={e.repo}>
              {e.repo}: {e.error}
            </div>
          ))}
        </div>
      )}
      {open && <WebSkillDetailModal target={open} onClose={() => (setOpen(null), reload())} />}
    </div>
  );
}

function targetQuery(t: WebTarget): Record<string, string> {
  return 'repo' in t ? { repo: t.repo, path: t.path } : { source: t.source, skillId: t.skillId };
}

export function WebSkillDetailModal({ target, onClose }: { target: WebTarget; onClose(): void }) {
  const [d, setD] = useState<WebSkillDetail | null>(null);
  const [error, setError] = useState('');
  const [staging, setStaging] = useState<StagingView | null>(null);
  const [file, setFile] = useState<{ path: string; text: string | null; binary: boolean; size: number } | null>(null);
  const { busy, run } = useAsync();
  useEffect(() => {
    api
      .get<WebSkillDetail>(`/skills/web/item${qs(targetQuery(target))}`)
      .then(setD)
      .catch((e) => setError(e.message));
  }, [JSON.stringify(target)]);
  const where = d ? { repo: d.repo!, path: d.path || '' } : null;
  const openFile = (p: string) =>
    where &&
    run(async () => {
      setFile(await api.get(`/skills/web/file${qs({ ...where, file: p })}`));
    });
  const install = () => where && run(async () => setStaging(await api.post<StagingView>('/skills/web/install', where)));
  return (
    <Modal open onClose={onClose} wide title={d ? d.title : 'Skill'}>
      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : !d ? (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Spinner /> Skill ophalen en controleren (er wordt niets uitgevoerd)…
        </div>
      ) : staging ? (
        <div className="space-y-3">
          <p className="text-sm text-muted">Stap 2 van 2: bekijk de scan en de rechten, kies voor welke bots je de skill meteen inschakelt en installeer.</p>
          <CandidatesReview staging={staging} doneLabel="Geïnstalleerd. Je vindt de skill onder Mijn skills." />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <LicenseBadge l={d.license} installable={d.installable} />
            <ScanBadge level={d.scan.level} />
            <LabelBadges labels={d.scan.labels} />
            <Badge>{d.category}</Badge>
            {d.installed && <Badge tone={d.installed.updateAvailable ? 'accent' : 'ok'}>{d.installed.updateAvailable ? 'Nieuwere versie bij de bron' : `Geïnstalleerd${d.installed.version ? ` (v${d.installed.version})` : ''}`}</Badge>}
            {d.stale && <Badge tone="warn">uit de cache</Badge>}
          </div>
          <p className="text-sm" translate="no">
            {d.description}
          </p>
          <Meta
            items={[
              [
                'Bron',
                <a key="b" className="inline-flex items-center gap-1 break-all text-accent underline" href={d.url} target="_blank" rel="noopener noreferrer">
                  {d.repo}
                  {d.path ? `/${d.path}` : ''} <ExternalLink className="h-3 w-3" />
                </a>,
              ],
              ['Auteur', d.author || d.publisher],
              ['Versie', [d.version, d.commit ? `commit ${d.commit.slice(0, 7)}` : ''].filter(Boolean).join(' · ')],
              ['Licentie', `${d.license.label}${LICENSE_SOURCE[d.license.source] ? ` (volgens ${LICENSE_SOURCE[d.license.source]}${d.license.file ? `: ${d.license.file}` : ''})` : ''}`],
              ['Bijgewerkt', d.updatedAt ? timeAgo(d.updatedAt) : ''],
              ['Populariteit', [d.repoMeta ? t('{0, plural, one {# ster op GitHub} other {# sterren op GitHub}}', formatNumber(d.repoMeta.stars)) : '', d.installs ? t('{0, plural, one {# installatie (skills.sh)} other {# installaties (skills.sh)}}', formatNumber(d.installs)) : ''].filter(Boolean).join(' · ')],
              ['Omvang', [d.files.length === 1 ? '1 bestand' : `${d.files.length} bestanden`, d.size ? formatBytes(d.size) : ''].filter(Boolean).join(', ')],
            ]}
          />
          {d.reason && <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">{d.reason}</p>}
          <ThinSkillWarning s={d.substance} />
          {d.repoMeta?.archived && <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">Deze repository is gearchiveerd; er komen geen updates meer.</p>}
          <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
            Van internet en niet door TeamBot beoordeeld. TeamBot heeft de bestanden alleen gelezen en gescand; bij installeren zie je de rechten en blijven scripts geblokkeerd tot je ze vertrouwt.
          </p>
          <section className="space-y-2">
            <div className="text-sm font-semibold">Rechten en externe aanroepen</div>
            <PermissionsView p={d.permissions} />
          </section>
          <Collapse title={`Veiligheidsscan (${d.scan.findings.length})`} defaultOpen={d.scan.level === 'warn' || d.scan.level === 'danger'}>
            <FindingsList findings={d.scan.findings} />
          </Collapse>
          <Collapse title="Bestanden">
            <FileList files={d.files} onOpen={openFile} />
            {file && (
              <div className="mt-2 rounded-lg border border-line">
                <div className="flex items-center justify-between border-b border-line px-3 py-1.5 text-xs">
                  <span className="font-mono">{file.path}</span>
                  <span className="text-muted">{formatBytes(file.size)}</span>
                </div>
                {file.binary ? <p className="p-3 text-sm text-muted">Binair bestand; niet getoond.</p> : <pre className="scroll-thin max-h-80 overflow-auto whitespace-pre-wrap p-3 text-xs">{file.text}</pre>}
              </div>
            )}
          </Collapse>
          <Collapse title="Instructies lezen" defaultOpen>
            <div className="max-h-96 overflow-y-auto rounded-lg border border-line p-3">
              <Md text={bodyOf(d.skillMd)} />
            </div>
          </Collapse>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
            <ReportButton type="skill" catalogId="github" itemId={d.id} itemName={d.title} />
            <Button variant="primary" loading={busy} disabled={!d.installable} title={d.reason || undefined} onClick={install} icon={d.installed ? undefined : <CheckCircle2 className="h-4 w-4" />}>
              {d.installed ? (d.installed.updateAvailable ? 'Bijwerken…' : 'Opnieuw bekijken…') : 'Installeren…'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Internet sources overview for the Bronnen tab: collections, refresh, optional GitHub token. */
export function InternetSourcesCard() {
  const [s, setS] = useState<WebSources | null>(null);
  const [token, setToken] = useState('');
  const { busy, run } = useAsync();
  const load = () => api.get<WebSources>('/skills/web/sources').then(setS).catch(() => setS(null));
  useEffect(() => {
    load();
  }, []);
  if (!s) return null;
  return (
    <>
      {s.collections.length > 0 && (
    <div className="space-y-3 rounded-card border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Globe className="h-4 w-4 text-muted" />
        <span className="font-semibold">Open collecties</span>
        {s.offline && <Badge tone="warn">offline</Badge>}
      </div>
      <p className="text-sm text-muted">
        Van GitHub, niet door TeamBot gecontroleerd.{' '}
        <MoreInfo>Deze collecties zijn live. Alleen skills met een open licentie zijn te installeren.</MoreInfo>
      </p>
      <ul className="divide-y divide-line text-sm">
        {s.collections.map((c) => (
          <li key={c.repo} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div className="min-w-0">
              <a className="font-medium text-accent hover:underline" href={c.url} target="_blank" rel="noopener noreferrer">
                {c.repo}
              </a>
              <div className="text-xs text-muted">
                {c.indexed ? t('{0, plural, one {# skill} other {# skills}} ({1} installeerbaar)', c.skills ?? 0, c.installable ?? 0) : 'Nog niet opgehaald'}
                {c.stars ? ` · ${t('{0, plural, one {# ster} other {# sterren}}', formatNumber(c.stars))}` : ''}
                {c.license ? ` · ${c.license}` : ''}
                {c.fetchedAt ? ` · opgehaald ${timeAgo(c.fetchedAt)}` : ''}
              </div>
              {c.note && <div className="text-xs text-muted">{c.note}</div>}
            </div>
            <Button size="sm" variant="ghost" loading={busy} onClick={() => run(() => api.post('/skills/web/sources/refresh', { repo: c.repo }).then(load), 'Bijgewerkt')}>
              Vernieuwen
            </Button>
          </li>
        ))}
      </ul>
    </div>
      )}
      <Fold title="GitHub-token" hint={s.github.tokenSet ? 'Ingesteld' : 'Optioneel'}>
        <p className="text-xs text-muted">
          {s.github.apiBlockedUntil ? `Limiet bereikt tot ${new Date(s.github.apiBlockedUntil).toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit' })}. ` : ''}
          <MoreInfo>
            Zonder token mag TeamBot de GitHub-API 60 keer per uur gebruiken (voor sterren en grote repositories); downloads gaan buiten die limiet om. Een token (alleen leesrechten op openbare repositories) verhoogt de limiet en wordt versleuteld in je kluis bewaard.
          </MoreInfo>
        </p>
        {s.github.tokenSet ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone="ok">Token ingesteld</Badge>
            <Button size="sm" variant="ghost" loading={busy} onClick={() => run(() => api.del('/skills/web/github-token').then(load), 'Token verwijderd')}>
              Verwijderen
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Input type="password" className="min-w-0 flex-1 sm:max-w-sm" value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_… of ghp_…" autoComplete="off" aria-label="GitHub-token" />
            <Button size="sm" loading={busy} disabled={!token.trim()} onClick={() => run(() => api.put('/skills/web/github-token', { token: token.trim() }).then(() => (setToken(''), load())), 'Token opgeslagen in de kluis')}>
              Opslaan
            </Button>
          </div>
        )}
      </Fold>
    </>
  );
}
