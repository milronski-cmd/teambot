import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { transformSync } from 'esbuild';
import { settingsNav, staticEntries, type ModuleShape, type SettingsNavRow } from '../ui/src/lib/palette.js';
import { PLACE, placeOf } from '../shared/places.js';
import { SETTINGS_PAGES, SETTINGS_ROWS } from '../shared/settings.js';
import { Translator } from '../shared/i18n-core.js';

/**
 * A message from the server that sends the user to a place in the screens ("Instellingen › Meer mogelijkheden ›
 * Zoeken op internet") names a place that exists: a row of Instellingen, an entry under it, and a part of that page (a
 * card, a button, a fold) in the words the interface shows. The one source for such places is shared/places.ts (PLACE).
 */

const ROOT = path.join(import.meta.dirname, '..');

const walk = (dir: string, ext: RegExp): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name), ext) : ext.test(d.name) ? [path.join(dir, d.name)] : []));

/** The modules of the interface as their index files describe them: pages and settings tabs, with their titles. */
function uiModules(): ModuleShape[] {
  const dir = path.join(ROOT, 'ui', 'src', 'modules');
  const out: ModuleShape[] = [];
  for (const name of fs.readdirSync(dir)) {
    const file = ['index.tsx', 'index.ts'].map((x) => path.join(dir, name, x)).find((f) => fs.existsSync(f));
    if (!file) continue;
    const src = fs.readFileSync(file, 'utf8');
    const at = src.search(/^ {2}id: '[^']+',$/m);
    if (at < 0) continue;
    const body = src.slice(at);
    const id = /^ {2}id: '([^']+)',$/m.exec(body)![1];
    const label = /^ {2}label: '([^']+)',$/m.exec(body)?.[1] || id;
    const pages = [...body.matchAll(/\{ path: '([^']*)', title: '([^']+)'([^}]*)\}/g)].map((m) => ({ path: m[1], title: m[2], ...(/bare: true/.test(m[3]) ? { bare: true } : {}) }));
    const tabs = /settingsTabs: \[([^\]]*)\]/.exec(body)?.[1] || '';
    const settingsTabs = [...tabs.matchAll(/\{ id: '([^']+)', title: '([^']+)'([^}]*)\}/g)].map((m) => ({ id: m[1], title: m[2], ...(/adminOnly: true/.test(m[3]) ? { adminOnly: true } : {}) }));
    out.push({ id, label, pages, settingsTabs });
  }
  return out;
}

/** Instellingen as the owner of a server sees it: every row, and every entry under it. */
function settingsList(): SettingsNavRow[] {
  const modules = uiModules();
  const tabs = staticEntries(modules, { isAdmin: true, serverMode: true })
    .filter((i) => i.kind === 'setting')
    .map((i) => ({ id: i.id.replace(/^settings:/, ''), label: i.title }));
  return settingsNav(tabs, modules, { advanced: true });
}

/** Every text the interface writes itself (ui/src): the text between tags, and every string. */
function uiTexts(): Set<string> {
  const out = new Set<string>();
  const add = (s: string | undefined) => {
    const t = (s || '').replace(/\s+/g, ' ').trim();
    if (t) out.add(t);
  };
  for (const file of walk(path.join(ROOT, 'ui', 'src'), /\.tsx?$/)) {
    // Without comments, and the text between tags as a string ("Toevoegen" in createElement(Button, …, "Toevoegen")).
    const code = transformSync(fs.readFileSync(file, 'utf8'), { loader: file.endsWith('x') ? 'tsx' : 'ts', jsx: 'transform', charset: 'utf8', legalComments: 'none' }).code;
    // One line at a time, so a quote inside a regular expression can never pair with one on another line.
    for (const m of code.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\\n]|\\.)*)`/g)) {
      const text = (m[1] ?? m[2] ?? m[3]).replace(/\\(.)/g, '$1');
      for (const piece of m[3] === undefined ? [text] : text.split(/\$\{[^}]*\}/)) add(piece);
    }
  }
  return out;
}

const LIST = settingsList();
const SHOWN = uiTexts();
/** Every row and entry of Instellingen with its own place. */
const ENTRIES = LIST.flatMap((r) => [{ title: r.title, at: `Instellingen › ${r.title}` }, ...r.more.flatMap((x) => x.rows.map((e) => ({ title: e.title, at: `Instellingen › ${r.title} › ${e.title}` })))]);
/** A title ends where a word ends ("Teams" in "Teams).", not "AI" in "AI-diensten"). */
const ends = (s: string, title: string) => s.startsWith(title) && !/^[\p{L}\p{N}’'-]/u.test(s.slice(title.length));
const longest = <T extends { title: string }>(list: T[], s: string) => list.filter((x) => ends(s, x.title)).sort((a, b) => b.title.length - a.title.length)[0];
const words = (s: string) => s.split(/[.,;:()“”"`]/)[0].trim().split(/\s+/).slice(0, 5).join(' ');
const STEP = /^\s*›\s*/;

