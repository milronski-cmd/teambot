import { useState } from 'react';
import type React from 'react';
import { Check, Copy, ExternalLink, QrCode, RefreshCw, Smartphone } from 'lucide-react';
import { api } from '../../lib/api';
import { t, translate } from '../../lib/i18n';
import { Button, Field, Input, Modal, Spinner, cx, timeAgo, useAsync, copyText } from '../../components/ui';
import { ConnectCard, ConnectResult, type ConnectState } from '../../components/ConnectCard';
import { clientLabel, linkButton, type Device, type Reach } from './parts';
import type { Pairing } from './pairing';

function PairStep({ n, title, done, children }: { n: number; title: string; done?: boolean; children: React.ReactNode }) {
  return (
    <li className="flex gap-3 py-3 first:pt-0 last:pb-0" data-step={n}>
      <span className={cx('flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold', done ? 'bg-ok-soft text-ok' : 'bg-accent-soft text-accent')} aria-hidden>
        {done ? <Check className="h-3.5 w-3.5" /> : n}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <h4 className="text-sm font-semibold">
          <span className="sr-only">{t('Stap {0}:', n)} </span>
          {title}
        </h4>
        {children}
      </div>
    </li>
  );
}

/**
 * Can a paired phone reach this computer now? Seen from the computer: the TeamBot connection runs, or an address a
 * phone can use is ready. 'off': the owner switched the TeamBot connection off and there is no other way in.
 */
function linkState(reach: Reach | null): 'unknown' | 'ok' | 'off' | 'down' {
  if (!reach) return 'unknown';
  if (reach.iroh?.running || reach.candidates.some((c) => c.kind !== 'iroh' && c.ready)) return 'ok';
  return reach.iroh?.available && !reach.iroh.enabled ? 'off' : 'down';
}

/**
 * Instellingen › Telefoon: ONE card on the shared connect pattern. No phone yet: get the app, scan the QR code that is
 * there right away, done. With a phone: its name, "Verbinding werkt" (or what is wrong and the one thing to do), rename
 * and revoke, and "Nog een telefoon koppelen". Addresses, Tailscale and the rest are under Meer opties.
 */
