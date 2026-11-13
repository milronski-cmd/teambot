import type { Agent, Ctx, ToolDef } from '../../core/types.js';
import type { TeamData } from './service.js';
import { type ProjectService, text } from './projects.js';
import { PROJECT_GROUP as GROUP } from './tools.js';
import { words } from '../../../shared/i18n-core.js';

/**
 * Kansen (opportunities): a researcher spots what works now, the main bot gives each one a score card, the owner gets
 * the top 3 of the week under "Wacht op jou", and only his "ja" turns one into work (a mini-test in the project loop).
 *
 * Honest by construction, in code:
 *  - a kans is only stored with at least one source that has a web address and a date, and at least one source of the
 *    last RECENT_DAYS days ("waarom nu" needs something recent). No source → refused → never shown;
 *  - the score is computed here from five marks, not written by a model;
 *  - nothing a bot does moves a kans to work: `decide` is the owner's route.
 */

export const RECENT_DAYS = 90;
export const TOP_N = 3;
export const SCORE_FIELDS = ['vraag', 'past', 'moeite', 'kosten', 'risico'] as const;
export type ScoreField = (typeof SCORE_FIELDS)[number];
export const SCORE_LABEL: Record<ScoreField, string> = { vraag: 'Vraag in de markt', past: 'Past bij jou', moeite: 'Moeite', kosten: 'Kosten', risico: 'Risico' };
/** vraag and past count for (higher is better); moeite, kosten and risico count against (higher is worse). */
const WEIGHT: Record<ScoreField, number> = { vraag: 3, past: 3, moeite: 2, kosten: 1, risico: 2 };

export interface Source {
  url: string;
  titel: string;
  datum: string;
}

export interface KansView {
  id: number;
  teamId: string | null;
  teamName: string;
  titel: string;
  wat: string;
  waarom_nu: string;
  bronnen: Source[];
  kosten: string;
  risico: string;
  minitest: string;
  score: number | null;
  scorekaart: (Record<ScoreField, number> & { toelichting?: string }) | null;
  gevonden_door: string;
  status: 'nieuw' | 'gescoord' | 'voorgelegd' | 'ja' | 'nee' | 'later';
  voorgelegd: string | null;
  beslist: string | null;
  project_id: number | null;
  aangemaakt: string;
}

export class KansError extends Error {}


