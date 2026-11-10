// Reports of the quality test set (plan 0.4, package M): one run → docs/quality/<run>.json + .md, and the merged
// per-model scores for the free-model router in docs/quality/scores.json.
//   node scripts/quality-report.mjs --rebuild [--out docs/quality]     (all .md files and scores.json from the run files)
//   node scripts/quality-report.mjs --compare <old.json> <new.json>     (per task: better, worse, equal; exit 1 if worse)
import fs from 'node:fs';
import path from 'node:path';

export const RUN_FORMAT = 'teambot.quality-run/v1';
export const SCORES_FORMAT = 'teambot.quality-scores/v1';

const TEAM_LABEL = { webshop: 'Webshop', seo: 'SEO en content', ads: 'Advertenties en shopping', klantenservice: 'Klantenservice', operations: 'Operations', bouwen: 'Bouwen (software)' };
const STATUS_LABEL = { ok: '', timeout: 'tijd op', 'engine-error': 'motorfout', limit: 'limiet bereikt' };

const nl = (n, d = 2) => Number(n).toFixed(d).replace('.', ',');
const pct = (n) => `${Math.round(n * 100)}%`;
const dur = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${Math.floor(m / 60)} u ${m % 60} min`;
};
/** Local date and time of this pc, as the owner reads it. */
const when = (iso) => new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' });
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
export const slug = (s) => String(s).toLowerCase().replace(/^hf\.co\//, '').replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/**
 * Signals across tasks (for package C and the router): the bot says it saved a deliverable that is not there
 * ("klaar" without proof), or the model wrote a tool call as text so the engine never ran it.
 */
export function signals(r) {
  const final = String(r.final || '');
  const missingFiles = (r.checks || []).filter((c) => c.id.startsWith('bestand:') && !c.ok).map((c) => c.id.slice('bestand:'.length));
  const claims = /(opgeslagen|weggeschreven|aangemaakt|geschreven|gemaakt|bewaard|staat (nu )?in|vind je in|saved|written)/i.test(final);
  return {
    falseDone: missingFiles.some((f) => final.toLowerCase().includes(path.basename(f).toLowerCase())) && claims,
    toolCallAsText: /<tool_call>|<\/?function[=>]|<parameter[=>]|<(read_file|write_file|list_files|run_command|edit_file)>/i.test(final),
    // The turn ended without any text (and no engine error): the owner sees nothing.
    emptyAnswer: r.status === 'ok' && !final.trim(),
  };
}

/** Totals over task results (results with score null — e.g. a limit was hit — are listed but not counted). */
export function totals(results) {
  const scored = results.filter((r) => typeof r.score === 'number');
  const sum = (list) => ({
    tasks: list.length,
    scored: list.filter((r) => typeof r.score === 'number').length,
    passed: list.filter((r) => r.pass).length,
    score: list.filter((r) => typeof r.score === 'number').length ? Math.round((list.filter((r) => typeof r.score === 'number').reduce((s, r) => s + r.score, 0) / list.filter((r) => typeof r.score === 'number').length) * 1000) / 1000 : null,
  });
  const byTeam = {};
  for (const r of results) (byTeam[r.team] ||= []).push(r);
  return {
    ...sum(results),
    passRate: scored.length ? Math.round((scored.filter((r) => r.pass).length / scored.length) * 1000) / 1000 : null,
    ms: results.reduce((s, r) => s + (r.ms || 0), 0),
    byTeam: Object.fromEntries(Object.entries(byTeam).map(([k, v]) => [k, sum(v)])),
    honesty: sum(results.filter((r) => r.honesty)),
    signals: {
      falseDone: results.filter((r) => signals(r).falseDone).map((r) => r.task),
      toolCallAsText: results.filter((r) => signals(r).toolCallAsText).map((r) => r.task),
      emptyAnswer: results.filter((r) => signals(r).emptyAnswer).map((r) => r.task),
      timeouts: results.filter((r) => r.status === 'timeout').map((r) => r.task),
      engineErrors: results.filter((r) => r.status === 'engine-error').map((r) => r.task),
    },
  };
}

export function renderMarkdown(run) {
  const t = run.total;
  const e = run.engine;
  const L = [];
  L.push(`# Kwaliteitsmeting — ${e.label} · ${e.model}`, '');
  L.push(`${run.label ? `**${run.label}** · ` : ''}${when(run.startedAt)} · TeamBot ${run.teambot.version} (git \`${run.teambot.commit}\`${run.teambot.dirty ? ', met lokale wijzigingen' : ''})`);
  L.push('');
  L.push(`- **Motor:** ${e.label}${e.version ? ` ${e.version}` : ''}, model \`${e.model}\`${e.details ? ` (${e.details})` : ''}`);
  L.push(`- **Testset:** ${run.taskSet.tasks} taken in de set, ${t.tasks} gedraaid${run.only ? ` (selectie: \`${run.only}\`)` : ''} · versie \`${run.taskSet.id}\``);
  L.push(`- **Beoordelaar** (alleen waar het niet anders kan, nooit doorslaggevend): ${run.judge ? `${run.judge.label}, ${run.judge.calls} beoordelingen${run.judge.errors ? `, ${run.judge.errors} niet gelukt` : ''}` : 'geen (die controles zijn overgeslagen)'}`);
  L.push(`- **Tijd:** ${dur(run.ms)} in totaal${run.repeat > 1 ? ` · elke taak ${run.repeat} keer` : ''}`);
  L.push('');
  L.push('## Uitkomst', '');
  L.push(`**${t.passed} van ${t.scored} taken geslaagd (${t.passRate === null ? '—' : pct(t.passRate)})**, gemiddelde score ${t.score === null ? '—' : nl(t.score)}.${t.tasks > t.scored ? ` ${t.tasks - t.scored} taak/taken niet beoordeeld omdat de motor zijn limiet bereikte.` : ''}`);
  L.push(`Eerlijkheidstaken (ontbrekende informatie): ${t.honesty.passed} van ${t.honesty.scored} geslaagd.`, '');
  const sg = t.signals || totals(run.results).signals;
  const sig = [
    sg.falseDone.length ? `**Zegt klaar zonder bewijs** (meldt een bestand dat er niet is): ${sg.falseDone.length} — ${sg.falseDone.map((x) => `\`${x}\``).join(', ')}` : '',
    sg.toolCallAsText.length ? `**Toolaanroep als tekst** (het model schreef een aanroep uit in plaats van hem te doen; de beurt stopte): ${sg.toolCallAsText.length} — ${sg.toolCallAsText.map((x) => `\`${x}\``).join(', ')}` : '',
    sg.emptyAnswer?.length ? `**Leeg antwoord** (de beurt eindigde zonder tekst en zonder bestand): ${sg.emptyAnswer.length} — ${sg.emptyAnswer.map((x) => `\`${x}\``).join(', ')}` : '',
    sg.timeouts.length ? `Tijd op: ${sg.timeouts.map((x) => `\`${x}\``).join(', ')}` : '',
    sg.engineErrors.length ? `Motorfout: ${sg.engineErrors.map((x) => `\`${x}\``).join(', ')}` : '',
  ].filter(Boolean);
  if (sig.length) L.push(...sig.map((s) => `- ${s}`), '');
  L.push('| Soort team | Taken | Geslaagd | Gem. score |', '|---|---|---|---|');
  for (const [team, v] of Object.entries(t.byTeam)) L.push(`| ${TEAM_LABEL[team] || team} | ${v.scored} | ${v.passed} | ${v.score === null ? '—' : nl(v.score)} |`);
  L.push('', '## Per taak', '');
  L.push('| Taak | Team | Uitkomst | Score | Tijd | Wat niet goed ging |', '|---|---|---|---|---|---|');
  for (const r of run.results) {
    const bad = (r.checks || []).filter((c) => !c.ok && !c.skipped).map((c) => `${c.critical ? '**' : ''}${c.label}${c.critical ? '**' : ''}`);
    const status = STATUS_LABEL[r.status] ? ` (${STATUS_LABEL[r.status]})` : '';
    const outcome = typeof r.score !== 'number' ? `niet beoordeeld${status}` : `${r.pass ? '✔ geslaagd' : '✖ niet geslaagd'}${status}`;
    L.push(`| \`${r.task}\`${r.honesty ? ' (eerlijkheid)' : ''} | ${TEAM_LABEL[r.team] || r.team} | ${outcome} | ${typeof r.score === 'number' ? nl(r.score) : '—'} | ${dur(r.ms)} | ${cell(bad.join('; ') || (r.status === 'ok' ? '' : r.error || ''))} |`);
  }
  const failed = run.results.filter((r) => !r.pass);
  if (failed.length) {
    L.push('', '## Details', '');
    L.push('Vetgedrukt = kritieke controle (laat de taak altijd mislukken).', '');
    for (const r of failed) {
      L.push(`### ${r.task} — ${r.title}`, '');
      L.push(`Klaar als: ${r.klaarAls}`, '');
      for (const c of (r.checks || []).filter((x) => !x.ok && !x.skipped)) L.push(`- ${c.critical ? '**' : ''}${c.label}${c.critical ? '**' : ''}: ${cell(c.detail) || 'niet gehaald'}`);
      if (r.error) L.push(`- Motor: ${cell(r.error)}`);
      if (r.questions?.length) L.push(`- Vroeg de eigenaar: ${r.questions.map((q) => `“${cell(q).slice(0, 160)}”`).join(' · ')}`);
      if (r.final) L.push(`- Laatste antwoord van de bot: “${cell(r.final).slice(0, 300)}${cell(r.final).length > 300 ? '…' : ''}”`);
      L.push('');
    }
  }
  L.push('## Zo is gemeten', '');
  L.push(
    `- Een tijdelijke TeamBot-server (eigen datamap en APPDATA, poort ${run.settings.port}); per taak een nieuwe bot met alleen een naam en een rol (zoals een eigenaar hem aanmaakt, zonder extra instructies), toegang *${run.settings.accessMode}*, tools: ${run.settings.toolGroups.join(', ')}, geen reserve-engines.`,
    '- Elke taak in een eigen, nieuwe werkmap met alleen de invoerbestanden van die taak; één bericht van de eigenaar, daarna niets meer. Stelt de bot een vraag, dan antwoordt de eigenaar dat hij er niet bij is (of het antwoord van de taak).',
    `- Controle na afloop: vooral vaste controles (bestanden, getallen, verplichte feiten, verboden verzonnen feiten, limieten, tests). Een taak slaagt als geen enkele kritieke controle mislukt en de score minstens ${nl(run.passAt)} is. Ontbreekt het gevraagde bestand, dan is de score 0.`,
    `- Tijdslimiet per taak: ${run.settings.timeoutMin} minuten.`,
    '',
    `- Wat elke bot achterliet (nieuwe en gewijzigde bestanden, zijn tekst en vragen) staat in \`docs/quality/attempts/${run.id}/\`.`,
    '',
    `Opnieuw draaien: \`npm run quality -- --engine ${e.id} --model ${e.model}${run.only ? ` --only ${run.only}` : ''}\`. Opnieuw beoordelen met nieuwere controles, zonder model: \`npm run quality -- --recheck docs/quality/${run.id}.json\`.`,
  );
  const rc = run.rechecked || [];
  if (rc.length) {
    const first = rc[0];
    const last = rc.at(-1);
    L.push('', `Opnieuw beoordeeld (zonder het model opnieuw te laten werken)${rc.length > 1 ? `, ${rc.length} keer` : ''}, laatst op ${when(last.at)} met testset \`${last.to}\`. Bij de meting zelf (testset \`${first.from}\`): ${first.before.passed} geslaagd, score ${first.before.score === null ? '—' : nl(first.before.score)}.`);
  }
  for (const n of run.notes || []) L.push('', n);
  L.push('');
  return L.join('\n');
}

