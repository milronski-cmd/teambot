import { CloudApiError, cloudRequest, rateLimitError, type CloudImage, type CloudOptions, type CloudPrice, type CloudProvider, type CloudServer, type CloudServerStatus, type CreateServerInput } from './provider.js';

/**
 * Hetzner Cloud (REST API v1, https://docs.hetzner.cloud). Only what TeamBot needs: locations, server types with
 * prices, system images, create/get/power/delete a server. The token goes only into the Authorization header.
 *
 * Notes:
 *  - no `ssh_keys` are sent: Hetzner would put them in root's authorized_keys. Access is set up by TeamBot's cloud-init
 *    (user `teambot`, no sudo). Hetzner then returns a root password, which TeamBot ignores (cloud-init locks it).
 *  - prices include VAT; the primary IPv4 address is billed separately (from `/pricing`).
 *  - Hetzner Cloud has no GPU server types.
 */

export const HETZNER_API = 'https://api.hetzner.cloud/v1';

const num = (v: any) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const price = (p: any): CloudPrice => ({ monthlyNet: num(p?.price_monthly?.net), monthlyGross: num(p?.price_monthly?.gross), hourlyGross: num(p?.price_hourly?.gross) });

const STATUS: Record<string, CloudServerStatus> = {
  initializing: 'initializing',
  starting: 'starting',
  running: 'running',
  stopping: 'stopping',
  off: 'off',
  deleting: 'deleting',
  migrating: 'migrating',
  rebuilding: 'rebuilding',
};

function toServer(s: any): CloudServer {
  return {
    id: String(s?.id ?? ''),
    name: String(s?.name ?? ''),
    status: STATUS[String(s?.status)] || 'unknown',
    ipv4: s?.public_net?.ipv4?.ip ? String(s.public_net.ipv4.ip) : null,
    ipv6: s?.public_net?.ipv6?.ip ? String(s.public_net.ipv6.ip) : null,
  };
}

/** Hetzner error → Dutch message (never includes the token or the request body). */
export function hetznerError(status: number, body: any, retryAfterSec?: number): CloudApiError {
  const code = String(body?.error?.code || '');
  const detail = String(body?.error?.message || '').replace(/[\r\n]+/g, ' ').slice(0, 200);
  if (status === 401 || code === 'unauthorized')
    return new CloudApiError(401, 'unauthorized', 'Hetzner weigert de API-token (ongeldig of ingetrokken). Maak in de Hetzner Console › je project › Beveiliging › API-tokens een token met lees- en schrijfrechten.');
  if (code === 'resource_limit_exceeded' || (status === 403 && /limit/i.test(detail)))
    return new CloudApiError(403, 'quota', 'Je Hetzner-project zit aan zijn limiet (bijvoorbeeld het maximale aantal servers of cores). Verwijder een server of vraag Hetzner om een hogere limiet.');
  if (status === 403 || code === 'forbidden') return new CloudApiError(403, 'forbidden', 'Deze Hetzner-token mag dit niet (alleen leesrechten?). Maak een token met lees- en schrijfrechten.');
  if (status === 429 || code === 'rate_limit_exceeded') return rateLimitError('Hetzner', retryAfterSec);
  if (status === 404 || code === 'not_found') return new CloudApiError(404, 'not_found', 'Deze server bestaat niet (meer) bij Hetzner.');
  if (code === 'resource_unavailable' || code === 'placement_error' || code === 'server_type_unavailable' || status === 412)
    return new CloudApiError(status || 412, 'unavailable', 'Dit servertype is nu niet beschikbaar op deze locatie. Kies een andere locatie of een ander type.');
  if (code === 'uniqueness_error' || status === 409) return new CloudApiError(409, 'conflict', 'Hetzner meldt een conflict (bestaat er al een server met deze naam?). Probeer het opnieuw.');
  if (code === 'locked' || status === 423) return new CloudApiError(423, 'locked', 'Hetzner is nog bezig met een vorige actie op deze server. Probeer het zo opnieuw.');
  if (status >= 500) return new CloudApiError(status, 'server_error', `Hetzner heeft een storing (HTTP ${status}). Probeer het later opnieuw.`);
  return new CloudApiError(status, code || 'invalid', `Hetzner weigert de aanvraag${detail ? `: ${detail}` : ` (HTTP ${status})`}.`);
}

export class HetznerProvider implements CloudProvider {
  readonly id = 'hetzner';
  readonly label = 'Hetzner Cloud';
  private base: string;
  /** Longest automatic wait on a 429 (seconds); longer waits become an error for the user. */
  maxAutoWaitSec = 10;

  constructor(o: { baseUrl?: string } = {}) {
    this.base = (o.baseUrl || HETZNER_API).replace(/\/+$/, '');
  }

