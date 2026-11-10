import { LOCAL_IDS } from '../../providers/catalog.js';
import { CHECKED } from './sources.js';

/**
 * Privacy label per provider (and model where the terms differ per model), from the provider's own terms.
 *  - local    "blijft op je pc": runs on this computer, nothing leaves it;
 *  - no-store "bewaart niets": the provider says it keeps no prompts or answers (by default) and does not train on them;
 *  - may-train "kan trainen": the provider (or the service behind it) may keep prompts and use them to improve or
 *    train models, or its terms do not say: TeamBot then assumes the worst.
 *
 * The labels of the network module (package P, server/modules/network/privacy.ts) get these terms for the free
 * sources they have no checked rule for themselves (service.ts registerPrivacy, via registerPrivacyRule).
 */

export type PrivacyLevel = 'local' | 'no-store' | 'may-train';

export interface PrivacyLabel {
  level: PrivacyLevel;
  /** "blijft op je pc" / "bewaart niets" / "kan trainen". */
  label: string;
  /** One or two plain sentences: what the terms say. */
  note?: string;
  source?: string;
  checked?: string;
}

export const PRIVACY_TEXT: Record<PrivacyLevel, string> = { local: 'blijft op je pc', 'no-store': 'bewaart niets', 'may-train': 'kan trainen' };
export const PRIVACY_RANK: Record<PrivacyLevel, number> = { local: 0, 'no-store': 1, 'may-train': 2 };

const lbl = (level: PrivacyLevel, note?: string, source?: string): PrivacyLabel => ({ level, label: PRIVACY_TEXT[level], note, source, checked: source ? CHECKED : undefined });

/** OpenCode Zen free models with zero retention and no training (OpenCode docs, checked 2026-11-09). */
const OPENCODE_NO_STORE = /(glm-5\.3-flash|deepseek-v4\.1-flash)/i;

/** The label for one provider kind and (optionally) one model. Unknown providers: "kan trainen" (assume the worst). */
export function privacyLabel(kind: string, model = ''): PrivacyLabel {
  if (LOCAL_IDS.has(kind)) return lbl('local', 'Draait op je eigen computer; er gaat niets naar buiten.');
  switch (kind) {
    case 'groq':
      return lbl('no-store', 'Groq bewaart je vragen en antwoorden standaard niet. Voor misbruikcontrole kan iets tot 30 dagen blijven staan; met Zero Data Retention in de Groq-console zet je dat uit.', 'https://console.groq.com/docs/your-data');
    case 'cloudflare':
      return lbl('no-store', 'Cloudflare bewaart je vragen en antwoorden niet en traint er geen modellen mee.', 'https://developers.cloudflare.com/workers-ai/platform/data-usage/');
    case 'openrouter':
      return lbl('may-train', 'Volgens de voorwaarden van OpenRouter mogen sommige modellen je vragen bewaren of ermee trainen; dat geldt vooral voor gratis modellen.', 'https://openrouter.ai/terms');
    case 'kilo':
      return lbl('may-train', 'De gratis modellen van Kilo kunnen via aanbieders lopen die vragen en antwoorden bewaren en gebruiken om hun diensten te verbeteren.', 'https://kilo.ai/docs/code-with-ai/agents/free-and-budget-models');
    case 'zai':
      return lbl('may-train', 'Z.ai zegt in zijn openbare documentatie niet wat het met je vragen doet; TeamBot gaat daarom uit van het ergste.', 'https://docs.z.ai/guides/overview/pricing');
    case 'opencode':
      return OPENCODE_NO_STORE.test(model)
        ? lbl('no-store', 'Volgens OpenCode bewaart dit gratis model niets en traint het niet.', 'https://opencode.ai/docs/zen')
        : lbl('may-train', 'Volgens OpenCode mogen de meeste gratis modellen je gegevens bewaren of gebruiken om het model te verbeteren.', 'https://opencode.ai/docs/zen');
    case 'google':
      return lbl('may-train', 'In de gratis laag gebruikt Google je invoer om zijn producten te verbeteren, en kunnen mensen die lezen.', 'https://aistudio.google.com/docs/terms');
    case 'nvidia':
      return lbl('may-train', 'Alleen om te proberen; NVIDIA logt het gebruik en gebruikt het om zijn producten te verbeteren.');
    case 'mistral':
      return lbl('may-train', 'In het gratis abonnement mag Mistral je gegevens voor training gebruiken, tenzij je bezwaar maakt.');
  }
  return lbl('may-train', 'Niet vastgesteld wat deze aanbieder met je gegevens doet; TeamBot gaat uit van het ergste.');
}

/** Does a source with this level fit a request that allows at most `allowed`? */
export function privacyFits(level: PrivacyLevel, allowed: PrivacyLevel | 'any' | undefined): boolean {
  if (!allowed || allowed === 'any') return true;
  return PRIVACY_RANK[level] <= PRIVACY_RANK[allowed];
}
