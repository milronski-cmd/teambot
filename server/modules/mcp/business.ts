import type { Ctx } from '../../core/types.js';
import { ah, user } from '../../core/http.js';
import type { ConnectionRow } from './db.js';
import type { McpManager } from './runtime.js';
import { googleConns } from './google.js';
import { bankConn } from './bank.js';

/**
 * The business on the dashboard (24 Nov 2026, the owner: "het dashboard … altijd actueel en mooie grafieken, duidelijke
 * onderscheiding"): revenue (Stripe), advertising (Google Ads), visitors (Analytics), search (Search Console) and money
 * (bank), per day over a period, with the period before it to compare. Read through the same tools the bots use (the
 * connections under Apps), only reading tools. Kept per user for REFRESH_MS and refreshed in the background while
 * TeamBot runs, so the dashboard opens at once and is never older than that.
 */

export interface Point {
  d: string; // YYYY-MM-DD
  v: number;
}
export interface Series {
  key: string;
  label: string;
  unit: 'eur' | 'count' | 'pct';
  now: Point[];
  before: Point[];
  total: number;
  totalBefore: number;
}
export interface Part {
  id: 'omzet' | 'ads' | 'bezoekers' | 'zoeken' | 'bank';
  state: 'ok' | 'off' | 'error';
  /** Why a part shows nothing, in the owner's words, and where to fix it. */
  note?: string;
  href?: string;
  series: Series[];
  /** Extra rows under a part: the sites, the ad accounts, the accounts. */
  rows?: { label: string; value: number; before?: number; unit: Series['unit'] }[];
  extra?: Record<string, number | string>;
}
export interface Business {
  days: number;
  from: string;
  to: string;
  at: string;
  parts: Part[];
}

const REFRESH_MS = 30 * 60_000;
const cache = new Map<string, { at: number; days: number; data: Business; running?: Promise<Business> }>();

const iso = (d: Date) => d.toISOString().slice(0, 10);
function addDays(day: string, n: number) {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}
function daysOf(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
/** A full row of days (missing days are 0) from a map day → value. */
function line(days: string[], m: Map<string, number>): Point[] {
  return days.map((d) => ({ d, v: Math.round((m.get(d) || 0) * 100) / 100 }));
}
const add = (m: Map<string, number>, d: string, v: number) => m.set(d, (m.get(d) || 0) + (Number.isFinite(v) ? v : 0));
const sum = (p: Point[]) => Math.round(p.reduce((s, x) => s + x.v, 0) * 100) / 100;

export function businessRanges(days: number, today = new Date()) {
  const to = iso(today);
  const from = addDays(to, -(days - 1));
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(days - 1));
  return { from, to, prevFrom, prevTo, now: daysOf(from, to), before: daysOf(prevFrom, prevTo) };
}

/** Make a series of the period and the one before it, out of one map over both. */
export function seriesOf(key: string, label: string, unit: Series['unit'], m: Map<string, number>, r: ReturnType<typeof businessRanges>): Series {
  const now = line(r.now, m);
  const before = line(r.before, m);
  return { key, label, unit, now, before, total: sum(now), totalBefore: sum(before) };
}

