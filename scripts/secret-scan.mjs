#!/usr/bin/env node
// Secret scan (D-15): no API keys, tokens or private keys in the repository, the build output or the installer.
// Scans every file git tracks plus dist/ and the unpacked app in release/ (not the compressed installer itself), with
// the patterns of the well-known secret formats. The app itself ships as resources/app.asar: the scanner reads the
// files inside that archive (all of them, node_modules included, because that is what users get) with the same rules;
// files the archive keeps outside (app.asar.unpacked) are scanned on disk. Test fixtures that are obviously fake are
// allowed through ALLOW.
// Usage: node scripts/secret-scan.mjs [--json]   exit 1 on a finding or an archive that cannot be read.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RULES = [
  ['OpenAI-sleutel', /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}\b|\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}\b/],
  ['Anthropic-sleutel', /\bsk-ant-(?:api|admin|oat)\d{2}-[A-Za-z0-9_-]{80,}\b/],
  ['GitHub-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/],
  ['AWS-sleutel', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['Google-API-sleutel', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Slack-token', /\bxox[abprs]-[A-Za-z0-9-]{20,}\b/],
  ['Stripe-geheim', /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/],
  ['Telegram-bottoken', /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/],
  ['Discord-bottoken', /\b[MN][A-Za-z\d]{23,25}\.[\w-]{6}\.[\w-]{27,38}\b/],
  ['Groq/xAI/OpenRouter-sleutel', /\b(?:gsk_[A-Za-z0-9]{48,}|xai-[A-Za-z0-9]{70,}|sk-or-v1-[a-f0-9]{64})\b/],
  ['Privésleutel', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----\s*\n\s*[A-Za-z0-9+/=]{40,}/],
];
// Known fake values in tests and docs (they look like a format on purpose).
export const ALLOW = [/EXAMPLE/i, /abcdefghijklmnop/i, /x{10,}/i, /0{16,}/, /1234567890abcdef/i, /your[-_]?key/i, /test[-_]?secret/i, /fake/i, /dummy/i];
export const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.icns', '.webp', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.wav', '.ogg', '.onnx', '.bin', '.zip', '.7z', '.exe', '.dll', '.node', '.pak', '.dat', '.blockmap', '.asar', '.pdf', '.docx', '.xlsx']);
export const MAX = 8 * 1024 * 1024;

/** Findings in one text: [{ line, kind, sample }] (sample = first 8 characters, never the whole value). */
export function scanText(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (const [name, re] of RULES) {
    const g = new RegExp(re.source, 'g');
    for (const m of text.matchAll(g)) {
      if (ALLOW.some((a) => a.test(m[0]))) continue;
      const line = text.slice(0, m.index).split('\n').length;
      const ctx = lines[line - 1] || '';
      if (ALLOW.some((a) => a.test(ctx))) continue;
      out.push({ line, kind: name, sample: m[0].slice(0, 8) + '…' });
    }
  }
  return out;
}

/**
 * Opens an asar archive (Electron's format: an 8-byte size pickle, a JSON header pickle, then the file data) and lists
 * its files. Throws on anything that is not a well-formed archive, so a broken app.asar fails the gate instead of
 * being skipped. Entries with `unpacked` live next to it in `<archive>.unpacked/`; links are left out.
 * @returns {{ entries: { path: string, size: number, unpacked: boolean }[], read(entry): Buffer, close(): void }}
 */
export function openAsar(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const total = fs.fstatSync(fd).size;
    const bad = (why) => new Error(`${file}: geen geldig asar-archief (${why})`);
    if (total < 16) throw bad('te klein');
    const sizePickle = Buffer.alloc(8);
    fs.readSync(fd, sizePickle, 0, 8, 0);
    if (sizePickle.readUInt32LE(0) !== 4) throw bad('kop');
    const headerSize = sizePickle.readUInt32LE(4);
    if (headerSize < 8 || 8 + headerSize > total) throw bad('kopgrootte');
    const headerPickle = Buffer.alloc(headerSize);
    fs.readSync(fd, headerPickle, 0, headerSize, 8);
    const jsonSize = headerPickle.readInt32LE(4);
    if (jsonSize <= 0 || 8 + jsonSize > headerSize) throw bad('kop-JSON');
    let header;
    try {
      header = JSON.parse(headerPickle.toString('utf8', 8, 8 + jsonSize));
    } catch {
      throw bad('kop-JSON');
    }
    const base = 8 + headerSize;
    const entries = [];
    const walk = (dir, prefix) => {
      for (const [name, e] of Object.entries(dir.files || {})) {
        if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) throw bad(`naam ${JSON.stringify(name)}`);
        const p = prefix ? `${prefix}/${name}` : name;
        if (e && typeof e === 'object' && e.files) walk(e, p);
        else if (e && typeof e === 'object' && 'link' in e) continue;
        else {
          const size = Number(e?.size);
          if (!Number.isSafeInteger(size) || size < 0) throw bad(`grootte van ${p}`);
          if (e.unpacked) entries.push({ path: p, size, unpacked: true });
          else {
            const offset = base + Number(e.offset);
            if (!Number.isSafeInteger(offset) || offset < base || offset + size > total) throw bad(`positie van ${p}`);
            entries.push({ path: p, size, unpacked: false, offset });
          }
        }
      }
    };
    walk(header, '');
    return {
      entries,
      read(entry) {
        if (entry.unpacked) return fs.readFileSync(path.join(`${file}.unpacked`, ...entry.path.split('/')));
        const buf = Buffer.alloc(entry.size);
        let done = 0;
        while (done < entry.size) {
          const n = fs.readSync(fd, buf, done, entry.size - done, entry.offset + done);
          if (n <= 0) throw bad(`einde van ${entry.path}`);
          done += n;
        }
        return buf;
      },
      close: () => fs.closeSync(fd),
    };
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
}

