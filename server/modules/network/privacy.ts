import net from 'node:net';

/**
 * Privacy label per engine (0.4, package P): what happens to what a bot sends to its AI engine.
 *
 *   privacyLabel(providerKind, model, context?) -> PrivacyLabel
 *
 * `providerKind` is the ProviderKind id (`ollama`, `anthropic`, `claude-code`, `opencode`, …), `model` the model id the
 * bot uses. `context` refines it: the provider's base URL (a "local" server on another machine is not on your pc) and,
 * for subscription CLIs, how they are logged in (`billing: 'subscription' | 'api'`; unknown = the worst plausible case).
 *
 * Other packages add or refine rules with registerPrivacyRule(kind, rule): a fixed label, or a function of the model
 * that returns a label or null (null = fall back to the built-in rule). Registered rules win over the built-in table,
 * the last registration first. Example (a free provider):
 *
 *   registerPrivacyRule('kilo', (model) => model.endsWith(':free') ? { level: 'may-train', receiver: 'Kilo', detail: '…',
 *     policyUrl: 'https://…', checkedAt: '2026-11-09' } : null);
 *
 * Levels, best first: local (blijft op je pc), lan (blijft in je netwerk), no-store (bewaart niets), no-train (traint
 * niet, bewaart tijdelijk), unknown (privacy onbekend), may-train (kan trainen). Only claim no-store/no-train from the
 * provider's own published policy, with its link and the date it was checked; otherwise say unknown.
 */

export type PrivacyLevel = 'local' | 'lan' | 'no-store' | 'no-train' | 'unknown' | 'may-train';

export interface PrivacyLabel {
  level: PrivacyLevel;
  /** Short label for a badge, e.g. "Blijft op je pc". */
  label: string;
  /** One or two plain sentences: who gets what and what they do with it. */
  detail: string;
  /** Who receives the conversation; null when it stays on this computer. */
  receiver: string | null;
  /** Where the owner turns training off (when that is possible). */
  optOutUrl?: string;
  /** The provider's own page about data use. */
  policyUrl?: string;
  /** When TeamBot last checked that policy (YYYY-MM-DD). */
  checkedAt: string;
}

export interface PrivacyContext {
  /** Base URL of the provider connection (local servers: where it runs). */
  baseUrl?: string | null;
  /** How a CLI is logged in / what kind of account it uses. */
  billing?: 'subscription' | 'api' | 'free' | 'paid' | 'local' | 'unknown' | null;
  /** Display name of the provider (for texts about providers TeamBot did not check). */
  providerLabel?: string | null;
}

export type PrivacyInput = Omit<PrivacyLabel, 'label'> & { label?: string };
export type PrivacyRule = PrivacyInput | ((model: string, c: PrivacyContext) => PrivacyInput | null | undefined);

export const PRIVACY_TEXT: Record<PrivacyLevel, string> = {
  local: 'Blijft op je pc',
  lan: 'Blijft in je netwerk',
  'no-store': 'Bewaart niets',
  'no-train': 'Traint niet',
  unknown: 'Privacy onbekend',
  'may-train': 'Kan trainen',
};

/** Order from best to worst (for "the worst engine of a bot"). */
export const PRIVACY_ORDER: PrivacyLevel[] = ['local', 'lan', 'no-store', 'no-train', 'unknown', 'may-train'];
export const worse = (a: PrivacyLabel, b: PrivacyLabel) => (PRIVACY_ORDER.indexOf(b.level) > PRIVACY_ORDER.indexOf(a.level) ? b : a);

const CHECKED = '2026-11-09';
const ANTHROPIC_POLICY = 'https://code.claude.com/docs/en/data-usage';
const ANTHROPIC_OPT_OUT = 'https://claude.ai/settings/data-privacy-controls';
const OPENAI_POLICY = 'https://help.openai.com/en/articles/7730893-data-controls-faq';
const OPENAI_OPT_OUT = 'https://chatgpt.com/#settings/DataControls';

