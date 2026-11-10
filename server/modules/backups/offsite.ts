import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Writable } from 'node:stream';
import zlib from 'node:zlib';
import type { Ctx } from '../../core/types.js';
import { bad } from '../../core/http.js';
import { NAME, type BackupItem, type BackupService } from './service.js';

/**
 * A second place for backups (a USB drive, a NAS or a synced folder), encrypted: own code on Node's crypto, no new
 * dependency.
 *
 * One backup set (database, manifest, team databases, data files) becomes one file `<name>.teambotbackup`:
 *   "TEAMBOTBK" 0x01 | u32 header length | header JSON | AES-256-GCM( gzip( entries ) ) | 16-byte GCM tag
 * - The key is derived from the owner's password with scrypt (N=2^17, r=8, p=1, 16-byte random salt per file), the
 *   IV is random per file, and the header is authenticated as AAD: a changed header, a wrong password or a damaged
 *   file all fail the tag check, and nothing is put in place before that check passed.
 * - Entries: u16 path length | path (utf8, "/" separated, relative to the set) | u64 size | bytes.
 * - The password is kept in TeamBot's encrypted secrets (for the automatic copy after each backup), never in the
 *   file, a log or an answer. Without it the file cannot be opened: TeamBot cannot recover a forgotten password.
 */

const MAGIC = Buffer.from('TEAMBOTBK\x01', 'latin1');
export const EXT = '.teambotbackup';
const FILE = /^teambot-\d{8}-\d{6}(-[a-z]+)?\.teambotbackup$/;
export const MIN_PASSWORD = 12;
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const SECRET = 'backups.offsite.password';
/** Copies kept in the second place (oldest go first); never fewer than three. */
const MIN_KEEP = 3;

export interface OffsiteSettings {
  folder: string;
  /** After every backup (daily or made by hand) also a copy in the folder. */
  auto: boolean;
}
export interface OffsiteState {
  lastCopy: { at: string; file: string; bytes: number; backup: string } | null;
  lastError: { at: string; message: string } | null;
}
export interface OffsiteFile {
  file: string;
  name: string;
  createdAt: string | null;
  version: string | null;
  kind: string | null;
  bytes: number;
}

interface Header {
  v: 1;
  app: 'TeamBot';
  name: string;
  createdAt: string;
  version: string;
  kdf: { alg: 'scrypt'; N: number; r: number; p: number; salt: string };
  iv: string;
}

function deriveKey(password: string, salt: Buffer, k = SCRYPT): Promise<Buffer> {
  return new Promise((resolve, reject) => crypto.scrypt(password.normalize('NFC'), salt, 32, k, (e, key) => (e ? reject(e) : resolve(key))));
}

/** Every file of a backup set (relative paths with "/"), the .db first. */
function setFiles(dir: string, name: string): { rel: string; abs: string; size: number }[] {
  const base = name.replace(/\.db$/, '');
  const out: { rel: string; abs: string; size: number }[] = [];
  const add = (rel: string) => {
    const abs = path.join(dir, rel);
    const st = fs.statSync(abs, { throwIfNoEntry: false });
    if (!st) return;
    if (st.isFile()) out.push({ rel: rel.split(path.sep).join('/'), abs, size: st.size });
    else if (st.isDirectory()) for (const e of fs.readdirSync(abs)) add(path.join(rel, e));
  };
  for (const p of [`${base}.db`, `${base}.json`, `${base}.teamdata`, `${base}.files`]) add(p);
  return out;
}

