import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Agent, Ctx, Module, ToolDef, User } from '../../core/types.js';
import { ah, bad, forbidden, notFound, str, user } from '../../core/http.js';
import { newId, now } from '../../core/db.js';
import { agentRootList, resolveInRoots, resolveInWorkspace, isProtectedPath } from '../../tools/builtin/files.js';
import { interfaces } from '../mobile/reach.js';
import { SiteError, copySnapshot, fmtBytes, scanFolder, skippedText, type ScanResult } from './snapshot.js';
import { SitesServer, type Reach, type ServedSite } from './server.js';
import { nlCount } from '../../core/i18n.js';

/**
 * Websites: a bot publishes a folder from its work folder as a small static site with its own unguessable link,
 * served by TeamBot itself on a separate port — on this computer, the owner's network (LAN) or tailnet. Never the
 * public internet. Publishing always asks the owner (danger, also under "Volledige toegang"); the approval card
 * shows the folder, the number of files, the size and who can open it. The owner manages everything on #/m/sites
 * (open, copy link, stop, publish again with another reach or expiry, delete). Every action is audited.
 */

export interface SiteRow {
  id: string;
  user_id: string;
  agent_id: string | null;
  title: string;
  source: string;
  entry: string;
  token: string;
  reach: Reach;
  status: 'live' | 'stopped' | 'expired';
  version: string | null;
  files: number;
  bytes: number;
  skipped: number;
  expires_days: number;
  expires_at: string | null;
  published_at: string | null;
  views: number;
  last_view_at: string | null;
  created_at: string;
  updated_at: string;
}

const REACHES: Reach[] = ['local', 'lan', 'tailnet'];
export const REACH_LABEL: Record<Reach, string> = { local: 'Alleen deze computer', lan: 'Je netwerk', tailnet: 'Je tailnet' };
export const REACH_TEXT: Record<Reach, string> = {
  local: 'Alleen te openen op de computer waarop TeamBot draait.',
  lan: 'Iedereen op hetzelfde (wifi-)netwerk die de link heeft.',
  tailnet: 'Je eigen apparaten via Tailscale die de link hebben.',
};
const DEFAULT_PORT = 4760;
const MAX_DAYS = 365;

const cleanReach = (v: unknown): Reach => (REACHES.includes(v as Reach) ? (v as Reach) : 'local');
const cleanDays = (v: unknown): number => {
  const n = Math.round(Number(v) || 0);
  return n > 0 ? Math.min(MAX_DAYS, n) : 0;
};
const normPath = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const daysText = (d: number) => (d === 1 ? 'verloopt na 1 dag' : d ? `verloopt na ${d} dagen` : 'verloopt niet');

export function summarizePublish(a: any): string {
  const reach = cleanReach(a?.reach);
  const days = cleanDays(a?.expires_days);
  return `Website publiceren: ${str(a?.title, 80) || str(a?.path, 120) || 'werkmap'} · ${REACH_LABEL[reach].toLowerCase()} · ${daysText(days)}`;
}

export class SiteService {
  readonly http: SitesServer;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(private ctx: Ctx) {
    this.http = new SitesServer({
      lookup: (token) => this.served(token),
      onView: (s) => {
        try {
          ctx.store.exec('UPDATE sites SET views = views + 1, last_view_at = ? WHERE id = ?', now(), s.id);
        } catch {
          /* counting is best effort */
        }
      },
      log: ctx.log,
    });
  }

  private dir(id: string, version: string) {
    return path.join(this.ctx.config.dataDir, 'sites', id, version);
  }

  get(id: string): SiteRow | null {
    return this.ctx.store.get<SiteRow>('sites', id);
  }

  list(userId: string): SiteRow[] {
    return this.ctx.store.find<SiteRow>('sites', { user_id: userId }, { order: 'created_at DESC' });
  }

  private expired(s: SiteRow) {
    return !!s.expires_at && Date.parse(s.expires_at) <= Date.now();
  }

  private served(token: string): ServedSite | null {
    const s = this.ctx.store.one<SiteRow>('SELECT * FROM sites WHERE token = ?', token);
    if (!s) return null;
    const online = s.status === 'live' && !this.expired(s) && !!s.version;
    return { id: s.id, token: s.token, reach: cleanReach(s.reach), entry: s.entry, dir: online ? this.dir(s.id, s.version!) : null };
  }

