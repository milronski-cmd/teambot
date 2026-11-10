import crypto from 'node:crypto';
import net from 'node:net';
import type { Agent, Ctx, User } from '../../../core/types.js';
import { newId, now } from '../../../core/db.js';
import { isRestricted, memberPolicy } from '../../../api/member-policy.js';
import { isPrivateIp } from '../../../tools/builtin/web.js';
import { isPrivateAddress } from '../policy.js';
import { HostKeyRejected, capture, connectSsh, lastLine, mismatchMessage, wrapSh } from '../remote.js';
import { HttpLike, type ComputerService } from '../service.js';
import { HetznerProvider } from './hetzner.js';
import { DigitalOceanProvider } from './digitalocean.js';
import { buildCloudInit, genKeyPair } from './cloudinit.js';
import { CloudApiError, defaultChoice, estimate, type CloudEstimate, type CloudOptions, type CloudProvider, type CloudServer, type CreateServerInput } from './provider.js';

/**
 * Cloud-VM per bot (CMP-07 part 2): TeamBot creates a VM through a cloud API (Hetzner, DigitalOcean), gives it a cloud-init
 * with a host key TeamBot generated itself, waits until SSH answers with exactly that key, and then points the bot's
 * remote (SSH) config at it with the fingerprint already pinned. Power on/off and delete go through the same API.
 * Costs are the user's own (their token, their invoice) and never count towards the daily LLM budget.
 */

export type VmStatus = 'creating' | 'booting' | 'running' | 'stopping' | 'off' | 'starting' | 'deleting' | 'deleted' | 'error';

export interface CloudVm {
  id: string;
  user_id: string;
  agent_id: string | null;
  agent_name: string;
  provider: string;
  provider_id: string | null;
  name: string;
  server_type: string;
  location: string;
  image: string;
  ip: string | null;
  status: VmStatus;
  detail: string;
  host_fingerprint: string;
  docker: boolean;
  price: CloudEstimate | Record<string, never>;
  created_at: string;
  updated_at: string;
  ready_at: string | null;
  action_at: string | null;
  deleted_at: string | null;
}

const TRANSITIONAL: VmStatus[] = ['creating', 'booting', 'starting', 'stopping', 'deleting'];
const READY_PROBE = 'if command -v cloud-init >/dev/null 2>&1; then cloud-init status --wait >/dev/null 2>&1 || true; fi; echo teambot-ready';
const MAX_VMS_PER_USER = 10;

export const tokenName = (provider: string) => `cloud-token:${provider}`;
export const vmKeyName = (vmId: string) => `cloudvm-key:${vmId}`;

/** A cloud error as an HTTP error for our own API (never 401: the UI would think the TeamBot session ended). */
function http(e: unknown): Error {
  if (e instanceof HttpLike) return e;
  if (e instanceof CloudApiError) return new HttpLike(e.status === 401 || e.status === 0 ? 400 : e.status === 429 ? 429 : e.status >= 500 ? 502 : e.status === 403 ? 403 : 400, e.message);
  return new HttpLike(500, 'Onverwachte fout bij de cloudprovider.');
}

function vmName(agent: Agent) {
  const slug = agent.name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  return `teambot-${slug || 'bot'}-${crypto.randomBytes(2).toString('hex')}`;
}

export class CloudVmService {
  /** Provider adapters (tests swap in one pointed at a fake API). */
  providers: Record<string, CloudProvider>;
  /** Development/tests only: accept a non-public VM address. Production refuses private IPs. */
  allowPrivateIps = process.env.TEAMBOT_CLOUDVM_DEV === '1';
  /** SSH port of the VMs (tests point it at an in-process SSH server). */
  sshPort = 22;
  pollMs = 4000;
  bootTimeoutMs = 15 * 60_000;
  shutdownGraceMs = 90_000;
  refreshEveryMs = 5 * 60_000;
  private watching = new Set<string>();
  private timers = new Set<NodeJS.Timeout>();
  private hardOff = new Set<string>();
  private lastRefresh = new Map<string, number>();
  private optionsCache = new Map<string, { at: number; o: CloudOptions }>();
  private stopped = false;

