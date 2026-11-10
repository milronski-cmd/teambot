// Shared helpers for the 0.4 acceptance suites (tests/e2e/accept-04-*.mjs, package T). Each suite acts like the owner
// in the real built app: a temporary data folder and an empty HOME/APPDATA/PATH (nothing of this PC is found, used or
// changed), the server in this process (`createApp`, desktop mode, own port), the built UI from dist/ui, and Edge
// headless. The only AI is a scripted test engine ("Testmodel", found on this PC, no key) that answers per bot.
// Every check prints one line with its acceptance id (see docs/ACCEPTANCE_0.4.md); the suite exits 1 when one fails.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

/** Fixed port (package T: 4838), so a run never takes 4747/4748 of the owner's TeamBot. */
export const PORT = Number(process.env.TEAMBOT_E2E_PORT) || 4838;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------------ results

const results = [];
/** One acceptance check: `id` from docs/ACCEPTANCE_0.4.md (e.g. "B-02"), a sentence, ok, and what was seen. */
export function check(id, name, ok, detail = '') {
  results.push({ id, name, ok: !!ok, detail });
  console.log(`${ok ? '✔' : '✖'} [${id}] ${name}${detail && !ok ? ` — ${String(detail).slice(0, 400)}` : detail ? ` (${String(detail).slice(0, 160)})` : ''}`);
  return !!ok;
}
/** TEAMBOT_ACCEPT_ONLY=F-01,N-01: run only these parts (later parts may need what earlier parts made). */
const ONLY = (process.env.TEAMBOT_ACCEPT_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
/** Run one part of a suite; an exception fails that part (with its id) and the suite goes on with the next part. */
export async function part(id, title, fn) {
  if (ONLY.length && !ONLY.includes(id)) return;
  console.log(`\n— ${id}: ${title}`);
  try {
    await fn();
  } catch (e) {
    check(id, `${title}: onverwachte fout`, false, e?.stack || e?.message || String(e));
  }
}
export function summary(suite) {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${suite}: ${results.length - failed.length}/${results.length} geslaagd`);
  if (failed.length) {
    console.log('Mislukt:');
    for (const f of failed) console.log(`  [${f.id}] ${f.name}${f.detail ? ` — ${String(f.detail).slice(0, 300)}` : ''}`);
  }
  const ids = {};
  for (const r of results) (ids[r.id] ||= []).push(r.ok);
  console.log(`Per item: ${Object.entries(ids).map(([id, oks]) => `${id} ${oks.every(Boolean) ? 'werkt' : 'FOUT'}`).join(', ')}`);
  return failed.length ? 1 : 0;
}

export async function until(fn, ms = 10_000, step = 100) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not yet */
    }
    if (Date.now() > end) return false;
    await sleep(step);
  }
}

// ------------------------------------------------------------------------------------------------ environment

/** The browser starts first (it needs this PC's normal environment); then TeamBot gets an empty one. */
export async function launchBrowser() {
  return chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
}

/** An empty HOME, APPDATA and PATH for TeamBot: no real Claude Code, Codex, OpenCode or Ollama is ever found. */
export function isolate(prefix) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-home-`));
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_DATA_HOME: path.join(home, 'xdg', 'data'),
    XDG_CONFIG_HOME: path.join(home, 'xdg', 'config'),
    XDG_CACHE_HOME: path.join(home, 'xdg', 'cache'),
    PATH: path.dirname(process.execPath),
  });
  delete process.env.Path;
  delete process.env.TEAMBOT_DATA;
  return home;
}

export function rmrf(...dirs) {
  for (const d of dirs) {
    if (!d) continue;
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* left in the temp folder */
    }
  }
}

// ------------------------------------------------------------------------------------------------ the test engine

