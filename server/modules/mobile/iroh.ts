import crypto from 'node:crypto';
import net from 'node:net';
import { createRequire } from 'node:module';
import type { Ctx } from '../../core/types.js';
import { bad } from '../../core/http.js';
import { now } from '../../core/db.js';
import { Gateway } from './gateway.js';
import { isLoopbackHost } from '../../core/util.js';

/**
 * "TeamBot-verbinding": the phone reaches this computer from anywhere without Tailscale, an account or port
 * forwarding, through iroh (n0-computer/iroh via `@number0/iroh`, MIT OR Apache-2.0).
 *
 *  - The computer runs an iroh endpoint with a stable key (kept in Secrets). Its public key (the endpoint id) goes into
 *    the pairing QR code, so the phone dials exactly this computer: no relay or lookup server can stand in for it.
 *  - iroh connects directly where it can (at home over wifi, or through hole punching) and through a relay otherwise.
 *    Either way the link is end-to-end encrypted (QUIC, TLS 1.3, keyed by the endpoint ids); a relay only sees
 *    ciphertext.
 *  - Every bidirectional stream carries raw HTTP/WebSocket bytes. They are piped, unchanged, into a private phone
 *    gateway on 127.0.0.1 (gateway.ts), so exactly the same rules apply as on wifi: only the public pairing routes and
 *    device tokens get through, then the device policy (policy.ts). The owner token never works here.
 *
 * Default relays: n0's public relays (free, rate-limited, meant for testing). An own `iroh-relay` can be set under
 * Geavanceerd (docs/modules/mobile.md › Eigen relay). Turning the connection on or off is computer-only.
 */

export const IROH_ALPN = 'teambot/http/1';
const ALPN = Array.from(Buffer.from(IROH_ALPN));
const KEY_NAME = 'mobile.iroh.key';
const MAX_CONNECTIONS = 32;
const READ_CHUNK = 64 * 1024;

export interface IrohSettings {
  enabled: boolean;
  /** Own iroh-relay (https://…); null = n0's public relays. */
  relay: string | null;
}

export interface IrohStatus {
  /** The native part loads on this computer (Windows x64/arm64, macOS arm64, Linux). */
  available: boolean;
  enabled: boolean;
  running: boolean;
  /** Public key of this computer (goes into the QR code). */
  id: string | null;
  relay: { own: string | null; home: string | null; online: boolean };
  error: string | null;
  /** Phones connected right now. */
  phones: number;
  /** The last phone that connected: when, and whether directly or through the relay. */
  last: { at: string; path: 'direct' | 'relay' | null; rttMs: number | null } | null;
}

let lib: any;
let libError: string | null = null;
/** The native module, or null with `libError` (unsupported platform, missing file). Loaded once, lazily. */
export function irohLib(): any | null {
  if (lib !== undefined) return lib;
  try {
    lib = createRequire(import.meta.url)('@number0/iroh');
  } catch (e: any) {
    lib = null;
    libError = String(e?.message || e).split('\n')[0];
  }
  return lib;
}

/** Only an https origin (http only on this computer, for a test relay); null = n0's public relays. */
export function normalizeRelayUrl(raw: unknown): string | null {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw bad('Ongeldig adres. Voorbeeld: https://relay.voorbeeld.nl');
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== '/')) throw bad('Gebruik alleen het adres van de relay-server, zonder pad');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackHost(u.hostname))) throw bad('Een relay-server moet een https-adres hebben');
  return u.origin + '/';
}

/** A stable, private IPv6 address per phone key (fd7e::/16): rate limits and the audit log tell phones apart. */
export function peerAddress(endpointId: string): string {
  const h = crypto.createHash('sha256').update(endpointId).digest('hex');
  const groups = ['fd7e'];
  for (let i = 0; i < 7; i++) groups.push(h.slice(i * 4, i * 4 + 4));
  return groups.join(':');
}

