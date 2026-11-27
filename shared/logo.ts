/**
 * TeamBot's logo (4.18.12, chosen by the owner on 27 Nov 2026 from four drafts: "A, bot met antenne"): a white bot
 * head with two pill eyes and an antenna on black. Monochrome, to match the black-and-white look of the app. One
 * recipe for the menu (NavRail), the app icon files (scripts/make-logo.mjs) and anything else that draws the logo.
 */

/** The mark alone, in a 512 × 512 box; `fg` is the head, `cut` the eyes (the background colour). */
export function logoMark(fg = '#fff', cut = '#000'): string {
  return (
    `<rect x="116" y="138" width="280" height="236" rx="92" fill="${fg}"/>` +
    `<rect x="190" y="208" width="34" height="78" rx="17" fill="${cut}"/>` +
    `<rect x="288" y="208" width="34" height="78" rx="17" fill="${cut}"/>` +
    `<circle cx="256" cy="98" r="22" fill="${fg}"/>` +
    `<rect x="249" y="104" width="14" height="40" fill="${fg}"/>`
  );
}

/**
 * The app icon: the mark on black. `round`: corner radius in a 512 box (0 = full bleed, iOS and Android round it
 * themselves). `pad`: extra share of the canvas around the mark (maskable icons keep it inside the safe zone).
 */
export function logoSvg(o: { round?: number; pad?: number } = {}): string {
  const round = o.round ?? 116;
  const pad = o.pad ?? 0;
  const s = 1 - pad * 2;
  const r = round ? ` rx="${round}"` : '';
  const edge = round ? `<rect x="1" y="1" width="510" height="510" rx="${round - 1}" fill="none" stroke="#fff" stroke-opacity=".14" stroke-width="2"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512"${r} fill="#000"/>${edge}<g transform="translate(${512 * pad} ${512 * pad}) scale(${s})">${logoMark()}</g></svg>`;
}
