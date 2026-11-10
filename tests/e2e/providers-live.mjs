// LIVE provider check: which AI providers really work on this PC.
//   npm run providers:live              (add -- --record to refresh tests/fixtures/providers/recorded/*.json)
// - Every API key found (environment variable or a file with that name in ~/Sleutels) gets the free check that
//   "Test verbinding" does (key/credit endpoint or model list) plus a free wrong-key check. Keys are never printed.
// - Real chat (text, parallel tool calls, tool results, image in) only on OpenAI's cheapest model: well under a cent.
// - Local servers (Ollama, LM Studio, llama.cpp, vLLM, ...) found on their default ports: check + real chat (free).
// - CLIs: Claude Code and Codex with your own login, OpenCode with a free model in a throw-away HOME/XDG folder
//   (your real ~/.local/share/opencode is never touched). Skip them with -- --no-cli, or run only them with -- --only-cli.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const RECORD = process.argv.includes('--record');
const NO_CLI = process.argv.includes('--no-cli');
const ONLY_OPENCODE = process.argv.includes('--only-opencode');
const ONLY_CLI = process.argv.includes('--only-cli');
const NO_LOCAL = process.argv.includes('--no-local');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'providers', 'recorded');
const SLEUTELS = path.join(process.env.TEAMBOT_KEYS_DIR || path.join(os.homedir(), 'Sleutels'));

