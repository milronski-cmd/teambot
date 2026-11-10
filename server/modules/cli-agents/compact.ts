import { APP_VERSION } from '../../core/config.js';
import { codexContext } from '../usage/parse.js';
import { startProc } from './proc.js';
import { RpcError, RpcPeer } from './rpc.js';
import type { CompactResult } from './usage.js';

/**
 * Codex's own compaction of a bot's thread: `codex app-server` → `thread/resume` → `thread/compact/start`, then wait
 * until the compaction item (or the turn it runs in) is done. The same thread id stays, so the next turn resumes it
 * with the compacted context. A Codex without this method answers "method not found": then `unsupported` is set and
 * TeamBot summarises itself and starts a new session with that summary (see agent/compaction.ts).
 */
export async function compactCodexSession(o: { bin: string; cwd: string; threadId: string; args?: string[]; timeoutMs?: number }): Promise<CompactResult & { unsupported?: boolean }> {
  const timeoutMs = o.timeoutMs ?? 5 * 60_000;
  const ctl = new AbortController();
  let peer!: RpcPeer;
  let done: (v: 'done' | 'failed') => void = () => {};
  const finished = new Promise<'done' | 'failed'>((r) => (done = r));
  let post: number | undefined;
  let failure = '';
  const proc = startProc({ bin: o.bin, args: ['app-server', ...(o.args || [])], cwd: o.cwd, env: { NO_COLOR: '1' }, signal: ctl.signal, timeoutMs, idleMs: timeoutMs, onLine: (l) => peer.handleLine(l) });
  peer = new RpcPeer(proc, { jsonrpcField: false });
  proc.done.then(() => {
    peer.close('Codex app-server is gestopt');
    done('failed');
  });
  peer.onRequest = async () => {
    // Compacting runs no tools; anything Codex asks is refused.
    throw new RpcError('Niet beschikbaar tijdens samenvatten', -32601);
  };
  peer.onNotification = (method, p) => {
    if (p?.threadId && p.threadId !== o.threadId) return;
    if (method === 'thread/compacted') done('done');
    else if (method === 'item/completed' && p?.item?.type === 'contextCompaction') done('done');
    else if (method === 'thread/tokenUsage/updated') post = codexContext(p)?.used ?? post;
    else if (method === 'turn/completed') {
      if (p?.turn?.status === 'failed') failure = String(p?.turn?.error?.message || 'Codex kon niet samenvatten');
      done(p?.turn?.status === 'failed' ? 'failed' : 'done');
    } else if (method === 'error' && !p?.willRetry) failure = String(p?.error?.message || failure);
  };
  try {
    await peer.request('initialize', { clientInfo: { name: 'teambot', title: 'TeamBot', version: APP_VERSION }, capabilities: { experimentalApi: false, requestAttestation: false } }, 30_000);
    peer.notify('initialized', {});
    await peer.request('thread/resume', { threadId: o.threadId, cwd: o.cwd, approvalPolicy: 'never', sandbox: 'read-only', excludeTurns: true }, 60_000);
    try {
      await peer.request('thread/compact/start', { threadId: o.threadId }, 60_000);
    } catch (e: any) {
      if (e instanceof RpcError && (e.code === -32601 || /unknown|not found|unsupported/i.test(e.message))) return { compacted: false, unsupported: true, reason: 'Deze Codex-versie kan niet samenvatten op verzoek.' };
      throw e;
    }
    const r = await Promise.race([finished, new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), timeoutMs).unref?.())]);
    if (r === 'done') return { compacted: true, postTokens: post };
    return { compacted: false, reason: failure || (r === 'timeout' ? 'Codex was na 5 minuten nog niet klaar met samenvatten.' : proc.killedReason || proc.stderrTail().slice(-300) || 'Codex heeft niet samengevat') };
  } catch (e: any) {
    return { compacted: false, reason: String(e?.message || e).slice(0, 300) };
  } finally {
    ctl.abort();
    await proc.done;
  }
}
