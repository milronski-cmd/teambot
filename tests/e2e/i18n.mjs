// Interface language check (UX-02), for every language in ui/src/i18n/languages.json (or --lang de,ar):
// 1. the dictionary: every source text translated, placeholders/plural blocks/markup intact, right script;
// 2. the app, as people use it: a team with engines of every kind (subscription, own key, local, free), a limit
//    reached, a security log with every kind of event, routines, memory and chats. The crawl visits the main pages,
//    every settings tab and every page those link to, opens the bot editor's folded sections, and reads every
//    visible text and placeholder/title/aria-label. A text is still Dutch when it
//    - is a known source text that the dictionary translates (shown untranslated), or
//    - contains a Dutch source text of two or more words ("geen extra kosten" inside "haiku (geen extra kosten)"), or
//    - contains a Dutch word: a word of the Dutch source texts that the language's own translations never use
//      ("abonnement", "betaald", "gevonden" in English; not "Abonnement" in German, which German uses too);
//    plus broken placeholders ("{0}", "plural,") and page errors; right-to-left languages must render dir="rtl".
// Exit 1 on page errors, untranslated or broken texts. Usage: npm run build:ui && npm run i18n:check [-- --lang de]
// [TEAMBOT_I18N_SHOTS=<dir> saves a screenshot per page and language] [--static: dictionary checks only]
// [--max-pages N: crawl at most N pages per language (default 160)]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { copiedDutch, dutchDetector, dutchWords, fixMenuPaths, missingPlurals, nameLike, problems, readDict, sourceStrings, targets, wrongScript } from '../../scripts/i18n-lib.mjs';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const langArg = args.includes('--lang') ? args[args.indexOf('--lang') + 1] : process.env.TEAMBOT_I18N_LANGS || 'all';
const langs = targets().filter((l) => langArg === 'all' || langArg.split(',').includes(l.code));
const staticOnly = args.includes('--static');
const maxPages = args.includes('--max-pages') ? Number(args[args.indexOf('--max-pages') + 1]) : 160;
const strings = sourceStrings();
const report = {};
let failed = false;

// ---------- 1. dictionaries ----------
for (const l of langs) {
  const d = readDict(l.code);
  // Product names and other name-like texts ("Goose", "Gmail (Google)", "Ctrl K") may stay as they are: not missing.
  const missing = strings.filter((s) => (typeof d[s] !== 'string' || !d[s].trim()) && !nameLike(s));
  const broken = [];
  // Dutch copied into a translation ("Alle routines staan op pauze ; niet uitgevoerd"): npm run i18n:translate -- --recheck.
  const copied = new Set(copiedDutch(l.code, d, strings));
  for (const s of strings) {
    const v = d[s];
    if (typeof v !== 'string') continue;
    const p = problems(s, v);
    if (wrongScript(l.code, v, s)) p.push('schrift');
    const forms = missingPlurals(l.locale, v);
    if (forms.length) p.push(`meervoudsvorm ${forms.join('/')} ontbreekt`);
    if ((v === s && s.split(' ').length > 2 && dutchWords(l.code).test(s) && !nameLike(s)) || copied.has(s)) p.push('nog Nederlands');
    if (p.length) broken.push(`${p.join(', ')}: ${JSON.stringify(s).slice(0, 90)} → ${JSON.stringify(v).slice(0, 90)}`);
  }
  // Menu paths with a Dutch label copied from the source ("Bot › Computer & bestanden"): npm run i18n:translate fixes them.
  const fixed = { ...d };
  if (fixMenuPaths(fixed)) for (const s of strings) if (fixed[s] !== d[s]) broken.push(`menupad met Nederlands label: ${JSON.stringify(d[s]).slice(0, 90)} → ${JSON.stringify(fixed[s]).slice(0, 90)}`);
  report[l.code] = { missing: missing.length, broken: broken.length, pages: 0, visible: 0, errors: 0 };
  console.log(`[${l.code}] woordenboek: ${strings.length - missing.length}/${strings.length} vertaald, ${broken.length} met fouten`);
  for (const s of missing.slice(0, 10)) console.log(`   ontbreekt: ${JSON.stringify(s).slice(0, 120)}`);
  for (const b of broken.slice(0, 10)) console.log(`   fout: ${b}`);
  if (missing.length || broken.length) failed = true;
}

