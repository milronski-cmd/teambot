#!/usr/bin/env node
// Memory benchmark (TeamBot 0.4 F2): `npm run memory:bench [-- --modes a,b,c] [--write]` (`--quick`: without the
// stale facts, the year and the customers; `--only tools`: only the 0.4.5 scenario "the bot discovers facts with a tool").
//
// One fixed set (scripts/memory-bench-data.mjs): ±200 facts the owner mentions in passing during long conversations
// (with small talk in between), paraphrased questions for them (Dutch, some English), corrections, facts that go stale
// and a simulated year of everyday memory growth. Measured per mode:
//   - recall@1 / recall@5 of the bot's own search (memory_search's ranking, svc.searchItemsAsync);
//   - the per-turn context block: does the fact reach the bot (recall), and how much of the "Relevant" part is about
//     the question (precision);
//   - corrections: the new value comes first and the old one is no longer active;
//   - stale facts: refreshed from their source, confirmed by the owner, or marked "te controleren" — never silently
//     stale;
//   - after a simulated year: every part within its target size, nothing important (pinned, owner-confirmed, often
//     used) lost, the archive bounded below the quota, a monthly report with undo;
//   - (0.4.5) learning from the whole conversation: what the bot found with a tool is learned and marked as such,
//     a newer reading replaces the older one directly, a tool never overwrites the owner (a card), and a planted
//     instruction, a key, a guess without work and passing state are never stored.
// Modes:
//   (a) words only: the word index with TeamBot's built-in synonyms (and, for comparison, plain words like 0.3);
//   (b) the built-in model (multilingual-e5-small on the CPU) + words;
//   (c) Ollama on this computer: the free local model learns (facts, synonyms, "can change") and does maintenance,
//       with the built-in model for meaning. Only `qwen3.6-uncensored-snel` is used (never pulled or another loaded),
//       one request at a time.
// (a) and (b) learn with a fixed, ideal learner (the facts as written, no synonyms), so they measure search and upkeep
// only; (c) is end to end with a real free model.
//
// Runs in a temporary data folder (TEAMBOT_DATA/APPDATA in the temp folder), port 4840 by default. The built-in model
// is taken from .data/models-cache (downloaded once, hash-checked) and needs onnxruntime-node + @huggingface/tokenizers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------- a clock we can move (simulated time)
const RealDate = Date;
let OFFSET = 0;
class BenchDate extends RealDate {
  constructor(...a) {
    if (!a.length) super(RealDate.now() + OFFSET);
    else super(...a);
  }
  static now() {
    return RealDate.now() + OFFSET;
  }
}
globalThis.Date = BenchDate;
const advance = (days) => (OFFSET += days * 864e5);

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const MODES = String(opt('modes', 'a,b,c')).split(',').map((s) => s.trim()).filter(Boolean);
const WRITE = args.includes('--write');
const ONLY = opt('only', null);
const OLLAMA = opt('ollama', 'http://127.0.0.1:11434');
const OLLAMA_MODEL = 'qwen3.6-uncensored-snel:latest';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-membench-'));
const DEBUG_DIR = path.join(ROOT, '.data', 'bench-debug');
if (process.argv.includes('--debug')) (fs.mkdirSync(DEBUG_DIR, { recursive: true }), (process.env.TEAMBOT_MEMORY_DEBUG = '1'));
process.env.APPDATA = path.join(TMP, 'appdata');
process.env.LOCALAPPDATA = path.join(TMP, 'localappdata');
fs.mkdirSync(process.env.APPDATA, { recursive: true });
fs.mkdirSync(process.env.LOCALAPPDATA, { recursive: true });
process.env.TEAMBOT_TEST_PORT ||= '4840';

const { startTestApp, mockAdapter } = await import('../tests/helpers.ts');
const { setShortCallFake } = await import('../server/agent/short-call.ts');
const { BUILTIN, BUILTIN_FILES, BuiltinModel, runtimeProblem } = await import('../server/modules/memory/builtin-embed.ts');
const { normalize, tokens } = await import('../server/modules/memory/text.ts');
const { groundedShare } = await import('../server/modules/memory/learn.ts');
const { writeCandidate } = await import('../server/modules/memory/pipeline.ts');
const { FACTS, FILLER, CORRECTIONS, STALE, YEAR_SUBJECTS, YEAR_TEMPLATES, OFFTOPIC, UPDATES, TASKS, DOSSIER_CHANGE, CUSTOMERS, TOOL_LEARN } = await import('./memory-bench-data.mjs');

const log = (...a) => console.log('[bench]', ...a);
const pct = (x) => (Number.isFinite(x) ? `${(100 * x).toFixed(1).replace('.', ',')} %` : '–');

/** Facts with their questions. */
const facts = FACTS.map((f, i) => {
  const [content, ...rest] = f;
  const qs = rest.filter((x) => typeof x === 'string');
  const o = rest.find((x) => x && typeof x === 'object') || {};
  return { i, content, qs, key: o.key || null, about: o.about || 'owner' };
});
const QUESTIONS = facts.flatMap((f) => f.qs.map((q) => ({ q, fact: f.i })));

// ---------------------------------------------------------------------------- the built-in model (cache)
async function modelCache() {
  const dir = path.join(ROOT, '.data', 'models-cache');
  const m = new BuiltinModel(dir);
  if (!m.present()) {
    log(`ingebouwd model downloaden naar ${m.dir} (eenmalig, ±${Math.round(m.files.reduce((n, f) => n + f.size, 0) / 1e6)} MB, met hashcontrole) …`);
    if (!(await m.download())) throw new Error('download van het ingebouwde model mislukt');
  }
  return m.dir;
}
function installModel(t, cacheDir) {
  const svc = t.app.ctx.services.memory.svc;
  const dest = svc.semantic.builtin.dir;
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(cacheDir)) fs.copyFileSync(path.join(cacheDir, f), path.join(dest, f));
  svc.semantic.builtin.recheck();
  svc.semantic.forgetInfo();
}

// ---------------------------------------------------------------------------- the ideal learner for (a) and (b)
const KNOWN = [
  ...facts.map((f) => ({ content: f.content, key: f.key, about: f.about })),
  ...STALE.restated.map((r) => ({ content: r.content, key: null, about: 'owner' })),
  ...STALE.unconfirmed.map((c) => ({ content: c, key: null, about: 'owner' })),
  // 0.4.4 updates and tasks: the ideal learner stores what was said; deciding what it ends is consolidation's job.
  ...[...UPDATES.ends, ...UPDATES.keeps].map((u) => ({ content: u.said, key: null, about: 'owner' })),
  { content: UPDATES.cascade.said, key: null, about: 'owner' },
  ...TASKS.todos.map((c) => ({ content: c, key: null, about: 'owner', type: 'task' })),
  { content: TASKS.ownerDone, key: null, about: 'owner' },
  { content: TOOL_LEARN.ownerBefore, key: null, about: 'owner' },
];
/** Learning calls the learner answered (0.4.5: one call per batch). */
let LEARN_CALLS = 0;
function idealLearner(system, prompt) {
  // Consolidation (0.4.4) is not part of the ideal learner: (a) and (b) measure the patterns; (c) the real model.
  if (/langetermijngeheugen van TeamBot/.test(system)) return JSON.stringify({ facts: [] });
  if (/geheugenmodule van TeamBot/.test(system)) {
    LEARN_CALLS++;
    const known = [...prompt.matchAll(/^- (m:[a-z0-9]+)(?: \[[^\]]*\])*(?: \[herzien\])? (.*)$/gm)].map((m) => ({ ref: m[1], text: m[2] }));
    const items = [];
    const confirms = [];
    for (const m of prompt.matchAll(/<eigenaar id="(\d+)">([\s\S]*?)<\/eigenaar>/g)) {
      const msg = m[2];
      const low = msg.toLowerCase();
      for (const k of KNOWN) if (low.includes(k.content.toLowerCase())) items.push({ content: k.content, type: k.type || 'fact', key: k.key, about: k.about, replaces: null, evidence: k.content, msg: m[1], terms: [], changes: null });
      for (const c of CORRECTIONS)
        if (low.includes(c.said.toLowerCase())) {
          const old = known.find((x) => normalize(x.text).includes(normalize(c.old)) || normalize(c.old).includes(normalize(x.text)));
          items.push({ content: c.content, type: 'fact', key: c.key || null, about: 'owner', replaces: old?.ref || null, evidence: c.said, msg: m[1], terms: [], changes: null });
        }
    }
    // 0.4.5: what a model finds in the bot's replies and the tool output — also what must never be stored, so the
    // code's safety rails are measured (before 0.4.5 a bot or tool text is never a source: these are all dropped).
    const blocks = [...prompt.matchAll(/<(bot|tool)\b([^>]*)>([\s\S]*?)<\/\1>/g)].map((m) => ({ kind: m[1], id: (m[2].match(/id="([a-z]?\d+)"/) || [])[1] || '', text: m[3] }));
    for (const f of [...TOOL_LEARN.found, TOOL_LEARN.newer]) {
      const b = blocks.find((x) => x.kind === f.source && normalize(x.text).includes(normalize(f.evidence)));
      if (!b) continue;
      const old = f.replaces ? known.find((k) => normalize(k.text).includes(normalize(f.replaces))) : null;
      items.push({ content: f.content, type: 'fact', key: null, about: 'bot', source: f.source, replaces: old?.ref || null, evidence: f.evidence, msg: b.id, terms: [], changes: null });
    }
    return JSON.stringify({ items, confirms, episode: { summary: '', decisions: [], actions: [], open_questions: [], subject: null } });
  }
  if (/onderhoudsmodule/.test(system)) return JSON.stringify({ duplicates: [], contradictions: [], outdated: [] });
  return JSON.stringify({ summary: '' });
}

// ---------------------------------------------------------------------------- helpers
async function talk(t, agent, messages) {
  const th = await t.api('POST', '/threads', { agentId: agent.id });
  for (const m of messages) {
    t.script.push({ text: 'Oké, genoteerd.' });
    await t.say(th.id, m, 60_000);
  }
  return th;
}

/** Long conversations: about 6 facts each, mixed with small talk, as one person writes. */
function conversations(list) {
  const out = [];
  let cur = [];
  list.forEach((f, n) => {
    const lead = ['Trouwens, ', 'Even iets anders: ', 'Goed om te weten: ', '', 'Oh ja, ', 'Voor de volledigheid: '][n % 6];
    cur.push(`${lead}${f.content}.`);
    if (n % 2 === 1) cur.push(FILLER[n % FILLER.length]);
    if (cur.length >= 10) (out.push(cur), (cur = []));
  });
  if (cur.length) out.push(cur);
  return out;
}

const parseSection = (text, name) => {
  const s = String(text || '');
  const i = s.indexOf(`${name}:\n`);
  if (i < 0) return [];
  const rest = s.slice(i + name.length + 2).split('\n');
  const refs = [];
  for (const line of rest) {
    if (!line.startsWith('- ') && !line.startsWith('  ')) break;
    const m = line.match(/^- \[m:([a-z0-9]+)\]/);
    if (m) refs.push(m[1]);
  }
  return refs;
};

/** Which stored memories are "this fact" (exact for the ideal learner; by overlap for a real model). */
function mapFacts(svc, userId) {
  const rows = svc.store.all("SELECT id, ref, content, status, merge_of FROM memory_items WHERE user_id = ? AND status = 'active'", userId);
  const map = new Map();
  for (const f of facts) {
    const hit = rows.filter((r) => normalize(r.content) === normalize(f.content) || (groundedShare(f.content, r.content) >= 0.7 && groundedShare(r.content, f.content) >= 0.6));
    map.set(f.i, new Set(hit.map((r) => r.id)));
  }
  return map;
}

