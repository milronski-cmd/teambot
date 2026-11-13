import crypto from 'node:crypto';
import type { Request } from 'express';
import type { Ctx, ProviderConfig, User } from '../../core/types.js';
import type { SessionInfo } from '../../core/auth.js';
import { HttpError, ah, bad, user } from '../../core/http.js';
import { normalizeBaseUrl } from './pairing.js';
import { Limiter, isLoopbackHost } from '../../core/util.js';
import { interfaces, isPrivateLan, isTailscaleIp } from './reach.js';
import type { Mobile } from './index.js';

/**
 * What the iPhone app needs to show an honest status per link and to ask consent (App Review 5.1.2(i)):
 *
 *  - `POST /api/public/mobile/hello` (no token): "is this my TeamBot, and does it still know this phone?" The answer is
 *    bound to the device's token with an HMAC (key = SHA-256 of the token, which the server stores anyway), so the app
 *    only sends its token to an address that proved to be its own TeamBot. A foreign host on another wifi (same
 *    192.168.x address) or a carrier address in 100.64/10 gets nothing.
 *  - `GET /api/mobile/status` (device token): the other addresses of this TeamBot (wifi, Tailscale, https), so the
 *    pairing survives a switch between wifi and Tailscale; whether the pc may sleep; the start page hook.
 *  - `GET /api/mobile/privacy` (device token): which AI services the bots on this pc can send your data to.
 *
 * Cheap on purpose: no child processes on the request path (the Tailscale https name is looked up in the background).
 */

export const HELLO_VERSION = 1;

/** A question or approval of this user waits (0.4.5: then the phone opens on "Wacht op jou"). */
export function waitsFor(ctx: Ctx, userId: string): boolean {
  try {
    return !!ctx.store.one("SELECT id FROM approvals WHERE user_id = ? AND status = 'pending' LIMIT 1", userId);
  } catch {
    return false;
  }
}

export type DeviceState = 'active' | 'revoked' | 'unknown';
export type AddressKind = 'tailscale-https' | 'public' | 'lan' | 'tailscale';
export interface PhoneAddress {
  url: string;
  kind: AddressKind;
  secure: boolean;
}
export type PrivacyData = 'chat' | 'voice' | 'readaloud';
export interface PrivacyProvider {
  id: string;
  /** Company or service that receives the data (a name, never translated). */
  vendor: string;
  /** The connection as the owner named or chose it ("Claude Code", "Groq"). */
  service: string;
  /** Runs on this pc or in the owner's own network (nothing leaves it). */
  local: boolean;
  /** Host of a custom endpoint (no path, no key), when the kind does not say where the data goes. */
  host: string | null;
  /** Passes the data on to the model chosen there (OpenRouter, OpenCode, an own endpoint …). */
  forwards: boolean;
  /** A free tier: some free services may use what you send to improve their models (the website says the same). */
  free: boolean;
  data: PrivacyData[];
  /** Bots that use it now as engine or reserve engine. */
  bots: string[];
}

/** The text the HMAC covers; the app builds the same string (HostClient.helloMessage). */
export function helloMessage(instance: string, device: string, nonce: string, state: DeviceState): string {
  return `teambot-hello/${HELLO_VERSION}|${instance}|${device}|${nonce}|${state}`;
}
export function helloProof(tokenHashHex: string, message: string): string {
  return crypto.createHmac('sha256', Buffer.from(tokenHashHex, 'hex')).update(message).digest('hex');
}

