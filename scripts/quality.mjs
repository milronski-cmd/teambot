// Quality run (plan 0.4, package M): the fixed test set in tests/quality against one engine and model, in a temporary
// TeamBot server. Your own TeamBot is never touched: own data folder and APPDATA in the temp folder, own port; OpenCode
// gets its own HOME/XDG folders (never ~/.local/share/opencode). Writes docs/quality/<date>-<engine>-<model>.{json,md}
// and merges the per-model scores into docs/quality/scores.json (for the free-model router).
//
//   npm run quality -- --engine ollama [--model <name>] [--only <ids or teams, comma-separated>]
//   npm run quality -- --engine opencode [--model opencode/big-pickle] [--opencode-bin <opencode.exe>] --only …
//   npm run quality -- --engine claude|codex [--model …]        (subscription engines: uses your own login and limits)
// Options: --timeout <min per task, 15>  --judge auto|none|<ollama model>  --judge-fast  --repeat <n>  --port <4822>
//          --tools files,shell  --label <text>  --out docs/quality  --no-write  --keep  --list
//   npm run quality -- --recheck docs/quality/<run>.json   (score the saved attempts again with the current checkers;
//          no model needed: judge verdicts are reused)
// What each bot left behind (new and changed files, its text, its questions) is saved in docs/quality/attempts/<run>/.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { TASKS, HIDDEN_DIR, inputDirs } from '../tests/quality/tasks.ts';
import { DEFAULT_ANSWER, PASS_AT, evaluate, scoreChecks } from '../tests/quality/checks.ts';
import { RUN_FORMAT, rebuildAll, renderMarkdown, slug, totals, writeRun } from './quality-report.mjs';
import { makeJudge } from './quality-judge.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENGINES = {
  ollama: { kind: 'ollama', label: 'Ollama (lokaal)' },
  opencode: { kind: 'opencode', label: 'OpenCode', defaultModel: 'opencode/big-pickle' },
  claude: { kind: 'claude-code', label: 'Claude Code', defaultModel: '' },
  codex: { kind: 'codex-cli', label: 'Codex', defaultModel: '' },
};

// ------------------------------------------------------------------ arguments

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : def;
};
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (flag('list')) {
  for (const t of TASKS) log(`${t.id.padEnd(34)} ${t.team.padEnd(15)} ${t.honesty ? 'eerlijkheid ' : ''}${t.title}`);
  process.exit(0);
}
const RECHECK = opt('recheck');
const engineId = opt('engine');
const ENGINE = ENGINES[engineId];
if (!ENGINE && !RECHECK) {
  log(`Kies een motor: --engine ${Object.keys(ENGINES).join('|')}  (--list toont de taken)`);
  process.exit(2);
}
const PORT = Number(opt('port', '4822'));
if ([4747, 4748].includes(PORT)) {
  log('Poort 4747/4748 is van je eigen TeamBot; kies een andere poort.');
  process.exit(2);
}
const TIMEOUT_MS = Number(opt('timeout', '15')) * 60_000;
const REPEAT = Math.max(1, Number(opt('repeat', '1')) || 1);
const TOOL_GROUPS = opt('tools', 'files,shell').split(',').map((s) => s.trim()).filter(Boolean);
const OLLAMA = (opt('ollama-url', process.env.OLLAMA_HOST && /^https?:/.test(process.env.OLLAMA_HOST) ? process.env.OLLAMA_HOST : 'http://127.0.0.1:11434')).replace(/\/+$/, '');
const ONLY = opt('only', '');
const OUT = path.resolve(ROOT, opt('out', 'docs/quality'));
const tokens = ONLY.split(',').map((s) => s.trim()).filter(Boolean);
const selected = tokens.length ? TASKS.filter((t) => tokens.some((w) => t.id === w || t.id.startsWith(w) || t.team === w)) : TASKS;
if (!selected.length) {
  log(`Geen taken gevonden voor --only ${ONLY}`);
  process.exit(2);
}

// ------------------------------------------------------------------ helpers

const json = async (url, init = {}, ms = 10_000) => {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => resolve(false));
    s.setTimeout(1500, () => {
      s.destroy();
      resolve(false);
    });
  });
}