async function measureRetrieval(t, agent, userId, label) {
  const svc = t.app.ctx.services.memory.svc;
  const mem = t.app.ctx.services.memory;
  const map = mapFacts(svc, userId);
  const reader = svc.readerFor(t.app.ctx.store.agent(agent.id), null);
  const refOf = new Map(svc.store.all('SELECT id, ref FROM memory_items WHERE user_id = ?', userId).map((r) => [r.ref, r.id]));
  let r1 = 0, r5 = 0, ctxHit = 0, n = 0, precSum = 0, precN = 0, inBlock = 0, emptyBlock = 0, extracted = 0, nStored = 0, r5Stored = 0;
  const qms = [];
  const misses = [];
  for (const f of facts) if (map.get(f.i)?.size) extracted++;
  for (const { q, fact } of QUESTIONS) {
    n++;
    const want = map.get(fact) || new Set();
    const t0 = performance.now();
    const hits = await svc.searchItemsAsync(reader, q, { limit: 10 });
    qms.push(performance.now() - t0);
    const rank = hits.findIndex((h) => want.has(h.row.id));
    if (rank === 0) r1++;
    if (rank >= 0 && rank < 5) r5++;
    if (want.size) (nStored++, rank >= 0 && rank < 5 && r5Stored++);
    if (rank !== 0) misses.push({ q, want: facts[fact].content, stored: !!want.size, rank, top: hits.slice(0, 3).map((h) => `${h.score.toFixed(2)}${h.meaning ? '*' : ''} ${h.row.content}`) });
    const th = await t.api('POST', '/threads', { agentId: agent.id });
    const block = (await mem.context(userId, agent.id, th.id, q)) || '';
    const rel = parseSection(block, 'Relevant').map((r) => refOf.get(r));
    const pinned = parseSection(block, 'Vastgezet').map((r) => refOf.get(r));
    if ([...rel, ...pinned].some((id) => want.has(id))) ctxHit++;
    inBlock += rel.length;
    if (rel.length) {
      precSum += rel.filter((id) => want.has(id)).length / rel.length;
      precN++;
    } else emptyBlock++;
    await t.api('DELETE', `/threads/${th.id}`).catch(() => {});
  }
  qms.sort((a, b) => a - b);
  // Turns that are not about memory: every "Relevant" line (and any other loose memory line) is noise.
  let offRel = 0, offAll = 0;
  for (const q of OFFTOPIC) {
    const th = await t.api('POST', '/threads', { agentId: agent.id });
    const block = (await mem.context(userId, agent.id, th.id, q)) || '';
    offRel += parseSection(block, 'Relevant').length;
    offAll += parseSection(block, 'Relevant').length + parseSection(block, 'Laatste notities (niet gevonden bij deze vraag)').length;
    await t.api('DELETE', `/threads/${th.id}`).catch(() => {});
  }
  if (args.includes('--debug')) fs.writeFileSync(path.join(DEBUG_DIR, `misses-${label.split(' ')[0]}.json`), JSON.stringify(misses, null, 1));
  const res = { label, questions: n, facts: facts.length, extracted, recall1: r1 / n, recall5: r5 / n, recall5Stored: nStored ? r5Stored / nStored : NaN, contextRecall: ctxHit / n, contextPrecision: precN ? precSum / precN : NaN, avgInBlock: inBlock / n, emptyBlocks: emptyBlock, offTopicLines: offRel / OFFTOPIC.length, offTopicAllLines: offAll / OFFTOPIC.length, queryMsMedian: qms[Math.floor(qms.length / 2)], queryMsP95: qms[Math.floor(qms.length * 0.95)] };
  log(label, `R@1 ${pct(res.recall1)} R@5 ${pct(res.recall5)} context ${pct(res.contextRecall)} precision ${pct(res.contextPrecision)} (${res.avgInBlock.toFixed(1)} per block), off-topic ${res.offTopicLines.toFixed(1)} lines (${res.offTopicAllLines.toFixed(1)} with latest notes)`);
  return res;
}

// ---------------------------------------------------------------------------- one mode
async function runMode(mode, cacheDir) {
  const t = await startTestApp();
  // The bench's own client and the server share one busy process: a long stretch of synchronous work (thousands of
  // writes) let the server drop an idle keep-alive socket that fetch then reused ("fetch failed", ECONNRESET). Keep idle
  // sockets open for the whole run.
  t.app.server.keepAliveTimeout = 30 * 60_000;
  t.app.server.headersTimeout = 30 * 60_000 + 1000;
  const ctx = t.app.ctx;
  const svc = ctx.services.memory.svc;
  const mem = ctx.services.memory;
  const userId = ctx.auth.owner().id;
  const started = performance.now();
  const out = { mode, notes: [] };
  try {
    // The learning engine: an ideal fixed learner (a, b) or the local model (c).
    let providerId;
    if (mode === 'c') {
      const p = ctx.providers.create(userId, { kind: 'ollama', base_url: `${OLLAMA}/v1` });
      providerId = p.id;
      setShortCallFake(null);
    } else {
      ctx.providers.registerKind({ id: 'mock-local', label: 'Vaste leerder', type: 'api', group: 'local', billing: 'local', needsKey: false, description: 'bench', models: ['ideaal'], defaultModel: 'ideaal', create: () => mockAdapter(t.script, t.requests) });
      providerId = (await t.api('POST', '/providers', { kind: 'mock-local' })).id;
      setShortCallFake(idealLearner);
    }
    await t.api('PUT', '/memory/settings', { extractor: 'free', engine: { providerId, model: mode === 'c' ? OLLAMA_MODEL : 'ideaal' }, semantic: mode === 'a' ? 'off' : 'auto', semanticModel: mode === 'a' ? null : BUILTIN.id, modelDailyCap: 5000, nightly: false });
    if (mode !== 'a') installModel(t, cacheDir);
    const sem = await t.api('GET', '/memory/semantic?fresh=1');
    out.semantic = { state: sem.state, model: sem.model, engine: sem.engine };
    if (mode !== 'a' && sem.state !== 'on') throw new Error(`zoeken op betekenis staat niet aan: ${sem.state} (${sem.builtin?.state})`);
    const bot = await t.agent({ name: 'Bench', tool_groups: ['memory'] });
    const agent = ctx.store.agent(bot.id);
    // --scale-only: only the customer service at scale (to measure loading many dossiers on its own).
    if (args.includes('--scale-only')) {
      try {
        out.customers = await customerScale(t, userId);
      } catch (e) {
        out.customers = { error: `${String(e?.message || e)}${e?.cause ? ` (${e.cause.code || ''} ${e.cause.message || e.cause})` : ''}`.slice(0, 300) };
        log(mode, 'klantenservice FOUT', out.customers.error);
        if (process.env.TEAMBOT_BENCH_TRACE) console.error(e?.stack || e, e?.cause);
      }
      return out;
    }
    // `--only tools` (0.4.5): just the scenario "the bot discovers facts with a tool" (e.g. a quick check of (c)).
    if (ONLY === 'tools') {
      out.toolLearn = await toolScenario(t, userId);
      return out;
    }

    // 1. Learn ±200 facts from long conversations.
    const t1 = performance.now();
    for (const conv of conversations(facts)) {
      const th = await talk(t, bot, conv);
      await mem.learner.learnNow(agent, ctx.store.thread(th.id));
    }
    await mem.drain();
    out.learnSeconds = (performance.now() - t1) / 1000;
    out.stored = svc.store.one("SELECT COUNT(*) AS n FROM memory_items WHERE user_id = ? AND status = 'active'", userId).n;
    // What the learner did per batch (model or patterns, how much it applied, proposed or refused).
    const batches = svc.store.all("SELECT last_result FROM memory_learn WHERE user_id = ? AND last_result IS NOT NULL", userId).map((r) => JSON.parse(r.last_result));
    const sum = (k) => batches.reduce((n, r) => n + (r[k] || 0), 0);
    const why = batches.flatMap((r) => r.droppedDetail || []);
    out.learner = { batches: batches.length, model: batches.filter((r) => r.method === 'model').length, applied: sum('applied'), proposed: sum('proposed'), dropped: sum('dropped'), errors: batches.filter((r) => r.error).length, consolidated: { invalidated: sum('invalidated'), closed: sum('closed'), merged: sum('merged') }, droppedWhy: Object.fromEntries([...new Set(why.map((x) => x.why))].map((w) => [w, why.filter((x) => x.why === w).length])), droppedDetail: why.slice(0, 60) };
    out.vectors = svc.store.one('SELECT COUNT(*) AS n FROM memory_vectors WHERE user_id = ?', userId).n;
    log(mode, `geleerd: ${out.stored} herinneringen in ${out.learnSeconds.toFixed(0)} s, ${out.vectors} vectoren`);

    // 2. Retrieval (and, in (a), the 0.3 baseline: words without synonyms).
    if (mode === 'a') {
      const orig = svc.ftsText.bind(svc);
      svc.ftsText = (kind, row) => (kind === 'item' ? (row.sensitivity === 'sensitive' ? [row.canonical_key || '', row.type].join(' ') : [row.content, row.canonical_key || '', row.type].join(' ')) : orig(kind, row));
      svc.reindex(userId);
      out.plain = await measureRetrieval(t, bot, userId, 'a0 woorden zonder synoniemen');
      svc.ftsText = orig;
      svc.reindex(userId);
    }
    out.retrieval = await measureRetrieval(t, bot, userId, `${mode}`);

    // 3. Corrections in a later conversation.
    const th = await talk(t, bot, CORRECTIONS.map((c) => `${c.said}.`));
    await mem.learner.learnNow(agent, ctx.store.thread(th.id));
    await mem.drain();
    const reader = svc.readerFor(agent, null);
    let corrOk = 0, oldGone = 0, corr5 = 0;
    const corrDetail = [];
    for (const c of CORRECTIONS) {
      const hits = await svc.searchItemsAsync(reader, c.q, { limit: 5 });
      const top = !!hits[0] && c.expect.test(hits[0].row.content);
      if (top) corrOk++;
      if (hits.slice(0, 5).some((h) => c.expect.test(h.row.content))) corr5++;
      const old = svc.store.one("SELECT COUNT(*) AS n FROM memory_items WHERE user_id = ? AND status = 'active' AND content = ?", userId, c.old).n;
      if (!old) oldGone++;
      const neu = svc.store.all("SELECT status, content, proposal_reason FROM memory_items WHERE user_id = ? AND status IN ('active','proposed')", userId).find((r) => c.expect.test(r.content));
      corrDetail.push({ said: c.said, top, oldActive: !!old, new: neu ? `${neu.status}${neu.proposal_reason ? ' (' + neu.proposal_reason + ')' : ''}` : 'niet opgeslagen', first: hits[0]?.row.content || null });
    }
    out.corrections = { total: CORRECTIONS.length, newFirst: corrOk, newTop5: corr5, oldInactive: oldGone, detail: corrDetail };
    log(mode, `correcties: nieuw bovenaan ${corrOk}/${CORRECTIONS.length}, in top 5 ${corr5}/${CORRECTIONS.length}, oud niet meer actief ${oldGone}/${CORRECTIONS.length}`);

    // 3b (0.4.4). Updates without a shared key, and open tasks that close themselves.
    out.updates = await updateScenarios(t, bot, agent, userId);
    out.tasks = await taskScenario(t, userId);
    out.dossier = await dossierChangeScenario(t, userId);
    // 3c (0.4.5). Learning from the whole conversation: the bot discovers facts with a tool.
    out.toolLearn = await toolScenario(t, userId);

    if (args.includes('--quick')) return out;
    // 4. Facts that go stale.
    out.stale = await staleScenarios(t, bot, agent, userId, mode);

    // 5. A simulated year.
    out.year = await simulateYear(t, userId, mode);
    // 6 (0.4.4). Customer service at scale (search and upkeep only: not with the local model, it is not used here).
    if (mode !== 'c' && !args.includes('--no-scale')) {
      try {
        out.customers = await customerScale(t, userId);
      } catch (e) {
        // "fetch failed" alone says nothing: the cause (connection refused, reset, time-out) with it.
        out.customers = { error: `${String(e?.message || e)}${e?.cause ? ` (${e.cause.code || ''} ${e.cause.message || e.cause})` : ''}`.slice(0, 300) };
        if (process.env.TEAMBOT_BENCH_TRACE) console.error(e?.stack || e, e?.cause);
        log(mode, 'klantenservice FOUT', out.customers.error);
      }
    }
  } catch (e) {
    out.error = String(e?.stack || e).slice(0, 2000);
    log(mode, 'FOUT', out.error);
  } finally {
    setShortCallFake(null);
    out.seconds = (performance.now() - started) / 1000;
    await t.close();
  }
  return out;
}

