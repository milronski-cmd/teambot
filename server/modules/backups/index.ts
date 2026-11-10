import fs from 'node:fs';
import path from 'node:path';
import type { Ctx, Module } from '../../core/types.js';
import { ah, bad, requireRole } from '../../core/http.js';
import { BackupService, NAME, type Job } from './service.js';
import { PENDING_MARKER, restorable } from './files.js';
import { whatsNew } from './changelog.js';
import { Offsite } from './offsite.js';
import { patchUpdateState, readUpdateState, recordStart, rollbackInfo, type UpdateEntry } from './updates.js';
import { registerAppUpdate } from './app-update.js';

/**
 * Back-ups (Instellingen › Back-ups) and updates of TeamBot itself (package N). See docs/modules/backups.md.
 *  - full app backup now / daily automatic (keep N) / restore with one click (desktop restarts by itself);
 *  - a backup before every TeamBot update (ctx.services.backups.beforeUpdate, called by desktop/main.ts);
 *  - after an update "Wat is er nieuw" from the changelog and, in the Windows app, "Terug naar versie x".
 */

let service: BackupService | null = null;

const mod: Module = {
  id: 'backups',
  label: 'Back-ups',

  init(ctx) {
    const svc = new BackupService(ctx);
    service = svc;
    // The encrypted copy to a second place after each backup, when the owner set that up (offsite.ts).
    const offsite = new Offsite(ctx, svc);
    svc.onCreated = (b) => void offsite.afterBackup(b);
    const admin = (req: any) => requireRole(req, 'admin');
    const owner = (req: any) => {
      const u = admin(req);
      if (u.role !== 'owner') throw bad('Alleen de eigenaar kan een back-up terugzetten');
      return u;
    };
    // A staged restore whose database is gone (cancelled through core's route) leaves no marker behind.
    if (!fs.existsSync(path.join(ctx.config.dataDir, 'restore-pending.db'))) fs.rmSync(path.join(ctx.config.dataDir, PENDING_MARKER), { force: true });

    // Download the database of a backup (the page's "Downloaden"; the name is checked against the fixed pattern).
    ctx.api.get(
      '/admin/backups/:name',
      ah(async (req, res) => {
        admin(req);
        const name = String(req.params.name);
        if (!NAME.test(name) || !svc.exists(name)) throw bad('Back-up niet gevonden');
        res.setHeader('content-type', 'application/octet-stream');
        res.setHeader('content-disposition', `attachment; filename="${name}"`);
        fs.createReadStream(path.join(svc.dir(), name)).pipe(res);
      }),
    );

    const progress = (userId: string) => (j: Job) => ctx.events.emit(userId, 'backups.progress', j);
    const backupExists = (name: string) => svc.exists(name.endsWith('.db') ? name : `${name}.db`);
    const updatesView = () => {
      const s = readUpdateState(ctx.config.dataDir);
      const v = ctx.config.version;
      const last: UpdateEntry | undefined = s.history[0];
      const news = last && last.to === v ? whatsNew(v, last.kind === 'update' ? last.from : undefined) : whatsNew(v);
      return {
        version: v,
        last: last || null,
        history: s.history.slice(0, 10),
        failed: s.failed || null,
        whatsNew: news,
        seen: s.seen === v,
        rollback: rollbackInfo(ctx.config.dataDir, v, { desktop: ctx.config.mode === 'desktop', backupExists }),
      };
    };

    ctx.api.get(
      '/backups',
      ah(async (req) => {
        admin(req);
        const plan = await svc.plan(req.query.fresh === '1');
        return {
          items: svc.list(),
          settings: svc.settings(),
          plan: plan.map((p) => ({ id: p.id, label: p.label, kind: p.kind, reason: p.reason, exists: p.exists, bytes: p.bytes, files: p.files, truncated: !!p.truncated, unknown: !!p.unknown })),
          job: svc.job,
          pending: svc.pending(),
          lastRestore: svc.lastRestore(),
          keys: keyInfo(ctx),
          dbBytes: svc.dbBytes(),
          mode: ctx.config.mode,
          dataDir: ctx.config.dataDir,
          offsite: offsite.view(),
        };
      }),
    );

    ctx.api.put(
      '/backups/settings',
      ah(async (req) => {
        const u = admin(req);
        const s = svc.saveSettings(req.body || {});
        ctx.audit(u.id, 'backup.settings', { auto: s.auto, keep: s.keep, includeWork: s.includeWork });
        return s;
      }),
    );

    /** Make a backup now. Answers at once with the job (progress as "backups.progress"); `wait: true` waits for it. */
    ctx.api.post(
      '/backups',
      ah(async (req) => {
        const u = admin(req);
        if (svc.job && (svc.job.phase === 'database' || svc.job.phase === 'files')) throw bad('Er wordt al een back-up gemaakt. Wacht tot die klaar is.');
        const includeWork = req.body?.includeWork === true;
        const p = svc.make({ kind: 'manual', includeWork, onProgress: progress(u.id) }).then(
          (b) => {
            ctx.audit(u.id, 'backup.created', { name: b.name, bytes: b.bytes, includesWork: b.includesWork });
            ctx.events.emit(u.id, 'backups.updated', { name: b.name });
            return b;
          },
          (e) => {
            ctx.events.emit(u.id, 'backups.updated', { error: e?.message || String(e) });
            throw e;
          },
        );
        if (req.body?.wait === true) return { backup: await p };
        p.catch(() => {});
        return { job: svc.job };
      }),
    );

    ctx.api.post(
      '/backups/:name/restore',
      ah(async (req) => {
        const u = owner(req);
        const name = String(req.params.name);
        const m = svc.stageRestore(name, { by: u.id, reason: 'restore' });
        ctx.audit(u.id, 'backup.restore_staged', { name });
        return { ok: true, pending: m, restartNeeded: true, canRestart: ctx.config.mode === 'desktop' };
      }),
    );

    ctx.api.delete(
      '/backups/pending',
      ah(async (req) => {
        admin(req);
        svc.cancelRestore();
        return { ok: true };
      }),
    );

    // ---------------------------------------------------------------- a second place, encrypted (offsite.ts)

    ctx.api.get(
      '/backups/offsite',
      ah(async (req) => {
        admin(req);
        return offsite.view();
      }),
    );
    ctx.api.put(
      '/backups/offsite',
      ah(async (req) => {
        const u = owner(req);
        const b = req.body || {};
        const v = offsite.save({ folder: typeof b.folder === 'string' ? b.folder : undefined, auto: typeof b.auto === 'boolean' ? b.auto : undefined, password: typeof b.password === 'string' ? b.password : undefined });
        ctx.audit(u.id, 'backup.offsite_settings', { folder: v.folder, auto: v.auto, password: typeof b.password === 'string' ? 'changed' : 'kept' });
        return v;
      }),
    );
    ctx.api.delete(
      '/backups/offsite',
      ah(async (req) => {
        const u = owner(req);
        ctx.audit(u.id, 'backup.offsite_cleared', {});
        return offsite.clear();
      }),
    );
    ctx.api.post(
      '/backups/offsite/copy',
      ah(async (req) => {
        const u = admin(req);
        const name = typeof req.body?.name === 'string' && NAME.test(req.body.name) ? req.body.name : undefined;
        const r = await offsite.copy(name);
        ctx.audit(u.id, 'backup.offsite_copy', { file: r.file, bytes: r.bytes });
        return { ...r, view: offsite.view() };
      }),
    );
    ctx.api.post(
      '/backups/offsite/import',
      ah(async (req) => {
        const u = owner(req);
        const item = await offsite.importFile(String(req.body?.file || ''), String(req.body?.password || ''));
        ctx.audit(u.id, 'backup.offsite_import', { name: item.name });
        return { backup: item };
      }),
    );

    ctx.api.delete(
      '/backups/:name',
      ah(async (req) => {
        const u = admin(req);
        const name = String(req.params.name);
        if (!NAME.test(name)) throw bad('Ongeldige naam');
        svc.remove(name);
        ctx.audit(u.id, 'backup.deleted', { name });
        return { ok: true };
      }),
    );

    // ---------------------------------------------------------------- updates of TeamBot itself

    ctx.api.get(
      '/backups/updates',
      ah(async (req) => {
        requireRole(req, 'member');
        const v = updatesView();
        // Members see what is new; the way back and the history are for the owner and admins.
        if ((req as any).user?.role === 'member') return { version: v.version, whatsNew: v.whatsNew, seen: v.seen };
        return v;
      }),
    );

    ctx.api.post(
      '/backups/updates/seen',
      ah(async (req) => {
        admin(req);
        patchUpdateState(ctx.config.dataDir, (s) => {
          s.seen = ctx.config.version;
          s.failed = null;
        });
        return { ok: true };
      }),
    );

    // Automatic updates of TeamBot itself: status, Nu bijwerken, Automatisch bijwerken, the channel (app-update.ts).
    registerAppUpdate(ctx);

    ctx.services.backups = {
      service: svc,
      list: () => svc.list(),
      make: (o: Parameters<BackupService['make']>[0]) => svc.make(o),
      /** Right before a TeamBot update (desktop/main.ts): database, team databases and key; fast. */
      beforeUpdate: (o: { from: string; to: string }) => svc.make({ kind: 'update', dataOnly: true, label: `Voor de update naar ${o.to}`, update: o }),
      stageRestore: (name: string, o?: { by?: string; reason?: 'restore' | 'rollback' }) => svc.stageRestore(name, o),
      rollbackInfo: () => rollbackInfo(ctx.config.dataDir, ctx.config.version, { desktop: ctx.config.mode === 'desktop', backupExists }),
      restorable,
    };
  },

  start(ctx) {
    const svc = service;
    if (!svc) return;
    // After a restore: indexes and a note. This module starts after memory and history (modules/index.ts), so what was
    // forgotten or wiped is gone again before the indexes are rebuilt.
    try {
      svc.afterRestore();
    } catch (e) {
      ctx.log.error('[backups] na het terugzetten', e);
    }
    noteVersionChange(ctx);
    startSchedule(ctx, svc);
  },

  stop() {
    stopSchedule?.();
    stopSchedule = null;
  },
};

