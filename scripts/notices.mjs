// Generates THIRD_PARTY_NOTICES.txt and a CycloneDX SBOM (sbom.cdx.json) for all production
// dependencies, and fails when a dependency has a license outside the allowlist.
// Usage: node scripts/notices.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// MPL-2.0 is weak, file-level copyleft: allowed only for unmodified npm packages (source stays available on npm). See docs/adr/0004-licenties.md.
// OFL-1.1 is for fonts only (bundled unmodified in the interface; the license text ships in the notices).
const ALLOW = new Set(['MPL-2.0', 'MIT', 'MIT-0', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'BlueOak-1.0.0', 'CC0-1.0', 'Unlicense', 'Python-2.0', 'CC-BY-4.0', 'Zlib', 'OFL-1.1']);
// Build-time packages whose files are copied into the shipped interface (dist/ui) and need their own notice.
// pdfjs-dist (Apache-2.0): the pdf viewer and its worker are bundled into dist/ui. highlight.js (BSD-3-Clause): code colours.
// papaparse (MIT): CSV for "Kopieer tabel" under a table in a chat answer.
// katex (MIT) with its fonts (OFL-1.1, see FONT_NOTICES): formulas in chat answers. @radix-ui/react-dialog (MIT): dialogs.
const BUNDLED_ASSETS = ['@fontsource-variable/figtree', 'pdfjs-dist', 'highlight.js', 'papaparse', 'katex', '@radix-ui/react-dialog'];
// Packages whose code has one license and whose bundled fonts another (the package.json names only the first): the SPDX
// expression for both, and the font notice. The OFL 1.1 text follows it (taken from the OFL package Figtree ships).
const FONT_NOTICES = {
  katex: {
    license: 'MIT AND OFL-1.1',
    text: 'The KaTeX fonts (katex/dist/fonts, bundled unmodified into the interface): Copyright (c) 2009-2010, Design Science, Inc. (www.mathjax.org); Copyright (c) 2014-2018 Khan Academy (www.khanacademy.org), with Reserved Font Names. This Font Software is licensed under the SIL Open Font License, Version 1.1.',
  },
};
// Source code adapted from other Apache-2.0 projects (not npm packages): listed with the project's licence (the same
// Apache-2.0 text as TeamBot's own LICENSE) and what TeamBot changed. The adapted files carry a notice at the top.
const ADAPTED_CODE = [
  {
    name: 'OpenMausBot',
    version: 'commit 1de1164d5040d8699f55e0907552270bd9fbd38f',
    license: 'Apache-2.0',
    homepage: 'https://github.com/milind-soni/OpenMausBot',
    note: 'Copyright OpenMausBot contributors. Adapted from server/live-call.ts into server/modules/voice/calltools.ts: the shape of spokenHangUp (lead words stripped, the whole utterance must be the request) and the delegation policy of the live voice instructions. Changed: Dutch and English, a separate wait/no check, tool-based delegation with tasks, spoken one-time approvals and end_call guards.',
  },
];
// Code ported from, or data taken from, open-source projects that are not npm packages; each keeps its own licence
// file under third_party/ and is listed in THIRD_PARTY_NOTICES.txt after the npm packages.
const EMBEDDED = [
  { name: 'ollama (model/parsers/qwen3coder.go, ported to server/providers/qwen3coder.ts)', version: '64a901e7', license: 'MIT', homepage: 'https://github.com/ollama/ollama', file: 'third_party/ollama/LICENSE' },
  { name: 'models.dev (model catalogue data, trimmed in server/providers/models-dev-snapshot.json)', version: 'api.json', license: 'MIT', homepage: 'https://github.com/anomalyco/models.dev', file: 'third_party/models.dev/LICENSE' },
];
const checkOnly = process.argv.includes('--check');
const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const tree = JSON.parse(execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ls', '--omit=dev', '--all', '--json', '--long'], { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 }));
const seen = new Map();
(function walk(deps) {
  for (const [name, d] of Object.entries(deps || {})) {
    if (!d || !d.version) continue;
    const key = `${name}@${d.version}`;
    if (!seen.has(key)) seen.set(key, { name, version: d.version, path: d.path });
    walk(d.dependencies);
  }
})(tree.dependencies);
for (const name of BUNDLED_ASSETS) {
  const dir = path.join(root, 'node_modules', ...name.split('/'));
  try {
    const version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
    if (!seen.has(`${name}@${version}`)) seen.set(`${name}@${version}`, { name, version, path: dir });
  } catch {
    console.error(`Meegeleverd bestand ontbreekt: ${name} (draai npm ci)`);
    process.exitCode = 1;
  }
}

// Packages whose package.json names no exact SPDX id, checked by hand against their LICENSE file (name@version → id).
// duck (via mammoth → lop): "BSD"; its LICENSE is the 2-clause BSD text.
const CLARIFIED = { 'duck@0.1.12': 'BSD-2-Clause' };

function licenseOf(dir) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    let l = CLARIFIED[`${p.name}@${p.version}`] || p.license || (Array.isArray(p.licenses) ? p.licenses.map((x) => x.type || x).join(' OR ') : p.licenses?.type) || 'UNKNOWN';
    if (typeof l === 'object') l = l.type || 'UNKNOWN';
    return { license: String(l), homepage: p.homepage || p.repository?.url || p.repository || '' };
  } catch {
    return { license: 'UNKNOWN', homepage: '' };
  }
}