/**
 * Null when the path after "Instellingen" exists; else what was not found. A row, an entry under a row without a page
 * of its own, then any part of that page: written as the screen writes it (a part ends at punctuation or the next
 * "›"), and never an entry that has its own place in Instellingen (one place for each thing).
 */
function problem(after: string): string | null {
  let s = after.replace(STEP, '');
  const row = longest(LIST, s);
  if (!row) return `geen regel “${words(s)}”`;
  s = s.slice(row.title.length);
  let page = row.title;
  if (!row.hasMain && STEP.test(s)) {
    s = s.replace(STEP, '');
    const entry = longest(row.more.flatMap((x) => x.rows), s);
    if (!entry) return `geen “${words(s)}” onder ${row.title}`;
    s = s.slice(entry.title.length);
    page = entry.title;
  }
  while (STEP.test(s)) {
    s = s.replace(STEP, '');
    const part = s.split(/\s*›|[.,;:()“”"`]/)[0].trim();
    const own = ENTRIES.find((e) => e.title === part && e.title !== page);
    if (own) return `“${part}” staat zelf in Instellingen: ${own.at}`;
    if (!SHOWN.has(part)) return `geen “${words(part)}” op ${page}`;
    s = s.slice(s.indexOf(part) + part.length);
  }
  return null;
}
/** The same for a whole path; "→" is read as "›". */
const check = (where: string) => problem(where.replace(/^Instellingen/, '').replace(/→/g, '›'));

interface Named {
  file: string;
  line: number;
  path: string;
  why: string;
}

/** Programs whose own settings a text may name ("Bij Gmail … onder Instellingen › Accounts › Verzenden als"). */
const OTHER_PROGRAM = /\b(?:Gmail|Google|Chrome|Edge|Firefox|Safari|iPhone|iPad|iOS|Android|Windows|macOS|Apple|Outlook|Microsoft|ChatGPT|claude\.ai|OpenRouter|Notion|Slack|Todoist|Shopify|Bing|Search Console|Jan|1Password|Bitwarden)\b/;

/**
 * Every "Instellingen › …" (or "→") in the text of the server and the interface (strings and the text between tags,
 * not comments) that names no existing place. A text of the server names TeamBot's places only through PLACE, so
 * there any typed path of TeamBot counts.
 */
function wrongPlaces(): Named[] {
  const out: Named[] = [];
  for (const file of [...walk(path.join(ROOT, 'server'), /\.ts$/), ...walk(path.join(ROOT, 'shared'), /\.ts$/), ...walk(path.join(ROOT, 'ui', 'src'), /\.tsx?$/)]) {
    const src = fs.readFileSync(file, 'utf8');
    if (!/Instellingen [›→]/.test(src)) continue;
    const typedIsWrong = !file.startsWith(path.join(ROOT, 'ui'));
    // Without comments (minified, so none is kept): only what a user or a bot can read; the text between tags becomes
    // a string.
    const code = transformSync(src, { loader: file.endsWith('x') ? 'tsx' : 'ts', jsx: 'transform', charset: 'utf8', legalComments: 'none', minifyWhitespace: true }).code;
    let from = 0;
    for (const m of code.matchAll(/Instellingen(?= [›→])/g)) {
      const before = code.slice(Math.max(0, m.index - 160), m.index);
      // Another program's own settings: "Shopify-beheer › Instellingen › Apps", "In Notion: Instellingen ›
      // Verbindingen", or a program named in the same sentence ("op Windows: Instellingen › Tijd en taal").
      // "Meer › Instellingen" is TeamBot's own menu on the phone.
      if (/(?<!\b(?:TeamBot|Meer)\s?)[›→]\s*$|\bIn [\p{L}\p{N}.\- ]{1,30}:\s*$/u.test(before)) continue;
      if (OTHER_PROGRAM.test(before.split('\n').pop()!.split(/[.!?]\s/).pop()!)) continue;
      const after = code.slice(m.index + 'Instellingen'.length, m.index + 200);
      // A path made from data (`Instellingen › ${row.title}`) is as right as that data.
      if (/^\s*[›→]\s*\$\{/.test(after)) continue;
      const why = problem(after.replace(/→/g, '›')) || (typedIsWrong ? 'getypt pad: gebruik PLACE uit shared/places.ts' : null);
      if (!why) continue;
      const shown = `Instellingen${after.split(/[)“”"'`]|\.(?=[\s"'`]|$)|,|;/)[0]}`.trim();
      // The same text in the source, after the one before it (strings keep their order).
      const at = src.indexOf(shown.slice(0, 40), from);
      from = at + 1;
      out.push({ file: path.relative(ROOT, file).replace(/\\/g, '/'), line: src.slice(0, at).split('\n').length, path: shown, why });
    }
  }
  return out;
}

test('the settings list of the interface is read completely (rows, Meer mogelijkheden, module tabs)', () => {
  const titles = LIST.map((r) => r.title);
  for (const t of ['AI-diensten', 'Telefoon', 'Taal en uiterlijk', 'Teams', 'Kanalen', 'Apps', 'Bestanden', 'Meer mogelijkheden']) assert.ok(titles.includes(t), `row ${t}: ${titles.join(', ')}`);
  const meer = LIST.find((r) => r.title === 'Meer mogelijkheden')!.more.flatMap((s) => s.rows.map((e) => e.title));
  for (const t of ['Zoeken op internet', 'Spraak', 'AI-programma’s', 'Beveiliging', 'Privacy en gegevens', 'Kosten', 'Kluis', 'Teaminstellingen', 'Status van TeamBot', 'Bureaublad op afstand']) assert.ok(meer.includes(t), `entry ${t}: ${meer.join(', ')}`);
  assert.ok(meer.length >= 35, `${meer.length} entries under Meer mogelijkheden`);
  for (const t of ['Toevoegen', 'Sleutel', 'Logboek', 'Opgeslagen sleutels']) assert.ok(SHOWN.has(t), `the interface writes “${t}”`);
});

test('every place in shared/places.ts comes from the settings list, exists in the screens, and is used', () => {
  const code = [...walk(path.join(ROOT, 'server'), /\.ts$/), ...walk(path.join(ROOT, 'ui', 'src'), /\.tsx?$/)].map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  for (const [key, where] of Object.entries(PLACE)) {
    assert.match(where, /^Instellingen › /, key);
    assert.equal(check(where), null, `${key}: ${where}`);
    assert.ok(code.includes(`PLACE.${key}`), `PLACE.${key} is used by a message`);
  }
  // Built from shared/settings.ts: the place of a key follows its titles there (no second copy to keep in step).
  assert.equal(placeOf('voice-spraak'), `Instellingen › ${SETTINGS_ROWS.find((r) => r.id === 'meer')!.title} › ${SETTINGS_PAGES['voice-spraak'].title}`);
  assert.equal(placeOf('providers'), `Instellingen › ${SETTINGS_PAGES.providers.title}`);
  // teams/manage.ts (teambot_find) names a setting's page with the same placeOf.
  assert.match(fs.readFileSync(path.join(ROOT, 'server', 'modules', 'teams', 'manage.ts'), 'utf8'), /import \{ placeOf as settingsPlace \} from '\.\.\/\.\.\/\.\.\/shared\/places\.js'/);
  // The check itself: an old, made-up or second place is caught; a part of a page as the screen writes it is not.
  for (const bad of [
    'Instellingen › Geavanceerd › Zoeken',
    'Instellingen › Spraak',
    'Instellingen › Meer mogelijkheden › Zoeken',
    'Instellingen › AI een dienst',
    'Instellingen → Gebruikers',
    'Instellingen › Meer mogelijkheden › Beveiliging › Opgeslagen geheimen',
    'Instellingen › Telefoon › Bureaublad op afstand',
    'Instellingen › AI-diensten › Sleutel plakken › Nergens',
  ])
    assert.notEqual(check(bad), null, bad);
  for (const good of [
    'Instellingen › AI-diensten',
    'Instellingen › Teams).',
    'Instellingen → Telefoon.',
    'Instellingen › Meer mogelijkheden',
    'Instellingen › Meer mogelijkheden › Beveiliging › Logboek',
    'Instellingen › AI-diensten › Toevoegen › Sleutel plakken',
    `${PLACE.ai} › Sleutel.`,
  ])
    assert.equal(check(good), null, good);
});

test('a place is translated step by step with the titles of the list, also inside a sentence', () => {
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'ui', 'src', 'i18n', 'en.json'), 'utf8'));
  const tr = new Translator(en, 'en-GB');
  assert.equal(tr.translate(PLACE.voice), 'Settings › More options › Speech');
  const small = new Translator({ 'Verhoog de limiet in {0}.': 'Raise the limit in {0}.', Instellingen: 'Settings', 'Meer mogelijkheden': 'More options', Kosten: 'Costs' }, 'en-GB');
  assert.equal(small.translate(`Verhoog de limiet in ${PLACE.costs}.`), 'Raise the limit in Settings › More options › Costs.');
  // A step without a translation leaves the place as it is (never half a path in two languages).
  assert.equal(small.translate(PLACE.voice), PLACE.voice);
});

test('no text names a settings path that does not exist in the screens; the server names them only through PLACE', () => {
  const wrong = wrongPlaces();
  assert.deepEqual(
    wrong.map((w) => `${w.file}:${w.line} “${w.path}”: ${w.why}`),
    [],
    'use PLACE from shared/places.ts, or the words the screens show',
  );
});
