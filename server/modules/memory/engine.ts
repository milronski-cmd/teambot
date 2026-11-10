/**
 * Learning engine: the memory module's own rules for the short model call ("leer-motor"; agent/short-call.ts chooses,
 * runs and logs it), on an engine the owner already pays nothing extra for. Order of preference:
 *   1. the engine the owner picked in Geheugen › Opslag (if it is free, or paid use was explicitly allowed);
 *   2. the bot's own engine when it costs nothing extra: Claude Code / Codex on a subscription login, OpenCode with a
 *      free model, a local model (Ollama, LM Studio) or a free API tier. With extractor "own" (the default since 0.4.5,
 *      as OpenBot does) with the bot's own model — the one it answers with — also when the bot sets none (then the
 *      CLI's own default); with "free" a light model (Claude Code: haiku);
 *   3. any other such engine the owner has connected (the fallback, with a light model).
 * Paid API keys are only used with extractor "model" (explicit opt-in, as before).
 *
 * Memory reads the owner's own messages, so a CLI engine does not answer through its normal one-shot but through the
 * isolated one of this file: non-interactive, without tools, sessions or the user's own MCP servers/settings, in an
 * empty working folder: Claude Code `-p --tools "" --safe-mode --no-session-persistence`, Codex `exec --ephemeral
 * --ignore-user-config` with its shell and app features disabled, OpenCode `run --standalone` with every tool denied
 * and its own HOME/XDG folders inside TeamBot's data dir (the owner's own OpenCode database is never touched).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Agent } from '../../core/types.js';
import { newId } from '../../core/db.js';
import { redact } from '../../core/secrets.js';
import { isBudgetError } from '../../agent/budget.js';
import { judgeEngine, pickShortEngine, runShortCall, type PickOptions, type RawAnswer, type ShortBilling, type ShortEngine, type ShortResult } from '../../agent/short-call.js';
import { findBinary, runQuick, startProc } from '../cli-agents/proc.js';
import type { MemoryService } from './service.js';

export class EngineError extends Error {
  constructor(
    message: string,
    public retryAfterMs = 0,
  ) {
    super(message);
  }
}

/** Default models for CLI engines: a fast model is plenty for extraction and keeps subscription limits light. */
const CLI_DEFAULT_MODEL: Record<string, string> = { 'claude-code': 'haiku', 'codex-cli': 'default', opencode: 'opencode/big-pickle' };
const FREE_OPENCODE = /^opencode\/(?:.+-free|big-pickle)$/i;

const BILLING_LABEL: Record<ShortBilling, string> = { subscription: 'abonnement, geen extra kosten', free: 'gratis model', local: 'lokaal, gratis', paid: 'betaald per gebruik' };

/** Engines that are temporarily unavailable (free-tier limit, rate limit, not logged in), per provider. */
const backoff = new Map<string, { until: number; reason: string }>();

export function engineBackoff(providerId: string) {
  const b = backoff.get(providerId);
  if (b && b.until > Date.now()) return b;
  if (b) backoff.delete(providerId);
  return null;
}

export function setBackoff(providerId: string, ms: number, reason: string) {
  backoff.set(providerId, { until: Date.now() + Math.max(60_000, Math.min(ms, 26 * 3600_000)), reason: reason.slice(0, 200) });
}

/**
 * How memory judges engines for this user: only without extra cost unless `allowPaid`, a free API tier only with a free
 * model from a source that keeps nothing, and the three CLIs through the isolated one-shot below (the owner's own
 * login, installed and logged in; `ownModel`: the bot's own engine with its own model instead of a light one).
 */
