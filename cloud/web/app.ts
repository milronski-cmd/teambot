import path from 'node:path';
import express, { type Request, type Response, type NextFunction } from 'express';
import type { CloudConfig } from '../config.js';
import type { Db } from '../db.js';
import type { Plan } from '../billing/plans.js';
import type { BillingService } from '../billing/service.js';
import { Accounts, UserError, type Account, type Session } from '../accounts.js';
import type { ActorRef, Workspace, WorkspaceService } from '../workspaces.js';
import { audit } from '../audit.js';
import { ProvisionError } from '../provisioner/types.js';
import { hmacHex, newId, randomToken, safeEqual } from '../crypto.js';
import { trusted } from '../proxy.js';
import { addDays, calendarDays, localDay, MONTH_RE, monthOf, RateLimiter, suggestSlug, toLocalInput, zonedTimeToUtc, type Clock, type Log } from '../util.js';
import type { MonitoringService } from '../monitoring.js';
import type { AlertService } from '../alerts.js';
import { reportCsv, reportsSummaryCsv, type ReportService } from '../reports.js';
import { planById } from '../billing/plans.js';
import { layout, type Flash, type Raw } from './html.js';
import * as P from './pages.js';

export interface ControlDeps {
  cfg: CloudConfig;
  db: Db;
  plans: Plan[];
  clock: Clock;
  log: Log;
  workspaces: WorkspaceService;
  monitoring: MonitoringService;
  alerts: AlertService;
  reports: ReportService;
  accounts: Accounts;
  billing: BillingService;
}

/** Fixed flash messages selected by ?m=<code> (never reflect free text from the URL). */
const MESSAGES: Record<string, Flash> = {
  welkom: { kind: 'ok', text: 'Je account is aangemaakt. Maak nu je eerste workspace.' },
  'workspace-gemaakt': { kind: 'ok', text: 'Je workspace wordt klaargezet. Dat duurt meestal een paar seconden.' },
  'export-klaar': { kind: 'ok', text: 'Je export staat klaar om te downloaden.' },
  verwijderd: { kind: 'ok', text: 'Je workspace is verwijderd, met al zijn gegevens.' },
  betaald: { kind: 'ok', text: 'Bedankt! We verwerken je abonnement; dat kan een minuutje duren.' },
  'betaling-afgebroken': { kind: 'error', text: 'Het afrekenen is afgebroken. Er is niets betaald.' },
  uitgelogd: { kind: 'ok', text: 'Je bent uitgelogd.' },
  'email-bevestigd': { kind: 'ok', text: 'Je e-mailadres is bevestigd.' },
  'link-verstuurd': { kind: 'ok', text: 'We hebben je een nieuwe link gestuurd.' },
  opgeslagen: { kind: 'ok', text: 'Opgeslagen.' },
  'storing-gemeld': { kind: 'ok', text: 'De storing staat op de statuspagina.' },
  'onderhoud-gepland': { kind: 'ok', text: 'Het onderhoud is aangekondigd.' },
  'onderhoud-kort': { kind: 'error', text: 'Aangekondigd, maar met te weinig voorbereidingstijd: dit onderhoud telt mee als uitval.' },
  'onderhoud-geannuleerd': { kind: 'ok', text: 'Het onderhoud is geannuleerd.' },
  'test-verstuurd': { kind: 'ok', text: 'Testmelding verstuurd. Hieronder zie je of het lukte.' },
  'rapport-gemaakt': { kind: 'ok', text: 'Er is een nieuwe versie van het rapport gemaakt.' },
  'rapporten-gemaakt': { kind: 'ok', text: 'Ontbrekende rapporten zijn gemaakt.' },
  'credit-goedgekeurd': { kind: 'ok', text: 'Credit goedgekeurd.' },
  'credit-afgewezen': { kind: 'ok', text: 'Credit afgewezen.' },
  'credit-verrekend': { kind: 'ok', text: 'Credit gemarkeerd als verrekend.' },
};

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    if (k in out) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* ignore malformed cookie */
    }
  }
  return out;
}

