import type { Request, Response } from 'express';
import type { Ctx, User } from '../../core/types.js';
import type { SessionInfo } from '../../core/auth.js';
import { HttpError } from '../../core/http.js';

/**
 * What a paired phone (session of kind "device") may do. Since 0.4.1 the owner's phone can do everything the
 * computer can — make bots, connect AI, change settings, routines, teams — because the owner is often away from the
 * computer (owner, 9 November 2026: "ik kan nu niks … ik kan niet eens wat bedienen via de app"). Only a short
 * denylist stays computer-only: things that hand out access or reveal secrets if a phone is lost — admin and user
 * management, pairing or managing other devices and sessions, revealing secrets and vault passwords, full data export,
 * and changing who can reach the computer over the network. The listed rules below still apply their checks
 * (e-mail/password only on the computer, "always allow" only on the computer) and their safe answers (provider list
 * without keys).
 */

export interface MobileRoute {
  method: string;
  /** Express-like path relative to /api: `/threads/:id/messages`, optional trailing `/*`. */
  path: string;
}

interface Rule extends MobileRoute {
  check?(req: Request): void;
  handle?(req: Request, res: Response, who: { user: User; session: SessionInfo }): void;
}

const deny = (msg = 'Dit kan om veiligheidsredenen alleen op je computer.') => new HttpError(403, msg, 'mobile_denied');

/**
 * Computer-only routes (prefix match on the path relative to /api). Everything else is allowed for the owner's phone.
 * `/mobile/devices/self…` stays allowed (the phone's own entry); other devices are managed on the computer.
 */
const COMPUTER_ONLY: { re: RegExp; msg: string }[] = [
  { re: /^\/admin(\/|$)/i, msg: 'Beheer (gebruikers, uitnodigingen, netwerk, SSO) doe je op je computer.' },
  { re: /^\/(export|memory\/export)(\/|$)/i, msg: 'Al je gegevens exporteren kan alleen op je computer.' },
  { re: /^\/secrets(\/|$)/i, msg: 'Opgeslagen sleutels bekijken kan alleen op je computer.' },
  { re: /^\/computers\/vault(\/|$)/i, msg: 'De kluis met wachtwoorden open je alleen op je computer.' },
  // The proxy of a browser profile carries a login (module browser, 0.4.4).
  { re: /^\/computers\/profiles\/[^/]+\/proxy(\/|$)/i, msg: 'De proxy van een browserprofiel stel je in op je computer.' },
  // Giving a stored secret to a bot's scripts hands out access (module script-keys).
  { re: /^\/script-keys(\/|$)/i, msg: 'Sleutels voor scripts beheer je op je computer.' },
  { re: /^\/routines\/triggers\/[^/]+\/secret(\/|$)/i, msg: 'Het geheim van een webhook bekijk je op je computer.' },
  // Own rules (module botrules): a rule that lets a bot do more, or removing a rule, makes the bot looser.
  { re: /^\/bot-rules\/loosen(\/|$)/i, msg: 'Een regel die de bot meer laat doen, of een regel weghalen, doe je op je computer.' },
  { re: /^\/realtime\/client_secrets(\/|$)/i, msg: 'Dit kan alleen op je computer.' },
  { re: /^\/(pair|pairing|mobile\/pair)(\/|$)/i, msg: 'Een nieuw apparaat koppelen doe je op je computer.' },
  { re: /^\/mobile\/devices(?!\/self(\/|$))(\/|$)/i, msg: 'Andere gekoppelde apparaten beheer je op je computer.' },
  { re: /^\/sessions(\/|$)/i, msg: 'Inlogsessies beheer je op je computer.' },
  { re: /^\/mobile\/gateway(\/|$)/i, msg: 'Telefoontoegang aan- of uitzetten doe je op je computer.' },
  { re: /^\/mobile\/iroh(\/|$)/i, msg: 'De TeamBot-verbinding zet je aan of uit op je computer.' },
  // Who can reach the computer over the network (its addresses, Tailscale): the phone never asks (0.4.3; the routes
  // themselves refuse a phone too).
  { re: /^\/mobile\/(reachability|tailscale-https)(\/|$)/i, msg: 'Wie je computer via het netwerk kan bereiken, stel je in op je computer.' },
  // Remote desktop: switching it on or changing it stays at the computer (a lost phone can never turn it on);
  // switching it off (`/remote-desktop/off`) and using it while it is on work from the phone.
  { re: /^\/remote-desktop\/switch(\/|$)/i, msg: 'Bureaublad op afstand aanzetten of instellen doe je op de computer zelf. Uitzetten kan ook hier.' },

  // A folder on this computer and the password of the encrypted copies (module backups, offsite.ts).
  { re: /^\/backups\/offsite(\/|$)/i, msg: 'De tweede plek voor back-ups stel je in op je computer.' },

  // Where TeamBot fetches its own updates (0.4.4): a lost phone must not point the computer at another server. The
  // status, "Nu bijwerken" and Automatisch bijwerken stay available on the phone.
  { re: /^\/app-update\/channel(\/|$)/i, msg: 'Het updatekanaal stel je in op je computer.' },
];

