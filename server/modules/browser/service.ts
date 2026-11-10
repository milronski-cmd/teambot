import fs from 'node:fs';
import path from 'node:path';
import type { Agent, Ctx, ToolContext, User } from '../../core/types.js';
import { newId, now } from '../../core/db.js';
import { checkUrl, cleanRules, type UrlPolicy } from './policy.js';
import { LeaseManager, type Holder } from './lease.js';
import { detectCapabilities, isolatedRuntime, modeTable, realProbes, type Capabilities, type ModeId, type Probes } from './capabilities.js';
import { BrowserManager, profileSize, type BrowserSession, type Launcher } from './browser.js';
import { ENGINE_SETTING, inAppBrowserHost, type BrowserEngine } from './inapp.js';
import { trUser } from '../../core/i18n.js';
import { PowerShellDriver, cleanApps, desktopSnapshots, pruneSnapshots, windowAllowed, type HostDriver, type HostWindow } from './host.js';
import { ContainerRuntime, cleanContainerSettings, DEFAULT_CONTAINER, type ContainerSettings, type DockerRunner } from './container.js';
import {
  RemoteManager,
  RemoteInputError,
  RemoteRefused,
  HostKeyRejected,
  capture,
  cleanRemoteInput,
  connectSsh,
  effectiveDir,
  friendlySshError,
  isFingerprint,
  lastLine,
  mismatchMessage,
  probeFingerprint,
  remoteFromRow,
  remoteToRow,
  resolveRemoteHost,
  secretNameFor,
  validateCredential,
  wrapSh,
  DOCKER_PROBE,
  POSIX_PROBE,
  POSIX_PROBE_OK,
  type RemoteSettings,
  type RemoteTarget,
} from './remote.js';
import { isRestricted } from '../../api/member-policy.js';
import { ScreenControl, type ScreenDriver } from './screen.js';
import { ALWAYS_BLOCKED_APPS, cleanHostOptions, cleanLevel, DEFAULT_HOST_OPTIONS, LEVEL_LABEL, type HostLevel, type HostOptions } from './screen-policy.js';
import type { CloudVmService } from './cloudvm/service.js';
import type { VaultService } from './vault.js';
import * as ws from './workspace.js';
import { makeUpstream, parseProxyUrl, testProxy, type UpstreamProxy } from '../network/proxy.js';
import { assertPublicUrl } from '../../tools/builtin/web.js';

/** A profile's proxy as the owner's UI sees it: the address and whether a login is stored. */
export interface ProfileProxyView {
  url: string;
  has_login: boolean;
}

export const MODES: ModeId[] = ['none', 'workspace', 'browser', 'host', 'container', 'remote'];
const COMPUTER_GROUPS = ['files', 'shell', 'browser', 'desktop', 'rehearsal', 'container', 'remote'];
const MODE_GROUPS: Record<ModeId, string[]> = {
  none: [],
  workspace: ['files', 'rehearsal'],
  browser: ['files', 'rehearsal', 'browser'],
  host: ['files', 'rehearsal', 'browser', 'desktop'],
  container: ['files', 'rehearsal', 'container'],
  remote: ['files', 'rehearsal', 'remote'],
};

export interface ComputerLimits {
  downloadMb: number;
  idleMin: number;
}

export interface ComputerConfig {
  agent_id: string;
  user_id: string;
  mode: ModeId;
  profile_id: string | null;
  allow_domains: string[];
  deny_domains: string[];
  allow_private: boolean;
  host_control: boolean;
  host_apps: string[];
  /** desktop access level: ask every action / once per task / full access within the allowed scope */
  host_level: HostLevel;
  host_options: HostOptions;
  container: ContainerSettings;
  limits: ComputerLimits;
  /** Own server over SSH (mode "remote"). Never contains the key/password, only the name of the secret. */
  remote: RemoteView;
  updated_at: string;
  /** true when no row exists yet (derived from the agent's tool groups) */
  derived?: boolean;
}

export interface RemoteView extends RemoteSettings {
  /** a key or password is stored (the value itself never leaves the server) */
  has_secret: boolean;
  /** effective folder on the server */
  workdir: string;
}

/** What a remote tool needs for one call. */
export interface RemoteSession {
  cfg: ComputerConfig;
  r: RemoteView;
  target: RemoteTarget;
  label: string;
  dir: string;
}

export interface RemoteTestResult {
  ok: boolean;
  host: string;
  port: number;
  username: string;
  fingerprint: string | null;
  trusted: boolean;
  mismatch?: boolean;
  expected?: string | null;
  windows?: boolean;
  os?: string;
  docker?: { installed: boolean; usable: boolean; version: string | null };
  message?: string;
  error?: string;
}

export interface BrowserProfile {
  id: string;
  user_id: string;
  name: string;
  agent_id: string | null;
  shared: boolean;
  room_id: string | null;
  created_at: string;
  last_used_at: string | null;
  /** Own proxy of this profile (http(s)://host:port, no login in it); '' = none (migration browser-006). */
  proxy_url?: string;
}

/** The encrypted login of a profile's proxy ({ username, password }); never in the profile row, the API or a log. */
const proxySecret = (profileId: string) => 'browser-proxy:' + profileId;
/**
 * A profile's own proxy is HTTP(S) only (11.1, as its form says). parseProxyUrl also takes SOCKS since 0.4.4, for the
 * proxy of all of TeamBot (Instellingen › Netwerk en proxy); a profile keeps refusing it in plain words.
 */
const profileProxyOnlyHttp = (url: URL) => {
  if (url.protocol.startsWith('socks')) throw new HttpLike(400, 'Een browserprofiel kan alleen een HTTP- of HTTPS-proxy gebruiken, geen SOCKS.');
};

const DEFAULT_LIMITS: ComputerLimits = { downloadMb: 50, idleMin: 10 };
const MAX_MANUAL_SNAPSHOTS = 20;
const MAX_AUTO_SNAPSHOTS = 10;
const MAX_SNAPSHOT_BYTES_PER_USER = 2 * 1024 * 1024 * 1024;
const MAX_FRAMES = 80;
const MAX_ACTIONS = 1000;

const isRunActive = (ctx: Ctx, runId: string) => ['queued', 'running', 'waiting'].includes(ctx.store.run(runId)?.status || '');

export class ComputerService {
  readonly leases = new LeaseManager();
  readonly browsers: BrowserManager;
  probes: Probes = realProbes;
  hostDriver: HostDriver;
  container: ContainerRuntime;
  /** SSH connections of bots in mode "remote" (one per bot, closed when idle). */
  readonly remote = new RemoteManager();
  /** Cloud VMs made by TeamBot (set by the module; absent in unit setups). */
  cloud?: CloudVmService;
  /** Login vault of the owners (set by the module). */
  vault?: VaultService;
  private mismatchNotified = new Map<string, number>();
  private capsCache: { at: number; caps: Capabilities } | null = null;
  private capsOverride: Capabilities | null = null;
  readonly hostStopped = new Set<string>();
  private beats = new Map<string, number>();
  /** Built proxy per browser profile (null = none); dropped on every change of that profile's proxy. */
  private proxyCache = new Map<string, UpstreamProxy | null>();
  readonly streams = new Set<{ end(): void }>();
  readonly base: string;
  readonly headlessOnly: boolean;
  /** Full-screen computer use on this desktop (screenshots, input, grants, live screen, emergency stop). */
  readonly screen: ScreenControl;

  constructor(
    private ctx: Ctx,
    o: { launcher?: Launcher; docker?: DockerRunner; host?: HostDriver; screen?: ScreenDriver } = {},
  ) {
    this.base = path.join(ctx.config.dataDir, 'browser');
    for (const d of ['profiles', 'frames', 'tmp', 'rehearsals', 'snapshots', 'host']) fs.mkdirSync(path.join(this.base, d), { recursive: true });
    this.headlessOnly = process.env.TEAMBOT_BROWSER_HEADLESS_ONLY === '1';
    this.hostDriver = o.host || new PowerShellDriver(path.join(this.base, 'host'));
    this.screen = new ScreenControl(ctx, this, o.screen);
    this.container = new ContainerRuntime(o.docker);
    this.browsers = new BrowserManager({
      launcher: o.launcher,
      sandbox: process.env.TEAMBOT_BROWSER_NO_SANDBOX !== '1',
      findBrowser: async () => (await this.caps()).browsers[0] || null,
      inApp: () => inAppBrowserHost(),
      engine: (opts) => this.engineChoice(opts.userId),
      onClosed: (s, unexpected) => {
        if (unexpected) this.logAction(s.opts.userId, this.agentOfProfile(s.opts.profileId), { actor: 'system', tool: 'browser', summary: 'Browser onverwacht gestopt; profiel en werkmap zijn bewaard', status: 'error' });
        this.emitStatus(s.opts.userId, s.opts.profileId);
      },
    });
    this.leases.onChange((resource) => {
      const [kind, id] = resource.split(':');
      if (kind === 'browser') {
        const p = this.ctx.store.get<BrowserProfile>('browser_profiles', id);
        if (p) this.emitStatus(p.user_id, p.id);
      }
    });
  }

  // ---------------- capabilities ----------------

  async caps(refresh = false): Promise<Capabilities> {
    if (this.capsOverride) return this.capsOverride;
    if (!refresh && this.capsCache && Date.now() - this.capsCache.at < 10 * 60_000) return this.capsCache.caps;
    const caps = await detectCapabilities(this.probes, this.ctx.config.mode, { inApp: !!inAppBrowserHost() });
    if (this.headlessOnly) caps.caps.visible = { ...caps.caps.visible, status: 'unsupported', detail: 'Zichtbare vensters zijn uitgeschakeld (TEAMBOT_BROWSER_HEADLESS_ONLY). Overnemen kan via het live scherm.' };
    this.capsCache = { at: Date.now(), caps };
    return caps;
  }

  /**
   * The engine the owner chose for the bot browsers (Computers › Browser van de bots): inside TeamBot (default, desktop
   * app) or an installed Edge/Chrome. Without the app (server mode) it is always Edge/Chrome.
   */
  engineChoice(userId: string): BrowserEngine {
    return this.ctx.store.getSetting<string>(userId, ENGINE_SETTING, 'app') === 'external' ? 'external' : 'app';
  }

