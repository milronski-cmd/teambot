import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import { Bell, CloudOff, Download, Laptop, ShieldCheck, Smartphone } from 'lucide-react';
import { api, emit } from '../../lib/api';
import { navigate } from '../../lib/router';
import { t } from '../../lib/i18n';
import { Badge, Button, Card, Modal, Spinner, cx, timeAgo, toast, toastError, useAsync } from '../../components/ui';
import { MoreOptions } from '../../components/MoreOptions';
import { MoreInfo } from '../../components/MoreInfo';
import { SavedNote } from '../../components/SettingControls';
import { ComputerOnly } from '../../shell/computerOnly';
import * as pwa from './pwa';
import { useDrafts } from './drafts';
import { Note, Section, platformLabel, type Device, type Reach } from './parts';
import { useDevices, usePairing } from './pairing';
import { PairCard } from './PairCard';
import { AddressPicker, ReachSection, TailscaleQuick } from './options';
import { AlwaysPhone, PushDetails, PushSection, pushSubtitle, usePushActions, usePushInfo } from './push';

// ------------------------------------------------------------------ install

function InstallSection({ phoneOnly }: { phoneOnly?: boolean }) {
  const plat = pwa.platform();
  const standalone = pwa.isStandalone();
  const [can, setCan] = useState(pwa.canPromptInstall());
  useEffect(() => {
    const off = pwa.onInstallChange(() => setCan(pwa.canPromptInstall()));
    return () => {
      off();
    };
  }, []);
  const steps: {
    id: string;
    title: string;
    icon: React.ReactNode;
    body: React.ReactNode;
  }[] = [
    {
      id: 'ios',
      title: 'iPhone / iPad (Safari)',
      icon: <Smartphone className="h-4 w-4" aria-hidden />,
      body: (
        <ol className="list-decimal space-y-1 ps-5">
          <li>Open TeamBot in Safari (via je https-adres).</li>
          <li>
            Tik op Deel → <strong>Zet op beginscherm</strong> → Voeg toe.
          </li>
          <li>
            Open TeamBot vanaf je beginscherm en kies <strong>Koppelen</strong> met een nieuwe code. De app op je beginscherm heeft een eigen opslag, los van Safari.
          </li>
        </ol>
      ),
    },
    {
      id: 'android',
      title: 'Android (Chrome)',
      icon: <Smartphone className="h-4 w-4" aria-hidden />,
      body: (
        <p>
          Menu ⋮ → <strong>App installeren</strong> of <strong>Toevoegen aan startscherm</strong>. Volledig installeren en meldingen werken alleen via https.
        </p>
      ),
    },
    {
      id: 'desktop',
      title: 'Computer (Chrome / Edge)',
      icon: <Laptop className="h-4 w-4" aria-hidden />,
      body: <p>Klik op het installeer-icoon rechts in de adresbalk. In de Windows-app van TeamBot is dit niet nodig.</p>,
    },
  ]
    .filter((s) => !phoneOnly || s.id !== 'desktop')
    .sort((a, b) => (a.id === plat ? -1 : b.id === plat ? 1 : 0));
  return (
    <Section icon={Download} title="Web-app op je telefoon" actions={standalone ? <Badge tone="ok">Geïnstalleerd op dit apparaat</Badge> : undefined}>
      {can && !standalone && (
        <Button variant="primary" onClick={() => pwa.promptInstall().catch(toastError)} icon={<Download className="h-4 w-4" />}>
          Installeer TeamBot
        </Button>
      )}
      <div className={cx('grid gap-3', phoneOnly ? 'md:grid-cols-2' : 'md:grid-cols-3')}>
        {steps.map((s) => (
          <div key={s.id} className={cx('space-y-1.5 rounded-lg border p-3 text-sm', s.id === plat ? 'border-accent' : 'border-line')}>
            <div className="flex items-center gap-2 font-medium">
              {s.icon}
              {s.title}
              {s.id === plat && <Badge tone="accent">dit apparaat</Badge>}
            </div>
            <div className="text-muted">{s.body}</div>
          </div>
        ))}
      </div>
      <Note>Zonder de iPhone-app werkt TeamBot ook als app op je beginscherm, op de iPhone en op Android.</Note>
    </Section>
  );
}

// ------------------------------------------------------------------ phone view

function ThisDevice({ device }: { device: Device | null }) {
  const [confirm, setConfirm] = useState(false);
  const { busy, run } = useAsync();
  return (
    <Section icon={Smartphone} title="Dit apparaat" subtitle={device ? `${device.name} · ${platformLabel(device.platform)} · gekoppeld ${timeAgo(device.created_at)}` : undefined}>
      <p className="text-sm text-muted">
        Deze telefoon kan bijna alles wat je computer kan. <MoreInfo>Chatten, bots maken, AI koppelen, instellingen wijzigen, routines maken en één keer goedkeuren.</MoreInfo>
      </p>
      <ComputerOnly>
        Koppelen, beheer en sleutels bekijken kan alleen op je computer.
      </ComputerOnly>
      {pwa.hasNativeSettings() && (
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => pwa.tellNativeApp('settings')} icon={<ShieldCheck className="h-4 w-4" />}>
            Toestemming en verbinding
          </Button>
          <span className="text-xs text-muted">Welke AI-diensten wat krijgen, toestemming intrekken en de verbinding van deze iPhone-app.</span>
        </div>
      )}
      <Button variant="danger" onClick={() => setConfirm(true)}>
        Ontkoppel dit apparaat
      </Button>
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Dit apparaat ontkoppelen?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Annuleren
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={() =>
                run(async () => {
                  await api.del('/mobile/devices/self');
                  setConfirm(false);
                  // In the iPhone app: let the app see right away that its key is gone (it shows "Koppeling ingetrokken").
                  pwa.tellNativeApp('unauthorized');
                  emit('auth.lost', {});
                })
              }
            >
              Ontkoppelen
            </Button>
          </>
        }
      >
        <p className="text-sm">Je sleutel op deze telefoon wordt meteen ongeldig. Opnieuw gebruiken kan door opnieuw te koppelen.</p>
      </Modal>
    </Section>
  );
}

