import React, { useState } from 'react';
import { Bot, ChevronRight, ClipboardCheck, Download, FolderOpen, HardDrive, History, Pause, Play, Plus, Search, Share2, User } from 'lucide-react';
import { api, authUrl } from '../../lib/api';
import { t } from '../../lib/i18n';
import { stripRefs } from '../../lib/preview';
import { navigate } from '../../lib/router';
import { useApp } from '../../lib/store';
import { Badge, Button, Card, EmptyState, Input, Page, PageHeader, Select, Tabs, useAsync } from '../../components/ui';
import { Menu, SkeletonRows } from '../../components/overview';
import { Segmented } from '../../components/SettingControls';
import { BotAvatar } from '../../components/BotFace';
import { ErrorBox, ItemCard, ItemDetail, ItemEditor, ItemList } from './parts';
import { ALL_TEAMS, type MemItem, defaultTeamFor, fmtDate, memPath, RECORD_LABEL, teamQuery, useMem, useMemTeams, useTeamFilter } from './lib';
import { ProfileView, RecentLearned } from './learned';
import { DossierText } from './dossiers';
import { ComputerOnly, useIsPhoneSession } from '../../shell/computerOnly';
import { MoreInfo } from '../../components/MoreInfo';
import { Words } from '../../components/Words';

/**
 * Geheugen is ONE place: the page opens on what TeamBot knows. Two tabs ("Herinneringen" and "Dossiers"); inside
 * Herinneringen one search box and a small switch (over jou, van je bots, gedeeld, pas geleerd). What waits for your
 * judgement shows as one line while something waits. History and storage are rarely needed: they sit behind "Meer
 * opties" and open as a page of their own with a way back. Every older address (#/m/memory/over-jou, …/bots,
 * …/gedeeld, …/beoordelen, …/geschiedenis, …/opslag, …/item/<id>) still opens its own thing.
 */
export const TABS = [
  { id: '', label: 'Herinneringen' },
  { id: 'dossiers', label: 'Dossiers' },
] as const;

/** Whose memories: a small switch inside "Herinneringen" (each keeps its own link). */
const ITEM_VIEWS = [
  { value: 'over-jou', label: 'Over jou' },
  { value: 'bots', label: 'Van je bots' },
  { value: 'gedeeld', label: 'Gedeeld' },
  { value: 'pas-geleerd', label: 'Pas geleerd' },
];
const isItemView = (tab: string) => ITEM_VIEWS.some((v) => v.value === tab);

/** Pages behind "Meer opties" (and the review line): their own title, and a link back to Geheugen. */
const MORE_PAGES: Record<string, string> = { beoordelen: 'Te beoordelen', geschiedenis: 'Geschiedenis', opslag: 'Opslag en instellingen' };

/** Tabs where the team filter applies ("Over jou" is personal; review and storage show every team). */
const TEAM_TABS = new Set(['bots', 'dossiers', 'gedeeld', 'geschiedenis']);

