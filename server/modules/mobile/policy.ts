import type { Request, Response } from 'express';
import type { Ctx, User } from '../../core/types.js';
import type { SessionInfo } from '../../core/auth.js';
import { HttpError } from '../../core/http.js';

/**
 * What a paired phone (session of kind "device") may do. The owner's phone can do everything the computer can (owner,
 * 9 November 2026: "ik kan niet eens wat bedienen via de app"; 15 November: "mobiel moet ook alle toegang hebben"),
 * except pairing a new device and managing the other devices and their login sessions, so a lost phone cannot add a
 * device of its own. The listed rules below still apply their checks (e-mail/password only on the computer, "always
 * allow" only on the computer) and their safe answers (provider list without keys). A bot's own call is a device
 * session too; what a bot may do is decided before that, in teams/manage.ts.
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
 * What the owner's phone may not do: pair a new device, manage the other devices and their sessions, so a lost phone
 * cannot add a device of its own. Everything else the computer can, the phone can too (owner, 15 nov: "mobiel moet
 * ook alle toegang hebben", "alles, maar koppelen blijft pc"). A bot calls TeamBot as a device too; what a bot may
 * not do is decided in teams/manage.ts (NEVER), before its call is made. `/mobile/devices/self…` stays allowed: the
 * phone's own entry.
 */
const COMPUTER_ONLY: { re: RegExp; msg: string }[] = [
  { re: /^\/(pair|pairing|mobile\/pair)(\/|$)/i, msg: 'Een nieuw apparaat koppelen doe je op je computer.' },
  { re: /^\/mobile\/devices(?!\/self(\/|$))(\/|$)/i, msg: 'Andere gekoppelde apparaten beheer je op je computer.' },
  { re: /^\/sessions(\/|$)/i, msg: 'Inlogsessies beheer je op je computer.' },
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