export function registerBusiness(ctx: Ctx, mgr: McpManager) {
  async function tool(c: ConnectionRow, name: string, args: any): Promise<any> {
    const res: any = await mgr.use(c, (cl) => cl.callTool({ name, arguments: args }, { timeout: 90_000 }));
    const text = (res?.content || []).map((x: any) => x?.text || '').join('');
    if (res?.isError) throw new Error(text.slice(0, 400) || 'fout');
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  const conns = (userId: string) => ctx.store.find<ConnectionRow>('mcp_connections', { user_id: userId }).filter((c) => c.enabled);
  /** Run a few at a time: Google and the bank allow some, not dozens at once. */
  async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
    const q = [...items];
    await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => {
      while (q.length) await fn(q.shift()!).catch(() => {});
    }));
  }

  async function omzet(userId: string, r: ReturnType<typeof businessRanges>): Promise<Part> {
    const c = conns(userId).find((x) => /stripe/i.test(x.catalog_id || '') || /stripe/i.test(x.name));
    if (!c) return { id: 'omzet', state: 'off', note: 'Koppel Stripe onder Apps om je omzet te zien.', href: '#/m/mcp/', series: [] };
    try {
      const acc = await tool(c, 'list_available_accounts_or_orgs', {});
      const ctxId = acc?.accounts?.find((a: any) => a.livemode)?.stripe_context || acc?.accounts?.[0]?.stripe_context;
      if (!ctxId) throw new Error('geen Stripe-account gevonden');
      const gross = new Map<string, number>();
      const orders = new Map<string, number>();
      const since = Math.floor(new Date(r.prevFrom + 'T00:00:00Z').getTime() / 1000);
      let after: string | undefined;
      for (let page = 0; page < 30; page++) {
        const res = await tool(c, 'stripe_api_read', {
          stripe_api_operation_id: 'GetCharges',
          parameters: { limit: 100, 'created[gte]': since, ...(after ? { starting_after: after } : {}) },
          stripe_context: ctxId,
          livemode: true,
        });
        const data: any[] = res?.data || [];
        for (const ch of data) {
          if (!ch.paid || ch.status !== 'succeeded') continue;
          const d = iso(new Date(ch.created * 1000));
          const cur = String(ch.currency || 'eur').toLowerCase();
          if (cur !== 'eur') continue;
          add(gross, d, (ch.amount - (ch.amount_refunded || 0)) / 100);
          add(orders, d, 1);
        }
        if (!res?.has_more || !data.length) break;
        after = data[data.length - 1].id;
      }
      return { id: 'omzet', state: 'ok', series: [seriesOf('omzet', 'Omzet', 'eur', gross, r), seriesOf('orders', 'Betalingen', 'count', orders, r)] };
    } catch (e: any) {
      return { id: 'omzet', state: 'error', note: `Stripe gaf geen cijfers: ${String(e?.message || e).slice(0, 200)}`, href: '#/m/mcp/', series: [] };
    }
  }

  async function ads(userId: string, r: ReturnType<typeof businessRanges>): Promise<Part> {
    const gs = googleConns(ctx, userId).filter((c) => c.enabled);
    if (!gs.length) return { id: 'ads', state: 'off', note: 'Koppel Google onder Apps om je advertenties te zien.', href: '#/m/mcp/', series: [] };
    const cost = new Map<string, number>();
    const clicks = new Map<string, number>();
    const conv = new Map<string, number>();
    const rows: Part['rows'] = [];
    let lastError = '';
    let anyOk = false;
    const seen = new Set<string>();
    for (const g of gs) {
      let ids: string[] = [];
      try {
        const res = await tool(g, 'ads_customers', {});
        ids = (res?.resourceNames || []).map((x: string) => x.split('/')[1]).filter((x: string) => x && !seen.has(x));
      } catch (e: any) {
        lastError = String(e?.message || e);
        continue;
      }
      ids.forEach((x) => seen.add(x));
      await pool(ids, 3, async (id) => {
        try {
          const q = `SELECT customer.descriptive_name, customer.manager, segments.date, metrics.cost_micros, metrics.clicks, metrics.conversions FROM customer WHERE segments.date BETWEEN '${r.prevFrom}' AND '${r.to}'`;
          let token: string | undefined;
          let name = id;
          let mine = 0;
          let mineBefore = 0;
          for (let page = 0; page < 10; page++) {
            const res = await tool(g, 'ads_query', { customer: id, query: q, ...(token ? { pageToken: token } : {}) });
            const list: any[] = res?.results || (Array.isArray(res) ? res.flatMap((b: any) => b.results || []) : []);
            for (const x of list) {
              if (x.customer?.manager) continue;
              name = x.customer?.descriptiveName || name;
              const d = x.segments?.date;
              const eur = Number(x.metrics?.costMicros || 0) / 1e6;
              add(cost, d, eur);
              add(clicks, d, Number(x.metrics?.clicks || 0));
              add(conv, d, Number(x.metrics?.conversions || 0));
              if (d >= r.from) mine += eur;
              else mineBefore += eur;
            }
            token = res?.nextPageToken;
            if (!token) break;
          }
          anyOk = true;
          if (mine || mineBefore) rows.push({ label: name, value: Math.round(mine * 100) / 100, before: Math.round(mineBefore * 100) / 100, unit: 'eur' });
        } catch (e: any) {
          lastError = String(e?.message || e);
        }
      });
    }
    if (!anyOk) {
      const token = /test accounts|developer token|developer-token/i.test(lastError);
      return {
        id: 'ads',
        state: 'error',
        note: token ? 'Google Ads geeft alleen cijfers met je developer token. Vul die in onder Apps › Google › Google Ads.' : `Google Ads gaf geen cijfers: ${lastError.slice(0, 200)}`,
        href: '#/m/mcp/',
        series: [],
      };
    }
    rows.sort((a, b) => b.value - a.value);
    return { id: 'ads', state: 'ok', series: [seriesOf('kosten', 'Advertentiekosten', 'eur', cost, r), seriesOf('klikken', 'Klikken', 'count', clicks, r), seriesOf('conversies', 'Conversies', 'count', conv, r)], rows };
  }

  async function bezoekers(userId: string, r: ReturnType<typeof businessRanges>): Promise<Part> {
    const gs = googleConns(ctx, userId).filter((c) => c.enabled);
    if (!gs.length) return { id: 'bezoekers', state: 'off', note: 'Koppel Google onder Apps om je bezoekers te zien.', href: '#/m/mcp/', series: [] };
    const users = new Map<string, number>();
    const rows: Part['rows'] = [];
    const seen = new Set<string>();
    let lastError = '';
    let anyOk = false;
    for (const g of gs) {
      let props: { id: string; name: string }[] = [];
      try {
        const res = await tool(g, 'ga_properties', {});
        props = (res?.accountSummaries || []).flatMap((a: any) => (a.propertySummaries || []).map((p: any) => ({ id: String(p.property).split('/')[1], name: p.displayName })));
      } catch (e: any) {
        lastError = String(e?.message || e);
        continue;
      }
      props = props.filter((p) => p.id && !seen.has(p.id));
      props.forEach((p) => seen.add(p.id));
      await pool(props, 3, async (p) => {
        try {
          const res = await tool(g, 'ga_report', { property: p.id, metrics: ['activeUsers'], dimensions: ['date'], start: r.prevFrom, end: r.to, limit: 1000 });
          let mine = 0;
          let mineBefore = 0;
          for (const row of res?.rows || []) {
            const raw = String(row.dimensionValues?.[0]?.value || '');
            const d = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
            const v = Number(row.metricValues?.[0]?.value || 0);
            add(users, d, v);
            if (d >= r.from) mine += v;
            else mineBefore += v;
          }
          anyOk = true;
          if (mine || mineBefore) rows.push({ label: p.name, value: mine, before: mineBefore, unit: 'count' });
        } catch (e: any) {
          lastError = String(e?.message || e);
        }
      });
    }
    if (!anyOk) return { id: 'bezoekers', state: 'error', note: `Analytics gaf geen cijfers: ${lastError.slice(0, 200)}`, href: '#/m/mcp/', series: [] };
    rows.sort((a, b) => b.value - a.value);
    return { id: 'bezoekers', state: 'ok', series: [seriesOf('bezoekers', 'Bezoekers', 'count', users, r)], rows };
  }

  async function zoeken(userId: string, r: ReturnType<typeof businessRanges>): Promise<Part> {
    const gs = googleConns(ctx, userId).filter((c) => c.enabled);
    if (!gs.length) return { id: 'zoeken', state: 'off', note: 'Koppel Google onder Apps om te zien hoe je gevonden wordt.', href: '#/m/mcp/', series: [] };
    const clicks = new Map<string, number>();
    const shows = new Map<string, number>();
    const rows: Part['rows'] = [];
    const seen = new Set<string>();
    let lastError = '';
    let anyOk = false;
    for (const g of gs) {
      let sites: string[] = [];
      try {
        const res = await tool(g, 'gsc_sites', {});
        sites = (res?.siteEntry || []).filter((s: any) => s.permissionLevel !== 'siteUnverifiedUser').map((s: any) => s.siteUrl).filter((s: string) => !seen.has(s));
      } catch (e: any) {
        lastError = String(e?.message || e);
        continue;
      }
      sites.forEach((s) => seen.add(s));
      await pool(sites, 4, async (site) => {
        try {
          const res = await tool(g, 'gsc_search_analytics', { site, dimensions: ['date'], start: r.prevFrom, end: r.to, limit: 1000 });
          let mine = 0;
          let mineBefore = 0;
          for (const row of res?.rows || []) {
            const d = row.keys?.[0];
            add(clicks, d, Number(row.clicks || 0));
            add(shows, d, Number(row.impressions || 0));
            if (d >= r.from) mine += Number(row.clicks || 0);
            else mineBefore += Number(row.clicks || 0);
          }
          anyOk = true;
          if (mine || mineBefore) rows.push({ label: site.replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').replace(/\/$/, ''), value: mine, before: mineBefore, unit: 'count' });
        } catch (e: any) {
          lastError = String(e?.message || e);
        }
      });
    }
    if (!anyOk) return { id: 'zoeken', state: 'error', note: `Search Console gaf geen cijfers: ${lastError.slice(0, 200)}`, href: '#/m/mcp/', series: [] };
    rows.sort((a, b) => b.value - a.value);
    // Search Console is two or three days behind: the last days stay empty instead of looking like a drop.
    const behind = addDays(r.to, -3);
    const cut = (s: Series): Series => ({ ...s, now: s.now.filter((p) => p.d <= behind), total: sum(s.now.filter((p) => p.d <= behind)), totalBefore: sum(s.before.slice(0, s.now.filter((p) => p.d <= behind).length)) });
    return { id: 'zoeken', state: 'ok', series: [cut(seriesOf('klikken', 'Klikken uit Google', 'count', clicks, r)), cut(seriesOf('vertoningen', 'Vertoningen in Google', 'count', shows, r))], rows, extra: { tot: behind } };
  }

  async function bank(userId: string, r: ReturnType<typeof businessRanges>): Promise<Part> {
    const c = bankConn(ctx, userId);
    if (!c) return { id: 'bank', state: 'off', note: 'Koppel je bank onder Apps › Bank.', href: '#/m/mcp/', series: [] };
    try {
      const acc = await tool(c, 'bank_accounts', {});
      const accounts: any[] = (acc?.accounts || []).filter((a: any, i: number, all: any[]) => String(a.currency || 'EUR').toUpperCase() === 'EUR' && all.findIndex((x: any) => x.iban === a.iban) === i);
      const inn = new Map<string, number>();
      const out = new Map<string, number>();
      const rows: Part['rows'] = [];
      let balance = 0;
      const bal = await tool(c, 'bank_balances', {});
      const balList: any[] = bal?.accounts || bal?.balances || [];
      for (const a of accounts) {
        // One IBAN can hold several currencies (Revolut): the euro balance of this IBAN.
        const eur = balList.filter((x: any) => x.iban === a.iban).flatMap((x: any) => x.balances || []).find((x: any) => String(x.currency || '').toUpperCase() === 'EUR');
        const amount = Number(eur?.amount ?? 0);
        balance += amount;
        rows.push({ label: `${a.bank} ${String(a.iban || '').slice(-4)}`, value: Math.round(amount * 100) / 100, unit: 'eur' });
      }
      await pool(accounts, 2, async (a) => {
        const res = await tool(c, 'bank_transactions', { account: a.iban, from: r.prevFrom, to: r.to, limit: 1000 });
        for (const t of res?.transactions || res || []) {
          const d = String(t.date || t.booking_date || t.value_date || '').slice(0, 10);
          const v = Number(t.amount ?? 0);
          if (!d) continue;
          if (v >= 0) add(inn, d, v);
          else add(out, d, -v);
        }
      });
      return { id: 'bank', state: 'ok', series: [seriesOf('in', 'Ontvangen', 'eur', inn, r), seriesOf('uit', 'Uitgegeven', 'eur', out, r)], rows, extra: { saldo: Math.round(balance * 100) / 100 } };
    } catch (e: any) {
      return { id: 'bank', state: 'error', note: `De bank gaf geen cijfers: ${String(e?.message || e).slice(0, 200)}`, href: '#/m/mcp/', series: [] };
    }
  }

  async function gather(userId: string, days: number): Promise<Business> {
    const r = businessRanges(days);
    const parts = await Promise.all([omzet(userId, r), ads(userId, r), bezoekers(userId, r), zoeken(userId, r), bank(userId, r)].map((p, i) =>
      p.catch((e: any) => ({ id: (['omzet', 'ads', 'bezoekers', 'zoeken', 'bank'] as const)[i], state: 'error' as const, note: String(e?.message || e).slice(0, 200), series: [] })),
    ));
    return { days, from: r.from, to: r.to, at: new Date().toISOString(), parts };
  }

  function get(userId: string, days: number, force: boolean): Promise<Business> | Business {
    const key = `${userId}:${days}`;
    const hit = cache.get(key);
    if (hit?.running) return hit.data && !force ? hit.data : hit.running;
    if (hit && !force && Date.now() - hit.at < REFRESH_MS) return hit.data;
    const running = gather(userId, days)
      .then((data) => {
        cache.set(key, { at: Date.now(), days, data });
        ctx.events.emit(userId, 'dashboard.business', { days, at: data.at });
        return data;
      })
      .catch((e) => {
        const old = cache.get(key);
        if (old) cache.set(key, { ...old, running: undefined });
        else cache.delete(key);
        throw e;
      });
    cache.set(key, { at: hit?.at || 0, days, data: hit?.data as Business, running });
    // A stale copy answers at once; the fresh one follows as an event.
    return hit?.data && !force ? hit.data : running;
  }

  ctx.api.get(
    '/dashboard/business',
    ah(async (req) => {
      const u = user(req);
      const days = [7, 30, 90].includes(Number((req.query as any)?.days)) ? Number((req.query as any).days) : 30;
      return await get(u.id, days, (req.query as any)?.refresh === '1');
    }),
  );

  // Kept fresh in the background for whoever looked at it, so the dashboard is current when it opens.
  const timer = setInterval(() => {
    for (const [key, v] of cache) {
      if (Date.now() - v.at < REFRESH_MS || v.running) continue;
      const [userId] = key.split(':');
      Promise.resolve(get(userId, v.days, true)).catch((e) => ctx.log.warn('[dashboard] cijfers niet ververst', String(e?.message || e).slice(0, 200)));
    }
  }, 60_000);
  timer.unref?.();
}