  /** What the Computers page shows about the engine: the choice, and whether each engine is there. */
  async engineView(userId: string) {
    const caps = await this.caps();
    return { choice: this.engineChoice(userId), app: !!inAppBrowserHost(), external: caps.browsers[0]?.name || null };
  }

  setEngine(u: User, engine: unknown) {
    const v: BrowserEngine = engine === 'external' ? 'external' : 'app';
    this.ctx.store.setSetting(u.id, ENGINE_SETTING, v);
    this.ctx.audit(u.id, 'browser.engine', { engine: v });
    return v;
  }

  /** Tests / diagnostics: pin the detected capabilities. */
  setCapabilities(c: Capabilities | null) {
    this.capsOverride = c;
  }

  // ---------------- config ----------------

  config(agent: Agent): ComputerConfig {
    const row = this.ctx.store.get<any>('computer_configs', agent.id, 'agent_id');
    if (row) {
      const rest: any = {};
      for (const [k, v] of Object.entries(row)) if (!k.startsWith('remote_')) rest[k] = v;
      return {
        ...rest,
        host_level: cleanLevel(row.host_level),
        host_options: cleanHostOptions(row.host_options || {}, DEFAULT_HOST_OPTIONS),
        mode: MODES.includes(rest.mode) ? rest.mode : 'workspace',
        container: cleanContainerSettings(row.container), limits: { ...DEFAULT_LIMITS, ...(row.limits || {}) }, remote: this.remoteView(agent, remoteFromRow(row)) };
    }
    const g = agent.tool_groups || [];
    const mode: ModeId = g.includes('browser') ? 'browser' : g.includes('files') ? 'workspace' : 'none';
    return {
      agent_id: agent.id,
      user_id: agent.user_id,
      mode,
      profile_id: null,
      allow_domains: [],
      deny_domains: [],
      allow_private: false,
      host_control: false,
      host_apps: [],
      host_level: 'every',
      host_options: { ...DEFAULT_HOST_OPTIONS },
      container: { ...DEFAULT_CONTAINER },
      limits: { ...DEFAULT_LIMITS },
      remote: this.remoteView(agent, remoteFromRow({})),
      updated_at: agent.updated_at,
      derived: true,
    };
  }

  /** Database row (flat remote_* columns) for a config. */
  private configRow(cfg: ComputerConfig): Record<string, any> {
    const { remote, derived: _derived, ...rest } = cfg;
    return { ...rest, ...remoteToRow(remote) };
  }

  private upsertConfig(agent: Agent, cfg: ComputerConfig) {
    const row = this.configRow(cfg);
    this.ctx.store.tx(() => {
      if (this.ctx.store.get('computer_configs', agent.id, 'agent_id')) this.ctx.store.update('computer_configs', agent.id, row, 'agent_id');
      else this.ctx.store.insert('computer_configs', row);
    });
  }

  canAllowPrivate(u: User) {
    return u.role === 'owner' || u.role === 'admin';
  }

  async saveConfig(u: User, agent: Agent, body: any): Promise<{ config: ComputerConfig; agent: Agent }> {
    const cur = this.config(agent);
    const caps = await this.caps();
    const next: ComputerConfig = { ...cur, derived: undefined };
    if (body.mode !== undefined) {
      if (!MODES.includes(body.mode)) throw new HttpLike(400, 'Onbekende computermodus');
      // A container runs on this machine's Docker host: only the owner/admins may give a bot one on a shared server.
      if (body.mode === 'container' && cur.mode !== 'container' && !this.canAllowPrivate(u)) throw new HttpLike(403, 'Alleen de eigenaar of een beheerder mag een bot een container op deze server geven.');
      next.mode = body.mode;
    }
    if (body.allow_domains !== undefined) next.allow_domains = cleanRules(body.allow_domains);
    if (body.deny_domains !== undefined) next.deny_domains = cleanRules(body.deny_domains);
    if (body.allow_private !== undefined) {
      const want = !!body.allow_private;
      if (want && !cur.allow_private && !this.canAllowPrivate(u)) throw new HttpLike(403, 'Alleen de eigenaar of een beheerder mag lokale netwerkadressen toestaan.');
      next.allow_private = want;
    }
    if (body.host_apps !== undefined) next.host_apps = cleanApps(body.host_apps).filter((a) => !ALWAYS_BLOCKED_APPS.includes(a));
    if (body.host_level !== undefined || body.host_options !== undefined) {
      // how independently a bot may work on the real desktop: only the owner of this computer decides
      if (u.role !== 'owner') throw new HttpLike(403, 'Alleen de eigenaar van deze computer mag het toegangsniveau voor het bureaublad kiezen.');
      if (body.host_level !== undefined) next.host_level = cleanLevel(body.host_level);
      if (body.host_options !== undefined) {
        next.host_options = cleanHostOptions(body.host_options, cur.host_options);
        if (next.host_options.allApps && !cur.host_options.allApps && body.confirmAllApps !== true)
          throw new HttpLike(400, 'Bevestig eerst dat de bot alle apps op je bureaublad mag bedienen (behalve de altijd geblokkeerde).');
      }
    }
    if (body.host_control !== undefined) {
      const want = !!body.host_control;
      if (want && !cur.host_control) {
        if (u.role !== 'owner') throw new HttpLike(403, 'Alleen de eigenaar van deze computer mag bureaubladbediening aanzetten.');
        if (body.confirmHost !== true) throw new HttpLike(400, 'Bevestig eerst dat je begrijpt wat bureaubladbediening betekent.');
        if (caps.caps.host.status !== 'available') throw new HttpLike(400, `Bureaubladbediening kan hier niet: ${caps.caps.host.detail}`);
      }
      next.host_control = want;
    }
    if (body.container !== undefined) {
      next.container = cleanContainerSettings(body.container);
      // Network access from a container reaches the LAN of this host: owner/admin only.
      if (next.container.network === 'bridge' && cur.container?.network !== 'bridge' && !this.canAllowPrivate(u)) throw new HttpLike(403, 'Alleen de eigenaar of een beheerder mag een container netwerktoegang geven.');
    }
    if (body.limits !== undefined)
      next.limits = {
        downloadMb: Math.min(500, Math.max(1, Number(body.limits?.downloadMb) || cur.limits.downloadMb)),
        idleMin: Math.min(120, Math.max(1, Number(body.limits?.idleMin) || cur.limits.idleMin)),
      };
    if (body.remote !== undefined) {
      try {
        next.remote = { ...next.remote, ...cleanRemoteInput(body.remote, cur.remote) };
      } catch (e: any) {
        if (e instanceof RemoteInputError) throw new HttpLike(400, e.message);
        throw e;
      }
      // a TeamBot-managed cloud VM: address, port and user follow the VM, never a hand-typed value
      if (this.cloud?.isManaged(agent.id) && (next.remote.host !== cur.remote.host || next.remote.port !== cur.remote.port || next.remote.username !== cur.remote.username))
        throw new HttpLike(409, 'Deze bot werkt op een cloud-VM; adres, poort en gebruiker beheert TeamBot. Verwijder de VM als je een eigen server wilt instellen.');
    }
    if (body.profile_id !== undefined) {
      if (body.profile_id === null || body.profile_id === '') next.profile_id = null;
      else {
        const p = this.ctx.store.get<BrowserProfile>('browser_profiles', String(body.profile_id));
        if (!p || p.user_id !== agent.user_id || !p.shared) throw new HttpLike(400, 'Onbekend gedeeld browserprofiel');
        next.profile_id = p.id;
      }
    }
    // mode requirements: fail closed with an honest reason
    if (next.mode === 'host') {
      if (u.role !== 'owner') throw new HttpLike(403, 'Alleen de eigenaar van deze computer mag "Mijn bureaublad" kiezen.');
      if (!next.host_control) throw new HttpLike(400, 'Zet eerst bureaubladbediening aan (met bevestiging).');
      if (caps.caps.host.status !== 'available') throw new HttpLike(400, `Bureaubladbediening kan hier niet: ${caps.caps.host.detail}`);
    }
    if (next.mode === 'browser' || next.mode === 'host') {
      if (caps.caps.browser.status !== 'available') throw new HttpLike(400, `${caps.caps.browser.detail} ${caps.caps.browser.howTo || ''}`.trim());
    }
    if (next.mode === 'container') {
      const iso = isolatedRuntime(caps);
      if (!iso.available) throw new HttpLike(400, `Geen afgeschermde omgeving beschikbaar op dit apparaat. ${iso.missing.join(' · ')}`);
    }
    if (next.mode === 'remote' && (!next.remote.host || !next.remote.username)) throw new HttpLike(400, 'Vul eerst het adres en de gebruikersnaam van je server in.');
    // restricted members (server mode) may only use public hosts; checked again at every connection
    if (next.remote.host && (next.mode === 'remote' || next.remote.host !== cur.remote.host) && !this.remoteAllowsPrivate(agent)) await this.checkRemoteHost(agent, next.remote.host, true);
    next.updated_at = now();
    this.upsertConfig(agent, next);
    const updated = this.applyModeGroups(agent, next.mode);
    if (cur.mode !== next.mode && (cur.mode === 'browser' || cur.mode === 'host')) await this.closeFor(agent);
    if (cur.mode === 'container' && next.mode !== 'container') this.container.stop(agent.id).catch(() => {});
    if ((cur.mode === 'remote' && next.mode !== 'remote') || next.remote.host !== cur.remote.host || next.remote.port !== cur.remote.port || next.remote.username !== cur.remote.username) this.remote.close(agent.id);
    if (!next.host_control) this.hostStopped.delete(agent.id);
    if (
      !next.host_control ||
      next.host_level !== cur.host_level ||
      next.host_options.allApps !== cur.host_options.allApps ||
      next.host_apps.join(',') !== cur.host_apps.join(',')
    )
      this.screen.revokeGrant(agent.id, 'instellingen gewijzigd');
    this.ctx.audit(
      u.id,
      'computer.config',
      {
        mode: next.mode,
        allow: next.allow_domains.length,
        deny: next.deny_domains.length,
        allow_private: next.allow_private,
        host_control: next.host_control,
        host_apps: next.host_apps,
        host_level: next.host_level,
        host_options: next.host_options,
        remote: next.mode === 'remote' ? { host: next.remote.host, port: next.remote.port, user: next.remote.username, docker: next.remote.docker.enabled } : undefined,
      },
      agent.id,
    );
    if (next.host_control && !cur.host_control) this.ctx.audit(u.id, 'computer.host_optin', { apps: next.host_apps }, agent.id);
    if (next.host_level !== cur.host_level) this.ctx.audit(u.id, 'computer.host_level', { from: cur.host_level, to: next.host_level, label: LEVEL_LABEL[next.host_level] }, agent.id);
    if (next.host_options.allApps && !cur.host_options.allApps) this.ctx.audit(u.id, 'computer.host_all_apps', {}, agent.id);
    this.ctx.events.emit(agent.user_id, 'computer.config', this.config(updated));
    return { config: this.config(updated), agent: updated };
  }