/** The active note that is this text (exact for the ideal learner; by overlap for a real model). */
function findActive(svc, userId, text) {
  const rows = svc.store.all("SELECT id, content FROM memory_items WHERE user_id = ? AND status = 'active'", userId);
  return rows.find((r) => normalize(r.content) === normalize(text)) || rows.find((r) => groundedShare(text, r.content) >= 0.7 && groundedShare(r.content, text) >= 0.6) || null;
}

async function talkIn(t, threadId, messages) {
  for (const m of messages) {
    t.script.push({ text: 'Oké, genoteerd.' });
    await t.say(threadId, m, 60_000);
  }
}

/**
 * 0.4.4: the owner says things that end older notes without a shared key (a task done, a wish fulfilled, something
 * stopped), one ending that also ends what depended on it, and related news that must end nothing.
 */
async function updateScenarios(t, bot, agent, userId) {
  const ctx = t.app.ctx;
  const svc = ctx.services.memory.svc;
  const mem = ctx.services.memory;
  const before = (list) => list.map((x) => findActive(svc, userId, x)?.id || null);
  const endsIds = before(UPDATES.ends.map((u) => u.old));
  const cascadeIds = before(UPDATES.cascade.ends);
  const keepIds = before(UPDATES.keeps.map((u) => u.old));
  const msgs = [];
  [...UPDATES.ends, ...UPDATES.keeps].forEach((u, i) => {
    msgs.push(`${u.said}.`);
    if (i % 3 === 2) msgs.push(FILLER[i % FILLER.length]);
  });
  msgs.push(`${UPDATES.cascade.said}.`);
  const th = await talk(t, bot, msgs);
  await mem.learner.learnNow(agent, ctx.store.thread(th.id));
  await mem.drain();
  const gone = (id) => !!id && svc.itemRow(id)?.status !== 'active';
  const detail = [
    ...UPDATES.ends.map((u, i) => ({ kind: 'ends', heldOut: !!u.heldOut, old: u.old, said: u.said, present: !!endsIds[i], ok: gone(endsIds[i]), reason: endsIds[i] ? svc.itemRow(endsIds[i])?.invalid_reason || null : svc.store.one("SELECT i.status, c.summary FROM memory_items i LEFT JOIN memory_changes c ON c.record_id = i.id WHERE i.user_id = ? AND i.content = ? ORDER BY c.created_at DESC LIMIT 1", userId, u.old) || 'nooit opgeslagen' })),
    ...UPDATES.cascade.ends.map((o, i) => ({ kind: 'cascade', old: o, said: UPDATES.cascade.said, present: !!cascadeIds[i], ok: gone(cascadeIds[i]) })),
    ...UPDATES.keeps.map((u, i) => ({ kind: 'keeps', heldOut: !!u.heldOut, old: u.old, said: u.said, present: !!keepIds[i], ok: !!keepIds[i] && !gone(keepIds[i]) })),
  ];
  const count = (kind, held) => {
    const d = detail.filter((x) => x.kind === kind && x.present && (held === undefined || !!x.heldOut === held));
    return { ok: d.filter((x) => x.ok).length, of: d.length };
  };
  const res = { ends: count('ends', false), endsHeldOut: count('ends', true), cascade: count('cascade'), keeps: count('keeps', false), keepsHeldOut: count('keeps', true), wrong: detail.filter((x) => x.kind === 'keeps' && x.present && !x.ok).length, detail };
  log('bijwerken', `impliciet beëindigd ${res.ends.ok}/${res.ends.of} (achtergehouden ${res.endsHeldOut.ok}/${res.endsHeldOut.of}), ketting ${res.cascade.ok}/${res.cascade.of}, terecht gebleven ${res.keeps.ok}/${res.keeps.of} (achtergehouden ${res.keepsHeldOut.ok}/${res.keepsHeldOut.of})`);
  return res;
}

/** 0.4.4, the SEO case: open tasks and dossier actions close when the work is done — and only those. */
async function taskScenario(t, userId) {
  const ctx = t.app.ctx;
  const svc = ctx.services.memory.svc;
  const mem = ctx.services.memory;
  const bot = await t.agent({ name: 'Webbot', tool_groups: ['memory', 'core'] });
  const agent = ctx.store.agent(bot.id);
  const d = (await t.api('POST', '/memory/dossiers', { title: TASKS.dossier })).dossier;
  const acts = {};
  for (const [k, title] of Object.entries(TASKS.actions)) acts[k] = (await t.api('POST', `/memory/dossiers/${d.id}/records`, { kind: 'action', title })).record;
  const linked = async () => {
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    await t.api('PUT', `/memory/thread/${th.id}/link`, { dossierId: d.id });
    return th;
  };
  // 1. The owner's own todos, learned like any fact.
  const th1 = await linked();
  await talkIn(t, th1.id, TASKS.todos.map((x) => `${x}.`));
  await mem.learner.learnNow(agent, ctx.store.thread(th1.id));
  await mem.drain();
  const todoIds = TASKS.todos.map((c) => findActive(svc, userId, c)?.id || null);
  // 2. The owner says the SEO is done.
  const th2 = await linked();
  await talkIn(t, th2.id, [`${TASKS.ownerDone}.`]);
  await mem.learner.learnNow(agent, ctx.store.thread(th2.id));
  await mem.drain();
  // 3. "Gedaan!" right after the bot names the offerte.
  const th3 = await linked();
  t.script.push({ text: TASKS.reminder });
  await t.say(th3.id, 'Wat staat er nog open?');
  t.script.push({ text: 'Prima.' });
  await t.say(th3.id, 'Gedaan!');
  // 4. A bot that did the work (it used a tool) and says so.
  t.script.push({ toolCalls: [{ name: 'notify_user', args: { message: 'De foto’s staan online' } }] }, { text: TASKS.botDone });
  await t.say(th3.id, 'Zet de foto’s van de Gazelle online.');
  // 5. A routine that finished.
  const msg = ctx.store.createMessage({ thread_id: th3.id, role: 'user', author_type: 'system', author_id: null, author_name: 'Routine', content: 'Routine: sitemap controleren' });
  t.script.push({ text: TASKS.routineDone });
  const run = ctx.chat.startAgent(ctx.store.thread(th3.id), bot.id, msg.id, 'schedule');
  if (run) await ctx.runs.waitFor(run.id, 30_000);
  const st = (k) => ctx.store.get('memory_records', acts[k].id)?.status;
  const ways = { eigenaar: st('seo') === 'done', gedaan: st('offerte') === 'done', bot: st('fotos') === 'done', routine: st('sitemap') === 'done' };
  // The block of a new conversation about the website: what is done is gone, what is open is there.
  const th4 = await linked();
  const block = String((await mem.context(userId, bot.id, th4.id, TASKS.question)) || '');
  const res = {
    closed: Object.values(ways).filter(Boolean).length,
    of: 4,
    ways,
    controlOpen: st('banner') === 'open',
    todosEnded: todoIds.filter((id) => id && svc.itemRow(id)?.status !== 'active').length,
    todosPresent: todoIds.filter(Boolean).length,
    blockClean: !/SEO van de website bijwerken|SEO van de website nog bijwerken/.test(block) && /Banner voor de kerstactie/.test(block),
    block,
  };
  log('taken', `afgerond ${res.closed}/4 (${Object.entries(ways).map(([k, v]) => `${k} ${v ? 'ja' : 'nee'}`).join(', ')}), open gebleven: ${res.controlOpen ? 'ja' : 'nee'}, eigen taken afgesloten ${res.todosEnded}/${res.todosPresent}, blok schoon: ${res.blockClean ? 'ja' : 'nee'}`);
  return res;
}

/**
 * 0.4.5: a conversation where the bot discovers facts with a tool (TOOL_LEARN). Learned, and marked as found by a
 * tool: what it found about the owner's world. Never: passing state, a page that instructs an AI, a key, a guess of the
 * bot without work. A newer reading replaces the older one directly; a tool that contradicts the owner is a card.
 */
