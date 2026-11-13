import { useEffect, useState } from 'react';
import { ChevronDown, Eye, HeartPulse, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api';
import { t } from '../../lib/i18n';
import { useApp } from '../../lib/store';
import { formatBytes, formatDateTime, formatNumber, formatPercent, formatSeconds } from '../../lib/format';
import { Button, Card, CardHead, Spinner, Toggle, cx, useAsync } from '../../components/ui';

type Level = 'ok' | 'warn' | 'bad';
type Reason = { code: 'stalls1s'; n: number; longestMs: number } | { code: 'stalls100'; n: number } | { code: 'longStall'; ms: number } | { code: 'slow'; p99: number } | { code: 'memory'; mb: number };

interface Health {
  level: Level;
  reasons: Reason[];
  startedAt: string;
  sampleEverySeconds: number;
  keptHours: number;
  now: { loop: { p50: number; p99: number; max: number }; cpu: number; busy: number; mem: { rssMb: number; heapUsedMb: number }; handles: number; runs: number };
  lastHour: { minutes: number; stalls100: number; stalls1s: number; longestMs: number; totalStallMs: number; p99: number; rssMaxMb: number; cpuAvg: number };
  sinceStart: { stalls100: number; stalls1s: number; longestMs: number; totalStallMs: number; pauses: number; peakRssMb: number };
  /** The watchdog outside the app (0.4.4, P14). */
  watchdog?: { notify: boolean; finding: { at: string; status: 'ok' | 'down' | 'hang' | 'stopped'; since?: string | null; detail?: string } | null; task: 'on' | 'missing' | 'none' };
}

/**
 * Wachter buiten de app: a scheduled task checks every 10 minutes whether TeamBot runs and answers, also after a crash,
 * without AI (build/watchdog.ps1). Shows what it last found and lets the owner switch its message off.
 */
function WatchdogCard({ w, onChange }: { w: NonNullable<Health['watchdog']>; onChange(notify: boolean): void }) {
  const { busy, run } = useAsync();
  const f = w.finding;
  const found = !f
    ? w.task === 'on'
      ? 'De wachter heeft nog niet gekeken.'
      : 'De wachter heeft nog niet gekeken. Hij hoort bij de geïnstalleerde TeamBot op Windows.'
    : f.status === 'ok'
      ? t('Laatste controle {0}: TeamBot draait en antwoordt.', formatDateTime(f.at))
      : f.status === 'stopped'
        ? t('Laatste controle {0}: TeamBot was netjes afgesloten.', formatDateTime(f.at))
        : f.status === 'down'
          ? t('Laatste controle {0}: TeamBot draaide niet (sinds {1}).', formatDateTime(f.at), formatDateTime(f.since || f.at))
          : t('Laatste controle {0}: TeamBot reageerde niet (sinds {1}).', formatDateTime(f.at), formatDateTime(f.since || f.at));
  return (
    <Card className="space-y-3 p-5" id="wachter">
      <CardHead icon={Eye} tone="teal" title="Wachter buiten de app" hint="Elke 10 minuten controleert Windows of TeamBot nog antwoordt." />
      <p className={cx('text-sm', f && (f.status === 'down' || f.status === 'hang') ? 'text-warn' : '')} data-watchdog={f?.status || 'none'}>
        {found}
      </p>
      {w.task === 'missing' && <p className="text-sm text-warn">De taak van de wachter staat niet in Windows. Installeer TeamBot opnieuw om hem terug te zetten.</p>}
      <Toggle
        checked={w.notify}
        disabled={busy}
        onChange={(v) =>
          run(async () => {
            const r = await api.put<{ notify: boolean }>('/health/watchdog', { notify: v });
            onChange(r.notify);
          })
        }
        label="Meld het als TeamBot niet draait of vastloopt"
      />
    </Card>
  );
}

const MB = 1024 * 1024;
const mem = (mb: number) => formatBytes(mb * MB);
const ms = (n: number) => formatNumber(Math.round(n), { style: 'unit', unit: 'millisecond', unitDisplay: 'short' });

const LINE: Record<Level, string> = { ok: 'bg-ok', warn: 'bg-warn-strong', bad: 'bg-danger' };

function headline(level: Level): string {
  if (level === 'bad') return 'TeamBot loopt vaak vast';
  if (level === 'warn') return 'TeamBot hapert soms';
  return 'Alles loopt soepel';
}

/** One plain sentence per reason, in the reader's language. */
function reasonText(r: Reason): string {
  switch (r.code) {
    case 'stalls1s':
      return t('{0, plural, one {Het afgelopen uur stond TeamBot één keer stil ({1}).} other {Het afgelopen uur stond TeamBot # keer stil (langste {1}).}}', r.n, formatSeconds(r.longestMs));
    case 'stalls100':
      return t('{0, plural, one {Het afgelopen uur haperde TeamBot # keer even.} other {Het afgelopen uur haperde TeamBot # keer even.}}', r.n);
    case 'longStall':
      return t('Eén keer stond TeamBot {0} stil.', formatSeconds(r.ms));
    case 'slow':
      return t('TeamBot reageerde het afgelopen uur soms traag (tot {0} wachten).', ms(r.p99));
    case 'memory':
      return t('TeamBot gebruikt veel geheugen: {0}.', mem(r.mb));
  }
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-line py-2 last:border-b-0">
      <dt className="text-muted">{label}</dt>
      <dd className="text-end tabular-nums">{children}</dd>
    </div>
  );
}

