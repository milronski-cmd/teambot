#!/usr/bin/env node
// The update channel of a release (parity 16.2): latest.yml, the installer and its .blockmap in one folder, ready to
// upload. electron-updater in every installed TeamBot reads latest.yml, downloads the installer and checks it against
// the sha512 in there; the .blockmap lets a next version download only what changed.
//
//   npm run release:feed                       release/TeamBot-Setup-<package.json version>.exe → release/feed/
//   npm run release:feed -- --version 0.4.4 --dir release --out release/feed
//   npm run release:feed -- --check            does release/latest.yml still match the installer? (exit 1 if not)
//
// Run it after `npm run dist:win`, and again after signing the installer outside electron-builder (SignPath): a
// signature changes the file, so the sha512 and the blockmap that electron-builder wrote no longer match.
// The installer of the previous version (when it is in --dir) goes into the folder too: "Terug naar versie x" fetches
// it from the channel. On a folder host keep the installers of earlier versions online; on GitHub Releases every
// release keeps its own (docs/IOS_WINDOWS_RELEASE.md, "Updates publiceren").
// Uses electron-builder's own blockmap code (app-builder-lib, MIT) and yaml (ISC); nothing is uploaded.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;

/** package.json build.win.artifactName → the installer's file name for a version. */
export function installerFileName(version, pattern = 'TeamBot-Setup-${version}.${ext}') {
  return pattern.replace('${version}', version).replace('${ext}', 'exe').replace('${productName}', 'TeamBot');
}

async function sha512(file) {
  const h = crypto.createHash('sha512');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest('base64');
}

