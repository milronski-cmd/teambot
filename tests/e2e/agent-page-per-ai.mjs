// The bot page per kind of AI, in a real browser, without any real AI.
//
// TeamBot runs a bot on a model through an API key, a local model (Ollama, LM Studio), Claude Code, Codex or an ACP
// program (OpenCode, Gemini CLI …). Not everything on the bot page works on every one of them ("Alleen chat" cannot be
// enforced on Codex or ACP, a thinking level is never passed to an ACP program, a context window is only ours to set
// on Ollama and LM Studio, a time limit per turn exists for the programs only …). The page shows, for the AI the bot
// uses now, exactly the rows that work on it; what does not work there is hidden, not greyed out.
//
// This check makes one bot on each kind (the scripted API provider and the fake engines of the tests), opens each bot
// page, records the rows it shows in one table, and holds the table against what the engines really do. Then it moves
// one bot from Claude Code to Codex and back: values that do not apply to Codex are out of view, stay in storage, and
// are back when the bot is back on Claude Code.
//
// Usage: npm run build:ui && node --import tsx tests/e2e/agent-page-per-ai.mjs
//        [TEAMBOT_UI_DIR=<a built ui>] [TEAMBOT_E2E_SHOTS=<dir>] [--record]   (--record: only print the table)
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(here, '..', 'fixtures', name);
const RECORD = process.argv.includes('--record');
const shots = process.env.TEAMBOT_E2E_SHOTS || '';
if (shots) fs.mkdirSync(shots, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push(!!ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(80)) {
    try {
      if (await fn()) return true;
    } catch {
      /* not there yet */
    }
  }
  return false;
};

// ---------------------------------------------------------------- a local model server (a stand-in Ollama; no model runs)
const ollama = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const send = (x) => (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify(x)));
    if (req.url === '/api/version') return send({ version: '0.40.15' });
    // (qwen3 thinks, as the real Ollama says: the bot on it has a thinking level to choose.)
    if (req.url === '/api/tags') return send({ models: [{ name: 'qwen3:4b', digest: 'q', size: 2_600_000_000, details: { parameter_size: '4B', context_length: 40960 }, capabilities: ['completion', 'tools', 'thinking'] }] });
    if (req.url === '/api/ps') return send({ models: [{ name: 'qwen3:4b', context_length: 8192 }] });
    if (req.url === '/api/show') return send({ model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960 }, capabilities: ['completion', 'tools', 'thinking'] });
    if (req.url === '/v1/models') return send({ data: [{ id: 'qwen3:4b' }] });
    res.writeHead(404);
    res.end('{}');
  });
});
await new Promise((r) => ollama.listen(0, '127.0.0.1', r));
const ollamaUrl = `http://127.0.0.1:${ollama.address().port}/v1`;

// The browser starts first (it needs this pc's normal environment); TeamBot then gets an empty one: nothing of the
// owner's own TeamBot, Claude Code, Codex or OpenCode is read or touched.
const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-agent-page-home-'));
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  XDG_DATA_HOME: path.join(home, 'xdg', 'data'),
  XDG_CONFIG_HOME: path.join(home, 'xdg', 'config'),
  XDG_CACHE_HOME: path.join(home, 'xdg', 'cache'),
  PATH: path.dirname(process.execPath),
  TEAMBOT_TEST_NO_STARTER_RULES: '1',
});
delete process.env.Path;
delete process.env.TEAMBOT_DATA;