/** Header + tab bar shared by every memory page. Each view is its own route so links and the back button work. */
export function MemoryShell({ tab, children, actions, noTeamFilter }: { tab: string; children: React.ReactNode; actions?: React.ReactNode; noTeamFilter?: boolean }) {
  const ov = useMem<any>('/memory/overview');
  const review = ov.data?.review || 0;
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [team] = useTeamFilter();
  const res = useMem<any>(query ? `/memory/search?q=${encodeURIComponent(query)}${teamQuery(team)}` : null, [query, team]);
  const { run, busy } = useAsync();
  const more = MORE_PAGES[tab];
  const items = isItemView(tab);
  const mainTab = tab === 'dossiers' ? 'dossiers' : '';
  const teamFilter = TEAM_TABS.has(tab) && !noTeamFilter;
  const s = ov.data?.settings;
  return (
    <Page>
      <PageHeader
        width="5xl"
        title={more || 'Geheugen & dossiers'}
        subtitle={more ? undefined : 'Je bots onthouden vanzelf wat belangrijk is. Klopt er iets niet? Zeg het tegen je bot.'}
        back={more ? { href: memPath(''), label: 'Geheugen & dossiers' } : undefined}
        actions={
          <>
            {actions}
            {!more && (
              <Menu
                label="Meer opties"
                variant="secondary"
                items={[
                  { label: 'Zelf iets toevoegen', icon: <Plus />, onSelect: () => setAdding(true) },
                  { label: 'Geschiedenis', icon: <History />, href: memPath('geschiedenis') },
                  { label: 'Opslag en instellingen', icon: <HardDrive />, href: memPath('opslag') },
                ]}
              >
                Meer opties
              </Menu>
            )}
          </>
        }
      />
      {!more && (
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 pt-2 sm:px-6">
          <Tabs value={mainTab} onChange={(v) => navigate(memPath(v))} tabs={TABS.map((x) => ({ id: x.id, label: x.label }))} />
          {teamFilter && <TeamFilter />}
        </div>
      )}
      <div key={tab} className="tb-in mx-auto max-w-5xl space-y-4 px-4 py-4 sm:px-6">
        {more && teamFilter && (
          <div className="flex justify-end">
            <TeamFilter />
          </div>
        )}
        {review > 0 && !more && (
          <a href={memPath('beoordelen')} className="tb-ask flex items-center gap-3 rounded-card border px-4 py-3 text-sm hover:opacity-90" data-testid="memory-review-line">
            <ClipboardCheck className="h-4 w-4 shrink-0 text-warn" aria-hidden />
            <span className="min-w-0 flex-1 font-semibold">{t('{0, plural, one {# herinnering wacht op je oordeel} other {# herinneringen wachten op je oordeel}}', review)}</span>
            <span className="inline-flex shrink-0 items-center gap-1 font-semibold">
              Beoordelen <ChevronRight className="h-4 w-4" aria-hidden />
            </span>
          </a>
        )}
        {items && s && (s.paused || s.learnMode !== 'auto') && (
          <Card className="flex flex-wrap items-center gap-3 border-warn/40 bg-warn-soft p-3 text-sm">
            <Pause className="h-4 w-4 shrink-0 text-warn" aria-hidden />
            <span className="min-w-0 flex-1">{s.paused ? 'Automatisch leren is gepauzeerd.' : s.learnMode === 'off' ? 'Leren staat uit: je bots onthouden niets nieuws.' : 'Je bots onthouden alleen wat je ze vraagt te onthouden.'}</span>
            <Button size="sm" icon={<Play className="h-3.5 w-3.5" />} loading={busy} onClick={() => run(async () => (await api.put('/memory/settings', { paused: false, learnMode: 'auto' }), ov.reload()), 'Automatisch leren staat aan')}>
              Automatisch leren aanzetten
            </Button>
          </Card>
        )}
        {items && (
          <div className="space-y-3">
            <form
              className="flex gap-2"
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                setQuery(q.trim());
              }}
            >
              <label className="sr-only" htmlFor="mem-ask">
                Zoek in wat je bots weten
              </label>
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute start-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
                <Input
                  id="mem-ask"
                  type="search"
                  className="h-11 ps-10 text-[15px]"
                  placeholder="Zoek in wat je bots weten"
                  value={q}
                  onChange={(e) => {
                    setQ(e.target.value);
                    if (!e.target.value.trim()) setQuery('');
                  }}
                />
              </div>
              <Button type="submit" size="lg" disabled={!q.trim()}>
                Zoeken
              </Button>
            </form>
            {query && <div className="tb-in space-y-3">{res.loading && !res.data ? <SkeletonRows n={3} avatar={false} /> : res.error ? <ErrorBox error={res.error} /> : <SearchResults r={res.data} />}</div>}
          </div>
        )}
        {/* While you search, the results take the place of the list (everything is searched, dossiers too). */}
        <div className={items && query ? 'hidden' : undefined}>
          {items && (
            <div className="mb-3">
              <Segmented size="sm" label="Welke herinneringen" value={tab} options={ITEM_VIEWS} onChange={(v) => navigate(memPath(v))} />
            </div>
          )}
          {children}
        </div>
      </div>
      {adding && <ItemEditor onClose={() => setAdding(false)} onSaved={() => setAdding(false)} />}
    </Page>
  );
}

/** With two or more teams: show the memory of one team (or what is "voor alle teams"). One team: nothing. */
function TeamFilter() {
  const teams = useMemTeams();
  const [team, setTeam] = useTeamFilter();
  if (!teams.multi) return null;
  return (
    <Select className="w-auto min-w-[9rem]" value={team} onChange={(e) => setTeam(e.target.value)} aria-label="Team">
      <option value="">Alle teams</option>
      {teams.teams.map((x) => (
        <option key={x.id} value={x.id}>
          {x.name}
        </option>
      ))}
      <option value={ALL_TEAMS}>Voor alle teams</option>
    </Select>
  );
}

/** Geheugen › Herinneringen › Pas geleerd: what the bots learned lately (with undo), and what is still being processed. */
export function RecentPage() {
  return (
    <MemoryShell tab="pas-geleerd">
      <RecentLearned />
    </MemoryShell>
  );
}

