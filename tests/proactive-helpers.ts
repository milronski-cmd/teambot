// Shared set-up for the proactive tests: every module, the routines engine on a clock the test moves, and a fake
// website the site check fetches (no network).
import { startTestApp, mockAdapter, type MockStep, type TestApp } from './helpers.js';
import { modules as allModules } from '../server/modules/index.js';
import { createRoutinesModule } from '../server/modules/routines/index.js';
import type { RoutineEngine } from '../server/modules/routines/engine.js';
import type { DutyService } from '../server/modules/routines/duties/service.js';
import type { FetchResult } from '../server/modules/routines/triggers.js';
import type { ChatRequest } from '../server/core/types.js';

export const TZ = 'Europe/Amsterdam';

/** A small website: path → page. Tests change it to seed or fix a problem. */
export interface FakeSite {
  pages: Record<string, { status?: number; body?: string; robots?: string }>;
  hits: string[];
}

export const page = (o: { title?: string; description?: string; noindex?: boolean } = {}) =>
  `<html><head>${o.title === '' ? '' : `<title>${o.title ?? 'Kozijnen vergelijken'}</title>`}${o.description === '' ? '' : `<meta name="description" content="${o.description ?? 'Vergelijk kozijnen'}">`}${o.noindex ? '<meta name="robots" content="noindex, follow">' : ''}</head><body>ok</body></html>`;

export function healthySite(origin = 'https://raamwinkel.test'): FakeSite {
  return {
    hits: [],
    pages: {
      [`${origin}`]: { body: page() },
      [`${origin}/robots.txt`]: { body: `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml` },
      [`${origin}/sitemap.xml`]: { body: `<urlset><url><loc>${origin}/</loc></url><url><loc>${origin}/prijzen</loc></url><url><loc>${origin}/over</loc></url></urlset>` },
      [`${origin}/prijzen`]: { body: page({ title: 'Prijzen' }) },
      [`${origin}/over`]: { body: page({ title: 'Over ons' }) },
    },
  };
}

export interface Env {
  t: TestApp;
  engine: RoutineEngine;
  duties: DutyService;
  clock: { now: number };
  userId: string;
  site: FakeSite;
  events: any[];
  notes(): any[];
  /** A second engine that is free (billing 'free'), with its own script and requests. */
  free: { id: string; script: MockStep[]; requests: ChatRequest[] } | null;
  /** Move the clock to this local time today (or the next day when it has passed) and let the planner work. */
  at(isoUtc: string): Promise<void>;
  taken(teamId?: string | null): Promise<any[]>;
  runs(routineId: string): any[];
  duty(agentId: string, key: string): any;
}

export async function setup(o: { start?: string; free?: boolean } = {}): Promise<Env> {
  const clock = { now: Date.parse(o.start || '2026-11-09T04:00:00Z') };
  const site = healthySite();
  const fetcher = async (url: string): Promise<FetchResult> => {
    const key = url.replace(/\/$/, '');
    site.hits.push(key);
    const p = site.pages[key];
    if (!p) return { status: 404, url, contentType: 'text/html', text: 'Not found' };
    return { status: p.status ?? 200, url, contentType: 'text/html', text: p.body ?? '', robots: p.robots };
  };
  const t = await startTestApp({ modules: allModules.map((m) => (m.id === 'routines' ? createRoutinesModule({ clock: () => clock.now, tickMs: 0, fetcher }) : m)) });
  // With the specialists module, but it never reaches the network here, and a bot is not made a specialist by itself
  // (`settings.specialist: false`, the module's own switch): its learning rounds would call the model on their own.
  t.app.ctx.services.specialists?.setOptions?.({ hostDelayMs: 0, fetch: async () => { throw new Error('geen netwerk in tests'); }, search: async () => [] });
  const makeAgent = t.agent;
  t.agent = (data: any = {}) => makeAgent({ ...data, settings: { specialist: false, ...(data.settings || {}) } });
  const ctx = t.app.ctx;
  const engine: RoutineEngine = ctx.services.routines.engine;
  const duties: DutyService = ctx.services.routines.duties;
  const userId = ctx.store.one<{ id: string }>('SELECT id FROM users LIMIT 1')!.id;
  ctx.store.setSetting(userId, 'timezone', TZ);
  const events: any[] = [];
  ctx.events.subscribe((e: any) => events.push(e));
  let free: Env['free'] = null;
  if (o.free) {
    const script: MockStep[] = [];
    const requests: ChatRequest[] = [];
    ctx.providers.registerKind({ id: 'mockfree', label: 'Gratis', type: 'api', needsKey: false, description: 'test', models: ['free-1'], defaultModel: 'free-1', billing: 'free', create: () => mockAdapter(script, requests) } as any);
    const p = await t.api('POST', '/providers', { kind: 'mockfree' });
    free = { id: p.id, script, requests };
  }
  const env: Env = {
    t,
    engine,
    duties,
    clock,
    userId,
    site,
    events,
    free,
    notes: () => events.filter((e) => e.type === 'notification').map((e) => e.data),
    async at(isoUtc) {
      // Walk there minute by minute, like a pc that stays on: every duty in between runs at its own time.
      const target = Date.parse(isoUtc);
      const step = async () => {
        engine.tick();
        await engine.idle();
      };
      while (clock.now + 60_000 <= target) {
        clock.now += 60_000;
        await step();
      }
      clock.now = target;
      await step();
      // A run that finished frees its routine for the next pending one.
      await step();
    },
    taken: (teamId) => ctx.services.teamdata.rows(userId, 'SELECT * FROM taken ORDER BY id', [], true, teamId),
    runs: (routineId) => ctx.store.all<any>('SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY created_at, rowid', routineId).map((r) => ctx.store.decode('routine_runs', r)),
    duty: (agentId, key) => duties.duties(userId, agentId).find((r) => r.options.duty!.key === key),
  };
  return env;
}

/** A team with a website: PATCH the (first or given) team's profile. */
export async function teamWithSite(env: Env, teamId?: string, sites = ['https://raamwinkel.test']) {
  const teams = await env.t.api('GET', '/teams');
  const id = teamId || teams[0].id;
  return env.t.api('PATCH', `/teams/${id}`, { profile: { sites } });
}
