// LIVE check of memory as a user meets it, in an empty TeamBot data folder (startTestApp: its own folder and port):
//   1. the owner tells bot A in the chat what its task is from now on, and a fact about the work;
//   2. in a NEW conversation A has its task (and follows it) and knows the fact;
//   3. colleague B (same team) knows the fact in its own new conversation; C (another team) does not;
//   4. what the owner tells C (the other team) about himself stays in that team;
//   5. (--shorten) A keeps its own dossier: told something to note while its working notes are nearly full, it makes
//      them shorter.
// Engines (one per run, as few turns as the proof needs):
//   node --import tsx tests/e2e/memory-flow-live.mjs --engine haiku   (Claude Code with the owner's login, model haiku)
//   node --import tsx tests/e2e/memory-flow-live.mjs --engine qwen    (Ollama on this computer, qwen3:1.7b)
//   node --import tsx tests/e2e/memory-flow-live.mjs --engine none    (no AI at all: what memory does without a model)
// Set XDG_DOCUMENTS_DIR and TEMP to a folder of your own: bot workspaces and the data folder go there.
const { startTestApp } = await import('../helpers.ts');
const { systemPromptText } = await import('../../server/modules/memory/context.ts');

const arg = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const ENGINE = arg('engine', 'haiku');
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${String(detail).replace(/\s+/g, ' ').slice(0, 400)}` : ''}`);
};

