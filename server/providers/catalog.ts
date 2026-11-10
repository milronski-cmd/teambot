import type { ModelInfo, ProviderField } from '../core/types.js';
import { fetchJson, explain } from './common.js';
import { usdText } from '../core/i18n.js';
import type { KeyCheckResult, ReasoningStyle } from './openai-compat.js';

/**
 * Catalogue of API providers. Data only; `kinds.ts` turns each entry into a ProviderKind.
 *
 * Cost notes are honest one-liners (free-tier limits included) with the date they were checked against the
 * provider's own pages. Prices per model are NOT hard-coded here: they come from the provider's live model list
 * where it publishes them (see `parseModel`), otherwise from the dated table in pricing.ts, otherwise "onbekend".
 */

export type Section = 'free' | 'subscription' | 'local' | 'key';
export type AdapterKind = 'compat' | 'anthropic' | 'bedrock' | 'vertex' | 'azure' | 'cloudflare';

export interface ProviderDef {
  id: string;
  label: string;
  section: Section;
  adapter?: AdapterKind;
  baseUrl: string;
  needsKey: boolean;
  keyOptional?: boolean;
  keyUrl?: string;
  keyPlaceholder?: string;
  keyLabel?: string;
  description: string;
  billingNote?: string;
  costNote: string;
  costCheckedAt: string;
  pricingUrl?: string;
  /** Preferred default models, best first; the first one present in the live list wins. */
  recommend?: (string | RegExp)[];
  /** Fallback model list when the live list is unavailable. */
  models?: string[];
  reasoning?: ReasoningStyle;
  usageInStream?: boolean;
  modelFilter?: (id: string) => boolean;
  /** Extra info from one /models entry; return null to hide the entry. */
  parseModel?: (raw: any) => Partial<ModelInfo> | null;
  listModels?: (h: { base: string; headers: () => Promise<Record<string, string>> }) => Promise<ModelInfo[]>;
  keyCheck?: (h: { base: string; headers: () => Promise<Record<string, string>>; label: string }) => Promise<KeyCheckResult>;
  publicModelList?: boolean;
  /** Send reasoning_content back: 'loop' = current tool loop only, 'all' = every earlier tool turn (DeepSeek). */
  replayReasoning?: 'loop' | 'all';
  maxCompletionTokens?: boolean;
  headers?: Record<string, string>;
  /** Extra fields sent with every chat request (e.g. MiniMax reasoning_split). */
  extraBody?: Record<string, any>;
  fields?: ProviderField[];
  /** Not verified live or against current docs: shown as "experimenteel". */
  experimental?: boolean;
  /** The service stopped on this date: hidden from "add", existing connections get a clear message. */
  retired?: string;
  /** Other addresses to try when detecting a local server (old default ports). */
  altBases?: string[];
  /** Free/flaky service: an error inside a "successful" answer or a cut-off/silent stream counts as a failure (answer-check.ts). */
  answerCheck?: boolean;
}

const D = '2026-11-07';
const perToken = (v: any) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e4) / 1e4 : undefined;
};
const perM = (v: any) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};
const pair = (a?: number, b?: number): [number, number] | undefined => (a !== undefined && b !== undefined ? [a, b] : undefined);
/** Credit on a key: "US$ 5,00", shown in the reader's notation ("US$5.00" in English); under a dollar up to four decimals. */
const usd = (n: number) => usdText(n, { max: n > 0 && n < 1 ? 4 : 2 });

/** Text-chat models only (no embeddings, audio, image generation, moderation, rerankers). */
const NOT_CHAT = /(embed|embedding|whisper|tts|transcribe|speech|audio|realtime|moderation|rerank|dall-e|imagen|image-gen|sora|veo|lyria|aqa|guard|bge-|clip|flux|stable-diffusion|sdxl)/i;

const keyErr = (e: any, keyUrl?: string): KeyCheckResult => {
  const x = explain(e, { keyUrl });
  return { ok: false, verified: false, detail: e?.message || String(e), hint: x.hint, category: x.category };
};

// ---------- model-list parsers ----------

function parseOpenRouter(m: any): Partial<ModelInfo> | null {
  const out = (m.architecture?.output_modalities || ['text']) as string[];
  if (!out.includes('text')) return null;
  const pIn = perToken(m.pricing?.prompt);
  const pOut = perToken(m.pricing?.completion);
  const params: string[] = m.supported_parameters || [];
  const free = String(m.id).endsWith(':free') || (pIn === 0 && pOut === 0);
  return {
    label: m.name,
    context: m.context_length,
    price: pair(pIn, pOut),
    free,
    vision: (m.architecture?.input_modalities || []).includes('image'),
    tools: params.includes('tools'),
    reasoning: params.includes('reasoning'),
  };
}

function parseTogether(m: any): Partial<ModelInfo> | null {
  if (m.type && m.type !== 'chat') return null;
  return { label: m.display_name, context: m.context_length, price: pair(perM(m.pricing?.input), perM(m.pricing?.output)) };
}

function parseDeepInfra(m: any): Partial<ModelInfo> | null {
  const md = m.metadata;
  if (md && Array.isArray(md.tags) && md.tags.length && !md.tags.some((t: string) => /text|chat|llm|reasoning|vision/i.test(t))) return null;
  return { context: md?.context_length, price: pair(perM(md?.pricing?.input_tokens), perM(md?.pricing?.output_tokens)), vision: md?.tags?.includes?.('vision') || undefined };
}

function parseHuggingFace(m: any): Partial<ModelInfo> | null {
  const live = (m.providers || []).filter((p: any) => p.status !== 'staging' && p.status !== 'error');
  let best: [number, number] | undefined;
  for (const p of live) {
    const pr = pair(perM(p.pricing?.input), perM(p.pricing?.output));
    if (pr && (!best || pr[0] + pr[1] < best[0] + best[1])) best = pr;
  }
  return { context: Math.max(0, ...live.map((p: any) => Number(p.context_length) || 0)) || undefined, price: best, tools: live.some((p: any) => p.supports_tools) || undefined };
}

