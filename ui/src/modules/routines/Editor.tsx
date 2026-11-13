import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { api } from '../../lib/api';
import { t } from '../../lib/i18n';
import { formatTime, tText } from '../../lib/format';
import { useApp } from '../../lib/store';
import type { ToolGroup } from '../../lib/types';
import { Badge, Button, Card, cx, Field, Input, Select, Textarea, Toggle, useAsync } from '../../components/ui';
import { Fold, Skeleton } from '../../components/overview';
import { MoreInfo } from '../../components/MoreInfo';
import { DAY_ORDER, dayShort, type Meta, type RoutineOptions, type RoutineView, type Schedule } from './lib';
import { chainLoop, chainLoopText, chainOptionLabel, chainWarning, type ChainNode } from './chain';
import { useTeamStore } from '../teams/scope';
import { homeMap } from '../../shell/teamFilter';
import { CostEstimate } from '../usage/Estimate';

export interface Draft {
  name: string;
  agent_id: string;
  prompt: string;
  timezone: string;
  schedule: Schedule;
  options: RoutineOptions;
}

const ACCESS: { id: string; label: string; rank: number }[] = [
  { id: 'chat', label: 'Alleen chatten (geen tools)', rank: 0 },
  { id: 'readonly', label: 'Alleen lezen', rank: 1 },
  { id: 'ask', label: 'Vragen bij wijzigingen', rank: 2 },
  { id: 'auto', label: 'Automatisch (gevaarlijke acties vragen altijd)', rank: 3 },
  { id: 'full', label: 'Volledige toegang (versturen naar anderen en betalen vragen nog)', rank: 4 },
];

/**
 * "Resultaat ook sturen naar": one of the user's chat channels (to himself), when the channels module is there. With
 * two or more teams only the channels of the routine bot's team (a routine works inside its team; package B4).
 */
function DeliverField({ value, onChange, agentId }: { value: RoutineOptions['deliver'] | null; onChange(v: RoutineOptions['deliver'] | null): void; agentId?: string }) {
  const [all, setList] = useState<{ id: string; name: string; adapterLabel: string; enabled: boolean; team_id?: string | null }[] | null>(null);
  const teams = useTeamStore((s) => s.teams);
  useEffect(() => {
    api.get('/channels/bindings').then(
      (r: any[]) => setList(r.filter((b) => b.adapter !== 'webhook')),
      () => setList(null),
    );
  }, []);
  const home = agentId && teams.length > 1 ? homeMap(teams).get(agentId) : undefined;
  const list = all?.filter((b) => !home || !b.team_id || b.team_id === home || b.id === value?.bindingId) || null;
  if (!list?.length) return null;
  return (
    <Field label="Resultaat ook sturen naar" hint="Bijvoorbeeld je dagrapport als WhatsApp-bericht.">
      <div className="space-y-2">
        <Select
          value={value?.bindingId || ''}
          onChange={(e) => onChange(e.target.value ? { bindingId: e.target.value, to: 'owner', withFiles: value?.withFiles !== false } : null)}
          aria-label="Resultaat ook sturen naar"
        >
          <option value="">Niet doorsturen</option>
          {list.map((b) => (
            <option key={b.id} value={b.id}>
              Naar jou via {b.name} ({b.adapterLabel}){b.enabled ? '' : ' — staat uit'}
            </option>
          ))}
        </Select>
        {value?.bindingId && <Toggle checked={value.withFiles !== false} onChange={(v) => onChange({ ...value, withFiles: v })} label="Gedeelde bestanden (pdf, afbeeldingen) meesturen" />}
        {value?.bindingId && <Toggle checked={!!value.errors} onChange={(v) => onChange({ ...value, errors: v })} label="Ook mislukte runs daarheen melden" />}
      </div>
    </Field>
  );
}

export function emptyDraft(meta: Meta, agentId: string): Draft {
  return {
    name: '',
    agent_id: agentId,
    prompt: '',
    timezone: meta.timezone,
    schedule: { kind: 'weekly', days: [1, 2, 3, 4, 5], times: ['09:00'] },
    options: { ...meta.defaults, override: {} },
  };
}

