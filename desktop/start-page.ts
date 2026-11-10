/**
 * The page the main window shows while TeamBot starts its server (a few seconds, longest the very first time). Without
 * it nothing is on screen between the installer closing and the first-run screen, and a person clicks again. It is a
 * plain data: page without script or links: the window opens at once, then loads the real interface in place.
 * No Electron import (tests/desktop-shell.test.ts); desktop/main.ts passes the texts in the owner's language.
 */

export interface StartPage {
  lang: string;
  dark: boolean;
  /** The TeamBot icon as a data: URL (desktop/main.ts reads build/icon.png). */
  icon?: string;
  title: string;
  /** Short lines under the title ("Je vindt TeamBot in het Startmenu en op je bureaublad."). */
  lines: string[];
  /** For screen readers and under the progress bar ("Even geduld…"). */
  wait: string;
}

/** The colours of the interface's canvas (ui/src/styles.css), so the window does not flash when the interface loads. */
export const CANVAS = { light: { bg: '#f4f3f6', fg: '#17161c', muted: '#5d5c69', track: '#e6e5ea' }, dark: { bg: '#0d0d10', fg: '#ededf2', muted: '#9b9ba8', track: '#26262c' } } as const;

const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const RTL = new Set(['ar', 'he', 'fa', 'ur']);

export function startPageHtml(p: StartPage): string {
  const c = p.dark ? CANVAS.dark : CANVAS.light;
  const lang = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(p.lang) ? p.lang : 'nl';
  const icon = p.icon && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(p.icon) ? `<img src="${p.icon}" alt="" width="88" height="88">` : '';
  return `<!doctype html><html lang="${lang}" dir="${RTL.has(lang.split('-')[0]) ? 'rtl' : 'ltr'}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>TeamBot</title><style>
html,body{height:100%;margin:0}
body{background:${c.bg};color:${c.fg};font:15px/1.45 Segoe UI Variable,Segoe UI,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;-webkit-user-select:none;user-select:none;cursor:default}
main{display:flex;flex-direction:column;align-items:center;gap:6px;padding:24px;text-align:center;max-width:420px}
img{border-radius:22px;margin-bottom:14px}
h1{font-size:22px;font-weight:600;margin:0;letter-spacing:-.01em}
p{margin:0;color:${c.muted}}
.bar{width:160px;height:3px;border-radius:3px;background:${c.track};overflow:hidden;margin-top:18px}
.bar i{display:block;width:40%;height:100%;border-radius:3px;background:${c.muted};animation:go 1.4s ease-in-out infinite}
@keyframes go{from{transform:translateX(-100%)}to{transform:translateX(250%)}}
@media (prefers-reduced-motion:reduce){.bar i{animation:none;width:100%;opacity:.5}}
.wait{font-size:13px;margin-top:8px}
</style></head><body><main role="status" aria-live="polite">${icon}<h1>${esc(p.title)}</h1>${p.lines.map((l) => `<p>${esc(l)}</p>`).join('')}<div class="bar" aria-hidden="true"><i></i></div><p class="wait">${esc(p.wait)}</p></main></body></html>`;
}

export const startPageUrl = (p: StartPage) => `data:text/html;charset=utf-8,${encodeURIComponent(startPageHtml(p))}`;
