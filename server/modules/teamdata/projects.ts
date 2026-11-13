import type { Agent, Ctx, ToolDef } from '../../core/types.js';
import type { TeamData } from './service.js';
import { PROJECT_GROUP as GROUP } from './tools.js';
import { words } from '../../../shared/i18n-core.js';

/**
 * The project loop: inspectie (nulmeting with real numbers) → diagnose → plan (with "klaar als" and tasks) → uitvoeren
 * (with a work log) → meten → tip-top. One row per project in the team's table `projecten`; the order of the steps
 * and what each step must deliver are checked here, in code, not left to a prompt:
 *
 *  - a step is only taken with what it must deliver (a nulmeting with numbers, a diagnosis, a plan with tasks, every
 *    task closed, a new measurement);
 *  - no maximum of projects in the sprint, unless the owner sets one (`maxSprint`, 0 = none, the default); over it
 *    a new one waits its turn and moves up by itself when a place comes free or the maximum goes up;
 *  - a project that reaches tip-top leaves a guard behind: its site stays watched by a vaste taak on a cheap engine.
 */

export const PHASES = ['inspectie', 'diagnose', 'plan', 'uitvoeren', 'meten', 'tiptop'] as const;
export type Phase = (typeof PHASES)[number];
export const PHASE_LABEL: Record<Phase, string> = { inspectie: 'Inspectie', diagnose: 'Diagnose', plan: 'Plan', uitvoeren: 'Uitvoeren', meten: 'Meten', tiptop: 'Tip-top' };
const TASK_CLOSED = ['klaar', 'kon_niet', 'geannuleerd', 'vervallen'];

export interface ProjectRow {
  id: number;
  naam: string;
  site: string | null;
  doel: string | null;
  eigenaar: string | null;
  fase: Phase;
  status: 'sprint' | 'wacht' | 'tiptop' | 'gestopt';
  nulmeting: string | null;
  diagnose: string | null;
  plan: string | null;
  klaar_als: string | null;
  meting: string | null;
  werklog: string | null;
  kans_id: number | null;
  aangemaakt: string;
  bijgewerkt: string | null;
  tiptop_op: string | null;
}

export interface ProjectView extends ProjectRow {
  teamId: string | null;
  teamName: string;
  /** 0–5: how many steps are behind it. */
  step: number;
  tasks: { total: number; open: number; done: number };
  /** What the current step still needs, in words. */
  next: string;
}

export class ProjectError extends Error {}

/** A text field as the team tables keep it: no carriage returns, trimmed, at most `max` characters. */
export const text = (v: unknown, max: number) => String(v ?? '').replace(/\r/g, '').trim().slice(0, max);
/** A measurement names at least one number. */
const hasNumber = (s: string) => /\d/.test(s);
const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

export class ProjectService {
  /** Test seam. */
  clock = () => Date.now();

  constructor(
    private ctx: Ctx,
    private td: TeamData,
  ) {}

  /** The owner's maximum of projects in the sprint per team; 0 = none (the default). */
  private maxSprint(userId: string): number {
    const n = Math.round(Number(this.ctx.services.routines?.duties?.settings?.(userId)?.maxSprint));
    return n > 0 ? n : 0;
  }

  /** Is the sprint of this team full? Never without a maximum. */
  private async full(userId: string, teamId: string | null): Promise<boolean> {
    const max = this.maxSprint(userId);
    return max > 0 && (await this.sprintCount(userId, teamId)) >= max;
  }

  /** The name of a team ('' without teams). */
  teamName(teamId: string | null): string {
    return (teamId && this.ctx.services.teams?.team?.(teamId)?.name) || '';
  }

  /** The owner's teams, or [null] when there are none (one shared team table). */
  teamIds(userId: string): (string | null)[] {
    const list: { id: string }[] = this.ctx.services.teams?.list?.(userId) || [];
    return list.length ? list.map((t) => t.id) : [null];
  }

  private changed(userId: string, teamId: string | null) {
    this.ctx.events.emit(userId, 'teamdata.changed', { tables: ['projecten', 'taken'], by: 'TeamBot', teamId });
  }

