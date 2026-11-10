// The stricter language check and the pipeline fixes behind it (acceptance round 4, C-15: `i18n:check` said 0 while
// English and German still showed Dutch on 10 of 26 pages: badges such as "abonnement", "lokaal, gratis", sentences
// put together from pieces, server texts the extractor never saw).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Translator, patternSource } from '../shared/i18n-core.js';
import { copiedDutch, dutchDetector } from '../scripts/i18n-lib.mjs';

const lib = async () => import(pathToFileURL(path.join(process.cwd(), 'scripts', 'i18n-extract.mjs')).href);

test('detector: Dutch words the language never uses, Dutch phrases inside a text, known texts left as they are', () => {
  const sources = ['abonnement', 'betaald', 'lokaal, gratis', 'Geen extra kosten', 'Abonnement opzeggen', 'Opslaan', 'de bot is gestopt'];
  const en = { abonnement: 'subscription', betaald: 'paid', 'lokaal, gratis': 'local, free', 'Geen extra kosten': 'No extra costs', 'Abonnement opzeggen': 'Cancel subscription', Opslaan: 'Save', 'de bot is gestopt': 'the bot has stopped' };
  const de = { abonnement: 'Abonnement', betaald: 'bezahlt', 'lokaal, gratis': 'lokal, kostenlos', 'Geen extra kosten': 'Keine Zusatzkosten', 'Abonnement opzeggen': 'Abonnement kündigen', Opslaan: 'Speichern', 'de bot is gestopt': 'der Bot ist gestoppt' };
  const detEn = dutchDetector('en', { sources, dict: en, en, keep: ['Helper'] });
  const detDe = dutchDetector('de', { sources, dict: de, en, keep: ['Helper'] });
  assert.match(detEn('abonnement'), /onvertaald|woord/);
  assert.equal(detDe('Abonnement'), '', 'German uses "Abonnement" too');
  assert.match(detEn('Claude Code · haiku (betaald)'), /woord "betaald"/);
  assert.match(detEn('met haiku (geen extra kosten)'), /bevat "geen extra kosten"/);
  assert.equal(detEn('Save · subscription · local, free'), '');
  assert.equal(detEn('Helper'), '', 'names stay');
  assert.match(detEn('{0} bestanden'), /kapot/);
  assert.equal(detDe('Speichern'), '');
});

test('copied Dutch in a translation is found ("Controle mislukt : {0}" in French)', () => {
  const sources = ['Controle mislukt: {0}', 'Alle routines staan op pauze; niet uitgevoerd', 'Opslaan', 'de controle is klaar'];
  const en = { 'Controle mislukt: {0}': 'Check failed: {0}', 'Alle routines staan op pauze; niet uitgevoerd': 'All routines are paused; not run', Opslaan: 'Save' };
  const fr = { 'Controle mislukt: {0}': 'Controle mislukt : {0}', 'Alle routines staan op pauze; niet uitgevoerd': 'Toutes les routines sont en pause ; non exécutées', Opslaan: 'Enregistrer' };
  assert.deepEqual(copiedDutch('fr', fr, sources, en), ['Controle mislukt: {0}']);
  assert.deepEqual(copiedDutch('en', en, sources, en), []);
});