// ---------- 2. the app ----------
if (!staticOnly) {
  const { chromium } = require('playwright-core');
  const { createApp } = await import('./server.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-i18n-'));
  const app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
  const token = app.ctx.auth.ensureLocalOwner();
  const owner = app.ctx.auth.owner();
  const api = async (method, p, body) => {
    const r = await fetch(`${app.url}/api${p}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return r.ok ? r.json().catch(() => ({})) : null;
  };
  // ----- a team as people have it: an engine of every kind, each with a bot and a chat -----
  const mkProvider = (data) => {
    try {
      return app.ctx.providers.create(owner.id, data);
    } catch {
      return null;
    }
  };
  const engines = [
    mkProvider({ kind: 'ollama', name: 'Ollama' }), // local, free
    mkProvider({ kind: 'claude-code', name: 'Claude Code' }), // a subscription
    mkProvider({ kind: 'opencode', name: 'OpenCode' }), // free models
    // Own key, paid. A closed local port: nothing leaves the computer, and the editor shows the "not reachable" text.
    mkProvider({ kind: 'openai', name: 'OpenAI', apiKey: 'sk-i18n-check-0000000000000000', base_url: 'http://127.0.0.1:9/v1' }),
  ].filter(Boolean);
  const names = ['Helper', 'Ada', 'Max', 'Noor'];
  const bots = engines.map((p, i) => app.ctx.store.createAgent(owner.id, { name: names[i], avatar: '🤖', role: 'Test', provider_id: p.id, model: p.kind === 'ollama' ? 'llama3' : p.kind === 'openai' ? 'gpt-5.4-mini' : '' }));
  const agent = bots[0];
  const threads = bots.map((b) => {
    const th = app.ctx.store.createThread({ user_id: owner.id, agent_id: b.id, kind: 'chat' });
    app.ctx.store.createMessage({ thread_id: th.id, role: 'user', author_type: 'user', author_id: owner.id, author_name: owner.name, content: 'Hello, can you help?' });
    app.ctx.store.createMessage({ thread_id: th.id, role: 'assistant', author_type: 'agent', author_id: b.id, author_name: b.name, content: 'Of course.', usage: { input: 12000, output: 898, cost: b.name === 'Noor' ? 0.0123 : 0, value: b.name === 'Ada' ? 0.24 : null } });
    return th;
  });
  const th = threads[0];
  // A TeamBot event line in the chat (server text, translated in the page).
  app.ctx.store.createMessage({ thread_id: th.id, role: 'event', author_type: 'system', author_name: 'TeamBot', content: `${agent.name} heeft het maximum van 40 stappen bereikt en is gestopt. Stuur een bericht om verder te gaan.` });
  app.ctx.events.emit(owner.id, 'notification', { title: `${agent.name} is klaar`, body: 'Taak afgerond', link: `#/t/${th.id}`, kind: 'agent', agentId: agent.id });
  // A limit reached on the subscription engine (Instellingen › Limieten, the chat header, a notification).
  const cc = engines.find((p) => p.kind === 'claude-code');
  if (cc) app.ctx.services.usage?.limitHit(owner.id, cc.id, Date.now() + 3 * 3600_000);
  // The security log: one row for every kind of event the server writes (the same sentences people read).
  for (const kind of auditKinds(path.join(process.cwd(), 'server'))) app.ctx.audit(owner.id, kind, { tool: 'write_file', summary: 'Bestand schrijven: notities/test.txt', cli: 'opencode', kind: 'opencode', count: 3, adapter: 'telegram', title: 'Atlas', name: 'Ada', fields: ['instructions', 'model'], approved: true, asked: true, allowed: true }, kind.startsWith('agent') || kind.startsWith('tool') || kind.startsWith('file') ? agent.id : null);
  // Routines (the list and the calendar) and a memory.
  await api('POST', '/routines', { name: 'Weekly overview', agent_id: agent.id, prompt: 'Summarise.', timezone: 'Europe/Amsterdam', schedule: { kind: 'weekly', days: ['ma', 'wo', 'vr'], times: ['08:30'] }, options: { notify: 'never' } });
  await api('POST', '/memory/items', { content: 'Lives in Haarlem', scope: 'about_you', key: 'city' });

  // '#welcome' = the first-run screen (home without bots): the bots are archived for that one visit.
  const start = ['#welcome', '/', ...threads.map((t) => `/t/${t.id}`), '/agents', ...bots.map((b) => `/agents/${b.id}`), '/agents/new', '/inbox', '/search', '/more', '/settings/general', ...app.ctx.modules.map((m) => `/m/${m.id}/`)];
  // Pages that only start something (a sign-in callback, a download) are not crawled.
  const SKIP_ROUTE = /oauth|callback|logout|signout|download|\/export|\.json$/i;
  const editorRoute = new RegExp(`^/agents/(${bots.map((b) => b.id).join('|')})$`);
  const shots = process.env.TEAMBOT_I18N_SHOTS;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
  try {
    for (const l of langs) {
      // Team names are the owner's data like bot names (the default team was made before a language was chosen).
      let teamNames = [];
      try {
        teamNames = app.ctx.store.all('SELECT name FROM teams WHERE user_id = ?', owner.id).map((r) => r.name);
      } catch {
        /* no teams module */
      }
      const detect = dutchDetector(l.code, { keep: [...names, ...teamNames, owner.name, 'Weekly overview', 'Lives in Haarlem', 'Hello, can you help?', 'Of course.'] });
      const found = new Map();
      const errors = [];
      const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: l.locale.replace(/-u-.*$/, '') });
      await ctx.addInitScript((code) => localStorage.setItem('tb_lang', code), l.code);
      const page = await ctx.newPage();
      page.setDefaultTimeout(20_000);
      page.on('pageerror', (e) => errors.push(String(e)));
      // The server stores the choice for the user (as the app does on first load).
      app.ctx.store.setSetting(owner.id, 'language', l.code);
      app.ctx.store.exec('UPDATE agents SET archived = 1 WHERE user_id = ?', owner.id);
      await page.goto(`${app.url}/#token=${token}`);
      await page.waitForTimeout(1500);
      const html = await page.evaluate(() => ({ lang: document.documentElement.lang, dir: document.documentElement.dir }));
      if (html.lang !== l.code) errors.push(`<html lang="${html.lang}"> in plaats van ${l.code}`);
      if ((html.dir || 'ltr') !== l.dir) errors.push(`<html dir="${html.dir}"> in plaats van ${l.dir}`);
      const queue = [...start];
      const seen = new Set(queue);
      let visited = 0;
      while (queue.length && visited < maxPages) {
        const p = queue.shift();
        visited++;
        if (p === '#welcome') {
          await page.waitForSelector('h1', { timeout: 10_000 }).catch(() => {});
        } else {
          if (visited === 2) {
            app.ctx.store.exec('UPDATE agents SET archived = 0 WHERE user_id = ?', owner.id);
            await page.reload();
            await page.waitForTimeout(1200);
          }
          await page.evaluate((h) => (location.hash = h), '#' + p);
          await page.waitForTimeout(500);
        }
        await settle(page);
        // The bot editor: every folded section open (advanced settings, engine details).
        if (editorRoute.test(p)) {
          await page.evaluate(() => {
            for (const d of document.querySelectorAll('main details:not([open])')) d.setAttribute('open', '');
            for (const b of document.querySelectorAll('main button[aria-expanded="false"]')) if (!b.closest('[role="menu"],[role="listbox"],[aria-haspopup]') && !b.hasAttribute('aria-haspopup')) b.click();
          });
          await settle(page);
        }
        if (shots) await page.screenshot({ path: path.join(shots, `${l.code}-${p.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'home'}.png`) });
        const { texts, links } = await page.evaluate(() => {
          const SKIP = '[translate="no"],.notranslate,.md,code,pre,textarea,input,[contenteditable="true"],script,style';
          const out = [];
          const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let n = w.nextNode(); n; n = w.nextNode()) {
            const el = n.parentElement;
            const t = (n.nodeValue || '').replace(/\s+/g, ' ').trim();
            if (!t || !el || el.closest(SKIP)) continue;
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            // The whole visible line too (a sentence split over text nodes: "Limiet bereikt" + " · weer …").
            const block = el.closest('p,li,label,button,a,h1,h2,h3,h4,td,th,[role="status"],span');
            out.push(t);
            if (block && block !== el && !block.querySelector(SKIP)) out.push((block.textContent || '').replace(/\s+/g, ' ').trim());
          }
          for (const el of document.querySelectorAll('[placeholder],[title],[aria-label]')) {
            if (el.closest(SKIP) && !el.matches('input,textarea')) continue;
            for (const a of ['placeholder', 'title', 'aria-label']) {
              const v = el.getAttribute(a);
              if (v) out.push(`@${a}: ${v}`);
            }
          }
          // Options of a <select> are visible when it opens.
          for (const o of document.querySelectorAll('select option')) if (!o.closest(SKIP.replace(',textarea,input', ''))) out.push((o.textContent || '').trim());
          const links = [...document.querySelectorAll('a[href^="#/"]')].map((a) => a.getAttribute('href').slice(1));
          return { texts: [...new Set(out)].filter(Boolean), links };
        });
        for (const href of links) {
          const route = href.replace(/[?#].*$/, (m) => (m.startsWith('?') ? m : ''));
          if (seen.has(route) || SKIP_ROUTE.test(route)) continue;
          seen.add(route);
          queue.push(route);
        }
        for (const t of texts) {
          let bare = t.replace(/^@[a-z-]+: /, '');
          // Developer aid (TEAMBOT_I18N_PSEUDO=1): a dictionary with "⟪source⟫" for texts not translated yet shows
          // which Dutch never reaches the translator (code to fix) before paying for a translation run.
          if (process.env.TEAMBOT_I18N_PSEUDO) for (let prev = ''; prev !== bare; ) (prev = bare), (bare = bare.replace(/⟪[^⟪⟫]*⟫/g, ' '));
          const why = detect(bare);
          if (why) {
            const k = `${why}: ${t}`;
            if (!found.has(k)) found.set(k, new Set());
            found.get(k).add(p);
          }
        }
      }
      await ctx.close();
      for (const [t, where] of found) console.log(`[${l.code}] ${t.slice(0, 300)}    [${[...where].slice(0, 3).join(', ')}${where.size > 3 ? ` +${where.size - 3}` : ''}]`);
      for (const e of errors) console.log(`[${l.code}] FOUT: ${e}`);
      report[l.code].pages = visited;
      report[l.code].visible = found.size;
      report[l.code].errors = errors.length;
      if (found.size || errors.length) failed = true;
      console.log(`[${l.code}] app: ${visited} pagina's, ${found.size} zichtbare onvertaalde of kapotte tekst(en), ${errors.length} paginafout(en).`);
    }
  } finally {
    await browser.close();
    await app.close();
    // Windows keeps a file of a just-closed database locked for a moment: retry, and never fail the check on cleanup.
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch {
      console.log(`Map nog in gebruik, later weghalen: ${dir}`);
    }
  }
}