function parseMistral(m: any): Partial<ModelInfo> | null {
  const c = m.capabilities;
  if (c && c.completion_chat === false) return null;
  if (m.deprecation && Date.parse(m.deprecation) < Date.now()) return null;
  return { context: m.max_context_length, vision: c?.vision, tools: c?.function_calling };
}

function parseGroq(m: any): Partial<ModelInfo> | null {
  if (m.active === false) return null;
  return { context: m.context_window };
}

// ---------- key checks (all free) ----------

async function openrouterKey(h: { base: string; headers: () => Promise<Record<string, string>>; label: string }): Promise<KeyCheckResult> {
  try {
    const j = await fetchJson(`${h.base}/key`, { headers: await h.headers() }, h.label);
    const d = j?.data || {};
    const remaining = typeof d.limit_remaining === 'number' ? d.limit_remaining : null;
    const fm = d.free_model_daily_requests;
    const freeLeft = fm && typeof fm.remaining === 'number' ? ` Vandaag nog ${fm.remaining} van ${fm.limit} gratis verzoeken.` : '';
    const credit = d.is_free_tier ? `Gratis account: alleen modellen op ":free"; koop tegoed voor de rest.${freeLeft}` : remaining !== null ? `Resterende limiet op deze sleutel: ${usd(remaining)}` : `Verbruikt met deze sleutel: ${usd(Number(d.usage) || 0)}`;
    if (remaining !== null && remaining <= 0) return { ok: false, verified: true, detail: `${h.label}: Geen tegoed — de limiet van deze sleutel is op.`, credit, category: 'quota', hint: 'Verhoog de limiet van de sleutel of koop tegoed op openrouter.ai, of gebruik alleen ":free"-modellen.' };
    return { ok: true, verified: true, detail: 'Sleutel werkt', credit };
  } catch (e) {
    return keyErr(e, 'https://openrouter.ai/keys');
  }
}

async function deepseekBalance(h: { base: string; headers: () => Promise<Record<string, string>>; label: string }): Promise<KeyCheckResult> {
  try {
    const j = await fetchJson(`${h.base.replace(/\/v1$/, '')}/user/balance`, { headers: await h.headers() }, h.label);
    const b = (j?.balance_infos || [])[0];
    const credit = b ? `Tegoed: ${b.total_balance} ${b.currency}` : undefined;
    if (j?.is_available === false) return { ok: false, verified: true, detail: `${h.label}: Geen tegoed${credit ? ` (${credit})` : ''}`, credit, category: 'quota', hint: 'Waardeer je DeepSeek-tegoed op via platform.deepseek.com/top_up.' };
    return { ok: true, verified: true, detail: 'Sleutel werkt', credit };
  } catch (e) {
    return keyErr(e, 'https://platform.deepseek.com/api_keys');
  }
}

async function moonshotBalance(h: { base: string; headers: () => Promise<Record<string, string>>; label: string }): Promise<KeyCheckResult> {
  try {
    const j = await fetchJson(`${h.base}/users/me/balance`, { headers: await h.headers() }, h.label);
    const avail = Number(j?.data?.available_balance);
    const credit = Number.isFinite(avail) ? `Beschikbaar tegoed: ${avail}` : undefined;
    if (Number.isFinite(avail) && avail <= 0) return { ok: false, verified: true, detail: `${h.label}: Geen tegoed`, credit, category: 'quota', hint: 'Waardeer je tegoed op via platform.moonshot.ai.' };
    return { ok: true, verified: true, detail: 'Sleutel werkt', credit };
  } catch (e) {
    return keyErr(e, 'https://platform.moonshot.ai/console/api-keys');
  }
}

async function huggingfaceWhoami(h: { base: string; headers: () => Promise<Record<string, string>>; label: string }): Promise<KeyCheckResult> {
  try {
    const url = /router\.huggingface\.co/.test(h.base) ? 'https://huggingface.co/api/whoami-v2' : `${h.base.replace(/\/v1$/, '')}/api/whoami-v2`;
    const j = await fetchJson(url, { headers: await h.headers() }, h.label);
    const role = j?.auth?.accessToken?.role;
    return { ok: true, verified: true, detail: 'Token werkt', credit: j?.isPro ? 'PRO-account: meer inbegrepen tegoed per maand' : 'Gratis account: klein maandelijks tegoed voor Inference Providers', hint: role === 'read' ? 'Let op: dit token heeft alleen leesrechten; zet "Make calls to Inference Providers" aan bij een fine-grained token.' : undefined };
  } catch (e) {
    return keyErr(e, 'https://huggingface.co/settings/tokens');
  }
}

/** OpenRouter's /models is paginated since 2026 (data + links.next). */
async function openrouterModels(h: { base: string; headers: () => Promise<Record<string, string>> }): Promise<ModelInfo[]> {
  const out: ModelInfo[] = [];
  let url: string | null = `${h.base}/models`;
  for (let page = 0; url && page < 20; page++) {
    const j: any = await fetchJson(url, { headers: await h.headers() }, 'OpenRouter');
    for (const m of j?.data || []) {
      const extra = parseOpenRouter(m);
      if (extra) out.push({ id: m.id, ...extra });
    }
    const next = j?.links?.next;
    url = typeof next === 'string' && next ? new URL(next, h.base + '/').toString() : null;
    if (url && new URL(url).origin !== new URL(h.base).origin) url = null; // never follow a link off the provider
  }
  return out;
}

/**
 * Kilo Gateway (OpenRouter-style list, public, no key needed; checked 2026-11-09): `isFree` marks the free models.
 * Without a key only the free models can be used, so only those are listed then.
 */