export class IrohLink {
  /** For tests and the live check: 'offline' = no relays and no lookup service (direct addresses only). */
  preset: 'n0' | 'offline' = process.env.TEAMBOT_IROH_PRESET === 'offline' ? 'offline' : 'n0';
  private ep: any = null;
  private gateway: Gateway;
  private peerByPort = new Map<number, string>();
  private conns = new Set<any>();
  private watches: any[] = [];
  private state = { running: false, id: null as string | null, home: null as string | null, online: false, error: null as string | null, last: null as IrohStatus['last'] };
  private starting: Promise<void> | null = null;
  private guard: ReturnType<typeof setInterval> | null = null;
  private guardTick = 0;
  private offlineSince = 0;
  /** How often the guard looks, and how long the connection may be away before it is started again (tests shorten these). */
  guardEveryMs = 30_000;
  guardOfflineMs = 90_000;

  constructor(private ctx: Ctx) {
    this.gateway = new Gateway(ctx, { peerAddress: (s) => (s.remotePort ? this.peerByPort.get(s.remotePort) : undefined) });
  }

  settings(): IrohSettings {
    const s = this.ctx.store.getSetting<Partial<IrohSettings>>('', 'mobileIroh', {}) || {};
    let relay: string | null = null;
    try {
      relay = normalizeRelayUrl(s.relay);
    } catch {
      relay = null;
    }
    return { enabled: !!s.enabled, relay };
  }

  saveSettings(next: IrohSettings) {
    this.ctx.store.setSetting('', 'mobileIroh', { enabled: !!next.enabled, relay: next.relay });
  }

  status(): IrohStatus {
    const s = this.settings();
    return {
      available: !!irohLib(),
      enabled: s.enabled,
      running: this.state.running,
      id: this.state.running ? this.state.id : null,
      relay: { own: s.relay, home: this.state.running ? this.state.home : null, online: this.state.running && this.state.online },
      error: this.state.error,
      phones: this.conns.size,
      last: this.state.last,
    };
  }

  /** What the QR code and the phone's status carry: the key, and the relay when it is our own. */
  link(): { id: string; relay: string | null } | null {
    if (!this.state.running || !this.state.id) return null;
    return { id: this.state.id, relay: this.settings().relay };
  }

  /** Start or stop according to the settings. Waits for the endpoint, not for the relay. */
  async apply(): Promise<void> {
    if (this.starting) await this.starting.catch(() => undefined);
    this.starting = this.restart();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
    this.watchOver();
  }

  /**
   * Keeps the connection up without anyone looking: it starts again when it could not start (the computer was just
   * switched on and had no network yet), when it stays offline (the relay or the network went away and did not come
   * back by itself), and after the computer slept. The key stays the same, so paired phones find it again.
   */
  private watchOver() {
    const on = this.settings().enabled && this.preset !== 'offline' && !!irohLib();
    if (!on) {
      if (this.guard) clearInterval(this.guard);
      this.guard = null;
      return;
    }
    if (this.guard) return;
    this.guardTick = Date.now();
    this.offlineSince = 0;
    this.guard = setInterval(() => void this.check().catch(() => undefined), this.guardEveryMs);
    this.guard.unref?.();
  }

  /** One look of the guard (public for tests). Returns why it started the connection again, or null. */
  async check(): Promise<'not-running' | 'offline' | 'slept' | null> {
    const t = Date.now();
    const slept = t - this.guardTick > this.guardEveryMs * 3;
    this.guardTick = t;
    if (this.starting || !this.settings().enabled) return null;
    let why: 'not-running' | 'offline' | 'slept' | null = null;
    if (!this.state.running) why = 'not-running';
    else if (this.state.online) this.offlineSince = 0;
    else {
      if (!this.offlineSince) this.offlineSince = t;
      // After sleep the sockets are stale: do not wait out the full time.
      if (t - this.offlineSince >= this.guardOfflineMs || slept) why = slept ? 'slept' : 'offline';
    }
    // A phone that is connected right now is proof that it works (directly, without the relay).
    if (!why || (why !== 'not-running' && this.conns.size > 0)) return null;
    this.offlineSince = 0;
    this.ctx.log.info(`[mobile] TeamBot-verbinding opnieuw gestart (${why === 'not-running' ? 'was niet gestart' : why === 'slept' ? 'na slaapstand' : 'was offline'})`);
    await this.apply();
    return why;
  }