async function memoryRules(svc: MemoryService, userId: string, allowPaid: boolean, ownModel: boolean): Promise<PickOptions> {
  const kinds = [...new Set(svc.ctx.providers.list(userId).map((p) => p.kind))].filter((k) => k in CLI_DEFAULT_MODEL);
  const status = new Map<string, any>();
  await Promise.all(
    kinds.map(async (k) => {
      try {
        status.set(k, await svc.ctx.services['cli-agents']?.status?.(k));
      } catch {
        /* unknown: judged by the configured path alone */
      }
    }),
  );
  return {
    userId,
    allowPaid,
    privacy: 'no-store',
    checkFreeTier: true,
    cli(cfg, model, source) {
      if (!(cfg.kind in CLI_DEFAULT_MODEL) || cfg.user_id !== userId) return null; // CLI logins are personal
      const st = status.get(cfg.kind);
      const bin = (cfg.config?.path && fs.existsSync(cfg.config.path) ? cfg.config.path : null) || st?.path || null;
      if (!bin || st?.installed === false || st?.loggedIn === false) return null;
      if (cfg.kind === 'opencode') return { billing: 'free', bin, model: [model, cfg.config?.defaultModel].find((x) => x && FREE_OPENCODE.test(x)) || CLI_DEFAULT_MODEL.opencode };
      // The bot's own model (0.4.5, extractor "own"): the one it answers with; without one the CLI's own default.
      return { billing: st?.billing === 'subscription' ? 'subscription' : 'paid', bin, model: model && model !== 'default' ? model : ownModel && source === 'own' ? 'default' : CLI_DEFAULT_MODEL[cfg.kind] };
    },
  };
}

/** The label memory shows: the engine, and in words what it costs. */
const labelled = (e: ShortEngine): ShortEngine => ({ ...e, label: `${e.label} (${BILLING_LABEL[e.billing]})` });

/**
 * Pick the learning engine for a user (and optionally the bot whose conversation is being learned from).
 * mode "free": only engines without extra cost; mode "model": the bot's own engine even when it is paid (opt-in).
 */
export async function pickEngine(svc: MemoryService, userId: string, agent: Agent | null, mode: 'free' | 'model'): Promise<ShortEngine | null> {
  const s = svc.userSettings(userId);
  // The bot's own model only for a bot's conversation; maintenance without a bot keeps the light model.
  const rules = await memoryRules(svc, userId, mode === 'model', s.extractor !== 'free' && !!agent);
  const e = pickShortEngine(svc.ctx, { ...rules, agent, explicit: s.engine?.providerId ? { providerId: s.engine.providerId, model: s.engine.model } : null, others: true, usable: (cfg) => !engineBackoff(cfg.id) });
  return e && labelled(e);
}

/** All engines the owner could pick for memory (for the settings screen). */
export async function engineOptions(svc: MemoryService, userId: string) {
  const out: { providerId: string; label: string; billing: ShortBilling; model: string; available: boolean; reason?: string }[] = [];
  const rules = await memoryRules(svc, userId, true, false);
  for (const cfg of svc.ctx.providers.list(userId)) {
    const c = judgeEngine(svc.ctx, rules, { providerId: cfg.id }, 'explicit').engine;
    if (!c) continue;
    const b = engineBackoff(cfg.id);
    out.push({ providerId: cfg.id, label: labelled(c).label, billing: c.billing, model: c.model, available: !b, reason: b?.reason });
  }
  return out;
}

// ------------------------------------------------------------------ the isolated CLI one-shot

