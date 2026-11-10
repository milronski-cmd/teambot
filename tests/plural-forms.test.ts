// Real singular/plural forms instead of "bestand(en)", "versie(s)", "app(s)" (acceptance round 4: "0 bestand(en)",
// "alle 3 versie(s)", "1 herinnering(en)", "Aanzetten voor geen app(s)").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Translator, fillSource } from '../shared/i18n-core.js';
import { nlCount } from '../server/core/i18n.js';

test('a Dutch source template chooses its own form, also for zero', () => {
  const apps = '{0, plural, =0 {Kies eerst een app} one {Aanzetten voor # app} other {Aanzetten voor # apps}}';
  assert.deepEqual([0, 1, 3].map((n) => fillSource(apps, [n])), ['Kies eerst een app', 'Aanzetten voor 1 app', 'Aanzetten voor 3 apps']);
  const versions = '{0, plural, one {de skill en zijn enige versie in je bibliotheek;} other {de skill en alle # versies in je bibliotheek;}}';
  assert.equal(fillSource(versions, [1]), 'de skill en zijn enige versie in je bibliotheek;');
  assert.equal(fillSource(versions, [3]), 'de skill en alle 3 versies in je bibliotheek;');
  const two = '{0, plural, one {# voorgelezen bestand} other {# voorgelezen bestanden}}, {1}';
  assert.equal(fillSource(two, [1, '2,0 MB']), '1 voorgelezen bestand, 2,0 MB');
});

test('a translated plural template picks the target language\'s form (Polish few/many, Arabic zero)', () => {
  const key = '{0, plural, one {# bestand overgeslagen} other {# bestanden overgeslagen}}: maximaal 10 bestanden en 50 MB per keer.';
  const pl = new Translator({ [key]: '{0, plural, one {Pominięto # plik} few {Pominięto # pliki} many {Pominięto # plików} other {Pominięto # pliku}}: maksymalnie 10 plików i 50 MB naraz.' }, 'pl-PL');
  assert.deepEqual([1, 2, 5].map((n) => pl.format(key, [n]).split(':')[0]), ['Pominięto 1 plik', 'Pominięto 2 pliki', 'Pominięto 5 plików']);
  // A server sentence per form ("1 herinnering niet overgenomen" / "{0} herinneringen …") matches its own pattern.
  const de = new Translator({ '1 herinnering niet overgenomen: {0}.': '1 Erinnerung nicht übernommen: {0}.', '{0} herinneringen niet overgenomen: {1}.': '{0} Erinnerungen nicht übernommen: {1}.' }, 'de-DE');
  assert.equal(de.translate('1 herinnering niet overgenomen: dubbel.'), '1 Erinnerung nicht übernommen: dubbel.');
  assert.equal(de.translate('4 herinneringen niet overgenomen: dubbel.'), '4 Erinnerungen nicht übernommen: dubbel.');
});

test('Dutch counts for texts only the bots read', () => {
  assert.equal(nlCount(1, 'rij', 'rijen'), '1 rij');
  assert.equal(nlCount(0, 'rij', 'rijen'), '0 rijen');
  assert.equal(nlCount(7, 'vastgezette herinnering past', 'vastgezette herinneringen passen'), '7 vastgezette herinneringen passen');
});

// Acceptance round 6 (B-42): a snapshot in "Wijzigingen" read "8 nov, 12:34 · 1 bestanden · 38 byte".
test('the Wijzigingen tab never puts a bare count in front of a plural noun', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(path.join(process.cwd(), 'ui', 'src', 'modules', 'browser', 'Changes.tsx'), 'utf8');
  const bare = src.match(/(?<![$\w])\{[\w.?]+\}\s+(bestanden|stappen|wijzigingen|snapshots)\b/g) || [];
  assert.deepEqual(bare, []);
});

// Acceptance round 6: "1 tools" (Apps), "1 regels" and "1 bronnen" (dossiers), "1 runs" (routines), "1 skills
// gevonden", "OpenBot staat op deze computer met 1 bots", "Elke 1 dagen". A count in front of a plural noun needs a form
// of its own for one: in the interface an ICU plural in t() — one template for the whole sentence, so translators see
// it — and on the server one sentence per form (`n === 1 ? '1 bestand …' : `${n} bestanden …``, see server/core/i18n.ts).
const PLURAL_NOUNS =
  'aanroepen|acties|apparaten|apps|beurten|berichten|besluiten|bestanden|bevindingen|bijlagen|blokkades|bots|bronnen|connectors|dagen|documentdelen|dossierregels|dossiers|fouten|gebeurtenissen|gebruikers|geheimen|gesprekken|groepen|herinneringen|indexregels|installaties|items|kanalen|koppelingen|leden|logins|mappen|maanden|meldingen|minuten|modellen|notities|pogingen|providers|records|regels|resultaten|rijen|routines|runs|seconden|servers|sessies|skills|snapshots|stappen|sterren|tabbladen|tabellen|taken|teams|tools|toolgroepen|updates|uren|velden|verzoeken|versies|voorstellen|vragen|weken|werkmappen|wijzigingen|woorden|workflows';
