import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, ScrollText } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { t, uiLocale } from '../lib/i18n';
import { relativeTime } from '../lib/format';
import { Avatar, Badge, Button, EmptyState, Select, Spinner, cx } from '../components/ui';
import { BotAvatar } from '../components/BotFace';
import { Chips, SearchBox } from '../modules/teamdata/parts';
import { AUDIT_CATEGORIES, categoryLabel, collapseDuplicates, describeAudit, type AuditCategory, type AuditEntry, type AuditRow } from './auditText';
import { Mark } from './Sidebar';

const PAGE = 200;

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(Date.now() - 864e5);
  if (d.toDateString() === today.toDateString()) return 'Vandaag';
  if (d.toDateString() === y.toDateString()) return 'Gisteren';
  return d.toLocaleDateString(uiLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

/** "14:05", with "12 minuten geleden" in front for the last day (Intl, "1 minuut"); the full date and time as tooltip. */
function When({ iso }: { iso: string }) {
  const d = new Date(iso);
  const clock = d.toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit' });
  const s = (Date.now() - d.getTime()) / 1000;
  const rel = s < 60 ? 'zojuist' : s < 86400 ? relativeTime(d) : '';
  return (
    <time dateTime={iso} title={d.toLocaleString(uiLocale(), { dateStyle: 'full', timeStyle: 'medium' })} className="tabular-nums">
      {rel ? `${rel} · ${clock}` : clock}
    </time>
  );
}

function Who({ e, row }: { e: AuditEntry; row: AuditRow }) {
  const me = useApp((s) => s.me);
  const agent = useApp((s) => (row.agent_id ? s.agents.find((a) => a.id === row.agent_id) : undefined));
  if (e.actorKind === 'system') return <Mark size={28} />;
  if (e.actorKind === 'you') return <Avatar name={me?.name || 'Jij'} size={28} />;
  return <BotAvatar bot={agent && agent.name === e.actor ? agent : { id: row.agent_id || e.actor, name: e.actor }} size={28} />;
}

/**
 * Instellingen › Beveiliging › Logboek: every action with impact as one plain sentence (wie, wat, wanneer, wie het
 * goedkeurde), filterable by kind and bot, searchable, paged by 200 (server: GET /audit?limit&before&agentId).
 */
export function AuditLog() {
  const me = useApp((s) => s.me);
  const agents = useApp((s) => s.agents);
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState('');
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cat, setCat] = useState<'all' | AuditCategory>('all');
  const [bot, setBot] = useState('');
  const [q, setQ] = useState('');

  const fetchPage = (before?: number) => api.get<AuditRow[]>(`/audit?limit=${PAGE}${before ? `&before=${before}` : ''}${bot ? `&agentId=${encodeURIComponent(bot)}` : ''}`);
  const load = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await fetchPage();
      setRows(r);
      setMore(r.length === PAGE);
    } catch (e: any) {
      setError(e?.message || 'Onbekende fout');
    } finally {
      setBusy(false);
    }
  };
  const older = async () => {
    if (!rows?.length) return;
    setBusy(true);
    try {
      const r = await fetchPage(rows[rows.length - 1].id);
      setRows([...rows, ...r]);
      setMore(r.length === PAGE);
    } catch (e: any) {
      setError(e?.message || 'Onbekende fout');
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    setRows(null);
    void load();
  }, [bot]);

  const entries = useMemo(() => {
    const name = (id: string) => agents.find((a) => a.id === id)?.name;
    return collapseDuplicates(rows || []).map((row) => ({ row, e: describeAudit(row, { meId: me?.id, agentName: name }) }));
  }, [rows, agents, me?.id]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const { e } of entries) c[e.category] = (c[e.category] || 0) + 1;
    return c;
  }, [entries]);

  // Bots to filter on: your bots, plus bots that appear in the log (e.g. deleted ones are left out: no id to show).
  const botOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents) m.set(a.id, a.name);
    for (const { row } of entries) if (row.agent_id && row.agent_name && !m.has(row.agent_id)) m.set(row.agent_id, row.agent_name);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], uiLocale()));
  }, [agents, entries]);

  const needle = q.trim().toLowerCase();
  const shown = entries.filter(({ e }) => (cat === 'all' || e.category === cat) && (!needle || `${e.sentence} ${e.approval?.text || ''} ${categoryLabel(e.category)}`.toLowerCase().includes(needle)));

  let lastDay = '';
  return (
    <section aria-labelledby="tb-audit-title" className="space-y-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 id="tb-audit-title" className="text-sm font-semibold">
            Logboek
          </h3>
          <p className="text-xs text-muted">Wie wat deed en wanneer. Alleen jij ziet dit.</p>
        </div>
        <Button size="icon" variant="ghost" aria-label="Logboek vernieuwen" title="Vernieuwen" loading={busy && !!rows} onClick={() => void load()} icon={<RefreshCw className="h-4 w-4" />} />
      </div>
      <Chips
        label="Soort gebeurtenis"
        value={cat}
        onChange={setCat}
        items={[{ id: 'all', label: 'Alles', count: entries.length }, ...AUDIT_CATEGORIES.map((c) => ({ id: c.id, label: c.label, count: counts[c.id] || 0 }))]}
      />
      <div className="flex flex-col gap-2 sm:flex-row">
        <SearchBox value={q} onChange={setQ} label="Zoeken in het logboek" placeholder="Zoek in het logboek" className="sm:flex-1" />
        <Select value={bot} onChange={(e) => setBot(e.target.value)} aria-label="Filter op bot" className="sm:w-56">
          <option value="">Alle bots en jijzelf</option>
          {botOptions.map(([id, n]) => (
            <option key={id} value={id}>
              {n}
            </option>
          ))}
        </Select>
      </div>
      {error && !rows ? (
        <EmptyState icon={<ScrollText />} title="Logboek laden mislukt" action={<Button onClick={() => void load()}>Opnieuw proberen</Button>}>
          {error}
        </EmptyState>
      ) : !rows ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : entries.length === 0 ? (
        <EmptyState icon={<ScrollText />} title={bot ? 'Nog niets van deze bot' : 'Nog niets in het logboek'}>
          Zodra een bot iets doet met gevolgen, of jij iets instelt, zie je het hier.
        </EmptyState>
      ) : (
        <>
          {shown.length === 0 ? (
            <EmptyState icon={<ScrollText />} title="Niets gevonden">
              {more ? 'Niet in de geladen regels. Laad oudere regels of probeer een ander woord.' : 'Probeer een ander woord of een ander filter.'}
            </EmptyState>
          ) : (
            <ol className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface" aria-label="Gebeurtenissen">
              {shown.map(({ row, e }) => {
                const day = dayLabel(row.created_at);
                const head = day !== lastDay;
                lastDay = day;
                return (
                  <li key={row.id}>
                    {head && <div className="bg-surface-2 px-4 py-1.5 text-[11.5px] font-bold uppercase tracking-wider text-muted first-letter:uppercase">{day}</div>}
                    <div className="flex items-start gap-3 px-4 py-2.5">
                      <span className="mt-0.5 shrink-0">
                        <Who e={e} row={row} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm leading-snug [overflow-wrap:anywhere]">
                          <span className="font-semibold">{e.actor}</span> {e.text}.
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                          <When iso={row.created_at} />
                          <span aria-hidden>·</span>
                          <span>{categoryLabel(e.category)}</span>
                          {e.approval && <Badge tone={e.approval.tone === 'neutral' ? 'neutral' : e.approval.tone}>{e.approval.text}</Badge>}
                          {!e.approval && e.tone === 'danger' && <Badge tone="danger">Met gevolgen</Badge>}
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          <div className={cx('flex items-center justify-between gap-2 text-xs text-muted')}>
            <span>
              {shown.length === entries.length ? t('{0, plural, one {# regel geladen} other {# regels geladen}}', entries.length) : t('{0} van {1, plural, one {# geladen regel} other {# geladen regels}}', shown.length, entries.length)}
            </span>
            {more && (
              <Button size="sm" loading={busy} onClick={() => void older()}>
                Oudere laden
              </Button>
            )}
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
        </>
      )}
    </section>
  );
}
