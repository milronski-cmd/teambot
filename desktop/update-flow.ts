/**
 * Safe, automatic updates of the desktop app (REL-03, package N, parity 16.2), without any Electron import so the whole
 * flow is tested with a fake updater (tests/update-safety.test.ts, tests/app-update.test.ts) and with the real
 * electron-updater against a local feed (tests/update-feed.test.ts). desktop/updater.ts plugs in electron-updater and
 * Electron; the server shows it in Instellingen › Back-ups (server/modules/backups/app-update.ts, /api/app-update).
 *
 * - The channel (desktop/update-channel.ts): TEAMBOT_UPDATE_CHANNEL / TEAMBOT_UPDATE_URL (environment), else the one
 *   the owner typed (Instellingen › Back-ups › Geavanceerd), else the one built into the release (package.json
 *   build.publish → app-update.yml). A folder on a web server (https) or GitHub Releases. No channel: off, and the page
 *   calmly says new versions come with the next installer.
 * - Automatisch bijwerken (`auto`): "on" (default) looks once a day, downloads in the background and installs when
 *   desktop/update-idle.ts allows it (never during a task; the owner away 15 min or the screen locked); "notify" looks
 *   once a day and only says so; "off" never looks by itself. Every mode installs a downloaded update at the next quit,
 *   and "Nu bijwerken" installs as soon as no task runs.
 * - The download is checked against the sha512 in latest.yml (and, once signed, the publisher's signature).
 * - Before every install a backup is made (desktop/main.ts → prepareInstall); without that backup there is no install.
 *   electron-updater's own install-on-quit is off, so nothing can install around this step.
 * - The installer of the new version and the one of the running version are kept in `<data>/updates/installers/`,
 *   so "Terug naar versie x" can reinstall the previous version and put the pre-update backup back. electron-updater
 *   never downgrades: the way back runs the kept, re-verified installer itself (startRollback/finishRollback). After
 *   the way back, the version the owner left is never installed again by itself (`skipped`), only on "Nu bijwerken".
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  compareVersions,
  installerName,
  keepInstallerFile,
  keptInstaller,
  patchUpdateState,
  readUpdateState,
  rollbackInfo,
  validVersion,
  verifyKept,
  type KeptInstaller,
} from '../server/modules/backups/updates.js';
import { channelInput, channelText, feedError, feedOptions, installerUrl, parseChannel, type Channel } from './update-channel.js';
import { IDLE_POLL_MS, checkDue, installDecision, sameReasons, type AutoMode, type IdleFacts, type WaitReason } from './update-idle.js';

export type UpdateState =
  | { phase: 'off'; reason: string }
  | { phase: 'idle'; checkedAt?: string }
  | { phase: 'checking' }
  | { phase: 'available'; version: string; notes?: string }
  | { phase: 'downloading'; version: string; percent: number }
  | { phase: 'ready'; version: string }
  | { phase: 'error'; message: string };

interface Saved {
  /** 0.4.3 and earlier: a folder on a web server (read as `channel`). */
  feedUrl?: string;
  /** What the owner typed (parseChannel input); '' = no channel of my own (the built-in one applies). */
  channel?: string;
  auto?: AutoMode;
  /** The last check that got an answer, and the last try (also a failed one): once a day, after a failure an hour. */
  lastCheckAt?: string;
  lastTryAt?: string;
}

/** Where the channel in use comes from (the page says it; only `saved` is changed in Settings). */
export type ChannelSource = 'env' | 'saved' | 'built-in' | 'none';