  /** Keep tool groups in line with the mode (the mode decides which computer tools the bot sees). */
  private applyModeGroups(agent: Agent, mode: ModeId): Agent {
    const fresh = this.ctx.store.agent(agent.id) || agent;
    let groups = (fresh.tool_groups || []).filter((g) => !COMPUTER_GROUPS.includes(g) || g === 'shell');
    if (mode === 'none') groups = groups.filter((g) => g !== 'shell');
    for (const g of MODE_GROUPS[mode]) if (!groups.includes(g)) groups.push(g);
    const updated = this.ctx.store.updateAgent(agent.id, { tool_groups: groups });
    this.ctx.events.emit(agent.user_id, 'agent.updated', updated);
    return updated;
  }

  policyOf(cfg: ComputerConfig): UrlPolicy {
    return { allow: cfg.allow_domains, deny: cfg.deny_domains, allowPrivate: cfg.allow_private };
  }

  // ---------------- cloud VM (managed own server) ----------------

  /**
   * A TeamBot-made cloud VM is ready: point the bot's remote config at it with the self-generated host key already
   * pinned (no trust-on-first-use) and the VM's client key as the bot's SSH credential.
   */
  attachCloudVm(agent: Agent, o: { ip: string; port: number; fingerprint: string; privateKey: string; docker: boolean }) {
    const name = secretNameFor(agent.id);
    this.ctx.secrets.set(agent.user_id, name, o.privateKey);
    const cur = this.config(agent);
    const next: ComputerConfig = {
      ...cur,
      mode: 'remote',
      remote: { ...cur.remote, host: o.ip, port: o.port, username: 'teambot', auth: 'key', secret_name: name, fingerprint: o.fingerprint, dir: '', docker: { ...cur.remote.docker, enabled: o.docker } },
      updated_at: now(),
    };
    delete next.derived;
    this.upsertConfig(agent, next);
    this.remote.close(agent.id);
    const updated = this.applyModeGroups(agent, 'remote');
    this.ctx.events.emit(agent.user_id, 'computer.config', this.config(updated));
  }

  /** The VM is going away: the bot stops pointing at its address (an IP can be given to someone else later). */
  detachCloudVm(agent: Agent, fingerprint: string) {
    const cur = this.config(agent);
    if (cur.remote.fingerprint !== fingerprint) return; // the bot was moved to another server meanwhile
    this.remote.close(agent.id);
    for (const s of this.ctx.secrets.list(agent.user_id)) if (s.name === secretNameFor(agent.id)) this.ctx.secrets.delete(s.id);
    const mode: ModeId = cur.mode === 'remote' ? 'workspace' : cur.mode;
    const next: ComputerConfig = { ...cur, mode, remote: { ...cur.remote, host: '', fingerprint: null, secret_name: null }, updated_at: now() };
    delete next.derived;
    this.upsertConfig(agent, next);
    const updated = this.applyModeGroups(agent, mode);
    this.ctx.events.emit(agent.user_id, 'computer.config', this.config(updated));
  }

  // ---------------- own server (SSH) ----------------

  private remoteView(agent: Agent, r: RemoteSettings): RemoteView {
    return { ...r, has_secret: !!this.remoteSecretId(agent, r), workdir: effectiveDir(r, agent.id) };
  }

  /** Only the bot's own SSH secret of the bot's owner counts (never another secret picked by name). */
  private remoteSecretId(agent: Agent, r: RemoteSettings): string | null {
    if (r.secret_name !== secretNameFor(agent.id)) return null;
    return this.ctx.store.one<any>('SELECT id FROM secrets WHERE user_id = ? AND name = ?', agent.user_id, r.secret_name)?.id || null;
  }

  private remoteSecret(agent: Agent, r: RemoteSettings): string | null {
    const id = this.remoteSecretId(agent, r);
    return id ? this.ctx.secrets.get(id) : null;
  }

  /** Private/loopback addresses only for owners/admins and desktop mode (restricted members: public hosts only). */
  remoteAllowsPrivate(agent: Agent) {
    return !isRestricted(this.ctx, this.ctx.store.user(agent.user_id));
  }

  /** Resolve + check the host; returns the IP to connect to (checked again for every connection: no DNS rebinding). */
  async resolveRemote(agent: Agent, host: string): Promise<string> {
    return resolveRemoteHost(host, { allowPrivate: this.remoteAllowsPrivate(agent), resolver: this.remote.resolver });
  }

  private async checkRemoteHost(agent: Agent, host: string, lenientDns: boolean) {
    try {
      await this.resolveRemote(agent, host);
    } catch (e: any) {
      if (e instanceof RemoteRefused) {
        if (e.kind === 'dns' && lenientDns) return; // every connection repeats this check
        throw new HttpLike(e.kind === 'private' ? 403 : 400, e.message);
      }
      throw e;
    }
  }

  private saveRemote(agent: Agent, patch: Partial<RemoteSettings>) {
    const cur = this.config(agent);
    const next: ComputerConfig = { ...cur, remote: { ...cur.remote, ...patch }, updated_at: now() };
    delete next.derived;
    this.upsertConfig(agent, next);
    this.remote.close(agent.id);
    const cfg = this.config(agent);
    this.ctx.events.emit(agent.user_id, 'computer.config', cfg);
    return cfg;
  }

  private refuseIfCloudManaged(agent: Agent) {
    if (this.cloud?.isManaged(agent.id)) throw new HttpLike(409, 'Deze bot werkt op een cloud-VM; de sleutel en de vingerafdruk beheert TeamBot zelf. Verwijder de VM als je een eigen server wilt instellen.');
  }

  /** Store the private key / password once, encrypted, as a secret of the bot's owner. Returns only its name. */
  setRemoteCredential(u: User, agent: Agent, kind: unknown, value: unknown) {
    this.refuseIfCloudManaged(agent);
    let c: { kind: 'key' | 'password'; value: string };
    try {
      c = validateCredential(kind, value);
    } catch (e: any) {
      throw new HttpLike(400, e instanceof RemoteInputError ? e.message : 'Deze sleutel of dit wachtwoord kan niet worden opgeslagen.');
    }
    const name = secretNameFor(agent.id);
    this.ctx.secrets.set(agent.user_id, name, c.value);
    const cfg = this.saveRemote(agent, { auth: c.kind, secret_name: name });
    this.ctx.audit(u.id, 'remote.credential_set', { kind: c.kind }, agent.id);
    return { secret_name: name, has_secret: cfg.remote.has_secret, auth: cfg.remote.auth };
  }

  clearRemoteCredential(u: User, agent: Agent) {
    this.refuseIfCloudManaged(agent);
    const name = secretNameFor(agent.id);
    for (const s of this.ctx.secrets.list(agent.user_id)) if (s.name === name) this.ctx.secrets.delete(s.id);
    const cfg = this.saveRemote(agent, { secret_name: null });
    this.ctx.audit(u.id, 'remote.credential_deleted', {}, agent.id);
    return { secret_name: null, has_secret: cfg.remote.has_secret, auth: cfg.remote.auth };
  }

  /** Pin (or forget, with null) the server's host key fingerprint: explicit trust-on-first-use. */
  trustRemote(u: User, agent: Agent, fingerprint: unknown) {
    this.refuseIfCloudManaged(agent);
    const cur = this.config(agent);
    if (fingerprint !== null && !isFingerprint(fingerprint)) throw new HttpLike(400, 'Ongeldige vingerafdruk (verwacht SHA256:… zoals ssh-keygen -lf die toont).');
    if (fingerprint && !cur.remote.host) throw new HttpLike(400, 'Stel eerst het adres van de server in.');
    const cfg = this.saveRemote(agent, { fingerprint: (fingerprint as string | null) || null });
    this.mismatchNotified.delete(agent.id);
    this.ctx.audit(u.id, fingerprint ? 'remote.trusted' : 'remote.untrusted', { host: cur.remote.host, port: cur.remote.port, fingerprint: fingerprint || cur.remote.fingerprint }, agent.id);
    return cfg;
  }

