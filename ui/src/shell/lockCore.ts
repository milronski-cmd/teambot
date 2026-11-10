/**
 * App lock for this device (A-91): a PIN and/or the device's own fingerprint/face unlock (WebAuthn platform
 * authenticator). Everything stays on this device, and only what is needed to check an unlock is stored:
 *  - the PIN as a salted PBKDF2-SHA-256 hash (never the PIN itself),
 *  - the id of the WebAuthn credential (the key itself never leaves the phone's secure hardware),
 *  - the lock delay, and the number of wrong tries (so reloading does not skip the back-off).
 * The lock keeps people who pick up the phone out; it is not a replacement for the phone's own screen lock, and
 * unlocking never approves anything by itself. Pure helpers are unit-tested in tests/app-lock.test.ts.
 */

export const LOCK_KEY = 'tb_applock';
const FAIL_KEY = 'tb_applock_fails';
export const PIN_MIN = 4;
export const PIN_MAX = 8;
const ITERATIONS = 150_000;
/** Wrong tries before a pause, and the pause (doubles after every further wrong try, at most 5 minutes). */
export const FREE_TRIES = 5;
const PAUSE_MS = 30_000;
const PAUSE_MAX_MS = 5 * 60_000;

export interface LockConfig {
  v: 1;
  pin?: { salt: string; hash: string; iterations: number; length: number };
  bio?: { credId: string; created: string };
  /** Minutes the app may be in the background before it locks again; 0 = as soon as you leave it. */
  after: number;
}

export interface FailState {
  fails: number;
  /** Epoch ms until which no new try is accepted. */
  until: number;
}

export const DELAYS: { value: number; label: string }[] = [
  { value: 0, label: 'Meteen als je de app verlaat' },
  { value: 1, label: 'Na 1 minuut' },
  { value: 5, label: 'Na 5 minuten' },
  { value: 15, label: 'Na 15 minuten' },
];

// ------------------------------------------------------------------ storage (localStorage can be blocked)

function read<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}
function write(key: string, v: unknown) {
  try {
    if (v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* private mode: the lock simply is not kept */
  }
}

export function loadLock(): LockConfig | null {
  const c = read<LockConfig>(LOCK_KEY);
  return c && c.v === 1 && (c.pin || c.bio) ? c : null;
}
export function saveLock(c: LockConfig | null) {
  write(LOCK_KEY, c && (c.pin || c.bio) ? c : null);
  if (!c) write(FAIL_KEY, null);
}
export function loadFails(): FailState {
  return read<FailState>(FAIL_KEY) || { fails: 0, until: 0 };
}
export function saveFails(s: FailState) {
  write(FAIL_KEY, s.fails ? s : null);
}

// ------------------------------------------------------------------ pure rules

export function validPin(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_MIN},${PIN_MAX}}$`).test(pin);
}

/** Lock again after the app was in the background for at least `afterMin` minutes (0 = any time it was hidden). */
export function shouldLockAfterHidden(afterMin: number, hiddenAt: number | null, now: number): boolean {
  if (hiddenAt === null) return false;
  return now - hiddenAt >= Math.max(0, afterMin) * 60_000;
}

/** After a wrong PIN: count it; from the FREE_TRIES-th wrong try on, wait (30 s, 60 s, … at most 5 min). */
export function registerFailure(s: FailState, now: number): FailState {
  const fails = s.fails + 1;
  const until = fails >= FREE_TRIES ? now + Math.min(PAUSE_MAX_MS, PAUSE_MS * 2 ** (fails - FREE_TRIES)) : 0;
  return { fails, until };
}

/** Milliseconds to wait before the next try (0 = you may try now). */
export function waitMs(s: FailState, now: number): number {
  return Math.max(0, s.until - now);
}

/** Wrong tries left before the first pause (0 when a pause applies). */
export function triesLeft(s: FailState): number {
  return Math.max(0, FREE_TRIES - s.fails);
}

// ------------------------------------------------------------------ PIN hash (WebCrypto PBKDF2-SHA-256)

export const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))));
export const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(pin: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength) as ArrayBuffer, iterations }, key, 256);
  return b64(bits);
}

export async function hashPin(pin: string, iterations = ITERATIONS): Promise<NonNullable<LockConfig['pin']>> {
  if (!validPin(pin)) throw new Error(`Kies ${PIN_MIN} tot ${PIN_MAX} cijfers.`);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: b64(salt), hash: await derive(pin, salt, iterations), iterations, length: pin.length };
}

export async function verifyPin(pin: string, p: NonNullable<LockConfig['pin']>): Promise<boolean> {
  if (!validPin(pin)) return false;
  const got = await derive(pin, unb64(p.salt), p.iterations);
  // Same length strings; compare every character.
  let diff = got.length ^ p.hash.length;
  for (let i = 0; i < Math.min(got.length, p.hash.length); i++) diff |= got.charCodeAt(i) ^ p.hash.charCodeAt(i);
  return diff === 0;
}

/** The "user verified" flag (bit 2) of WebAuthn authenticator data (32-byte rpIdHash, then the flags byte). */
export function userVerified(authData: Uint8Array): boolean {
  return authData.length > 32 && (authData[32] & 0x04) !== 0;
}