export function createControlApp(d: ControlDeps): express.Express {
  const { cfg } = d;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', (addr: string) => trusted(addr, cfg.trustProxy));

  // __Host- cookies cannot be set or overwritten by a workspace subdomain (cookie tossing); needs Secure (HTTPS).
  const names = { session: cfg.cookieSecure ? '__Host-tbc_session' : 'tbc_session', pre: cfg.cookieSecure ? '__Host-tbc_pre' : 'tbc_pre' };
  const cookie = (name: string, value: string, maxAgeSec: number, sameSite: 'Lax' | 'Strict') =>
    `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; SameSite=${sameSite}${cfg.cookieSecure ? '; Secure' : ''}`;
  const anonToken = (pre: string) => hmacHex(cfg.secretKey, `csrf:${pre}`);

  const loginEmail = new RateLimiter(cfg.limits.loginPerEmail, cfg.limits.loginWindowMs);
  const loginIp = new RateLimiter(cfg.limits.loginPerIp, cfg.limits.loginWindowMs);
  const signupIp = new RateLimiter(cfg.limits.signupPerIp, cfg.limits.signupWindowMs);

  const workspaceOrigins = `${cfg.scheme}://*.${cfg.domain}${cfg.portSuffix}`;
  const CSP = `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self' ${workspaceOrigins} https://checkout.stripe.com https://billing.stripe.com`;

  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    if (cfg.scheme === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  // Stripe webhook: raw body (the signature covers the exact bytes); no session, no CSRF — the signature is the auth.
  app.post('/stripe/webhook', express.raw({ type: () => true, limit: '1mb' }), async (req, res) => {
    const r = await d.billing.handleWebhook(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), req.get('stripe-signature'), req.ip || '');
    res.status(r.status).json(r.body);
  });

  app.use(express.urlencoded({ extended: false, limit: '32kb', parameterLimit: 50 }));

  // ---------- session + CSRF ----------
  app.use(async (req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    const who = await d.accounts.resolve(cookies[names.session]);
    res.locals.viewer = who?.account || null;
    res.locals.session = who?.session || null;
    let pre = cookies[names.pre];
    if (!pre || !/^[A-Za-z0-9_-]{20,64}$/.test(pre)) {
      pre = randomToken(24);
      res.append('Set-Cookie', cookie(names.pre, pre, 4 * 3600, 'Strict'));
    }
    res.locals.csrf = who ? who.session.csrf_token : anonToken(pre);
    next();
  });

  app.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    const origin = req.get('origin');
    const site = req.get('sec-fetch-site');
    const t = String((req.body as any)?._csrf || '');
    const session = res.locals.session as Session | null;
    const pre = parseCookies(req.headers.cookie)[names.pre];
    const ok =
      (!origin || origin === cfg.url) &&
      site !== 'cross-site' &&
      !!t &&
      ((!!session && safeEqual(t, session.csrf_token)) || (!!pre && safeEqual(t, anonToken(pre))));
    if (ok) return next();
    page(res, 403, 'Verlopen formulier', P.messagePage('Dit formulier is verlopen', 'Ga terug, ververs de pagina en probeer het opnieuw.', { href: '/dashboard', label: 'Naar je dashboard' }));
  });

  // ---------- helpers ----------
  function page(res: Response, status: number, title: string, body: Raw, o: { flash?: Flash | null; refreshSec?: number } = {}) {
    const v = res.locals.viewer as Account | null;
    res
      .status(status)
      .type('html')
      .send(layout({ title, body, viewer: v ? { name: v.name, email: v.email, role: v.role } : null, csrf: res.locals.csrf, flash: o.flash, refreshSec: o.refreshSec }));
  }
  const ctx = (res: Response): P.Ctx => ({ csrf: res.locals.csrf, tz: cfg.timeZone, domain: cfg.domain, url: cfg.url });
  const flashOf = (req: Request): Flash | null => MESSAGES[String(req.query.m || '')] || null;
  const ip = (req: Request) => req.ip || req.socket.remoteAddress || '';
  const ref = (req: Request, res: Response, actor: 'user' | 'operator' = 'user'): ActorRef => ({ actor, actorId: (res.locals.viewer as Account | null)?.id, ip: ip(req) });
  const needsVerify = (a: Account) => !!cfg.smtpUrl && !a.email_verified;

  function requireUser(req: Request, res: Response): Account | null {
    const v = res.locals.viewer as Account | null;
    if (!v) {
      res.redirect(303, '/login');
      return null;
    }
    return v;
  }
  function requireOperator(req: Request, res: Response): Account | null {
    const v = requireUser(req, res);
    if (v && v.role !== 'operator') {
      page(res, 403, 'Geen toegang', P.messagePage('Geen toegang', 'Deze pagina is alleen voor beheer.', { href: '/dashboard', label: 'Naar je dashboard' }));
      return null;
    }
    return v;
  }
  /** Workspace of the logged-in account; anything else is a 404 (no hint that it exists). */
  async function owned(req: Request, res: Response): Promise<{ account: Account; ws: Workspace } | null> {
    const account = requireUser(req, res);
    if (!account) return null;
    const id = String(req.params.id || '');
    const ws = /^ws_[a-z0-9]{8,64}$/.test(id) ? await d.workspaces.getOwned(id, account.id) : null;
    if (!ws) {
      page(res, 404, 'Niet gevonden', P.messagePage('Niet gevonden', 'Deze workspace bestaat niet of is niet van jou.', { href: '/dashboard', label: 'Naar je dashboard' }));
      return null;
    }
    return { account, ws };
  }
  async function view(ws: Workspace): Promise<P.WorkspaceView> {
    return { ws, sub: await d.billing.subscription(ws.id), url: d.workspaces.openUrl(ws), plan: d.workspaces.plan(ws) };
  }
  async function availability(ws: Workspace): Promise<P.Availability> {
    return {
      uptime30: await d.monitoring.uptime(ws.id, 30),
      uptime90: await d.monitoring.uptime(ws.id, 90),
      incidents: await d.monitoring.incidentsFor(ws.id, 90),
      maintenance: await d.monitoring.upcoming({ workspaceId: ws.id }),
    };
  }
  async function renderWorkspace(req: Request, res: Response, ws: Workspace, flash: Flash | null, status = 200) {
    const v = await view(ws);
    const o = {
      exports: await d.workspaces.exports(ws.id),
      plans: d.plans,
      mode: d.billing.mode,
      storageLimitGb: v.plan.storageGb,
      availability: await availability(ws),
      stripePrices: cfg.stripe.prices,
      reports: await d.reports.listForWorkspace(ws.id),
    };
    page(res, status, ws.name, P.workspacePage(ctx(res), v, o), {
      flash,
      refreshSec: ws.status === 'provisioning' && !ws.status_reason ? 3 : undefined,
    });
  }
  /** Run a workspace action; show Dutch errors on the workspace page instead of a generic error. */
  function action(fn: (req: Request, res: Response, o: { account: Account; ws: Workspace }) => Promise<void>) {
    return async (req: Request, res: Response) => {
      const o = await owned(req, res);
      if (!o) return;
      try {
        await fn(req, res, o);
      } catch (e) {
        if (!(e instanceof UserError)) throw e;
        const fresh = (await d.workspaces.get(o.ws.id)) || o.ws;
        await renderWorkspace(req, res, fresh, { kind: 'error', text: e.message }, e.status);
      }
    };
  }

  // ---------- public ----------
  app.get('/', (req, res) => page(res, 200, 'Je eigen TeamBot, altijd aan', P.homePage(d.plans, !!res.locals.viewer, cfg.domain), { flash: flashOf(req) }));

  app.get('/signup', (req, res) => {
    if (res.locals.viewer) return res.redirect(303, '/dashboard');
    page(res, 200, 'Account maken', P.signupPage(ctx(res), {}, undefined, !cfg.signupOpen));
  });

  app.post('/signup', async (req, res) => {
    const b = req.body as Record<string, string>;
    if (!cfg.signupOpen) return page(res, 403, 'Account maken', P.signupPage(ctx(res), {}, undefined, true));
    if (!signupIp.hit(ip(req))) return page(res, 429, 'Account maken', P.signupPage(ctx(res), b, 'Te veel aanmeldingen vanaf dit adres. Probeer het over een uur opnieuw.'));
    try {
      const { account, verifyToken } = await d.accounts.signup({ email: b.email, name: b.name, password: b.password }, ip(req));
      const s = await d.accounts.createSession(account.id, ip(req), String(req.get('user-agent') || ''));
      res.append('Set-Cookie', cookie(names.session, s.token, 30 * 86400, 'Lax'));
      if (verifyToken) await d.accounts.sendVerification(account, verifyToken);
      res.redirect(303, '/dashboard?m=welkom');
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      page(res, e.status, 'Account maken', P.signupPage(ctx(res), b, e.message));
    }
  });

  app.get('/login', (req, res) => {
    if (res.locals.viewer) return res.redirect(303, '/dashboard');
    page(res, 200, 'Inloggen', P.loginPage(ctx(res), {}), { flash: flashOf(req) });
  });

  app.post('/login', async (req, res) => {
    const b = req.body as Record<string, string>;
    const email = String(b.email || '').trim().toLowerCase().slice(0, 254);
    if (loginEmail.blocked(email) || loginIp.blocked(ip(req))) {
      return page(res, 429, 'Inloggen', P.loginPage(ctx(res), { email }, 'Te veel mislukte pogingen. Probeer het over een kwartier opnieuw.'));
    }
    const account = await d.accounts.checkPassword(email, String(b.password || ''));
    if (!account) {
      loginEmail.hit(email);
      loginIp.hit(ip(req));
      await audit(d.db, d.clock, { actor: 'user', kind: 'account.login_failed', ip: ip(req) });
      return page(res, 401, 'Inloggen', P.loginPage(ctx(res), { email }, 'Onjuist e-mailadres of wachtwoord.'));
    }
    loginEmail.reset(email);
    const prev = res.locals.session as Session | null;
    if (prev) await d.accounts.revokeSession(prev.id);
    const s = await d.accounts.createSession(account.id, ip(req), String(req.get('user-agent') || ''));
    res.append('Set-Cookie', cookie(names.session, s.token, 30 * 86400, 'Lax'));
    await audit(d.db, d.clock, { actor: 'user', actorId: account.id, kind: 'account.login', ip: ip(req) });
    res.redirect(303, '/dashboard');
  });

  app.post('/logout', async (req, res) => {
    const s = res.locals.session as Session | null;
    if (s) await d.accounts.revokeSession(s.id);
    res.append('Set-Cookie', cookie(names.session, '', 0, 'Lax'));
    res.redirect(303, '/login?m=uitgelogd');
  });

  app.get('/verify', async (req, res) => {
    const ok = await d.accounts.verifyEmail(String(req.query.t || ''));
    if (ok) return res.redirect(303, '/dashboard?m=email-bevestigd');
    page(res, 400, 'Link verlopen', P.messagePage('Deze link werkt niet (meer)', 'Log in en vraag een nieuwe link aan.', { href: '/login', label: 'Inloggen' }));
  });

  app.post('/verify/resend', async (req, res) => {
    const a = requireUser(req, res);
    if (!a) return;
    if (needsVerify(a) && signupIp.hit(`verify|${a.id}`)) await d.accounts.sendVerification(a, await d.accounts.newVerifyToken(a.id));
    res.redirect(303, '/dashboard?m=link-verstuurd');
  });

  // ---------- dashboard ----------
  app.get('/dashboard', async (req, res) => {
    const a = requireUser(req, res);
    if (!a) return;
    const list = await d.workspaces.listForOwner(a.id);
    const items = await Promise.all(list.map(view));
    const busy = list.some((w) => w.status === 'provisioning' && !w.status_reason);
    page(res, 200, 'Dashboard', P.dashboardPage(ctx(res), items, { needsVerify: needsVerify(a), canCreate: list.length < cfg.maxWorkspacesPerAccount }), {
      flash: flashOf(req),
      refreshSec: busy ? 3 : undefined,
    });
  });

  app.get('/workspaces/new', (req, res) => {
    const a = requireUser(req, res);
    if (!a) return;
    if (needsVerify(a)) return res.redirect(303, '/dashboard');
    page(res, 200, 'Nieuwe workspace', P.newWorkspacePage(ctx(res), {}));
  });

  app.post('/workspaces', async (req, res) => {
    const a = requireUser(req, res);
    if (!a) return;
    const b = req.body as Record<string, string>;
    const v = { name: String(b.name || ''), slug: String(b.slug || '').trim().toLowerCase() || suggestSlug(String(b.name || '')) };
    if (needsVerify(a)) return page(res, 403, 'Nieuwe workspace', P.newWorkspacePage(ctx(res), v, 'Bevestig eerst je e-mailadres.'));
    try {
      await d.workspaces.create(a.id, v, ref(req, res), d.billing.mode);
      res.redirect(303, '/dashboard?m=workspace-gemaakt');
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      page(res, e.status, 'Nieuwe workspace', P.newWorkspacePage(ctx(res), v, e.message));
    }
  });

  app.get('/workspaces/:id', async (req, res) => {
    const o = await owned(req, res);
    if (o) await renderWorkspace(req, res, o.ws, flashOf(req));
  });

  app.post(
    '/workspaces/:id/claim',
    action(async (req, res, { ws }) => {
      res.redirect(303, await d.workspaces.newClaimLink(ws.id, ref(req, res)));
    }),
  );

  app.post(
    '/workspaces/:id/retry',
    action(async (_req, res, { ws }) => {
      await d.workspaces.retry(ws.id);
      res.redirect(303, '/dashboard');
    }),
  );

  app.post(
    '/workspaces/:id/checkout',
    action(async (req, res, { ws, account }) => {
      res.redirect(303, await d.billing.checkoutUrl(ws, account, String((req.body as any).plan || '')));
    }),
  );

  app.post(
    '/workspaces/:id/portal',
    action(async (_req, res, { ws, account }) => {
      res.redirect(303, await d.billing.portalUrl(ws, account));
    }),
  );

  app.post(
    '/workspaces/:id/export',
    action(async (req, res, { ws }) => {
      await d.workspaces.createExport(ws.id, ref(req, res));
      res.redirect(303, `/workspaces/${ws.id}?m=export-klaar#export`);
    }),
  );

  app.get('/workspaces/:id/exports/:exportId', async (req, res) => {
    const o = await owned(req, res);
    if (!o) return;
    const file = await d.workspaces.exportPath(o.ws.id, String(req.params.exportId));
    if (!file) return page(res, 404, 'Niet gevonden', P.messagePage('Export niet gevonden', 'Deze export is verlopen of bestaat niet. Maak een nieuwe.', { href: `/workspaces/${o.ws.id}#export`, label: 'Naar je workspace' }));
    await audit(d.db, d.clock, { ...ref(req, res), kind: 'workspace.export_downloaded', workspaceId: o.ws.id });
    // The service's data folder may lie under a folder whose name starts with a dot: Express refuses that by default.
    res.download(file, path.basename(file), { dotfiles: 'allow' });
  });

  app.post(
    '/workspaces/:id/delete',
    action(async (req, res, { ws }) => {
      if (String((req.body as any).confirm || '').trim() !== ws.slug) throw new UserError(`Typ precies "${ws.slug}" om te bevestigen.`);
      await d.billing.cancelBeforeDelete(ws, ref(req, res));
      await d.workspaces.remove(ws.id, ref(req, res));
      res.redirect(303, '/dashboard?m=verwijderd');
    }),
  );

  // ---------- SLA reports (owner) ----------
  async function ownedReport(req: Request, res: Response) {
    const o = await owned(req, res);
    if (!o) return null;
    const month = String(req.params.month || '');
    const row = MONTH_RE.test(month) ? await d.reports.current(o.ws.id, month) : null;
    if (!row) {
      page(res, 404, 'Niet gevonden', P.messagePage('Rapport niet gevonden', 'Voor deze maand is (nog) geen rapport.', { href: `/workspaces/${o.ws.id}#rapporten`, label: 'Naar je workspace' }));
      return null;
    }
    return { ...o, row, credit: await d.reports.credit(row.id) };
  }
  const sendCsv = (res: Response, name: string, body: string) => {
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.type('text/csv; charset=utf-8').send('\ufeff' + body);
  };
  const reportJson = (row: { version: number; generated_at: Date; reason: string | null; data: unknown }, credit: { status: string; pct: number; amount_cents: number; currency: string } | null) => ({
    version: row.version,
    generatedAt: row.generated_at,
    reason: row.reason,
    report: row.data,
    credit: credit ? { status: credit.status, pct: credit.pct, amountCents: credit.amount_cents, currency: credit.currency } : null,
  });

  app.get('/workspaces/:id/reports/:month', async (req, res) => {
    const r = await ownedReport(req, res);
    if (!r) return;
    page(res, 200, `SLA-rapport ${P.monthLabel(r.row.month)}`, P.reportPage(ctx(res), r.row, r.credit, { back: { href: `/workspaces/${r.ws.id}#rapporten`, label: r.ws.name }, downloads: `/workspaces/${r.ws.id}/reports/${r.row.month}` }));
  });
  app.get('/workspaces/:id/reports/:month/csv', async (req, res) => {
    const r = await ownedReport(req, res);
    if (r) sendCsv(res, `sla-${r.ws.slug}-${r.row.month}.csv`, reportCsv(r.row.data, r.credit));
  });
  app.get('/workspaces/:id/reports/:month/json', async (req, res) => {
    const r = await ownedReport(req, res);
    if (!r) return;
    res.setHeader('Content-Disposition', `attachment; filename="sla-${r.ws.slug}-${r.row.month}.json"`);
    res.json(reportJson(r.row, r.credit));
  });

  // ---------- alerts (owner) ----------
  async function renderAlerts(req: Request, res: Response, a: Account, secret: string | null, error?: string, status = 200) {
    page(res, status, 'Meldingen', P.alertsPage(ctx(res), await d.alerts.settings(a.id), await d.alerts.recent(a.id), secret, error), { flash: error ? null : flashOf(req) });
  }
  app.get('/account/alerts', async (req, res) => {
    const a = requireUser(req, res);
    if (a) await renderAlerts(req, res, a, null);
  });
  app.post('/account/alerts', async (req, res) => {
    const a = requireUser(req, res);
    if (!a) return;
    const b = req.body as Record<string, string>;
    try {
      const { secret } = await d.alerts.saveSettings(a.id, { email: b.email === '1', webhookUrl: String(b.webhook || '') }, ref(req, res));
      if (secret) return renderAlerts(req, res, a, secret);
      res.redirect(303, '/account/alerts?m=opgeslagen');
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      await renderAlerts(req, res, a, null, e.message, e.status);
    }
  });
  app.post('/account/alerts/secret', async (req, res) => {
    const a = requireUser(req, res);
    if (!a) return;
    try {
      await renderAlerts(req, res, a, await d.alerts.rotateSecret(a.id, ref(req, res)));
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      await renderAlerts(req, res, a, null, e.message, e.status);
    }
  });
  app.post('/account/alerts/test', async (req, res) => {
    const a = requireUser(req, res);
    if (!a) return;
    await d.alerts.deliver({ id: '', slug: 'test', name: 'Testmelding', owner_id: a.id }, 'test', { message: 'Je meldingen werken.' });
    res.redirect(303, '/account/alerts?m=test-verstuurd');
  });

  // ---------- operator ----------
  const loadIncidents = () => d.db.query<P.Incident>('SELECT * FROM incidents WHERE workspace_id IS NULL ORDER BY created_at DESC LIMIT 100');

  async function renderOperator(req: Request, res: Response, flash: Flash | null, status = 200) {
    const since = calendarDays(localDay(d.clock.now(), cfg.timeZone), 30)[0];
    const up = await d.db.query<{ workspace_id: string; checks: number; ok: number }>(
      'SELECT workspace_id, SUM(checks)::int AS checks, SUM(ok)::int AS ok FROM workspace_health_daily WHERE day >= $1 GROUP BY workspace_id',
      [since],
    );
    page(
      res,
      status,
      'Beheer',
      P.operatorPage(ctx(res), await d.workspaces.listAll(), await loadIncidents(), {
        plans: d.plans,
        mode: d.billing.mode,
        uptime30: new Map(up.map((u) => [u.workspace_id, u.checks ? (u.ok / u.checks) * 100 : null])),
        workspaceIncidents: await d.monitoring.openWorkspaceIncidents(),
        maintenance: await d.monitoring.upcoming('all', 60),
        noticeHours: cfg.maintenanceNoticeHours,
        nowLocal: toLocalInput(d.clock.now(), cfg.timeZone),
      }),
      { flash },
    );
  }

  app.get('/operator', async (req, res) => {
    if (!requireOperator(req, res)) return;
    await renderOperator(req, res, flashOf(req));
  });

  // Dedicated (CLD-05): register a customer-run instance; the setup token is shown once, in this response only.
  app.post('/operator/dedicated', async (req, res) => {
    if (!requireOperator(req, res)) return;
    const b = req.body as Record<string, string>;
    try {
      const owner = await d.accounts.byEmail(String(b.email || ''));
      if (!owner) throw new UserError('Geen account met dit e-mailadres. Laat de klant eerst een account maken op deze site.');
      const { ws, setupToken } = await d.workspaces.createDedicated(owner.id, { name: b.name, slug: b.slug, url: b.url }, ref(req, res, 'operator'));
      page(res, 200, 'Dedicated geregistreerd', P.dedicatedSecretsPage(ctx(res), ws, setupToken, planById(d.plans, ws.plan), false));
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      await renderOperator(req, res, { kind: 'error', text: e.message }, e.status);
    }
  });

  app.post('/operator/maintenance', async (req, res) => {
    if (!requireOperator(req, res)) return;
    const b = req.body as Record<string, string>;
    try {
      const m = await d.monitoring.announce(
        { title: b.title, body: b.body, startsAt: zonedTimeToUtc(b.starts, cfg.timeZone), endsAt: zonedTimeToUtc(b.ends, cfg.timeZone), workspaceId: b.workspace || null },
        ref(req, res, 'operator'),
      );
      res.redirect(303, `/operator?m=${m.excluded ? 'onderhoud-gepland' : 'onderhoud-kort'}`);
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      await renderOperator(req, res, { kind: 'error', text: e.message }, e.status);
    }
  });

  app.post('/operator/maintenance/:id/cancel', async (req, res) => {
    if (!requireOperator(req, res)) return;
    await d.monitoring.cancel(String(req.params.id), ref(req, res, 'operator'));
    res.redirect(303, '/operator?m=onderhoud-geannuleerd');
  });

  app.get('/operator/audit', async (req, res) => {
    if (!requireOperator(req, res)) return;
    page(res, 200, 'Auditlog', P.auditPage(ctx(res), await d.db.query('SELECT * FROM audit ORDER BY at DESC, id DESC LIMIT 200')));
  });

  const opWorkspace = async (req: Request, res: Response) => {
    if (!requireOperator(req, res)) return null;
    const ws = await d.workspaces.get(String(req.params.id || ''));
    if (!ws) {
      page(res, 404, 'Niet gevonden', P.messagePage('Niet gevonden', 'Deze workspace bestaat niet.', { href: '/operator', label: 'Naar beheer' }));
      return null;
    }
    return ws;
  };
  const opError = (res: Response, e: unknown) => {
    if (!(e instanceof UserError) && !(e instanceof ProvisionError)) throw e;
    page(res, 400, 'Beheer', P.messagePage('Dat lukte niet', (e as Error).message, { href: '/operator', label: 'Naar beheer' }));
  };

  // ---------- SLA reports and credits (operator) ----------
  async function opReport(req: Request, res: Response) {
    if (!requireOperator(req, res)) return null;
    const row = await d.reports.byId(String(req.params.id || ''));
    if (!row) {
      page(res, 404, 'Niet gevonden', P.messagePage('Rapport niet gevonden', 'Dit rapport bestaat niet.', { href: '/operator/reports', label: 'Naar de rapporten' }));
      return null;
    }
    return { row, credit: await d.reports.credit(row.id) };
  }
  const opMonth = (req: Request) => {
    const m = String(req.query.month || req.body?.month || '');
    return MONTH_RE.test(m) ? m : monthOf(d.clock.now(), cfg.timeZone, -1);
  };

  app.get('/operator/reports', async (req, res) => {
    if (!requireOperator(req, res)) return;
    const month = opMonth(req);
    const months = Array.from({ length: 13 }, (_, i) => monthOf(d.clock.now(), cfg.timeZone, -1 - i));
    page(res, 200, 'SLA-rapporten', P.operatorReportsPage(ctx(res), month, await d.reports.listMonth(month), months), { flash: flashOf(req) });
  });
  app.get('/operator/reports-export', async (req, res) => {
    if (!requireOperator(req, res)) return;
    const month = opMonth(req);
    sendCsv(res, `sla-${month}.csv`, reportsSummaryCsv(await d.reports.listMonth(month)));
  });
  app.post('/operator/reports/generate', async (req, res) => {
    if (!requireOperator(req, res)) return;
    const month = opMonth(req);
    await d.reports.generateDue(month, ref(req, res, 'operator'));
    res.redirect(303, `/operator/reports?month=${month}&m=rapporten-gemaakt`);
  });
  app.get('/operator/reports/:id', async (req, res) => {
    const r = await opReport(req, res);
    if (!r) return;
    page(res, 200, 'SLA-rapport', P.reportPage(ctx(res), r.row, r.credit, { back: { href: `/operator/reports?month=${r.row.month}`, label: 'SLA-rapporten' }, downloads: `/operator/reports/${r.row.id}`, operator: true }), { flash: flashOf(req) });
  });
  app.get('/operator/reports/:id/csv', async (req, res) => {
    const r = await opReport(req, res);
    if (r) sendCsv(res, `sla-${r.row.data.workspace.slug}-${r.row.month}-v${r.row.version}.csv`, reportCsv(r.row.data, r.credit));
  });
  app.get('/operator/reports/:id/json', async (req, res) => {
    const r = await opReport(req, res);
    if (r) res.json(reportJson(r.row, r.credit));
  });
  const reportAction = (fn: (req: Request, res: Response, row: { id: string; workspace_id: string; month: string }) => Promise<string>) => async (req: Request, res: Response) => {
    const r = await opReport(req, res);
    if (!r) return;
    try {
      res.redirect(303, await fn(req, res, r.row));
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      page(res, e.status, 'SLA-rapport', P.reportPage(ctx(res), r.row, await d.reports.credit(r.row.id), { back: { href: `/operator/reports?month=${r.row.month}`, label: 'SLA-rapporten' }, downloads: `/operator/reports/${r.row.id}`, operator: true }), {
        flash: { kind: 'error', text: e.message },
      });
    }
  };
  app.post(
    '/operator/reports/:id/regenerate',
    reportAction(async (req, res, row) => {
      const next = await d.reports.generate(row.workspace_id, row.month, ref(req, res, 'operator'), String((req.body as any).reason || ''));
      return `/operator/reports/${next.id}?m=rapport-gemaakt`;
    }),
  );
  app.post(
    '/operator/reports/:id/credit/approve',
    reportAction(async (req, res, row) => {
      await d.reports.approveCredit(row.id, ref(req, res, 'operator'));
      return `/operator/reports/${row.id}?m=credit-goedgekeurd`;
    }),
  );
  app.post(
    '/operator/reports/:id/credit/reject',
    reportAction(async (req, res, row) => {
      await d.reports.rejectCredit(row.id, String((req.body as any).note || ''), ref(req, res, 'operator'));
      return `/operator/reports/${row.id}?m=credit-afgewezen`;
    }),
  );
  app.post(
    '/operator/reports/:id/credit/settle',
    reportAction(async (req, res, row) => {
      await d.reports.settleCredit(row.id, ref(req, res, 'operator'));
      return `/operator/reports/${row.id}?m=credit-verrekend`;
    }),
  );

  app.get('/operator/workspaces/:id', async (req, res) => {
    const ws = await opWorkspace(req, res);
    if (!ws) return;
    const row = (await d.workspaces.listAll()).find((r) => r.id === ws.id)!;
    page(res, 200, ws.name, P.operatorWorkspacePage(ctx(res), row, await availability(ws), planById(d.plans, ws.plan)), { flash: flashOf(req) });
  });

  app.post('/operator/workspaces/:id/url', async (req, res) => {
    const ws = await opWorkspace(req, res);
    if (!ws) return;
    try {
      await d.workspaces.setExternalUrl(ws.id, String((req.body as any).url || ''), ref(req, res, 'operator'));
      res.redirect(303, `/operator/workspaces/${ws.id}?m=opgeslagen`);
    } catch (e) {
      opError(res, e);
    }
  });

  app.post('/operator/workspaces/:id/setup-token', async (req, res) => {
    const ws = await opWorkspace(req, res);
    if (!ws) return;
    try {
      const token = await d.workspaces.rotateSetupToken(ws.id, ref(req, res, 'operator'));
      page(res, 200, 'Nieuwe setup-token', P.dedicatedSecretsPage(ctx(res), ws, token, planById(d.plans, ws.plan), true));
    } catch (e) {
      opError(res, e);
    }
  });

  app.post('/operator/workspaces/:id/suspend', async (req, res) => {
    const ws = await opWorkspace(req, res);
    if (!ws) return;
    await d.workspaces.suspend(ws.id, 'operator', ref(req, res, 'operator'));
    res.redirect(303, '/operator?m=opgeslagen');
  });

  app.post('/operator/workspaces/:id/resume', async (req, res) => {
    const ws = await opWorkspace(req, res);
    if (!ws) return;
    try {
      await d.workspaces.resume(ws.id, ref(req, res, 'operator'));
      // Billing still applies: an unpaid workspace is paused again right away (with its billing reason).
      await d.billing.enforce(ws.id);
      res.redirect(303, '/operator?m=opgeslagen');
    } catch (e) {
      opError(res, e);
    }
  });

  app.post('/operator/workspaces/:id/billing', async (req, res) => {
    const ws = await opWorkspace(req, res);
    if (!ws) return;
    const b = req.body as Record<string, string>;
    try {
      await d.billing.manualSet(ws.id, { plan: b.plan, status: b.status }, ref(req, res, 'operator'));
      res.redirect(303, '/operator?m=opgeslagen');
    } catch (e) {
      opError(res, e);
    }
  });

  app.post('/operator/incidents', async (req, res) => {
    const a = requireOperator(req, res);
    if (!a) return;
    const b = req.body as Record<string, string>;
    const title = String(b.title || '').trim().slice(0, 120);
    if (!title) return page(res, 400, 'Beheer', P.messagePage('Titel ontbreekt', 'Geef de storing een titel.', { href: '/operator', label: 'Terug' }));
    const now = d.clock.now().toISOString();
    const id = newId('inc_');
    await d.db.query("INSERT INTO incidents (id, title, body, impact, status, created_by, created_at, updated_at) VALUES ($1, $2, $3, $4, 'open', $5, $6, $6)", [
      id,
      title,
      String(b.body || '').slice(0, 2000),
      b.impact === 'major' ? 'major' : 'minor',
      a.id,
      now,
    ]);
    await audit(d.db, d.clock, { ...ref(req, res, 'operator'), kind: 'incident.opened', data: { id, title } });
    res.redirect(303, '/operator?m=storing-gemeld');
  });

  app.post('/operator/incidents/:id/update', async (req, res) => {
    if (!requireOperator(req, res)) return;
    const text = String((req.body as any).text || '').trim().slice(0, 1000);
    const now = d.clock.now().toISOString();
    if (text) await d.db.query("UPDATE incidents SET updates = updates || $2::jsonb, updated_at = $3 WHERE id = $1 AND status = 'open'", [String(req.params.id), JSON.stringify([{ at: now, text }]), now]);
    await audit(d.db, d.clock, { ...ref(req, res, 'operator'), kind: 'incident.updated', data: { id: String(req.params.id) } });
    res.redirect(303, '/operator?m=opgeslagen');
  });

  app.post('/operator/incidents/:id/resolve', async (req, res) => {
    if (!requireOperator(req, res)) return;
    const now = d.clock.now().toISOString();
    await d.db.query("UPDATE incidents SET status = 'resolved', resolved_at = $2, updated_at = $2 WHERE id = $1", [String(req.params.id), now]);
    await audit(d.db, d.clock, { ...ref(req, res, 'operator'), kind: 'incident.resolved', data: { id: String(req.params.id) } });
    res.redirect(303, '/operator?m=opgeslagen');
  });

  // ---------- public status ----------
  async function statusData(): Promise<P.StatusData> {
    const now = d.clock.now();
    const c = (
      await d.db.query<P.StatusData['counts'] & { ded_healthy: number; ded_unhealthy: number }>(
        `SELECT COUNT(*) FILTER (WHERE deployment = 'shared' AND status = 'active' AND health = 'healthy')::int AS healthy,
                COUNT(*) FILTER (WHERE deployment = 'shared' AND status = 'active' AND health <> 'healthy')::int AS unhealthy,
                COUNT(*) FILTER (WHERE deployment = 'shared' AND status = 'suspended')::int AS suspended,
                COUNT(*) FILTER (WHERE deployment = 'shared' AND status = 'provisioning')::int AS provisioning,
                COUNT(*) FILTER (WHERE deployment = 'dedicated' AND status = 'active' AND health = 'healthy')::int AS ded_healthy,
                COUNT(*) FILTER (WHERE deployment = 'dedicated' AND status = 'active' AND health = 'unhealthy')::int AS ded_unhealthy
         FROM workspaces`,
      )
    )[0];
    const dayList = calendarDays(localDay(now, cfg.timeZone), 30);
    const sinceDay = dayList[0];
    // Public: platform incidents only. Incidents of one workspace stay with its owner and the operator.
    const incidents = await d.db.query<P.Incident>('SELECT * FROM incidents WHERE workspace_id IS NULL AND (status = $1 OR created_at >= $2) ORDER BY created_at DESC', [
      'open',
      zonedTimeToUtc(`${sinceDay}T00:00`, cfg.timeZone)!.toISOString(),
    ]);
    const daily = new Map((await d.db.query<{ day: string; checks: number; ok: number }>('SELECT day, checks, ok FROM health_daily WHERE day >= $1', [sinceDay])).map((r) => [r.day, r]));
    const days: P.StatusData['days'] = [];
    let checks = 0;
    let ok = 0;
    for (const day of dayList) {
      const h = daily.get(day);
      if (h) (checks += h.checks), (ok += h.ok);
      days.push({ day, pct: h && h.checks > 0 ? (h.ok / h.checks) * 100 : null, incidents: incidents.filter((x) => localDay(new Date(x.created_at), cfg.timeZone) === day).length });
    }
    const open = incidents.filter((i) => i.status === 'open');
    const maintenance = await d.monitoring.upcoming('public', 14);
    const counts = { healthy: c.healthy, unhealthy: c.unhealthy, suspended: c.suspended, provisioning: c.provisioning };
    const active = c.healthy + c.unhealthy;
    const overall: P.StatusData['overall'] = open.some((i) => i.impact === 'major')
      ? 'major'
      : open.length || (active > 0 && c.unhealthy / active >= 0.1)
        ? 'minor'
        : maintenance.some((m) => new Date(m.starts_at) <= now)
          ? 'maintenance'
          : 'ok';
    return {
      overall,
      counts,
      dedicated: { healthy: c.ded_healthy, unhealthy: c.ded_unhealthy },
      open,
      recent: incidents.filter((i) => i.status === 'resolved'),
      maintenance,
      days,
      uptime30: checks ? (ok / checks) * 100 : null,
    };
  }

  app.get('/status', async (_req, res) => {
    page(res, 200, 'Status', P.statusPage(ctx(res), await statusData(), d.clock.now()));
  });

  app.get('/status.json', async (_req, res) => {
    const s = await statusData();
    res.json({
      overall: s.overall,
      workspaces: s.counts,
      dedicated: s.dedicated,
      uptime30: s.uptime30,
      incidents: s.open.map((i) => ({ title: i.title, impact: i.impact, since: i.created_at, updates: i.updates })),
      maintenance: s.maintenance.map((m) => ({ title: m.title, starts: m.starts_at, ends: m.ends_at, counts: !m.excluded })),
    });
  });

  // ---------- fallbacks ----------
  app.use((_req, res) => page(res, 404, 'Niet gevonden', P.messagePage('Deze pagina bestaat niet', 'Controleer het adres.', { href: '/', label: 'Naar de startpagina' })));

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err?.type === 'entity.too.large') return page(res, 413, 'Te groot', P.messagePage('Te veel gegevens', 'Dit formulier is te groot.'));
    if (err instanceof UserError) return page(res, err.status, 'Dat lukte niet', P.messagePage('Dat lukte niet', err.message, { href: '/dashboard', label: 'Naar je dashboard' }));
    d.log.error('fout in de control plane', err);
    if (!res.headersSent) page(res, 500, 'Er ging iets mis', P.messagePage('Er ging iets mis', 'Probeer het zo opnieuw. Blijft dit gebeuren, kijk dan op de statuspagina.', { href: '/status', label: 'Status' }));
  });

  return app;
}

