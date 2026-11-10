// LIVE run of smart memory with a real engine that costs nothing extra (temp data dir, nothing of yours is touched):
//   1. the Dutch evaluation set (tests/memory-eval-set.ts): precision/recall of the patterns vs. the model;
//   2. a scenario: short conversation → items, a correction → superseded, maintenance → merged items, dossier
//      updated (timeline, decisions, actions, NU summary), report shown;
//   3. latency per call and extra cost (must be $0).
// The bot's own chat replies are scripted; only memory learning/maintenance uses the real engine.
//   node --import tsx tests/e2e/memory-live.mjs                 (Claude Code on your subscription, model haiku)
//   MEMORY_LIVE_ENGINE=opencode OPENCODE_BIN=<opencode.exe> …   (free OpenCode model, own HOME/XDG in the temp dir)
//   MEMORY_LIVE_ENGINE=codex …                                  (Codex on your ChatGPT login)
//   MEMORY_LIVE_CASES=correctie,ruis  → only cases whose id contains one of these words
import { startTestApp } from '../helpers.ts';
import { EVAL_SET, runEvalCase, summarize } from '../memory-eval-set.ts';

const ENGINE = process.env.MEMORY_LIVE_ENGINE || 'claude';
const KIND = { claude: 'claude-code', codex: 'codex-cli', opencode: 'opencode' }[ENGINE];
const MODEL = process.env.MEMORY_LIVE_MODEL || { claude: 'haiku', codex: 'default', opencode: 'opencode/big-pickle' }[ENGINE];
const only = (process.env.MEMORY_LIVE_CASES || '').split(',').filter(Boolean);
const cases = EVAL_SET.filter((c) => !only.length || only.some((w) => c.id.includes(w)));
const log = (...a) => console.log(...a);

async function withEngine(fn) {
  const t = await startTestApp();
  try {
    const p = await t.api('POST', '/providers', { kind: KIND, config: process.env.OPENCODE_BIN && ENGINE === 'opencode' ? { path: process.env.OPENCODE_BIN } : {} });
    await t.api('PUT', '/memory/settings', { extractor: 'free', engine: { providerId: p.id, model: MODEL } });
    const eng = await t.api('GET', '/memory/engine');
    if (!eng.engine) throw new Error(`Geen gratis engine beschikbaar (${KIND}): niet geïnstalleerd, niet ingelogd, betaald of tijdelijk beperkt`);
    return await fn(t, eng.engine);
  } finally {
    await t.close();
  }
}

const results = { engine: null, eval: {}, scenario: {}, calls: [], cost: 0 };

// ---- 1. evaluation set: patterns (no model) vs. model
for (const mode of ['heuristic', 'model']) {
  const scores = [];
  for (const c of cases) {
    if (mode === 'heuristic') {
      const t = await startTestApp();
      try {
        await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
        const a = await t.agent();
        scores.push(await runEvalCase(t, a.id, c));
      } finally {
        await t.close();
      }
    } else {
      await withEngine(async (t, eng) => {
        results.engine = eng.label;
        const a = await t.agent();
        const s = await runEvalCase(t, a.id, c);
        scores.push(s);
        const stats = await t.api('GET', '/memory/engine');
        for (const u of t.app.ctx.store.all("SELECT cost FROM usage_log WHERE provider_id = ?", eng.providerId)) results.cost += u.cost || 0;
        if (stats.today.calls) results.calls.push({ case: c.id, ms: stats.today.avgMs, calls: stats.today.calls, input: stats.today.input, output: stats.today.output });
        log(`  ${c.id.padEnd(28)} tp=${s.tp} fp=${s.fp} fn=${s.fn}${s.supersedeOk === null ? '' : ` vervangen=${s.supersedeOk}`}${s.violations.length ? ' SCHENDING ' + s.violations.join('; ') : ''} | ${s.learned.join(' || ')}`);
      });
    }
  }
  const sum = summarize(scores);
  results.eval[mode] = sum;
  log(`[eval] ${mode === 'model' ? `model (${results.engine})` : 'vaste patronen'}: P=${sum.precision.toFixed(2)} R=${sum.recall.toFixed(2)} (tp ${sum.tp}, fp ${sum.fp}, fn ${sum.fn}, actief fout ${sum.activeFp}), correcties ${sum.corrections}, schendingen ${sum.violations.length}`);
  if (mode === 'model') for (const s of scores.filter((x) => x.fp || x.fn)) log(`   - ${s.id}: fp ${s.fp} fn ${s.fn} | ${s.learned.join(' || ')}`);
}

