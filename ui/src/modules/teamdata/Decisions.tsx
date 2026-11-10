import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronRight, ListChecks, PenLine, Scale } from 'lucide-react';
import { useApp } from '../../lib/store';
import { BotAvatar } from '../../components/BotFace';
import { Badge, Button, EmptyState, Input, Spinner, Textarea, cx, toast, toastError } from '../../components/ui';
import { type Decision, type DecideResult, teamApi, usePickedSummary, useTeamChanged, useTeamPick, useTeamSummary } from './api';
import { BotName, Chips, Fold, Linkified, SearchBox, StatusBadge, When, nameKey } from './parts';

function wokeText(r: DecideResult) {
  if (r.woke) return r.woke.mode === 'queued' ? `Opgeslagen. ${r.woke.name} krijgt je keuze zodra hij klaar is met zijn huidige werk.` : `Opgeslagen. ${r.woke.name} gaat verder met je keuze.`;
  return r.notice || 'Opgeslagen.';
}

/**
 * One open decision: the question, the bot's explanation, and its options as buttons. Picking an option selects it;
 * "Kies" confirms (one tap less safe on a phone for things like refunds or contracts). An own answer and "vervalt"
 * are always possible. The asking bot gets the answer as a message in its chat.
 */
export function DecisionCard({ d, onDone, showTeam = false }: { d: Decision; onDone(r: DecideResult): void; showTeam?: boolean }) {
  const agents = useApp((s) => s.agents);
  const bot = (d.asker && agents.find((a) => a.id === d.asker!.id)) || agents.find((a) => nameKey(a.name) === nameKey(d.gevraagd_door)) || null;
  const who = bot?.name || d.gevraagd_door.trim() || 'Een bot';
  const [sel, setSel] = useState<number | null>(null);
  const [own, setOwn] = useState(d.options.length === 0);
  const [answer, setAnswer] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'choose' | 'expire' | null>(null);
  const titleId = `dec-${d.id}-q`;

  const send = async (body: Parameters<typeof teamApi.decide>[1], kind: 'choose' | 'expire') => {
    setBusy(kind);
    try {
      const r = await teamApi.decide(d.id, body, d.teamId);
      toast(wokeText(r), r.woke ? 'ok' : 'neutral');
      onDone(r);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };
  const ready = own ? !!answer.trim() : sel !== null;
  const submit = () => {
    if (!ready) return;
    void send(own ? { answer: answer.trim(), note: note.trim() } : { choice: sel!, note: note.trim() }, 'choose');
  };

  return (
    <article aria-labelledby={titleId} className="tb-ask w-full rounded-2xl border p-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <BotAvatar bot={bot || { name: who }} size={22} mood="waiting" />
        <span>
          <span className="font-semibold text-fg" translate="no">
            {who}
          </span>{' '}
          vraagt je te beslissen
        </span>
        <span aria-hidden>·</span>
        <When value={d.aangemaakt} />
        {d.vervangt_id && <Badge>vervangt #{d.vervangt_id}</Badge>}
        {showTeam && d.teamName && <Badge tone="accent">{d.teamName}</Badge>}
        {bot && (
          <>
            <span aria-hidden>·</span>
            <a className="font-semibold underline underline-offset-2 hover:text-fg" href={`#/a/${bot.id}`}>
              naar {bot.name}
            </a>
          </>
        )}
      </div>
      <h3 id={titleId} className="mt-2 whitespace-pre-wrap text-[15px] font-bold leading-snug [overflow-wrap:anywhere]" translate="no">
        {d.vraag}
      </h3>
      {d.uitleg && <Fold text={d.uitleg} lines={4} className="mt-1.5 text-[13.5px] leading-relaxed text-muted" />}

      {d.options.length > 0 && !own && (
        <div className="mt-3 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface" role="radiogroup" aria-label="Opties">
          {d.options.map((o, i) => {
            const on = sel === i;
            return (
              <button
                key={i}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={!!busy}
                onClick={() => setSel(on ? null : i)}
                className={cx('flex w-full items-start gap-3 px-3 py-2.5 text-start text-sm disabled:opacity-60 coarse:py-3', on ? 'bg-surface-3' : 'hover:bg-surface-2')}
              >
                <span className={cx('mt-px flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md px-1 text-xs font-bold', on ? 'bg-accent text-accent-fg' : 'bg-surface-3 text-muted')} aria-hidden>
                  {on ? <Check className="h-3.5 w-3.5" /> : o.key.length <= 2 ? o.key : i + 1}
                </span>
                <span className={cx('min-w-0 flex-1 [overflow-wrap:anywhere]', on ? 'font-semibold' : 'font-medium')} translate="no">
                  {o.text}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {own && (
        <div className="mt-3">
          <Textarea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={3} placeholder="Schrijf je antwoord…" aria-label="Je antwoord" className="bg-surface" />
        </div>
      )}

      {(ready || own) && (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          {!own && <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Toelichting voor de bot (optioneel)" aria-label="Toelichting (optioneel)" className="min-w-0 flex-1 bg-surface" onKeyDown={(e) => e.key === 'Enter' && submit()} />}
          <Button variant="primary" loading={busy === 'choose'} disabled={!ready || !!busy} onClick={submit} className={cx(own && 'sm:ms-auto')}>
            {own ? 'Antwoord sturen' : `Kies ${d.options[sel!]?.key && d.options[sel!].key.length <= 2 ? d.options[sel!].key : 'deze'}`}
          </Button>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center justify-end gap-1">
        {d.options.length > 0 && (
          <Button size="sm" variant="ghost" icon={own ? <ListChecks className="h-3.5 w-3.5" /> : <PenLine className="h-3.5 w-3.5" />} onClick={() => (setOwn(!own), setSel(null))} disabled={!!busy}>
            {own ? 'Toch een optie kiezen' : 'Iets anders antwoorden'}
          </Button>
        )}
        <Button size="sm" variant="ghost" loading={busy === 'expire'} disabled={!!busy} onClick={() => send({ expire: true, note: own ? answer.trim() : note.trim() }, 'expire')} title="Niet meer nodig: de beslissing vervalt en de bot hoort het">
          Laat vervallen
        </Button>
      </div>
    </article>
  );
}

/** The open decisions, filterable by the bot that asked. */
function DecisionList({ list, setList }: { list: Decision[]; setList(fn: (l: Decision[]) => Decision[]): void }) {
  const [bot, setBot] = useState('');
  const bots = useMemo(() => {
    const m = new Map<string, { label: string; n: number }>();
    for (const d of list) {
      const k = nameKey(d.asker?.name || d.gevraagd_door) || '?';
      const cur = m.get(k) || { label: d.asker?.name || d.gevraagd_door.trim() || 'onbekend', n: 0 };
      cur.n++;
      m.set(k, cur);
    }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  }, [list]);
  const shown = bot ? list.filter((d) => (nameKey(d.asker?.name || d.gevraagd_door) || '?') === bot) : list;
  // Decisions of several teams (every team has its own database): each card says its team; ids repeat across teams.
  const showTeam = new Set(list.map((d) => d.teamId)).size > 1;
  const key = (d: Decision) => `${d.teamId || ''}:${d.id}`;
  return (
    <div className="space-y-3">
      {list.length > 4 && bots.length > 1 && (
        <Chips
          label="Filter op bot"
          value={bot}
          onChange={setBot}
          items={[{ id: '', label: 'Alle bots', count: list.length }, ...bots.map(([k, v]) => ({ id: k, label: <BotName name={v.label} size={18} bold={false} />, count: v.n }))]}
        />
      )}
      {shown.map((d) => (
        <DecisionCard key={key(d)} d={d} showTeam={showTeam} onDone={() => setList((l) => l.filter((x) => key(x) !== key(d)))} />
      ))}
    </div>
  );
}

function useOpenDecisions() {
  const [list, setList] = useState<Decision[] | null>(null);
  const load = () =>
    teamApi
      .decisions('open')
      .then(setList)
      .catch(() => setList([]));
  useEffect(() => {
    void load();
  }, []);
  useTeamChanged(['beslissingen'], () => void load());
  return { list, setList: (fn: (l: Decision[]) => Decision[]) => setList((l) => fn(l || [])) };
}

/** Section in "Wacht op jou": open decisions plus a pointer to tasks that wait for the owner. */
export function DecisionsInbox() {
  const { list, setList } = useOpenDecisions();
  const waiting = useTeamSummary((s) => s.s?.waitingTasks || 0);
  if (list === null) return null;
  if (!list.length && !waiting) return null;
  return (
    <section aria-labelledby="inbox-decisions" className="space-y-3">
      {list.length > 0 && (
        <div className="flex items-end justify-between gap-3 pt-2">
          <h2 id="inbox-decisions" className="flex items-center gap-2 text-[15px] font-bold tracking-tight">
            <Scale className="h-4 w-4 text-muted" aria-hidden /> Beslissingen <span className="font-semibold text-muted tabular-nums">{list.length}</span>
          </h2>
          <a href="#/m/teamdata/beslissingen" className="text-[13px] font-semibold text-muted underline-offset-2 hover:text-fg hover:underline">
            Alle beslissingen
          </a>
        </div>
      )}
      {list.length > 0 && <DecisionList list={list} setList={setList} />}
      {waiting > 0 && (
        <a href="#/tasks?status=wacht" className="flex items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3 hover:bg-surface-2">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-warn-soft text-warn">
            <ListChecks className="h-[18px] w-[18px]" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">
              {waiting} {waiting === 1 ? 'taak wacht' : 'taken wachten'} op jou
            </span>
            <span className="block text-[13px] text-muted">Op het takenbord onder Taken</span>
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        </a>
      )}
    </section>
  );
}

/** Teamwerk → Beslissingen: open ones to answer, and everything that was decided before. */
export function DecisionsTab() {
  const [tab, setTab] = useState<'open' | 'closed'>('open');
  const [q, setQ] = useState('');
  const [list, setList] = useState<Decision[] | null>(null);
  // The team picked in the page header (none: every team).
  const team = useTeamPick((s) => s.team);
  const load = () =>
    teamApi
      .decisions(tab, q, team)
      .then(setList)
      .catch((e) => (toastError(e), setList([])));
  useEffect(() => {
    setList(null);
    void load();
  }, [tab, q, team]);
  useTeamChanged(['beslissingen'], () => void load());
  const summary = usePickedSummary();
  const closed = summary ? Object.entries(summary.decisions).reduce((n, [k, v]) => (k === 'open' ? n : n + v), 0) : undefined;
  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Chips
          label="Welke beslissingen"
          value={tab}
          onChange={setTab}
          items={[
            { id: 'open', label: 'Open', count: summary?.openDecisions },
            { id: 'closed', label: 'Afgehandeld', count: closed },
          ]}
        />
        <SearchBox value={q} onChange={setQ} label="Beslissingen doorzoeken" placeholder="Zoek in vraag, uitleg of antwoord" className="sm:ms-auto sm:w-72" />
      </div>
      {list === null ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : list.length === 0 ? (
        <EmptyState icon={<Scale />} title={q ? 'Niets gevonden' : tab === 'open' ? 'Geen open beslissingen' : 'Nog niets beslist'}>
          {q ? 'Probeer een ander woord.' : tab === 'open' ? 'Wat een bot door jou wil laten beslissen, staat hier en onder Wacht op jou.' : 'Beslissingen die je neemt (of die vervallen), komen hier te staan.'}
        </EmptyState>
      ) : tab === 'open' ? (
        <DecisionList list={list} setList={(fn) => setList((l) => fn(l || []))} />
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
          {list.map((d) => (
            <li key={`${d.teamId || ''}:${d.id}`} className="space-y-1.5 px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                <BotName name={d.asker?.name || d.gevraagd_door} size={20} />
                <span aria-hidden>·</span>
                <When value={d.beslist || d.aangemaakt} />
                <span aria-hidden>·</span>
                <span className="tabular-nums">#{d.id}</span>
                <span className="ms-auto">
                  <StatusBadge status={d.status} />
                </span>
              </div>
              <div className="text-sm font-semibold leading-snug [overflow-wrap:anywhere]" translate="no">
                {d.vraag}
              </div>
              {d.antwoord && (
                <div className="flex gap-2 text-[13.5px]">
                  <span className="shrink-0 text-muted">Antwoord:</span>
                  <Fold text={d.antwoord} lines={2} min={160} className="min-w-0" />
                </div>
              )}
              {d.uitleg && (
                <details className="text-[13px] text-muted">
                  <summary className="cursor-pointer font-semibold hover:text-fg">Uitleg</summary>
                  <div className="mt-1">
                    <Linkified text={d.uitleg} />
                  </div>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
