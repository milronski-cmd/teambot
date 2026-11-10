import type { UIModule } from '../types';
import { WebSearchSettings } from './WebSearchSettings';

/**
 * Zoeken (0.4.5): Instellingen › Geavanceerd › Meer over AI › Zoeken — the source web_search tries first, the optional
 * own free keys and the Jina Reader switch. The search chain itself lives in server/tools/builtin/web.ts.
 */
const mod: UIModule = {
  id: 'websearch',
  label: 'Zoeken',
  settingsTabs: [{ id: 'zoeken', title: 'Zoeken', component: WebSearchSettings }],
};

export default mod;