// ---- 2. scenario
await withEngine(async (t, eng) => {
  const S = results.scenario;
  const st = t.app.ctx.store;
  const svc = t.app.ctx.services.memory.svc;
  const me = t.app.ctx.auth.owner().id;
  const d = (await t.api('POST', '/memory/dossiers', { title: 'Velo Vintage', summary: 'Fietsenwinkel in Haarlem; nieuwe webshop in de maak.' })).dossier;
  const a = await t.agent({ name: 'Baas' });
  const th = await t.api('POST', '/threads', { agentId: a.id });
  t.script.push({ text: 'Fijn, genoteerd.' }, { text: 'Klinkt als een goed plan.' });
  let t0 = Date.now();
  await t.say(th.id, 'Even wat over mij: ik woon in Utrecht en ik werk als marketeer bij Raamwinkel. Ik hou van korte antwoorden zonder emoji.');
  await t.say(th.id, 'Voor Velo Vintage hebben we besloten om de webshop naar Shopify over te zetten. De lancering is op 1 maart en Mark levert de productfoto’s vóór 15 februari aan.');
  await t.app.ctx.services.memory.drain();
  S.learnMs = Date.now() - t0;
  const learned = (await t.api('GET', '/memory/learned')).items;
  S.learned = learned.map((i) => `${i.status === 'active' ? '' : `(${i.status}) `}${i.content} [${i.scope}]`);
  log('\n[scenario] geleerd na het gesprek:', S.learned);
  const map = await t.api('GET', `/memory/thread/${th.id}/learned-map`);
  S.undoLines = Object.values(map.byMessage).flat().filter((i) => i.changeId).length;

  t.script.push({ text: 'Gefeliciteerd!' });
  t0 = Date.now();
  await t.say(th.id, 'O ja, ik woon niet meer in Utrecht maar in Amersfoort.');
  await t.app.ctx.services.memory.drain();
  S.correctionMs = Date.now() - t0;
  const all = (await t.api('GET', '/memory/items?scope=about_you&status=all')).items;
  const cur = all.find((i) => i.status === 'active' && /amersfoort/i.test(i.content));
  const old = all.find((i) => /utrecht/i.test(i.content));
  S.correction = { now: cur?.content, old: old?.content, oldStatus: old?.status, supersedes: cur?.supersedes_id === old?.id };
  log('[scenario] correctie:', S.correction);

  // Duplicates and a contradiction for the maintenance run (as if learned weeks apart).
  const add = (content, extra = {}) => svc.insertItem({ user_id: me, scope: 'about_you', content, source_trust: 'user', source_kind: 'user', created_by: 'user', ...extra });
  const w1 = add('Ik wandel graag in de bergen', { type: 'preference', created_at: new Date(Date.now() - 40 * 864e5).toISOString() });
  const w2 = add('Wandelen in de bergen vind ik heerlijk', { type: 'preference' });
  const k1 = add('Ik drink elke ochtend koffie', { type: 'preference', created_at: new Date(Date.now() - 30 * 864e5).toISOString(), valid_from: new Date(Date.now() - 30 * 864e5).toISOString() });
  const k2 = add('Ik drink sinds kort geen koffie meer, alleen thee', { type: 'preference' });
  t0 = Date.now();
  const rep = await t.api('POST', '/memory/maintenance', {});
  S.maintenanceMs = Date.now() - t0;
  S.report = { engine: rep.engine, calls: rep.calls, latency_ms: rep.latency_ms, cost: rep.cost, summary: rep.summary, lines: rep.lines.map((l) => `${l.op}: ${l.text}`) };
  log('[scenario] onderhoud:', S.report);
  const status = (id) => st.get('memory_items', id).status;
  S.merged = [status(w1.id), status(w2.id)].sort().join(',');
  S.contradiction = { old: status(k1.id), new: status(k2.id) };
  const full = await t.api('GET', `/memory/dossiers/${d.id}`);
  S.dossier = { summary: full.dossier.summary, events: full.events.map((e) => e.title), decisions: full.decisions.map((x) => x.title), actions: full.actions.map((x) => `${x.title} (${x.status})`) };
  log('[scenario] dossier na onderhoud:', S.dossier);
  S.reportsListed = (await t.api('GET', '/memory/reports')).length;
  const eng2 = await t.api('GET', '/memory/engine');
  S.engineToday = eng2.today;
  for (const u of st.all('SELECT cost FROM usage_log WHERE provider_id = ?', eng.providerId)) results.cost += u.cost || 0;
});

const ms = results.calls.map((c) => c.ms).filter(Boolean);
log('\n=== samenvatting ===');
log(JSON.stringify({ engine: results.engine, eval: results.eval, scenario: results.scenario, latency: { calls: ms.length, avgMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : 0, maxMs: Math.max(0, ...ms) }, extraCostUsd: results.cost }, null, 1));
