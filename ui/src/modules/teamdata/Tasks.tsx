import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { ListChecks } from 'lucide-react';
import { query } from '../../lib/router';
import { useIsDesktop } from '../../lib/media';
import { Button, Card, EmptyState, Modal, Select, cx, toast, toastError } from '../../components/ui';
import { SkeletonCards } from '../../components/overview';
import { Segmented } from '../../components/SettingControls';
import { type Row, teamApi, useTeamChanged, teamTaskRef } from './api';
import { Block, BotName, Chips, Fields, Linkified, SearchBox, StatusBadge, When, dateLabel, extraColumns, nameKey, statusInfo } from './parts';
import { TaskQuality } from '../quality/parts';

type Col = 'open' | 'bezig' | 'wacht' | 'klaar' | 'gestopt';
const COLS: { id: Col; label: string; hint: string }[] = [
  { id: 'open', label: 'Open', hint: 'Nog niet opgepakt' },
  { id: 'bezig', label: 'Bezig', hint: 'Een bot werkt eraan' },
  { id: 'wacht', label: 'Wacht op jou', hint: 'Er is iets van jou nodig' },
  { id: 'klaar', label: 'Klaar', hint: 'Met resultaat en bewijs' },
  { id: 'gestopt', label: 'Gestopt', hint: 'Geannuleerd of vervallen' },
];
const colOf = (s: unknown): Col => {
  const v = String(s ?? '').trim();
  if (v === 'open' || v === '') return 'open';
  if (v === 'bezig') return 'bezig';
  // "kon_niet" (the bot honestly could not) also waits for the owner.
  if (v.startsWith('wacht_op') || v === 'kon_niet') return 'wacht';
  if (v === 'klaar') return 'klaar';
  return 'gestopt';
};
const STATUS_CHOICES = [
  { v: 'open', label: 'Open' },
  { v: 'bezig', label: 'Bezig' },
  { v: 'klaar', label: 'Klaar' },
  { v: 'geannuleerd', label: 'Geannuleerd' },
];
const KNOWN = ['id', 'titel', 'eigenaar', 'aangevraagd_door', 'site', 'status', 'resultaat', 'bewijs', 'aangemaakt', 'bijgewerkt', 'klaar_als'];
const PAGE = 25;

function TaskCard({ t, onOpen, showOwner = true }: { t: Row; onOpen(): void; showOwner?: boolean }) {
  return (
    // The same calm card as the board under Taken: what, who, and when it last changed. The rest is in the details.
    <button type="button" onClick={onOpen} className="tb-in block w-full rounded-xl border border-line bg-surface p-3 text-start transition-colors duration-150 hover:border-line-strong">
      <div className="line-clamp-3 text-sm font-semibold leading-snug [overflow-wrap:anywhere]" translate="no">
        {t.titel}
      </div>
      {t.resultaat && (
        <div className="mt-1 line-clamp-2 text-[13px] leading-snug text-muted [overflow-wrap:anywhere]" translate="no">
          {t.resultaat}
        </div>
      )}
      <div className="mt-2.5 flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs text-muted">
        {showOwner ? <BotName name={t.eigenaar} size={18} bold={false} /> : <span />}
        <When value={t.bijgewerkt || t.aangemaakt} />
      </div>
    </button>
  );
}