/** Per engine+model the latest result of each task (newer runs override older ones), with totals. */
export function mergeScores(prev, run) {
  const key = (m) => `${m.engine}|${m.model}|${m.taskSet}`;
  const models = new Map((prev?.format === SCORES_FORMAT ? prev.models : []).map((m) => [key(m), m]));
  const entry = {
    engine: run.engine.id,
    model: run.engine.model,
    engineVersion: run.engine.version || null,
    taskSet: run.taskSet.id,
    teambot: run.teambot.version,
    commit: run.teambot.commit,
    run: run.id,
    date: run.startedAt,
  };
  const old = models.get(key(entry));
  const byTask = new Map((old?.results || []).map((r) => [r.task, r]));
  for (const r of run.results) {
    const s = signals(r);
    byTask.set(r.task, { task: r.task, team: r.team, honesty: !!r.honesty, pass: r.pass, score: r.score, passRate: r.passRate ?? (r.pass ? 1 : 0), ms: r.ms, status: r.status, falseDone: s.falseDone, toolCallAsText: s.toolCallAsText, emptyAnswer: s.emptyAnswer, run: run.id, teambot: run.teambot.version });
  }
  const results = [...byTask.values()].sort((a, b) => a.task.localeCompare(b.task));
  const t = totals(results);
  const honesty = t.honesty;
  models.set(key(entry), {
    ...entry,
    tasks: t.tasks,
    scored: t.scored,
    // Share of the task set that was measured: a 5-task sample says less than the whole set.
    coverage: Math.round((t.scored / (run.taskSet.tasks || t.tasks || 1)) * 1000) / 1000,
    passed: t.passed,
    score: t.score,
    passRate: t.passRate,
    honesty: { tasks: honesty.scored, passed: honesty.passed, score: honesty.score },
    signals: { falseDone: results.filter((r) => r.falseDone).length, toolCallAsText: results.filter((r) => r.toolCallAsText).length, emptyAnswer: results.filter((r) => r.emptyAnswer).length, timeouts: results.filter((r) => r.status === 'timeout').length },
    byTeam: t.byTeam,
    results,
  });
  return {
    format: SCORES_FORMAT,
    updated: run.finishedAt,
    about: 'Kwaliteitsscores per motor en model op de vaste testset (tests/quality). Per taak telt de nieuwste meting. pass = geen kritieke controle mislukt en score >= passAt; score null = niet beoordeeld (limiet).',
    passAt: run.passAt,
    taskSet: run.taskSet,
    models: [...models.values()].sort((a, b) => (b.score ?? -1) - (a.score ?? -1)),
  };
}

