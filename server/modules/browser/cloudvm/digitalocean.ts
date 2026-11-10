import { CloudApiError, cloudRequest, rateLimitError, type CloudGpu, type CloudOptions, type CloudPrice, type CloudProvider, type CloudServer, type CloudServerStatus, type CreateServerInput } from './provider.js';

/**
 * DigitalOcean (API v2, https://docs.digitalocean.com/reference/api/). Droplets with TeamBot's cloud-init as
 * `user_data`; regions, sizes (incl. GPU droplets) with `price_monthly`; distribution images; power actions; delete.
 *
 * Differences from Hetzner (see docs/modules/browser.md):
 *  - prices are in USD and WITHOUT tax (VAT/sales tax is added on the invoice); a public IPv4 is part of the price;
 *  - no `ssh_keys` are sent (they would give root access). DigitalOcean then e-mails a root password; cloud-init
 *    locks root and turns password logins off, so that password does not work;
 *  - `with_droplet_agent: false`: the web-console agent (which can place login keys) is not installed;
 *  - the metadata service is the same address (169.254.169.254, `/metadata/v1/user-data`), blocked for `teambot`;
 *  - droplet names are not unique, so a lost create is found by the unique tag `teambot-vm-<vm id>`;
 *  - GPU droplets (sizes with `gpu_info`) are offered in their own group: expensive, only in some regions, and an
 *    account may need DigitalOcean's approval before it can create them.
 */

export const DO_API = 'https://api.digitalocean.com/v2';

const COUNTRY: Record<string, string> = { ams: 'NL', fra: 'DE', lon: 'GB', nyc: 'US', sfo: 'US', atl: 'US', ric: 'US', sgp: 'SG', tor: 'CA', blr: 'IN', syd: 'AU' };

const num = (v: any) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const STATUS: Record<string, CloudServerStatus> = { new: 'initializing', active: 'running', off: 'off', archive: 'unknown' };

/** Tag that identifies one TeamBot VM (allowed characters: letters, digits, `_`, `:`, `-`). */
export const vmTag = (labels: Record<string, string>) => `teambot-vm-${String(labels['teambot-vm'] || '').replace(/[^A-Za-z0-9_:-]/g, '')}`;

function toServer(d: any): CloudServer {
  const v4 = (d?.networks?.v4 || []).find((n: any) => n?.type === 'public')?.ip_address;
  const v6 = (d?.networks?.v6 || []).find((n: any) => n?.type === 'public')?.ip_address;
  return { id: String(d?.id ?? ''), name: String(d?.name ?? ''), status: STATUS[String(d?.status)] || 'unknown', ipv4: v4 ? String(v4) : null, ipv6: v6 ? String(v6) : null };
}

function gpuOf(s: any): CloudGpu | undefined {
  const g = s?.gpu_info;
  if (!g && !/^gpu-/.test(String(s?.slug || ''))) return undefined;
  const vram = num(g?.vram?.amount);
  const unit = String(g?.vram?.unit || 'gib').toLowerCase();
  return { count: num(g?.count) || 1, model: String(g?.model || 'GPU').replace(/_/g, ' '), vramGb: unit.startsWith('m') ? Math.round(vram / 1024) : vram };
}

/** DigitalOcean error → Dutch message (never includes the token or the request body). */
export function doError(status: number, body: any, retryAfterSec?: number): CloudApiError {
  const id = String(body?.id || '');
  const msg = String(body?.message || '').replace(/[\r\n]+/g, ' ').slice(0, 200);
  if (status === 401 || id === 'unauthorized')
    return new CloudApiError(401, 'unauthorized', 'DigitalOcean weigert de API-token (ongeldig, verlopen of ingetrokken). Maak bij DigitalOcean › API › Tokens een nieuwe token met lees- en schrijfrechten.');
  if (status === 429 || id === 'too_many_requests') return rateLimitError('DigitalOcean', retryAfterSec);
  if (/gpu/i.test(msg))
    return new CloudApiError(status || 422, 'gpu', 'GPU-droplets zijn (nog) niet vrijgegeven voor je DigitalOcean-account of niet beschikbaar in deze regio. Vraag toegang aan bij DigitalOcean, of kies een andere regio of een gewoon type.');
  if (/limit/i.test(msg)) return new CloudApiError(status === 403 ? 403 : 422, 'quota', 'Je DigitalOcean-account zit aan zijn limiet voor droplets. Verwijder een droplet of vraag DigitalOcean om een hogere limiet.');
  if (status === 403 || id === 'forbidden')
    return new CloudApiError(403, 'forbidden', 'Deze DigitalOcean-token mag dit niet (alleen lezen, of rechten zoals droplet:create of tag:create ontbreken). Maak een token met lees- en schrijfrechten.');
  if (status === 404 || id === 'not_found') return new CloudApiError(404, 'not_found', 'Deze droplet bestaat niet (meer) bij DigitalOcean.');
  if (status === 422 && /size|region|image|not available|unavailable/i.test(msg))
    return new CloudApiError(422, 'unavailable', 'Dit type of systeem is nu niet beschikbaar in deze regio. Kies een andere regio of een ander type.');
  if (status >= 500) return new CloudApiError(status, 'server_error', `DigitalOcean heeft een storing (HTTP ${status}). Probeer het later opnieuw.`);
  return new CloudApiError(status, id || 'invalid', `DigitalOcean weigert de aanvraag${msg ? `: ${msg}` : ` (HTTP ${status})`}.`);
}

