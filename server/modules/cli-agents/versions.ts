import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Ctx } from '../../core/types.js';
import { ah, bad } from '../../core/http.js';
import { APP_VERSION } from '../../core/config.js';
import { defById, type CliDef } from './catalog.js';
import { parseVersion, runQuick, startProc } from './proc.js';
import { RpcPeer } from './rpc.js';
import { ACP_PROTOCOL_VERSION, startLock } from './acp.js';
import { RUNTIMES, newer } from './runtimes.js';

/**
 * Engine versions (package N, plan G "Motorversies vastzetten"). Claude Code, Codex and OpenCode update themselves or
 * are updated by their owner at any time; a new version can drop a flag TeamBot relies on. So TeamBot:
 *  - knows the versions it was tested with (the pinned versions of its own copies, runtimes.ts) and remembers every
 *    version that passed its own check on this computer ("known good");
 *  - notices when the installed version changes and says so plainly ("Claude Code is bijgewerkt naar x; nog niet
 *    getest met TeamBot");
 *  - runs a cheap self-check that costs no model quota: `--version`, the options TeamBot uses (`--help`), and the
 *    start-up handshake of the protocol TeamBot speaks (Codex app-server `initialize`, ACP `initialize`); no session,
 *    no prompt;
 *  - on a failure shows the exact command to go back to the known-good version. It never updates or downgrades the
 *    owner's own (global) CLI itself; the only one-click way back is TeamBot's own copy (verified install of the
 *    version TeamBot tested), which bots then use instead.
 * State per computer in `<data>/cli-agents/engine-versions.json` (never part of a backup: it is about this machine).
 */

export const PINNED_ENGINES = ['claude-code', 'codex-cli', 'opencode'] as const;
export type EngineId = (typeof PINNED_ENGINES)[number];
export const isPinnedEngine = (id: string): id is EngineId => (PINNED_ENGINES as readonly string[]).includes(id);

export interface CheckStep {
  id: string;
  label: string;
  ok: boolean;
  /** A missing extra that TeamBot works around: shown, but the check still passes. */
  optional?: boolean;
  detail?: string;
}

export interface CheckResult {
  version: string;
  at: string;
  ok: boolean;
  ms: number;
  steps: CheckStep[];
}

export interface EngineRecord {
  version?: string;
  path?: string;
  source?: string;
  seenAt?: string;
  /** The version before the last change. */
  previous?: string;
  changedAt?: string;
  /** Versions that passed the self-check on this computer (oldest first, at most 8). */
  good?: string[];
  /** Last self-check, for `check.version`. */
  check?: CheckResult;
  /** The owner chose to keep using this version although its check failed. */
  accepted?: string;
}

interface StatusLike {
  installed: boolean;
  version?: string;
  path?: string;
  pathSource?: string;
  pathApp?: string;
}

export interface CliLike {
  status(def: CliDef, cfg?: any, fresh?: boolean): Promise<StatusLike>;
}

export interface VersionOptions {
  /** Delay before the self-check after a change was noticed (the CLI may still be busy updating itself). */
  checkDelayMs?: number;
  /** Time-outs of the handshakes. */
  handshakeMs?: number;
  /** Tested versions (tests: fixture versions). */
  tested?: Partial<Record<EngineId, string>>;
}

/** Options of Claude Code that TeamBot cannot work without, and extras it works around when they are missing. */
const CLAUDE_REQUIRED = ['--output-format', 'stream-json', '--resume', '--permission-mode', '--mcp-config', '--permission-prompt-tool', '--allowedTools', '--disallowedTools'];
const CLAUDE_EXTRAS = ['--append-system-prompt-file', '--strict-mcp-config', '--restricted', '--include-partial-messages', '--permission-prompts', '--tools'];
const CODEX_REQUIRED = ['--json', '--sandbox', '--skip-git-repo-check'];

const STATE_LABEL = {
  getest: 'Getest met TeamBot',
  werkt: 'Eigen test geslaagd',
  nieuw: 'Nog niet getest met TeamBot',
  mislukt: 'Eigen test mislukt',
  akkoord: 'Toch in gebruik (jouw keuze)',
  onbekend: 'Nog niet getest met TeamBot',
  ontbreekt: 'Niet gevonden',
} as const;
export type EngineState = keyof typeof STATE_LABEL;