/** Write the encrypted file of one backup set (to `<dest>.partial`, renamed when complete). */
export async function writeEncrypted(dir: string, name: string, dest: string, password: string, meta: { version: string; createdAt: string }): Promise<number> {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const header: Header = { v: 1, app: 'TeamBot', name, createdAt: meta.createdAt, version: meta.version, kdf: { alg: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64') }, iv: iv.toString('base64') };
  const hjson = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(hjson.length);
  const prefix = Buffer.concat([MAGIC, len, hjson]);
  const key = await deriveKey(password, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(prefix);
  const files = setFiles(dir, name);
  async function* entries() {
    for (const f of files) {
      const p = Buffer.from(f.rel, 'utf8');
      const h = Buffer.alloc(2 + p.length + 8);
      h.writeUInt16BE(p.length, 0);
      p.copy(h, 2);
      h.writeBigUInt64BE(BigInt(f.size), 2 + p.length);
      yield h;
      let n = 0;
      for await (const chunk of fs.createReadStream(f.abs)) {
        n += (chunk as Buffer).length;
        if (n > f.size) throw new Error(`${f.rel} veranderde tijdens het kopiëren`);
        yield chunk as Buffer;
      }
      if (n !== f.size) throw new Error(`${f.rel} veranderde tijdens het kopiëren`);
    }
  }
  const partial = `${dest}.partial`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(partial);
  try {
    out.write(prefix);
    await pipeline(Readable.from(entries()), zlib.createGzip({ level: 6 }), cipher, out, { end: false });
    await new Promise<void>((res, rej) => out.end(cipher.getAuthTag(), (e?: Error | null) => (e ? rej(e) : res())));
    fs.renameSync(partial, dest);
  } catch (e) {
    out.destroy();
    fs.rmSync(partial, { force: true });
    throw e;
  }
  return fs.statSync(dest).size;
}

/** The header of an encrypted backup file (readable without the password; it says what the file is). */
export function readHeader(file: string): { header: Header; prefix: Buffer } {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(MAGIC.length + 4);
    if (fs.readSync(fd, head, 0, head.length, 0) !== head.length || !head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Dit is geen versleutelde back-up van TeamBot.');
    const n = head.readUInt32BE(MAGIC.length);
    if (n > 64 * 1024) throw new Error('Dit is geen versleutelde back-up van TeamBot.');
    const h = Buffer.alloc(n);
    fs.readSync(fd, h, 0, n, head.length);
    const header = JSON.parse(h.toString('utf8')) as Header;
    if (header.v !== 1 || header.app !== 'TeamBot' || !NAME.test(header.name) || header.kdf?.alg !== 'scrypt') throw new Error('Deze versleutelde back-up komt van een onbekende versie.');
    return { header, prefix: Buffer.concat([head, h]) };
  } finally {
    fs.closeSync(fd);
  }
}

const WRONG = 'Het wachtwoord klopt niet, of het bestand is beschadigd. Er is niets veranderd.';

/**
 * Decrypt a backup file into `dir` as a normal backup set. Everything is written to a temporary folder first and only
 * moved into place after the tag check passed (a wrong password or a changed byte leaves nothing behind).
 */
export async function readEncrypted(file: string, password: string, dir: string): Promise<string> {
  const { header, prefix } = readHeader(file);
  const size = fs.statSync(file).size;
  if (size < prefix.length + 16) throw new Error(WRONG);
  const tag = Buffer.alloc(16);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, tag, 0, 16, size - 16);
  } finally {
    fs.closeSync(fd);
  }
  const k = header.kdf;
  if (![2 ** 14, 2 ** 15, 2 ** 16, 2 ** 17, 2 ** 18].includes(k.N) || k.r !== 8 || k.p !== 1) throw new Error('Deze versleutelde back-up komt van een onbekende versie.');
  const key = await deriveKey(password, Buffer.from(k.salt, 'base64'), { ...SCRYPT, N: k.N });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'));
  decipher.setAAD(prefix);
  decipher.setAuthTag(tag);
  const tmp = fs.mkdtempSync(path.join(dir, '.import-'));
  // Parse the entry stream: files are written into the temporary folder, never outside it.
  let buf: Buffer = Buffer.alloc(0);
  let cur: { out: fs.WriteStream; left: bigint } | null = null;
  const open = (rel: string, size: bigint) => {
    if (!rel || rel.includes('\\') || rel.split('/').some((p) => p === '' || p === '.' || p === '..') || path.isAbsolute(rel)) throw new Error(WRONG);
    const base = header.name.replace(/\.db$/, '');
    if (!rel.startsWith(`${base}.`)) throw new Error(WRONG);
    const abs = path.join(tmp, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    cur = { out: fs.createWriteStream(abs), left: size };
  };
  const writeTo = (s: fs.WriteStream, b: Buffer) => new Promise<void>((res, rej) => s.write(b, (e) => (e ? rej(e) : res())));
  const sink = new Writable({
    async write(chunk: Buffer, _enc, cb) {
      try {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        for (;;) {
          if (cur) {
            const c: { out: fs.WriteStream; left: bigint } = cur;
            const n = Number(c.left < BigInt(buf.length) ? c.left : BigInt(buf.length));
            if (n) await writeTo(c.out, buf.subarray(0, n));
            buf = buf.subarray(n);
            c.left -= BigInt(n);
            if (c.left === 0n) {
              await new Promise<void>((res) => c.out.end(res));
              cur = null;
              continue;
            }
            break;
          }
          if (buf.length < 2) break;
          const pl = buf.readUInt16BE(0);
          if (buf.length < 2 + pl + 8) break;
          const rel = buf.subarray(2, 2 + pl).toString('utf8');
          const sz = buf.readBigUInt64BE(2 + pl);
          buf = buf.subarray(2 + pl + 8);
          open(rel, sz);
          if (sz === 0n) {
            const c: { out: fs.WriteStream } = cur!;
            await new Promise<void>((res) => c.out.end(res));
            cur = null;
          }
        }
        cb();
      } catch (e: any) {
        cb(e);
      }
    },
  });
  try {
    await pipeline(fs.createReadStream(file, { start: prefix.length, end: size - 17 }), decipher, zlib.createGunzip(), sink);
    if (cur || buf.length) throw new Error(WRONG);
    const db = path.join(tmp, header.name);
    if (!fs.existsSync(db)) throw new Error(WRONG);
    // Checked: move the set into the backups folder (the .db last, so the listing only sees a complete set).
    for (const e of fs.readdirSync(tmp)) {
      if (e === header.name) continue;
      fs.rmSync(path.join(dir, e), { recursive: true, force: true });
      fs.renameSync(path.join(tmp, e), path.join(dir, e));
    }
    fs.renameSync(db, path.join(dir, header.name));
    return header.name;
  } catch (e: any) {
    const c = cur as { out: fs.WriteStream } | null;
    c?.out.destroy();
    const msg = String(e?.message || e);
    throw new Error(/unable to authenticate|bad decrypt|incorrect header|unexpected end|invalid|Unsupported state/i.test(msg) || msg === WRONG ? WRONG : `De back-up kon niet worden geopend: ${msg.slice(0, 200)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** The second place of one installation: settings, password (in secrets), copies and import. */
export class Offsite {
  private running: Promise<any> | null = null;

  constructor(
    private ctx: Ctx,
    private svc: BackupService,
  ) {}

  private file() {
    return path.join(this.svc.dir(), 'offsite.json');
  }

  private read(): OffsiteSettings & OffsiteState {
    try {
      const j = JSON.parse(fs.readFileSync(this.file(), 'utf8'));
      return { folder: typeof j.folder === 'string' ? j.folder : '', auto: j.auto !== false, lastCopy: j.lastCopy || null, lastError: j.lastError || null };
    } catch {
      return { folder: '', auto: true, lastCopy: null, lastError: null };
    }
  }

  private write(patch: Partial<OffsiteSettings & OffsiteState>) {
    fs.writeFileSync(this.file(), JSON.stringify({ ...this.read(), ...patch }, null, 1));
  }

  private ownerId(): string | null {
    return this.ctx.auth.owner()?.id ?? null;
  }

  private password(): string | null {
    const o = this.ownerId();
    return o ? this.ctx.secrets.getByName(o, SECRET) : null;
  }

  /** The folder copies go to: `<chosen folder>/TeamBot-backups`. */
  target(folder = this.read().folder): string {
    return path.join(folder, 'TeamBot-backups');
  }

  view() {
    const s = this.read();
    let reachable = false;
    try {
      reachable = !!s.folder && fs.statSync(s.folder).isDirectory();
    } catch {
      reachable = false;
    }
    return { folder: s.folder, auto: s.auto, hasPassword: !!this.password(), reachable, lastCopy: s.lastCopy, lastError: s.lastError, busy: !!this.running, files: reachable ? this.list() : [] };
  }

  /** Check a folder the owner typed: absolute, there, writable, and not inside TeamBot's own data folder. */
  checkFolder(raw: string): string {
    const f = String(raw || '').trim();
    if (!f) throw bad('Kies een map, bijvoorbeeld op een USB-schijf.');
    if (!path.isAbsolute(f)) throw bad('Geef het volledige pad van de map, bijvoorbeeld E:\\Back-ups.');
    const abs = path.resolve(f);
    let st: fs.Stats | undefined;
    try {
      st = fs.statSync(abs);
    } catch {
      st = undefined;
    }
    if (!st?.isDirectory()) throw bad('Deze map bestaat niet (of de schijf is niet aangesloten).');
    const data = path.resolve(this.ctx.config.dataDir);
    const rel = path.relative(data, abs);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw bad('Kies een plek buiten de map van TeamBot zelf: een tweede plek helpt alleen als die ergens anders is, het liefst op een andere schijf.');
    try {
      fs.mkdirSync(this.target(abs), { recursive: true });
      const probe = path.join(this.target(abs), `.schrijftest-${process.pid}`);
      fs.writeFileSync(probe, 'ok');
      fs.rmSync(probe, { force: true });
    } catch {
      throw bad('TeamBot kan niet in deze map schrijven.');
    }
    return abs;
  }

  save(o: { folder?: string; auto?: boolean; password?: string }) {
    const patch: Partial<OffsiteSettings> = {};
    if (o.folder !== undefined) patch.folder = this.checkFolder(o.folder);
    if (typeof o.auto === 'boolean') patch.auto = o.auto;
    if (o.password !== undefined) {
      const p = String(o.password);
      if (p.length < MIN_PASSWORD) throw bad(`Kies een wachtwoord van minstens ${MIN_PASSWORD} tekens.`);
      const owner = this.ownerId();
      if (!owner) throw bad('Er is nog geen eigenaar.');
      this.ctx.secrets.set(owner, SECRET, p);
    }
    this.write(patch);
    return this.view();
  }

  /** Stop using the second place (copies already there stay; the password is removed from TeamBot). */
  clear() {
    const owner = this.ownerId();
    const row = owner ? this.ctx.secrets.list(owner).find((s) => s.name === SECRET) : null;
    if (row) this.ctx.secrets.delete(row.id);
    this.write({ folder: '', lastError: null });
    return this.view();
  }

  /** Encrypted copies in the folder, newest first (read from their headers). */
  list(): OffsiteFile[] {
    const dir = this.target();
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((f) => FILE.test(f));
    } catch {
      return [];
    }
    return names
      .map((f) => {
        const abs = path.join(dir, f);
        try {
          const { header } = readHeader(abs);
          return { file: f, name: header.name, createdAt: header.createdAt, version: header.version, kind: header.name.match(/-([a-z]+)\.db$/)?.[1] || 'manual', bytes: fs.statSync(abs).size };
        } catch {
          return { file: f, name: '', createdAt: null, version: null, kind: null, bytes: 0 };
        }
      })
      .sort((a, b) => b.file.localeCompare(a.file));
  }

  /** Copy one backup set (default: the newest) to the second place, encrypted. One at a time. */
  async copy(name?: string): Promise<{ file: string; bytes: number; backup: string }> {
    if (this.running) await this.running.catch(() => {});
    const p = this.doCopy(name);
    this.running = p;
    try {
      return await p;
    } finally {
      if (this.running === p) this.running = null;
    }
  }

  private async doCopy(name?: string) {
    const s = this.read();
    try {
      if (!s.folder) throw bad('Kies eerst een map voor de tweede plek.');
      const password = this.password();
      if (!password) throw bad('Stel eerst een wachtwoord in voor de versleutelde kopie.');
      if (!fs.existsSync(s.folder)) throw bad(`De map ${s.folder} is niet bereikbaar. Is de schijf aangesloten?`);
      const items = this.svc.list();
      const b: BackupItem | undefined = name ? items.find((x) => x.name === name) : items.find((x) => x.kind !== 'replaced');
      if (!b) throw bad('Er is nog geen back-up om te kopiëren. Maak eerst een back-up.');
      const fileName = b.name.replace(/\.db$/, EXT);
      const dest = path.join(this.target(s.folder), fileName);
      const bytes = await writeEncrypted(this.svc.dir(), b.name, dest, password, { version: b.version || this.ctx.config.version, createdAt: b.createdAt });
      this.prune();
      const lastCopy = { at: new Date().toISOString(), file: fileName, bytes, backup: b.name };
      this.write({ lastCopy, lastError: null });
      return { file: fileName, bytes, backup: b.name };
    } catch (e: any) {
      this.write({ lastError: { at: new Date().toISOString(), message: String(e?.message || e).slice(0, 300) } });
      throw e;
    }
  }

  /** Keep as many copies as the automatic backups keep (at least three); older ones go. */
  private prune() {
    const keep = Math.max(MIN_KEEP, this.svc.settings().keep);
    for (const f of this.list().slice(keep)) fs.rmSync(path.join(this.target(), f.file), { force: true });
  }

  /** After a backup was made: also the encrypted copy, when the owner turned that on. Never throws. */
  async afterBackup(b: BackupItem) {
    const s = this.read();
    if (!s.auto || !s.folder || b.kind === 'update' || b.kind === 'replaced' || !this.password()) return;
    try {
      const r = await this.copy(b.name);
      this.ctx.log.info(`[backups] versleutelde kopie op de tweede plek: ${r.file}`);
    } catch (e: any) {
      this.ctx.log.warn('[backups] kopie naar de tweede plek mislukt', String(e?.message || e));
    }
  }

  /**
   * Take an encrypted copy back into this TeamBot's backups (then it is restored like any other backup). `file`: a
   * name from the list, or a full path to a .teambotbackup file elsewhere.
   */
  async importFile(file: string, password: string): Promise<BackupItem> {
    const f = String(file || '');
    const abs = path.isAbsolute(f) ? path.resolve(f) : path.join(this.target(), path.basename(f));
    if (!abs.endsWith(EXT) || !fs.existsSync(abs)) throw bad('Dit bestand is niet gevonden.');
    let header: Header;
    try {
      header = readHeader(abs).header;
    } catch (e: any) {
      throw bad(e?.message || String(e));
    }
    if (this.svc.exists(header.name)) {
      const have = this.svc.list().find((x) => x.name === header.name);
      if (have) return have;
    }
    try {
      await readEncrypted(abs, String(password || ''), this.svc.dir());
    } catch (e: any) {
      throw bad(e?.message || String(e));
    }
    const item = this.svc.list().find((x) => x.name === header.name);
    if (!item) throw bad(WRONG);
    return item;
  }
}