// Words between the count and the noun ("3 open acties", "2 eerdere berichten").
const COUNT_ADJECTIVES = 'open|eigen|nieuwe|geplande|gekozen|ongewijzigde|aanbevolen|lopende|eerdere|bestaande|dubbele|mogelijke|verborgen|voorgelezen|geladen|verschillende|vaste|actieve|extra|gewiste|vastgezette|ongelezen';
// `{n} tools` in JSX, `{0} dagen` in a t() template, `${n} bots` in a template literal (count and noun on one line).
const BARE_COUNT = new RegExp(String.raw`(\$?)\{([^{}\n]+)\}[ \t]+(?:(?:${COUNT_ADJECTIVES})[ \t]+)?(${PLURAL_NOUNS})(?![\p{L}\d_’-])(?![ \t]*=)`, 'gu');
// Server texts that reach the owner: errors, chat events, steps, notifications, notices, run reasons, approval texts.
const OWNER_SINK = /\b(?:bad|HttpError|ScimError|HttpLike|addEvent|event|activity|progress|recordEvent|cancel|notify|toast)\(|attention\.(?:push|unshift)\(|\b(?:title|body|summary|detail|reason|message):|'notification'|\bL\(/;
// Checked by hand: the count is never one there.
const BARE_COUNT_OK = new Set([
  'ui/src/modules/routines/Triggers.tsx|${grace} minuten', // the choices are 5, 15 and 60 minutes
  "ui/src/pages/AgentEditor.tsx|${groups.length || '…'} toolgroepen", // the fixed list of tool groups
  'server/modules/browser/browser.ts|${limits.maxTabs} tabbladen', // a fixed limit of 8
  'server/modules/browser/screen-tools.ts|${minutes} minuten', // a desktop task lasts 5–240 minutes
  'server/modules/browser/screen-tools.ts|${cfg.host_options.maxPerMinute} acties', // 5–240 per minute
  'server/modules/memory/lifecycle.ts|${g.length} items', // a merge proposal joins two or more
]);
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The bare counts in one source file (comments left out); `serverSide` keeps only the texts the owner sees. */
function bareCounts(rel: string, raw: string, serverSide: boolean): string[] {
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/^([ \t]*)\/\/.*$/gm, '$1');
  const out: string[] = [];
  for (const m of src.matchAll(BARE_COUNT)) {
    const expr = m[2].trim();
    // The security log's "{h}"/"{is}" (hebt/heeft, bent/is) and ICU's "#" are no counts; a constant is a limit.
    if (/^(?:h|is|#.*)$/.test(expr) || /^[A-Z][A-Z0-9_]*(?:\s*[-+*/]\s*[\d_]+)*$/.test(expr)) continue;
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const lineEnd = src.indexOf('\n', m.index);
    const line = src.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
    if (serverSide && !OWNER_SINK.test(line)) continue;
    // A form of its own for one nearby (`n === 1 ? '1 bestand' : `${n} bestanden``, `t.rows === 1 ? …`), or only shown
    // above one (`n > 1 && …`, `lines.length > 6`); for a template placeholder ({0}) a choice on the same line.
    const before = src.slice(Math.max(0, m.index - 300), m.index);
    const subject = expr.replace(/^-/, '').replace(/\.(?:toLocaleString|toString)\([^()]*(?:\([^()]*\))?[^()]*\)$/, '');
    const guard = /^\d+$/.test(expr) ? /[=!]==\s*1\s*\?/.test(line) : new RegExp(String.raw`${escRe(subject)}\s*(?:[=!]==\s*-?1\b|>\s*[1-9]|>=\s*[2-9])`).test(before);
    if (guard || BARE_COUNT_OK.has(`${rel}|${m[0].replace(/[ \t]+/g, ' ')}`)) continue;
    out.push(`${rel}:${src.slice(0, m.index).split('\n').length}: ${m[0]}`);
  }
  return out;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!['node_modules', 'dist', 'i18n'].includes(e.name)) sourceFiles(p, out);
    } else if (/\.(tsx?|mjs)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

test('no bare count in front of a plural noun in the interface or in server texts the owner sees', () => {
  const root = process.cwd();
  const scan = (dirs: string[], serverSide: boolean) =>
    dirs.flatMap((d) => sourceFiles(path.join(root, d))).flatMap((f) => bareCounts(path.relative(root, f).replace(/\\/g, '/'), fs.readFileSync(f, 'utf8'), serverSide));
  assert.deepEqual(scan(['ui/src', 'shared'], false), [], 'interface: t(\'{0, plural, one {# tool} other {# tools}}\', n)');
  assert.deepEqual(scan(['server', 'desktop'], true), [], "server: one sentence per form (n === 1 ? '1 tool' : `${n} tools`)");
  // The scan itself: what it catches and what it lets through.
  const caught = (s: string, server = false) => bareCounts('x.tsx', s, server).length;
  assert.equal(caught('<span>{c.counts.usable} tools</span>'), 1);
  assert.equal(caught("<li>{open.length} open acties</li>"), 1);
  assert.equal(caught("t('Elke {0} dagen', n)"), 1);
  assert.equal(caught('toast(`${r.created} bots geïmporteerd`)'), 1);
  assert.equal(caught("{n === 1 ? '1 bestand' : `${n} bestanden`}"), 0);
  assert.equal(caught("{t.rows === 1 ? '1 rij' : `${t.rows.toLocaleString(uiLocale())} rijen`}"), 0);
  assert.equal(caught("t('{0, plural, one {# tool} other {# tools}}', n)"), 0);
  assert.equal(caught('<BotAccess setChosen={setChosen} agents={agents} />'), 0);
  assert.equal(caught('const x = `Maximaal ${MAX_FILES} bestanden per bericht.`'), 0);
  assert.equal(caught('return `${list.length} tabellen in de teamdatabase`;', true), 0, 'server: a text for the bots only');
  assert.equal(caught('throw bad(`Je kunt maximaal ${max} bots hebben.`);', true), 1, 'server: an error the owner sees');
});

// The form for one of a server sentence is often a plain string (`n === 1 ? '1 routine staat uit. …' : `${n} …``); the
// extractor only found the template, so in every other language "1 routine staat uit" stayed Dutch.
test('a server sentence for one is found for translation, like the one for more', async () => {
  const { extractStrings } = await import(pathToFileURL(path.join(process.cwd(), 'scripts', 'i18n-extract.mjs')).href);
  const { strings } = extractStrings(process.cwd());
  for (const s of [
    '1 routine staat uit. Zet hem aan wanneer je OpenBot stopt, anders draait hij dubbel (bijv. klantmails).',
    '{0} routines staan uit. Zet ze aan wanneer je OpenBot stopt, anders draaien ze dubbel (bijv. klantmails).',
    '1 workflow wordt niet overgenomen; TeamBot heeft (nog) geen workflow-canvas.',
    '1 nieuwe tool gevonden. Die is pas bruikbaar nadat je hem goedkeurt.',
    'Je kunt op deze server maximaal 1 bot hebben.',
    'Typen in {0} (1 teken)',
    'elk uur',
  ])
    assert.ok(strings.has(s), `extracted: ${s}`);
});

// Acceptance round 6: a skill review said "13.3 KB" (a dot and "KB" in Dutch). Sizes and decimals the interface shows
// go through lib/format.ts (formatBytes, formatNumber, formatPercent …), server texts through bytesText.
test('sizes are never built by hand: no toFixed for display, no "KB", no "/ 1024 … MB" in the interface', () => {
  const root = process.cwd();
  const found: string[] = [];
  const HAND_SIZE = /\$\{[^{}\n]*\/\s*(?:1024|1e[369]|1048576|102\.4|104857\.6)\b[^{}\n]*\}\s*(?:B|KB|kB|MB|GB)\b/;
  for (const f of [...sourceFiles(path.join(root, 'ui', 'src')), ...sourceFiles(path.join(root, 'shared')), ...sourceFiles(path.join(root, 'server')), ...sourceFiles(path.join(root, 'desktop'))]) {
    const rel = path.relative(root, f).replace(/\\/g, '/');
    const ui = rel.startsWith('ui/') || rel.startsWith('shared/');
    fs.readFileSync(f, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (/^\s*(?:\/\/|\*)/.test(line)) return;
        // A decimal with a dot in front of a unit ("1.5 GB" in a Dutch sentence), or "KB" for kilobyte.
        const dot = /toFixed\([^)]*\)\s*\}\s*(?:B|KB|kB|MB|GB)\b/.test(line) || /\}\s*KB\b/.test(line);
        // The interface: no hand-built size at all, and toFixed only for drawing (SVG coordinates).
        const hand = ui && (HAND_SIZE.test(line) || (/\.toFixed\(/.test(line) && rel !== 'shared/botface.ts'));
        if (dot || hand) found.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
  }
  assert.deepEqual(found, []);
});

test('no "(en)", "(s)", "(n)" or "(ken)" plural shortcuts in interface or server texts', async () => {
  // Every text the interface or the server shows, as the extractor finds them for translation.
  const { extractStrings } = await import(pathToFileURL(path.join(process.cwd(), 'scripts', 'i18n-extract.mjs')).href);
  const { strings } = extractStrings(process.cwd());
  const found = [...strings.keys()].filter((s: string) => /\p{Ll}{2,}\((?:en|s|n|ken|e)\)(?![\p{L}\d])/u.test(s.replace(/https?\(s\)|http\(s\)/g, '')));
  assert.deepEqual(found, []);
});
