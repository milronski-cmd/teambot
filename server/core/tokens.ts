/** About 3.5 characters per token (Dutch, code and JSON). */
export const CHARS_PER_TOKEN = 3.5;

/**
 * The one token estimate of TeamBot, for sizes nobody measured: what a provider reports itself always wins. Takes a
 * text or a number of characters.
 */
export function estimateTokens(text: string | number | null | undefined): number {
  const chars = typeof text === 'number' ? text : (text || '').length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}