/**
 * The scripted AI. `ai.to(bot, ...steps)` queues answers for one bot (the name after "Je bent" in its system prompt;
 * '*' = any request without a queued answer of its own). A step is `{ text }`, `{ toolCalls: [{ name, args }] }`,
 * `{ error: { message, status } }` or a function `(req) => step` (to answer with what a tool returned). Without a
 * step the engine echoes the question. Every request is kept in `ai.requests` (with `bot`).
 */
export function testEngine() {
  const ai = {
    queues: {},
    requests: [],
    to(bot, ...steps) {
      (ai.queues[bot] ||= []).push(...steps);
      return ai;
    },
    last(bot) {
      return [...ai.requests].reverse().find((r) => !bot || r.bot === bot);
    },
    clear() {
      ai.queues = {};
    },
  };
  ai.adapter = () => ({
    kind: 'mock',
    async listModels() {
      return [{ id: 'mock-1' }];
    },
    async test() {
      return { ok: true, detail: 'e2e' };
    },
    async chat(req, _signal, onEvent) {
      const bot = /Je bent ([^\s,—]+)/.exec(req.system || '')?.[1] || '';
      ai.requests.push({ ...req, bot });
      const q = ai.queues[bot]?.length ? ai.queues[bot] : ai.queues['*'] || [];
      let step = q.shift();
      if (typeof step === 'function') step = await step(req);
      if (step?.error) {
        const { ProviderError } = await import('../../server/providers/common.ts');
        throw new ProviderError(step.error.message, step.error.status ?? 500, (step.error.status ?? 500) >= 500 || step.error.status === 429, '', step.error.category);
      }
      const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
      const text = step ? step.text ?? '' : `echo: ${typeof lastUser?.content === 'string' ? lastUser.content.slice(0, 200) : '[multi]'}`;
      for (const ch of text.match(/.{1,12}/gs) || []) onEvent({ type: 'text', delta: ch });
      const toolCalls = (step?.toolCalls || []).map((c, i) => ({ id: `call_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`, name: c.name, args: c.args }));
      return { text, toolCalls, usage: { input: 120, output: 30 }, stop: toolCalls.length ? 'tool_use' : 'end', model: req.model };
    },
  });
  return ai;
}

/** The text of the last tool result the engine got in this request (to answer with what really happened). */
export function lastToolResult(req) {
  const m = [...req.messages].reverse().find((x) => x.role === 'tool');
  if (!m) return '';
  return typeof m.content === 'string' ? m.content : m.content.map((p) => p.text || '').join('');
}

// ------------------------------------------------------------------------------------------------ TeamBot

/**
 * Start TeamBot on `dir` (desktop mode, local owner, fixed port) with the test engine registered as an AI that is
 * "found on this PC" (like Ollama would be). Returns a handle with `api()`, `restart()` (same folder and port, as
 * after "TeamBot start opnieuw") and `close()`.
 */
