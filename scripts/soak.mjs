// Soak test (parity 17.1): a TeamBot server of its own runs for hours under a light, realistic load with a fake engine,
// while the stall meter (server/modules/health) and the operating system are sampled. Optionally another program is
// sampled next to it, READ-ONLY (memory, CPU, handles from the OS; no interaction), e.g. OpenBot (OpenBot.exe).
//
//   npm run soak -- --hours 48 --compare OpenBot
//   npm run soak -- --minutes 5                       (a short smoke run)
// Options: --hours N | --minutes N, --compare <name or PID> (more than once allowed), --port 4765,
//          --sample-seconds 60, --out docs/quality
// Writes <out>/soak-<date>.md and .json (a checkpoint every 15 minutes, so an interrupted run still leaves a report).
// The server gets a temporary TEAMBOT_DATA, APPDATA and HOME, and is stopped by its PID at the end.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshot, selectTree, totals } from './soak/procstats.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const compare = argv.flatMap((a, i) => (a === '--compare' && argv[i + 1] ? [argv[i + 1]] : []));
const minutes = opt('minutes') ? Number(opt('minutes')) : Number(opt('hours', '1')) * 60;
const PORT = Number(opt('port', '4765'));
const SAMPLE_S = Number(opt('sample-seconds', '60'));
const OUT = path.resolve(ROOT, opt('out', 'docs/quality'));
if (!(minutes > 0)) throw new Error('Geef --hours N of --minutes N');
if ([4747, 4748].includes(PORT)) throw new Error('Poort 4747/4748 is van een geïnstalleerde TeamBot: kies een andere poort.');

const log = (s) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const startedAt = new Date();

// ---------------------------------------------------------------- the server, in an empty environment
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-soak-'));
const env = {
  ...process.env,
  TEAMBOT_DATA: path.join(home, 'data'),
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  HOME: home,
  USERPROFILE: home,
  XDG_DATA_HOME: path.join(home, 'xdg'),
  TEAMBOT_OFFLINE: '1',
  // No CLI engine, Ollama or other tool of this PC can be found: only node itself.
  PATH: [path.dirname(process.execPath), process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32') : '/usr/bin:/bin'].join(path.delimiter),
};
delete env.Path;
const child = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'scripts/soak/server.ts'), '--port', String(PORT)], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let serverLog = '';
child.stderr.on('data', (d) => (serverLog = (serverLog + d).slice(-20_000)));
const ready = await new Promise((resolve, reject) => {
  let buf = '';
  const to = setTimeout(() => reject(new Error(`server start time-out\n${serverLog}`)), 120_000);
  child.stdout.on('data', (d) => {
    buf += d;
    const line = buf.split('\n').find((l) => l.startsWith('{"ready"'));
    if (line) (clearTimeout(to), resolve(JSON.parse(line)));
  });
  child.on('exit', (c) => reject(new Error(`server stopped (${c})\n${serverLog}`)));
});
const { url: BASE, token: TOKEN } = ready;
log(`TeamBot (PID ${child.pid}) op ${BASE}, datamap ${env.TEAMBOT_DATA}`);

