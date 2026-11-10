/**
 * A short list of Ollama models to download from TeamBot, all able to call tools according to Ollama's library.
 * Sizes are the download sizes from the Ollama registry manifests (registry.ollama.ai/v2/library/<name>/manifests/<tag>,
 * sum of the layers), read on CATALOG_CHECKED. kvPerToken: KV-cache bytes per token of context (f16), from the
 * model's layout: attention layers × kv-heads × (key + value length) × 2 bytes. The texts per model live in the UI.
 */
export const CATALOG_CHECKED = '2026-11-09';
export const CATALOG_SOURCE = 'https://registry.ollama.ai';

export interface CatalogModel {
  /** Ollama name as `ollama pull` takes it. */
  id: string;
  /** Parameter count as Ollama shows it. */
  params: string;
  /** Download size in bytes (≈ what it takes in memory, without the context). */
  size: number;
  kvPerToken: number;
  /** Mixture-of-experts: few parameters active per token, so it stays usable partly on the processor. */
  moe?: boolean;
  vision?: boolean;
  thinking?: boolean;
  /** A good first bot: Qwen3 (the family guides name most often for reliable local tool calling). */
  firstBot?: boolean;
}

export const OLLAMA_CATALOG: CatalogModel[] = [
  // Qwen3 1.7B: 28 layers, 8 kv-heads, head 128.
  { id: 'qwen3:1.7b', params: '2B', size: 1_359_292_957, kvPerToken: 28 * 8 * 256 * 2, thinking: true, firstBot: true },
  // Llama 3.2 3B: 28 layers, 8 kv-heads, head 128.
  { id: 'llama3.2:3b', params: '3.2B', size: 2_019_392_628, kvPerToken: 28 * 8 * 256 * 2 },
  // Qwen3 4B: 36 layers, 8 kv-heads, head 128.
  { id: 'qwen3:4b', params: '4B', size: 2_497_293_444, kvPerToken: 36 * 8 * 256 * 2, thinking: true, firstBot: true },
  // Qwen3 8B: 36 layers, 8 kv-heads, head 128.
  { id: 'qwen3:8b', params: '8.2B', size: 5_225_387_677, kvPerToken: 36 * 8 * 256 * 2, thinking: true, firstBot: true },
  // Qwen3 14B: 40 layers, 8 kv-heads, head 128.
  { id: 'qwen3:14b', params: '14.8B', size: 9_276_198_077, kvPerToken: 40 * 8 * 256 * 2, thinking: true, firstBot: true },
  // gpt-oss 20B: 24 layers, 8 kv-heads, head 64 (half of the layers use a short sliding window: this is the upper bound).
  { id: 'gpt-oss:20b', params: '20.9B', size: 13_793_441_427, kvPerToken: 24 * 8 * 128 * 2, moe: true, thinking: true },
  // Qwen3 30B-A3B: 48 layers, 4 kv-heads, head 128; 3B parameters active per token.
  { id: 'qwen3:30b', params: '30.5B', size: 18_556_698_820, kvPerToken: 48 * 4 * 256 * 2, moe: true, thinking: true, firstBot: true },
  // Qwen3.6 35B-A3B: 40 layers of which every 4th has attention, 2 kv-heads, head 256; reads images too.
  { id: 'qwen3.6:35b', params: '35.5B', size: 22_621_314_161, kvPerToken: 10 * 2 * 512 * 2, moe: true, vision: true, thinking: true },
];
