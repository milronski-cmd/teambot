import { Upload } from 'lucide-react';
import type { UIModule } from '../types';
import { ImportPage } from './ImportPage';
import { ImportSettingsTab } from './Banner';

/**
 * "Importeer je OpenBot-team":
 *  #/m/openbot-import          preview with checkboxes → import → summary
 *  Settings → Overstappen      entry point (also after dismissing the home-screen banner)
 */
const mod: UIModule = {
  id: 'openbot-import',
  label: 'Overstappen',
  pages: [{ path: '', title: 'Overstappen uit OpenBot', icon: Upload, component: ImportPage }],
  settingsTabs: [{ id: 'overstappen', title: 'Overstappen', adminOnly: true, component: ImportSettingsTab }],
};

export default mod;