/** One group of other things the search found (dossiers, earlier conversations, documents): a quiet list of links. */
function ResultGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-[13px] font-semibold text-muted">{title}</h2>
      <Card className="divide-y divide-line overflow-hidden">{children}</Card>
    </section>
  );
}
const resultRow = 'block px-4 py-3 text-sm hover:bg-surface-2';

function SearchResults({ r }: { r: any }) {
  if (!r) return null;
  const none = !r.items.length && !r.dossiers.length && !r.records.length && !r.episodes.length && !r.documents.length;
  if (none) return <p className="px-1 text-sm text-muted">Daar weet je geheugen niets over.</p>;
  const byMeaning = r.items.some((i: any) => i.meaning) || r.documents.some((x: any) => x.meaning);
  return (
    <div className="space-y-4">
      {byMeaning && <p className="px-1 text-xs text-muted">Ook gevonden op betekenis.</p>}
      {r.items.length > 0 && (
        <div className="space-y-2">
          {r.items.slice(0, 10).map((i: MemItem) => (
            <ItemCard key={i.id} item={i} />
          ))}
        </div>
      )}
      {r.dossiers.length > 0 && (
        <ResultGroup title="Dossiers">
          {r.dossiers.map((d: any) => (
            <a key={d.id} href={memPath(`dossiers/${d.id}`)} className={resultRow}>
              <span className="font-medium" translate="no">{d.title}</span>
              {d.summary && <span className="block text-muted" translate="no">{d.summary}</span>}
            </a>
          ))}
        </ResultGroup>
      )}
      {r.records.length > 0 && (
        <ResultGroup title="Uit dossiers">
          {r.records.map((x: any) => (
            <a key={x.id} href={memPath(`dossiers/${x.dossier_id}`)} className={resultRow}>
              <span className="font-medium" translate="no">{x.title}</span>
              <span className="block text-xs text-muted">
                {RECORD_LABEL[x.kind]} · {x.dossier_title} · {fmtDate(x.at)}
              </span>
            </a>
          ))}
        </ResultGroup>
      )}
      {r.episodes.length > 0 && (
        <ResultGroup title="Eerdere gesprekken">
          {r.episodes.map((e: any) => (
            <a key={e.id} href={`#/t/${e.thread_id}`} className={resultRow}>
              {e.title ? <span className="font-medium" translate="no">{e.title}</span> : <span className="font-medium">Gesprek</span>} <span className="text-xs text-muted">· {fmtDate(e.updated_at)}</span>
              <span className="line-clamp-2 block text-muted" translate="no">{stripRefs(e.summary)}</span>
            </a>
          ))}
        </ResultGroup>
      )}
      {r.documents.length > 0 && (
        <ResultGroup title="Documenten">
          {r.documents.map((x: any) => (
            <a key={x.id} href={memPath(`dossiers/${x.dossier_id}`)} className={resultRow}>
              <span className="font-medium" translate="no">{x.title}</span>
              <span className="line-clamp-2 block text-muted" translate="no">{x.excerpt}</span>
            </a>
          ))}
        </ResultGroup>
      )}
    </div>
  );
}

/**
 * The text behind one place of memory (about you, one bot, a team's shared knowledge): the dossier the bots keep
 * themselves and always read, which the owner can change here. For a bot, what the owner told it himself (its
 * instructions) is shown with it: one view of what this bot was told and what it noted. The notes of the same dossier
 * (what the owner added by hand, an import, a pinned rule) are the list under it.
 */
function PlaceText({ scope, agentId }: { scope: 'about_you' | 'agent' | 'shared'; agentId?: string }) {
  const [team] = useTeamFilter();
  const q = new URLSearchParams({ scope, ...(agentId ? { agentId } : {}), ...(scope === 'shared' && team ? { teamId: team } : {}) });
  const r = useMem<{ dossiers: { id: string; title: string; body: string; body_limit: number }[]; instructions: { text: string; agentId: string } | null }>(`/memory/place?${q}`, [scope, agentId, team]);
  const { run } = useAsync();
  if (r.error) return <ErrorBox error={r.error} retry={r.reload} />;
  if (!r.data) return <SkeletonRows n={2} />;
  return (
    <div className="mb-4 space-y-3">
      {r.data.instructions && (
        <Card className="space-y-2 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">Instructies</h3>
            <a className="ms-auto text-[13px] font-medium text-muted underline-offset-2 hover:text-fg hover:underline" href={`#/agents/${r.data.instructions.agentId}`}>
              Aanpassen
            </a>
          </div>
          <p className="whitespace-pre-wrap text-sm" translate="no">
            {r.data.instructions.text || '—'}
          </p>
        </Card>
      )}
      {r.data.dossiers.map((d) => (
        <DossierText
          key={d.id}
          title={d.title}
          saved={d.body}
          limit={d.body_limit}
          canEdit
          onSave={(body) =>
            void run(async () => {
              await api.patch(`/memory/dossiers/${d.id}`, { body });
              r.reload();
            }, 'Opgeslagen')
          }
        />
      ))}
    </div>
  );
}