function TaskModal({ t, onClose, onSaved }: { t: Row | null; onClose(): void; onSaved(r: Row): void }) {
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setStatus(String(t?.status ?? '')), [t?.id]);
  if (!t) return null;
  const choices = STATUS_CHOICES.some((c) => c.v === t.status) ? STATUS_CHOICES : [{ v: String(t.status), label: statusInfo(t.status).label }, ...STATUS_CHOICES];
  const save = async () => {
    setBusy(true);
    try {
      const r = await teamApi.setTaskStatus(t.id, status);
      toast('Status bijgewerkt', 'ok');
      onSaved(r);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} wide title={<span className="tabular-nums">Taak #{t.id}</span>}>
      <div className="space-y-4 pb-2">
        <div className="whitespace-pre-wrap text-[15px] font-bold leading-snug [overflow-wrap:anywhere]" translate="no">
          {t.titel}
        </div>
        <Fields
          items={[
            ['Status', <StatusBadge status={t.status} />],
            ['Eigenaar', t.eigenaar ? <BotName name={t.eigenaar} size={20} /> : null],
            ['Gevraagd door', t.aangevraagd_door ? <BotName name={t.aangevraagd_door} size={20} /> : null],
            ['Site', t.site ? <span translate="no">{t.site}</span> : null],
            ['Aangemaakt', t.aangemaakt ? dateLabel(t.aangemaakt) + ' · ' + String(t.aangemaakt).slice(11, 16) : null],
            ['Bijgewerkt', t.bijgewerkt ? dateLabel(t.bijgewerkt) + ' · ' + String(t.bijgewerkt).slice(11, 16) : null],
            ...extraColumns(t, KNOWN).map(([k, v]) => [k, <Linkified text={v} />] as [string, ReactNode]),
          ]}
        />
        <Block title="Resultaat" text={t.resultaat} />
        <Block title="Bewijs" text={t.bewijs} />
        {!t.bewijs && colOf(t.status) === 'klaar' && <p className="text-[13px] text-warn">Klaar zonder bewijs: vraag de bot om een link, meting of schermafbeelding.</p>}
        {/* Klaar als, what TeamBot found of the evidence and the second look (quality module). */}
        <TaskQuality kind="teamdata" refId={teamTaskRef(t.id)} />
        <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
          <label className="min-w-0 flex-1 space-y-1.5 text-[13px] font-semibold">
            <span>Status wijzigen</span>
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              {choices.map((c) => (
                <option key={c.v} value={c.v}>
                  {c.label}
                </option>
              ))}
            </Select>
          </label>
          <Button variant="primary" loading={busy} disabled={status === t.status} onClick={save}>
            Opslaan
          </Button>
        </div>
        <p className="text-xs text-muted">Moet de bot er meteen iets mee? Zeg het in zijn chat.</p>
      </div>
    </Modal>
  );
}

function Column({ col, list, onOpen }: { col: (typeof COLS)[number]; list: Row[]; onOpen(t: Row): void }) {
  const [all, setAll] = useState(false);
  const shown = all ? list : list.slice(0, PAGE);
  return (
    <section aria-label={`${col.label}: ${list.length}`} className={cx('min-w-0 rounded-card border p-2', col.id === 'wacht' && list.length ? 'tb-ask' : 'border-transparent bg-surface-2')}>
      <header className="flex items-center justify-between gap-2 px-2 pb-2 pt-1">
        <h3 className="text-[13px] font-semibold">{col.label}</h3>
        <span className="text-xs tabular-nums text-muted">{list.length}</span>
      </header>
      <div className="space-y-2">
        {shown.map((t) => (
          <TaskCard key={t.id} t={t} onOpen={() => onOpen(t)} />
        ))}
        {!list.length && <p className="px-2 pb-2 text-xs text-muted">{col.hint}</p>}
        {list.length > shown.length && (
          <Button size="sm" variant="ghost" className="w-full justify-center" onClick={() => setAll(true)}>
            Toon alle {list.length}
          </Button>
        )}
      </div>
    </section>
  );
}

/**
 * Takenbord: the team's tasks by status (columns on a computer, one column at a time on a phone) or grouped per bot.
 * Click a task for the result and the evidence; the owner can change its status.
 */
