import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Download, ExternalLink, FolderGit2, Plus, Puzzle, ShieldAlert, ShieldCheck, Star } from 'lucide-react';
import { Badge, Button, EmptyState, Input, Modal, Spinner, cx, timeAgo, toast, useAsync } from '../../components/ui';
import { MoreInfo } from '../../components/MoreInfo';
import { Dropdown } from '../../components/SettingControls';
import { Fold } from '../../components/overview';
import { ApiError, api, on } from '../../lib/api';
import { navigate } from '../../lib/router';
import { t, uiLocale } from '../../lib/i18n';
import type { CuratedInstallResult, MarketSkillItem, OpenRepo, OpenSearch, StagingView, WebSources } from './api';
import { type OpenCard, type OpenSection, type OpenSort, starsText } from '../../../../shared/skills.js';
import { CARD, CARD_OPEN, ErrorCard, LoadingCards, SearchBox, Signal, qs } from './marketParts';
import { SkillCard, niceName, skillHref, useAddSkill } from './ClearMarket';
import { ReviewModal, UpdateDiffModal } from './Catalog';
import { TeamPlacePicker, useSkillPlace } from './TeamPlace';
import { firstSentence } from '../../lib/sentence';

/**
 * "Openbaar": everything public next to the checked catalogue. One search box and one order; under it the matches in the
 * checked catalogue and in TeamBot's own and added catalogues (a search by words), repositories on GitHub, single
 * skills from the open directory skills.sh, and skills hosted by ClawHub (by date the last and GitHub are one list). Adding is the same one click as in the catalogue: the scan and the
 * import rules run at that moment, and the version of that moment is the one you keep until you approve a newer one.
 */

const SORTS: { value: OpenSort; label: string }[] = [
  { value: 'stars', label: 'Meeste sterren' },
  { value: 'trending', label: 'Trending' },
  { value: 'new', label: 'Nieuwste' },
  { value: 'updated', label: 'Laatst bijgewerkt' },
];

/** What each order means, said in the screen (GitHub has no public list of stars gained, nor an order by creation date). */
const SORT_MEANS: Record<OpenSort, string> = {
  stars: 'Op GitHub de repositories met de meeste sterren eerst; op skills.sh de skills met de meeste installaties; op ClawHub de skills met de meeste sterren daar.',
  trending: 'Trending: op GitHub de meeste sterren onder repositories van de laatste 30 dagen; op skills.sh de meeste installaties in de laatste 24 uur; op ClawHub zijn eigen trending-volgorde.',
  new: 'Nieuwste: wat deze week op GitHub is aangemaakt (de 100 met de meeste sterren) en het nieuwste op ClawHub, door elkaar op datum.',
  updated: 'Waar het laatst iets aan veranderd is, op GitHub en ClawHub door elkaar op datum.',
};

function useDebounced<T>(v: T, ms = 450) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const timer = setTimeout(() => setD(v), ms);
    return () => clearTimeout(timer);
  }, [v, ms]);
  return d;
}

type Half = 'directory' | 'github' | 'clawhub';
const HALVES: Half[] = ['directory', 'github', 'clawhub'];
/** One page with what arrived of each source. */
type OpenPageView = OpenSearch & { arrived: Record<Half, boolean> };
const NO_SECTION: OpenSection = { items: [], total: null, more: false, stale: false, error: null };

/**
 * The pages of one search (words, order, team), loaded one after the other with "Meer laden". The two sources are
 * asked apart, so the skills of the directory show while GitHub is still answering (or the other way round).
 */