test('translator: optional glued parts, separators around a fragment, sentences, the most specific pattern', () => {
  // A placeholder glued to the text may be empty: the code leaves an optional " (elke dag)" out.
  assert.match('hebt de routine X gemaakt', new RegExp(patternSource('hebt de routine {0} gemaakt{1}')));
  assert.doesNotMatch(' berichten', new RegExp(patternSource('{0} berichten')));
  const t = new Translator(
    {
      'hebt de routine {0} gemaakt{1}': 'have created the routine {0}{1}',
      handmatig: 'manual',
      'nog downloaden': 'still to download',
      'Weer beschikbaar rond {0}.': 'Available again around {0}.',
      'Bots met een reserve-engine schakelen vanzelf over.': 'Bots with a backup engine switch over by themselves.',
      'Limieten van {0}': 'Limits of {0}',
      'Limieten van {0} opnieuw opvragen': 'Fetch the limits of {0} again',
      'voor {0}': 'for {0}',
    },
    'en-GB',
  );
  assert.equal(t.translate('hebt de routine “Ochtend” gemaakt'), 'have created the routine “Ochtend”');
  assert.equal(t.translate('hebt de routine “Ochtend” gemaakt (elke dag)'), 'have created the routine “Ochtend” (elke dag)');
  assert.equal(t.translate(' · handmatig'), ' · manual');
  assert.equal(t.translate('LJ (English, female) — nog downloaden'), 'LJ (English, female) — still to download');
  assert.equal(t.translate('Weer beschikbaar rond 13:19. Bots met een reserve-engine schakelen vanzelf over.'), 'Available again around 13:19. Bots with a backup engine switch over by themselves.');
  assert.equal(t.translate('Limieten van Claude Code opnieuw opvragen'), 'Fetch the limits of Claude Code again');
  // Short patterns only for known fragments of a composed sentence.
  assert.equal(t.translate('voor Ada'), 'voor Ada');
  assert.equal(t.fragment(' voor Ada'), ' for Ada');
});

test('translator: a pattern never swallows another part; a detail in brackets; the whole sentence before its parts', () => {
  const t = new Translator(
    {
      'Niet bereikbaar': 'Not reachable',
      '{0} downloaden': '{0} download',
      'nog downloaden': 'still to download',
      'MLS (Duits, meerdere stemmen)': 'MLS (German, multiple voices)',
      '{0} heeft het maximum van {1} stappen bereikt en is gestopt. Stuur een bericht om verder te gaan.': '{0} reached the maximum of {1} steps and stopped. Send a message to continue.',
      '{0} is gestopt.': '{0} has stopped.',
      'Stuur een bericht om verder te gaan.': 'Send a message to continue.',
    },
    'en-GB',
  );
  t.keep.add('Helper');
  assert.equal(t.translate('Niet bereikbaar (bad port)'), 'Not reachable (bad port)');
  assert.equal(t.translate('MLS (Duits, meerdere stemmen) — nog downloaden'), 'MLS (German, multiple voices) — still to download');
  assert.equal(
    t.translate('Helper heeft het maximum van 40 stappen bereikt en is gestopt. Stuur een bericht om verder te gaan.'),
    'Helper reached the maximum of 40 steps and stopped. Send a message to continue.',
  );
  // A German date in a value ("7. Nov. 2026") is no sentence end (round 5: the memory page stayed Dutch in German);
  // a time before a new sentence still is.
  const de = new Translator({ 'Wat ik bij het onderhoud van {0} heb bijgewerkt': 'Was ich bei der Wartung von {0} aktualisiert habe', 'Weer beschikbaar rond {0}.': 'Wieder verfügbar gegen {0}.' }, 'de-DE');
  assert.equal(de.translate('Wat ik bij het onderhoud van 7. Nov. 2026, 16:38 heb bijgewerkt'), 'Was ich bei der Wartung von 7. Nov. 2026, 16:38 aktualisiert habe');
  assert.equal(de.translate('Weer beschikbaar rond 13:19. Bots met een reserve-engine schakelen vanzelf over.'), 'Weer beschikbaar rond 13:19. Bots met een reserve-engine schakelen vanzelf over.');
});

test('routine schedules in the reader\'s language (Dutch unchanged for the bots)', async () => {
  const { describeSchedule } = await import('../server/modules/routines/schedule.js');
  const weekly = { kind: 'weekly', days: [1, 3, 5], times: ['08:30'] } as any;
  assert.equal(describeSchedule(weekly, 'Europe/Amsterdam'), 'Elke maandag, woensdag en vrijdag om 08:30');
  const en = describeSchedule(weekly, 'Europe/Amsterdam', 'en');
  assert.match(en, /Monday, Wednesday,? and Friday/);
  assert.doesNotMatch(en, /maandag|\bom\b|\belke\b/i);
  assert.match(describeSchedule(weekly, 'Europe/Amsterdam', 'de'), /Montag, Mittwoch und Freitag/);
});

