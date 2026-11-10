// Marketplace first view, measured in the real UI (B-01/B-12): headless Edge/Chrome against TeamBot with a TEMP data
// folder (never your own data), cold start every time. Sources are simulated with network delays (13 GitHub
// collections whose archives take 2.5-4 s, the MCP Registry from tests/fixtures/market with answers of 0.1-3 s), so
// nothing goes to the internet; with MARKET_SPEED_LIVE=1 the same run goes against the real internet (no accounts).
// Measures: first cards on the Skills tab, first internet cards, first app cards, apps visible without searching;
// takes screenshots (desktop 1360 px and phone 390x844) of the cold first view.
//   npm run build:ui && node --import tsx tests/e2e/market-speed.mjs [screenshot folder]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import AdmZip from 'adm-zip';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const { createApp } = await import('../../server/app.ts');
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
const SHA = 'd'.repeat(40);
const MIT = 'MIT License\n\nCopyright (c) 2026 Voorbeeld\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software...\n';
const TOPICS = [
  ['pdf-forms', 'Fill in and check PDF forms step by step.'],
  ['react-review', 'Review React components for accessibility and state bugs.'],
  ['sql-tuning', 'Find slow Postgres queries and suggest indexes.'],
  ['release-notes', 'Write clear release notes from a list of merged changes.'],
  ['test-plan', 'Turn a feature description into a test plan with edge cases.'],
  ['brand-voice', 'Rewrite marketing copy in a consistent brand voice.'],
];
const REPOS = Array.from({ length: 13 }, (_, i) => `voorbeeld/collectie-${String(i + 1).padStart(2, '0')}`);
const ZIPS = new Map(
  REPOS.map((repo, ri) => {
    const z = new AdmZip();
    const top = `${repo.split('/')[1]}-${SHA}`;
    z.addFile(`${top}/LICENSE`, Buffer.from(MIT));
    for (let k = 0; k < 3; k++) {
      const [name, desc] = TOPICS[(ri + k) % TOPICS.length];
      z.addFile(`${top}/skills/${name}/SKILL.md`, Buffer.from(`---\nname: ${name}-${ri + 1}\ndescription: ${desc}\n---\n\n# ${name}\n\nWork step by step.\n`));
    }
    z.addZipComment(SHA);
    return [repo, z.toBuffer()];
  }),
);
const res = (url, body, headers = {}) => ({ status: 200, contentType: 'application/json', url, body: Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)), headers });
const st = (url, s, headers = {}) => ({ status: s, contentType: '', url, body: Buffer.alloc(0), headers });
const githubSim = async (url) => {
  const n = Number(/collectie-(\d\d)/.exec(url)?.[1] || 0);
  await sleep(url.includes('codeload') ? 2500 + (n % 4) * 500 : 300);
  let m = /^https:\/\/github\.com\/(voorbeeld\/collectie-\d\d)\/archive\/HEAD\.zip$/.exec(url);
  if (m) return st(url, 302, { location: `https://codeload.github.com/${m[1]}/zip/${SHA}` });
  m = /^https:\/\/codeload\.github\.com\/(voorbeeld\/collectie-\d\d)\/zip\/[0-9a-f]{40}$/.exec(url);
  if (m) return res(url, ZIPS.get(m[1]));
  if (url.startsWith('https://api.github.com/repos/')) return res(url, { full_name: url.split('/repos/')[1], stargazers_count: 120 + n, license: { spdx_id: 'MIT' } });
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
    app.ctx.services.skills.setCollections(REPOS.map((repo) => ({ repo, note: '' })));
    app.ctx.services.mcp.setRegistryFetcher(registrySim);
  }
  return { app, dir, token: app.ctx.auth.ensureLocalOwner() };
}

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const CARD = 'main ul.grid > li > button';
const INTERNET_CARD = 'main ul.grid > li > button:not([data-card=starter])';

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
  // Since 0.4 the Skills tab opens on TeamBot's own pinned catalogue; the open collections measured here are a
  // configured extra source (setCollections / TEAMBOT_SKILL_COLLECTIONS), opened with ?bron=internet.
  const sk = await firstView(desk, '#/m/skills/skills?bron=internet', `${pre}-skills-desktop`, 'Skills, desktop, koud');
  check('Skills: eerste kaarten binnen 2 s (koud)', sk.firstCard < 2000, `${sk.firstCard} ms`);
  check('Skills: eerste internetkaarten binnen 8 s (koud)', sk.firstInternet < 8000, `${sk.firstInternet} ms`);
  // Live: the phone runs are left out (each cold run downloads every collection again and uses GitHub API quota).
  const skp = LIVE ? null : await firstView(phone, '#/m/skills/skills?bron=internet', `${pre}-skills-phone`, 'Skills, telefoon, koud');
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