function useOpenSearch(q: string, sort: OpenSort, teamId: string) {
  const [parts, setParts] = useState<Partial<Record<Half, OpenSearch>>[]>([]);
  const [error, setError] = useState('');
  const [waiting, setWaiting] = useState(0);
  const [tick, setTick] = useState(0);
  const key = `${q}\n${sort}\n${teamId}`;
  const cur = useRef(key);
  cur.current = key;
  const ask = (page: number, only: Half) =>
    api.get<OpenSearch>(`/skills/web/search${qs({ q, sort, page: String(page), only, teamId: teamId && teamId !== '*' ? teamId : '' })}`).then((d) => {
      if (cur.current !== key) return;
      setParts((p) => {
        const n = [...p];
        n[page - 1] = { ...n[page - 1], [only]: d };
        return n;
      });
    });
  const load = (page: number) => {
    setError('');
    for (const only of HALVES) {
      setWaiting((w) => w + 1);
      ask(page, only)
        .catch((e) => cur.current === key && setError(e.message))
        .finally(() => cur.current === key && setWaiting((w) => Math.max(0, w - 1)));
    }
  };
  useEffect(() => {
    setParts([]);
    setWaiting(0);
    load(1);
  }, [key]);
  // After an install: the same pages again, so "Toegevoegd" shows without losing your place.
  useEffect(() => {
    if (!tick) return;
    for (let page = 1; page <= (parts.length || 1); page++) for (const only of HALVES) ask(page, only).catch(() => {});
  }, [tick]);
  const reload = useCallback(() => setTick((x) => x + 1), []);
  // One page as the server would give it whole; a source that did not answer yet has no cards.
  const pages: OpenPageView[] = parts
    .filter((p) => p && (p.directory || p.github || p.clawhub))
    .map((p) => ({
      ...(p.directory || p.github || p.clawhub)!,
      github: p.github ? p.github.github : NO_SECTION,
      directory: p.directory ? p.directory.directory : null,
      clawhub: p.clawhub ? p.clawhub.clawhub : null,
      limit: p.github?.limit || null,
      arrived: { directory: !!p.directory, github: !!p.github, clawhub: !!p.clawhub },
    }));
  const last = pages[pages.length - 1];
  return {
    pages,
    first: pages[0] || null,
    /** Every source answered for the first page (only then "niets gevonden" is true). */
    complete: !!parts[0]?.directory && !!parts[0]?.github && !!parts[0]?.clawhub,
    /** GitHub has not answered for the first page yet. */
    githubPending: !!parts[0] && !parts[0].github && waiting > 0,
    error,
    busy: waiting > 0,
    more: !!last && (last.github.more || !!last.directory?.more || !!last.clawhub?.more),
    loadMore: () => load(parts.length + 1),
    reload,
  };
}

const when = (iso: string | null) => (iso ? timeAgo(iso) : '');

/** Checked by TeamBot or not, added, or a publisher that looks like a known one: the one signal of an open result. */
function OpenSignal({ c }: { c: OpenCard }) {
  if (c.kind === 'skill' ? c.installed : c.installedCount > 0)
    return (
      <Signal tone="ok" icon={<CheckCircle2 aria-hidden />}>
        {c.kind === 'skill' ? 'Toegevoegd' : t('{0, plural, one {# skill toegevoegd} other {# skills toegevoegd}}', c.installedCount)}
      </Signal>
    );
  if (c.flagged)
    return (
      <Signal tone="danger" icon={<ShieldAlert aria-hidden />}>
        Let op: ClawHub markeert deze skill als verdacht
      </Signal>
    );
  if (c.publisherStatus === 'lookalike')
    return (
      <Signal tone="warn" icon={<ShieldAlert aria-hidden />}>
        Let op: de naam lijkt op een bekende uitgever
      </Signal>
    );
  if (c.checked)
    return (
      <Signal tone="ok" icon={<ShieldCheck aria-hidden />}>
        {c.kind === 'skill' ? 'Gecontroleerd' : t('{0, plural, one {# skill gecontroleerd} other {# skills gecontroleerd}}', c.checkedCount)}
      </Signal>
    );
  return (
    <Signal tone="warn" icon={<ShieldAlert aria-hidden />}>
      Niet gecontroleerd
    </Signal>
  );
}

const SOURCE_NAME: Record<OpenCard['from'], string> = { github: 'GitHub', 'skills.sh': 'skills.sh', clawhub: 'ClawHub' };

/**
 * Where a result comes from and what its numbers are: stars on GitHub, installs counted by skills.sh, or the stars and
 * downloads ClawHub counts itself (said on the card: they are other counts than GitHub's stars); then the repository,
 * the licence when known, and the last update.
 */
