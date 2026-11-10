import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';

const MAGIC = Buffer.from('TBWA1');
/** What WhatsApp Web needs to restore a linked session (the same set whatsapp-web.js' RemoteAuth keeps). */
const KEEP = ['IndexedDB', 'Local Storage'];
const MAX_ARCHIVE = 512 * 1024 * 1024;

export function encryptBlob(key: Buffer, plain: Buffer): Buffer {
  if (key.length !== 32) throw new Error('Sessiesleutel moet 32 bytes zijn');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(MAGIC);
  const enc = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), enc]);
}

export function decryptBlob(key: Buffer, blob: Buffer): Buffer {
  if (blob.length < MAGIC.length + 28 || !blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Onbekend sessieformaat');
  const iv = blob.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = blob.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(MAGIC);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(blob.subarray(MAGIC.length + 28)), d.final()]);
}

function rm(p: string) {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* best effort: a browser that is still closing can hold a file for a moment */
  }
}

/**
 * The WhatsApp session of one binding on disk:
 *  - `profile/`    working browser profile, plaintext, only while the connection runs (Chromium needs it);
 *  - `session.enc` AES-256-GCM archive of the parts that keep the device linked, key in the TeamBot vault.
 * After a clean stop only the encrypted archive is left. After a crash the newer plaintext profile is reused once
 * and re-encrypted, so no session state is lost.
 */
export class SessionStore {
  readonly profileDir: string;
  readonly file: string;
  constructor(readonly dir: string, private key: Buffer) {
    this.profileDir = path.join(dir, 'profile');
    this.file = path.join(dir, 'session.enc');
  }

  hasBackup() {
    return fs.existsSync(this.file);
  }
  hasProfile() {
    return fs.existsSync(path.join(this.profileDir, 'Default'));
  }

  /** Prepare the working profile. Returns where the session came from. */
  restore(): 'profile' | 'backup' | 'none' | 'unreadable' {
    fs.mkdirSync(this.dir, { recursive: true });
    if (this.hasProfile()) return 'profile';
    rm(this.profileDir);
    fs.mkdirSync(this.profileDir, { recursive: true });
    if (!this.hasBackup()) return 'none';
    let zip: AdmZip;
    try {
      zip = new AdmZip(decryptBlob(this.key, fs.readFileSync(this.file)));
    } catch {
      return 'unreadable';
    }
    const root = path.resolve(this.profileDir);
    for (const e of zip.getEntries()) {
      if (e.isDirectory) continue;
      const dest = path.resolve(root, e.entryName);
      if (dest !== root && !dest.startsWith(root + path.sep)) continue; // zip-slip guard
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, e.getData());
    }
    return 'backup';
  }

  /** Encrypt the session parts of the working profile into session.enc (atomic). Returns the archive size. */
  backup(): number {
    const base = path.join(this.profileDir, 'Default');
    if (!fs.existsSync(base)) return 0;
    const zip = new AdmZip();
    let files = 0;
    let total = 0;
    const walk = (dir: string, rel: string) => {
      let list: fs.Dirent[];
      try {
        list = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of list) {
        const full = path.join(dir, d.name);
        const r = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) walk(full, r);
        else if (d.isFile() && d.name !== 'LOCK') {
          try {
            const buf = fs.readFileSync(full);
            total += buf.length;
            if (total > MAX_ARCHIVE) throw new Error('Sessie te groot om te bewaren');
            zip.addFile(`Default/${r}`, buf);
            files++;
          } catch (e: any) {
            if (/te groot/.test(String(e?.message))) throw e;
            /* file held open by the running browser: the next backup picks it up */
          }
        }
      }
    };
    for (const k of KEEP) if (fs.existsSync(path.join(base, k))) walk(path.join(base, k), k);
    if (!files) return 0;
    const blob = encryptBlob(this.key, zip.toBuffer());
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, blob, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return blob.length;
  }

  wipeProfile() {
    rm(this.profileDir);
  }

  wipeAll() {
    rm(this.profileDir);
    rm(this.file);
  }
}
