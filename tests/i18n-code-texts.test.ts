// Every visible text can be translated (the language check on 12 Nov 2026 still showed 15–28 Dutch texts per language,
// all from code, none from the dictionaries): lists joined with a Dutch "en", Dutch words passed as values into a
// sentence, catalogue descriptions cut to their first sentence before translating, texts the extractor never saw,
// texts the server stores in Dutch and the page showed as the owner's own words, and one dictionary entry ("Open")
// that was both a view and a verb.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Translator } from '../shared/i18n-core.js';
import { bindLocale, formatList, tKnown } from '../shared/format.js';
import { firstSentence } from '../ui/src/lib/sentence.js';
import { describeAudit } from '../ui/src/shell/auditText.js';
import { notesTitle } from '../server/modules/memory/living.js';
import { STARTER_RULES } from '../server/modules/teams/service.js';

const root = process.cwd();
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
function sources(dir: string, re = /\.(tsx?|mjs)$/): string[] {
  const out: string[] = [];
  (function walk(d: string) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!['node_modules', 'dist', 'i18n'].includes(e.name)) walk(p);
      } else if (re.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
    }
  })(path.join(root, dir));
  return out;
}
const withoutComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The interface in German with a small dictionary: what the page would show. */
function german(dict: Record<string, string>) {
  const tr = new Translator(dict, 'de-DE');
  bindLocale(
    () => 'de-DE',
    (s, ...values) => tr.format(s, values),
    (s) => tr.fragment(s),
    (s) => (tr.has(s) ? tr.translate(s) : s),
  );
  return tr;
}

let extracted: Map<string, Set<string>> | null = null;
async function strings() {
  if (!extracted) {
    const { extractStrings } = await import(pathToFileURL(path.join(root, 'scripts', 'i18n-extract.mjs')).href);
    extracted = extractStrings(root).strings as Map<string, Set<string>>;
  }
  return extracted;
}