  private req<T = any>(token: string, method: string, path: string, body?: any): Promise<T> {
    return cloudRequest<T>({ base: this.base, token, method, path, body, maxAutoWaitSec: this.maxAutoWaitSec, label: 'Hetzner', mapError: hetznerError });
  }

  /** GET every page of a list endpoint. */
  private async all(token: string, path: string, key: string): Promise<any[]> {
    const out: any[] = [];
    let page = 1;
    for (let i = 0; i < 20 && page; i++) {
      const sep = path.includes('?') ? '&' : '?';
      const r = await this.req(token, 'GET', `${path}${sep}page=${page}&per_page=50`);
      out.push(...(r?.[key] || []));
      page = Number(r?.meta?.pagination?.next_page) || 0;
    }
    return out;
  }

  async check(token: string) {
    await this.req(token, 'GET', '/locations?per_page=1');
  }

  async options(token: string): Promise<CloudOptions> {
    const [locations, types, images, pricing] = await Promise.all([
      this.all(token, '/locations', 'locations'),
      this.all(token, '/server_types', 'server_types'),
      this.all(token, '/images?type=system&status=available', 'images'),
      this.req(token, 'GET', '/pricing').catch(() => null),
    ]);
    const ipv4: Record<string, CloudPrice> = {};
    for (const ip of pricing?.pricing?.primary_ips || []) if (ip?.type === 'ipv4') for (const p of ip.prices || []) if (p?.location) ipv4[String(p.location)] = price(p);
    const imgs: CloudImage[] = images
      .filter((i) => (i.os_flavor === 'ubuntu' || i.os_flavor === 'debian') && (!i.architecture || i.architecture === 'x86') && !i.deprecated && i.name)
      .sort((a, b) => String(b.os_version).localeCompare(String(a.os_version), undefined, { numeric: true }))
      .map((i) => ({ name: String(i.name), description: String(i.description || i.name) }));
    return {
      currency: String(pricing?.pricing?.currency || 'EUR'),
      pricesIncludeTax: true,
      ipv4Included: false,
      locations: locations.map((l) => ({ name: String(l.name), description: String(l.description || l.name), city: String(l.city || ''), country: String(l.country || '') })),
      types: types
        .filter((t) => !t.deprecated && !t.deprecation && t.name)
        .map((t) => {
          const prices: Record<string, CloudPrice> = {};
          for (const p of t.prices || []) if (p?.location) prices[String(p.location)] = price(p);
          return { name: String(t.name), description: String(t.description || t.name), cores: num(t.cores), memoryGb: num(t.memory), diskGb: num(t.disk), architecture: String(t.architecture || 'x86'), group: 'standard' as const, prices };
        }),
      images: imgs,
      ipv4,
      preferred: { locations: ['nbg1', 'fsn1', 'hel1'], types: ['cx22', 'cx23', 'cpx11', 'cx21'], images: ['ubuntu-24.04'] },
    };
  }

  async createServer(token: string, i: CreateServerInput): Promise<CloudServer> {
    const r = await this.req(token, 'POST', '/servers', {
      name: i.name,
      server_type: i.serverType,
      location: i.location,
      image: i.image,
      user_data: i.userData,
      start_after_create: true,
      labels: i.labels,
      public_net: { enable_ipv4: true, enable_ipv6: true },
    });
    // r.root_password is deliberately ignored (never stored or logged); cloud-init locks the root account
    return toServer(r?.server);
  }

  async getServer(token: string, id: string): Promise<CloudServer | null> {
    try {
      const r = await this.req(token, 'GET', `/servers/${encodeURIComponent(id)}`);
      return toServer(r?.server);
    } catch (e) {
      if (e instanceof CloudApiError && e.status === 404) return null;
      throw e;
    }
  }

  /** Server names are unique per Hetzner project. */
  async findCreated(token: string, i: CreateServerInput): Promise<CloudServer | null> {
    const r = await this.req(token, 'GET', `/servers?name=${encodeURIComponent(i.name)}`);
    const s = (r?.servers || []).find((x: any) => x?.name === i.name);
    return s ? toServer(s) : null;
  }

  async powerOn(token: string, id: string) {
    await this.req(token, 'POST', `/servers/${encodeURIComponent(id)}/actions/poweron`);
  }

  async shutdown(token: string, id: string) {
    await this.req(token, 'POST', `/servers/${encodeURIComponent(id)}/actions/shutdown`);
  }

  async powerOff(token: string, id: string) {
    await this.req(token, 'POST', `/servers/${encodeURIComponent(id)}/actions/poweroff`);
  }

  async deleteServer(token: string, id: string) {
    try {
      await this.req(token, 'DELETE', `/servers/${encodeURIComponent(id)}`);
    } catch (e) {
      if (e instanceof CloudApiError && e.status === 404) return; // already gone
      throw e;
    }
  }
}
