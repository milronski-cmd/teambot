import { useEffect, useState } from 'react';
import { AlarmClock, ArrowRight, Archive, CheckCircle2, ClipboardCheck, MessageCircle, RefreshCw, Undo2, Upload } from 'lucide-react';
import { Badge, Button, Card, Spinner, cx, toastError } from '../../components/ui';
import { navigate } from '../../lib/router';
import { t } from '../../lib/i18n';
import { formatDateTime } from '../../lib/format';
import { type Cutover, type CutoverChannel, type StepStatus, obApi } from './api';
import { Check } from './parts';
import { UndoButton } from './Undo';

/**
 * "Overstappen van OpenBot", step by step (Instellingen › Algemeen › Overstappen): back up both apps, import with
 * channels and routines paused, a few days side by side, then per channel the switch moment, then the routines on,
 * and the way back. Every status comes from the server (TeamBot's own state and a read-only look at OpenBot).
 * The plan in words: docs/OVERSTAPPEN_OPENBOT.md.
 */

type Step = Cutover['steps'][number];
const pick = <K extends Step['id']>(c: Cutover, id: K) => c.steps.find((s) => s.id === id) as Extract<Step, { id: K }>;

function StatusBadge({ s }: { s: StepStatus }) {
  if (s === 'done') return <Badge tone="ok">Klaar</Badge>;
  if (s === 'now') return <Badge tone="accent">Nu</Badge>;
  if (s === 'later') return <Badge>Later</Badge>;
  return null;
}

function StepCard({ n, icon, title, status, children }: { n: number; icon: React.ReactNode; title: string; status: StepStatus; children: React.ReactNode }) {
  return (
    <li className={cx('rounded-xl border border-line bg-surface p-4', status === 'now' && 'ring-1 ring-accent')} aria-label={t('Stap {0}: {1}', n, title)}>
      <div className="flex items-start gap-3">
        <span className={cx('flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold', status === 'done' ? 'bg-ok-soft text-ok' : 'bg-surface-3 text-fg')} aria-hidden>
          {status === 'done' ? <CheckCircle2 className="h-4 w-4" /> : n}
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-accent" aria-hidden>
              {icon}
            </span>
            <h3 className="font-semibold">{title}</h3>
            <StatusBadge s={status} />
          </div>
          {children}
        </div>
      </div>
    </li>
  );
}

function PhaseBadge({ c }: { c: CutoverChannel }) {
  if (c.phase === 'both') return <Badge tone="danger">Aan in beide apps</Badge>;
  if (c.phase === 'teambot') return <Badge tone="ok">In TeamBot</Badge>;
  if (c.phase === 'switch') return <Badge tone="accent">Uit in OpenBot: nu overzetten</Badge>;
  return <Badge>Nog in OpenBot</Badge>;
}

