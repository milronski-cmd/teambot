/**
 * Master key at rest for the desktop app (SEC-07). The 32-byte key that encrypts all stored secrets is wrapped by an
 * OS protector: Windows DPAPI, the macOS Keychain or the Linux secret service (via Electron safeStorage). Rules:
 *  - never lock the user out: an unreadable wrapped key is kept aside for recovery and TeamBot continues with a new
 *    key (the user re-enters API keys) and a clear warning;
 *  - an existing plain `master.key` (0600) is migrated once and only deleted after a verified round-trip;
 *  - without a usable protector the plain 0600 file stays (no worse than before), and the reason is reported.
 * No Electron import here, so the logic is unit-tested with a fake protector. A protector may answer asynchronously:
 * DPAPI runs in a separate PowerShell, and the desktop app keeps its start window responsive meanwhile.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface KeyProtector {
  /** Short name for messages and the file suffix, e.g. "dpapi", "keychain", "secret-service". */
  name: string;
  protect(data: Buffer): Buffer | Promise<Buffer>;
  unprotect(data: Buffer): Buffer | Promise<Buffer>;
}

export interface KeyResult {
  /** The key to use, or undefined to let the server use its own plain key file. */
  key?: Buffer;
  /** Where the key lives now, for diagnostics. */
  storage: 'protected' | 'plain-file' | 'env';
  warning?: string;
}

export async function loadProtectedKey(dataDir: string, protector: KeyProtector | null, env: NodeJS.ProcessEnv = process.env): Promise<KeyResult> {
  if (env.TEAMBOT_MASTER_KEY) return { storage: 'env' };
  if (!protector) return { storage: 'plain-file' };
  const enc = path.join(dataDir, `master.key.${protector.name}`);
  const plain = path.join(dataDir, 'master.key');
  let warning: string | undefined;
  if (fs.existsSync(enc)) {
    try {
      const key = await protector.unprotect(fs.readFileSync(enc));
      if (key.length === 32) return { key, storage: 'protected' };
      throw new Error('onverwachte sleutellengte');
    } catch (e: any) {
      const broken = `${enc}.onleesbaar-${Date.now()}`;
      fs.renameSync(enc, broken);
      warning = `De beveiligde sleutel kon niet worden geopend (${e?.message || e}). Opgeslagen API-sleutels en wachtwoorden moet je opnieuw invoeren. Het oude sleutelbestand is bewaard als ${path.basename(broken)}.`;
    }
  }
  const key = fs.existsSync(plain) ? Buffer.from(fs.readFileSync(plain, 'utf8').trim(), 'base64') : crypto.randomBytes(32);
  if (key.length !== 32) return { storage: 'plain-file', warning };
  try {
    const blob = await protector.protect(key);
    if (!(await protector.unprotect(blob)).equals(key)) return { storage: 'plain-file', warning };
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(enc, blob, { mode: 0o600 });
    fs.rmSync(plain, { force: true });
    return { key, storage: 'protected', warning };
  } catch {
    // Protector unavailable right now: keep using (or create) the plain 0600 key file.
    return { storage: 'plain-file', warning };
  }
}

/** Linux safeStorage backends that really use an OS secret store (not the hard-coded "basic_text" fallback). */
export function linuxBackendIsSecure(backend: string | undefined): boolean {
  return !!backend && /^(gnome_libsecret|kwallet\d*)$/.test(backend);
}
