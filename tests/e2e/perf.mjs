// Performance review (release step 11): measures start-up, memory, API latencies on a large data set, the server
// overhead of a chat turn, and the UI opening a long conversation. Prints a table against budgets.
// Usage: npm run build:ui && npm run perf      (TEAMBOT_PERF_MESSAGES=50000 by default)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const { startTestApp } = await import('../helpers.ts');
const { createApp } = await import('../../server/app.ts');

const N_MSG = Number(process.env.TEAMBOT_PERF_MESSAGES || 50_000);
const N_THREADS = 500;
const rows = [];
const record = (name, value, unit, budget) => {
  const ok = budget === undefined || value <= budget;
  rows.push({ name, value, unit, budget, ok });
  console.log(`${ok ? '✔' : '✖'} ${name}: ${typeof value === 'number' ? value.toFixed(value < 10 ? 1 : 0) : value} ${unit}${budget !== undefined ? ` (budget ${budget})` : ''}`);
};
const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
async function timeMany(n, fn) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await fn(i);
    out.push(performance.now() - t);
  }
  return out;
}

const WORDS = 'factuur offerte planning klant project budget leverancier marketing campagne verslag notulen besluit actiepunt website server rapport analyse cijfers kwartaal omzet'.split(' ');
const sentence = (i) => Array.from({ length: 12 + (i % 20) }, (_, k) => WORDS[(i * 7 + k * 13) % WORDS.length]).join(' ');

// ---------------- cold start (empty) ----------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-perf-start-'));
  const t = performance.now();
  const app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
  record('opstarten server (leeg, alle modules)', performance.now() - t, 'ms', 3000);
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------- large data set ----------------
const t = await startTestApp();
try {
  const s = t.app.ctx.store;
  const owner = t.app.ctx.auth.owner();
  const agents = [];
  for (let i = 0; i < 20; i++) agents.push(await t.agent({ name: `Bot ${i}` }));
  const seedStart = performance.now();
  const threads = [];
  s.tx(() => {
    for (let i = 0; i < N_THREADS; i++) threads.push(s.createThread({ user_id: owner.id, agent_id: agents[i % agents.length].id, title: `Gesprek ${i}` }));
    for (let i = 0; i < N_MSG; i++) {
      const th = threads[i % threads.length];
      const user = i % 2 === 0;
      s.createMessage({ thread_id: th.id, role: user ? 'user' : 'assistant', author_type: user ? 'user' : 'agent', author_id: user ? owner.id : th.agent_id, author_name: user ? 'Ik' : 'Bot', content: `${sentence(i)}${i % 50 === 0 ? `\n\n- punt een\n- punt twee\n\n\`\`\`js\nconsole.log(${i})\n\`\`\`` : ''}` });
    }
  });
  record(`database vullen (${N_THREADS} gesprekken, ${N_MSG} berichten)`, (performance.now() - seedStart) / 1000, 's');
  const big = threads[0];
  // One long conversation for the UI test: 400 extra messages with markdown.
  s.tx(() => {
    for (let i = 0; i < 400; i++) s.createMessage({ thread_id: big.id, role: i % 2 ? 'assistant' : 'user', author_type: i % 2 ? 'agent' : 'user', author_id: i % 2 ? big.agent_id : owner.id, author_name: i % 2 ? 'Bot' : 'Ik', content: `**${i}.** ${sentence(i)}\n\n| a | b |\n|---|---|\n| ${i} | ${i * 2} |` });
  });

  // Seeding blocked the event loop; let the server close idle keep-alive sockets before measuring.
  await new Promise((r) => setTimeout(r, 6000));
  const sidebar = await timeMany(30, () => t.api('GET', '/threads'));
  record('GET /threads (zijbalk) p95', pct(sidebar, 95), 'ms', 100);
  const open = await timeMany(30, (i) => t.api('GET', `/threads/${threads[i % threads.length].id}`));
  record('GET /threads/:id (gesprek openen) p95', pct(open, 95), 'ms', 150);
  const openBig = await timeMany(20, () => t.api('GET', `/threads/${big.id}`));
  record('GET /threads/:id (lang gesprek, 300 berichten) p95', pct(openBig, 95), 'ms', 200);
  const search = await timeMany(30, (i) => t.api('GET', `/search?q=${encodeURIComponent(WORDS[i % WORDS.length] + ' ' + WORDS[(i + 3) % WORDS.length])}`));
  record(`zoeken in ${N_MSG} berichten p95`, pct(search, 95), 'ms', 250);

  // Server overhead of a chat turn (mock model answers instantly): context, memory hooks, persistence, events.
  const th = await t.api('POST', '/threads', { agentId: agents[0].id });
  const turns = await timeMany(25, async () => {
    t.script.push({ text: 'ok' });
    await t.say(th.id, 'Wat staat er op de planning?');
  });
  record('chatbeurt server-overhead (nep-model) p95', pct(turns, 95), 'ms', 400);

  global.gc?.();
  record('geheugen server (RSS) na meten', process.memoryUsage().rss / 1024 / 1024, 'MB', 600);

  // Restart with the full database.
  {
    const t0 = performance.now();
    const again = await createApp({ dataDir: t.dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
    record('opstarten server (volle database)', performance.now() - t0, 'ms', 4000);
    await again.close();
  }

  // ---------------- UI ----------------
  const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctx.addInitScript(() => {
      window.__longTasks = [];
      try {
        new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__longTasks.push(e.duration))).observe({ type: 'longtask', buffered: true });
      } catch {
        /* not supported */
      }
    });
    const page = await ctx.newPage();
    const t0 = performance.now();
    await page.goto(`${t.app.url}/#token=${t.token}`);
    await page.locator('aside a[href^="#/t/"]').first().waitFor({ timeout: 20_000 });
    record('app laden tot zijbalk zichtbaar', performance.now() - t0, 'ms', 2500);
    const t1 = performance.now();
    await page.evaluate((id) => (location.hash = `#/t/${id}`), big.id);
    await page.locator('[id^="m-"]').last().waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => document.querySelectorAll('[id^="m-"]').length >= 250, null, { timeout: 20_000 });
    record('lang gesprek openen en tonen (300 berichten)', performance.now() - t1, 'ms', 1500);
    await page.waitForTimeout(500);
    const longTasks = await page.evaluate(() => window.__longTasks || []);
    record('langste blokkering van de UI (long task)', longTasks.length ? Math.max(...longTasks) : 0, 'ms', 400);
    const heap = await page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize / 1024 / 1024 : 0));
    if (heap) record('JS-geheugen van de pagina', heap, 'MB', 250);
    // Typing stays responsive in a long conversation.
    const box = page.getByPlaceholder(/Bericht aan/);
    await box.click();
    const tt = performance.now();
    await page.keyboard.type('Dit is een test van de typsnelheid in een lang gesprek', { delay: 0 });
    await page.waitForFunction(() => document.querySelector('textarea')?.value.length >= 50);
    record('typen van 54 tekens in lang gesprek', performance.now() - tt, 'ms', 800);
  } finally {
    await browser.close();
  }
} finally {
  await t.close();
}

const failed = rows.filter((r) => !r.ok);
console.log(`\n${rows.length - failed.length}/${rows.length} binnen budget${failed.length ? ` — boven budget: ${failed.map((r) => r.name).join('; ')}` : ''}`);
if (process.env.TEAMBOT_PERF_JSON) fs.writeFileSync(process.env.TEAMBOT_PERF_JSON, JSON.stringify({ at: new Date().toISOString(), messages: N_MSG, rows }, null, 1));
process.exit(failed.length ? 1 : 0);