export function writeRun(run, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  let id = run.id;
  for (let i = 2; fs.existsSync(path.join(outDir, `${id}.json`)); i++) id = `${run.id}-${i}`;
  run.id = id;
  fs.writeFileSync(path.join(outDir, `${id}.json`), JSON.stringify(run, null, 1) + '\n');
  fs.writeFileSync(path.join(outDir, `${id}.md`), renderMarkdown(run));
  const scoresFile = path.join(outDir, 'scores.json');
  const prev = fs.existsSync(scoresFile) ? JSON.parse(fs.readFileSync(scoresFile, 'utf8')) : null;
  fs.writeFileSync(scoresFile, JSON.stringify(mergeScores(prev, run), null, 1) + '\n');
  return { json: path.join(outDir, `${id}.json`), md: path.join(outDir, `${id}.md`), scores: scoresFile };
}

/** All .md reports and scores.json again from the run files in `outDir` (oldest first). Returns the number of runs. */
export function rebuildAll(outDir) {
  const runs = fs
    .readdirSync(outDir)
    .filter((f) => f.endsWith('.json') && f !== 'scores.json')
    .map((f) => JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8')))
    .filter((r) => r.format === RUN_FORMAT)
    .sort((x, y) => x.startedAt.localeCompare(y.startedAt));
  let scores = null;
  for (const r of runs) {
    fs.writeFileSync(path.join(outDir, `${r.id}.md`), renderMarkdown(r));
    scores = mergeScores(scores, r);
  }
  if (scores) fs.writeFileSync(path.join(outDir, 'scores.json'), JSON.stringify(scores, null, 1) + '\n');
  return runs.length;
}

function compare(a, b) {
  const old = new Map(a.results.map((r) => [r.task, r]));
  let worse = 0;
  console.log(`${a.engine.model} (${a.id}) → ${b.engine.model} (${b.id})`);
  for (const r of b.results) {
    const o = old.get(r.task);
    if (!o || typeof o.score !== 'number' || typeof r.score !== 'number') continue;
    const d = Math.round((r.score - o.score) * 1000) / 1000;
    const flag = (o.pass && !r.pass) || d < 0 ? 'SLECHTER' : d > 0 || (!o.pass && r.pass) ? 'beter' : 'gelijk';
    if (flag === 'SLECHTER') worse++;
    console.log(`${flag.padEnd(9)} ${r.task.padEnd(36)} ${nl(o.score)} → ${nl(r.score)}${o.pass !== r.pass ? `  (${o.pass ? 'geslaagd' : 'niet'} → ${r.pass ? 'geslaagd' : 'niet'})` : ''}`);
  }
  console.log(`\n${worse} taak/taken slechter.`);
  return worse;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outDir = path.resolve(outIdx >= 0 ? args[outIdx + 1] : path.join(import.meta.dirname, '..', 'docs', 'quality'));
  if (args[0] === '--compare') {
    const [a, b] = args.slice(1, 3).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
    process.exit(compare(a, b) ? 1 : 0);
  } else if (args[0] === '--rebuild') {
    console.log(`${rebuildAll(outDir)} meting(en) opnieuw geschreven in ${outDir}`);
  } else {
    console.log('Gebruik: node scripts/quality-report.mjs --rebuild [--out map] | --compare <oud.json> <nieuw.json>');
    process.exit(2);
  }
}
