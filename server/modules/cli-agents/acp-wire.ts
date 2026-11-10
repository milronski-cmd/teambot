import { PROTOCOL_VERSION, RequestError, client, methods, ndJsonStream } from '@agentclientprotocol/sdk';
import type { Proc } from './proc.js';
import { RpcError, RpcPeer } from './rpc.js';

/**
 * The ACP connection of one agent process, on the official ACP SDK (`@agentclientprotocol/sdk`, Apache-2.0): JSON-RPC
 * framing (newline-delimited JSON), request ids, responses, errors and `$/cancel_request` come from the SDK. TeamBot
 * keeps everything above the wire in `acp.ts`: the permission rules, fs/* inside the workspace and the fixes for
 * agent quirks.
 *
 * What the agent asks of TeamBot (`session/request_permission`, `fs/read_text_file`, `fs/write_text_file`) is checked
 * against the ACP schema by the SDK first; a malformed request is answered with "invalid params" and never reaches the
 * permission gate (deny by default). `session/update` notifications are handled by TeamBot in arrival order (see
 * handleLine) and taken as sent: they only feed the chat, every field is read defensively, and an agent with a newer
 * or slightly different update must not lose its answer text.
 *
 * `TEAMBOT_ACP_WIRE=legacy` switches back to TeamBot's own JSON-RPC peer for one release (fallback if an agent turns out
 * to trip over the SDK).
 */

export { PROTOCOL_VERSION as ACP_PROTOCOL_VERSION };

/** What acp.ts needs from a connection: the same shape for the SDK wire and the legacy peer. */
export interface AcpWire {
  request<T = any>(method: string, params: any, timeoutMs?: number): Promise<T>;
  /** Send a notification; the promise (SDK) resolves once it is written. */
  notify(method: string, params: any): void | Promise<void>;
  /** Feed one stdout line of the agent. */
  handleLine(line: string): void;
  /** Fail every outstanding request (process ended). */
  close(reason: string): void;
  readonly closed: boolean;
  onRequest: (method: string, params: any) => Promise<any>;
  onNotification: (method: string, params: any) => void;
}

/** Is this a JSON-RPC error answer of the agent (SDK or legacy peer)? */
export function isWireError(e: any): e is { code: number; message: string; data?: any } {
  return e instanceof RequestError || e instanceof RpcError;
}

/** An error for the agent: TeamBot's own text and code as sent before (the SDK would hide a plain Error as "Internal error"). */
function toRequestError(e: any): RequestError {
  if (e instanceof RequestError) return e;
  if (e instanceof RpcError) return new RequestError(e.code, e.message, e.data);
  return new RequestError(-32603, String(e?.message || e).slice(0, 500));
}

/** The requests TeamBot answers as an ACP client (typed and schema-checked by the SDK). */
const TYPED_REQUESTS = [methods.client.session.requestPermission, methods.client.fs.readTextFile, methods.client.fs.writeTextFile] as const;

class SdkWire implements AcpWire {
  closed = false;
  onRequest: (method: string, params: any) => Promise<any> = async (method) => {
    throw new RpcError(`Method not found: ${method}`, -32601);
  };
  onNotification: (method: string, params: any) => void = () => {};
  private input!: ReadableStreamDefaultController<Uint8Array>;
  private enc = new TextEncoder();
  private dec = new TextDecoder();
  private conn: ReturnType<ReturnType<typeof client>['connect']>;

  constructor(private proc: Proc) {
    const input = new ReadableStream<Uint8Array>({ start: (c) => void (this.input = c) });
    const output = new WritableStream<Uint8Array>({ write: (chunk) => this.proc.write(this.dec.decode(chunk)) });
    const answer = (method: string) => async (ctx: { params: any }) => {
      try {
        return await this.onRequest(method, ctx.params);
      } catch (e) {
        throw toRequestError(e);
      }
    };
    const app = client({ name: 'teambot' });
    for (const m of TYPED_REQUESTS) app.onRequest(m, answer(m) as any);
    // Any other request: TeamBot's own "not supported" answer (as before), with the method named.
    app.onRequest('*', async (ctx: any) => answer(String(ctx.method))(ctx));
    app.onNotification('*', async (ctx: any) => {
      try {
        this.onNotification(String(ctx.method), ctx.params);
      } catch {
        /* a display problem never ends the connection */
      }
    });
    this.conn = app.connect(ndJsonStream(output, input));
  }

  handleLine(line: string) {
    if (this.closed) return;
    // Some agents print a banner or log line on stdout: skip what is not a JSON-RPC object instead of answering it
    // with a parse error (the SDK would), as TeamBot always did.
    const t = line.trim();
    if (!t.startsWith('{')) return;
    let m: any;
    try {
      m = JSON.parse(t);
    } catch {
      return;
    }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return;
    // session/update in arrival order, right here: the SDK dispatches messages concurrently, so a permission request
    // could be handled before the tool call the agent announced just before it (OpenCode sends both back to back),
    // and the approval card would not know what the action is.
    if (m.method === methods.client.session.update && m.id === undefined) {
      try {
        this.onNotification(m.method, m.params);
      } catch {
        /* a display problem never ends the connection */
      }
      return;
    }
    this.input.enqueue(this.enc.encode(t + '\n'));
  }

  request<T = any>(method: string, params: any, timeoutMs = 0): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Verbinding met de CLI is gesloten'));
    const call = this.conn.agent.request(method as any, params) as Promise<T>;
    if (!(timeoutMs > 0)) return call;
    let timer: NodeJS.Timeout;
    const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`Geen antwoord van de CLI op ${method} (time-out)`)), timeoutMs)));
    return Promise.race([call, late]).finally(() => clearTimeout(timer));
  }

  /** Resolves once the message is written (await it before ending the process, e.g. session/cancel). */
  notify(method: string, params: any): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.conn.agent.notify(method as any, params).catch(() => {});
  }

  close(reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.conn.close(new Error(reason));
    try {
      this.input.close();
    } catch {
      /* already closed */
    }
  }
}

/** The ACP connection for one agent process (the SDK unless TEAMBOT_ACP_WIRE=legacy). */
export function acpWire(proc: Proc): AcpWire {
  if (process.env.TEAMBOT_ACP_WIRE === 'legacy') return new RpcPeer(proc);
  return new SdkWire(proc);
}