export function coreRules(ctx: Ctx): Rule[] {
  return [
    { method: 'GET', path: '/me' },
    {
      method: 'PATCH',
      path: '/me',
      check(req) {
        const b = req.body || {};
        if (b.email !== undefined || b.password !== undefined) throw deny('E-mailadres en wachtwoord wijzig je op je computer.');
      },
    },
    { method: 'POST', path: '/auth/logout' },
    // The key for signing image, download and live-stream links of this phone's own session.
    { method: 'GET', path: '/auth/url-key' },
    { method: 'GET', path: '/settings' },
    { method: 'PUT', path: '/settings' },
    // Chat channels: the phone manages them, but making someone an OWNER of a channel (full say over the bots) hands
    // out access — that stays on the computer (found by the parity check, 0.4.2).
    {
      method: 'POST',
      path: '/channels/bindings/:id/senders',
      check(req) {
        if (req.body?.is_owner) throw deny('Iemand eigenaar van een kanaal maken doe je op je computer.');
      },
    },
    {
      method: 'PATCH',
      path: '/channels/bindings/:id/senders/:sid',
      check(req) {
        if (req.body?.is_owner) throw deny('Iemand eigenaar van een kanaal maken doe je op je computer.');
      },
    },
    {
      method: 'POST',
      path: '/channels/bindings/:id/pair-codes',
      check(req) {
        if (req.body?.owner) throw deny('Een koppelcode voor een eigenaar maak je op je computer.');
      },
    },
    { method: 'GET', path: '/agents' },
    { method: 'GET', path: '/agents/:id' },
    {
      // Provider list without base URL, config (may hold custom auth headers) or key status.
      method: 'GET',
      path: '/providers',
      handle(_req, res, who) {
        res.json(
          ctx.providers.list(who.user.id).map((p) => ({
            id: p.id,
            kind: p.kind,
            name: p.name,
            enabled: p.enabled,
            shared: p.shared,
            own: p.user_id === who.user.id,
            kindLabel: ctx.providers.kinds.get(p.kind)?.label || p.kind,
            type: ctx.providers.kinds.get(p.kind)?.type || 'api',
            config: {},
            base_url: '',
            hasKey: false,
            created_at: p.created_at,
            user_id: p.user_id,
          })),
        );
      },
    },
    {
      // Minimal system info (no data dir, host or LAN addresses).
      method: 'GET',
      path: '/system',
      handle(_req, res, who) {
        res.json({
          app: ctx.config.appName,
          version: ctx.config.version,
          mode: ctx.config.mode,
          modules: ctx.modules.map((m) => ({ id: m.id, label: m.label || m.id })),
          publicUrl: ctx.config.publicUrl || null,
          device: true,
          stats: { activeRuns: ctx.runs.activeRuns(who.user.id).length },
        });
      },
    },
    { method: 'GET', path: '/tools' },
    { method: 'GET', path: '/usage' },
    // chats
    { method: 'GET', path: '/threads' },
    { method: 'POST', path: '/threads' },
    { method: 'GET', path: '/threads/:id' },
    { method: 'PATCH', path: '/threads/:id' },
    { method: 'POST', path: '/threads/:id/messages' },
    { method: 'POST', path: '/threads/:id/stop' },
    { method: 'POST', path: '/threads/:id/resume' },
    { method: 'POST', path: '/threads/:id/retry' },
    { method: 'GET', path: '/threads/:id/export' },
    { method: 'PATCH', path: '/messages/:id' },
    { method: 'POST', path: '/messages/:id/react' },
    { method: 'POST', path: '/messages/:id/pin' },
    { method: 'POST', path: '/messages/:id/forward' },
    // attachments, search
    { method: 'POST', path: '/attachments' },
    { method: 'GET', path: '/attachments/:id' },
    { method: 'GET', path: '/search' },
    // questions / approvals: approve once or deny — never "always allow" from a phone
    { method: 'GET', path: '/approvals' },
    {
      method: 'POST',
      path: '/approvals/:id',
      check(req) {
        if (req.body?.decision === 'always') throw deny('“Altijd toestaan” kan alleen op je computer. Op de telefoon keur je één keer goed of af.');
      },
    },
    // task status + stop
    { method: 'GET', path: '/runs' },
    { method: 'POST', path: '/runs/:id/cancel' },
    { method: 'POST', path: '/stop-all' },
    // rooms (read; room messages go through /threads)
    { method: 'GET', path: '/rooms' },
    { method: 'GET', path: '/rooms/:id' },
    { method: 'GET', path: '/rooms/by-thread/:threadId' },
    { method: 'POST', path: '/rooms/:id/stop' },
    { method: 'POST', path: '/rooms/:id/accept' },
    { method: 'POST', path: '/rooms/:id/decline' },
    { method: 'GET', path: '/rooms/delegations' },
    { method: 'GET', path: '/rooms/delegations/by-call/:callId' },
    { method: 'GET', path: '/rooms/tasks' },
    { method: 'PATCH', path: '/rooms/tasks/:id' },
    { method: 'GET', path: '/rooms/inbox' },
    { method: 'POST', path: '/rooms/inbox/:id/read' },
    // this module: own device + push
    { method: 'GET', path: '/mobile/devices/self' },
    { method: 'DELETE', path: '/mobile/devices/self' },
    { method: 'POST', path: '/mobile/devices/self/apns' },
    // iPhone app: per-link status (addresses, keep-awake) and the consent list (which AI services get what)
    { method: 'GET', path: '/mobile/status' },
    { method: 'GET', path: '/mobile/privacy' },
    { method: 'GET', path: '/mobile/push' },
    { method: 'POST', path: '/mobile/push/subscribe' },
    { method: 'POST', path: '/mobile/push/unsubscribe' },
    { method: 'POST', path: '/mobile/push/test' },
    { method: 'PUT', path: '/mobile/push/prefs' },
    // shell features available on the phone: HTML previews, link previews, summarising a long chat
    { method: 'POST', path: '/attachments/:id/preview' },
    { method: 'GET', path: '/link-preview' },
    { method: 'POST', path: '/threads/:id/compact' },
    { method: 'POST', path: '/threads/:id/fork' },
  ];
}

