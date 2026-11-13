import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronRight, CircleDot, Clock, Crown, Hourglass, Plus, Settings2, Users } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Page, PageHeader, Select, Spinner, cx, timeAgo, toast, toastError, CardHead } from '../../components/ui';
import { MoreInfo } from '../../components/MoreInfo';
import { SkeletonCards } from '../../components/overview';
import { BotAvatar } from '../../components/BotFace';
import { on } from '../../lib/api';
import { formatCompact, formatNumber, formatUsd } from '../../lib/format';
import { t } from '../../lib/i18n';
import { useApp } from '../../lib/store';
import { useShallow } from 'zustand/react/shallow';
import { type Overview, type OverviewItem, type Spend, teamsApi } from './api';

/**
 * #/m/teams/alle — "Alle teams": the main bot on top, then the leaders, then per team the lead (when there is one), its
 * bots, open tasks, what waits for you, recent results, errors and missed routine runs (last 7 days) and usage this
 * week. Read-only; every line links to where you act on it. With one team it is simply that team under the main bot.
 */
export function AllTeamsPage() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [err, setErr] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = () =>
    teamsApi
      .overview()
      .then((o) => (setOv(o), setErr('')))
      .catch((e) => setErr(e?.message || String(e)));
  useEffect(() => {
    load();
    // Live, but calm: many events in a row (a chain of bots at work) give one reload.
    const soon = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(load, 600);
    };
    const offs = ['teams.changed', 'rooms.task', 'rooms.delegation', 'approval.created', 'approval.updated', 'agent.updated', 'agent.deleted', 'routine.run'].map((e) => on(e, soon));
    return () => {
      offs.forEach((f) => f());
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  return (
    <Page>
      <PageHeader title="Alle teams" subtitle={t('{0, plural, one {Wat er de afgelopen # dag in je teams gebeurde.} other {Wat er de afgelopen # dagen in je teams gebeurde.}}', ov?.days ?? 7)} back={{ href: '#/m/teams/', label: 'Teams' }} />
      <div className="mx-auto max-w-4xl space-y-4 px-4 pb-8 pt-3 sm:px-6">
        {err && !ov ? (
          <Card className="flex flex-wrap items-center gap-3 p-4">
            <p className="min-w-0 flex-1 text-sm text-danger">{err}</p>
            <Button size="sm" onClick={load}>
              Opnieuw
            </Button>
          </Card>
        ) : !ov ? (
          <SkeletonCards n={3} className="!grid-cols-1" />
        ) : (
          <>
            <MainCard ov={ov} reload={load} />
            {ov.leaders.length > 0 && <LeadersCard ov={ov} />}
            {ov.teams.length ? (
              ov.teams.map((team) => <TeamCard key={team.id} team={team} multi={ov.teams.length > 1} />)
            ) : (
              <EmptyState
                icon={<Users />}
                title="Nog geen teams"
                action={
                  <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => (location.hash = '#/agents/new')}>
                    Nieuwe bot
                  </Button>
                }
              >
                Je eerste team ontstaat vanzelf als je je eerste bot maakt.
              </EmptyState>
            )}
            {ov.usage?.source === 'bots' && <p className="text-xs text-muted">Verbruik per team is opgeteld per bot, bij het team waar de bot nu in zit.</p>}
          </>
        )}
      </div>
    </Page>
  );
}

type TeamView = Overview['teams'][number];

function Dot({ color }: { color: string }) {
  return <span aria-hidden className="inline-block h-3 w-3 shrink-0 rounded-full" style={{ background: color }} />;
}

function usageLine(u: { week: Spend } | null | undefined): string | null {
  if (!u || !u.week.calls) return null;
  return u.week.cost > 0 ? t('Verbruik deze week: {0} tokens, {1} aan kosten.', formatCompact(u.week.tokens), formatUsd(u.week.cost)) : t('Verbruik deze week: {0} tokens.', formatCompact(u.week.tokens));
}