/** The part of electron-updater's autoUpdater this flow uses (a fake in tests). */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  logger: unknown;
  /** NsisUpdater (Windows): checks the downloaded installer's signature when app-update.yml names a publisher. */
  verifyUpdateCodeSignature?: (publisherNames: string[], file: string) => Promise<string | null>;
  on(event: string, listener: (...args: any[]) => void): unknown;
  setFeedURL(o: any): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface FlowDeps {
  updater: UpdaterLike;
  /** Version of the running app. */
  version: string;
  packaged: boolean;
  /** update.json and update.log (Electron's userData). */
  configDir: string;
  /** TeamBot's data folder (`updates/` with the state and the kept installers). */
  dataDir: string;
  platform?: string;
  env?: NodeJS.ProcessEnv;
  notify?(title: string, body: string): void;
  /** Shell texts in the owner's language; Dutch source texts when not given. */
  t?(text: string, ...values: (string | number)[]): string;
  onChange?(): void;
  /** Quit the app: will-quit makes the backup and then runs install(). */
  requestQuit?(): void;
  /** Start an installer detached (the way back). Tests pass a fake; nothing else runs an installer. */
  spawnInstaller?(file: string, args: string[]): void;
  /** Runs a PowerShell script without a window and returns its output (signature check, see verifyPublisher). */
  powershell?(script: string): Promise<string>;
  /** The channel built into this version (app-update.yml → builtInChannel in desktop/update-channel.ts). */
  builtIn?: Channel | null;
  /** 0.4.3: the built-in channel as a folder address (defaultFeedUrl). `builtIn` wins. */
  defaultFeed?: string;
  /** What runs on the server and whether the owner is away (desktop/main.ts: updateBlockers + powerMonitor). */
  idleFacts?(): IdleFacts | null | Promise<IdleFacts | null>;
  /** Timings, for tests (defaults: first look 30 s after start, every hour whether a check is due, idle every minute). */
  timing?: { firstCheckMs?: number; tickMs?: number; idlePollMs?: number; idleSeconds?: number };
  /** Tests only: a local server that plays GitHub (desktop/update-channel.ts feedOptions). */
  githubHost?: string;
  fetch?: typeof fetch;
}

/** Arguments for a kept installer on the way back: like electron-updater runs it (keeps the data, starts TeamBot). */
export const ROLLBACK_ARGS = ['--updated', '/S', '--force-run'];
/** How often TeamBot asks itself whether the daily check is due (catches a pc that slept). */
const TICK_MS = 3600_000;

export interface Safety {
  /** The installer of the running version is kept (needed to come back here after the update). */
  current: { version: string; source: KeptInstaller['source'] } | null;
  /** The installer of the downloaded version is kept. */
  next: string | null;
  note?: string;
}

export interface RollbackPlan {
  to: string;
  backup: string;
  installer: KeptInstaller;
}

export class UpdateFlow {
  state: UpdateState = { phase: 'off', reason: 'Nog niet gestart' };
  safety: Safety = { current: null, next: null };
  /** What a downloaded update waits for before it installs by itself (or after "Nu bijwerken"). */
  waitingFor: WaitReason[] = [];
  /** "Nu bijwerken" was chosen: install as soon as no task runs (the owner's presence does not matter). */
  soon = false;
  private file: string;
  private timers: NodeJS.Timeout[] = [];
  private idleTimer: NodeJS.Timeout | null = null;
  private listeners = new Set<(s: UpdateState) => void>();
  private log: (line: string) => void;
  private installing = false;
  private autoQuit = false;
  private evaluating = false;
  private rollback: RollbackPlan | null = null;
  private downloaded: { version: string; file?: string; sha512?: string; fileName?: string } | null = null;
  /** Background work after a download (keeping installers); awaited before an install. */
  private keeping: Promise<void> | null = null;
  requestQuit?: () => void;

