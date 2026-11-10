/**
 * Cloud provider adapter for "Cloud-VM" (CMP-07). A provider creates, powers and deletes one VM per bot through its
 * REST API; TeamBot then uses the VM through the existing SSH remote mode (`remote.ts`).
 *
 * Providers today: Hetzner Cloud (`hetzner.ts`) and DigitalOcean incl. GPU droplets (`digitalocean.ts`).
 *
 * Adding a provider: implement `CloudProvider` in its own file (use `cloudRequest` below and map the
 * provider's errors to `CloudApiError` with a Dutch message), and register it in `CloudVmService.providers`. Rules:
 *  - the API token is passed per call and never logged, stored, echoed in errors or sent anywhere but the provider's
 *    own API host (pagination is done by page number, never by following URLs from a response);
 *  - the VM must receive TeamBot's cloud-init (`cloudinit.ts`) as user data, unchanged, and NO provider SSH keys
 *    (those would give root access);
 *  - every server gets the labels/tags from `CreateServerInput.labels` so a create whose answer was lost can be found
 *    again (`findCreated`);
 *  - `getServer` returns null when the server no longer exists (deleted elsewhere);
 *  - prices come from the provider's API, never from hard-coded tables; say whether they include tax.
 */

export interface CloudLocation {
  name: string;
  description: string;
  city: string;
  country: string;
}

export interface CloudPrice {
  /** per month, excluding tax */
  monthlyNet: number;
  /** per month as the provider shows it (incl. VAT when `CloudOptions.pricesIncludeTax`) */
  monthlyGross: number;
  hourlyGross: number;
}

export interface CloudGpu {
  count: number;
  model: string;
  vramGb: number;
}

export interface CloudServerType {
  name: string;
  description: string;
  cores: number;
  memoryGb: number;
  diskGb: number;
  architecture: string;
  /** 'gpu' types are shown in their own group with an extra note (price, availability, account approval) */
  group?: 'standard' | 'gpu';
  gpu?: CloudGpu;
  /** price per location name; a type without a price for a location is not offered there */
  prices: Record<string, CloudPrice>;
}

export interface CloudImage {
  name: string;
  description: string;
}

export interface CloudOptions {
  currency: string;
  /** false: prices are without VAT/sales tax (the provider adds tax on the invoice) */
  pricesIncludeTax?: boolean;
  /** true: a public IPv4 address is part of the server price */
  ipv4Included?: boolean;
  locations: CloudLocation[];
  types: CloudServerType[];
  images: CloudImage[];
  /** monthly price of a separately billed public IPv4 address per location */
  ipv4: Record<string, CloudPrice>;
  /** the provider's sensible defaults, in order of preference */
  preferred?: { locations?: string[]; types?: string[]; images?: string[] };
}

/** Provider-side state. TeamBot keeps its own, more detailed state (booting, ready …) in `cloud_vms`. */
export type CloudServerStatus = 'initializing' | 'starting' | 'running' | 'stopping' | 'off' | 'deleting' | 'migrating' | 'rebuilding' | 'unknown';

export interface CloudServer {
  id: string;
  name: string;
  status: CloudServerStatus;
  ipv4: string | null;
  ipv6: string | null;
}

export interface CreateServerInput {
  name: string;
  serverType: string;
  location: string;
  image: string;
  /** cloud-init made by TeamBot */
  userData: string;
  /** `managed-by: teambot` and `teambot-vm: <vm id>` (labels at Hetzner, tags at DigitalOcean) */
  labels: Record<string, string>;
}

export interface CloudProvider {
  readonly id: string;
  readonly label: string;
  /** Throws CloudApiError when the token does not work. */
  check(token: string): Promise<void>;
  options(token: string): Promise<CloudOptions>;
  createServer(token: string, input: CreateServerInput): Promise<CloudServer>;
  getServer(token: string, id: string): Promise<CloudServer | null>;
  /** After a create request failed in transit: find the server that was created anyway (it would cost money). */
  findCreated?(token: string, input: CreateServerInput): Promise<CloudServer | null>;
  powerOn(token: string, id: string): Promise<void>;
  /** Graceful (ACPI) shutdown. */
  shutdown(token: string, id: string): Promise<void>;
  /** Hard power off (fallback when a shutdown does not finish). */
  powerOff(token: string, id: string): Promise<void>;
  deleteServer(token: string, id: string): Promise<void>;
}

/** An API error with a Dutch, secret-free message. */
export class CloudApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfterSec?: number,
  ) {
    super(message);
  }
  /** Worth retrying later (rate limit, provider outage, network). */
  get transient() {
    return this.status === 429 || this.status >= 500 || this.status === 0;
  }
}

/** Monthly estimate shown to the user before creating a VM (and stored with it). */
export interface CloudEstimate {
  currency: string;
  serverMonthlyGross: number;
  /** null = billed separately but price unknown; 0 with `ipv4Included` = part of the server price */
  ipv4MonthlyGross: number | null;
  ipv4Included: boolean;
  totalMonthlyGross: number;
  totalMonthlyNet: number;
  hourlyGross: number;
  /** false: plus VAT/sales tax on the provider's invoice */
  taxIncluded: boolean;
  gpu: boolean;
  /** the exact string the user confirms, e.g. "5.11" */
  confirm: string;
}

