// LIVE check with the real Claude Code (logged in on this computer): the owner changes a bot's instructions while a
// conversation is running, the SAME conversation is continued, and the bot follows the new instruction.
// Two short turns in one conversation, on the cheapest model, in a temporary TeamBot data folder:
//   node --import tsx tests/e2e/instructions-live.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { startTestApp } = await import('../helpers.ts');
const MODEL = process.env.TEAMBOT_LIVE_MODEL || 'haiku';
const WORDS = ['kiwi', 'lantaarn', 'zeilboot', 'kompas', 'vuurtoren', 'marmot', 'tulband', 'pindakaas', 'regenboog', 'schaakbord'];
const pick = (not) => WORDS.filter((w) => w !== not)[Math.floor(Math.random() * (WORDS.length - (not ? 1 : 0)))];
const first = pick();
const second = pick(first);
const rule = (w) => `Antwoord kort, in het Nederlands. Sluit elk antwoord af met een losse regel met alleen het woord ${w.toUpperCase()}.`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(!!ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${String(detail).replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
};

const debug = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-instr-live-'));
process.env.TEAMBOT_DEBUG_SYSTEM = debug;
const t = await startTestApp();
try {
  const prov = await t.api('POST', '/providers', { kind: 'claude-code' });
  const bot = await t.api('POST', '/agents', { name: 'Proefbot', provider_id: prov.id, model: MODEL, access_mode: 'ask', instructions: rule(first) });
  const th = await t.api('POST', '/threads', { agentId: bot.id });
  const turn = async (text) => {
    const m = (await t.say(th.id, text, 240_000)).filter((x) => x.role === 'assistant').at(-1);
    const steps = (m.parts.activity || []).map((x) => `${x.title}${x.detail ? ` (${x.detail})` : ''}`);
    console.log(`\n> ${text}\n${m.content}\nStappen: ${steps.join(' | ') || '(geen)'}${m.status !== 'done' ? `\nStatus: ${m.status} ${m.parts.error || ''}` : ''}`);
    return { m, steps };
  };
  const session = () => t.app.ctx.store.one('SELECT session_id FROM cli_sessions WHERE thread_id = ?', th.id)?.session_id;

  const a = await turn('Wat is de hoofdstad van Frankrijk?');
  const sid = session();
  check('eerste beurt volgt de instructie waarmee het gesprek begon', a.m.content.toUpperCase().includes(first.toUpperCase()), first.toUpperCase());

  // The owner changes what the bot must do; the same conversation goes on.
  await t.api('PATCH', `/agents/${bot.id}`, { instructions: rule(second) });
  const b = await turn('En van Italië?');
  check('hetzelfde gesprek is voortgezet (dezelfde sessie van Claude Code)', session() === sid && b.steps.some((s) => /^Verder in het vorige Claude Code-gesprek/.test(s)), sid);
  check('TeamBot gaf alleen het gewijzigde onderdeel mee', b.steps.some((s) => /^Bijgewerkte instructies meegegeven \(Gewijzigd: Jouw instructies\)/.test(s)), b.steps.find((s) => /instructies/.test(s)) || '');
  check('de bot volgt de nieuwe instructie', b.m.content.toUpperCase().includes(second.toUpperCase()), second.toUpperCase());
  check('en niet meer de oude', !b.m.content.toUpperCase().includes(first.toUpperCase()), first.toUpperCase());
  console.log(`\n${results.filter(Boolean).length}/${results.length} goed`);
} finally {
  await t.close();
  fs.rmSync(debug, { recursive: true, force: true });
}
process.exit(results.every(Boolean) ? 0 : 1);
