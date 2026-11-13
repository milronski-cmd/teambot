import crypto from 'node:crypto';
import type { Request } from 'express';
import type { Ctx, Module } from '../../core/types.js';
import type { SessionInfo } from '../../core/auth.js';
import { ah, bad, forbidden, requireRole, user } from '../../core/http.js';
import { DevicePolicy, type MobileRoute } from './policy.js';
import { Pairing, normalizeBaseUrl } from './pairing.js';
import { PushService, type PushMessage } from './push.js';
import { Apns } from './apns.js';
import { Gateway, type GatewayBind } from './gateway.js';
import { IrohLink, normalizeRelayUrl } from './iroh.js';
import { IROH_BASE } from './pairing.js';
import { isLoopbackHost } from '../../core/util.js';
import { interfaces, isTailscaleIp, tailscaleServe, tailscaleServeTargets, tailscaleStatus, type TailscaleInfo } from './reach.js';
import { Limiter } from '../../core/util.js';
import { pairPage } from './page.js';
import { PhoneStatus } from './status.js';
import { Presence } from './presence.js';

interface GatewaySettings {
  enabled: boolean;
  bind: GatewayBind;
  port: number | null;
}

const session = (req: Request) => (req as any).session as SessionInfo;

/** `baseUrl` of POST /mobile/pair for the one card: TeamBot picks how the phone reaches this computer (autoTicket). */
export const AUTO_BASE = 'auto';

/**
 * Where to get the iPhone app (0.4.5, step 1 of the card): a public TestFlight or App Store link, set by whoever ships
 * TeamBot (`TEAMBOT_IOS_APP_URL`, https only). Without one the card says plainly that the app is not public yet and
 * where it works without the app; it never links to TestFlight for an invitation that does not exist.
 */