async function toolScenario(t, userId) {
  const ctx = t.app.ctx;
  const svc = ctx.services.memory.svc;
  const mem = ctx.services.memory;
  const T = TOOL_LEARN;
  let output = '';
  for (const name of new Set([...T.turns, T.later].map((x) => x.tool).filter(Boolean)))
    ctx.tools.register({ name, group: 'core', risk: 'read', description: `bench: ${name}`, parameters: { type: 'object', properties: {} }, async run() { return output; } });
  const bot = await t.agent({ name: 'Werkplaatsbot', tool_groups: ['memory', 'core'] });
  const agent = ctx.store.agent(bot.id);
  const turn = async (threadId, x) => {
    if (x.tool) (output = x.output), t.script.push({ toolCalls: [{ name: x.tool, args: {} }] }, { text: x.reply });
    else t.script.push({ text: x.reply });
    await t.say(threadId, x.ask, 60_000);
  };
  const learnResults = [];
  const learn = async (threadId) => {
    learnResults.push(await mem.learner.learnNow(agent, ctx.store.thread(threadId)));
    await mem.drain();
  };
  // 1. Earlier, the owner said where the booking system is hosted (his own words).
  const th0 = await talk(t, bot, [`${T.ownerBefore}.`]);
  await learn(th0.id);
  const owner = findActive(svc, userId, T.ownerBefore);
  const since = new Date().toISOString();
  // 2. The bot looks things up, in one conversation (one learning batch).
  const th = await t.api('POST', '/threads', { agentId: bot.id });
  for (const x of T.turns) await turn(th.id, x);
  const c0 = LEARN_CALLS;
  const t0 = performance.now();
  await learn(th.id);
  const ms = performance.now() - t0;
  // Learning calls for the conversation (the learner counts them; the ideal learner too, for a run before 0.4.5).
  const calls = learnResults.at(-1)?.calls ?? LEARN_CALLS - c0;
  const checkCalls = learnResults.at(-1)?.checkCalls || 0;
  // 3. Later, in another conversation: a newer reading.
  const th2 = await t.api('POST', '/threads', { agentId: bot.id });
  await turn(th2.id, T.later);
  await learn(th2.id);
  const rows = svc.store.all('SELECT id, content, status, source_kind, source_trust, proposal_reason, conflict_with, superseded_by FROM memory_items WHERE user_id = ? AND created_at >= ?', userId, since);
  // The stored note that is this text: the same words first (PHP 8.1 and PHP 8.3 share all but one), else by overlap.
  const find = (text, ok = () => true) => rows.find((r) => ok(r) && normalize(r.content) === normalize(text)) || rows.find((r) => ok(r) && groundedShare(text, r.content) >= 0.7 && groundedShare(r.content, text) >= 0.6);
  const from = (r) => (r.source_kind === 'tool' && r.source_trust === 'agent' ? 'tool' : r.source_trust === 'agent' ? 'bot' : 'eigenaar');
  const detail = T.found.map((f) => {
    const r = find(f.content);
    return { content: f.content, expect: f.expect, status: r ? r.status : 'niet opgeslagen', from: r ? from(r) : null, reason: r?.proposal_reason || null };
  });
  const learned = detail.filter((d) => d.expect === 'stored' || d.expect === 'replaced');
  const oldRow = find(T.found.find((f) => f.expect === 'replaced').content);
  const newRow = find(T.newer.content, (r) => r.status === 'active' && r.id !== oldRow?.id);
  const card = find(T.found.find((f) => f.expect === 'card').content);
  const live = rows.filter((r) => ['active', 'proposed'].includes(r.status));
  const res = {
    learned: learned.filter((d) => d.from === 'tool' && (d.expect === 'stored' ? d.status === 'active' : ['active', 'superseded'].includes(d.status))).length,
    of: learned.length,
    marked: learned.filter((d) => d.from === 'tool').length,
    replaced: !!(newRow && oldRow && oldRow.status === 'superseded' && oldRow.superseded_by === newRow.id),
    ownerKept: !!owner && svc.itemRow(owner.id)?.status === 'active',
    card: !!(card && card.status === 'proposed' && owner && card.conflict_with === owner.id),
    // Without a card (a real model may not name what it contradicts) the check against what is known can still ask
    // the owner: his note "te controleren" (Klopt dit nog?), never ended.
    ownerCheck: !!owner && (svc.itemRow(owner.id)?.flags || []).includes('check'),
    never: detail.filter((d) => d.expect === 'never' && !['active', 'proposed'].includes(d.status)).length + (live.some((r) => T.passing.test(r.content)) ? 0 : 1),
    neverOf: detail.filter((d) => d.expect === 'never').length + 1,
    leaked: live.filter((r) => T.never.test(r.content) || T.passing.test(r.content)).map((r) => r.content),
    cards: rows.filter((r) => r.status === 'proposed').length,
    calls,
    checkCalls,
    errors: learnResults.filter((r) => r?.error).map((r) => r.error),
    ms,
    detail,
    ...(args.includes('--debug') ? { learnResults, rows } : {}),
  };
  log('gereedschap', `ontdekt met een tool en geleerd ${res.learned}/${res.of} (als tool gemarkeerd ${res.marked}), nieuwere meting vervangt direct: ${res.replaced ? 'ja' : 'nee'}, tool tegen eigenaar → ${res.card ? 'kaart' : res.ownerCheck ? 'te controleren' : 'geen vraag'} (eigenaar blijft: ${res.ownerKept ? 'ja' : 'nee'}), nooit opgeslagen ${res.never}/${res.neverOf}, kaarten ${res.cards}, leeraanroepen ${calls} (+${checkCalls} controle)${res.errors.length ? `, fouten: ${res.errors.join('; ')}` : ''}`);
  return res;
}

/** 0.4.4: a dossier whose document gets a new version is read again; NU no longer says what changed. */
async function dossierChangeScenario(t, userId) {
  const ctx = t.app.ctx;
  const svc = ctx.services.memory.svc;
  const mem = ctx.services.memory;
  const D = DOSSIER_CHANGE;
  const d = (await t.api('POST', '/memory/dossiers', { title: D.title, kind: 'client' })).dossier;
  const src = await t.api('POST', `/memory/dossiers/${d.id}/sources`, { kind: 'note', title: D.source, text: D.v1 });
  const ids = D.facts.map((f, i) => mem.remember(userId, { content: f.text, scope: 'dossier', dossierId: d.id, source: { kind: 'file', ref: src.id, excerpt: f.text, trust: 'system' }, createdBy: 'user', idemKey: `bench-dv-${i}` }).item?.id);
  await t.api('PATCH', `/memory/dossiers/${d.id}`, { summary: D.summary });
  await mem.drain();
  const t0 = performance.now();
  // A person uploads the new version of the agreements.
  await t.api('POST', `/memory/dossiers/${d.id}/sources`, { kind: 'note', title: D.source, text: D.v2 });
  await mem.drain();
  const ms = performance.now() - t0;
  const outcome = (id, f) => {
    let r = svc.itemRow(id);
    for (let i = 0; r && r.status === 'superseded' && r.superseded_by && i < 5; i++) r = svc.itemRow(r.superseded_by);
    if (!r) return 'missing';
    if (r.status === 'superseded') return 'ended';
    if ((r.flags || []).includes('check')) return 'te controleren';
    if (r.id !== id) return f.expect && !f.expect.test(r.content) ? 'wrong' : 'refreshed';
    return 'confirmed';
  };
  const detail = D.facts.map((f, i) => ({ fact: f.text, now: f.now, outcome: outcome(ids[i], f) }));
  // Expected: the same ones confirmed; with a model the changed one refreshed and the gone one ended; without a model
  // both "te controleren" (never a silent change).
  const want = (x, model) => (x.now === 'same' ? 'confirmed' : model ? (x.now === 'changed' ? 'refreshed' : 'ended') : 'te controleren');
  const summary = ctx.store.get('memory_dossiers', d.id).summary || '';
  const hits = svc.chunkMatch([userId], 'levering frames maart korting', null, 10, d.id).map((h) => ctx.store.one('SELECT text FROM memory_chunks WHERE id = ?', h.rid)?.text || '').join(' ');
  const res = { detail, withModel: detail.filter((x) => x.outcome === want(x, true)).length, withoutModel: detail.filter((x) => x.outcome === want(x, false)).length, of: detail.length, silent: detail.filter((x) => x.outcome === 'wrong' || (x.now !== 'same' && x.outcome === 'confirmed')).length, nuClean: !D.stale.test(summary), oldDocGone: !/12 maart|5 procent/.test(hits) && /19 maart/.test(hits), ms, summary };
  log('dossier', `opnieuw gelezen: ${detail.map((x) => `${x.now}→${x.outcome}`).join(', ')}; NU schoon: ${res.nuClean ? 'ja' : 'nee'}; oude versie uit het zoeken: ${res.oldDocGone ? 'ja' : 'nee'}; ${ms.toFixed(0)} ms`);
  return res;
}

/**
 * 0.4.4 customer service at scale: CUSTOMERS.count customers (each a client dossier with its own facts, a tenth of them
 * three times as many), arriving over two years. Questions about one customer must find that customer's facts among
 * all of them, fast; the per-turn block stays small; each customer stays within its target and customers nobody
 * worked on for half a year go to the archive (still found by search, active again when they come back).
 */
