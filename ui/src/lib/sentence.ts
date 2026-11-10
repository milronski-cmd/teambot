/** The first sentence of a longer text: lists show this, the full text stays in the item's own dialog. */
export const firstSentence = (s: string | undefined | null): string => {
  const text = String(s ?? '').trim();
  return (text.match(/^.*?[.!?](?=\s|$)/)?.[0] || text).trim();
};
