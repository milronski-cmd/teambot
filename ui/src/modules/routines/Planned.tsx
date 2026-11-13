import { useEffect, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { api, on } from '../../lib/api';
import { useApp } from '../../lib/store';
import { t } from '../../lib/i18n';
import { formatDateTime } from '../../lib/format';
import type { Agent } from '../../lib/types';
import { Badge, Button, Card, CardHead, Spinner, toast, toastError } from '../../components/ui';
import { BotAvatar } from '../../components/BotFace';
import { Words } from '../../components/Words';
import { spApi, type SpecialistListItem } from '../specialists/api';
import type { RoutineView } from './lib';

/**
 * "Wat start vanzelf": the ONE list of everything that will begin by itself (GET /api/routines/planned: routines,
 * reminders, wait points, fixed tasks, new attempts, workflow schedules, work that lies ready, the main bot's check-in
 * and overview, a specialist's learning round, a conversation the memory still reads, the automatic backup, a second
 * look that waits for a usage limit, the one download of the search model). Every row is the same: what it is, which
 * bot, when next, whether it uses AI, and ONE action that keeps it from starting (pause, switch off, "nu niet"), or the
 * page where you change it. Under it, in the same row shape, what can start by itself but is off, each with the one
 * action that switches it on: the check-in and the overview of the main bot, the learning round of every specialist,
 * work you parked, and every paused routine (with who paused it).
 * Shown on Taken › Automatisch › Werk and under Instellingen › Meer mogelijkheden.
 */

type Kind = 'routine' | 'reminder' | 'waitpoint' | 'duty' | 'retry' | 'workflow' | 'work' | 'checkin' | 'briefing' | 'learning' | 'backup' | 'recheck' | 'download';
interface Planned {
  kind: Kind;
  id: string;
  agentId: string | null;
  title: string;
  /** TeamBot's words with someone's own words in them (a chat title, a routine's name): shown with Words. */
  words?: { text: string; values?: (string | number)[] };
  at: string | null;
  model: boolean;
  link?: string;
}
/** The work loop per bot (GET /api/proactive/work): here only what the owner parked. */
interface WorkView {
  agentId: string;
  agentName: string;
  items: { ref: string }[];
  parked?: boolean;
}

const KIND: Record<Kind, string> = {
  routine: 'Routine',
  reminder: 'Herinnering',
  waitpoint: 'Wachtpunt',
  duty: 'Vaste taak',
  retry: 'Nieuwe poging',
  workflow: 'Workflow',
  work: 'Werk dat klaarligt',
  checkin: 'Check-in',
  briefing: 'Overzicht',
  learning: 'Leerronde',
  backup: 'Back-up',
  recheck: 'Tweede controle',
  download: 'Download',
};
/** Kinds that are a routine underneath: paused with the routine's own route, changed on its own page. */
const AS_ROUTINE = new Set<Kind>(['routine', 'reminder', 'waitpoint', 'duty']);
/**
 * Two things start as "learning": a specialist's learning round (`learn:<bot>`, switched off with the specialist's own
 * route) and a conversation the memory still has to read (`review:<thread>`, shown where the memory lists it). Only the
 * first is a learning round: switching that off for the bot of a conversation would make it a specialist.
 */
const isRound = (p: Planned) => p.kind === 'learning' && p.id.startsWith('learn:');
const kindLabel = (p: Planned) => (p.kind === 'learning' && !isRound(p) ? 'Geheugen' : KIND[p.kind] || p.kind);

/** Kinds whose title is a name as a whole (a routine's, a workflow's): the owner's or a bot's words, never translated. */
const NAMED = new Set<Kind>(['routine', 'reminder', 'waitpoint', 'duty', 'workflow']);
/** The title of a row: TeamBot's words in the reader's language, a name or a chat title exactly as written. */
const titleOf = (p: Planned): React.ReactNode => (p.words ? <Words text={p.words.text} values={p.words.values} /> : NAMED.has(p.kind) ? <span translate="no">{p.title}</span> : p.title);

const linkClass = 'inline-flex h-8 shrink-0 items-center rounded-control border border-line bg-surface-2 px-3 text-[13px] font-semibold transition-colors hover:border-line-strong coarse:h-11';

/** One row, the same for what starts and for what is off: who, what it is, one line, whether it uses AI, one action. */
function Row({ bot, title, href, line, model, action, ...rest }: { bot?: Pick<Agent, 'id' | 'name' | 'avatar'>; title: React.ReactNode; href?: string; line: React.ReactNode; model: boolean; action: React.ReactNode; 'data-planned'?: string; 'data-off'?: string }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5" {...rest}>
      {bot ? <BotAvatar bot={bot} size={28} /> : <span className="h-7 w-7 shrink-0" aria-hidden />}
      <span className="min-w-0 flex-1 basis-56">
        <span className="block text-sm font-medium [overflow-wrap:anywhere]">
          {href ? (
            <a href={href} className="hover:underline">
              {title}
            </a>
          ) : (
            title
          )}
        </span>
        <span className="block text-xs text-muted">{line}</span>
      </span>
      <Badge>{model ? 'gebruikt AI' : 'kost niets'}</Badge>
      {action}
    </li>
  );
}

