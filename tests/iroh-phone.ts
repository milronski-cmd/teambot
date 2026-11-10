import net from 'node:net';
import { irohLib, IROH_ALPN } from '../server/modules/mobile/iroh.js';

/**
 * A Node stand-in for the iPhone app's TeamBot connection (mobile/ios/TeamBot/Connection/IrohTunnel.swift): an iroh
 * endpoint that dials the computer's key, plus a loopback proxy where every TCP connection becomes one iroh stream.
 * fetch() and WebSockets against `base` then travel exactly like the app's web view does.
 */
export interface IrohPhone {
  base: string;
  /** Milliseconds from bind to the first established connection. */
  connectMs: number;
  /** 'direct' or 'relay' for the path in use now. */
  path(): 'direct' | 'relay' | null;
  rttMs(): number | null;
  close(): Promise<void>;
}

export async function startIrohPhone(target: { id: string; relay?: string | null; direct?: string[] }, opts: { offline?: boolean; bind?: string[]; relay?: string | null; timeoutMs?: number } = {}): Promise<IrohPhone> {
  const iroh = irohLib();
  if (!iroh) throw new Error('iroh ontbreekt');
  const t0 = Date.now();
  const b = iroh.Endpoint.builder();
  if (opts.offline) {
    b.applyMinimal();
    b.relayMode(iroh.RelayMode.disabled());
  } else {
    b.applyN0();
    if (opts.relay) b.relayMode(iroh.RelayMode.customFromUrls([opts.relay]));
  }
  for (const a of opts.bind || []) b.bindAddr(a);
  const ep = await b.bind();
  const addr = new iroh.EndpointAddr(iroh.EndpointId.fromString(target.id), target.relay || null, target.direct || []);
  const alpn = Array.from(Buffer.from(IROH_ALPN));
  let timer: NodeJS.Timeout | undefined;
  let conn: any;
  try {
    conn = await Promise.race([
      ep.connect(addr, alpn),
      new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`geen verbinding binnen ${opts.timeoutMs ?? 30000} ms`)), opts.timeoutMs ?? 30000))),
    ]);
  } catch (e) {
    await ep.close().catch(() => undefined);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const connectMs = Date.now() - t0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer(async (sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.pause();
    let bi: any;
    try {
      bi = await conn.openBi();
    } catch {
      // The connection dropped (computer restarted, network switch): dial again once.
      try {
        conn = await ep.connect(addr, alpn);
        bi = await conn.openBi();
      } catch {
        sock.destroy();
        return;
      }
    }
    void (async () => {
      try {
        for (;;) {
          const chunk: number[] = await bi.recv.read(64 * 1024);
          if (!chunk.length) break;
          sock.write(Buffer.from(chunk));
        }
        sock.end();
      } catch {
        sock.destroy();
      }
    })();
    sock.resume();
    try {
      for await (const chunk of sock) await bi.send.writeAll(Array.from(chunk as Buffer));
      await bi.send.finish();
    } catch {
      void bi.send.reset(0n).catch(() => undefined);
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  const selected = () => {
    try {
      return (conn.paths() as any[]).find((p) => p.isSelected) || null;
    } catch {
      return null;
    }
  };
  return {
    base: `http://127.0.0.1:${port}`,
    connectMs,
    path: () => {
      const s = selected();
      return s ? (s.isRelay ? 'relay' : 'direct') : null;
    },
    rttMs: () => {
      const s = selected();
      return s ? Math.round(s.rttMs) : null;
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      try {
        conn.close(0n, []);
      } catch {
        /* closed */
      }
      await ep.close().catch(() => undefined);
    },
  };
}
