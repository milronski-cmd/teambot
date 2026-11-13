import { tKnown } from './format.js';

/**
 * The first sentence of a longer text: lists show this, the full text stays in the item's own dialog. The whole text is
 * translated first: the dictionary has a catalogue description as a whole, never its first sentence on its own, so
 * cutting first left that sentence Dutch in every other language (Goose, Factory Droid, Kilo Code, the mail app).
 */
export const firstSentence = (s: string | undefined | null): string => {
  const text = tKnown(String(s ?? '').trim()).trim();
  return (text.match(/^.*?[.!?](?=\s|$)/)?.[0] || text).trim();
};