/** What the owner should know about the stored keys in a backup (plain words, by platform). */
function keyInfo(ctx: Ctx): { kind: 'dpapi' | 'keychain' | 'secret-service' | 'file' | 'env'; text: string } {
  const d = ctx.config.dataDir;
  if (process.env.TEAMBOT_MASTER_KEY) return { kind: 'env', text: 'Opgeslagen sleutels en wachtwoorden zijn versleuteld met de sleutel uit TEAMBOT_MASTER_KEY. Die zit niet in de back-up: bewaar hem zelf. Zonder die sleutel moet je ze na het terugzetten opnieuw invoeren.' };
  if (fs.existsSync(path.join(d, 'master.key.dpapi')))
    return { kind: 'dpapi', text: 'Opgeslagen sleutels en wachtwoorden blijven versleuteld. Ze werken na het terugzetten alleen op deze computer met hetzelfde Windows-account. Op een andere computer of na een nieuwe Windows-installatie voer je ze opnieuw in.' };
  if (fs.existsSync(path.join(d, 'master.key.keychain')) || fs.existsSync(path.join(d, 'master.key.secret-service')))
    return { kind: fs.existsSync(path.join(d, 'master.key.keychain')) ? 'keychain' : 'secret-service', text: 'Opgeslagen sleutels en wachtwoorden blijven versleuteld en werken na het terugzetten alleen met dezelfde gebruiker op deze computer. Elders voer je ze opnieuw in.' };
  return { kind: 'file', text: 'Opgeslagen sleutels en wachtwoorden blijven versleuteld met master.key uit de datamap. Dat bestand zit niet in de back-up: bewaar het zelf op een veilige plek, anders voer je ze op een andere computer opnieuw in.' };
}