export function estimate(o: CloudOptions, type: string, location: string): CloudEstimate | null {
  const t = o.types.find((x) => x.name === type);
  const p = t?.prices[location];
  if (!t || !p) return null;
  const ip = o.ipv4Included ? null : o.ipv4[location] || null;
  const total = p.monthlyGross + (ip?.monthlyGross || 0);
  return {
    currency: o.currency,
    serverMonthlyGross: round2(p.monthlyGross),
    ipv4MonthlyGross: o.ipv4Included ? 0 : ip ? round2(ip.monthlyGross) : null,
    ipv4Included: !!o.ipv4Included,
    totalMonthlyGross: round2(total),
    totalMonthlyNet: round2(p.monthlyNet + (ip?.monthlyNet || 0)),
    hourlyGross: Math.round((p.hourlyGross + (ip?.hourlyGross || 0)) * 10_000) / 10_000,
    taxIncluded: o.pricesIncludeTax !== false,
    gpu: t.group === 'gpu',
    confirm: round2(total).toFixed(2),
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const EU = ['DE', 'NL', 'FI', 'FR', 'AT', 'BE', 'SE', 'IE', 'DK'];

/**
 * Sensible defaults from what the API offers: the provider's preferences, else an EU location, the cheapest standard
 * (never GPU) x86 type there, and Ubuntu 24.04 (or the newest Ubuntu/Debian).
 */
export function defaultChoice(o: CloudOptions): { location: string; serverType: string; image: string } | null {
  const has = (l: string) => o.locations.some((x) => x.name === l);
  const loc = (o.preferred?.locations || []).find(has) || o.locations.find((x) => EU.includes(x.country))?.name || o.locations[0]?.name;
  if (!loc) return null;
  const priced = o.types.filter((t) => t.prices[loc] && t.architecture === 'x86' && t.group !== 'gpu');
  const preferred = (o.preferred?.types || []).map((n) => priced.find((t) => t.name === n)).find(Boolean);
  const cheapest = [...priced].sort((a, b) => a.prices[loc].monthlyGross - b.prices[loc].monthlyGross)[0];
  const type = preferred || cheapest;
  const image =
    (o.preferred?.images || []).map((n) => o.images.find((i) => i.name === n)).find(Boolean) ||
    o.images.find((i) => i.name === 'ubuntu-24.04') ||
    o.images.find((i) => /^ubuntu-/.test(i.name)) ||
    o.images.find((i) => /^debian-/.test(i.name)) ||
    o.images[0];
  if (!type || !image) return null;
  return { location: loc, serverType: type.name, image: image.name };
}

/** Seconds to wait from Retry-After or RateLimit-Reset (epoch seconds), if the provider says so. */
export function retryAfterOf(h: Headers): number | undefined {
  const ra = h.get('retry-after');
  if (ra) {
    const s = Number(ra);
    if (Number.isFinite(s)) return Math.max(0, s);
    const d = Date.parse(ra);
    if (Number.isFinite(d)) return Math.max(0, (d - Date.now()) / 1000);
  }
  const reset = Number(h.get('ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset - Date.now() / 1000);
  return undefined;
}

/**
 * One JSON request to a provider API: Bearer token only in the header, no redirects, 30 s time-out, short 429 waits
 * (≤ `maxAutoWaitSec`) retried at most twice, every other error mapped by the adapter. 204 → null.
 */
export async function cloudRequest<T = any>(o: {
  base: string;
  token: string;
  method: string;
  path: string;
  body?: any;
  maxAutoWaitSec: number;
  label: string;
  mapError(status: number, json: any, retryAfterSec?: number): CloudApiError;
}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(o.base + o.path, {
        method: o.method,
        headers: { authorization: `Bearer ${o.token}`, accept: 'application/json', 'user-agent': 'TeamBot', ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new CloudApiError(0, 'network', `Kan ${o.label} niet bereiken (netwerk of time-out). Probeer het later opnieuw.`);
    }
    const text = await res.text().catch(() => '');
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (res.ok) return json as T;
    const wait = retryAfterOf(res.headers);
    if (res.status === 429 && attempt < 2 && wait !== undefined && wait <= o.maxAutoWaitSec) {
      await new Promise((r) => setTimeout(r, Math.max(200, wait * 1000)));
      continue;
    }
    throw o.mapError(res.status, json, wait);
  }
}

/** Rate-limit message shared by the adapters. */
export function rateLimitError(label: string, retryAfterSec?: number) {
  return new CloudApiError(429, 'rate_limit', `${label} beperkt het aantal verzoeken. Probeer het over ${retryAfterSec && retryAfterSec > 0 ? (Math.ceil(retryAfterSec) === 1 ? '1 seconde' : `${Math.ceil(retryAfterSec)} seconden`) : 'een minuut'} opnieuw.`, retryAfterSec);
}
