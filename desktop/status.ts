/**
 * Desktop notifications with buttons + the optional floating status window ("eiland").
 *
 * Notifications: the server's `notification` events (approvals, questions, usage limits, rooms …) become Windows
 * notifications while the TeamBot window is not in front, with buttons where that is safe:
 *   - approval of a normal action: Goedkeuren / Weigeren / Bekijken. Clicking a button IS the owner deciding (the
 *     desktop app has one local owner); TeamBot never approves anything by itself.
 *   - approval with impact (send, publish, delete, pay): only Bekijken / Weigeren — you see the details first.
 *   - a question: Beantwoorden (opens the chat).
 * A long task the owner started that finishes (or fails) while the window is in the background is notified too.
 *
 * Status window: a small always-on-top window with the running bots, what they do and what waits for the owner,
 * with stop (the UI page #/m/usage/eiland). Mode off / auto (only while something runs or waits) / always.
 */
import { BrowserWindow, Notification, screen } from 'electron';
import type { AppHandle } from '../server/app.js';
import { tr, trUserText, userLanguage } from '../server/core/i18n.js';
import { PendingNotes } from './notes.js';

export type StatusMode = 'off' | 'auto' | 'always';
const MODES = new Set<StatusMode>(['off', 'auto', 'always']);
const DONE_AFTER_MS = 60_000;

interface Deps {
  handle(): AppHandle | null;
  baseUrl(): string;
  icon(): string;
  preload: string;
  /** Bring the main window to the front, optionally at a route. */
  show(hash?: string): void;
  isAppUrl(u: string): boolean;
  /** The main window is visible and focused (then the in-app toast is enough). */
  mainFocused(): boolean;
  onModeChange(): void;
}

export class DesktopStatus {
  private live = new Set<Notification>();
  /** Notifications of approvals and questions: closed once they are decided elsewhere (phone, other window). */
  private pending = new PendingNotes<Notification>();
  private off: (() => void) | null = null;
  private win: BrowserWindow | null = null;
  private hiddenByUser = false;
  private evalTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private boundsTimer: NodeJS.Timeout | null = null;

  constructor(private d: Deps) {}

  private owner() {
    return this.d.handle()?.ctx.auth.owner() || null;
  }

  start() {
    const h = this.d.handle();
    if (!h) return;
    this.off = h.ctx.events.subscribe((e) => {
      const o = this.owner();
      if (!o || (e.userId !== o.id && e.userId !== '*')) return;
      if (e.type === 'notification') this.notify(e.data || {});
      else if (e.type === 'run.updated') this.runUpdated(e.data);
      else if (e.type === 'approval.updated') this.pending.approvalUpdated(e.data);
      if (e.type === 'run.updated' || e.type === 'approval.created' || e.type === 'approval.updated') {
        if (e.type === 'approval.created' || (e.type === 'run.updated' && e.data?.status === 'queued')) this.hiddenByUser = false;
        this.scheduleEval();
      }
    });
    this.scheduleEval();
  }