async function customerScale(t, userId) {
  const ctx = t.app.ctx;
  const svc = ctx.services.memory.svc;
  const mem = ctx.services.memory;
  const C = CUSTOMERS;
  const firsts = ['Anna', 'Bas', 'Chris', 'Daan', 'Eva', 'Femke', 'Gijs', 'Hanna', 'Ivo', 'Joost', 'Kim', 'Lars', 'Mila', 'Noah', 'Olga', 'Pim', 'Quinten', 'Roos', 'Sem', 'Tess', 'Uma', 'Vince', 'Wout', 'Xander', 'Yara'];
  const bot = await t.agent({ name: 'Klantenservice', tool_groups: ['memory'] });
  const agent = ctx.store.agent(bot.id);
  const months = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
  const pay = ['iDEAL', 'pin', 'creditcard', 'op rekening'];
  const facts = (n, i, place, bike) => [
    `Klant ${n} woont in ${place}`,
    `Klant ${n} heeft een ${bike} e-bike gekocht`,
    `Het klantnummer van ${n} is K-${10000 + i}`,
    `${n} belt het liefst ${['in de ochtend', 'tussen de middag', 'aan het eind van de middag'][i % 3]}`,
    `${n} betaalt altijd met ${pay[i % 4]}`,
    `De laatste onderhoudsbeurt van de fiets van ${n} was in ${months[i % 12]}`,
    `${n} heeft framemaat ${48 + (i % 12)}`,
    `${n} wil de nieuwsbrief alleen per e-mail`,
    `De garantie op de fiets van ${n} loopt tot ${2027 + (i % 4)}`,
    `${n} komt de fiets altijd zelf ophalen in de winkel`,
    `${n} rijdt dagelijks ${5 + (i % 30)} kilometer naar het werk`,
    `${n} heeft een kinderzitje voorop laten monteren`,
    `De accu van de fiets van ${n} is ${['400', '500', '625'][i % 3]} Wh`,
    `${n} heeft in ${months[(i + 5) % 12]} een klacht gehad over de remmen`,
    `${n} krijgt de vaste-klantkorting van 5 procent`,
    `${n} spreekt liever Engels dan Nederlands`,
    `${n} heeft een tweede fiets voor zijn partner besteld`,
    `${n} wil herinneringen voor onderhoud via sms`,
    `De fiets van ${n} heeft een ${['Shimano', 'Bosch', 'Bafang'][i % 3]}-motor`,
    `${n} kwam via een advertentie op Marktplaats bij ons`,
  ];
  const customers = [];
  const t0 = performance.now();
  // Four waves, half a year apart: the first customers nobody hears from again.
  for (let wave = 0; wave < 4; wave++) {
    for (let i = wave * (C.count / 4); i < (wave + 1) * (C.count / 4); i++) {
      const name = `${firsts[i % firsts.length]} ${C.names[Math.floor(i / firsts.length) % C.names.length]}`;
      const place = C.places[i % C.places.length];
      const bike = C.bikes[(i * 7) % C.bikes.length];
      const d = (await t.api('POST', '/memory/dossiers', { title: `Klant ${name}`, kind: 'client' })).dossier;
      const list = facts(name, i, place, bike);
      // A tenth are big customers with three times as many notes (orders over the years).
      if (i % 10 === 0) for (let k = 0; k < 2 * C.perCustomer; k++) list.push(`Bestelling ${k + 1} van ${name}: ${['een set remblokken', 'een nieuwe ketting', 'stuurlint', 'een zadel', 'een fietstas'][k % 5]} in ${months[k % 12]}`);
      list.forEach((content, k) =>
        writeCandidate(svc, { userId, content, scope: 'dossier', dossierId: d.id, source: { kind: 'message', trust: 'user', excerpt: content }, origin: 'model', createdBy: 'agent', createdByAgent: bot.id, idemKey: `cs-${i}-${k}`, ownStatement: true, consolidate: false }),
      );
      customers.push({ i, name, place, bike, dossierId: d.id, wave });
    }
    // Per wave, so a write that gets slower as memory grows shows (0.4.5: it did, 100 customers 18 s, 300 138 s).
    log('klanten', `golf ${wave + 1}: ${customers.length} klanten na ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    advance(182);
  }
  await mem.drain();
  const loadSeconds = (performance.now() - t0) / 1000;
  const total = svc.store.one("SELECT COUNT(*) AS n FROM memory_items WHERE user_id = ? AND scope = 'dossier' AND status = 'active'", userId).n;
  // Questions about one customer, among all of them.
  const reader = svc.readerFor(agent, null);
  const sample = customers.filter((c) => c.i % 10 === 3).slice(0, 50);
  let r1 = 0, r5 = 0;
  const qms = [];
  for (const c of sample) {
    for (const [q, re] of [[`Welke fiets heeft ${c.name}?`, new RegExp(`${c.name} heeft een ${c.bike}`)], [`Wat is het klantnummer van ${c.name}?`, new RegExp(`klantnummer van ${c.name} is`)]]) {
      const s = performance.now();
      const hits = await svc.searchItemsAsync(reader, q, { limit: 10, archivedDossiers: true });
      qms.push(performance.now() - s);
      const k = hits.findIndex((h) => re.test(h.row.content));
      if (k === 0) r1++;
      if (k >= 0 && k < 5) r5++;
    }
  }
  qms.sort((a, b) => a - b);
  // The per-turn block of a conversation about one (recent) customer stays small, whatever the size of memory.
  const recentOne = customers.filter((c) => c.wave === 3)[3];
  const th = await t.api('POST', '/threads', { agentId: bot.id });
  const block = String((await mem.context(userId, bot.id, th.id, `${recentOne.name} vraagt wanneer de garantie afloopt`)) || '');
  // Maintenance: customers nobody worked on for half a year go to the archive; every customer within its target.
  advance(1);
  await mem.maintain(userId, 'nightly');
  const target = svc.userSettings(userId).targets.client;
  const perDossier = svc.store.all("SELECT d.status, COUNT(i.id) AS n FROM memory_dossiers d LEFT JOIN memory_items i ON i.dossier_id = d.id AND i.status = 'active' WHERE d.user_id = ? AND d.kind = 'client' GROUP BY d.id", userId);
  const archivedCustomers = perDossier.filter((x) => x.status === 'archived').length;
  const activeCustomers = perDossier.filter((x) => x.status === 'active').length;
  const maxActive = Math.max(0, ...perDossier.filter((x) => x.status === 'active').map((x) => x.n));
  const activeInContext = svc.store.one("SELECT COUNT(*) AS n FROM memory_items i JOIN memory_dossiers d ON d.id = i.dossier_id WHERE i.user_id = ? AND i.status = 'active' AND d.status = 'active'", userId).n;
  const retained = svc.store.one("SELECT COUNT(*) AS n FROM memory_items WHERE user_id = ? AND scope = 'dossier' AND status IN ('active','archived','superseded')", userId).n;
  // A customer from the first wave comes back: found by search, and his dossier is active again.
  const back = customers.find((c) => c.wave === 0 && c.i % 10 === 5);
  const found = (await svc.searchItemsAsync(reader, `Welke fiets heeft ${back.name}?`, { limit: 5, archivedDossiers: true })).some((h) => new RegExp(`${back.name} heeft een ${back.bike}`).test(h.row.content));
  const th2 = await t.api('POST', '/threads', { agentId: bot.id });
  t.script.push({ text: 'Goedemiddag!' });
  await t.say(th2.id, `Klant ${back.name} belt over een nieuwe accu`);
  const reactivated = ctx.store.get('memory_dossiers', back.dossierId).status === 'active';
  const res = { customers: C.count, facts: total, loadSeconds, r1: r1 / (sample.length * 2), r5: r5 / (sample.length * 2), msMedian: qms[Math.floor(qms.length / 2)], msP95: qms[Math.floor(qms.length * 0.95)], blockChars: block.length, blockLines: block.split('\n').filter((l) => l.startsWith('- ')).length, target, maxActive, activeCustomers, archivedCustomers, activeInContext, retained, returning: { found, reactivated } };
  log('klanten', `${C.count} klanten, ${total} feiten (${loadSeconds.toFixed(0)} s): R@1 ${pct(res.r1)} R@5 ${pct(res.r5)}, zoeken ${res.msMedian.toFixed(0)}/${res.msP95.toFixed(0)} ms, blok ${res.blockLines} regels; na onderhoud ${activeCustomers} actief / ${archivedCustomers} in het archief, max ${maxActive} per klant (doel ${target}), ${activeInContext} in de context, ${retained} bewaard; terug: gevonden ${found ? 'ja' : 'nee'}, weer actief ${reactivated ? 'ja' : 'nee'}`);
  return res;
}

async function staleScenarios(t, bot, agent, userId, mode) {
  const ctx = t.app.ctx;
  const svc = ctx.services.memory.svc;
  const mem = ctx.services.memory;
  const res = { document: [], web: [], restated: [], unconfirmed: [], staleSilently: 0 };
  const settingsModel = { extractor: 'free' };
  // A dossier with a price list (v1) and the facts from it; a specialist's knowledge base from a web page.
  const d = (await t.api('POST', '/memory/dossiers', { title: STALE.document.title })).dossier;
  const src = await mem.dossiers.addSource(userId, d.id, { kind: 'note', title: 'Prijslijst 2026', text: STALE.document.v1 });
  const docIds = STALE.document.facts.map((f, i) => mem.remember(userId, { content: f.v1, scope: 'dossier', dossierId: d.id, source: { kind: 'file', ref: src.id, excerpt: f.v1, trust: 'system' }, createdBy: 'agent', createdByAgent: bot.id, idemKey: `bench-doc-${i}` }).item?.id);
  const kb = (await t.api('POST', '/memory/dossiers', { title: 'Kennisbank Shopify' })).dossier;
  const webIds = STALE.web.facts.map((f, i) => mem.remember(userId, { content: f.v1, scope: 'dossier', dossierId: kb.id, source: { kind: 'url', ref: STALE.web.url, excerpt: f.v1, trust: 'system' }, createdBy: 'agent', createdByAgent: bot.id, idemKey: `bench-web-${i}` }).item?.id);
  // Facts the owner said (and will say again), and some nobody will confirm.
  const th = await talk(t, bot, [...STALE.restated.map((r) => `${r.content}.`), ...STALE.unconfirmed.map((c) => `${c}.`)]);
  await mem.learner.learnNow(agent, ctx.store.thread(th.id));
  await mem.drain();
  const find = (c) => svc.store.one("SELECT * FROM memory_items WHERE user_id = ? AND status = 'active' AND content = ?", userId, c) || svc.store.all("SELECT * FROM memory_items WHERE user_id = ? AND status = 'active'", userId).find((r) => groundedShare(c, r.content) >= 0.75);
  const restatedIds = STALE.restated.map((r) => find(r.content)?.id || null);
  const unconfIds = STALE.unconfirmed.map((c) => find(c)?.id || null);
  res.reviewDates = [...docIds, ...webIds, ...restatedIds, ...unconfIds].filter(Boolean).map((id) => svc.store.get('memory_items', id)).filter((r) => r?.review_at).length;

  // Half a year later: everything with a price, version, contract, rule or opening hours is due.
  advance(190);
  // The specialist re-reads its page: the new statements come in from the same source.
  STALE.web.facts.forEach((f, i) => mem.remember(userId, { content: f.v2, scope: 'dossier', dossierId: kb.id, source: { kind: 'url', ref: STALE.web.url, excerpt: f.v2, trust: 'system' }, createdBy: 'agent', createdByAgent: bot.id, idemKey: `bench-web2-${i}` }));
  // The owner mentions two of them again.
  const th2 = await talk(t, bot, STALE.restated.map((r) => r.said));
  await mem.learner.learnNow(agent, ctx.store.thread(th2.id));
  await mem.drain();
  // The price list in the dossier is a new version now (the document's text changed).
  for (const c of svc.store.all('SELECT id FROM memory_chunks WHERE source_id = ?', src.id)) svc.store.exec('UPDATE memory_chunks SET text = ? WHERE id = ?', STALE.document.v2, c.id);
  // Maintenance: with a model (c) it re-reads the document; without one (a, b) it waits two weeks and asks.
  if (mode !== 'c') await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
  await mem.maintain(userId, 'nightly');
  advance(20);
  await mem.maintain(userId, 'nightly');
  if (mode !== 'c') await t.api('PUT', '/memory/settings', settingsModel);

  const state = (id, expect) => {
    // Follow the chain to the current version.
    let r = id ? svc.store.get('memory_items', id) : null;
    for (let i = 0; r && r.status === 'superseded' && r.superseded_by && i < 5; i++) r = svc.store.get('memory_items', r.superseded_by);
    if (!r) return 'missing';
    const flags = Array.isArray(r.flags) ? r.flags : JSON.parse(r.flags || '[]');
    if (r.status === 'active' && flags.includes('check')) return 'te controleren';
    if (r.status === 'active' && r.id !== id) return expect && !expect.test(r.content) ? 'wrong' : 'refreshed';
    if (r.status === 'active' && r.review_at && r.review_at > new Date().toISOString()) return 'confirmed';
    if (r.status === 'active') return 'stale';
    return r.status;
  };
  STALE.document.facts.forEach((f, i) => res.document.push({ fact: f.v1, outcome: state(docIds[i], f.v2), expected: mode === 'c' ? (f.same ? 'confirmed' : 'refreshed') : 'te controleren' }));
  STALE.web.facts.forEach((f, i) => res.web.push({ fact: f.v1, outcome: state(webIds[i], f.expect), expected: 'refreshed' }));
  STALE.restated.forEach((f, i) => res.restated.push({ fact: f.content, outcome: state(restatedIds[i]), expected: 'confirmed' }));
  STALE.unconfirmed.forEach((f, i) => res.unconfirmed.push({ fact: f, outcome: state(unconfIds[i]), expected: 'te controleren' }));
  const all = [...res.document, ...res.web, ...res.restated, ...res.unconfirmed];
  res.correct = all.filter((x) => x.outcome === x.expected).length;
  res.total = all.length;
  res.staleSilently = all.filter((x) => x.outcome === 'stale' || x.outcome === 'wrong').length;
  log(mode, `verouderd: ${res.correct}/${res.total} zoals verwacht, ${res.staleSilently} stil verouderd`, JSON.stringify(all.map((x) => x.outcome)));
  return res;
}

async function simulateYear(t, userId, mode) {
  const ctx = t.app.ctx;
  const svc = ctx.services.memory.svc;
  const mem = ctx.services.memory;
  const yb = await t.agent({ name: 'Jaarbot', tool_groups: ['memory'] });
  const target = svc.userSettings(userId).targets.agent;
  // Written the way the learner writes what the owner said (own words, applied directly; a merely similar note stays
  // next to the other one), not as a bot's tool call.
  const learned = (content, idemKey) =>
    writeCandidate(svc, { userId, content, scope: 'agent', agentId: yb.id, source: { kind: 'message', trust: 'user', excerpt: content }, origin: 'model', createdBy: 'agent', createdByAgent: yb.id, idemKey, ownStatement: true });
  const quota = svc.userSettings(userId).quotas.agent.items;
  const important = [];
  // Month 1: what must never get lost: 5 pinned by the owner, 5 he wrote himself, 5 used often.
  for (let i = 0; i < 5; i++) {
    const it = (await t.api('POST', '/memory/items', { content: `Belangrijke vaste afspraak nummer ${i + 1} met de groothandel Fietsgigant`, scope: 'agent', agentId: yb.id })).item;
    await t.api('PATCH', `/memory/items/${it.id}`, { pinned: true });
    important.push({ id: it.id, why: 'vastgezet' });
  }
  for (let i = 0; i < 5; i++) important.push({ id: (await t.api('POST', '/memory/items', { content: `Door mij genoteerd: het kenteken van bus ${i + 1} is VX-${100 + i}-B`, scope: 'agent', agentId: yb.id })).item.id, why: 'door de eigenaar' });
  const often = [];
  for (let i = 0; i < 5; i++) {
    const r = learned(`De vaste ophaaldag van retourpakket soort ${i + 1} is ${['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag'][i]}`, `often-${i}`);
    important.push({ id: r.item.id, why: 'vaak gebruikt' });
    often.push({ id: r.item.id, q: `Wat is de ophaaldag van retourpakket soort ${i + 1}?` });
  }
  const perMonth = 50;
  let added = 0;
  const peak = { active: 0, retained: 0 };
  const months = 12;
  for (let m = 1; m <= months; m++) {
    for (let i = 0; i < perMonth; i++) {
      const s = YEAR_SUBJECTS[(m * 7 + i) % YEAR_SUBJECTS.length];
      const content = YEAR_TEMPLATES[(m * 3 + i) % YEAR_TEMPLATES.length](s, m, i);
      learned(content, `year-${m}-${i}`);
      added++;
    }
    // The often used ones are used every week; a few of the new ones once.
    for (let w = 0; w < 4; w++) {
      for (const o of often) {
        const th = await t.api('POST', '/threads', { agentId: yb.id });
        await mem.context(userId, yb.id, th.id, o.q);
        await t.api('DELETE', `/threads/${th.id}`).catch(() => {});
      }
      advance(7);
      // Maintenance: weekly without a model; once a month with the local model (fewer calls on the shared Ollama).
      if (mode !== 'c' || w === 3) await mem.maintain(userId, 'nightly');
      const n = svc.store.one("SELECT COUNT(*) AS n FROM memory_items WHERE user_id = ? AND scope = 'agent' AND agent_id = ? AND status = 'active'", userId, yb.id).n;
      const r = svc.store.one("SELECT COUNT(*) AS n FROM memory_items WHERE user_id = ? AND scope = 'agent' AND agent_id = ? AND status IN ('active','proposed','archived','superseded')", userId, yb.id).n;
      peak.active = Math.max(peak.active, n);
      peak.retained = Math.max(peak.retained, r);
    }
    advance(2);
  }
  await mem.drain();
  const active = svc.store.one("SELECT COUNT(*) AS n FROM memory_items WHERE user_id = ? AND scope = 'agent' AND agent_id = ? AND status = 'active'", userId, yb.id).n;
  const archived = svc.store.one("SELECT COUNT(*) AS n FROM memory_items WHERE user_id = ? AND scope = 'agent' AND agent_id = ? AND status = 'archived'", userId, yb.id).n;
  const retained = svc.store.one("SELECT COUNT(*) AS n FROM memory_items WHERE user_id = ? AND scope = 'agent' AND agent_id = ? AND status IN ('active','proposed','archived','superseded')", userId, yb.id).n;
  const summaries = svc.store.one("SELECT COUNT(*) AS n FROM memory_items WHERE user_id = ? AND agent_id = ? AND source_kind = 'consolidation' AND status = 'active'", userId, yb.id).n;
  const lost = important.filter((x) => svc.store.get('memory_items', x.id)?.status !== 'active').map((x) => ({ ...x, status: svc.store.get('memory_items', x.id)?.status, change: svc.store.one('SELECT op, summary, actor FROM memory_changes WHERE record_id = ? ORDER BY created_at DESC LIMIT 1', x.id) }));
  const byStatus = Object.fromEntries(svc.store.all("SELECT status, COUNT(*) AS n FROM memory_items WHERE user_id = ? AND agent_id = ? GROUP BY status", userId, yb.id).map((r) => [r.status, r.n]));
  const monthly = svc.store.all("SELECT id, lines, counts FROM memory_reports WHERE user_id = ? AND trigger = 'monthly' ORDER BY started_at", userId);
  // The owner can still find an archived memory and put it back (undo of a monthly report line).
  let restored = null;
  const last = monthly.at(-1);
  if (last) {
    const lines = JSON.parse(last.lines || '[]');
    const idx = lines.findIndex((l) => l.op === 'archive' && l.changeIds?.length);
    if (idx >= 0) {
      const ref = lines[idx].refs?.[0]?.replace(/^m:/, '');
      const r = await t.api('POST', `/memory/reports/${last.id}/undo`, { index: idx }).catch((e) => ({ error: String(e.message || e) }));
      const row = ref ? svc.store.one('SELECT status FROM memory_items WHERE user_id = ? AND ref = ?', userId, ref) : null;
      restored = { undone: r.undone ?? 0, error: r.errors?.[0] || r.error || null, status: row?.status || null };
    }
  }
  const search = (await t.api('GET', `/memory/search?q=${encodeURIComponent('kenteken bus 3')}`)).items.length > 0;
  const res = { months, added: added + important.length, target, quota, active, archived, retained, summaries, peak, important: important.length, lost: lost.map((x) => x.why), lostDetail: lost, byStatus, monthlyReports: monthly.length, restored, importantFoundBySearch: search };
  log(mode, `jaar: ${res.added} toegevoegd, actief ${active} (doel ${target}), archief ${archived}, totaal ${retained} (quotum ${quota}), ${summaries} samenvattingen, kwijt: ${lost.length}, maandverslagen ${monthly.length}`);
  return res;
}

// ---------------------------------------------------------------------------- run and report
// `--report a.json,b.json [--write]`: only render the report from saved results (e.g. (a)+(b) and (c) run apart).
const FROM = opt('report', null);
const BEFORE = opt('before', null) ? JSON.parse(fs.readFileSync(opt('before', null), 'utf8')) : [];
/** Which code the "before" results are from (`--before-label 0.4.4`). */
const BEFORE_LABEL = opt('before-label', 'vóór 0.4.4');
if (FROM) {
  const rs = FROM.split(',').flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  const md = report(rs, BEFORE);
  console.log(md);
  if (WRITE) {
    fs.mkdirSync(path.join(ROOT, 'docs', 'quality'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'docs', 'quality', 'memory-bench.md'), md);
  }
  process.exit(0);
}
const results = [];
let cacheDir = null;
const needModel = MODES.some((m) => m === 'b' || m === 'c');
const rtProblem = runtimeProblem();
if (needModel && rtProblem) log(`ingebouwd model kan hier niet draaien (${rtProblem}); installeer onnxruntime-node en @huggingface/tokenizers. Modus b/c overgeslagen.`);
else if (needModel) cacheDir = await modelCache();
let ollamaOk = false;
if (MODES.includes('c')) {
  try {
    const tags = await (await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) })).json();
    ollamaOk = (tags.models || []).some((m) => m.name === OLLAMA_MODEL);
    if (!ollamaOk) log(`Ollama heeft ${OLLAMA_MODEL} niet; modus c overgeslagen (er wordt niets gedownload).`);
  } catch {
    log('Ollama niet bereikbaar; modus c overgeslagen.');
  }
}
const CHILD = opt('child', null);
if (CHILD) {
  OFFSET = 0;
  const r = await runMode(CHILD, cacheDir);
  fs.writeFileSync(opt('out', path.join(TMP, 'child.json')), JSON.stringify(r));
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    /* left in the temp folder */
  }
  process.exit(0);
}
const { spawnSync } = await import('node:child_process');
for (const mode of MODES) {
  if ((mode === 'b' || mode === 'c') && !cacheDir) {
    results.push({ mode, skipped: 'het ingebouwde model kan op deze pc niet draaien (onnxruntime-node ontbreekt)' });
    continue;
  }
  if (mode === 'c' && !ollamaOk) {
    results.push({ mode, skipped: `geen Ollama met ${OLLAMA_MODEL}` });
    continue;
  }
  log(`modus ${mode} …`);
  // Each mode in its own process: a fresh app, clock and connection pool.
  const outFile = path.join(TMP, `mode-${mode}.json`);
  const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '--child', mode, '--out', outFile, ...(args.includes('--debug') ? ['--debug'] : []), ...(args.includes('--quick') ? ['--quick'] : []), ...(args.includes('--scale-only') ? ['--scale-only'] : []), ...(ONLY ? ['--only', ONLY] : []), '--ollama', OLLAMA], { stdio: 'inherit', env: process.env });
  results.push(fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : { mode, error: `het proces stopte (code ${child.status})` });
}
fs.writeFileSync(path.join(TMP, 'results.json'), JSON.stringify(results, null, 1));
if (args.includes('--debug')) fs.writeFileSync(path.join(DEBUG_DIR, 'results.json'), JSON.stringify(results, null, 1));
// --scale-only measured one scenario: print that, not the whole report (it has no other numbers).
if (args.includes('--scale-only')) {
  for (const r of results) console.log(`${r.mode}: ${JSON.stringify(r.customers || { error: r.error })}`);
  process.exit(0);
}

// `--only tools`: no full report, the scenario's result per mode.
const md = ONLY ? results.map((r) => `${r.mode}: ${r.error || r.skipped || JSON.stringify({ ...r.toolLearn, learnResults: undefined, rows: undefined }, null, 1)}`).join('\n') : report(results, BEFORE);
console.log('\n' + md);
if (WRITE && !ONLY) {
  const dest = path.join(ROOT, 'docs', 'quality', 'memory-bench.md');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, md);
  log('verslag geschreven:', dest);
}
try {
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5 });
} catch {
  /* left in the temp folder */
}

/**
 * The report. `before` (optional, `--before results.json`): the same bench on the code before 0.4.4 (modes a and b),
 * for the before/after table; (c) before is the run of 9 November 2026 (code before 0.4.4, same model).
 */
function report(rs, before = []) {
  const name = { a: '(a) alleen woorden + synoniemen', b: '(b) ingebouwd model + woorden', c: `(c) Ollama (${OLLAMA_MODEL}) leert, ingebouwd model zoekt` };
  const ok = (r) => r && !r.skipped && !r.error;
  const okBefore = (r) => r && !r.skipped && r.retrieval;
  const n1 = (x) => (Number.isFinite(x) ? x.toFixed(1).replace('.', ',') : '–');
  const L = [];
  L.push('# Geheugentest (`npm run memory:bench`)', '');
  L.push(`Gedraaid op ${new RealDate().toISOString().slice(0, 10)} · ${os.cpus()[0]?.model?.trim() || 'cpu'} · Node ${process.version}. Vaste set: ${facts.length} feiten in lange gesprekken (met praatjes ertussen), ${QUESTIONS.length} vragen in andere woorden (deels Engels), ${OFFTOPIC.length} beurten die niet over het geheugen gaan, ${CORRECTIONS.length} correcties, ${UPDATES.ends.length + UPDATES.cascade.ends.length + UPDATES.keeps.length} updates zonder vaste sleutel (waarvan ${UPDATES.ends.filter((u) => u.heldOut).length + UPDATES.keeps.filter((u) => u.heldOut).length} achtergehouden), een dossier met open taken, een dossier dat verandert, ${STALE.document.facts.length + STALE.web.facts.length + STALE.restated.length + STALE.unconfirmed.length} feiten die verouderen, een gesimuleerd jaar en een klantenservice met ${CUSTOMERS.count} klanten.`, '');
  L.push('(a) en (b) leren met een vaste, ideale leerder (de feiten zoals geschreven, zonder synoniemen en zonder te beslissen wat een nieuw feit beëindigt): zo meten ze zoeken, de vaste patronen en het onderhoud. (c) is van begin tot eind met een echt gratis lokaal model (leren, synoniemen, controleren tegen wat er al staat, onderhoud), met het ingebouwde model voor betekenis.', '');
  // ---- before / after
  const bOf = (m) => before.find((r) => r.mode === m && okBefore(r));
  const aOf = (m) => rs.find((r) => r.mode === m && ok(r));
  L.push(`## Voor en na (${BEFORE_LABEL} → nu)`, '');
  L.push('| Meting | (a) voor | (a) na | (b) voor | (b) na | (c) voor | (c) na |', '|---|---|---|---|---|---|---|');
  const row = (label, f, cb = '–') => L.push(`| ${label} | ${bOf('a') ? f(bOf('a')) : '–'} | ${aOf('a') ? f(aOf('a')) : '–'} | ${bOf('b') ? f(bOf('b')) : '–'} | ${aOf('b') ? f(aOf('b')) : '–'} | ${cb} | ${aOf('c') ? f(aOf('c')) : '–'} |`);
  row('Opgeslagen feiten', (r) => `${r.retrieval.extracted}/${r.retrieval.facts}`, '88/206');
  row('Recall@1', (r) => pct(r.retrieval.recall1), '30,2 %');
  row('Recall@5', (r) => pct(r.retrieval.recall5), '38,2 %');
  row('In het geheugenblok', (r) => pct(r.retrieval.contextRecall), '37,3 %');
  row('Precisie "Relevant"', (r) => pct(r.retrieval.contextPrecision), '19,1 %');
  row('Regels per blok', (r) => n1(r.retrieval.avgInBlock), '3,8');
  row('Regels bij een beurt zonder geheugenvraag', (r) => n1(r.retrieval.offTopicLines));
  row('Correctie bovenaan · in top 5', (r) => `${r.corrections.newFirst}/8 · ${r.corrections.newTop5}/8`, '1/8 · 6/8');
  row('Impliciet beëindigd (+ achtergehouden)', (r) => (r.updates ? `${r.updates.ends.ok}/${r.updates.ends.of} (+${r.updates.endsHeldOut.ok}/${r.updates.endsHeldOut.of})` : '–'));
  row('Ketting: wat ervan afhing ook beëindigd', (r) => (r.updates ? `${r.updates.cascade.ok}/${r.updates.cascade.of}` : '–'));
  row('Onterecht beëindigd', (r) => (r.updates ? `${r.updates.wrong}/${r.updates.keeps.of + r.updates.keepsHeldOut.of}` : '–'));
  row('Taken vanzelf afgerond (SEO-geval)', (r) => (r.tasks ? `${r.tasks.closed}/4` : '–'));
  const tl = (r, f) => (r.toolLearn ? f(r.toolLearn) : '–');
  row('Bot ontdekt iets met een tool: geleerd (als tool gemarkeerd)', (r) => tl(r, (x) => `${x.learned}/${x.of}`));
  row('Nieuwere meting vervangt de oude direct', (r) => tl(r, (x) => (x.replaced ? 'ja' : 'nee')));
  const asked = (x) => (x.card ? 'kaart' : x.ownerCheck ? 'te controleren' : 'geen vraag');
  row('Tool spreekt de eigenaar tegen: eigenaar gevraagd, zijn woorden blijven', (r) => tl(r, (x) => `${asked(x)}, ${x.ownerKept ? 'blijven' : 'overschreven'}`));
  row('Nooit opgeslagen (opdracht, sleutel, gok, tijdelijke stand)', (r) => tl(r, (x) => `${x.never}/${x.neverOf}`));
  row('Beoordelingskaarten · modelaanroepen in dat gesprek', (r) => tl(r, (x) => `${x.cards} · ${x.calls}`));
  row('Dossier verandert: zoals verwacht',(r) => (r.dossier ? `${r.mode === 'c' ? r.dossier.withModel : r.dossier.withoutModel}/${r.dossier.of}, ${r.dossier.silent} stil fout, ${r.dossier.nuClean ? 'NU schoon' : 'NU verouderd'}` : '–'));
  const cs = (r, f) => (r.customers?.error || /dossiers/.test(String(r.error || '')) ? `kon niet (${String(r.customers?.error || r.error).replace(/^.*?400: /, '').split('.')[0]})` : r.customers ? f(r.customers) : '–');
  row('Klantenservice: recall@1 · @5', (r) => cs(r, (c) => `${pct(c.r1)} · ${pct(c.r5)}`));
  row('Klantenservice: klanten actief / archief', (r) => cs(r, (c) => `${c.activeCustomers} / ${c.archivedCustomers}`));
  row('Na een jaar: actief (doel 250), belangrijk kwijt', (r) => (r.year ? `${r.year.active}, ${r.year.lost.length}/${r.year.important}` : '–'), '232, 0/15');
  row('Zoektijd mediaan / p95', (r) => `${r.retrieval.queryMsMedian.toFixed(0)} / ${r.retrieval.queryMsP95.toFixed(0)} ms`, '3 / 3 ms');
  L.push('', `"Voor" = dezelfde test op de code van ${BEFORE_LABEL} (\`--before\`); (c) voor = de run van 9 november 2026 (code van vóór 0.4.4) met hetzelfde lokale model. "–" = niet gemeten (het scenario bestond toen niet, of hoort niet bij die modus).`, '');
  L.push('## Terugvinden', '');
  L.push('| Modus | Opgeslagen | Recall@1 | Recall@5 | Recall@5 van opgeslagen feiten | In het geheugenblok | Precisie "Relevant" | Regels per blok | Regels bij een praatje | Zoektijd (mediaan / p95) |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rs) {
    if (!ok(r)) continue;
    const line = (x, label) => `| ${label} | ${x.extracted}/${x.facts} | ${pct(x.recall1)} | ${pct(x.recall5)} | ${pct(x.recall5Stored)} | ${pct(x.contextRecall)} | ${pct(x.contextPrecision)} | ${n1(x.avgInBlock)} | ${n1(x.offTopicLines)} | ${x.queryMsMedian.toFixed(0)} / ${x.queryMsP95.toFixed(0)} ms |`;
    if (r.plain) L.push(line(r.plain, '0.3: woorden zonder synoniemen'));
    L.push(line(r.retrieval, name[r.mode]));
  }
  L.push('', '"Opgeslagen" = feiten die na het leren in het geheugen staan. Recall@k = de vraag vindt het feit in de eerste k resultaten van de zoektool van de bot. "In het geheugenblok" = het feit staat in het blok dat de bot per beurt krijgt; precisie = welk deel van het onderdeel "Relevant" over de vraag gaat. "Regels bij een praatje" = hoeveel "Relevant"-regels een beurt als "Leuk, dankjewel!" of "Hoe ver is de maan?" krijgt (verspilde tokens; liefst 0).', '');
  L.push('## Correcties en verouderde feiten', '');
  L.push('| Modus | Correctie bovenaan | Correctie in top 5 | Oude waarde niet meer actief | Verouderd: zoals verwacht | Stil verouderd |', '|---|---|---|---|---|---|');
  for (const r of rs) if (ok(r) && r.stale) L.push(`| ${name[r.mode]} | ${r.corrections.newFirst}/${r.corrections.total} | ${r.corrections.newTop5}/${r.corrections.total} | ${r.corrections.oldInactive}/${r.corrections.total} | ${r.stale.correct}/${r.stale.total} | ${r.stale.staleSilently} |`);
  L.push('', 'Een correctie staat bovenaan als de oorspronkelijke vraag het nieuwe feit als eerste vindt; de oude waarde is dan altijd al uit het actieve geheugen (vervangen, met geschiedenis). Wat niet bovenaan komt, mist om dezelfde reden als het oorspronkelijke feit: de vraag gebruikt heel andere woorden ("Wie doet mijn administratie?" → boekhouder).', '');
  L.push('Verwacht bij verouderen: van een webpagina die de specialist opnieuw leest → *vernieuwd* (zelfde bron, nieuwe versie, oude in de geschiedenis); wat de eigenaar opnieuw zegt → *bevestigd*; wat niemand bevestigt → *te controleren*; een prijslijst in een dossier → met een model opnieuw gelezen (*vernieuwd* of *bevestigd*), zonder model *te controleren*. "Stil verouderd" = een verouderd feit dat zonder waarschuwing actief bleef (moet 0 zijn).', '');
  for (const r of rs)
    if (ok(r) && r.stale) {
      const all = [...r.stale.document, ...r.stale.web, ...r.stale.restated, ...r.stale.unconfirmed];
      L.push(`<details><summary>${name[r.mode]}: per feit</summary>`, '', '| Feit | Uitkomst | Verwacht |', '|---|---|---|', ...all.map((x) => `| ${x.fact} | ${x.outcome} | ${x.expected} |`), '', '</details>', '');
    }
  L.push('## Bijwerken zonder vaste sleutel (0.4.4)', '');
  L.push('| Modus | Impliciet beëindigd | Achtergehouden gevallen | Ketting (wat ervan afhing) | Terecht gebleven | Taken vanzelf afgerond | Open taak bleef open | Eigen taaknotities gesloten | Blok zonder afgeronde taak |', '|---|---|---|---|---|---|---|---|---|');
  for (const r of rs) if (ok(r) && r.updates && r.tasks) L.push(`| ${name[r.mode]} | ${r.updates.ends.ok}/${r.updates.ends.of} | ${r.updates.endsHeldOut.ok}/${r.updates.endsHeldOut.of} beëindigd, ${r.updates.keepsHeldOut.ok}/${r.updates.keepsHeldOut.of} terecht gebleven | ${r.updates.cascade.ok}/${r.updates.cascade.of} | ${r.updates.keeps.ok}/${r.updates.keeps.of} | ${r.tasks.closed}/4 (${Object.entries(r.tasks.ways).map(([k, v]) => `${k} ${v ? 'ja' : 'nee'}`).join(', ')}) | ${r.tasks.controlOpen ? 'ja' : 'nee'} | ${r.tasks.todosEnded}/${r.tasks.todosPresent} | ${r.tasks.blockClean ? 'ja' : 'nee'} |`);
  L.push('', `De eigenaar zegt iets dat een oudere notitie zonder gedeelde sleutel beëindigt ("${UPDATES.ends[1].said}" na "${UPDATES.ends[1].old}"), één zin die ook beëindigt wat ervan afhing ("${UPDATES.cascade.said}": zijn werk in de werkplaats en de productfoto's), en verwant nieuws dat niets mag beëindigen ("${UPDATES.keeps[0].said}" na "${UPDATES.keeps[0].old}"). De achtergehouden gevallen zijn pas na het schrijven van de patronen toegevoegd en nooit gebruikt om ze bij te stellen. Taken: een dossier met vijf open acties en twee eigen taaknotities; afgerond door wat de eigenaar zegt, een kaal "gedaan" direct nadat de bot de taak noemde, een bot die het werk met een tool deed en een routine; één actie moet open blijven. Gevoelige notities (bijv. over zwangerschapsverlof) worden nooit vergeleken.`, '');
  L.push('## Leren uit het hele gesprek (0.4.5)', '');
  L.push('| Modus | Geleerd uit tool-uitvoer | Nieuwere meting vervangt direct | Tool tegen eigenaar | Nooit opgeslagen | Kaarten | Modelaanroepen | Tijd |', '|---|---|---|---|---|---|---|---|');
  for (const r of rs) if (ok(r) && r.toolLearn) L.push(`| ${name[r.mode]} | ${r.toolLearn.learned}/${r.toolLearn.of} | ${r.toolLearn.replaced ? 'ja' : 'nee'} | ${asked(r.toolLearn)}, eigenaar ${r.toolLearn.ownerKept ? 'blijft' : 'overschreven'} | ${r.toolLearn.never}/${r.toolLearn.neverOf}${r.toolLearn.leaked.length ? ` (lek: ${r.toolLearn.leaked.join('; ')})` : ''} | ${r.toolLearn.cards} | ${r.toolLearn.calls}${r.toolLearn.checkCalls ? ` (+${r.toolLearn.checkCalls} controle)` : ''}${r.toolLearn.errors?.length ? `; fout: ${r.toolLearn.errors.join('; ')}` : ''} | ${r.toolLearn.ms.toFixed(0)} ms |`);
  for (const r of rs)
    if (ok(r) && r.toolLearn) L.push('', `<details><summary>${name[r.mode]}: per feit</summary>`, '', '| Wat het model teruggaf | Verwacht | Uitkomst | Bron |', '|---|---|---|---|', ...r.toolLearn.detail.map((d) => `| ${d.content} | ${d.expect} | ${d.status}${d.reason ? ` (${d.reason})` : ''} | ${d.from || '–'} |`), '', '</details>');
  L.push('', 'Een bot zoekt in één gesprek met een tool op waar het afsprakensysteem van de werkplaats op draait, hoeveel reparaties er open staan en wat er op twee pagina\'s van een groothandel staat; één vraag beantwoordt hij zonder iets na te kijken. Wat hij vond over de wereld van de eigenaar moet geleerd worden, gemarkeerd als *tool*. Nooit: een pagina die een AI iets opdraagt (ook de andere feiten van die pagina niet), een sleutel, een gok zonder werk en de stand van nu. In een later gesprek ziet de tool een nieuwere PHP-versie: die vervangt de oude direct. De tool zegt een andere hoster dan de eigenaar zelf zei: dat wordt één beoordelingskaart en wat de eigenaar zei blijft staan. Het model is hier ideaal maar naïef: het geeft ook wat nooit opgeslagen mag worden, zodat de vangrails in de code gemeten worden. Vóór 0.4.5 leerde TeamBot alleen uit de eigen woorden van de eigenaar.', '');
  L.push('## Een dossier dat verandert (0.4.4)', '');
  L.push('| Modus | Per feit (verwacht → uitkomst) | Zoals verwacht | Stil fout | NU zegt het oude niet meer | Oude versie uit het zoeken | Tijd |', '|---|---|---|---|---|---|---|');
  for (const r of rs) if (ok(r) && r.dossier) L.push(`| ${name[r.mode]} | ${r.dossier.detail.map((x) => `${x.now} → ${x.outcome}`).join('; ')} | ${r.mode === 'c' ? r.dossier.withModel : r.dossier.withoutModel}/${r.dossier.of} | ${r.dossier.silent} | ${r.dossier.nuClean ? 'ja' : 'nee'} | ${r.dossier.oldDocGone ? 'ja' : 'nee'} | ${r.dossier.ms.toFixed(0)} ms |`);
  L.push('', 'De afspraken met een klant krijgen een nieuwe versie (dezelfde titel): één datum anders, één afspraak weg, twee hetzelfde. Verwacht: wat hetzelfde blijft *bevestigd* (en wijst naar de nieuwe versie); met een model het veranderde *vernieuwd* en het verdwenen *beëindigd*; zonder model beide *te controleren* (nooit stil). NU mag de oude datum en de korting niet meer noemen.', '');
  L.push('## Na een gesimuleerd jaar', '');
  L.push('| Modus | Toegevoegd | Actief (doel) | Archief | Totaal (quotum) | Hoogste actief | Samenvattingen | Belangrijk kwijt | Maandverslagen | Terugzetten uit verslag |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rs) if (ok(r) && r.year) L.push(`| ${name[r.mode]} | ${r.year.added} | ${r.year.active} (${r.year.target}) | ${r.year.archived} | ${r.year.retained} (${r.year.quota}) | ${r.year.peak.active} | ${r.year.summaries} | ${r.year.lost.length}/${r.year.important} | ${r.year.monthlyReports} | ${r.year.restored ? (r.year.restored.status === 'active' ? 'ja' : `nee (${r.year.restored.error || r.year.restored.status})`) : '–'} |`);
  L.push('', 'Eén bot krijgt 12 maanden lang 50 kleine notities per maand (over 10 onderwerpen), plus 15 belangrijke: 5 vastgezet, 5 door de eigenaar zelf geschreven, 5 die elke week gebruikt worden. Onderhoud elke week; in (c) elke maand (minder aanroepen op de gedeelde Ollama), dus komt daar tussen twee onderhoudsrondes een maand aan notities bovenop ("hoogste actief"). In de app draait het onderhoud elke nacht. "Belangrijk kwijt" moet 0 zijn; actief moet binnen het doel blijven en het totaal onder het quotum.', '');
  L.push('## Klantenservice op schaal (0.4.4)', '');
  L.push('| Modus | Klanten / feiten | Recall@1 | Recall@5 | Zoektijd (mediaan / p95) | Blok per beurt | Na onderhoud: actief / archief | Grootste klant (doel) | In de context | Bewaard | Terugkerende klant |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rs)
    if (ok(r) && r.customers && !r.customers.error) {
      const c = r.customers;
      L.push(`| ${name[r.mode]} | ${c.customers} / ${c.facts} | ${pct(c.r1)} | ${pct(c.r5)} | ${c.msMedian.toFixed(0)} / ${c.msP95.toFixed(0)} ms | ${c.blockLines} regels, ${c.blockChars} tekens | ${c.activeCustomers} / ${c.archivedCustomers} | ${c.maxActive} (${c.target}) | ${c.activeInContext} | ${c.retained} | ${c.returning.found ? 'gevonden' : 'niet gevonden'}, ${c.returning.reactivated ? 'weer actief' : 'niet heractiveerd'} |`);
    }
  L.push('', `${CUSTOMERS.count} klanten, elk een klantdossier met ${CUSTOMERS.perCustomer} feiten (een tiende ${3 * CUSTOMERS.perCustomer}), in vier golven met een half jaar ertussen. 100 vragen over één klant ("Welke fiets heeft Anna Bakker?") tussen alle klanten in. Daarna één onderhoudsronde: klanten waar een half jaar niets mee gebeurde gaan naar het archief (buiten de context van de bots, wel vindbaar met memory_search), elke klant blijft binnen zijn doel (een gearchiveerde klant houdt een kwart), en een oude klant die terugkomt wordt gevonden en is daarna weer actief.`, '');
  L.push('## Wat het zegt', '');
  L.push(
    '- **Het ingebouwde model is nu granite-embedding-97m-multilingual-r2** (IBM, Apache-2.0, getraind op data met vrije licenties): op betekenis alleen staat het juiste feit bij 60 % van de vragen bovenaan, met multilingual-e5-small was dat 44 %. Samen met de nieuwe weging van woorden en betekenis gaat recall@1 van ongeveer 40 % naar ongeveer 60 % en recall@5 naar ruim 85 %, met een kleinere download (124 MB in plaats van 135 MB).',
    '- **Het geheugenblok is schoner**: de helft van de regels, en ongeveer de helft daarvan gaat over de vraag; een beurt die niet over het geheugen gaat, krijgt meestal niets meer. Dat komt door een drempel die alleen bij een gemeten model werkt (granite onderscheidt een geheugenvraag van een praatje, e5 niet).',
    '- **Zonder enig model** helpen de koppen van Nederlandse samenstellingen ("teamoverleg" → overleg, "webwinkel" → winkel) en een strakkere synoniemenlijst ook het zoeken op woorden.',
    '- **Bijwerken**: een nieuw feit wordt vergeleken met wat er al staat. De vaste patronen sluiten duidelijke gevallen (een taak die gedaan is, iets dat gestopt is) direct, met een reden en ongedaan maken, maar zijn voorzichtig: bij twijfel of twee gelijke kandidaten niets. Wat ervan afhing (een ketting) en anders verwoorde gevallen vragen het model.',
    '- **Taken sluiten zichzelf**: het SEO-geval werkt op elke manier (de eigenaar, "gedaan", een bot met bewijs, een routine) en de afgeronde taak staat niet meer in het blok.',
    '- **Een dossier dat verandert** wordt opnieuw gelezen: alleen wat niet meer letterlijk in de nieuwe versie staat wordt gecontroleerd; NU noemt het oude niet meer.',
    '- **Klantenservice**: het juiste feit van één klant tussen meer dan 10.000 feiten wordt snel gevonden, het blok blijft klein, en klanten waar niets meer mee gebeurt gaan naar het archief.',
    '- **Leren uit het hele gesprek** (0.4.5): wat de bot met een tool vond wordt nu geleerd en als *tool* gemarkeerd (vóór 0.4.5 niets), een nieuwere meting vervangt de oude direct, en een tool die de eigenaar tegenspreekt wordt één kaart in plaats van een overschrijving. Wat nooit mag (een pagina die een AI iets opdraagt, een sleutel, een gok zonder werk) bleef buiten het geheugen; de rest van de test veranderde niet.',
    '',
    `Model: granite-embedding-97m-multilingual-r2 (IBM, Apache-2.0), uint8-ONNX van IBM zelf (revisie ${BUILTIN.revision.slice(0, 12)}…), drie bestanden van samen ${Math.round(BUILTIN_FILES.reduce((n, f) => n + f.size, 0) / 1e6)} MB met SHA-256-controle; runtime onnxruntime-node (MIT) en @huggingface/tokenizers 0.2.0 (Apache-2.0). Vergeleken op deze set (alleen betekenis): granite recall@1 60 % / @5 81 %, multilingual-e5-small 44 % / 76 %, paraphrase-multilingual-MiniLM-L12-v2 47 % / 74 %. Een herrangschikker (cross-encoder mmarco-mMiniLMv2, Apache-2.0, 119 MB) gaf op e5 +10 punten recall@1 en op granite nog +7, maar is getraind op MS MARCO (alleen niet-commercieel gebruik); daarom niet meegenomen.`,
    '',
  );
  for (const r of rs)
    if (r.learner && r.mode === 'c')
      L.push(`Leerder in (c): ${r.learner.batches} gesprekken, ${r.learner.model} door het model gelezen (de rest met vaste patronen na een fout: ${r.learner.errors}), ${r.learner.applied} opgeslagen, ${r.learner.proposed} als voorstel, ${r.learner.dropped} geweigerd${r.learner.droppedWhy && Object.keys(r.learner.droppedWhy).length ? ` (${Object.entries(r.learner.droppedWhy).map(([k, v]) => `${v}× ${k}`).join(', ')})` : ''}; tegen wat er al stond: ${r.learner.consolidated?.invalidated ?? 0} beëindigd of vervangen, ${r.learner.consolidated?.merged ?? 0} samengevoegd. Vóór 0.4.4: 88 van 206 opgeslagen, 32 geweigerd.`, '');
  L.push('## Tijd', '');
  for (const r of rs) {
    if (r.skipped) L.push(`- ${name[r.mode]}: overgeslagen (${r.skipped}).`);
    else if (r.error) L.push(`- ${name[r.mode]}: fout — ${String(r.error).split('\n')[0]}`);
    else L.push(`- ${name[r.mode]}: ${r.seconds.toFixed(0)} s in totaal; leren ${r.learnSeconds.toFixed(0)} s; ${r.vectors} vectoren; zoeken op betekenis: ${r.semantic.state}${r.semantic.model ? ` (${r.semantic.model})` : ''}${r.customers?.loadSeconds != null ? `; klantenservice laden ${r.customers.loadSeconds.toFixed(0)} s` : ''}.`);
  }
  L.push('');
  return L.join('\n');
}