function allowed(expr) {
  const e = expr.replace(/[()]/g, '').trim();
  if (e.includes(' OR ')) return e.split(' OR ').some((x) => ALLOW.has(x.trim()));
  if (e.includes(' AND ')) return e.split(' AND ').every((x) => ALLOW.has(x.trim()));
  return ALLOW.has(e);
}

function licenseText(dir) {
  try {
    const f = fs.readdirSync(dir).find((x) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(x));
    return f ? fs.readFileSync(path.join(dir, f), 'utf8').trim() : '';
  } catch {
    return '';
  }
}

/** The SIL OFL 1.1 text (from "SIL OPEN FONT LICENSE Version 1.1" on). */
function oflText() {
  const t = licenseText(path.join(root, 'node_modules', '@fontsource-variable', 'figtree'));
  const i = t.indexOf('SIL OPEN FONT LICENSE Version 1.1');
  return i >= 0 ? t.slice(i) : 'SIL Open Font License, Version 1.1: https://openfontlicense.org';
}

const rows = [...seen.values()]
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((d) => {
    const l = licenseOf(d.path);
    const font = FONT_NOTICES[d.name];
    return { ...d, ...l, ...(font ? { license: font.license, extra: `${font.text}\n\n${oflText()}` } : {}) };
  });
const embedded = EMBEDDED.map((e) => {
  let text = '';
  try {
    text = fs.readFileSync(path.join(root, e.file), 'utf8').trim();
  } catch {
    console.error(`Licentietekst ontbreekt: ${e.file}`);
    process.exitCode = 1;
  }
  return { ...e, text };
});
const bad = [...rows, ...embedded, ...ADAPTED_CODE].filter((r) => !allowed(r.license));
console.log(`${rows.length} productie-dependencies gecontroleerd.`);
if (bad.length) {
  console.error('Niet-toegestane of onbekende licenties:');
  for (const b of bad) console.error(`  ${b.name}@${b.version}: ${b.license}`);
}
if (!checkOnly) {
  const out = [`Third-party software included in ${pkg.productName || pkg.name} ${pkg.version}`, `Generated ${new Date().toISOString().slice(0, 10)}`, ''];
  for (const r of rows) {
    out.push('='.repeat(78), `${r.name} ${r.version} — ${r.license}`, r.homepage ? String(r.homepage) : '', '-'.repeat(78), licenseText(r.path) || `(${r.license}; licentietekst niet meegeleverd door het pakket)`, ...(r.extra ? ['', r.extra] : []), '');
  }
  out.push('='.repeat(78), 'Code and data from other open-source projects (not npm packages)', '');
  for (const e of embedded) out.push('='.repeat(78), `${e.name} ${e.version} — ${e.license}`, e.homepage, '-'.repeat(78), e.text, '');
  const apache = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8').trim();
  for (const c of ADAPTED_CODE) out.push('='.repeat(78), `${c.name} (${c.version}) — ${c.license} (adapted source code)`, c.homepage, c.note, '-'.repeat(78), apache, '');
  fs.writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.txt'), out.join('\n'));
  const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: { timestamp: new Date().toISOString(), component: { type: 'application', name: pkg.name, version: pkg.version, licenses: [{ license: { id: pkg.license } }] } },
    components: rows.map((r) => ({ type: 'library', name: r.name, version: r.version, purl: `pkg:npm/${r.name.replace('@', '%40')}@${r.version}`, licenses: [{ expression: r.license }] })),
  };
  fs.writeFileSync(path.join(root, 'sbom.cdx.json'), JSON.stringify(sbom, null, 2));
  console.log('THIRD_PARTY_NOTICES.txt en sbom.cdx.json geschreven.');
}
process.exit(bad.length || process.exitCode ? 1 : 0);