/** -1, 0 or 1 for x.y.z (a pre-release counts lower than the release). */
function cmp(a, b) {
  const [ma, pa = ''] = a.split('-', 2);
  const [mb, pb = ''] = b.split('-', 2);
  const x = ma.split('.').map(Number);
  const y = mb.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  if (pa === pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  return pa > pb ? 1 : -1;
}

/** latest.yml as electron-builder writes it for an NSIS installer. */
export function latestYml({ version, name, sha512: sum, size, releaseDate, releaseNotes }) {
  const doc = { version, files: [{ url: name, sha512: sum, size }], path: name, sha512: sum, releaseDate };
  if (releaseNotes) doc.releaseNotes = releaseNotes;
  // Quoted, as electron-builder writes it: js-yaml (in electron-updater) would read a bare ISO time as a Date.
  return YAML.stringify(doc, { lineWidth: 0 }).replace(/^releaseDate: (.+)$/m, (_, d) => `releaseDate: '${d.replace(/^['"]|['"]$/g, '')}'`);
}

/** The "## [<version>]" section of CHANGELOG.md (what electron-updater shows as the notes), or ''. */
export function changelogNotes(version, changelog = path.join(root, 'CHANGELOG.md')) {
  try {
    const lines = fs.readFileSync(changelog, 'utf8').split(/\r?\n/);
    const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
    if (start < 0) return '';
    const end = lines.findIndex((l, i) => i > start && /^## \[/.test(l));
    return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim().slice(0, 4000);
  } catch {
    return '';
  }
}

/**
 * Build the feed folder. Returns what is in it. `previous`: also copy the newest older installer found in `dir` (the
 * way back on a folder host).
 */
export async function makeFeed({ dir = path.join(root, 'release'), out, version, pattern, previous = true, notes = true, now = new Date() } = {}) {
  if (!version) version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  if (!VERSION.test(version)) throw new Error(`Ongeldige versie: ${version}`);
  out = out || path.join(dir, 'feed');
  const name = installerFileName(version, pattern);
  const exe = path.join(dir, name);
  if (!fs.existsSync(exe)) throw new Error(`${name} staat niet in ${dir}. Bouw eerst de installer (npm run dist:win).`);
  const head = Buffer.alloc(2);
  const fd = fs.openSync(exe, 'r');
  fs.readSync(fd, head, 0, 2, 0);
  fs.closeSync(fd);
  if (head.toString('latin1') !== 'MZ') throw new Error(`${name} is geen Windows-programma`);
  fs.mkdirSync(out, { recursive: true });
  const target = path.join(out, name);
  if (path.resolve(target) !== path.resolve(exe)) fs.copyFileSync(exe, target);
  // The blockmap electron-builder wrote is kept while it still belongs to this file (it knows where app.asar sits in
  // the installer, which keeps the next download small); after signing afterwards it is made again with
  // electron-builder's own code (gzip, next to the installer).
  const built = await checkFeed(dir);
  const ownMap = path.join(dir, `${name}.blockmap`);
  let info;
  if (built.ok && built.name === name && fs.existsSync(ownMap) && path.resolve(out) !== path.resolve(dir)) {
    fs.copyFileSync(ownMap, `${target}.blockmap`);
    info = { sha512: await sha512(target), size: fs.statSync(target).size };
  } else {
    const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap.js');
    info = await buildBlockMap(target, 'gzip', `${target}.blockmap`);
  }
  const sum = info.sha512 || (await sha512(target));
  const size = info.size || fs.statSync(target).size;
  const yml = latestYml({ version, name, sha512: sum, size, releaseDate: now.toISOString(), releaseNotes: notes ? changelogNotes(version) : '' });
  fs.writeFileSync(path.join(out, 'latest.yml'), yml);
  const files = ['latest.yml', name, `${name}.blockmap`];
  let prev = null;
  if (previous) {
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('^' + installerFileName('\u0000', pattern).split('\u0000').map(esc).join('(\\d+\\.\\d+\\.\\d+(?:-[\\w.]+)?)') + '$');
    const older = fs
      .readdirSync(dir)
      .map((f) => [f, re.exec(f)?.[1]])
      .filter(([, v]) => v && cmp(v, version) < 0)
      .sort((a, b) => cmp(b[1], a[1]));
    if (older.length) {
      prev = older[0][1];
      const [f] = older[0];
      if (path.resolve(path.join(out, f)) !== path.resolve(path.join(dir, f))) fs.copyFileSync(path.join(dir, f), path.join(out, f));
      files.push(f);
    }
  }
  return { out, version, name, sha512: sum, size, files, previous: prev };
}

/** Does latest.yml in `dir` still describe the installer next to it (e.g. after signing it afterwards)? */
export async function checkFeed(dir = path.join(root, 'release')) {
  const f = path.join(dir, 'latest.yml');
  if (!fs.existsSync(f)) return { ok: false, reason: `Geen latest.yml in ${dir}` };
  const doc = YAML.parse(fs.readFileSync(f, 'utf8'));
  const file = doc?.files?.[0];
  const exe = file?.url ? path.join(dir, file.url) : '';
  if (!exe || !fs.existsSync(exe)) return { ok: false, reason: `${file?.url || 'de installer'} staat niet naast latest.yml` };
  const [sum, size] = [await sha512(exe), fs.statSync(exe).size];
  if (sum !== file.sha512 || size !== file.size) return { ok: false, reason: `latest.yml klopt niet met ${file.url} (ondertekend na het bouwen?). Draai npm run release:feed.` };
  return { ok: true, version: doc.version, name: file.url };
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (k) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  try {
    const dir = path.resolve(opt('dir') || path.join(root, 'release'));
    if (args.includes('--check')) {
      const r = await checkFeed(dir);
      console.log(r.ok ? `latest.yml klopt met ${r.name} (versie ${r.version}).` : r.reason);
      process.exit(r.ok ? 0 : 1);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const r = await makeFeed({ dir, out: opt('out') ? path.resolve(opt('out')) : undefined, version: opt('version'), pattern: pkg.build?.win?.artifactName, previous: !args.includes('--only-new') });
    console.log(`Updatekanaal voor TeamBot ${r.version} staat klaar in ${r.out}:`);
    for (const f of r.files) console.log(`  ${f}`);
    console.log(r.previous ? `(met de installer van ${r.previous} voor "Terug naar versie ${r.previous}")` : '(geen oudere installer gevonden; laat die van de vorige versie op je host staan)');
    console.log('Upload deze bestanden naar je updatemap (https), of als bijlagen bij GitHub-release v' + r.version + '. Zie docs/IOS_WINDOWS_RELEASE.md, "Updates publiceren".');
  } catch (e) {
    console.error(e?.message || e);
    process.exit(1);
  }
}
