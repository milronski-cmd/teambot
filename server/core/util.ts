/** Small helpers every part of the server needs; one copy of each. */
import crypto from 'node:crypto';
import fs from 'node:fs';

/** SHA-256 of a text or bytes, as hex. */
export const sha256 = (data: string | Buffer): string => crypto.createHash('sha256').update(data).digest('hex');

/** A random secret for links, tokens and codes (URL-safe). */
export const randomToken = (bytes = 32): string => crypto.randomBytes(bytes).toString('base64url');

/** Is there a file at this path (false for a folder, a missing path or one that cannot be read)? */
export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Is there a folder at this path? */
export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