  /**
   * Connection test. Without a pinned key we only fetch the host key: no credentials go to an unverified server.
   * With a pinned key: verify it, log in, report OS and Docker. A Windows / non-POSIX login shell is refused.
   */
  async testRemote(agent: Agent): Promise<RemoteTestResult> {
    const r = this.config(agent).remote;
    if (!r.host || !r.username) throw new HttpLike(400, 'Vul eerst het adres en de gebruikersnaam van de server in en sla op.');
    let ip: string;
    try {
      ip = await this.resolveRemote(agent, r.host);
    } catch (e: any) {
      if (e instanceof RemoteRefused) throw new HttpLike(e.kind === 'private' ? 403 : 400, e.message);
      throw e;
    }
    const base = { host: r.host, port: r.port, username: r.username };
    const timeoutMs = this.remote.connectTimeoutMs;
    const secret = r.fingerprint ? this.remoteSecret(agent, r) : null;
    if (!r.fingerprint || !secret) {
      let fp: string;
      try {
        fp = await probeFingerprint({ ip, port: r.port, username: r.username, timeoutMs });
      } catch (e: any) {
        return { ...base, ok: false, trusted: false, fingerprint: null, error: friendlySshError(e, { port: r.port }) };
      }
      if (!r.fingerprint) return { ...base, ok: true, trusted: false, fingerprint: fp, message: 'Controleer of deze vingerafdruk klopt met je server en klik dan op Vertrouwen. Pas daarna logt TeamBot in.' };
      if (fp !== r.fingerprint) return { ...base, ok: false, trusted: false, mismatch: true, fingerprint: fp, expected: r.fingerprint, error: mismatchMessage(fp, r.fingerprint) };
      return { ...base, ok: false, trusted: true, fingerprint: fp, error: 'De serversleutel klopt, maar er is nog geen sleutel of wachtwoord opgeslagen om in te loggen.' };
    }
    let conn: Awaited<ReturnType<typeof connectSsh>>;
    try {
      conn = await connectSsh({ ip, port: r.port, username: r.username, auth: r.auth, secret, verify: (fp) => fp === r.fingerprint, timeoutMs });
    } catch (e: any) {
      if (e instanceof HostKeyRejected) {
        this.ctx.audit(agent.user_id, 'remote.hostkey_mismatch', { host: r.host, port: r.port, expected: r.fingerprint, observed: e.fingerprint }, agent.id);
        return { ...base, ok: false, trusted: false, mismatch: true, fingerprint: e.fingerprint || null, expected: r.fingerprint, error: mismatchMessage(e.fingerprint, r.fingerprint) };
      }
      return { ...base, ok: false, trusted: true, fingerprint: r.fingerprint, error: friendlySshError(e, { port: r.port, secret }) };
    }
    try {
      const windows: RemoteTestResult = {
        ...base,
        ok: false,
        trusted: true,
        fingerprint: r.fingerprint,
        windows: true,
        error: 'Dit lijkt een Windows-server (OpenSSH voor Windows) of een server zonder POSIX-loginshell. TeamBot ondersteunt alleen Linux- en macOS-servers waar de SSH-gebruiker sh, bash of zsh als shell heeft.',
      };
      // (a login shell may print text first, e.g. from ~/.bashrc: only our own last line counts)
      const posix = await capture(conn.client, POSIX_PROBE, 10_000);
      if (posix.code !== 0 || lastLine(posix.out) !== POSIX_PROBE_OK) return windows;
      const un = await capture(conn.client, 'uname -sm', 10_000);
      const os = lastLine(un.out).slice(0, 120);
      if (un.code !== 0 || !/^[A-Za-z][\w.\-]*(\s+\S+)?$/.test(os)) return windows;
      const d = await capture(conn.client, wrapSh(DOCKER_PROBE), 20_000);
      const m = d.out.match(/docker:(ok|noaccess|none)(?::([\w.+-]+))?/);
      const docker = { installed: m?.[1] === 'ok' || m?.[1] === 'noaccess', usable: m?.[1] === 'ok', version: m?.[2] || null };
      return { ...base, ok: true, trusted: true, fingerprint: r.fingerprint, os, docker };
    } catch (e: any) {
      return { ...base, ok: false, trusted: true, fingerprint: r.fingerprint, error: friendlySshError(e, { port: r.port, secret }) };
    } finally {
      conn.client.end();
    }
  }

  /** Everything a remote tool needs; fails closed with a clear reason (not configured, not trusted, private host…). */
  async remoteFor(t: ToolContext): Promise<RemoteSession> {
    const block = this.cloud?.blockReason(t.agent.id);
    if (block) throw new Error(block);
    const cfg = this.config(t.agent);
    if (cfg.mode !== 'remote') throw new Error(`Deze bot heeft geen eigen server (computermodus: ${modeLabel(cfg.mode)}). De gebruiker kan dit instellen bij Bot › Computer & bestanden.`);
    const r = cfg.remote;
    if (!r.host || !r.username) throw new Error('De server van deze bot is nog niet ingesteld (adres of gebruikersnaam ontbreekt). De gebruiker doet dat bij Bot › Computer & bestanden.');
    if (!r.fingerprint)
      throw new Error('De sleutel van de server is nog niet vertrouwd. De gebruiker moet bij Bot › Computer & bestanden op "Verbinding testen" en daarna op "Vertrouwen" klikken. Tot die tijd maakt TeamBot geen verbinding.');
    const secret = this.remoteSecret(t.agent, r);
    if (!secret) throw new Error('Er is nog geen sleutel of wachtwoord voor de server opgeslagen. De gebruiker doet dat bij Bot › Computer & bestanden.');
    const ip = await this.resolveRemote(t.agent, r.host);
    await this.control(t, 'remote:' + t.agent.id);
    return { cfg, r, target: { ip, port: r.port, username: r.username, auth: r.auth, secret, fingerprint: r.fingerprint }, label: `${r.username}@${r.host}`, dir: r.workdir };
  }

  /** A tool saw a different host key: drop the connection, audit and notify (the tool already failed closed). */
  remoteMismatch(agent: Agent, r: RemoteView, observed: string) {
    this.remote.close(agent.id);
    this.ctx.audit(agent.user_id, 'remote.hostkey_mismatch', { host: r.host, port: r.port, expected: r.fingerprint, observed }, agent.id);
    // one notification per bot per 10 minutes, even if the bot keeps retrying
    const last = this.mismatchNotified.get(agent.id) || 0;
    if (Date.now() - last < 10 * 60_000) return;
    this.mismatchNotified.set(agent.id, Date.now());
    this.ctx.events.emit(agent.user_id, 'notification', {
      title: `${agent.name}: serversleutel klopt niet`,
      body: `De server ${r.host} gaf een andere sleutel dan vertrouwd. TeamBot heeft niet ingelogd. Controleer de server bij Bot › Computer & bestanden.`,
      link: `#/agents/${agent.id}/edit`,
      kind: 'warning',
      agentId: agent.id,
    });
  }

  // ---------------- profiles ----------------

  profileDir(id: string) {
    return path.join(this.base, 'profiles', id.replace(/[^a-zA-Z0-9_-]/g, ''));
  }

  privateProfile(agent: Agent): BrowserProfile {
    const existing = this.ctx.store.one<any>('SELECT * FROM browser_profiles WHERE agent_id = ? AND shared = 0', agent.id);
    if (existing) return this.ctx.store.decode('browser_profiles', existing);
    const p: BrowserProfile = { id: newId('bp_'), user_id: agent.user_id, name: `${agent.name} (eigen profiel)`, agent_id: agent.id, shared: false, room_id: null, created_at: now(), last_used_at: null };
    this.ctx.store.insert('browser_profiles', p);
    return p;
  }

  /** The bot's profile if it exists (never creates one; for status/read paths). */
  findProfile(agent: Agent, cfg = this.config(agent)): BrowserProfile | null {
    if (cfg.profile_id) {
      const p = this.ctx.store.get<BrowserProfile>('browser_profiles', cfg.profile_id);
      if (p && p.user_id === agent.user_id) return p;
    }
    const row = this.ctx.store.one<any>('SELECT * FROM browser_profiles WHERE agent_id = ? AND shared = 0', agent.id);
    return row ? this.ctx.store.decode('browser_profiles', row) : null;
  }

  profileFor(agent: Agent, cfg = this.config(agent)): BrowserProfile {
    if (cfg.profile_id) {
      const p = this.ctx.store.get<BrowserProfile>('browser_profiles', cfg.profile_id);
      if (p && p.user_id === agent.user_id) return p;
    }
    return this.privateProfile(agent);
  }

  profilesOf(userId: string): (BrowserProfile & { members: string[]; running: boolean; bytes: number; proxy: ProfileProxyView | null })[] {
    const rows = this.ctx.store.find<BrowserProfile>('browser_profiles', { user_id: userId }, { order: 'created_at' });
    const cfgs = this.ctx.store.find<any>('computer_configs', { user_id: userId });
    return rows.map((p) => ({
      ...p,
      members: p.shared ? cfgs.filter((c) => c.profile_id === p.id).map((c) => c.agent_id) : p.agent_id ? [p.agent_id] : [],
      running: !!this.browsers.get('p:' + p.id),
      bytes: profileSize(this.profileDir(p.id)),
      proxy: this.proxyView(p),
    }));
  }

  // ---------------- proxy per profile ----------------

  /** What the UI sees of a profile's proxy: the address and whether a login is stored (never the login). */
  proxyView(p: BrowserProfile): ProfileProxyView | null {
    if (!p.proxy_url) return null;
    return { url: p.proxy_url, has_login: !!this.ctx.secrets.getByName(p.user_id, proxySecret(p.id)) };
  }

  /**
   * The profile's own proxy for the policy proxy, built once per change (cached; asked on every request so a change
   * applies to new connections at once). null = none: the owner's proxy (if on for the browser) or direct.
   */
  profileUpstream(profileId: string): UpstreamProxy | null {
    if (this.proxyCache.has(profileId)) return this.proxyCache.get(profileId)!;
    const p = this.ctx.store.get<BrowserProfile>('browser_profiles', profileId);
    let up: UpstreamProxy | null = null;
    if (p?.proxy_url) {
      try {
        const raw = this.ctx.secrets.getByName(p.user_id, proxySecret(p.id));
        const login = raw ? (JSON.parse(raw) as { username?: string; password?: string }) : null;
        up = makeUpstream({ url: p.proxy_url, noProxy: [], browser: true, username: login?.username, password: login?.password });
      } catch {
        // a stored address that no longer parses: fail closed (no silent direct route around the chosen proxy)
        up = makeUpstream({ url: 'http://127.0.0.1:9', noProxy: [], browser: true });
      }
    }
    this.proxyCache.set(profileId, up);
    return up;
  }