const ops = { chats: 0, chatErrors: 0, chatMs: [], attachments: 0, routineRuns: 0, memoryItems: 0, maintenance: 0, searches: 0, reads: 0, errors: [] };
const api = async (method, p, body, raw) => {
  const r = await fetch(BASE + '/api' + p, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(raw ? { 'content-type': raw.type } : body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: raw ? raw.data : body !== undefined ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status}: ${j.error || ''}`);
  return j;
};
const note = (e) => {
  ops.errors.push({ at: new Date().toISOString(), error: String(e?.message || e).slice(0, 300) });
  if (ops.errors.length > 200) ops.errors.shift();
};

// ---------------------------------------------------------------- set-up: three bots, a routine every 5 minutes
const prov = await api('POST', '/providers', { kind: 'soak-fake' });
const bots = [];
for (const name of ['Planner', 'Schrijver', 'Onderzoeker']) bots.push(await api('POST', '/agents', { name, provider_id: prov.id, model: 'fake-1', access_mode: 'auto' }));
const threads = [];
for (const b of bots) threads.push(await api('POST', '/threads', { agentId: b.id }));
await api('PUT', '/routines/settings', { maxRunsPerDay: 0, maxCostPerDayUsd: 0 }).catch(note);
const routine = await api('POST', '/routines', { name: 'Dagelijkse samenvatting (duurtest)', agent_id: bots[0].id, prompt: 'Vat de planning van vandaag samen.', timezone: 'Europe/Amsterdam', schedule: { kind: 'interval', everyMinutes: 5 }, options: { notify: 'never', maxRunsPerDay: 0, maxCostPerDayUsd: 0 } }).catch((e) => (note(e), null));

// The open app keeps a WebSocket: so does the soak (signed like the app signs it).
let ws = null;
async function connectWs() {
  try {
    const k = await api('GET', '/auth/url-key');
    const base = `/ws?tbs=${encodeURIComponent(k.sid)}&tbe=${Math.floor(Date.now() / 1000) + 600}`;
    const sig = crypto.createHmac('sha256', Buffer.from(k.key, 'base64url')).update(base).digest('base64url');
    ws?.close();
    ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}${base}&tbsig=${sig}`);
    ws.onerror = () => {};
  } catch (e) {
    note(e);
  }
}
await connectWs();

// ---------------------------------------------------------------- the load
let n = 0;
async function chat(attach) {
  const th = threads[n % threads.length];
  const t0 = Date.now();
  try {
    let attachments;
    if (attach) {
      const big = n % 2 === 0;
      const data = big ? crypto.randomBytes(150_000) : Buffer.from(`Notities ${n}\n`.repeat(400));
      const a = await api('POST', `/attachments?name=${big ? `foto-${n}.bin` : `notities-${n}.txt`}&threadId=${th.id}`, undefined, { type: big ? 'application/octet-stream' : 'text/plain', data });
      attachments = [a.id];
      ops.attachments++;
    }
    await api('POST', `/threads/${th.id}/messages`, { content: `Wat staat er vandaag op de planning voor ${['de klant', 'het project', 'de campagne'][n % 3]}? (${n})`, attachments });
    for (const end = Date.now() + 90_000; Date.now() < end; ) {
      await sleep(400);
      const t = await api('GET', `/threads/${th.id}?limit=2`);
      if (!t.runs.length) break;
    }
    ops.chats++;
    ops.chatMs.push(Date.now() - t0);
  } catch (e) {
    ops.chatErrors++;
    note(e);
  }
  n++;
}
const every = (s, fn, firstS = s) => {
  let busy = false;
  const go = async () => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (e) {
      note(e);
    } finally {
      busy = false;
    }
  };
  const first = setTimeout(go, firstS * 1000);
  const iv = setInterval(go, s * 1000);
  return () => (clearTimeout(first), clearInterval(iv));
};
let attachNext = false;
const stops = [
  every(40, () => chat(attachNext && !(attachNext = false)), 5),
  every(600, () => void (attachNext = true), 120),
  every(30, async () => {
    await api('GET', '/threads');
    await api('GET', '/me');
    ops.reads++;
  }),
  every(120, async () => {
    await api('GET', `/search?q=${encodeURIComponent(['planning', 'klant', 'offerte'][n % 3])}`);
    await api('GET', `/memory/search?q=planning`).catch(() => {});
    ops.searches++;
  }),
  every(900, async () => {
    await api('POST', '/memory/items', { content: `Afspraak ${ops.memoryItems + 1}: de klant wil elke week een kort verslag.`, scope: 'about_you' });
    ops.memoryItems++;
  }, 180),
  every(1800, async () => {
    await api('POST', '/memory/maintenance');
    ops.maintenance++;
  }, 300),
  every(7200, async () => threads.push(await api('POST', '/threads', { agentId: bots[threads.length % bots.length].id }))),
  every(540, connectWs),
];