export function draftFrom(r: RoutineView): Draft {
  return { name: r.name, agent_id: r.agent_id, prompt: r.prompt, timezone: r.timezone, schedule: r.schedule, options: { ...r.options, override: { ...(r.options.override || {}) } } };
}

// ---------------------------------------------------------------------------

function NumberInput({ value, onChange, min, max, step, id, ...p }: { value: number; onChange(v: number): void; min?: number; max?: number; step?: number; id?: string; 'aria-label'?: string }) {
  return <Input id={id} type="number" inputMode="decimal" value={Number.isFinite(value) ? value : ''} min={min} max={max} step={step} onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))} className="w-28" {...p} />;
}

const MONTH_PRESETS: { token: number | string; label: string }[] = [
  { token: 1, label: 'de 1e' },
  { token: 15, label: 'de 15e' },
  { token: 'FW', label: 'eerste werkdag' },
  { token: 'LW', label: 'laatste werkdag' },
  { token: 'L', label: 'laatste dag' },
  { token: '1MO', label: 'eerste maandag' },
  { token: '-1FR', label: 'laatste vrijdag' },
];
/** A day or month you switch on or off (aria-pressed says which). */
const CHIP = 'h-9 rounded-full border text-sm font-medium transition-colors coarse:h-11';
const CHIP_ON = 'border-fg bg-surface-3 text-fg';
const CHIP_OFF = 'border-line bg-surface text-muted hover:bg-surface-2 hover:text-fg';
const MONTHS_SHORT =['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

function TimesEditor({ times, onChange }: { times: string[]; onChange(t: string[]): void }) {
  return (
    <div>
      <div className="mb-1.5 text-sm font-medium">Tijden</div>
      <div className="flex flex-wrap items-center gap-2">
        {times.map((t, i) => (
          <div key={i} className="flex items-center gap-1">
            <Input type="time" value={t} aria-label={tText('Tijd {0}', i + 1)} className="w-28" onChange={(e) => onChange(times.map((x, j) => (j === i ? e.target.value : x)))} />
            {times.length > 1 && (
              <Button size="icon" variant="ghost" type="button" aria-label="Tijd verwijderen" onClick={() => onChange(times.filter((_, j) => j !== i))}>
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        ))}
        {times.length < 24 && (
          <Button size="sm" variant="ghost" type="button" icon={<Plus className="h-4 w-4" />} onClick={() => onChange([...times, '17:00'])}>
            Tijd
          </Button>
        )}
      </div>
    </div>
  );
}

/** Monthly: days of the month (1–31, last day, first/last workday, nth weekday) and optionally only some months. */
function MonthlyFields({ value, onChange }: { value: Extract<Schedule, { kind: 'monthly' }>; onChange(s: Schedule): void }) {
  const [text, setText] = useState(() => value.days.join(', '));
  const sameDays = (a: (number | string)[], b: (number | string)[]) => a.length === b.length && a.every((x, i) => String(x) === String(b[i]));
  useEffect(() => {
    const parsed = parse(text);
    if (!sameDays(parsed, value.days)) setText(value.days.join(', '));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.days.join(',')]);
  function parse(s: string): (number | string)[] {
    return s
      .split(/[,;\s]+/)
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => (/^\d{1,2}$/.test(x) ? Number(x) : x.toUpperCase()));
  }
  const toggle = (tok: number | string) => {
    const on = value.days.some((d) => String(d) === String(tok));
    const days = on ? value.days.filter((d) => String(d) !== String(tok)) : [...value.days, tok];
    onChange({ ...value, days: days.length ? days : [tok] });
  };
  const months = value.months || [];
  return (
    <>
      <div>
        <div className="mb-1.5 text-sm font-medium" id="mdays-label">
          Dagen van de maand
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby="mdays-label">
          {MONTH_PRESETS.map((p) => {
            const on = value.days.some((d) => String(d) === String(p.token));
            return (
              <button
                key={String(p.token)}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(p.token)}
                className={cx(CHIP, 'px-3', on ? CHIP_ON : CHIP_OFF)}
              >
                {p.label}
              </button>
            );
          })}
        </div>
        <Field
          className="mt-2"
          label="Of typ zelf"
          hint={<MoreInfo>Komma's ertussen: 1–31, L = laatste dag, 1MO = eerste maandag, -1FR = laatste vrijdag.</MoreInfo>}
        >
          <Input
            value={text}
            className="font-mono"
            spellCheck={false}
            aria-label="Dagen van de maand"
            onChange={(e) => {
              setText(e.target.value);
              const days = parse(e.target.value);
              if (days.length) onChange({ ...value, days });
            }}
          />
        </Field>
      </div>
      <TimesEditor times={value.times} onChange={(times) => onChange({ ...value, times })} />
      <div>
        <div className="mb-1.5 text-sm font-medium" id="months-label">
          Maanden <span className="font-normal text-muted">(niets gekozen = elke maand)</span>
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby="months-label">
          {MONTHS_SHORT.map((m, i) => {
            const on = months.includes(i + 1);
            return (
              <button
                key={m}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  const next = on ? months.filter((x) => x !== i + 1) : [...months, i + 1].sort((a, b) => a - b);
                  onChange({ ...value, months: next.length && next.length < 12 ? next : undefined });
                }}
                className={cx(CHIP, 'min-w-11 px-2.5', on ? CHIP_ON : CHIP_OFF)}
              >
                {m}
              </button>
            );
          })}
          <Button size="sm" variant="ghost" type="button" onClick={() => onChange({ ...value, months: [1, 4, 7, 10] })}>
            Elk kwartaal
          </Button>
        </div>
      </div>
    </>
  );
}

