/**
 * Local models on this pc (TeamBot 0.4, Q). Not a registered UIModule: the card is placed where it belongs.
 *  - Settings › AI-providers shows <LocalModelsCard /> in full (pages/Providers.tsx).
 *  - The first-run screen can show <LocalModelsCard compact /> in its slot: the pc in one sentence, the GPU warning
 *    and the advice for a first bot with one button (download, or use it for new bots).
 */
export { LocalModelsCard, hardwareSummary } from './LocalModelsCard';
export { localModelsApi } from './api';
export type { LocalModelsView } from '../../../../shared/localModels.js';
