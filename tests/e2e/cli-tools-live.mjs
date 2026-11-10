// LIVE test: TeamBot's own tools inside CLI engines (memory, own browser, delegation, approvals) — free/subscription route.
//   CLI_ENGINE=claude   npm run cli-tools:live     (Claude Code with your own login)
//   CLI_ENGINE=codex    npm run cli-tools:live     (Codex CLI with your own login)
//   CLI_ENGINE=opencode OPENCODE_BIN=<opencode(.exe)> [OPENCODE_MODEL=opencode/big-pickle] npm run cli-tools:live
// TeamBot runs with a temporary data dir (never your real TeamBot data). OpenCode runs with its own temporary HOME/XDG
// folders (your real OpenCode data is never touched) and a free OpenCode model, so no key is needed.
// Each step prints its latency and the cost TeamBot booked (0 on a subscription / free model).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENGINE = process.env.CLI_ENGINE || 'claude';
const KIND = { claude: 'claude-code', codex: 'codex-cli', opencode: 'opencode' }[ENGINE];
if (!KIND) {
  console.log('CLI_ENGINE moet claude, codex of opencode zijn');
  process.exit(2);
}
let iso = null;
const providerConfig = {};
let model = process.env.CLI_MODEL || '';
if (ENGINE === 'opencode') {
  const BIN = process.env.OPENCODE_BIN;
  if (!BIN || !fs.existsSync(BIN)) {
    console.log('Zet OPENCODE_BIN (pad naar opencode of opencode.exe).');
    process.exit(0);
  }
  providerConfig.path = BIN;
  model = process.env.OPENCODE_MODEL || 'opencode/big-pickle';
  iso = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-oc-live-'));
  for (const d of ['data/opencode', 'config/opencode', 'state', 'cache', 'home']) fs.mkdirSync(path.join(iso, d), { recursive: true });
  Object.assign(process.env, {
    XDG_DATA_HOME: path.join(iso, 'data'),
    XDG_CONFIG_HOME: path.join(iso, 'config'),
    XDG_STATE_HOME: path.join(iso, 'state'),
    XDG_CACHE_HOME: path.join(iso, 'cache'),
    HOME: path.join(iso, 'home'),
    // USERPROFILE stays: OpenCode keeps its data under XDG_* (isolated above), and the bot's browser needs a normal profile.
    OPENCODE_DISABLE_AUTOUPDATE: '1',
  });
  fs.writeFileSync(path.join(iso, 'config/opencode/opencode.json'), JSON.stringify({ autoupdate: false }));
}
if (ENGINE === 'codex' && process.env.CODEX_BIN) providerConfig.path = process.env.CODEX_BIN;

const { startTestApp } = await import('../helpers.ts');
const t = await startTestApp();
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const store = t.app.ctx.store;

