import { useEffect, useState } from 'react';
import { Globe, Network, QrCode, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react';
import { api } from '../../lib/api';
import { t } from '../../lib/i18n';
import { Badge, Button, Field, Input, Modal, Spinner, Toggle, timeAgo, useAsync } from '../../components/ui';
import { useAdvanced } from '../../shell/advanced';
import { MoreInfo } from '../../components/MoreInfo';
import { Dropdown, Segmented, SettingRow } from '../../components/SettingControls';
import { AUTO, Note, Section, isLoopbackUrl, type Reach } from './parts';
import type { Pairing } from './pairing';

/**
 * Meer opties: a QR code with a chosen address (Tailscale, wifi, an own tunnel or server) instead of TeamBot's choice.
 * The address is a dropdown that applies at once: choosing one makes a new code with it in the card above. An own
 * address is typed first (Enter or the button).
 */
export function AddressPicker({ reach, pair }: { reach: Reach | null; pair: Pairing }) {
  const cands = reach?.candidates || [];
  const [ownAddress, setOwnAddress] = useState(false);
  const [custom, setCustom] = useState('');
  const known = pair.base === AUTO || cands.some((c) => c.url === pair.base);
  const choice = ownAddress || !known ? 'custom' : pair.base;
  const chosen = cands.find((c) => c.url === choice);
  const customUrl = custom.trim();

  const apply = (base: string) => {
    if (!base) return;
    // Once the code has this address, the dropdown follows the code (Eigen adres stays shown for an own address).
    setOwnAddress(false);
    void pair.make(base).then(() => document.querySelector('[data-testid="pair-card"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  const pick = (v: string) => {
    if (v === 'custom') return setOwnAddress(true);
    setOwnAddress(false);
    apply(v);
  };

  return (
    <section className="space-y-2 rounded-lg border border-line p-3" aria-labelledby="tb-pair-address">
      <div>
        <h3 id="tb-pair-address" className="flex items-center gap-2 font-medium">
          <QrCode className="h-4 w-4 text-accent" aria-hidden />
          QR-code met een ander adres
        </h3>
        <p className="mt-0.5 text-xs text-muted">
          TeamBot kiest zelf hoe je telefoon deze computer bereikt. <MoreInfo>Wil je een vast adres, zoals Tailscale? Kies het hier.</MoreInfo>
        </p>
      </div>
      {!reach ? (
        <Spinner />
      ) : (
        <>
          <SettingRow label="Adres voor je telefoon">
            <Dropdown
              testId="pair-address"
              value={choice}
              onChange={pick}
              options={[
                { value: AUTO, label: 'Automatisch (TeamBot kiest)' },
                ...cands.map((c) => ({
                  value: c.url,
                  label: c.kind === 'iroh' ? c.label : `${c.label} · ${c.url}`,
                })),
                { value: 'custom', label: 'Eigen adres' },
              ]}
            />
          </SettingRow>
          {chosen && (
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
              {chosen.kind === 'iroh' ? <Badge tone="ok">versleuteld</Badge> : chosen.secure ? <Badge tone="ok">https</Badge> : <Badge tone="warn">http</Badge>}
              {!chosen.ready && chosen.kind !== 'iroh' && <Badge tone="warn">eerst instellen</Badge>}
              <span className="min-w-0">{chosen.note}</span>
            </p>
          )}
          {choice === 'custom' && (
            <div className="space-y-1">
              <div className="flex flex-wrap gap-2">
                <Input className="min-w-0 flex-1" value={custom} onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && apply(customUrl)} placeholder="https://teambot.voorbeeld.nl" aria-label="Eigen adres" />
                <Button loading={pair.busy} disabled={!customUrl} onClick={() => apply(customUrl)} icon={<QrCode className="h-4 w-4" />}>
                  QR-code met dit adres
                </Button>
              </div>
              <p className="text-xs text-muted">Bijvoorbeeld je Cloudflare Tunnel- of serveradres (https://…).</p>
            </div>
          )}
          {!cands.length && <Note tone="warn">Je telefoon kan deze computer nog niet bereiken. Kies hieronder bij Bereikbaarheid hoe.</Note>}
          {choice === 'custom' && customUrl && isLoopbackUrl(customUrl) && <Note tone="warn">Dit adres werkt alleen op deze computer zelf, niet op een telefoon.</Note>}
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ reachability

export function ReachSection({ reach, setReach, reload }: { reach: Reach | null; setReach(r: Reach): void; reload(): void }) {
  const [warn, setWarn] = useState(false);
  const [bind, setBind] = useState<'all' | 'tailscale' | 'loopback'>('all');
  const [port, setPort] = useState('');
  const { busy, run } = useAsync();
  useEffect(() => {
    if (!reach) return;
    setBind(reach.gateway.bind || 'all');
    setPort(reach.gateway.port ? String(reach.gateway.port) : '');
  }, [reach]);

  if (!reach)
    return (
      <Section icon={<Network className="h-5 w-5" />} title="Bereikbaarheid">
        <Spinner />
      </Section>
    );
  const gw = reach.gateway;
  const save = (patch: any, ok?: string) =>
    run(async () => {
      setReach(
        await api.put<Reach>('/mobile/gateway', {
          bind,
          port: port === '' ? null : Number(port),
          ...patch,
        }),
      );
    }, ok);
  const applyPort = () => gw.enabled && (port || null) !== (gw.port ? String(gw.port) : null) && void save({}, 'Opgeslagen');

  return (
    <Section
      icon={<Network className="h-5 w-5" />}
      title="Bereikbaarheid"
      subtitle="Je telefoon praat altijd met jóuw computer of server."
      actions={<Button size="sm" variant="ghost" onClick={reload} aria-label="Opnieuw controleren" icon={<RefreshCw className="h-3.5 w-3.5" />} />}
    >
      {!reach.policyActive && <Note tone="danger">De beveiligingslaag voor telefoons is niet actief; koppelen is daarom uitgeschakeld.</Note>}

      <IrohBlock reach={reach} setReach={setReach} />

      {/* phone gateway */}
      {reach.isAdmin ? (
        <div className="space-y-3 rounded-lg border border-line p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-medium">
              <ShieldCheck className="h-4 w-4 text-accent" aria-hidden />
              Telefoon-toegang via netwerk
            </div>
            <Toggle checked={!!gw.enabled} disabled={busy} onChange={(v) => (v ? setWarn(true) : save({ enabled: false }, 'Telefoon-toegang uit'))} label={gw.enabled ? 'Aan' : 'Uit'} />
          </div>
          <p className="text-xs text-muted">
            Een aparte poort die alleen gekoppelde telefoons doorlaat.{' '}
            <MoreInfo>
              {reach.server.loopbackOnly
                ? 'TeamBot luistert nu alleen op deze computer. Met telefoon-toegang opent TeamBot een aparte poort die alléén gekoppelde telefoons doorlaat (geen beheer, geen sleutels).'
                : 'Deze server luistert al op alle netwerken. Telefoon-toegang is een extra poort die alleen gekoppelde telefoons doorlaat.'}
            </MoreInfo>
          </p>
          <div className="divide-y divide-line">
            {/* While it is on, a change applies at once (the port restarts); while it is off, it is used when you turn it on. */}
            <SettingRow label="Bereikbaar via">
              <Segmented
                value={bind}
                disabled={busy}
                onChange={(v) => (setBind(v), gw.enabled && save({ bind: v }, 'Opgeslagen'))}
                options={[
                  { value: 'all', label: 'Alle netwerken' },
                  { value: 'tailscale', label: 'Alleen Tailscale' },
                  { value: 'loopback', label: 'Alleen deze computer' },
                ]}
              />
            </SettingRow>
            <SettingRow label="Poort" hint={`Leeg = ${gw.defaultPort || 'standaard'}`}>
              <Input
                inputMode="numeric"
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
                onBlur={applyPort}
                onKeyDown={(e) => e.key === 'Enter' && applyPort()}
                placeholder={String(gw.defaultPort || '')}
                disabled={busy}
                aria-label="Poort"
                className="w-28"
              />
            </SettingRow>
          </div>
          {gw.running && (
            <Note tone="ok">
              Actief op {gw.address}:{gw.port}
            </Note>
          )}
          {gw.enabled && !gw.running && gw.error && <Note tone="danger">Niet gestart: {gw.error}</Note>}
        </div>
      ) : (
        <Note>Je beheerder bepaalt hoe deze server bereikbaar is. De adressen die je kunt gebruiken staan hierboven bij Adres voor je telefoon.</Note>
      )}

      <p className="text-xs text-muted">
        Je computer moet aan staan. <MoreInfo>{'Staat je computer uit, dan toont je telefoon “niet bereikbaar”; berichten blijven als concept bewaard.'}</MoreInfo>
      </p>

      <Modal
        open={warn}
        onClose={() => setWarn(false)}
        title="Telefoon-toegang aanzetten?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setWarn(false)}>
              Annuleren
            </Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={() =>
                save({ enabled: true, acknowledge: true }).then(() => {
                  setWarn(false);
                })
              }
            >
              Ik begrijp het, zet aan
            </Button>
          </>
        }
      >
        <div className="space-y-2 text-sm">
          <p className="flex gap-2">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
            TeamBot opent dan een poort op {bind === 'all' ? 'al je netwerken (wifi en Tailscale)' : bind === 'tailscale' ? 'je Tailscale-netwerk' : 'deze computer (voor een tunnel)'}.
          </p>
          <ul className="list-disc space-y-1 ps-5 text-muted">
            <li>Alleen gekoppelde telefoons komen erdoor; beheer en sleutels blijven op deze computer.</li>
            <li>Via wifi is het verkeer niet versleuteld. Gebruik dit alleen thuis, of kies Tailscale.</li>
            <li>Windows kan vragen om TeamBot door de firewall te laten.</li>
          </ul>
        </div>
      </Modal>
    </Section>
  );
}

/**
 * The TeamBot connection (iroh): the iPhone app reaches this computer at home and away, end-to-end encrypted, without
 * Tailscale, an account or router settings. On/off and an own relay server (Geavanceerd) only here on the computer.
 */
export function IrohBlock({ reach, setReach }: { reach: Reach; setReach(r: Reach): void }) {
  const advanced = useAdvanced();
  const ir = reach.iroh;
  const own = ir?.relay?.own || '';
  const [relay, setRelay] = useState(own);
  const { busy, run } = useAsync();
  useEffect(() => setRelay(own), [own]);
  if (!reach.isAdmin || !ir) return null;
  if (!ir.available) return <Note>De TeamBot-verbinding (onderweg zonder Tailscale) werkt niet op deze computer. Gebruik Tailscale of wifi.</Note>;
  const put = (body: any, ok: string) =>
    run(async () => {
      setReach(await api.put<Reach>('/mobile/iroh', body));
    }, ok);
  const last = ir.last;
  return (
    <div className="space-y-3 rounded-lg border border-line p-3" data-testid="iroh-block">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-medium">
          <Globe className="h-4 w-4 text-accent" aria-hidden />
          TeamBot-verbinding (thuis en onderweg)
        </div>
        <Toggle checked={!!ir.enabled} disabled={busy} onChange={(v) => put({ enabled: v }, v ? 'TeamBot-verbinding aan' : 'TeamBot-verbinding uit')} label={ir.enabled ? 'Aan' : 'Uit'} />
      </div>
      <p className="text-xs text-muted">
        Je iPhone-app bereikt deze computer overal, versleuteld.{' '}
        <MoreInfo>
          Zonder Tailscale, account of instellingen in je router. Alles is versleuteld van je iPhone tot deze computer. Lukt een directe verbinding niet, dan loopt het verkeer via een relay-server die alleen versleutelde gegevens ziet.
        </MoreInfo>
      </p>
      {ir.running && (
        <Note tone="ok">
          {ir.relay?.online ? 'Actief en bereikbaar via de relay-server.' : 'Actief. Zoekt nog contact met de relay-server.'}
          {last ? ' ' + t('Laatste telefoon: {0}, {1}.', timeAgo(last.at), last.path === 'relay' ? t('via de relay-server') : last.path === 'direct' ? t('direct') : t('verbonden')) : ''}
        </Note>
      )}
      {ir.enabled && !ir.running && ir.error && <Note tone="danger">{ir.error}</Note>}
      {!ir.enabled && <p className="text-xs text-muted">{ir.offOnPurpose ? 'Je hebt hem uitgezet. TeamBot zet hem niet vanzelf weer aan.' : 'Gaat vanzelf aan als je een telefoon koppelt.'}</p>}
      {advanced ? (
        <Field label="Eigen relay-server" hint="Leeg = de gratis relay-servers van n0, bedoeld om te testen. Een eigen server staat in de handleiding.">
          <div className="flex flex-wrap gap-2">
            <Input className="min-w-0 flex-1" value={relay} onChange={(e) => setRelay(e.target.value)} placeholder="https://relay.voorbeeld.nl" aria-label="Eigen relay-server" disabled={busy} />
            <Button size="sm" loading={busy} disabled={relay.trim() === own} onClick={() => put({ relay: relay.trim() }, relay.trim() ? 'Eigen relay-server opgeslagen' : 'Terug naar de relay-servers van n0')}>
              Opslaan
            </Button>
          </div>
        </Field>
      ) : (
        own && <p className="text-xs text-muted">{t('Eigen relay-server: {0}', own)}</p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ one-click Tailscale

/** Tailscale on this PC + phone, one button: the QR code then carries the https address (Meer opties). */
export function TailscaleQuick({ reach, setReach }: { reach: Reach | null; setReach(r: Reach): void }) {
  const [warn, setWarn] = useState(false);
  const { busy, run } = useAsync();
  if (!reach?.isAdmin) return null;
  const ts = reach.tailscale;
  const https = reach.candidates.find((c) => c.kind === 'tailscale-https');
  const ready = !!https?.ready;
  const setup = () =>
    run(async () => {
      setWarn(false);
      setReach(await api.post<Reach>('/mobile/tailscale-https', { acknowledge: true }));
    }, 'Je telefoon kan TeamBot nu veilig bereiken');
  return (
    <Section icon={<ShieldCheck className="h-5 w-5" />} title="Tailscale" subtitle="Gratis: een privé, versleutelde verbinding tussen jouw eigen apparaten. Ook voor de web-app en Android.">
      <ol className="space-y-2 text-sm">
        <li className="flex flex-wrap items-center gap-2">
          <Badge tone={ts?.running ? 'ok' : 'warn'}>{ts?.running ? 'Klaar' : 'Stap 1'}</Badge>
          {ts?.running ? (
            <span>
              Tailscale is verbonden op deze computer
              {ts.dnsName ? ` (${ts.dnsName.split('.')[0]})` : ''}.
            </span>
          ) : ts?.installed ? (
            <span>Open Tailscale op deze computer en log in.</span>
          ) : (
            <span>
              Installeer Tailscale op deze computer en log in:{' '}
              <a className="underline" href="https://tailscale.com/download" target="_blank" rel="noreferrer">
                tailscale.com/download
              </a>
            </span>
          )}
        </li>
        <li className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral">Stap 2</Badge>
          <span>Zet de app Tailscale op je telefoon (App Store of Play Store) en log in met hetzelfde account.</span>
        </li>
        <li className="flex flex-wrap items-center gap-2">
          <Badge tone={ready ? 'ok' : 'neutral'}>{ready ? 'Klaar' : 'Stap 3'}</Badge>
          {ready ? (
            <span>
              Je TeamBot-adres: <strong className="break-all">{https!.url}</strong>
            </span>
          ) : (
            <Button size="sm" loading={busy} disabled={!ts?.running} onClick={() => setWarn(true)}>
              Telefoon via Tailscale instellen
            </Button>
          )}
        </li>
        <li className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral">Stap 4</Badge>
          <span>Maak bovenaan een nieuwe QR-code: daar staat dit adres dan vanzelf in. Zet de pagina daarna op je beginscherm.</span>
        </li>
      </ol>
      <Modal open={warn} onClose={() => setWarn(false)} title="Telefoon via Tailscale instellen">
        <div className="space-y-3 text-sm">
          <p>Via Tailscale, alleen voor apparaten op jouw Tailscale-account.</p>
          <p>Alleen telefoons die je met een QR-code koppelt, komen binnen. Ontkoppelen kan altijd.</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setWarn(false)}>
              Annuleren
            </Button>
            <Button loading={busy} onClick={setup}>
              Instellen
            </Button>
          </div>
        </div>
      </Modal>
    </Section>
  );
}
