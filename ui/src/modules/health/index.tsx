import type { UIModule } from '../types';
import { HealthSettings } from './HealthSettings';

/**
 * Status van TeamBot (0.4.3, parity 17.1):
 *  Instellingen › Algemeen › Status van TeamBot   a green/orange/red line from the stall meter in the server
 *                                                        (server/modules/health), the numbers behind "Meer informatie"
 */
const mod: UIModule = {
  id: 'health',
  label: 'Status van TeamBot',
  settingsTabs: [{ id: 'status', title: 'Status van TeamBot', adminOnly: true, component: HealthSettings }],
};

export default mod;
