import crypto from 'node:crypto';

/**
 * Minimal Web Push implementation on node:crypto only:
 *  - RFC 8292 (VAPID): ES256-signed JWT that identifies this server to the push service.
 *  - RFC 8291 + RFC 8188 (aes128gcm): end-to-end encryption of the payload to the browser,
 *    so the push service (Apple/Google/Mozilla/Microsoft) only ever sees ciphertext.
 * We do not use the `web-push` npm package (MPL-2.0, outside the project's licence policy).
 */

export const b64u = {
  enc: (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url'),
  dec: (s: string) => Buffer.from(String(s || ''), 'base64url'),
};

/** publicKey: 65-byte uncompressed P-256 point; privateKey: 32-byte scalar. Both base64url. */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export function generateVapidKeys(): VapidKeys {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' }) as { x?: string; y?: string; d?: string };
  const pub = Buffer.concat([Buffer.from([4]), b64u.dec(jwk.x!), b64u.dec(jwk.y!)]);
  return { publicKey: b64u.enc(pub), privateKey: jwk.d! };
}

function vapidKeyObject(k: VapidKeys): crypto.KeyObject {
  const pub = b64u.dec(k.publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('Ongeldige VAPID-sleutel');
  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u.enc(pub.subarray(1, 33)), y: b64u.enc(pub.subarray(33, 65)), d: k.privateKey },
    format: 'jwk',
  });
}

/** `Authorization` header value for one push request (RFC 8292, "vapid" scheme). */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, ttlSec = 12 * 3600): string {
  const aud = new URL(endpoint).origin;
  const enc = (o: any) => b64u.enc(Buffer.from(JSON.stringify(o)));
  const data = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud, exp: Math.floor(Date.now() / 1000) + ttlSec, sub: subject })}`;
  const sig = crypto.sign('sha256', Buffer.from(data), { key: vapidKeyObject(keys), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${data}.${b64u.enc(sig)}, k=${keys.publicKey}`;
}

const hmac = (key: Buffer, data: Buffer) => crypto.createHmac('sha256', key).update(data).digest();

function deriveKeys(authSecret: Buffer, ecdhSecret: Buffer, uaPublic: Buffer, asPublic: Buffer, salt: Buffer) {
  const prkKey = hmac(authSecret, ecdhSecret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'latin1')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'latin1')).subarray(0, 12);
  return { cek, nonce };
}

export const MAX_PAYLOAD = 3000;
const RECORD_SIZE = 4096;

/**
 * Encrypt a push payload for one subscription (single aes128gcm record).
 * `opts` exists only so tests can reproduce the RFC 8291 example.
 */
export function encryptPayload(payload: Buffer, p256dh: string, auth: string, opts: { salt?: Buffer; asPrivate?: Buffer } = {}): Buffer {
  const uaPublic = b64u.dec(p256dh);
  const authSecret = b64u.dec(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('Ongeldige p256dh-sleutel');
  if (authSecret.length !== 16) throw new Error('Ongeldige auth-sleutel');
  if (payload.length > MAX_PAYLOAD) throw new Error('Pushbericht te groot');
  const ecdh = crypto.createECDH('prime256v1');
  if (opts.asPrivate) ecdh.setPrivateKey(opts.asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = opts.salt ?? crypto.randomBytes(16);
  const { cek, nonce } = deriveKeys(authSecret, ecdh.computeSecret(uaPublic), uaPublic, asPublic, salt);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21 + asPublic.length);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  asPublic.copy(header, 21);
  return Buffer.concat([header, body]);
}

/** Receiver side (what the browser does). Used by the tests to verify encryptPayload. */
export function decryptPayload(message: Buffer, uaPrivate: Buffer, uaPublicB64: string, authB64: string): Buffer {
  const salt = message.subarray(0, 16);
  const idlen = message.readUInt8(20);
  const asPublic = message.subarray(21, 21 + idlen);
  const data = message.subarray(21 + idlen);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const uaPublic = b64u.dec(uaPublicB64);
  const { cek, nonce } = deriveKeys(b64u.dec(authB64), ecdh.computeSecret(asPublic), uaPublic, asPublic, salt);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  if (plain[end] !== 2) throw new Error('Ongeldige opvulling');
  return plain.subarray(0, end);
}

/** Push services we are willing to POST to (SSRF guard: the endpoint URL comes from a client). */
const PUSH_HOSTS = [/(^|\.)push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];

export function assertPushEndpoint(raw: string): URL {
  let u: URL;
  try {
    u = new URL(String(raw || ''));
  } catch {
    throw new Error('Ongeldig push-adres');
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) throw new Error('Push-adres moet https zijn');
  const extra = (process.env.TEAMBOT_PUSH_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const host = u.hostname.toLowerCase();
  if (!PUSH_HOSTS.some((r) => r.test(host)) && !extra.includes(host)) throw new Error('Onbekende pushdienst');
  return u;
}
