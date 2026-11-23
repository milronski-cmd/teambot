/**
 * TeamBot's app icon (4.17.0): the orange robot (the figure of shared/botface.ts, kept as the owner wants it) on a
 * background from indigo to violet with a warm glow behind the robot and a soft sheen at the top. One recipe for every
 * place the icon is drawn: the app's icon files (scripts/make-icons.mjs, `npm run icons`) and the website's favicon
 * (website/build.mjs). Before 4.17.0 the background was near-black.
 *
 * `inner`: the figure's SVG content (without its own <svg> element), drawn in a 100 × 100 box. `round`: the corner
 * radius (0 = full bleed: iOS and Android round it themselves). `pad`: the share of the canvas left around the figure.
 */
export function appIconSvg(inner: string, o: { round?: number; pad?: number; id?: string } = {}): string {
  const round = o.round ?? 0;
  const pad = o.pad ?? 0.14;
  const id = o.id || 'tb';
  const s = 1 - pad * 2;
  const off = 1024 * pad;
  const r = round ? ` rx="${round}"` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><linearGradient id="bg${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4f46e5"/><stop offset=".55" stop-color="#7c3aed"/><stop offset="1" stop-color="#c026d3"/></linearGradient><radialGradient id="glow${id}" cx="50%" cy="55%" r="48%"><stop offset="0" stop-color="#ffb070" stop-opacity=".6"/><stop offset=".55" stop-color="#ff8a3d" stop-opacity=".16"/><stop offset="1" stop-color="#ff8a3d" stop-opacity="0"/></radialGradient><linearGradient id="sheen${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".24"/><stop offset=".42" stop-color="#fff" stop-opacity="0"/></linearGradient></defs><rect width="1024" height="1024"${r} fill="url(#bg${id})"/><rect width="1024" height="1024"${r} fill="url(#glow${id})"/><rect width="1024" height="1024"${r} fill="url(#sheen${id})"/>${round ? `<rect x="6" y="6" width="1012" height="1012" rx="${Math.max(0, round - 6)}" fill="none" stroke="#fff" stroke-opacity=".16" stroke-width="12"/>` : ''}<g transform="translate(${off} ${off + 1024 * 0.005}) scale(${(1024 * s) / 100})">${inner}</g></svg>`;
}