  /**
   * Set or clear the proxy of one browser profile. `url` '' = no own proxy. The login is optional and write-only:
   * empty fields keep a stored login, `clear_login` removes it. On a shared server a member may only use a public proxy.
   */
  async setProfileProxy(u: User, p: BrowserProfile, body: any): Promise<ProfileProxyView | null> {
    const raw = String(body?.url ?? '').trim().slice(0, 500);
    const name = proxySecret(p.id);
    const dropLogin = () => {
      const row = this.ctx.store.one<{ id: string }>('SELECT id FROM secrets WHERE user_id = ? AND name = ?', p.user_id, name);
      if (row) this.ctx.secrets.delete(row.id);
    };
    if (!raw) {
      this.ctx.store.update('browser_profiles', p.id, { proxy_url: '' });
      dropLogin();
      this.proxyCache.delete(p.id);
      this.ctx.audit(u.id, 'browser.profile_proxy', { profile: p.id, proxy: null }, p.agent_id);
      this.emitStatus(p.user_id, p.id);
      return null;
    }
    let url: URL;
    try {
      url = parseProxyUrl(raw);
    } catch (e: any) {
      throw new HttpLike(400, e.message);
    }
    profileProxyOnlyHttp(url);
    if (!this.canAllowPrivate(u)) await assertPublicUrl(url.href).catch((e: any) => Promise.reject(new HttpLike(400, `Kies een proxy met een openbaar adres: ${e.message}`)));
    const username = String(body?.username ?? '').slice(0, 300);
    const password = String(body?.password ?? '').slice(0, 1000);
    if (body?.clear_login) dropLogin();
    else if (username || password) this.ctx.secrets.set(p.user_id, name, JSON.stringify({ username, password }));
    const href = url.href.replace(/\/$/, '');
    this.ctx.store.update('browser_profiles', p.id, { proxy_url: href });
    this.proxyCache.delete(p.id);
    const next = this.ctx.store.get<BrowserProfile>('browser_profiles', p.id)!;
    const view = this.proxyView(next);
    // the address host and whether there is a login: never the login itself
    this.ctx.audit(u.id, 'browser.profile_proxy', { profile: p.id, proxy: url.host, login: !!view?.has_login }, p.agent_id);
    this.emitStatus(p.user_id, p.id);
    return view;
  }

  /** "Testen": reach a site through the profile's proxy (the address and login as typed, else as stored). */
  async testProfileProxy(u: User, p: BrowserProfile, body: any) {
    let up: UpstreamProxy;
    try {
      const stored = this.ctx.secrets.getByName(p.user_id, proxySecret(p.id));
      const login = stored ? (JSON.parse(stored) as { username?: string; password?: string }) : null;
      const url = String(body?.url ?? '').trim() || p.proxy_url || '';
      up = makeUpstream({ url, noProxy: [], browser: true, username: String(body?.username || '') || login?.username, password: String(body?.password || '') || login?.password });
    } catch (e: any) {
      throw new HttpLike(400, e.message);
    }
    profileProxyOnlyHttp(up.url);
    if (!this.canAllowPrivate(u)) await assertPublicUrl(up.url.href).catch((e: any) => Promise.reject(new HttpLike(400, `Kies een proxy met een openbaar adres: ${e.message}`)));
    const r = await testProxy(up, 'https://example.com/');
    return { ...r, proxy: up.label, target: 'example.com' };
  }

  createSharedProfile(userId: string, name: string, roomId: string | null): BrowserProfile {
    const count = this.ctx.store.one<any>('SELECT COUNT(*) n FROM browser_profiles WHERE user_id = ? AND shared = 1', userId)?.n ?? 0;
    if (count >= 20) throw new HttpLike(400, 'Maximaal 20 gedeelde browserprofielen');
    const p: BrowserProfile = { id: newId('bp_'), user_id: userId, name: name.trim().slice(0, 80) || 'Gedeelde computer', agent_id: null, shared: true, room_id: roomId, created_at: now(), last_used_at: null };
    this.ctx.store.insert('browser_profiles', p);
    this.ctx.audit(userId, 'browser.profile_created', { name: p.name, room: roomId });
    return p;
  }

  /** Remove cookies, logins and history of a profile (the profile itself stays). */
  async wipeProfile(userId: string, p: BrowserProfile) {
    await this.browsers.close('p:' + p.id);
    await this.browsers.removeProfile(this.profileDir(p.id));
    this.ctx.audit(userId, 'browser.profile_wiped', { name: p.name }, p.agent_id);
    this.emitStatus(userId, p.id);
  }

  async deleteProfile(userId: string, p: BrowserProfile) {
    await this.wipeProfile(userId, p);
    this.ctx.store.exec('UPDATE computer_configs SET profile_id = NULL WHERE profile_id = ?', p.id);
    this.ctx.store.remove('browser_profiles', p.id);
    // its proxy login goes with it
    const login = this.ctx.store.one<{ id: string }>('SELECT id FROM secrets WHERE user_id = ? AND name = ?', p.user_id, proxySecret(p.id));
    if (login) this.ctx.secrets.delete(login.id);
    this.proxyCache.delete(p.id);
    this.ctx.audit(userId, 'browser.profile_deleted', { name: p.name });
  }

  agentOfProfile(profileId: string): string | null {
    const p = this.ctx.store.get<BrowserProfile>('browser_profiles', profileId);
    if (!p) return null;
    if (p.agent_id) return p.agent_id;
    const holder = this.leases.current('browser:' + profileId)?.holder;
    return holder?.agentId || null;
  }

  /** Policy for a (possibly shared) browser: the controlling bot's rules; for humans the strictest union. */
  private sessionPolicy(profile: BrowserProfile): UrlPolicy {
    if (!profile.shared && profile.agent_id) {
      const a = this.ctx.store.agent(profile.agent_id);
      if (a) return this.policyOf(this.config(a));
    }
    const holder = this.leases.current('browser:' + profile.id)?.holder;
    if (holder?.agentId) {
      const a = this.ctx.store.agent(holder.agentId);
      if (a) return this.policyOf(this.config(a));
    }
    const cfgs = this.ctx.store.find<any>('computer_configs', { profile_id: profile.id }).map((c) => this.ctx.store.decode('computer_configs', c));
    return {
      allow: [],
      deny: [...new Set(cfgs.flatMap((c: any) => c.deny_domains || []))],
      allowPrivate: cfgs.length > 0 && cfgs.every((c: any) => c.allow_private),
    };
  }

  sessionOf(agent: Agent): BrowserSession | null {
    const p = this.findProfile(agent);
    return p ? this.browsers.get('p:' + p.id) : null;
  }

  /** How a profile's browser is launched (the same for bots, the owner's "start" and takeover). */
  sessionOpts(profile: BrowserProfile, headed = false) {
    return {
      key: 'p:' + profile.id,
      userId: profile.user_id,
      profileId: profile.id,
      profileDir: this.profileDir(profile.id),
      policy: () => this.sessionPolicy(profile),
      upstream: () => this.profileUpstream(profile.id),
      headed,
      // address bar and tab list of the browser panel follow the bot live
      onChange: () => this.emitStatus(profile.user_id, profile.id),
      title: trUser(this.ctx.store, profile.user_id, 'TeamBot — browser van {0}', this.ctx.store.agent(this.agentOfProfile(profile.id))?.name || profile.name),
    };
  }

  /** The owner starts the bot's browser himself (to look along, or to log in before the bot needs it). */
  async startBrowser(u: User, agent: Agent, url?: string): Promise<BrowserSession> {
    const cfg = this.config(agent);
    if (cfg.mode !== 'browser' && cfg.mode !== 'host') throw new HttpLike(400, `Deze bot heeft geen eigen browser (computermodus: ${modeLabel(cfg.mode)}). Zet die aan bij Bot › Computer & bestanden.`);
    const caps = await this.caps();
    if (caps.caps.browser.status !== 'available') throw new HttpLike(400, `Geen browser beschikbaar op dit apparaat: ${caps.caps.browser.detail}`);
    const profile = this.profileFor(agent, cfg);
    let s: BrowserSession;
    try {
      s = await this.browsers.ensure(this.sessionOpts(profile));
    } catch (e: any) {
      throw new HttpLike(400, String(e?.message || e));
    }
    s.limits.idleMs = cfg.limits.idleMin * 60_000;
    if (url) {
      const r = await checkUrl(url, this.policyOf(cfg), { navigation: true });
      if (!r.ok) throw new HttpLike(400, r.reason || 'Geblokkeerd');
      await s.active.goto(r.url!.href, { waitUntil: 'domcontentloaded' }).catch(() => {});
      s.titles.set(s.active, await s.active.title().catch(() => ''));
    }
    this.ctx.store.update('browser_profiles', profile.id, { last_used_at: now() });
    this.logAction(u.id, agent.id, { actor: 'user', actorName: u.name, tool: 'browser_open', summary: 'Browser gestart door gebruiker', url: s.clean(s.active.url()), status: 'done' });
    this.emitStatus(agent.user_id, profile.id);
    return s;
  }

  /** A running session for a profile (started headless when needed; for the owner's own actions). */
  private async profileSession(p: BrowserProfile): Promise<BrowserSession> {
    try {
      return await this.browsers.ensure(this.sessionOpts(p));
    } catch (e: any) {
      throw new HttpLike(400, String(e?.message || e));
    }
  }

  /** Sites with cookies in a profile ("ingelogd bij"), grouped by site. Starts the browser headless if needed. */
  async cookieSites(p: BrowserProfile): Promise<{ site: string; cookies: number }[]> {
    const s = await this.profileSession(p);
    const counts = new Map<string, number>();
    for (const c of await s.context.cookies()) {
      const site = siteOf(c.domain);
      if (site) counts.set(site, (counts.get(site) || 0) + 1);
    }
    return [...counts.entries()].map(([site, cookies]) => ({ site, cookies })).sort((a, b) => a.site.localeCompare(b.site));
  }

  /** Log a profile out of one site: its cookies and site data (local storage, IndexedDB, cache) go. */
  async logoutSite(u: User, p: BrowserProfile, site: string, agentId: string | null) {
    const clean = siteOf(site);
    if (!clean) throw new HttpLike(400, 'Onbekende site');
    const s = await this.profileSession(p);
    const re = new RegExp(`(^|\\.)${clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    const domains = [...new Set((await s.context.cookies()).map((c) => c.domain.replace(/^\./, '')).filter((d) => re.test(d)))];
    await s.context.clearCookies({ domain: re });
    try {
      const cdp = await s.context.newCDPSession(s.active);
      for (const d of [...new Set([clean, ...domains])]) for (const scheme of ['https', 'http']) await cdp.send('Storage.clearDataForOrigin', { origin: `${scheme}://${d}`, storageTypes: 'all' }).catch(() => {});
      await cdp.detach().catch(() => {});
    } catch {
      /* cookies are gone; site storage is best effort */
    }
    for (const pg of s.pages()) {
      try {
        if (re.test(new URL(pg.url()).hostname)) await pg.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      } catch {
        /* not a web page */
      }
    }
    this.ctx.audit(u.id, 'browser.logout_site', { profile: p.id, site: clean }, agentId);
    const agent = agentId || this.agentOfProfile(p.id);
    if (agent) this.logAction(u.id, agent, { actor: 'user', actorName: u.name, tool: 'logout', summary: `Uitgelogd bij ${clean}`, status: 'done' });
    this.emitStatus(p.user_id, p.id);
    return { ok: true, site: clean };
  }