  async get(userId: string, teamId: string | null, id: number): Promise<ProjectRow | null> {
    return (await this.td.rows(userId, 'SELECT * FROM projecten WHERE id = ?', [id], true, teamId))[0] || null;
  }

  private async tasksOf(userId: string, teamId: string | null, id: number): Promise<{ id: number; titel: string; status: string }[]> {
    return this.td.rows(userId, 'SELECT id, titel, status FROM taken WHERE project_id = ? ORDER BY id', [id], true, teamId);
  }

  private nextText(p: ProjectRow, open: number): string {
    if (p.status === 'wacht') return 'Wacht op een plek in de sprint.';
    if (p.status === 'gestopt') return 'Gestopt.';
    switch (p.fase) {
      case 'inspectie':
        return 'Nulmeting: de echte cijfers van nu, met bron en datum.';
      case 'diagnose':
        return 'Diagnose: wat is de oorzaak, onderbouwd met de nulmeting.';
      case 'plan':
        return 'Plan met “klaar als” en de taken die het uitvoeren.';
      case 'uitvoeren':
        return open ? `Uitvoeren: nog ${open === 1 ? '1 taak' : `${open} taken`} open.` : 'Alle taken zijn dicht: tijd om te meten.';
      case 'meten':
        return 'Meten: dezelfde cijfers als de nulmeting, opnieuw gemeten.';
      default:
        return 'Tip-top: een bewaker houdt het in de gaten.';
    }
  }

  async view(userId: string, teamId: string | null, p: ProjectRow): Promise<ProjectView> {
    const tasks = await this.tasksOf(userId, teamId, p.id);
    const open = tasks.filter((t) => !TASK_CLOSED.includes(t.status)).length;
    return { ...p, teamId, teamName: this.teamName(teamId), step: PHASES.indexOf(p.fase), tasks: { total: tasks.length, open, done: tasks.filter((t) => t.status === 'klaar').length }, next: this.nextText(p, open) };
  }

  /** Every project of one team, or of all the owner's teams. Sprint first, then waiting, then tip-top. */
  async list(userId: string, teamId?: string | null): Promise<ProjectView[]> {
    const out: ProjectView[] = [];
    for (const tid of teamId ? [teamId] : this.teamIds(userId)) {
      await this.fill(userId, tid);
      const rows: ProjectRow[] = await this.td.rows(userId, 'SELECT * FROM projecten ORDER BY id', [], true, tid);
      for (const p of rows) out.push(await this.view(userId, tid, p));
    }
    const rank = { sprint: 0, wacht: 1, tiptop: 2, gestopt: 3 } as Record<string, number>;
    return out.sort((a, b) => rank[a.status] - rank[b.status] || a.id - b.id);
  }

  private async sprintCount(userId: string, teamId: string | null): Promise<number> {
    return Number((await this.td.rows(userId, "SELECT COUNT(*) n FROM projecten WHERE status = 'sprint'", [], true, teamId))[0]?.n) || 0;
  }

  private log(p: Pick<ProjectRow, 'werklog'>, who: string, what: string): string {
    return `${p.werklog ? `${p.werklog}\n` : ''}${stamp(this.clock())} · ${who}: ${what}`.slice(-20_000);
  }

  /** What TeamBot can measure of a site by itself, as the first numbers of the nulmeting (or of the final measurement). */
  private async measureSite(userId: string, site: string | null): Promise<{ text: string; findings: number } | null> {
    if (!site) return null;
    const engine = this.ctx.services.routines?.engine;
    if (!engine) return null;
    try {
      const { checkSites, cleanSiteUrl } = await import('../routines/duties/checks.js');
      const url = cleanSiteUrl(site);
      if (!url) return null;
      const r = await checkSites(engine.fetcher, [url], { depth: 'full', now: () => this.clock() });
      const nums = Object.entries(r.numbers)
        .filter(([k]) => k !== 'websites')
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      const problems = r.findings.length ? ` Problemen: ${r.findings.map((f) => f.title).join('; ')}.` : ' Geen technische problemen gevonden.';
      return { text: `TeamBot sitecontrole ${stamp(this.clock())} UTC (${url}): ${nums}.${problems}`, findings: r.findings.length };
    } catch {
      return null;
    }
  }

