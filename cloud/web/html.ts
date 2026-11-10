/** Tiny HTML helpers: auto-escaping template tag + page layout. No client-side JavaScript anywhere. */

export class Raw {
  constructor(readonly s: string) {}
  toString() {
    return this.s;
  }
}
export const raw = (s: string) => new Raw(s);

export function esc(v: unknown): string {
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function render(v: unknown): string {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(v);
}

/** Template tag: every interpolated value is escaped unless it is Raw (output of another html`` call). */
export function html(strings: TemplateStringsArray, ...vals: unknown[]): Raw {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += render(vals[i]) + strings[i + 1];
  return new Raw(out);
}

export const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--fg:#14161a;--muted:#5b6170;--line:#dde1e7;--accent:#2f5bea;--accent-fg:#fff;--ok:#127a3e;--ok-bg:#e5f5ec;--warn:#8a5a00;--warn-bg:#fdf1d8;--bad:#b42318;--bad-bg:#fde8e6;--focus:#2f5bea}
@media (prefers-color-scheme:dark){:root{--bg:#111318;--card:#1a1d24;--fg:#eceef2;--muted:#a3a9b6;--line:#2c313b;--accent:#7c9cff;--accent-fg:#0b0d12;--ok:#5fd394;--ok-bg:#13291d;--warn:#f3c162;--warn-bg:#2d2412;--bad:#ff8a80;--bad-bg:#331a18;--focus:#9fb6ff}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.skip{position:absolute;left:-9999px}.skip:focus{left:16px;top:8px;background:var(--card);padding:8px 12px;z-index:9}
header.top{border-bottom:1px solid var(--line);background:var(--card)}
.wrap{max-width:880px;margin:0 auto;padding:0 16px}
header.top .wrap{display:flex;gap:16px;align-items:center;flex-wrap:wrap;min-height:56px}
.brand{font-weight:700;color:var(--fg);text-decoration:none;margin-right:auto}
nav a{color:var(--fg);text-decoration:none;padding:6px 4px}nav a:hover{text-decoration:underline}
nav form{display:inline}
main.wrap{padding-top:24px;padding-bottom:48px}
h1{font-size:1.6rem;margin:0 0 8px}h2{font-size:1.2rem;margin:0 0 8px}h3{font-size:1rem;margin:16px 0 4px}
p{margin:0 0 12px}.muted{color:var(--muted)}.small{font-size:.875rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin:0 0 16px}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(230px,1fr))}.grid.stats{grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:16px}.grid.stats .card{margin:0;padding:14px 16px}.grid.stats h2{font-size:1.6rem;margin:0}.grid.stats p{margin:0}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.btn,button{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:8px;padding:8px 14px;font:inherit;font-size:.95rem;cursor:pointer;text-decoration:none;min-height:40px}
.btn:hover,button:hover{border-color:var(--muted)}
.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
.danger{color:var(--bad);border-color:var(--bad)}
label{display:block;font-weight:600;margin:12px 0 4px}
input,select,textarea{width:100%;max-width:420px;font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
textarea{max-width:100%;min-height:80px}
.hint{font-size:.875rem;color:var(--muted);margin:4px 0 0}
.flash{border-radius:10px;padding:12px 16px;margin:0 0 16px;border:1px solid}
.flash.ok{background:var(--ok-bg);color:var(--ok);border-color:var(--ok)}.flash.error{background:var(--bad-bg);color:var(--bad);border-color:var(--bad)}
.badge{display:inline-block;font-size:.8rem;font-weight:600;border-radius:99px;padding:2px 10px;border:1px solid var(--line);white-space:nowrap}
.badge.ok{background:var(--ok-bg);color:var(--ok);border-color:transparent}.badge.warn{background:var(--warn-bg);color:var(--warn);border-color:transparent}.badge.bad{background:var(--bad-bg);color:var(--bad);border-color:transparent}
dl.facts{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:12px 0}dl.facts dt{color:var(--muted)}dl.facts dd{margin:0;min-width:0;overflow-wrap:anywhere}@media (max-width:560px){dl.facts{grid-template-columns:1fr;gap:0}dl.facts dt{margin-top:8px}}
table{width:100%;border-collapse:collapse;font-size:.92rem}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}
.table-wrap{overflow-x:auto}
.callout{border-left:4px solid var(--accent);padding:8px 12px;background:var(--bg);border-radius:4px;margin:12px 0}
.days{display:flex;gap:3px;flex-wrap:wrap;margin:8px 0}.day{width:14px;height:28px;border-radius:3px;background:var(--line)}.day.ok{background:var(--ok)}.day.warn{background:var(--warn)}.day.bad{background:var(--bad)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.card>h3:first-child,.card>h2:first-child{margin-top:0}.page-head{justify-content:space-between;margin-bottom:12px}
@media print{header.top,footer,.no-print,.skip{display:none!important}body{background:#fff;color:#000}.card{border:1px solid #bbb;break-inside:avoid}a{color:#000}main.wrap{padding-top:0}}
.hero{padding:16px 0 8px}.hero p{font-size:1.1rem;max-width:640px}
.price{font-size:1.25rem;font-weight:700;margin:4px 0 8px}
ul.clean{list-style:none;padding:0;margin:0}ul.clean li{padding:2px 0}
footer{border-top:1px solid var(--line);padding:16px 0;color:var(--muted);font-size:.875rem}
`;

export interface Flash {
  kind: 'ok' | 'error';
  text: string;
}

export interface Viewer {
  name: string;
  email: string;
  role: string;
}

/** Full page. `csrf` is needed for the logout button in the header. */
export function layout(o: { title: string; body: Raw; viewer?: Viewer | null; csrf?: string; flash?: Flash | null; refreshSec?: number; nav?: boolean }): string {
  const nav = o.nav === false
    ? ''
    : html`<nav aria-label="Hoofdmenu" class="row">
        ${o.viewer
          ? html`<a href="/dashboard">Dashboard</a><a href="/account/alerts">Meldingen</a>${o.viewer.role === 'operator' ? html`<a href="/operator">Beheer</a>` : ''}<a href="/status">Status</a>
              <form method="post" action="/logout"><input type="hidden" name="_csrf" value="${o.csrf || ''}"><button type="submit">Uitloggen</button></form>`
          : html`<a href="/#prijzen">Prijzen</a><a href="/status">Status</a><a href="/login">Inloggen</a><a class="btn primary" href="/signup">Account maken</a>`}
      </nav>`;
  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
${o.refreshSec ? `<meta http-equiv="refresh" content="${o.refreshSec}">` : ''}
<title>${esc(o.title)} · TeamBot Cloud</title>
<style>${CSS}</style>
</head>
<body>
<a class="skip" href="#inhoud">Naar de inhoud</a>
<header class="top"><div class="wrap"><a class="brand" href="/">TeamBot Cloud</a>${nav}</div></header>
<main id="inhoud" class="wrap">
${o.flash ? html`<div class="flash ${o.flash.kind}" role="${o.flash.kind === 'error' ? 'alert' : 'status'}">${o.flash.text}</div>` : ''}
${o.body}
</main>
<footer><div class="wrap">TeamBot is open source (Apache-2.0). Je modelkosten betaal je rechtstreeks aan je AI-provider. · <a href="/status">Status</a></div></footer>
</body>
</html>`;
}

/** Minimal standalone page (router answers on a workspace host: paused, unknown, starting). */
export function simplePage(title: string, body: Raw, cloudUrl: string): string {
  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main id="inhoud" class="wrap"><div class="card">${body}</div>
<p class="small muted"><a href="${esc(cloudUrl)}">TeamBot Cloud</a> · <a href="${esc(cloudUrl)}/status">Status</a></p></main>
</body>
</html>`;
}