  constructor(
    private ctx: Ctx,
    private computers: ComputerService,
  ) {
    const dev = process.env.TEAMBOT_CLOUDVM_DEV === '1';
    this.providers = {
      hetzner: new HetznerProvider({ baseUrl: dev ? process.env.TEAMBOT_HETZNER_API_URL : undefined }),
      digitalocean: new DigitalOceanProvider({ baseUrl: dev ? process.env.TEAMBOT_DO_API_URL : undefined }),
    };
  }

  // ---------------- access, token, options ----------------

  provider(id: string): CloudProvider {
    const p = this.providers[id];
    if (!p) throw new HttpLike(400, 'Onbekende cloudprovider.');
    return p;
  }

  allowedFor(userId: string): { allowed: boolean; reason?: string } {
    const u = this.ctx.store.user(userId);
    if (isRestricted(this.ctx, u) && !memberPolicy(this.ctx).allowCloudVm)
      return { allowed: false, reason: "Cloud-VM's staan op deze server uit voor leden. De eigenaar of een beheerder kan ze toestaan bij Instellingen › Gebruikers (met je eigen token en op je eigen kosten)." };
    return { allowed: true };
  }

  private requireAllowed(userId: string) {
    const a = this.allowedFor(userId);
    if (!a.allowed) throw new HttpLike(403, a.reason!);
  }

  private token(userId: string, provider: string): string | null {
    return this.ctx.secrets.getByName(userId, tokenName(provider));
  }

  providerList(userId: string) {
    const a = this.allowedFor(userId);
    return Object.values(this.providers).map((p) => ({ id: p.id, label: p.label, has_token: !!this.token(userId, p.id), allowed: a.allowed, reason: a.reason }));
  }

  /** Check the token with the provider, then store it encrypted (never returned, logged or audited). */
  async saveToken(u: User, providerId: string, raw: unknown) {
    this.requireAllowed(u.id);
    const p = this.provider(providerId);
    const token = typeof raw === 'string' ? raw.trim() : '';
    if (!token) throw new HttpLike(400, 'Plak de API-token.');
    if (token.length > 500 || !/^[\x21-\x7e]+$/.test(token)) throw new HttpLike(400, 'Dit lijkt geen geldige API-token.');
    try {
      await p.check(token);
    } catch (e) {
      throw http(e);
    }
    this.ctx.secrets.set(u.id, tokenName(p.id), token);
    this.optionsCache.delete(`${u.id}|${p.id}`);
    this.ctx.audit(u.id, 'cloudvm.token_set', { provider: p.id });
    return { has_token: true };
  }

  deleteToken(u: User, providerId: string) {
    const p = this.provider(providerId);
    for (const s of this.ctx.secrets.list(u.id)) if (s.name === tokenName(p.id)) this.ctx.secrets.delete(s.id);
    this.optionsCache.delete(`${u.id}|${p.id}`);
    this.ctx.audit(u.id, 'cloudvm.token_deleted', { provider: p.id, activeVms: this.list(u.id).filter((v) => v.provider === p.id).length });
    return { has_token: false };
  }

  async options(userId: string, providerId: string, refresh = false): Promise<CloudOptions> {
    this.requireAllowed(userId);
    const p = this.provider(providerId);
    const token = this.token(userId, p.id);
    if (!token) throw new HttpLike(400, `Sla eerst een API-token van ${p.label} op.`);
    const key = `${userId}|${p.id}`;
    const hit = this.optionsCache.get(key);
    if (!refresh && hit && Date.now() - hit.at < 10 * 60_000) return hit.o;
    let o: CloudOptions;
    try {
      o = await p.options(token);
    } catch (e) {
      throw http(e);
    }
    this.optionsCache.set(key, { at: Date.now(), o });
    return o;
  }

  async optionsView(userId: string, providerId: string, refresh = false) {
    const o = await this.options(userId, providerId, refresh);
    return { ...o, defaults: defaultChoice(o) };
  }

  async estimateView(userId: string, providerId: string, type: string, location: string) {
    const e = estimate(await this.options(userId, providerId), type, location);
    if (!e) throw new HttpLike(400, 'Dit servertype is niet beschikbaar op deze locatie.');
    return e;
  }