  /** Start a project. Over the sprint limit it waits; the answer says so. */
  async start(userId: string, teamId: string | null, who: string, d: { naam?: any; site?: any; doel?: any; eigenaar?: any; kansId?: number | null; plan?: any }): Promise<{ project: ProjectView; note: string }> {
    const naam = text(d.naam, 120);
    if (!naam) throw new ProjectError('Geef het project een naam.');
    const dup = await this.td.rows(userId, "SELECT id FROM projecten WHERE lower(naam) = lower(?) AND status IN ('sprint','wacht') LIMIT 1", [naam], true, teamId);
    if (dup.length) throw new ProjectError(`Er loopt al een project “${naam}” (project ${dup[0].id}).`);
    // Those that waited go first; then the new one waits only when the owner's maximum is reached.
    await this.fill(userId, teamId);
    const max = this.maxSprint(userId);
    const waits = await this.full(userId, teamId);
    const site = text(d.site, 200) || null;
    const base = waits ? null : await this.measureSite(userId, site);
    const row = { werklog: null as string | null };
    const werklog = this.log(row, who, waits ? `project aangemaakt; wacht op een plek in de sprint (hoogstens ${max} tegelijk)` : 'project gestart: inspectie');
    const [res] = await this.td.write(
      userId,
      [{ sql: 'INSERT INTO projecten (naam, site, doel, eigenaar, fase, status, nulmeting, plan, werklog, kans_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', params: [naam, site, text(d.doel, 2000) || null, text(d.eigenaar, 80) || who, 'inspectie', waits ? 'wacht' : 'sprint', base?.text || null, text(d.plan, 4000) || null, werklog, d.kansId ?? null] }],
      teamId,
    );
    this.changed(userId, teamId);
    const p = (await this.get(userId, teamId, Number(res.lastInsertRowid)))!;
    const note = waits ? `Project “${naam}” staat klaar maar wacht: er zitten al ${max} projecten in de sprint. Het schuift vanzelf door als er één tip-top of gestopt is.` : `Project “${naam}” is gestart (project ${p.id}). Eerste stap: de nulmeting.${base ? ' TeamBot heeft de website al gemeten; vul aan met de cijfers uit je eigen bronnen.' : ''}`;
    return { project: await this.view(userId, teamId, p), note };
  }