const { createApp } = await import('./server.mjs');
const { mockAdapter } = await import('../helpers.ts');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-agent-page-'));
const app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
// Nothing on this pc is found by itself (no real program, no real local model server).
for (const k of app.ctx.providers.kinds.values()) if (k.detect) k.detect = async () => ({ installed: false, detail: 'e2e' });
app.ctx.providers.registerKind({ id: 'mock', label: 'Testmodel (API)', type: 'api', needsKey: false, description: 'e2e', models: ['mock-1'], defaultModel: 'mock-1', create: () => mockAdapter([], []) });
const api = async (method, p, body) => {
  const r = await fetch(app.url + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status}: ${j.error}`);
  return j;
};

// ---------------------------------------------------------------- one bot on each kind of AI
const KINDS = [
  { key: 'api', label: 'API-sleutel', provider: { kind: 'mock' }, model: 'mock-1' },
  { key: 'local', label: 'Lokaal model', provider: { kind: 'ollama', base_url: ollamaUrl }, model: 'qwen3:4b' },
  { key: 'claude', label: 'Claude Code', provider: { kind: 'claude-code', config: { path: fixture('cli-agents-fake-claude.mjs') } }, model: '' },
  { key: 'codex', label: 'Codex', provider: { kind: 'codex-cli', config: { path: fixture('cli-agents-fake-codex.mjs') } }, model: '' },
  { key: 'acp', label: 'OpenCode (ACP)', provider: { kind: 'opencode', name: 'OpenCode', config: { path: fixture('cli-agents-fake-acp.mjs'), defaultModel: 'opencode/big-pickle' } }, model: '' },
];
for (const k of KINDS) {
  k.prov = await api('POST', '/providers', k.provider);
  k.bot = await api('POST', '/agents', { name: `Bot ${k.key}`, role: 'Assistent', provider_id: k.prov.id, model: k.model, access_mode: 'auto' });
}
console.log(`• TeamBot op ${app.url} (lege datamap), ${KINDS.length} bots: ${KINDS.map((k) => `${k.label} = ${k.prov.name}`).join(', ')}`);

const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text()) && errors.push(m.text()));

/** Open a bot page with everything in view: "Meer mogelijkheden" open, every row of it open. */
async function openBot(id) {
  await page.evaluate((h) => (location.hash = h), `#/agents/${id}`);
  await page.locator('[data-testid="bot-advanced"]').waitFor({ timeout: 15000 });
  // The model list of a program can take a moment (the fake Claude Code is asked for its models).
  await page.waitForTimeout(1500);
  await openAll();
}
async function openAll() {
  await page.evaluate(() => document.querySelectorAll('[data-testid="bot-advanced"] details').forEach((d) => (d.open = true)));
  for (let pass = 0; pass < 4; pass++) {
    const closed = page.locator('[data-testid="bot-advanced"] [data-section] > h3 > button[aria-expanded="false"]');
    const n = await closed.count();
    if (!n) break;
    for (let i = 0; i < n; i++) await closed.first().click();
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(700);
}

/**
 * What the page shows: the rows of the first level, the levels of "Wat mag de bot?", the rows of Meer mogelijkheden
 * and, inside the rows that differ per AI, their own fields. A row or field is named by `data-row` when the page gives
 * one, else by its visible label.
 */
async function rowsShown() {
  const out = await page.evaluate(() => {
    const vis = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) && !el.closest('[hidden]');
    const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
    const first = [];
    const top = document.querySelector('[data-tab="overzicht"]');
    for (const el of top?.querySelectorAll('[data-row]') || []) if (vis(el)) first.push(el.getAttribute('data-row'));
    if (!first.length) {
      // (A page without data-row: the card titles and field labels of the first level.)
      for (const el of top?.querySelectorAll('label > span:first-child, h2, h3') || []) if (vis(el) && text(el)) first.push(text(el));
    }
    const adv = document.querySelector('[data-testid="bot-advanced"]');
    const sections = [];
    for (const s of adv?.querySelectorAll('[data-section]') || []) {
      if (!vis(s)) continue;
      const id = s.getAttribute('data-section');
      const title = text(s.querySelector(':scope > h3 > button > span > span'))
        .replace(/Niet opgeslagen$/, '')
        .trim();
      const fields = [];
      const body = s.querySelector(':scope > div');
      if (body && vis(body)) {
        const named = [...body.querySelectorAll('[data-row]')].filter((el) => vis(el) && el.closest('[data-section]') === s);
        if (named.length) fields.push(...named.map((el) => el.getAttribute('data-row')));
        else {
          const seen = new Set();
          const add = (t) => t && !seen.has(t) && (seen.add(t), fields.push(t));
          for (const el of body.querySelectorAll('label, [role="radiogroup"][aria-label], [role="switch"], [role="combobox"][aria-label], input[aria-label], textarea[aria-label], [data-testid="context-window"], [data-testid="no-levels"], [data-testid="model-facts"]')) {
            if (!vis(el) || el.closest('[data-section]') !== s) continue;
            if (el.matches('[data-testid]')) add(`[${el.getAttribute('data-testid')}]`);
            else if (el.matches('label')) add(text(el.querySelector('span')) || text(el));
            else add(el.getAttribute('aria-label') || text(el));
          }
        }
      }
      sections.push({ id, title, fields });
    }
    return { first, sections };
  });
  // The levels of "Wat mag de bot?": open the dropdown and read which ones can be chosen.
  const box = page.locator('[data-testid="access-choice"] [role="combobox"]');
  await box.click();
  const levels = await page.locator('[role="listbox"] [role="option"]').evaluateAll((os) => os.map((o) => `${o.textContent.trim()}${o.getAttribute('aria-disabled') === 'true' ? ' (grijs)' : ''}`));
  await page.keyboard.press('Escape');
  // The choices of "Als de bot bezig is" (a radiogroup inside its row).
  const busy = await page.locator('[role="radiogroup"][aria-label="Als de bot bezig is"] [role="radio"]').evaluateAll((os) => os.filter((o) => !!(o.offsetWidth || o.offsetHeight)).map((o) => o.textContent.trim()));
  // The one line under "Wat mag de bot?" where TeamBot does not guard the hard blocks at this level on this AI.
  const guard = (await page.locator('[data-testid="level-guard"]').count()) ? (await page.locator('[data-testid="level-guard"]').innerText()).trim() : '';
  return { ...out, levels, busy, guard };
}