  /**
   * Share one browser profile (logins!) between selected bots. A bot's own profile becomes a shared one (its logins
   * stay); bots that are no longer selected go back to their own profile. One bot at a time works in it (lease).
   */
  async setProfileMembers(u: User, p: BrowserProfile, agentIds: string[]) {
    const mine = this.ctx.store.agents(u.id);
    const want = new Set(agentIds.filter((id) => mine.some((a) => a.id === id)));
    let profile = p;
    if (!p.shared) {
      const owner = p.agent_id ? this.ctx.store.agent(p.agent_id) : null;
      const name = `${owner?.name || 'Bot'} (gedeeld)`;
      this.ctx.store.update('browser_profiles', p.id, { shared: true, agent_id: null, name });
      profile = this.ctx.store.get<BrowserProfile>('browser_profiles', p.id)!;
      // sharing a bot's own profile: that bot keeps it (its logins live there)
      if (owner) want.add(owner.id);
      this.ctx.audit(u.id, 'browser.profile_shared', { profile: p.id, from: owner?.id || null });
    }
    const changed: string[] = [];
    for (const a of mine) {
      const cfg = this.config(a);
      const has = cfg.profile_id === profile.id;
      if (want.has(a.id) === has) continue;
      // the bot's running browser belongs to its previous profile: close it, the next action opens the new one
      const before = this.findProfile(a, cfg);
      if (before && before.id !== profile.id && !before.shared) await this.browsers.close('p:' + before.id);
      const next: ComputerConfig = { ...cfg, profile_id: want.has(a.id) ? profile.id : null, updated_at: now() };
      delete next.derived;
      this.upsertConfig(a, next);
      changed.push(a.id);
      this.ctx.events.emit(a.user_id, 'computer.config', this.config(a));
    }
    this.ctx.audit(u.id, 'browser.profile_members', { profile: profile.id, members: [...want].length, changed: changed.length });
    this.emitStatus(u.id, profile.id);
    return { profile, members: [...want] };
  }

  // ---------------- bot access (fail closed) ----------------

  /** Get the bot's browser for a tool call: checks mode + capability, then waits for control (lease). */
  async browserFor(t: ToolContext): Promise<BrowserSession> {
    const cfg = this.config(t.agent);
    if (cfg.mode === 'container') throw new Error('Deze bot werkt in een container, en daarin zit geen browser. Moet hij browsen, kies dan bij Bot › Computer & bestanden “Eigen browser”. Er wordt nooit teruggevallen op een browser op deze computer.');
    if (cfg.mode !== 'browser' && cfg.mode !== 'host') throw new Error(`Deze bot heeft geen eigen browser (computermodus: ${modeLabel(cfg.mode)}). De gebruiker kan dit aanzetten bij Bot › Computer & bestanden.`);
    const caps = await this.caps();
    if (caps.caps.browser.status !== 'available') throw new Error(`Geen browser beschikbaar op dit apparaat: ${caps.caps.browser.detail}`);
    const profile = this.profileFor(t.agent, cfg);
    await this.control(t, 'browser:' + profile.id);
    const s = await this.browsers.ensure(this.sessionOpts(profile));
    s.limits.idleMs = cfg.limits.idleMin * 60_000;
    this.ctx.store.update('browser_profiles', profile.id, { last_used_at: now() });
    if (s.createdAt > Date.now() - 2000) this.emitStatus(t.agent.user_id, profile.id);
    return s;
  }

  /** Wait until this run controls the resource (humans and other bots go first). */
  async control(t: ToolContext, resource: string) {
    const holder: Holder = { kind: 'bot', id: t.run.id, name: t.agent.name, agentId: t.agent.id };
    let announced = false;
    await this.leases.waitFor(resource, holder, {
      ttlMs: 120_000,
      alive: () => isRunActive(this.ctx, t.run.id),
      signal: t.signal,
      timeoutMs: 15 * 60_000,
      onWait: (h) => {
        if (announced) return;
        announced = true;
        t.progress(h.kind === 'user' ? 'Wacht: de gebruiker bedient deze computer nu' : `Wacht: ${h.name} gebruikt deze computer`);
      },
    });
  }

  async hostFor(t: ToolContext): Promise<ComputerConfig> {
    const cfg = this.config(t.agent);
    const owner = this.ctx.store.user(t.agent.user_id);
    if (cfg.mode !== 'host' || !cfg.host_control) throw new Error('Bureaubladbediening staat uit voor deze bot. Alleen de eigenaar kan dit per bot aanzetten bij Bot › Computer & bestanden.');
    if (owner?.role !== 'owner') throw new Error('Bureaubladbediening is alleen beschikbaar voor de eigenaar van deze computer.');
    const caps = await this.caps();
    if (caps.caps.host.status !== 'available') throw new Error(`Bureaubladbediening kan hier niet: ${caps.caps.host.detail}`);
    if (this.hostStopped.has(t.agent.id)) throw new Error('De gebruiker heeft de noodstop gebruikt. Bureaubladbediening is gepauzeerd tot de gebruiker hervat.');
    if (!cfg.host_apps.length && !cfg.host_options.allApps) throw new Error('Er staan nog geen toegestane apps op de lijst. De gebruiker kiest die bij Bot › Computer & bestanden.');
    await this.control(t, 'desktop:host');
    return cfg;
  }

  async allowedWindows(cfg: ComputerConfig): Promise<{ allowed: HostWindow[]; hidden: number }> {
    const r = await this.hostDriver.call('windows', {});
    const list: HostWindow[] = r.windows || [];
    const allowed = list.filter((w) => windowAllowed(w, cfg.host_apps, cfg.host_options));
    return { allowed, hidden: list.length - allowed.length };
  }

  async containerFor(t: ToolContext): Promise<ComputerConfig> {
    const cfg = this.config(t.agent);
    if (cfg.mode !== 'container') throw new Error(`Deze bot heeft geen privé-container (computermodus: ${modeLabel(cfg.mode)}).`);
    const iso = isolatedRuntime(await this.caps());
    if (!iso.available) throw new Error(`De afgeschermde omgeving is niet beschikbaar: ${iso.missing.join(' · ')}. Er wordt nooit teruggevallen op deze computer.`);
    await this.control(t, 'container:' + t.agent.id);
    return cfg;
  }

  // ---------------- human control ----------------

  private beatKey(resource: string, userId: string) {
    return resource + '|' + userId;
  }

  heartbeat(resource: string, userId: string) {
    this.beats.set(this.beatKey(resource, userId), Date.now());
    return this.leases.renew(resource, userId, 30_000);
  }

  /** The human takes control: the bot pauses (its next actions wait). `sticky` = pause without heartbeat. */
  takeControl(u: User, resource: string, o: { sticky?: boolean; session?: BrowserSession | null } = {}) {
    this.beats.set(this.beatKey(resource, u.id), Date.now());
    const r = this.leases.acquire(resource, { kind: 'user', id: u.id, name: u.name }, {
      preempt: true,
      ttlMs: o.sticky ? 365 * 864e5 : 30_000,
      alive: o.sticky ? () => true : () => Date.now() - (this.beats.get(this.beatKey(resource, u.id)) || 0) < 90_000 || !!(o.session && !o.session.closed && o.session.headed),
    });
    if (!r.ok) throw new HttpLike(409, `${r.holder.name} bedient deze computer al`);
    return r.lease;
  }

  releaseControl(u: User, resource: string) {
    this.beats.delete(this.beatKey(resource, u.id));
    return this.leases.release(resource, u.id);
  }

  controller(resource: string) {
    const l = this.leases.current(resource);
    return l ? { kind: l.holder.kind, name: l.holder.name, agentId: l.holder.agentId || null, userId: l.holder.kind === 'user' ? l.holder.id : null, since: new Date(l.since).toISOString(), sticky: l.ttlMs > 864e5, waiting: this.leases.waiting(resource).map((h) => h.name) } : null;
  }

  /** Emergency stop: cancel the bot's runs, close its browser, pause host control. */
  async emergencyStop(u: User, agent: Agent) {
    let cancelled = 0;
    for (const r of this.ctx.store.all<any>("SELECT id FROM runs WHERE agent_id = ? AND status IN ('queued','running','waiting')", agent.id)) {
      if (this.ctx.runs.cancel(r.id, 'Noodstop door gebruiker')) cancelled++;
      this.leases.releaseHolder(r.id);
    }
    const cfg = this.config(agent);
    if (cfg.host_control) {
      this.hostStopped.add(agent.id);
      // in-flight desktop input of this bot stops right now (the helper restarts on the next action)
      const l = this.leases.current('desktop:host');
      if (l?.holder.kind === 'bot' && l.holder.agentId === agent.id) this.screen.driver.kill();
      this.screen.revokeGrant(agent.id, 'noodstop');
    }
    const p = this.findProfile(agent, cfg);
    if (p && !p.shared) await this.browsers.close('p:' + p.id);
    if (cfg.mode === 'container') await this.container.stop(agent.id).catch(() => {});
    // the cancelled runs already sent SIGKILL to their remote commands; now drop the connection too
    this.remote.close(agent.id);
    this.logAction(u.id, agent.id, {
      actor: 'user',
      actorName: u.name,
      tool: 'stop',
      summary: 'Noodstop: taken gestopt, browser gesloten' + (cfg.host_control ? ', bureaubladbediening gepauzeerd' : '') + (cfg.mode === 'remote' ? ', serververbinding verbroken' : ''),
      status: 'done',
    });
    this.ctx.audit(u.id, 'computer.emergency_stop', { cancelled }, agent.id);
    if (p) this.emitStatus(u.id, p.id);
    else this.ctx.events.emit(u.id, 'computer.status', this.statusOf(agent));
    return { cancelled };
  }

  async closeFor(agent: Agent) {
    const p = this.findProfile(agent);
    if (p && !p.shared) await this.browsers.close('p:' + p.id);
  }

