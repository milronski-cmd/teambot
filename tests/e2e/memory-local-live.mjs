// LIVE check of memory with the local Ollama on this computer (temp data dir; nothing of yours is touched):
//   1. sources from memory with a local model: the model answers from memory without citing it → the source shows (A-42);
//   2. the notice when memory is full (A-46);
//   3. a pinned standing rule reaches the local model in its system prompt;
//   4. search by meaning: state of the embedding model, and a fact in other words when one is installed.
// The bot's answers come from the real local model (no cloud, no subscription limits).
//   TEAMBOT_TEST_PORT=4815 node --import tsx tests/e2e/memory-local-live.mjs
//   MEMORY_LIVE_MODEL=<ollama model>   (default: the first chat model Ollama lists)
import { startTestApp } from '../helpers.ts';
import { systemPromptText } from '../../server/modules/memory/context.ts';

const BASE = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const log = (...a) => console.log(...a);
const tags = await fetch(`${BASE}/api/tags`).then((r) => r.json()).catch(() => null);
if (!tags) {
  log('Ollama draait niet op', BASE, '— niets getest.');
  process.exit(2);
}
const chatModels = (tags.models || []).filter((m) => !m.capabilities || m.capabilities.includes('completion')).map((m) => m.name);
const embedModels = (tags.models || []).filter((m) => (m.capabilities || []).includes('embedding')).map((m) => m.name);
const MODEL = process.env.MEMORY_LIVE_MODEL || chatModels[0];
log('Ollama', BASE, '· chatmodel', MODEL, '· embedmodellen', embedModels.length ? embedModels.join(', ') : '(geen)');

