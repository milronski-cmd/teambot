// LIVE test: bots answer in the language the owner writes in, and in a fixed language when one is set — with a real
// CLI engine on the owner's own login (no API key, $0 extra on a subscription).
//   npm run language:live                    (Claude Code)
//   CLI_ENGINE=codex npm run language:live   (Codex CLI)
// TeamBot runs with a temporary data dir (never your real TeamBot data). Four short turns:
//   1. German in → German out (interface language Dutch, so the rule must follow the message, not the app)
//   2. Dutch in → Dutch out (new conversation)
//   3. interface language German, a message without language (only a link) → German (the fallback)
//   4. a fixed language for this bot (French), Dutch in → French out
import { detectTextLanguage } from '../../server/modules/voice/textlang.ts';

const ENGINE = process.env.CLI_ENGINE || 'claude';
const KIND = { claude: 'claude-code', codex: 'codex-cli' }[ENGINE];
if (!KIND) {
  console.log('CLI_ENGINE moet claude of codex zijn');
  process.exit(2);
}
const { startTestApp } = await import('../helpers.ts');
const t = await startTestApp();
const store = t.app.ctx.store;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/** The language of a one-sentence answer (too short for detectTextLanguage): the most common words win. */
const WORDS = {
  de: ['eine', 'ein', 'hat', 'ist', 'die', 'der', 'das', 'und', 'tage', 'sieben', 'woche', 'nicht', 'mit'],
  nl: ['een', 'heeft', 'is', 'de', 'het', 'en', 'dagen', 'zeven', 'week', 'niet', 'met'],
  fr: ['une', 'un', 'a', 'est', 'la', 'le', 'les', 'et', 'jours', 'sept', 'semaine', 'compte', 'pas'],
  en: ['a', 'has', 'is', 'the', 'and', 'days', 'seven', 'week', 'not', 'with'],
};
function shortLanguage(text) {
  const words = String(text).toLowerCase().match(/\p{L}+/gu) || [];
  let best = null;
  let score = 0;
  for (const [code, list] of Object.entries(WORDS)) {
    const s = words.filter((w) => list.includes(w)).length;
    if (s > score) [best, score] = [code, s];
  }
  return score >= 2 ? best : null;
}

/** Send a message, wait for the bot to finish, return its answer and the cost TeamBot booked. */
async function turn(label, threadId, content, timeoutMs = 300_000) {
  const start = Date.now();
  await t.api('POST', `/threads/${threadId}/messages`, { content });
  await new Promise((r) => setTimeout(r, 300));
  while (Date.now() - start < timeoutMs) {
    const busy = store.all("SELECT id FROM runs WHERE thread_id = ? AND status IN ('queued','running','waiting')", threadId);
    if (!busy.length) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  const run = store.all('SELECT * FROM runs WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1', threadId)[0];
  const msg = store.messages(threadId).filter((m) => m.role === 'assistant').at(-1);
  const text = (msg?.content || msg?.parts?.error || '').trim();
  const cost = Number((run?.usage ? JSON.parse(run.usage) : {}).cost || 0);
  const lang = detectTextLanguage(text) || shortLanguage(text);
  console.log(`\n[${label}] ${((Date.now() - start) / 1000).toFixed(1)} s · $${cost.toFixed(4)} · taal: ${lang ?? 'onbekend'}`);
  console.log(`  vraag:   ${content}`);
  console.log(`  antwoord: ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
  return { text, lang, cost, status: run?.status };
}

let total = 0;
try {
  const p = await t.api('POST', '/providers', { kind: KIND, config: {} });
  const bot = await t.api('POST', '/agents', { name: 'Talenbot', provider_id: p.id, model: process.env.CLI_MODEL || '', access_mode: 'chat', tool_groups: [] });
  const owner = t.app.ctx.auth.owner();

  // Interface language Dutch: the German question must still get a German answer.
  store.setSetting(owner.id, 'language', 'nl');
  const th1 = await t.api('POST', '/threads', { agentId: bot.id });
  const r1 = await turn('Duits in', th1.id, 'Wie viele Tage hat eine Woche? Antworte bitte in einem kurzen Satz.');
  check('Duits in → Duits uit', r1.lang === 'de' && /sieben|7/i.test(r1.text), r1.lang);
  total += r1.cost;

  const th2 = await t.api('POST', '/threads', { agentId: bot.id });
  const r2 = await turn('Nederlands in', th2.id, 'Hoeveel dagen heeft een week? Antwoord in één korte zin.');
  check('Nederlands in → Nederlands uit', r2.lang === 'nl' && /zeven|7/i.test(r2.text), r2.lang);
  total += r2.cost;

  // No language in the message (a link and a number): the interface language decides.
  store.setSetting(owner.id, 'language', 'de');
  const th3 = await t.api('POST', '/threads', { agentId: bot.id });
  const r3 = await turn('alleen een link, app in het Duits', th3.id, 'https://example.com ?');
  check('zonder taal in het bericht → de taal van de app (Duits)', r3.lang === 'de', r3.lang);
  total += r3.cost;

  // A fixed language for this bot: French, whatever the owner writes.
  store.setSetting(owner.id, 'language', 'nl');
  await t.api('PATCH', `/agents/${bot.id}`, { settings: { ...(bot.settings || {}), language: 'fr' } });
  const th4 = await t.api('POST', '/threads', { agentId: bot.id });
  const r4 = await turn('vaste taal Frans, Nederlands in', th4.id, 'Hoeveel dagen heeft een week? Antwoord in één korte zin.');
  check('vaste taal per bot (Frans): Nederlands in → Frans uit', r4.lang === 'fr' && /sept|7/i.test(r4.text), r4.lang);
  total += r4.cost;

  console.log(`\nKosten volgens TeamBot: $${total.toFixed(4)} (0 op een abonnement)`);
} catch (e) {
  check('onverwachte fout', false, e.message);
} finally {
  await t.close?.();
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} geslaagd (${ENGINE})`);
process.exit(failed ? 1 : 0);
