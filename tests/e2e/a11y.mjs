// Accessibility audit (WCAG 2.x A/AA rules from axe-core) of the main pages, light + dark, desktop + phone width.
// Usage: npm run build:ui && npm run a11y   — prints violations; exits 1 on serious/critical ones.
// In another interface language: npm run a11y -- --lang ar  (or TEAMBOT_LANG=de); right-to-left included.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const { createApp } = await import('./server.mjs');
const { testLanguage } = await import('./lang.mjs');
const lang = testLanguage();

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-a11y-'));
const app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
// Some content so pages are not empty.
const owner = app.ctx.auth.owner();
await lang.apply(app, owner.id);
// A local provider, so the usage popover shows an engine (no network needed to render it).
const prov = app.ctx.providers.create(owner.id, { kind: 'ollama', name: 'Ollama' });
const agent = app.ctx.store.createAgent(owner.id, { name: 'Toegankelijk', avatar: '🤖', role: 'Test', provider_id: prov.id, model: 'llama3' });
// A free source near its limit and one gone, so the usage meters show amber and red rings and their sentences.
app.ctx.services.usage.reportSource({ id: 'gratis-a11y', label: 'Groq', status: 'low', usedPercent: 82, resetsAt: Date.now() + 3 * 3600_000, userId: owner.id, kind: 'free' });
app.ctx.services.usage.reportSource({ id: 'gratis-op', label: 'Kilo', status: 'limited', resetsAt: Date.now() + 26 * 3600_000, estimated: true, userId: owner.id, kind: 'free' });
const th = app.ctx.store.createThread({ user_id: owner.id, agent_id: agent.id, kind: 'chat' });
app.ctx.store.createMessage({ thread_id: th.id, role: 'user', author_type: 'user', author_id: owner.id, author_name: owner.name, content: 'Hallo, kun je helpen?' });
app.ctx.store.createMessage({ thread_id: th.id, role: 'assistant', author_type: 'agent', author_id: agent.id, author_name: agent.name, content: 'Natuurlijk. **Waarmee?**\n\n- punt een\n- punt twee\n\n```python\ndef groet(naam):\n    return f"Hoi {naam}"  # zeg hallo\nprint(groet("Mo"), 42, True)\n```' });
// A few notifications for the bell, its popover and the Meldingen page.
app.ctx.events.emit(owner.id, 'notification', { title: 'Toegankelijk is klaar', body: 'Het rapport staat klaar', link: `#/t/${th.id}`, kind: 'agent', agentId: agent.id });
app.ctx.events.emit(owner.id, 'notification', { title: 'Ollama: 85% van je limiet gebruikt', body: 'Weeklimiet', kind: 'limit', level: 'warn', link: '#/settings/usage-limits' });

// Instellingen since 12 Nov: the rows of the list (AI-diensten, Telefoon, Taal en uiterlijk, Regels, Back-ups,
// Vergrendeling, Teams), "Meer mogelijkheden" and its pages that are not a module page. The old links (appearance,
// advanced, bots, apps) only open these pages now. The bot page has no tabs any more: one fold "Meer mogelijkheden".
const pages = ['/', `/t/${th.id}`, '/agents', `/agents/${agent.id}`, '/agents/new', '/inbox', '/tasks', '/more', '/search', '/search?q=toe', '/settings',
  '/settings/providers', '/settings/telefoon', '/settings/general', '/settings/regels', '/settings/veilig', '/settings/slot', '/settings/teams', '/settings/meer',
  '/settings/kant-en-klaar', '/settings/vanzelf', '/settings/bot-defaults', '/settings/ai-meer', '/settings/systeem', '/settings/security', '/settings/data', '/settings/backups', '/settings/usage',
  `/agents/${agent.id}?meer=1`,
  '/settings/usage-limits', '/settings/notifications-meldingen', '/m/usage/status', '/m/usage/eiland', `/m/seen/${agent.id}`, '/m/browser/kluis',
  ...app.ctx.modules.map((m) => `/m/${m.id}/`)];