  /** Resolves once the relay is reachable (or after `ms`): a QR code made right after turning it on then works. */
  async waitOnline(ms: number): Promise<boolean> {
    if (this.preset === 'offline') return false;
    const t = Date.now() + ms;
    while (Date.now() < t && this.state.running && !this.state.online) await new Promise((r) => setTimeout(r, 100));
    return this.state.online;
  }

  private secretKey(): number[] {
    const cur = this.ctx.secrets.getByName('', KEY_NAME);
    const buf = cur ? Buffer.from(cur, 'base64') : null;
    if (buf && buf.length === 32) return Array.from(buf);
    const fresh = crypto.randomBytes(32);
    this.ctx.secrets.set('', KEY_NAME, fresh.toString('base64'));
    return Array.from(fresh);
  }

  private async restart() {
    await this.shutdown();
    const s = this.settings();
    if (!s.enabled) {
      this.state.error = null;
      return;
    }
    const iroh = irohLib();
    if (!iroh) {
      this.state.error = `De TeamBot-verbinding werkt niet op deze computer (${libError || 'onderdeel ontbreekt'}).`;
      this.ctx.log.warn(`[mobile] TeamBot-verbinding niet beschikbaar: ${libError}`);
      return;
    }
    const gw = await this.gateway.start('127.0.0.1', 0);
    if (!gw.running || !gw.port) {
      this.state.error = `Interne ingang start niet: ${gw.error || 'onbekende fout'}`;
      return;
    }
    try {
      const b = iroh.Endpoint.builder();
      if (this.preset === 'offline') {
        b.applyMinimal();
        b.relayMode(iroh.RelayMode.disabled());
      } else {
        b.applyN0();
        if (s.relay) b.relayMode(iroh.RelayMode.customFromUrls([s.relay]));
      }
      b.secretKey(this.secretKey());
      b.alpns([ALPN]);
      // Only for the live check (a forced relay): bind the sockets to given addresses, e.g. "192.168.1.5:0,[::1]:0".
      for (const a of (process.env.TEAMBOT_IROH_BIND || '').split(',').map((x) => x.trim()).filter(Boolean)) b.bindAddr(a);
      const ep = await b.bind();
      this.ep = ep;
      this.state = { ...this.state, running: true, id: ep.id().toString(), home: null, online: false, error: null };
      if (this.preset !== 'offline') {
        try {
          this.watches.push(
            // napi callbacks get (error, value); never throw in here (that would end the process).
            ep.watchHomeRelay((...args: unknown[]) => {
              const urls = (Array.isArray(args[0]) ? args[0] : Array.isArray(args[1]) ? args[1] : null) as string[] | null;
              if (this.ep !== ep || !urls) return;
              this.state.home = urls[0] || null;
              this.state.online = urls.length > 0;
            }),
          );
        } catch {
          /* older binding without the watcher: online() below still tells */
        }
        ep.online().then(
          () => {
            if (this.ep !== ep) return;
            this.state.online = true;
            this.state.home = this.state.home || ep.addr().relayUrl() || null;
          },
          () => undefined,
        );
      }
      void this.acceptLoop(ep, gw.port);
      this.ctx.log.info(`[mobile] TeamBot-verbinding actief (${s.relay ? 'eigen relay' : 'relays van n0'})`);
    } catch (e: any) {
      await this.shutdown();
      this.state.error = `TeamBot-verbinding start niet: ${String(e?.message || e).split('\n')[0]}`;
      this.ctx.log.warn(`[mobile] ${this.state.error}`);
    }
  }