export function CutoverSteps() {
  const [c, setC] = useState<Cutover | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'' | 'check' | 'routines' | 'backup' | 'checked'>('');
  const [resumed, setResumed] = useState<{ started: string[]; skipped: { name: string; why: string }[] } | null>(null);

  const load = () =>
    obApi
      .cutover()
      .then((x) => {
        setC(x);
        setError('');
      })
      .catch((e) => setError(e?.message || String(e)));
  useEffect(() => {
    load();
  }, []);

  const run = async (what: typeof busy, fn: () => Promise<Cutover>) => {
    setBusy(what);
    try {
      setC(await fn());
    } catch (e) {
      toastError(e);
    } finally {
      setBusy('');
    }
  };

  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!c) return <Spinner />;
  const backup = pick(c, 'backup');
  const imp = pick(c, 'import');
  const check = pick(c, 'check');
  const channels = pick(c, 'channels');
  const routines = pick(c, 'routines');
  const back = pick(c, 'back');
  const ob = c.openbot;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">
          {!ob
            ? 'OpenBot is nog niet bekeken.'
            : ob.running
              ? t('OpenBot draait nu (bekeken {0}).', formatDateTime(ob.checkedAt))
              : t('OpenBot draait niet (bekeken {0}).', formatDateTime(ob.checkedAt))}
        </span>
        <Button size="sm" variant="ghost" loading={busy === 'check'} icon={<RefreshCw className="h-4 w-4" />} onClick={() => run('check', obApi.checkOpenBot)}>
          OpenBot bekijken
        </Button>
      </div>

      <ol className="space-y-3">
        <StepCard n={1} icon={<Archive className="h-4 w-4" />} title="Maak een back-up van beide apps" status={backup.status}>
          <p className="text-sm text-muted">Zo kun je altijd terug. Kopieer de OpenBot-mappen met OpenBot afgesloten.</p>
          <ul className="space-y-1 text-sm">
            <li>{backup.teambot ? t('TeamBot: laatste back-up {0}.', formatDateTime(backup.teambot.at)) : 'TeamBot: nog geen back-up.'}</li>
            <li className="flex items-start gap-2">
              <Check checked={!!backup.openbotConfirmedAt} disabled={busy === 'backup'} onChange={(v) => run('backup', () => obApi.mark('backup', v))} label="Ik heb OpenBot geback-upt" />
              <span>Ik heb OpenBot geback-upt (de mappen OpenBot in AppData\Roaming en in mijn gebruikersmap)</span>
            </li>
          </ul>
          <Button size="sm" icon={<ArrowRight className="h-4 w-4" />} onClick={() => navigate('/settings/backups')}>
            Naar Back-ups
          </Button>
        </StepCard>

        <StepCard n={2} icon={<Upload className="h-4 w-4" />} title="Importeer, met kanalen en routines op pauze" status={imp.status}>
          <p className="text-sm text-muted">Alles komt mee. Kanalen en routines staan uit, zodat niets dubbel draait.</p>
          {imp.at && imp.counts && (
            <p className="text-sm">
              {t('Overgenomen op {0}: {1, plural, one {# bot} other {# bots}}, {2, plural, one {# routine} other {# routines}} (uit), {3, plural, one {# kanaal} other {# kanalen}} (uit).', formatDateTime(imp.at), imp.counts.bots, imp.counts.routines, imp.counts.channels || 0)}
            </p>
          )}
          <Button size="sm" variant={imp.status === 'done' ? 'secondary' : 'primary'} icon={<ArrowRight className="h-4 w-4" />} onClick={() => navigate('/m/openbot-import')}>
            {imp.status === 'done' ? 'Opnieuw inlezen' : 'Importeer je OpenBot-team'}
          </Button>
        </StepCard>

        <StepCard n={3} icon={<ClipboardCheck className="h-4 w-4" />} title="Controleer je bots, een paar dagen naast elkaar" status={check.status}>
          <p className="text-sm text-muted">OpenBot blijft je echte team. Probeer je bots in TeamBot; berichten van buiten komen alleen bij OpenBot.</p>
          {imp.at && <p className="text-sm">{t('{0, plural, =0 {Vandaag geïmporteerd.} one {# dag geleden geïmporteerd.} other {# dagen geleden geïmporteerd.}}', check.days)}</p>}
          {check.channelsOn > 0 && <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-fg">{t('{0, plural, one {# overgenomen kanaal staat al aan in TeamBot.} other {# overgenomen kanalen staan al aan in TeamBot.}}', check.channelsOn)}</p>}
          <div className="flex items-start gap-2 text-sm">
            <Check checked={!!check.checkedAt} disabled={!imp.at || busy === 'checked'} onChange={(v) => run('checked', () => obApi.mark('check', v))} label="Mijn bots werken goed in TeamBot" />
            <span>Mijn bots werken goed in TeamBot</span>
          </div>
        </StepCard>

        <StepCard n={4} icon={<MessageCircle className="h-4 w-4" />} title="Zet je kanalen over, één voor één" status={channels.status}>
          <p className="text-sm text-muted">Per kanaal: eerst uit in OpenBot, dan aan in TeamBot. WhatsApp koppel je opnieuw met een QR-scan.</p>
          {channels.items.length === 0 ? (
            <p className="text-sm">Je OpenBot had geen kanalen. Telefoon koppelen kan via Instellingen › Telefoon.</p>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {channels.items.map((x) => (
                <li key={x.key} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                  <span className="font-medium">{x.label}</span>
                  {x.bot && <span className="text-xs text-muted">{x.bot}</span>}
                  <PhaseBadge c={x} />
                  <span className="ms-auto">
                    {x.teambot ? (
                      <Button size="sm" variant="ghost" onClick={() => navigate(`/m/channels/${x.teambot!.id}`)}>
                        Kanaal openen
                      </Button>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={() => navigate('/m/channels')}>
                        Opnieuw koppelen
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Button size="sm" variant="ghost" icon={<ArrowRight className="h-4 w-4" />} onClick={() => navigate('/settings/mobile-telefoon')}>
            Telefoon koppelen
          </Button>
        </StepCard>

        <StepCard n={5} icon={<AlarmClock className="h-4 w-4" />} title="Zet de routines aan" status={routines.status}>
          <p className="text-sm text-muted">Zet ze eerst uit in OpenBot, dan hier aan.</p>
          <p className="text-sm">{t('{0} van {1} aan in TeamBot.', routines.on, routines.wasOn)}</p>
          {ob?.running && !!routines.openbotActive && <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-fg">{t('{0, plural, one {# routine staat nog aan in OpenBot en blijft hier uit.} other {# routines staan nog aan in OpenBot en blijven hier uit.}}', routines.openbotActive)}</p>}
          {routines.customer.length > 0 && <p className="text-sm text-muted">{t('Klantenservice ({0}) zet je zelf aan bij Routines, nadat je een testrun hebt bekeken en goedgekeurd.', routines.customer.join(', '))}</p>}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={routines.status === 'now' ? 'primary' : 'secondary'}
              disabled={!imp.at || routines.on >= routines.wasOn}
              loading={busy === 'routines'}
              onClick={async () => {
                setBusy('routines');
                try {
                  const r = await obApi.resumeRoutines();
                  setResumed({ started: r.started, skipped: r.skipped });
                  setC(r.status);
                } catch (e) {
                  toastError(e);
                } finally {
                  setBusy('');
                }
              }}
            >
              Zet de routines aan
            </Button>
            <Button size="sm" variant="ghost" icon={<ArrowRight className="h-4 w-4" />} onClick={() => navigate('/m/routines')}>
              Naar Routines
            </Button>
          </div>
          {resumed && (
            <div className="space-y-1 text-sm" role="status">
              <p>{t('{0, plural, =0 {Er is geen routine aangezet.} one {# routine aangezet.} other {# routines aangezet.}}', resumed.started.length)}</p>
              {resumed.skipped.map((s, i) => (
                <p key={i} className="text-muted">
                  {t('{0} blijft uit: {1}', s.name, s.why)}
                </p>
              ))}
            </div>
          )}
        </StepCard>

        <StepCard n={6} icon={<Undo2 className="h-4 w-4" />} title="Terug naar OpenBot, als het nodig is" status={back.status}>
          <p className="text-sm text-muted">Zet het kanaal of de routines hier uit en in OpenBot weer aan, of maak de hele import ongedaan.</p>
          {back.undoable && <UndoButton onDone={() => load()} />}
        </StepCard>
      </ol>
    </div>
  );
}