// ---------------------------------------------------------------- sampling
const samples = []; // the meter's own samples
const os_ = []; // OS samples: { at, teambot: totals, compare: { name: totals } }
let lastAt;
let prevCpu = {};
async function sampleNow() {
  try {
    const h = await api('GET', `/health/history${lastAt ? `?after=${encodeURIComponent(lastAt)}` : ''}`);
    for (const s of h.samples) samples.push(s);
    if (h.samples.length) lastAt = h.samples.at(-1).at;
  } catch (e) {
    note(e);
  }
  try {
    const all = await snapshot();
    const at = Date.now();
    const row = { at: new Date(at).toISOString(), teambot: totals(selectTree(all, child.pid)), compare: {} };
    for (const c of compare) row.compare[c] = totals(selectTree(all, c));
    for (const [k, v] of [['teambot', row.teambot], ...Object.entries(row.compare)]) {
      const p = prevCpu[k];
      v.cpuPct = p && at > p.at ? Math.round(((v.cpuMs - p.cpuMs) / (at - p.at)) * 1000) / 10 : null;
      prevCpu[k] = { at, cpuMs: v.cpuMs };
    }
    os_.push(row);
  } catch (e) {
    note(e);
  }
}
const stamp = startedAt.toISOString().slice(0, 10);
let base = path.join(OUT, `soak-${stamp}`);
for (let i = 2; fs.existsSync(`${base}.json`) && !JSON.parse(fs.readFileSync(`${base}.json`, 'utf8')).running; i++) base = path.join(OUT, `soak-${stamp}-${i}`);
const sampleIv = setInterval(sampleNow, SAMPLE_S * 1000);
const checkpoint = setInterval(() => write(true), 15 * 60_000);
await sampleNow();
log(`belasting loopt; ${minutes} minuten${compare.length ? `, vergelijkt met ${compare.join(', ')} (alleen lezen)` : ''}`);

let finishing = false;
const finish = async (why) => {
  if (finishing) return;
  finishing = true;
  log(`klaar (${why}): laatste meting en server stoppen`);
  for (const s of stops) s();
  clearInterval(sampleIv);
  clearInterval(checkpoint);
  await sleep(SAMPLE_S * 1000 + 2000); // the meter closes the running minute
  await sampleNow();
  try {
    const runs = await api('GET', `/routines/${routine?.id}/runs`);
    ops.routineRuns = (Array.isArray(runs) ? runs : runs.runs || []).length;
  } catch (e) {
    note(e);
  }
  try {
    ops.finalHealth = await api('GET', '/health');
  } catch (e) {
    note(e);
  }
  ws?.close();
  child.stdin.write('stop\n');
  await Promise.race([new Promise((r) => child.once('exit', r)), sleep(20_000)]);
  if (child.exitCode === null) child.kill(); // only the PID this script started
  write(false, why);
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  log(`rapport: ${path.relative(ROOT, base)}.md`);
  process.exit(0);
};
process.on('SIGINT', () => void finish('onderbroken'));
setTimeout(() => void finish('tijd om'), minutes * 60_000);
child.on('exit', (c) => !finishing && (note(`server stopte onverwacht (${c})`), void finish('server gestopt')));

