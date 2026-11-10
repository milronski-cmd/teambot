import { sha256 } from '../core/util.js';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

/**
 * Minimal AWS helpers for Amazon Bedrock without the AWS SDK: Signature Version 4 request signing and the
 * `application/vnd.amazon.eventstream` framing that ConverseStream uses. Verified against the published SigV4
 * test vector (tests/providers-conformance.test.ts).
 */

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const hmac = (key: crypto.BinaryLike, data: string) => crypto.createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding as SigV4 wants it (also encodes !'()*). */
export function awsEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * Sign a request in place (adds x-amz-date, x-amz-security-token and authorization headers).
 * `url` must already be encoded the way it is sent; non-S3 services encode each path segment once more in the
 * canonical request (that is why a Bedrock model id with ":" ends up as %253A in the signature).
 */
export function signV4(
  req: { method: string; url: string; headers: Record<string, string>; body?: string },
  creds: AwsCredentials,
  region: string,
  service: string,
  now = new Date(),
): Record<string, string> {
  const u = new URL(req.url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  headers.host = u.host;
  headers['x-amz-date'] = amzDate;
  if (creds.sessionToken) headers['x-amz-security-token'] = creds.sessionToken;
  const signedNames = Object.keys(headers).sort();
  const canonicalHeaders = signedNames.map((k) => `${k}:${headers[k]}\n`).join('');
  const signedHeaders = signedNames.join(';');
  const canonicalUri = u.pathname.split('/').map((seg) => awsEncode(seg)).join('/') || '/';
  const params = [...u.searchParams.entries()].map(([k, v]) => [awsEncode(k), awsEncode(v)]).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const canonicalQuery = params.map(([k, v]) => `${k}=${v}`).join('&');
  const payloadHash = sha256(req.body ?? '');
  const canonical = [req.method.toUpperCase(), canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const kDate = hmac('AWS4' + creds.secretAccessKey, date);
  const kSigning = hmac(hmac(hmac(kDate, region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  delete headers.host; // fetch sets it
  return headers;
}

/**
 * Parse the secret the user pasted for Bedrock:
 *  - a Bedrock API key (long-term or short-term; sent as Bearer token), or
 *  - "ACCESS_KEY_ID:SECRET_ACCESS_KEY" or "ACCESS_KEY_ID:SECRET_ACCESS_KEY:SESSION_TOKEN" for SigV4.
 */
export function parseBedrockSecret(secret: string): { bearer: string } | { creds: AwsCredentials } {
  const s = secret.trim();
  const m = /^((?:AKIA|ASIA)[A-Z0-9]{12,})\s*[:\s]\s*([A-Za-z0-9/+=]{30,})(?:\s*[:\s]\s*(\S+))?$/.exec(s);
  if (m) return { creds: { accessKeyId: m[1], secretAccessKey: m[2], sessionToken: m[3] || undefined } };
  return { bearer: s };
}

export interface EventStreamMessage {
  headers: Record<string, string | number | boolean>;
  payload: Buffer;
}

/** Incremental decoder for AWS event-stream frames: prelude (len, headers len, CRC) + headers + payload + CRC. */
export class EventStreamDecoder {
  private buf = Buffer.alloc(0);
  push(chunk: Uint8Array): EventStreamMessage[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, Buffer.from(chunk)]) : Buffer.from(chunk);
    const out: EventStreamMessage[] = [];
    while (this.buf.length >= 12) {
      const total = this.buf.readUInt32BE(0);
      const headersLen = this.buf.readUInt32BE(4);
      if (total < 16 || total > 16 * 1024 * 1024) throw new Error('Ongeldig event-stream frame');
      if (this.buf.length < total) break;
      const preludeCrc = this.buf.readUInt32BE(8);
      if (zlib.crc32(this.buf.subarray(0, 8)) !== preludeCrc) throw new Error('Event-stream controlegetal klopt niet');
      const msgCrc = this.buf.readUInt32BE(total - 4);
      if (zlib.crc32(this.buf.subarray(0, total - 4)) !== msgCrc) throw new Error('Event-stream controlegetal klopt niet');
      const headers = decodeHeaders(this.buf.subarray(12, 12 + headersLen));
      const payload = Buffer.from(this.buf.subarray(12 + headersLen, total - 4));
      out.push({ headers, payload });
      this.buf = this.buf.subarray(total);
    }
    return out;
  }
}

function decodeHeaders(b: Buffer): Record<string, string | number | boolean> {
  const h: Record<string, string | number | boolean> = {};
  let i = 0;
  while (i < b.length) {
    const nameLen = b.readUInt8(i);
    const name = b.subarray(i + 1, i + 1 + nameLen).toString('utf8');
    i += 1 + nameLen;
    const type = b.readUInt8(i++);
    switch (type) {
      case 0:
        h[name] = true;
        break;
      case 1:
        h[name] = false;
        break;
      case 2:
        h[name] = b.readInt8(i);
        i += 1;
        break;
      case 3:
        h[name] = b.readInt16BE(i);
        i += 2;
        break;
      case 4:
        h[name] = b.readInt32BE(i);
        i += 4;
        break;
      case 5:
      case 8:
        h[name] = Number(b.readBigInt64BE(i));
        i += 8;
        break;
      case 6:
      case 7: {
        const len = b.readUInt16BE(i);
        const v = b.subarray(i + 2, i + 2 + len);
        h[name] = type === 7 ? v.toString('utf8') : v.toString('base64');
        i += 2 + len;
        break;
      }
      case 9:
        h[name] = b.subarray(i, i + 16).toString('hex');
        i += 16;
        break;
      default:
        throw new Error('Onbekend event-stream headertype ' + type);
    }
  }
  return h;
}

/** Encode one frame (used by the test fixtures to build recorded ConverseStream answers). */
export function encodeEventStream(headers: Record<string, string>, payload: string | Buffer): Buffer {
  const hb = Buffer.concat(
    Object.entries(headers).map(([k, v]) => {
      const name = Buffer.from(k, 'utf8');
      const val = Buffer.from(v, 'utf8');
      const head = Buffer.alloc(1 + name.length + 1 + 2);
      head.writeUInt8(name.length, 0);
      name.copy(head, 1);
      head.writeUInt8(7, 1 + name.length);
      head.writeUInt16BE(val.length, 2 + name.length);
      return Buffer.concat([head, val]);
    }),
  );
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const total = 12 + hb.length + body.length + 4;
  const prelude = Buffer.alloc(12);
  prelude.writeUInt32BE(total, 0);
  prelude.writeUInt32BE(hb.length, 4);
  prelude.writeUInt32BE(zlib.crc32(prelude.subarray(0, 8)), 8);
  const msg = Buffer.concat([prelude, hb, body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(msg), 0);
  return Buffer.concat([msg, crc]);
}