/** OpenCode: the given binary, else a system install, else the copy OpenBot keeps (only read and run, never changed). */
function findOpencode() {
  const given = opt('opencode-bin', process.env.OPENCODE_BIN || process.env.QUALITY_OPENCODE_BIN);
  if (given) return fs.existsSync(given) ? given : null;
  const exe = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
  const cands = [path.join(os.homedir(), '.opencode', 'bin', exe)];
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const ob = path.join(appData, 'OpenBot', 'provider-runtimes', 'opencode', `${process.platform}-${process.arch}`);
  try {
    for (const v of fs.readdirSync(ob).sort().reverse()) cands.push(path.join(ob, v, 'bin', exe));
  } catch {
    /* no OpenBot copy */
  }
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['opencode'], { encoding: 'utf8' });
  if (which.status === 0) cands.push(...which.stdout.split(/\r?\n/).filter(Boolean));
  return cands.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) || null;
}

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

/** Hash of the task set (tasks, checkers, inputs, hidden checks): scores are only comparable within one version. */
function taskSetId() {
  const h = crypto.createHash('sha256');
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        h.update(path.relative(ROOT, p).replace(/\\/g, '/'));
        h.update(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'));
      }
    }
  };
  const q = path.join(ROOT, 'tests', 'quality');
  for (const f of ['tasks.ts', 'checks.ts']) {
    h.update(f);
    h.update(fs.readFileSync(path.join(q, f), 'utf8').replace(/\r\n/g, '\n'));
  }
  walk(path.join(q, 'fixtures'));
  walk(path.join(q, 'hidden'));
  return h.digest('hex').slice(0, 12);
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}

function rmTemp(d) {
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      return true;
    } catch {
      spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},1000)']);
    }
  }
  return false;
}