  constructor(protected deps: FlowDeps) {
    this.file = path.join(deps.configDir, 'update.json');
    const logFile = path.join(deps.configDir, 'update.log');
    this.log = (line) => {
      try {
        fs.mkdirSync(deps.configDir, { recursive: true });
        fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
      } catch {
        /* ignore */
      }
    };
    this.requestQuit = deps.requestQuit;
    const u = deps.updater;
    u.autoDownload = false;
    // Installing happens only from will-quit, after the backup (prepareInstall). electron-updater's own install on quit
    // would run the installer without one, also when TeamBot exits because the backup failed.
    u.autoInstallOnAppQuit = false;
    u.allowDowngrade = false;
    // Once the installer is signed (docs/IOS_WINDOWS_RELEASE.md), app-update.yml names the publisher and every update
    // is checked against it: with our check, which runs hidden and refuses when it cannot check.
    if (deps.powershell && 'verifyUpdateCodeSignature' in u) {
      const ps = deps.powershell;
      u.verifyUpdateCodeSignature = async (names, file) => {
        const r = await verifyPublisher(names, file, ps);
        this.log(r ? `signature refused: ${r}` : `signature ok: ${path.basename(file)}`);
        return r;
      };
    }
    u.logger = { info: (m: any) => this.log(`info ${m}`), warn: (m: any) => this.log(`warn ${m}`), error: (m: any) => this.log(`error ${m}`), debug: () => {} };
    u.on('checking-for-update', () => this.set({ phase: 'checking' }));
    u.on('update-not-available', () => {
      this.soon = false;
      const at = new Date().toISOString();
      this.remember({ lastCheckAt: at });
      this.set({ phase: 'idle', checkedAt: at });
    });
    u.on('update-available', (i: any) => {
      this.remember({ lastCheckAt: new Date().toISOString() });
      const version = String(i?.version || '');
      this.set({ phase: 'available', version, notes: typeof i?.releaseNotes === 'string' ? i.releaseNotes.slice(0, 2000) : undefined });
      const byItself = this.config().auto === 'on' && version !== this.skipped();
      if (this.env.TEAMBOT_UPDATE_TEST === '1' || byItself || this.soon) {
        // In the background; the owner hears about it once it is ready.
        void this.download();
        return;
      }
      deps.notify?.(this.t('TeamBot {0} is beschikbaar', version), this.t('Kies in Instellingen › Back-ups "Nu bijwerken". Vooraf maakt TeamBot een back-up.'));
    });
    u.on('download-progress', (p: any) => {
      const cur = this.state;
      if (cur.phase === 'downloading' || cur.phase === 'available') this.set({ phase: 'downloading', version: cur.version, percent: Math.round(p.percent) });
    });
    u.on('update-downloaded', (i: any) => {
      const f = Array.isArray(i?.files) ? i.files[0] : null;
      this.downloaded = { version: String(i?.version || ''), file: i?.downloadedFile, sha512: f?.sha512 || i?.sha512, fileName: f?.url || (typeof i?.path === 'string' ? i.path : undefined) };
      this.set({ phase: 'ready', version: i.version });
      this.keeping = this.keepInstallers().catch((e) => this.log(`keep ${e?.message || e}`));
      const byItself = this.config().auto === 'on' && i.version !== this.skipped();
      if (!this.soon)
        deps.notify?.(
          this.t('TeamBot {0} staat klaar', i.version),
          byItself
            ? this.t('TeamBot werkt zichzelf bij zodra er geen taak loopt en je even niet aan de computer zit. Vooraf maakt TeamBot een back-up.')
            : this.t('Start opnieuw om bij te werken. Vooraf maakt TeamBot een back-up. Anders gebeurt het de volgende keer dat je TeamBot afsluit.'),
        );
      if (this.env.TEAMBOT_UPDATE_TEST === '1') setTimeout(() => this.requestQuit?.(), 1500);
      else this.watchIdle();
    });
    u.on('error', (e: any) => {
      this.soon = false;
      this.set({ phase: 'error', message: this.plainError(e) });
    });
  }

  private get env() {
    return this.deps.env || process.env;
  }

  /** One line for the settings page; a refused signature in words instead of electron-updater's English dump. */
  private plainError(e: any): string {
    if (e?.code === 'ERR_UPDATER_INVALID_SIGNATURE' || /not signed by the application owner/.test(String(e?.message))) {
      return this.t('Deze update is niet ondertekend door de maker van TeamBot. TeamBot installeert hem niet.');
    }
    return String(e?.message || e).split('\n')[0].slice(0, 300);
  }

  private t(text: string, ...v: (string | number)[]) {
    return this.deps.t ? this.deps.t(text, ...v) : text.replace(/\{(\d+)\}/g, (_, n) => String(v[Number(n)] ?? ''));
  }

  private saved(): Saved {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }

