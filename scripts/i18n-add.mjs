// Adds an interface language in one command: registers it in ui/src/i18n/languages.json (name, locale and writing
// direction from Intl), translates every interface text into it and checks the dictionary.
// Usage: npm run i18n:add -- <code> [--locale sv-SE] [--name Svenska] [--english Swedish] [--no-translate]
//   e.g. npm run i18n:add -- sv      npm run i18n:add -- he (right-to-left is detected)
// Afterwards: npm run build:ui && npm run i18n:check -- --lang <code>
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { dictFile, languages, writeLanguages } from './i18n-lib.mjs';

const args = process.argv.slice(2);
const code = (args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--')) || '').toLowerCase();
const opt = (n) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
if (!/^[a-z]{2,3}$/.test(code)) {
  console.error('Gebruik: npm run i18n:add -- <taalcode>   (ISO 639-1, bijv. sv, he, ja)');
  process.exit(2);
}
const list = languages();
if (list.some((l) => l.code === code)) {
  console.log(`${code} staat er al in; alleen ontbrekende teksten worden vertaald.`);
} else {
  const max = new Intl.Locale(code).maximize();
  const locale = opt('locale') || `${code}-${max.region || code.toUpperCase()}`;
  const cap = (s) => s.charAt(0).toLocaleUpperCase(locale) + s.slice(1);
  const name = opt('name') || cap(new Intl.DisplayNames([code], { type: 'language' }).of(code) || code);
  const english = opt('english') || new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code;
  const rtl = ['Arab', 'Hebr', 'Thaa', 'Syrc', 'Nkoo', 'Adlm', 'Rohg'].includes(max.script || '');
  const entry = { code, name, english, locale, dir: rtl ? 'rtl' : 'ltr' };
  writeLanguages([...list, entry]);
  console.log(`Toegevoegd: ${JSON.stringify(entry)}`);
}
if (!fs.existsSync(dictFile(code))) fs.writeFileSync(dictFile(code), '{}\n');
if (!args.includes('--no-translate')) {
  const r = spawnSync(process.execPath, ['scripts/i18n-translate.mjs', '--lang', code], { stdio: 'inherit' });
  if (r.status) process.exit(r.status);
  spawnSync(process.execPath, ['--import', 'tsx', 'tests/e2e/i18n.mjs', '--lang', code, '--static'], { stdio: 'inherit' });
}
console.log(`\nKlaar. Controleer de app in deze taal: npm run build:ui && npm run i18n:check -- --lang ${code}`);
