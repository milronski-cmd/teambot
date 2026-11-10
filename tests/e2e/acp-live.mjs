// LIVE test of an ACP agent (OpenCode) through TeamBot (PRV-03): a bot in "ask" mode asks to write a file; the
// approval goes through TeamBot's Broker. Run 1 approves (file must appear exactly once, in the right place),
// run 2 denies (no file). Costs a few cents on your OpenAI key.
//   OPENCODE_BIN=<path to opencode(.exe)> OPENAI_KEY_FILE=<file with an OpenAI key> npm run acp:live
// OpenCode runs with its own temporary HOME/XDG folders, so your real OpenCode data is never touched; the key is only
// written to that temporary folder for the run and the folder is removed afterwards.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BIN = process.env.OPENCODE_BIN;
const KEY_FILE = process.env.OPENAI_KEY_FILE;
if (!BIN || !KEY_FILE || !fs.existsSync(BIN) || !fs.existsSync(KEY_FILE)) {
  console.log('Zet OPENCODE_BIN en OPENAI_KEY_FILE (zie de kop van dit script).');
  process.exit(0);
}
const X = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-acp-live-'));
for (const d of ['data/opencode', 'config/opencode', 'state', 'cache', 'home']) fs.mkdirSync(path.join(X, d), { recursive: true });
Object.assign(process.env, {
  XDG_DATA_HOME: path.join(X, 'data'),
  XDG_CONFIG_HOME: path.join(X, 'config'),
  XDG_STATE_HOME: path.join(X, 'state'),
  XDG_CACHE_HOME: path.join(X, 'cache'),
  HOME: path.join(X, 'home'),
  USERPROFILE: path.join(X, 'home'),
  OPENCODE_DISABLE_AUTOUPDATE: '1',
});
fs.writeFileSync(path.join(X, 'data/opencode/auth.json'), JSON.stringify({ openai: { type: 'api', key: fs.readFileSync(KEY_FILE, 'utf8').trim() } }), { mode: 0o600 });
fs.writeFileSync(path.join(X, 'config/opencode/opencode.json'), JSON.stringify({ model: process.env.OPENCODE_MODEL || 'openai/gpt-5.4-mini', autoupdate: false }));

const { startTestApp } = await import('../helpers.ts');
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

async function round(decision) {
  const t = await startTestApp();
  try {
    const p = await t.api('POST', '/providers', { kind: 'opencode', config: { path: BIN } });
    const a = await t.api('POST', '/agents', { name: 'OpenCodeBot', provider_id: p.id, model: '', access_mode: 'ask' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Maak in je werkmap een bestand hallo.txt met precies de tekst: hallo van opencode. Zeg daarna alleen: klaar.' });
    const start = Date.now();
    let asked = 0;
    while (Date.now() - start < 180_000) {
      for (const ap of (await t.api('GET', '/approvals')).filter((x) => x.status === 'pending')) {
        asked++;
        await t.api('POST', `/approvals/${ap.id}`, { decision });
      }
      const busy = t.app.ctx.store.all("SELECT id FROM runs WHERE thread_id = ? AND status IN ('queued','running','waiting')", th.id);
      if (!busy.length && Date.now() - start > 3000) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const file = path.join(a.workspace, 'hallo.txt');
    const run = t.app.ctx.store.all('SELECT status, error FROM runs WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1', th.id)[0];
    check(`${decision}: run klaar zonder fout`, run?.status === 'done', run?.error || '');
    check(`${decision}: precies één goedkeuringsvraag via TeamBot`, asked === 1, `${asked}×`);
    if (decision === 'approve') check('goedkeuren: bestand op de juiste plek', fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim() === 'hallo van opencode');
    else check('weigeren: geen bestand', !fs.existsSync(file));
    check(`${decision}: geen verkeerd geneste map in de werkmap`, !fs.existsSync(path.join(a.workspace, 'Users')));
  } finally {
    await t.close();
  }
}

try {
  await round('approve');
  await round('deny');
} catch (e) {
  check('onverwachte fout', false, e.message);
} finally {
  fs.rmSync(X, { recursive: true, force: true });
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} geslaagd`);
process.exit(failed ? 1 : 0);
