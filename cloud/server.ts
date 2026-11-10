import http from 'node:http';
import path from 'node:path';
import { loadCloudConfig, type CloudConfig } from './config.js';
import { migrate, openDb, type Db } from './db.js';
import { loadPlans, type Plan } from './billing/plans.js';
import { BillingService } from './billing/service.js';
import { Accounts } from './accounts.js';
import { WorkspaceService } from './workspaces.js';
import { MonitoringService } from './monitoring.js';
import { AlertService, type Mailer } from './alerts.js';
import { ReportService } from './reports.js';
import type { Resolver } from './health.js';
import { ProcessProvisioner } from './provisioner/process.js';
import { DockerProvisioner } from './provisioner/docker.js';
import type { Provisioner } from './provisioner/types.js';
import { createRouter } from './router.js';
import { createControlApp } from './web/app.js';
import { makeLog, systemClock, type Clock, type Log } from './util.js';

export interface CloudHandle {
  cfg: CloudConfig;
  db: Db;
  plans: Plan[];
  log: Log;
  clock: Clock;
  provisioner: Provisioner;
  workspaces: WorkspaceService;
  monitoring: MonitoringService;
  alerts: AlertService;
  reports: ReportService;
  accounts: Accounts;
  billing: BillingService;
  server: http.Server;
  /** Address the router listens on (use with a Host header in tests). */
  listenUrl: string;
  close(): Promise<void>;
}

export interface CreateCloudOptions {
  env?: NodeJS.ProcessEnv;
  config?: Partial<CloudConfig>;
  clock?: Clock;
  provisioner?: Provisioner;
  /** PGlite folder; null = in memory (tests). Ignored when DATABASE_URL is set. */
  pgliteDir?: string | null;
  fetchImpl?: typeof fetch;
  /** Start active instances again after boot (default true). */
  restore?: boolean;
  /** DNS resolver for dedicated health checks and alert webhooks (tests). */
  resolve?: Resolver;
  /** E-mail sender for alerts (tests); default: CLOUD_SMTP_URL via nodemailer. */
  mailer?: Mailer;
}

export function makeProvisioner(cfg: CloudConfig, log: Log): Provisioner {
  if (cfg.provisioner === 'docker') {
    return new DockerProvisioner({ bin: cfg.docker.bin, image: cfg.docker.image, self: cfg.docker.self, readOnly: cfg.docker.readOnly, startTimeoutMs: cfg.process.startTimeoutMs * 2, log });
  }
  return new ProcessProvisioner({ rootDir: path.join(cfg.dataDir, 'instances'), entry: cfg.process.entry, nodeBin: cfg.process.nodeBin, startTimeoutMs: cfg.process.startTimeoutMs, uiDir: cfg.process.uiDir, log });
}

/** Wire up database, services, control plane and router into one HTTP server. */
export async function createCloud(o: CreateCloudOptions = {}): Promise<CloudHandle> {
  const env = o.env ?? process.env;
  const cfg = loadCloudConfig(env, o.config);
  const log = makeLog(cfg.quiet, [cfg.stripe.secretKey || '', cfg.stripe.webhookSecret || '', cfg.databaseUrl || '', cfg.secretKey.toString('base64')]);
  const db = await openDb(cfg.databaseUrl, o.pgliteDir === null ? undefined : o.pgliteDir || path.join(cfg.dataDir, 'pglite'));
  await migrate(db);
  const plans = loadPlans(env, cfg.trialDays);
  const clock = o.clock ?? systemClock;
  const provisioner = o.provisioner ?? makeProvisioner(cfg, log);
  const workspaces = new WorkspaceService({ db, cfg, plans, provisioner, clock, log, resolve: o.resolve });
  const alerts = new AlertService({ db, cfg, clock, log, mailer: o.mailer, resolve: o.resolve });
  const monitoring = new MonitoringService({ db, cfg, clock, log, workspaces, alerts });
  const accounts = new Accounts({ db, cfg, clock, log });
  const billing = new BillingService({ db, cfg, plans, clock, log, workspaces, fetchImpl: o.fetchImpl });
  const reports = new ReportService({ db, cfg, plans, clock, log, workspaces, billing, alerts });
  const control = createControlApp({ cfg, db, plans, clock, log, workspaces, monitoring, alerts, reports, accounts, billing });
  const router = createRouter({ cfg, workspaces, control, log });

  const server = http.createServer(router.handle);
  server.on('upgrade', router.upgrade);
  server.headersTimeout = 30_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.listenPort, cfg.listenHost, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : cfg.listenPort;
  const listenUrl = `http://${cfg.listenHost === '0.0.0.0' ? '127.0.0.1' : cfg.listenHost}:${port}`;

  if (o.restore !== false) await workspaces.restoreOnBoot();

  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, fn: () => Promise<unknown>, what: string) => {
    if (ms <= 0) return;
    let running = false;
    const t = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        await fn();
      } catch (e) {
        log.error(`${what} mislukte`, e);
      } finally {
        running = false;
      }
    }, ms);
    t.unref();
    timers.push(t);
  };
  every(cfg.healthIntervalMs, () => monitoring.sweep(), 'gezondheidscontrole');
  every(cfg.enforceIntervalMs, () => billing.enforce(), 'abonnementscontrole');
  // Monthly SLA reports: made automatically once the month (in CLOUD_TZ) is over.
  every(cfg.enforceIntervalMs, () => reports.generateDue(), 'maandrapporten');

  let closed = false;
  return {
    cfg,
    db,
    plans,
    log,
    clock,
    provisioner,
    workspaces,
    monitoring,
    alerts,
    reports,
    accounts,
    billing,
    server,
    listenUrl,
    async close() {
      if (closed) return;
      closed = true;
      for (const t of timers) clearInterval(t);
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
      await workspaces.idle();
      await alerts.idle();
      await provisioner.shutdown();
      await db.close();
    },
  };
}