test('extractor: nested templates, the security log per actor, labels and badges without the common Dutch words', async () => {
  const { extractStrings, templateLiterals } = await lib();
  const src = "x = `{h} de routine ${q(d.name)} gemaakt${d.schedule ? ` (${clean(d.schedule)})` : ''}`;";
  assert.deepEqual(
    templateLiterals(src).map((x: { pat: string }) => x.pat),
    [' ({0})', '{h} de routine {0} gemaakt{1}'],
  );
  const { strings } = extractStrings(process.cwd());
  for (const s of ['hebt een instelling van {0} gewijzigd', 'heeft een instelling van {0} gewijzigd', 'AI-diensten', 'lokaal, gratis', 'abonnement', 'betaald', 'gevonden', 'nog downloaden', 'Het lokale spraakmodel is nog niet gedownload ({0}). Download het bij Instellingen › Spraak.', 'Bots met een reserve-engine gaan daarop verder.'])
    assert.ok(strings.has(s), `extracted: ${s}`);
  // Acceptance round 5 (C-15): "Active path: ChatGPT-abonnement" and "Ingelogd (ChatGPT)." stayed Dutch in English
  // (one word is never picked up; a bracket before the full stop is no known text).
  // (and the calls per person on the usage overview: "5 aufrufen" in German was the loose verb; now one plural sentence)
  for (const s of ['Je ChatGPT-abonnement', 'Je Claude-abonnement', 'Ingelogd met ChatGPT.', 'Ingelogd met een API-sleutel.', '{0, plural, one {# aanroep} other {# aanroepen}}'])
    assert.ok(strings.has(s), `extracted: ${s}`);
  // The channel lines of the security log as whole sentences per actor ("You hebt een koppelcode voor een kanaal
  // gemaakt" and "TeamBot heeft een nieuwe afzender via webhook connected" in round 5).
  for (const s of ['hebt een koppelcode voor {0} gemaakt', 'heeft een nieuwe afzender via {0} gekoppeld', 'hebt een kanaal verbonden', 'hebt {0} toegestaan om jou zonder vragen berichten te sturen'])
    assert.ok(strings.has(s), `extracted: ${s}`);
  // A backtick or quote inside a regex literal (/please\s+[`'"]?log ?in/, .replace(/"/g, …)) no longer turns the
  // templates after it inside out: the engine errors in the chat ("De gratis limiet van OpenCode is bereikt. Probeer het
  // later opnieuw …") were never extracted and stood in Dutch in English.
  for (const s of ['De gratis limiet van {0} is bereikt{1}. Probeer het later opnieuw of kies een ander model.', '{0} is niet (meer) ingelogd. Log zelf in met: {1}', '{0} kent dit model niet (meer). Kies een ander model in de instellingen van de bot.', 'Pakketsoort “{0}” wordt niet ondersteund.', 'kernprofiel bijgewerkt', '{0} besluiten'])
    assert.ok(strings.has(s), `extracted: ${s}`);
  const tricky = "const P = /please\\s+[`'\"]?log ?in/i;\nconst a = `Eerste ${x}`;\nconst b = `<d t=\"${t.replace(/\"/g, \"'\")}\">`;\nconst c = [y, z ? `${p}==${q}` : y];\nconst d = n / 2 + `Tweede ${n}`;";
  assert.deepEqual(
    templateLiterals(tricky).map((x: { pat: string }) => x.pat),
    ['Eerste {0}', '<d t="{0}">', '{0}=={1}', 'Tweede {0}'],
  );
  for (const s of ['^(?:de|onze|mijn) ([\\p{L}-]{3,30}) (?:staat|is) gepland (?:voor|op) (\\d{1,2} (?:{0})(?: \\d{4})?|{1})\\b.{0,60}$', '#inhoud', 'memory/beoordelen'])
    assert.ok(!strings.has(s), `not interface text: ${s}`);
});