  stop() {
    this.off?.();
    this.off = null;
    for (const n of this.live) n.close();
    this.live.clear();
    this.pending.clear();
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  // ---------------- notifications ----------------

  private keep(n: Notification) {
    // Electron drops the click/action handlers when the object is garbage collected.
    this.live.add(n);
    const drop = () => {
      this.live.delete(n);
      this.pending.forget(n);
    };
    n.on('close', drop);
    n.on('failed', drop);
    setTimeout(drop, 10 * 60_000).unref?.();
  }

  private safeHash(link: unknown): string | undefined {
    const s = typeof link === 'string' ? link : '';
    const h = s.startsWith('#') ? s : s ? '#' + s : '';
    return /^#\/[\w\-/.?=&%]{0,200}$/.test(h) ? h : undefined;
  }

  private notify(n: { title?: string; body?: string; link?: string; kind?: string; approvalId?: string }) {
    if (!Notification.isSupported() || this.d.mainFocused()) return;
    const h = this.d.handle();
    const o = this.owner();
    if (!h || !o) return;
    // Meldingen: a bot set to "alleen belangrijk" or "niets" stays quiet here too (it is still in the history).
    const nt = h.ctx.services.notifications;
    if (nt && !nt.shouldAlert(o.id, n)) return;
    const quiet = !!nt && !nt.sound(o.id);
    // Desktop notifications are not part of the page: translate them here (the owner's interface language).
    const lang = userLanguage(h.ctx.store, o.id);
    const hash = this.safeHash(n.link) || '#/inbox';
    type Act = { text: string; run(): void };
    const acts: Act[] = [];
    const apr = n.kind === 'approval' && n.approvalId ? h.ctx.store.get<any>('approvals', n.approvalId) : null;
    if (apr && apr.status === 'pending') {
      const decide = (decision: 'approve' | 'deny') => () => {
        try {
          const cur = h.ctx.store.get<any>('approvals', apr.id);
          if (!cur || cur.status !== 'pending') throw new Error(tr(lang, 'Dit verzoek is al afgehandeld'));
          h.ctx.broker.resolve(apr.id, o.id, decision);
        } catch (e: any) {
          new Notification({ title: 'TeamBot', body: String(e?.message || e).slice(0, 200), silent: true }).show();
        }
      };
      if (apr.kind === 'question') acts.push({ text: tr(lang, 'Beantwoorden'), run: () => this.d.show(hash) });
      else if (apr.risk === 'danger') acts.push({ text: tr(lang, 'Bekijken'), run: () => this.d.show(hash) }, { text: tr(lang, 'Weigeren'), run: decide('deny') });
      else acts.push({ text: tr(lang, 'Goedkeuren'), run: decide('approve') }, { text: tr(lang, 'Weigeren'), run: decide('deny') }, { text: tr(lang, 'Bekijken'), run: () => this.d.show(hash) });
    }
    const note = new Notification({
      title: trUserText(h.ctx.store, o.id, String(n.title || 'TeamBot').slice(0, 120)),
      body: trUserText(h.ctx.store, o.id, String(n.body || '').slice(0, 300)),
      icon: this.d.icon() || undefined,
      silent: n.kind === 'limit' || quiet,
      actions: acts.map((a) => ({ type: 'button' as const, text: a.text })),
      ...(n.approvalId ? { id: `apr-${n.approvalId}` } : {}),
    });
    note.on('click', () => this.d.show(hash));
    note.on('action', (details: any, legacyIndex?: number) => {
      const i = typeof details?.actionIndex === 'number' ? details.actionIndex : legacyIndex;
      acts[i ?? -1]?.run();
    });
    this.keep(note);
    if (apr && apr.status === 'pending') this.pending.add(apr.id, note);
    note.show();
  }

  private runUpdated(r: any) {
    if (!r || (r.status !== 'done' && r.status !== 'error') || this.d.mainFocused() || !Notification.isSupported()) return;
    if (r.trigger && r.trigger !== 'user' && r.trigger !== 'retry') return;
    const took = r.finished_at && r.started_at ? Date.parse(r.finished_at) - Date.parse(r.started_at) : 0;
    if (r.status === 'done' && took < DONE_AFTER_MS) return;
    const h = this.d.handle();
    const o = this.owner();
    const nt = h?.ctx.services.notifications;
    if (nt && o && !nt.shouldAlert(o.id, { kind: 'run', agentId: r.agent_id, level: r.status === 'error' ? 'error' : undefined })) return;
    const a = h?.ctx.store.agent(r.agent_id);
    const hash = `#/t/${r.thread_id}`;
    const lang = userLanguage(h?.ctx.store, o?.id);
    const name = a?.name || tr(lang, 'Je bot');
    const note = new Notification({
      title: r.status === 'done' ? tr(lang, '{0} is klaar', name) : r.meta?.budget ? tr(lang, '{0} heeft de daglimiet bereikt', name) : tr(lang, '{0} liep vast', name),
      body: r.status === 'done' ? tr(lang, 'Na {0} min. Klik om het antwoord te zien.', Math.round(took / 60_000)) : trUserText(h?.ctx.store, o?.id, String(r.error || 'Er ging iets mis.').slice(0, 200)),
      icon: this.d.icon() || undefined,
      silent: !!nt && !!o && !nt.sound(o.id),
      actions: [{ type: 'button', text: tr(lang, 'Openen') }],
    });
    note.on('click', () => this.d.show(hash));
    note.on('action', () => this.d.show(hash));
    this.keep(note);
    note.show();
  }

  // ---------------- floating status window ----------------

  mode(): StatusMode {
    const o = this.owner();
    const m = o ? this.d.handle()?.ctx.store.getSetting<string>(o.id, 'desktopStatusWindow', 'off') : 'off';
    return MODES.has(m as StatusMode) ? (m as StatusMode) : 'off';
  }

  setMode(m: string): StatusMode {
    const o = this.owner();
    const mode: StatusMode = MODES.has(m as StatusMode) ? (m as StatusMode) : 'off';
    if (o) this.d.handle()?.ctx.store.setSetting(o.id, 'desktopStatusWindow', mode);
    this.hiddenByUser = false;
    this.scheduleEval(0);
    this.d.onModeChange();
    return mode;
  }

  /** The window's own close button: hide until something new happens (auto) or until switched on again. */
  hide() {
    this.hiddenByUser = true;
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }

  private busy(): boolean {
    const h = this.d.handle();
    const o = this.owner();
    if (!h || !o) return false;
    return h.ctx.runs.activeRuns(o.id).length > 0 || !!h.ctx.store.one("SELECT 1 FROM approvals WHERE user_id = ? AND status = 'pending'", o.id);
  }

  private scheduleEval(ms = 300) {
    if (this.evalTimer) clearTimeout(this.evalTimer);
    this.evalTimer = setTimeout(() => {
      this.evalTimer = null;
      this.evaluate();
    }, ms);
  }

  private evaluate() {
    const mode = this.mode();
    if (mode === 'off') {
      if (this.win && !this.win.isDestroyed()) this.win.destroy();
      this.win = null;
      return;
    }
    const want = !this.hiddenByUser && (mode === 'always' || this.busy());
    if (want) {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = null;
      const w = this.ensure();
      if (!w.isVisible()) w.showInactive();
    } else if (this.win && !this.win.isDestroyed() && this.win.isVisible() && !this.idleTimer) {
      // Let "klaar" sink in for a moment before the window goes away.
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        if (this.mode() !== 'always' && !this.busy()) this.win?.hide();
      }, this.hiddenByUser ? 0 : 6000);
    }
  }

  private ensure(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const o = this.owner();
    const saved = o ? this.d.handle()?.ctx.store.getSetting<any>(o.id, 'desktopStatusBounds', null) : null;
    const wa = screen.getPrimaryDisplay().workArea;
    const W = 340;
    const H = 400;
    const onScreen = saved && screen.getAllDisplays().some((d) => saved.x >= d.workArea.x - 20 && saved.y >= d.workArea.y - 20 && saved.x < d.workArea.x + d.workArea.width - 60 && saved.y < d.workArea.y + d.workArea.height - 40);
    const b = onScreen ? { x: saved.x, y: saved.y, width: Math.max(280, Math.min(600, saved.width || W)), height: Math.max(160, Math.min(900, saved.height || H)) } : { x: wa.x + wa.width - W - 16, y: wa.y + wa.height - H - 16, width: W, height: H };
    const w = new BrowserWindow({
      ...b,
      minWidth: 280,
      minHeight: 160,
      frame: false,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      title: 'TeamBot — nu bezig',
      icon: this.d.icon() || undefined,
      backgroundColor: '#f4f3f6',
      webPreferences: { preload: this.d.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
    });
    w.setAlwaysOnTop(true, 'floating');
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', (e, url) => {
      if (!this.d.isAppUrl(url)) e.preventDefault();
    });
    const remember = () => {
      if (this.boundsTimer) clearTimeout(this.boundsTimer);
      this.boundsTimer = setTimeout(() => {
        const ow = this.owner();
        if (ow && !w.isDestroyed()) this.d.handle()?.ctx.store.setSetting(ow.id, 'desktopStatusBounds', w.getBounds());
      }, 500);
    };
    w.on('moved', remember);
    w.on('resized', remember);
    w.on('closed', () => {
      if (this.win === w) this.win = null;
    });
    w.loadURL(`${this.d.baseUrl()}/#/m/usage/eiland`);
    this.win = w;
    return w;
  }
}
