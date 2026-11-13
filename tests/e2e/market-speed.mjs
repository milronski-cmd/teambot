// Marketplace first view, measured in the real UI (B-01/B-12): headless Edge/Chrome against TeamBot with a TEMP data
// folder (never your own data), cold start every time. Sources are simulated with network delays (GitHub's
// repository search of 2.5 s, the skill directory of 0.3 s, the MCP Registry from tests/fixtures/market with answers of 0.1-3 s), so
// nothing goes to the internet; with MARKET_SPEED_LIVE=1 the same run goes against the real internet (no accounts).
// Measures: first cards on the Skills tab, first internet cards, first app cards, apps visible without searching;
// takes screenshots (desktop 1360 px and phone 390x844) of the cold first view.
//   npm run build:ui && node --import tsx tests/e2e/market-speed.mjs [screenshot folder]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const { createApp } = await import('./server.mjs');
const { FEATURED } = await import('../../server/modules/mcp/registry.ts');

const LIVE = process.env.MARKET_SPEED_LIVE === '1';
const SHOTS = process.argv[2] || path.join(os.tmpdir(), 'teambot-market-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const FIX = JSON.parse(fs.readFileSync(path.resolve('tests/fixtures/market/registry-featured.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const check = (name, ok, detail = '') => {
  if (!ok) failed = true;
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// ---- simulated sources ----
const TOPICS = [
  ['pdf-forms', 'Fill in and check PDF forms step by step.'],
  ['react-review', 'Review React components for accessibility and state bugs.'],
  ['sql-tuning', 'Find slow Postgres queries and suggest indexes.'],
  ['release-notes', 'Write clear release notes from a list of merged changes.'],
  ['test-plan', 'Turn a feature description into a test plan with edge cases.'],
  ['brand-voice', 'Rewrite marketing copy in a consistent brand voice.'],
];
const REPOS = Array.from({ length: 40 }, (_, i) => ({ full_name: `voorbeeld/skills-${String(i + 1).padStart(2, '0')}`, name: `skills-${String(i + 1).padStart(2, '0')}`, description: TOPICS[i % TOPICS.length][1], stargazers_count: 5000 - i * 100, license: { spdx_id: 'MIT' }, pushed_at: '2026-11-01T00:00:00Z', created_at: '2026-06-01T00:00:00Z' }));
const res = (url, body, headers = {}) => ({ status: 200, contentType: 'application/json', url, body: Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)), headers });
const st = (url, s, headers = {}) => ({ status: s, contentType: '', url, body: Buffer.alloc(0), headers });
/** The open search of the Skills view: GitHub's repository search takes 2.5 s, the skill directory 0.3 s, ClawHub 0.8 s. */
const githubSim = async (url) => {
  if (url.startsWith('https://api.github.com/search/repositories?')) {
    await sleep(2500);
    const page = Number(new URL(url).searchParams.get('page')) || 1;
    return res(url, { total_count: REPOS.length, items: REPOS.slice((page - 1) * 30, page * 30) });
  }
  if (url.startsWith('https://skills.sh/api/skills/')) {
    await sleep(300);
    return res(url, { skills: TOPICS.map(([name], i) => ({ source: REPOS[i].full_name, skillId: name, name, installs: 9000 - i * 1000 })), total: TOPICS.length, hasMore: false, page: 0 });
  }
  if (url.startsWith('https://clawhub.ai/api/v1/skills?')) {
    await sleep(800);
    return res(url, { items: TOPICS.map(([name, summary], i) => ({ ownerHandle: 'voorbeeld', slug: name, displayName: name, summary, stats: { stars: 400 - i * 10, downloads: 9000 - i * 500 }, createdAt: Date.now() - (i + 1) * 86400000, updatedAt: Date.now() - i * 3600000, latestVersion: { version: '1.0.0', license: 'MIT' } })), nextCursor: null });
  }
  return st(url, 404);
};
const registrySim = async (url) => {
  const m = /\/v0\.1\/servers\/([^/]+)\/versions\/latest$/.exec(url);
  const name = m ? decodeURIComponent(m[1]) : '';
  await sleep([100, 300, 700, 3000][Math.max(0, FEATURED.indexOf(name)) % 4]);
  return FIX[name] ? res(url, FIX[name]) : st(url, 404); // icons: 404 → the monogram
};

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-market-speed-'));
  const app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
  if (!LIVE) {
    app.ctx.services.skills.setFetcher(githubSim);
    app.ctx.services.mcp.setRegistryFetcher(registrySim);
  }
  return { app, dir, token: app.ctx.auth.ensureLocalOwner() };
}

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
// An app card from the register has its one-click status line under it, in one wrapper (RegistryApps QuickAppCard).
const CARD = 'main ul.grid > li > button, main ul.grid > li > [data-card], main ul.grid > li > div > [data-card=app]';
const INTERNET_CARD = 'main ul.grid > li > button:not([data-card=starter]), main ul.grid > li > [data-card=app], main ul.grid > li > div > [data-card=app], main ul.grid > li > [data-card=open][data-kind=repo]';