/**
 * Geheugen opens here (#/m/memory/ and #/m/memory/over-jou): what the bots know about you — the text of your dossier,
 * and the notes with it, grouped. The same notes as a plain list (with filters, archive and bin) are one small link away.
 */
export function AboutYouPage() {
  const [list, setList] = useState(false);
  return (
    <MemoryShell tab="over-jou">
      <p className="mb-4 text-sm text-muted">
        Wat je bots over jou weten. <MoreInfo>Klik op een regel om hem aan te passen of te laten vergeten. Dit wordt nooit vanzelf met anderen gedeeld.</MoreInfo>
      </p>
      <PlaceText scope="about_you" />
      {list ? (
        <ItemList
          base={{ scope: 'about_you' }}
          addDefaults={{ scope: 'about_you' }}
          empty={
            <EmptyState icon={<User />} title="Nog niets over jou">
              Zeg “onthoud dat ik …” in een gesprek, of voeg zelf iets toe.
            </EmptyState>
          }
        />
      ) : (
        <ProfileView />
      )}
      <p className="mt-4 text-center">
        <button type="button" className="text-[13px] font-medium text-muted underline-offset-2 hover:text-fg hover:underline" aria-pressed={list} onClick={() => setList(!list)}>
          {list ? 'Terug naar het overzicht per onderwerp' : 'Filteren, of archief en prullenbak bekijken'}
        </button>
      </p>
    </MemoryShell>
  );
}

export function BotsPage({ params }: { params: string[] }) {
  const agentId = params[0];
  const agents = useMem<any[]>('/memory/agents');
  const storeAgents = useApp((s) => s.agents);
  const [team] = useTeamFilter();
  const shown = (agents.data || []).filter((a) => !team || team === ALL_TEAMS || a.team?.id === team);
  if (agentId) {
    const a = agents.data?.find((x) => x.id === agentId) || storeAgents.find((x) => x.id === agentId);
    return (
      <MemoryShell tab="bots" noTeamFilter>
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button size="sm" variant="ghost" onClick={() => navigate(memPath('bots'))}>
            ← Alle bots
          </Button>
          {a && <BotAvatar bot={a} size={24} />}
          <h2 className="text-base font-semibold" translate="no">
            {a?.name || 'Bot'}
          </h2>
          <MoreInfo>Privé notities van deze bot. Andere bots zien ze niet, tenzij je een notitie deelt.</MoreInfo>
          <a className="ms-auto text-[13px] font-medium text-muted underline-offset-2 hover:text-fg hover:underline" href={`#/agents/${agentId}`}>
            Instellingen van deze bot
          </a>
        </div>
        <PlaceText scope="agent" agentId={agentId} />
        <ItemList base={{ scope: 'agent', agentId }} hideScope addDefaults={{ scope: 'agent', agentId }} empty={<EmptyState icon={<Bot />} title="Deze bot heeft nog geen notities" />} />
      </MemoryShell>
    );
  }
  return (
    <MemoryShell tab="bots">
      {agents.error ? (
        <ErrorBox error={agents.error} retry={agents.reload} />
      ) : !agents.data ? (
        <SkeletonRows n={4} />
      ) : agents.data.length === 0 ? (
        <Card>
          <EmptyState icon={<Bot />} title="Nog geen bots" action={<Button onClick={() => navigate('/agents/new')}>Bot maken</Button>} />
        </Card>
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState icon={<Bot />} title="Geen bots in dit team" />
        </Card>
      ) : (
        <Card className="divide-y divide-line overflow-hidden">
          {shown.map((a) => (
            <a key={a.id} href={memPath(`bots/${a.id}`)} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2">
              <BotAvatar bot={a} size={32} />
              <span className="min-w-0 flex-1">
                <span className="block font-semibold [overflow-wrap:anywhere]" translate="no">
                  {a.name}
                </span>
                <span className="block text-[13px] text-muted">
                  {t('{0, plural, one {# notitie} other {# notities}}', a.items)}
                  {a.team ? ` · ${a.team.name}` : ''}
                </span>
              </span>
              {!a.enabled ? <Badge tone="warn">Geheugen uit</Badge> : a.learn !== 'auto' && <Badge>{a.learn === 'explicit' ? 'Alleen op verzoek' : 'Leert niet'}</Badge>}
              <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
            </a>
          ))}
        </Card>
      )}
    </MemoryShell>
  );
}