// ---------------------------------------------------------------- report
function stats(arr) {
  const s = [...arr].filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return { n: 0 };
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, min: s[0], p50: q(0.5), p95: q(0.95), p99: q(0.99), max: s.at(-1), avg: Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 10) / 10 };
}
/** Linear growth per hour (least squares) after the first 10 % of the run: a leak shows as a steady slope. */
function slopePerHour(points) {
  const pts = points.slice(Math.floor(points.length / 10));
  if (pts.length < 5) return null;
  const x0 = pts[0][0];
  const xs = pts.map((p) => (p[0] - x0) / 3_600_000);
  const ys = pts.map((p) => p[1]);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const den = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  return den ? Math.round((xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / den) * 10) / 10 : null;
}
function summarize() {
  const t = (s) => Date.parse(s.at);
  const meter = {
    samples: samples.length,
    loopP50: stats(samples.map((s) => s.loop.p50)),
    loopP99: stats(samples.map((s) => s.loop.p99)),
    loopMaxMs: Math.max(0, ...samples.map((s) => s.loop.max)),
    stalls100: samples.reduce((a, s) => a + s.stalls.over100ms, 0),
    stalls1s: samples.reduce((a, s) => a + s.stalls.over1s, 0),
    longestStallMs: Math.max(0, ...samples.map((s) => s.stalls.longestMs)),
    totalStallMs: samples.reduce((a, s) => a + s.stalls.totalMs, 0),
    pauses: samples.reduce((a, s) => a + s.pauses, 0),
    rssMb: stats(samples.map((s) => s.mem.rssMb)),
    heapMb: stats(samples.map((s) => s.mem.heapUsedMb)),
    handles: stats(samples.map((s) => s.handles)),
    cpu: stats(samples.map((s) => s.cpu)),
    rssSlopeMbPerHour: slopePerHour(samples.map((s) => [t(s), s.mem.rssMb])),
    heapSlopeMbPerHour: slopePerHour(samples.map((s) => [t(s), s.mem.heapUsedMb])),
    handlesSlopePerHour: slopePerHour(samples.map((s) => [t(s), s.handles])),
    first: samples[0] ? { rssMb: samples[0].mem.rssMb, heapMb: samples[0].mem.heapUsedMb, handles: samples[0].handles } : null,
    last: samples.at(-1) ? { rssMb: samples.at(-1).mem.rssMb, heapMb: samples.at(-1).mem.heapUsedMb, handles: samples.at(-1).handles } : null,
  };
  const osSide = (pick) => {
    const rows = os_.map((r) => ({ at: Date.parse(r.at), v: pick(r) })).filter((r) => r.v && r.v.processes > 0);
    if (!rows.length) return null;
    return {
      samples: rows.length,
      processes: stats(rows.map((r) => r.v.processes)),
      wsMb: stats(rows.map((r) => r.v.wsMb)),
      privateMb: stats(rows.map((r) => r.v.privateMb)),
      handles: stats(rows.map((r) => r.v.handles)),
      cpuPct: stats(rows.map((r) => r.v.cpuPct)),
      wsSlopeMbPerHour: slopePerHour(rows.map((r) => [r.at, r.v.wsMb])),
      names: rows.at(-1).v.names,
    };
  };
  return { meter, os: { teambot: osSide((r) => r.teambot), ...Object.fromEntries(compare.map((c) => [c, osSide((r) => r.compare[c])])) } };
}
function write(running, why = '') {
  fs.mkdirSync(OUT, { recursive: true });
  const endedAt = new Date();
  const s = summarize();
  const chat = stats(ops.chatMs);
  const json = { format: 'teambot.soak/v1', running, why, startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(), plannedMinutes: minutes, version: ops.finalHealth?.version, platform: `${process.platform} ${os.release()} · Node ${process.versions.node}`, port: PORT, compare, ops: { ...ops, chatMs: chat, finalHealth: undefined }, finalHealth: ops.finalHealth || null, summary: s, samples, osSamples: os_ };
  fs.writeFileSync(`${base}.json`, JSON.stringify(json, null, 1));
  const h = (endedAt - startedAt) / 3_600_000;
  const m = s.meter;
  const f = (x, d = 0) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(d).replace('.', ','));
  const osRow = (label, o) => (o ? `| ${label} | ${f(o.processes.max)} | ${f(o.wsMb.p50)} / ${f(o.wsMb.max)} | ${f(o.privateMb.p50)} / ${f(o.privateMb.max)} | ${f(o.handles.p50)} / ${f(o.handles.max)} | ${f(o.cpuPct.avg, 1)} | ${f(o.wsSlopeMbPerHour, 1)} |` : `| ${label} | niet gevonden | | | | | |`);
  const md = `# Duurtest TeamBot ${json.version || ''} — ${startedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC

${running ? '**Loopt nog** (tussenstand).' : `Afgerond (${why}).`} Duur: ${f(h, 2)} uur (gepland ${f(minutes / 60, 2)} uur). ${json.platform}.
Eigen TeamBot-server (PID-boom van het testproces) op poort ${PORT} met een tijdelijke datamap en een nep-engine, met \`npm run soak\`
(scripts/soak.mjs). De server draait via tsx (TypeScript-loader), dus zonder Electron-venster: het geheugen is dat van de server alleen.

## Belasting

| wat | aantal |
|---|---|
| chatbeurten (elke 40 s, nep-engine streamt 0,5–1,5 s; soms geheugen zoeken/opslaan) | ${ops.chats} (fout: ${ops.chatErrors}) |
| doorlooptijd chatbeurt p50 / p95 / max | ${f(chat.p50)} / ${f(chat.p95)} / ${f(chat.max)} ms |
| bijlagen (elke 10 min, 150 KB of 5 KB) | ${ops.attachments} |
| routine-runs (routine elke 5 min) | ${ops.routineRuns} |
| geheugen: nieuwe feiten / onderhoud / zoekopdrachten | ${ops.memoryItems} / ${ops.maintenance} / ${ops.searches} |
| lijst-verversingen zoals de app (elke 30 s) | ${ops.reads} |
| fouten van de belasting | ${ops.errors.length} |

## Stilstandmeter (in de server, één meting per minuut)

| | waarde |
|---|---|
| metingen | ${m.samples} |
| wachttijd event-loop p50 (mediaan van de minuten) | ${f(m.loopP50.p50, 1)} ms |
| wachttijd event-loop p99 (mediaan / slechtste minuut) | ${f(m.loopP99.p50, 1)} / ${f(m.loopP99.max, 1)} ms |
| langste wachttijd | ${f(m.loopMaxMs)} ms |
| haperingen > 100 ms | ${m.stalls100} |
| stilstand > 1 s | ${m.stalls1s} |
| langste stilstand | ${f(m.longestStallMs)} ms |
| alle stilstand bij elkaar | ${f(m.totalStallMs / 1000, 1)} s |
| pauzes (pc sliep) | ${m.pauses} |
| RSS eerste / mediaan / max / laatste | ${f(m.first?.rssMb)} / ${f(m.rssMb.p50)} / ${f(m.rssMb.max)} / ${f(m.last?.rssMb)} MB |
| heap eerste / max / laatste | ${f(m.first?.heapMb)} / ${f(m.heapMb.max)} / ${f(m.last?.heapMb)} MB |
| handles eerste / max / laatste | ${f(m.first?.handles)} / ${f(m.handles.max)} / ${f(m.last?.handles)} |
| groei per uur na de eerste 10 % (RSS / heap / handles) | ${f(m.rssSlopeMbPerHour, 1)} MB / ${f(m.heapSlopeMbPerHour, 1)} MB / ${f(m.handlesSlopePerHour, 1)} |
| CPU gemiddeld | ${f(m.cpu.avg, 1)} % van één kern |
| kleur aan het eind | ${ops.finalHealth?.level || '—'} |

## Besturingssysteem (alleen lezen)

| programma | processen | werkgeheugen p50 / max (MB) | privé p50 / max (MB) | handles p50 / max | CPU gem. (% kern) | groei werkgeheugen (MB/uur) |
|---|---|---|---|---|---|---|
${osRow('TeamBot-server (deze test)', s.os.teambot)}
${compare.map((c) => osRow(`${c} (vergelijking)`, s.os[c])).join('\n')}

${compare.length ? `De vergelijking leest alleen procesgegevens van het besturingssysteem (Win32_Process: werkgeheugen, privégeheugen, handles, CPU-tijd) van ${compare.join(', ')} en alle onderliggende processen. Er is geen verbinding met, invoer naar of injectie in dat programma. Let op: dat programma draait met zijn eigen gebruik en venster, deze TeamBot met een nep-belasting en zonder venster.` : 'Geen vergelijking (gebruik `--compare <naam of PID>`).'}

${ops.errors.length ? `## Fouten (laatste 10)\n\n${ops.errors.slice(-10).map((e) => `- ${e.at} ${e.error}`).join('\n')}\n` : ''}
Ruwe metingen: \`${path.basename(base)}.json\`.
`;
  fs.writeFileSync(`${base}.md`, md);
}