/** Open TeamBot, then the marketplace at `hash`, and time the first card (and the first internet card). */
async function firstView(viewport, hash, shot, label) {
  const s = await boot();
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`${s.app.url}/#token=${s.token}`);
    await page.waitForFunction(() => !!document.querySelector('nav'), null, { timeout: 20000 });
    const t0 = Date.now();
    await page.evaluate((h) => (location.hash = h), hash);
    await page.locator(CARD).first().waitFor({ timeout: 30000 });
    const firstCard = Date.now() - t0;
    await sleep(150);
    await page.screenshot({ path: path.join(SHOTS, `${shot}-first.png`), fullPage: false });
    await page.locator(INTERNET_CARD).first().waitFor({ timeout: 60000 });
    const firstInternet = Date.now() - t0;
    // Fill in completely (the indicator goes away), then count what is visible without searching.
    await page.waitForFunction(() => ![...document.querySelectorAll('[role=status]')].some((e) => /Bijwerken/.test(e.textContent || '')), null, { timeout: 90000 });
    const done = Date.now() - t0;
    const cards = await page.locator(INTERNET_CARD).count();
    await page.screenshot({ path: path.join(SHOTS, `${shot}-filled.png`), fullPage: false });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    console.log(`  ${label}: eerste kaarten ${firstCard} ms · eerste internetkaarten ${firstInternet} ms · compleet ${done} ms · ${cards} kaarten zonder zoeken`);
    return { firstCard, firstInternet, done, cards, overflow, errors };
  } finally {
    await page.close();
    await s.app.close();
    fs.rmSync(s.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

try {
  console.log(`Bronnen: ${LIVE ? 'echt internet' : 'gesimuleerd (vertraagd)'}; schermafbeeldingen in ${SHOTS}`);
  const desk = { width: 1360, height: 900 };
  const phone = { width: 390, height: 844 };
  const pre = LIVE ? 'market-live' : 'market';
  // The Skills tab opens on TeamBot's own pinned catalogue (no network); measured here is the view next to it,
  // "Openbaar" (?bron=open): the directory's skills show while GitHub's search is still answering.
  const sk = await firstView(desk, '#/m/skills/skills?bron=open', `${pre}-skills-desktop`, 'Skills, desktop, koud');
  check('Skills: eerste kaarten binnen 2 s (koud)', sk.firstCard < 2000, `${sk.firstCard} ms`);
  check('Skills: eerste internetkaarten binnen 8 s (koud)', sk.firstInternet < 8000, `${sk.firstInternet} ms`);
  // Live: the phone runs are left out (each cold run downloads every collection again and uses GitHub API quota).
  const skp = LIVE ? null : await firstView(phone, '#/m/skills/skills?bron=open', `${pre}-skills-phone`, 'Skills, telefoon, koud');
  if (skp) check('Skills telefoon: eerste kaarten binnen 2 s', skp.firstCard < 2000, `${skp.firstCard} ms`);
  if (skp) check('Skills telefoon: geen horizontale scroll', skp.overflow <= 0, `${skp.overflow}px`);
  const ap = await firstView(desk, '#/m/skills/apps', `${pre}-apps-desktop`, 'Apps, desktop, koud');
  check('Apps: eerste kaarten binnen 2 s (koud)', ap.firstCard < 2000, `${ap.firstCard} ms`);
  check('Apps: minstens 40 apps zonder zoeken', ap.cards >= 40, `${ap.cards}`);
  const app2 = LIVE ? null : await firstView(phone, '#/m/skills/apps', `${pre}-apps-phone`, 'Apps, telefoon, koud');
  if (app2) check('Apps telefoon: geen horizontale scroll', app2.overflow <= 0, `${app2.overflow}px`);
  const errs = [...sk.errors, ...(skp?.errors || []), ...ap.errors, ...(app2?.errors || [])];
  check('geen fouten in de pagina', !errs.length, errs.join(' | '));
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