/** The main bot: who it is and a way to talk to it, or (without one) how to make one. */
function MainCard({ ov, reload }: { ov: Overview; reload(): void }) {
  const agents = useApp(useShallow((s) => s.agents.filter((a) => !a.archived)));
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const main = ov.main;
  if (!main) {
    const make = async () => {
      setBusy(true);
      try {
        const r = await teamsApi.setMain(pick);
        toast(t('{0} is nu je hoofdbot', r.main?.name || ''), 'ok');
        for (const n of r.notes) toast(n);
        setPick('');
        reload();
      } catch (e) {
        toastError(e);
      } finally {
        setBusy(false);
      }
    };
    return (
      <Card className="space-y-3 p-5">
        <CardHead icon={Crown} tone="teal" title="Hoofdbot" />
        <p className="text-sm text-muted">
          Eén bot waar je mee praat; hij geeft het werk door. <MoreInfo>Hij geeft het werk aan de juiste bot of het juiste team. Een hoofdbot hoeft niet.</MoreInfo>
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => (location.hash = '#/agents/new')}>
            Nieuwe hoofdbot maken
          </Button>
          {agents.length > 0 && (
            <>
              <span className="text-sm text-muted sm:px-1">of</span>
              <Select className="sm:w-56" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Bestaande bot als hoofdbot kiezen">
                <option value="">Bestaande bot kiezen…</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
              <Button disabled={!pick} loading={busy} onClick={make}>
                Hoofdbot maken
              </Button>
            </>
          )}
        </div>
      </Card>
    );
  }
  const usage = usageLine(main.usage);
  return (
    <Card className="space-y-3 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <BotAvatar bot={main} size={44} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[15px] font-bold">{main.name}</span>
            <Badge tone="accent">
              <Crown className="h-3 w-3" aria-hidden /> Hoofdbot
            </Badge>
            {main.archived && <Badge tone="warn">In het archief</Badge>}
          </div>
          <p className="text-xs text-muted">
            {main.notDirected.length ? t('Geeft alle teams werk, behalve: {0}.', main.notDirected.map((x) => x.name).join(', ')) : ov.teams.length > 1 ? 'Geeft alle teams werk.' : 'Geeft de bots van je team werk.'}
            {usage ? ` ${usage}` : ''}
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={() => (location.hash = `#/a/${main.id}`)}>
          {t('Praat met {0}', main.name)}
        </Button>
      </div>
      <ItemList title="Wacht op jou" icon={<Hourglass className="h-4 w-4 text-warn" aria-hidden />} items={main.waiting.items} total={main.waiting.count} />
      <ItemList title="Fouten" icon={<AlertTriangle className="h-4 w-4 text-danger" aria-hidden />} items={main.errors.items} total={main.errors.count} />
    </Card>
  );
}