async function ollamaModels() {
  const tags = await json(`${OLLAMA}/api/tags`, {}, 5000).catch(() => null);
  if (!tags) return null;
  const ps = await json(`${OLLAMA}/api/ps`, {}, 5000).catch(() => ({ models: [] }));
  const loaded = new Set((ps.models || []).map((m) => m.name));
  const out = [];
  for (const m of tags.models || []) {
    const show = await json(`${OLLAMA}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: m.name }) }, 10_000).catch(() => ({}));
    const loadedCtx = (ps.models || []).find((x) => x.name === m.name)?.context_length;
    const numCtx = Number(String(show.parameters || '').match(/(?:^|\n)\s*num_ctx\s+(\d+)/)?.[1]) || undefined;
    out.push({ name: m.name, digest: m.digest, size: m.size, details: m.details, tools: (show.capabilities || []).includes('tools'), loaded: loaded.has(m.name), context: loadedCtx || numCtx });
  }
  return out;
}

// ------------------------------------------------------------------ attempts: save, restore, score again

/** Files under a folder, as relative paths with forward slashes (no node_modules/.git). */
function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(path.relative(dir, p).replace(/\\/g, '/'));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

const ATTEMPT_META = ['_reply.md', '_attempt.json'];

/** What the bot left behind: new and changed files (not the untouched inputs), its text, questions, deleted inputs. */
function archiveAttempt(dest, task, work, info) {
  fs.mkdirSync(dest, { recursive: true });
  const inputs = new Map();
  for (const d of inputDirs(task)) for (const rel of listFiles(d)) inputs.set(rel, fs.readFileSync(path.join(d, rel)));
  const now = listFiles(work);
  const skipped = [];
  for (const rel of now) {
    const buf = fs.readFileSync(path.join(work, rel));
    if (inputs.get(rel)?.equals(buf)) continue;
    if (buf.length > 256_000 || ATTEMPT_META.includes(rel)) {
      skipped.push(rel);
      continue;
    }
    fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
    fs.writeFileSync(path.join(dest, rel), buf);
  }
  fs.writeFileSync(path.join(dest, '_reply.md'), info.reply || '');
  fs.writeFileSync(path.join(dest, '_attempt.json'), JSON.stringify({ task: task.id, final: info.final, questions: info.questions, deleted: [...inputs.keys()].filter((rel) => !now.includes(rel)), skipped, status: info.status, error: info.error }, null, 1) + '\n');
}

/** A work folder as the bot left it, rebuilt from the inputs and a saved attempt. */
function restoreAttempt(task, src, dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const d of inputDirs(task)) fs.cpSync(d, dir, { recursive: true });
  const info = JSON.parse(fs.readFileSync(path.join(src, '_attempt.json'), 'utf8'));
  for (const rel of listFiles(src).filter((r) => !ATTEMPT_META.includes(r))) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.copyFileSync(path.join(src, rel), path.join(dir, rel));
  }
  for (const rel of info.deleted || []) fs.rmSync(path.join(dir, rel), { force: true });
  const reply = fs.readFileSync(path.join(src, '_reply.md'), 'utf8');
  return { dir, fixtureDirs: inputDirs(task), hiddenDir: HIDDEN_DIR(task), reply, final: info.final || '', questions: info.questions || [] };
}

/** One task result from its attempts (with --repeat: mean score, passed when most attempts passed). */
function aggregate(task, engine, attempts) {
  const scored = attempts.filter((a) => typeof a.score === 'number');
  const main = attempts.at(-1);
  return {
    engine: engine.id,
    model: engine.model,
    task: task.id,
    team: task.team,
    honesty: !!task.honesty,
    title: task.title,
    klaarAls: task.klaarAls,
    ...main,
    score: scored.length ? Math.round((scored.reduce((s, a) => s + a.score, 0) / scored.length) * 1000) / 1000 : null,
    pass: scored.length ? scored.filter((a) => a.pass).length / scored.length >= 0.5 : false,
    passRate: scored.length ? scored.filter((a) => a.pass).length / scored.length : null,
    ms: Math.round(attempts.reduce((s, a) => s + (a.ms || 0), 0) / attempts.length),
    attempts: attempts.length > 1 ? attempts.map((a) => ({ score: a.score, pass: a.pass, ms: a.ms, status: a.status, dir: a.dir })) : undefined,
  };
}

/** Score a saved run again with the current checkers (judge verdicts are reused, so no model is needed). */
async function recheck(file) {
  const run = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (run.format !== RUN_FORMAT) throw new Error(`${file} is geen meting (${RUN_FORMAT})`);
  const root = path.join(path.dirname(file), 'attempts', run.id);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-quality-recheck-'));
  const before = { taskSet: run.taskSet.id, passed: run.total.passed, score: run.total.score };
  let missingAttempts = 0;
  // --rejudge: ask the judge again only where its verdict is missing (it failed during the run); one call at a time.
  const judgeModel = flag('rejudge') ? opt('judge', run.judge?.model || (run.engine.id === 'ollama' ? run.engine.model : '')) : '';
  const J = judgeModel ? makeJudge(judgeModel, { base: OLLAMA, think: !flag('judge-fast') }) : null;
  try {
    const out = [];
    for (const r of run.results) {
      const task = TASKS.find((t) => t.id === r.task);
      if (!task) {
        out.push(r);
        continue;
      }
      const list = r.attempts ? r.attempts.map((x, n) => ({ ...x, dir: x.dir || `${r.task}-${n + 1}` })) : [{ ...r, dir: r.dir || r.task }];
      const redone = [];
      for (const old of list) {
        const src = path.join(root, old.dir);
        if (!fs.existsSync(path.join(src, '_attempt.json'))) {
          missingAttempts++;
          redone.push(old);
          continue;
        }
        const prevChecks = old.checks || r.checks || [];
        const missingVerdict = (x) => x.judge && (x.skipped || /geen antwoord\)/.test(x.detail || ''));
        const needJudge = !!J && prevChecks.some(missingVerdict);
        const a = restoreAttempt(task, src, path.join(tmp, old.dir));
        const ev = await evaluate(task, needJudge ? { ...a, judge: J.judge } : a);
        // The judge is not asked again: its verdict from the run counts (except where it was missing and --rejudge).
        for (const c of ev.checks.filter((x) => x.judge)) {
          const prev = prevChecks.find((x) => x.id === c.id);
          if (prev && !(needJudge && missingVerdict(prev))) Object.assign(c, { ok: prev.ok, skipped: prev.skipped, detail: prev.detail });
        }
        const s = scoreChecks(ev.checks);
        redone.push(old.status === 'limit' ? old : { ...old, checks: ev.checks, criticalFailed: s.criticalFailed, score: s.score, pass: s.pass });
      }
      const agg = aggregate(task, run.engine, redone);
      out.push({ ...r, ...agg, attempts: r.attempts ? agg.attempts : undefined });
    }
    run.results = out;
    if (J?.stats.calls) {
      // Errors = verdicts that are still missing now (a failed call that was asked again successfully no longer counts).
      const stillMissing = out.flatMap((r) => r.checks || []).filter((c) => c.judge && c.skipped && /niet gelukt/.test(c.detail || '')).length;
      run.judge = { ...(run.judge || J.stats), calls: (run.judge?.calls || 0) + J.stats.calls, errors: stillMissing, rejudged: J.stats.calls - J.stats.errors };
    }
  } finally {
    rmTemp(tmp);
  }
  run.taskSet = { id: taskSetId(), tasks: TASKS.length };
  run.total = totals(run.results);
  run.rechecked = [...(run.rechecked || []), { at: new Date().toISOString(), from: before.taskSet, to: run.taskSet.id, before: { passed: before.passed, score: before.score } }];
  fs.writeFileSync(file, JSON.stringify(run, null, 1) + '\n');
  fs.writeFileSync(file.replace(/\.json$/, '.md'), renderMarkdown(run));
  rebuildAll(path.dirname(file));
  log(`${run.id}: opnieuw beoordeeld met testset ${run.taskSet.id} (was ${before.taskSet}): ${before.passed} → ${run.total.passed} geslaagd, score ${before.score} → ${run.total.score}${missingAttempts ? ` · ${missingAttempts} poging(en) zonder opgeslagen werk, ongewijzigd` : ''}`);
}

if (RECHECK) {
  try {
    await recheck(path.resolve(ROOT, RECHECK));
  } catch (e) {
    log(`Fout: ${e?.message || e}`);
    process.exitCode = 1;
  }
  process.exit();
}

// ------------------------------------------------------------------ main

const startedAt = new Date();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-quality-'));
const dirs = { data: path.join(tmp, 'data'), appdata: path.join(tmp, 'appdata'), work: path.join(tmp, 'work'), oc: path.join(tmp, 'opencode') };
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
let server = null;
let interrupted = false;
const notes = [];

const shutdown = () => {
  killTree(server);
  if (!flag('keep')) rmTemp(tmp);
};
process.on('SIGINT', () => {
  interrupted = true;
  log('\nAfgebroken; tijdelijke TeamBot wordt gestopt.');
  shutdown();
  process.exit(130);
});

try {
  if (await portInUse(PORT)) throw new Error(`Poort ${PORT} is al in gebruik. Kies een andere met --port.`);

  // ---- engine preparation (before the server starts: OpenCode needs its isolated folders in the server's env)
  const env = { ...process.env, TEAMBOT_DATA: dirs.data, APPDATA: dirs.appdata, TEAMBOT_PORT: String(PORT), TEAMBOT_MARKET_OFFLINE: '1', TEAMBOT_MODE: 'desktop' };
  delete env.TEAMBOT_HOST;
  const engine = { id: engineId, kind: ENGINE.kind, label: ENGINE.label, model: opt('model', ENGINE.defaultModel ?? ''), version: '', details: '' };
  let providerConfig = {};
  let judgeModel = null;
  const om = await ollamaModels();
  if (engineId === 'ollama') {
    if (!om) throw new Error(`Ollama is niet bereikbaar op ${OLLAMA}.`);
    const tool = om.filter((m) => m.tools).sort((x, y) => (y.size || 0) - (x.size || 0));
    if (!engine.model) {
      // Default: the largest tool-capable model that is already loaded (no reload of a model Ollama shares with your
      // own TeamBot), else the largest one. Better: name it with --model.
      const pick = tool.find((m) => m.loaded) || tool[0];
      if (!pick) throw new Error('Geen Ollama-model met tools gevonden (ollama list).');
      engine.model = pick.name;
    }
    const m = om.find((x) => x.name === engine.model || x.name === `${engine.model}:latest`);
    if (!m) throw new Error(`Model ${engine.model} staat niet in Ollama (ollama list).`);
    if (!m.tools) notes.push(`Let op: Ollama meldt geen tool-ondersteuning voor ${m.name}.`);
    engine.model = m.name;
    engine.digest = m.digest?.slice(0, 12);
    engine.details = [m.details?.parameter_size, m.details?.quantization_level, m.context ? `context ${m.context}` : ''].filter(Boolean).join(', ');
    engine.version = (await json(`${OLLAMA}/api/version`, {}, 5000).catch(() => ({}))).version || '';
  } else if (engineId === 'opencode') {
    const bin = findOpencode();
    if (!bin) throw new Error('OpenCode niet gevonden; geef het pad met --opencode-bin.');
    providerConfig = { path: bin };
    for (const d of ['data/opencode', 'config/opencode', 'state', 'cache', 'home']) fs.mkdirSync(path.join(dirs.oc, d), { recursive: true });
    fs.writeFileSync(path.join(dirs.oc, 'config/opencode/opencode.json'), JSON.stringify({ autoupdate: false }));
    Object.assign(env, {
      XDG_DATA_HOME: path.join(dirs.oc, 'data'),
      XDG_CONFIG_HOME: path.join(dirs.oc, 'config'),
      XDG_STATE_HOME: path.join(dirs.oc, 'state'),
      XDG_CACHE_HOME: path.join(dirs.oc, 'cache'),
      HOME: path.join(dirs.oc, 'home'),
      OPENCODE_DISABLE_AUTOUPDATE: '1',
    });
    const v = spawnSync(bin, ['--version'], { env, encoding: 'utf8', timeout: 60_000, windowsHide: true });
    engine.version = (v.stdout || '').match(/\d+\.\d+\.\d+/)?.[0] || '';
    engine.details = `eigen HOME/XDG in de tijdelijke map; ${/[\\/]OpenBot[\\/]/i.test(bin) ? 'de kopie van OpenBot' : opt('opencode-bin') || process.env.OPENCODE_BIN ? 'opgegeven programma' : 'systeeminstallatie'}`;
  }
  const judgeOpt = opt('judge', 'auto');
  if (judgeOpt !== 'none' && om) {
    if (judgeOpt !== 'auto') judgeModel = judgeOpt;
    else if (engineId === 'ollama') judgeModel = engine.model;
    else {
      // The strongest model that is already loaded (a small model that happens to be loaded is a poor judge).
      const bySize = [...om].sort((x, y) => (y.size || 0) - (x.size || 0));
      judgeModel = (bySize.find((m) => m.tools && m.loaded) || bySize.find((m) => m.tools) || bySize[0])?.name || null;
    }
  }
  // The judge thinks first (slower, but without it a judge passed an answer with an invented delivery policy).
  const J = judgeModel ? makeJudge(judgeModel, { base: OLLAMA, think: flag('judge-fast') ? false : true }) : null;

  // ---- temporary TeamBot server
  log(`Tijdelijke TeamBot op poort ${PORT} (data: ${dirs.data})`);
  server = spawn(process.execPath, ['--import', 'tsx', 'server/main.ts', '--mode', 'desktop', '--port', String(PORT), '--host', '127.0.0.1'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  const serverLog = fs.createWriteStream(path.join(tmp, 'server.log'));
  let token = '';
  server.stdout.on('data', (b) => {
    serverLog.write(b);
    token ||= String(b).match(/#token=([A-Za-z0-9_-]+)/)?.[1] || '';
  });
  server.stderr.on('data', (b) => serverLog.write(b));
  const base = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 240 && !token; i++) {
    if (server.exitCode !== null) throw new Error(`De tijdelijke TeamBot stopte meteen (zie ${path.join(tmp, 'server.log')}).`);
    await sleep(250);
  }
  if (!token) throw new Error('De tijdelijke TeamBot startte niet binnen 60 s.');
  const health = await json(`${base}/healthz`);
  const api = async (method, p, body) => {
    const r = await fetch(`${base}/api${p}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120_000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${p} → ${r.status}: ${j.error || ''}`);
    return j;
  };
  await api('PUT', '/settings', { language: 'nl' });
  const provider = await api('POST', '/providers', { kind: ENGINE.kind, config: providerConfig });
  const test = await api('POST', `/providers/${provider.id}/test`).catch((e) => ({ ok: false, detail: e.message }));
  if (!test.ok) throw new Error(`${ENGINE.label} werkt niet in de tijdelijke TeamBot: ${test.detail || ''} ${test.hint || ''}`.trim());
  if (!engine.version) engine.version = String(test.detail || '').match(/\d+\.\d+\.\d+/)?.[0] || '';
  if (!engine.model && engineId === 'opencode') engine.model = provider.config?.defaultModel || ENGINE.defaultModel;

  const teambot = { version: health.version, commit: git(['rev-parse', '--short', 'HEAD']), branch: git(['rev-parse', '--abbrev-ref', 'HEAD']), dirty: !!git(['status', '--porcelain', '--', 'server', 'ui', 'tests/quality', 'scripts']) };
  log(`${engine.label} ${engine.version} · model ${engine.model || '(standaard)'} · ${selected.length} taak/taken × ${REPEAT} · beoordelaar: ${J ? J.stats.label : 'geen'}`);
  log(`TeamBot ${teambot.version} (git ${teambot.commit}${teambot.dirty ? ', met lokale wijzigingen' : ''})\n`);
  // The task set as it is now (the checkers used in this run), and a run id that is not taken yet.
  const setId = taskSetId();
  const baseId = `${startedAt.toISOString().slice(0, 10)}-${engine.id}-${slug(engine.model || 'standaard')}${opt('label') ? `-${slug(opt('label'))}` : ''}`;
  let runId = baseId;
  for (let k = 2; fs.existsSync(path.join(OUT, `${runId}.json`)) || fs.existsSync(path.join(OUT, 'attempts', runId)); k++) runId = `${baseId}-${k}`;
  const attemptsRoot = flag('no-write') ? path.join(tmp, 'attempts') : path.join(OUT, 'attempts', runId);

  // ---- one task
  async function runTask(task, n) {
    const dirName = REPEAT > 1 ? `${task.id}-${n + 1}` : task.id;
    const work = path.join(dirs.work, dirName);
    fs.mkdirSync(work, { recursive: true });
    for (const d of inputDirs(task)) fs.cpSync(d, work, { recursive: true });
    const agent = await api('POST', '/agents', { name: task.bot.name, role: task.bot.role, provider_id: provider.id, model: engine.model, access_mode: 'auto', tool_groups: TOOL_GROUPS, workspace: work, settings: { fallbacks: [], onLimit: 'stop' } });
    const thread = await api('POST', '/threads', { agentId: agent.id, title: task.id });
    const questions = [];
    const decisions = [];
    const t0 = Date.now();
    await api('POST', `/threads/${thread.id}/messages`, { content: task.prompt });
    let sawRun = false;
    let idleSince = 0;
    let timedOut = false;
    for (;;) {
      if (Date.now() - t0 > TIMEOUT_MS) {
        timedOut = true;
        await api('POST', `/threads/${thread.id}/stop`, {}).catch(() => {});
        await sleep(3000);
        break;
      }
      for (const ap of await api('GET', '/approvals').catch(() => [])) {
        if (ap.status !== 'pending' || (ap.thread_id !== thread.id && ap.agent_id !== agent.id)) continue;
        if (ap.kind === 'question') {
          questions.push(String(ap.input?.question || ap.summary || ''));
          await api('POST', `/approvals/${ap.id}`, { decision: 'approve', answer: task.answer || DEFAULT_ANSWER }).catch(() => {});
        } else {
          // The work folder is a throwaway copy: the bot's own work there is fine; anything that leaves the pc is not.
          const allow = ap.risk !== 'danger' || ap.tool === 'delete_file';
          decisions.push(`${ap.tool}:${allow ? 'ja' : 'nee'}`);
          await api('POST', `/approvals/${ap.id}`, { decision: allow ? 'approve' : 'deny' }).catch(() => {});
        }
      }
      const t = await api('GET', `/threads/${thread.id}?limit=1`).catch(() => ({ runs: [{}] }));
      if (t.runs?.length) {
        sawRun = true;
        idleSince = 0;
      } else {
        idleSince ||= Date.now();
        if ((sawRun || Date.now() - t0 > 20_000) && Date.now() - idleSince > 2500) break;
      }
      await sleep(1000);
    }
    const ms = Date.now() - t0;
    const full = await api('GET', `/threads/${thread.id}?limit=300`);
    const mine = full.messages.filter((m) => m.role === 'assistant' && m.author_id === agent.id);
    const texts = mine.map((m) => String(m.content || '').trim()).filter(Boolean);
    const errors = mine.map((m) => m.parts?.error).filter(Boolean);
    const models = [...new Set(mine.map((m) => m.parts?.model).filter(Boolean))];
    const usage = mine.reduce((u, m) => ({ input: u.input + (m.usage?.input || 0), output: u.output + (m.usage?.output || 0) }), { input: 0, output: 0 });
    const steps = mine.reduce((n, m) => n + (m.parts?.toolCalls?.length || 0) + (m.parts?.activity?.length || 0), 0);
    const tools = [...new Set(mine.flatMap((m) => (m.parts?.toolCalls || []).map((c) => c.name)))];
    const lastError = errors.at(-1) || '';
    const limit = /limiet|limit|quota|429|rate.?limit|free-limit|te veel verzoeken/i.test(lastError) && !texts.length;
    const status = limit ? 'limit' : timedOut ? 'timeout' : lastError && !texts.length ? 'engine-error' : 'ok';
    const attempt = { dir: work, fixtureDirs: inputDirs(task), hiddenDir: HIDDEN_DIR(task), reply: texts.join('\n\n'), final: texts.at(-1) || '', questions, judge: J?.judge };
    const ev = await evaluate(task, attempt);
    try {
      archiveAttempt(path.join(attemptsRoot, dirName), task, work, { reply: attempt.reply, final: attempt.final, questions, status, error: lastError || undefined });
    } catch (e) {
      notes.push(`Het werk van ${dirName} kon niet worden bewaard: ${e?.message || e}`);
    }
    return {
      dir: dirName,
      status,
      score: limit ? null : ev.score,
      pass: limit ? false : ev.pass,
      ms,
      checks: ev.checks,
      criticalFailed: ev.criticalFailed,
      error: lastError ? String(lastError).slice(0, 400) : undefined,
      questions,
      approvals: decisions,
      modelsSeen: models,
      usage,
      toolSteps: steps,
      tools,
      final: attempt.final.slice(0, 1500),
      files: fs.readdirSync(work, { recursive: true }).map(String).filter((f) => !/node_modules/.test(f)).slice(0, 60),
    };
  }

  // ---- all tasks
  const results = [];
  let i = 0;
  for (const task of selected) {
    i++;
    const attempts = [];
    for (let n = 0; n < REPEAT; n++) {
      process.stdout.write(`[${i}/${selected.length}${REPEAT > 1 ? ` #${n + 1}` : ''}] ${task.id.padEnd(34)} `);
      let a;
      try {
        a = await runTask(task, n);
      } catch (e) {
        a = { status: 'engine-error', score: 0, pass: false, ms: 0, checks: [], criticalFailed: [], error: String(e?.message || e).slice(0, 400), questions: [], approvals: [], modelsSeen: [], usage: { input: 0, output: 0 }, toolSteps: 0, tools: [], final: '', files: [] };
      }
      attempts.push(a);
      const bad = a.checks.filter((c) => !c.ok && !c.skipped).map((c) => c.id);
      log(`${a.score === null ? '— niet beoordeeld' : `${a.pass ? '✔' : '✖'} ${a.score.toFixed(2)}`} (${Math.round(a.ms / 1000)} s${a.status !== 'ok' ? `, ${a.status}` : ''})${bad.length ? ` mis: ${bad.join(', ')}` : ''}${a.error && a.status !== 'ok' ? ` — ${a.error.slice(0, 120)}` : ''}`);
      if (a.status === 'limit') break;
    }
    results.push(aggregate(task, engine, attempts));
    if (attempts.at(-1).status === 'limit' && engineId !== 'ollama') {
      notes.push(`De motor bereikte zijn limiet bij ${task.id}; de overige taken zijn niet gedraaid.`);
      break;
    }
  }

  const finishedAt = new Date();
  const run = {
    format: RUN_FORMAT,
    id: runId,
    label: opt('label', ''),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    ms: finishedAt - startedAt,
    teambot,
    engine,
    judge: J ? J.stats : null,
    taskSet: { id: setId, tasks: TASKS.length },
    only: ONLY || undefined,
    repeat: REPEAT,
    passAt: PASS_AT,
    settings: { port: PORT, accessMode: 'auto', toolGroups: TOOL_GROUPS, timeoutMin: TIMEOUT_MS / 60_000, node: process.version, os: `${os.type()} ${os.release()} ${os.arch()}` },
    total: totals(results),
    notes,
    results,
  };
  const t = run.total;
  log(`\n${engine.label} · ${engine.model}: ${t.passed} van ${t.scored} geslaagd, gemiddelde score ${t.score ?? '—'} (${Math.round(run.ms / 60000)} min)`);
  if (!flag('no-write')) {
    const w = writeRun(run, OUT);
    log(`Verslag: ${path.relative(ROOT, w.md)}\nGegevens: ${path.relative(ROOT, w.json)} · scores: ${path.relative(ROOT, w.scores)}`);
  }
  if (flag('keep')) log(`Tijdelijke map bewaard: ${tmp}`);
} catch (e) {
  log(`\nFout: ${e?.message || e}`);
  process.exitCode = 1;
} finally {
  if (!interrupted) shutdown();
}
