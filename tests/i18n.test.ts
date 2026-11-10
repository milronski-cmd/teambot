import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatBytes, formatDate, formatDateTime, formatMoney, formatNumber, formatTime, listTimeIn, plural, relativeTime, shortAgo } from '../shared/format.js';
import { Translator, fill, fillSource, numberIn, placeholders } from '../shared/i18n-core.js';
import { LANGUAGES, isLanguage, languageName, localeOf, matchLanguage } from '../shared/languages.js';
import { botLanguage, DEFAULT_LANGUAGE_NOTE, languageNote, languageSection, nlName, outputLanguage, withLanguage } from '../server/agent/language.js';
import { resetTranslators, tr, userLanguage } from '../server/core/i18n.js';
import { sessionInstructions } from '../server/modules/cli-agents/context.js';
import { shortSystem } from '../server/modules/cli-agents/claude.js';
import { fixMenuPaths, missingPlurals, nameLike, problems, readDict, sourceStrings, targets, wrongScript } from '../scripts/i18n-lib.mjs';
import { startTestApp } from './helpers.js';

const AR = 'ar-u-nu-latn';
const at = (s: string) => new Date(s);

test('languages: registry, first-run match (system language, else English), locales and names', () => {
  for (const c of ['nl', 'en', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'tr', 'uk', 'ar']) assert.ok(isLanguage(c), c);
  assert.equal(LANGUAGES.find((l) => l.code === 'ar')?.dir, 'rtl');
  assert.ok(LANGUAGES.filter((l) => l.code !== 'ar').every((l) => l.dir === 'ltr'));
  assert.equal(matchLanguage(['de-AT', 'en-US']), 'de');
  assert.equal(matchLanguage(['pt-BR']), 'pt');
  assert.equal(matchLanguage(['nl-BE']), 'nl');
  assert.equal(matchLanguage(['nb-NO', 'sv-SE']), 'en', 'fallback English');
  assert.equal(matchLanguage([]), 'en');
  assert.equal(matchLanguage(['zh-CN', 'uk-UA']), 'uk', 'first one TeamBot has');
  assert.equal(localeOf('ar'), AR);
  assert.equal(localeOf('xx'), 'nl-NL');
  assert.equal(languageName('de', 'nl'), 'Duits');
  assert.equal(nlName('uk'), 'Oekraïens');
});

test('locale formatting: dates, times, numbers, money, sizes per language (Arabic with Latin digits)', () => {
  const d = at('2025-03-04T14:05:00');
  assert.equal(formatDate(d, {}, 'nl-NL'), '4 mrt 2025');
  assert.equal(formatDate(d, {}, 'en-GB'), '4 Mar 2025');
  assert.equal(formatDate(d, {}, 'de-DE'), '4. März 2025');
  assert.equal(formatTime(d, 'nl-NL'), '14:05');
  assert.equal(formatTime(d, 'de-DE'), '14:05');
  assert.equal(formatTime(d, AR), '02:05 م', 'Arabic: 12-hour clock, Latin digits');
  assert.match(formatDateTime(d, undefined, 'fr-FR'), /4 mars 2025/);
  assert.equal(formatNumber(1234.5, {}, 'nl-NL'), '1.234,5');
  assert.equal(formatNumber(1234.5, {}, 'en-GB'), '1,234.5');
  assert.equal(formatNumber(1234.5, {}, 'de-DE'), '1.234,5');
  assert.match(formatNumber(1234.5, {}, 'fr-FR'), /^1\s234,5$/);
  assert.equal(formatNumber(1234.5, {}, AR), '1,234.5', 'Latin digits in Arabic');
  assert.equal(formatMoney(1.5, 'USD', {}, 'en-GB'), 'US$1.50');
  assert.match(formatMoney(1.5, 'USD', {}, 'nl-NL'), /^US\$\s1,50$/);
  assert.match(formatMoney(1.5, 'USD', {}, 'de-DE'), /^1,50\s\$$/);
  assert.equal(formatBytes(1536 * 1024, 'nl-NL'), '1,5 MB');
  assert.equal(formatBytes(1536 * 1024, 'en-GB'), '1.5 MB');
  assert.equal(formatDate('niet-een-datum', {}, 'nl-NL'), '');
});