export function iosAppUrl(raw = process.env.TEAMBOT_IOS_APP_URL): string | null {
  try {
    const u = new URL(String(raw || '').trim());
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

/** Everything the module owns for one app instance (tests start many apps in one process). */
export class Mobile {
  pairing: Pairing;
  push: PushService;
  presence = new Presence();
  apns: Apns;
  gateway: Gateway;
  /** "TeamBot-verbinding": reachable from anywhere without Tailscale (iroh.ts). */
  iroh: IrohLink;
  policy: DevicePolicy;
  /** Honest per-link status and the consent list for the iPhone app (status.ts). */
  status: PhoneStatus;
  policyActive = false;
  tailscaleProbe: (ips: string[]) => Promise<TailscaleInfo> = tailscaleStatus;
  /** Injectable for tests: what Tailscale Serve publishes on https, and how to publish a loopback target. */
  serveTargets: () => Promise<string[]> = tailscaleServeTargets;
  serveRun: (target: string) => Promise<{ ok: boolean; detail: string }> = tailscaleServe;
  private testLimiter = new Limiter(5, 60_000);
  private unsub: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private ctx: Ctx) {
    this.iroh = new IrohLink(ctx);
    this.pairing = new Pairing(ctx, () => this.policyActive, () => this.iroh.link());
    this.apns = new Apns(ctx);
    this.push = new PushService(ctx, this.apns);
    // 0.4.4 (P8): where the owner is; the desktop app reports it (desktop/presence.ts).
    this.push.presence = this.presence;
    this.presence.onAway((userId) => this.push.releaseHeld(userId));
    this.gateway = new Gateway(ctx);
    this.policy = new DevicePolicy(ctx, (req, s) => this.pairing.seen(s, String(req.headers['user-agent'] || '')));
    this.status = new PhoneStatus(ctx, this);
  }

  // ---------- gateway (opt-in, server-wide, admin only) ----------

  gatewaySettings(): GatewaySettings {
    const s = this.ctx.store.getSetting<Partial<GatewaySettings>>('', 'mobileGateway', {}) || {};
    return { enabled: !!s.enabled, bind: (['all', 'tailscale', 'loopback'] as const).includes(s.bind as any) ? (s.bind as GatewayBind) : 'all', port: typeof s.port === 'number' ? s.port : null };
  }
  defaultGatewayPort() {
    return this.ctx.config.port ? this.ctx.config.port + 1 : 0;
  }
  async applyGateway() {
    const s = this.gatewaySettings();
    if (!s.enabled) return this.gateway.stop();
    let address = s.bind === 'loopback' ? '127.0.0.1' : '0.0.0.0';
    if (s.bind === 'tailscale') {
      const ts = interfaces().tailscale[0]?.address;
      if (!ts) {
        await this.gateway.stop();
        this.gateway.state = { running: false, address: null, port: null, error: 'Geen Tailscale-adres (100.x) gevonden op deze computer. Staat Tailscale aan?' };
        return;
      }
      address = ts;
    }
    const st = await this.gateway.start(address, s.port ?? this.defaultGatewayPort());
    if (st.running) this.ctx.log.info(`[mobile] telefoon-toegang actief op ${st.address}:${st.port}`);
    else this.ctx.log.warn(`[mobile] telefoon-toegang niet gestart: ${st.error}`);
  }

  /**
   * 0.4.5 "Telefoon koppelen" in one card: the QR code is there right away, without a choice first. The TeamBot
   * connection (iroh) works at home and away without Tailscale, so it is switched on here when this computer can run
   * it. A ready https address (Tailscale Serve, the public address) goes into the code too: the app then tries that
   * first and the browser can use the code as well; otherwise the code is for the iPhone app only (teambot://pair).
   * Without iroh: the best address that works now. Nothing that works: a plain reason (Meer opties has the choices).
   */
  async autoTicket(req: Request) {
    const u = user(req);
    const ir = this.iroh.status();
    // Switched off on purpose (Meer opties › Bereikbaarheid): the card does not switch it on again behind your back.
    const offOnPurpose = this.ctx.store.getSetting<boolean>('', 'mobileIrohOff', false) === true;
    if (ir.available && !this.iroh.link() && u.role !== 'member' && !offOnPurpose) {
      await this.setIroh(u.id, { enabled: true });
      // A few seconds for the relay, so the phone finds this computer at once; the code works either way.
      if (this.iroh.link()) await this.iroh.waitOnline(4000);
    }
    const reach = await this.reachability(req);
    const ready = reach.candidates.filter((c) => c.ready && c.kind !== 'iroh' && !isLoopbackHost(new URL(c.url).hostname));
    const https = ready.find((c) => c.secure);
    const link = this.iroh.link();
    const pick = https || (link ? null : ready[0]);
    if (!pick && !link) {
      throw bad(
        ir.available && u.role === 'member'
          ? 'Je telefoon kan deze server nog niet bereiken. Vraag je beheerder om de TeamBot-verbinding aan te zetten, of kies bij Meer opties een adres.'
          : ir.available && offOnPurpose
            ? 'De TeamBot-verbinding staat uit. Zet hem aan onder Meer opties › Bereikbaarheid, of kies daar een adres.'
            : 'Je telefoon kan deze computer nog niet bereiken. Kies bij Meer opties hoe: wifi, Tailscale of een eigen adres.',
      );
    }
    const ticket = await this.pairing.createTicket(u, pick ? pick.url : IROH_BASE);
    return { ...ticket, auto: { kind: pick ? pick.kind : 'iroh', label: pick ? pick.label : 'TeamBot-verbinding (thuis en onderweg)' } };
  }

  async setIroh(byUserId: string, patch: { enabled?: boolean; relay?: string | null }) {
    const cur = this.iroh.settings();
    const next = { enabled: patch.enabled ?? cur.enabled, relay: patch.relay !== undefined ? patch.relay : cur.relay };
    this.iroh.saveSettings(next);
    // Remember an explicit "off", so the card's automatic choice (autoTicket) respects it; any "on" clears it.
    if (patch.enabled !== undefined) this.ctx.store.setSetting('', 'mobileIrohOff', !patch.enabled);
    await this.iroh.apply();
    const st = this.iroh.status();
    this.ctx.audit(byUserId, next.enabled ? 'mobile.iroh.enabled' : 'mobile.iroh.disabled', { relay: next.relay ? 'own' : 'n0', running: st.running, error: st.error });
  }

  // ---------- reachability ----------

  async reachability(req: Request) {
    const u = user(req);
    const isAdmin = u.role !== 'member';
    const cfg = this.ctx.config;
    const listensOnAll = !cfg.host || cfg.host === '0.0.0.0' || cfg.host === '::';
    const gs = this.gateway.state;
    const gset = this.gatewaySettings();
    const nets = interfaces();
    const ts = isAdmin ? await this.tailscaleProbe(nets.tailscale.map((a) => a.address)) : null;
    const tsIps = [...new Set([...(ts?.ips || []), ...nets.tailscale.map((a) => a.address)])];
    type Cand = { kind: string; url: string; label: string; secure: boolean; ready: boolean; note: string };
    const candidates: Cand[] = [];
    const add = (c: Cand) => {
      if (!candidates.some((x) => x.url === c.url)) candidates.push(c);
    };
    const httpNote = 'http: geen pushmeldingen en geen offline-app (de browser eist https).';
    if (cfg.publicUrl) {
      try {
        const url = normalizeBaseUrl(cfg.publicUrl);
        add({ kind: 'public', url, label: 'Publiek adres van deze server', secure: url.startsWith('https:'), ready: true, note: url.startsWith('https:') ? 'Versleuteld (https). Pushmeldingen werken.' : httpNote });
      } catch {
        /* ignore malformed public url */
      }
    }
    try {
      const cur = normalizeBaseUrl(`${req.protocol}://${req.get('host')}`);
      if (!isLoopbackHost(new URL(cur).hostname)) add({ kind: 'current', url: cur, label: 'Het adres dat je nu gebruikt', secure: cur.startsWith('https:'), ready: true, note: cur.startsWith('https:') ? 'Versleuteld (https).' : httpNote });
    } catch {
      /* no usable host header */
    }
    let tunnelTarget: string | null = null;
    if (isAdmin) {
      if (listensOnAll) {
        for (const a of nets.lan) add({ kind: 'lan', url: `http://${a.address}:${cfg.port}`, label: `Zelfde wifi (${a.iface})`, secure: false, ready: true, note: 'Niet versleuteld: alleen op een vertrouwd thuisnetwerk. ' + httpNote });
        for (const ip of tsIps) add({ kind: 'tailscale', url: `http://${ip}:${cfg.port}`, label: 'Tailscale (direct)', secure: false, ready: true, note: 'Versleuteld door Tailscale (WireGuard), maar de browser ziet http: geen pushmeldingen.' });
      }
      if (gs.running && gs.address) {
        const all = gs.address === '0.0.0.0';
        if (all) for (const a of nets.lan) add({ kind: 'lan', url: `http://${a.address}:${gs.port}`, label: `Zelfde wifi (${a.iface})`, secure: false, ready: true, note: 'Niet versleuteld: alleen op een vertrouwd thuisnetwerk. ' + httpNote });
        for (const ip of all ? tsIps : isTailscaleIp(gs.address) ? [gs.address] : []) add({ kind: 'tailscale', url: `http://${ip}:${gs.port}`, label: 'Tailscale (direct)', secure: false, ready: true, note: 'Versleuteld door Tailscale (WireGuard), maar de browser ziet http: geen pushmeldingen.' });
        if (all || gs.address === '127.0.0.1') tunnelTarget = `http://127.0.0.1:${gs.port}`;
      }
      if (!tunnelTarget && cfg.mode === 'server') tunnelTarget = `http://127.0.0.1:${cfg.port}`;
      if (ts?.dnsName) {
        const served = ts.running && tunnelTarget ? (await this.serveTargets()).includes(tunnelTarget) : false;
        // Put the ready https address first: it is the one the QR code should carry.
        const cand = {
          kind: 'tailscale-https',
          url: `https://${ts.dnsName}`,
          label: 'Tailscale (https, aanbevolen)',
          secure: true,
          ready: served,
          note: served
            ? 'Versleuteld (https), alleen voor jouw eigen apparaten. Werkt thuis en onderweg; meldingen en app op je beginscherm werken.'
            : tunnelTarget
              ? 'Nog niet gedeeld. Gebruik "Telefoon via Tailscale instellen", dan regelt TeamBot het.'
              : 'Gebruik "Telefoon via Tailscale instellen", dan regelt TeamBot het.',
        };
        if (served) candidates.unshift(cand);
        else add(cand);
      }
    }
    // The TeamBot connection (iroh): works at home and away without Tailscale, only with the iPhone app. First in the
    // list, after a ready Tailscale https address (the owner's own setup stays the default there).
    const ir = this.iroh.status();
    if (ir.available && (isAdmin || ir.running)) {
      const cand = {
        kind: 'iroh',
        url: IROH_BASE,
        label: 'TeamBot-verbinding (thuis en onderweg)',
        secure: true,
        ready: ir.running,
        note: ir.running
          ? 'Versleuteld, zonder Tailscale of account. Werkt met de iPhone-app.'
          : 'Gaat aan zodra je de QR-code maakt. Versleuteld, zonder Tailscale of account. Werkt met de iPhone-app.',
      };
      candidates.splice(candidates[0]?.kind === 'tailscale-https' && candidates[0].ready ? 1 : 0, 0, cand);
    }
    return {
      mode: cfg.mode,
      isAdmin,
      server: isAdmin ? { host: cfg.host, port: cfg.port, listensOnAll, loopbackOnly: isLoopbackHost(cfg.host) } : { port: cfg.port },
      gateway: isAdmin ? { ...gset, defaultPort: this.defaultGatewayPort(), ...gs } : { running: gs.running },
      tailscale: ts,
      lan: isAdmin ? nets.lan : [],
      candidates,
      tunnelTarget,
      policyActive: this.policyActive,
      iroh: isAdmin ? { ...ir, offOnPurpose: this.ctx.store.getSetting<boolean>('', 'mobileIrohOff', false) === true } : { available: ir.available, running: ir.running },
      /** Step 1 of the card: where to get the iPhone app (null: no public link yet). */
      app: { ios: iosAppUrl() },
    };
  }

  // ---------- module lifecycle ----------

  init() {
    const { ctx } = this;
    if (!Array.isArray(ctx.services.mobileRoutes)) ctx.services.mobileRoutes = [];
    if (Array.isArray((ctx.auth as any).policies)) {
      ctx.auth.policies.push(this.policy.policy);
      this.policyActive = true;
    } else {
      ctx.log.error('[mobile] Auth.policies ontbreekt: koppelen van telefoons is uitgeschakeld (geen beperkte toegang mogelijk)');
    }
    ctx.auth.onRevoke?.((ids) => this.pairing.onRevoked(ids));
    this.routes();
    this.status.routes();
    ctx.services.mobile = {
      /** Let a phone use one of your routes: ctx.services.mobile.allowRoute('GET', '/memory/items'). */
      allowRoute: (method: string, path: string) => (ctx.services.mobileRoutes as MobileRoute[]).push({ method, path }),
      sendPush: (userId: string, msg: PushMessage) => this.push.send(userId, msg),
      isDevice: (req: Request) => session(req)?.kind === 'device',
      /** The desktop app: keyboard/mouse idle seconds and screen lock of this computer, every few seconds. */
      reportPresence: (userId: string, f: { idleSeconds: number; locked: boolean }) => this.presence.report(userId, f),
      presence: (userId: string) => this.presence.view(userId),
      exportUser: (userId: string) => ({
        mobile: {
          devices: this.pairing.devices(userId, '').map(({ name, platform, client, created_at, last_seen, status }) => ({ name, platform, client, created_at, last_seen, status })),
          push: { prefs: this.push.prefs(userId), subscriptions: this.push.list(userId, '').length },
        },
      }),
      instance: this,
    };
  }

  async start() {
    this.unsub = this.ctx.events.subscribe(this.push.onEvent);
    this.timer = setInterval(() => {
      try {
        this.pairing.cleanup();
        this.push.cleanup();
      } catch (e) {
        this.ctx.log.warn('[mobile] opruimen mislukt', e);
      }
    }, 3600_000);
    this.timer.unref();
    await this.applyGateway();
    await this.iroh.apply();
  }

  async stop() {
    this.unsub?.();
    if (this.timer) clearInterval(this.timer);
    await this.gateway.stop();
    await this.iroh.stop();
  }

  private routes() {
    const { ctx } = this;
    const api = ctx.api;
    const notDevice = (req: Request) => {
      // A second line behind the device policy (policy.ts COMPUTER_ONLY says it first, with a reason per route).
      if (session(req)?.kind === 'device') throw forbidden('Dit doe je op je computer.');
    };

    // ----- public: pairing page + claim -----
    ctx.publicApi.get('/mobile/pair', (_req, res) => {
      const nonce = crypto.randomBytes(16).toString('base64');
      res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Robots-Tag', 'noindex');
      res.type('html').send(pairPage(ctx.config.appName, nonce));
    });
    ctx.publicApi.post('/mobile/claim', ah(async (req) => this.pairing.claim(req.body, req.ip || 'unknown', String(req.headers['user-agent'] || ''))));

    // ----- pairing (from a computer, never from a phone) -----
    api.post(
      '/mobile/pair',
      ah(async (req) => {
        notDevice(req);
        // 0.4.5: the one card asks for 'auto' (the TeamBot connection on, plus a ready https address when there is one).
        if (req.body?.baseUrl === AUTO_BASE) return this.autoTicket(req);
        // A QR code for the TeamBot connection turns it on when it is not on yet: making the code is the choice.
        if (req.body?.baseUrl === IROH_BASE && !this.iroh.link()) {
          const me = requireRole(req, 'admin');
          await this.setIroh(me.id, { enabled: true });
          if (!this.iroh.link()) throw bad(this.iroh.status().error || 'De TeamBot-verbinding start niet');
          await this.iroh.waitOnline(8000);
        }
        return this.pairing.createTicket(user(req), req.body?.baseUrl);
      }),
    );
    /** The TeamBot connection on or off, and an own relay (Geavanceerd). Computer only, admin only. */
    api.put(
      '/mobile/iroh',
      ah(async (req) => {
        notDevice(req);
        const me = requireRole(req, 'admin');
        const b = req.body || {};
        const patch: { enabled?: boolean; relay?: string | null } = {};
        if (b.enabled !== undefined) patch.enabled = !!b.enabled;
        if (b.relay !== undefined) patch.relay = normalizeRelayUrl(b.relay);
        await this.setIroh(me.id, patch);
        if (patch.enabled) await this.iroh.waitOnline(5000);
        return this.reachability(req);
      }),
    );
    api.get(
      '/mobile/pair/:id',
      ah(async (req) => {
        notDevice(req);
        return this.pairing.ticketStatus(user(req).id, String(req.params.id));
      }),
    );
    api.delete(
      '/mobile/pair/:id',
      ah(async (req) => {
        notDevice(req);
        this.pairing.cancel(user(req).id, String(req.params.id));
        return { ok: true };
      }),
    );

    // ----- this device -----
    api.get(
      '/mobile/devices/self',
      ah(async (req) => {
        const s = session(req);
        const device = s.kind === 'device' ? this.pairing.devices(user(req).id, s.id).find((d) => d.id === s.id) || null : null;
        return { kind: s.kind, device };
      }),
    );
    api.delete(
      '/mobile/devices/self',
      ah(async (req) => {
        const s = session(req);
        if (s.kind !== 'device') throw bad('Dit is geen gekoppeld apparaat. Gebruik Uitloggen.');
        return this.pairing.revoke(user(req).id, s.id);
      }),
    );
    api.post(
      '/mobile/devices/self/apns',
      ah(async (req) => {
        const s = session(req);
        if (s.kind !== 'device') throw bad('Alleen voor de iPhone-app');
        this.pairing.seen(s, String(req.headers['user-agent'] || ''));
        try {
          this.apns.setDeviceToken(s.id, req.body?.token, req.body?.environment);
        } catch (e: any) {
          throw bad(e.message);
        }
        return { ok: true, apns: this.apns.status() };
      }),
    );

    // ----- device list -----
    api.get(
      '/mobile/devices',
      ah(async (req) => {
        notDevice(req);
        return this.pairing.devices(user(req).id, session(req).id);
      }),
    );
    api.post(
      '/mobile/devices/:id/revoke',
      ah(async (req) => {
        notDevice(req);
        return this.pairing.revoke(user(req).id, String(req.params.id));
      }),
    );
    api.patch(
      '/mobile/devices/:id',
      ah(async (req) => {
        notDevice(req);
        return this.pairing.rename(user(req).id, String(req.params.id), req.body?.name);
      }),
    );

    // ----- reachability + gateway -----
    api.get(
      '/mobile/reachability',
      ah(async (req) => {
        notDevice(req);
        return this.reachability(req);
      }),
    );
    api.put(
      '/mobile/gateway',
      ah(async (req) => {
        notDevice(req);
        const me = requireRole(req, 'admin');
        const b = req.body || {};
        const cur = this.gatewaySettings();
        const enabled = b.enabled === undefined ? cur.enabled : !!b.enabled;
        if (enabled && !cur.enabled && b.acknowledge !== true) throw bad('Bevestig eerst dat je de waarschuwing hebt gelezen');
        const bind: GatewayBind = ['all', 'tailscale', 'loopback'].includes(b.bind) ? b.bind : cur.bind;
        let port = cur.port;
        if (b.port !== undefined) {
          if (b.port === null || b.port === '') port = null;
          else {
            const n = Number(b.port);
            if (!Number.isInteger(n) || n < 0 || n > 65535 || (n > 0 && n < 1024)) throw bad('Poort moet tussen 1024 en 65535 liggen');
            if (n !== 0 && n === ctx.config.port) throw bad('Kies een andere poort dan die van TeamBot zelf');
            port = n;
          }
        }
        ctx.store.setSetting('', 'mobileGateway', { enabled, bind, port });
        await this.applyGateway();
        ctx.audit(me.id, enabled ? 'mobile.gateway.enabled' : 'mobile.gateway.disabled', { bind, port, running: this.gateway.state.running, error: this.gateway.state.error });
        return this.reachability(req);
      }),
    );
    /**
     * One-click phone access over Tailscale: the gateway listens on loopback only (nothing on the LAN), and Tailscale
     * Serve publishes it as https://<this-pc>.<tailnet>.ts.net — reachable only by the owner's own tailnet devices.
     */
    api.post(
      '/mobile/tailscale-https',
      ah(async (req) => {
        notDevice(req);
        const me = requireRole(req, 'admin');
        if (req.body?.acknowledge !== true) throw bad('Bevestig eerst dat je de waarschuwing hebt gelezen');
        const ts = await this.tailscaleProbe(interfaces().tailscale.map((a) => a.address));
        if (!ts.installed) throw bad('Tailscale staat niet op deze computer. Installeer het via tailscale.com/download en log in.');
        if (!ts.running || !ts.dnsName) throw bad('Tailscale is niet verbonden. Open Tailscale op deze computer en log in.');
        const cur = this.gatewaySettings();
        const keepAll = cur.enabled && cur.bind === 'all';
        ctx.store.setSetting('', 'mobileGateway', { enabled: true, bind: keepAll ? 'all' : 'loopback', port: cur.port });
        await this.applyGateway();
        const gs = this.gateway.state;
        if (!gs.running || !gs.port) throw bad(`Telefoon-toegang kon niet starten: ${gs.error || 'onbekende fout'}`);
        // Pin the port so the Tailscale address keeps working after a restart.
        if (cur.port !== gs.port) ctx.store.setSetting('', 'mobileGateway', { ...this.gatewaySettings(), port: gs.port });
        const target = `http://127.0.0.1:${gs.port}`;
        const r = await this.serveRun(target);
        ctx.audit(me.id, 'mobile.tailscale.serve', { target, ok: r.ok, detail: r.detail });
        if (!r.ok) throw bad(r.detail);
        return { ...(await this.reachability(req)), serve: { url: `https://${ts.dnsName}`, target } };
      }),
    );

    // ----- push -----
    api.get(
      '/mobile/push',
      ah(async (req) => {
        const u = user(req);
        const s = session(req);
        const subs = this.push.list(u.id, s.id);
        return { publicKey: this.push.publicKey(), prefs: this.push.prefs(u.id), subscriptions: subs, subscribed: subs.some((x) => x.current), apns: this.apns.status(), device: s.kind === 'device', presence: this.presence.view(u.id) };
      }),
    );
    api.post(
      '/mobile/push/subscribe',
      ah(async (req) => {
        const u = user(req);
        const r = this.push.subscribe(u.id, session(req).id, req.body);
        ctx.events.emit(u.id, 'mobile.devices.updated', {});
        return { ok: true, id: r.id };
      }),
    );
    api.post(
      '/mobile/push/unsubscribe',
      ah(async (req) => {
        const u = user(req);
        this.push.unsubscribe(u.id, session(req).id, req.body?.endpoint);
        ctx.events.emit(u.id, 'mobile.devices.updated', {});
        return { ok: true };
      }),
    );
    api.put('/mobile/push/prefs', ah(async (req) => this.push.setPrefs(user(req).id, req.body)));
    api.post(
      '/mobile/push/test',
      ah(async (req) => {
        const u = user(req);
        if (!this.testLimiter.hit(u.id)) throw bad('Even wachten: maximaal 5 testmeldingen per minuut');
        const only = req.body?.thisDevice ? session(req).id : undefined;
        const results = await this.push.send(u.id, { title: 'Testmelding van TeamBot', body: 'Pushmeldingen werken op dit apparaat.', link: '#/settings/mobile-telefoon', tag: 'test', kind: 'test' }, { force: true, ttl: 300, sessionId: only });
        if (!results.length) throw bad(only ? 'Op dit apparaat staan nog geen meldingen aan' : 'Er staan op geen enkel apparaat meldingen aan');
        return { sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results: results.map((r) => ({ label: r.label, ok: r.ok, status: r.status, error: r.error, channel: r.channel })) };
      }),
    );
  }
}

const instances = new WeakMap<Ctx, Mobile>();

/** Telefoon: koppelen via QR, apparaten + intrekken, beperkte telefoon-toegang, bereikbaarheid, Web Push / APNs. */
const mod: Module = {
  id: 'mobile',
  label: 'Telefoon & meldingen',
  migrations: [
    {
      id: 'mobile-001',
      sql: `
CREATE TABLE mobile_pair_tickets (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, secret_hash TEXT NOT NULL UNIQUE, code TEXT NOT NULL,
  base_url TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, cancelled INTEGER NOT NULL DEFAULT 0,
  session_id TEXT, created_at TEXT NOT NULL
);
CREATE INDEX mobile_tickets_user ON mobile_pair_tickets(user_id);
CREATE INDEX mobile_tickets_code ON mobile_pair_tickets(code);
CREATE TABLE mobile_devices (
  session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, platform TEXT NOT NULL DEFAULT 'other',
  client TEXT NOT NULL DEFAULT 'browser', user_agent TEXT NOT NULL DEFAULT '', apns_enc TEXT, apns_env TEXT,
  created_at TEXT NOT NULL, revoked_at TEXT
);
CREATE INDEX mobile_devices_user ON mobile_devices(user_id);
CREATE TABLE mobile_push_subs (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT NOT NULL, endpoint_hash TEXT NOT NULL UNIQUE,
  data_enc TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, last_ok TEXT, last_error TEXT,
  failures INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX mobile_push_user ON mobile_push_subs(user_id);
CREATE INDEX mobile_push_session ON mobile_push_subs(session_id);
`,
    },
  ],
  init(ctx) {
    const m = new Mobile(ctx);
    instances.set(ctx, m);
    m.init();
  },
  async start(ctx) {
    await instances.get(ctx)?.start();
  },
  async stop(ctx) {
    await instances.get(ctx)?.stop();
  },
};
export default mod;