  private write(next: Saved) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(next, null, 1));
  }

  /** Check times survive a restart (once a day means once a day, also when TeamBot is restarted often). */
  private remember(patch: Pick<Saved, 'lastCheckAt' | 'lastTryAt'>) {
    try {
      this.write({ ...this.saved(), ...patch });
    } catch (e: any) {
      this.log(`remember ${e?.message || e}`);
    }
  }

  /** The channel in use and where it comes from (environment, Settings, the release), or why it does not work. */
  channel(): { channel: Channel | null; source: ChannelSource; error?: string } {
    const env = this.env.TEAMBOT_UPDATE_CHANNEL || this.env.TEAMBOT_UPDATE_URL || '';
    if (env) {
      const r = parseChannel(env);
      return { channel: r.channel, source: 'env', error: r.error };
    }
    const s = this.saved();
    const own = s.channel ?? s.feedUrl ?? '';
    if (own) {
      const r = parseChannel(own);
      return { channel: r.channel, source: 'saved', error: r.error };
    }
    const built = this.deps.builtIn !== undefined ? this.deps.builtIn : this.deps.defaultFeed ? parseChannel(this.deps.defaultFeed).channel : null;
    return built ? { channel: built, source: 'built-in' } : { channel: null, source: 'none' };
  }

  config() {
    const s = this.saved();
    const c = this.channel();
    return {
      /** The channel in the form the owner types it back ('' = none). Kept under this name since 0.4.2. */
      feedUrl: channelInput(c.channel),
      channelText: channelText(c.channel),
      source: c.source,
      error: c.error || '',
      fromEnv: c.source === 'env',
      auto: (s.auto === 'notify' || s.auto === 'off' ? s.auto : 'on') as AutoMode,
      version: this.deps.version,
      packaged: this.deps.packaged,
      lastCheckAt: s.lastCheckAt || '',
    };
  }

  /** After "Terug naar versie x": the version the owner left, never installed again by itself. */
  skipped(): string | null {
    const last = readUpdateState(this.deps.dataDir).history[0];
    return last?.kind === 'rollback' && last.to === this.deps.version && validVersion(last.from) ? last.from : null;
  }

  private set(s: UpdateState) {
    this.state = s;
    this.log(`state ${JSON.stringify(s)}`);
    for (const l of this.listeners) l(s);
    this.deps.onChange?.();
  }

  onState(fn: (s: UpdateState) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Validate and apply the configuration; (re)starts the daily check. A download that is under way or ready stays. */
  start() {
    this.stop();
    const c = this.config();
    const busy = this.state.phase === 'available' || this.state.phase === 'downloading' || this.state.phase === 'ready';
    if (!c.packaged) return this.set({ phase: 'off', reason: 'Alleen in de geïnstalleerde app' });
    const ch = this.channel();
    if (ch.error) return this.set({ phase: 'off', reason: ch.error });
    if (!ch.channel) return this.set({ phase: 'off', reason: 'Geen updatekanaal ingesteld' });
    this.deps.updater.setFeedURL(feedOptions(ch.channel, { githubHost: this.deps.githubHost }));
    if (!busy) this.set({ phase: 'idle', checkedAt: c.lastCheckAt || undefined });
    else this.deps.onChange?.();
    if (this.state.phase === 'ready') this.watchIdle();
    if (c.auto === 'off') return;
    const timing = this.deps.timing || {};
    const first = setTimeout(() => void this.tick(), timing.firstCheckMs ?? (this.env.TEAMBOT_UPDATE_TEST === '1' ? 2_000 : 30_000));
    const every = setInterval(() => void this.tick(), timing.tickMs ?? TICK_MS);
    first.unref?.();
    every.unref?.();
    this.timers = [first, every];
  }

  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  /** The daily look: only when it is due (desktop/update-idle.ts checkDue). */
  async tick() {
    const s = this.saved();
    if (this.config().auto === 'off' || (this.env.TEAMBOT_UPDATE_TEST !== '1' && !checkDue({ lastCheckAt: s.lastCheckAt, lastTryAt: s.lastTryAt }))) return this.state;
    return this.check();
  }

  /** Instellingen › Back-ups: Automatisch bijwerken, and (on the computer, Geavanceerd) the channel. */
  save(patch: { feedUrl?: string; channel?: string; auto?: AutoMode }) {
    const next: Saved = { ...this.saved() };
    const typed = patch.channel !== undefined ? patch.channel : patch.feedUrl;
    if (typed !== undefined) {
      const r = parseChannel(String(typed));
      if (r.error) throw new Error(r.error);
      next.channel = r.channel ? channelInput(r.channel) : '';
      delete next.feedUrl;
    }
    if (patch.auto === 'on' || patch.auto === 'notify' || patch.auto === 'off') next.auto = patch.auto;
    this.write(next);
    this.start();
    return this.config();
  }

  async check() {
    if (this.state.phase === 'off' || this.state.phase === 'checking' || this.state.phase === 'downloading' || this.state.phase === 'ready') return this.state;
    this.remember({ lastTryAt: new Date().toISOString() });
    try {
      await this.deps.updater.checkForUpdates();
    } catch (e: any) {
      this.set({ phase: 'error', message: this.plainError(e) });
    }
    return this.state;
  }

  async download() {
    const cur = this.state;
    if (cur.phase !== 'available') return cur;
    this.set({ phase: 'downloading', version: cur.version, percent: 0 });
    try {
      await this.deps.updater.downloadUpdate();
    } catch (e: any) {
      this.soon = false;
      this.set({ phase: 'error', message: this.plainError(e) });
    }
    return this.state;
  }

  // ------------------------------------------------------------------ installing by itself, when nothing runs

  /**
   * "Nu bijwerken": look (when nothing was found yet), download (when not done yet) and install as soon as no task
   * runs. The owner's own presence does not hold it back: they asked.
   */
  async installNow() {
    if (this.state.phase === 'off') return this.state;
    this.soon = true;
    this.deps.onChange?.();
    if (this.state.phase === 'idle' || this.state.phase === 'error') await this.check();
    if (this.state.phase === 'available') await this.download();
    if (this.state.phase === 'ready') await this.evaluate();
    // A look or download under way carries "Nu bijwerken" along (update-available downloads, update-downloaded installs).
    else if (this.state.phase !== 'downloading' && this.state.phase !== 'checking') this.soon = false;
    return this.state;
  }

  /** While an update is ready: look every minute whether it may install now. */
  private watchIdle() {
    if (this.idleTimer || this.state.phase !== 'ready') return;
    this.idleTimer = setInterval(() => void this.evaluate(), this.deps.timing?.idlePollMs ?? IDLE_POLL_MS);
    this.idleTimer.unref?.();
    void this.evaluate();
  }

  /** May the downloaded update install now (desktop/update-idle.ts)? Then quit; will-quit makes the backup first. */
  async evaluate(): Promise<boolean> {
    if (this.state.phase !== 'ready' || this.installing || this.autoQuit || this.evaluating) return false;
    this.evaluating = true;
    try {
      const version = this.state.version;
      const mode = version === this.skipped() ? 'notify' : this.config().auto;
      let facts: IdleFacts | null = null;
      try {
        facts = (await this.deps.idleFacts?.()) ?? null;
      } catch (e: any) {
        this.log(`idle facts: ${e?.message || e}`);
      }
      const d = installDecision({ mode, ready: true, soon: this.soon, facts, idleSeconds: this.deps.timing?.idleSeconds });
      if (!sameReasons(d.waitingFor, this.waitingFor)) {
        this.waitingFor = d.waitingFor;
        this.deps.onChange?.();
      }
      if (!d.install || !this.requestQuit) return false;
      this.autoQuit = true;
      this.log(`installing ${version} by itself (${this.soon ? 'Nu bijwerken' : 'nothing runs, owner away'})`);
      this.requestQuit();
      return true;
    } finally {
      this.evaluating = false;
    }
  }

  // ------------------------------------------------------------------ keeping installers for the way back

  /**
   * After a download: keep the new installer (checked against latest.yml) and make sure the installer of the running
   * version is here too (from the update channel when it was installed by hand). Only these two stay.
   */
  private async keepInstallers() {
    const d = this.downloaded;
    const dataDir = this.deps.dataDir;
    const cur = this.deps.version;
    if (!d || !validVersion(d.version)) return;
    if (d.file && fs.existsSync(d.file)) {
      try {
        await keepInstallerFile(dataDir, { version: d.version, from: d.file, expectSha512: d.sha512, source: 'update', keepVersions: [cur] });
        this.safety.next = d.version;
      } catch (e: any) {
        this.log(`keep new installer: ${e?.message || e}`);
      }
    }
    let have = keptInstaller(dataDir, cur);
    if (!have && validVersion(cur) && (this.deps.platform || process.platform) === 'win32') {
      try {
        have = await this.fetchCurrentInstaller(d);
      } catch (e: any) {
        this.safety.note = `Het installatiebestand van versie ${cur} kon niet worden opgehaald (${String(e?.message || e).slice(0, 160)}). Na de update kun je dan niet met één klik terug.`;
        this.log(`fetch current installer: ${e?.message || e}`);
      }
    }
    this.safety.current = have ? { version: have.version, source: have.source } : null;
    this.deps.onChange?.();
  }

  /** The installer of the running version from the same update channel (its name follows the new one's). */
  private async fetchCurrentInstaller(d: { version: string; fileName?: string }): Promise<KeptInstaller | null> {
    const ch = this.channel().channel;
    const cur = this.deps.version;
    if (!ch) return null;
    const newName = d.fileName && d.fileName.includes(d.version) ? path.basename(d.fileName) : installerName(d.version);
    const name = newName.replace(d.version, cur);
    // Next to latest.yml in the folder, or an asset of the GitHub release v<version>.
    const url = installerUrl(ch, cur, name, { githubHost: this.deps.githubHost });
    const f = this.deps.fetch || fetch;
    const r = await f(url, { redirect: 'follow', signal: AbortSignal.timeout(30 * 60_000) });
    if (r.url && feedError(r.url)) throw new Error('doorgestuurd naar een adres zonder https');
    if (r.status === 404) throw new Error(`${name} staat niet op het updatekanaal`);
    if (!r.ok || !r.body) throw new Error(`het updatekanaal antwoordde ${r.status}`);
    const len = Number(r.headers.get('content-length')) || 0;
    if (len && len > 1024 ** 3) throw new Error('bestand te groot');
    const tmp = path.join(this.deps.dataDir, 'updates', `${name}.download`);
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    try {
      await pipeline(Readable.fromWeb(r.body as any), fs.createWriteStream(tmp));
      return await keepInstallerFile(this.deps.dataDir, { version: cur, from: tmp, source: 'feed', keepVersions: [d.version] });
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  // ------------------------------------------------------------------ installing

  /**
   * Right before installing (will-quit, the database is still open): the backup, then a note of what is about to
   * happen (`pending`, read at the next start). No backup → no install, and the owner is told why.
   */
  async prepareInstall(backup: (o: { from: string; to: string }) => Promise<{ name: string }> | { name: string }): Promise<{ ok: boolean; backup?: string; error?: string }> {
    const s = this.state;
    if (s.phase !== 'ready') return { ok: false, error: 'Er staat geen update klaar' };
    // Keeping the installers normally finished long ago; a slow fetch never holds up quitting for more than 30 s
    // (then only the one-click way back for this update is missing, and the page says so).
    if (this.keeping) await Promise.race([this.keeping.catch(() => {}), new Promise((r) => setTimeout(r, 30_000).unref())]);
    const from = this.deps.version;
    try {
      const b = await backup({ from, to: s.version });
      if (!b?.name) throw new Error('geen back-up');
      patchUpdateState(this.deps.dataDir, (st) => {
        st.pending = { kind: 'update', from, to: s.version, at: new Date().toISOString(), backup: b.name };
      });
      this.log(`backup before update to ${s.version}: ${b.name}`);
      return { ok: true, backup: b.name };
    } catch (e: any) {
      const msg = String(e?.message || e).split('\n')[0].slice(0, 300);
      this.set({ phase: 'error', message: this.t('De back-up vóór het bijwerken lukte niet ({0}). TeamBot is niet bijgewerkt.', msg) });
      this.deps.notify?.(this.t('TeamBot is niet bijgewerkt'), this.t('De back-up vooraf lukte niet: {0}. Je blijft op versie {1}.', msg, from));
      return { ok: false, error: msg };
    }
  }

  /** Quit and run the downloaded installer (silently, then start TeamBot again). Only after prepareInstall. */
  install() {
    if (this.state.phase !== 'ready' || this.installing) return false;
    this.installing = true;
    this.deps.updater.quitAndInstall(true, true);
    return true;
  }

  // ------------------------------------------------------------------ the way back

  /** Is there a one-click way back, and is the kept installer still the checked file? */
  async planRollback(backupExists: (name: string) => boolean): Promise<{ ok: true; plan: RollbackPlan } | { ok: false; reason: string }> {
    const info = rollbackInfo(this.deps.dataDir, this.deps.version, { desktop: true, platform: this.deps.platform || process.platform, backupExists });
    if (!info.available || !info.to || !info.backup) return { ok: false, reason: info.reason || 'Terug naar de vorige versie kan nu niet.' };
    const k = keptInstaller(this.deps.dataDir, info.to);
    if (!k) return { ok: false, reason: `Het installatiebestand van versie ${info.to} staat niet op deze computer.` };
    if (!(await verifyKept(k))) return { ok: false, reason: `Het bewaarde installatiebestand van versie ${info.to} is veranderd sinds het werd gecontroleerd. TeamBot start het niet.` };
    if (compareVersions(info.to, this.deps.version) >= 0) return { ok: false, reason: 'Er is geen oudere versie om naar terug te gaan.' };
    return { ok: true, plan: { to: info.to, backup: info.backup, installer: k } };
  }

  /**
   * Start the way back: the pre-update backup is staged for restore (by the caller, through the backups service), and
   * a note says what is about to happen. The app then quits; will-quit calls finishRollback after the server closed.
   */
  async startRollback(backupExists: (name: string) => boolean, stage: (backup: string) => void): Promise<RollbackPlan> {
    const r = await this.planRollback(backupExists);
    if (!r.ok) throw new Error(r.reason);
    stage(r.plan.backup);
    patchUpdateState(this.deps.dataDir, (st) => {
      st.pending = { kind: 'rollback', from: this.deps.version, to: r.plan.to, at: new Date().toISOString(), backup: r.plan.backup };
    });
    this.rollback = r.plan;
    this.log(`rollback to ${r.plan.to} with backup ${r.plan.backup}`);
    return r.plan;
  }

  rollbackPending(): RollbackPlan | null {
    return this.rollback;
  }

  /** After the server closed (and the staged restore was put in place): run the kept installer of the older version. */
  async finishRollback(): Promise<boolean> {
    const plan = this.rollback;
    if (!plan || this.installing) return false;
    // Checked again right before it runs: the file must still be the one that was verified when it was kept.
    if (!(await verifyKept(plan.installer))) {
      this.log(`rollback refused: installer ${plan.installer.file} changed`);
      this.deps.notify?.(this.t('Terug naar versie {0} is niet gestart', plan.to), this.t('Het bewaarde installatiebestand is veranderd. Je gegevens van vlak voor de update zijn wel teruggezet.'));
      return false;
    }
    if (!this.deps.spawnInstaller) return false;
    this.installing = true;
    this.deps.spawnInstaller(plan.installer.file, ROLLBACK_ARGS);
    this.log(`rollback installer started: ${path.basename(plan.installer.file)} ${ROLLBACK_ARGS.join(' ')}`);
    return true;
  }

  /** For the settings page: config, state and whether the installer of this version is kept. */
  info() {
    const kept = this.safety.current ? null : keptInstaller(this.deps.dataDir, this.deps.version);
    return {
      config: this.config(),
      state: this.state,
      waitingFor: this.state.phase === 'ready' ? this.waitingFor : [],
      soon: this.soon,
      skipped: this.skipped(),
      safety: { ...this.safety, current: this.safety.current || (kept ? { version: this.deps.version, source: kept.source } : null) },
    };
  }
}

/**
 * The update channel built into a release: electron-builder writes package.json build.publish into
 * resources/app-update.yml. Until there is hosting that is a placeholder on `.invalid` (a name that never exists), and
 * then the app has no channel and says nothing. Once it is a real https address, every installed TeamBot uses it
 * without anyone typing it (Settings or TEAMBOT_UPDATE_URL still win).
 */
export function defaultFeedUrl(appUpdateYml: string | null | undefined): string {
  if (!appUpdateYml) return '';
  const field = (k: string) => new RegExp(`^${k}:\\s*['"]?([^'"\\r\\n]+?)['"]?\\s*$`, 'm').exec(appUpdateYml)?.[1] || '';
  const url = field('url');
  if (field('provider') !== 'generic' || !url || feedError(url)) return '';
  const host = new URL(url).hostname;
  if (/\.(invalid|example|test|localhost)$/i.test(host) || /^(example\.(com|org|net)|localhost|127\.0\.0\.1|\[::1\])$/i.test(host)) return '';
  return url;
}

// ------------------------------------------------------------------ the signature of an update (once signed)

/** "CN=Jan Jansen, O=TeamBot, C=NL" (also with quoted values: CN="Jansen, Jan") → Map of upper-case keys. */
export function parseDn(dn: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /\s*([A-Za-z][\w.]*)\s*=\s*(?:"((?:[^"]|"")*)"|((?:\\.|[^,;+])*))\s*(?:[,;+]|$)/gy;
  let m: RegExpExecArray | null;
  while (re.lastIndex < dn.length && (m = re.exec(dn))) {
    if (!out.has(m[1].toUpperCase())) out.set(m[1].toUpperCase(), (m[2] !== undefined ? m[2].replace(/""/g, '"') : m[3].replace(/\\(.)/g, '$1')).trim());
    if (m[0] === '') break;
  }
  return out;
}