  // ---------------- rows ----------------

  get(id: string): CloudVm | null {
    return this.ctx.store.get<CloudVm>('cloud_vms', id);
  }

  list(userId: string): CloudVm[] {
    return this.ctx.store.all<any>("SELECT * FROM cloud_vms WHERE user_id = ? AND status != 'deleted' ORDER BY created_at DESC", userId).map((r) => this.ctx.store.decode('cloud_vms', r));
  }

  forAgent(agentId: string): CloudVm | null {
    const r = this.ctx.store.one<any>("SELECT * FROM cloud_vms WHERE agent_id = ? AND status != 'deleted' ORDER BY created_at DESC LIMIT 1", agentId);
    return r ? this.ctx.store.decode('cloud_vms', r) : null;
  }

  /** The bot's own server is a TeamBot-managed VM: host/port/user/key/fingerprint are not editable by hand. */
  isManaged(agentId: string) {
    return !!this.forAgent(agentId);
  }

  /** Why the bot's remote tools can't run right now (null = the VM is ready or the bot has no VM). */
  blockReason(agentId: string): string | null {
    const vm = this.forAgent(agentId);
    if (!vm) return null;
    switch (vm.status) {
      case 'running':
        return null;
      case 'creating':
      case 'booting':
        return 'De cloud-VM van deze bot wordt nog aangemaakt en opgestart. Probeer het over een minuut opnieuw.';
      case 'starting':
        return 'De cloud-VM van deze bot wordt aangezet. Probeer het over een minuut opnieuw.';
      case 'stopping':
      case 'off':
        return 'De cloud-VM van deze bot staat uit. De gebruiker kan hem aanzetten bij Bot › Computer & bestanden of op de pagina Computers.';
      case 'deleting':
        return 'De cloud-VM van deze bot wordt verwijderd.';
      default:
        return `De cloud-VM van deze bot heeft een probleem: ${vm.detail || 'onbekende fout'}`;
    }
  }

  private set(vm: CloudVm, patch: Partial<CloudVm>) {
    this.ctx.store.update('cloud_vms', vm.id, { ...patch, updated_at: now() });
    const row = this.get(vm.id)!;
    this.ctx.events.emit(vm.user_id, 'cloudvm.updated', row);
    return row;
  }

  private ipOk(ip: string) {
    if (this.allowPrivateIps) return net.isIP(ip) > 0;
    return net.isIP(ip) > 0 && !isPrivateAddress(ip) && !isPrivateIp(ip);
  }

  private agentOf(vm: CloudVm): Agent | null {
    const a = vm.agent_id ? this.ctx.store.agent(vm.agent_id) : null;
    return a && a.user_id === vm.user_id ? a : null;
  }

  // ---------------- lifecycle ----------------