test('relative times: "5 minuten geleden", "gestern", compact list times, in the locale', () => {
  const now = at('2025-03-04T14:05:00').getTime();
  assert.equal(relativeTime(now - 5 * 60_000, { now }, 'nl-NL'), '5 minuten geleden');
  assert.equal(relativeTime(now - 5 * 60_000, { now }, 'de-DE'), 'vor 5 Minuten');
  assert.equal(relativeTime(now - 86_400_000, { now }, 'de-DE'), 'gestern');
  assert.equal(relativeTime(now - 2 * 3600_000, { now }, 'en-GB'), '2 hours ago');
  assert.equal(relativeTime(now + 3 * 86_400_000, { now }, 'fr-FR'), 'dans 3 jours');
  assert.equal(relativeTime(now - 5 * 60_000, { now }, AR), 'قبل 5 دقائق');
  assert.equal(relativeTime(now - 5 * 60_000, { now }, 'uk-UA'), '5 хвилин тому');
  // Compact (chat list, history): "zojuist" is the Dutch source text (the dictionary translates it).
  assert.equal(shortAgo(now - 10_000, now, 'nl-NL'), 'zojuist');
  assert.equal(shortAgo(now - 5 * 60_000, now, 'nl-NL'), '5 min');
  assert.equal(shortAgo(now - 3 * 3600_000, now, 'nl-NL'), '3 uur');
  assert.equal(shortAgo(now - 3 * 3600_000, now, 'de-DE'), '3 Std.');
  assert.equal(shortAgo(now - 30 * 86_400_000, now, 'en-GB'), '2 Feb');
  assert.equal(listTimeIn(now - 60_000, now, 'nl-NL'), '14:04');
  assert.equal(listTimeIn(now - 86_400_000, now, 'nl-NL'), 'gisteren');
  assert.equal(listTimeIn(now - 86_400_000, now, 'pl-PL'), 'wczoraj');
  assert.equal(listTimeIn(now - 2 * 86_400_000, now, 'de-DE'), 'So');
});

test('plural forms per language (one/few/many/other; Arabic zero…many) via Intl.PluralRules', () => {
  const pl = { one: '# plik', few: '# pliki', many: '# plików', other: '# pliku' };
  assert.deepEqual([1, 2, 5, 22, 25].map((n) => plural(n, pl, 'pl-PL')), ['1 plik', '2 pliki', '5 plików', '22 pliki', '25 plików']);
  const uk = { one: '# файл', few: '# файли', many: '# файлів', other: '# файлу' };
  assert.deepEqual([1, 3, 11, 21].map((n) => plural(n, uk, 'uk-UA')), ['1 файл', '3 файли', '11 файлів', '21 файл']);
  const ar = { zero: 'لا ملفات', one: 'ملف واحد', two: 'ملفان', few: '# ملفات', many: '# ملفًا', other: '# ملف' };
  assert.deepEqual([0, 1, 2, 3, 11, 100].map((n) => plural(n, ar, AR)), ['لا ملفات', 'ملف واحد', 'ملفان', '3 ملفات', '11 ملفًا', '100 ملف']);
  assert.equal(plural(1, { one: '# bericht', other: '# berichten' }, 'nl-NL'), '1 bericht');
  assert.equal(plural(1500, { one: '# bericht', other: '# berichten' }, 'nl-NL'), '1.500 berichten');
  assert.equal(plural(0, { one: '# fichier', other: '# fichiers' }, 'fr-FR'), '0 fichier', 'French: 0 is singular');
  assert.equal(plural(3, { other: '# x' }, 'pl-PL'), '3 x', 'missing category → other');
});