export class DigitalOceanProvider implements CloudProvider {
  readonly id = 'digitalocean';
  readonly label = 'DigitalOcean';
  private base: string;
  maxAutoWaitSec = 10;

  constructor(o: { baseUrl?: string } = {}) {
    this.base = (o.baseUrl || DO_API).replace(/\/+$/, '');
  }

  private req<T = any>(token: string, method: string, path: string, body?: any): Promise<T> {
    return cloudRequest<T>({ base: this.base, token, method, path, body, maxAutoWaitSec: this.maxAutoWaitSec, label: 'DigitalOcean', mapError: doError });
  }

  /** Every page by page number (the `links.pages.next` URL from a response is never followed: token only to our base). */
  private async all(token: string, path: string, key: string): Promise<any[]> {
    const out: any[] = [];
    for (let page = 1; page <= 20; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const r = await this.req(token, 'GET', `${path}${sep}page=${page}&per_page=200`);
      out.push(...(r?.[key] || []));
      if (!r?.links?.pages?.next) break;
    }
    return out;
  }

  async check(token: string) {
    await this.req(token, 'GET', '/account');
  }

  async options(token: string): Promise<CloudOptions> {
    const [regions, sizes, images] = await Promise.all([this.all(token, '/regions', 'regions'), this.all(token, '/sizes', 'sizes'), this.all(token, '/images?type=distribution', 'images')]);
    const open = new Set(regions.filter((r) => r?.available !== false && r?.slug).map((r) => String(r.slug)));
    return {
      currency: 'USD',
      pricesIncludeTax: false,
      ipv4Included: true,
      locations: regions
        .filter((r) => open.has(String(r?.slug)))
        .map((r) => ({ name: String(r.slug), description: String(r.name || r.slug), city: String(r.name || r.slug).replace(/\s*\d+$/, ''), country: COUNTRY[String(r.slug).replace(/\d+$/, '')] || '' })),
      types: sizes
        .filter((s) => s?.slug && s.available !== false)
        .map((s) => {
          const gpu = gpuOf(s);
          const prices: Record<string, CloudPrice> = {};
          for (const r of s.regions || []) if (open.has(String(r))) prices[String(r)] = { monthlyNet: num(s.price_monthly), monthlyGross: num(s.price_monthly), hourlyGross: num(s.price_hourly) };
          return {
            name: String(s.slug),
            description: String(s.description || s.slug),
            cores: num(s.vcpus),
            memoryGb: Math.round((num(s.memory) / 1024) * 10) / 10,
            diskGb: num(s.disk),
            architecture: 'x86',
            group: gpu ? ('gpu' as const) : ('standard' as const),
            ...(gpu ? { gpu } : {}),
            prices,
          };
        }),
      images: images
        .filter((i) => ['Ubuntu', 'Debian'].includes(String(i?.distribution)) && i.slug && i.status !== 'deleted' && i.public !== false)
        .sort((a, b) => String(b.distribution).localeCompare(String(a.distribution)) || String(b.name).localeCompare(String(a.name), undefined, { numeric: true }))
        .map((i) => ({ name: String(i.slug), description: `${i.distribution} ${String(i.name).replace(/\s*x64$/, '')}` })),
      ipv4: {},
      preferred: { locations: ['ams3', 'fra1', 'lon1'], types: ['s-1vcpu-2gb', 's-1vcpu-1gb', 's-2vcpu-2gb'], images: ['ubuntu-24-04-x64'] },
    };
  }

  async createServer(token: string, i: CreateServerInput): Promise<CloudServer> {
    const r = await this.req(token, 'POST', '/droplets', {
      name: i.name,
      region: i.location,
      size: i.serverType,
      image: i.image,
      user_data: i.userData,
      tags: ['teambot', vmTag(i.labels)],
      ipv6: true,
      monitoring: false,
      backups: false,
      with_droplet_agent: false,
    });
    return toServer(r?.droplet);
  }

  async getServer(token: string, id: string): Promise<CloudServer | null> {
    try {
      const r = await this.req(token, 'GET', `/droplets/${encodeURIComponent(id)}`);
      return toServer(r?.droplet);
    } catch (e) {
      if (e instanceof CloudApiError && e.status === 404) return null;
      throw e;
    }
  }

  async findCreated(token: string, i: CreateServerInput): Promise<CloudServer | null> {
    const r = await this.req(token, 'GET', `/droplets?tag_name=${encodeURIComponent(vmTag(i.labels))}`);
    const d = (r?.droplets || []).find((x: any) => x?.name === i.name) || (r?.droplets || [])[0];
    return d ? toServer(d) : null;
  }

  private action(token: string, id: string, type: 'power_on' | 'shutdown' | 'power_off') {
    return this.req(token, 'POST', `/droplets/${encodeURIComponent(id)}/actions`, { type });
  }

  async powerOn(token: string, id: string) {
    await this.action(token, id, 'power_on');
  }

  async shutdown(token: string, id: string) {
    await this.action(token, id, 'shutdown');
  }

  async powerOff(token: string, id: string) {
    await this.action(token, id, 'power_off');
  }

  async deleteServer(token: string, id: string) {
    try {
      await this.req(token, 'DELETE', `/droplets/${encodeURIComponent(id)}`);
    } catch (e) {
      if (e instanceof CloudApiError && e.status === 404) return;
      throw e;
    }
  }
}