/** Instellingen › Status van TeamBot: one coloured line for everyone, the meter's numbers behind "Meer informatie". */
export function HealthSettings() {
  const [h, setH] = useState<Health | null>(null);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const device = useApp((s) => s.device);
  const load = async () => {
    setBusy(true);
    try {
      setH(await api.get<Health>('/health'));
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 15_000);
    return () => clearInterval(iv);
  }, []);

  if (!h && failed)
    return (
      <Card className="space-y-3 p-5">
        <CardHead icon={HeartPulse} tone="teal" title="Status van TeamBot" />
        <p className="text-sm text-muted">De meting kon niet worden opgehaald. Probeer het zo nog eens.</p>
        <Button onClick={() => void load()} loading={busy} icon={<RefreshCw className="h-4 w-4" />}>
          Opnieuw proberen
        </Button>
      </Card>
    );
  if (!h) return <Spinner />;

  const reasons = h.reasons.map(reasonText);
  const s = h.sinceStart;
  const hr = h.lastHour;
  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-5" id="hoe-gaat-het">
        <div className="space-y-2">
          <CardHead icon={HeartPulse} tone="teal" title={headline(h.level)} />
          <div className={cx('h-2 rounded-full', LINE[h.level])} aria-hidden data-level={h.level} />
        </div>
        {h.level === 'ok' ? (
          <p className="text-sm text-muted">{t('TeamBot reageert snel en gebruikt nu {0} geheugen.', mem(h.now.mem.rssMb))}</p>
        ) : (
          <div className="space-y-2 text-sm">
            {reasons.map((r) => (
              <p key={r}>{r}</p>
            ))}
            <p className="text-muted">
              Blijft het zo, herstart TeamBot dan.{' '}
              {!device && (
                <>
                  Wil je hulp? Download het diagnosebestand bij{' '}
                  <a className="underline hover:text-fg" href="#/settings/data">
                    Privacy en gegevens
                  </a>
                  : daar staan deze cijfers ook in.
                </>
              )}
            </p>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="inline-flex min-h-9 items-center gap-1 text-[13px] font-semibold text-muted hover:text-fg coarse:min-h-11" aria-expanded={more} aria-controls="hoe-gaat-het-meer" onClick={() => setMore((x) => !x)}>
            Meer informatie <ChevronDown className={cx('h-4 w-4 transition-transform', more && 'rotate-180')} aria-hidden />
          </button>
          <Button variant="ghost" size="sm" onClick={() => void load()} loading={busy} icon={<RefreshCw className="h-4 w-4" />}>
            Vernieuwen
          </Button>
        </div>
        {more && (
          <div id="hoe-gaat-het-meer" className="space-y-3">
            <dl className="text-sm">
              <Row label="Wachttijd nu, gewoonlijk">{ms(h.now.loop.p50)}</Row>
              <Row label="Wachttijd nu, traagste moment">{ms(Math.max(h.now.loop.p99, h.now.loop.max))}</Row>
              <Row label="Haperingen (langer dan 0,1 seconde)">{t('{0} het afgelopen uur, {1} sinds de start', formatNumber(hr.stalls100), formatNumber(s.stalls100))}</Row>
              <Row label="Stilstand (langer dan 1 seconde)">{t('{0} het afgelopen uur, {1} sinds de start', formatNumber(hr.stalls1s), formatNumber(s.stalls1s))}</Row>
              <Row label="Langste stilstand sinds de start">{s.longestMs ? formatSeconds(s.longestMs) : 'geen'}</Row>
              <Row label="Alle stilstand bij elkaar sinds de start">{formatSeconds(s.totalStallMs)}</Row>
              <Row label="Geheugen">{t('{0} (hoogste sinds de start: {1})', mem(h.now.mem.rssMb), mem(Math.max(s.peakRssMb, h.now.mem.rssMb)))}</Row>
              <Row label="Waarvan voor JavaScript">{mem(h.now.mem.heapUsedMb)}</Row>
              <Row label="Processor, het afgelopen uur">{t('{0} van één kern', formatPercent(hr.cpuAvg))}</Row>
              <Row label="Open verbindingen, bestanden en timers">{formatNumber(h.now.handles)}</Row>
              <Row label="Taken die nu lopen">{formatNumber(h.now.runs)}</Row>
              {s.pauses > 0 && <Row label="Computer sliep of TeamBot was gepauzeerd">{t('{0, plural, one {# keer} other {# keer}}', s.pauses)}</Row>}
            </dl>
            <p className="text-xs text-muted">
              {t('Gemeten sinds {0}; de laatste {1} uur blijft op deze computer.', formatDateTime(h.startedAt), h.keptHours)} Stilstand: TeamBot was zo lang met één ding bezig dat al het andere moest wachten. Het opstarten (de eerste twee minuten) telt niet mee voor de kleur.
            </p>
          </div>
        )}
      </Card>
      {h.watchdog && !device && <WatchdogCard w={h.watchdog} onChange={(notify) => setH((x) => (x && x.watchdog ? { ...x, watchdog: { ...x.watchdog, notify } } : x))} />}
    </div>
  );
}