console.log("\nTaal  ontbreekt  fouten  pagina's  zichtbaar  paginafouten");
for (const [code, r] of Object.entries(report)) console.log(`${code.padEnd(5)} ${String(r.missing).padStart(9)} ${String(r.broken).padStart(7)} ${String(r.pages).padStart(9)} ${String(r.visible).padStart(10)} ${String(r.errors).padStart(13)}`);
process.exit(failed ? 1 : 0);

/** Wait until the page has been quiet for 300 ms (at most 3 s), then two frames: late content is translated by then. */
async function settle(page) {
  await page.evaluate(
    () =>
      new Promise((done) => {
        let quiet;
        const finish = () => {
          mo.disconnect();
          clearTimeout(hard);
          requestAnimationFrame(() => requestAnimationFrame(() => done(null)));
        };
        const mo = new MutationObserver(() => {
          clearTimeout(quiet);
          quiet = setTimeout(finish, 300);
        });
        mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
        quiet = setTimeout(finish, 300);
        const hard = setTimeout(finish, 3000);
      }),
  );
}

/** Every audit kind in the server source (as tests/audit-text.test.ts finds them), dynamic families expanded. */
function auditKinds(root) {
  const DYNAMIC = { 'team.': ['delegate', 'message'], 'usage.limit_': ['warn', 'limit'], 'rehearsal.': ['applied', 'discarded'] };
  const out = new Set();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) {
        const src = fs.readFileSync(p, 'utf8');
        for (const m of src.matchAll(/\baudit\(/g)) {
          const head = src.slice(m.index + 6, m.index + 400);
          const a = head.slice(0, Math.min(...[head.indexOf('{'), head.indexOf(');')].filter((i) => i >= 0), head.length));
          for (const s of a.matchAll(/['`]([a-z][a-z_]*(?:\.[a-z_-]*)+)(?:\$\{[^}]*\})?['`]/g)) {
            if (DYNAMIC[s[1]]) for (const v of DYNAMIC[s[1]]) out.add(s[1] + v);
            else if (!s[1].endsWith('.')) out.add(s[1]);
          }
        }
      }
    }
  };
  walk(root);
  return [...out].sort();
}