/** Key names per provider kind (env var or file name in ~/Sleutels). */
const KEY_NAMES = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  google: ['GEMINI_API_KEY', 'GOOGLE_AI_STUDIO_KEY'],
  groq: ['GROQ_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  zai: ['ZAI_API_KEY', 'Z_AI_API_KEY'],
  nvidia: ['NVIDIA_API_KEY'],
  xai: ['XAI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  moonshot: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
  qwen: ['DASHSCOPE_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  fireworks: ['FIREWORKS_API_KEY'],
  deepinfra: ['DEEPINFRA_API_KEY'],
  huggingface: ['HF_TOKEN', 'HUGGINGFACE_API_KEY'],
  perplexity: ['PERPLEXITY_API_KEY'],
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ''}`);
};
const info = (s) => console.log(`  · ${s}`);

function keyFor(kind) {
  for (const n of KEY_NAMES[kind] || []) {
    if (process.env[n]?.trim()) return { key: process.env[n].trim(), from: `omgevingsvariabele ${n}` };
    const f = path.join(SLEUTELS, n);
    try {
      const v = fs.readFileSync(f, 'utf8').trim();
      if (v) return { key: v, from: `~/Sleutels/${n}` };
    } catch {
      /* not there */
    }
  }
  return null;
}

// ---------- recording (raw provider answers → fixtures; request bodies without headers, so never a key) ----------
const recorded = [];
if (RECORD) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const res = await orig(url, init);
    const u = String(url);
    if (!/^https?:\/\//.test(u) || /oauth2|token/.test(u)) return res;
    const copy = res.clone();
    const entry = { url: u.replace(/\?.*$/, ''), method: init.method || 'GET', request: init.body ? safeParse(String(init.body)) : undefined, status: res.status, contentType: res.headers.get('content-type') || '' };
    recorded.push(entry);
    copy.text().then((t) => (entry.body = t.slice(0, 200_000))).catch(() => {});
    return res;
  };
}
function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s.slice(0, 2000);
  }
}
function saveFixture(name, entries, note) {
  if (!RECORD || !entries.length) return;
  fs.mkdirSync(FIXTURES, { recursive: true });
  // Balances are personal: recorded as 0.00 (the shape is what the tests need).
  const clean = entries.map((e) => ({ ...e, request: shrink(e.request), body: /balance/.test(e.url) && typeof e.body === 'string' ? e.body.replace(/"(-?\d+(?:\.\d+)?)"/g, '"0.00"') : e.body }));
  fs.writeFileSync(path.join(FIXTURES, `${name}.json`), JSON.stringify({ source: `recorded live on ${new Date().toISOString().slice(0, 10)} by tests/e2e/providers-live.mjs`, note, entries: clean }, null, 2) + '\n');
  info(`fixture opgeslagen: tests/fixtures/providers/recorded/${name}.json`);
}
/** Images in requests are replaced by a marker (fixtures stay small). */
function shrink(req) {
  return JSON.parse(JSON.stringify(req ?? null, (k, v) => (typeof v === 'string' && v.startsWith('data:image/') ? 'data:image/png;base64,(weggelaten)' : v)));
}
const take = () => recorded.splice(0, recorded.length);
const settle = () => new Promise((r) => setTimeout(r, 200));

/** A 16x16 solid red PNG (built here, no file needed). */
function redPng() {
  const w = 16;
  const h = 16;
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([255, 0, 0], y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

const WEATHER = { name: 'get_weather', description: 'Geeft het weer in een stad.', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } };
const cfgFor = (kind, extra = {}) => ({ id: 'live', user_id: 'live', kind, name: kind, base_url: '', secret_id: null, config: {}, enabled: true, shared: false, created_at: new Date().toISOString(), ...extra });

async function chatCases(label, adapter, model, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs || 120_000);
  const run = (req) => adapter.chat({ system: 'Antwoord kort, in het Nederlands.', tools: [], ...req, model }, ctl.signal, () => {});
  try {
    const t = await run({ messages: [{ role: 'user', content: 'Zeg alleen het woord: hallo' }], reasoning: opts.reasoning, maxTokens: opts.maxTokens || 400 });
    check(`${label}: tekst streamen`, /hallo/i.test(t.text), JSON.stringify(t.text).slice(0, 80));
    check(`${label}: gebruik (tokens) gemeld`, t.usage.input > 0 && t.usage.output > 0, `${t.usage.input} in / ${t.usage.output} uit${t.usage.cacheRead ? ` / ${t.usage.cacheRead} cache` : ''}`);
    if (t.reasoning) info(`denktekst ontvangen (${t.reasoning.length} tekens)`);
    await settle();
    saveFixture(`${opts.fixture}-text`, take(), 'Plain text answer');

    const tc = await run({ messages: [{ role: 'user', content: 'Wat is het weer in Amsterdam en in Utrecht? Roep de tool voor beide steden tegelijk aan.' }], tools: [WEATHER], maxTokens: opts.maxTokens || 400, reasoning: opts.reasoning });
    const cities = tc.toolCalls.map((c) => String(c.args?.city || '')).join(', ');
    check(`${label}: tool-aanroepen (${opts.parallel === false ? 'minstens één' : 'parallel'})`, opts.parallel === false ? tc.toolCalls.length >= 1 : tc.toolCalls.length >= 2, `${tc.toolCalls.length}× ${cities}`);
    await settle();
    saveFixture(`${opts.fixture}-tools`, take(), 'Parallel tool calls');
    if (tc.toolCalls.length) {
      const back = await run({
        messages: [
          { role: 'user', content: 'Wat is het weer in Amsterdam en in Utrecht? Roep de tool voor beide steden tegelijk aan.' },
          { role: 'assistant', content: tc.text, toolCalls: tc.toolCalls, raw: tc.raw },
          ...tc.toolCalls.map((c) => ({ role: 'tool', toolCallId: c.id, toolName: c.name, content: `Zonnig, 21 graden in ${c.args?.city || 'de stad'}.` })),
        ],
        tools: [WEATHER],
        maxTokens: opts.maxTokens || 400,
        reasoning: opts.reasoning,
      });
      check(`${label}: antwoord na tool-resultaten`, back.text.length > 0 && !back.toolCalls.length, JSON.stringify(back.text).slice(0, 80));
      await settle();
      saveFixture(`${opts.fixture}-toolresult`, take(), 'Answer after tool results');
    }
    if (opts.vision !== false) {
      const im = await run({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Welke kleur heeft dit plaatje? Eén woord.' }, { type: 'image', mime: 'image/png', data: redPng() }] }], maxTokens: opts.maxTokens || 400, reasoning: opts.reasoning });
      check(`${label}: afbeelding als invoer`, /rood|red/i.test(im.text), JSON.stringify(im.text).slice(0, 80));
      await settle();
      saveFixture(`${opts.fixture}-image`, take(), 'Image input');
    }
  } catch (e) {
    check(`${label}: chat`, false, e?.message || String(e));
    take();
  } finally {
    clearTimeout(timer);
  }
}

async function apiProviders() {
  const { builtinKinds } = await import('../../server/providers/kinds.ts');
  const { categoryOf } = await import('../../server/providers/common.ts');
  const { pickDefault } = await import('../../server/providers/catalog.ts');
  const kinds = new Map(builtinKinds().map((k) => [k.id, k]));
  console.log('\n== API-providers met een sleutel op deze pc ==');
  let found = 0;
  for (const kind of Object.keys(KEY_NAMES)) {
    const k = kinds.get(kind);
    const key = keyFor(kind);
    if (!k || !key) continue;
    found++;
    console.log(`\n${k.label} (sleutel uit ${key.from})`);
    const adapter = k.create(cfgFor(kind), key.key, {});
    const t = await adapter.test();
    // "Geen tegoed" from a free balance endpoint still proves the key works: that is a correct, verified outcome.
    const label = t.ok ? 'Test verbinding (gratis)' : t.category === 'quota' && t.verified ? 'Test verbinding (gratis): sleutel geldig, geen tegoed gemeld' : 'Test verbinding (gratis)';
    check(`${k.label}: ${label}`, t.ok || (t.category === 'quota' && !!t.verified && !!t.hint), `${t.detail}${t.credit && !t.detail.includes(t.credit) ? ` · ${t.credit}` : ''}${t.hint ? ` · Oplossing: ${t.hint}` : ''}`);
    let models = [];
    try {
      models = await adapter.listModels();
      check(`${k.label}: modellenlijst live`, models.length > 0, `${models.length} modellen; aanbevolen: ${pickDefault(models, k.recommend) || '-'}`);
    } catch (e) {
      check(`${k.label}: modellenlijst live`, false, e?.message);
    }
    await settle();
    saveFixture(`${kind}-models`, take(), 'Free checks: key/credit endpoint and model list');

    const bad = k.create(cfgFor(kind), 'sk-teambot-ongeldige-testsleutel-000000000000', {});
    const bt = await bad.test();
    check(`${k.label}: foute sleutel → "Sleutel ongeldig" met oplossing`, !bt.ok && bt.category === 'auth' && !!bt.hint, `${bt.category}: ${bt.detail}`);
    await settle();
    saveFixture(`${kind}-error-auth`, take(), 'Wrong key');

    if (kind === 'openai') {
      const cheap = pickDefault(models, [/^gpt-6(\.\d+)?-luna$/, /^gpt-5(\.\d+)?-nano$/, /^gpt-4\.1-nano$/, /^gpt-5(\.\d+)?-mini$/, /^gpt-4o-mini$/]);
      if (!cheap) {
        check('OpenAI: goedkoop model gevonden', false);
        continue;
      }
      info(`chat met ${cheap} (goedkoopste model; kosten < $0,01)`);
      try {
        await adapter.chat({ model: 'gpt-teambot-bestaat-niet', system: '', messages: [{ role: 'user', content: 'x' }], tools: [] }, new AbortController().signal, () => {});
        check('OpenAI: onbekend model → "Model bestaat niet"', false, 'geen fout');
      } catch (e) {
        check('OpenAI: onbekend model → "Model bestaat niet"', categoryOf(e) === 'model', e?.message);
      }
      await settle();
      saveFixture('openai-resp-error-model', take(), 'Unknown model via the Responses API (free: rejected before any tokens)');
      // Chat goes through the Responses API (tools together with reasoning); Chat Completions is tested separately.
      await chatCases('OpenAI (Responses API)', adapter, cheap, { fixture: 'openai-resp', reasoning: 'low', maxTokens: 600 });
      if (process.argv.includes('--chat-completions')) {
        const cc = k.create(cfgFor(kind, { config: { api: 'chat' } }), key.key, {});
        await chatCases('OpenAI (Chat Completions)', cc, cheap, { fixture: 'openai', reasoning: 'low', maxTokens: 600 });
      }
    }
  }
  if (!found) info('geen sleutels gevonden');
}

async function localServers() {
  const { builtinKinds } = await import('../../server/providers/kinds.ts');
  console.log('\n== Lokale modelservers ==');
  for (const k of builtinKinds().filter((x) => x.section === 'local')) {
    const d = await k.detect();
    if (!d.installed) {
      info(`${k.label}: ${d.detail}`);
      continue;
    }
    check(`${k.label}: gevonden`, true, d.detail + (d.version ? ` (versie ${d.version})` : ''));
    const adapter = k.create(cfgFor(k.id, { base_url: d.baseUrl || '' }), null, {});
    const t = await adapter.test();
    check(`${k.label}: Test verbinding`, t.ok, t.detail);
    let models = [];
    try {
      models = await adapter.listModels();
    } catch {
      /* reported by test */
    }
    take();
    const pref = process.env.LOCAL_MODEL || models.map((m) => m.id).find((id) => /snel|mini|small|7b|8b|3b|4b/i.test(id) && !/embed/i.test(id)) || models.find((m) => !/embed/i.test(m.id))?.id;
    if (!pref) continue;
    info(`chat met ${pref}`);
    await chatCases(k.label, adapter, pref, { fixture: k.id, timeoutMs: 600_000, maxTokens: 2000, parallel: false, vision: false });
  }
}

async function cliEngines() {
  const { startTestApp } = await import('../helpers.ts');
  console.log('\n== CLI-engines (eigen login) ==');
  const t = await startTestApp();
  try {
    for (const kind of ['claude-code', 'codex-cli']) {
      const p = await t.api('POST', '/providers', { kind });
      const r = await t.api('POST', `/providers/${p.id}/test`);
      check(`${kind}: gevonden en ingelogd`, r.ok, r.detail);
      if (!r.ok) continue;
      await botSays(t, p, kind, '');
    }
  } finally {
    await t.close();
  }
}

async function botSays(t, p, label, model) {
  const a = await t.api('POST', '/agents', { name: `Live ${label}`, provider_id: p.id, model, access_mode: 'readonly' });
  const th = await t.api('POST', '/threads', { agentId: a.id });
  const msgs = await t.say(th.id, 'Zeg alleen het woord: hallo', 300_000);
  const ans = msgs.filter((m) => m.role === 'assistant').at(-1);
  check(`${label}: bot antwoordt via TeamBot`, ans?.status === 'done' && /hallo/i.test(ans?.content || ''), ans ? `${ans.status}: ${String(ans.content || ans.parts?.error || '').slice(0, 120)}` : 'geen antwoord');
}

async function opencodeIsolated() {
  const { startTestApp } = await import('../helpers.ts');
  console.log('\n== OpenCode (gratis model, afgeschermde HOME/XDG) ==');
  const t = await startTestApp();
  try {
    const p = await t.api('POST', '/providers', { kind: 'opencode' });
    const r = await t.api('POST', `/providers/${p.id}/test`);
    check('opencode: gevonden', r.ok, r.detail);
    if (!r.ok) return;
    const models = await t.api('GET', `/providers/${p.id}/models`);
    const free = models.filter((m) => m.billing === 'free');
    check('opencode: gratis modellen in de lijst', free.length > 0, free.slice(0, 4).map((m) => m.id).join(', '));
    await botSays(t, p, 'opencode', free.find((m) => m.id === 'opencode/big-pickle')?.id || free[0]?.id || '');
  } finally {
    await t.close();
  }
}

if (ONLY_OPENCODE) {
  await opencodeIsolated();
} else {
  if (!ONLY_CLI) {
    await apiProviders();
    if (!NO_LOCAL) await localServers();
  }
  if (!NO_CLI) {
    await cliEngines();
    // OpenCode runs in a child process with its own temporary HOME/XDG, so the owner's OpenCode data stays untouched.
    const X = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-providers-live-oc-'));
    for (const d of ['data', 'config', 'state', 'cache', 'home']) fs.mkdirSync(path.join(X, d), { recursive: true });
    const env = { ...process.env, XDG_DATA_HOME: path.join(X, 'data'), XDG_CONFIG_HOME: path.join(X, 'config'), XDG_STATE_HOME: path.join(X, 'state'), XDG_CACHE_HOME: path.join(X, 'cache'), HOME: path.join(X, 'home'), USERPROFILE: path.join(X, 'home'), OPENCODE_DISABLE_AUTOUPDATE: '1' };
    const r = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--only-opencode'], { env, cwd: ROOT, encoding: 'utf8', timeout: 600_000 });
    process.stdout.write(r.stdout || '');
    if (r.stderr) process.stderr.write(r.stderr.split('\n').filter((l) => !/ExperimentalWarning|--trace-warnings/.test(l)).join('\n'));
    for (const line of (r.stdout || '').split('\n')) if (/^[✔✖] /.test(line)) results.push({ name: line.slice(2), ok: line.startsWith('✔') });
    fs.rmSync(X, { recursive: true, force: true });
  }
}

if (!ONLY_OPENCODE) {
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} geslaagd${bad.length ? `; mislukt: ${bad.map((b) => b.name).join(' | ')}` : ''}`);
  process.exit(bad.length ? 1 : 0);
}
