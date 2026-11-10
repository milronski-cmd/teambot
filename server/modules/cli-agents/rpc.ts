import type { Proc } from './proc.js';

export class RpcError extends Error {
  constructor(message: string, public code: number, public data?: any) {
    super(message);
  }
}

type Handler = (method: string, params: any) => Promise<any>;

/**
 * Minimal bidirectional JSON-RPC 2.0 peer over newline-delimited JSON (stdio).
 * Used for ACP agents and the Codex app-server (which omits the "jsonrpc" field).
 */
export class RpcPeer {
  private nextId = 1;
  private pending = new Map<number | string, { resolve(v: any): void; reject(e: any): void; method: string }>();
  onRequest: Handler = async (method) => {
    throw new RpcError(`Method not found: ${method}`, -32601);
  };
  onNotification: (method: string, params: any) => void = () => {};
  closed = false;

  constructor(private proc: Proc, private opts: { jsonrpcField?: boolean } = {}) {}

  private send(o: any) {
    if (this.closed) return;
    this.proc.write(JSON.stringify(this.opts.jsonrpcField === false ? o : { jsonrpc: '2.0', ...o }) + '\n');
  }

  request<T = any>(method: string, params: any, timeoutMs = 0): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Verbinding met de CLI is gesloten'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      const done = (fn: () => void) => {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        fn();
      };
      this.pending.set(id, { resolve: (v) => done(() => resolve(v)), reject: (e) => done(() => reject(e)), method });
      if (timeoutMs > 0) timer = setTimeout(() => this.pending.get(id)?.reject(new Error(`Geen antwoord van de CLI op ${method} (time-out)`)), timeoutMs);
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: any) {
    this.send({ method, params });
  }

  /** Feed one stdout line. */
  handleLine(line: string) {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;
    if (typeof m.method === 'string') {
      if (m.id !== undefined && m.id !== null) {
        const id = m.id;
        Promise.resolve()
          .then(() => this.onRequest(m.method, m.params))
          .then(
            (result) => this.send({ id, result: result ?? null }),
            (e: any) => this.send({ id, error: { code: e instanceof RpcError || typeof e?.code === 'number' ? e.code : -32603, message: String(e?.message || e).slice(0, 500), data: e?.data } }),
          );
      } else {
        try {
          this.onNotification(m.method, m.params);
        } catch {
          /* ignore */
        }
      }
      return;
    }
    if (m.id !== undefined && this.pending.has(m.id)) {
      const p = this.pending.get(m.id)!;
      if (m.error) p.reject(new RpcError(String(m.error.message || 'Fout'), Number(m.error.code) || -32603, m.error.data));
      else p.resolve(m.result);
    }
  }

  /** Fail every outstanding request (process ended). */
  close(reason: string) {
    this.closed = true;
    for (const [, p] of this.pending) p.reject(new Error(reason));
    this.pending.clear();
  }
}
