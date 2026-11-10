// Money, percentages, compact counts, tokens and seconds in the reader's notation (acceptance round 4: "4.3% vol",
// "188.3k", "$0.30" and "$0,015" in the Dutch interface; "$0.0000" on a group's cost tab).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { capFirst, formatCompact, formatPercent, formatSeconds, formatTokens, formatUsd, formatUsdRange } from '../shared/format.js';
import { usdText } from '../server/core/i18n.js';
import { Translator, localizeUsd } from '../shared/i18n-core.js';

const AR = 'ar-u-nu-latn';

test('dollars: two decimals, small amounts keep up to four, in the notation of the language', () => {
  assert.match(formatUsd(0, {}, 'nl-NL'), /^US\$\s0,00$/);
  assert.match(formatUsd(0.3, {}, 'nl-NL'), /^US\$\s0,30$/);
  assert.match(formatUsd(0.3, {}, 'de-DE'), /^0,30\s\$$/);
  assert.equal(formatUsd(0.3, {}, 'en-GB'), 'US$0.30');
  assert.match(formatUsd(0.0012, {}, 'nl-NL'), /^US\$\s0,0012$/, 'under a cent never reads as zero');
  assert.match(formatUsd(0.0123, { max: 4 }, 'nl-NL'), /^US\$\s0,0123$/);
  assert.match(formatUsd(0.015, { max: 3 }, 'nl-NL'), /^US\$\s0,015$/, 'a price per minute');
  assert.match(formatUsd(3, { min: 0, max: 2 }, 'fr-FR'), /^3\s\$US$/);
  assert.match(formatUsd(1.5, {}, AR), /1\.50/, 'Latin digits in Arabic');
  assert.ok(!/\$0\.0000/.test(formatUsd(0, {}, 'en-GB')), 'no "$0.0000"');
});

test('dollar ranges follow the reader\'s language', () => {
  assert.match(formatUsdRange(0.02, 0.05, {}, 'nl-NL'), /0,02.*0,05/);
  assert.match(formatUsdRange(0.02, 0.05, {}, 'en-GB'), /0\.02.*0\.05/);
});

test('a stored server text shows its amount in the notation of whoever reads it (acceptance round 5, C-17)', () => {
  // The server writes the amount as a value in the source notation, whatever the user's language is now ...
  const text = `Je daglimiet van ${usdText(0.5)} op de gedeelde provider Team-endpoint is bereikt.`;
  assert.match(text, /van US\$\s0,50 op/);
  // ... and the translator puts it in the reader's notation when it is shown ("Your daily limit of US$ 0,50" before).
  const dict = { 'Je daglimiet van {0} op de gedeelde provider {1} is bereikt.': 'Your daily limit of {0} on the shared provider {1} has been reached.' };
  assert.equal(new Translator(dict, 'en-GB').translate(text), 'Your daily limit of US$0.50 on the shared provider Team-endpoint has been reached.');
  const de = new Translator({ 'Je daglimiet van {0} op de gedeelde provider {1} is bereikt.': 'Dein Tageslimit von {0} beim gemeinsamen Anbieter {1} ist erreicht.' }, 'de-DE');
  assert.match(de.translate(text), /von 0,50\s\$ beim/);
  // The same decimals, thousands, a sign before it; a template with values (trUser) too.
  assert.equal(localizeUsd(usdText(0.0123, { max: 4 }), 'en-GB'), 'US$0.0123');
  assert.equal(localizeUsd(usdText(0.0012), 'en-GB'), 'US$0.0012');
  assert.equal(localizeUsd(usdText(1234.5), 'en-GB'), 'US$1,234.50');
  assert.equal(localizeUsd(`≈ ${usdText(0.05)}`, 'en-GB'), '≈ US$0.05');
  assert.equal(new Translator({ 'Daglimiet van {0} bereikt': 'Daily limit of {0} reached' }, 'en-GB').format('Daglimiet van {0} bereikt', [usdText(2)]), 'Daily limit of US$2.00 reached');
  // A composed line (voice call record): the amount between the parts.
  assert.equal(new Translator({ Spraakgesprek: 'Voice call' }, 'en-GB').translate(`Spraakgesprek · 1:05 · ≈ ${usdText(0.05)}`), 'Voice call · 1:05 · ≈ US$0.05');
  // Only values that are amounts; amounts the reader's page made itself stay as they are.
  assert.equal(localizeUsd('US$ 0,50 per dag', 'en-GB'), null);
  assert.equal(localizeUsd('US$0.50', 'en-GB'), null);
  assert.equal(localizeUsd(formatUsd(1234.5, {}, 'pt-BR'), 'pt-BR'), formatUsd(1234.5, {}, 'pt-BR'));
});

test('percentages: one decimal below 10, the language\'s own sign and spacing', () => {
  assert.equal(formatPercent(4.3, 'nl-NL'), '4,3%');
  assert.equal(formatPercent(4.3, 'en-GB'), '4.3%');
  assert.match(formatPercent(4.3, 'de-DE'), /^4,3\s%$/);
  assert.equal(formatPercent(4.3, 'tr-TR'), '%4,3');
  assert.equal(formatPercent(91.4, 'nl-NL'), '91%');
  assert.equal(formatPercent(5, 'nl-NL'), '5%');
});

test('compact counts and tokens: "188,3K" in Dutch, "188.3k" in English, words in Polish', () => {
  assert.equal(formatCompact(188_300, 'nl-NL'), '188,3K');
  assert.equal(formatCompact(188_300, 'en-GB'), '188.3k');
  assert.match(formatCompact(188_300, 'pl-PL'), /^188,3\stys\.$/);
  assert.equal(formatCompact(950, 'nl-NL'), '950');
  assert.match(formatTokens(1_200_000, 'de-DE'), /^1,2\sMio\.$/);
});

test('dates start a heading with one capital, never Title Case (no CSS capitalize)', () => {
  assert.equal(capFirst('zaterdag 7 november', 'nl-NL'), 'Zaterdag 7 november');
  assert.equal(capFirst('2 nov. – 8 nov. 2026', 'nl-NL'), '2 nov. – 8 nov. 2026');
  assert.equal(capFirst('', 'nl-NL'), '');
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && /className=[^\n]*\bcapitalize\b/.test(fs.readFileSync(p, 'utf8'))) files.push(p);
    }
  };
  walk(path.join(process.cwd(), 'ui', 'src'));
  assert.deepEqual(files, [], 'CSS capitalize makes "Zaterdag 7 November" of a Dutch date');
});

test('seconds with one decimal from milliseconds', () => {
  assert.equal(formatSeconds(2000, 'nl-NL'), '2,0 s');
  assert.equal(formatSeconds(2000, 'en-GB'), '2.0s');
  assert.equal(formatSeconds(10_800, 'nl-NL'), '10,8 s');
});