async function step(label, threadId, content, decide = () => 'approve', timeoutMs = 300_000) {
  const start = Date.now();
  const seen = [];
  await t.api('POST', `/threads/${threadId}/messages`, { content });
  await new Promise((r) => setTimeout(r, 300));
  while (Date.now() - start < timeoutMs) {
    for (const ap of (await t.api('GET', '/approvals')).filter((x) => x.status === 'pending' && x.thread_id === threadId)) {
      const d = decide(ap);
      seen.push(`${ap.tool}→${d}`);
      await t.api('POST', `/approvals/${ap.id}`, { decision: d });
    }
    const busy = store.all("SELECT id FROM runs WHERE thread_id = ? AND status IN ('queued','running','waiting')", threadId);
    if (!busy.length) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  const ms = Date.now() - start;
  const run = store.all('SELECT * FROM runs WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1', threadId)[0];
  const msg = store.messages(threadId).filter((m) => m.role === 'assistant').at(-1);
  const usage = run?.usage ? JSON.parse(run.usage) : {};
  const acts = (msg?.parts?.activity || []).map((a) => a.title).filter((x) => /TeamBot|Wacht|tools|sessie/i.test(x));
  console.log(`\n[${label}] ${(ms / 1000).toFixed(1)} s · kosten $${Number(usage.cost || 0).toFixed(4)} · goedkeuringen: ${seen.join(', ') || 'geen'}`);
  console.log(`  activiteit: ${acts.slice(0, 8).join(' | ')}`);
  console.log(`  antwoord: ${(msg?.content || msg?.parts?.error || '').replace(/\s+/g, ' ').slice(0, 300)}`);
  return { ms, run, msg, text: msg?.content || '', seen, cost: Number(usage.cost || 0) };
}

try {
  const p = await t.api('POST', '/providers', { kind: KIND, config: providerConfig });
  const helper = await t.agent({ name: 'Hulpbot', role: 'weet alles over Friesland' });
  t.script.push({ text: 'De hoofdstad van Friesland is Leeuwarden (Ljouwert). — Hulpbot' });
  const bot = await t.api('POST', '/agents', { name: 'Baas', provider_id: p.id, model, access_mode: 'ask', tool_groups: ['files', 'web', 'memory', 'team', 'skills', 'routines', 'browser'] });
  void helper;
  const timings = [];

  // (1) the owner says "onthoud dat …": TeamBot's memory stores it (an explicit owner instruction, same as for API bots)
  const th1 = await t.api('POST', '/threads', { agentId: bot.id });
  const s1 = await step('onthouden', th1.id, 'Onthoud dat mijn favoriete kleur groen is.');
  timings.push(s1);
  const mem = store.all("SELECT * FROM memory_items WHERE user_id = ? AND status != 'deleted'", bot.user_id);
  check('onthouden: staat in het TeamBot-geheugen', mem.some((m) => /groen/i.test(m.content || '')), `${mem.length} item(s)`);

  // (2) new conversation: ask it back via memory
  const th2 = await t.api('POST', '/threads', { agentId: bot.id });
  const s2 = await step('terugvragen (nieuw gesprek)', th2.id, 'Wat is mijn favoriete kleur? Antwoord in één korte zin.');
  timings.push(s2);
  check('terugvragen: antwoord noemt groen', /groen/i.test(s2.text));

  // (3) own TeamBot browser: open a page and summarise
  const s3 = await step('browser', th2.id, 'Open https://example.com in je eigen TeamBot-browser (browser_open) en vat de pagina in één zin samen.');
  timings.push(s3);
  const usedBrowser = (s3.msg?.parts?.activity || []).some((a) => /^TeamBot · Browser/.test(a.title) && !/mislukt|geweigerd/.test(a.title));
  check('browser: TeamBot-browser gebruikt', usedBrowser);
  check('browser: samenvatting klopt', /example|voorbeeld|illustrat|documentatie|domain|domein/i.test(s3.text));

  // (4) delegation: ask another own bot. Since "fewer approvals" (asking your own bots runs without a card) this
  // happens without an approval; the answer must come back.
  const s4 = await step('delegeren', th2.id, 'Vraag aan de bot Hulpbot (met message_bot) wat de hoofdstad van Friesland is, en geef zijn antwoord letterlijk door.');
  timings.push(s4);
  check('delegeren: eigen bot vragen zonder goedkeuringskaart', !s4.seen.some((x) => x.startsWith('message_bot')), s4.seen.join(', ') || 'geen kaart');
  check('delegeren: antwoord van Hulpbot doorgegeven', /Leeuwarden|Ljouwert/i.test(s4.text));

  // (5) a file the bot writes itself (the CLI's own write tool; TeamBot's own board/tasks are internal and need no
  // card) → the CLI asks TeamBot → approval card → deny: nothing may happen
  const ws = (await t.api('GET', `/agents/${bot.id}`)).workspace;
  const s5 = await step('weigeren', th2.id, "Schrijf het woord 'kat' naar het bestand kat.txt in je werkmap.", () => 'deny');
  timings.push(s5);
  check('weigeren: goedkeuring gevraagd en geweigerd', s5.seen.some((x) => x.endsWith('deny')), s5.seen.join(', '));
  check('weigeren: geen bestand geschreven', !fs.existsSync(path.join(ws, 'kat.txt')));

  // (6) a file write → approve → it happens (exactly once, in the bot's folder)
  const s6 = await step('goedkeuren', th2.id, "Schrijf het woord 'planten' naar het bestand planten.txt in je werkmap.", () => 'approve');
  timings.push(s6);
  check('goedkeuren: goedkeuring gevraagd', s6.seen.some((x) => x.endsWith('approve')), s6.seen.join(', '));
  check('goedkeuren: bestand geschreven', /planten/i.test(fs.existsSync(path.join(ws, 'planten.txt')) ? fs.readFileSync(path.join(ws, 'planten.txt'), 'utf8') : ''));

  // (7) readonly: TeamBot read tools still work (Claude plan mode, Codex exec read-only sandbox, ACP plan mode)
  await t.api('PATCH', `/agents/${bot.id}`, { access_mode: 'readonly' });
  const th7 = await t.api('POST', '/threads', { agentId: bot.id });
  const s7 = await step('alleen lezen', th7.id, 'Open https://example.org in je eigen TeamBot-browser (browser_open) en noem de titel van de pagina.');
  timings.push(s7);
  check('alleen lezen: TeamBot-browser werkt', (s7.msg?.parts?.activity || []).some((a) => /^TeamBot · Browser/.test(a.title)) && /example/i.test(s7.text));

  // (8) "Volledige toegang": the bot's own normal work runs without an approval card
  await t.api('PATCH', `/agents/${bot.id}`, { access_mode: 'full' });
  const s8 = await step('volledige toegang', th7.id, "Zet met task_create een taak 'post ophalen' op mijn takenbord.", () => 'deny');
  timings.push(s8);
  check('volledige toegang: geen goedkeuring nodig, taak aangemaakt', !s8.seen.length && store.all("SELECT * FROM room_tasks WHERE title LIKE '%post ophalen%'").length === 1, s8.seen.join(', '));

  const total = timings.reduce((a, x) => a + x.cost, 0);
  check('kosten: 0 extra (abonnement/gratis model)', total === 0, `$${total.toFixed(4)}`);
  console.log(`\nLatency per stap: ${timings.map((x) => (x.ms / 1000).toFixed(1) + ' s').join(', ')}`);
} catch (e) {
  check('onverwachte fout', false, e.stack || e.message);
} finally {
  await t.close();
  if (iso) fs.rmSync(iso, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${ENGINE}: ${results.length - failed}/${results.length} geslaagd`);
process.exit(failed ? 1 : 0);
