import type { ModelInfo } from '../../core/types.js';
import { LOCAL_IDS } from '../../providers/catalog.js';

/**
 * The free sources TeamBot uses for the free-model chain, with their limits and terms (checked 2026-11-09 on the
 * pages in `docs`). One account per provider: quota counts per account (OpenRouter, Cloudflare, Kilo) or per model
 * of one account (Groq), never per key, and combining accounts to stack free limits is not allowed (OpenRouter
 * terms §7(3)).
 *
 * Not here on purpose:
 *  - Google Gemini's free tier: its terms allow only Paid Services in apps offered to users in the EEA, CH and UK.
 *  - OpenCode Zen's servers: their free models are for OpenCode itself, so TeamBot reaches them only through the
 *    OpenCode CLI engine (kind "opencode"), never by calling Zen directly.
 *  - Mistral, NVIDIA, Cerebras: trial or "may train" terms without published numbers; still usable as normal providers.
 */

export const CHECKED = '2026-11-09';

export interface FreeSourceDef {
  /** Provider kind id (server/providers/catalog.ts or a CLI kind). */
  kind: string;
  label: string;
  /** api = HTTP adapter (probed); cli = agent CLI with its own tools (never probed); local = own hardware. */
  engine: 'api' | 'cli' | 'local';
  /** Shown as a row with on/off and key in the "Gratis modellen" card. */
  card: boolean;
  needsKey: boolean;
  signupUrl?: string;
  /** Extra setting beside the key (Cloudflare account). */
  fields?: { key: string; label: string; placeholder?: string; hint?: string; pattern?: RegExp; invalid?: string }[];
  /** Which listed models are free to use. */
  isFree(m: ModelInfo): boolean;
  /** What a 429 blocks: the whole account, or only that model of the account (Groq: limits per model). */
  quotaScope: 'account' | 'model';
  /** The daily counter restarts at 00:00 UTC (OpenRouter, Cloudflare). */
  dailyReset?: 'utc';
  /** Requests per hour without a key, counted by TeamBot (Kilo: 200 per IP). */
  hourlyAnon?: number;
  /** Probes per day for the whole account (they come out of the same free quota). */
  probesPerDay: number;
  /** Preference among free sources (lower first). */
  rank: number;
  /** The free limit in one plain sentence. */
  limitNote: string;
  docs: { limits: string; terms: string; checked: string };
}

/** Auto routers pick a random model per request: no stable label possible, so they stay out of the catalogue. */
export const ROUTER = /^(openrouter\/|kilo-auto\/)/i;
const ZAI_FREE = /^glm-(4\.7|4\.5|4\.6v)-flash$/i;
/** Workers AI models that need Workers Paid or AI Gateway credit (pricing page, checked 2026-11-09). */
const CF_PAID = /(kimi-k2\.[67]|glm-5\.[23]|deepseek-v4)/i;