  /**
   * Take the next step of a project with what that step must deliver. Throws a ProjectError (in plain Dutch) when it
   * is missing; nothing changes then.
   */
  async step(userId: string, teamId: string | null, id: number, who: string, d: any): Promise<{ project: ProjectView; note: string }> {
    const p = await this.get(userId, teamId, id);
    if (!p) throw new ProjectError(`Project ${id} bestaat niet in dit team.`);
    if (p.status === 'wacht') throw new ProjectError(`Project “${p.naam}” wacht nog op een plek in de sprint; werk eerst de lopende projecten af.`);
    if (p.status !== 'sprint') throw new ProjectError(`Project “${p.naam}” is ${p.status === 'tiptop' ? 'al tip-top' : 'gestopt'}.`);
    const set: Record<string, any> = {};
    let note = '';
    let said = '';
    switch (p.fase) {
      case 'inspectie': {
        const extra = text(d?.nulmeting, 6000);
        const all = [p.nulmeting, extra].filter(Boolean).join('\n');
        if (!all || !hasNumber(all)) throw new ProjectError('De nulmeting ontbreekt: geef de echte cijfers van nu (bijv. klikken, posities, afgekeurde producten), met de bron en de datum. Zonder cijfers is er later niets om mee te vergelijken.');
        if (extra && !/\d{1,2}[-/ ]\d{1,2}|\d{4}|vandaag|gisteren|nov|dec|jan|feb|mrt|maa|apr|mei|jun|jul|aug|sep|okt/i.test(extra)) throw new ProjectError('Zet bij de nulmeting de datum van de meting en de bron (bijv. “Search Console, 9 nov”).');
        set.nulmeting = all;
        set.fase = 'diagnose';
        said = 'nulmeting vastgelegd';
        note = 'Nulmeting vastgelegd. Volgende stap: de diagnose (wat is de oorzaak?).';
        break;
      }
      case 'diagnose': {
        const diag = text(d?.diagnose, 6000);
        if (diag.length < 20) throw new ProjectError('De diagnose ontbreekt: schrijf in een paar zinnen wat de oorzaak is en waar je dat aan ziet in de nulmeting.');
        set.diagnose = diag;
        set.fase = 'plan';
        said = 'diagnose vastgelegd';
        note = 'Diagnose vastgelegd. Volgende stap: het plan met “klaar als” en de taken.';
        break;
      }
      case 'plan': {
        const plan = text(d?.plan, 6000) || p.plan || '';
        const doneWhen = text(d?.klaar_als ?? d?.klaarAls, 1000);
        const tasks: any[] = Array.isArray(d?.taken) ? d.taken.slice(0, 30) : [];
        if (plan.length < 20) throw new ProjectError('Het plan ontbreekt: wat ga je doen, in welke volgorde?');
        if (!doneWhen) throw new ProjectError('“klaar_als” ontbreekt: wanneer is dit project tip-top, meetbaar tegen de nulmeting?');
        const existing = await this.tasksOf(userId, teamId, id);
        if (!tasks.length && !existing.length) throw new ProjectError('Een plan heeft taken nodig: geef in “taken” per taak een titel, wie hem doet (eigenaar) en klaar_als.');
        const steps = [];
        for (const t of tasks) {
          const titel = text(t?.titel ?? t?.title, 200);
          const kl = text(t?.klaar_als ?? t?.klaarAls, 500);
          if (!titel || !kl) throw new ProjectError('Elke taak in het plan heeft een titel en klaar_als nodig.');
          steps.push({ sql: "INSERT INTO taken (titel, eigenaar, aangevraagd_door, site, status, klaar_als, bron, project_id) VALUES (?, ?, ?, ?, 'open', ?, ?, ?)", params: [titel, text(t?.eigenaar, 80) || p.eigenaar || who, `Project: ${p.naam}`.slice(0, 120), p.site, kl, `project:${id}`, id] });
        }
        if (steps.length) await this.td.write(userId, steps, teamId);
        set.plan = plan;
        set.klaar_als = doneWhen;
        set.fase = 'uitvoeren';
        said = `plan vastgelegd met ${tasks.length || existing.length} ${tasks.length + existing.length === 1 ? 'taak' : 'taken'}`;
        note = `Plan vastgelegd; ${steps.length ? `${steps.length === 1 ? '1 taak staat' : `${steps.length} taken staan`} op het bord` : 'de taken staan al op het bord'}. Volgende stap: uitvoeren. Elke taak meld je af met resultaat en bewijs.`;
        break;
      }
      case 'uitvoeren': {
        const tasks = await this.tasksOf(userId, teamId, id);
        const open = tasks.filter((t) => !TASK_CLOSED.includes(t.status));
        if (open.length) throw new ProjectError(`Nog niet klaar met uitvoeren: ${open.length === 1 ? 'deze taak staat' : 'deze taken staan'} nog open: ${open.map((t) => `taak ${t.id} (${t.titel}, ${t.status})`).join('; ')}. Maak ze af (klaar met bewijs) of meld kon_niet met de reden.`);
        if (!tasks.some((t) => t.status === 'klaar')) throw new ProjectError('Geen enkele taak van dit project is klaar: er valt nog niets te meten.');
        set.fase = 'meten';
        said = 'alle taken zijn dicht';
        note = 'Alle taken zijn dicht. Volgende stap: meten, met dezelfde cijfers als de nulmeting.';
        break;
      }
      case 'meten': {
        const extra = text(d?.meting, 6000);
        const own = await this.measureSite(userId, p.site);
        const all = [own?.text, extra].filter(Boolean).join('\n');
        if (!all || !hasNumber(all)) throw new ProjectError('De meting ontbreekt: meet dezelfde cijfers als in de nulmeting opnieuw, met bron en datum.');
        set.meting = all;
        if (own && own.findings > 0) {
          await this.save(userId, teamId, p, { ...set, werklog: this.log(p, who, 'gemeten: nog niet tip-top') });
          throw new ProjectError(`Nog niet tip-top. ${own.text} Los dit op (nieuwe taken met project_stap is niet nodig: maak ze met team_execute in taken met project_id ${id}) en meet daarna opnieuw.`);
        }
        if (d?.tiptop === false) {
          set.fase = 'uitvoeren';
          said = 'gemeten: nog niet tip-top, terug naar uitvoeren';
          note = 'Meting vastgelegd; het project gaat terug naar uitvoeren. Zet de extra taken op het bord met dit project_id.';
          break;
        }
        set.fase = 'tiptop';
        set.status = 'tiptop';
        set.tiptop_op = stamp(this.clock());
        said = 'gemeten: tip-top';
        note = '';
        break;
      }
      default:
        throw new ProjectError(`Project “${p.naam}” is al tip-top.`);
    }
    await this.save(userId, teamId, p, { ...set, werklog: this.log(p, who, said) });
    if (set.status === 'tiptop') {
      const guard = await this.leaveGuard(userId, teamId, p);
      const next = await this.promote(userId, teamId);
      note = `Project “${p.naam}” is tip-top. ${guard}${next ? ` Project “${next}” schuift nu de sprint in.` : ''}`;
    }
    const fresh = (await this.get(userId, teamId, id))!;
    return { project: await this.view(userId, teamId, fresh), note };
  }