function DraftsLink() {
  const drafts = useDrafts();
  if (!drafts.length) return null;
  return (
    <Note tone="warn">
      <span className="inline-flex flex-wrap items-center gap-2">
        <CloudOff className="h-4 w-4" aria-hidden />
        {drafts.length} {drafts.length === 1 ? 'bericht is' : 'berichten zijn'} nog niet afgeleverd.
        <Button size="sm" variant="secondary" onClick={() => navigate('/m/mobile/concepten')}>
          Naar concepten
        </Button>
      </span>
    </Note>
  );
}

// ------------------------------------------------------------------ the computer's page

/**
 * The computer: ONE card (get the app, scan the QR code, done; with a phone: its name and "Verbinding werkt"), the one
 * notification switch, and everything else (an address of your own, Tailscale, telefoon-toegang, the TeamBot connection
 * and its relay, notification details, the web app) in one "Meer opties" at the bottom.
 */
function ComputerPhone({ simple }: { simple?: boolean }) {
  const [reach, setReach] = useState<Reach | null>(null);
  const loadReach = useCallback(() => {
    api
      .get<Reach>('/mobile/reachability')
      .then(setReach)
      .catch((e) => toast(e.message, 'danger'));
  }, []);
  const devices = useDevices();
  const pair = usePairing(loadReach);
  const push = usePushInfo();
  const act = usePushActions(push);
  const started = useRef(false);
  useEffect(() => loadReach(), [loadReach]);
  // A QR code right away for someone without a paired phone (no choices first); with one, "Nog een telefoon koppelen".
  useEffect(() => {
    if (started.current || !devices.list) return;
    started.current = true;
    if (!devices.list.some((d) => d.status === 'active')) pair.start();
  }, [devices.list, pair]);

  return (
    <>
      <PairCard pair={pair} reach={reach} setReach={setReach} devices={devices.list} devicesError={devices.err} reloadDevices={devices.load} />
      {/* The short page (Instellingen › Telefoon) is the QR code and nothing else; the rest is under Geavanceerd. */}
      {simple ? null : (
        <>
      <Card className="px-4" data-testid="phone-alerts">
        {push.err && <Note tone="danger">{push.err}</Note>}
        {!push.info && !push.err && <Spinner className="my-3" />}
        {push.info && <AlwaysPhone push={push} busy={act.busy} setPref={act.setPref} />}
        <SavedNote shown={act.savedAlways} className={act.savedAlways ? 'pb-3' : 'sr-only'} />
      </Card>
      <a href="#/m/remote-desktop/" className="inline-flex min-h-8 items-center gap-1 text-sm font-semibold text-accent underline underline-offset-2 coarse:min-h-11">
        {t('Bureaublad op afstand')}
      </a>
      <MoreOptions>
        <AddressPicker reach={reach} pair={pair} />
        <TailscaleQuick reach={reach} setReach={setReach} />
        <ReachSection reach={reach} setReach={setReach} reload={loadReach} />
        {push.info && (
          <Section icon={Bell} tone="orange" title="Pushmeldingen" subtitle={pushSubtitle}>
            <PushDetails push={push} act={act} isDevice={false} />
          </Section>
        )}
        <InstallSection phoneOnly />
      </MoreOptions>
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------ tab

export function PhoneSettings({ simple }: { simple?: boolean } = {}) {
  const [self, setSelf] = useState<{
    kind: string;
    device: Device | null;
  } | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api
      .get('/mobile/devices/self')
      .then(setSelf)
      .catch((e) => setErr(e.message));
  }, []);
  if (err) return <Note tone="danger">Kon de telefooninstellingen niet laden: {err}</Note>;
  if (!self) return <Spinner />;
  return <div className="space-y-5">{self.kind === 'device' ? <PhoneView device={self.device} /> : <ComputerPhoneWrap simple={simple} />}</div>;
}

function ComputerPhoneWrap({ simple }: { simple?: boolean }) {
  return (
    <>
      {!simple && <DraftsLink />}
      <ComputerPhone simple={simple} />
    </>
  );
}

/** On the phone itself: this device, its notifications, the web app. Pairing stays on the computer. */
function PhoneView({ device }: { device: Device | null }) {
  const push = usePushInfo();
  return (
    <>
      <DraftsLink />
      <a href="#/m/remote-desktop/" className="inline-flex min-h-8 items-center gap-1 text-sm font-semibold text-accent underline underline-offset-2 coarse:min-h-11">
        {t('Bureaublad op afstand')}
      </a>
      <ThisDevice device={device} />
      <PushSection push={push} isDevice />
      <InstallSection />
    </>
  );
}