/** "08:15" for an interval anchor (an ISO instant), in this computer's time: the value of the time field (always 24 hours). */
function anchorTime(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
}

function SchedulePicker({ value, onChange }: { value: Schedule; onChange(s: Schedule): void }) {
  const [unit, setUnit] = useState<'min' | 'hour' | 'day'>(() => {
    if (value.kind !== 'interval') return 'min';
    return value.everyMinutes % 1440 === 0 ? 'day' : value.everyMinutes % 60 === 0 ? 'hour' : 'min';
  });
  const factor = unit === 'day' ? 1440 : unit === 'hour' ? 60 : 1;
  const setKind = (k: string) => {
    if (k === value.kind) return;
    if (k === 'weekly') onChange({ kind: 'weekly', days: [1, 2, 3, 4, 5], times: ['09:00'] });
    else if (k === 'monthly') onChange({ kind: 'monthly', days: [1], times: value.kind === 'weekly' ? value.times : ['09:00'] });
    else if (k === 'interval') onChange({ kind: 'interval', everyMinutes: 60 }), setUnit('hour');
    else if (k === 'once') {
      const d = new Date(Date.now() + 3600_000);
      const pad = (n: number) => String(n).padStart(2, '0');
      onChange({ kind: 'once', at: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00` });
    } else if (k === 'cron') onChange({ kind: 'cron', expr: value.kind === 'weekly' ? `${Number(value.times[0]?.split(':')[1] || 0)} ${Number(value.times[0]?.split(':')[0] || 9)} * * ${value.days.join(',') || '*'}` : '0 9 * * 1-5' });
    else onChange({ kind: 'none' });
  };
  return (
    <div className="space-y-3">
      <Field label="Wanneer">
        <Select value={value.kind} onChange={(e) => setKind(e.target.value)}>
          <option value="weekly">Op vaste dagen en tijden</option>
          <option value="monthly">Elke maand (vaste dag, laatste werkdag …)</option>
          <option value="interval">Steeds na een vaste tijd (interval)</option>
          <option value="once">Eenmalig</option>
          <option value="cron">Cron-schema (gevorderd)</option>
          <option value="none">Geen schema (alleen handmatig of via trigger)</option>
        </Select>
      </Field>

      {value.kind === 'weekly' && (
        <>
          <div>
            <div className="mb-1.5 text-sm font-medium" id="days-label">
              Dagen
            </div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby="days-label">
              {DAY_ORDER.map((d) => {
                const on = value.days.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    onClick={() => onChange({ ...value, days: on ? value.days.filter((x) => x !== d) : [...value.days, d].sort() })}
                    className={cx(CHIP, 'min-w-11 px-2.5', on ? CHIP_ON : CHIP_OFF)}
                  >
                    {dayShort(d)}
                  </button>
                );
              })}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Button size="sm" variant="ghost" type="button" onClick={() => onChange({ ...value, days: [0, 1, 2, 3, 4, 5, 6] })}>
                Elke dag
              </Button>
              <Button size="sm" variant="ghost" type="button" onClick={() => onChange({ ...value, days: [1, 2, 3, 4, 5] })}>
                Werkdagen
              </Button>
              <Button size="sm" variant="ghost" type="button" onClick={() => onChange({ ...value, days: [0, 6] })}>
                Weekend
              </Button>
            </div>
          </div>
          <TimesEditor times={value.times} onChange={(times) => onChange({ ...value, times })} />
        </>
      )}

      {value.kind === 'monthly' && <MonthlyFields value={value} onChange={onChange} />}

      {value.kind === 'interval' && (
        <Field
          label="Elke"
          hint={value.anchor ? t('Loopt om {0} en daarna steeds na deze tijd.', formatTime(value.anchor)) : 'Zonder begintijd telt het vanaf het opslaan.'}
        >
          <div className="flex flex-wrap items-center gap-2">
            <NumberInput aria-label="Aantal" value={Math.round(value.everyMinutes / factor)} min={1} onChange={(n) => onChange({ ...value, everyMinutes: Math.max(1, Math.round((n || 1) * factor)) })} />
            <Select
              aria-label="Eenheid"
              className="w-32"
              value={unit}
              onChange={(e) => {
                const u = e.target.value as typeof unit;
                const f = u === 'day' ? 1440 : u === 'hour' ? 60 : 1;
                setUnit(u);
                onChange({ ...value, everyMinutes: Math.max(1, Math.round(value.everyMinutes / factor) * f) });
              }}
            >
              <option value="min">minuten</option>
              <option value="hour">uur</option>
              <option value="day">dagen</option>
            </Select>
            <span className="text-sm text-muted">vanaf</span>
            {/* The anchor: "elke 2 uur vanaf 08:15" runs at 08:15, 10:15, … (A-64). Empty = from the moment of saving. */}
            <Input
              type="time"
              className="w-32"
              aria-label="Begintijd van het interval"
              value={value.anchor ? anchorTime(value.anchor) : ''}
              onChange={(e) => {
                const t = e.target.value;
                if (!/^\d{2}:\d{2}$/.test(t)) return onChange({ kind: 'interval', everyMinutes: value.everyMinutes });
                const d = new Date();
                d.setHours(Number(t.slice(0, 2)), Number(t.slice(3, 5)), 0, 0);
                onChange({ ...value, anchor: d.toISOString() });
              }}
            />
          </div>
        </Field>
      )}

      {value.kind === 'once' && (
        <Field label="Datum en tijd">
          <Input type="datetime-local" value={value.at} onChange={(e) => onChange({ kind: 'once', at: e.target.value })} className="w-60" />
        </Field>
      )}

      {value.kind === 'cron' && (
        <Field label="Cron-expressie" hint={<MoreInfo>Voorbeelden: “0 9 * * 1-5” (werkdagen 09:00), “*/30 * * * *” (elk half uur).</MoreInfo>}>
          <Input value={value.expr} onChange={(e) => onChange({ kind: 'cron', expr: e.target.value })} className="font-mono" spellCheck={false} />
        </Field>
      )}
    </div>
  );
}

interface Preview {
  ok: boolean;
  error?: string;
  text?: string;
  next?: { at: string; text: string }[];
  runsPerDay?: number;
}

function SchedulePreview({ schedule, timezone, maxRunsPerDay }: { schedule: Schedule; timezone: string; maxRunsPerDay: number }) {
  const [p, setP] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const key = JSON.stringify({ schedule, timezone });
  useEffect(() => {
    let alive = true;
    setLoading(true);
    const t = setTimeout(() => {
      api
        .post<Preview>('/routines/preview', { schedule, timezone })
        .then((r) => alive && setP(r))
        .catch((e) => alive && setP({ ok: false, error: e.message }))
        .finally(() => alive && setLoading(false));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (schedule.kind === 'none') return <div className="text-sm text-muted">Deze routine draait alleen via “Nu testen” of een trigger.</div>;
  if (!p) return <Skeleton className="h-[4.25rem] rounded-control" />;
  if (!p.ok) return <div className="text-sm text-danger" role="alert">{p.error}</div>;
  return (
    <div className={cx('space-y-1 rounded-control bg-surface-2 px-3 py-2.5 text-sm transition-opacity', loading && 'opacity-60')} aria-live="polite">
      <div className="flex items-start gap-2 font-medium">
        <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
        {p.text}
      </div>
      {!!p.next?.length && (
        <div className="ps-6 text-[13px] text-muted">
          Eerstvolgende: {p.next.slice(0, 3).map((n) => n.text).join(' · ')}
        </div>
      )}
      {maxRunsPerDay > 0 && (p.runsPerDay || 0) > maxRunsPerDay && (
        <div className="flex items-start gap-1.5 text-warn">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          Dit schema draait ongeveer {p.runsPerDay}× per dag, maar de daglimiet van deze routine is {maxRunsPerDay}. Verhoog de limiet of kies een ruimer schema.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Where and when exactly the run happens, what happens at an engine limit, and which routine starts after it. */
function RunFields({ d, set, setOpt, routineId, meta }: { d: Draft; set(p: Partial<Draft>): void; setOpt(p: Partial<RoutineOptions>): void; routineId?: string; meta: Meta }) {
  // All routines (with their own "Daarna starten"): the picker refuses a choice that would come back here (a loop).
  const [all, setAll] = useState<ChainNode[]>([]);
  useEffect(() => {
    api
      .get<RoutineView[]>('/routines')
      .then((l) => setAll(l.map((r) => ({ id: r.id, name: r.name, status: r.status, paused_reason: r.paused_reason, options: { then: r.options?.then || null } }))))
      .catch(() => setAll([]));
  }, [routineId]);
  const routines = all.filter((r) => r.id !== routineId);
  const loopOf = (id: string) => chainLoop(all, routineId, d.name || 'deze routine', id);
  const next = routines.find((r) => r.id === d.options.then?.routineId);
  const nextLoop = next ? loopOf(next.id) : null;
  const o = d.options;
  const tzList = useMemo(() => (meta.timezones.includes(d.timezone) ? meta.timezones : [d.timezone, ...meta.timezones]), [meta.timezones, d.timezone]);
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Waar draait de routine" hint={o.runIn === 'main' ? 'De bot houdt de context van zijn gewone chat.' : 'Elke run begint met een schone lei.'}>
          <Select value={o.runIn || 'thread'} onChange={(e) => setOpt({ runIn: e.target.value as any })} aria-label="Waar draait de routine">
            <option value="thread">In een eigen routinegesprek</option>
            <option value="main">In de hoofdchat van de bot</option>
          </Select>
        </Field>
        <Field label="Tijdzone">
          <Select value={d.timezone} onChange={(e) => set({ timezone: e.target.value })} aria-label="Tijdzone">
            {tzList.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Gemiste runs" hint={<MoreInfo>{t('“Gemist” = TeamBot draaide niet en zou meer dan {0, plural, one {# minuut} other {# minuten}} te laat zijn.', meta.graceMinutes)}</MoreInfo>}>
        <Select value={o.missedPolicy} onChange={(e) => setOpt({ missedPolicy: e.target.value as any })} aria-label="Gemiste runs">
          <option value="catchup">Eén keer inhalen bij opstarten</option>
          <option value="skip">Overslaan (wel zichtbaar in de historie)</option>
        </Select>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Als de limiet van de AI-engine is bereikt" hint={o.important ? 'Belangrijk werk wacht altijd op de reset, wat je hier ook kiest.' : undefined}>
          <Select value={o.limitPolicy || 'wait'} onChange={(e) => setOpt({ limitPolicy: e.target.value as any })} aria-label="Bij een limiet">
            <option value="wait">Wachten tot de reset en dan opnieuw</option>
            <option value="skip">Deze run overslaan</option>
            <option value="fail">Als fout melden</option>
          </Select>
        </Field>
        {(o.limitPolicy || 'wait') === 'wait' && (
          <Field label="Maximaal wachten (uur)">
            <NumberInput aria-label="Maximaal wachten in uren" value={o.maxLimitWaitHours ?? 12} min={1} max={168} onChange={(n) => setOpt({ maxLimitWaitHours: n })} />
          </Field>
        )}
      </div>
      <Field label="Daarna starten" hint="Is deze routine klaar, dan start de routine die je hier kiest.">
        <Select value={o.then?.routineId || ''} aria-label="Daarna starten" onChange={(e) => setOpt({ then: e.target.value ? { routineId: e.target.value, on: o.then?.on || 'done', passResult: o.then?.passResult ?? true } : null })}>
          <option value="">Niets</option>
          {routines.map((r) => {
            const loop = loopOf(r.id);
            return (
              <option key={r.id} value={r.id} disabled={!!loop && r.id !== o.then?.routineId}>
                {chainOptionLabel(r, loop)}
              </option>
            );
          })}
        </Select>
      </Field>
      {nextLoop && (
        <div className="flex items-start gap-1.5 rounded-control bg-danger-soft px-3 py-2.5 text-sm text-danger" role="alert">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{chainLoopText(nextLoop)} Kies een andere routine of “Niets”; opslaan lukt zo niet.</span>
        </div>
      )}
      {next && !nextLoop && chainWarning(next) && (
        <div className="flex items-start gap-1.5 rounded-control bg-warn-soft px-3 py-2.5 text-sm text-warn" role="status">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {chainWarning(next)}{' '}
            <a className="underline" href={`#/m/routines/r/${next.id}`}>
              Naar die routine
            </a>
          </span>
        </div>
      )}
      {o.then && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Wanneer">
            <Select value={o.then.on} onChange={(e) => setOpt({ then: { ...o.then!, on: e.target.value as any } })} aria-label="Wanneer de volgende routine start">
              <option value="done">Alleen na een resultaat</option>
              <option value="always">Altijd (ook na “niets nieuws” of een fout)</option>
            </Select>
          </Field>
          <div className="sm:pt-6">
            <Toggle checked={o.then.passResult} onChange={(v) => setOpt({ then: { ...o.then!, passResult: v } })} label="Resultaat doorgeven aan de volgende routine" />
          </div>
        </div>
      )}
    </>
  );
}