export function SharedPage() {
  const [team] = useTeamFilter();
  const teams = useMemTeams();
  const ds = useMem<any[]>(`/memory/dossiers${team ? `?teamId=${encodeURIComponent(team)}` : ''}`, [team]);
  const sharedWithMe = (ds.data || []).filter((d) => d.role !== 'owner');
  const mineShared = (ds.data || []).filter((d) => d.role === 'owner' && d.agent_ids === null);
  return (
    <MemoryShell tab="gedeeld">
      <div className="space-y-6">
        <section>
          <p className="mb-4 text-sm text-muted">
            {teams.multi ? 'Wat de bots van een team samen weten.' : 'Wat al je bots samen weten.'}{' '}
            <MoreInfo>
              {teams.multi
                ? 'Gedeelde kennis hoort bij één team: de bots van dat team lezen het, en bots die mogen meekijken ook. Kies “Voor alle teams” als elk team het moet weten. Bots kunnen iets voorstellen; jij keurt goed.'
                : 'Alleen wat jij deelt. Bots kunnen iets voorstellen; jij keurt goed.'}
            </MoreInfo>
          </p>
          <PlaceText scope="shared" />
          <ItemList
            base={{ scope: 'shared' }}
            hideScope
            addDefaults={{ scope: 'shared', ...(teams.multi ? { teamId: defaultTeamFor(team, teams) } : {}) }}
            empty={
              <EmptyState icon={<Share2 />} title="Nog niets gedeeld">
                Deel een notitie van een bot via het menu bij die notitie.
              </EmptyState>
            }
          />
        </section>
        {ds.error && <ErrorBox error={ds.error} retry={ds.reload} />}
        {sharedWithMe.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold">Dossiers die met jou gedeeld zijn</h2>
            <Card className="divide-y divide-line overflow-hidden">
              {sharedWithMe.map((d) => (
                <a key={d.id} href={memPath(`dossiers/${d.id}`)} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm hover:bg-surface-2">
                  <FolderOpen className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                  <span className="min-w-0 flex-1 font-medium [overflow-wrap:anywhere]" translate="no">{d.title}</span>
                  <span className="text-xs text-muted">
                    <Words text="van {0}" values={[d.owner_name || '']} />
                  </span>
                  <Badge>{d.role === 'edit' ? 'Bewerken' : 'Lezen'}</Badge>
                </a>
              ))}
            </Card>
          </section>
        )}
        {mineShared.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold">{teams.multi ? 'Dossiers die alle bots van hun team mogen lezen' : 'Dossiers die al je bots mogen lezen'}</h2>
            <div className="flex flex-wrap gap-2">
              {mineShared.map((d) => (
                <a key={d.id} href={memPath(`dossiers/${d.id}`)} className="rounded-full border border-line bg-surface px-3 py-1.5 text-sm hover:bg-surface-2" translate="no">
                  {d.title}
                </a>
              ))}
            </div>
          </section>
        )}
      </div>
    </MemoryShell>
  );
}

export function ItemPage({ params }: { params: string[] }) {
  return (
    <MemoryShell tab="item">
      <div className="mb-3">
        <Button size="sm" variant="ghost" onClick={() => history.back()}>
          ← Terug
        </Button>
      </div>
      {params[0] ? <ItemDetail id={params[0]} /> : <EmptyState title="Geen herinnering gekozen" />}
    </MemoryShell>
  );
}

export function ExportButtons() {
  // A full export stays on the computer (server/modules/mobile/policy.ts).
  if (useIsPhoneSession()) return <ComputerOnly>Al je gegevens exporteren kan alleen op je computer.</ComputerOnly>;
  const link = 'inline-flex h-9 items-center gap-2 rounded-control border border-line bg-surface px-4 text-sm font-semibold hover:bg-surface-2 coarse:h-11';
  return (
    <div className="flex flex-wrap gap-2">
      <a className={link} href={authUrl('/memory/export?format=json')} download>
        <Download className="h-4 w-4" aria-hidden /> Export (JSON)
      </a>
      <a className={link} href={authUrl('/memory/export?format=md')} download>
        <Download className="h-4 w-4" aria-hidden /> Export (Markdown)
      </a>
    </div>
  );
}