// A route parameter is a generated id (always has digits/underscores), never a bare word: otherwise `/rooms/:id`
// would also allow sibling routes such as `/rooms/people` or `/rooms/defaults` that were never opted in.
const PARAM = '(?![a-z-]+(?:/|$))[^/]+';

function compile(path: string): RegExp {
  const wild = path.endsWith('/*');
  const base = wild ? path.slice(0, -2) : path;
  const body = base
    .split('/')
    .map((seg) => (seg.startsWith(':') ? PARAM : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  // Case-sensitive on purpose: odd casing is denied (Express itself would route it case-insensitively).
  return new RegExp(`^${body}${wild ? '(?:/.*)?' : ''}/?$`);
}

export class DevicePolicy {
  private rules: { rule: Rule; re: RegExp }[];
  private extraCount = -1;
  private extra: { rule: Rule; re: RegExp }[] = [];

  constructor(private ctx: Ctx, private onDeviceSeen?: (req: Request, session: SessionInfo) => void) {
    this.rules = coreRules(ctx).map((rule) => ({ rule, re: compile(rule.path) }));
  }

  private extras() {
    const list: MobileRoute[] = Array.isArray(this.ctx.services.mobileRoutes) ? this.ctx.services.mobileRoutes : [];
    if (list.length !== this.extraCount) {
      this.extra = list
        .filter((r) => r && typeof r.method === 'string' && typeof r.path === 'string' && r.path.startsWith('/') && !r.path.startsWith('/mobile/'))
        .map((r) => ({ rule: { method: r.method.toUpperCase(), path: r.path }, re: compile(r.path) }));
      this.extraCount = list.length;
    }
    return this.extra;
  }

  match(method: string, path: string): Rule | null {
    const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
    for (const { rule, re } of this.rules) if (rule.method === m && re.test(path)) return rule;
    for (const { rule, re } of this.extras()) if (rule.method === m && re.test(path)) return rule;
    return null;
  }

  /**
   * May a phone use this route at all? The same decision as `policy` below, without a request: everything except the
   * computer-only list (a listed rule's own checks, e.g. "always allow", still apply per request). For modules that
   * ask before showing something on the phone (e.g. which sources a search on the phone covers).
   */
  allows(method: string, path: string): boolean {
    return !!this.match(method, path) || !COMPUTER_ONLY.some((b) => b.re.test(path));
  }

  /** Auth policy (see Auth.policies): only acts on device sessions. */
  policy = (req: Request, res: Response, who: { user: User; session: SessionInfo }): boolean | void => {
    if (who.session.kind !== 'device') return;
    this.onDeviceSeen?.(req, who.session);
    const rule = this.match(req.method, req.path);
    if (!rule) {
      const blocked = COMPUTER_ONLY.find((b) => b.re.test(req.path));
      if (blocked) throw deny(blocked.msg);
      return;
    }
    rule.check?.(req);
    if (rule.handle) {
      rule.handle(req, res, who);
      return true;
    }
  };
}