/** Who receives the data, per provider kind. Unknown kinds fall back to their label. */
const VENDORS: Record<string, string> = {
  anthropic: 'Anthropic',
  'claude-code': 'Anthropic',
  openai: 'OpenAI',
  'codex-cli': 'OpenAI',
  azure: 'Microsoft (Azure OpenAI)',
  google: 'Google',
  vertex: 'Google',
  'gemini-cli': 'Google',
  antigravity: 'Google',
  groq: 'Groq',
  cerebras: 'Cerebras',
  mistral: 'Mistral AI',
  'mistral-vibe': 'Mistral AI',
  openrouter: 'OpenRouter',
  zai: 'Z.ai',
  nvidia: 'NVIDIA',
  cloudflare: 'Cloudflare',
  xai: 'xAI',
  'grok-build': 'xAI',
  deepseek: 'DeepSeek',
  moonshot: 'Moonshot AI',
  'kimi-code': 'Moonshot AI',
  qwen: 'Alibaba Cloud',
  'qwen-code': 'Alibaba Cloud',
  minimax: 'MiniMax',
  together: 'Together AI',
  fireworks: 'Fireworks AI',
  deepinfra: 'DeepInfra',
  huggingface: 'Hugging Face',
  perplexity: 'Perplexity',
  bedrock: 'Amazon Web Services',
  'kiro-cli': 'Amazon Web Services',
  github: 'GitHub (Microsoft)',
  'copilot-cli': 'GitHub (Microsoft)',
  'cursor-cli': 'Cursor',
  'devin-cli': 'Cognition',
  auggie: 'Augment Code',
  'factory-droid': 'Factory',
  'junie-cli': 'JetBrains',
};
/** Kinds whose destination is the model configured inside them, not one fixed company. */
const FORWARDERS = new Set(['openrouter', 'openai-compatible', 'opencode', 'goose', 'cline-cli', 'kilo-code', 'hermes-agent', 'huggingface']);

const hostOf = (raw: string): string | null => {
  try {
    const u = new URL(raw);
    return u.hostname.replace(/^\[|\]$/g, '').toLowerCase() || null;
  } catch {
    return null;
  }
};
const isOwnNetwork = (host: string) => isLoopbackHost(host) || isPrivateLan(host) || isTailscaleIp(host) || host.endsWith('.local') || !host.includes('.');

const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const DEVICE = /^[A-Za-z0-9_-]{4,64}$/;

export class PhoneStatus {
  private hellos = new Limiter(60, 60_000);
  /** Tailscale https name that serves this TeamBot, looked up in the background (never on the request path). */
  private https: { at: number; urls: string[]; busy: boolean } = { at: 0, urls: [], busy: false };

  constructor(private ctx: Ctx, private m: Mobile) {}

  /** A random, stable id of this TeamBot (public: it only tells "same TeamBot on another address"). */
  instance(): string {
    const cur = this.ctx.store.getSetting<string>('', 'mobileInstance', '');
    if (typeof cur === 'string' && /^tbi_[A-Za-z0-9_-]{16,}$/.test(cur)) return cur;
    const id = 'tbi_' + crypto.randomBytes(12).toString('base64url');
    this.ctx.store.setSetting('', 'mobileInstance', id);
    return id;
  }

  hello(body: any, ip: string) {
    if (!this.hellos.hit(ip)) throw new HttpError(429, 'Te veel controles. Probeer het over een minuut opnieuw.', 'rate_limited');
    const device = typeof body?.device === 'string' ? body.device : '';
    const nonce = typeof body?.nonce === 'string' ? body.nonce : '';
    if (!DEVICE.test(device) || !NONCE.test(nonce)) throw bad('Ongeldige controle');
    const instance = this.instance();
    const row = this.ctx.store.one<{ token_hash: string; kind: string; revoked: number; expires_at: string | null; user_id: string }>(
      'SELECT token_hash, kind, revoked, expires_at, user_id FROM sessions WHERE id = ?',
      device,
    );
    let state: DeviceState = 'unknown';
    if (row && row.kind === 'device') {
      const u = this.ctx.store.user(row.user_id);
      const expired = !!row.expires_at && row.expires_at <= new Date().toISOString();
      state = row.revoked || expired || !u || u.disabled ? 'revoked' : 'active';
    }
    const proof = state === 'unknown' || !row ? null : helloProof(row.token_hash, helloMessage(instance, device, nonce, state));
    return { teambot: HELLO_VERSION, app: this.ctx.config.appName, version: this.ctx.config.version, instance, device: state, proof };
  }

  // ---------- addresses ----------

