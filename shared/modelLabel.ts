/**
 * A bot's model in words for cards and headers: "Opus 5.5", "gpt-5.4-mini", never the raw "default". No imports, so it
 * is unit-tested directly.
 */

const CLAUDE_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];
/** Engines whose model names are the owner's own local models ("ollama/qwen3.6:latest" → "qwen3.6"). */
const LOCAL_VENDORS = new Set(['ollama', 'lmstudio', 'llama.cpp', 'llamacpp']);
/** Brand spelling for the words in OpenCode's own model ids. */
const WORDS: Record<string, string> = { glm: 'GLM', gpt: 'GPT', vl: 'VL', deepseek: 'DeepSeek', mimo: 'MiMo', minimax: 'MiniMax', qwen: 'Qwen', kimi: 'Kimi', grok: 'Grok', gemini: 'Gemini', llama: 'Llama', mistral: 'Mistral', nemotron: 'Nemotron', gemma: 'Gemma', oss: 'OSS' };

/**
 * OpenCode's own (Zen) model ids in words, like OpenCode itself names them: "big-pickle" → "Big Pickle",
 * "glm-5.3-flash-free" → "GLM-5.3 Flash", "deepseek-v4.1-flash-free" → "DeepSeek V4.1 Flash". "-free" is left out:
 * where it matters TeamBot says "gratis" next to it.
 */
function zenName(name: string): string {
  const parts = name.replace(/-free$/i, '').split('-').filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    const lower = p.toLowerCase();
    const w = WORDS[lower] || (/^v\d/i.test(p) ? 'V' + p.slice(1) : /^\d+(\.\d+)?b$/i.test(p) ? p.toUpperCase() : /^\d/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1));
    // "GLM-5.3", "GPT-5": an acronym keeps its version number attached, like the vendors write it.
    if (/^\d/.test(p) && out.length && /^(GLM|GPT)$/.test(out[out.length - 1])) out[out.length - 1] += '-' + p;
    else out.push(w);
  }
  return out.join(' ') || name;
}

/**
 * A model id in words: "claude-opus-5-5" → "Opus 5.5", "claude-haiku-4-5-20251001" → "Haiku 4.5", "opus" → "Opus",
 * "opencode/big-pickle" → "Big Pickle", "ollama/qwen3.6:latest" → "qwen3.6", "anthropic/claude-sonnet-4-5" → "Sonnet 4.5".
 * Other ids are already the vendor's own names ("gpt-5.4-mini") and stay as they are.
 */
export function prettyModel(id: string): string {
  const raw = String(id || '').trim();
  if (!raw) return '';
  const slash = raw.indexOf('/');
  if (slash > 0 && slash < raw.length - 1 && !/\[1m\]$/i.test(raw.slice(0, slash))) {
    const vendor = raw.slice(0, slash).toLowerCase();
    const name = raw.slice(slash + 1);
    if (vendor === 'opencode') return zenName(name);
    if (LOCAL_VENDORS.has(vendor)) return name.replace(/:latest$/i, '');
    return prettyModel(name);
  }
  // Ollama's default tag says nothing ("qwen3.6:latest" is "qwen3.6").
  if (/:latest$/i.test(raw)) return raw.replace(/:latest$/i, '');
  const long = raw.match(/\[1m\]$/i);
  const base = raw.replace(/\[1m\]$/i, '');
  const suffix = long ? ' (1M)' : '';
  const lower = base.toLowerCase();
  if (CLAUDE_FAMILIES.includes(lower)) return lower.charAt(0).toUpperCase() + lower.slice(1) + suffix;
  // claude-<family>-<major>-<minor>[-<date>] and the older claude-<major>-<minor>-<family>[-<date>]
  let m = lower.match(/^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/);
  if (m) return `${m[1].charAt(0).toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}${suffix}`;
  m = lower.match(/^claude-(\d+)(?:-(\d{1,2}))?-(opus|sonnet|haiku)(?:-\d{8})?$/);
  if (m) return `${m[3].charAt(0).toUpperCase()}${m[3].slice(1)} ${m[1]}${m[2] ? '.' + m[2] : ''}${suffix}`;
  return raw;
}

/** True for "no model chosen": the engine picks its own default. */
export function isDefaultModel(model: string | null | undefined): boolean {
  const m = String(model || '').trim().toLowerCase();
  return !m || m === 'default' || m === 'standaard';
}

/**
 * The model text on a bot card: the chosen model, or for "default" the model the engine really used last
 * (e.g. Claude Code reports "claude-opus-5-5"), or else "standaardmodel".
 */
export function botModelText(model: string | null | undefined, lastUsed?: string | null): string {
  if (!isDefaultModel(model)) return prettyModel(String(model));
  if (lastUsed && !isDefaultModel(lastUsed)) return prettyModel(lastUsed);
  return 'standaardmodel';
}