export function RoutineEditor({ meta, initial, onSave, onCancel, saveLabel = 'Opslaan', routineId }: { meta: Meta; initial: Draft; onSave(d: Draft): Promise<void>; onCancel?(): void; saveLabel?: string; routineId?: string }) {
  const agents = useApp((s) => s.agents);
  const providers = useApp((s) => s.providers);
  const [d, setD] = useState<Draft>(initial);
  const [groups, setGroups] = useState<ToolGroup[]>([]);
  const { busy, run } = useAsync();
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    api
      .get<{ groups: ToolGroup[] }>('/tools')
      .then((r) => setGroups(r.groups))
      .catch(() => setGroups([]));
    if (!initial.name) first.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const agent = agents.find((a) => a.id === d.agent_id);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const setOpt = (p: Partial<RoutineOptions>) => setD((x) => ({ ...x, options: { ...x.options, ...p } }));
  const ov = d.options.override || {};
  const setOv = (p: Partial<RoutineOptions['override']>) => setOpt({ override: { ...ov, ...p } });
  const agentRank = ACCESS.find((a) => a.id === agent?.access_mode)?.rank ?? 3;
  const agentGroups = useMemo(() => groups.filter((g) => !g.always && agent?.tool_groups.includes(g.id)), [groups, agent]);

  const valid = d.name.trim() && d.prompt.trim() && d.agent_id;
  const submit = () => run(() => onSave({ ...d, options: { ...d.options, override: cleanOverride(ov) } }));

  if (!agents.length)
    return (
      <Card className="p-5 text-sm text-muted">
        Je hebt nog geen bot. Maak eerst een bot aan via <a className="text-accent underline" href="#/agents/new">Nieuwe bot</a>.
      </Card>
    );

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) submit();
      }}
    >
      <Card className="space-y-4 p-4 sm:p-5">
        <Field label="Naam">
          <Input ref={first} value={d.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} placeholder="Bijv. Ochtendoverzicht" required />
        </Field>
        <Field label="Bot">
          <Select value={d.agent_id} onChange={(e) => set({ agent_id: e.target.value })} aria-label="Bot">
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Opdracht" hint={<MoreInfo>Schrijf het als opdracht: wat moet de bot bij elke run doen?</MoreInfo>}>
          <Textarea rows={5} value={d.prompt} maxLength={20000} onChange={(e) => set({ prompt: e.target.value })} placeholder="Bijv. Vat de belangrijkste nieuwe e-mails van vandaag samen in 5 punten." required />
        </Field>
      </Card>

      <Card className="space-y-4 p-4 sm:p-5">
        <SchedulePicker value={d.schedule} onChange={(schedule) => set({ schedule })} />
        <SchedulePreview schedule={d.schedule} timezone={d.timezone} maxRunsPerDay={d.options.maxRunsPerDay} />
      </Card>

      <Card className="space-y-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Toggle checked={!!d.options.important} onChange={(v) => setOpt({ important: v })} label="Belangrijk" />
          <MoreInfo className="text-xs text-muted">Belangrijk werk wacht liever op de reset dan door te gaan op een gratis model.</MoreInfo>
        </div>
        {/* Kosten vooraf (P3): what one run roughly costs; "Start na de reset" when it does not fit in the window. */}
        <CostEstimate
          routineId={routineId}
          agentId={routineId ? null : d.agent_id}
          important={!!d.options.important}
          startLabel={routineId ? t('Eén keer, los van het schema.') : undefined}
          onStartAfter={
            routineId
              ? async (at) => {
                  await api.post(`/routines/${routineId}/run-after`, { at });
                }
              : undefined
          }
        />
      </Card>

      {/* What is rarely changed: each fold opens to its controls. One that holds a chain opens by itself. */}
      <Fold title="Uitvoering" defaultOpen={!!initial.options.then} testId="routine-run">
        <RunFields d={d} set={set} setOpt={setOpt} routineId={routineId} meta={meta} />
      </Fold>

      <Fold title="Meldingen" testId="routine-notify">
        <Field label="Melding sturen">
          <Select value={d.options.notify} onChange={(e) => setOpt({ notify: e.target.value as any })} aria-label="Melding sturen">
            <option value="always">Bij elk resultaat en bij fouten</option>
            <option value="errors">Alleen bij fouten en pauzes</option>
            <option value="never">Nooit (alleen historie)</option>
          </Select>
        </Field>
        <DeliverField value={d.options.deliver || null} onChange={(deliver) => setOpt({ deliver })} agentId={d.agent_id} />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Toggle checked={d.options.hideSilentRuns} onChange={(v) => setOpt({ hideSilentRuns: v })} label="Stille runs verbergen in het gesprek" />
          <MoreInfo className="text-xs text-muted">Verberg runs zonder nieuws ook uit het gesprek.</MoreInfo>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Toggle checked={d.options.lastRunContext} onChange={(v) => setOpt({ lastRunContext: v })} label="Uitkomst van de vorige run meesturen" />
          <MoreInfo className="text-xs text-muted">Elke run start schoon. Zet dit aan om de vorige uitkomst mee te geven.</MoreInfo>
        </div>
        {d.options.lastRunContext && (
          <Field label="Maximaal aantal tekens">
            <NumberInput aria-label="Maximaal aantal tekens" value={d.options.lastRunChars} min={200} max={4000} step={100} onChange={(n) => setOpt({ lastRunChars: n })} />
          </Field>
        )}
      </Fold>

      <Fold title="Limieten, model en rechten" hint={(ov.provider_id || ov.access_mode || ov.tool_groups || ov.max_turns) && <Badge tone="accent">aangepast</Badge>} testId="routine-limits">
        {
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Max. runs per dag" hint="0 = geen limiet">
                <NumberInput aria-label="Max. runs per dag" value={d.options.maxRunsPerDay} min={0} onChange={(n) => setOpt({ maxRunsPerDay: n })} />
              </Field>
              <Field label="Max. kosten per dag (USD)" hint="Geschatte kosten; 0 = geen limiet">
                <NumberInput aria-label="Max. kosten per dag" value={d.options.maxCostPerDayUsd} min={0} step={0.1} onChange={(n) => setOpt({ maxCostPerDayUsd: n })} />
              </Field>
              <Field label="Nieuwe pogingen bij een storing">
                <NumberInput aria-label="Nieuwe pogingen" value={d.options.retries} min={0} max={5} onChange={(n) => setOpt({ retries: n })} />
              </Field>
              <Field label="Pauzeren na zoveel fouten op rij">
                <NumberInput aria-label="Pauzeren na fouten" value={d.options.pauseAfterFailures} min={1} max={50} onChange={(n) => setOpt({ pauseAfterFailures: n })} />
              </Field>
              <Field label="Maximale duur per run (minuten)" hint="0 = geen limiet">
                <NumberInput aria-label="Maximale duur" value={d.options.timeoutMinutes} min={0} max={20160} onChange={(n) => setOpt({ timeoutMinutes: n })} />
              </Field>
              <Field label="Max. stappen per run" hint="Leeg = instelling van de bot">
                <NumberInput aria-label="Max. stappen" value={ov.max_turns ?? NaN} min={1} max={200} onChange={(n) => setOv({ max_turns: Number.isFinite(n) ? n : undefined })} />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="AI-provider">
                <Select value={ov.provider_id || ''} onChange={(e) => setOv({ provider_id: e.target.value || null, model: e.target.value ? ov.model : '' })} aria-label="AI-provider">
                  <option value="">Zelfde als de bot</option>
                  {providers
                    .filter((p) => p.enabled)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label="Model" hint="Leeg = standaardmodel">
                <Input value={ov.model || ''} onChange={(e) => setOv({ model: e.target.value })} placeholder={ov.provider_id ? 'standaardmodel van provider' : agent?.model || ''} />
              </Field>
            </div>
            <Field label="Toegangsmodus" hint="Alleen gelijk aan of strenger dan de bot zelf.">
              <Select value={ov.access_mode || ''} onChange={(e) => setOv({ access_mode: e.target.value || undefined })} aria-label="Toegangsmodus">
                <option value="">Zelfde als de bot</option>
                {ACCESS.filter((a) => a.rank <= agentRank).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </Select>
            </Field>
            {agentGroups.length > 0 && (
              <div className="space-y-2">
                <Toggle
                  checked={Array.isArray(ov.tool_groups)}
                  onChange={(v) => setOv({ tool_groups: v ? agentGroups.map((g) => g.id) : null })}
                  label="Tools beperken voor deze routine"
                />
                {Array.isArray(ov.tool_groups) && (
                  <div className="flex flex-wrap gap-2" role="group" aria-label="Toegestane toolgroepen">
                    {agentGroups.map((g) => {
                      const on = ov.tool_groups!.includes(g.id);
                      return (
                        <button key={g.id} type="button" aria-pressed={on} className={cx(CHIP, 'px-3', on ? CHIP_ON : CHIP_OFF)} onClick={() => setOv({ tool_groups: on ? ov.tool_groups!.filter((x) => x !== g.id) : [...ov.tool_groups!, g.id] })}>
                          {g.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </>
        }
      </Fold>

      <div className="flex flex-wrap justify-end gap-2 pb-6">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Annuleren
          </Button>
        )}
        <Button type="submit" variant="primary" loading={busy} disabled={!valid}>
          {saveLabel}
        </Button>
      </div>
    </form>
  );
}

function cleanOverride(o: RoutineOptions['override']) {
  const out: RoutineOptions['override'] = {};
  if (o.provider_id) out.provider_id = o.provider_id;
  if (o.model) out.model = o.model;
  if (o.access_mode) out.access_mode = o.access_mode;
  if (Array.isArray(o.tool_groups)) out.tool_groups = o.tool_groups;
  if (o.max_turns && Number.isFinite(o.max_turns)) out.max_turns = o.max_turns;
  if (o.deny_tools?.length) out.deny_tools = o.deny_tools;
  return out;
}
