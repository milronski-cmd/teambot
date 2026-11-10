/**
 * "Ik heb een API-sleutel" (first screen and Instellingen › AI-diensten): which service a pasted key belongs to, from
 * its format alone. No imports, so it is unit-tested directly (tests/key-format.test.ts).
 *
 * A prefix that only one service uses gives one candidate (sk-ant- → Anthropic). A shape that several services share
 * (sk- with 32 hex characters: DeepSeek and Alibaba Qwen) gives the candidates in the order to try them; TeamBot then
 * asks each one for its model list (free, never a paid prompt, docs/PROVIDER_POLICY.md rule 4) until one says yes.
 * A login token of a Claude subscription (sk-ant-oat…) is never accepted as a key: TeamBot does not take subscription
 * logins (docs/PROVIDER_POLICY.md); the person is pointed to "Ik heb Claude" instead.
 */

export type KeyNote =
  /** A Claude subscription login token, not an API key. */
  | 'claude-login'
  /** An admin or management key that cannot answer chats. */
  | 'admin'
  /** Nothing recognisable. */
  | 'unknown'
  /** Too short to be a key yet (still typing). */
  | 'short';

export interface KeyGuess {
  /** Provider kind ids (server/providers/catalog.ts) to try, best first. Empty with a `note`. */
  kinds: string[];
  note?: KeyNote;
}

/** The key as it was meant: without spaces, line ends, quotes or a "Bearer " in front. */
export function cleanKey(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/^bearer\s+/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, '');
}

/** Fixed prefixes, longest first where one starts with another (sk-ant-, sk-or- and sk-proj- before sk-). */
const PREFIXES: [RegExp, string[]][] = [
  [/^sk-ant-api/, ['anthropic']],
  [/^sk-or-/, ['openrouter']],
  [/^sk-(proj|svcacct|None)-/, ['openai']],
  [/^gsk_/, ['groq']],
  [/^AIza[\w-]{30,}$/, ['google']],
  [/^xai-/, ['xai']],
  [/^csk-/, ['cerebras']],
  [/^nvapi-/, ['nvidia']],
  [/^fw_/, ['fireworks']],
  [/^hf_/, ['huggingface']],
  [/^pplx-/, ['perplexity']],
  [/^tgp_v1_/, ['together']],
];

/** Guess the service of an API key from its format. */
export function guessKey(raw: string): KeyGuess {
  const k = cleanKey(raw);
  if (k.length < 12) return { kinds: [], note: k ? 'short' : 'unknown' };
  // Claude subscription logins (OAuth access/refresh tokens) and admin keys are not chat keys.
  if (/^sk-ant-(oat|ort)/.test(k)) return { kinds: [], note: 'claude-login' };
  if (/^sk-ant-admin/.test(k) || /^sk-admin-/.test(k)) return { kinds: [], note: 'admin' };
  for (const [re, kinds] of PREFIXES) if (re.test(k)) return { kinds };
  if (/^sk-ant-/.test(k)) return { kinds: ['anthropic'] };
  if (/^sk-/.test(k)) {
    // OpenAI's older keys carry "T3BlbkFJ" ("OpenAI" in base64) in the middle.
    if (k.includes('T3BlbkFJ')) return { kinds: ['openai'] };
    if (/^sk-[a-f0-9]{32}$/.test(k)) return { kinds: ['deepseek', 'qwen', 'moonshot'] };
    if (/^sk-[A-Za-z0-9]{48}$/.test(k)) return { kinds: ['moonshot', 'openai'] };
    return { kinds: ['openai', 'deepseek', 'moonshot', 'qwen'] };
  }
  // Z.ai: <32 hex>.<16 letters and digits>
  if (/^[a-f0-9]{32}\.[A-Za-z0-9]{16}$/.test(k)) return { kinds: ['zai'] };
  // MiniMax hands out long JWT-like keys.
  if (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(k)) return { kinds: ['minimax'] };
  if (/^[a-f0-9]{64}$/.test(k)) return { kinds: ['together'] };
  if (/^[A-Za-z0-9]{32}$/.test(k)) return { kinds: ['mistral', 'deepinfra'] };
  return { kinds: [], note: 'unknown' };
}

/** What to tell the person when the format says "not a usable key" (null: nothing to say). */
export function keyNoteText(note?: KeyNote): string | null {
  if (note === 'claude-login') return 'Dit is een inlogcode van een Claude-abonnement, geen API-sleutel. Gebruik hierboven “Ik heb Claude of ChatGPT”: dan log je in bij Claude zelf.';
  if (note === 'admin') return 'Dit is een beheerderssleutel; daarmee kan een bot niet praten. Maak bij de dienst een gewone API-sleutel aan.';
  if (note === 'unknown') return 'TeamBot herkent deze sleutel niet. Kies de dienst zelf onder Andere AI koppelen.';
  return null;
}
