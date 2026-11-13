import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, CheckCircle2, ExternalLink, Eye, EyeOff, Flag, FileJson, Globe, Link2, Plug, Puzzle, RefreshCw, ShieldAlert, ShieldCheck, Trash2, Share2, Ban, ClipboardCheck } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Page, PageHeader, Select, Spinner, cx, timeAgo, toast, useAsync, CardHead } from '../../components/ui';
import { MoreInfo } from '../../components/MoreInfo';
import { Segmented } from '../../components/SettingControls';
import { Fold, Menu, Skeleton, SkeletonRows, type MenuEntry } from '../../components/overview';
import { BotAvatar } from '../../components/BotFace';
import { encodeFace, isImageAvatar, parseFace, traitsFor } from '../../lib/botface';
import { api, request } from '../../lib/api';
import { navigate, query } from '../../lib/router';
import { t } from '../../lib/i18n';
import { Words } from '../../components/Words';
import { useApp } from '../../lib/store';
import type { ModelInfo } from '../../lib/types';
import type { AppItem, MarketBotDetail, MarketBotItem, MarketSkillDetail, MarketSkillItem, ReportRow, SourceView, StagingView, TemplatePreview } from './api';
import type { SignatureView } from '../../../../shared/skills.js';
import { REPORT_REASONS, fmtDate, formatBytes } from './api';
import { CARD, ErrorCard, Changelog, ListTools, LoadingCards, MarketMenuProvider, Meta, ReportButton, Signal, SkillsLinks, qs, useList, useMarketMenu } from './marketParts';
import { GithubTokenCard, OpenMarket } from './OpenMarket';
import { RegistryApps } from './RegistryApps';
import { CatalogSkills, CuratedDetailPage } from './Catalog';
import { skillHref } from './ClearMarket';
import { RecommendedTab } from './Recommended';
import { useAdvanced } from '../../shell/advanced';
import { AgentPicker, CandidatesReview, Collapse, Confirm, FileList, FindingsList, LabelBadges, Md, PermissionsView, PolicyOverride, ScanBadge, SignatureBadge, SignaturePanel, ThinSkillWarning, VerifiedBadge, bodyOf } from './common';
import { firstSentence } from '../../lib/sentence';
import { QuickConnect } from '../mcp/quick';
import { PLACE } from '../../../../shared/places.js';

type MTab = 'aanbevolen' | 'skills' | 'apps' | 'bots' | 'bronnen' | 'meldingen';
const TABS: MTab[] = ['aanbevolen', 'skills', 'apps', 'bots', 'bronnen', 'meldingen'];

export function MarketPage({ params }: { params: string[] }) {
  // One catalogue skill: a page of its own, with the way back.
  if (params[0] === 'skill' && params.length > 1) return <CuratedDetailPage id={params.slice(1).map(decodeURIComponent).join('/')} />;
  return <MarketTabs params={params} />;
}

function MarketTabs({ params }: { params: string[] }) {
  // 0.4.5: the page opens on what fits your bots; a link to an item (`?item=`) still opens on its own tab.
  const tab: MTab = TABS.includes(params[0] as MTab) ? (params[0] as MTab) : query().get('item') || query().get('bron') ? 'skills' : 'aanbevolen';
  const advanced = useAdvanced();
  const [importTpl, setImportTpl] = useState(false);
  // What the shown tab adds to "Meer opties" (see useMarketMenu).
  const [slots, setSlots] = useState<Record<string, MenuEntry[]>>({});
  const setSlot = useCallback((key: string, items: MenuEntry[] | null) => {
    setSlots((s) => {
      const n = { ...s };
      if (items) n[key] = items;
      else delete n[key];
      return n;
    });
  }, []);
  const own = Object.values(slots).flat().filter(Boolean);
  // Sources and reports are for the few who manage them: pages of their own behind "Meer opties", with a way back.
  const sub = tab === 'bronnen' || tab === 'meldingen';
  return (
    <Page>
      <PageHeader
        width="6xl"
        title={tab === 'bronnen' ? 'Bronnen' : tab === 'meldingen' ? 'Meldingen' : 'Marktplaats'}
        subtitle={tab === 'bronnen' ? 'Waar de skills, apps en bots vandaan komen.' : tab === 'meldingen' ? 'Wat er gemeld is over een skill, bot of app.' : 'Skills, apps en bots voor je team.'}
        back={sub ? { href: '#/m/skills/', label: 'Marktplaats' } : undefined}
        actions={
          !sub && (
            <>
              <Menu
                label="Meer opties"
                variant="secondary"
                testId="market-more"
                items={[
                  ...own,
                  own.length > 0 && 'sep',
                  { label: 'Bronnen', icon: <Globe aria-hidden />, href: '#/m/skills/bronnen' },
                  { label: 'Meldingen', icon: <Flag aria-hidden />, href: '#/m/skills/meldingen' },
                  advanced && { label: 'Bot-sjabloon importeren', icon: <FileJson aria-hidden />, onSelect: () => setImportTpl(true) },
                ]}
              />
            </>
          )
        }
      />
      <MarketMenuProvider value={setSlot}>
        <div className="mx-auto max-w-6xl space-y-4 px-4 pb-8 pt-2 sm:px-6">
          {!sub && <SkillsLinks current={tab === 'aanbevolen' ? 'recommended' : 'all'} />}
          {/* "Alles": one choice of what kind you look for. */}
          {!sub && tab !== 'aanbevolen' && (
            <Segmented<MTab>
              label="Soort"
              size="sm"
              value={tab}
              onChange={(v) => navigate(`/m/skills/${v}`)}
              options={[
                { value: 'skills', label: 'Skills' },
                { value: 'apps', label: 'Apps' },
                { value: 'bots', label: 'Bots' },
              ]}
            />
          )}
          {tab === 'aanbevolen' && <RecommendedTab />}
          {tab === 'bots' && <BotsTab />}
          {tab === 'skills' && <SkillsTab />}
          {tab === 'apps' && <AppsTab />}
          {tab === 'bronnen' && <SourcesTab />}
          {tab === 'meldingen' && <ReportsTab />}
        </div>
      </MarketMenuProvider>
      <TemplateImport open={importTpl} onClose={() => setImportTpl(false)} />
    </Page>
  );
}

// ---------------------------------------------------------------- shared

/** The filter menu of a catalogue list: only there once there is more than TeamBot's own catalogue to choose from. */
function filterMenu(o: { sources?: SourceView[] | null; source?: string; setSource?(v: string): void; signedOnly: boolean; setSignedOnly(v: boolean): void; show: boolean }): MenuEntry[] {
  if (!o.show && !o.source && !o.signedOnly) return [];
  const setSource = o.setSource;
  return [
    ...(o.sources && setSource
      ? [{ heading: 'Bron' }, { label: 'Alle bronnen', checked: !o.source, onSelect: () => setSource('') }, ...o.sources.map((s) => ({ label: <span translate="no">{s.name}</span>, checked: o.source === s.id, onSelect: () => setSource(s.id) })), 'sep' as const]
      : []),
    { label: 'Alleen ondertekend', checked: o.signedOnly, onSelect: () => o.setSignedOnly(!o.signedOnly) },
  ];
}