const L = (x: PrivacyInput): PrivacyLabel => ({ ...x, label: x.label || PRIVACY_TEXT[x.level] });

// ---------- where a server runs ----------

const PRIVATE_V4: [string, number][] = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['169.254.0.0', 16],
  ['100.64.0.0', 10], // Tailscale / CGNAT
];
const v4 = (ip: string) => ip.split('.').reduce((n, p) => n * 256 + Number(p), 0);
const inV4 = (ip: string, [base, bits]: [string, number]) => {
  const mask = bits === 0 ? 0 : 2 ** 32 - 2 ** (32 - bits);
  return (v4(ip) & mask) >>> 0 === (v4(base) & mask) >>> 0;
};

/** 'local' = this computer, 'lan' = home/office network or tailnet, 'public' = somewhere on the internet. */
export function whereIs(baseUrl: string | null | undefined): 'local' | 'lan' | 'public' {
  let host = '';
  try {
    host = new URL(String(baseUrl || '')).hostname.toLowerCase();
  } catch {
    return 'local'; // no URL: the provider's own default (127.0.0.1 for local servers)
  }
  if (host.startsWith('[')) host = host.slice(1, -1);
  if (host.startsWith('::ffff:')) host = host.slice(7);
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return 'local';
  if (net.isIPv4(host)) {
    if (host.startsWith('127.')) return 'local';
    return PRIVATE_V4.some((r) => inV4(host, r)) ? 'lan' : 'public';
  }
  if (net.isIPv6(host)) {
    if (host === '::1') return 'local';
    return /^(f[cd]|fe[89ab])/i.test(host) ? 'lan' : 'public';
  }
  if (!host.includes('.') || /\.(local|lan|home|internal|intranet|corp|home\.arpa|ts\.net)$/.test(host)) return 'lan';
  return 'public';
}

const LOCAL_KINDS = new Set(['ollama', 'lmstudio', 'llamacpp', 'vllm', 'jan', 'localai', 'lemonade', 'koboldcpp', 'textgen-webui', 'gpt4all']);

function bySite(c: PrivacyContext, name: string): PrivacyLabel {
  const w = whereIs(c.baseUrl);
  if (w === 'local') return L({ level: 'local', receiver: null, detail: `${name} draait op deze computer: je gesprekken gaan niet naar internet.`, checkedAt: CHECKED });
  let host = '';
  try {
    host = new URL(String(c.baseUrl)).host;
  } catch {
    /* shown without host */
  }
  if (w === 'lan') return L({ level: 'lan', receiver: host || null, detail: `${name} draait op een ander apparaat in je eigen netwerk${host ? ` (${host})` : ''}: je gesprekken gaan daarheen, niet naar internet.`, checkedAt: CHECKED });
  return L({ level: 'unknown', receiver: host || name, detail: `Deze ${name}-server staat op internet${host ? ` (${host})` : ''}: wat er met je gesprekken gebeurt, hangt af van wie die server beheert.`, checkedAt: CHECKED });
}

// ---------- built-in rules (policies checked on 9 November 2026) ----------

const unchecked = (c: PrivacyContext, kind: string): PrivacyLabel =>
  L({ level: 'unknown', receiver: c.providerLabel || kind, detail: `TeamBot heeft de privacyvoorwaarden van ${c.providerLabel || kind} niet nagekeken. Lees ze voordat je er persoonlijke of vertrouwelijke gegevens heen stuurt.`, checkedAt: CHECKED });