async function kiloModels(h: { base: string; headers: () => Promise<Record<string, string>> }): Promise<ModelInfo[]> {
  const hdr = await h.headers();
  const j: any = await fetchJson(`${h.base}/models`, { headers: hdr }, 'Kilo Gateway');
  const keyed = !!hdr.authorization;
  const out: ModelInfo[] = [];
  for (const m of j?.data || []) {
    const extra = parseOpenRouter(m);
    if (!extra || !m?.id) continue;
    const free = m.isFree === true || !!extra.free;
    if (!keyed && !free) continue;
    out.push({ id: String(m.id), ...extra, free: free || undefined });
  }
  return out;
}

/** Perplexity Orchestrator: allowlisted models with prices (usd_per_1m_tokens). */
function parsePerplexity(m: any): Partial<ModelInfo> | null {
  const pr = m.pricing;
  const factor = pr?.unit && !/1m/i.test(pr.unit) ? (/token/i.test(pr.unit) ? 1e6 : 1) : 1;
  return { price: pair(perM(pr?.input) !== undefined ? perM(pr.input)! * factor : undefined, perM(pr?.output) !== undefined ? perM(pr.output)! * factor : undefined) };
}

function parseDeepSeek(m: any): Partial<ModelInfo> | null {
  if (Array.isArray(m.output_modalities) && !m.output_modalities.includes('text')) return null;
  return { label: m.name && m.name !== m.id ? m.name : undefined, context: m.context_window, vision: Array.isArray(m.input_modalities) ? m.input_modalities.includes('image') : undefined, reasoning: !!m.effort || undefined };
}

const ZAI_FREE = /^glm-(4\.7|4\.5|4\.6v)-flash$/i;

async function cloudflareModels(h: { base: string; headers: () => Promise<Record<string, string>> }): Promise<ModelInfo[]> {
  const root = h.base.replace(/\/ai\/v1$/, '');
  const j = await fetchJson(`${root}/ai/models/search?task=Text%20Generation&per_page=200`, { headers: await h.headers() }, 'Cloudflare Workers AI');
  return (j?.result || []).map((m: any) => {
    const props: any[] = m.properties || [];
    const prop = (id: string) => props.find((p) => p.property_id === id)?.value;
    const price = Array.isArray(prop('price')) ? prop('price') : [];
    const pin = price.find((p: any) => /input/i.test(p.unit))?.price;
    const pout = price.find((p: any) => /output/i.test(p.unit))?.price;
    return { id: m.name, context: Number(prop('context_window')) || undefined, tools: String(prop('function_calling')) === 'true' || undefined, price: pair(perM(pin), perM(pout)) };
  });
}

