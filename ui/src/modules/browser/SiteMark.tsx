/** "shop.example.nl" for https, "http://shop.example.nl" when the address is not encrypted. */
export const hostOf = (origin: string) => {
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' ? `http://${u.host}` : u.host;
  } catch {
    return origin;
  }
};

/** First letter of the site on a tile (no favicon download: nothing leaves the computer). */
export function SiteMark({ origin, size = 36 }: { origin: string; size?: number }) {
  let letter = '?';
  try {
    letter = new URL(origin).hostname.replace(/^www\./, '').slice(0, 1).toUpperCase();
  } catch {
    /* keep */
  }
  return (
    <span className="flex shrink-0 items-center justify-center rounded-xl bg-surface-3 font-bold text-fg" style={{ width: size, height: size, fontSize: size * 0.42 }} aria-hidden>
      {letter}
    </span>
  );
}