test('dictionary translation: exact texts, patterns, ICU plural blocks, names kept, composed texts', () => {
  const t = new Translator(
    {
      Opslaan: 'Zapisz',
      '{0} berichten': '{0, plural, one {# wiadomość} few {# wiadomości} many {# wiadomości} other {# wiadomości}}',
      'Gestopt ({0} taak/taken)': 'Zatrzymano ({0, plural, =0 {brak zadań} one {# zadanie} few {# zadania} many {# zadań} other {# zadania}})',
      '{0} is klaar': '{0} skończył',
      'Bestand schrijven': 'Zapis pliku',
      Onderzoeker: 'Badacz',
    },
    'pl-PL',
  );
  assert.equal(t.translate('Opslaan'), 'Zapisz');
  assert.equal(t.translate('  Opslaan '), '  Zapisz ', 'surrounding whitespace kept');
  assert.equal(t.translate('5 berichten'), '5 wiadomości');
  assert.equal(t.translate('1 berichten'), '1 wiadomość');
  assert.equal(t.translate('Gestopt (3 taak/taken)'), 'Zatrzymano (3 zadania)');
  assert.equal(t.translate('Gestopt (12 taak/taken)'), 'Zatrzymano (12 zadań)');
  assert.equal(t.translate('Gestopt (0 taak/taken)'), 'Zatrzymano (brak zadań)', 'exact =0');
  assert.equal(t.translate('Opslaan · Bestand schrijven'), 'Zapisz · Zapis pliku', 'parts of a composed text');
  assert.equal(t.translate('Niet in het woordenboek'), 'Niet in het woordenboek', 'unknown stays Dutch');
  assert.equal(t.format('{0} is klaar', ['Ada']), 'Ada skończył');
  assert.equal(t.format('{0} berichten', [4]), '4 wiadomości');
  assert.equal(t.format('Niet vertaald {0}', ['x']), 'Niet vertaald x');
  t.keep.add('Onderzoeker');
  t.reset();
  assert.equal(t.translate('Onderzoeker'), 'Onderzoeker', 'a bot called "Onderzoeker" keeps its name');
  // An interface label with the same text is still translated (acceptance round 5, C-15: a bot "Lokaal" kept the
  // heading "Lokaal" on AI-providers Dutch); a label that is not in the dictionary goes the usual way.
  const l = new Translator({ Lokaal: 'Local', '{0} is klaar': '{0} is done' }, 'en-GB');
  l.keep.add('Lokaal');
  assert.equal(l.translate('Lokaal'), 'Lokaal', 'the bot name');
  assert.equal(l.label('Lokaal'), 'Local', 'the section heading');
  assert.equal(l.label(' Lokaal '), ' Local ');
  assert.equal(l.label('Lokaal is klaar'), 'Lokaal is done', 'a name inside a label stays a name');
  assert.equal(numberIn('1.234 rijen'), 1234);
  assert.equal(numberIn('1,5'), 1.5);
  assert.ok(Number.isNaN(numberIn('geen')));
  assert.deepEqual(placeholders('{1} en {0, plural, one {#} other {#}}'), ['{0}', '{1}']);
  assert.equal(fill('{0} van {1}', ['a', 'b'], new Intl.PluralRules('nl')), 'a van b');
});

test('translation checks: placeholders, plural blocks and markup must survive', () => {
  assert.deepEqual(problems('Opslaan', 'Speichern'), []);
  assert.deepEqual(problems('{0} berichten', '{0, plural, one {# Nachricht} other {# Nachrichten}}'), []);
  assert.ok(problems('{0} berichten', '{1} Nachrichten').some((p) => p.startsWith('placeholders')));
  assert.ok(problems('{0} berichten', '{0, plural, one {# Nachricht}}').includes('plural/accolades'), 'other is required');
  assert.ok(problems('Gebruik `npm run build`', 'Use npm run build').includes('backticks'));
  assert.ok(problems('Zie **dit**', 'See this').includes('vet (**)'));
  assert.ok(problems('Open https://teambot.app/x', 'Open the site').includes('links'));
  assert.ok(problems(' en meer', 'and more').includes('spaties'));
  assert.deepEqual(problems('{0} in {1}', '{0, plural, one {# Datei in {1}} other {# Dateien in {1}}}'), [], 'nested placeholders inside a plural form');
});

