import type { UIModule } from '../types';
import { HealthSettings } from './HealthSettings';

/**
 * Hoe gaat het met TeamBot? (0.4.3, parity 17.1):
 *  Instellingen › Algemeen › Hoe gaat het met TeamBot?   a green/orange/red line from the stall meter in the server
 *                                                        (server/modules/health), the numbers behind "Meer informatie"
 */
const mod: UIModule = {
  id: 'health',
  label: 'Hoe gaat het met TeamBot?',
  settingsTabs: [{ id: 'status', title: 'Hoe gaat het met TeamBot?', adminOnly: true, component: HealthSettings }],
};

export default mod;