  /** Port the site server uses (TEAMBOT_SITES_PORT, the one used before, or 4760). */
  private wantedPort(): { port: number; fixed: boolean } {
    const env = process.env.TEAMBOT_SITES_PORT;
    if (env !== undefined && env !== '' && !isNaN(Number(env))) return { port: Number(env), fixed: true };
    const saved = this.ctx.store.getSetting<number | null>('', 'sites.port', null);
    return { port: typeof saved === 'number' && saved > 0 ? saved : DEFAULT_PORT, fixed: false };
  }

  /** Listen only while something is online; on all interfaces only when a site wants the LAN or tailnet. */
  async sync() {
    const live = this.ctx.store.all<SiteRow>("SELECT * FROM sites WHERE status = 'live'").filter((s) => !this.expired(s));
    if (!live.length) return this.http.close();
    const host = process.env.TEAMBOT_SITES_HOST || (live.some((s) => s.reach !== 'local') ? '0.0.0.0' : '127.0.0.1');
    const want = this.wantedPort();
    try {
      const r = await this.http.listen(host, this.http.listening && this.http.host !== host ? this.http.port || want.port : want.port, !want.fixed);
      if (!want.fixed && r.port !== this.ctx.store.getSetting('', 'sites.port', null)) this.ctx.store.setSetting('', 'sites.port', r.port);
    } catch (e: any) {
      this.ctx.log.error('[sites] kan niet luisteren', e);
      throw new SiteError(e?.code === 'EADDRINUSE' ? `Poort ${want.port} is al in gebruik; zet TEAMBOT_SITES_PORT op een vrije poort.` : `De websiteserver kan niet starten: ${e?.message || e}`);
    }
  }

  port(): number {
    return this.http.port || this.wantedPort().port || DEFAULT_PORT;
  }

  /** Links for a site, best first ("Op je netwerk" before "Op deze computer"). */
  urls(s: Pick<SiteRow, 'token' | 'reach'>): { url: string; label: string }[] {
    const port = this.port();
    const at = (h: string) => `http://${h}:${port}/s/${s.token}/`;
    const nets = interfaces();
    const out: { url: string; label: string }[] = [];
    if (s.reach === 'lan') for (const a of nets.lan) out.push({ url: at(a.address), label: 'Op je netwerk' });
    if (s.reach === 'tailnet') for (const a of nets.tailscale) out.push({ url: at(a.address), label: 'Via Tailscale' });
    out.push({ url: at('127.0.0.1'), label: 'Op deze computer' });
    return out;
  }

  view(s: SiteRow) {
    const state = s.status === 'live' && this.expired(s) ? 'expired' : s.status;
    const agent = s.agent_id ? this.ctx.store.agent(s.agent_id) : null;
    const { token: _t, version: _v, ...rest } = s;
    return {
      ...rest,
      reach: cleanReach(s.reach),
      state,
      urls: state === 'live' ? this.urls(s) : [],
      reachLabel: REACH_LABEL[cleanReach(s.reach)],
      reachText: REACH_TEXT[cleanReach(s.reach)],
      agent: agent ? { id: agent.id, name: agent.name, avatar: agent.avatar } : null,
      sourceExists: fs.existsSync(s.source),
    };
  }

  info(u: User) {
    const nets = interfaces();
    return {
      port: this.port(),
      listening: this.http.listening,
      host: this.http.host || null,
      lan: nets.lan.map((a) => a.address),
      tailnet: nets.tailscale.map((a) => a.address),
      canPublish: this.canPublish(u),
      mode: this.ctx.config.mode,
    };
  }

  canPublish(u: User | null): boolean {
    return !!u && (this.ctx.config.mode !== 'server' || u.role !== 'member');
  }

  /** Can this reach work on this computer right now? */
  reachProblem(reach: Reach): string | null {
    const nets = interfaces();
    if (reach === 'tailnet' && !nets.tailscale.length) return 'Tailscale staat niet aan op deze computer. Kies "Alleen deze computer" of "Je netwerk", of zet Tailscale aan.';
    if (reach === 'lan' && !nets.lan.length) return 'Deze computer heeft nu geen adres op een thuis- of kantoornetwerk. Kies "Alleen deze computer".';
    return null;
  }

  sameFolder(userId: string, agentId: string | null, folder: string): SiteRow | null {
    const n = normPath(folder);
    return this.list(userId).find((s) => s.agent_id === agentId && normPath(s.source) === n) || null;
  }