test('translation checks: product names may stay as they are, links need a host, "<naam>" is a word', () => {
  for (const s of ['Goose', 'Gmail (Google)', 'Claude Code: {0}', 'Amazon Bedrock', 'Ctrl K', 'J. de Vries', 'MIT (upstash/context7)', 'Windows (winget)', '/invite @bot', 'xoxb-…', 'Authorization: Bearer <token>'])
    assert.ok(nameLike(s), `name-like: ${s}`);
  for (const s of ['Alleen praten', 'een skill', 'Wacht op jou', 'Kies een bot', '{0} vragen wachten op je', 'Iedereen (aanbevolen)'])
    assert.ok(!nameLike(s), `to translate: ${s}`);
  assert.equal(wrongScript('uk', 'Amazon Bedrock', 'Amazon Bedrock'), false, 'a product name may stay Latin in Ukrainian');
  assert.equal(wrongScript('ar', 'Goose', 'Goose'), false);
  assert.equal(wrongScript('uk', 'Alleen praten', 'Alleen praten'), true, 'Dutch left in Latin script is wrong');
  assert.equal(wrongScript('ar', 'Read only', 'Alleen lezen'), true);
  assert.equal(wrongScript('ar', '{0, plural, one {# سؤال} few {# أسئلة} many {# سؤالًا} other {# سؤال}}', '{0} vragen'), false, 'ICU keywords are not Latin text');
  assert.equal(wrongScript('de', 'Nur lesen', 'Alleen lezen'), false, 'Latin languages: no script check');
  assert.deepEqual(problems('Alleen http:// en https:// proxy’s worden ondersteund.', 'Nur http://- und https://-Proxys werden unterstützt.'), [], 'a bare scheme is not a link');
  assert.ok(problems('Voorbeeld: http://proxy.bedrijf.nl:8080', 'Example: http://proxy.company.com:8080').includes('links'), 'a real link must stay');
  assert.deepEqual(problems('Kopieer naar downloads/<naam>', 'Copy to downloads/<name>'), [], '<naam> is a placeholder word');
  assert.ok(problems('Zie <b>dit</b>', 'See this').includes('tags'), 'HTML tags must stay');
});

test('translation checks: every plural form a language needs (Polish/Ukrainian/Arabic few and many)', () => {
  assert.deepEqual(missingPlurals('pl-PL', '{0, plural, one {# plik} other {# pliki}}'), ['few', 'many']);
  assert.deepEqual(missingPlurals('pl-PL', '{0, plural, one {# plik} few {# pliki} many {# plików} other {# pliku}}'), []);
  assert.deepEqual(missingPlurals('ar-u-nu-latn', 'فحص ({0, plural, one {# نتيجة} other {# نتائج}})'), ['few', 'many']);
  assert.deepEqual(missingPlurals('ar-u-nu-latn', '{0, plural, one {# ملف} few {# ملفات} many {# ملفًا} other {# ملف}}'), [], 'zero and two may fall back to other');
  assert.deepEqual(missingPlurals('fr-FR', '{0, plural, one {# fichier} other {# fichiers}}'), [], 'French "many" (millions) may fall back');
  assert.deepEqual(missingPlurals('de-DE', '{0, plural, one {# Datei} other {# Dateien}}'), []);
  assert.deepEqual(missingPlurals('uk-UA', 'Geen plural {0}'), []);
  // Nested placeholders inside a form do not count as forms.
  assert.deepEqual(missingPlurals('pl-PL', '{0, plural, one {# plik w {1}} few {# pliki w {1}} many {# plików w {1}} other {# pliku w {1}}}'), []);
});