  // ---------------- action log + frames ----------------

  logAction(userId: string, agentId: string | null, a: { actor: 'bot' | 'user' | 'system'; actorName?: string; tool: string; summary: string; url?: string; status: string; threadId?: string | null; runId?: string | null }) {
    if (!agentId) return null;
    const row = {
      id: newId('ca_'),
      user_id: userId,
      agent_id: agentId,
      thread_id: a.threadId ?? null,
      run_id: a.runId ?? null,
      actor: a.actor,
      actor_name: a.actorName || '',
      tool: a.tool,
      summary: a.summary.slice(0, 500),
      url: (a.url || '').slice(0, 500),
      status: a.status,
      frame: null as string | null,
      created_at: now(),
    };
    this.ctx.store.insert('computer_actions', row);
    const n = this.ctx.store.one<any>('SELECT COUNT(*) n FROM computer_actions WHERE agent_id = ?', agentId)?.n ?? 0;
    if (n > MAX_ACTIONS) this.ctx.store.exec('DELETE FROM computer_actions WHERE id IN (SELECT id FROM computer_actions WHERE agent_id = ? ORDER BY created_at ASC LIMIT ?)', agentId, n - MAX_ACTIONS);
    this.ctx.events.emit(userId, 'computer.action', row);
    return row;
  }

  framesDir(agentId: string) {
    return path.join(this.base, 'frames', agentId.replace(/[^a-zA-Z0-9_-]/g, ''));
  }