function OpenFacts({ c }: { c: OpenCard }) {
  const parts = [c.license || '', c.updatedAt ? t('bijgewerkt {0}', when(c.updatedAt)) : '', c.archived ? 'gearchiveerd' : ''].filter(Boolean);
  const claw = c.from === 'clawhub';
  return (
    <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted">
      {c.stars !== null && (
        <span className="inline-flex shrink-0 items-center gap-1">
          <Star className="h-3.5 w-3.5 fill-current text-warn" aria-hidden />
          <span className="font-semibold text-fg">{starsText(c.stars) || '0'}</span>
          {claw ? <span>op ClawHub</span> : <span className="sr-only">sterren op GitHub</span>}
        </span>
      )}
      {claw && c.downloads !== null && (
        <span className="inline-flex shrink-0 items-center gap-1">
          <Download className="h-3.5 w-3.5" aria-hidden />
          <span className="font-semibold text-fg">{starsText(c.downloads) || '0'}</span>
          <span>downloads</span>
        </span>
      )}
      {(c.installs !== null || c.recent !== null) && (
        <span className="inline-flex shrink-0 items-center gap-1">
          <Download className="h-3.5 w-3.5" aria-hidden />
          <span className="font-semibold text-fg">{starsText(c.installs ?? c.recent) || '0'}</span>
          <span>{c.recent !== null ? 'installaties in 24 uur' : 'installaties'}</span>
        </span>
      )}
      <span className="min-w-0 truncate" translate="no" data-from={c.from}>
        {SOURCE_NAME[c.from]} · {c.repo}
      </span>
      {parts.length > 0 && <span className="shrink-0">· {parts.join(' · ')}</span>}
    </span>
  );
}

