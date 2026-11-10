import { useCallback, useEffect, useState } from 'react';
import { Eye, Laptop, Monitor, MonitorSmartphone, MousePointer2, Power, ShieldCheck, Smartphone } from 'lucide-react';
import { on } from '../../lib/api';
import { navigate } from '../../lib/router';
import { t } from '../../lib/i18n';
import { askConfirm, Badge, Button, Card, EmptyState, Field, Page, PageHeader, Select, Spinner, Toggle, timeAgo, toast, toastError } from '../../components/ui';
import { ComputerOnly } from '../../shell/computerOnly';
import { IDLE_CHOICES, remote, type RemoteSessionInfo, type RemoteState } from './api';

export function useRemoteState() {
  const [data, setData] = useState<RemoteState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    remote
      .state()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e?.message || String(e)));
  }, []);
  useEffect(() => {
    load();
    const offs = [on('remote-desktop.state', load), on('remote-desktop.ended', load)];
    const timer = setInterval(load, 15_000);
    return () => {
      offs.forEach((o) => o());
      clearInterval(timer);
    };
  }, [load]);
  return { data, error, reload: load, setData };
}

export const idleLabel = (n: number) => t('{0, plural, one {Na # minuut zonder bediening} other {Na # minuten zonder bediening}}', n);

function deviceLabel(s: Pick<RemoteSessionInfo, 'deviceKind' | 'deviceName'>) {
  if (s.deviceName) return s.deviceName;
  return s.deviceKind === 'computer' ? t('Deze computer') : s.deviceKind === 'phone' ? t('Telefoon') : t('Een browser');
}

function SessionRow({ s, onStop }: { s: RemoteSessionInfo; onStop(): void }) {
  const Icon = s.deviceKind === 'phone' ? Smartphone : s.deviceKind === 'computer' ? Monitor : Laptop;
  return (
    <li className="flex flex-wrap items-center gap-3 py-2.5">
      <Icon className="h-5 w-5 shrink-0 text-muted" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">
          <span translate="no">{deviceLabel(s)}</span>
          {s.mine && <span className="ms-1.5 text-xs font-normal text-muted">(dit apparaat)</span>}
        </div>
        <div className="text-xs text-muted">{t('Begonnen {0}', timeAgo(s.since))}</div>
      </div>
      {s.view ? <Badge>Kijkt alleen mee</Badge> : s.controlling ? <Badge tone="warn">Bedient de computer</Badge> : <Badge tone="accent">Kijkt mee</Badge>}
      <Button size="sm" variant="danger" onClick={onStop} aria-label={t('Stop de sessie van {0}', deviceLabel(s))}>
        Stop
      </Button>
    </li>
  );
}