const anthropicApi = L({
  level: 'no-train',
  receiver: 'Anthropic',
  detail: 'Met een API-sleutel traint Anthropic niet op je gesprekken. Anthropic bewaart ze 30 dagen.',
  policyUrl: ANTHROPIC_POLICY,
  checkedAt: CHECKED,
});
const anthropicConsumer = L({
  level: 'may-train',
  receiver: 'Anthropic',
  detail:
    'Met een claude.ai-abonnement (Free, Pro, Max) gebruikt Anthropic je gesprekken om Claude te trainen als "Help Claude verbeteren" aanstaat; dan bewaart Anthropic ze 5 jaar, anders 30 dagen. Je zet het uit bij claude.ai › Instellingen › Privacy. Met een API-sleutel traint Anthropic niet.',
  optOutUrl: ANTHROPIC_OPT_OUT,
  policyUrl: ANTHROPIC_POLICY,
  checkedAt: CHECKED,
});
const openaiApi = L({
  level: 'no-train',
  receiver: 'OpenAI',
  detail: 'Via de API (en met ChatGPT Business, Enterprise of Edu) traint OpenAI standaard niet op je gesprekken. Voor misbruikcontrole bewaart OpenAI ze tot 30 dagen.',
  policyUrl: OPENAI_POLICY,
  checkedAt: CHECKED,
});
const openaiConsumer = L({
  level: 'may-train',
  receiver: 'OpenAI',
  detail:
    'Met een ChatGPT-abonnement (Free, Plus, Pro) gebruikt OpenAI je Codex-taken om modellen te verbeteren zolang "Het model voor iedereen verbeteren" aanstaat (standaard aan). Je zet het uit in ChatGPT › Instellingen › Gegevensbeheer. Business, Enterprise en een API-sleutel: traint niet.',
  optOutUrl: OPENAI_OPT_OUT,
  policyUrl: OPENAI_POLICY,
  checkedAt: CHECKED,
});

/** OpenCode Zen: per model (https://opencode.ai/docs/zen, checked 9 November 2026). */
function opencode(model: string, c: PrivacyContext): PrivacyLabel {
  const m = model.toLowerCase();
  const [prov, ...rest] = m.includes('/') ? m.split('/') : ['opencode', m];
  const name = rest.join('/') || prov;
  if (['ollama', 'lmstudio', 'llamacpp', 'llama.cpp'].includes(prov)) return L({ level: 'local', receiver: null, detail: 'OpenCode gebruikt hier een model op deze computer: je gesprekken gaan niet naar internet.', checkedAt: CHECKED });
  if (prov === 'anthropic') return anthropicApi;
  if (prov === 'openai') return openaiApi;
  if (prov !== 'opencode' && m.includes('/')) return unchecked({ ...c, providerLabel: `${prov} (via OpenCode)` }, prov);
  const policyUrl = 'https://opencode.ai/docs/zen';
  if (/glm-5\.3-flash.*free|deepseek-v4\.1-flash.*free/.test(name))
    return L({ level: 'no-store', receiver: 'OpenCode', detail: 'Volgens OpenCode bewaart de aanbieder van dit gratis model niets en traint hij er niet op.', policyUrl, checkedAt: CHECKED });
  if (/crouton|beam/.test(name)) return L({ level: 'no-train', receiver: 'OpenCode', detail: 'Volgens OpenCode wordt dit gratis model niet getraind op je gesprekken; ze worden 30 dagen bewaard.', policyUrl, checkedAt: CHECKED });
  if (/big-pickle|iceman|inkling|flint|mimo|nemotron|free/.test(name) || name === 'default')
    return L({
      level: 'may-train',
      receiver: 'OpenCode',
      detail: 'Bij de gratis modellen van OpenCode (zoals Big Pickle) mogen de makers je gesprekken gebruiken om het model te verbeteren zolang het gratis is. Stuur er geen persoonlijke of vertrouwelijke gegevens heen.',
      policyUrl,
      checkedAt: CHECKED,
    });
  return L({ level: 'no-store', receiver: 'OpenCode', detail: 'Volgens OpenCode bewaren de aanbieders van de betaalde Zen-modellen niets en trainen ze niet (behalve modellen van OpenAI en Anthropic: die bewaren 30 dagen).', policyUrl, checkedAt: CHECKED });
}