  private async save(userId: string, teamId: string | null, p: ProjectRow, set: Record<string, any>) {
    const keys = Object.keys(set);
    await this.td.write(userId, [{ sql: `UPDATE projecten SET ${keys.map((k) => `${k} = ?`).join(', ')}, bijgewerkt = datetime('now','localtime') WHERE id = ?`, params: [...keys.map((k) => set[k]), p.id] }], teamId);
    this.changed(userId, teamId);
  }

  /** A line in the project's work log (what was done, by whom). */
  async note(userId: string, teamId: string | null, id: number, who: string, what: string): Promise<void> {
    const p = await this.get(userId, teamId, id);
    if (!p) throw new ProjectError(`Project ${id} bestaat niet in dit team.`);
    const line = text(what, 1000);
    if (!line) throw new ProjectError('Wat heb je gedaan? Geef één regel voor het werklog.');
    await this.save(userId, teamId, p, { werklog: this.log(p, who, line) });
  }

  /** The owner stops a project; the next waiting one moves up. */
  async stop(userId: string, teamId: string | null, id: number, who: string): Promise<ProjectView> {
    const p = await this.get(userId, teamId, id);
    if (!p) throw new ProjectError('Project niet gevonden.');
    if (p.status === 'sprint' || p.status === 'wacht') {
      await this.save(userId, teamId, p, { status: 'gestopt', werklog: this.log(p, who, 'gestopt') });
      await this.promote(userId, teamId);
    }
    return this.view(userId, teamId, (await this.get(userId, teamId, id))!);
  }

  /**
   * Every waiting project that has a place now moves up, oldest first: after the owner raised his maximum or set none
   * (duties setSettings), and before a list or a new project. One team, or all of the owner's teams.
   */
  async fill(userId: string, teamId?: string | null): Promise<string[]> {
    const moved: string[] = [];
    for (const tid of teamId !== undefined ? [teamId] : this.teamIds(userId)) {
      for (let next = await this.promote(userId, tid); next; next = await this.promote(userId, tid)) moved.push(next);
    }
    return moved;
  }

