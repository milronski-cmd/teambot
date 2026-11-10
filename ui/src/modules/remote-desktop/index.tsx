import { MonitorSmartphone } from 'lucide-react';
import type { UIModule } from '../types';
import { RemotePage } from './RemotePage';
import { Viewer } from './Viewer';

/**
 * "Bureaublad op afstand" (server/modules/remote-desktop): the page linked from Instellingen › Telefoon and listed on
 * Geavanceerd › Bestanden en computers (switch, options, who watches, safety rules) and the full-screen viewer for the
 * phone or a browser on another PC.
 */
const mod: UIModule = {
  id: 'remote-desktop',
  label: 'Bureaublad op afstand',
  pages: [
    { path: '', title: 'Bureaublad op afstand', icon: MonitorSmartphone, component: RemotePage },
    { path: 'live', title: 'Bureaublad op afstand', bare: true, component: Viewer },
  ],
};

export default mod;