const BUILTIN: Record<string, (model: string, c: PrivacyContext) => PrivacyLabel> = {
  anthropic: () => anthropicApi,
  // Claude Code's own telemetry (code.claude.com/docs/en/data-usage, checked 9 November 2026). Each detail is written
  // out whole: the interface translates a detail as one text, and a sentence glued to another one was left Dutch.
  'claude-code': (_m, c) =>
    c.billing === 'api' || c.billing === 'paid'
      ? {
          ...anthropicApi,
          detail:
            'Met een API-sleutel traint Anthropic niet op je gesprekken. Anthropic bewaart ze 30 dagen. Claude Code zelf stuurt daarnaast gebruiksstatistieken en foutrapporten naar Anthropic en de diensten die Anthropic daarvoor gebruikt, zonder je code, berichten of bestandsnamen.',
        }
      : {
          ...anthropicConsumer,
          detail:
            'Met een claude.ai-abonnement (Free, Pro, Max) gebruikt Anthropic je gesprekken om Claude te trainen als "Help Claude verbeteren" aanstaat; dan bewaart Anthropic ze 5 jaar, anders 30 dagen. Je zet het uit bij claude.ai › Instellingen › Privacy. Met een API-sleutel traint Anthropic niet. Claude Code zelf stuurt daarnaast gebruiksstatistieken en foutrapporten naar Anthropic en de diensten die Anthropic daarvoor gebruikt, zonder je code, berichten of bestandsnamen.',
        },
  openai: () => openaiApi,
  'codex-cli': (_m, c) => (c.billing === 'api' || c.billing === 'paid' ? openaiApi : openaiConsumer),
  azure: () => L({ level: 'no-train', receiver: 'Microsoft Azure', detail: 'Azure OpenAI traint niet op je gesprekken; Microsoft kan ze tot 30 dagen bewaren voor misbruikcontrole.', policyUrl: 'https://learn.microsoft.com/legal/cognitive-services/openai/data-privacy', checkedAt: CHECKED }),
  bedrock: () => L({ level: 'no-train', receiver: 'Amazon (AWS)', detail: 'Amazon Bedrock gebruikt je gesprekken niet om modellen te trainen.', policyUrl: 'https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html', checkedAt: CHECKED }),
  vertex: () => L({ level: 'no-train', receiver: 'Google Cloud', detail: 'Vertex AI gebruikt je gesprekken niet om modellen te trainen zonder jouw toestemming.', policyUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/data-governance', checkedAt: CHECKED }),
  google: () =>
    L({
      level: 'may-train',
      receiver: 'Google',
      detail:
        'Met een gratis Gemini-sleutel mag Google je gesprekken gebruiken om producten en modellen te verbeteren, en kunnen mensen ze lezen. Stuur er geen persoonlijke gegevens heen. Betaald gebruik (en volgens de voorwaarden ook gratis gebruik in de EER, Zwitserland en het VK) traint niet.',
      policyUrl: 'https://ai.google.dev/gemini-api/terms',
      checkedAt: CHECKED,
    }),
  groq: () =>
    L({
      level: 'no-store',
      receiver: 'Groq',
      detail: 'Groq bewaart je gesprekken standaard niet; alleen bij een storing of misbruikonderzoek tot 30 dagen. Met Zero Data Retention (Data Controls bij Groq) ook dat niet.',
      policyUrl: 'https://console.groq.com/docs/your-data',
      checkedAt: CHECKED,
    }),
  mistral: () =>
    L({
      level: 'may-train',
      receiver: 'Mistral',
      detail: 'Op het gratis Experiment-abonnement mag Mistral je gesprekken gebruiken om modellen te trainen. Je zet dat uit in de Admin Console van Mistral › Privacy. Betaalde abonnementen trainen standaard niet.',
      optOutUrl: 'https://help.mistral.ai/en/articles/455207-can-i-opt-out-of-my-input-or-output-data-being-used-for-training',
      policyUrl: 'https://help.mistral.ai/en/articles/455207-can-i-opt-out-of-my-input-or-output-data-being-used-for-training',
      checkedAt: CHECKED,
    }),
  openrouter: (model) =>
    /:free$/i.test(model)
      ? L({
          level: 'may-train',
          receiver: 'OpenRouter en de aanbieder van het model',
          detail: 'Gratis modellen op OpenRouter lopen vaak via aanbieders die je gesprekken bewaren of gebruiken voor training. In OpenRouter › Instellingen › Privacy zet je zulke aanbieders uit.',
          optOutUrl: 'https://openrouter.ai/settings/privacy',
          policyUrl: 'https://openrouter.ai/docs/guides/privacy/data-collection',
          checkedAt: CHECKED,
        })
      : L({
          level: 'unknown',
          receiver: 'OpenRouter en de aanbieder van het model',
          detail: 'OpenRouter zelf bewaart standaard niets, maar de aanbieder achter het model kan dat wel. In OpenRouter › Instellingen › Privacy kies je alleen aanbieders die niets bewaren.',
          optOutUrl: 'https://openrouter.ai/settings/privacy',
          policyUrl: 'https://openrouter.ai/docs/guides/privacy/data-collection',
          checkedAt: CHECKED,
        }),
  cloudflare: () => L({ level: 'no-train', receiver: 'Cloudflare', detail: 'Cloudflare gebruikt je gesprekken niet om modellen te trainen.', policyUrl: 'https://developers.cloudflare.com/workers-ai/platform/privacy/', checkedAt: CHECKED }),
  nvidia: () =>
    L({
      level: 'may-train',
      receiver: 'NVIDIA',
      detail: 'De gratis proef van NVIDIA logt je gebruik en mag het gebruiken om producten te verbeteren. Niet bedoeld voor persoonlijke of vertrouwelijke gegevens.',
      policyUrl: 'https://build.nvidia.com/',
      checkedAt: CHECKED,
    }),
  xai: () => L({ level: 'no-train', receiver: 'xAI', detail: 'Via de API traint xAI niet op je gesprekken; xAI bewaart ze 30 dagen voor misbruikcontrole.', policyUrl: 'https://docs.x.ai/docs/faq/security', checkedAt: CHECKED }),
  opencode,
  'openai-compatible': (_m, c) => bySite(c, c.providerLabel || 'Dit eigen endpoint'),
};

/** Does TeamBot's own table have a checked rule for this provider kind (local servers included)? */
export function hasBuiltinPrivacy(kind: string): boolean {
  return LOCAL_KINDS.has(kind) || Object.prototype.hasOwnProperty.call(BUILTIN, kind);
}

// ---------- registry ----------

const RULES = new Map<string, PrivacyRule[]>();

/** Add a rule for a provider kind (other packages). Returns a function that removes it again. */
export function registerPrivacyRule(kind: string, rule: PrivacyRule): () => void {
  const list = RULES.get(kind) || [];
  list.unshift(rule);
  RULES.set(kind, list);
  return () => {
    const l = RULES.get(kind) || [];
    const i = l.indexOf(rule);
    if (i >= 0) l.splice(i, 1);
  };
}

/** The privacy label of one engine: provider kind + model (+ where it runs and how it is logged in). */
export function privacyLabel(providerKind: string, model?: string | null, c: PrivacyContext = {}): PrivacyLabel {
  const kind = String(providerKind || '');
  const m = String(model || '');
  for (const r of RULES.get(kind) || []) {
    const out = typeof r === 'function' ? r(m, c) : r;
    if (out) return L(out);
  }
  if (LOCAL_KINDS.has(kind)) {
    // Ollama's cloud models ("…-cloud", "…:cloud") run at ollama.com, not on this pc.
    if (kind === 'ollama' && /(^|[:-])cloud$/i.test(m)) return L({ level: 'unknown', receiver: 'Ollama', detail: 'Dit is een cloudmodel van Ollama: je gesprekken gaan naar de servers van Ollama, niet naar je eigen pc.', policyUrl: 'https://ollama.com/cloud', checkedAt: CHECKED });
    return bySite(c, c.providerLabel || kind);
  }
  const b = BUILTIN[kind];
  if (b) return b(m, c);
  return unchecked(c, kind);
}
