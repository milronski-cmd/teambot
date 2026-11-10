import type { Ctx, ToolDef, ToolGroup } from '../../../core/types.js';
import { ah, bad, HttpError, notFound, str, user } from '../../../core/http.js';
import { HttpishError, type RoutineEngine } from '../engine.js';
import { formatLocal, ScheduleError, wallTime } from '../schedule.js';
import { cleanMeasure, type DutyService } from './service.js';
import { SOURCE_LABEL } from './types.js';

/** Always on: a reminder only ever tells the owner something, so every bot may set one (also bots without Routines). */
export const REMINDER_GROUP: ToolGroup = { id: 'routines:reminders', label: 'Herinneringen en vaste taken', description: 'Herinneringen voor de eigenaar en vaste taken voor de bot zelf instellen en weghalen', always: true };
const MAX_REMINDERS = 100;
const pad = (n: number) => String(n).padStart(2, '0');

/** Tools for vaste taken and reminders. `report` is only offered during a duty's run. */
export function dutyTools(engine: RoutineEngine, duties: DutyService): { static: ToolDef[]; report: ToolDef } {
  const report: ToolDef = {
    name: 'duty_report',
    group: 'routines:run',
    risk: 'write',
    internal: true,
    description:
      'Sluit de run van een vaste taak af met wat je hebt gemeten. status: in_orde (alles goed: één regel met het cijfer in samenvatting; de eigenaar krijgt geen melding), ' +
      'probleem (er is iets mis: per punt titel, bewijs en klaar_als; TeamBot zet het op het takenbord, nooit dubbel), opgelost (je hebt het zelf opgelost: per punt titel, bewijs en klaar_als; komt in het logboek) ' +
      'of kon_niet (je kon de bron niet bereiken: zeg waarom in samenvatting). Bewijs is altijd het gemeten cijfer met de bron en de datum; zonder bewijs wordt een punt geweigerd.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['in_orde', 'probleem', 'opgelost', 'kon_niet'] },
        samenvatting: { type: 'string', description: 'Eén regel: wat je hebt gemeten, met het cijfer' },
        punten: {
          type: 'array',
          description: 'Bij probleem of opgelost: één per punt',
          items: {
            type: 'object',
            properties: {
              titel: { type: 'string', description: 'Kort, bijv. "12 producten afgekeurd: ontbrekende GTIN"' },
              bewijs: { type: 'string', description: 'Het gemeten cijfer, de bron en de datum' },
              klaar_als: { type: 'string', description: 'Wanneer dit opgelost is, meetbaar' },
              site: { type: 'string', description: 'De website of het account waar het om gaat (optioneel)' },
              sleutel: { type: 'string', description: 'Vaste korte naam voor dit probleem, zodat het bij de volgende controle dezelfde taak blijft (optioneel)' },
            },
            required: ['titel', 'bewijs', 'klaar_als'],
          },
        },
      },
      required: ['status'],
    },
    summarize: (a) => `Vaste taak afronden: ${a?.status === 'in_orde' ? 'in orde' : a?.status === 'probleem' ? 'probleem gevonden' : a?.status === 'opgelost' ? 'opgelost' : 'kon niet'}`,
    async run(a, t) {
      return duties.report(t.run.id, t.agent, a);
    },
  };

  const remind: ToolDef = {
    name: 'reminder_set',
    group: REMINDER_GROUP.id,
    risk: 'write',
    internal: true,
    description:
      'Zet een herinnering voor de eigenaar ("herinner me morgen om 9 uur aan de tandarts"). Op dat moment meldt TeamBot het zelf: als melding op de pc en de telefoon, in jullie chat en via zijn chat-app als die gekoppeld is. ' +
      'Dat kost geen AI en komt precies op tijd. Geef at (lokale datum en tijd "JJJJ-MM-DDTUU:MM") of in_minutes; voor een terugkerende herinnering days (ma, di, …; leeg = elke dag) met times. ' +
      'Gebruik dit voor herinneren; gebruik routine_create alleen als jij op dat moment zelf iets moet uitzoeken of doen.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Waar de eigenaar aan herinnerd wil worden, zoals hij het wil lezen' },
        at: { type: 'string', description: "Eenmalig: lokale datum en tijd 'JJJJ-MM-DDTUU:MM'" },
        in_minutes: { type: 'number', description: 'Eenmalig: over zoveel minuten' },
        days: { type: 'array', items: { type: 'string' }, description: 'Terugkerend: dagen als ma, di, wo, do, vr, za, zo' },
        times: { type: 'array', items: { type: 'string' }, description: "Terugkerend: tijden 'UU:MM'" },
      },
      required: ['text'],
    },
    summarize: (a) => `Herinnering zetten: “${String(a?.text || '').slice(0, 80)}”${a?.at ? ` op ${String(a.at).replace('T', ' ')}` : a?.in_minutes ? ` over ${a.in_minutes} min` : ''}`,
    async run(a, t) {
      const text = String(a?.text || '').trim();
      if (!text) return { text: 'Geef de tekst van de herinnering.', isError: true };
      if (engine.routinesOf(t.userId, t.agent.id).filter((r) => r.options.reminder && r.status === 'active').length >= MAX_REMINDERS) return { text: `Er staan al ${MAX_REMINDERS} herinneringen klaar bij deze bot.`, isError: true };
      const tz = engine.userTz(t.userId);
      let schedule: any;
      if (Array.isArray(a?.times) && a.times.length) schedule = { kind: 'weekly', days: Array.isArray(a.days) && a.days.length ? a.days : [0, 1, 2, 3, 4, 5, 6], times: a.times };
      else if (Number(a?.in_minutes) > 0) {
        const w = wallTime(engine.now() + Math.round(Number(a.in_minutes)) * 60_000, tz);
        schedule = { kind: 'once', at: `${w.y}-${pad(w.m)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}` };
      } else if (a?.at) schedule = { kind: 'once', at: String(a.at) };
      else return { text: 'Wanneer? Geef at (JJJJ-MM-DDTUU:MM), in_minutes, of days met times.', isError: true };
      try {
        const r = engine.create(t.userId, { name: `Herinnering: ${text}`.slice(0, 80), prompt: text, agent_id: t.agent.id, timezone: tz, schedule, options: { reminder: { text }, notify: 'always', missedPolicy: 'catchup', retries: 0, maxRunsPerDay: 50 } }, { createdBy: 'agent' });
        const next = r.next_run_at ? formatLocal(Date.parse(r.next_run_at), r.timezone, true) : '';
        return { text: `Herinnering gezet${next ? ` voor ${next}` : ''}: “${text}”. De eigenaar krijgt hem dan als melding (pc en telefoon), in de chat en via zijn chat-app als die gekoppeld is.`, data: { routineId: r.id, at: r.next_run_at } };
      } catch (e: any) {
        if (e instanceof HttpishError || e instanceof ScheduleError) return { text: `Kon de herinnering niet zetten: ${e.message}`, isError: true };
        throw e;
      }
    },
  };

  const cancel: ToolDef = {
    name: 'reminder_cancel',
    group: REMINDER_GROUP.id,
    risk: 'write',
    internal: true,
    description: 'Haal een herinnering weg die je eerder zette (een deel van de tekst is genoeg). Zonder text: toon de herinneringen die klaarstaan.',
    parameters: { type: 'object', properties: { text: { type: 'string', description: 'Een deel van de tekst van de herinnering' } } },
    summarize: (a) => (a?.text ? `Herinnering weghalen: “${String(a.text).slice(0, 60)}”` : 'Herinneringen bekijken'),
    async run(a, t) {
      const mine = engine.routinesOf(t.userId, t.agent.id).filter((r) => r.options.reminder && r.status === 'active');
      const q = String(a?.text || '').trim().toLowerCase();
      const line = (r: (typeof mine)[number]) => `- ${r.options.reminder!.text}${r.next_run_at ? ` · ${formatLocal(Date.parse(r.next_run_at), r.timezone, true)}` : ''}`;
      if (!q) return mine.length ? `Herinneringen die klaarstaan:\n${mine.map(line).join('\n')}` : 'Er staan geen herinneringen klaar.';
      const hit = mine.filter((r) => r.options.reminder!.text.toLowerCase().includes(q));
      if (!hit.length) return { text: `Geen herinnering gevonden met “${q}”.${mine.length ? `\nEr staan klaar:\n${mine.map(line).join('\n')}` : ''}`, isError: true };
      if (hit.length > 1) return { text: `Meer dan één herinnering past bij “${q}”; wees preciezer:\n${hit.map(line).join('\n')}`, isError: true };
      engine.remove(hit[0], { deleteThread: true });
      return `Herinnering weggehaald: “${hit[0].options.reminder!.text}”.`;
    },
  };

  const set: ToolDef = {
    name: 'duty_set',
    group: REMINDER_GROUP.id,
    risk: 'write',
    description:
      'Stel een vaste taak voor jezelf in: iets dat je uit jezelf in de gaten houdt of bijhoudt ("houd elke ochtend de voorraad in de gaten", "kijk elk uur of de site nog werkt"). Werkt voor elke rol. ' +
      'Geef title, check (wat je controleert), ok_when (wanneer het in orde is) en on_problem: fix (zelf oplossen), task (een taak maken) of ask (de eigenaar vragen). Hoe vaak: every_minutes (vanaf 1), of days (ma, di, …; leeg = elke dag) met times. ' +
      'Kan TeamBot het zelf meten, geef dan measure mee; dan wordt er zonder AI gemeten en word je alleen gewekt als het niet in orde is. measure.kind: url (url, optioneel contains, status, maxMs), ' +
      'tool (tool = de naam van een van je lees-tools, args, path naar het getal zoals "rows.length", op en value: in orde als getal op value) of query (sql = één SELECT op de teamdatabase die één getal geeft, op, value). ' +
      'Een vaste taak met dezelfde title werk je hiermee bij.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        check: { type: 'string', description: 'Wat je controleert of bijhoudt' },
        ok_when: { type: 'string', description: 'Wanneer het in orde is, meetbaar' },
        on_problem: { type: 'string', enum: ['fix', 'task', 'ask'] },
        every_minutes: { type: 'number' },
        days: { type: 'array', items: { type: 'string' } },
        times: { type: 'array', items: { type: 'string' }, description: "Tijden 'UU:MM'" },
        measure: {
          type: 'object',
          properties: { kind: { type: 'string', enum: ['url', 'tool', 'query'] }, url: { type: 'string' }, contains: { type: 'string' }, status: { type: 'number' }, maxMs: { type: 'number' }, tool: { type: 'string' }, args: { type: 'object' }, path: { type: 'string' }, sql: { type: 'string' }, op: { type: 'string', enum: ['<', '<=', '>', '>=', '=', '!='] }, value: { type: 'number' } },
        },
      },
      required: ['title', 'check'],
    },
    summarize: (a) => `Vaste taak instellen: “${String(a?.title || '').slice(0, 80)}”${a?.every_minutes ? ` (elke ${a.every_minutes} min)` : Array.isArray(a?.times) ? ` (${a.times.join(', ')})` : ''}`,
    async run(a, t) {
      const title = String(a?.title || '').trim().slice(0, 80);
      const check = String(a?.check || '').trim();
      if (!title || !check) return { text: 'Geef een title en check (wat je controleert).', isError: true };
      if (a?.measure && !cleanMeasure(a.measure)) return { text: 'De meting klopt niet. url: een http(s)-adres. tool: tool, op en value. query: één SELECT zonder puntkomma, op en value. Laat measure weg als je zelf meet.', isError: true };
      const existing = duties.duties(t.userId, t.agent.id).find((r) => r.name.toLowerCase() === title.toLowerCase());
      try {
        const body = { key: existing?.options.duty?.key || 'eigen', title, check, source: a?.measure?.kind === 'url' ? 'web' : 'team', okWhen: String(a?.ok_when || ''), onProblem: a?.on_problem, days: a?.days, times: a?.times, everyMinutes: a?.every_minutes, measure: a?.measure } as any;
        if (existing) engine.remove(existing, { deleteThread: true });
        const r = duties.create(t.userId, t.agent.id, body);
        const { describeSchedule } = await import('../schedule.js');
        t.ctx.events.emit(t.userId, 'notification', { title: `${t.agent.name} heeft een vaste taak ${existing ? 'bijgewerkt' : 'ingesteld'}`, body: `${r.name} · ${describeSchedule(r.schedule, r.timezone)}`, link: '#/m/routines/werk', kind: 'routine', routineId: r.id, agentId: t.agent.id });
        return { text: `Vaste taak “${r.name}” staat aan: ${describeSchedule(r.schedule, r.timezone)}.${r.options.duty?.measure ? ' TeamBot meet zelf; je wordt alleen gewekt als het niet in orde is.' : ''} De eigenaar ziet hem bij Werk en kan hem aanpassen.`, data: { routineId: r.id } };
      } catch (e: any) {
        if (e instanceof HttpishError || e instanceof ScheduleError) return { text: `Kon de vaste taak niet instellen: ${e.message}`, isError: true };
        throw e;
      }
    },
  };

  const unset: ToolDef = {
    name: 'duty_remove',
    group: REMINDER_GROUP.id,
    risk: 'write',
    internal: true,
    description: 'Haal een vaste taak van jezelf weg (een deel van de naam is genoeg). Zonder title: toon je vaste taken.',
    parameters: { type: 'object', properties: { title: { type: 'string' } } },
    summarize: (a) => (a?.title ? `Vaste taak weghalen: “${String(a.title).slice(0, 60)}”` : 'Vaste taken bekijken'),
    async run(a, t) {
      const mine = duties.duties(t.userId, t.agent.id);
      const q = String(a?.title || '').trim().toLowerCase();
      const line = (r: (typeof mine)[number]) => `- ${r.name} · ${r.status === 'active' ? 'aan' : 'uit'}${r.last_summary ? ` · laatst: ${r.last_summary.slice(0, 120)}` : ''}`;
      if (!q) return mine.length ? `Je vaste taken:\n${mine.map(line).join('\n')}` : 'Je hebt geen vaste taken.';
      const hit = mine.filter((r) => r.name.toLowerCase().includes(q));
      if (hit.length !== 1) return { text: hit.length ? `Meer dan één vaste taak past bij “${q}”:\n${hit.map(line).join('\n')}` : `Geen vaste taak gevonden met “${q}”.`, isError: true };
      engine.remove(hit[0], { deleteThread: true });
      return `Vaste taak weggehaald: “${hit[0].name}”.`;
    },
  };

  return { static: [remind, cancel, set, unset], report };
}