/** The one signal of a catalogue item: a problem with its signature, added, not checked, or checked. */
function ItemSignal({ sig, verified, added, update }: { sig?: SignatureView | null; verified: boolean; added?: boolean; update?: boolean }) {
  if (sig && (sig.blocked || sig.state === 'invalid' || !sig.compatible))
    return (
      <Signal tone="danger" icon={<ShieldAlert aria-hidden />}>
        {sig.compatible ? sig.label : 'Past niet bij deze TeamBot-versie'}
      </Signal>
    );
  if (added)
    return (
      <Signal tone="ok" icon={<CheckCircle2 aria-hidden />}>
        {update ? 'Toegevoegd · update beschikbaar' : 'Toegevoegd'}
      </Signal>
    );
  if (!verified)
    return (
      <Signal tone="warn" icon={<ShieldAlert aria-hidden />}>
        Niet gecontroleerd
      </Signal>
    );
  return (
    <Signal tone="ok" icon={<ShieldCheck aria-hidden />}>
      Gecontroleerd
    </Signal>
  );
}

// ---------------------------------------------------------------- skills

type CatalogPick = { catalogId: string; id: string };

type SkillSrc = 'curated' | 'open' | 'catalog';

/**
 * Skills, in one screen: "Gecontroleerd" is TeamBot's own catalogue on pinned versions (the first view), "Openbaar" is
 * everything public next to it (GitHub and the open skill libraries, with sorting; its search also covers the checked
 * catalogue and the catalogues below). "Eigen catalogi" holds TeamBot's self-written skills and the catalogues the
 * owner added: rarely needed, so one line in "Meer opties" until it is chosen. ("Openbaar", not "Open": "Open" is the
 * status of a task or a report, and one dictionary entry cannot be a view and a status at once.)
 */
function SkillsTab() {
  const item = query().get('item');
  const bron = query().get('bron');
  const [src, setSrc] = useState<SkillSrc>(() => (item?.startsWith('curated/') ? 'curated' : item?.startsWith('github/') || bron === 'internet' || bron === 'alles' || bron === 'open' ? 'open' : item || bron === 'eigen' ? 'catalog' : 'curated'));
  const [pick, setPick] = useState<CatalogPick | null>(null);
  // "Alle … bekijken" under the checked matches of a search in "Open": the checked view with the same words.
  const [words, setWords] = useState('');
  const advanced = useAdvanced();
  const choose = (v: SkillSrc) => (setPick(null), setWords(''), setSrc(v));
  // A link to one skill on GitHub (the update notice of a skill installed from the internet before 0.4): its own page.
  useEffect(() => {
    if (item?.startsWith('github/')) navigate(skillHref(item));
  }, [item]);
  const own = advanced || src === 'catalog';
  useMarketMenu('skills', own ? [] : [{ label: 'Zelf geschreven en eigen catalogi', icon: <Puzzle aria-hidden />, onSelect: () => choose('catalog') }], [own]);
  return (
    <div className="space-y-4">
      <Segmented<SkillSrc>
        label="Weergave"
        value={src}
        onChange={choose}
        options={[{ value: 'curated', label: 'Gecontroleerd' }, { value: 'open', label: 'Openbaar' }, ...(own ? [{ value: 'catalog' as const, label: 'Eigen catalogi' }] : [])]}
      />
      {src === 'open' && (
        <p className="text-sm text-muted" data-testid="open-means">
          Open: alles wat openbaar is op GitHub en in de open skill-bibliotheken. Niet door TeamBot gecontroleerd; de controle gebeurt op het moment dat je iets toevoegt.
        </p>
      )}
      {src === 'curated' ? (
        <CatalogSkills initialItem={item?.startsWith('curated/') ? item.slice('curated/'.length) : null} initialQuery={words} />
      ) : src === 'open' ? (
        <OpenMarket onOpenOwn={(catalogId, id) => (setPick({ catalogId, id }), setSrc('catalog'))} onShowOwn={() => choose('catalog')} onShowChecked={(q) => (setWords(q), setSrc('curated'))} />
      ) : (
        <CatalogSkillsTab initialOpen={pick} />
      )}
    </div>
  );
}