function LeadersCard({ ov }: { ov: Overview }) {
  const names = new Map(ov.teams.map((x) => [x.id, x.name]));
  return (
    <Card className="space-y-2 p-5">
      <CardHead icon={Users} tone="teal" title="Leiders" hint="Bots die meer dan één team werk geven, onder de hoofdbot." />
      <ul className="space-y-1.5">
        {ov.leaders.map((l) => (
          <li key={l.id} className="flex flex-wrap items-center gap-2 text-sm">
            <BotAvatar bot={l} size={24} />
            <a className="font-medium hover:underline" href={`#/a/${l.id}`}>
              {l.name}
            </a>
            <span className="text-muted">{l.teams.map((id) => names.get(id) || '').filter(Boolean).join(', ')}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Stat({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: number; tone?: 'warn' | 'danger' }) {
  return (
    <div className={cx('rounded-xl border border-line p-3', value > 0 && tone === 'warn' && 'bg-warn-soft', value > 0 && tone === 'danger' && 'bg-danger-soft')}>
      <div className="flex items-center gap-1.5 text-xs text-muted">
        {icon}
        {label}
      </div>
      <div className="mt-0.5 text-xl font-bold tabular-nums">{formatNumber(value)}</div>
    </div>
  );
}

function ItemList({ title, icon, items, total }: { title: string; icon: React.ReactNode; items: OverviewItem[]; total?: number }) {
  if (!items.length) return null;
  const more = (total ?? items.length) - items.length;
  return (
    <section>
      <h3 className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold">
        {icon}
        {title}
      </h3>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {items.map((it) => (
          <li key={`${it.kind}:${it.id}`}>
            <a href={it.link} className="flex items-start gap-2 px-3 py-2 hover:bg-surface-2">
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2 text-sm [overflow-wrap:anywhere]">{it.title}</span>
                {(it.who || it.detail) && <span className="line-clamp-2 text-xs text-muted [overflow-wrap:anywhere]">{[it.who, it.detail].filter(Boolean).join(' · ')}</span>}
              </span>
              <span className="shrink-0 text-xs text-muted">{timeAgo(it.at)}</span>
              <ChevronRight className="rtl-flip mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
            </a>
          </li>
        ))}
      </ul>
      {more > 0 && <p className="mt-1 text-xs text-muted">{t('{0, plural, one {en nog # andere} other {en nog # andere}}', more)}</p>}
    </section>
  );
}

function TeamCard({ team, multi }: { team: TeamView; multi: boolean }) {
  const usage = usageLine(team.usage);
  const others = team.directedBy;
  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Dot color={team.color} />
        <h2 className="min-w-0 flex-1 text-[15px] font-bold [overflow-wrap:anywhere]">{team.name}</h2>
        <a href={`#/m/teams/${team.id}`} className="inline-flex items-center gap-1 text-xs font-semibold text-muted hover:text-fg">
          <Settings2 className="h-3.5 w-3.5" aria-hidden /> Instellingen
        </a>
      </div>

      {team.bots.length ? (
        <ul className="flex flex-wrap gap-2">
          {team.bots.map((b) => (
            <li key={b.id}>
              <a href={`#/a/${b.id}`} className="flex min-h-8 items-center gap-2 rounded-full border border-line py-1 pe-3 ps-1 hover:bg-surface-2 coarse:min-h-11">
                <BotAvatar bot={b} size={24} />
                <span className="text-sm font-medium">{b.name}</span>
                {b.role && (
                  <span className="hidden text-xs text-muted sm:inline" translate="no">
                    {b.role}
                  </span>
                )}
                {b.lead && <Badge tone="accent">teamleider</Badge>}
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">Dit team heeft nog geen bots.</p>
      )}
      {multi && others.length > 0 && <p className="text-xs text-muted">{t('Krijgt werk van: {0}.', others.map((x) => x.name).join(', '))}</p>}

      {/* Only what there is: a row of four zeros says nothing (the lists below name the same things). */}
      {team.open.count + team.waiting.count + team.errors.count + team.missed.count > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {team.open.count > 0 && <Stat icon={<CircleDot className="h-3.5 w-3.5" aria-hidden />} label="Open taken" value={team.open.count} />}
          {team.waiting.count > 0 && <Stat icon={<Hourglass className="h-3.5 w-3.5" aria-hidden />} label="Wacht op jou" value={team.waiting.count} tone="warn" />}
          {team.errors.count > 0 && <Stat icon={<AlertTriangle className="h-3.5 w-3.5" aria-hidden />} label="Fouten" value={team.errors.count} tone="danger" />}
          {team.missed.count > 0 && <Stat icon={<Clock className="h-3.5 w-3.5" aria-hidden />} label="Gemiste runs" value={team.missed.count} tone="warn" />}
        </div>
      )}

      <ItemList title="Wacht op jou" icon={<Hourglass className="h-4 w-4 text-warn" aria-hidden />} items={team.waiting.items} total={team.waiting.count} />
      <ItemList title="Recente resultaten" icon={<CheckCircle2 className="h-4 w-4 text-ok" aria-hidden />} items={team.results} />
      <ItemList title="Fouten" icon={<AlertTriangle className="h-4 w-4 text-danger" aria-hidden />} items={team.errors.items} total={team.errors.count} />
      <ItemList title="Gemiste runs" icon={<Clock className="h-4 w-4 text-warn" aria-hidden />} items={team.missed.items} total={team.missed.count} />
      <ItemList title="Open taken" icon={<CircleDot className="h-4 w-4 text-muted" aria-hidden />} items={team.open.items} total={team.open.count} />
      {!team.waiting.count && !team.results.length && !team.errors.count && !team.missed.count && !team.open.count && <p className="text-sm text-muted">Geen open taken en niets dat op jou wacht.</p>}
      {usage && <MoreInfo label="Gebruik">{usage}</MoreInfo>}
    </Card>
  );
}