  /** A free place in the sprint goes to the project that waited longest. Returns its name. */
  private async promote(userId: string, teamId: string | null): Promise<string | null> {
    if (await this.full(userId, teamId)) return null;
    const next: ProjectRow | undefined = (await this.td.rows(userId, "SELECT * FROM projecten WHERE status = 'wacht' ORDER BY id LIMIT 1", [], true, teamId))[0];
    if (!next) return null;
    const base = next.nulmeting ? null : await this.measureSite(userId, next.site);
    await this.save(userId, teamId, next, { status: 'sprint', ...(base ? { nulmeting: base.text } : {}), werklog: this.log(next, 'TeamBot', 'er is plek: het project zit nu in de sprint') });
    this.ctx.events.emit(userId, 'notification', { title: `Project “${next.naam}” is gestart`, body: 'Er kwam een plek vrij in de sprint.', link: '#/m/routines/werk/projecten', kind: 'info' });
    return next.naam;
  }

  /**
   * Tip-top: the project's site stays watched. The duties of the project's bot that watch this team's sites become
   * guards (cheapest engine); without one, the bot gets "Websites bereikbaar" as its guard.
   */
  private async leaveGuard(userId: string, teamId: string | null, p: ProjectRow): Promise<string> {
    const r = this.ctx.services.routines;
    const duties = r?.duties;
    if (!duties || !r?.engine) return '';
    const bots: Agent[] = this.ctx.store.agents(userId).filter((a) => !teamId || this.ctx.services.teams?.teamOf?.(a.id) === teamId);
    const owner = bots.find((a) => a.name.toLowerCase() === String(p.eigenaar || '').toLowerCase()) || null;
    const all: any[] = duties.duties(userId).filter((x: any) => r.engine.inTeam(x, teamId));
    let guards = all.filter((x) => x.options.duty.source === 'site' || (owner && x.agent_id === owner.id && x.options.duty.key !== 'werk.afmaken'));
    if (!guards.length && owner && p.site) {
      const { cleanSiteUrl } = await import('../routines/duties/checks.js');
      const url = cleanSiteUrl(p.site);
      if (url) guards = [duties.create(userId, owner.id, { key: `bewaker.${p.id}`, title: `Bewaker: ${p.naam}`.slice(0, 80), check: `Antwoordt ${url} nog?`, source: 'site', okWhen: `${url} antwoordt met status 200`, onProblem: 'fix', days: [0, 1, 2, 3, 4, 5, 6], times: ['08:00', '14:00', '20:00'], measure: { kind: 'url', url } })];
    }
    for (const g of guards) if (!g.options.duty.guard) r.engine.update(g, { options: { duty: { ...g.options.duty, guard: true, projectId: p.id } } });
    return guards.length ? `${guards.length === 1 ? 'De vaste taak' : 'De vaste taken'} ${guards.map((g) => `“${g.name}”`).join(', ')} ${guards.length === 1 ? 'blijft' : 'blijven'} als bewaker achter (goedkoop model).` : 'Er is geen bewaker: vul een website in of geef een bot een vaste taak voor dit project.';
  }
}

// ------------------------------------------------------------------ bot tools

