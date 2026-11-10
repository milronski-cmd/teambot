import { useEffect, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronUp, PowerOff } from 'lucide-react';
import { api, on } from '../../lib/api';
import { t } from '../../lib/i18n';
import { Badge, Button, Card, useAsync } from '../../components/ui';
import { fmtDate, type AttentionItem, type MissedPeriod } from './lib';
import { useFollowTeam } from '../teams/follow';

const KIND: Record<AttentionItem['kind'], { label: string; tone: 'warn' | 'danger' | 'neutral' }> = {
  not_run: { label: 'Niet gedraaid', tone: 'danger' },
  missed: { label: 'Gemist', tone: 'warn' },
  error: { label: 'Mislukt', tone: 'danger' },
  no_result: { label: 'Zonder resultaat', tone: 'warn' },
  limited: { label: 'Limiet bereikt', tone: 'warn' },
  skipped: { label: 'Overgeslagen', tone: 'neutral' },
  interrupted: { label: 'Onderbroken', tone: 'warn' },
};

/** Load now, again after routine runs (bundled, at most every 2 s), and when the team switcher changes (`key`). */
function useLive(load: () => void, key = '') {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (!timer) timer = setTimeout(() => ((timer = null), load()), 2000);
    };
    load();
    const off = on('routine.run', soon);
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/**
 * "Wat niet gebeurde": the runs of the last three days that did not deliver — not run, missed, failed, without a
 * result, stopped by a limit — since the owner last clicked "Gezien". Nothing to show: nothing rendered.
 */
export function AttentionCard() {
  const [d, setD] = useState<{ items: AttentionItem[]; seenAt: string | null } | null>(null);
  const [all, setAll] = useState(false);
  const { busy, run } = useAsync();
  // Package B4: only the chosen team's routines (the team switcher; '' = all teams).
  const team = useFollowTeam().and;
  const load = () => api.get<{ items: AttentionItem[]; seenAt: string | null }>(`/routines/attention?hours=72${team}`).then(setD).catch(() => {});
  useLive(load, team);
  if (!d) return null;
  const fresh = d.items.filter((i) => !d.seenAt || i.created_at > d.seenAt);
  if (!fresh.length) return null;
  const shown = all ? fresh : fresh.slice(0, 3);
  return (
    <Card className="tb-in p-0" role="status">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <AlertTriangle className="h-4 w-4 shrink-0 text-warn" aria-hidden />
        <span className="text-sm font-semibold">Wat niet gebeurde</span>
        <Badge tone="warn">{fresh.length}</Badge>
        <Button size="sm" variant="ghost" className="-my-1 ms-auto" icon={<Check className="h-4 w-4" />} loading={busy} onClick={() => run(async () => (await api.post('/routines/attention/seen', {}), await load()))}>
          Gezien
        </Button>
      </div>
      <ul className="divide-y divide-line border-t border-line">
        {shown.map((i) => (
          <li key={i.id} className="px-4 py-2.5 text-sm">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <a className="font-medium [overflow-wrap:anywhere] hover:underline" href={`#/m/routines/r/${i.routineId}?tab=history`} translate="no">
                {i.name}
              </a>
              <Badge tone={KIND[i.kind]?.tone || 'neutral'}>{KIND[i.kind]?.label || i.kind}</Badge>
              <span className="ms-auto text-xs text-muted">{fmtDate(i.at, i.timezone)}</span>
            </div>
            {i.text && <div className="mt-0.5 line-clamp-2 text-[13px] text-muted [overflow-wrap:anywhere]">{i.text}</div>}
          </li>
        ))}
      </ul>
      {fresh.length > 3 && (
        <div className="border-t border-line px-2 py-1">
          <Button size="sm" variant="ghost" icon={all ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />} onClick={() => setAll(!all)}>
            {all ? 'Minder tonen' : t('Alle {0} tonen', fresh.length)}
          </Button>
        </div>
      )}
    </Card>
  );
}

/**
 * "Gemist terwijl je pc uit stond": per period that TeamBot did not run (pc off, asleep, app closed), each routine with
 * how many runs it missed, the first and the last, and what TeamBot did (caught up once, or skipped as chosen). Shows
 * by itself only what is new; `all` (Meer opties › Eerder gemist) shows the last 30 days.
 */
export function MissedCard({ all, onAll }: { all: boolean; onAll(v: boolean): void }) {
  const [d, setD] = useState<{ periods: MissedPeriod[]; seenAt: string | null } | null>(null);
  const { busy, run } = useAsync();
  const team = useFollowTeam().and;
  const load = () => api.get<{ periods: MissedPeriod[]; seenAt: string | null }>(`/routines/missed?days=30${team}`).then(setD).catch(() => {});
  useLive(load, team);
  if (!d) return null;
  const unseen = d.periods.filter((p) => !d.seenAt || p.to > d.seenAt);
  const list = all ? d.periods : unseen;
  if (!list.length && !all) return null;
  return (
    <Card className="tb-in p-0">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <PowerOff className="h-4 w-4 shrink-0 text-warn" aria-hidden />
        <span className="text-sm font-semibold">{all ? 'Gemist in de laatste 30 dagen' : 'Gemist terwijl je pc uit stond'}</span>
        <div className="-my-1 ms-auto flex gap-1">
          {unseen.length > 0 && (
            <Button size="sm" variant="ghost" icon={<Check className="h-4 w-4" />} loading={busy} onClick={() => run(async () => (await api.post('/routines/missed/seen', {}), await load(), onAll(false)))}>
              Gezien
            </Button>
          )}
          {all && (
            <Button size="sm" variant="ghost" onClick={() => onAll(false)}>
              Sluiten
            </Button>
          )}
        </div>
      </div>
      {!list.length && <p className="border-t border-line px-4 py-3 text-sm text-muted">Niets gemist.</p>}
      {list.map((p) => (
        <div key={p.id} className="space-y-1.5 border-t border-line px-4 py-3">
          <div className="text-sm">
            <span className="font-medium">{p.kind === 'sleep' ? 'Pc in slaapstand' : 'TeamBot draaide niet'}</span>{' '}
            <span className="text-muted">
              {t('van {0} tot {1}', fmtDate(p.from), fmtDate(p.to))} · {t('{0, plural, one {# geplande run gemist} other {# geplande runs gemist}}', p.runs)}
            </span>
          </div>
          <ul className="space-y-1">
            {p.items.map((i) => (
              <li key={i.runId} className="flex flex-wrap items-center gap-2 text-sm">
                <a className="font-medium [overflow-wrap:anywhere] hover:underline" href={`#/m/routines/r/${i.routineId}?tab=history`} translate="no">
                  {i.name}
                </a>
                <span className="text-muted">
                  {i.capped ? t('meer dan {0, plural, one {# run} other {# runs}}', i.count) : t('{0, plural, one {# run} other {# runs}}', i.count)}
                  {i.count > 1 ? ` (${fmtDate(i.first, i.timezone)} – ${fmtDate(i.last, i.timezone)})` : ` (${fmtDate(i.first, i.timezone)})`}
                </span>
                <Badge tone={i.outcome === 'caught_up' ? (i.status === 'done' && i.result !== 'none' ? 'ok' : 'warn') : 'neutral'}>
                  {i.outcome === 'caught_up' ? (i.status === 'done' ? (i.result === 'none' ? 'Ingehaald, zonder resultaat' : 'Eén keer ingehaald') : i.status === 'error' ? 'Inhalen mislukt' : 'Wordt ingehaald') : 'Overgeslagen'}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </Card>
  );
}
