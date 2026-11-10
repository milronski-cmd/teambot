import crypto from 'node:crypto';
import http from 'node:http';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';

/**
 * A local stand-in for the npm registry (TeamBot's own CLI copies, C-07): version manifests signed with a test key
 * exactly like the real registry signs them ("<name>@<version>:<integrity>", ECDSA P-256), dist-tags, and tarballs.
 * Never touches the internet or the owner's PC.
 */

export interface TarFile {
  name: string;
  data?: Buffer | string;
  mode?: number;
  /** '0' file, '2' symlink, '5' folder */
  type?: '0' | '2' | '5';
  linkname?: string;
}

/** A gzipped ustar archive, as `npm pack` makes them. */
export function tarGz(files: TarFile[]): Buffer {
  const blocks: Buffer[] = [];
  for (const f of files) {
    const data = f.data === undefined ? Buffer.alloc(0) : Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const size = f.type === '2' || f.type === '5' ? 0 : data.length;
    const h = Buffer.alloc(512);
    h.write(f.name, 0, 100, 'utf8');
    h.write((f.mode ?? 0o644).toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii');
    h.write('0000000\0', 108, 8, 'ascii');
    h.write('0000000\0', 116, 8, 'ascii');
    h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
    h.write('00000000000\0', 136, 12, 'ascii');
    h.fill(' ', 148, 156);
    h.write(f.type ?? '0', 156, 1, 'ascii');
    if (f.linkname) h.write(f.linkname, 157, 100, 'utf8');
    h.write('ustar\0', 257, 6, 'ascii');
    h.write('00', 263, 2, 'ascii');
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    blocks.push(h);
    if (size) {
      blocks.push(data);
      const pad = (512 - (size % 512)) % 512;
      if (pad) blocks.push(Buffer.alloc(pad));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

export const sri = (b: Buffer) => 'sha512-' + crypto.createHash('sha512').update(b).digest('base64');
export const sha256 = (b: Buffer) => 'sha256:' + crypto.createHash('sha256').update(b).digest('hex');

export interface ZipFile {
  name: string;
  data?: Buffer | string;
  /** Unix mode (e.g. 0o100755 for an executable, 0o120777 for a symlink). */
  mode?: number;
  /** 0 = stored, 8 = deflate (default). */
  method?: 0 | 8;
  /** Write a wrong CRC-32 into the directory (a damaged archive). */
  badCrc?: boolean;
}

/** A zip archive like OpenCode's release assets (made on Unix, deflated). */
export function zip(files: ZipFile[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let off = 0;
  for (const f of files) {
    const data = f.data === undefined ? Buffer.alloc(0) : Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const method = f.method ?? 8;
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = (zlib.crc32(data) ^ (f.badCrc ? 1 : 0)) >>> 0;
    const name = Buffer.from(f.name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE((3 << 8) | 20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(((f.mode ?? (f.name.endsWith('/') ? 0o040755 : 0o100644)) << 16) >>> 0, 38);
    ch.writeUInt32LE(off, 42);
    central.push(ch, name);
    off += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

export interface FixtureAsset {
  name: string;
  data: Buffer;
  /** No digest in the API (an old release). */
  noDigest?: boolean;
  /** Serve other bytes than the digest says (a swapped download). */
  tamper?: boolean;
  /** The API points the download somewhere else. */
  url?: string;
  /** github.com redirects this download to a host TeamBot must not trust. */
  evilRedirect?: boolean;
}

export interface FixtureRelease {
  tag: string;
  draft?: boolean;
  prerelease?: boolean;
  assets: FixtureAsset[];
}

/**
 * A local stand-in for api.github.com and github.com (TeamBot's own OpenCode copy from the GitHub releases): the
 * releases list and one release per tag with an asset `digest`, and downloads that redirect to an asset host
 * (/assets/…), like github.com does. Never touches the internet.
 */
export async function startFixtureGithub(o: { repo: string; releases: FixtureRelease[] }) {
  const hits: string[] = [];
  const blobs = new Map<string, Buffer>();
  let base = '';
  const view = (r: FixtureRelease) => ({
    tag_name: r.tag,
    name: r.tag,
    draft: !!r.draft,
    prerelease: !!r.prerelease,
    assets: r.assets.map((a) => ({
      name: a.name,
      size: a.data.length,
      digest: a.noDigest ? null : sha256(a.data),
      browser_download_url: a.url || `${base}/${o.repo}/releases/download/${r.tag}/${a.name}`,
    })),
  });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://x');
    const p = decodeURIComponent(u.pathname);
    hits.push(p);
    const json = (code: number, body: any) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(body)));
    if (p === `/repos/${o.repo}/releases`) return json(200, o.releases.map(view));
    const tag = p.match(new RegExp(`^/repos/${o.repo}/releases/tags/(.+)$`))?.[1];
    if (tag) {
      const r = o.releases.find((x) => x.tag === tag);
      return r ? json(200, view(r)) : json(404, { message: 'Not Found' });
    }
    const dl = p.match(new RegExp(`^/${o.repo}/releases/download/([^/]+)/(.+)$`));
    if (dl) {
      const a = o.releases.find((x) => x.tag === dl[1])?.assets.find((x) => x.name === dl[2]);
      if (!a) return json(404, { message: 'Not Found' });
      const id = crypto.randomUUID();
      blobs.set(id, a.tamper ? Buffer.concat([a.data, Buffer.from('x')]) : a.data);
      res.writeHead(302, { location: a.evilRedirect ? `http://evil.example/${id}` : `${base}/assets/${id}` });
      return res.end();
    }
    const blob = p.match(/^\/assets\/(.+)$/)?.[1];
    if (blob && blobs.has(blob)) {
      const b = blobs.get(blob)!;
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(b.length) });
      return res.end(b);
    }
    json(404, { message: 'Not Found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: base,
    hits,
    digest: (tag: string, name: string) => {
      const a = o.releases.find((x) => x.tag === tag)?.assets.find((x) => x.name === name);
      return a ? sha256(a.data) : '';
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** A fake CLI (Node script) that answers --version, `models` and Codex's device login like the real ones. */
export function fakeCliScript(o: { name: string; version: string }): string {
  return `const a = process.argv.slice(2);
if (a.includes('--version')) { console.log('${o.name} ${o.version} autoupdate-off=' + (process.env.OPENCODE_DISABLE_AUTOUPDATE || process.env.DISABLE_AUTOUPDATER || '') + ' path-has-helpers=' + /codex-path/.test(process.env.PATH || process.env.Path || '')); process.exit(0); }
if (a[0] === 'models') { console.log('opencode/big-pickle'); console.log('opencode/gpt-5-nano-free'); console.log('anthropic/claude-opus-5-5'); process.exit(0); }
if (a[0] === 'login' && a.includes('--device-auth')) {
  console.log('Follow these steps to sign in with ChatGPT using device code authorization:');
  console.log('1. Open this link in your browser and sign in to your account');
  console.log('   \\u001b[94mhttps://auth.openai.com/codex/device\\u001b[0m');
  console.log('2. Enter this one-time code (expires in 15 minutes)');
  console.log('   \\u001b[94mWXYZ-12345\\u001b[0m');
  setTimeout(() => { console.log('Successfully logged in'); process.exit(0); }, Number(process.env.FAKE_LOGIN_MS || 400));
} else if (a[0] === 'login' && a[1] === 'status') { if (process.env.FAKE_LOGGED_OUT) { console.log('Not logged in'); process.exit(1); } console.log('Logged in using ChatGPT'); process.exit(0); }
else if (a[0] === 'auth' && a[1] === 'status') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
else { process.exit(0); }
`;
}

export interface FixturePackage {
  name: string;
  version: string;
  files: TarFile[];
  /** Serve other bytes than were signed (a tampered download). */
  tamper?: boolean;
  /** Sign with another key (not the one TeamBot trusts). */
  badSig?: boolean;
}

export async function startFixtureRegistry(o: { packages: FixturePackage[]; distTags?: Record<string, Record<string, string>> }) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const keyid = 'SHA256:teambot-fixture';
  const keys = [{ keyid, key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }];
  const tarballs = new Map<string, Buffer>();
  const manifests = new Map<string, any>();
  let base = '';
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const p = new URL(req.url || '/', 'http://x').pathname;
    hits.push(p);
    const send = (code: number, body: any, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type, ...(Buffer.isBuffer(body) ? { 'content-length': String(body.length) } : {}) });
      res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    if (p.startsWith('/t/')) {
      const b = tarballs.get(p);
      return b ? send(200, b, 'application/octet-stream') : send(404, { error: 'not found' });
    }
    const tags = p.match(/^\/-\/package\/(.+)\/dist-tags$/);
    if (tags) {
      const t = o.distTags?.[decodeURIComponent(tags[1])];
      return t ? send(200, t) : send(404, { error: 'not found' });
    }
    const seg = p.split('/').filter(Boolean).map(decodeURIComponent);
    const m = manifests.get(`${seg[0]}@${seg[1]}`);
    return m ? send(200, m) : send(404, { error: 'version not found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const pkg of o.packages) {
    const tgz = tarGz(pkg.files);
    const integrity = sri(tgz);
    const file = `/t/${pkg.name.replace(/[@/]/g, '_')}-${pkg.version}.tgz`;
    const served = pkg.tamper ? Buffer.concat([tgz.subarray(0, tgz.length - 1), Buffer.from([tgz[tgz.length - 1] ^ 0xff])]) : tgz;
    tarballs.set(file, served);
    const sig = crypto.sign('sha256', Buffer.from(`${pkg.name}@${pkg.version}:${integrity}`), pkg.badSig ? other.privateKey : privateKey).toString('base64');
    manifests.set(`${pkg.name}@${pkg.version}`, { name: pkg.name, version: pkg.version, dist: { integrity, tarball: base + file, signatures: [{ keyid, sig }] } });
  }
  return {
    url: base,
    keys,
    hits,
    integrity: (name: string, version: string) => manifests.get(`${name}@${version}`)?.dist.integrity as string,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
