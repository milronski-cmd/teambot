import type { UIModule } from '../types';
import { BackupsSettings } from './BackupsSettings';
import { WhatsNewPage } from './WhatsNew';

/**
 * Back-ups (server/modules/backups):
 *  Instellingen › Back-ups (#/settings/backups-app)  back-up now, daily (keep N), restore, updates and the way back
 *  #/m/backups/nieuw                                  "Wat is er nieuw" after an update (link in the notification)
 */
const mod: UIModule = {
  id: 'backups',
  label: 'Back-ups',
  pages: [{ path: 'nieuw', title: 'Wat is er nieuw', component: WhatsNewPage }],
  settingsTabs: [{ id: 'app', title: 'Back-ups', adminOnly: true, component: BackupsSettings }],
};

export default mod;
