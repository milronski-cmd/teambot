#!/usr/bin/env node
// teambot-pack — make, sign and verify TeamBot packages (skills, bot templates, connector templates).
//
//   npm run pack:package -- keygen [--out <file>] [--force]
//   npm run pack:package -- init <dir> --kind skill|bot|connector [--name n] [--version 0.1.0]
//                                [--publisher-id id] [--publisher-name naam] [--license Apache-2.0] [--key <file>]
//   npm run pack:package -- validate <dir>
//   npm run pack:package -- sign <dir> --key <file> [--new-key]
//   npm run pack:package -- verify <dir|zip> [--trust <publieke sleutel>]...
//   npm run pack:package -- zip <dir> [--out <file>] [--allow-unsigned]
//   npm run pack:package -- catalog-entry <dir> [--id <id>]
//   (add --json for machine-readable output)
//
// The SDK (packages/teambot-sdk) and the security scan are the TypeScript sources the server itself uses;
// they are loaded through tsx (a dev dependency), so this works from a checkout after `npm install`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api');
register();
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const sdk = await load('packages/teambot-sdk/src/index.ts');
const { scanSkill } = await load('server/modules/skills/scan.ts');
const { filesFromDir, filesFromZip, stripTopFolder, checksumOf } = await load('server/modules/skills/files.ts');
const { parseSkillMd, slugify } = await load('server/modules/skills/format.ts');
const { APP_VERSION } = await load('server/core/config.ts');
const AdmZip = (await import('adm-zip')).default;

// ------------------------------------------------------------------ args

const argv = process.argv.slice(2);
const cmd = argv[0];
const positional = [];
const flags = {};
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const next = argv[i + 1];
    const value = next !== undefined && !next.startsWith('--') ? (i++, next) : true;
    if (k === 'trust') (flags.trust ||= []).push(value);
    else flags[k] = value;
  } else positional.push(a);
}
const JSON_OUT = flags.json === true;

class CliError extends Error {}
const fail = (msg) => {
  throw new CliError(msg);
};
const out = (text, data) => {
  if (JSON_OUT) process.stdout.write(JSON.stringify(data ?? { ok: true }, null, 2) + '\n');
  else process.stdout.write(text + '\n');
};
const need = (v, msg) => (v === undefined || v === true || v === '' ? fail(msg) : String(v));

// ------------------------------------------------------------------ helpers