/** The PowerShell script that reads the Authenticode signature of `file` (base64 JSON, independent of code pages). */
export function signatureScript(file: string): string {
  const lit = file.replace(/'/g, "''"); // a single-quoted PowerShell string: only ' needs escaping
  return (
    `$s = Get-AuthenticodeSignature -LiteralPath '${lit}' -ErrorAction Stop; ` +
    `$j = [pscustomobject]@{ Status = $(if ($s) { [int]$s.Status } else { -1 }); Subject = [string]$s.SignerCertificate.Subject; Path = [string]$s.Path } | ConvertTo-Json -Compress; ` +
    `[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j)))`
  );
}

/**
 * Is `file` signed (valid Authenticode signature) by one of `publisherNames`? electron-updater's contract: null = yes,
 * otherwise the reason. `publisherNames` come from app-update.yml (package.json build.win.azureSignOptions
 * .publisherName, or the subject of the certificate); a full DN must match on every part, a bare name the CN.
 * electron-updater's own check starts PowerShell through cmd without hiding the window (a console flashes on every
 * update) and lets the update through when PowerShell fails; this one runs hidden and refuses when it cannot check.
 */
export async function verifyPublisher(publisherNames: string[], file: string, powershell: (script: string) => Promise<string>): Promise<string | null> {
  let info: { Status?: number; Subject?: string; Path?: string };
  try {
    info = JSON.parse(Buffer.from((await powershell(signatureScript(file))).trim(), 'base64').toString('utf8'));
  } catch (e: any) {
    return `de handtekening kon niet worden gecontroleerd (${String(e?.message || e).split('\n')[0].slice(0, 200)})`;
  }
  if (info.Status !== 0) return `geen geldige handtekening (status ${info.Status ?? '?'})`;
  if (!info.Path || path.win32.normalize(info.Path).toLowerCase() !== path.win32.normalize(file).toLowerCase()) return 'de controle ging over een ander bestand';
  const subject = parseDn(info.Subject || '');
  for (const name of publisherNames) {
    const want = parseDn(name);
    if (want.size && name.includes('=') ? [...want].every(([k, v]) => subject.get(k) === v) : subject.get('CN') === name.trim()) return null;
  }
  return `ondertekend door "${subject.get('CN') || info.Subject || '?'}", verwacht: ${publisherNames.join(' of ')}`;
}