  /** Where a phone token is accepted from outside this pc: the main port when it listens on all networks, the gateway. */
  private tunnelTarget(): string | null {
    const cfg = this.ctx.config;
    const gs = this.m.gateway.state;
    if (gs.running && gs.port && (gs.address === '0.0.0.0' || gs.address === '127.0.0.1')) return `http://127.0.0.1:${gs.port}`;
    if (cfg.mode === 'server' && cfg.port) return `http://127.0.0.1:${cfg.port}`;
    return null;
  }

  private refreshHttps() {
    if (this.https.busy || Date.now() - this.https.at < 60_000) return;
    const target = this.tunnelTarget();
    if (!target) {
      this.https = { at: Date.now(), urls: [], busy: false };
      return;
    }
    this.https.busy = true;
    void (async () => {
      let urls: string[] = [];
      try {
        const ts = await this.m.tailscaleProbe(interfaces().tailscale.map((a) => a.address));
        if (ts.running && ts.dnsName && (await this.m.serveTargets()).includes(target)) urls = [`https://${ts.dnsName}`];
      } catch {
        urls = [];
      }
      this.https = { at: Date.now(), urls, busy: false };
    })();
  }

  addresses(u: User): PhoneAddress[] {
    const cfg = this.ctx.config;
    const out: PhoneAddress[] = [];
    const add = (url: string, kind: AddressKind) => {
      if (!out.some((a) => a.url === url)) out.push({ url, kind, secure: url.startsWith('https:') });
    };
    this.refreshHttps();
    for (const url of this.https.urls) add(url, 'tailscale-https');
    if (cfg.publicUrl) {
      try {
        add(normalizeBaseUrl(cfg.publicUrl), 'public');
      } catch {
        /* malformed public url: skip */
      }
    }
    // LAN and Tailscale addresses of this pc only for the owner and admins (the same rule as Instellingen › Telefoon).
    if (u.role !== 'member') {
      const nets = interfaces();
      const listensOnAll = !cfg.host || cfg.host === '0.0.0.0' || cfg.host === '::';
      const both = (port: number) => {
        for (const a of nets.lan) add(`http://${a.address}:${port}`, 'lan');
        for (const a of nets.tailscale) add(`http://${a.address}:${port}`, 'tailscale');
      };
      if (listensOnAll && cfg.port) both(cfg.port);
      const gs = this.m.gateway.state;
      if (gs.running && gs.port && gs.address) {
        if (gs.address === '0.0.0.0') both(gs.port);
        else if (isTailscaleIp(gs.address)) add(`http://${gs.address}:${gs.port}`, 'tailscale');
      }
    }
    return out.slice(0, 8);
  }

  // ---------- privacy (consent screen) ----------