/** Instellingen › Bureaublad op afstand: on/off (only at the computer), options, who watches now, and the safety rules. */
export function RemotePage() {
  const { data: s, error, reload, setData } = useRemoteState();
  const [busy, setBusy] = useState(false);

  const save = async (body: Partial<Pick<RemoteState, 'enabled' | 'control' | 'idleMinutes'>>) => {
    setBusy(true);
    try {
      setData(await remote.configure(body));
      if (body.enabled === true) toast('Bureaublad op afstand staat aan', 'ok');
      if (body.enabled === false) toast('Bureaublad op afstand staat uit', 'ok');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const switchOn = async (v: boolean) => {
    if (!v) return save({ enabled: false });
    const ok = await askConfirm(
      t('Je gekoppelde telefoon en andere browsers kunnen dan je hele bureaublad zien en bedienen. Aanzetten?'),
      { ok: t('Aanzetten') },
    );
    if (ok) await save({ enabled: true });
  };
  const turnOff = async () => {
    setBusy(true);
    try {
      setData(await remote.off());
      toast('Bureaublad op afstand staat uit', 'ok');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const stopSession = async (id: string) => {
    try {
      await remote.end(id);
      reload();
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <Page>
      <PageHeader title="Bureaublad op afstand" subtitle="Bekijk en bedien je hele Windows-bureaublad vanaf je telefoon of vanaf een browser op een andere computer." width="3xl" />
      <div className="mx-auto max-w-3xl space-y-4 px-4 pb-8 sm:px-6">
        {error && !s ? (
          <EmptyState icon={<MonitorSmartphone className="h-8 w-8" />} title="Kon de status niet laden">
            {error}
          </EmptyState>
        ) : !s ? (
          <div className="flex justify-center p-8">
            <Spinner />
          </div>
        ) : (
          <>
            <Card className="space-y-4 p-4 sm:p-5">
              <div className="flex flex-wrap items-center gap-2">
                <MonitorSmartphone className="h-5 w-5 text-accent" aria-hidden />
                <h2 className="text-base font-bold">Status</h2>
                {s.enabled ? <Badge tone="warn">Staat aan</Badge> : <Badge>Staat uit</Badge>}
              </div>
              {!s.available && (
                <p className="text-sm leading-relaxed text-muted">
                  {s.unavailable === 'platform'
                    ? 'Dit werkt alleen als TeamBot op een Windows-computer draait.'
                    : 'Dit werkt alleen met de TeamBot-app op je Windows-computer.'}
                </p>
              )}
              {s.here ? (
                <div className="space-y-4">
                  {/* Not possible here and off: the note above says why; a greyed-out switch would only add noise. */}
                  {(s.enabled || s.available) && <Toggle checked={s.enabled} disabled={busy} onChange={switchOn} label={<span className="font-semibold">Bureaublad op afstand toestaan</span>} />}
                  <Toggle checked={s.control} disabled={busy} onChange={(v) => save({ control: v })} label="Ook bedienen met muis en toetsenbord (anders alleen meekijken)" />
                  <Field label="Stopt vanzelf" hint="Een sessie stopt na deze tijd zonder bediening.">
                    <Select value={String(s.idleMinutes)} disabled={busy} onChange={(e) => save({ idleMinutes: Number(e.target.value) })}>
                      {IDLE_CHOICES.map((n) => (
                        <option key={n} value={n}>
                          {idleLabel(n)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  {s.enabled && (
                    <p className="text-sm text-muted">
                      Open TeamBot op je telefoon en kies Meer › Instellingen › Telefoon › Bureaublad op afstand › <b>Bureaublad openen</b>.
                    </p>
                  )}
                </div>
              ) : s.enabled ? (
                <div className="space-y-3">
                  <p className="text-sm leading-relaxed text-muted">
                    {s.control ? 'Je kunt je computer zien en bedienen.' : 'Je kunt meekijken; bedienen staat op de computer uit.'}{' '}
                    {t('{0, plural, one {Stopt vanzelf na # minuut zonder bediening.} other {Stopt vanzelf na # minuten zonder bediening.}}', s.idleMinutes)}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="primary" icon={<MousePointer2 className="h-4 w-4" />} disabled={!s.available} onClick={() => navigate('#/m/remote-desktop/live')}>
                      Bureaublad openen
                    </Button>
                    <Button variant="secondary" icon={<Power className="h-4 w-4" />} loading={busy} onClick={turnOff}>
                      Uitzetten
                    </Button>
                  </div>
                </div>
              ) : (
                <ComputerOnly>Staat uit. Aanzetten kan alleen op de computer zelf (Instellingen › Telefoon › Bureaublad op afstand).</ComputerOnly>
              )}
              {s.here && s.enabled && (
                <div className="flex flex-wrap gap-2 border-t border-line pt-3">
                  <Button variant="secondary" size="sm" icon={<Eye className="h-4 w-4" />} disabled={!s.available} onClick={() => navigate('#/m/remote-desktop/live')}>
                    Probeer het hier
                  </Button>
                </div>
              )}
            </Card>

            <Card className="p-4 sm:p-5">
              <h2 className="text-base font-bold">Wie kijkt er mee</h2>
              {s.sessions.length ? (
                <ul className="mt-1 divide-y divide-line">
                  {s.sessions.map((x) => (
                    <SessionRow key={x.id} s={x} onStop={() => stopSession(x.id)} />
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-sm text-muted">Nu niemand.</p>
              )}
            </Card>

            {/* a <details> (open): its summary is something to focus, so the page also scrolls by keyboard on a phone */}
            <Card className="p-4 sm:p-5">
              <details open>
                <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
                  <ShieldCheck className="h-5 w-5 text-ok" aria-hidden />
                  <h2 className="text-base font-bold">Zo is het beveiligd</h2>
                </summary>
                <ul className="mt-2 list-disc space-y-1.5 ps-5 text-sm leading-relaxed text-muted">
                  <li>Standaard uit. Aanzetten kan alleen op deze computer zelf.</li>
                  <li>Alleen jij, de eigenaar, op je eigen ingelogde apparaten. Een sessie hoort bij het apparaat dat hem begon.</li>
                  <li>Zolang iemand meekijkt staat bovenaan een balk met Stop. Noodstop: Ctrl+Alt+Esc.</li>
                  <li>{t('Een sessie stopt vanzelf na {0, plural, one {# minuut} other {# minuten}} zonder bediening.', s.idleMinutes)}</li>
                  <li>TeamBot zelf is afgedekt en niet op afstand te bedienen.</li>
                  <li>Elke sessie staat in het logboek (Instellingen › Beveiliging), met apparaat, begin en einde.</li>
                </ul>
              </details>
            </Card>
          </>
        )}
      </div>
    </Page>
  );
}