  /** Create a VM for the bot. `confirmCost` must equal the current monthly estimate the user saw. */
  async create(u: User, agent: Agent, body: any): Promise<CloudVm> {
    this.requireAllowed(agent.user_id);
    const p = this.provider(String(body?.provider || 'hetzner'));
    const token = this.token(agent.user_id, p.id);
    if (!token) throw new HttpLike(400, `Sla eerst een API-token van ${p.label} op.`);
    if (this.forAgent(agent.id)) throw new HttpLike(409, 'Deze bot heeft al een cloud-VM. Verwijder die eerst.');
    if (this.list(agent.user_id).length >= MAX_VMS_PER_USER) throw new HttpLike(400, `Maximaal ${MAX_VMS_PER_USER} cloud-VM's per gebruiker.`);
    const o = await this.options(agent.user_id, p.id, true); // fresh prices
    const location = String(body?.location || '');
    const serverType = String(body?.server_type || '');
    const image = String(body?.image || '');
    if (!o.locations.some((l) => l.name === location)) throw new HttpLike(400, 'Onbekende locatie.');
    if (!o.images.some((i) => i.name === image)) throw new HttpLike(400, 'Onbekend image (alleen Ubuntu en Debian).');
    const est = estimate(o, serverType, location);
    if (!est) throw new HttpLike(400, 'Dit servertype is niet beschikbaar op deze locatie.');
    if (String(body?.confirmCost ?? '') !== est.confirm)
      throw new HttpLike(409, `Bevestig eerst de kosten: ongeveer ${est.currency} ${est.confirm} per maand (de prijs kan veranderd zijn).`);
    const docker = body?.docker === true;
    const id = newId('cvm_');
    const hostKey = genKeyPair('teambot-host');
    const client = genKeyPair(`teambot-${agent.id}`);
    const name = vmName(agent);
    const userData = buildCloudInit({ hostKey, clientPublicKey: client.public, docker, label: `${agent.name} (${agent.id})` });
    // the client key logs in later; it is stored before the VM exists and removed again if creating fails
    this.ctx.secrets.set(agent.user_id, vmKeyName(id), client.private);
    const input: CreateServerInput = { name, serverType, location, image, userData, labels: { 'managed-by': 'teambot', 'teambot-vm': id } };
    let srv: CloudServer | null = null;
    try {
      srv = await p.createServer(token, input);
    } catch (e) {
      // lost in transit (time-out, outage)? Then the server may exist anyway and cost money: look it up by its unique
      // name (Hetzner) or tag (DigitalOcean)
      if (e instanceof CloudApiError && e.transient && e.status !== 429 && p.findCreated) srv = await p.findCreated(token, input).catch(() => null);
      if (!srv) {
        for (const s of this.ctx.secrets.list(agent.user_id)) if (s.name === vmKeyName(id)) this.ctx.secrets.delete(s.id);
        this.ctx.audit(u.id, 'cloudvm.create_failed', { provider: p.id, server_type: serverType, location, code: e instanceof CloudApiError ? e.code : 'error' }, agent.id);
        throw http(e);
      }
    }
    const ts = now();
    const row: CloudVm = {
      id,
      user_id: agent.user_id,
      agent_id: agent.id,
      agent_name: agent.name,
      provider: p.id,
      provider_id: srv.id,
      name: srv.name || name,
      server_type: serverType,
      location,
      image,
      ip: srv.ipv4,
      status: 'creating',
      detail: '',
      host_fingerprint: hostKey.fingerprint,
      docker,
      price: est,
      created_at: ts,
      updated_at: ts,
      ready_at: null,
      action_at: ts,
      deleted_at: null,
    };
    this.ctx.store.insert('cloud_vms', row);
    this.ctx.audit(u.id, 'cloudvm.created', { provider: p.id, name: row.name, server_type: serverType, location, image, docker, monthly: est.totalMonthlyGross, currency: est.currency, fingerprint: hostKey.fingerprint }, agent.id);
    this.ctx.events.emit(agent.user_id, 'cloudvm.updated', row);
    this.watch(id);
    return row;
  }

  private requireToken(vm: CloudVm): string {
    const t = this.token(vm.user_id, vm.provider);
    if (!t) throw new HttpLike(400, `De API-token van ${this.provider(vm.provider).label} is niet (meer) opgeslagen. Sla hem opnieuw op, of beheer de VM in de console van de provider.`);
    return t;
  }

  async powerOff(u: User, vm: CloudVm) {
    if (!['running', 'booting', 'error', 'starting'].includes(vm.status) || !vm.provider_id) throw new HttpLike(409, 'Deze VM kan nu niet worden uitgezet.');
    try {
      await this.provider(vm.provider).shutdown(this.requireToken(vm), vm.provider_id);
    } catch (e) {
      throw http(e);
    }
    this.hardOff.delete(vm.id);
    if (vm.agent_id) this.computers.remote.close(vm.agent_id);
    const row = this.set(vm, { status: 'stopping', detail: '', action_at: now() });
    this.ctx.audit(u.id, 'cloudvm.poweroff', { name: vm.name }, vm.agent_id);
    this.watch(vm.id);
    return row;
  }