const t = await startTestApp();
const st = t.app.ctx.store;
const mem = t.app.ctx.services.memory;
try {
  const me = t.app.ctx.auth.owner().id;
  let provider = null;
  let model = '';
  if (ENGINE === 'qwen') {
    provider = t.app.ctx.providers.create(me, { kind: 'ollama', base_url: `${OLLAMA}/v1` });
    model = 'qwen3:1.7b';
  } else if (ENGINE === 'haiku') {
    provider = await t.api('POST', '/providers', { kind: 'claude-code' });
    model = 'haiku';
  } else st.exec('DELETE FROM providers');
  const bot = async (name, extra = {}) => (provider ? t.api('POST', '/agents', { name, provider_id: provider.id, model, ...extra }) : t.api('POST', '/agents', { name, ...extra }));
  const A = await bot('Ada');
  const B = await bot('Bo');
  const team2 = await t.api('POST', '/teams', { name: 'Thuis', starterRules: false });
  const C = await bot('Cas', { settings: { homeTeam: team2.id } });
  t.app.ctx.services.teams.setHome(me, team2.id, C.id);
  const eng = await t.api('GET', '/memory/engine');
  console.log(`Engine: ${ENGINE}${model ? ` (${model})` : ''} · nalezen: ${eng.engine ? eng.engine.label : `niet — ${eng.blocked}`}`);

  const say = async (agentId, text, threadId = null) => {
    const th = threadId ? { id: threadId } : await t.api('POST', '/threads', { agentId });
    const t0 = Date.now();
    let msgs = [];
    try {
      msgs = await t.say(th.id, text, 600_000);
    } catch {
      msgs = st.messages(th.id);
    }
    const ans = msgs.filter((m) => m.role === 'assistant').at(-1);
    const steps = (ans?.parts?.activity || []).filter((x) => x.kind === 'tool').map((x) => x.title);
    console.log(`\n> ${text}\n< ${String(ans?.content || '(geen antwoord)').replace(/\s+/g, ' ').slice(0, 300)} (${((Date.now() - t0) / 1000).toFixed(0)} s${steps.length ? `; stappen: ${steps.join(' | ')}` : ''}${ans && ans.status !== 'done' ? `; ${ans.status}: ${ans.parts?.error || ''}` : ''})`);
    return { th, ans };
  };
  const notes = (agentId) => String(st.one("SELECT body FROM memory_dossiers WHERE core = 'notes' AND created_by_agent = ?", agentId)?.body || '');
  const prompt = (agentId) => systemPromptText(mem.svc, st.agent(agentId), null) || '';

  console.log('\n1. De eigenaar vertelt het één keer, in de chat met Ada');
  const first = await say(A.id, 'Vanaf nu is dit je vaste taak: je beantwoordt binnenkomende vragen over bestellingen. Antwoord altijd in korte zinnen en eindig elk antwoord met een vraag.');
  check('de taak staat meteen in Ada’s werknotities, onder de opdrachten van de eigenaar', /## Opdrachten van de eigenaar[\s\S]*vaste taak: je beantwoordt binnenkomende vragen over bestellingen/.test(notes(A.id)), notes(A.id));
  await say(A.id, ENGINE === 'none' ? 'Onthoud dat onze leverancier Frameworks de frames voortaan op donderdag levert.' : 'Onze leverancier Frameworks levert de frames voortaan op donderdag.', first.th.id);
  // The conversation goes quiet; the owner presses "nu nalezen" instead of waiting a quarter of an hour.
  const learned = await t.api('POST', `/memory/thread/${first.th.id}/learn`, {});
  console.log(`  nalezen: ${JSON.stringify({ method: learned.method, applied: learned.applied, dropped: learned.dropped, error: learned.error })}`);
  await mem.drain();
  const overview = st.all("SELECT d.title, d.body FROM memory_dossiers d WHERE d.core = 'overview'").map((d) => `${d.title}: ${d.body}`).join(' | ');
  const overviewNotes = st.all("SELECT i.content FROM memory_items i JOIN memory_dossiers d ON d.id = i.dossier_id WHERE d.core = 'overview' AND i.status = 'active'").map((r) => r.content).join(' | ');
  check('het feit over het werk staat bij het overzicht van het team', /donderdag/i.test(overview + overviewNotes), overview + ' ' + overviewNotes);

  console.log('\n2. Een nieuw gesprek met Ada');
  check('de taak staat in wat Ada in elke beurt leest', /Opdrachten van de eigenaar[\s\S]*bestellingen/.test(prompt(A.id)));
  if (provider) {
    const r = await say(A.id, 'Er komt een vraag binnen van een klant: waar blijft bestelling 1042?');
    const text = String(r.ans?.content || '').trim();
    check('Ada volgt de taak zonder dat het opnieuw gezegd is (kort, eindigt met een vraag)', text.length > 0 && text.length < 600 && /\?\s*$/.test(text), text);
  }

  console.log('\n3. Collega Bo (zelfde team) en Cas (ander team)');
  check('Bo leest het feit in elke beurt; Cas niet; Ada’s taak is niet die van Bo', /donderdag/i.test(prompt(B.id)) && !/Frameworks|donderdag/i.test(prompt(C.id)) && !/bestellingen/.test(prompt(B.id)));
  if (provider) {
    const b = await say(B.id, 'Op welke dag levert Frameworks de frames?');
    check('Bo weet het in een nieuw gesprek', /donderdag/i.test(String(b.ans?.content || '')), b.ans?.content);
    const c = await say(C.id, 'Op welke dag levert Frameworks de frames? Als je het niet weet, zeg dan alleen: weet ik niet.');
    check('Cas (ander team) weet het niet', !/donderdag/i.test(String(c.ans?.content || '')), c.ans?.content);
  }

  console.log('\n4. Wat de eigenaar in het andere team over zichzelf vertelt, blijft daar');
  const leak = await say(C.id, 'Onthoud dat mijn codewoord voor de kluis KOLIBRIE-23 is.');
  check('Cas leest het, Ada en Bo niet', /KOLIBRIE/.test(prompt(C.id)) && !/KOLIBRIE/.test(prompt(A.id)) && !/KOLIBRIE/.test(prompt(B.id)));
  if (provider) check('wat Cas zegt over waar het staat, klopt (niet "alle teams")', !/alle teams|al je bots|alle bots(?! van team)/i.test(String(leak.ans?.content || '')), leak.ans?.content);

  if (process.argv.includes('--shorten') && provider) {
    console.log('\n5. Ada houdt haar eigen dossier bij en maakt het korter');
    const d = st.one("SELECT id, body FROM memory_dossiers WHERE core = 'notes' AND created_by_agent = ?", A.id);
    const filler = ['## Lopend werk'];
    for (let i = 1; filler.join('\n').length < 2600; i++) filler.push(`- Vraag ${i} over een bestelling is beantwoord en afgesloten; de klant was tevreden en er hoeft niets meer te gebeuren.`);
    await t.api('PATCH', `/memory/dossiers/${d.id}`, { body: `${d.body}\n\n${filler.join('\n')}` });
    const before = notes(A.id).length;
    await say(A.id, 'Bestelling 1042 is vertraagd tot vrijdag. Houd dat bij in je werknotities.');
    const after = notes(A.id);
    check('Ada zette het erin en maakte haar werknotities korter, met de opdracht er nog in', /1042/.test(after) && after.length < before && /bestellingen/.test(after), `${before} → ${after.length} tekens`);
  }
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} goed (${ENGINE})`);
  process.exitCode = ok === results.length ? 0 : 1;
} finally {
  await t.close();
}