export class EngineVersions {
  private file: string;
  private timers = new Map<EngineId, NodeJS.Timeout>();
  private running = new Map<EngineId, Promise<CheckResult | null>>();
  private periodic: NodeJS.Timeout | null = null;
  private firstScan: NodeJS.Timeout | null = null;
  private o: Required<Omit<VersionOptions, 'tested'>> & { tested: Partial<Record<EngineId, string>> };

  constructor(
    private ctx: Ctx,
    private cli: CliLike,
    o: VersionOptions = {},
  ) {
    this.file = path.join(ctx.config.dataDir, 'cli-agents', 'engine-versions.json');
    this.o = { checkDelayMs: o.checkDelayMs ?? 30_000, handshakeMs: o.handshakeMs ?? 60_000, tested: o.tested || {} };
  }

  /** The version TeamBot was tested with (the pinned version of its own copy). */
  tested(id: EngineId): string {
    return this.o.tested[id] || RUNTIMES[id].pinned;
  }

  read(): Partial<Record<EngineId, EngineRecord>> {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return j?.engines && typeof j.engines === 'object' ? j.engines : {};
    } catch {
      return {};
    }
  }

  private write(all: Partial<Record<EngineId, EngineRecord>>) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ engines: all }, null, 1));
    fs.renameSync(this.file + '.tmp', this.file);
  }

  private patch(id: EngineId, fn: (r: EngineRecord) => void): EngineRecord {
    const all = this.read();
    const r = all[id] || {};
    fn(r);
    all[id] = r;
    this.write(all);
    return r;
  }

  /**
   * Called with every status TeamBot reads of a CLI (the default binary, not a provider's own path). The first
   * sighting is only recorded; a different version than last time is a change: told to the owner, and checked.
   */
  observe(def: CliDef, st: StatusLike) {
    if (!isPinnedEngine(def.id) || !st.installed || !st.version) return;
    const id = def.id;
    const v = st.version;
    const prev = this.read()[id];
    if (prev?.version === v && prev.path === st.path) return;
    // Bijgewerkt: the same program (same path, or TeamBot's own copy that moved to a new version folder). A switch to
    // another binary (e.g. from the global CLI to TeamBot's own copy) is recorded without a "bijgewerkt" message.
    const changed = !!prev?.version && prev.version !== v && (prev.path === st.path || (prev.source === 'teambot' && st.pathSource === 'teambot'));
    this.patch(id, (r) => {
      if (changed) {
        r.previous = prev!.version;
        r.changedAt = new Date().toISOString();
      }
      r.version = v;
      r.path = st.path;
      r.source = st.pathSource;
      r.seenAt = new Date().toISOString();
    });
    if (!changed) return;
    const owner = this.ctx.auth.owner();
    if (owner) {
      this.ctx.audit(owner.id, 'cli.version_changed', { cli: id, from: prev!.version, to: v });
      const tested = v === this.tested(id);
      this.ctx.events.emit(owner.id, 'notification', {
        title: `${def.label} is bijgewerkt naar ${v}`,
        body: tested ? 'Dit is de versie waarmee TeamBot getest is.' : 'Nog niet getest met TeamBot. TeamBot doet zo een korte eigen test; die kost geen tegoed.',
        link: '#/settings/cli-agents-cli',
        kind: 'system',
      });
      this.ctx.events.emit(owner.id, 'cli.versions', { id });
    }
    this.scheduleCheck(id, 'change');
  }

  private scheduleCheck(id: EngineId, why: 'change') {
    clearTimeout(this.timers.get(id));
    const t = setTimeout(() => {
      this.timers.delete(id);
      void this.check(id, { why }).catch(() => {});
    }, this.o.checkDelayMs);
    t.unref?.();
    this.timers.set(id, t);
  }

  /** Wait for checks that are scheduled or running (tests). */
  async idle() {
    while (this.timers.size || this.running.size) {
      await Promise.all([...this.running.values()].map((p) => p.catch(() => null)));
      if (this.timers.size && !this.running.size) await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** The self-check of one engine; one at a time per engine. Costs no model quota. */
  check(id: EngineId, o: { why?: 'change' | 'manual' } = {}): Promise<CheckResult | null> {
    const cur = this.running.get(id);
    if (cur) return cur;
    const p = this.doCheck(id, o).finally(() => this.running.delete(id));
    this.running.set(id, p);
    return p;
  }

  private async doCheck(id: EngineId, o: { why?: 'change' | 'manual' }): Promise<CheckResult | null> {
    const def = defById(id);
    if (!def) return null;
    const st = await this.cli.status(def, null, true);
    if (!st.installed || !st.path) return null;
    const started = Date.now();
    const steps = await selfCheck(def, st.path, { handshakeMs: this.o.handshakeMs });
    const version = st.version || parseVersion(steps.find((s) => s.id === 'version')?.detail || '') || '';
    const ok = steps.every((s) => s.ok || s.optional);
    const res: CheckResult = { version, at: new Date().toISOString(), ok, ms: Date.now() - started, steps };
    const rec = this.patch(id, (r) => {
      r.check = res;
      if (ok && version) r.good = [...(r.good || []).filter((g) => g !== version), version].slice(-8);
      if (r.accepted && r.accepted !== version) delete r.accepted;
    });
    const owner = this.ctx.auth.owner();
    if (owner) {
      this.ctx.audit(owner.id, 'cli.version_check', { cli: id, version, ok });
      this.ctx.events.emit(owner.id, 'cli.versions', { id });
      if (!ok && o.why === 'change') {
        const fail = steps.find((s) => !s.ok && !s.optional);
        const back = this.rollback(id, rec);
        this.ctx.events.emit(owner.id, 'notification', {
          title: `${def.label} ${version} werkt niet goed met TeamBot`,
          body: `${fail ? `${fail.label}: ${fail.detail || 'mislukt'}. ` : ''}${back.command ? `Terug naar ${back.target}: ${back.command}` : back.note}`,
          link: '#/settings/cli-agents-cli',
          kind: 'warning',
        });
      }
    }
    return res;
  }

  /** The owner keeps using a version whose check failed (no more warnings for this version). */
  accept(id: EngineId) {
    const r = this.read()[id];
    if (!r?.version) throw bad('Geen versie om te accepteren');
    this.patch(id, (x) => {
      x.accepted = r.version;
    });
    const owner = this.ctx.auth.owner();
    if (owner) this.ctx.audit(owner.id, 'cli.version_accepted', { cli: id, version: r.version });
  }

  state(id: EngineId, r: EngineRecord | undefined, installed: boolean): EngineState {
    if (!installed || !r?.version) return 'ontbreekt';
    const c = r.check && r.check.version === r.version ? r.check : null;
    if (c && !c.ok) return r.accepted === r.version ? 'akkoord' : 'mislukt';
    if (r.version === this.tested(id)) return 'getest';
    if (c?.ok || (r.good || []).includes(r.version)) return 'werkt';
    return r.previous ? 'nieuw' : 'onbekend';
  }

  /**
   * How to go back to a known-good version: the newest version that passed here (other than this one), else the
   * version TeamBot tested. TeamBot's own copy: one click (a verified install of the tested version). The owner's
   * own CLI: the exact command to run yourself; TeamBot never changes it.
   */
  rollback(id: EngineId, r?: EngineRecord): { target: string; command?: string; oneClick?: 'runtime'; note: string } {
    const rec = r || this.read()[id] || {};
    const tested = this.tested(id);
    const cur = rec.version || '';
    const good = [...(rec.good || [])].reverse().find((g) => g !== cur && !(rec.check && !rec.check.ok && rec.check.version === g));
    const def = defById(id)!;
    if (rec.source === 'teambot')
      return { target: tested, oneClick: 'runtime', note: `Dit is TeamBot's eigen kopie. Met één klik zet TeamBot de geteste versie ${tested} terug (gecontroleerd gedownload).` };
    if (rec.source === 'andere-app')
      return { target: tested, oneClick: 'runtime', note: `Deze kopie hoort bij een andere app; TeamBot wijzigt die niet. Installeer TeamBot's eigen kopie (getest: ${tested}); bots gebruiken die dan.` };
    const target = good || tested;
    const p = (rec.path || '').replace(/\\/g, '/').toLowerCase();
    const npm = /node_modules|\/npm\/|\.cmd$|\/\.npm-global\//.test(p);
    let command: string;
    let note = `TeamBot verandert je eigen ${def.label} nooit zelf. Voer dit uit in een terminal om terug te gaan naar ${target}.`;
    if (id === 'claude-code') {
      if (npm) command = `npm install -g @anthropic-ai/claude-code@${target}`;
      else if (/\/winget\//.test(p)) command = `winget install --id Anthropic.ClaudeCode --version ${target} --force`;
      else command = `claude install ${target}`;
      note += ' Zet daarna het automatisch bijwerken van Claude Code uit (omgevingsvariabele DISABLE_AUTOUPDATER=1), anders werkt hij zichzelf weer bij.';
    } else if (id === 'codex-cli') {
      command = `npm install -g @openai/codex@${target}`;
      if (!npm) note += ' (Codex is hier niet via npm geïnstalleerd; dit zet een npm-versie naast de huidige. Je kunt ook TeamBot\'s eigen kopie gebruiken.)';
    } else {
      command = `opencode upgrade v${target}`;
    }
    return { target, command, note: `${note} Of gebruik TeamBot's eigen kopie (getest: ${tested}).` };
  }

  /** For the settings page. */
  async view(fresh = false) {
    const all = this.read();
    const out = [];
    for (const id of PINNED_ENGINES) {
      const def = defById(id)!;
      const st = await this.cli.status(def, null, fresh).catch(() => ({ installed: false }) as StatusLike);
      const r = this.read()[id] || all[id];
      const state = this.state(id, r, st.installed);
      out.push({
        id,
        label: def.label,
        installed: st.installed,
        version: st.version || r?.version || null,
        path: st.path || null,
        source: st.pathSource || r?.source || null,
        tested: this.tested(id),
        state,
        stateLabel: STATE_LABEL[state],
        previous: r?.previous || null,
        changedAt: r?.changedAt || null,
        good: r?.good || [],
        check: r?.check && r.check.version === (st.version || r.version) ? r.check : null,
        accepted: r?.accepted === (st.version || r?.version),
        rollback: state === 'ontbreekt' ? null : this.rollback(id, r),
        newerThanTested: !!st.version && newer(st.version.split('-')[0], this.tested(id)),
      });
    }
    return out;
  }

  /** Look for changes now and then (90 s after start, then every 6 hours): a CLI can update itself at any time. */
  start() {
    this.stop();
    const scan = async () => {
      for (const id of PINNED_ENGINES) {
        const def = defById(id);
        if (def) await this.cli.status(def, null, true).catch(() => null);
      }
    };
    this.firstScan = setTimeout(() => void scan(), 90_000);
    this.periodic = setInterval(() => void scan(), 6 * 3600_000);
    this.firstScan.unref?.();
    this.periodic.unref?.();
  }

  stop() {
    if (this.firstScan) clearTimeout(this.firstScan);
    if (this.periodic) clearInterval(this.periodic);
    this.firstScan = null;
    this.periodic = null;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}

// ---------------------------------------------------------------- the self-check (no prompt, no session)

const missing = (help: string, flags: string[]) => flags.filter((f) => !help.includes(f));

/** The checks for one engine binary. Every step is free: version, help, login state, protocol handshake. */
export async function selfCheck(def: CliDef, bin: string, o: { handshakeMs?: number } = {}): Promise<CheckStep[]> {
  const steps: CheckStep[] = [];
  const v = await runQuick(bin, def.versionArgs, { timeoutMs: 20_000 });
  const version = parseVersion(v.stdout || v.stderr);
  steps.push({ id: 'version', label: 'Programma start en meldt zijn versie', ok: v.code === 0 && !!version, detail: version ? `versie ${version}` : v.error || `exitcode ${v.code}` });
  if (!steps[0].ok) return steps;
  const hs = o.handshakeMs ?? 60_000;
  if (def.engine === 'claude') {
    const h = await runQuick(bin, ['--help'], { timeoutMs: 20_000 });
    const help = h.stdout + h.stderr;
    const miss = missing(help, CLAUDE_REQUIRED);
    steps.push({ id: 'flags', label: 'Opties die TeamBot gebruikt', ok: !miss.length, detail: miss.length ? `ontbreekt: ${miss.join(', ')}` : `${CLAUDE_REQUIRED.length} opties aanwezig` });
    const extras = missing(help, CLAUDE_EXTRAS);
    if (extras.length) steps.push({ id: 'extras', label: 'Extra opties', ok: false, optional: true, detail: `ontbreekt: ${extras.join(', ')} (TeamBot werkt eromheen)` });
    const a = await runQuick(bin, ['auth', 'status', '--json'], { timeoutMs: 20_000 });
    let json = false;
    try {
      JSON.parse(a.stdout.slice(a.stdout.indexOf('{')));
      json = true;
    } catch {
      json = false;
    }
    steps.push({ id: 'auth', label: 'Inlogstatus lezen (zonder prompt)', ok: json, optional: true, detail: json ? 'leesbaar' : 'niet als JSON leesbaar; TeamBot kijkt dan naar de exitcode' });
  } else if (def.engine === 'codex') {
    const h = await runQuick(bin, ['exec', '--help'], { timeoutMs: 20_000 });
    const miss = missing(h.stdout + h.stderr, CODEX_REQUIRED);
    steps.push({ id: 'flags', label: 'Opties die TeamBot gebruikt', ok: !miss.length, detail: miss.length ? `ontbreekt bij "codex exec": ${miss.join(', ')}` : `${CODEX_REQUIRED.length} opties aanwezig` });
    steps.push(await handshake(bin, ['app-server'], { jsonrpc: false, label: 'App-server start en antwoordt', params: { clientInfo: { name: 'teambot', title: 'TeamBot', version: APP_VERSION }, capabilities: { experimentalApi: false, requestAttestation: false } }, accept: (r) => !!r && typeof r === 'object', timeoutMs: hs }));
  } else if (def.engine === 'acp') {
    const major = Number(version!.split('.')[0]);
    const args = def.legacy && major < def.legacy.below ? def.legacy.acpArgs : def.acpArgs || [];
    const unlock = await startLock(`${def.id}:${process.env.XDG_DATA_HOME || ''}`);
    try {
      steps.push(
        await handshake(bin, args, {
          jsonrpc: true,
          env: { NO_COLOR: '1', ...(def.acpEnv || {}) },
          label: 'ACP-verbinding start en antwoordt',
          params: { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'teambot', title: 'TeamBot', version: APP_VERSION } },
          accept: (r) => typeof r?.protocolVersion === 'number',
          timeoutMs: hs,
        }),
      );
    } finally {
      unlock();
    }
  }
  return steps;
}

/** Start the protocol server of a CLI, send `initialize`, stop it again. Nothing is opened or asked of a model. */
async function handshake(bin: string, args: string[], o: { jsonrpc: boolean; label: string; params: any; accept(r: any): boolean; timeoutMs: number; env?: Record<string, string> }): Promise<CheckStep> {
  const ctl = new AbortController();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-engine-check-'));
  let peer!: RpcPeer;
  const proc = startProc({ bin, args, cwd, env: o.env, signal: ctl.signal, timeoutMs: o.timeoutMs + 5000, idleMs: o.timeoutMs + 5000, onLine: (l) => peer.handleLine(l) });
  peer = new RpcPeer(proc, { jsonrpcField: o.jsonrpc });
  const exited = proc.done.then((r) => {
    peer.close(`het programma stopte (exitcode ${r.code ?? r.error ?? '?'})`);
    return r;
  });
  try {
    const r = await peer.request('initialize', o.params, o.timeoutMs);
    if (!o.accept(r)) return { id: 'handshake', label: o.label, ok: false, detail: 'onverwacht antwoord op initialize' };
    return { id: 'handshake', label: o.label, ok: true, detail: 'antwoordt op initialize' };
  } catch (e: any) {
    const tail = proc.stderrTail().split(/\r?\n/).filter(Boolean).pop() || '';
    return { id: 'handshake', label: o.label, ok: false, detail: `${String(e?.message || e).slice(0, 160)}${tail ? ` — ${tail.slice(0, 160)}` : ''}` };
  } finally {
    ctl.abort();
    proc.kill('klaar');
    await exited;
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

/** Routes under /api/cli-agents/versions (owner only, like the rest of CLI-agents). */
export function versionRoutes(ctx: Ctx, versions: EngineVersions, ownerOnly: (req: any) => any) {
  ctx.api.get(
    '/cli-agents/versions',
    ah(async (req) => {
      ownerOnly(req);
      return { items: await versions.view(req.query.fresh === '1') };
    }),
  );
  ctx.api.post(
    '/cli-agents/versions/:id/check',
    ah(async (req) => {
      ownerOnly(req);
      const id = String(req.params.id);
      if (!isPinnedEngine(id)) throw bad('TeamBot test alleen Claude Code, Codex en OpenCode');
      const r = await versions.check(id, { why: 'manual' });
      if (!r) throw bad('Deze CLI is niet gevonden op deze computer.');
      return { check: r, items: await versions.view() };
    }),
  );
  ctx.api.post(
    '/cli-agents/versions/:id/accept',
    ah(async (req) => {
      ownerOnly(req);
      const id = String(req.params.id);
      if (!isPinnedEngine(id)) throw bad('Onbekende CLI');
      versions.accept(id);
      return { items: await versions.view() };
    }),
  );
}