test('menu paths: Dutch labels copied into a translation become the labels of that language; other products stay', () => {
  const en = { Instellingen: 'Settings', Spraak: 'Voice', 'Computer & bestanden': 'Computer & files', 'Eigen server (SSH)': 'Own server (SSH)', Settings: 'Settings', 'Reset Token': 'Reset token' };
  const fr: Record<string, string> = {
    Instellingen: 'Paramètres',
    Spraak: 'Voix',
    'Computer & bestanden': 'Ordinateur et fichiers',
    'Eigen server (SSH)': 'Serveur personnel (SSH)',
    Settings: 'Paramètres',
    'Reset Token': 'Réinitialiser le jeton',
    'Kies een stem in Instellingen › Spraak.': 'Choisissez une voix dans Instellingen › Spraak.',
    'Ga naar Bot › Computer & bestanden › Eigen server (SSH) › Cloud-VM.': 'Allez dans Bot › Computer & bestanden › Eigen server (SSH) › Cloud-VM.',
    'In GitHub: Settings › Webhooks.': 'Dans GitHub : Settings › Webhooks.',
    'Maak een nieuwe (Bot › Reset Token).': 'Créez-en un nouveau (Bot › Reset Token).',
  };
  assert.equal(fixMenuPaths(fr, en), 2);
  assert.equal(fr['Kies een stem in Instellingen › Spraak.'], 'Choisissez une voix dans Paramètres › Voix.');
  assert.equal(fr['Ga naar Bot › Computer & bestanden › Eigen server (SSH) › Cloud-VM.'], 'Allez dans Bot › Ordinateur et fichiers › Serveur personnel (SSH) › Cloud-VM.');
  assert.equal(fr['In GitHub: Settings › Webhooks.'], 'Dans GitHub : Settings › Webhooks.', 'the GitHub label stays');
  assert.equal(fr['Maak een nieuwe (Bot › Reset Token).'], 'Créez-en un nouveau (Bot › Reset Token).', 'the Discord label stays');
  assert.equal(fixMenuPaths(fr, en), 0, 'idempotent');
});

test('dictionary translation: lists of labels item by item; ICU plural forms in the Dutch source', () => {
  const t = new Translator({ Spraak: 'Voix', Kanalen: 'Canaux', 'Netwerk en proxy': 'Réseau et proxy' }, 'fr-FR');
  assert.equal(t.translate('Netwerk en proxy, Spraak, Kanalen'), 'Réseau et proxy, Voix, Canaux');
  assert.equal(t.translate('Netwerk en proxy, CLI-agents, Spraak'), 'Réseau et proxy, CLI-agents, Voix', 'an acronym item may stay');
  assert.equal(t.translate('Spraak, iets onbekends'), 'Spraak, iets onbekends', 'an unknown item: the list stays as it is');
  const ar = new Translator({ Spraak: 'الصوت', Kanalen: 'القنوات' }, 'ar-u-nu-latn');
  assert.equal(ar.translate('Spraak, Kanalen'), 'الصوت، القنوات', 'Arabic comma');
  // Dutch (no dictionary): the source picks its own form.
  const tpl = '{0, plural, one {# gesprek} other {# gesprekken}} met {1, plural, one {# bericht} other {# berichten}}';
  assert.equal(fillSource(tpl, [1, 1]), '1 gesprek met 1 bericht');
  assert.equal(fillSource(tpl, [3, 12]), '3 gesprekken met 12 berichten');
  assert.equal(fillSource('{0} is klaar', ['Ada']), 'Ada is klaar');
  // Names stay as they are, also a bot called by a Dutch word that is in the dictionary.
  const de = new Translator({ Onderzoeker: 'Forscher', '{0} is klaar': '{0} ist fertig', '{0} stelt {1} herinneringen voor.': '{0} schlägt {1} Erinnerungen vor.' }, 'de-DE');
  assert.equal(de.translate('Onderzoeker is klaar'), 'Forscher ist fertig', 'without names: the word is translated');
  assert.equal(de.translateKeeping('Onderzoeker is klaar', ['Onderzoeker', 'Ada']), 'Onderzoeker ist fertig');
  assert.equal(de.translateKeeping('Onderzoeker stelt 3 herinneringen voor.', ['Onderzoeker']), 'Onderzoeker schlägt 3 Erinnerungen vor.');
  assert.equal(de.translateKeeping('Niets bekends', ['Onderzoeker']), 'Niets bekends');
  const pl = new Translator({ [tpl]: '{0, plural, one {# rozmowa} few {# rozmowy} many {# rozmów} other {# rozmowy}} z {1, plural, one {# wiadomością} few {# wiadomościami} many {# wiadomościami} other {# wiadomości}}' }, 'pl-PL');
  assert.equal(pl.format(tpl, [5, 2]), '5 rozmów z 2 wiadomościami');
  assert.equal(pl.format(tpl, [2, 1]), '2 rozmowy z 1 wiadomością');
});