  async saveFrame(userId: string, agentId: string, actionId: string, jpeg: Buffer | null) {
    if (!jpeg) return;
    const dir = this.framesDir(agentId);
    fs.mkdirSync(dir, { recursive: true });
    const name = actionId + '.jpg';
    fs.writeFileSync(path.join(dir, name), jpeg);
    this.ctx.store.update('computer_actions', actionId, { frame: name });
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg'));
    if (files.length > MAX_FRAMES) {
      const sorted = files.map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => a.t - b.t);
      for (const x of sorted.slice(0, files.length - MAX_FRAMES)) {
        fs.rmSync(path.join(dir, x.f), { force: true });
        this.ctx.store.exec('UPDATE computer_actions SET frame = NULL WHERE agent_id = ? AND frame = ?', agentId, x.f);
      }
    }
    this.ctx.events.emit(userId, 'computer.frame', { agentId, actionId });
  }

  // ---------------- status ----------------

  statusOf(agent: Agent) {
    const cfg = this.config(agent);
    const p = this.findProfile(agent, cfg);
    const s = p ? this.browsers.get('p:' + p.id) : null;
    const active = s && !s.active?.isClosed() ? s.active : null;
    return {
      agentId: agent.id,
      mode: cfg.mode,
      profileId: p?.id || null,
      profileShared: !!p?.shared,
      profileName: p?.name || null,
      browser: s
        ? {
            running: true,
            headed: s.headed,
            // inside TeamBot (invisible tabs) or an installed Edge/Chrome, and what its own processes use
            engine: s.engine,
            memoryMb: s.memoryMb(),
            tabs: s.tabs(),
            url: active ? s.clean(active.url()) : '',
            title: active ? s.clean(s.titles.get(active) || '') : '',
            since: new Date(s.createdAt).toISOString(),
            viewers: s.viewers.size,
            filling: s.privacy > 0,
          }
        : { running: false },
      controller: p ? this.controller('browser:' + p.id) : null,
      host: cfg.host_control
        ? (() => {
            const g = this.screen.grant(agent.id);
            return {
              enabled: true,
              stopped: this.hostStopped.has(agent.id),
              controller: this.controller('desktop:host'),
              apps: cfg.host_apps,
              level: cfg.host_level,
              allApps: cfg.host_options.allApps,
              grant: g ? { goal: g.goal, until: new Date(g.until).toISOString(), apps: g.apps, actions: g.actions, threadId: g.threadId } : null,
              hotkey: this.screen.hotkey,
            };
          })()
        : { enabled: false },
      remote:
        cfg.mode === 'remote'
          ? {
              host: cfg.remote.host,
              port: cfg.remote.port,
              username: cfg.remote.username,
              configured: !!(cfg.remote.host && cfg.remote.username),
              hasSecret: cfg.remote.has_secret,
              trusted: !!cfg.remote.fingerprint,
              connected: this.remote.isConnected(agent.id),
              docker: cfg.remote.docker.enabled,
              cloud: this.cloud?.isManaged(agent.id) || false,
              controller: this.controller('remote:' + agent.id),
            }
          : null,
      rehearsal: this.activeRehearsal(agent.id),
    };
  }

  emitStatus(userId: string, profileId: string) {
    const agents = this.ctx.store
      .all<any>('SELECT agent_id FROM computer_configs WHERE profile_id = ? UNION SELECT agent_id FROM browser_profiles WHERE id = ? AND agent_id IS NOT NULL', profileId, profileId)
      .map((r) => this.ctx.store.agent(r.agent_id))
      .filter(Boolean) as Agent[];
    for (const a of agents) this.ctx.events.emit(userId, 'computer.status', this.statusOf(a));
  }

  async modes(u: User) {
    const caps = await this.caps();
    return modeTable(caps, { isOwner: u.role === 'owner' });
  }

  // ---------------- rehearsal ----------------

  activeRehearsal(agentId: string): any | null {
    return this.ctx.store.one<any>("SELECT * FROM rehearsals WHERE agent_id = ? AND status IN ('active','review') ORDER BY created_at DESC LIMIT 1", agentId) || null;
  }

  /** The bot's real workspace (the original while a rehearsal copy is active). */
  realWorkspace(agent: Agent): string {
    return this.activeRehearsal(agent.id)?.original || agent.workspace;
  }

  startRehearsal(userId: string, agent: Agent, note: string) {
    if (this.activeRehearsal(agent.id)) throw new HttpLike(409, 'Er loopt al een repetitie voor deze bot. Rond die eerst af.');
    const id = newId('rh_');
    const dir = path.join(this.base, 'rehearsals', agent.id.replace(/[^a-zA-Z0-9_-]/g, ''), id);
    const copy = path.join(dir, 'work');
    const original = path.resolve(agent.workspace);
    let base: ws.Manifest;
    try {
      base = ws.startRehearsalCopy(original, copy, path.join(dir, 'base.json'));
    } catch (e: any) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new HttpLike(400, e instanceof ws.LimitError ? e.message : `Kopie maken mislukt: ${e.message}`);
    }
    const row = { id, user_id: userId, agent_id: agent.id, original, copy_dir: copy, status: 'active', note: note.slice(0, 500), files: Object.keys(base.files).length, skipped: base.skipped.length, created_at: now(), finished_at: null };
    this.ctx.store.insert('rehearsals', row);
    const upd = this.ctx.store.updateAgent(agent.id, { workspace: copy });
    this.ctx.events.emit(userId, 'agent.updated', upd);
    this.ctx.events.emit(userId, 'rehearsal.updated', row);
    this.ctx.audit(userId, 'rehearsal.started', { files: row.files }, agent.id);
    return row;
  }

  rehearsalChanges(r: any): ws.FileChange[] {
    if (!fs.existsSync(path.join(path.dirname(r.copy_dir), 'base.json'))) return [];
    return ws.rehearsalChanges(r.original, r.copy_dir, ws.readManifest(path.join(path.dirname(r.copy_dir), 'base.json')));
  }

  rehearsalFileDiff(r: any, key: string, from?: string) {
    return ws.rehearsalFileDiff(r.original, r.copy_dir, ws.readManifest(path.join(path.dirname(r.copy_dir), 'base.json')), key, from);
  }

  /** One file as two bots' practice copies of the same folder have it (B-42: compare, then apply one). */
  compareRehearsalFiles(r: any, other: any, key: string) {
    const base = (x: any) => ws.readManifest(path.join(path.dirname(x.copy_dir), 'base.json'));
    return ws.compareRehearsalFiles({ original: r.original, copyDir: r.copy_dir, base: base(r) }, { copyDir: other.copy_dir, base: base(other) }, key);
  }

  applyRehearsal(userId: string, r: any, files: string[] | null, force: string[]) {
    const { targets } = ws.planApply(this.rehearsalChanges(r), files, force);
    let snapshotId: string | null = null;
    // Everything in the real folder that this apply overwrites or removes (for a move: the old place, and a file of
    // the owner's own at the new place when he chose the bot's version anyway).
    const existing = [...new Set(targets.flatMap((c) => (c.from ? [c.from, c.path] : [c.path])))].filter((k) => ws.fileExistsIn(r.original, k));
    if (existing.length) {
      const agent = this.ctx.store.agent(r.agent_id);
      if (agent) snapshotId = this.createSnapshot(userId, agent, existing.length === 1 ? 'Voor toepassen repetitie (1 bestand)' : `Voor toepassen repetitie (${existing.length} bestanden)`, true, existing, r.original).id;
    }
    const res = ws.applyRehearsal(r.original, r.copy_dir, path.join(path.dirname(r.copy_dir), 'base.json'), files, force);
    this.ctx.audit(userId, 'rehearsal.applied', { applied: res.applied.length, conflicts: res.conflicts.length, held: res.held.length, snapshotId }, r.agent_id);
    this.ctx.events.emit(userId, 'rehearsal.updated', r);
    return { ...res, snapshotId };
  }

  revertRehearsal(userId: string, r: any, files: string[]) {
    const res = ws.revertInCopy(r.original, r.copy_dir, path.join(path.dirname(r.copy_dir), 'base.json'), files);
    this.ctx.audit(userId, 'rehearsal.reverted', { files: files.length, kept: res.kept.length }, r.agent_id);
    this.ctx.events.emit(userId, 'rehearsal.updated', r);
    return res;
  }

  /** End a rehearsal; unapplied changes are discarded. The original workspace is restored on the bot. */
  endRehearsal(userId: string, r: any, status: 'applied' | 'discarded') {
    const agent = this.ctx.store.agent(r.agent_id);
    if (agent && path.resolve(agent.workspace) === path.resolve(r.copy_dir)) {
      const upd = this.ctx.store.updateAgent(agent.id, { workspace: r.original });
      this.ctx.events.emit(userId, 'agent.updated', upd);
    }
    fs.rmSync(path.dirname(r.copy_dir), { recursive: true, force: true });
    this.ctx.store.update('rehearsals', r.id, { status, finished_at: now() });
    this.ctx.audit(userId, 'rehearsal.' + status, {}, r.agent_id);
    const row = this.ctx.store.get('rehearsals', r.id);
    this.ctx.events.emit(userId, 'rehearsal.updated', row);
    return row;
  }

  // ---------------- snapshots ----------------

  createSnapshot(userId: string, agent: Agent, label: string, auto: boolean, keys?: string[], rootOverride?: string) {
    const root = rootOverride || this.realWorkspace(agent);
    if (!auto) {
      const n = this.ctx.store.one<any>('SELECT COUNT(*) n FROM workspace_snapshots WHERE agent_id = ? AND auto = 0', agent.id)?.n ?? 0;
      if (n >= MAX_MANUAL_SNAPSHOTS) throw new HttpLike(400, `Maximaal ${MAX_MANUAL_SNAPSHOTS} eigen snapshots per bot. Verwijder eerst een oude snapshot.`);
    }
    const used = this.ctx.store.one<any>('SELECT COALESCE(SUM(bytes),0) b FROM workspace_snapshots WHERE user_id = ?', userId)?.b ?? 0;
    if (used > MAX_SNAPSHOT_BYTES_PER_USER) throw new HttpLike(400, 'De opslag voor snapshots is vol (2 GB). Verwijder oude snapshots.');
    const id = newId('ws_');
    const dir = path.join(this.base, 'snapshots', agent.id.replace(/[^a-zA-Z0-9_-]/g, ''), id);
    let m: ws.Manifest;
    try {
      m = ws.createSnapshot(root, dir, { keys });
    } catch (e: any) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new HttpLike(400, e instanceof ws.LimitError ? e.message : `Snapshot mislukt: ${e.message}`);
    }
    const bytes = Object.values(m.files).reduce((n, f) => n + f.size, 0);
    const row = { id, user_id: userId, agent_id: agent.id, workspace: root, label: label.slice(0, 200) || 'Snapshot', auto, partial: !!m.partial, files: Object.keys(m.files).length, bytes, dir, created_at: now() };
    this.ctx.store.insert('workspace_snapshots', row);
    if (auto) {
      const autos = this.ctx.store.all<any>('SELECT id, dir FROM workspace_snapshots WHERE agent_id = ? AND auto = 1 ORDER BY created_at DESC', agent.id);
      for (const old of autos.slice(MAX_AUTO_SNAPSHOTS)) {
        fs.rmSync(old.dir, { recursive: true, force: true });
        this.ctx.store.remove('workspace_snapshots', old.id);
      }
    }
    this.ctx.audit(userId, 'snapshot.created', { label: row.label, files: row.files, auto }, agent.id);
    this.ctx.events.emit(userId, 'snapshot.updated', { agentId: agent.id });
    return this.ctx.store.get<any>('workspace_snapshots', id);
  }

  restoreSnapshot(userId: string, snap: any, deleteExtra: boolean) {
    const agent = this.ctx.store.agent(snap.agent_id);
    if (!agent) throw new HttpLike(404, 'Bot niet gevonden');
    if (path.resolve(snap.workspace) !== path.resolve(this.realWorkspace(agent))) throw new HttpLike(409, 'De werkmap van deze bot is veranderd sinds deze snapshot. Herstellen is daarom geblokkeerd.');
    const plan = ws.restorePlan(snap.workspace, snap.dir);
    const touched = [...plan.overwrite, ...(deleteExtra ? plan.extra : [])];
    let before: string | null = null;
    if (touched.length) before = this.createSnapshot(userId, agent, 'Voor herstel van snapshot', true, touched, snap.workspace).id;
    const res = ws.restoreSnapshot(snap.workspace, snap.dir, { deleteExtra });
    this.ctx.audit(userId, 'snapshot.restored', { id: snap.id, overwrite: res.overwrite.length, recreate: res.recreate.length, deleted: deleteExtra ? res.extra.length : 0, before }, agent.id);
    this.ctx.events.emit(userId, 'snapshot.updated', { agentId: agent.id });
    return { ...res, deleted: deleteExtra ? res.extra : [], before };
  }

  deleteSnapshot(userId: string, snap: any) {
    fs.rmSync(snap.dir, { recursive: true, force: true });
    this.ctx.store.remove('workspace_snapshots', snap.id);
    this.ctx.audit(userId, 'snapshot.deleted', { label: snap.label }, snap.agent_id);
    this.ctx.events.emit(userId, 'snapshot.updated', { agentId: snap.agent_id });
  }

  // ---------------- lifecycle ----------------

  async agentDeleted(agentId: string, userId: string) {
    const prof = this.ctx.store.one<any>('SELECT * FROM browser_profiles WHERE agent_id = ? AND shared = 0', agentId);
    if (prof) {
      await this.browsers.close('p:' + prof.id);
      await this.browsers.removeProfile(this.profileDir(prof.id));
      this.ctx.store.remove('browser_profiles', prof.id);
    }
    const r = this.activeRehearsal(agentId);
    if (r) {
      // give the bot its original folder back before the core deletes the agent
      const agent = this.ctx.store.agent(agentId);
      if (agent && path.resolve(agent.workspace) === path.resolve(r.copy_dir)) this.ctx.store.updateAgent(agentId, { workspace: r.original });
    }
    for (const x of this.ctx.store.find<any>('rehearsals', { agent_id: agentId })) fs.rmSync(path.dirname(x.copy_dir), { recursive: true, force: true });
    for (const x of this.ctx.store.find<any>('workspace_snapshots', { agent_id: agentId })) fs.rmSync(x.dir, { recursive: true, force: true });
    fs.rmSync(this.framesDir(agentId), { recursive: true, force: true });
    for (const t of ['rehearsals', 'workspace_snapshots', 'computer_actions']) this.ctx.store.exec(`DELETE FROM ${t} WHERE agent_id = ?`, agentId);
    this.ctx.store.exec('DELETE FROM computer_configs WHERE agent_id = ?', agentId);
    this.remote.close(agentId);
    this.mismatchNotified.delete(agentId);
    for (const s of this.ctx.secrets.list(userId)) if (s.name === secretNameFor(agentId)) this.ctx.secrets.delete(s.id);
    this.container.remove(agentId).catch(() => {});
    this.hostStopped.delete(agentId);
    this.ctx.audit(userId, 'computer.agent_cleanup', {}, agentId);
  }

  async sweep() {
    pruneSnapshots();
    const closed = await this.browsers.closeIdle((s) => !!this.leases.current('browser:' + s.opts.profileId));
    for (const k of closed) {
      const pid = k.slice(2);
      const p = this.ctx.store.get<BrowserProfile>('browser_profiles', pid);
      if (p) this.emitStatus(p.user_id, p.id);
    }
    for (const f of fs.readdirSync(path.join(this.base, 'tmp'))) {
      const full = path.join(this.base, 'tmp', f);
      const st = fs.statSync(full, { throwIfNoEntry: false });
      if (st && Date.now() - st.mtimeMs > 3600_000) fs.rmSync(full, { recursive: true, force: true });
    }
    // desktop preview images only matter while their refs are valid
    const hostDir = path.join(this.base, 'host');
    for (const d of fs.readdirSync(hostDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      for (const f of fs.readdirSync(path.join(hostDir, d.name))) {
        const full = path.join(hostDir, d.name, f);
        const st = fs.statSync(full, { throwIfNoEntry: false });
        if (st && Date.now() - st.mtimeMs > 3600_000) fs.rmSync(full, { force: true });
      }
    }
  }

  async stop() {
    for (const s of this.streams) {
      try {
        s.end();
      } catch {
        /* ignore */
      }
    }
    this.streams.clear();
    this.remote.closeAll();
    this.screen.stop();
    await this.browsers.closeAll();
    desktopSnapshots.clear();
  }

  exportUser(userId: string) {
    return {
      computers: {
        configs: this.ctx.store.find('computer_configs', { user_id: userId }),
        profiles: this.ctx.store.find('browser_profiles', { user_id: userId }),
        actions: this.ctx.store.all('SELECT * FROM computer_actions WHERE user_id = ? ORDER BY created_at DESC LIMIT 5000', userId),
        rehearsals: this.ctx.store.find('rehearsals', { user_id: userId }),
        snapshots: this.ctx.store.find('workspace_snapshots', { user_id: userId }).map((s: any) => ({ ...s, dir: undefined })),
        cloudVms: this.cloud?.exportUser(userId) || [],
        // which logins exist; never the username, password or 2FA secret
        vault: this.vault?.exportUser(userId) || [],
      },
    };
  }

  /** Pre-check a navigation for a clear error before the proxy blocks it. */
  async checkNavigation(agent: Agent, url: string) {
    const r = await checkUrl(url, this.policyOf(this.config(agent)), { navigation: true });
    if (!r.ok) throw new Error(r.reason);
    return r.url!;
  }
}

/** "accounts.google.com" / ".google.com" / a URL → "google.com" (rough registrable domain; IPs and localhost as is). */
export function siteOf(input: string): string | null {
  let d = String(input || '').trim().toLowerCase();
  if (d.includes('://')) {
    try {
      d = new URL(d).hostname;
    } catch {
      return null;
    }
  }
  d = d.replace(/^\.+/, '').replace(/\.$/, '');
  if (!d || /[^a-z0-9.\-:[\]]/.test(d)) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(d) || d.includes(':') || !d.includes('.')) return d;
  const parts = d.split('.');
  if (parts.length <= 2) return d;
  const sld = parts[parts.length - 2];
  const tld = parts[parts.length - 1];
  const n = tld.length === 2 && ['co', 'com', 'net', 'org', 'gov', 'ac', 'edu', 'or', 'ne', 'go'].includes(sld) ? 3 : 2;
  return parts.slice(-n).join('.');
}

export class HttpLike extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function modeLabel(m: ModeId) {
  return { none: 'geen computer', workspace: 'alleen werkmap', browser: 'eigen browser', host: 'mijn bureaublad', container: 'privé-container', remote: 'eigen server (SSH)' }[m] || m;
}