const table = {};
try {
  await page.goto(`${app.url}/#token=${token}`);
  await page.waitForTimeout(1200);
  for (const k of KINDS) {
    await openBot(k.bot.id);
    table[k.key] = await rowsShown();
    if (shots) await page.screenshot({ path: path.join(shots, `botpagina-${k.key}.png`), fullPage: true });
  }

  // ---------------------------------------------------------------- the table: a line per row, a column per kind of AI
  const lines = [];
  const mark = (has) => KINDS.map((k) => (has(table[k.key]) ? 'ja' : '–').padEnd(8)).join('');
  const all = (pick) => [...new Set(KINDS.flatMap((k) => pick(table[k.key])))];
  lines.push(`${'RIJ'.padEnd(64)}${KINDS.map((k) => k.key.padEnd(8)).join('')}`);
  lines.push('— eerste niveau');
  for (const r of all((t) => t.first)) lines.push(`${`  ${r}`.padEnd(64)}${mark((t) => t.first.includes(r))}`);
  lines.push('— Wat mag de bot? (niveaus)');
  for (const r of all((t) => t.levels)) lines.push(`${`  ${r}`.padEnd(64)}${mark((t) => t.levels.includes(r))}`);
  lines.push(`${'  regel "Niet bewaakt door TeamBot" (bij Automatisch)'.padEnd(64)}${mark((t) => !!t.guard)}`);
  lines.push('— Als de bot bezig is (keuzes)');
  for (const r of all((t) => t.busy)) lines.push(`${`  ${r}`.padEnd(64)}${mark((t) => t.busy.includes(r))}`);
  lines.push('— Meer mogelijkheden');
  for (const id of all((t) => t.sections.map((s) => s.id))) {
    const title = KINDS.map((k) => table[k.key].sections.find((s) => s.id === id)?.title).find(Boolean) || '';
    lines.push(`${`  ${title} [${id}]`.padEnd(64)}${mark((t) => t.sections.some((s) => s.id === id))}`);
    const fields = all((t) => t.sections.find((s) => s.id === id)?.fields || []);
    const same = fields.every((f) => KINDS.every((k) => !table[k.key].sections.some((s) => s.id === id) || table[k.key].sections.find((s) => s.id === id).fields.includes(f)));
    // Only the fields that differ per AI are listed (a row whose fields are the same everywhere is one line).
    if (!same) for (const f of fields) lines.push(`${`      · ${f}`.padEnd(64)}${mark((t) => !!t.sections.find((s) => s.id === id)?.fields.includes(f))}`);
  }
  console.log(`\n${lines.join('\n')}\n`);
  if (shots) fs.writeFileSync(path.join(shots, 'botpagina-rijen.txt'), lines.join('\n') + '\n');

  if (!RECORD) {
    const T = table;
    const sec = (k, id) => T[k].sections.find((s) => s.id === id);
    const field = (k, id, f) => !!sec(k, id)?.fields.includes(f);
    const only = (name, has, want) => {
      const got = KINDS.filter((k) => has(k.key)).map((k) => k.key);
      check(`${name}: alleen bij ${want.join(', ') || 'geen enkele'}`, got.join() === want.join(), `nu bij ${got.join(', ') || 'geen enkele'}`);
    };
    // Nothing greyed out: a level that cannot work on this AI is not in the list at all.
    check('Wat mag de bot?: geen enkel niveau staat grijs', KINDS.every((k) => !T[k.key].levels.some((l) => /grijs/.test(l))));
    only('Alleen chat (alleen af te dwingen met eigen tools of Claude Code)', (k) => T[k].levels.includes('Alleen chat'), ['api', 'local', 'claude']);
    for (const lvl of ['Alleen lezen', 'Vraagt toestemming', 'Automatisch', 'Volledige toegang']) only(lvl, (k) => T[k].levels.includes(lvl), ['api', 'local', 'claude', 'codex', 'acp']);
    only('Bijsturen tijdens een beurt (alleen TeamBots eigen lus kan dat)', (k) => T[k].busy.includes('Bijsturen'), ['api', 'local']);
    only('Wachtrij en Onderbreken', (k) => T[k].busy.includes('Wachtrij') && T[k].busy.includes('Onderbreken'), ['api', 'local', 'claude', 'codex', 'acp']);
    // The scripted API model and OpenCode have no thinking levels to choose; an ACP program never gets one at all.
    only('Denkniveau (waar het model niveaus heeft en de AI ze aanneemt)', (k) => field(k, 'core:engine', 'denkniveau'), ['local', 'claude', 'codex']);
    only('Bij een gebruikslimiet', (k) => field(k, 'core:engine', 'gebruikslimiet'), ['api', 'local', 'claude', 'codex', 'acp']);
    only('Stappen per beurt (TeamBots eigen lus en Claude Code)', (k) => field(k, 'core:turn', 'stappen'), ['api', 'local', 'claude']);
    only('Hoe lang mag een beurt duren (elk programma)', (k) => field(k, 'core:turn', 'duur'), ['claude', 'codex', 'acp']);
    only('Stoppen na stilte (elk programma)', (k) => field(k, 'core:turn', 'stilte'), ['claude', 'codex', 'acp']);
    only('Je eigen apps van het programma gebruiken (Claude Code en Codex)', (k) => field(k, 'core:program', 'eigen-apps'), ['claude', 'codex']);
    only('Je eigen instellingen van het programma laden (Claude Code)', (k) => field(k, 'core:program', 'eigen-instellingen'), ['claude']);
    only('Altijd toegestane en altijd geweigerde stappen van het programma (Claude Code)', (k) => field(k, 'core:program', 'altijd-toegestaan') && field(k, 'core:program', 'altijd-geweigerd'), ['claude']);
    only('Extra argumenten (programma’s met een lijst van toegestane argumenten)', (k) => field(k, 'core:program', 'extra-argumenten'), ['claude', 'codex']);
    only('de rij Programma zelf', (k) => !!sec(k, 'core:program'), ['claude', 'codex']);
    only('Contextvenster (alleen bij een lokaal model in te stellen)', (k) => field(k, 'core:model', 'contextvenster'), ['local']);
    only('Stappen zonder iets nieuws (alleen TeamBots eigen lus telt ze)', (k) => field(k, 'quality:quality', 'Stappen zonder iets nieuws'), ['api', 'local']);
    check('de oude rij met vlaggen per programma (cli-agents:cli) is er niet meer', KINDS.every((k) => !sec(k.key, 'cli-agents:cli')));
    check('geen uitlegregel waar iets niet kan (geen “geen denkniveaus”-tekst)', KINDS.every((k) => !sec(k.key, 'core:engine')?.fields.includes('[no-levels]')));
    // "Niet bewaakt door TeamBot": one line under the level, exactly where the server says the hard blocks do not hold
    // for this bot at this level on this AI (GET /cli-agents/hard-blocks), and nothing anywhere else.
    const guards = [];
    for (const k of KINDS) {
      const f = (await api('GET', `/cli-agents/hard-blocks/${k.prov.id}?agentId=${k.bot.id}`)).levels?.auto;
      const want = f && !f.guarded ? f.text : '';
      guards.push(`${k.key}: ${T[k.key].guard ? 'regel' : '–'}`);
      if (T[k.key].guard !== want) guards.push(`(${k.key} verwacht “${want || 'geen regel'}”)`);
    }
    check('“Niet bewaakt door TeamBot” staat er precies waar de server het zegt', !guards.some((g) => g.startsWith('(')), guards.join(', '));
    // The same row has the same words on every AI it is shown on.
    const titles = {};
    for (const k of KINDS) for (const s of T[k.key].sections) (titles[s.id] ||= new Set()).add(s.title);
    const differ = Object.entries(titles).filter(([, v]) => v.size > 1).map(([id, v]) => `${id}: ${[...v].join(' / ')}`);
    check('dezelfde rij heet overal hetzelfde', !differ.length, differ.join('; '));

    // ---------------------------------------------------------------- Claude Code → Codex → Claude Code
    const cc = KINDS.find((k) => k.key === 'claude');
    const cx = KINDS.find((k) => k.key === 'codex');
    const stored = { cli: { timeoutMin: 90, loadUserSettings: true, allowedTools: ['Bash(npm test)'], extraArgs: ['--fallback-model', 'haiku'] }, maxTurns: 25 };
    await api('PATCH', `/agents/${cc.bot.id}`, { access_mode: 'chat', reasoning: 'high', settings: { ...(cc.bot.settings || {}), ...stored } });
    await page.reload();
    await page.waitForTimeout(1200);
    await openBot(cc.bot.id);
    const val = (row) => page.locator(`[data-row="${row}"] input, [data-row="${row}"] textarea`).first().inputValue().catch(() => null);
    const shown = (row) => page.locator(`[data-row="${row}"]`).first().isVisible().catch(() => false);
    const level = () => page.locator('[data-testid="access-choice"] [role="combobox"]').innerText();
    const before = { level: (await level()).trim(), steps: await val('stappen'), time: await val('duur'), extra: await val('extra-argumenten') };
    check('op Claude Code: de opgeslagen waarden staan in beeld', before.level === 'Alleen chat' && before.steps === '25' && before.time === '90' && before.extra === '--fallback-model haiku', JSON.stringify(before));
    // Claude Code only takes the always-allowed rules at "Vraagt toestemming" and "Automatisch" (claude.ts).
    check('op Claude Code bij Alleen chat: de altijd toegestane tools zijn uit beeld', !(await shown('altijd-toegestaan')));

    const pickAi = async (name) => {
      await page.locator('[data-row="ai"] [role="combobox"]').first().click();
      await page.locator('[role="listbox"] [role="option"]', { hasText: name }).first().click();
      await page.waitForTimeout(1500);
      await openAll();
    };
    const save = async () => {
      await page.getByRole('button', { name: 'Opslaan', exact: true }).first().click();
      await page.waitForTimeout(900);
      return api('GET', `/agents/${cc.bot.id}`);
    };
    await pickAi(cx.prov.name);
    const onCodex = { level: (await level()).trim(), allowedShown: await shown('altijd-toegestaan'), stepsShown: await shown('stappen'), settingsShown: await shown('eigen-instellingen'), time: await val('duur'), extra: await val('extra-argumenten') };
    check('naar Codex: wat daar niet werkt is uit beeld (Alleen chat, stappen, toegestane stappen, eigen instellingen)', onCodex.level !== 'Alleen chat' && !onCodex.allowedShown && !onCodex.stepsShown && !onCodex.settingsShown, JSON.stringify(onCodex));
    check('naar Codex: wat daar ook werkt staat er met dezelfde waarde (duur van een beurt 90 minuten)', onCodex.time === '90', String(onCodex.time));
    check('naar Codex: de extra argumenten van Claude Code staan niet in het veld van Codex', onCodex.extra === '', String(onCodex.extra));
    const a1 = await save();
    check('opgeslagen op Codex: het niveau is er een dat Codex kan (Alleen lezen)', a1.provider_id === cx.prov.id && a1.access_mode === 'readonly', `${a1.access_mode}`);
    check('opgeslagen op Codex: de waarden van Claude Code staan nog in de opslag', a1.settings?.cli?.allowedTools?.[0] === 'Bash(npm test)' && a1.settings?.cli?.loadUserSettings === true && a1.settings?.maxTurns === 25 && a1.reasoning === 'high', JSON.stringify(a1.settings?.cli));
    check('opgeslagen op Codex: Codex krijgt geen argumenten van Claude Code mee', !(a1.settings?.cli?.extraArgs || []).length, JSON.stringify(a1.settings?.cli?.extraArgs));

    await page.reload();
    await page.waitForTimeout(1200);
    await openBot(cc.bot.id);
    await pickAi(cc.prov.name);
    const back = { level: (await level()).trim(), steps: await val('stappen'), time: await val('duur'), extra: await val('extra-argumenten') };
    check('terug naar Claude Code (na opslaan en opnieuw laden): alles is er weer', JSON.stringify(back) === JSON.stringify(before), JSON.stringify(back));
    const a2 = await save();
    check('opgeslagen terug op Claude Code: zoals het was', a2.provider_id === cc.prov.id && a2.access_mode === 'chat' && a2.settings?.cli?.extraArgs?.join(' ') === '--fallback-model haiku' && a2.settings?.cli?.timeoutMin === 90, `${a2.access_mode} ${JSON.stringify(a2.settings?.cli)}`);
    // The level where Claude Code reads them: the always-allowed rules are there again, as they were stored.
    await page.locator('[data-testid="access-choice"] [role="combobox"]').click();
    await page.locator('[role="listbox"] [role="option"]', { hasText: 'Vraagt toestemming' }).first().click();
    await page.waitForTimeout(400);
    check('terug op Claude Code, bij Vraagt toestemming: de altijd toegestane tools staan er weer', (await val('altijd-toegestaan')) === 'Bash(npm test)', String(await val('altijd-toegestaan')));
    if (shots) await page.screenshot({ path: path.join(shots, 'botpagina-terug-op-claude.png'), fullPage: true });

    // ---------------------------------------------------------------- "Niet bewaakt door TeamBot", at every level
    // The line is there exactly where the steps of the bot's AI pass outside TeamBot's gate and nothing else keeps the
    // key files, the closed folders and TeamBot's data shut; nowhere else. What the engines do (not what the server
    // says): an API or local model only has TeamBot's tools; Claude Code asks the gate or gets the shut folders as its
    // own deny rules; OpenCode asks the gate for every path outside its folder; another ACP program (Gemini CLI) reads
    // without asking, and from "Automatisch" on also writes and runs; Codex asks nothing (approvals off), so only its
    // own sandbox can keep them shut: the fake Codex tells TeamBot's check that it holds (FAKE_CODEX_SANDBOX=mxc), and
    // that the whole disk with deny rules holds too (FAKE_CODEX_ROOT=held), or not. "Volledige toegang" on this pc is
    // the whole computer, which on Codex needs that second kind of sandbox.
    const LABEL = { chat: 'Alleen chat', readonly: 'Alleen lezen', ask: 'Vraagt toestemming', auto: 'Automatisch', full: 'Volledige toegang' };
    const copy = (name) => {
      const to = path.join(home, name, 'codex.mjs');
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(fixture('cli-agents-fake-codex.mjs'), to);
      return to;
    };
    const extra = async (key, provider) => {
      const prov = await api('POST', '/providers', provider);
      const bot = await api('POST', '/agents', { name: `Bot ${key}`, role: 'Assistent', provider_id: prov.id, model: '', access_mode: 'auto' });
      return { key, prov, bot };
    };
    /** Every level the page offers for this bot, chosen on the page: the line under it ('' = none). Nothing saved. */
    const linesPerLevel = async (botId) => {
      // Away from the page before (its level was only chosen, not saved: "Niet opslaan").
      await page.evaluate(() => (location.hash = '#/agents'));
      const notSave = page.getByRole('button', { name: 'Niet opslaan', exact: true });
      if (await notSave.isVisible({ timeout: 1000 }).catch(() => false)) await notSave.click();
      await until(async () => (await page.evaluate(() => location.hash)) === '#/agents', 3000);
      await openBot(botId);
      const box = page.locator('[data-testid="access-choice"] [role="combobox"]');
      await box.click();
      const offered = await page.locator('[role="listbox"] [role="option"]').evaluateAll((os) => os.map((o) => o.textContent.trim()));
      await page.keyboard.press('Escape');
      const out = {};
      for (const [id, label] of Object.entries(LABEL)) {
        if (!offered.includes(label)) continue;
        await box.click();
        await page.locator('[role="listbox"] [role="option"]', { hasText: label }).first().click();
        // "Volledige toegang" asks first (the warning); yes.
        const sure = page.getByRole('button', { name: 'Doorgaan', exact: true });
        if (await sure.isVisible({ timeout: 800 }).catch(() => false)) await sure.click();
        await until(async () => (await box.innerText()).trim() === label, 3000);
        await page.waitForTimeout(150);
        const g = page.locator('[data-testid="level-guard"]');
        out[id] = (await g.count()) ? (await g.innerText()).trim() : '';
      }
      return out;
    };
    const NOT = /^Niet bewaakt door TeamBot: /;
    const none = () => ({ chat: '', readonly: '', ask: '', auto: '', full: '' });
    const levels = KINDS.filter((k) => k.key !== 'codex').map((k) => [k.label, k.bot.id, none()]);
    // The fake Codex without a sandbox check (an older Codex): nothing holds at any level.
    const reads = /^Niet bewaakt door TeamBot: Codex kan op deze pc alles lezen wat jij kunt lezen, ook sleutelbestanden/;
    levels.push(['Codex zonder sandbox', cx.bot.id, { readonly: reads, ask: reads, auto: reads, full: /^Niet bewaakt door TeamBot: met Volledige toegang draait Codex hier zonder sandbox/ }]);
    const gemini = await extra('gemini', { kind: 'gemini-cli', config: { path: fixture('cli-agents-fake-acp.mjs') } });
    levels.push(['Gemini CLI (ACP)', gemini.bot.id, { readonly: /^Niet bewaakt door TeamBot: Gemini CLI kan bestanden lezen zonder TeamBot te vragen/, ask: /^Niet bewaakt door TeamBot: Gemini CLI kan bestanden lezen zonder/, auto: /^Niet bewaakt door TeamBot: Gemini CLI kan in deze stand bestanden lezen en wijzigen en opdrachten uitvoeren/, full: /^Niet bewaakt door TeamBot: Gemini CLI kan in deze stand bestanden lezen en wijzigen/ }]);
    const judge = (name, got, want) => {
      for (const [lvl, w] of Object.entries(want)) {
        if (!(lvl in got)) continue;
        const ok = w ? w.test(got[lvl]) : got[lvl] === '';
        if (!ok) console.log(`    ${name} · ${LABEL[lvl]}: verwacht ${w ? w : 'geen regel'}, staat er: “${got[lvl] || 'geen regel'}”`);
      }
      const offered = Object.keys(got).map((l) => LABEL[l]).join(', ');
      check(`${name}: “Niet bewaakt door TeamBot” op ${Object.keys(got).filter((l) => got[l]).map((l) => LABEL[l]).join(', ') || 'geen enkel niveau'}`, Object.keys(got).every((l) => (want[l] ? want[l].test(got[l]) : got[l] === '')) && Object.values(got).every((t) => !t || NOT.test(t)), `niveaus: ${offered}`);
    };
    for (const [name, id, want] of levels) judge(name, await linesPerLevel(id), want);
    // Codex whose sandbox holds (checked on this pc): shut at every level; on the whole computer only when the whole
    // disk with deny rules holds too.
    process.env.FAKE_CODEX_SANDBOX = 'mxc';
    const boxed = await extra('codex-sandbox', { kind: 'codex-cli', name: 'Codex met sandbox', config: { path: copy('codex-sandbox') } });
    judge('Codex met sandbox die leest afschermt (niet de hele schijf)', await linesPerLevel(boxed.bot.id), { readonly: null, ask: null, auto: null, full: /^Niet bewaakt door TeamBot: met Volledige toegang draait Codex hier zonder sandbox/ });
    process.env.FAKE_CODEX_ROOT = 'held';
    const rooted = await extra('codex-root', { kind: 'codex-cli', name: 'Codex met sandbox op de hele schijf', config: { path: copy('codex-root') } });
    judge('Codex met sandbox, ook op de hele schijf', await linesPerLevel(rooted.bot.id), { readonly: null, ask: null, auto: null, full: null });
    delete process.env.FAKE_CODEX_SANDBOX;
    delete process.env.FAKE_CODEX_ROOT;
    // The line follows the AI chosen on the page, before it is saved: Claude Code at "Automatisch" → Codex → back.
    const guardNow = async () => ((await page.locator('[data-testid="level-guard"]').count()) ? (await page.locator('[data-testid="level-guard"]').innerText()).trim() : '');
    await page.evaluate(() => (location.hash = '#/agents'));
    const notSave = page.getByRole('button', { name: 'Niet opslaan', exact: true });
    if (await notSave.isVisible({ timeout: 1000 }).catch(() => false)) await notSave.click();
    const onAuto = KINDS.find((k) => k.key === 'claude');
    await api('PATCH', `/agents/${onAuto.bot.id}`, { access_mode: 'auto' });
    await openBot(onAuto.bot.id);
    const flip = [await guardNow()];
    await pickAi(cx.prov.name);
    await until(async () => !!(await guardNow()), 5000);
    flip.push(await guardNow());
    if (shots) await page.screenshot({ path: path.join(shots, 'botpagina-niet-bewaakt.png'), fullPage: false });
    await pickAi(onAuto.prov.name);
    await until(async () => !(await guardNow()), 5000);
    flip.push(await guardNow());
    check('de regel volgt de AI die je op de pagina kiest: Claude Code geen, Codex wel, terug geen', !flip[0] && reads.test(flip[1]) && !flip[2], flip.map((f) => f || '–').join(' → '));
  }
} catch (e) {
  check('onverwachte fout', false, e.stack || e.message);
} finally {
  await browser.close();
  await app.close();
  await new Promise((r) => ollama.close(r));
  for (const d of [dir, home]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
if (!RECORD) check('geen fouten in de console', !errors.length, errors.slice(0, 5).join(' | '));
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} geslaagd`);
process.exit(failed ? 1 : 0);