/** The owner's side: the one budget setting, the duties per bot, and a duty of his own. */
export function dutyRoutes(ctx: Ctx, engine: RoutineEngine, duties: DutyService) {
  const teamOf = (q: any) => (typeof q === 'string' && q.trim() && q !== 'all' ? q.trim().slice(0, 80) : null);
  ctx.api.get('/proactive/settings', ah(async (req) => ({ settings: duties.settings(user(req).id), budget: duties.budget(user(req).id) })));
  ctx.api.put('/proactive/settings', ah(async (req) => ({ settings: duties.setSettings(user(req).id, req.body || {}), budget: duties.budget(user(req).id) })));
  ctx.api.get(
    '/proactive/duties',
    ah(async (req) => {
      const u = user(req);
      duties.seed(u.id);
      return { duties: await duties.views(u.id, teamOf(req.query.teamId)), budget: duties.budget(u.id), settings: duties.settings(u.id), sources: SOURCE_LABEL, presets: duties.presets(u.id).map((r) => ({ id: r.id, label: r.label })) };
    }),
  );
  // Presets: which duties a kind of bot gets. The built-in ones and the owner's own are the same thing.
  ctx.api.get('/proactive/presets', ah(async (req) => ({ presets: duties.presets(user(req).id), own: duties.ownPresets(user(req).id).map((p) => p.id) })));
  ctx.api.put(
    '/proactive/presets',
    ah(async (req) => {
      const u = user(req);
      duties.setPresets(u.id, req.body?.presets);
      duties.seed(u.id);
      return { presets: duties.presets(u.id), own: duties.ownPresets(u.id).map((p) => p.id) };
    }),
  );
  ctx.api.post(
    '/proactive/duties',
    ah(async (req) => {
      const u = user(req);
      const b = req.body || {};
      const agent = ctx.store.agent(str(b.agentId, 80));
      if (!agent || agent.user_id !== u.id) throw notFound('Bot niet gevonden');
      const title = str(b.title, 80).trim();
      if (!title) throw bad('Geef de vaste taak een naam');
      try {
        const r = duties.create(u.id, agent.id, { key: 'eigen', title, check: str(b.check, 1000), source: b.source, okWhen: str(b.okWhen, 500), onProblem: b.onProblem, days: b.days, times: b.times, everyMinutes: b.everyMinutes, measure: b.measure } as any);
        return engine.view(r);
      } catch (e: any) {
        if (e instanceof HttpishError) throw new HttpError(e.status, e.message);
        throw bad(String(e?.message || e));
      }
    }),
  );
}
