import fs from 'node:fs';
import { APP_VERSION } from '../../core/config.js';
import { runQuick, startProc } from './proc.js';
import { RpcPeer } from './rpc.js';
import { parseClaudeUsageText, parseCodexRateLimits, parseOpencodeStats, type LimitReport } from '../usage/parse.js';

/**
 * Read usage limits from the user's own CLI logins, without a prompt and without reading private files:
 *  - Claude Code: the local `/usage` command in print mode (no model call, cost 0; verified with 2.1.319).
 *  - Codex: `codex app-server` → `account/read` + `account/rateLimits/read` (no thread, no turn).
 *  - OpenCode: `opencode stats --days 0 --json` (tokens/cost of today; OpenCode reports no limits).
 */

const CLAUDE_USAGE_ARGS = ['-p', '--output-format', 'stream-json', '--verbose', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--max-turns', '1'];

export interface ClaudeUsageRead {
  report: LimitReport | null;
  /** false when this Claude Code version has no `/usage` in print mode (then TeamBot stops asking). */
  supported: boolean;
  error?: string;
}

export async function readClaudeUsage(bin: string, cwd: string, tz: string, timeoutMs = 60_000): Promise<ClaudeUsageRead> {
  fs.mkdirSync(cwd, { recursive: true });
  let text = '';
  let local = '';
  let slash: string[] | null = null;
  let err = '';
  const ctl = new AbortController();
  const proc = startProc({
    bin,
    args: CLAUDE_USAGE_ARGS,
    cwd,
    env: { NO_COLOR: '1' },
    signal: ctl.signal,
    timeoutMs,
    idleMs: timeoutMs,
    onLine: (l) => {
      let m: any;
      try {
        m = JSON.parse(l);
      } catch {
        return;
      }
      if (m.type === 'system' && m.subtype === 'init' && Array.isArray(m.slash_commands)) slash = m.slash_commands.map(String);
      else if (m.type === 'result') {
        if (typeof m.local_command === 'string') local = m.local_command;
        if (typeof m.result === 'string') text = m.result;
        if (m.is_error) err = String(m.result || m.subtype || 'fout').slice(0, 300);
      }
    },
  });
  proc.write('/usage');
  proc.end();
  const exit = await proc.done;
  const known = slash as string[] | null;
  if (known && !known.includes('usage')) return { report: null, supported: false, error: 'Deze versie van Claude Code heeft geen /usage in de niet-interactieve modus.' };
  if (!text) return { report: null, supported: true, error: err || proc.killedReason || proc.stderrTail().slice(-300) || `Claude Code stopte (exitcode ${exit.code})` };
  // Not answered by the local command (e.g. sent to the model by an old version): do not try again.
  if (local && local !== 'usage') return { report: null, supported: false };
  return { report: parseClaudeUsageText(text, Date.now(), tz), supported: true, error: err || undefined };
}

export async function readCodexLimits(bin: string, cwd: string, timeoutMs = 30_000): Promise<{ report: LimitReport | null; error?: string; apiKey?: boolean }> {
  fs.mkdirSync(cwd, { recursive: true });
  const ctl = new AbortController();
  let peer!: RpcPeer;
  const proc = startProc({ bin, args: ['app-server'], cwd, env: { NO_COLOR: '1' }, signal: ctl.signal, timeoutMs, idleMs: timeoutMs, onLine: (l) => peer.handleLine(l) });
  peer = new RpcPeer(proc, { jsonrpcField: false });
  proc.done.then(() => peer.close('gestopt'));
  try {
    await peer.request('initialize', { clientInfo: { name: 'teambot', title: 'TeamBot', version: APP_VERSION }, capabilities: { experimentalApi: false, requestAttestation: false } }, 20_000);
    peer.notify('initialized', {});
    let plan: string | undefined;
    let apiKey = false;
    try {
      const a: any = await peer.request('account/read', {}, 15_000);
      if (a?.account?.type === 'apiKey') apiKey = true;
      else if (a?.account?.planType) plan = String(a.account.planType);
    } catch {
      /* older Codex: no account/read */
    }
    if (apiKey) return { report: { windows: [], billing: 'api', source: 'app-server', at: Date.now(), note: 'Codex gebruikt een API-sleutel: betalen per gebruik, geen abonnementslimiet.' }, apiKey };
    const r: any = await peer.request('account/rateLimits/read', { excludeResetCreditDetails: true }, 20_000);
    const report = parseCodexRateLimits(r);
    if (report && !report.plan && plan && plan !== 'unknown') report.plan = `ChatGPT ${plan.charAt(0).toUpperCase()}${plan.slice(1)}`;
    return { report };
  } catch (e: any) {
    return { report: null, error: String(e?.message || e).slice(0, 300) };
  } finally {
    ctl.abort();
    await proc.done;
  }
}

export async function readOpencodeStats(bin: string, cwd: string) {
  // --standalone (OpenCode 2.x, TeamBot's own copy): otherwise `stats` starts or joins the shared background service
  // (another OpenCode, e.g. OpenBot's, may hold its port). 1.x does not know the flag: then again without it.
  let r = await runQuick(bin, ['stats', '--standalone', '--days', '0', '--json'], { timeoutMs: 45_000, cwd });
  if (!r.stdout.includes('{')) r = await runQuick(bin, ['stats', '--days', '0', '--json'], { timeoutMs: 45_000, cwd });
  try {
    return parseOpencodeStats(JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))));
  } catch {
    return null;
  }
}

export interface CompactResult {
  compacted: boolean;
  reason?: string;
  /** Context after compaction (tokens), when Claude Code reports it. */
  postTokens?: number;
  preTokens?: number;
}

/** Claude Code's own `/compact` on the bot's session for this chat (same working folder, no tools, no MCP). */
export async function compactClaudeSession(o: { bin: string; cwd: string; sessionId: string; model?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<CompactResult> {
  const args = ['-p', '--resume', o.sessionId, '--output-format', 'stream-json', '--verbose', '--tools', '', '--strict-mcp-config', '--max-turns', '1'];
  if (o.model && o.model !== 'default' && /^[\w.:\-[\]]{1,80}$/.test(o.model)) args.push('--model', o.model);
  let meta: any = null;
  let ok: boolean | null = null;
  let err = '';
  const proc = startProc({
    bin: o.bin,
    args,
    cwd: o.cwd,
    env: { NO_COLOR: '1' },
    signal: o.signal || new AbortController().signal,
    timeoutMs: o.timeoutMs ?? 5 * 60_000,
    idleMs: o.timeoutMs ?? 5 * 60_000,
    onLine: (l) => {
      let m: any;
      try {
        m = JSON.parse(l);
      } catch {
        return;
      }
      if (m.type === 'system' && m.subtype === 'compact_boundary') meta = m.compact_metadata || {};
      else if (m.type === 'system' && m.subtype === 'status' && m.compact_result) ok = m.compact_result === 'success';
      else if (m.type === 'result' && m.is_error) err = String(m.result || m.subtype || '').slice(0, 300);
    },
  });
  proc.write('/compact');
  proc.end();
  await proc.done;
  if (meta || ok) return { compacted: true, preTokens: Number(meta?.pre_tokens) || undefined, postTokens: Number(meta?.post_tokens) || undefined };
  return { compacted: false, reason: err || proc.killedReason || proc.stderrTail().slice(-300) || 'Claude Code heeft niet samengevat' };
}