/**
 * Scans the files inside one asar archive with the same rules, extensions and size limit as files on disk.
 * `seen` = absolute paths already scanned on disk (unpacked entries are then not read twice).
 */
export function scanAsar(file, label = file, seen = new Set()) {
  const archive = openAsar(file);
  const findings = [];
  let entries = 0;
  let scanned = 0;
  try {
    for (const e of archive.entries) {
      entries++;
      if (SKIP_EXT.has(path.extname(e.path).toLowerCase()) || e.size > MAX) continue;
      if (e.unpacked && seen.has(path.join(`${file}.unpacked`, ...e.path.split('/')))) continue;
      const text = archive.read(e).toString('utf8');
      scanned++;
      for (const f of scanText(text)) findings.push({ file: `${label} › ${e.path}`, ...f });
    }
  } finally {
    archive.close();
  }
  return { entries, scanned, findings };
}

function tracked() {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\0')
      .filter(Boolean)
      .map((f) => path.join(root, f));
  } catch {
    return [];
  }
}
function walk(dir, out = []) {
  let list = [];
  try {
    list = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of list) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' && !p.includes('app.asar.unpacked')) continue;
      walk(p, out);
    } else out.push(p);
  }
  return out;
}

function main() {
  const files = new Set([...tracked(), ...walk(path.join(root, 'dist')), ...walk(path.join(root, 'release', 'win-unpacked', 'resources')), ...['mac-arm64', 'mac'].flatMap((d) => walk(path.join(root, 'release', d, 'TeamBot.app', 'Contents', 'Resources')))]);
  const findings = [];
  const seen = new Set();
  const archives = [];
  let scanned = 0;
  for (const f of files) {
    if (path.extname(f).toLowerCase() === '.asar') {
      archives.push(f);
      continue;
    }
    if (SKIP_EXT.has(path.extname(f).toLowerCase())) continue;
    let st;
    try {
      st = fs.statSync(f);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > MAX) continue;
    const text = fs.readFileSync(f, 'utf8');
    scanned++;
    seen.add(f);
    for (const x of scanText(text)) findings.push({ file: path.relative(root, f), ...x });
  }
  const asar = [];
  for (const a of archives) {
    const label = path.relative(root, a);
    try {
      const r = scanAsar(a, label, seen);
      asar.push({ file: label, entries: r.entries, scanned: r.scanned, findings: r.findings.length });
      findings.push(...r.findings);
    } catch (e) {
      asar.push({ file: label, error: String(e?.message || e) });
      findings.push({ file: label, line: 0, kind: 'Asar-archief niet te lezen', sample: String(e?.message || e) });
    }
  }
  const inAsar = asar.reduce((n, a) => n + (a.scanned || 0), 0);
  if (process.argv.includes('--json')) console.log(JSON.stringify({ scanned, asar, findings }, null, 2));
  else {
    for (const x of findings) console.log(`✗ ${x.kind}: ${x.file}:${x.line} (${x.sample})`);
    for (const a of asar)
      if (!a.error) console.log(`${a.file}: ${a.entries} bestanden in het archief, ${a.scanned} tekstbestanden gescand.`);
    console.log(
      `${scanned + inAsar} bestanden gescand (repo, dist/, release/${archives.length ? `, waarvan ${inAsar} in app.asar` : ''}): ${findings.length ? `${findings.length} mogelijke geheimen` : '0 treffers'}.`,
    );
  }
  process.exit(findings.length ? 1 : 0);
}

// Run as a script (npm run secrets:check); imported by tests/secret-scan.test.ts only for its functions.
const self = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (process.platform === 'win32' ? invoked.toLowerCase() === self.toLowerCase() : invoked === self) main();
