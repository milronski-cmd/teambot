/**
 * Model family from a model id ("openai/gpt-oss-120b:free" → "gpt-oss", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
 * → "llama"). Used to try the same kind of model at another provider first, so a conversation keeps the same model
 * behaviour where it can (idea from free-coding-models, MIT; own implementation).
 */

const FAMILIES: [RegExp, string][] = [
  [/gpt-oss/, 'gpt-oss'],
  [/claude|sonnet|opus|haiku|fable/, 'claude'],
  [/^(gpt|o\d|chatgpt|codex)/, 'gpt'],
  [/gemini/, 'gemini'],
  [/gemma/, 'gemma'],
  [/llama/, 'llama'],
  [/qwen|qwq/, 'qwen'],
  [/deepseek/, 'deepseek'],
  [/glm/, 'glm'],
  [/nemotron/, 'nemotron'],
  [/mistral|mixtral|codestral|devstral|magistral|ministral/, 'mistral'],
  [/kimi/, 'kimi'],
  [/minimax/, 'minimax'],
  [/lfm/, 'lfm'],
  [/north|command|aya/, 'cohere'],
  [/phi-?\d/, 'phi'],
  [/granite/, 'granite'],
  [/hermes/, 'hermes'],
  [/mimo/, 'mimo'],
  [/grok/, 'grok'],
];

export function familyOf(model: string): string {
  const id = String(model || '')
    .toLowerCase()
    .replace(/:free$/, '')
    .replace(/-free$/, '');
  const name = id.split('/').pop() || id;
  for (const [re, f] of FAMILIES) if (re.test(name)) return f;
  // Unknown: the name up to its first version number ("big-pickle", "flint-v1.0" → "flint").
  return name.replace(/[-_.:]?v?\d.*$/, '') || name;
}