function workDir(svc: MemoryService, sub: string) {
  const d = path.join(svc.ctx.config.dataDir, 'memory', sub);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

const helpCache = new Map<string, string>();
async function helpText(bin: string, args: string[] = ['--help']) {
  const k = bin + ' ' + args.join(' ');
  if (helpCache.has(k)) return helpCache.get(k)!;
  const r = await runQuick(bin, args, { timeoutMs: 15_000 });
  const t = (r.stdout + '\n' + r.stderr).slice(0, 200_000);
  helpCache.set(k, t);
  return t;
}

/** Claude Code: one turn, no tools, no session, no user settings/MCP/CLAUDE.md, our own system prompt. */
export function claudeOneShotArgs(o: { model: string; systemFile: string; help: string }): string[] {
  const h = o.help;
  const a = ['-p', '--output-format', 'json', '--max-turns', '1', '--strict-mcp-config'];
  if (/--no-session-persistence/.test(h)) a.push('--no-session-persistence');
  if (/--tools\s/.test(h)) a.push('--tools', '');
  else a.push('--disallowedTools', 'Bash,PowerShell,Edit,MultiEdit,Write,NotebookEdit,Read,Glob,Grep,WebFetch,WebSearch,Task,Agent');
  if (/--safe-mode/.test(h)) a.push('--safe-mode');
  if (/--disable-slash-commands/.test(h)) a.push('--disable-slash-commands');
  if (/"dontAsk"/.test(h)) a.push('--permission-mode', 'dontAsk');
  if (/--permission-prompts/.test(h)) a.push('--permission-prompts', 'none');
  if (/--system-prompt-file|--system-prompt\[-file\]/.test(h)) a.push('--system-prompt-file', o.systemFile);
  if (o.model && o.model !== 'default') a.push('--model', o.model);
  return a;
}

/** Codex: `exec`, ephemeral, without the user's config/rules, read-only sandbox, shell and app features off. */
export function codexOneShotArgs(o: { model: string; cwd: string; features: string }): string[] {
  const off = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'remote_plugin', 'browser_use', 'browser_use_external', 'in_app_browser', 'computer_use', 'image_generation', 'view_image', 'multi_agent', 'goals', 'sleep_tool', 'hooks', 'code_mode_host', 'enable_mcp_apps'];
  const known = new Set(o.features.split(/\r?\n/).map((l) => l.trim().split(/\s+/)[0]).filter(Boolean));
  const a = ['exec', '--json', '--skip-git-repo-check', '--color', 'never', '--ephemeral', '--ignore-user-config', '--ignore-rules', '-C', o.cwd, '-s', 'read-only', '-c', 'approval_policy="never"', '-c', 'web_search="disabled"'];
  for (const f of off) if (!known.size || known.has(f)) a.push('--disable', f);
  if (o.model && o.model !== 'default') a.push('-m', o.model);
  a.push('-');
  return a;
}

/** OpenCode: isolated HOME/XDG in TeamBot's data dir, private server, every tool denied, our own agent prompt. */
export function openCodeOneShot(o: { home: string; model: string; system: string }): { args: string[]; env: Record<string, string> } {
  const d = (s: string) => path.join(o.home, s);
  const cfg = {
    autoupdate: false,
    share: 'disabled',
    permission: { '*': 'deny' },
    tools: { '*': false },
    agent: { teambot_geheugen: { mode: 'primary', prompt: o.system, tools: { '*': false }, permission: { '*': 'deny' } } },
  };
  return {
    args: ['run', '--standalone', '--format', 'json', '-m', o.model, '--agent', 'teambot_geheugen'],
    env: {
      XDG_DATA_HOME: d('data'),
      XDG_CONFIG_HOME: d('config'),
      XDG_STATE_HOME: d('state'),
      XDG_CACHE_HOME: d('cache'),
      HOME: d('home'),
      USERPROFILE: d('home'),
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_CONFIG_CONTENT: JSON.stringify(cfg),
      NO_COLOR: '1',
    },
  };
}

/** Run a CLI with the prompt on stdin, collecting stdout lines. */
async function runCli(bin: string, args: string[], o: { cwd: string; env?: Record<string, string>; stdin: string; timeoutMs: number; signal?: AbortSignal }) {
  const lines: string[] = [];
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  o.signal?.addEventListener('abort', onAbort, { once: true });
  const p = startProc({ bin, args, cwd: o.cwd, env: { NO_COLOR: '1', ...(o.env || {}) }, signal: ac.signal, timeoutMs: o.timeoutMs, idleMs: o.timeoutMs, onLine: (l) => lines.push(l) });
  p.write(o.stdin);
  p.end();
  const exit = await p.done;
  o.signal?.removeEventListener('abort', onAbort);
  return { lines, exit, stderr: p.stderrTail(), killed: p.killedReason };
}