export const FREE_SOURCES: FreeSourceDef[] = [
  {
    kind: 'opencode',
    label: 'OpenCode',
    engine: 'cli',
    card: false,
    needsKey: false,
    isFree: (m) => m.billing === 'free',
    quotaScope: 'account',
    probesPerDay: 0,
    rank: 0,
    limitNote: 'De gratis modellen van OpenCode Zen, alleen via OpenCode zelf. OpenCode noemt geen vaste limiet.',
    docs: { limits: 'https://opencode.ai/docs/zen', terms: 'https://opencode.ai/docs/zen', checked: CHECKED },
  },
  {
    kind: 'groq',
    label: 'Groq',
    engine: 'api',
    card: true,
    needsKey: true,
    signupUrl: 'https://console.groq.com/keys',
    isFree: () => true,
    quotaScope: 'model',
    probesPerDay: 6,
    rank: 1,
    limitNote: 'Gratis plan zonder creditcard: per model een vaste limiet per minuut en per dag (ongeveer 1.000 verzoeken per dag); je eigen limieten staan in de Groq-console.',
    docs: { limits: 'https://console.groq.com/docs/rate-limits', terms: 'https://console.groq.com/docs/your-data', checked: CHECKED },
  },
  {
    kind: 'openrouter',
    label: 'OpenRouter',
    engine: 'api',
    card: true,
    needsKey: true,
    signupUrl: 'https://openrouter.ai/keys',
    isFree: (m) => /:free$/i.test(m.id),
    quotaScope: 'account',
    dailyReset: 'utc',
    probesPerDay: 3,
    rank: 2,
    limitNote: 'Alleen modellen op ":free": 20 verzoeken per minuut en 50 per dag voor het hele account (1.000 per dag als je ooit $10 tegoed kocht).',
    docs: { limits: 'https://openrouter.ai/docs/api/reference/limits', terms: 'https://openrouter.ai/terms', checked: CHECKED },
  },
  {
    kind: 'cloudflare',
    label: 'Cloudflare Workers AI',
    engine: 'api',
    card: true,
    needsKey: true,
    signupUrl: 'https://dash.cloudflare.com/?to=/:account/ai/workers-ai',
    fields: [{ key: 'accountId', label: 'Account-ID', placeholder: '32 tekens', hint: 'Staat in het Cloudflare-dashboard bij Workers AI › "Use REST API", naast het token.', pattern: /^[a-f0-9]{32}$/i, invalid: 'Het Account-ID van Cloudflare heeft 32 tekens (cijfers en a tot f).' }],
    isFree: (m) => !CF_PAID.test(m.id),
    quotaScope: 'account',
    dailyReset: 'utc',
    probesPerDay: 6,
    rank: 3,
    limitNote: '10.000 "neurons" per dag voor het hele account, opnieuw om 00:00 UTC. Kimi-, GLM- en DeepSeek V4-modellen alleen met een betaald abonnement.',
    docs: { limits: 'https://developers.cloudflare.com/workers-ai/platform/pricing/', terms: 'https://developers.cloudflare.com/workers-ai/platform/data-usage/', checked: CHECKED },
  },
  {
    kind: 'zai',
    label: 'Z.ai GLM',
    engine: 'api',
    card: true,
    needsKey: true,
    signupUrl: 'https://z.ai/manage-apikey/apikey-list',
    isFree: (m) => ZAI_FREE.test(m.id),
    quotaScope: 'account',
    probesPerDay: 3,
    rank: 4,
    limitNote: 'GLM-4.7-Flash, GLM-4.5-Flash en GLM-4.6V-Flash zijn gratis. Z.ai noemt geen limiet; reken op één verzoek tegelijk.',
    docs: { limits: 'https://docs.z.ai/guides/overview/pricing', terms: 'https://docs.z.ai/guides/overview/pricing', checked: CHECKED },
  },
  {
    kind: 'kilo',
    label: 'Kilo Gateway',
    engine: 'api',
    card: true,
    needsKey: false,
    signupUrl: 'https://app.kilo.ai/profile',
    isFree: (m) => !!m.free,
    quotaScope: 'account',
    hourlyAnon: 200,
    probesPerDay: 5,
    rank: 5,
    limitNote: 'Werkt zonder sleutel: alleen de gratis modellen, 200 verzoeken per uur per internetadres.',
    docs: { limits: 'https://kilo.ai/docs/gateway/authentication', terms: 'https://kilo.ai/docs/code-with-ai/agents/free-and-budget-models', checked: CHECKED },
  },
  ...[...LOCAL_IDS].map(
    (kind): FreeSourceDef => ({
      kind,
      label: kind,
      engine: 'local',
      card: false,
      needsKey: false,
      isFree: () => true,
      quotaScope: 'account',
      probesPerDay: 0,
      rank: 9,
      limitNote: 'Gratis; draait op je eigen computer.',
      docs: { limits: '', terms: '', checked: CHECKED },
    }),
  ),
];

const BY_KIND = new Map(FREE_SOURCES.map((d) => [d.kind, d]));
export const sourceDef = (kind: string): FreeSourceDef | undefined => BY_KIND.get(kind);
export const cardSources = () => FREE_SOURCES.filter((d) => d.card);