const t = await startTestApp();
const out = { model: MODEL };
try {
  await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
  const owner = t.app.ctx.auth.owner().id;
  const p = t.app.ctx.providers.create(owner, { kind: 'ollama', base_url: `${BASE}/v1` });
  const a = await t.api('POST', '/agents', { name: 'Lokaal', provider_id: p.id, model: MODEL, access_mode: 'chat' });
  const say = async (th, text) => {
    const t0 = Date.now();
    const msgs = await t.say(th, text, 600_000);
    const ans = msgs.filter((m) => m.role === 'assistant').at(-1);
    log(`  > ${text}\n  < ${String(ans?.content || '').replace(/\s+/g, ' ').slice(0, 200)} (${((Date.now() - t0) / 1000).toFixed(1)} s${ans?.status !== 'done' ? `, ${ans?.status}: ${ans?.parts?.error || ''}` : ''})`);
    return { msgs, ans };
  };

  // 1. Sources from memory with a local model.
  log('\n1. Bronnen uit het geheugen bij een lokaal model');
  const th = await t.api('POST', '/threads', { agentId: a.id });
  await say(th.id, 'Onthoud dat mijn hond Bram heet.');
  await say(th.id, 'Onthoud dat mijn kat Mo heet.');
  const items = (await t.api('GET', '/memory/items?scope=about_you')).items;
  const dog = items.find((i) => /Bram/.test(i.content));
  const th2 = await t.api('POST', '/threads', { agentId: a.id });
  const { ans } = await say(th2.id, 'Hoe heet mijn hond? Antwoord in één korte zin.');
  const cited = /\[m:[a-z0-9]+\]/.test(ans.content);
  const src = await t.api('GET', `/memory/thread/${th2.id}/answer-sources`);
  const implied = (src.byMessage[ans.id] || []).map((c) => c.label);
  out.sources = { answer: ans.content, cited, implied, ok: cited || implied.some((l) => /Bram/.test(l)) };
  log('  bron onder het antwoord:', cited ? 'model citeerde zelf' : implied.length ? implied.join(' | ') : '(geen)', out.sources.ok ? '✔' : '✖');
  void dog;

  // 2. Memory full.
  log('\n2. Melding bij een vol geheugen');
  const notes = [];
  t.app.ctx.events.on('notification', (e) => notes.push(e.data));
  await t.api('PUT', '/memory/settings', { quotas: { about_you: { items: 10, bytes: 100_000 } } });
  const have = (await t.api('GET', '/memory/items?scope=about_you')).items.length;
  for (let i = have; i < 10; i++) await t.api('POST', '/memory/items', { content: `Vulregel ${i} ${i * 7919}`, scope: 'about_you' });
  const leiden = await say(th.id, 'Ik woon in Leiden.');
  const full = notes.filter((n) => n?.title === 'Geheugen vol');
  // The bot heard it before answering: it should not claim it remembered (seen live before this was added).
  const claims = /\b(heb|is)\b[^.]{0,40}\bonthouden\b/i.test(leiden.ans.content) && !/\bvol\b|niet (?:meer )?(?:onthouden|opslaan|bewaren)/i.test(leiden.ans.content);
  out.full = { notices: full.map((n) => n.body), answer: leiden.ans.content, botClaimsRemembered: claims, ok: full.length === 1 };
  log('  melding:', full.map((n) => `${n.title}: ${n.body}`).join(' | ') || '(geen)', out.full.ok ? '✔' : '✖');
  log('  bot belooft niets dat niet kan:', claims ? '✖ (zegt dat hij het onthouden heeft)' : '✔');

  // 3. A standing rule reaches the local model (system prompt), also with a tiny memory budget.
  log('\n3. Vaste regel bij een lokaal model');
  await t.api('PUT', '/memory/settings', { quotas: { about_you: { items: 300, bytes: 256_000 } } });
  const rule = (await t.api('POST', '/memory/items', { content: 'Vraag altijd eerst toestemming voordat je iets verwijdert', scope: 'about_you', type: 'instruction', pinned: true })).item;
  await t.api('PATCH', `/agents/${a.id}`, { settings: { memory: { budgetTokens: 0, profileCap: 0 } } });
  // The memory part of the bot's system prompt, as the runner builds it for this conversation.
  const sys = systemPromptText(t.app.ctx.services.memory.svc, t.app.ctx.store.agent(a.id), t.app.ctx.store.thread(th.id));
  const th3 = await t.api('POST', '/threads', { agentId: a.id });
  const r3 = await say(th3.id, 'Verwijder alle oude offertes uit mijn map, meteen.');
  out.rule = { inSystemPrompt: sys ? sys.includes(`[m:${rule.ref}]`) : null, answer: r3.ans.content.slice(0, 300) };
  log('  regel in de systeemprompt:', out.rule.inSystemPrompt === null ? '(niet uit te lezen)' : out.rule.inSystemPrompt ? '✔' : '✖');

  // 4. Search by meaning.
  log('\n4. Zoeken op betekenis');
  const sem = await t.api('GET', '/memory/semantic?fresh=1');
  out.semantic = { state: sem.state, model: sem.model, models: sem.models };
  log('  status:', sem.state, sem.model || '', sem.state === 'no-model' ? '(geen embedmodel in Ollama: zoeken op woorden werkt, de knop bij Opslag kan bge-m3 downloaden)' : '');
  await t.api('POST', '/memory/items', { content: 'Mijn auto is een blauwe Volvo', scope: 'about_you' });
  if (sem.state === 'on') {
    await t.app.ctx.services.memory.drain();
    const r = await t.api('GET', '/memory/search?q=' + encodeURIComponent('Welke wagen rijd ik?'));
    out.semantic.found = r.items.slice(0, 3).map((i) => `${i.content}${i.meaning ? ' (betekenis)' : ''}`);
    log('  "Welke wagen rijd ik?" →', out.semantic.found.join(' | ') || '(niets)');
  } else {
    const r = await t.api('GET', '/memory/search?q=' + encodeURIComponent('wagen'));
    log('  zonder embedmodel: "wagen" vindt', r.items.length, 'items (alleen woorden); "auto" vindt', (await t.api('GET', '/memory/search?q=auto')).items.length);
  }
} finally {
  await t.close();
}
log('\nResultaat:', JSON.stringify(out, null, 2));
process.exit(out.sources?.ok && out.full?.ok ? 0 : 1);