// States behind a click or key: the usage popover of the chat (a popover on wide screens, a bottom sheet on phones)
// and, since 12 Nov, the model switcher in the chat header (it comes first in the page, so the usage button is named
// apart); on wide screens also the Ctrl+K command palette (with results) and the notification bell's popover.
const opened = {
  [`/t/${th.id}`]: [
    { name: `/t/${th.id} (gebruik-popover)`, click: 'main button[aria-haspopup="dialog"]:not([data-testid="model-switch"])' },
    { name: `/t/${th.id} (modelkiezer)`, click: 'main button[data-testid="model-switch"]' },
  ],
  '/inbox': [
    { name: '/inbox (Ctrl+K-palet)', keys: ['Control+k', 't', 'o', 'e'], desktopOnly: true },
    { name: '/inbox (meldingen-bel)', click: `button[aria-label^="${lang.L('Meldingen')}"]`, desktopOnly: true },
    // The usage meters in the sidebar footer (0.4.5): rings, and the popover with a bar and a sentence per line.
    { name: '/inbox (gebruiksmeters)', click: 'nav button[data-usage-meter]', desktopOnly: true },
  ],
  // Apps & connectors › Importeren (plakken / van deze computer)
  '/m/mcp/': [{ name: '/m/mcp/ (importeren)', click: `button:has-text("${lang.L('Importeren')}")` }],
  // Kluis › Login toevoegen: every field has a name, also the password (it sits in a wrapper with the eye button).
  '/m/browser/kluis': [{ name: '/m/browser/kluis (login toevoegen)', click: `main button:has-text("${lang.L('Login toevoegen')}")` }],
};
const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const all = [];
try {
  for (const scheme of ['light', 'dark']) {
    // 320 px = 1280 px at 400% zoom (WCAG 1.4.10 reflow); 640 px = 200% zoom (1.4.4).
    for (const vp of [{ width: 1360, height: 900 }, { width: 640, height: 450 }, { width: 390, height: 800 }, { width: 320, height: 640 }]) {
      const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme, bypassCSP: true, ...lang.contextOptions() });
      await lang.apply(app, owner.id, ctx);
      const page = await ctx.newPage();
      await page.goto(`${app.url}/#token=${token}`);
      await page.waitForTimeout(800);
      for (const p of pages) {
        await page.evaluate((h) => (location.hash = h), '#' + p);
        await page.waitForTimeout(500);
        await page.addScriptTag({ content: axeSource });
        const res = await page.evaluate(async () => {
          // @ts-ignore
          const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
          return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ') + ' :: ' + (n.failureSummary || '').split('\n').slice(1, 2).join(' ')) }));
        });
        for (const v of res) all.push({ page: p, scheme, width: vp.width, ...v });
        for (const o of opened[p] || []) {
          if (o.desktopOnly && vp.width < 760) continue;
          if (o.click) await page.click(o.click);
          for (const k of o.keys || []) await page.keyboard.press(k);
          await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
          await page.waitForTimeout(600);
          const r2 = await page.evaluate(async () => {
            // @ts-ignore
            const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
            return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ') + ' :: ' + (n.failureSummary || '').split('\n').slice(1, 2).join(' ')) }));
          });
          for (const v of r2) all.push({ page: o.name, scheme, width: vp.width, ...v });
          await page.keyboard.press('Escape');
        }
        // Reflow: nothing may force horizontal scrolling of the page (tables/code blocks scroll inside themselves).
        const wide = await page.evaluate(() => {
          const vw = document.documentElement.clientWidth;
          if (document.documentElement.scrollWidth <= vw + 1) return [];
          const out = [];
          for (const el of document.querySelectorAll('body *')) {
            const r = el.getBoundingClientRect();
            if (r.width && r.right > vw + 1 && !el.closest('pre,table,[data-scroll-x]')) {
              let p = el.parentElement;
              let inScroller = false;
              while (p) {
                const ox = getComputedStyle(p).overflowX;
                if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') { inScroller = true; break; }
                p = p.parentElement;
              }
              if (!inScroller) out.push((el.id ? '#' + el.id : el.tagName.toLowerCase()) + '.' + String(el.className || '').split(' ').slice(0, 3).join('.') + ' (' + Math.round(r.right) + 'px)');
            }
            if (out.length >= 3) break;
          }
          return out.length ? out : ['(document ' + document.documentElement.scrollWidth + 'px)'];
        });
        if (wide.length) all.push({ page: p, scheme, width: vp.width, id: 'reflow', impact: 'serious', help: 'Pagina scrolt horizontaal (WCAG 1.4.10)', nodes: wide });
      }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
const byRule = new Map();
for (const v of all) {
  const k = `${v.impact} ${v.id}`;
  if (!byRule.has(k)) byRule.set(k, { ...v, where: new Set() });
  byRule.get(k).where.add(`${v.page} (${v.scheme}, ${v.width})`);
}
for (const [k, v] of [...byRule.entries()].sort()) {
  console.log(`\n[${k}] ${v.help}\n  op: ${[...v.where].slice(0, 6).join(', ')}${v.where.size > 6 ? ` (+${v.where.size - 6})` : ''}\n  bv: ${v.nodes.join('\n      ')}`);
}
const serious = all.filter((v) => v.impact === 'serious' || v.impact === 'critical');
console.log(`\n${all.length} bevindingen, ${serious.length} ernstig/kritiek, ${byRule.size} unieke regels (taal: ${lang.code}, ${lang.dir}).`);
process.exitCode = serious.length ? 1 : 0;
