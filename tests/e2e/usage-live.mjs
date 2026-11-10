// Live check of usage limits with the CLIs that are logged in on this computer (Claude Code, Codex, OpenCode),
// in a temporary TeamBot data folder. Reads only what the CLIs report themselves: Claude's local /usage command
// (no model call), Codex's app-server account/rateLimits/read, OpenCode's stats. With --run it also sends one tiny
// prompt through a Claude Code bot (Haiku) to show the rate_limit_event, context fill and list-price value of a turn.
// Usage: npm run usage:live [-- --run]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { createApp } = await import('../../server/app.ts');
const withRun = process.argv.includes('--run');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-usage-live-'));
const app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const api = async (method, p, body) => {
  const r = await fetch(app.url + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status}: ${j.error}`);
  return j;
};
const when = (ms) => (ms ? new Date(ms).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : 'onbekend');
const show = (e) => {
  console.log(`\n== ${e.name} (${e.kind}) — ${e.billingPath || e.billing}${e.plan ? ` · ${e.plan}` : ''}`);
  if (e.windows.length) for (const w of e.windows) console.log(`   ${w.label.padEnd(24)} ${w.usedPercent === null ? 'onbekend' : w.usedPercent + '%'}  reset ${when(w.resetsAt)}  [${w.level}]`);
  else console.log(`   limieten: onbekend — ${e.unsupported || e.error || 'niet gemeld'}`);
  if (e.note) console.log(`   noot: ${e.note}`);
  if (e.stats) console.log(`   OpenCode vandaag: ${e.stats.input + e.stats.output} tokens, $${e.stats.cost}, ${e.stats.sessions} sessies`);
  if (e.blocked) console.log(`   GEBLOKKEERD tot ${when(e.blocked.until)}`);
  console.log(`   bron: ${e.source || '-'} · opgevraagd: ${e.checkedAt ? 'ja' : 'nee'}${e.error ? ` · fout: ${e.error}` : ''}`);
  console.log(`   vandaag via TeamBot: ${e.spend.today.tokens} tokens, kosten $${e.spend.today.cost}, geschatte waarde ${e.spend.today.value === null ? 'onbekend' : '$' + e.spend.today.value.toFixed(5)}`);
};
let failed = 0;
try {
  const ids = {};
  for (const cli of ['claude-code', 'codex-cli', 'opencode']) {
    try {
      const r = await api('POST', `/cli-agents/${cli}/connect`);
      ids[cli] = r.provider.id;
    } catch (e) {
      console.log(`- ${cli}: niet gekoppeld (${e.message})`);
    }
  }
  for (const [cli, id] of Object.entries(ids)) {
    const t0 = Date.now();
    try {
      const e = await api('POST', `/usage/limits/${id}/refresh`);
      show(e);
      console.log(`   (${Date.now() - t0} ms)`);
      if ((cli === 'claude-code' || cli === 'codex-cli') && !e.windows.length) failed++;
    } catch (e) {
      console.log(`\n== ${cli}: ${e.message}`);
      if (cli !== 'opencode') failed++;
    }
  }
  if (withRun && ids['claude-code']) {
    const a = await api('POST', '/agents', { name: 'Live', provider_id: ids['claude-code'], model: 'haiku', access_mode: 'readonly' });
    const th = await api('POST', '/threads', { agentId: a.id });
    await api('POST', `/threads/${th.id}/messages`, { content: 'Antwoord alleen met: ok' });
    for (let i = 0; i < 240 && app.ctx.store.all("SELECT 1 FROM runs WHERE thread_id = ? AND status IN ('queued','running','waiting')", th.id).length; i++) await new Promise((r) => setTimeout(r, 500));
    const m = app.ctx.store.messages(th.id).filter((x) => x.role === 'assistant').at(-1);
    console.log(`\n== Claude Code-beurt via TeamBot: "${(m?.content || '').slice(0, 40)}" status=${m?.status}${m?.parts?.error ? ' fout=' + m.parts.error : ''}`);
    console.log(`   usage van het bericht: ${JSON.stringify(m?.usage)}`);
    const c = await api('GET', `/usage/context/${th.id}`);
    console.log(`   contextring: ${c.used ?? '?'} van ${c.window ?? '?'} tokens (${c.percent ?? 'onbekend'}%) · samenvatten mogelijk: ${c.canCompact}`);
    show(await api('GET', `/usage/limits/${ids['claude-code']}`));
    if (!c.used) failed++;
  }
} finally {
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} controle(s) zonder gegevens` : '\nLive uitlezen geslaagd');
process.exit(failed ? 1 : 0);