const BEDROCK_REGIONS = ['us-east-1', 'us-east-2', 'us-west-2', 'eu-central-1', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-north-1', 'eu-south-1', 'ap-northeast-1', 'ap-southeast-1', 'ap-southeast-2', 'ap-south-1', 'ca-central-1', 'sa-east-1'];
const VERTEX_LOCATIONS = ['global', 'us-central1', 'us-east5', 'europe-west1', 'europe-west4', 'europe-west9', 'asia-northeast1'];
const LOCAL_NOTE = 'Gratis; draait op je eigen computer.';

export const PROVIDERS: ProviderDef[] = [
  // ---------------- Gratis ----------------
  {
    id: 'google',
    label: 'Google Gemini',
    section: 'free',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    needsKey: true,
    keyUrl: 'https://aistudio.google.com/apikey',
    keyPlaceholder: 'AIza...',
    description: 'Gemini-modellen via de Gemini API (Google AI Studio). Werkt met tools, afbeeldingen en denkniveaus.',
    costNote: 'Gratis tier zonder betaalgegevens voor de Flash- en Flash-Lite-modellen, met limieten per minuut en per dag die je in AI Studio ziet (reset om middernacht Pacific-tijd); Pro- en Argon-modellen alleen betaald. In de gratis tier mag Google je invoer gebruiken om producten te verbeteren. Een app die je aan gebruikers in de EER, Zwitserland of het VK aanbiedt, mag volgens de voorwaarden van Google alleen de betaalde laag gebruiken; daarom staat de gratis laag niet bij "Gratis modellen".',
    costCheckedAt: '2026-11-09',
    pricingUrl: 'https://aistudio.google.com/docs/pricing',
    recommend: [/^gemini-\d+(\.\d+)?-flash$/, /^gemini-\d+(\.\d+)?-flash-lite$/, /^gemini-flash-latest$/],
    models: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'],
    reasoning: 'effort',
    modelFilter: (id) => /gemini|gemma/i.test(id) && !NOT_CHAT.test(id) && !/(-tts|native-audio|live|image|robotics|computer-use)/i.test(id),
  },
  {
    id: 'groq',
    label: 'Groq',
    section: 'free',
    baseUrl: 'https://api.groq.com/openai/v1',
    needsKey: true,
    keyUrl: 'https://console.groq.com/keys',
    keyPlaceholder: 'gsk_...',
    description: 'Zeer snelle open modellen (gpt-oss, Qwen). Ook Whisper-spraakherkenning.',
    costNote: 'Gratis plan zonder creditcard; je limieten per model (verzoeken en tokens per minuut en per dag) staan in de Groq-console onder Limits. Developer-plan: per token met hogere limieten.',
    costCheckedAt: D,
    pricingUrl: 'https://groq.com/pricing',
    // Llama 3.x on Groq stopped in August 2026; the rate-limit page (checked 2026-11-09) lists gpt-oss and Qwen.
    recommend: ['openai/gpt-oss-120b', /^qwen\/qwen3/, 'openai/gpt-oss-20b'],
    models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'],
    reasoning: 'effort',
    parseModel: parseGroq,
    modelFilter: (id) => !NOT_CHAT.test(id) && !/(playai|orpheus|prompt-guard|safeguard|compound)/i.test(id),
    answerCheck: true,
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    section: 'free',
    baseUrl: 'https://api.cerebras.ai/v1',
    needsKey: true,
    keyUrl: 'https://cloud.cerebras.ai/platform',
    keyPlaceholder: 'csk-...',
    description: 'Extreem snelle inferentie van open modellen (gpt-oss, Qwen).',
    costNote: 'Gratis proefniveau: 5 verzoeken per minuut, tot 1 miljoen tokens per uur en per dag, en een kleiner contextvenster (~64k). Betaald: per token, met het volle venster.',
    costCheckedAt: D,
    pricingUrl: 'https://www.cerebras.ai/pricing',
    recommend: ['gpt-oss-120b', /^qwen-3/],
    models: ['gpt-oss-120b', 'qwen-3.8-27b'],
    reasoning: 'effort',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    section: 'free',
    baseUrl: 'https://api.mistral.ai/v1',
    needsKey: true,
    keyUrl: 'https://console.mistral.ai/api-keys',
    description: 'Europese modellen (Mistral Small, Medium en Large, Codestral, Devstral), gehost in de EU.',
    costNote: 'Gratis "Experiment"-abonnement (telefoonverificatie) met lage limieten die je in de console ziet; je gegevens mogen dan voor training worden gebruikt. Scale-abonnement: per token.',
    costCheckedAt: D,
    pricingUrl: 'https://mistral.ai/pricing#api-pricing',
    recommend: ['mistral-medium-latest', /^mistral-medium-\d/, 'mistral-small-latest', /^mistral-small-\d/, /^mistral-large-/],
    models: ['mistral-small-2603', 'mistral-medium-3-5', 'mistral-large-4-0'],
    reasoning: 'effort',
    parseModel: parseMistral,
    modelFilter: (id) => !NOT_CHAT.test(id) && !/(ocr|moderation|voxtral|-embed)/i.test(id),
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    section: 'free',
    baseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    keyUrl: 'https://openrouter.ai/keys',
    keyPlaceholder: 'sk-or-v1-...',
    description: 'Honderden modellen via één sleutel, inclusief gratis modellen (namen eindigen op ":free"). Prijzen per model komen live uit de modellenlijst.',
    costNote: 'Modellen op ":free" kosten niets: 20 verzoeken per minuut en 50 per dag (1.000 per dag zodra je ooit minstens $10 tegoed kocht). Andere modellen: de prijs van de onderliggende provider, met vooraf gekocht tegoed.',
    costCheckedAt: D,
    pricingUrl: 'https://openrouter.ai/models',
    recommend: [/^openai\/gpt-oss-120b:free$/, /^deepseek\/.*:free$/, /^qwen\/qwen3.*:free$/, /^meta-llama\/llama-3\.3-70b-instruct:free$/, /:free$/],
    reasoning: 'openrouter',
    listModels: openrouterModels,
    keyCheck: openrouterKey,
    headers: { 'HTTP-Referer': 'https://github.com/teambot-app/teambot', 'X-Title': 'TeamBot', 'X-OpenRouter-Title': 'TeamBot' },
    answerCheck: true,
  },
  {
    id: 'zai',
    label: 'Z.ai GLM',
    section: 'free',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    needsKey: true,
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    description: 'GLM-modellen van Zhipu / Z.ai, sterk in programmeren en tools.',
    costNote: 'GLM-4.7-Flash, GLM-4.5-Flash en GLM-4.6V-Flash zijn gratis (wel een account en sleutel nodig). Andere modellen (zoals GLM-5.3) per token; een GLM Coding Plan gebruik je via een CLI.',
    costCheckedAt: D,
    pricingUrl: 'https://docs.z.ai/guides/overview/pricing',
    recommend: ['glm-4.7-flash', /^glm-5\.\d+$/, /^glm-4\.\d+$/],
    models: ['glm-4.7-flash', 'glm-4.5-flash', 'glm-5.3', 'glm-5.3-flash'],
    reasoning: 'zai',
    replayReasoning: 'loop',
    parseModel: (m) => (ZAI_FREE.test(String(m.id)) ? { free: true } : {}),
    answerCheck: true,
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    section: 'free',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    needsKey: true,
    keyUrl: 'https://build.nvidia.com/settings/api-keys',
    keyPlaceholder: 'nvapi-...',
    description: 'Open modellen gehost door NVIDIA (Nemotron, Llama, DeepSeek, Qwen, ...).',
    costNote: 'Gratis voor prototypen met een NVIDIA Developer-account, met een vaste limiet per minuut (ongeveer 40 verzoeken). Niet bedoeld voor productie.',
    costCheckedAt: D,
    pricingUrl: 'https://build.nvidia.com/explore/discover',
    recommend: [/^nvidia\/nemotron-3-super/, /^deepseek-ai\/deepseek-v4/, /^meta\/llama-3\.3-70b-instruct$/, /^openai\/gpt-oss-120b$/],
    models: ['nvidia/nemotron-3-super-120b-a12b', 'meta/llama-3.1-8b-instruct', 'deepseek-ai/deepseek-v4-pro'],
    modelFilter: (id) => !NOT_CHAT.test(id) && !/(nemoretriever|parakeet|fastpitch|riva|cosmos|vila|nv-embed|reward)/i.test(id),
    // The model list answers without a key (checked live: a made-up key gets the full list), so it proves nothing.
    publicModelList: true,
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare Workers AI',
    section: 'free',
    adapter: 'cloudflare',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1',
    needsKey: true,
    keyUrl: 'https://dash.cloudflare.com/?to=/:account/ai/workers-ai',
    keyLabel: 'Workers AI API-token',
    description: 'Open modellen op het netwerk van Cloudflare (gpt-oss, Llama, Qwen, Mistral, ...). Maak het token via Workers AI › "Use REST API".',
    costNote: 'Gratis 10.000 "neurons" per dag (reset 00:00 UTC), ook zonder betaald abonnement; daarboven $0,011 per 1.000 neurons met Workers Paid. Kimi-, GLM- en DeepSeek V4-modellen alleen met Workers Paid. Prijzen per model komen live uit de lijst.',
    costCheckedAt: D,
    pricingUrl: 'https://developers.cloudflare.com/workers-ai/platform/pricing/',
    recommend: ['@cf/openai/gpt-oss-120b', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct'],
    models: ['@cf/openai/gpt-oss-120b', '@cf/meta/llama-3.1-8b-instruct'],
    listModels: cloudflareModels,
    fields: [{ key: 'accountId', label: 'Account-ID', placeholder: '32 tekens', required: true, hint: 'Staat in het Cloudflare-dashboard bij Workers AI › "Use REST API", naast het token.' }],
    answerCheck: true,
  },
  {
    id: 'kilo',
    label: 'Kilo Gateway',
    section: 'free',
    baseUrl: 'https://ai-gateway.kilo.ai/api/v1',
    needsKey: false,
    keyOptional: true,
    keyUrl: 'https://app.kilo.ai/profile',
    keyLabel: 'Kilo Gateway API-sleutel',
    description: 'Gratis modellen via de Kilo Gateway, ook zonder account of sleutel. Met de sleutel van je Kilo-account ook de andere modellen, met Kilo-tegoed.',
    costNote: 'Zonder sleutel: alleen de gratis modellen, 200 verzoeken per uur per internetadres. Gratis modellen kunnen door de onderliggende aanbieder extra worden beperkt, en die mag je vragen bewaren en gebruiken om zijn diensten te verbeteren.',
    costCheckedAt: '2026-11-09',
    pricingUrl: 'https://kilo.ai/docs/gateway/models-and-providers',
    recommend: [/^nvidia\/nemotron-3-ultra.*:free$/, /^nvidia\/nemotron-3\.5-super.*:free$/, /:free$/],
    reasoning: 'openrouter',
    listModels: kiloModels,
    publicModelList: true,
    answerCheck: true,
  },

  // ---------------- Met API-sleutel ----------------
  {
    id: 'openai',
    label: 'OpenAI (API)',
    section: 'key',
    baseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    keyUrl: 'https://platform.openai.com/api-keys',
    keyPlaceholder: 'sk-...',
    description: 'GPT-modellen via de OpenAI API. Ook nodig voor live spraak (Realtime) en Whisper.',
    billingNote: 'Betaal per gebruik via je OpenAI API-account (los van een ChatGPT-abonnement). Gebruik je ChatGPT-abonnement via de Codex-koppeling.',
    costNote: 'Betaald per token met vooraf gekocht tegoed; geen gratis tier. Je ChatGPT-abonnement telt hier niet: dat gebruik je via de Codex-CLI.',
    costCheckedAt: D,
    pricingUrl: 'https://developers.openai.com/api/docs/pricing',
    recommend: [/^gpt-6(\.\d+)?-terra$/, /^gpt-6(\.\d+)?-luna$/, /^gpt-6(\.\d+)?-sol$/, /^gpt-5(\.\d+)?-mini$/, /^gpt-5(\.\d+)?$/, /^gpt-4\.1-mini$/],
    reasoning: 'effort',
    maxCompletionTokens: true,
    modelFilter: (id) => /^(gpt|o\d|chatgpt|codex)/i.test(id) && !/(audio|realtime|transcribe|tts|image|embedding|moderation|search|instruct)/i.test(id),
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude (API)',
    section: 'key',
    adapter: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    needsKey: true,
    keyUrl: 'https://platform.claude.com/settings/keys',
    keyPlaceholder: 'sk-ant-...',
    description: 'Claude-modellen via de officiële Anthropic API (adaptive thinking, prompt caching).',
    billingNote: 'Betaal per gebruik via je Anthropic API-account. Je Claude-abonnement gebruik je via de Claude Code-koppeling.',
    costNote: 'Betaald per token met vooraf gekocht tegoed; geen gratis tier. Je Claude Pro/Max-abonnement telt hier niet: dat gebruik je via Claude Code.',
    costCheckedAt: D,
    pricingUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
    recommend: ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'],
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
  },
  {
    id: 'xai',
    label: 'xAI Grok',
    section: 'key',
    baseUrl: 'https://api.x.ai/v1',
    needsKey: true,
    keyUrl: 'https://console.x.ai/team/default/api-keys',
    keyPlaceholder: 'xai-...',
    description: 'Grok-modellen van xAI, met tools en afbeeldingen.',
    costNote: 'Betaald per token met tegoed op console.x.ai; geen vaste gratis tier. Vragen van 200k tokens of meer kosten het dubbele.',
    costCheckedAt: D,
    pricingUrl: 'https://docs.x.ai/docs/models',
    recommend: [/^grok-4\.\d+$/, /^grok-build/, /^grok-4/],
    models: ['grok-4.7', 'grok-4.3', 'grok-build-0.1'],
    reasoning: 'xai',
    modelFilter: (id) => !/(image|imagine|video|embed|vision-beta|multi-agent)/i.test(id),
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    section: 'key',
    baseUrl: 'https://api.deepseek.com',
    needsKey: true,
    keyUrl: 'https://platform.deepseek.com/api_keys',
    keyPlaceholder: 'sk-...',
    description: 'DeepSeek V4-modellen (denken staat standaard aan); voordelig, met korting op gecachete invoer.',
    costNote: 'Betaald per token met vooraf gekocht tegoed, zeer voordelig; geen gratis tier. De test controleert je tegoed gratis.',
    costCheckedAt: D,
    pricingUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
    recommend: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-chat'],
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    reasoning: 'deepseek',
    replayReasoning: 'all',
    parseModel: parseDeepSeek,
    keyCheck: deepseekBalance,
  },
  {
    id: 'moonshot',
    label: 'Moonshot Kimi',
    section: 'key',
    baseUrl: 'https://api.moonshot.ai/v1',
    needsKey: true,
    keyUrl: 'https://platform.moonshot.ai/console/api-keys',
    keyPlaceholder: 'sk-...',
    description: 'Kimi-modellen van Moonshot AI (Kimi K3 en K2.6). Een sleutel van het Chinese platform werkt hier niet.',
    costNote: 'Betaald per token met vooraf gekocht tegoed. De test controleert je tegoed gratis.',
    costCheckedAt: D,
    pricingUrl: 'https://platform.kimi.ai/docs/pricing/chat',
    recommend: ['kimi-k2.6', /^kimi-k3(\.\d+)?$/, /^kimi-k3/, /^kimi-k2/],
    models: ['kimi-k2.6', 'kimi-k3', 'kimi-k3.1-pro'],
    replayReasoning: 'loop',
    keyCheck: moonshotBalance,
  },
  {
    id: 'qwen',
    label: 'Alibaba Qwen (Model Studio)',
    section: 'key',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    needsKey: true,
    keyUrl: 'https://modelstudio.console.alibabacloud.com/?tab=playground#/api-key',
    keyPlaceholder: 'sk-...',
    description: 'Qwen-modellen via Alibaba Cloud Model Studio (internationaal, Singapore). De sleutel werkt alleen in de regio waar je hem maakte.',
    costNote: 'Betaald per token; nieuwe accounts krijgen in Singapore (internationaal) ongeveer 1 miljoen gratis tokens per model, 90 dagen geldig. Met "Free Quota Only" aan krijg je een fout in plaats van kosten.',
    costCheckedAt: D,
    pricingUrl: 'https://www.alibabacloud.com/help/en/model-studio/new-free-quota',
    recommend: ['qwen-flash', 'qwen-plus', /^qwen3\.\d+-flash$/, /^qwen3\.\d+-plus$/],
    models: ['qwen-flash', 'qwen-plus', 'qwen3.8-flash', 'qwen3.7-plus'],
    reasoning: 'qwen',
    modelFilter: (id) => !NOT_CHAT.test(id) && !/(wanx|wan2|-tts|-asr|-mt-|paraformer|cosyvoice|sambert|-image|omni)/i.test(id),
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    section: 'key',
    baseUrl: 'https://api.minimax.io/v1',
    needsKey: true,
    keyUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    description: 'MiniMax-modellen (M3-serie, 1M context), sterk in agent-taken en programmeren.',
    costNote: 'Betaald per token met vooraf gekocht tegoed (of een Token Plan).',
    costCheckedAt: D,
    pricingUrl: 'https://platform.minimax.io/docs/pricing/overview',
    recommend: ['MiniMax-M3.1-Flash', 'MiniMax-M3'],
    models: ['MiniMax-M3.1-Flash', 'MiniMax-M3'],
    // Without this M3.1-Flash refuses; with it the thinking arrives in reasoning_content instead of <think> tags.
    extraBody: { reasoning_split: true },
  },
  {
    id: 'together',
    label: 'Together AI',
    section: 'key',
    baseUrl: 'https://api.together.ai/v1',
    needsKey: true,
    keyUrl: 'https://api.together.ai/settings/api-keys',
    description: 'Open modellen (gpt-oss, Llama, Qwen, DeepSeek, Kimi, ...) in de cloud. Prijzen per model komen live uit de lijst.',
    costNote: 'Betaald per token met tegoed; geen vaste gratis tier.',
    costCheckedAt: D,
    pricingUrl: 'https://www.together.ai/pricing',
    recommend: ['openai/gpt-oss-120b', 'meta-llama/Llama-3.3-70B-Instruct-Turbo', /^Qwen\/Qwen3/, /^deepseek-ai\/DeepSeek-V/],
    reasoning: 'effort',
    parseModel: parseTogether,
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    section: 'key',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    needsKey: true,
    keyUrl: 'https://app.fireworks.ai/settings/users/api-keys',
    keyPlaceholder: 'fw_...',
    description: 'Snelle hosting van open modellen (Kimi, MiniMax, GLM, gpt-oss, ...).',
    costNote: 'Betaald per token. Zonder betaalmethode maximaal 10 verzoeken per minuut.',
    costCheckedAt: D,
    pricingUrl: 'https://fireworks.ai/pricing',
    recommend: [/gpt-oss-120b$/, /kimi-k2/, /glm-4p7/, /minimax-m2/],
    reasoning: 'effort',
    modelFilter: (id) => !NOT_CHAT.test(id),
  },
  {
    id: 'deepinfra',
    label: 'DeepInfra',
    section: 'key',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    needsKey: true,
    keyUrl: 'https://deepinfra.com/dash/api_keys',
    description: 'Voordelige hosting van open modellen.',
    costNote: 'Betaald per token (achteraf, met een limiet die je zelf instelt); geen gratis tier.',
    costCheckedAt: D,
    pricingUrl: 'https://deepinfra.com/pricing',
    recommend: ['openai/gpt-oss-120b', 'meta-llama/Llama-3.3-70B-Instruct-Turbo', /^Qwen\/Qwen3/, /^deepseek-ai\/DeepSeek-V/],
    reasoning: 'effort',
    parseModel: parseDeepInfra,
    modelFilter: (id) => !NOT_CHAT.test(id),
  },
  {
    id: 'huggingface',
    label: 'Hugging Face',
    section: 'key',
    baseUrl: 'https://router.huggingface.co/v1',
    needsKey: true,
    keyUrl: 'https://huggingface.co/settings/tokens/new?ownUserPermissions=inference.serverless.write&tokenType=fineGrained',
    keyPlaceholder: 'hf_...',
    keyLabel: 'Hugging Face-token',
    description: 'Duizenden open modellen via Inference Providers (Cerebras, Groq, Together, Fireworks, ...), met één token. Prijzen per model komen live uit de lijst.',
    costNote: 'Gratis accounts krijgen geen maandtegoed meer: koop tegoed, of neem PRO ($2 per maand inbegrepen). Je betaalt de prijs van de gekozen provider, zonder opslag.',
    costCheckedAt: D,
    pricingUrl: 'https://huggingface.co/docs/inference-providers/pricing',
    recommend: ['openai/gpt-oss-120b', /^deepseek-ai\/DeepSeek-V4/, /^Qwen\/Qwen3/, /^meta-llama\/Llama-3\.3-70B-Instruct$/],
    parseModel: parseHuggingFace,
    keyCheck: huggingfaceWhoami,
    publicModelList: true,
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    section: 'key',
    baseUrl: 'https://api.perplexity.ai/orchestrator/v1',
    needsKey: true,
    keyUrl: 'https://www.perplexity.ai/account/api/keys',
    keyPlaceholder: 'pplx-...',
    description: 'Modellen via de Perplexity Orchestrator API (OpenAI-formaat): Kimi, GLM, DeepSeek en Nemotron, met prijzen live uit de lijst.',
    costNote: 'Betaald per token; geen gratis tier. Alleen de modellen in de lijst van Perplexity zijn toegestaan.',
    costCheckedAt: D,
    pricingUrl: 'https://docs.perplexity.ai/api-reference/gateway-models-get',
    recommend: [/^perplexity\/kimi/, /^perplexity\/glm/, /^perplexity\/deepseek/],
    models: ['perplexity/kimi-k3', 'perplexity/glm-5.3', 'perplexity/deepseek-v4-pro-0813'],
    reasoning: 'effort',
    parseModel: parsePerplexity,
    publicModelList: true,
    experimental: true,
  },
  {
    id: 'azure',
    label: 'Azure OpenAI',
    section: 'key',
    adapter: 'azure',
    baseUrl: '',
    needsKey: true,
    keyUrl: 'https://ai.azure.com',
    keyLabel: 'API-sleutel van je Azure-resource',
    description: 'OpenAI-modellen (en DeepSeek, Grok, ...) in je eigen Azure-abonnement via de v1-API. Het model is de naam van je deployment.',
    costNote: 'Betaald via je Azure-abonnement, per token volgens het Azure-tarief van je regio.',
    costCheckedAt: D,
    pricingUrl: 'https://azure.microsoft.com/pricing/details/cognitive-services/openai-service/',
    maxCompletionTokens: true,
    reasoning: 'effort',
    fields: [{ key: 'base_url', label: 'Adres van je resource', placeholder: 'https://<naam>.openai.azure.com', required: true, hint: 'Staat in de Azure-portal bij "Keys and Endpoint" (ook *.services.ai.azure.com werkt). TeamBot voegt zelf /openai/v1 toe.' }],
  },
  {
    id: 'bedrock',
    label: 'Amazon Bedrock',
    section: 'key',
    adapter: 'bedrock',
    baseUrl: '',
    needsKey: true,
    keyUrl: 'https://console.aws.amazon.com/bedrock/home#/api-keys',
    keyLabel: 'Bedrock API-sleutel, of ACCESS_KEY_ID:SECRET_ACCESS_KEY',
    keyPlaceholder: 'ABSK... of AKIA...:...',
    description: 'Claude, Llama, Mistral, Nova, DeepSeek, gpt-oss en meer in je eigen AWS-account (Converse API). Werkt met een Bedrock API-sleutel of IAM-sleutels (SigV4).',
    costNote: 'Betaald via je AWS-rekening, per token volgens het Bedrock-tarief van je regio. Zet modeltoegang aan in de Bedrock-console.',
    costCheckedAt: D,
    pricingUrl: 'https://aws.amazon.com/bedrock/pricing/',
    recommend: [/^(eu|us|global)\.anthropic\.claude-sonnet/, /anthropic\.claude-sonnet/, /amazon\.nova-pro/, /openai\.gpt-oss-120b/, /meta\.llama/],
    models: ['openai.gpt-oss-120b-1:0', 'amazon.nova-pro-v1:0'],
    fields: [{ key: 'region', label: 'Regio', required: true, options: BEDROCK_REGIONS.map((r) => ({ value: r, label: r })), hint: 'De AWS-regio waar je modeltoegang hebt aangezet (bijv. eu-central-1 voor Frankfurt).' }],
  },
  {
    id: 'vertex',
    label: 'Google Vertex AI',
    section: 'key',
    adapter: 'vertex',
    baseUrl: '',
    needsKey: true,
    keyUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    keyLabel: 'Service-account-sleutel (JSON) of toegangstoken',
    keyPlaceholder: '{"type": "service_account", ...}',
    description: 'Gemini (en partnermodellen) in je eigen Google Cloud-project, via het OpenAI-compatibele Vertex-endpoint. Alleen Google Cloud-login (service account), geen API-sleutel.',
    costNote: 'Betaald via je Google Cloud-rekening, per token volgens het Vertex-tarief. Nieuwe Cloud-accounts krijgen vaak eenmalig starttegoed.',
    costCheckedAt: D,
    pricingUrl: 'https://cloud.google.com/vertex-ai/generative-ai/pricing',
    recommend: [/^google\/gemini-\d+(\.\d+)?-flash$/, /^google\/gemini-\d+(\.\d+)?-flash-lite$/],
    models: ['google/gemini-3.5-flash', 'google/gemini-3.8-flash', 'google/gemini-3.5-flash-lite'],
    reasoning: 'effort',
    fields: [
      { key: 'project', label: 'Project-ID', placeholder: 'mijn-project-123', hint: 'Leeg = het project uit het service-account-bestand.' },
      { key: 'location', label: 'Locatie', options: VERTEX_LOCATIONS.map((l) => ({ value: l, label: l })), hint: '"global" heeft de meeste modellen; kies een EU-regio als je data in de EU moet blijven.' },
    ],
  },
  {
    id: 'github',
    label: 'GitHub Models',
    section: 'free',
    baseUrl: 'https://models.github.ai/inference',
    needsKey: true,
    keyUrl: 'https://github.com/settings/personal-access-tokens/new',
    description: 'GitHub Models is op 30 juli 2026 gestopt (GitHub verwijst naar Microsoft Foundry). Kies een andere provider, bijv. OpenRouter (gratis modellen) of Azure OpenAI.',
    costNote: 'Gestopt op 30 juli 2026.',
    costCheckedAt: D,
    retired: '2026-07-30',
    usageInStream: false,
  },
  {
    id: 'openai-compatible',
    label: 'Eigen endpoint (OpenAI-compatibel)',
    section: 'key',
    baseUrl: '',
    needsKey: false,
    keyOptional: true,
    description: 'Elke OpenAI-compatibele server: LiteLLM, een eigen proxy, een server in je netwerk, ...',
    costNote: 'Afhankelijk van je eigen server; vul zo nodig je eigen prijzen in bij "Prijzen".',
    costCheckedAt: D,
  },

  // ---------------- Lokaal ----------------
  { id: 'ollama', label: 'Ollama (lokaal)', section: 'local', baseUrl: 'http://127.0.0.1:11434/v1', needsKey: false, description: 'Gratis lokale modellen op je eigen computer via Ollama.', billingNote: 'Gratis; draait op je eigen hardware.', costNote: LOCAL_NOTE, costCheckedAt: D },
  { id: 'lmstudio', label: 'LM Studio (lokaal)', section: 'local', baseUrl: 'http://127.0.0.1:1234/v1', needsKey: false, description: 'Gratis lokale modellen via de LM Studio-server (zet "Start server" aan in LM Studio).', billingNote: 'Gratis; draait op je eigen hardware.', costNote: LOCAL_NOTE, costCheckedAt: D },
  { id: 'llamacpp', label: 'llama.cpp server (lokaal)', section: 'local', baseUrl: 'http://127.0.0.1:9931/v1', altBases: ['http://127.0.0.1:8080/v1'], needsKey: false, keyOptional: true, description: 'De llama-server van llama.cpp met een GGUF-model (nieuwe standaardpoort 9931; oudere versies en Docker: 8080).', costNote: LOCAL_NOTE, costCheckedAt: D },
  { id: 'vllm', label: 'vLLM (lokaal of eigen server)', section: 'local', baseUrl: 'http://127.0.0.1:8000/v1', needsKey: false, keyOptional: true, description: 'vLLM-server ("vllm serve <model>", standaard poort 8000), ook op een eigen GPU-server.', costNote: 'Gratis software; je betaalt alleen je eigen hardware.', costCheckedAt: D },
  { id: 'jan', label: 'Jan (lokaal)', section: 'local', baseUrl: 'http://127.0.0.1:1337/v1', needsKey: false, keyOptional: true, description: 'De lokale API-server van Jan (zet hem aan in Jan › Instellingen › Local API Server; een API-sleutel die je daar instelt vul je hier in).', costNote: LOCAL_NOTE, costCheckedAt: D },
  { id: 'localai', label: 'LocalAI (lokaal)', section: 'local', baseUrl: 'http://127.0.0.1:8080/v1', needsKey: false, keyOptional: true, description: 'LocalAI, een OpenAI-compatibele server voor lokale modellen (standaard poort 8080).', costNote: LOCAL_NOTE, costCheckedAt: D, experimental: true },
  { id: 'lemonade', label: 'Lemonade (lokaal, AMD)', section: 'local', baseUrl: 'http://127.0.0.1:13305/v1', altBases: ['http://127.0.0.1:8000/api/v1'], needsKey: false, description: 'Lemonade Server voor AMD Ryzen AI en Radeon (NPU en GPU), standaard poort 13305.', costNote: LOCAL_NOTE, costCheckedAt: D, experimental: true },
  { id: 'koboldcpp', label: 'KoboldCpp (lokaal)', section: 'local', baseUrl: 'http://127.0.0.1:5001/v1', needsKey: false, keyOptional: true, description: 'KoboldCpp met zijn OpenAI-compatibele API (standaard poort 5001).', costNote: LOCAL_NOTE, costCheckedAt: D, experimental: true },
  { id: 'textgen-webui', label: 'Text Generation WebUI (lokaal)', section: 'local', baseUrl: 'http://127.0.0.1:5000/v1', needsKey: false, keyOptional: true, description: 'oobabooga text-generation-webui gestart met --api (standaard poort 5000).', costNote: LOCAL_NOTE, costCheckedAt: D, experimental: true },
  { id: 'gpt4all', label: 'GPT4All (lokaal)', section: 'local', baseUrl: 'http://127.0.0.1:4891/v1', needsKey: false, description: 'De lokale API-server van GPT4All (zet "Enable Local API Server" aan; poort 4891, alleen 127.0.0.1).', costNote: LOCAL_NOTE, costCheckedAt: D, experimental: true },
];

export const LOCAL_IDS = new Set(PROVIDERS.filter((p) => p.section === 'local').map((p) => p.id));

/** Default model: the first recommendation present in the live list (newest version first within a pattern). */
export function pickDefault(models: { id: string }[], recommend: (string | RegExp)[] = []): string | undefined {
  for (const r of recommend) {
    const hits = models.filter((m) => (typeof r === 'string' ? m.id === r : r.test(m.id)));
    if (hits.length) return hits.map((m) => m.id).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))[0];
  }
  return undefined;
}