  privacy(userId: string) {
    const { ctx } = this;
    const agents = ctx.store.agents(userId);
    const usedBy = new Map<string, Set<string>>();
    const mark = (pid: unknown, bot: string) => {
      if (typeof pid !== 'string' || !pid) return;
      if (!usedBy.has(pid)) usedBy.set(pid, new Set());
      usedBy.get(pid)!.add(bot);
    };
    for (const a of agents) {
      mark(a.provider_id, a.name);
      mark(a.fallback?.provider_id, a.name);
      const list = Array.isArray(a.settings?.fallbacks) ? a.settings.fallbacks : [];
      for (const f of list) mark(f?.provider_id, a.name);
    }
    // Voice settings may send recordings (speech recognition, OpenAI Realtime) or texts to read aloud to a provider.
    const extra = new Map<string, Set<PrivacyData>>();
    const flag = (pid: unknown, d: PrivacyData) => {
      if (typeof pid !== 'string' || !pid) return;
      if (!extra.has(pid)) extra.set(pid, new Set());
      extra.get(pid)!.add(d);
    };
    const voice = ctx.store.getSetting<any>(userId, 'voice', null);
    if (voice && typeof voice === 'object') {
      if (voice.stt?.engine === 'provider') flag(voice.stt.providerId, 'voice');
      if (voice.call?.engine === 'realtime') flag(voice.realtime?.providerId, 'voice');
      if (voice.tts?.engine === 'provider' || voice.tts?.engine === 'auto') flag(voice.tts?.providerId, 'readaloud');
    }
    for (const a of agents) {
      const v = a.settings?.voice;
      if (v && v.engine === 'provider') flag(v.providerId, 'readaloud');
    }
    const providers: PrivacyProvider[] = ctx.providers
      .list(userId)
      .filter((p: ProviderConfig) => p.enabled)
      .map((p: ProviderConfig) => {
        const kind = ctx.providers.kinds.get(p.kind);
        const base = p.base_url || kind?.baseUrl || '';
        const host = base ? hostOf(base) : null;
        const local = host ? isOwnNetwork(host) : kind?.section === 'local' || kind?.group === 'local';
        const known = VENDORS[p.kind];
        // Every enabled engine can get your chat: as a bot's engine, as a reserve, or when the free chain switches.
        const data = new Set<PrivacyData>(['chat', ...(extra.get(p.id) || [])]);
        return {
          id: p.id,
          vendor: local ? p.name || kind?.label || p.kind : known || kind?.label || p.name || p.kind,
          service: p.name || kind?.label || p.kind,
          local,
          host: !known && host && !local ? host : null,
          forwards: FORWARDERS.has(p.kind),
          free: !local && (kind?.section === 'free' || kind?.billing === 'free'),
          data: (['chat', 'voice', 'readaloud'] as PrivacyData[]).filter((d) => data.has(d)),
          bots: [...(usedBy.get(p.id) || [])].sort((a, b) => a.localeCompare(b)),
        };
      });
    return { version: privacyVersion(providers), providers };
  }

  // ---------- routes ----------

  routes() {
    const { ctx } = this;
    const session = (req: Request) => (req as any).session as SessionInfo;
    ctx.publicApi.post(
      '/mobile/hello',
      ah(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        return this.hello(req.body, req.ip || 'unknown');
      }),
    );
    ctx.api.get(
      '/mobile/status',
      ah(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        const u = user(req);
        const s = session(req);
        const device = s?.kind === 'device' ? this.m.pairing.devices(u.id, s.id).find((d) => d.id === s.id) || null : null;
        const power = typeof ctx.services.power?.state === 'function' ? ctx.services.power.state() : null;
        // 0.4.5: the phone opens on "Wacht op jou" when a question or approval waits, otherwise on Chats (or the page a
        // module picks: wave 2, plan §C, ctx.services.mobileHome = (userId) => '#/t/<thread>').
        let home: string | null = waitsFor(ctx, u.id) ? '#/inbox' : null;
        if (!home && typeof ctx.services.mobileHome === 'function') {
          try {
            const h = ctx.services.mobileHome(u.id);
            if (typeof h === 'string' && /^#\/[A-Za-z0-9/_?=&.-]{0,200}$/.test(h)) home = h;
          } catch {
            home = null;
          }
        }
        return {
          teambot: HELLO_VERSION,
          app: ctx.config.appName,
          version: ctx.config.version,
          instance: this.instance(),
          device: device ? { id: device.id, name: device.name } : null,
          addresses: this.addresses(u),
          power: power ? { available: !!power.available, keepAwake: !!power.enabled } : null,
          privacy: { version: this.privacy(u.id).version },
          home,
          // The TeamBot connection (iroh.ts): the app pins this key and dials it when wifi and Tailscale don't answer.
          iroh: this.m.iroh.link(),
        };
      }),
    );
    ctx.api.get(
      '/mobile/privacy',
      ah(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        return this.privacy(user(req).id);
      }),
    );
  }
}

/**
 * Changes only when a receiving party or the kind of data changes — not when a bot or connection is renamed or a bot
 * switches between engines it already had: then the app asks for consent again.
 */
export function privacyVersion(list: PrivacyProvider[]): string {
  const key = list
    .filter((p) => !p.local)
    .map((p) => [p.vendor, p.host, p.forwards, p.free, p.data.join(',')].join('|'))
    .sort()
    .join('\n');
  return crypto.createHash('sha256').update(`privacy/1\n${key}`).digest('hex').slice(0, 16);
}
