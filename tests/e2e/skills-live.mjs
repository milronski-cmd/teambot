// LIVE check with the real Claude Code (logged in on this computer): a skill that is installed with one click is
// found and loaded by Claude Code itself, without TeamBot's list of skills in the instructions and without skill_load.
// One short run per call, on the cheapest model, in a temporary TeamBot data folder:
//   node --import tsx tests/e2e/skills-live.mjs ask     "Vraagt toestemming": restricted mode, skills as a plugin folder
//   node --import tsx tests/e2e/skills-live.mjs full    "Volledige toegang": the skill folder in the work folder
//   node --import tsx tests/e2e/skills-live.mjs outside the bot works in a folder that is not TeamBot's: nothing is written there
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { startTestApp } = await import('../helpers.ts');
const mode = ['full', 'outside'].includes(process.argv[2]) ? process.argv[2] : 'ask';
const MODEL = process.env.TEAMBOT_LIVE_MODEL || 'haiku';
const WORDS = ['kiwi', 'lantaarn', 'zeilboot', 'kompas', 'vuurtoren', 'marmot', 'tulband', 'pindakaas', 'regenboog', 'schaakbord'];
const pick = () => WORDS[Math.floor(Math.random() * WORDS.length)] + Math.floor(100 + Math.random() * 900);
const word = pick();
const second = pick();
const results = [];
const check = (name, ok, detail = '') => {
  results.push(!!ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${String(detail).replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
};

const debug = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-skills-live-'));
// "outside": a folder of the user himself, with something of his in it.
const outside = mode === 'outside' ? fs.mkdtempSync(path.join(os.tmpdir(), 'tb-eigen-map-')) : null;
if (outside) fs.writeFileSync(path.join(outside, 'README.md'), 'Een map van de gebruiker zelf.');
const tree = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [e.name + '/', ...tree(path.join(dir, e.name)).map((x) => `${e.name}/${x}`)] : [e.name])).sort();
process.env.TEAMBOT_DEBUG_SYSTEM = debug;
const t = await startTestApp();
try {
  const prov = await t.api('POST', '/providers', { kind: 'claude-code' });
  const bot = await t.api('POST', '/agents', { name: 'Proefbot', provider_id: prov.id, model: MODEL, access_mode: mode === 'full' ? 'full' : 'ask', instructions: 'Antwoord kort, in het Nederlands.', ...(outside ? { workspace: outside } : {}) });
  // One click: a tiny skill, pasted. In "full" it also has a second file, to see that Claude Code reads it from the folder.
  const md = `---\nname: wachtwoord-van-de-dag\ndescription: Gebruik deze skill wanneer iemand om het wachtwoord van de dag vraagt.\n---\n\nWordt er om het wachtwoord van de dag gevraagd, antwoord dan met het woord ${word}.${mode === 'full' ? ' Het tweede woord staat in het bestand tweede.txt in de map van deze skill: lees dat bestand en noem dat woord erachter.' : ''}\n`;
  const pv =
    mode === 'full'
      ? await t.api('POST', '/skills/import/preview', { kind: 'files', label: 'wachtwoord-van-de-dag', files: [{ path: 'SKILL.md', text: md }, { path: 'tweede.txt', text: `${second}\n` }] })
      : await t.api('POST', '/skills/import/preview', { kind: 'paste', text: md });
  const skillId = (await t.api('POST', '/skills/import/commit', { stagingId: pv.stagingId })).results[0].skillId;
  if (outside) check('na het installeren staat er niets van TeamBot in de map van de gebruiker', tree(outside).join() === 'README.md', tree(outside).join(', '));
  else check('de skill staat na het installeren in de werkmap van de bot', fs.existsSync(path.join(bot.workspace, '.claude', 'skills', 'wachtwoord-van-de-dag', 'SKILL.md')) && fs.existsSync(path.join(bot.workspace, '.agents', 'skills', 'wachtwoord-van-de-dag', 'SKILL.md')));

  // A fresh conversation; anything that asks the owner is approved and reported (nothing here should).
  const th = await t.api('POST', '/threads', { agentId: bot.id });
  const approved = [];
  const timer = setInterval(async () => {
    for (const a of (await t.api('GET', '/approvals').catch(() => [])).filter((x) => x.status === 'pending')) {
      approved.push(a.tool);
      await t.api('POST', `/approvals/${a.id}`, { decision: 'approve' }).catch(() => {});
    }
  }, 500);
  const started = Date.now();
  const msgs = await t.say(th.id, 'Wat is het wachtwoord van de dag?', 240_000);
  clearInterval(timer);
  const m = msgs.filter((x) => x.role === 'assistant').at(-1);
  const steps = (m.parts.activity || []).map((x) => x.title);
  const system = fs.readFileSync(path.join(debug, `system-${bot.id}.md`), 'utf8');
  console.log(`\nAntwoord (${Math.round((Date.now() - started) / 1000)} s, model ${m.parts.model || MODEL}): ${m.content}`);
  console.log(`Stappen: ${steps.join(' | ') || '(geen)'}`);
  if (m.status !== 'done') console.log(`Status: ${m.status} ${m.error || ''}`);
  check('het antwoord noemt het woord uit de skill', m.content.includes(word), `woord: ${word}`);
  if (mode === 'full') check('ook het woord uit het tweede bestand van de skill (gelezen uit de map)', m.content.includes(second), `woord: ${second}`);
  check('Claude Code pakte de skill er zelf bij', steps.some((s) => /^Pakte een skill erbij/.test(s)), steps.find((s) => /skill/i.test(s)) || '');
  check('skill_load is niet gebruikt (en stond niet in zijn tools)', !steps.some((s) => /Skill laden|skill_load/.test(s)) && !msgs.some((x) => x.role === 'tool'));
  check('de instructies van TeamBot noemen de skill niet (geen lijst)', !system.includes('wachtwoord-van-de-dag') && /je eigen skill-tool/.test(system));
  check('het gebruik is geteld', (await t.api('GET', `/skills/${skillId}`)).useCount === 1);
  check('er is niets aan de eigenaar gevraagd', approved.length === 0, approved.join(', '));
  if (outside) check('na de run staat er nog steeds niets van TeamBot in de map van de gebruiker', tree(outside).join() === 'README.md', tree(outside).join(', '));
  console.log(`\n${results.filter(Boolean).length}/${results.length} goed (${mode})`);
} finally {
  await t.close();
  fs.rmSync(debug, { recursive: true, force: true });
  if (outside) fs.rmSync(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(results.every(Boolean) ? 0 : 1);