export function PlannedList() {
  const agents = useApp((s) => s.agents);
  const [list, setList] = useState<Planned[] | null>(null);
  const [err, setErr] = useState('');
  const [checkin, setCheckin] = useState<boolean | null>(null);
  const [briefing, setBriefing] = useState<string | null>(null);
  const [specialists, setSpecialists] = useState<SpecialistListItem[] | null>(null);
  const [work, setWork] = useState<WorkView[]>([]);
  const [pausedRoutines, setPausedRoutines] = useState<RoutineView[]>([]);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState('');
  const load = () => {
    api
      .get<{ planned: Planned[] }>('/routines/planned')
      .then((r) => (setList(r.planned || []), setErr('')))
      .catch((e) => setErr(e?.message || String(e)));
    api.get<{ enabled: boolean }>('/proactive/checkin').then((r) => setCheckin(!!r.enabled), () => setCheckin(null));
    api.get<{ settings: { briefing: string } }>('/proactive/settings').then((r) => setBriefing(r.settings?.briefing || 'uit'), () => setBriefing(null));
    api.get<{ paused: boolean }>('/routines/settings').then((r) => setPaused(!!r.paused), () => setPaused(false));
    spApi.list().then((r) => setSpecialists(Array.isArray(r) ? r : []), () => setSpecialists(null));
    api.get<{ work: WorkView[] }>('/proactive/work').then((r) => setWork(r.work || []), () => setWork([]));
    api.get<RoutineView[]>('/routines').then((r) => setPausedRoutines((Array.isArray(r) ? r : []).filter((x) => x.status === 'paused')), () => setPausedRoutines([]));
  };
  useEffect(() => {
    load();
    const offs = ['routine.updated', 'routine.deleted', 'routine.settings', 'routine.run', 'proactive.settings', 'proactive.work', 'rooms.task'].map((e) => on(e, load));
    return () => offs.forEach((off) => off());
  }, []);
  const act = async (key: string, what: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      await what();
      toast(done, 'ok');
      load();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy('');
    }
  };
  const button = (key: string, label: string, what: () => Promise<unknown>, done: string) => (
    <Button size="sm" loading={busy === key} onClick={() => act(key, what, done)}>
      {label}
    </Button>
  );
  const botOf = (id: string | null | undefined) => (id ? agents.find((a) => a.id === id) : undefined);

  /** The one action of a row: keep it from starting where the server has a route for that, else the page where you change it. */
  const action = (p: Planned) => {
    const key = `${p.kind}:${p.id}`;
    if (AS_ROUTINE.has(p.kind)) return button(key, 'Pauzeren', () => api.post(`/routines/${p.id}/pause`, {}), 'Gepauzeerd');
    if (p.kind === 'checkin') return button(key, 'Uitzetten', () => api.put('/proactive/checkin', { enabled: false }), 'De check-in staat uit');
    if (p.kind === 'briefing') return button(key, 'Uitzetten', () => api.put('/proactive/settings', { briefing: 'uit' }), 'Het overzicht staat uit');
    if (isRound(p) && p.agentId) return button(key, 'Uitzetten', () => spApi.save(p.agentId!, { learnOn: false }), 'De leerronde staat uit');
    if (p.kind === 'work' && p.agentId) return button(key, 'Nu niet', () => api.post(`/proactive/work/${p.agentId}/park`, { parked: true }), 'Geparkeerd tot er iets verandert');
    return p.link ? (
      <a href={p.link} className={linkClass}>
        {p.kind === 'retry' || p.kind === 'learning' || p.kind === 'recheck' || p.kind === 'download' ? 'Bekijken' : 'Aanpassen'}
      </a>
    ) : null;
  };

  // What can start by itself but is off: the same row, with the one action that switches it on.
  const off: { key: string; bot?: Pick<Agent, 'id' | 'name' | 'avatar'>; title: React.ReactNode; href?: string; line: string; model: boolean; node: React.ReactNode }[] = [];
  if (checkin === false)
    off.push({
      key: 'checkin',
      title: 'Check-in van de hoofdbot',
      line: 'Je hoofdbot kijkt elke dag zelf wat er ligt en wat aandacht nodig heeft.',
      model: true,
      node: button('on:checkin', 'Aanzetten', () => api.put('/proactive/checkin', { enabled: true }), 'De check-in staat aan'),
    });
  if (briefing === 'uit')
    off.push({
      key: 'briefing',
      title: 'Overzicht van de hoofdbot',
      line: 'Elke dag een kort overzicht van wat je team deed en wat op je wacht.',
      model: false,
      node: button('on:briefing', 'Aanzetten', () => api.put('/proactive/settings', { briefing: 'dag' }), 'Het overzicht staat aan'),
    });
  // A specialist (a bot with a field) whose learning round is off: switched on right here.
  const learners = (specialists || []).filter((s) => s.enabled && s.field && !s.learnOn);
  for (const s of learners)
    off.push({
      key: `learning:${s.agentId}`,
      bot: botOf(s.agentId) || { id: s.agentId, name: s.agentName, avatar: s.avatar },
      title: t('Leerronde van {0}', s.agentName),
      href: `#/m/specialists/${s.agentId}`,
      line: s.cadence === 'weekly' ? 'Leert elke week zelf bij uit zijn bronnen.' : s.cadence === 'hourly' ? 'Leert elk uur zelf bij uit zijn bronnen.' : 'Leert elke dag zelf bij uit zijn bronnen.',
      model: true,
      node: button(`on:learning:${s.agentId}`, 'Aanzetten', () => spApi.save(s.agentId, { learnOn: true }), 'De leerronde staat aan'),
    });
  // No specialist yet: the learning round exists, and this is where you make one.
  if (specialists && !specialists.some((s) => s.enabled && s.field))
    off.push({
      key: 'learning',
      title: 'Leerronde van een specialist',
      line: 'Een bot met een vakgebied leert zelf bij uit zijn bronnen.',
      model: true,
      node: (
        <a href="#/m/specialists/" className={linkClass}>
          Instellen
        </a>
      ),
    });
  // Work you parked ("nu niet"): it waits for a change, or for you.
  for (const w of work.filter((x) => x.parked && x.items.length > 0))
    off.push({
      key: `work:${w.agentId}`,
      bot: botOf(w.agentId),
      title: w.items.length === 1 ? t('Werk dat klaarligt voor {0}: 1 punt', w.agentName) : t('Werk dat klaarligt voor {0}: {1} punten', w.agentName, w.items.length),
      href: `#/a/${w.agentId}`,
      line: 'Geparkeerd: begint weer zodra er iets verandert.',
      model: true,
      node: button(`on:work:${w.agentId}`, 'Weer oppakken', () => api.post(`/proactive/work/${w.agentId}/park`, { parked: false }), 'Het werk wordt weer opgepakt'),
    });
  // A paused routine (also a reminder, wait point or vaste taak): who or what paused it, and Aanzetten.
  for (const r of pausedRoutines) {
    const o = r.options;
    const kind: Kind = o?.reminder ? 'reminder' : o?.waitpoint ? 'waitpoint' : o?.duty ? 'duty' : 'routine';
    off.push({
      key: `routine:${r.id}`,
      bot: botOf(r.agent_id) || { id: r.agent_id, name: r.agentName || '', avatar: r.agentAvatar || '' },
      title: <span translate="no">{r.name}</span>,
      href: `#/m/routines/r/${r.id}`,
      line: [KIND[kind], r.paused_reason || 'Gepauzeerd', r.scheduleText].filter(Boolean).join(' · '),
      model: kind !== 'reminder',
      node: button(`on:routine:${r.id}`, 'Aanzetten', () => api.post(`/routines/${r.id}/resume`, {}), 'Staat weer aan'),
    });
  }

  return (
    <Card className="space-y-3 p-5" data-testid="planned-list">
      <CardHead icon={CalendarClock} tone="teal" title="Wat start vanzelf" hint="Alles wat uit zichzelf begint, met wanneer. Verder start er niets." />
      {paused && (
        <div className="flex flex-wrap items-center gap-2 rounded-control bg-warn-soft px-3 py-2 text-sm text-warn" role="status">
          <span className="min-w-0 flex-1 basis-48">Alle routines staan op pauze: er start er nu geen.</span>
          {button('resume', 'Weer aanzetten', () => api.put('/routines/settings', { paused: false }), 'Routines staan weer aan')}
        </div>
      )}
      {err && <p className="text-sm text-danger">{err}</p>}
      {!list && !err && <Spinner />}
      {list && list.length === 0 && <p className="text-sm text-muted">Er start nu niets vanzelf.</p>}
      {list && list.length > 0 && (
        <ul className="divide-y divide-line">
          {list.map((p) => {
            const bot = botOf(p.agentId);
            return (
              <Row
                key={`${p.kind}:${p.id}`}
                data-planned={p.kind}
                bot={bot}
                title={titleOf(p)}
                href={AS_ROUTINE.has(p.kind) ? `#/m/routines/r/${p.id}` : p.link}
                line={
                  <>
                    {kindLabel(p)}
                    {bot ? ` · ${bot.name}` : ''} · {p.at ? formatDateTime(p.at) : 'zodra het kan'}
                  </>
                }
                model={p.model}
                action={action(p)}
              />
            );
          })}
        </ul>
      )}
      {off.length > 0 && (
        <div className="space-y-1 border-t border-line pt-3" data-testid="planned-off">
          <h3 className="text-[13px] font-semibold text-muted">{t('Staat uit')}</h3>
          <ul className="divide-y divide-line">
            {off.map((o) => (
              <Row key={o.key} data-off={o.key} bot={o.bot} title={o.title} href={o.href} line={o.line} model={o.model} action={o.node} />
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
