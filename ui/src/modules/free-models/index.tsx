import type { UIModule } from '../types';
import { FreeModelsSettings } from './FreeModelsSettings';

/**
 * Gratis modellen (package D1):
 *  Instellingen › Gratis modellen   each free source on/off, key with a sign-up link, privacy and tools labels, status;
 *                                   models, quota and terms under "Meer opties"
 */
const mod: UIModule = {
  id: 'free-models',
  label: 'Gratis modellen',
  settingsTabs: [{ id: 'gratis', title: 'Gratis modellen', component: FreeModelsSettings }],
};

export default mod;