/** "2026-11-03", "3 nov 2026", "03-11-2026" → ISO date, or null. */
export function parseDate(raw: unknown): string | null {
  const s = String(raw ?? '').trim().toLowerCase();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  const MONTHS = ['jan', 'feb', 'mrt|maa|mar', 'apr', 'mei|may', 'jun', 'jul', 'aug', 'sep', 'okt|oct', 'nov', 'dec'];
  let y = 0;
  let mo = 0;
  let d = 0;
  if (m) [y, mo, d] = [+m[1], +m[2], +m[3]];
  else if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/))) [d, mo, y] = [+m[1], +m[2], +m[3]];
  else if ((m = s.match(/^(\d{1,2})\s+([a-z]{3})[a-z.]*\s+(\d{4})/))) {
    d = +m[1];
    y = +m[3];
    mo = MONTHS.findIndex((x) => new RegExp(`^(${x})`).test(m![2])) + 1;
  } else return null;
  if (!(y > 2000 && y < 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  const t = Date.UTC(y, mo - 1, d);
  return new Date(t).getUTCDate() === d ? new Date(t).toISOString().slice(0, 10) : null;
}

/** Sources as a bot gave them → the ones that count: a web address and a date that is not in the future. */
export function cleanSources(raw: unknown, now: number): Source[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: Source[] = [];
  for (const x of list.slice(0, 12)) {
    const url = text((x as any)?.url ?? (x as any)?.adres, 500);
    const datum = parseDate((x as any)?.datum ?? (x as any)?.date);
    if (!/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(url) || !datum) continue;
    if (Date.parse(datum) > now + 86_400_000) continue;
    if (out.some((s) => s.url === url)) continue;
    out.push({ url, titel: text((x as any)?.titel ?? (x as any)?.title, 200), datum });
  }
  return out;
}

/** 0–100 from five marks of 1–5. */
export function scoreOf(card: Record<ScoreField, number>): number {
  let got = 0;
  let max = 0;
  for (const f of SCORE_FIELDS) {
    const v = Math.min(5, Math.max(1, Math.round(Number(card[f]))));
    const good = f === 'vraag' || f === 'past' ? v : 6 - v;
    got += (good - 1) * WEIGHT[f];
    max += 4 * WEIGHT[f];
  }
  return Math.round((got / max) * 100);
}

export class KansService {
  /** Test seam. */
  clock = () => Date.now();

  constructor(
    private ctx: Ctx,
    private td: TeamData,
    private projects: ProjectService,
  ) {}

  private changed(userId: string, teamId: string | null) {
    this.ctx.events.emit(userId, 'teamdata.changed', { tables: ['kansen'], by: 'TeamBot', teamId });
  }

  view(teamId: string | null, r: any): KansView {
    const json = (v: any, d: any) => {
      try {
        return v ? JSON.parse(v) : d;
      } catch {
        return d;
      }
    };
    return {
      id: r.id,
      teamId,
      teamName: this.projects.teamName(teamId),
      titel: r.titel || '',
      wat: r.wat || '',
      waarom_nu: r.waarom_nu || '',
      bronnen: cleanSources(json(r.bronnen, []), Infinity),
      kosten: r.kosten || '',
      risico: r.risico || '',
      minitest: r.minitest || '',
      score: r.score ?? null,
      scorekaart: json(r.scorekaart, null),
      gevonden_door: r.gevonden_door || '',
      status: r.status,
      voorgelegd: r.voorgelegd || null,
      beslist: r.beslist || null,
      project_id: r.project_id ?? null,
      aangemaakt: r.aangemaakt || '',
    };
  }

  /** The board: every kans of one team or of all teams. A row without a valid source is never shown. */
  async list(userId: string, teamId?: string | null): Promise<KansView[]> {
    const out: KansView[] = [];
    for (const tid of teamId ? [teamId] : this.projects.teamIds(userId)) {
      const rows = await this.td.rows(userId, 'SELECT * FROM kansen ORDER BY id DESC LIMIT 300', [], true, tid);
      for (const r of rows) {
        const v = this.view(tid, r);
        if (v.bronnen.length) out.push(v);
      }
    }
    return out;
  }

  async get(userId: string, teamId: string | null, id: number): Promise<KansView | null> {
    const r = (await this.td.rows(userId, 'SELECT * FROM kansen WHERE id = ?', [id], true, teamId))[0];
    return r ? this.view(teamId, r) : null;
  }

  /** A researcher reports a kans. Refused without a dated source, a recent source, a mini-test, cost and risk. */
  async report(userId: string, teamId: string | null, who: string, d: any): Promise<KansView> {
    const now = this.clock();
    const titel = text(d?.titel, 160);
    const wat = text(d?.wat, 2000);
    const waarom = text(d?.waarom_nu ?? d?.waaromNu, 2000);
    const minitest = text(d?.minitest ?? d?.mini_test, 2000);
    const kosten = text(d?.kosten, 500);
    const risico = text(d?.risico, 1000);
    if (!titel || !wat) throw new KansError('Geef een titel en wat de kans is.');
    if (!waarom) throw new KansError('“waarom_nu” ontbreekt: wat is er de laatste weken veranderd waardoor dit nu een kans is?');
    const given = Array.isArray(d?.bronnen) ? d.bronnen.length : 0;
    const bronnen = cleanSources(d?.bronnen, now);
    if (!bronnen.length) throw new KansError(given ? 'Geen enkele bron heeft een webadres (https://…) én een datum (JJJJ-MM-DD) die niet in de toekomst ligt. Zonder zo’n bron wordt een kans niet opgeslagen en niet getoond.' : 'Bronnen ontbreken: geef per bron het webadres en de datum van publicatie. Zonder bron wordt een kans niet opgeslagen en niet getoond.');
    const cutoff = now - RECENT_DAYS * 86_400_000;
    if (!bronnen.some((b) => Date.parse(b.datum) >= cutoff)) throw new KansError(`Alle bronnen zijn ouder dan ${RECENT_DAYS} dagen: dat bewijst niet dat dit nú werkt. Zoek een recente bron of meld de kans niet.`);
    if (!kosten || !risico) throw new KansError('Kosten en risico ontbreken: wat kost een eerste test ongeveer, en wat kan er misgaan (bijv. een ban, verlies van budget)?');
    if (!minitest) throw new KansError('De mini-test ontbreekt: hoe test je dit klein, in dagen, met een meetbare uitkomst?');
    const dup = await this.td.rows(userId, "SELECT id FROM kansen WHERE lower(titel) = lower(?) AND status NOT IN ('nee') LIMIT 1", [titel], true, teamId);
    if (dup.length) throw new KansError(`Deze kans staat al op het bord (kans ${dup[0].id}).`);
    const [res] = await this.td.write(userId, [{ sql: 'INSERT INTO kansen (titel, wat, waarom_nu, bronnen, kosten, risico, minitest, gevonden_door) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', params: [titel, wat, waarom, JSON.stringify(bronnen), kosten, risico, minitest, who] }], teamId);
    this.changed(userId, teamId);
    return (await this.get(userId, teamId, Number(res.lastInsertRowid)))!;
  }

  /** The score card: five marks of 1–5; the score is computed here. */
  async score(userId: string, teamId: string | null, who: string, id: number, d: any): Promise<KansView> {
    const k = await this.get(userId, teamId, id);
    if (!k) throw new KansError(`Kans ${id} bestaat niet in dit team.`);
    if (!['nieuw', 'gescoord'].includes(k.status)) throw new KansError(`Kans ${id} is al ${k.status === 'voorgelegd' ? 'aan de eigenaar voorgelegd' : 'beslist'}.`);
    const card: any = {};
    for (const f of SCORE_FIELDS) {
      const v = Number(d?.[f]);
      if (!Number.isFinite(v) || v < 1 || v > 5) throw new KansError(`Geef voor “${f}” een cijfer van 1 tot 5 (${SCORE_LABEL[f]}).`);
      card[f] = Math.round(v);
    }
    const why = text(d?.toelichting, 1000);
    if (why.length < 10) throw new KansError('Geef een toelichting van één of twee zinnen bij de scorekaart.');
    card.toelichting = why;
    await this.td.write(userId, [{ sql: "UPDATE kansen SET score = ?, scorekaart = ?, gescoord_door = ?, status = 'gescoord' WHERE id = ?", params: [scoreOf(card), JSON.stringify(card), who, id] }], teamId);
    this.changed(userId, teamId);
    return (await this.get(userId, teamId, id))!;
  }

  /** Kansen without a score card, in every team this bot may give work to (the main bot: all of them). */
  async unscored(userId: string, agent: Pick<Agent, 'id'>): Promise<KansView[]> {
    const teams = this.ctx.services.teams;
    const ids: (string | null)[] = teams?.directableTeams ? teams.directableTeams(agent.id) : [null];
    const out: KansView[] = [];
    for (const tid of ids.length ? ids : [null]) out.push(...(await this.list(userId, tid)).filter((k) => k.status === 'nieuw'));
    return out;
  }

  /** What waits for the owner's yes or no. */
  async waiting(userId: string): Promise<KansView[]> {
    return (await this.list(userId)).filter((k) => k.status === 'voorgelegd').sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  /**
   * The weekly top 3: the best scored kansen of all teams go to the owner ("voorgelegd"). Returns them; [] when there
   * is nothing new with a score card. Kansen still waiting from an earlier week are not offered again.
   */
  async propose(userId: string): Promise<KansView[]> {
    const pick = (await this.list(userId))
      .filter((k) => k.status === 'gescoord' && k.score !== null)
      .sort((a, b) => (b.score || 0) - (a.score || 0) || a.id - b.id)
      .slice(0, TOP_N);
    const day = new Date(this.clock()).toISOString().slice(0, 10);
    for (const k of pick) {
      await this.td.write(userId, [{ sql: "UPDATE kansen SET status = 'voorgelegd', voorgelegd = ? WHERE id = ? AND status = 'gescoord'", params: [day, k.id] }], k.teamId);
      this.changed(userId, k.teamId);
    }
    return pick.map((k) => ({ ...k, status: 'voorgelegd' as const, voorgelegd: day }));
  }

  /** The owner's answer. Only "ja" makes work: a mini-test in the project loop of that team. */
  async decide(userId: string, teamId: string | null, id: number, choice: 'ja' | 'nee' | 'later', who: string): Promise<{ kans: KansView; note: string }> {
    const k = await this.get(userId, teamId, id);
    if (!k) throw new KansError('Kans niet gevonden.');
    if (['ja', 'nee'].includes(k.status)) throw new KansError('Over deze kans is al beslist.');
    const day = new Date(this.clock()).toISOString().slice(0, 10);
    let note = '';
    let projectId: number | null = null;
    if (choice === 'ja') {
      const r = await this.projects.start(userId, teamId, who, { naam: `Mini-test: ${k.titel}`.slice(0, 120), doel: k.minitest, eigenaar: k.gevonden_door, kansId: k.id, plan: `Mini-test: ${k.minitest}\nKosten: ${k.kosten}\nRisico: ${k.risico}` });
      projectId = r.project.id;
      note = r.project.status === 'wacht' ? 'De mini-test staat klaar en begint zodra er plek is in de sprint.' : 'De mini-test is gestart als project.';
    } else note = choice === 'nee' ? 'Afgewezen; deze kans komt niet terug.' : 'Bewaard voor later.';
    await this.td.write(userId, [{ sql: 'UPDATE kansen SET status = ?, beslist = ?, project_id = COALESCE(?, project_id) WHERE id = ?', params: [choice, day, projectId, id] }], teamId);
    this.changed(userId, teamId);
    return { kans: (await this.get(userId, teamId, id))!, note };
  }
}

// ------------------------------------------------------------------ bot tools

export function kansTools(svc: KansService, ctx: Ctx): ToolDef[] {
  const teams = () => ctx.services.teams;
  const home = (agent: Agent): string | null => teams()?.teamOf?.(agent.id) || null;
  const fail = (e: any) => {
    if (e instanceof KansError) return { text: e.message, isError: true };
    throw e;
  };
  /** The team a score is for: the bot's own, or (by name) one it may give work to. */
  const teamFor = (agent: Agent, raw: unknown): string | null => {
    const name = String(raw ?? '').trim().toLowerCase();
    if (!name) return home(agent);
    const t = (teams()?.list?.(agent.user_id) || []).find((x: any) => String(x.name).toLowerCase() === name);
    if (!t || !teams().canDirect(agent.id, t.id)) throw new KansError(`Je hebt geen team “${String(raw).slice(0, 60)}” dat je mag aansturen.`);
    return t.id;
  };
  return [
    {
      name: 'kans_melden',
      group: GROUP,
      risk: 'write',
      internal: true,
      description:
        'Meld een kans voor de eigenaar: iets dat nu werkt en bij zijn bedrijven of interesses past (een nieuw kanaal, advertentieplatform of verdienmodel). Verplicht: titel, wat, waarom_nu, bronnen (per bron het webadres en de publicatiedatum JJJJ-MM-DD; minstens één van de laatste 90 dagen), ' +
        'kosten, risico (wees eerlijk, bijv. kans op een ban) en een minitest (klein, in dagen, meetbaar). Zonder bron met datum wordt de kans geweigerd en nooit getoond. Een kans is geen werk: de eigenaar beslist.',
      parameters: {
        type: 'object',
        properties: {
          titel: { type: 'string' },
          wat: { type: 'string', description: 'Wat het is, in twee zinnen' },
          waarom_nu: { type: 'string', description: 'Wat er recent veranderde' },
          bronnen: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, titel: { type: 'string' }, datum: { type: 'string', description: 'Publicatiedatum JJJJ-MM-DD' } }, required: ['url', 'datum'] } },
          kosten: { type: 'string', description: 'Wat een eerste test ongeveer kost (geld en tijd)' },
          risico: { type: 'string' },
          minitest: { type: 'string', description: 'Hoe je dit klein test, met wat je meet' },
        },
        required: ['titel', 'wat', 'waarom_nu', 'bronnen', 'kosten', 'risico', 'minitest'],
      },
      summarize: (a) => words('Kans melden: “{0}”', String(a?.titel || '').slice(0, 80)),
      async run(a, t) {
        try {
          const k = await svc.report(t.agent.user_id, home(t.agent), t.agent.name, a);
          return { text: `Kans ${k.id} staat op het kansenbord met ${k.bronnen.length === 1 ? '1 bron' : `${k.bronnen.length} bronnen`}. De hoofdbot geeft hem een scorekaart; de eigenaar beslist. Begin er niet zelf aan.`, data: { kansId: k.id } };
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      name: 'kans_scoren',
      group: GROUP,
      risk: 'write',
      internal: true,
      description:
        'Geef een gemelde kans een scorekaart: vijf cijfers van 1 tot 5. vraag (hoe sterk is de vraag, 5 = sterk), past (past het bij de bedrijven en interesses van de eigenaar, 5 = heel goed), moeite (5 = veel werk), kosten (5 = duur), risico (5 = groot). ' +
        'TeamBot rekent de score uit. Geef een toelichting van één of twee zinnen. Kansen van een ander team dat je aanstuurt: geef team.',
      parameters: {
        type: 'object',
        properties: { kans: { type: 'number' }, vraag: { type: 'number' }, past: { type: 'number' }, moeite: { type: 'number' }, kosten: { type: 'number' }, risico: { type: 'number' }, toelichting: { type: 'string' }, team: { type: 'string', description: 'Naam van het team van de kans (leeg = je eigen team)' } },
        required: ['kans', 'vraag', 'past', 'moeite', 'kosten', 'risico', 'toelichting'],
      },
      summarize: (a) => words('Kans {0} scoren', a?.kans),
      async run(a, t) {
        try {
          const main = teams()?.mainOf?.(t.agent.user_id);
          if (main && main !== t.agent.id) return { text: 'De scorekaart maakt de hoofdbot. Meld kansen met kans_melden; scoren doe jij niet.', isError: true };
          const k = await svc.score(t.agent.user_id, teamFor(t.agent, a?.team), t.agent.name, Number(a?.kans), a);
          return { text: `Scorekaart opgeslagen: kans ${k.id} “${k.titel}” scoort ${k.score}/100. De beste drie van de week gaan naar de eigenaar.`, data: { kansId: k.id, score: k.score } };
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      name: 'kansen_lijst',
      group: GROUP,
      risk: 'read',
      description: 'Toon het kansenbord: wat er gemeld is, de score, en wat de eigenaar besliste. Kijk hier eerst, zodat je geen kans dubbel meldt.',
      parameters: { type: 'object', properties: {} },
      summarize: () => words('Kansenbord bekijken'),
      async run(_a, t) {
        const tms = teams();
        const ids: (string | null)[] = tms?.directableTeams ? tms.directableTeams(t.agent.id) : [null];
        const all: KansView[] = [];
        for (const tid of ids.length ? ids : [null]) all.push(...(await svc.list(t.agent.user_id, tid)));
        if (!all.length) return 'Het kansenbord is leeg.';
        return all.map((k) => `- kans ${k.id}${k.teamName && ids.length > 1 ? ` (team ${k.teamName})` : ''}: ${k.titel} · ${k.status}${k.score !== null ? ` · score ${k.score}` : ''} · bronnen: ${k.bronnen.map((b) => `${b.url} (${b.datum})`).join(', ')}`).join('\n');
      },
    },
  ];
}