  async powerOn(u: User, vm: CloudVm) {
    if (!['off', 'error'].includes(vm.status) || !vm.provider_id) throw new HttpLike(409, 'Deze VM staat niet uit.');
    try {
      await this.provider(vm.provider).powerOn(this.requireToken(vm), vm.provider_id);
    } catch (e) {
      throw http(e);
    }
    const row = this.set(vm, { status: 'starting', detail: '', action_at: now() });
    this.ctx.audit(u.id, 'cloudvm.poweron', { name: vm.name }, vm.agent_id);
    this.watch(vm.id);
    return row;
  }

  /** Delete the VM at the provider. Requires the VM's name typed by the user. */
  async remove(u: User, vm: CloudVm, confirm: unknown) {
    if (vm.status === 'deleted' || vm.status === 'deleting') throw new HttpLike(409, 'Deze VM wordt al verwijderd.');
    if (String(confirm ?? '').trim() !== vm.name) throw new HttpLike(400, `Typ de naam van de VM (${vm.name}) om te bevestigen dat je hem wilt verwijderen.`);
    if (vm.provider_id) {
      try {
        await this.provider(vm.provider).deleteServer(this.requireToken(vm), vm.provider_id);
      } catch (e) {
        throw http(e);
      }
    }
    const agent = this.agentOf(vm);
    if (agent) this.computers.detachCloudVm(agent, vm.host_fingerprint);
    const row = this.set(vm, { status: 'deleting', detail: '', action_at: now() });
    this.ctx.audit(u.id, 'cloudvm.deleted', { name: vm.name, provider: vm.provider }, vm.agent_id);
    this.watch(vm.id);
    return row;
  }

  /** Re-read the provider state once (button "Vernieuwen", and the periodic sweep). */
  async refresh(vm: CloudVm): Promise<CloudVm> {
    this.lastRefresh.set(vm.id, Date.now());
    if (TRANSITIONAL.includes(vm.status)) {
      this.watch(vm.id);
      return vm;
    }
    if (vm.status === 'deleted' || !vm.provider_id) return vm;
    const token = this.token(vm.user_id, vm.provider);
    if (!token) return vm;
    let srv: CloudServer | null;
    try {
      srv = await this.provider(vm.provider).getServer(token, vm.provider_id);
    } catch (e) {
      if (e instanceof CloudApiError && e.status === 401) return this.set(vm, { detail: e.message });
      return vm;
    }
    if (!srv) return this.markDeleted(vm, true);
    if (srv.status === 'off' && vm.status !== 'off') return this.set(vm, { status: 'off', detail: '' });
    if (srv.status === 'running' && vm.status === 'off') {
      const row = this.set(vm, { status: 'booting', detail: '', action_at: now() });
      this.watch(vm.id);
      return row;
    }
    return vm;
  }

  private markDeleted(vm: CloudVm, outside: boolean) {
    for (const s of this.ctx.secrets.list(vm.user_id)) if (s.name === vmKeyName(vm.id)) this.ctx.secrets.delete(s.id);
    const agent = this.agentOf(vm);
    if (agent) this.computers.detachCloudVm(agent, vm.host_fingerprint);
    const row = this.set(vm, { status: 'deleted', deleted_at: now(), detail: outside ? 'Verwijderd buiten TeamBot om.' : '' });
    if (outside) {
      this.ctx.audit(vm.user_id, 'cloudvm.gone', { name: vm.name }, vm.agent_id);
      this.ctx.events.emit(vm.user_id, 'notification', { title: `Cloud-VM ${vm.name} bestaat niet meer`, body: 'De VM is buiten TeamBot om verwijderd. De bot gebruikt hem niet meer.', link: '#/m/browser', kind: 'warning' });
    }
    return row;
  }

  // ---------------- background ----------------

  private watch(id: string) {
    if (this.watching.has(id) || this.stopped) return;
    this.watching.add(id);
    const started = Date.now();
    const loop = async () => {
      let again = false;
      try {
        again = await this.step(id, started);
      } catch (e: any) {
        this.ctx.log.warn('[cloudvm] step failed', e?.message);
        again = true;
      }
      if (again && !this.stopped && Date.now() - started < this.bootTimeoutMs + 10 * 60_000) this.later(loop, this.pollMs);
      else this.watching.delete(id);
    };
    this.later(loop, 10);
  }