/** Tell the owner once when TeamBot was updated, went back, or an update did not happen. */
function noteVersionChange(ctx: Ctx) {
  const r = recordStart(ctx.config.dataDir, ctx.config.version);
  const owner = ctx.auth.owner();
  if (!owner) return;
  if (r.changed) {
    const c = r.changed;
    ctx.audit(owner.id, c.kind === 'update' ? 'backup.app_updated' : 'backup.rollback', { from: c.from, to: c.to, backup: c.backup || null });
    ctx.events.emit(owner.id, 'notification', {
      title: c.kind === 'update' ? `TeamBot is bijgewerkt naar ${c.to}` : `TeamBot is terug op versie ${c.to}`,
      body:
        c.kind === 'update'
          ? c.backup
            ? `Bekijk wat er nieuw is. Vooraf is een back-up gemaakt; gaat er iets mis, dan kun je terug naar ${c.from}.`
            : 'Bekijk wat er nieuw is.'
          : c.backup
            ? 'Je gegevens van vlak voor de update zijn teruggezet. De stand van daarna is bewaard als veiligheidskopie.'
            : `TeamBot draait weer op versie ${c.to}.`,
      link: '#/m/backups/nieuw',
      kind: 'system',
    });
  } else if (r.failed) {
    const f = r.failed;
    ctx.events.emit(owner.id, 'notification', {
      title: f.kind === 'update' ? `De update naar TeamBot ${f.to} is niet geïnstalleerd` : `Terug naar TeamBot ${f.to} is niet gelukt`,
      body:
        f.kind === 'update'
          ? `TeamBot draait nog op versie ${ctx.config.version}. Er is niets veranderd; de back-up van vooraf staat bij je back-ups.`
          : `TeamBot draait nog op versie ${ctx.config.version}. Je gegevens van vlak voor de update zijn wel teruggezet; installeer versie ${f.to} zelf als je die wilt.`,
      link: '#/settings/backups-app',
      kind: 'warning',
    });
  }
}

let stopSchedule: (() => void) | null = null;

/** Daily automatic backup while TeamBot runs (first check two minutes after start, then every hour). */
function startSchedule(ctx: Ctx, svc: BackupService) {
  stopSchedule?.();
  const run = async () => {
    const s = svc.settings();
    if (!s.auto) return;
    const last = svc.list().find((b) => b.kind === 'auto');
    if (last && Date.now() - Date.parse(last.createdAt) < 23 * 3600_000) return;
    try {
      const b = await svc.make({ kind: 'auto', includeWork: s.includeWork });
      ctx.log.info(`[backups] automatische back-up gemaakt: ${b.name}`);
    } catch (e: any) {
      ctx.log.error('[backups] automatische back-up mislukt', e?.message || e);
      const owner = ctx.auth.owner();
      if (owner) ctx.events.emit(owner.id, 'notification', { title: 'Automatische back-up mislukt', body: String(e?.message || e).slice(0, 300), link: '#/settings/backups-app', kind: 'warning' });
    }
  };
  const first = setTimeout(() => void run(), 2 * 60_000);
  const every = setInterval(() => void run(), 3600_000);
  first.unref?.();
  every.unref?.();
  stopSchedule = () => {
    clearTimeout(first);
    clearInterval(every);
  };
}

export default mod;