const isInside = (child, parent) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** Is `p` (a file path) inside a package folder (any parent with teambot-package.json)? */
function insidePackage(p) {
  let d = path.dirname(path.resolve(p));
  for (;;) {
    if (fs.existsSync(path.join(d, sdk.MANIFEST_FILE))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

function readDir(dir) {
  const d = path.resolve(need(dir, 'Geef een pakketmap op.'));
  if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) fail(`Map niet gevonden: ${d}`);
  return { dir: d, files: filesFromDir(d) };
}

function readZipOrDir(p) {
  const full = path.resolve(need(p, 'Geef een pakketmap of zip-bestand op.'));
  if (!fs.existsSync(full)) fail(`Niet gevonden: ${full}`);
  if (fs.statSync(full).isDirectory()) return filesFromDir(full);
  return stripTopFolder(filesFromZip(fs.readFileSync(full)));
}

function manifestOf(files) {
  const m = sdk.readManifest(files);
  if (!m) fail(`Geen ${sdk.MANIFEST_FILE} gevonden. Maak er een met: teambot-pack init <map> --kind skill|bot|connector`);
  return m;
}

function writeManifest(dir, m) {
  fs.writeFileSync(path.join(dir, sdk.MANIFEST_FILE), JSON.stringify(m, null, 2) + '\n');
}

function readKey(file) {
  const k = path.resolve(need(file, 'Geef de privésleutel op met --key <bestand>.'));
  if (!fs.existsSync(k)) fail(`Sleutelbestand niet gevonden: ${k}`);
  return { path: k, pem: fs.readFileSync(k, 'utf8') };
}

const STATE_LABEL = {
  trusted: 'Ondertekend door een vertrouwde uitgever',
  untrusted: 'Ondertekend, onbekende uitgever',
  unsigned: 'Niet ondertekend',
  invalid: 'Handtekening ongeldig',
};

/** Kind-specific checks; returns { errors, warnings }. */
async function checkContent(kind, files, manifest) {
  const errors = [];
  const warnings = [];
  const main = sdk.MAIN_FILE[kind];
  const raw = files.get(main);
  if (!raw) return { errors: [`${main} ontbreekt.`], warnings };
  if (kind === 'skill') {
    const p = parseSkillMd(raw.toString('utf8'), { fallbackName: manifest?.name });
    errors.push(...p.errors.map((e) => `SKILL.md: ${e}`));
    warnings.push(...p.warnings.map((w) => `SKILL.md: ${w}`));
    if (manifest?.name && p.meta.name && p.meta.name !== manifest.name) warnings.push(`De pakketnaam (${manifest.name}) verschilt van de skillnaam in SKILL.md (${p.meta.name}).`);
  } else {
    let json;
    try {
      json = JSON.parse(raw.toString('utf8'));
    } catch {
      return { errors: [`${main} is geen geldige JSON.`], warnings };
    }
    if (kind === 'bot') {
      if (json.format !== 'teambot.bot-template/v1' && json.format !== 'teambot.agent/v1') errors.push('bot.json: het veld "format" moet "teambot.bot-template/v1" zijn.');
      if (!String(json.name || '').trim()) errors.push('bot.json: "name" ontbreekt.');
    } else {
      const { normalizeConnector } = await load('server/modules/mcp/package.ts');
      try {
        normalizeConnector(json, manifest?.publisher?.name || 'uitgever');
      } catch (e) {
        errors.push(e.message);
      }
    }
  }
  return { errors, warnings };
}

// ------------------------------------------------------------------ commands

async function keygen() {
  const file = path.resolve(flags.out && flags.out !== true ? String(flags.out) : path.join(os.homedir(), '.teambot', 'keys', 'publisher-key.pem'));
  const pkg = insidePackage(file);
  if (pkg) fail(`Een privésleutel hoort nooit in een pakketmap (${pkg}). Kies een plek buiten je pakketten, bijvoorbeeld ~/.teambot/keys/.`);
  if (fs.existsSync(file) && flags.force !== true) fail(`${file} bestaat al. Gebruik --force om te overschrijven (de oude sleutel is dan weg).`);
  const k = sdk.generateKeyPair();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, k.privateKeyPem, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows: ACLs of the user profile apply */
  }
  out(
    [
      `Privésleutel opgeslagen: ${file}`,
      'Bewaar dit bestand veilig en deel het nooit; het hoort niet in een pakket of repository.',
      `Publieke sleutel: ${k.publicKey}`,
      `Vingerafdruk:     ${k.fingerprint}`,
      'Geef gebruikers de publieke sleutel (en vingerafdruk) via een kanaal dat ze vertrouwen.',
    ].join('\n'),
    { ok: true, keyFile: file, publicKey: k.publicKey, fingerprint: k.fingerprint },
  );
}

async function init() {
  const dir = path.resolve(need(positional[0], 'Geef een map op: init <map> --kind skill|bot|connector'));
  const kind = need(flags.kind, 'Geef het soort pakket op met --kind skill|bot|connector.');
  if (!sdk.PACKAGE_KINDS.includes(kind)) fail('--kind moet skill, bot of connector zijn.');
  if (fs.existsSync(path.join(dir, sdk.MANIFEST_FILE)) && flags.force !== true) fail(`${sdk.MANIFEST_FILE} bestaat al in ${dir}. Gebruik --force om het te vervangen.`);
  fs.mkdirSync(dir, { recursive: true });
  const name = flags.name && flags.name !== true ? String(flags.name) : slugify(path.basename(dir)) || `mijn-${kind}`;
  const version = flags.version && flags.version !== true ? String(flags.version) : '0.1.0';
  const license = flags.license && flags.license !== true ? String(flags.license) : 'Apache-2.0';
  const main = path.join(dir, sdk.MAIN_FILE[kind]);
  if (!fs.existsSync(main)) {
    if (kind === 'skill')
      fs.writeFileSync(main, `---\nname: ${name}\ndescription: Beschrijf in één zin wat deze skill doet en wanneer een bot hem gebruikt.\nlicense: ${license}\nversion: ${version}\n---\n\n# ${name}\n\nSchrijf hier de instructies, stap voor stap.\n`);
    else if (kind === 'bot')
      fs.writeFileSync(
        main,
        JSON.stringify({ format: 'teambot.bot-template/v1', name, role: 'Assistent', description: 'Wat deze bot doet.', instructions: 'Schrijf hier de instructies van de bot.', avatar: '🤖', color: '#6366f1', access_mode: 'ask', tool_groups: [], skills: [], routines: [], meta: { template_version: version } }, null, 2) + '\n',
      );
    else
      fs.writeFileSync(
        main,
        JSON.stringify({ format: 'teambot.connector/v1', name, description: 'Wat deze connector doet.', category: 'eigen', transport: 'http', url: 'https://mcp.example.com/mcp', auth: 'none', dataFlow: 'Beschrijf welke gegevens naar welke dienst gaan.', source: 'https://example.com/broncode' }, null, 2) + '\n',
      );
  }
  const publicKey = flags.key && flags.key !== true ? sdk.publicKeyFromPrivateKey(readKey(flags.key).pem) : '';
  const files = filesFromDir(dir);
  const m = sdk.createManifest({
    name,
    version,
    kind,
    publisher: { id: flags['publisher-id'] && flags['publisher-id'] !== true ? String(flags['publisher-id']) : 'nl.voorbeeld', name: flags['publisher-name'] && flags['publisher-name'] !== true ? String(flags['publisher-name']) : 'Mijn naam', publicKey },
    license,
    files,
  });
  writeManifest(dir, m);
  out(`Pakket aangemaakt in ${dir} (${kind}). Pas ${sdk.MAIN_FILE[kind]} en ${sdk.MANIFEST_FILE} (publisher, teambot, requires) aan, en voer daarna uit:\n  teambot-pack validate ${dir}\n  teambot-pack sign ${dir} --key <privésleutel>`, { ok: true, dir, manifest: m });
}

async function validate() {
  const { dir, files } = readDir(positional[0]);
  const errors = [];
  const warnings = [];
  const m = manifestOf(files);
  errors.push(...sdk.validateManifest(m));
  const keys = sdk.findPrivateKeys(files);
  if (keys.length) errors.push(`Privésleutel gevonden in het pakket: ${keys.join(', ')}. Haal die er direct uit.`);
  if (!errors.length) {
    try {
      if (!sdk.satisfies(APP_VERSION, m.teambot)) errors.push(`Niet compatibel met deze TeamBot-versie (${APP_VERSION}): het pakket vraagt ${m.teambot}.`);
    } catch (e) {
      errors.push(e.message);
    }
    const actual = sdk.hashFiles(files);
    const listed = Object.keys(m.files || {});
    const stale = [...listed.filter((p) => actual[p] !== m.files[p]), ...Object.keys(actual).filter((p) => !listed.includes(p))];
    if (stale.length) (m.signature ? errors : warnings).push(`Bestanden wijken af van het manifest (${stale.join(', ')}). Voer "sign" opnieuw uit.`);
    if (m.signature) {
      const s = sdk.verifyManifestSignature(m);
      if (!s.ok) errors.push(s.error);
    } else warnings.push('Het pakket is nog niet ondertekend.');
    const c = await checkContent(m.kind, files, m);
    errors.push(...c.errors);
    warnings.push(...c.warnings);
  }
  const content = new Map([...files].filter(([p]) => p !== sdk.MANIFEST_FILE));
  const scan = scanSkill(content);
  const serious = scan.findings.filter((f) => f.severity === 'danger');
  if (serious.length) errors.push(`De veiligheidsscan vond ${serious.length} ernstige bevinding(en); TeamBot vraagt gebruikers die expliciet te bevestigen.`);
  for (const f of scan.findings.filter((x) => x.severity === 'warn')) warnings.push(`Scan: ${f.message}${f.file ? ` (${f.file}${f.line ? ':' + f.line : ''})` : ''}`);
  const lines = [`Pakket ${m.name || '?'} ${m.version || ''} (${m.kind || '?'}) in ${dir}`, `Scan: ${scan.level}${scan.labels.length ? ' — ' + scan.labels.join(', ') : ''}`];
  for (const f of serious) lines.push(`  ✖ ${f.message}${f.file ? ` (${f.file}${f.line ? ':' + f.line : ''})` : ''}`);
  for (const e of errors) lines.push(`✖ ${e}`);
  for (const w of warnings) lines.push(`! ${w}`);
  lines.push(errors.length ? 'Niet in orde.' : 'In orde.');
  out(lines.join('\n'), { ok: !errors.length, errors, warnings, scan: { level: scan.level, labels: scan.labels, findings: scan.findings } });
  if (errors.length) process.exitCode = 1;
}

async function sign() {
  const { dir, files } = readDir(positional[0]);
  const key = readKey(flags.key);
  if (isInside(key.path, dir)) fail('De privésleutel staat in de pakketmap. Verplaats hem naar een plek buiten het pakket; hij mag nooit mee in een pakket.');
  const keys = sdk.findPrivateKeys(files);
  if (keys.length) fail(`Privésleutel gevonden in het pakket: ${keys.join(', ')}. Niet ondertekend.`);
  const m = manifestOf(files);
  const next = { ...m, files: sdk.hashFiles(files) };
  if (flags['new-key'] === true) next.publisher = { ...next.publisher, publicKey: '' };
  const signed = sdk.signManifest(next, key.pem);
  try {
    if (!sdk.satisfies(APP_VERSION, signed.teambot)) process.stderr.write(`Let op: deze TeamBot (${APP_VERSION}) valt buiten het bereik ${signed.teambot}.\n`);
  } catch {
    /* validated by signManifest */
  }
  writeManifest(dir, signed);
  const fp = sdk.fingerprint(signed.publisher.publicKey);
  const count = Object.keys(signed.files).length;
  out(`Ondertekend: ${signed.name} ${signed.version} (${count === 1 ? '1 bestand' : `${count} bestanden`})\nVingerafdruk van de uitgever: ${fp}`, { ok: true, name: signed.name, version: signed.version, files: Object.keys(signed.files), publicKey: signed.publisher.publicKey, fingerprint: fp });
}

async function verify() {
  const files = readZipOrDir(positional[0]);
  const trusted = new Map();
  for (const t of flags.trust || []) {
    const v = String(t);
    const keyText = fs.existsSync(v) && fs.statSync(v).isFile() ? fs.readFileSync(v, 'utf8') : v;
    trusted.set(sdk.normalizePublicKey(keyText), 'opgegeven met --trust');
  }
  const v = sdk.verifyPackage(files, { appVersion: APP_VERSION, trusted });
  const ok = (v.state === 'trusted' || v.state === 'untrusted') && v.compatible;
  const lines = [`${STATE_LABEL[v.state]}${v.manifest ? `: ${v.manifest.name} ${v.manifest.version} (${v.manifest.kind})` : ''}`];
  if (v.publisher) lines.push(`Uitgever (zoals opgegeven): ${v.publisher.name} [${v.publisher.id}]`, `Vingerafdruk: ${v.publisher.fingerprint}`);
  for (const e of v.errors) lines.push(`✖ ${e}`);
  for (const e of v.incompatible) lines.push(`✖ Niet compatibel: ${e}`);
  for (const w of v.warnings) lines.push(`! ${w}`);
  lines.push(ok ? 'Handtekening en bestanden in orde.' : 'Niet in orde.');
  out(lines.join('\n'), { ok, state: v.state, compatible: v.compatible, publisher: v.publisher, manifest: v.manifest ? { name: v.manifest.name, version: v.manifest.version, kind: v.manifest.kind } : null, errors: v.errors, incompatible: v.incompatible, warnings: v.warnings });
  if (!ok) process.exitCode = 1;
}

async function zip() {
  const { dir, files } = readDir(positional[0]);
  const keys = sdk.findPrivateKeys(files);
  if (keys.length) fail(`Privésleutel gevonden in het pakket: ${keys.join(', ')}. Geen zip gemaakt.`);
  const m = manifestOf(files);
  const v = sdk.verifyPackage(files, { appVersion: APP_VERSION });
  if (v.state === 'invalid') fail(`Het pakket is niet in orde: ${v.errors.join(' ')}`);
  if (v.state === 'unsigned' && flags['allow-unsigned'] !== true) fail('Het pakket is niet ondertekend. Voer eerst "sign" uit (of gebruik --allow-unsigned).');
  const file = path.resolve(flags.out && flags.out !== true ? String(flags.out) : path.join(path.dirname(dir), `${m.name}-${m.version}.zip`));
  if (isInside(file, dir)) fail('Schrijf de zip buiten de pakketmap (anders zit hij bij de volgende keer in het pakket).');
  const z = new AdmZip();
  for (const [p, b] of [...files.entries()].sort((a, b) => a[0].localeCompare(b[0]))) z.addFile(`${m.name}/${p}`, b);
  const buf = z.toBuffer();
  fs.writeFileSync(file, buf);
  out(`Zip gemaakt: ${file}\nsha256: ${sdk.sha256Hex(buf)}`, { ok: true, file, sha256: sdk.sha256Hex(buf), files: [...files.keys()].sort() });
}

async function catalogEntry() {
  const { files } = readDir(positional[0]);
  const m = manifestOf(files);
  if (sdk.findPrivateKeys(files).length) fail('Privésleutel gevonden in het pakket.');
  const inline = sdk.filesToInline(files);
  const id = flags.id && flags.id !== true ? String(flags.id) : m.name;
  let entry;
  if (m.kind === 'skill') {
    const content = new Map([...files].filter(([p]) => p !== sdk.MANIFEST_FILE));
    entry = { id, name: m.name, title: m.name, description: m.description || '', version: m.version, license: m.license, publisher: m.publisher.name, files: inline.files, sha256: checksumOf(content), manifest: inline.manifest };
  } else entry = { id, title: m.name, description: m.description || '', version: m.version, license: m.license, publisher: m.publisher.name, manifest: inline.manifest, files: inline.files };
  const section = m.kind === 'skill' ? 'skills' : m.kind === 'bot' ? 'bots' : 'connectors';
  if (JSON_OUT) out('', { ok: true, section, entry });
  else out(`// Voeg dit item toe aan de lijst "${section}" van je teambot.catalog/v1-index:\n${JSON.stringify(entry, null, 2)}`);
}

const COMMANDS = { keygen, init, validate, sign, verify, zip, 'catalog-entry': catalogEntry };

if (!cmd || cmd === 'help' || cmd === '--help' || !COMMANDS[cmd]) {
  process.stdout.write(
    [
      'teambot-pack — TeamBot-pakketten maken, ondertekenen en controleren',
      '',
      '  keygen [--out <bestand>] [--force]        Ed25519-sleutelpaar maken (privésleutel blijft bij jou)',
      '  init <map> --kind skill|bot|connector      Pakketmap met teambot-package.json opzetten',
      '  validate <map>                             Manifest, compatibiliteit en veiligheidsscan controleren',
      '  sign <map> --key <bestand> [--new-key]     Bestanden hashen en het manifest ondertekenen',
      '  verify <map|zip> [--trust <sleutel>]       Handtekening, bestanden en compatibiliteit controleren',
      '  zip <map> [--out <bestand>]                Ondertekend pakket als zip (zonder privésleutel)',
      '  catalog-entry <map> [--id <id>]            JSON voor een teambot.catalog/v1-index',
      '',
      'Voeg --json toe voor uitvoer als JSON. Zie docs/SDK.md.',
    ].join('\n') + '\n',
  );
  process.exitCode = cmd && cmd !== 'help' && cmd !== '--help' ? 1 : 0;
} else {
  try {
    await COMMANDS[cmd]();
  } catch (e) {
    const msg = e instanceof CliError || e?.message ? e.message : String(e);
    if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: false, error: msg }, null, 2) + '\n');
    else process.stderr.write(`Fout: ${msg}\n`);
    process.exitCode = 1;
  }
}