export function projectTools(svc: ProjectService, ctx: Ctx): ToolDef[] {
  const teamOf = (agent: Agent): string | null => ctx.services.teams?.teamOf?.(agent.id) || null;
  const fail = (e: any) => {
    if (e instanceof ProjectError) return { text: e.message, isError: true };
    throw e;
  };
  const line = (p: ProjectView) => `- project ${p.id}: ${p.naam}${p.site ? ` (${p.site})` : ''} · ${p.status === 'sprint' ? `stap ${PHASE_LABEL[p.fase]}` : p.status} · ${p.next}${p.tasks.total ? ` · taken: ${p.tasks.done} klaar, ${p.tasks.open} open` : ''}`;
  return [
    {
      name: 'project_start',
      group: GROUP,
      risk: 'write',
      internal: true,
      description:
        'Start een project voor je team: iets dat je in een paar dagen tip-top maakt (een website, een feed, een campagne). Een project loopt in vaste stappen: inspectie (nulmeting) → diagnose → plan → uitvoeren → meten → tip-top. ' +
        'Heeft de eigenaar een maximum aantal projecten tegelijk in de sprint ingesteld en is dat bereikt, dan wacht het nieuwe project vanzelf op zijn beurt.',
      parameters: { type: 'object', properties: { naam: { type: 'string' }, site: { type: 'string', description: 'De website of het account waar het om gaat (optioneel)' }, doel: { type: 'string', description: 'Wat er beter moet worden, meetbaar' } }, required: ['naam', 'doel'] },
      summarize: (a) => words('Project starten: “{0}”', String(a?.naam || '').slice(0, 80)),
      async run(a, t) {
        try {
          const r = await svc.start(t.agent.user_id, teamOf(t.agent), t.agent.name, { naam: a?.naam, site: a?.site, doel: a?.doel, eigenaar: t.agent.name });
          return { text: `${r.note}\n${r.project.nulmeting ? `Nulmeting tot nu toe: ${r.project.nulmeting}` : ''}`.trim(), data: { projectId: r.project.id, status: r.project.status } };
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      name: 'project_stap',
      group: GROUP,
      risk: 'write',
      internal: true,
      description:
        'Zet de volgende stap van een project, met wat die stap moet opleveren. TeamBot weigert een stap zonder inhoud. Per stap: inspectie → nulmeting (echte cijfers van nu, met bron en datum); ' +
        'diagnose → diagnose (de oorzaak); plan → plan, klaar_als en taken (per taak titel, eigenaar en klaar_als: TeamBot zet ze op het bord); uitvoeren → niets (kan pas als alle taken dicht zijn); ' +
        'meten → meting (dezelfde cijfers opnieuw, met bron en datum; tiptop: false als het nog niet goed is). Met alleen "werklog" schrijf je één regel in het werklog zonder een stap te zetten.',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'number', description: 'Het nummer van het project' },
          nulmeting: { type: 'string' },
          diagnose: { type: 'string' },
          plan: { type: 'string' },
          klaar_als: { type: 'string' },
          taken: { type: 'array', items: { type: 'object', properties: { titel: { type: 'string' }, eigenaar: { type: 'string', description: 'Naam van de bot die het doet' }, klaar_als: { type: 'string' } }, required: ['titel', 'klaar_als'] } },
          meting: { type: 'string' },
          tiptop: { type: 'boolean' },
          werklog: { type: 'string', description: 'Eén regel: wat je net hebt gedaan' },
        },
        required: ['project'],
      },
      summarize: (a) => words(a?.werklog && !a?.nulmeting && !a?.diagnose && !a?.plan && !a?.meting ? 'Project {0}: werklog bijwerken' : 'Project {0}: volgende stap', a?.project),
      async run(a, t) {
        try {
          const id = Number(a?.project);
          const only = a?.werklog && a?.nulmeting === undefined && a?.diagnose === undefined && a?.plan === undefined && a?.meting === undefined && a?.taken === undefined && a?.klaar_als === undefined;
          if (a?.werklog) await svc.note(t.agent.user_id, teamOf(t.agent), id, t.agent.name, String(a.werklog));
          if (only) return 'Genoteerd in het werklog.';
          const r = await svc.step(t.agent.user_id, teamOf(t.agent), id, t.agent.name, a);
          return { text: r.note, data: { projectId: id, fase: r.project.fase, status: r.project.status } };
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      name: 'project_list',
      group: GROUP,
      risk: 'read',
      description: 'Toon de projecten van je team: welke in de sprint zitten, in welke stap, wat de stap nog nodig heeft, en welke wachten of tip-top zijn.',
      parameters: { type: 'object', properties: {} },
      summarize: () => words('Projecten bekijken'),
      async run(_a, t) {
        const list = await svc.list(t.agent.user_id, teamOf(t.agent) || undefined);
        return list.length ? list.map(line).join('\n') : 'Er zijn nog geen projecten.';
      },
    },
  ];
}