function limitError(text: string, def: number): EngineError | null {
  if (/free usage limit|free-limit|usage limit|rate limit|limit reached|out of extra usage|429|quota/i.test(text)) return new EngineError('Gebruikslimiet van dit model bereikt', def);
  if (/not logged in|login required|unauthenticated|please run .*login|invalid api key|authentication/i.test(text)) return new EngineError('Niet ingelogd', 6 * 3600_000);
  return null;
}

const jsonLine = (l: string): any => {
  try {
    return JSON.parse(l);
  } catch {
    return null;
  }
};

/** One answer of a CLI engine through its isolated one-shot, with the tokens and cost the CLI itself reports. */
async function cliOneShot(svc: MemoryService, choice: ShortEngine, system: string, prompt: string, o: { timeoutMs: number; signal?: AbortSignal }): Promise<RawAnswer> {
  const bin = choice.bin || findBinary([choice.providerKind === 'claude-code' ? 'claude' : choice.providerKind === 'codex-cli' ? 'codex' : 'opencode']);
  if (!bin) throw new EngineError('Programma niet gevonden', 3600_000);
  const tmp = path.join(workDir(svc, 'engine-runs'), newId('run_'));
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  try {
    if (choice.providerKind === 'claude-code') {
      const systemFile = path.join(tmp, 'system.md');
      fs.writeFileSync(systemFile, system, { mode: 0o600 });
      const args = claudeOneShotArgs({ model: choice.model, systemFile, help: await helpText(bin) });
      const r = await runCli(bin, args, { cwd: tmp, stdin: (args.includes('--system-prompt-file') ? '' : system + '\n\n') + prompt, ...o });
      const out = r.lines.map(jsonLine).find((j: any) => j?.type === 'result');
      if (r.killed) throw new EngineError(r.killed);
      if (!out) throw limitError(r.stderr + r.lines.join('\n'), 3600_000) || new EngineError(`Claude Code gaf geen antwoord (${r.exit.error || `exitcode ${r.exit.code}`})${r.stderr ? ': ' + redact(r.stderr).slice(-300) : ''}`);
      if (out.is_error || String(out.subtype || '').startsWith('error')) throw limitError(String(out.result || '') + ' ' + (out.api_error_status || ''), 3600_000) || new EngineError(`Claude Code: ${redact(String(out.result || out.subtype || 'fout')).slice(0, 300)}`);
      const u = out.usage || {};
      const cacheRead = Number(u.cache_read_input_tokens) || 0;
      const listed = Number(out.total_cost_usd) || 0;
      return {
        text: String(out.result || ''),
        usage: { input: (Number(u.input_tokens) || 0) + cacheRead + (Number(u.cache_creation_input_tokens) || 0), output: Number(u.output_tokens) || 0, cacheRead },
        model: Object.keys(out.modelUsage || {})[0] || choice.model,
        // On a subscription the call costs nothing extra; what it would have cost at list price is kept as its value.
        cost: choice.billing === 'subscription' ? 0 : listed,
        ...(choice.billing === 'subscription' && listed > 0 ? { value: listed } : {}),
      };
    }
    if (choice.providerKind === 'codex-cli') {
      const features = await helpText(bin, ['features', 'list']);
      const r = await runCli(bin, codexOneShotArgs({ model: choice.model, cwd: tmp, features }), { cwd: tmp, stdin: `${system}\n\n---\n\n${prompt}`, ...o });
      let text = '';
      let failed = '';
      const usage = { input: 0, output: 0, cacheRead: 0 };
      for (const m of r.lines.map(jsonLine)) {
        if (!m) continue;
        if (m.type === 'item.completed' && m.item?.type === 'agent_message') text += (text ? '\n' : '') + String(m.item.text || '');
        else if (m.type === 'turn.completed') {
          usage.input += Number(m.usage?.input_tokens) || 0;
          usage.output += (Number(m.usage?.output_tokens) || 0) + (Number(m.usage?.reasoning_output_tokens) || 0);
          usage.cacheRead += Number(m.usage?.cached_input_tokens) || 0;
        } else if (m.type === 'turn.failed' || m.type === 'error') failed = String(m.error?.message || m.message || 'Codex-fout');
      }
      if (r.killed) throw new EngineError(r.killed);
      if (failed || (!text && r.exit.code !== 0)) throw limitError(failed + ' ' + r.stderr, 3600_000) || new EngineError(`Codex: ${redact(failed || r.stderr || `exitcode ${r.exit.code}`).slice(0, 300)}`);
      // Codex reports no cost: on a pay-per-use login it comes from the price list (null).
      return { text, usage, model: choice.model, cost: choice.billing === 'subscription' ? 0 : null };
    }
    // OpenCode
    const home = workDir(svc, 'opencode');
    for (const d of ['data', 'config', 'state', 'cache', 'home']) fs.mkdirSync(path.join(home, d), { recursive: true, mode: 0o700 });
    const oc = openCodeOneShot({ home, model: choice.model, system });
    const r = await runCli(bin, oc.args, { cwd: tmp, env: oc.env, stdin: prompt, ...o });
    let text = '';
    let cost = 0;
    const usage = { input: 0, output: 0, cacheRead: 0 };
    for (const m of r.lines.map(jsonLine)) {
      if (!m) continue;
      if (m.type === 'text' && m.part?.text) text += m.part.text;
      else if (m.type === 'step_finish') {
        const t = m.part?.tokens || {};
        usage.input += Number(t.input) || 0;
        usage.output += (Number(t.output) || 0) + (Number(t.reasoning) || 0);
        usage.cacheRead += Number(t.cache?.read) || 0;
        cost += Number(m.part?.cost) || 0;
      } else if (m.type === 'error') {
        const e = m.error || {};
        const msg = String(e.message || e.type || 'OpenCode-fout');
        if (/free-limit|rate|429/i.test(String(e.type || '') + ' ' + (e.status || ''))) throw new EngineError(`OpenCode: ${msg}`, Number(e.retryAfterMs) || 3600_000);
        throw new EngineError(`OpenCode: ${redact(msg).slice(0, 300)}`);
      }
    }
    if (r.killed) throw new EngineError(r.killed);
    if (!text) throw limitError(r.stderr, 3600_000) || new EngineError(`OpenCode gaf geen antwoord${r.stderr ? ': ' + redact(r.stderr).slice(-300) : ''}`);
    return { text, usage, model: choice.model, cost };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * One model call on the chosen engine, written to the usage log. Throws EngineError on failure; an engine at its limit
 * rests for a while (back-off), so the next pick takes another one.
 */
export async function runEngine(svc: MemoryService, choice: ShortEngine, req: { userId: string; agentId?: string | null; system: string; prompt: string; timeoutMs?: number; signal?: AbortSignal; maxTokens?: number }): Promise<ShortResult> {
  try {
    return await runShortCall(svc.ctx, choice, { ...req, timeoutMs: req.timeoutMs ?? 120_000, ...(choice.type === 'cli' ? { transport: (o) => cliOneShot(svc, choice, req.system, req.prompt, o) } : {}) });
  } catch (e: any) {
    // Our own daily budget is not a limit of the engine: it does not rest for it.
    const err = e instanceof EngineError ? e : (!isBudgetError(e) && limitError(String(e?.message || e), 30 * 60_000)) || new EngineError(String(e?.message || e).slice(0, 300));
    if (err.retryAfterMs) setBackoff(choice.providerId, err.retryAfterMs, err.message);
    throw err;
  }
}