  /** Copy `scan` into a fresh snapshot of `site` and drop older snapshots. */
  private snapshot(id: string, scan: ScanResult): { version: string; files: number; bytes: number } {
    const version = 'v' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
    try {
      return { version, ...copySnapshot(scan, this.dir(id, version)) };
    } catch (e) {
      fs.rmSync(this.dir(id, version), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      throw e;
    }
  }

  private dropOld(id: string, keep: string | null) {
    const base = path.join(this.ctx.config.dataDir, 'sites', id);
    if (!fs.existsSync(base)) return;
    for (const v of fs.readdirSync(base)) {
      if (v === keep) continue;
      try {
        fs.rmSync(path.join(base, v), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        /* a file may still be open; removed next time */
      }
    }
    if (!keep) {
      try {
        fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        /* ignore */
      }
    }
  }

  /** Publish (or update) a folder. `by` is who did it: the bot (after the owner's approval) or the owner. */
  async publish(o: { userId: string; agent: Agent | null; folder: string; title?: string; reach: Reach; expiresDays: number; existing?: SiteRow | null; by: 'bot' | 'owner' }): Promise<{ site: SiteRow; scan: ScanResult; updated: boolean }> {
    const problem = this.reachProblem(o.reach);
    if (problem) throw new SiteError(problem);
    const scan = scanFolder(o.folder);
    if (!scan.entry) throw new SiteError('Er staat geen index.html in deze map. Maak eerst een index.html (de startpagina van de site).');
    const existing = o.existing === undefined ? this.sameFolder(o.userId, o.agent?.id ?? null, o.folder) : o.existing;
    const id = existing?.id || newId('site_');
    const snap = this.snapshot(id, scan);
    const ts = now();
    const title = (str(o.title, 120).trim() || existing?.title || path.basename(o.folder) || 'Website').slice(0, 120);
    const row: SiteRow = {
      id,
      user_id: o.userId,
      agent_id: o.agent?.id ?? existing?.agent_id ?? null,
      title,
      source: o.folder,
      entry: scan.entry,
      token: existing?.token || crypto.randomBytes(24).toString('base64url'),
      reach: o.reach,
      status: 'live',
      version: snap.version,
      files: snap.files,
      bytes: snap.bytes,
      skipped: scan.skipped.length,
      expires_days: o.expiresDays,
      expires_at: o.expiresDays ? new Date(Date.now() + o.expiresDays * 86_400_000).toISOString() : null,
      published_at: ts,
      views: existing?.views ?? 0,
      last_view_at: existing?.last_view_at ?? null,
      created_at: existing?.created_at || ts,
      updated_at: ts,
    };
    if (existing) this.ctx.store.update('sites', id, row);
    else this.ctx.store.insert('sites', row);
    this.dropOld(id, snap.version);
    await this.sync();
    this.ctx.audit(o.userId, existing ? 'site.republish' : 'site.publish', { id, title, folder: o.folder, files: snap.files, bytes: snap.bytes, skipped: scan.skipped.length, reach: o.reach, expiresDays: o.expiresDays, by: o.by }, o.agent?.id ?? row.agent_id);
    this.ctx.events.emit(o.userId, 'sites.updated', { id });
    return { site: this.get(id)!, scan, updated: !!existing };
  }

  async stop(s: SiteRow, by: 'bot' | 'owner', status: 'stopped' | 'expired' = 'stopped') {
    this.ctx.store.update('sites', s.id, { status, version: null, updated_at: now() });
    this.dropOld(s.id, null);
    await this.sync().catch(() => {});
    this.ctx.audit(s.user_id, status === 'expired' ? 'site.expire' : 'site.unpublish', { id: s.id, title: s.title, by }, s.agent_id);
    this.ctx.events.emit(s.user_id, 'sites.updated', { id: s.id });
  }

  async remove(s: SiteRow) {
    this.ctx.store.remove('sites', s.id);
    this.dropOld(s.id, null);
    await this.sync().catch(() => {});
    this.ctx.audit(s.user_id, 'site.delete', { id: s.id, title: s.title }, s.agent_id);
    this.ctx.events.emit(s.user_id, 'sites.updated', { id: s.id });
  }

  /** Expired sites go offline and lose their snapshot (the row stays, so the owner can publish again). */
  async sweep() {
    for (const s of this.ctx.store.all<SiteRow>("SELECT * FROM sites WHERE status = 'live' AND expires_at IS NOT NULL")) if (this.expired(s)) await this.stop(s, 'owner', 'expired');
  }

  startSweeper() {
    this.sweepTimer = setInterval(() => this.sweep().catch((e) => this.ctx.log.warn('[sites] opruimen mislukt', e)), 60_000);
    this.sweepTimer.unref?.();
  }

  async shutdown() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    await this.http.close();
  }

  /** What an approval card shows: folder, files, size, entry, who can open it, and what would go wrong. */
  preview(agent: Agent, args: any) {
    const reach = cleanReach(args?.reach);
    const expiresDays = cleanDays(args?.expires_days);
    const base = { reach, reachLabel: REACH_LABEL[reach], reachText: REACH_TEXT[reach], expiresDays, title: str(args?.title, 120) };
    let folder = '';
    try {
      folder = resolveInWorkspace(agent, str(args?.path, 2000) || '.');
    } catch (e: any) {
      return { ...base, folder: str(args?.path, 2000), ok: false, problem: String(e?.message || e), files: 0, bytes: 0, skipped: 0, skippedText: '', entry: null, update: null };
    }
    const existing = this.sameFolder(agent.user_id, agent.id, folder);
    const update = existing ? { id: existing.id, title: existing.title, state: this.view(existing).state } : null;
    try {
      const scan = scanFolder(folder);
      const problem = !scan.entry ? 'Er staat geen index.html in deze map; publiceren zal mislukken.' : this.reachProblem(reach);
      return { ...base, folder, ok: !problem, problem, files: scan.files.length, bytes: scan.bytes, size: fmtBytes(scan.bytes), skipped: scan.skipped.length, skippedText: skippedText(scan.skipped), entry: scan.entry, update };
    } catch (e: any) {
      return { ...base, folder, ok: false, problem: String(e?.message || e), files: 0, bytes: 0, skipped: 0, skippedText: '', entry: null, update };
    }
  }
}

function botTools(svc: SiteService): ToolDef[] {
  const findSite = (t: { userId: string; agent: Agent }, ref: string): SiteRow | null => {
    const r = String(ref || '').trim();
    const mine = svc.list(t.userId).filter((s) => s.agent_id === t.agent.id);
    if (!r) return mine.find((s) => s.status === 'live') || null;
    const byId = mine.find((s) => s.id === r || r.includes(`/s/${s.token}`));
    if (byId) return byId;
    try {
      const folder = resolveInWorkspace(t.agent, r);
      return mine.find((s) => normPath(s.source) === normPath(folder)) || null;
    } catch {
      return mine.find((s) => s.title.toLowerCase() === r.toLowerCase()) || null;
    }
  };
  return [
    {
      name: 'site_publish',
      group: 'files',
      risk: 'danger',
      impact: 'external',
      description:
        'Publiceer een map uit je werkmap als kleine statische website (HTML, CSS, JavaScript, afbeeldingen) met een eigen, moeilijk te raden link. ' +
        'Bereik: "local" = alleen deze computer, "lan" = het eigen netwerk van de eigenaar, "tailnet" = zijn apparaten via Tailscale. Nooit het openbare internet. ' +
        'Vraagt altijd toestemming. De map moet een index.html hebben; verborgen bestanden en bestanden met geheimen gaan niet mee. ' +
        'De site draait afgeschermd: geen cookies of localStorage, geen formulieren naar andere sites, geen toegang tot TeamBot. ' +
        'Dezelfde map opnieuw publiceren werkt de bestaande site bij (zelfde link). Wat je daarna in de map verandert, komt pas online na opnieuw publiceren.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Map relatief aan je werkmap (standaard ".")' },
          title: { type: 'string', description: 'Naam van de site, zoals de eigenaar hem ziet' },
          reach: { type: 'string', enum: ['local', 'lan', 'tailnet'], description: 'Wie de site kan openen (standaard "local")' },
          expires_days: { type: 'number', description: 'Na hoeveel dagen de site offline gaat (0 = niet)' },
        },
        required: ['path'],
      },
      summarize: summarizePublish,
      async run(a, t) {
        const me = t.ctx.store.user(t.userId);
        if (!svc.canPublish(me)) return { text: 'Websites publiceren kan op deze server alleen de eigenaar of een beheerder.', isError: true };
        let folder: string;
        try {
          folder = resolveInWorkspace(t.agent, str(a.path, 2000) || '.');
        } catch (e: any) {
          return { text: String(e?.message || e), isError: true };
        }
        if (!t.approved) {
          // the access mode let this through without a person (e.g. "Volledige toegang" that may publish): publishing still asks
          const r = await t.ctx.broker
            .request({ userId: t.userId, agent: t.agent, thread: t.thread, run: t.run, kind: 'tool', tool: 'site_publish', input: a ?? {}, summary: summarizePublish(a), risk: 'danger', signal: t.signal })
            .catch(() => ({ approved: false }));
          if (!r.approved) return { text: 'De eigenaar heeft het publiceren niet goedgekeurd.', isError: true };
        }
        try {
          const reach = cleanReach(a.reach);
          const { site, scan, updated } = await svc.publish({ userId: t.userId, agent: t.agent, folder, title: a.title, reach, expiresDays: cleanDays(a.expires_days), by: 'bot' });
          const urls = svc.urls(site);
          const skipped = skippedText(scan.skipped);
          return [
            `${updated ? 'Bijgewerkt' : 'Gepubliceerd'}: “${site.title}” (${nlCount(site.files, 'bestand', 'bestanden')}, ${fmtBytes(site.bytes)}).`,
            `Link: ${urls[0].url}`,
            urls.length > 1 ? `Op de computer van de eigenaar zelf: ${urls[urls.length - 1].url}` : '',
            `Bereikbaar: ${REACH_TEXT[reach]} Niet op het openbare internet.`,
            `Verloopt: ${site.expires_days ? `over ${site.expires_days} ${site.expires_days === 1 ? 'dag' : 'dagen'}` : 'niet'}.`,
            skipped ? `Niet meegenomen: ${skipped}.` : '',
            'Geef de link aan de gebruiker. Wijzigingen in de map komen pas online na opnieuw publiceren.',
          ]
            .filter(Boolean)
            .join('\n');
        } catch (e: any) {
          return { text: e instanceof SiteError ? e.message : `Publiceren mislukt: ${e?.message || e}`, isError: true };
        }
      },
    },
    {
      name: 'site_list',
      group: 'files',
      risk: 'read',
      description: 'Toon de websites die jij gepubliceerd hebt, met status en link.',
      parameters: { type: 'object', properties: {} },
      summarize: () => 'Gepubliceerde websites bekijken',
      async run(_a, t) {
        const mine = svc.list(t.userId).filter((s) => s.agent_id === t.agent.id);
        if (!mine.length) return 'Je hebt nog geen websites gepubliceerd.';
        return mine
          .map((s) => {
            const v = svc.view(s);
            const state = v.state === 'live' ? 'online' : v.state === 'expired' ? 'verlopen' : 'gestopt';
            return `- “${s.title}” (${state}, ${REACH_LABEL[v.reach].toLowerCase()}) map: ${s.source}${v.urls[0] ? `\n  ${v.urls[0].url}` : ''}`;
          })
          .join('\n');
      },
    },
    {
      name: 'site_unpublish',
      group: 'files',
      risk: 'write',
      description: 'Haal een website die jij gepubliceerd hebt offline (de link werkt daarna niet meer). Geef de link, de map of de naam.',
      parameters: { type: 'object', properties: { site: { type: 'string', description: 'Link, map of naam van de site' } }, required: ['site'] },
      summarize: (a) => `Website offline halen: ${str(a.site, 120)}`,
      async run(a, t) {
        const s = findSite(t, str(a.site, 2000));
        if (!s) return { text: 'Geen website van jou gevonden met die link, map of naam. Gebruik site_list.', isError: true };
        if (s.status !== 'live') return `“${s.title}” is al offline.`;
        await svc.stop(s, 'bot');
        return `“${s.title}” is offline; de link werkt niet meer.`;
      },
    },
  ];
}

