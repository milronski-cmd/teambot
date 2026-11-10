/** The engines the welcome screen looks for by name: own subscriptions, free OpenCode, and Ollama on this PC. */
const MAIN_ENGINES = ['claude-code', 'codex-cli', 'opencode', 'ollama'];

/**
 * Welcome screen: the main engines that are not usable yet, said honestly instead of left out ("Codex staat op deze
 * pc, maar is niet ingelogd", "Niet gevonden: Ollama"). '' when all of them are found.
 */
export function missingEnginesText(kinds: { id: string; label: string; type: 'api' | 'cli'; status?: { installed?: boolean; loggedIn?: boolean } | null }[]): string {
  const main = MAIN_ENGINES.map((id) => kinds.find((k) => k.id === id)).filter((k): k is (typeof kinds)[number] => !!k);
  const name = (k: (typeof kinds)[number]) => k.label.replace(/\s*\((lokaal|local)\)$/i, '');
  const out = main.filter((k) => k.type === 'cli' && k.status?.installed && k.status?.loggedIn === false).map((k) => `${name(k)} staat op deze pc, maar is niet ingelogd.`);
  const missing = main.filter((k) => !k.status?.installed).map(name);
  if (missing.length) out.push(`Niet gevonden: ${missing.join(', ')}.`);
  return out.join(' ');
}

/** Who pays (same values as Billing in ./types; kept local so this file has no imports and is unit-tested). */
type Billing = 'free' | 'subscription' | 'paid' | 'local';

/**
 * Short route note next to the engine in the chat header: "abonnement", "gratis", or — for an API — "eigen sleutel"
 * with the model, so the active route (subscription, own key, local) is always visible (C-10).
 */
export function engineChipNote(agentModel: string, provider: { kind: string; type: 'api' | 'cli'; billing?: Billing; config?: Record<string, any>; shared?: boolean; own?: boolean }): { text: string; free: boolean; label?: string; model?: string } {
  if (provider.billing === 'local' || provider.billing === 'free' || provider.kind === 'ollama' || provider.kind === 'lmstudio') return { text: 'gratis', free: true };
  if (provider.type === 'cli') return { text: 'abonnement', free: true };
  const model = agentModel || provider.config?.defaultModel || '';
  // A member on the admin's shared provider does not use their own key (acceptance round 5, C-12/C-10).
  // `label` and `model` apart: the label is translated, the model name never (round 5, C-15: "eigen sleutel" stayed Dutch).
  const label = provider.shared && provider.own === false ? 'gedeelde sleutel' : 'eigen sleutel';
  return { text: model ? `${label} · ${model}` : label, free: false, label, model: model || undefined };
}

/**
 * Tokens and cost under an answer: "12.898 tokens · $0.0123" for a paid API, "53.671 tokens · via abonnement (≈ $0.24)"
 * when a subscription covered it (the estimate is what the same tokens would cost at API prices).
 */
export function messageCostText(usage: { input: number; output: number; cost?: number | null; value?: number | null } | null | undefined, locale?: string): string {
  if (!usage) return '';
  const tokens = `${(usage.input + usage.output).toLocaleString(locale)} tokens`;
  if (usage.cost) return `${tokens} · ${usd(usage.cost, 4, locale)}`;
  if (typeof usage.value === 'number' && usage.value > 0) return `${tokens} · via abonnement (≈ ${usd(usage.value, 2, locale)})`;
  return tokens;
}

/** Dollars in the reader's notation: "US$ 0,24" (nl), "0,24 $" (de), "$0.24" (en-US) (C-17). */
function usd(n: number, digits: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}