function CatalogSkillsTab({ initialOpen }: { initialOpen?: CatalogPick | null }) {
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [source, setSource] = useState('');
  const [signedOnly, setSignedOnly] = useState(false);
  const sources = useList<SourceView[]>('/skills/market/sources');
  const { data, error, reload } = useList<{ categories: string[]; items: MarketSkillItem[] }>(`/skills/market/skills${qs({ q, category, source, signed: signedOnly ? '1' : '' })}`);
  const [open, setOpen] = useState<CatalogPick | null>(() => {
    if (initialOpen) return initialOpen;
    const it = query().get('item');
    if (!it || it.startsWith('github/')) return null;
    const [catalogId, ...rest] = it.split('/');
    return { catalogId, id: rest.join('/') };
  });
  const filtered = !!(q || category || source || signedOnly);
  const clear = () => (setQ(''), setCategory(''), setSource(''), setSignedOnly(false));
  return (
    <div className="space-y-4">
      <ListTools q={q} setQ={setQ} label="Zoek een skill" category={category} setCategory={setCategory} categories={data?.categories || []} filter={filterMenu({ sources: sources.data, source, setSource, signedOnly, setSignedOnly, show: !!sources.data?.some((s) => s.kind === 'external') })} />
      {error ? (
        <ErrorCard error={error} retry={reload} />
      ) : !data ? (
        <LoadingCards n={6} />
      ) : !data.items.length ? (
        <EmptyState icon={<Puzzle />} title="Geen skills gevonden" action={filtered ? <Button onClick={clear}>Alles tonen</Button> : <Button onClick={() => navigate('/m/skills/bronnen')}>Naar Bronnen</Button>}>
          {filtered ? 'Probeer een ander zoekwoord.' : 'Voeg een catalogus toe bij Bronnen.'}
        </EmptyState>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.items.map((i) => (
            <li key={i.catalogId + i.id} className="min-w-0">
              <button type="button" className={cx(CARD, 'w-full text-start')} onClick={() => setOpen({ catalogId: i.catalogId, id: i.id })}>
                <span className="break-words font-semibold" translate="no">{i.title}</span>
                <span className="mt-1 line-clamp-1 flex-1 break-words text-sm text-muted">{firstSentence(i.description)}</span>
                <span className="mt-3 flex min-h-8 items-center">
                  <ItemSignal sig={i.signature} verified={i.verified} added={!!i.installed} update={i.installed?.updateAvailable} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && <SkillDetailModal catalogId={open.catalogId} id={open.id} onClose={() => (setOpen(null), reload())} />}
    </div>
  );
}

function SkillDetailModal({ catalogId, id, onClose }: { catalogId: string; id: string; onClose(): void }) {
  const [d, setD] = useState<MarketSkillDetail | null>(null);
  const [error, setError] = useState('');
  const [staging, setStaging] = useState<StagingView | null>(null);
  const [tick, setTick] = useState(0);
  const { busy, run } = useAsync();
  useEffect(() => {
    api
      .get<MarketSkillDetail>(`/skills/market/skills/${encodeURIComponent(catalogId)}/${encodeURIComponent(id)}`)
      .then(setD)
      .catch((e) => setError(e.message));
  }, [catalogId, id, tick]);
  const preview = () =>
    run(async () => {
      setStaging(await api.post<StagingView>(`/skills/market/skills/${encodeURIComponent(catalogId)}/${encodeURIComponent(id)}/preview`, {}));
    });
  const a = d?.analysis;
  return (
    <Modal open onClose={onClose} wide title={d ? d.title : 'Skill'}>
      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : !d ? (
        <Spinner />
      ) : staging ? (
        <div className="space-y-3">
          <p className="text-sm text-muted">Stap 2 van 2: bekijk de controle en installeer. De skill werkt daarna meteen voor het hele team.</p>
          <CandidatesReview staging={staging} doneLabel="Geïnstalleerd. Je vindt de skill onder Mijn skills." />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <SignatureBadge sig={d.signature} />
            <VerifiedBadge verified={d.verified} />
            {a?.scan && <ScanBadge level={a.scan.level} />}
            {a?.scan && <LabelBadges labels={a.scan.labels} />}
            {d.installed && <Badge tone="ok">Geïnstalleerd (v{d.installed.version || '?'})</Badge>}
          </div>
          <p className="text-sm" translate="no">{d.description}</p>
          <Meta
            items={[
              ['Uitgever', d.publisher],
              ['Catalogus', d.catalogName],
              ['Versie', d.version],
              ['Licentie', d.license],
              ['Categorie', d.category],
              ['Platform', d.platforms.join(', ') || 'Alle'],
              ['Afhankelijk van', d.dependencies.join(', ')],
              ['Checksum', d.sha256 ? <code className="break-all text-xs">{d.sha256}</code> : '—'],
            ]}
          />
          <ThinSkillWarning s={a?.substance} />
          {!d.verified && <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">Niet geverifieerd: deze skill komt van een externe bron en is niet door TeamBot beoordeeld. Lees de instructies en de scan goed na.</p>}
          <SignaturePanel sig={d.signature} policy={d.policy} onTrusted={() => setTick((x) => x + 1)} />
          <section className="space-y-2">
            <div className="text-sm font-semibold">Rechten en externe aanroepen</div>
            {a?.permissions ? <PermissionsView p={a.permissions} /> : d.download ? <p className="text-sm text-muted">Wordt bij installatie gedownload van {d.download.host}{d.download.size ? ` (${formatBytes(d.download.size)})` : ''} en gecontroleerd met de checksum; daarna zie je de rechten en de scan.</p> : null}
          </section>
          {a?.scan && (
            <Collapse title={t('Veiligheidsscan ({0})', a.scan.findings.length)} defaultOpen={a.scan.level === 'warn' || a.scan.level === 'danger'}>
              <FindingsList findings={a.scan.findings} />
            </Collapse>
          )}
          {a?.scan && (
            <Collapse title="Bestanden">
              <FileList files={a.scan.files} />
            </Collapse>
          )}
          {a?.skillMd && (
            <Collapse title="Instructies lezen">
              <div className="max-h-96 overflow-y-auto rounded-lg border border-line p-3">
                <Md text={bodyOf(a.skillMd)} />
              </div>
            </Collapse>
          )}
          {a?.error && <p className="text-sm text-danger">{a.error}</p>}
          <Collapse title="Wijzigingslog">
            <Changelog items={d.changelog} />
          </Collapse>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
            <ReportButton type="skill" catalogId={d.catalogId} itemId={d.id} itemName={d.title} />
            <Button variant="primary" loading={busy} disabled={d.policy.blocked} onClick={preview}>
              {d.installed ? (d.installed.updateAvailable ? 'Bijwerken…' : 'Opnieuw bekijken…') : 'Installeren…'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- bots

function BotsTab() {
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [source, setSource] = useState('');
  const [signedOnly, setSignedOnly] = useState(false);
  const sources = useList<SourceView[]>('/skills/market/sources');
  const { data, error, reload } = useList<{ categories: string[]; items: MarketBotItem[] }>(`/skills/market/bots${qs({ q, category, source, signed: signedOnly ? '1' : '' })}`);
  const [open, setOpen] = useState<MarketBotItem | null>(null);
  // Without a search or category the templates are grouped by category, in the order the server lists them
  // (the built-in catalogue is kept in a fixed category order; shared and external items follow).
  const grouped = !q.trim() && !category;
  const groups = useMemo(() => {
    const m = new Map<string, MarketBotItem[]>();
    for (const i of data?.items || []) {
      const k = i.category || 'Overig';
      const list = m.get(k);
      if (list) list.push(i);
      else m.set(k, [i]);
    }
    return [...m.entries()];
  }, [data]);
  const filtered = !!(q || category || source || signedOnly);
  return (
    <div className="space-y-4">
      <ListTools q={q} setQ={setQ} label="Zoek een bot" category={category} setCategory={setCategory} categories={data?.categories || []} filter={filterMenu({ sources: sources.data, source, setSource, signedOnly, setSignedOnly, show: !!sources.data?.some((s) => s.kind === 'external') })} />
      {error ? (
        <ErrorCard error={error} retry={reload} />
      ) : !data ? (
        <div className="space-y-3 pt-1">
          <Skeleton className="h-5 w-40" />
          <LoadingCards n={6} />
        </div>
      ) : !data.items.length ? (
        <EmptyState icon={<Bot />} title="Geen bots gevonden" action={filtered && <Button onClick={() => (setQ(''), setCategory(''), setSource(''), setSignedOnly(false))}>Alles tonen</Button>}>
          Probeer een ander zoekwoord.
        </EmptyState>
      ) : grouped ? (
        <div className="space-y-6 pt-1">
          {groups.map(([cat, items], gi) => (
            <section key={cat} aria-labelledby={`botcat-${gi}`} className="space-y-3">
              <h2 id={`botcat-${gi}`} className="flex items-baseline gap-2 text-[15px] font-bold tracking-tight">
                {cat}
                <span className="text-xs font-medium text-muted">
                  {items.length}
                  <span className="sr-only"> {items.length === 1 ? 'sjabloon' : 'sjablonen'}</span>
                </span>
              </h2>
              <BotGrid items={items} onOpen={setOpen} />
            </section>
          ))}
        </div>
      ) : (
        <BotGrid items={data.items} onOpen={setOpen} />
      )}
      {open && <BotDetailModal item={open} onClose={() => (setOpen(null), reload())} />}
    </div>
  );
}

/** A bot to add: its face, name and role, one sentence and one signal. The card opens what it brings and can do. */
function BotGrid({ items, onOpen }: { items: MarketBotItem[]; onOpen(i: MarketBotItem): void }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((i) => (
        <li key={i.catalogId + i.id} className="min-w-0">
          <button type="button" className={cx(CARD, 'w-full text-start')} onClick={() => onOpen(i)}>
            <span className="flex items-center gap-3">
              <BotAvatar bot={{ name: i.title, avatar: i.avatar }} size={44} />
              <span className="min-w-0">
                <span className="block break-words font-semibold" translate="no">{i.title}</span>
                <span className="block break-words text-xs text-muted" translate="no">{i.role}</span>
              </span>
            </span>
            <span className="mt-2 line-clamp-1 flex-1 break-words text-sm text-muted">{firstSentence(i.description)}</span>
            <span className="mt-3 flex min-h-8 items-center">
              <ItemSignal sig={i.signature} verified={i.verified} added={i.installedCount > 0} />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function BotDetailModal({ item, onClose }: { item: MarketBotItem; onClose(): void }) {
  const base = `/skills/market/bots/${encodeURIComponent(item.catalogId)}/${encodeURIComponent(item.id)}`;
  const [d, setD] = useState<MarketBotDetail | null>(null);
  const [preview, setPreview] = useState<TemplatePreview | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const { busy, run } = useAsync();
  useEffect(() => {
    api
      .get<MarketBotDetail>(base)
      .then(setD)
      .catch((e) => setError(e.message));
  }, [base, tick]);
  return (
    <Modal open onClose={onClose} wide title={<span translate="no">{item.title}</span>}>
      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : !d ? (
        <Spinner />
      ) : preview ? (
        <TemplateInstall preview={preview} install={(body) => api.post(`${base}/install`, body)} />
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <BotAvatar bot={{ name: d.title, avatar: d.avatar }} size={56} />
            <div>
              <div className="font-semibold" translate="no">{d.title}</div>
              <div className="text-sm text-muted" translate="no">{d.role}</div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <SignatureBadge sig={d.signature} />
            <VerifiedBadge verified={d.verified} />
            <Badge>{d.category}</Badge>
            {d.installedCount > 0 && <Badge tone="ok">{d.installedCount}× geïnstalleerd</Badge>}
          </div>
          <p className="text-sm" translate="no">{d.description}</p>
          <SignaturePanel sig={d.signature} policy={d.policy} onTrusted={() => setTick((x) => x + 1)} />
          <Meta
            items={[
              ['Uitgever', d.publisher],
              ['Catalogus', d.catalogName],
              ['Versie', d.version],
              ['Licentie', d.license],
              ['Toolgroepen', d.tool_groups.join(', ')],
              ['Skills', d.skills.join(', ')],
            ]}
          />
          <Collapse title="Instructies lezen">
            <div className="max-h-80 overflow-y-auto rounded-lg border border-line p-3">
              <Md text={d.instructions || '_Geen instructies._'} />
            </div>
          </Collapse>
          <Collapse title="Wijzigingslog">
            <Changelog items={d.changelog} />
          </Collapse>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
            <ReportButton type="bot" catalogId={d.catalogId} itemId={d.id} itemName={d.title} />
            <Button variant="primary" loading={busy} disabled={d.policy.blocked} onClick={() => run(async () => setPreview(await api.post<TemplatePreview>(`${base}/preview`, {})))}>
              Installeren…
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

const ACCESS_LABEL: Record<string, string> = { chat: 'Alleen chatten (geen tools)', readonly: 'Alleen lezen', ask: 'Vragen bij elke actie met impact', auto: 'Automatisch', full: 'Volledige toegang' };

/** Install preview for a bot template: what gets created, which rights, which external calls; pick engine. */
/**
 * A template's preview shows a face seeded by the template's name; the new bot would otherwise get a face seeded by
 * its own id. Store the previewed traits on the new bot so it looks the same as what you picked.
 */
async function keepFace<T extends { agent?: { id: string } }>(res: T, b: { name: string; avatar?: string }): Promise<T> {
  if (res?.agent?.id && !isImageAvatar(b.avatar)) {
    await api.patch(`/agents/${res.agent.id}`, { avatar: encodeFace(traitsFor(b.name, parseFace(b.avatar) || {})) }).catch(() => undefined);
  }
  return res;
}

function TemplateInstall({ preview, install }: { preview: TemplatePreview; install(body: any): Promise<any> }) {
  const providers = useApp((s) => s.providers);
  const settings = useApp((s) => s.settings);
  const usable = useMemo(() => providers.filter((p) => p.enabled), [providers]);
  const [providerId, setProviderId] = useState<string>(() => settings.defaultProvider || usable[0]?.id || '');
  const [model, setModel] = useState<string>(preview.bot.model_hint || '');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [name, setName] = useState(preview.bot.name);
  const [ack, setAck] = useState(false);
  const [override, setOverride] = useState(false);
  const [done, setDone] = useState<null | { agent: { id: string; name: string }; warnings: string[]; skillsCreated: { id: string; name: string }[] }>(null);
  const { busy, run } = useAsync();
  useEffect(() => {
    if (!providerId) return setModels([]);
    api
      .get<ModelInfo[]>(`/providers/${providerId}/models`)
      .then((m) => {
        setModels(m);
        setModel((cur) => (cur && m.some((x) => x.id === cur) ? cur : m[0]?.id || cur));
      })
      .catch(() => setModels([]));
  }, [providerId]);
  if (done)
    return (
      <div className="space-y-3">
        <p className="flex items-center gap-2 text-sm text-ok">
          <CheckCircle2 className="h-4 w-4" /> {done.skillsCreated.length ? t('{0} is aangemaakt met {1, plural, one {# nieuwe skill} other {# nieuwe skills}}.', done.agent.name, done.skillsCreated.length) : t('{0} is aangemaakt.', done.agent.name)}
        </p>
        {done.warnings.length > 0 && (
          <ul className="list-disc ps-5 text-sm text-warn">
            {done.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => navigate(`/a/${done.agent.id}`)}>
            Chat openen
          </Button>
          <Button onClick={() => navigate(`/agents/${done.agent.id}`)}>Instellingen bekijken</Button>
        </div>
      </div>
    );
  const b = preview.bot;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">Er wordt een nieuwe bot gemaakt. Gesprekken, geheugen, bestanden en sleutels zitten nooit in een sjabloon.</p>
      <SignaturePanel sig={preview.signature} policy={preview.policy} />
      <Card className="space-y-3 p-4">
        <div className="flex items-center gap-3">
          <BotAvatar bot={{ name: b.name, avatar: b.avatar }} size={48} />
          <div className="min-w-0">
            <div className="font-semibold" translate="no">{b.name}</div>
            <div className="text-sm text-muted" translate="no">{b.role}</div>
          </div>
        </div>
        <Meta
          items={[
            ['Toegang', `${ACCESS_LABEL[b.access_mode] || b.access_mode}${b.requested_access_mode !== b.access_mode ? ` (sjabloon vroeg: ${ACCESS_LABEL[b.requested_access_mode] || b.requested_access_mode})` : ''}`],
            ['Tools', b.tool_groups.filter((g) => g.known).map((g) => g.label).join(', ') || 'Geen'],
            ['Routines', preview.routines.count ? `${preview.routines.count}${preview.routines.supported ? ' (worden aangemaakt via de routinemodule)' : ' (niet beschikbaar)'}` : 'Geen'],
            ['Externe adressen', preview.externalCalls.length ? preview.externalCalls.join(', ') : 'Geen'],
          ]}
        />
        <Collapse title="Instructies">
          <div className="max-h-72 overflow-y-auto rounded-lg border border-line p-3">
            <Md text={b.instructions || '_Geen instructies._'} />
          </div>
        </Collapse>
      </Card>
      {preview.skills.length > 0 && (
        <Card className="space-y-2 p-4">
          <CardHead icon={Puzzle} tone="teal" title="Skills" />
          <ul className="space-y-2">
            {preview.skills.map((s) => (
              <li key={s.name} className="rounded-lg border border-line p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium" translate="no">{s.name}</span>
                  {s.version && <Badge>v{s.version}</Badge>}
                  <Badge tone={s.action === 'create' ? 'accent' : s.action === 'error' ? 'danger' : 'neutral'}>{s.action === 'create' ? 'Wordt geïnstalleerd' : s.action === 'error' ? 'Overgeslagen' : 'Je eigen versie wordt gebruikt'}</Badge>
                  {s.scan && <ScanBadge level={s.scan.level} />}
                  {s.scan && <LabelBadges labels={s.scan.labels} />}
                </div>
                {s.description && <p className="mt-1 text-muted" translate="no">{s.description}</p>}
                {s.error && <p className="mt-1 text-danger">{s.error}</p>}
                {s.scan && s.scan.findings.some((f) => f.severity !== 'info') && (
                  <div className="mt-2">
                    <FindingsList findings={s.scan.findings.filter((f) => f.severity !== 'info')} max={5} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {preview.warnings.length > 0 && (
        <ul className="list-disc space-y-0.5 ps-5 text-sm text-warn">
          {preview.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      <Card className="space-y-3 p-4">
        <Field label="Naam van de nieuwe bot">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {usable.length === 0 ? (
          <p className="text-sm text-warn">
            Je hebt nog geen AI-provider. De bot wordt aangemaakt zonder provider;{' '}
            <a className="underline" href="#/settings/providers">
              koppel er een
            </a>{' '}
            en kies hem daarna bij de bot.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Provider">
              <Select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
                {usable.map((p) => (
                  <option key={p.id} value={p.id} translate="no">
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Model" hint={b.model_hint ? `Sjabloon stelt voor: ${b.model_hint}` : undefined}>
              {models.length ? (
                <Select value={model} onChange={(e) => setModel(e.target.value)}>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label || m.id}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="modelnaam" />
              )}
            </Field>
          </div>
        )}
        {preview.needsAcknowledge && (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 h-4 w-4" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>Ik heb de ernstige waarschuwingen bij de skills gelezen en wil toch installeren.</span>
          </label>
        )}
        {preview.policy?.needsOverride && <PolicyOverride checked={override} onChange={setOverride} />}
        <div className="flex justify-end">
          <Button
            variant="primary"
            loading={busy}
            disabled={(preview.needsAcknowledge && !ack) || !!preview.policy?.blocked || (!!preview.policy?.needsOverride && !override)}
            onClick={() => run(async () => setDone(await keepFace(await install({ provider_id: providerId || null, model, name, acknowledge: ack, overridePolicy: override }), b)))}
          >
            Bot aanmaken
          </Button>
        </div>
      </Card>
    </div>
  );
}

function TemplateImport({ open, onClose }: { open: boolean; onClose(): void }) {
  const [tpl, setTpl] = useState<{ template?: any; package?: any } | null>(null);
  const [preview, setPreview] = useState<TemplatePreview | null>(null);
  const [error, setError] = useState('');
  const { busy, run } = useAsync();
  useEffect(() => {
    if (!open) (setTpl(null), setPreview(null), setError(''));
  }, [open]);
  const onFile = (f?: File) => {
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) return setError('Het bestand is te groot (max. 10 MB).');
    run(async () => {
      setError('');
      try {
        let body: { template?: any; package?: any };
        if (/\.zip$/i.test(f.name) || f.type.includes('zip')) {
          // Signed bot package: the server unpacks it; preview and install verify it again.
          const r = await request<{ kind: string; package: any }>('/skills/packages/unzip', { method: 'POST', raw: f, headers: { 'content-type': 'application/zip' } });
          if (r.kind !== 'bot') throw new Error(r.kind === 'skill' ? 'Dit is een skillpakket. Importeer het via Mijn skills › Importeren.' : 'Dit is een connectorpakket. Importeer het via Apps & connectors.');
          body = { package: r.package };
        } else {
          const j = JSON.parse(await f.text());
          body = j && j.manifest && j.files ? { package: j } : { template: j };
        }
        const p = await api.post<TemplatePreview>('/skills/templates/preview', body);
        setTpl(body);
        setPreview(p);
      } catch (e: any) {
        setError(e instanceof SyntaxError ? 'Dit is geen geldig JSON-bestand.' : e.message);
      }
    });
  };
  return (
    <Modal open={open} onClose={onClose} wide title="Bot-sjabloon importeren">
      {preview ? (
        <TemplateInstall preview={preview} install={(body) => api.post('/skills/templates/install', { ...body, ...tpl })} />
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted">Kies een bot-bestand dat iemand met je deelde. Je ziet eerst wat erin zit.</p>
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-line px-4 py-8 text-center text-sm hover:border-line-strong">
            <FileJson className="h-6 w-6 text-muted" />
            <span>{busy ? 'Bezig…' : 'Bestand kiezen'}</span>
            <input type="file" accept=".json,application/json,.zip,application/zip" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
          {error && (
            <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- apps

function AppsTab() {
  const [src, setSrc] = useState<'registry' | 'catalog'>('registry');
  const [pick, setPick] = useState<string | null>(null);
  // The switch stands next to the search box of either list (one row of controls instead of two).
  const tools = (
    <Segmented<'registry' | 'catalog'>
      label="Bron"
      value={src}
      onChange={(v) => (setPick(null), setSrc(v))}
      options={[
        { value: 'registry', label: 'Alle apps' },
        { value: 'catalog', label: 'Van TeamBot' },
      ]}
    />
  );
  return src === 'registry' ? <RegistryApps tools={tools} onOpenCatalog={(id) => (setPick(id), setSrc('catalog'))} onShowCatalog={() => (setPick(null), setSrc('catalog'))} /> : <CatalogAppsTab tools={tools} initialOpen={pick} />;
}

function CatalogAppsTab({ initialOpen, tools }: { initialOpen?: string | null; tools: React.ReactNode }) {
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [signedOnly, setSignedOnly] = useState(false);
  const { data, error, reload } = useList<{ available: boolean; canInstall: boolean; categories: string[]; items: AppItem[]; error?: string }>(`/skills/market/apps${qs({ q, category, signed: signedOnly ? '1' : '' })}`);
  const [open, setOpen] = useState<AppItem | null>(null);
  // Opened from a "TeamBot" card on the registry tab: show that app as soon as the catalogue is loaded.
  const [wanted, setWanted] = useState(initialOpen || null);
  useEffect(() => {
    if (!wanted || !data) return;
    const it = data.items.find((i) => i.catalogId === 'mcp' && i.id === wanted);
    if (it) setOpen(it);
    setWanted(null);
  }, [data, wanted]);
  if (error)
    return (
      <div className="space-y-4">
        {tools}
        <ErrorCard error={error} retry={reload} />
      </div>
    );
  if (data && !data.available)
    return (
      <div className="space-y-4">
        {tools}
        <EmptyState icon={<Plug />} title="Apps staan hier uit">
          De koppeling met apps is in deze installatie niet actief. Skills en bots werken wel.
        </EmptyState>
      </div>
    );
  const filtered = !!(q || category || signedOnly);
  const bar = (
    <ListTools q={q} setQ={setQ} label="Zoek een app" category={category} setCategory={setCategory} categories={data?.categories || []} filter={filterMenu({ signedOnly, setSignedOnly, show: !!data?.items.some((i) => !!i.sourceKind && i.sourceKind !== 'builtin') })}>
      {tools}
    </ListTools>
  );
  if (!data)
    return (
      <div className="space-y-4">
        {bar}
        <LoadingCards n={6} />
      </div>
    );
  return (
    <div className="space-y-4">
      {bar}
      {data.error && <p className="text-sm text-danger">De apps konden niet allemaal laden: {data.error}</p>}
      {!data.items.length ? (
        <EmptyState icon={<Plug />} title="Geen apps gevonden" action={filtered && <Button onClick={() => (setQ(''), setCategory(''), setSignedOnly(false))}>Alles tonen</Button>}>
          Probeer een ander zoekwoord.
        </EmptyState>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.items.map((i) => (
            <li key={`${i.catalogId}/${i.id}`} className="min-w-0">
              <button type="button" className={cx(CARD, 'w-full text-start')} onClick={() => setOpen(i)}>
                <span className="break-words font-semibold" translate="no">{i.title}</span>
                <span className="mt-1 line-clamp-1 flex-1 break-words text-sm text-muted">{firstSentence(i.description)}</span>
                <span className="mt-3 flex min-h-8 items-center">
                  {/* TeamBot's own connectors ('mcp') were looked at by TeamBot; a package from elsewhere shows its signature. */}
                  <ItemSignal sig={i.packaged ? i.signature : null} verified={i.verified || (!i.packaged && i.catalogId === 'mcp')} added={i.installed} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && <AppDetail app={open} canInstall={data.canInstall} onClose={() => (setOpen(null), reload())} />}
    </div>
  );
}

function AppDetail({ app, canInstall, onClose }: { app: AppItem; canInstall: boolean; onClose(): void }) {
  const [agents, setAgents] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const { busy, run } = useAsync();
  return (
    <Modal open onClose={onClose} wide title={<span translate="no">{app.title}</span>}>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <SignatureBadge sig={app.signature} />
          {!app.packaged && <VerifiedBadge verified={app.verified} />}
          <Badge>{app.category}</Badge>
          {app.needsAuth && <Badge tone="warn">Vraagt om inloggen</Badge>}
        </div>
        <p className="text-sm" translate="no">{app.description}</p>
        {app.packaged && <SignaturePanel sig={app.signature} />}
        <Meta
          items={[
            ['Uitgever', app.publisher],
            ['Versie', app.version],
            ['Licentie', app.license],
            ['Verbinding', app.transport],
            ['Rechten', app.permissions.join(', ') || 'Niet opgegeven'],
            ['Externe adressen', app.externalCalls.join(', ') || 'Niet opgegeven'],
            [
              'Website',
              app.homepage ? (
                <a className="inline-flex items-center gap-1 text-accent underline" href={app.homepage} target="_blank" rel="noopener noreferrer">
                  {app.homepage} <ExternalLink className="h-3 w-3" />
                </a>
              ) : (
                ''
              ),
            ],
          ]}
        />
        {app.changelog.length > 0 && (
          <Collapse title="Wijzigingslog">
            <Changelog items={app.changelog} />
          </Collapse>
        )}
        {done ? (
          <p className="flex items-center gap-2 text-sm text-ok">
            <CheckCircle2 className="h-4 w-4" /> Geïnstalleerd. Rond eventueel het inloggen af in Apps.
          </p>
        ) : canInstall ? (
          <div className="space-y-3 border-t border-line pt-3">
            <AgentPicker single value={agents.slice(0, 1)} onChange={(v) => setAgents(v.slice(-1))} label="Koppelen aan bot (optioneel, één)" />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <ReportButton type="app" catalogId="mcp" itemId={app.id} itemName={app.title} />
              <Button variant="primary" loading={busy} onClick={() => run(async () => (await api.post(`/skills/market/apps/${encodeURIComponent(app.id)}/install`, { agentId: agents[0] }), setDone(true)), 'App geïnstalleerd')}>
                Installeren
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
            <ReportButton type="app" catalogId={app.catalogId || 'mcp'} itemId={app.id} itemName={app.title} />
            {app.packaged ? (
              <Button variant="primary" disabled={app.signature.blocked} onClick={() => navigate(`/m/mcp?package=${encodeURIComponent(`${app.catalogId}/${app.id}`)}`)}>
                Installeren via Apps…
              </Button>
            ) : (
              <QuickConnect catalogId={app.id} name={app.title} />
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- sources

function SourcesTab() {
  return (
    <div className="space-y-4">
      <CatalogSources />
      <GithubTokenCard />
    </div>
  );
}

function CatalogSources() {
  const { data, error, reload } = useList<SourceView[]>('/skills/market/sources');
  const shares = useList<{ id: string; item_type: string; slug: string; title: string; version: string; status?: string; review?: { reason?: string } | null; updated_at: string }[]>('/skills/shares');
  const [url, setUrl] = useState('');
  const [sha, setSha] = useState('');
  const [del, setDel] = useState<SourceView | null>(null);
  const { busy, run } = useAsync();
  const add = () =>
    run(async () => {
      const r = await api.post<{ warnings: string[]; skills: number; bots: number }>('/skills/catalogs', { url: url.trim(), sha256: sha.trim() || undefined });
      toast(
        r.warnings.length
          ? t('Catalogus toegevoegd: {0, plural, one {# skill} other {# skills}}, {1, plural, one {# bot} other {# bots}} ({2, plural, one {# item overgeslagen} other {# items overgeslagen}})', r.skills, r.bots, r.warnings.length)
          : t('Catalogus toegevoegd: {0, plural, one {# skill} other {# skills}}, {1, plural, one {# bot} other {# bots}}', r.skills, r.bots),
        'ok',
      );
      setUrl('');
      setSha('');
      reload();
    });
  return (
    <div className="space-y-4">
      {error && <ErrorCard error={error} retry={reload} />}
      {!data ? (
        !error && <SkeletonRows n={2} avatar={false} />
      ) : (
        <ul className="tb-in divide-y divide-line rounded-card border border-line bg-surface">
          {data.map((s) => (
            <li key={s.id} className="space-y-2 px-4 py-3.5">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="break-words font-semibold" translate="no">
                    {s.name}
                  </div>
                  <div className="text-[13px] text-muted">
                    {t('{0, plural, one {# skill} other {# skills}} · {1, plural, one {# bot} other {# bots}}', s.skills, s.bots)}
                    {s.connectors ? ` · ${t('{0, plural, one {# app} other {# apps}}', s.connectors)}` : ''}
                  </div>
                </div>
                {s.error ? (
                  <Signal tone="danger" icon={<ShieldAlert aria-hidden />}>
                    Ophalen mislukt
                  </Signal>
                ) : s.kind === 'external' && s.enabled === false ? (
                  <Signal>Uit</Signal>
                ) : (
                  <ItemSignal verified={s.verified} />
                )}
                {s.kind === 'external' && (
                  <Menu
                    label={t('Meer bij {0}', s.name)}
                    items={[
                      { label: s.enabled !== false ? 'Verbergen in de marktplaats' : 'Tonen in de marktplaats', icon: s.enabled !== false ? <EyeOff aria-hidden /> : <Eye aria-hidden />, onSelect: () => run(() => api.patch(`/skills/catalogs/${s.rowId}`, { enabled: s.enabled === false }).then(reload)) },
                      { label: 'Vernieuwen', icon: <RefreshCw aria-hidden />, onSelect: () => run(() => api.post(`/skills/catalogs/${s.rowId}/refresh`).then(reload), 'Bijgewerkt') },
                      'sep',
                      { label: 'Verwijderen', icon: <Trash2 aria-hidden />, danger: true, onSelect: () => setDel(s) },
                    ]}
                  />
                )}
              </div>
              {s.kind === 'external' && (
                <>
                  {s.error && <p className="text-sm text-danger">{s.error}</p>}
                  <Collapse title="Details">
                    <div className="space-y-0.5 text-xs text-muted">
                      <div className="break-all">{s.url}</div>
                      <div>Uitgever: {s.publisher || 'onbekend'}</div>
                      <div>Laatst opgehaald: {s.fetchedAt ? `${fmtDate(s.fetchedAt)} (${timeAgo(s.fetchedAt)})` : '—'}</div>
                      <div className="break-all">sha256: {s.sha256 || '—'}</div>
                      {s.expectedSha256 && <div className="break-all">Vastgezet op: {s.expectedSha256}</div>}
                      {(s.warnings || []).length > 0 && (
                        <ul className="list-disc ps-5 pt-1 text-warn">
                          {s.warnings!.map((w, i) => (
                            <li key={i}>{w}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </Collapse>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <Fold title="Catalogus toevoegen">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Adres (https)">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/catalog.json" inputMode="url" />
          </Field>
          <Field label="sha256 van het bestand (optioneel)" hint="Zet de catalogus vast: andere inhoud wordt dan geweigerd.">
            <Input value={sha} onChange={(e) => setSha(e.target.value)} placeholder="64 tekens" />
          </Field>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <MoreInfo>
            Een externe catalogus is een JSON-bestand in het formaat <code>teambot.catalog/v1</code>. Items daaruit zijn altijd “niet gecontroleerd” en worden bij installatie gecontroleerd met hun sha256-checksum. {t('Ondertekende items tonen wie ze ondertekende; het beleid daarvoor staat bij {0}.', t(PLACE.trustedMakers))}
          </MoreInfo>
          <Button variant="primary" className="ms-auto" icon={<Link2 className="h-4 w-4" />} loading={busy} disabled={!/^https?:\/\//i.test(url.trim())} onClick={add}>
            Toevoegen
          </Button>
        </div>
      </Fold>
      <Card className="space-y-2 p-4">
        <CardHead icon={Share2} tone="blue" title="Wat ik deel" />
        {!shares.data ? (
          <Skeleton className="h-4 w-1/2" />
        ) : !shares.data.length ? (
          <p className="text-sm text-muted">Je deelt nog niets.</p>
        ) : (
          <ul className="divide-y divide-line">
            {shares.data.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {s.item_type === 'bot' ? 'Bot' : 'Skill'}: <span className="font-medium" translate="no">{s.title}</span> <span className="text-muted">({timeAgo(s.updated_at)})</span>
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
                    {s.status === 'pending' ? <Badge tone="warn">Wacht op beoordeling</Badge> : s.status === 'rejected' ? <Badge tone="danger">Afgekeurd</Badge> : <Badge tone="ok">Zichtbaar voor iedereen</Badge>}
                    {s.status === 'rejected' && s.review?.reason && <Words className="text-xs text-muted" text="Reden: {0}" values={[s.review.reason]} />}
                  </span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => run(() => api.del(`/skills/shares/${s.id}`).then(() => (shares.reload(), reload())), 'Niet meer gedeeld')}>
                  Stop met delen
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Confirm open={!!del} onClose={() => setDel(null)} title="Catalogus verwijderen?" confirmLabel="Verwijderen" danger busy={busy} onConfirm={() => del && run(() => api.del(`/skills/catalogs/${del.rowId}`).then(() => (setDel(null), reload())), 'Catalogus verwijderd')}>
        <p>De catalogus verdwijnt uit je marktplaats. Skills en bots die je eruit hebt geïnstalleerd, blijven staan.</p>
      </Confirm>
    </div>
  );
}

// ---------------------------------------------------------------- review of shares (B-11)

interface PendingShare {
  id: string;
  item_type: 'skill' | 'bot';
  title: string;
  description: string;
  version: string;
  by: string;
  submitted_at: string;
  license: string;
  scan: { level: 'ok' | 'info' | 'warn' | 'danger'; labels: string[]; findings: any[]; scripts?: string[]; domains?: string[] } | null;
  skillMd?: string;
  files: { path: string; size: number }[];
  bot?: { role: string; instructions: string; access_mode: string; tool_groups: string[]; skills: string[] };
}

/** Owner/admin: what members want to share. Nobody else sees an item before it is approved here. */
function ShareReviews({ onDecided }: { onDecided(): void }) {
  const { data, error, reload } = useList<PendingShare[]>('/skills/shares/review');
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const { busy, run } = useAsync();
  const decide = (p: PendingShare, decision: 'approve' | 'reject') =>
    run(
      () => api.post(`/skills/shares/${p.id}/review`, { decision, reason: reasons[p.id] || '' }).then(() => (reload(), onDecided())),
      decision === 'approve' ? `Goedgekeurd: iedereen op deze server ziet “${p.title}” nu` : 'Afgekeurd; de indiener krijgt de reden te zien',
    );
  if (error) return <ErrorCard error={error} retry={reload} />;
  if (!data) return <SkeletonRows n={1} avatar={false} />;
  return (
    <section className="space-y-2" aria-labelledby="share-review-title" data-testid="share-reviews">
      <CardHead id="share-review-title" icon={ClipboardCheck} tone="orange" title={<>Ter beoordeling{data.length ? ` (${data.length})` : ''}</>} />
      {!data.length ? (
        <p className="text-sm text-muted">Niets te beoordelen. Wat iemand deelt, zie jij hier eerst.</p>
      ) : (
        <ul className="space-y-2">
          {data.map((p) => (
            <li key={p.id}>
              <Card className="space-y-2 p-4 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold" translate="no">{p.title}</span>
                  <Badge>{p.item_type === 'bot' ? 'Bot-sjabloon' : 'Skill'}</Badge>
                  {p.version && <span className="text-xs text-muted">versie {p.version}</span>}
                  {p.scan && <ScanBadge level={p.scan.level} />}
                </div>
                <div className="text-muted">
                  Ingediend door {p.by} · {fmtDate(p.submitted_at)}
                  {p.license ? ` · licentie ${p.license}` : ''}
                </div>
                {p.description && <p translate="no">{p.description}</p>}
                {p.scan ? (
                  <div className="space-y-1.5 rounded-lg bg-surface-2 p-2.5">
                    <div className="text-xs font-semibold text-muted">Scan</div>
                    {p.scan.labels.length > 0 && <LabelBadges labels={p.scan.labels} />}
                    {p.scan.findings.length ? <FindingsList findings={p.scan.findings} max={20} /> : <p className="text-xs text-muted">Geen bevindingen: geen geheimen, scripts met gevolgen of verdachte instructies gevonden.</p>}
                    {!!p.scan.domains?.length && <p className="text-xs text-muted">Externe adressen: {p.scan.domains.join(', ')}</p>}
                  </div>
                ) : (
                  <p className="rounded-lg bg-surface-2 p-2.5 text-xs text-muted">Een bot-sjabloon heeft geen scripts; controleer de instructies en wat de bot mag.</p>
                )}
                <Collapse title={p.item_type === 'bot' ? 'Instructies en rechten bekijken' : `Inhoud bekijken (${p.files.length} ${p.files.length === 1 ? 'bestand' : 'bestanden'})`}>
                  {p.bot ? (
                    <div className="space-y-1.5 text-[13px]">
                      {p.bot.role && (
                        <div>
                          <Words text="Rol: {0}" values={[p.bot.role]} />
                        </div>
                      )}
                      <div>
                        Mag: {p.bot.access_mode || 'standaard'} · tools: {p.bot.tool_groups.join(', ') || 'geen'}
                        {p.bot.skills.length ? ` · skills: ${p.bot.skills.join(', ')}` : ''}
                      </div>
                      <Md text={p.bot.instructions || '(geen instructies)'} />
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <ul className="text-xs text-muted">
                        {p.files.map((f) => (
                          <li key={f.path} className="break-all font-mono" translate="no">
                            {f.path}
                          </li>
                        ))}
                      </ul>
                      {p.skillMd && <Md text={bodyOf(p.skillMd)} />}
                    </div>
                  )}
                </Collapse>
                <div className="flex flex-wrap items-end gap-2 pt-1">
                  <Input className="h-8 min-w-0 flex-1 basis-56" value={reasons[p.id] || ''} onChange={(e) => setReasons({ ...reasons, [p.id]: e.target.value })} placeholder="Reden bij afkeuren (de indiener ziet die)" aria-label={t('Reden voor {0}', p.title)} />
                  <Button size="sm" variant="primary" loading={busy} onClick={() => decide(p, 'approve')}>
                    Goedkeuren
                  </Button>
                  <Button size="sm" variant="ghost" loading={busy} disabled={!(reasons[p.id] || '').trim()} onClick={() => decide(p, 'reject')} title="Vul eerst een reden in">
                    Afkeuren
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- reports

function ReportsTab() {
  const me = useApp((s) => s.me);
  const isAdmin = me?.role === 'owner' || me?.role === 'admin';
  const { data, error, reload } = useList<ReportRow[]>(`/skills/market/reports${isAdmin ? '?all=1' : ''}`);
  const blocks = useList<{ item_type: string; catalog_id: string; item_id: string; reason: string; created_at: string }[]>(isAdmin ? '/skills/market/blocks' : null);
  const { busy, run } = useAsync();
  const reason = (id: string) => REPORT_REASONS.find((r) => r.id === id)?.label || id;
  const resolve = (r: ReportRow, status: 'resolved' | 'dismissed', block = false) =>
    run(() => api.post(`/skills/market/reports/${r.id}`, { status, block, resolution: block ? 'Geblokkeerd door beheerder' : status === 'dismissed' ? 'Afgewezen' : 'Afgehandeld' }).then(() => (reload(), blocks.reload())), block ? 'Item geblokkeerd voor iedereen' : 'Bijgewerkt');
  return (
    <div className="space-y-4">
      {isAdmin && <ShareReviews onDecided={reload} />}
      {isAdmin && <CardHead className="pt-2" icon={Flag} tone="rose" title="Gemeld" />}
      {error ? (
        <ErrorCard error={error} retry={reload} />
      ) : !data ? (
        <SkeletonRows n={2} avatar={false} />
      ) : !data.length ? (
        <EmptyState icon={<Flag />} title="Geen meldingen">
          Deugt een skill, bot of app niet? Open hem en kies Melden.
        </EmptyState>
      ) : (
        <ul className="space-y-2">
          {data.map((r) => (
            <li key={r.id}>
              <Card className="space-y-1 p-4 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{r.item_name || r.item_id}</span>
                  <Badge>{r.item_type}</Badge>
                  <Badge tone={r.status === 'open' ? 'warn' : 'neutral'}>{r.status === 'open' ? 'Open' : r.status === 'resolved' ? 'Afgehandeld' : 'Afgewezen'}</Badge>
                  {r.blocked && <Badge tone="danger">Geblokkeerd</Badge>}
                </div>
                <div className="text-muted">
                  {reason(r.reason)} · {fmtDate(r.created_at)}
                  {r.reporter ? ` · door ${r.reporter}` : ''}
                </div>
                {r.details && <p>{r.details}</p>}
                {r.resolution && <p className="text-muted">Afhandeling: {r.resolution}</p>}
                {isAdmin && r.status === 'open' && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button size="sm" variant="danger" loading={busy} onClick={() => resolve(r, 'resolved', true)}>
                      Blokkeren
                    </Button>
                    <Button size="sm" loading={busy} onClick={() => resolve(r, 'resolved')}>
                      Afgehandeld
                    </Button>
                    <Button size="sm" variant="ghost" loading={busy} onClick={() => resolve(r, 'dismissed')}>
                      Afwijzen
                    </Button>
                  </div>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
      {isAdmin && blocks.data && blocks.data.length > 0 && (
        <Card className="space-y-2 p-4">
          <CardHead icon={Ban} tone="rose" title="Geblokkeerde items" />
          <ul className="divide-y divide-line">
            {blocks.data.map((b) => (
              <li key={`${b.item_type}|${b.catalog_id}|${b.item_id}`} className={cx('flex flex-wrap items-center justify-between gap-2 py-2 text-sm')}>
                <span className="min-w-0 break-all">
                  {b.item_type}: {b.catalog_id}/{b.item_id} {b.reason && (
                    <span className="text-muted" translate="no">
                      — {b.reason}
                    </span>
                  )}
                </span>
                <Button size="sm" variant="ghost" loading={busy} onClick={() => run(() => api.del(`/skills/market/blocks/${b.item_type}/${encodeURIComponent(b.catalog_id)}/${encodeURIComponent(b.item_id)}`).then(() => (blocks.reload(), reload())), 'Blokkade opgeheven')}>
                  Deblokkeren
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