  /** Direct addresses of this endpoint (tests and the live check dial these when there is no relay). */
  addr(): { id: string; relay: string | null; direct: string[] } | null {
    if (!this.ep) return null;
    const a = this.ep.addr();
    return { id: a.id().toString(), relay: a.relayUrl() || null, direct: a.directAddresses() };
  }

  private async acceptLoop(ep: any, port: number) {
    for (;;) {
      let inc: any;
      try {
        inc = await ep.acceptNext();
      } catch {
        break;
      }
      if (!inc || this.ep !== ep) break;
      if (this.conns.size >= MAX_CONNECTIONS) {
        void inc.refuse().catch(() => undefined);
        continue;
      }
      void this.serve(inc, port);
    }
  }

  private async serve(inc: any, port: number) {
    let conn: any;
    try {
      const accepting = await inc.accept();
      conn = await accepting.connect();
    } catch {
      return;
    }
    if (Buffer.from(conn.alpn()).toString() !== IROH_ALPN) {
      try {
        conn.close(0n, Array.from(Buffer.from('alpn')));
      } catch {
        /* already closed */
      }
      return;
    }
    const peer = peerAddress(conn.remoteId().toString());
    this.conns.add(conn);
    this.noteLast(conn);
    setTimeout(() => this.noteLast(conn), 3000).unref();
    try {
      for (;;) {
        const bi = await conn.acceptBi();
        void this.bridge(bi, port, peer);
      }
    } catch {
      /* the phone went away or the endpoint closed */
    } finally {
      this.conns.delete(conn);
    }
  }

  private noteLast(conn: any) {
    try {
      const sel = (conn.paths() as any[]).find((p) => p.isSelected);
      this.state.last = { at: now(), path: sel ? (sel.isRelay ? 'relay' : 'direct') : null, rttMs: sel ? Math.round(sel.rttMs) : null };
    } catch {
      this.state.last = { at: now(), path: null, rttMs: null };
    }
  }

  /** One stream ⇄ one TCP connection to the private gateway: bytes in both directions, unchanged. */
  private async bridge(bi: any, port: number, peer: string) {
    const sock = net.connect(port, '127.0.0.1');
    sock.setNoDelay(true);
    try {
      await new Promise<void>((resolve, reject) => {
        sock.once('connect', resolve);
        sock.once('error', reject);
      });
    } catch {
      void bi.send.reset(0n).catch(() => undefined);
      return;
    }
    const local = sock.localPort!;
    this.peerByPort.set(local, peer);
    const send = bi.send;
    const recv = bi.recv;
    // phone → computer
    void (async () => {
      try {
        for (;;) {
          const chunk: number[] = await recv.read(READ_CHUNK);
          if (!chunk.length) break;
          if (!sock.write(Buffer.from(chunk))) await drained(sock);
        }
        sock.end();
      } catch {
        sock.destroy();
      }
    })();
    // computer → phone
    try {
      for await (const chunk of sock) await send.writeAll(Array.from(chunk as Buffer));
      await send.finish();
    } catch {
      void send.reset(0n).catch(() => undefined);
      sock.destroy();
    } finally {
      this.peerByPort.delete(local);
    }
  }

  private async shutdown() {
    const ep = this.ep;
    this.ep = null;
    for (const w of this.watches.splice(0)) void Promise.resolve(w.stop?.()).catch(() => undefined);
    this.conns.clear();
    this.state = { ...this.state, running: false, id: null, home: null, online: false };
    if (ep) await ep.close().catch(() => undefined);
    await this.gateway.stop();
    this.peerByPort.clear();
  }

  async stop() {
    if (this.guard) clearInterval(this.guard);
    this.guard = null;
    if (this.starting) await this.starting.catch(() => undefined);
    await this.shutdown();
  }
}

function drained(sock: net.Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      sock.off('drain', done);
      sock.off('close', closed);
      resolve();
    };
    const closed = () => {
      sock.off('drain', done);
      reject(new Error('closed'));
    };
    sock.once('drain', done);
    sock.once('close', closed);
  });
}