  private later(fn: () => void, ms: number) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    t.unref?.();
    this.timers.add(t);
  }

  /** One state transition. Returns true while there is something to wait for. */
  private async step(id: string, started: number): Promise<boolean> {
    const vm = this.get(id);
    if (!vm || !TRANSITIONAL.includes(vm.status) || !vm.provider_id) return false;
    const token = this.token(vm.user_id, vm.provider);
    if (!token) {
      this.set(vm, { status: 'error', detail: 'De API-token is verwijderd, dus TeamBot kan deze VM niet meer volgen. Sla de token opnieuw op.' });
      return false;
    }
    const p = this.provider(vm.provider);
    let srv: CloudServer | null;
    try {
      srv = await p.getServer(token, vm.provider_id);
    } catch (e) {
      if (e instanceof CloudApiError && !e.transient) {
        this.set(vm, { status: 'error', detail: e.message });
        return false;
      }
      return true; // rate limit, outage, network: try again
    }
    if (!srv) {
      this.markDeleted(vm, vm.status !== 'deleting');
      return false;
    }
    const late = Date.now() - started > this.bootTimeoutMs;
    switch (vm.status) {
      case 'creating':
      case 'starting': {
        if (srv.status === 'running' && srv.ipv4) {
          if (!this.ipOk(srv.ipv4)) {
            this.set(vm, { status: 'error', detail: `De provider gaf geen openbaar IPv4-adres (${srv.ipv4}). TeamBot verbindt alleen met openbare adressen.` });
            this.ctx.audit(vm.user_id, 'cloudvm.error', { name: vm.name, reason: 'private_ip' }, vm.agent_id);
            return false;
          }
          this.set(vm, { status: 'booting', ip: srv.ipv4 });
          return true;
        }
        if (late) {
          this.set(vm, { status: 'error', detail: 'De VM is na 15 minuten nog niet gestart. Kijk in de console van de provider of verwijder hem.' });
          return false;
        }
        return true;
      }
      case 'booting': {
        if (srv.status === 'off') {
          this.set(vm, { status: 'off' });
          return false;
        }
        if (srv.status !== 'running') return true;
        let ip = vm.ip;
        if (srv.ipv4 && srv.ipv4 !== vm.ip) {
          if (!this.ipOk(srv.ipv4)) {
            this.set(vm, { status: 'error', detail: `De provider gaf geen openbaar IPv4-adres (${srv.ipv4}).` });
            return false;
          }
          ip = srv.ipv4;
          this.set(vm, { ip });
        }
        const r = await this.probe({ ...vm, ip });
        if (r === 'ready') {
          const agent = this.agentOf(vm);
          const secret = this.ctx.secrets.getByName(vm.user_id, vmKeyName(vm.id));
          if (agent && secret && ip) this.computers.attachCloudVm(agent, { ip, port: this.sshPort, fingerprint: vm.host_fingerprint, privateKey: secret, docker: vm.docker });
          const first = !vm.ready_at;
          this.set(vm, { status: 'running', detail: '', ready_at: vm.ready_at || now() });
          if (first) {
            this.ctx.audit(vm.user_id, 'cloudvm.ready', { name: vm.name, ip }, vm.agent_id);
            this.ctx.events.emit(vm.user_id, 'notification', { title: `Cloud-VM ${vm.name} is klaar`, body: `${vm.agent_name} kan nu op zijn eigen server werken.`, link: vm.agent_id ? `#/agents/${vm.agent_id}/edit` : '#/m/browser', kind: 'agent', agentId: vm.agent_id });
          }
          return false;
        }
        if (r !== 'wait') {
          this.set(vm, { status: 'error', detail: r.error });
          return false;
        }
        if (late) {
          this.set(vm, { status: 'error', detail: 'De VM draait, maar reageert na 15 minuten nog niet via SSH. Kijk in de console van de provider of verwijder hem.' });
          return false;
        }
        return true;
      }
      case 'stopping': {
        if (srv.status === 'off') {
          this.hardOff.delete(vm.id);
          this.set(vm, { status: 'off', detail: '' });
          return false;
        }
        // a shutdown that does not finish (OS ignores ACPI) becomes a hard power off
        if (!this.hardOff.has(vm.id) && Date.now() - Date.parse(vm.action_at || vm.updated_at) > this.shutdownGraceMs) {
          this.hardOff.add(vm.id);
          await p.powerOff(token, vm.provider_id).catch(() => {});
        }
        return true;
      }
      case 'deleting':
        return true;
      default:
        return false;
    }
  }

  /** SSH with the pinned (self-generated) host key; ready once cloud-init has finished. */
  private async probe(vm: CloudVm): Promise<'ready' | 'wait' | { error: string }> {
    const secret = this.ctx.secrets.getByName(vm.user_id, vmKeyName(vm.id));
    if (!secret) return { error: 'De SSH-sleutel van deze VM ontbreekt in TeamBot. Verwijder de VM en maak een nieuwe.' };
    if (!vm.ip) return 'wait';
    let conn: Awaited<ReturnType<typeof connectSsh>>;
    try {
      conn = await connectSsh({ ip: vm.ip, port: this.sshPort, username: 'teambot', auth: 'key', secret, verify: (fp) => fp === vm.host_fingerprint, timeoutMs: 10_000 });
    } catch (e) {
      if (e instanceof HostKeyRejected) {
        this.ctx.audit(vm.user_id, 'remote.hostkey_mismatch', { host: vm.ip, expected: vm.host_fingerprint, observed: e.fingerprint, cloudVm: vm.name }, vm.agent_id);
        return { error: `${mismatchMessage(e.fingerprint, vm.host_fingerprint)} TeamBot heeft de sleutel van deze VM zelf gemaakt; een andere sleutel betekent dat je met een andere machine praat.` };
      }
      return 'wait'; // not up yet (refused, timeout, user not created yet)
    }
    try {
      const r = await capture(conn.client, wrapSh(READY_PROBE), 10 * 60_000);
      return lastLine(r.out) === 'teambot-ready' ? 'ready' : 'wait';
    } catch {
      return 'wait';
    } finally {
      conn.client.end();
    }
  }

  /** Resume watching transitional VMs after a restart. */
  start() {
    this.stopped = false;
    for (const r of this.ctx.store.all<any>(`SELECT id FROM cloud_vms WHERE status IN (${TRANSITIONAL.map(() => '?').join(',')})`, ...TRANSITIONAL)) this.watch(r.id);
  }

  /** Periodic, low-rate check of stable VMs (deleted or switched off outside TeamBot). */
  async sweep() {
    const rows = this.ctx.store.all<any>("SELECT * FROM cloud_vms WHERE status IN ('running','off','error')").map((r) => this.ctx.store.decode<CloudVm>('cloud_vms', r));
    let n = 0;
    for (const vm of rows) {
      if (n >= 20) break;
      if (Date.now() - (this.lastRefresh.get(vm.id) || 0) < this.refreshEveryMs) continue;
      n++;
      await this.refresh(vm).catch(() => {});
    }
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.watching.clear();
  }

  /** The bot is gone, its VM is not: never delete silently, never let it run unnoticed. */
  agentDeleted(agentId: string, userId: string) {
    for (const r of this.ctx.store.all<any>("SELECT * FROM cloud_vms WHERE agent_id = ? AND status != 'deleted'", agentId)) {
      const vm = this.ctx.store.decode<CloudVm>('cloud_vms', r);
      this.set(vm, { agent_id: null });
      this.ctx.audit(userId, 'cloudvm.orphaned', { name: vm.name }, agentId);
      this.ctx.events.emit(userId, 'notification', {
        title: `Cloud-VM ${vm.name} bestaat nog`,
        body: `De bot ${vm.agent_name} is verwijderd, maar zijn cloud-VM niet. Die kost geld tot je hem verwijdert (ook als hij uit staat). Beheer hem op de pagina Computers.`,
        link: '#/m/browser',
        kind: 'warning',
      });
    }
    this.ctx.store.exec("UPDATE cloud_vms SET agent_id = NULL WHERE agent_id = ? AND status = 'deleted'", agentId);
  }

  exportUser(userId: string) {
    return this.ctx.store.find('cloud_vms', { user_id: userId });
  }
}