const mod: Module = {
  id: 'sites',
  label: 'Websites',
  migrations: [
    {
      id: 'sites-001',
      sql: `CREATE TABLE sites (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        agent_id TEXT,
        title TEXT NOT NULL,
        source TEXT NOT NULL,
        entry TEXT NOT NULL DEFAULT 'index.html',
        token TEXT NOT NULL UNIQUE,
        reach TEXT NOT NULL DEFAULT 'local',
        status TEXT NOT NULL DEFAULT 'live',
        version TEXT,
        files INTEGER NOT NULL DEFAULT 0,
        bytes INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0,
        expires_days INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT,
        published_at TEXT,
        views INTEGER NOT NULL DEFAULT 0,
        last_view_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX sites_user ON sites(user_id);`,
    },
  ],
  init(ctx) {
    const svc = new SiteService(ctx);
    ctx.services.sites = svc;
    for (const t of botTools(svc)) ctx.tools.register(t);

    const mine = (req: any): { me: User; s: SiteRow } => {
      const me = user(req);
      const s = svc.get(String(req.params.id));
      if (!s || s.user_id !== me.id) throw notFound('Site niet gevonden');
      return { me, s };
    };
    const fail = (e: any) => {
      if (e instanceof SiteError) throw bad(e.message);
      throw e;
    };

    ctx.api.get(
      '/sites',
      ah(async (req) => {
        const me = user(req);
        return { sites: svc.list(me.id).map((s) => svc.view(s)), info: svc.info(me) };
      }),
    );

    // What the approval card of site_publish shows (only for the owner of that approval).
    ctx.api.get(
      '/sites/preview/:approvalId',
      ah(async (req) => {
        const me = user(req);
        const a = ctx.store.get<any>('approvals', String(req.params.approvalId));
        if (!a || a.user_id !== me.id || a.tool !== 'site_publish') throw notFound('Verzoek niet gevonden');
        const agent = ctx.store.agent(a.agent_id);
        if (!agent || agent.user_id !== me.id) throw notFound('Bot niet gevonden');
        const p = svc.preview(agent, a.input || {});
        const urls = svc.urls({ token: 'voorbeeld'.padEnd(32, '0'), reach: p.reach }).map((u) => ({ label: u.label, host: new URL(u.url).host }));
        return { ...p, hosts: urls, canPublish: svc.canPublish(me), port: svc.port() };
      }),
    );

    // Publish again from the folder (owner): new snapshot, same link; optionally another reach or expiry.
    ctx.api.post(
      '/sites/:id/republish',
      ah(async (req) => {
        const { me, s } = mine(req);
        if (!svc.canPublish(me)) throw forbidden('Websites publiceren kan op deze server alleen de eigenaar of een beheerder.');
        const b = req.body || {};
        const agent = s.agent_id ? ctx.store.agent(s.agent_id) : null;
        let folder = s.source;
        try {
          // still inside that bot's folders (the owner may have taken a folder away from the bot since)
          folder = agent ? resolveInRoots(agentRootList(agent), s.source) : s.source;
          if (isProtectedPath(folder)) throw new SiteError('Deze map is beschermd.');
        } catch (e: any) {
          throw bad(e instanceof SiteError ? e.message : `De map hoort niet meer bij ${agent?.name || 'de bot'}: ${e?.message || e}`);
        }
        const reach = b.reach === undefined ? cleanReach(s.reach) : cleanReach(b.reach);
        const expiresDays = b.expires_days === undefined ? s.expires_days : cleanDays(b.expires_days);
        const r = await svc.publish({ userId: me.id, agent, folder, title: s.title, reach, expiresDays, existing: s, by: 'owner' }).catch(fail);
        return svc.view(r!.site);
      }),
    );

    ctx.api.post(
      '/sites/:id/stop',
      ah(async (req) => {
        const { s } = mine(req);
        if (s.status === 'live') await svc.stop(s, 'owner');
        return svc.view(svc.get(s.id)!);
      }),
    );

    ctx.api.delete(
      '/sites/:id',
      ah(async (req) => {
        const { s } = mine(req);
        await svc.remove(s);
        return { ok: true };
      }),
    );

    // A deleted bot's sites go offline (they stay listed so the owner sees what happened).
    ctx.hooks.agentDeleted.push(({ agentId, userId }) => {
      for (const s of svc.list(userId).filter((x) => x.agent_id === agentId && x.status === 'live')) svc.stop(s, 'owner').catch(() => {});
    });
  },
  async start(ctx) {
    const svc: SiteService = ctx.services.sites;
    await svc.sweep().catch(() => {});
    await svc.sync().catch((e) => ctx.log.warn('[sites] niet gestart', e?.message || e));
    svc.startSweeper();
  },
  async stop(ctx) {
    await (ctx.services.sites as SiteService | undefined)?.shutdown();
  },
};

export default mod;