function OpenResult({ c, busy, onAdd, onOpen }: { c: OpenCard; busy: boolean; onAdd(): void; onOpen(): void }) {
  const repo = c.kind === 'repo';
  const added = repo ? false : !!c.installed;
  // A repository that is known to hold several skills: the button opens the list to choose from.
  const choose = repo && (c.skillCount ?? 0) > 1;
  return (
    <div data-card="open" data-kind={c.kind} data-open={c.id} className={CARD}>
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-control bg-surface-2 text-muted" aria-hidden>
          {repo ? <FolderGit2 className="h-[18px] w-[18px]" /> : <Puzzle className="h-[18px] w-[18px]" />}
        </span>
        <div className="min-w-0 flex-1">
          <button type="button" className={cx(CARD_OPEN, 'block')} onClick={onOpen}>
            <span className="break-words" translate="no">
              {niceName(c.name)}
            </span>
          </button>
          <OpenFacts c={c} />
        </div>
      </div>
      {/* The author's own words; a skill from the directory has none until its repository was opened. */}
      <p className="mt-2 line-clamp-2 flex-1 break-words text-sm text-muted" translate={c.description ? 'no' : undefined}>
        {firstSentence(c.description) || (repo ? 'Repository met skills.' : '')}
        {repo && c.skillCount ? ` ${t('{0, plural, one {# skill} other {# skills}}', c.skillCount)}.` : ''}
      </p>
      <div className="mt-3 flex min-h-8 items-center justify-between gap-2">
        <OpenSignal c={c} />
        {!added && (
          <span className="relative z-10 shrink-0">
            <Button size="sm" icon={choose ? undefined : <Plus className="h-4 w-4" />} loading={busy} onClick={choose ? onOpen : onAdd}>
              {choose ? 'Kies skill' : 'Toevoegen'}
            </Button>
          </span>
        )}
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h2 className="text-[15px] font-bold tracking-tight">{title}</h2>
        {hint && <span className="text-xs text-muted">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

const GRID = 'grid gap-3 sm:grid-cols-2 lg:grid-cols-3';

export function OpenMarket({ onOpenOwn, onShowOwn, onShowChecked }: { onOpenOwn(catalogId: string, id: string): void; onShowOwn(): void; onShowChecked(q: string): void }) {
  const place = useSkillPlace();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim());
  const [sort, setSort] = useState<OpenSort>('stars');
  const s = useOpenSearch(dq, sort, place.teamId);
  const [review, setReview] = useState<StagingView | null>(null);
  const [diff, setDiff] = useState<{ skillId: string; commit: string } | null>(null);
  const [repo, setRepo] = useState<string | null>(null);
  const [busyId, setBusyId] = useState('');
  const adder = useAddSkill({ teamId: place.teamId, onReview: setReview, onDone: s.reload });
  useEffect(() => on('skills.updated', s.reload), [s.reload]);
  // TeamBot's own skills and the catalogues you added: found by the same words.
  const [own, setOwn] = useState<MarketSkillItem[]>([]);
  useEffect(() => {
    if (!dq) return setOwn([]);
    let alive = true;
    api
      .get<{ items: MarketSkillItem[] }>(`/skills/market/skills${qs({ q: dq })}`)
      .then((d) => alive && setOwn(d.items))
      .catch(() => alive && setOwn([]));
    return () => {
      alive = false;
    };
  }, [dq]);

  /** One click. A repository with several skills answers "kies er een": then its list opens. */
  const add = async (c: OpenCard) => {
    if (busyId) return;
    setBusyId(c.id);
    try {
      const r = await api.post<CuratedInstallResult>('/skills/curated/install', { id: c.id, ...(place.teamId ? { teamId: place.teamId } : {}) });
      if (r.staging) return setReview(r.staging);
      if (!(r.status === 'created' || r.status === 'installed')) throw new Error(r.error || 'Toevoegen lukte niet');
      toast(t('{0} is toegevoegd. Je bots kunnen hem meteen gebruiken.', niceName(r.name || c.name)), 'ok');
      s.reload();
    } catch (e: any) {
      if (c.kind === 'repo' && e instanceof ApiError && e.status === 409) setRepo(c.repo);
      else toast(e?.message || 'Toevoegen lukte niet', 'danger');
    } finally {
      setBusyId('');
    }
  };
  const open = (c: OpenCard) => (c.kind === 'repo' ? setRepo(c.repo) : navigate(skillHref(c.id)));

  const first = s.first;
  const checked = first?.checked || [];
  const dir = s.pages.flatMap((p) => p.directory?.items || []);
  // By date ("Nieuwste", "Laatst bijgewerkt") GitHub and ClawHub give the same kind of number: one list, each page
  // put in order once both answered (so cards do not move when the second source comes in).
  const byDate = sort === 'new' || sort === 'updated';
  const dateOf = (c: OpenCard) => (sort === 'new' ? c.createdAt : c.updatedAt) || '';
  const mixed = byDate ? s.pages.flatMap((p) => (p.arrived.github && p.arrived.clawhub ? [...p.github.items, ...(p.clawhub?.items || [])].sort((a, b) => dateOf(b).localeCompare(dateOf(a))) : [])) : [];
  const mixPending = byDate && s.pages.some((p) => !(p.arrived.github && p.arrived.clawhub)) && s.busy;
  const gh = byDate ? [] : s.pages.flatMap((p) => p.github.items);
  const claw = byDate ? [] : s.pages.flatMap((p) => p.clawhub?.items || []);
  const limit = s.pages.map((p) => p.limit).find(Boolean) || null;
  const problems = first ? [first.github.error && !limit && !first.offline ? `GitHub: ${first.github.error}` : '', first.directory?.error && !first.offline ? `skills.sh: ${first.directory.error}` : '', first.clawhub?.error && !first.offline ? `ClawHub: ${first.clawhub.error}` : ''].filter(Boolean) : [];
  const stale = !!first && (first.github.stale || !!first.directory?.stale || !!first.clawhub?.stale);
  const nothing = s.complete && !checked.length && !own.length && !dir.length && !gh.length && !claw.length && !mixed.length;
  return (
    <div className="space-y-4" data-testid="open-market">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={setQ} label="Zoek in alles wat openbaar is" />
        <Dropdown<OpenSort> className="w-full sm:w-auto" label="Sorteren" testId="open-sort" value={sort} onChange={setSort} options={SORTS} />
        <TeamPlacePicker place={place} label="Team" />
      </div>
      <p className="text-xs text-muted" data-testid="open-sort-means">
        {SORT_MEANS[sort]}{' '}
        <MoreInfo>
          Dit komt rechtstreeks van GitHub en van de open skill-bibliotheken skills.sh en ClawHub; niemand bij TeamBot heeft het bekeken, tenzij er “Gecontroleerd” bij staat. Elke kaart zegt waar hij vandaan komt. Sterren en downloads van ClawHub telt ClawHub zelf; dat zijn andere getallen dan de sterren van GitHub. Toevoegen is één klik en werkt meteen voor het hele team. Op dat moment draait dezelfde controle als bij de gecontroleerde catalogus: alleen leesbare tekst komt mee en de veiligheidsscan leest alles. Scripts werken meteen mee, zoals elke opdracht op het niveau van de bot; een riskant script staat als waarschuwing bij de skill. Vindt de scan iets ernstigs in de instructies, dan zie je dat eerst en beslis jij. Je krijgt de versie van dat moment; een latere wijziging bij de bron zie je als verschil en wordt nooit vanzelf doorgevoerd. GitHub geeft geen lijst van sterren per dag en kan niet op aanmaakdatum sorteren; daarom staat hierboven wat “Trending” en “Nieuwste” hier betekenen.
        </MoreInfo>
      </p>
      {limit && (
        <p className="rounded-control bg-surface-2 px-3 py-2 text-sm text-muted" role="status" data-testid="open-limit">
          {limit.text}{' '}
          <a className="font-medium text-accent hover:underline" href="#/m/skills/bronnen">
            Met een eigen GitHub-token kan het vaker
          </a>
        </p>
      )}
      {s.error && !first ? (
        <ErrorCard error={s.error} retry={s.reload} />
      ) : !first ? (
        <LoadingCards n={6} />
      ) : nothing ? (
        <EmptyState icon={<Puzzle />} title="Niets gevonden" action={q && <Button onClick={() => setQ('')}>Alles tonen</Button>}>
          {first.offline ? 'TeamBot werkt offline en heeft deze zoekopdracht nog niet eerder gedaan.' : limit ? 'Zodra GitHub weer antwoordt, staat hier wat je zocht.' : 'Probeer een ander zoekwoord (ook in het Engels).'}
        </EmptyState>
      ) : (
        <>
          {checked.length > 0 && (
            <Section title="Gecontroleerd door TeamBot" hint="vaste versie, open licentie">
              <ul className={GRID}>
                {checked.slice(0, 6).map((c) => (
                  <li key={c.id} className="min-w-0">
                    <SkillCard c={c} adder={adder} onDiff={setDiff} />
                  </li>
                ))}
              </ul>
              {checked.length > 6 && (
                <button type="button" className="text-sm font-medium text-accent hover:underline" onClick={() => onShowChecked(dq)}>
                  {t('Alle {0} bekijken', checked.length)}
                </button>
              )}
            </Section>
          )}
          {own.length > 0 && (
            <Section title="Van TeamBot zelf en je eigen catalogi">
              <ul className={GRID}>
                {own.slice(0, 6).map((i) => (
                  <li key={i.catalogId + i.id} className="min-w-0">
                    <button type="button" data-card="own" className={cx(CARD, 'w-full text-start')} onClick={() => onOpenOwn(i.catalogId, i.id)}>
                      <span className="break-words font-semibold" translate="no">{i.title}</span>
                      <span className="mt-1 line-clamp-2 flex-1 break-words text-sm text-muted">{firstSentence(i.description)}</span>
                      <span className="mt-3 flex min-h-8 items-center">
                        {i.installed ? (
                          <Signal tone="ok" icon={<CheckCircle2 aria-hidden />}>
                            Toegevoegd
                          </Signal>
                        ) : i.verified ? (
                          <Signal tone="ok" icon={<ShieldCheck aria-hidden />}>
                            Gecontroleerd
                          </Signal>
                        ) : (
                          <Signal tone="warn" icon={<ShieldAlert aria-hidden />}>
                            Niet gecontroleerd
                          </Signal>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {own.length > 6 && (
                <button type="button" className="text-sm font-medium text-accent hover:underline" onClick={onShowOwn}>
                  {t('Alle {0} bekijken', own.length)}
                </button>
              )}
            </Section>
          )}
          {(mixed.length > 0 || mixPending) && (
            <Section title="GitHub en ClawHub" hint={sort === 'new' ? 'nieuwste eerst' : 'laatst bijgewerkt eerst'}>
              <ul className={GRID}>
                {mixed.map((c) => (
                  <li key={`${c.from}:${c.id}`} className="min-w-0">
                    <OpenResult c={c} busy={busyId === c.id} onAdd={() => add(c)} onOpen={() => open(c)} />
                  </li>
                ))}
              </ul>
              {mixPending && (
                <p className="flex items-center gap-2 text-sm text-muted" role="status">
                  <Spinner /> GitHub en ClawHub zoeken nog…
                </p>
              )}
            </Section>
          )}
          {s.githubPending && !byDate && (
            <Section title="Repositories op GitHub">
              <p className="flex items-center gap-2 text-sm text-muted" role="status">
                <Spinner /> GitHub zoekt nog…
              </p>
            </Section>
          )}
          {gh.length > 0 && (
            <Section title="Repositories op GitHub" hint={first.github.total ? t('{0, plural, one {# gevonden} other {# gevonden}}', first.github.total) : undefined}>
              <ul className={GRID}>
                {gh.map((c) => (
                  <li key={c.repo} className="min-w-0">
                    <OpenResult c={c} busy={busyId === c.id} onAdd={() => add(c)} onOpen={() => open(c)} />
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {dir.length > 0 && (
            <Section title="Losse skills uit de open bibliotheek" hint={first.directory?.order === 'recent' ? 'skills.sh · meeste installaties in 24 uur eerst' : 'skills.sh · meeste installaties eerst'}>
              <ul className={GRID}>
                {dir.map((c) => (
                  <li key={`${c.repo}/${c.skill}`} className="min-w-0">
                    <OpenResult c={c} busy={busyId === c.id} onAdd={() => add(c)} onOpen={() => open(c)} />
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {claw.length > 0 && (
            <Section title="Skills van ClawHub" hint={sort === 'trending' ? (dq ? 'meeste installaties in 60 dagen eerst' : 'de trending-volgorde van ClawHub') : 'sterren en downloads van ClawHub zelf · meeste sterren daar eerst'}>
              <ul className={GRID}>
                {claw.map((c) => (
                  <li key={c.id} className="min-w-0">
                    <OpenResult c={c} busy={busyId === c.id} onAdd={() => add(c)} onOpen={() => open(c)} />
                  </li>
                ))}
              </ul>
            </Section>
          )}
          <div className="flex flex-wrap items-center gap-3">
            {s.more && (
              <Button loading={s.busy} onClick={s.loadMore} data-testid="open-more">
                Meer laden
              </Button>
            )}
            {s.busy && !s.more && <Spinner />}
            {(stale || first.offline) && <span className="text-xs text-muted">{first.offline ? 'Offline: wat je eerder zag.' : 'Uit de cache: de bron is nu niet bereikbaar.'}</span>}
          </div>
          {problems.length > 0 && (
            <div className="space-y-1 rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
              <div className="font-medium text-fg">Niet alles kon worden opgehaald</div>
              {problems.map((p) => (
                <div key={p}>{p}</div>
              ))}
            </div>
          )}
        </>
      )}
      {repo && <RepoModal repo={repo} teamId={place.teamId} onClose={() => (setRepo(null), s.reload())} onReview={setReview} />}
      {review && <ReviewModal staging={review} onClose={() => (setReview(null), s.reload())} />}
      {diff && <UpdateDiffModal skillId={diff.skillId} commit={diff.commit} onClose={() => (setDiff(null), s.reload())} />}
    </div>
  );
}

/** The skills in one repository: each with its own "Toevoegen". */
function RepoModal({ repo, teamId, onClose, onReview }: { repo: string; teamId: string; onClose(): void; onReview(s: StagingView): void }) {
  const [d, setD] = useState<OpenRepo | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const adder = useAddSkill({ teamId, onReview, onDone: () => setTick((x) => x + 1) });
  useEffect(() => {
    api
      .get<OpenRepo>(`/skills/web/repo${qs({ repo, teamId: teamId && teamId !== '*' ? teamId : '' })}`)
      .then(setD)
      .catch((e) => setError(e.message));
  }, [repo, teamId, tick]);
  return (
    <Modal open wide onClose={onClose} title={<span translate="no">{repo}</span>}>
      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : !d ? (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Spinner /> Repository ophalen en lezen (er wordt niets uitgevoerd)…
        </div>
      ) : (
        <div className="space-y-3" data-testid="open-repo">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
            {d.stars !== null && (
              <span className="inline-flex items-center gap-1">
                <Star className="h-3.5 w-3.5 fill-current text-warn" aria-hidden />
                <span className="font-semibold text-fg">{starsText(d.stars) || '0'}</span>
                <span className="sr-only">sterren op GitHub</span>
              </span>
            )}
            <span>{d.license || 'geen licentie gevonden'}</span>
            {d.updatedAt && <span>{t('bijgewerkt {0}', when(d.updatedAt))}</span>}
            <a className="inline-flex items-center gap-1 text-accent hover:underline" href={d.url} target="_blank" rel="noopener noreferrer">
              Op GitHub <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          </div>
          {d.description && (
            <p className="text-sm" translate="no">
              {d.description}
            </p>
          )}
          {d.publisherStatus === 'lookalike' && <p className="rounded-control bg-warn-soft px-3 py-2 text-sm text-warn">{d.publisherNote}</p>}
          {!d.skills.length ? (
            <p className="text-sm text-muted">In deze repository staat geen skill (geen map met een SKILL.md).</p>
          ) : (
            <ul className="divide-y divide-line rounded-card border border-line">
              {d.skills.map((k) => (
                <li key={k.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5" data-open-skill={k.id}>
                  <div className="min-w-0 flex-1">
                    <button type="button" className="text-start font-semibold hover:underline" onClick={() => navigate(skillHref(k.id))}>
                      <span translate="no">{niceName(k.name)}</span>
                    </button>
                    {k.description && (
                      <p className="line-clamp-2 break-words text-sm text-muted" translate={k.checked ? undefined : 'no'}>
                        {firstSentence(k.description)}
                      </p>
                    )}
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {k.checked ? <Badge tone="ok">Gecontroleerd</Badge> : <Badge tone="warn">Niet gecontroleerd</Badge>}
                      {k.scripts && <Badge>scripts: uit</Badge>}
                      {k.scanLevel === 'danger' && <Badge tone="danger">scan: ernstige bevinding</Badge>}
                      {k.license && <Badge>{k.license}</Badge>}
                    </div>
                    {k.problem && <p className="mt-1 text-xs text-danger">Niet toe te voegen: {k.problem}</p>}
                  </div>
                  {k.installed ? (
                    <Signal tone="ok" icon={<CheckCircle2 aria-hidden />}>
                      Toegevoegd
                    </Signal>
                  ) : (
                    <Button size="sm" icon={<Plus className="h-4 w-4" />} loading={adder.busyId === k.id} disabled={!!k.problem} onClick={() => adder.add({ id: k.id, name: k.name, scripts: k.scripts })}>
                      Toevoegen
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {(d.namesOnly || d.truncated) && <p className="text-xs text-muted">{d.namesOnly ? 'Een grote repository: je ziet de namen; open een skill voor de beschrijving.' : 'Een grote repository: je ziet de eerste 400 skills.'}</p>}
        </div>
      )}
    </Modal>
  );
}

/** The optional GitHub token (Bronnen): more searches a minute; saved in the vault. */
export function GithubTokenCard() {
  const [s, setS] = useState<WebSources | null>(null);
  const [token, setToken] = useState('');
  const { busy, run } = useAsync();
  const load = () => api.get<WebSources>('/skills/web/sources').then(setS).catch(() => setS(null));
  useEffect(() => {
    load();
  }, []);
  if (!s) return null;
  const until = s.github.searchBlockedUntil || s.github.apiBlockedUntil;
  return (
    <Fold title="GitHub-token" hint={s.github.tokenSet ? 'Ingesteld' : 'Optioneel'}>
      <p className="text-xs text-muted">
        {until ? `Limiet bereikt tot ${new Date(until).toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit' })}. ` : ''}
        <MoreInfo>
          Zonder token laat GitHub 10 zoekopdrachten per minuut toe en 60 andere verzoeken per uur; downloads gaan buiten die limiet om. Een token (alleen leesrechten op openbare repositories) verhoogt de limiet en wordt versleuteld in je kluis bewaard.
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
  );
}