export function PairCard({ pair, reach, setReach, devices, devicesError, reloadDevices }: { pair: Pairing; reach: Reach | null; setReach(r: Reach): void; devices: Device[] | null; devicesError: string; reloadDevices(): void }) {
  const [revoking, setRevoking] = useState<Device | null>(null);
  const [renaming, setRenaming] = useState<Device | null>(null);
  const [newName, setNewName] = useState('');
  const { busy, run } = useAsync();
  const active = (devices || []).filter((d) => d.status === 'active');
  const { ticket: tk, status } = pair;
  const showQr = !!tk && status !== 'used';
  const waiting = showQr && status === 'waiting';
  const ios = reach?.app?.ios || null;
  const mmss = `${Math.floor(pair.left / 60)}:${String(pair.left % 60).padStart(2, '0')}`;
  const appOnly = tk?.via === 'iroh';
  const link = linkState(reach);
  const failed = !!pair.error || !!devicesError;

  let state: ConnectState = 'off';
  let label: string | undefined;
  if (failed) state = 'error';
  else if (waiting) ((state = 'busy'), (label = 'wacht op scan'));
  else if (showQr) label = status === 'expired' ? 'code verlopen' : 'code ingetrokken';
  else if (!devices || (pair.busy && !active.length)) state = 'busy';
  else if (active.length) state = link === 'ok' || link === 'unknown' ? 'on' : 'error';

  const names = active.map((d) => d.name).join(', ');
  const result = pair.error ? (
    <ConnectResult
      ok={false}
      next={
        <Button size="sm" loading={pair.busy} onClick={() => pair.make()} icon={<RefreshCw className="h-3.5 w-3.5" />}>
          Opnieuw proberen
        </Button>
      }
    >
      {pair.error}
    </ConnectResult>
  ) : devicesError ? (
    <ConnectResult ok={false}>{devicesError}</ConnectResult>
  ) : showQr || !active.length || link === 'unknown' ? null : link === 'ok' ? (
    <ConnectResult ok>
      <span className="font-semibold">Verbinding werkt</span> · {t('Verbonden: {0}', names)}
    </ConnectResult>
  ) : (
    <ConnectResult
      ok={false}
      next={
        link === 'off' && reach?.isAdmin ? (
          <Button size="sm" loading={busy} onClick={() => run(async () => setReach(await api.put<Reach>('/mobile/iroh', { enabled: true })), 'TeamBot-verbinding aan')}>
            TeamBot-verbinding aanzetten
          </Button>
        ) : (
          reach?.iroh?.error || 'Kijk bij Instellingen › Meer mogelijkheden › Telefoonverbinding.'
        )
      }
    >
      Je telefoon kan deze computer nu niet bereiken.
    </ConnectResult>
  );

  return (
    <>
      <ConnectCard
        data-testid="pair-card"
        icon={<Smartphone />}
        tone="blue"
        title="Telefoon koppelen"
        line={active.length && !showQr ? undefined : ios ? 'Installeer de app en scan de code. Meer is het niet.' : 'Scan de code met de iPhone-app.'}
        state={state}
        stateLabel={label}
        action={
          showQr && active.length ? (
            <Button size="sm" variant="ghost" onClick={pair.close}>
              Sluiten
            </Button>
          ) : active.length && !pair.error ? (
            <Button size="sm" loading={pair.busy} onClick={() => pair.make()} icon={<QrCode className="h-3.5 w-3.5" />}>
              Nog een telefoon koppelen
            </Button>
          ) : undefined
        }
        result={
          result && (
            <div aria-live="polite" data-testid={showQr ? undefined : 'pair-status'}>
              {result}
            </div>
          )
        }
      >
        {showQr || !active.length ? (
          <ol className="divide-y divide-line">
            <PairStep n={1} title="Haal de app" done={active.length > 0}>
              {ios ? (
                <a href={ios} target="_blank" rel="noreferrer" className={linkButton}>
                  <Smartphone className="h-4 w-4" aria-hidden />
                  iPhone-app downloaden
                  <ExternalLink className="h-3.5 w-3.5 text-muted" aria-hidden />
                </a>
              ) : (
                // No public link (TEAMBOT_IOS_APP_URL): say so, instead of a button to TestFlight for an invitation that
                // does not exist. Without the app the browser works on the same wifi or with Tailscale.
                <div className="space-y-1 text-sm text-muted">
                  <p>De iPhone-app is nog niet openbaar. Heb je een uitnodiging voor TestFlight gekregen, installeer hem dan daarmee.</p>
                  <p>Zonder app: kies onder Instellingen › Meer mogelijkheden › Telefoonverbinding een adres voor de browser (zelfde wifi of Tailscale).</p>
                </div>
              )}
            </PairStep>

            <PairStep n={2} title="Scan de QR-code">
              {!showQr ? (
                pair.busy || !devices ? (
                  <div className="flex items-center gap-2 text-sm text-muted">
                    <Spinner className="h-4 w-4" /> QR-code maken…
                  </div>
                ) : (
                  !pair.error && (
                    <Button variant="primary" onClick={() => pair.make()} icon={<QrCode className="h-4 w-4" />}>
                      QR-code tonen
                    </Button>
                  )
                )
              ) : (
                <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
                  <div className="flex w-full max-w-[15rem] shrink-0 flex-col items-center gap-1.5">
                    <img src={tk!.qr} alt="QR-code om je telefoon te koppelen" className={cx('aspect-square w-full rounded-lg bg-white p-1.5', !waiting && 'opacity-20')} />
                    {waiting ? (
                      <span className="text-xs text-muted" aria-live="polite">
                        {t('Nog {0} geldig', mmss)}
                      </span>
                    ) : (
                      <Button size="sm" variant="primary" loading={pair.busy} onClick={() => pair.make()} icon={<RefreshCw className="h-3.5 w-3.5" />}>
                        Nieuwe QR-code
                      </Button>
                    )}
                  </div>
                  <div className="min-w-0 flex-1 space-y-2 text-sm">
                    <p>{appOnly ? 'Open TeamBot op je iPhone en tik op Scan de QR-code.' : 'Open TeamBot op je iPhone en tik op Scan de QR-code, of scan met de camera van je telefoon.'}</p>
                    {!appOnly && (
                      <>
                        <div>
                          <div className="text-xs text-muted">Of typ deze code in TeamBot op je telefoon:</div>
                          <div className="mt-0.5 select-all font-mono text-xl font-semibold tracking-widest" aria-label={t('Koppelcode {0}', tk!.code.split('').join(' '))}>
                            {tk!.code}
                          </div>
                        </div>
                        <p className="text-xs text-muted" data-testid="pair-via">
                          {tk!.via === 'both' ? t('Via {0}, en de TeamBot-verbinding voor onderweg.', tk!.base_url) : t('Via {0}.', tk!.base_url)}
                        </p>
                        {waiting && (
                          <Button size="sm" variant="ghost" onClick={() => copyText(tk!.url)} icon={<Copy className="h-3.5 w-3.5" />}>
                            Link kopiëren
                          </Button>
                        )}
                      </>
                    )}
                    <p className="text-xs text-muted">Deel deze code met niemand.</p>
                  </div>
                </div>
              )}
            </PairStep>

            <PairStep n={3} title="Verbonden">
              <div aria-live="polite" data-testid="pair-status" className="text-sm text-muted">
                {waiting ? (
                  <span className="inline-flex items-center gap-2">
                    <Spinner className="h-4 w-4" /> Wacht tot je telefoon de code scant…
                  </span>
                ) : (
                  'Zodra je telefoon de code scant, staat hier Verbonden.'
                )}
              </div>
            </PairStep>
          </ol>
        ) : (
          <ul className="divide-y divide-line" data-testid="paired-phones">
            {active.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-3 py-2 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1 basis-40">
                  <div className="font-medium">{d.name}</div>
                  <div className="text-xs text-muted">
                    {clientLabel(d.client)} · {d.last_seen ? t('laatst gezien {0}', timeAgo(d.last_seen)) : translate('nog niet gezien')}
                  </div>
                </div>
                <div className="flex gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => (setRenaming(d), setNewName(d.name))}>
                    Hernoemen
                  </Button>
                  <Button size="sm" onClick={() => setRevoking(d)}>
                    Intrekken
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </ConnectCard>

      <Modal
        open={!!revoking}
        onClose={() => setRevoking(null)}
        title="Toegang intrekken?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRevoking(null)}>
              Annuleren
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={() =>
                run(async () => {
                  await api.post(`/mobile/devices/${revoking!.id}/revoke`, {});
                  setRevoking(null);
                  reloadDevices();
                  // The last phone is gone: a new code right away, like the first time.
                  if (active.length === 1 && !showQr) void pair.make();
                }, 'Toegang ingetrokken')
              }
            >
              Intrekken
            </Button>
          </>
        }
      >
        <p className="text-sm">
          <strong>{revoking?.name}</strong> verliest meteen alle toegang. Opnieuw gebruiken kan alleen door opnieuw te koppelen.
        </p>
      </Modal>
      <Modal
        open={!!renaming}
        onClose={() => setRenaming(null)}
        title="Apparaat hernoemen"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              Annuleren
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!newName.trim()}
              onClick={() =>
                run(async () => {
                  await api.patch(`/mobile/devices/${renaming!.id}`, {
                    name: newName,
                  });
                  setRenaming(null);
                  reloadDevices();
                })
              }
            >
              Opslaan
            </Button>
          </>
        }
      >
        <Field label="Naam">
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={60} autoFocus />
        </Field>
      </Modal>
    </>
  );
}