test('a list in words comes from one helper in the reader\'s language, never a hand-made Dutch "en"', () => {
  assert.equal(formatList(['Naam', 'Tools', 'Computer & bestanden'], 'nl-NL'), 'Naam, Tools en Computer & bestanden');
  assert.equal(formatList(['your own apps', 'extra arguments'], 'en-GB'), 'your own apps and extra arguments');
  assert.equal(formatList(['eigene Apps', 'Argumente'], 'de-DE'), 'eigene Apps und Argumente');
  assert.equal(formatList(['a', 'b'], 'nl-NL', { or: true }), 'a of b');
  assert.equal(formatList([], 'de-DE'), '');
  // The interface (and what it shares with the server) joins no list by hand: the bot editor's "Programma" summary
  // showed "…, feste Regeln pro Schritt en zusätzliche Argumente".
  const hand = /join\(\s*' en '\s*\)|' en ' \+|\+ ' en '|\blistNl\b|\bjoinNl\b/;
  const found = [...sources('ui/src'), ...sources('shared')].filter((f) => hand.test(withoutComments(fs.readFileSync(f, 'utf8')))).map((f) => path.relative(root, f));
  assert.deepEqual(found, []);
  // One helper: the update screen and the usage bar used their own Intl.ListFormat.
  const own = [...sources('ui/src'), ...sources('shared'), ...sources('server')].filter((f) => !f.endsWith(path.join('shared', 'format.ts')) && /new Intl\.ListFormat\(/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(root, f));
  assert.deepEqual(own, []);
});

test('whole sentences: no Dutch word or ending is passed as a value into a sentence', () => {
  // `${n === 1 ? 'is' : 'zijn'}`, `opleverde${n === 1 ? '' : 'n'}`, `${d === 1 ? 'dag' : 'dagen'}`, 'het veld' as a
  // value, `is ${existing ? 'bijgewerkt' : 'gemaakt'}`, `je vindt ${n === 1 ? 'hem' : 'ze'}`: one sentence per form.
  const piece = /\$\{[^{}`]*\?\s*'(is|zijn|n|dag|dagen|het veld|de velden|veld|velden|bijgewerkt|gemaakt|hem|ze|die|is de map|zijn de mappen|een bron)'\s*:\s*'(is|zijn|n|dag|dagen|het veld|de velden|veld|velden|bijgewerkt|gemaakt|hem|ze|die|is de map|zijn de mappen|)'\s*\}/;
  const files = ['server/modules/routines/duties/service.ts', 'server/modules/folders/documents.ts', 'server/modules/sites/index.ts', 'server/modules/routines/engine.ts', 'server/modules/workflows/index.ts', 'server/modules/specialists/service.ts', 'server/modules/skills/workspace.ts'];
  for (const f of files) assert.doesNotMatch(read(f), piece, f);
  assert.doesNotMatch(read('server/modules/browser/tools.ts'), /describeElement\(info, 'het veld'\)/);
  assert.doesNotMatch(read('ui/src/modules/skills/common.tsx'), /\{thin\.length === 1 \? 'hem' : 'ze'\}/);
});

test('the extractor sees the whole texts: no piece outside t(), no sentence that only a value completes', async () => {
  const s = await strings();
  const want = [
    // joined pieces
    'Scherm {0} (hoofdscherm) — {1}×{2}',
    'Scherm {0} — {1}×{2}',
    'Je hebt {0} gewijzigd maar nog niet opgeslagen. Zonder opslaan gaan die wijzigingen verloren.',
    'Bot opgeslagen, maar {0} niet: {1}',
    'De bot noemde ook {0}, maar TeamBot zag dat niet gebeuren.',
    '{0} · vergrendelt {1}',
    // whole sentences per form
    '1 automatische routine die nooit iets opleverde, is gearchiveerd. Niets is weg: je vindt hem bij Werk onder “Opgeruimd” en kunt hem terugzetten.',
    '{0} automatische routines die nooit iets opleverden, zijn gearchiveerd. Niets is weg: je vindt ze bij Werk onder “Opgeruimd” en kunt ze terugzetten.',
    "Pagina's {0} zijn niet gelezen: per keer leest TeamBot {1} gescande pagina's. Vraag om de volgende pagina's met pages.",
    'Pagina {0} is een scan zonder tekst. {1}',
    'Verloopt: over 1 dag.',
    'Verloopt: over {0} dagen.',
    'Een nieuwe routine neemt het veld {0} niet aan. Er is geen routine gemaakt. Wat je kunt meegeven: {1}; en status paused om hem op pauze te laten beginnen.',
    'Een nieuwe routine neemt de velden {0} niet aan. Er is geen routine gemaakt. Wat je kunt meegeven: {1}; en status paused om hem op pauze te laten beginnen.',
    'Getypt in het veld ({0}, {1} tekens). Niets verstuurd.',
    'Workflow “{0}” is bijgewerkt (versie {1}, {2} stappen). De gebruiker bekijkt en start hem op #/m/workflows/w/{3}.',
    'Workflow “{0}” is gemaakt (versie {1}, {2} stappen). De gebruiker bekijkt en start hem op #/m/workflows/w/{3}.',
    '{0} leert niet meer van een bron buiten zijn vak',
    '{0}. Uitgezet, niet weggehaald: je vindt hem bij de bot onder Specialisme.',
    'Let op: “{0}” doet zelf weinig (zie hierboven). Je kunt hem toch installeren.',
    // texts the extractor never picked up
    '{0, plural, one {# skill} other {# skills}}, de meeste sterren op GitHub eerst. Gratis, met een open licentie en op een vaste versie.',
    'Werkt het liefst in de ochtend',
    'Wil eerst de conclusie, dan de uitleg',
    '{0} van {1} tekens',
    '{0} van {1} tekens: maak het korter',
    '{0}. Wat is gecontroleerd?',
    // a dossier title the server stores
    'Werknotities van {0}',
    // the skills view has its own word
    'Openbaar',
  ];
  assert.deepEqual(want.filter((x) => !s.has(x)), []);
  // The example under "Antwoord van de andere assistent" is neutral: nobody's own city or habits.
  assert.doesNotMatch(read('ui/src/modules/memory/assistant-import.tsx'), /Utrecht|korte antwoorden/);
  const gone = [
    '{0} nooit iets opleverde{1}, {2} gearchiveerd. Niets is weg: je vindt ze bij Werk onder “Opgeruimd” en kunt ze terugzetten.',
    "Pagina {0} {1} niet gelezen: per keer leest TeamBot {2} gescande pagina's. Vraag om de volgende pagina's met pages.",
    'Een nieuwe routine neemt {0} {1} niet aan. Er is geen routine gemaakt. Wat je kunt meegeven: {2}; en status paused om hem op pauze te laten beginnen.',
    'Workflow “{0}” is {1} (versie {2}, {3} stappen). De gebruiker bekijkt en start hem op #/m/workflows/w/{4}.',
    'Verloopt: {0}.',
  ];
  assert.deepEqual(gone.filter((x) => s.has(x)), []);
  // "Open" is the status of a task, a decision, an approval and a report; the skills view no longer shares that entry.
  assert.ok(![...(s.get('Open') || [])].some((f) => f.endsWith('skills/Market.tsx')), 'Market.tsx no longer says "Open"');
  assert.match(read('ui/src/modules/skills/Market.tsx'), /\{ value: 'open', label: 'Openbaar' \}/);
  // A command-line flag is code, never translated and never counted as Dutch.
  assert.match(read('ui/src/modules/mcp/ServerTab.tsx'), /<code className="whitespace-nowrap font-mono">--sta-extern-toe<\/code>/);
});

test('a catalogue description is translated as a whole before its first sentence is cut', () => {
  const goose = 'Goose (open source, oorspronkelijk van Block) via het Agent Client Protocol (goose acp). TeamBot start Goose in de modus "approve".';
  german({ [goose]: 'Goose (Open Source, ursprünglich von Block) über das Agent Client Protocol (goose acp). TeamBot startet Goose im Modus "approve".' });
  assert.equal(firstSentence(goose), 'Goose (Open Source, ursprünglich von Block) über das Agent Client Protocol (goose acp).');
  // A description the dictionary does not have (a skill from GitHub) stays as it is.
  assert.equal(firstSentence('Searches the web. Returns links.'), 'Searches the web.');
  // One firstSentence: the CLI programs and the providers page had their own copy that cut the Dutch text.
  const copies = sources('ui/src').filter((f) => /const firstSentence =/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(root, f).replace(/\\/g, '/'));
  assert.deepEqual(copies, ['ui/src/lib/sentence.ts']);
});

test('stored texts in TeamBot\'s own words are shown translated; the owner\'s own words stay as written', () => {
  const [money, send] = STARTER_RULES.map((r) => r.text);
  german({
    [send]: 'Frag zuerst bei einer wichtigen Nachricht an andere',
    [money]: 'Frag immer zuerst, bevor du Geld ausgibst',
    '{0} zonder mij te vragen': '{0} ohne mich zu fragen',
    'Werknotities van {0}': 'Arbeitsnotizen von {0}',
    'Dossier: {0}': 'Dossier: {0}',
  });
  // A team's starting rules (stored in Dutch by the server) and an own rule.
  assert.equal(tKnown(send), 'Frag zuerst bei einer wichtigen Nachricht an andere');
  const own = 'Mail nooit naar klanten zonder mij te vragen';
  assert.equal(tKnown(own), own, 'never a pattern on the owner\'s own words');
  // The security log quotes the rule in the reader's language.
  const row = (text: string) => ({ id: 1, user_id: 'u', agent_id: null, kind: 'botrules.added', data: { text, effect: 'ask', teamId: 'tm_1' }, created_at: '2026-11-12T20:00:00Z' });
  assert.match(describeAudit(row(money)).text, /“Frag immer zuerst, bevor du Geld ausgibst”/);
  assert.match(describeAudit(row(own)).text, /“Mail nooit naar klanten zonder mij te vragen”/);
  // The rule list shows the same (OwnRules: the text and the remove button's label).
  const rules = read('ui/src/modules/botrules/OwnRules.tsx');
  assert.match(rules, /const text = tKnown\(r\.text\)/);
  assert.match(rules, /t\('Regel weghalen: \{0\}', text\)/);
  // A bot's working notes: the title the server stores is the whole source text, so the page translates it.
  assert.equal(notesTitle('Max'), 'Werknotities van Max');
  const tr = new Translator({ 'Werknotities van {0}': 'Arbeitsnotizen von {0}', 'Dossier: {0}': 'Dossier: {0}' }, 'de-DE');
  assert.equal(tr.translate(`Dossier: ${notesTitle('Max')}`), 'Dossier: Arbeitsnotizen von Max');
  // A provider's name (by default its catalogue label, "Ollama (lokaal)") inside a sentence: translated as a whole.
  assert.match(read('ui/src/pages/Providers.tsx'), /t\('\{0\} gekoppeld', tKnown\(p\.name\)\)/);
  assert.match(read('ui/src/pages/Providers.tsx'), /t\('\{0\} draait nog niet op deze computer\.', tKnown\(kind\.label\)\)/);
});