test('real dictionaries: complete, placeholders and markup intact, plural forms complete, menu paths translated', () => {
  const strings = sourceStrings();
  const en = readDict('en');
  for (const l of targets()) {
    const d = readDict(l.code);
    const missing = strings.filter((s) => (typeof d[s] !== 'string' || !d[s]) && !nameLike(s));
    assert.deepEqual(missing.slice(0, 5), [], `${l.code}: every interface text translated`);
    const bad: string[] = [];
    for (const s of strings) {
      const v = d[s];
      if (typeof v !== 'string') continue;
      const p = [...problems(s, v), ...(wrongScript(l.code, v, s) ? ['script'] : []), ...missingPlurals(l.locale, v).map((c: string) => `plural ${c}`)];
      if (p.length) bad.push(`${p.join(',')}: ${s}`);
    }
    assert.deepEqual(bad.slice(0, 5), [], `${l.code}: translations intact`);
    assert.equal(fixMenuPaths({ ...d }, en), 0, `${l.code}: no Dutch labels in menu paths`);
  }
});

test('server texts in the user language: dictionaries from disk, templates with plurals, Dutch fallback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-i18n-dict-'));
  fs.copyFileSync(path.join('ui', 'src', 'i18n', 'languages.json'), path.join(dir, 'languages.json'));
  fs.writeFileSync(path.join(dir, 'de.json'), JSON.stringify({ '{0} is klaar': '{0} ist fertig', 'Taak afgerond': 'Aufgabe erledigt', '{0} nieuwe meldingen': '{0, plural, one {# neue Benachrichtigung} other {# neue Benachrichtigungen}}' }));
  const prev = process.env.TEAMBOT_I18N_DIR;
  process.env.TEAMBOT_I18N_DIR = dir;
  resetTranslators();
  try {
    assert.equal(tr('de', '{0} is klaar', 'Ada'), 'Ada ist fertig');
    assert.equal(tr('de', 'Taak afgerond'), 'Aufgabe erledigt');
    assert.equal(tr('de', '{0} nieuwe meldingen', 1), '1 neue Benachrichtigung');
    assert.equal(tr('de', '{0} nieuwe meldingen', 7), '7 neue Benachrichtigungen');
    assert.equal(tr('de', 'Onbekende tekst'), 'Onbekende tekst');
    assert.equal(tr('nl', '{0} is klaar', 'Ada'), 'Ada is klaar', 'Dutch: the template filled in');
    assert.equal(tr('fr', '{0} is klaar', 'Ada'), 'Ada is klaar', 'no dictionary: Dutch');
    const store = { getSetting: (_u: string, k: string, d: any) => (k === 'language' ? 'de' : d) };
    assert.equal(userLanguage(store, 'u1'), 'de');
    assert.equal(userLanguage({ getSetting: (_u: string, _k: string, d: any) => d }, 'u1'), 'nl', 'never chose: Dutch');
    assert.equal(userLanguage({ getSetting: (() => 'xx') as any }, 'u1'), 'nl', 'unknown code: Dutch');
  } finally {
    if (prev === undefined) delete process.env.TEAMBOT_I18N_DIR;
    else process.env.TEAMBOT_I18N_DIR = prev;
    resetTranslators();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('language rule: the language the owner writes in by default, fixed per user or per bot, always last', () => {
  const settings: Record<string, any> = {};
  const store = { getSetting: (_u: string, k: string, d: any) => (k in settings ? settings[k] : d) };
  assert.deepEqual(botLanguage(store, 'u'), { mode: 'auto', fallback: 'nl' });
  settings.language = 'de';
  assert.deepEqual(botLanguage(store, 'u'), { mode: 'auto', fallback: 'de' }, 'fallback follows the interface language');
  settings.botLanguage = 'fr';
  assert.deepEqual(botLanguage(store, 'u'), { mode: 'fixed', code: 'fr' }, 'fixed for the user');
  assert.deepEqual(botLanguage(store, 'u', { settings: { language: 'auto' } }), { mode: 'auto', fallback: 'de' }, 'a bot can go back to auto');
  assert.deepEqual(botLanguage(store, 'u', { settings: { language: 'es' } }), { mode: 'fixed', code: 'es' }, 'fixed for one bot');
  assert.deepEqual(botLanguage(store, 'u', { settings: { language: '' } }), { mode: 'fixed', code: 'fr' }, "'' follows the user");

  const auto = languageNote({ mode: 'auto', fallback: 'de' });
  assert.match(auto, /^## Taal\n/);
  assert.match(auto, /taal waarin de gebruiker schrijft/);
  assert.match(auto, /het Duits \(Deutsch\)/, 'the fallback named in Dutch and in its own name');
  assert.match(auto, /tussen je stappen/);
  assert.doesNotMatch(auto, /standaard Nederlands/);
  const fixed = languageNote({ mode: 'fixed', code: 'ar' });
  assert.match(fixed, /Schrijf alles wat de gebruiker leest in het Arabisch \(العربية\), ook als de gebruiker zelf in een andere taal schrijft/);
  assert.match(DEFAULT_LANGUAGE_NOTE, /het Nederlands/);

  // CLI engines: the rule moves to the very end, after the tool note; once.
  const sys = `Je bent Assistent.\n\n${fixed}\n\n## Jouw instructies\nWees kort.`;
  assert.equal(languageSection(sys), fixed);
  const full = sessionInstructions(sys, '## TeamBot-tools\nNaast je eigen tools …');
  assert.ok(full.endsWith(fixed), 'rule last');
  assert.equal(full.split('## Taal').length, 2, 'rule once');
  assert.ok(full.includes('## Jouw instructies\nWees kort.') && full.includes('## TeamBot-tools'));
  assert.equal(withLanguage(full), full, 'stable');
  assert.ok(withLanguage('Geen regel').endsWith(DEFAULT_LANGUAGE_NOTE), 'a prompt without rule gets the default');
  // Old Claude Code (inline prompt, ≤ 6000 characters): cut the body, keep the rule whole and last.
  const long = shortSystem(`${'x'.repeat(9000)}\n\n${fixed}`);
  assert.ok(long.length <= 6000 && long.endsWith(fixed));

  // Built-in prompts that ask for Dutch output ask for the owner's language.
  assert.equal(outputLanguage('een zin in het Nederlands; (Nederlands); "<max 25 woorden, Nederlands>"', 'pl'), 'een zin in het Pools; (Pools); "<max 25 woorden, Pools>"');
  assert.equal(outputLanguage('in het Nederlands', 'nl'), 'in het Nederlands');
});

test('every engine gets the rule: API system prompt ends with it, follows the settings, date in the answer language', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent();
    const th = await t.api('POST', '/threads', { agentId: a.id });
    const runner = t.app.ctx.services.runner;
    const agent = () => t.app.ctx.store.agent(a.id)!;
    const thread = t.app.ctx.store.thread(th.id)!;
    let sys = await runner.systemPrompt(agent(), thread);
    assert.ok(sys.trimEnd().endsWith(DEFAULT_LANGUAGE_NOTE), 'default: the language the user writes in, Dutch fallback');
    await t.api('PUT', '/settings', { language: 'de' });
    sys = await runner.systemPrompt(agent(), thread);
    assert.match(languageSection(sys), /gebruik dan het Duits/);
    assert.match(await runner.turnContext(agent(), thread, null), /Huidige datum en tijd: \w+, \d+\. \w+ \d{4}/, 'German date');
    await t.api('PUT', '/settings', { botLanguage: 'it' });
    assert.match(languageSection(await runner.systemPrompt(agent(), thread)), /in het Italiaans/);
    await t.api('PATCH', `/agents/${a.id}`, { settings: { ...agent().settings, language: 'auto' } });
    assert.match(languageSection(await runner.systemPrompt(agent(), thread)), /taal waarin de gebruiker schrijft/, 'per bot');
    await assert.rejects(t.api('PUT', '/settings', { language: 'klingon' }), /Onbekende taal/);
    await assert.rejects(t.api('PUT', '/settings', { botLanguage: 'xx' }), /Onbekende taal/);
    // The request the model gets carries the rule as the last section.
    t.script.push({ text: 'ok' });
    await t.say(th.id, 'Hallo');
    assert.ok(t.requests.at(-1)!.system!.trimEnd().endsWith(languageNote({ mode: 'auto', fallback: 'de' })));
  } finally {
    await t.close();
  }
});