export function TasksTab() {
  const desk = useIsDesktop();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [q, setQ] = useState('');
  const [bot, setBot] = useState('');
  const [view, setView] = useState<'status' | 'bot'>('status');
  const [stopped, setStopped] = useState(false);
  const [open, setOpen] = useState<Row | null>(null);
  const [phoneCol, setPhoneCol] = useState<Col | null>(query().get('status') === 'wacht' ? 'wacht' : null);
  const load = () =>
    teamApi
      .tasks()
      .then(setRows)
      .catch((e) => (toastError(e), setRows([])));
  useEffect(() => void load(), []);
  useTeamChanged(['taken'], () => void load());

  const owners = useMemo(() => {
    const m = new Map<string, { label: string; n: number }>();
    for (const t of rows || []) {
      const k = nameKey(t.eigenaar) || '?';
      const cur = m.get(k) || { label: String(t.eigenaar || '').trim() || 'niemand', n: 0 };
      cur.n++;
      m.set(k, cur);
    }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  }, [rows]);

  const filtered = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (rows || []).filter((t) => (!bot || (nameKey(t.eigenaar) || '?') === bot) && terms.every((w) => [t.titel, t.resultaat, t.bewijs, t.site, t.eigenaar, t.aangevraagd_door, `#${t.id}`].some((v) => String(v ?? '').toLowerCase().includes(w))));
  }, [rows, q, bot]);
  const byCol = useMemo(() => {
    const m: Record<Col, Row[]> = { open: [], bezig: [], wacht: [], klaar: [], gestopt: [] };
    for (const t of filtered) m[colOf(t.status)].push(t);
    return m;
  }, [filtered]);

  if (rows === null) return <SkeletonCards n={4} className="lg:grid-cols-4" />;
  if (!rows.length)
    return (
      <Card>
        <EmptyState icon={<ListChecks />} title="Nog geen taken" action={<Button onClick={() => (location.hash = '#/tasks')}>Naar het takenbord</Button>}>
          Je bots zetten hier taken voor elkaar en voor jou neer.
        </EmptyState>
      </Card>
    );

  const cols = COLS.filter((c) => c.id !== 'gestopt' || stopped);
  const firstWithWork = (['wacht', 'bezig', 'open', 'klaar'] as Col[]).find((c) => byCol[c].length) || 'open';
  const phone = phoneCol || firstWithWork;

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <SearchBox value={q} onChange={setQ} label="Taken doorzoeken" placeholder="Zoek in taken" className="lg:w-72" />
        <div className="flex min-w-0 items-center gap-2">
          <Select value={bot} onChange={(e) => setBot(e.target.value)} aria-label="Filter op bot" className="w-auto min-w-0 max-w-[14rem]">
            <option value="">Alle bots</option>
            {owners.map(([k, v]) => (
              <option key={k} value={k}>
                {v.label} ({v.n})
              </option>
            ))}
          </Select>
          <Segmented<'status' | 'bot'>
            label="Weergave"
            value={view}
            onChange={setView}
            options={[
              { value: 'status', label: 'Per status' },
              { value: 'bot', label: 'Per bot' },
            ]}
          />
        </div>
        {view === 'status' && desk && byCol.gestopt.length > 0 && (
          <Button size="sm" variant="ghost" className="lg:ms-auto" onClick={() => setStopped(!stopped)} aria-pressed={stopped}>
            {stopped ? 'Verberg gestopte' : `Toon gestopte (${byCol.gestopt.length})`}
          </Button>
        )}
      </div>

      {view === 'status' && desk && (
        <div className={cx('grid items-start gap-3', stopped ? 'md:grid-cols-3 xl:grid-cols-5' : 'md:grid-cols-2 xl:grid-cols-4')}>
          {cols.map((c) => (
            <Column key={c.id} col={c} list={byCol[c.id]} onOpen={setOpen} />
          ))}
        </div>
      )}

      {view === 'status' && !desk && (
        <div className="space-y-3">
          <Chips label="Status" value={phone} onChange={setPhoneCol} items={COLS.filter((c) => c.id !== 'gestopt' || byCol.gestopt.length).map((c) => ({ id: c.id, label: c.label, count: byCol[c.id].length }))} />
          <Column col={COLS.find((c) => c.id === phone)!} list={byCol[phone]} onOpen={setOpen} />
        </div>
      )}

      {view === 'bot' && (
        <div className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
          {owners
            .filter(([k]) => !bot || k === bot)
            .map(([k, v]) => {
              const list = filtered.filter((t) => (nameKey(t.eigenaar) || '?') === k && (stopped || colOf(t.status) !== 'gestopt'));
              if (!list.length) return null;
              const counts = COLS.map((c) => [c, list.filter((t) => colOf(t.status) === c.id).length] as const).filter(([, n]) => n);
              return (
                <section key={k} aria-label={v.label} className="tb-in min-w-0 rounded-card border border-line bg-surface p-4">
                  <header className="mb-2 flex items-center justify-between gap-2">
                    <BotName name={v.label} size={26} />
                    <span className="text-xs text-muted">{counts.map(([c, n]) => `${n} ${c.label.toLowerCase()}`).join(' · ')}</span>
                  </header>
                  <ul className="divide-y divide-line">
                    {list.map((t) => (
                      <li key={t.id}>
                        <button type="button" onClick={() => setOpen(t)} className="flex w-full items-start gap-2 py-2 text-start hover:opacity-80">
                          <span className="mt-0.5 shrink-0">
                            <StatusBadge status={t.status} />
                          </span>
                          <span className="line-clamp-2 min-w-0 flex-1 text-[13.5px] leading-snug [overflow-wrap:anywhere]" translate="no">
                            {t.titel}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
        </div>
      )}

      <TaskModal
        t={open}
        onClose={() => setOpen(null)}
        onSaved={(r) => {
          setRows((l) => (l || []).map((x) => (x.id === r.id ? { ...r, id: Number(r.id) } : x)));
          setOpen(null);
        }}
      />
    </div>
  );
}
