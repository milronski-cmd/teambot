// npm run website:check — builds the site, then checks website/dist:
//  1. static: valid lang/hreflang attributes, every internal link and #anchor exists, no runtime resource (script,
//     stylesheet, font, image, icon, CSS url()) from another server, no duplicate ids; per page a title, a meta
//     description, the Open Graph tags, exactly one <h1>, images with alt/width/height, valid JSON-LD, no inline
//     style (the CSP in _headers forbids it) and the inline script's hash in that CSP; no "unlimited"/"onbeperkt"
//     and no "beter dan"/"better than" in the copy; no "[object Object]", "undefined", "NaN" or placeholder
//     address as text; _headers, 404.html, robots.txt and .nojekyll exist;
//  2. in Edge/Chrome (playwright-core): axe-core (WCAG 2.x A/AA, the same rules as `npm run a11y`) on every page at
//     320, 360, 390, 768, 1280 and 1360 px in light and dark, no horizontal scrolling, no page errors, no request to
//     another host;
//  3. the site also works from file:// and the light/dark toggle works.
// Exits 1 on any finding. Hard time-out: 4 minutes.
// Options: --screens <dir>   also save screenshots of every page (1360 light, full page; 390 dark, first screen;
//                              320 light, full page)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from './serve.mjs';

const killer = setTimeout(() => {
  console.error('website:check: time-out na 4 minuten');
  process.exit(2);
}, 240_000);
killer.unref();

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const dist = path.join(here, 'dist');
const require = createRequire(path.join(repo, 'package.json'));
const { chromium } = require('playwright-core');
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const screensArg = process.argv.indexOf('--screens');
const screens = screensArg > 0 ? path.resolve(process.argv[screensArg + 1]) : null;
const LANGS = new Set(['nl', 'en']);
const problems = [];
const problem = (where, what) => problems.push(`${where}: ${what}`);

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('website/dist ontbreekt: draai eerst npm run website:build');
  process.exit(1);
}
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const files = walk(dist);
const pages = files.filter((f) => f.endsWith('.html')).map((f) => path.relative(dist, f).split(path.sep).join('/'));
const headersFile = path.join(dist, '_headers');
const headers = fs.existsSync(headersFile) ? fs.readFileSync(headersFile, 'utf8') : null;
if (!headers) problem('_headers', 'ontbreekt (beveiligingsheaders voor Cloudflare Pages)');
for (const f of ['404.html', 'robots.txt', '.nojekyll']) if (!fs.existsSync(path.join(dist, f))) problem(f, 'ontbreekt');
const idsCache = new Map();
const idsOf = (file) => {
  if (!idsCache.has(file)) idsCache.set(file, [...fs.readFileSync(file, 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  return idsCache.get(file);
};

// ---------------------------------------------------------------- 1. static checks
const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
for (const rel of pages) {
  const file = path.join(dist, rel);
  const html = fs.readFileSync(file, 'utf8');
  const htmlLang = /<html[^>]*\slang="([^"]+)"/.exec(html)?.[1];
  if (!htmlLang || !LANGS.has(htmlLang)) problem(rel, `ongeldige of ontbrekende <html lang> (${htmlLang})`);
  for (const m of html.matchAll(/\s(lang|hreflang)="([^"]*)"/g)) {
    const ok = m[1] === 'hreflang' && m[2] === 'x-default' ? true : LANGS.has(m[2]) && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(m[2]);
    if (!ok) problem(rel, `ongeldige ${m[1]}="${m[2]}"`);
  }
  const ids = idsOf(file);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) problem(rel, `dubbele id's: ${[...new Set(dup)].join(', ')}`);
  for (const m of html.matchAll(/<(a|link|script|img|source|iframe|video|audio)\b[^>]*>/g)) {
    const tag = m[0];
    const kind = m[1];
    for (const name of ['href', 'src', 'srcset']) {
      const raw = attr(tag, name);
      if (raw == null) continue;
      const url = raw.replace(/&amp;/g, '&');
      const external = /^(https?:)?\/\//i.test(url);
      const runtime = kind !== 'a' && !(kind === 'link' && /rel="(canonical|alternate)"/.test(tag));
      if (external) {
        if (runtime) problem(rel, `externe bron wordt geladen: <${kind} ${name}="${url}">`);
        continue;
      }
      if (/^(mailto|tel|data):/i.test(url)) continue;
      if (/^[a-z]+:/i.test(url)) {
        problem(rel, `onbekend linkschema: ${url}`);
        continue;
      }
      const [pq, hash] = url.split('#');
      // A fingerprint behind a file name (site.css?v=…) is not part of the file's path.
      const p = pq.split('?')[0];
      const target = p ?path.resolve(path.dirname(file), decodeURIComponent(p)) : file;
      if (!target.startsWith(dist)) problem(rel, `link buiten de site: ${url}`);
      else if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) problem(rel, `kapotte link: ${url}`);
      else if (hash && target.endsWith('.html') && !idsOf(target).includes(decodeURIComponent(hash))) problem(rel, `anker bestaat niet: ${url}`);
    }
  }
  for (const m of html.matchAll(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/g)) {
    if (!/^https?:/.test(m[1]) && !fs.existsSync(path.resolve(path.dirname(file), m[1]))) problem(rel, `og:image bestaat niet: ${m[1]}`);
  }
  // meta tags and structure every page needs
  if (!/<title>[^<]{3,}<\/title>/.test(html)) problem(rel, 'geen <title>');
  if (!/<meta name="description" content="[^"]{20,}">/.test(html)) problem(rel, 'geen meta description');
  for (const p of ['og:title', 'og:description', 'og:image', 'og:image:alt', 'og:locale']) if (!html.includes(`property="${p}"`)) problem(rel, `${p} ontbreekt`);
  const h1s = (html.match(/<h1[\s>]/g) || []).length;
  if (h1s !== 1) problem(rel, `${h1s} keer <h1> (moet 1 zijn)`);
  for (const m of html.matchAll(/<img\b[^>]*>/g)) for (const a of ['alt', 'width', 'height']) if (attr(m[0], a) == null) problem(rel, `<img> zonder ${a}: ${m[0].slice(0, 80)}`);
  for (const m of html.matchAll(/<script type="application\/ld\+json">([^<]*)<\/script>/g)) {
    try {
      JSON.parse(m[1]);
    } catch (e) {
      problem(rel, `JSON-LD is geen geldige JSON: ${e.message}`);
    }
  }
  // The strict Content-Security-Policy in _headers (style-src 'self') blocks inline styles.
  if (/<[a-z][^>]*\sstyle="/i.test(html)) problem(rel, 'inline style="…" gevonden (werkt niet met de CSP in _headers)');
  const inline = /<script>([^<]*)<\/script>/.exec(html)?.[1];
  if (inline && headers && !headers.includes(`'sha256-${crypto.createHash('sha256').update(inline).digest('base64')}'`)) problem(rel, 'de hash van het inline script staat niet in de CSP van _headers');
  // Honest copy: no "unlimited" and no "better than" claims (there is no published measurement). The manual is
  // generated from docs/HANDLEIDING.md and is checked where it is written.
  // A value that was never filled in must not reach a reader: "[object Object]" (an object printed as text),
  // "undefined"/"NaN" (a missing text) or the placeholder address of the repository. Checked on the visible text and
  // on the texts in attributes (alt, title, aria-label, content).
  {
    const visible = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ');
    const attrs = [...html.matchAll(/\s(?:alt|title|aria-label|content|placeholder)="([^"]*)"/g)].map((m) => m[1]).join(' ');
    for (const [w, name] of [
      [/\[object [A-Za-z]+\]/, '[object Object]'],
      [/\bundefined\b/, 'undefined'],
      [/\bNaN\b/, 'NaN'],
      [/(&lt;|<)org(&gt;|>)/, 'het placeholder-adres <org>'],
    ]) {
      for (const text of [visible, attrs]) {
        const hit = w.exec(text);
        if (hit) problem(rel, `niet-ingevulde waarde in de tekst: ${name} (…${text.slice(Math.max(0, hit.index - 40), hit.index + 30).replace(/\s+/g, ' ').trim()}…)`);
      }
    }
  }
  if (!/^(handleiding|en\/manual)\.html$/.test(rel)) {
    const text = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ');
    for (const w of [/\bunlimited\b/i, /\bonbeperkt/i, /\bbeter dan\b/i, /\bbetter than\b/i]) if (w.test(text)) problem(rel, `verboden belofte in de tekst: ${w.source}`);
  }
}
for (const css of files.filter((f) => f.endsWith('.css'))) {
  const text = fs.readFileSync(css, 'utf8');
  for (const m of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
    if (/^(https?:)?\/\//.test(m[1])) problem(path.relative(dist, css), `externe bron in CSS: ${m[1]}`);
    else if (!/^data:/.test(m[1]) && !fs.existsSync(path.resolve(path.dirname(css), m[1]))) problem(path.relative(dist, css), `CSS-bestand ontbreekt: ${m[1]}`);
  }
  if (/@import/.test(text)) problem(path.relative(dist, css), '@import gevonden (laadt extra bestanden)');
}
const staticCount = problems.length;
console.log(`• statisch: ${pages.length} pagina's, ${files.length} bestanden, ${staticCount} bevindingen`);
const shots = JSON.parse(fs.readFileSync(path.join(here, 'src/shots.json'), 'utf8'));
const emptySlots = Object.entries(shots)
  .filter(([k]) => !k.startsWith('_'))
  .filter(([, s]) => !['webp', 'png'].some((e) => fs.existsSync(path.join(dist, 'img', `${s.file}.${e}`))))
  .map(([k, s]) => `${k} (${s.file})`);
if (emptySlots.length) console.log(`• let op: geen afbeelding voor ${emptySlots.join(', ')}; die vakken worden weggelaten`);

// ---------------------------------------------------------------- 2 + 3. in the browser
const server = createServer(dist);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
const host = new URL(base).host;
const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const axeFindings = [];
try {
  for (const scheme of ['light', 'dark']) {
    for (const width of [320, 360, 390, 768, 1280, 1360]) {
      const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 780 : 900 }, colorScheme: scheme });
      const page = await ctx.newPage();
      let current = '';
      page.on('request', (req) => {
        const u = new URL(req.url());
        if (u.protocol !== 'data:' && u.host !== host) problem(`${current} (${width}, ${scheme})`, `verzoek naar een andere server: ${req.url()}`);
      });
      page.on('pageerror', (e) => problem(`${current} (${width}, ${scheme})`, `paginafout: ${e.message}`));
      page.on('console', (m) => m.type() === 'error' && problem(`${current} (${width}, ${scheme})`, `consolefout: ${m.text()}`));
      page.on('response', (r) => r.status() >= 400 && problem(`${current} (${width}, ${scheme})`, `HTTP ${r.status()}: ${r.url()}`));
      for (const rel of pages) {
        current = rel;
        await page.goto(base + rel, { waitUntil: 'load' });
        await page.evaluate(() => document.fonts.ready);
        await page.addScriptTag({ content: axeSource });
        const res = await page.evaluate(async () => {
          // @ts-ignore
          const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } });
          return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ') + ' :: ' + (n.failureSummary || '').split('\n').slice(1, 2).join(' ')) }));
        });
        for (const v of res) axeFindings.push({ page: rel, scheme, width, ...v });
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (over > 1) problem(`${rel} (${width}, ${scheme})`, `pagina scrolt ${over}px horizontaal`);
        if (screens && ((width === 1360 && scheme === 'light') || (width === 390 && scheme === 'dark') || (width === 320 && scheme === 'light'))) {
          fs.mkdirSync(screens, { recursive: true });
          // lazy images only load when scrolled into view; a full-page capture needs them now
          await page.evaluate(() => Promise.all([...document.images].map((i) => ((i.loading = 'eager'), i.decode().catch(() => null)))));
          const name = rel.replace(/\//g, '_').replace(/\.html$/, '');
          if (width === 1360) await page.screenshot({ path: path.join(screens, `${name}-desktop.png`), fullPage: true });
          else if (width === 320) await page.screenshot({ path: path.join(screens, `${name}-320.png`), fullPage: true });
          else {
            await page.setViewportSize({ width: 390, height: 844 });
            await page.screenshot({ path: path.join(screens, `${name}-phone.png`) });
            await page.setViewportSize({ width, height: 780 });
          }
        }
      }
      await ctx.close();
    }
  }
  console.log(`• browser: ${pages.length} pagina's × 6 breedtes (320–1360) × licht/donker met axe-core`);

  // file:// — the stylesheet, font and images load and links point at existing files.
  const fctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const fp = await fctx.newPage();
  const failed = [];
  fp.on('requestfailed', (r) => failed.push(r.url()));
  for (const rel of ['index.html', 'en/index.html', 'vergelijking.html']) {
    await fp.goto(pathToFileURL(path.join(dist, rel)).href);
    await fp.evaluate(() => document.fonts.ready);
    const s = await fp.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, font: document.fonts.check('16px "Figtree Variable"'), imgs: [...document.images].filter((i) => i.complete && i.naturalWidth === 0).length }));
    if (s.bg === 'rgba(0, 0, 0, 0)' || s.bg === 'rgb(255, 255, 255)') problem(`file://${rel}`, 'stylesheet niet geladen');
    if (!s.font) problem(`file://${rel}`, 'Figtree niet geladen');
    if (s.imgs) problem(`file://${rel}`, `${s.imgs} afbeelding(en) niet geladen`);
  }
  for (const u of failed) problem('file://', `laden mislukt: ${u}`);
  // Theme toggle: light system → dark → stays dark after reload → back to light.
  const tctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
  const tp = await tctx.newPage();
  await tp.goto(base + 'index.html');
  const bg = () => tp.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const before = await bg();
  await tp.getByRole('button', { name: 'Donker thema' }).click();
  const afterClick = await bg();
  await tp.reload();
  const afterReload = await bg();
  await tp.getByRole('button', { name: 'Licht thema' }).click();
  const back = await bg();
  if (!(before !== afterClick && afterClick === afterReload && back === before)) problem('thema-knop', `werkt niet (${before} → ${afterClick} → ${afterReload} → ${back})`);
  console.log('• file:// en thema-knop gecontroleerd');
} finally {
  await browser.close();
  server.close();
}

const byRule = new Map();
for (const v of axeFindings) {
  const k = `${v.impact} ${v.id}`;
  if (!byRule.has(k)) byRule.set(k, { ...v, where: new Set() });
  byRule.get(k).where.add(`${v.page} (${v.scheme}, ${v.width})`);
}
for (const [k, v] of [...byRule.entries()].sort()) console.log(`\n[axe ${k}] ${v.help}\n  op: ${[...v.where].slice(0, 6).join(', ')}${v.where.size > 6 ? ` (+${v.where.size - 6})` : ''}\n  bv: ${v.nodes.join('\n      ')}`);
const unique = [...new Set(problems)];
for (const p of unique.slice(0, 60)) console.log(`✖ ${p}`);
if (unique.length > 60) console.log(`… en nog ${unique.length - 60}`);
const total = unique.length + axeFindings.length;
console.log(`\n${total ? 'WEBSITE-CHECK MISLUKT' : 'WEBSITE-CHECK GESLAAGD'}: ${unique.length} bevindingen, ${axeFindings.length} axe-bevindingen (${byRule.size} regels)${screens ? ` · schermafbeeldingen in ${screens}` : ''}`);
process.exit(total ? 1 : 0);