export async function startTeamBot({ dir, ai, port = PORT, beforeStart } = {}) {
  const { createApp } = await import('../../server/app.ts');
  const tb = { dir, ai, port, app: null, token: '', owner: null, url: '' };
  const boot = async () => {
    const app = await createApp({ dataDir: dir, port, host: '127.0.0.1', mode: 'desktop', quiet: true });
    tb.app = app;
    tb.token = app.ctx.auth.ensureLocalOwner();
    tb.owner = app.ctx.auth.owner();
    tb.url = app.url;
    // Nothing on this PC is ever found (no real Claude Code, Codex, OpenCode or Ollama): only the test engine.
    for (const k of app.ctx.providers.kinds.values()) if (k.detect && k.id !== 'mock') k.detect = async () => ({ installed: false, detail: 'e2e' });
    app.ctx.providers.registerKind({
      id: 'mock',
      label: 'Testmodel',
      type: 'api',
      group: 'local',
      billing: 'local',
      needsKey: false,
      description: 'e2e',
      models: ['mock-1'],
      defaultModel: 'mock-1',
      detect: async () => ({ installed: true, detail: 'e2e' }),
      create: () => ai.adapter(),
    });
    await beforeStart?.(tb);
  };
  tb.api = async (method, p, body) => {
    const r = await fetch(tb.url + '/api' + p, { method, headers: { authorization: `Bearer ${tb.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${p} → ${r.status}: ${j.error}`);
    return j;
  };
  tb.upload = async (name, body, type) => {
    const r = await fetch(`${tb.url}/api/attachments?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { authorization: `Bearer ${tb.token}`, 'content-type': type }, body: new Uint8Array(body) });
    return r.json();
  };
  tb.restart = async () => {
    await tb.app.close();
    await sleep(300);
    await boot();
  };
  tb.close = async () => tb.app?.close();
  /** Wait until no run of this owner is queued, running or waiting. */
  tb.idle = async (ms = 15_000) => until(() => !tb.app.ctx.store.all("SELECT id FROM runs WHERE status IN ('queued','running','waiting')").length, ms, 50);
  tb.bot = (name) => tb.app.ctx.store.agents(tb.owner.id).find((a) => a.name === name);
  await boot();
  return tb;
}

// ------------------------------------------------------------------------------------------------ the browser

/** A page logged in as the local owner; console errors and browser dialogs are collected in `errors`. */
export async function openPage(browser, tb, { width = 1360, height = 880, phone = false, errors = [] } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, locale: 'nl-NL', bypassCSP: true, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|net::ERR_ABORTED|WebSocket/.test(m.text()) && errors.push(m.text()));
  page.on('dialog', (d) => (errors.push(`onverwacht browserdialoog: ${d.message()}`), d.dismiss().catch(() => {})));
  await page.goto(`${tb.url}/#token=${tb.token}`);
  return page;
}

export async function go(page, hash, wait = 700) {
  await page.evaluate((h) => (location.hash = h), hash);
  await page.waitForTimeout(wait);
}
export const hashOf = (page) => page.evaluate(() => location.hash);
export const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
/** The visible text of the main area (#inhoud), whitespace collapsed. */
export const mainText = async (page) => ((await page.locator('#inhoud').innerText().catch(() => '')) || '').replace(/\s+/g, ' ');

export const SHOTS = process.env.TEAMBOT_E2E_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
export async function shot(page, name) {
  if (!SHOTS) return;
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOTS, `accept-${name}.png`) }).catch(() => {});
}

/** Type into the composer of the open conversation and send, as a person does. */
export async function send(page, text) {
  const box = page.getByRole('textbox', { name: 'Bericht' });
  await box.waitFor({ timeout: 10_000 });
  await box.click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

/** Wait for a message bubble with this text in the open conversation. */
export async function seeMessage(page, text, ms = 20_000) {
  return page
    .locator('[id^="m-"]')
    .getByText(text, { exact: false })
    .first()
    .waitFor({ timeout: ms })
    .then(() => true)
    .catch(() => false);
}

/** Confirm the app's own confirmation dialog (askConfirm, role alertdialog) with the button `ok`. */
export async function confirmDialog(page, ok) {
  const dlg = page.getByRole('alertdialog').last();
  await dlg.waitFor({ timeout: 5000 });
  await dlg.getByRole('button', { name: ok, exact: true }).click();
}

// ------------------------------------------------------------------------------------------------ documents

/** A small valid pdf with text per page (Helvetica), built by hand (same as tests/memory-documents.test.ts). */
export function makePdf(pages) {
  const objs = [];
  const add = (s) => objs.push(s);
  const catalog = add('<< /Type /Catalog /Pages 2 0 R >>');
  add('PAGES');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  for (const lines of pages) {
    const body = ['BT', '/F1 24 Tf', '72 760 Td', ...lines.flatMap((l, i) => (i ? ['0 -36 Td', `(${l}) Tj`] : [`(${l}) Tj`])), 'ET'].join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => {
    offs.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A minimal Word document (.docx) with these paragraphs. */
export function makeDocx(paragraphs) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${esc(p)}</w:t></w:r></w:p>`).join('');
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
  zip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`));
  return zip.toBuffer();
}
