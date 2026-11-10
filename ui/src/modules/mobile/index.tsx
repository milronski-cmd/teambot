import { CloudOff, Share2 } from 'lucide-react';
import type { UIModule } from '../types';
import { on } from '../../lib/api';
import { toast } from '../../components/ui';
import { PhoneSettings } from './PhoneSettings';
import { SharePage } from './SharePage';
import { DraftBadge, DraftsPage } from './DraftsPage';
import { installSendObserver, loadDrafts } from './drafts';
import * as pwa from './pwa';

/** Telefoon: koppelen (QR), apparaten, bereikbaarheid, pushmeldingen, PWA (offline-schil) en concepten. */
const mod: UIModule = {
  id: 'mobile',
  label: 'Telefoon',
  pages: [
    { path: 'concepten', title: 'Concepten', icon: CloudOff, nav: false, component: DraftsPage },
    { path: 'delen', title: 'Delen', icon: Share2, nav: false, component: SharePage },
  ],
  settingsTabs: [{ id: 'telefoon', title: 'Telefoon', component: PhoneSettings }],
  composerActions: [DraftBadge],
  init() {
    pwa.registerSW();
    pwa.syncPush().catch(() => undefined);
    const offFetch = installSendObserver(() => toast('Niet afgeleverd: TeamBot is niet bereikbaar. Je bericht staat bij Concepten.', 'danger'));
    let down = false;
    let lastNotice = 0;
    const offs = [
      on('mobile.paired', (d: any) => toast(`Gekoppeld: ${d?.device?.name || 'telefoon'}`, 'ok')),
      on('ws.status', (s: any) => {
        if (!s?.connected) {
          down = true;
          return;
        }
        const n = loadDrafts().length;
        if (down && n && Date.now() - lastNotice > 60_000) {
          lastNotice = Date.now();
          toast(n === 1 ? 'TeamBot is weer bereikbaar. 1 bericht is nog niet afgeleverd — zie Concepten.' : `TeamBot is weer bereikbaar. ${n} berichten zijn nog niet afgeleverd — zie Concepten.`);
        }
        down = false;
      }),
    ];
    // A tapped push notification asks an open window to go to its link (in-app hash routes only).
    const onSwMessage = (e: MessageEvent) => {
      const link = e.data?.type === 'tb.navigate' ? String(e.data.link || '') : '';
      if (/^#\/[\w\-/?=&.%:]*$/.test(link)) location.hash = link.slice(1);
    };
    if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', onSwMessage);
    return () => {
      offFetch();
      for (const off of offs) off();
      if ('serviceWorker' in navigator) navigator.serviceWorker.removeEventListener('message', onSwMessage);
    };
  },
};

export default mod;
