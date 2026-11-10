import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Configuration of the managed cloud (control plane + router). Everything comes from environment variables so the
 * same build runs locally (PGlite + process provisioner) and in production (Postgres + Docker). See docs/CLOUD.md.
 */
export interface CloudConfig {
  /** Public URL of the control plane, e.g. https://cloud.example.com. Workspaces live at <slug>.<host of this URL>. */
  url: string;
  scheme: 'http' | 'https';
  /** Apex host of the control plane (lowercase, no port). */
  domain: string;
  /** ":8080" when the public URL has an explicit port, else "". */
  portSuffix: string;
  listenHost: string;
  listenPort: number;
  /** Folder for PGlite data (dev), process-provisioner instances and exports. */
  dataDir: string;
  databaseUrl: string | null;
  /** 32-byte key that encrypts per-workspace master keys in the database. */
  secretKey: Buffer;
  cookieSecure: boolean;
  /** Peers whose X-Forwarded-* headers are trusted: 'loopback' and/or exact IPs. Empty = trust nobody. */
  trustProxy: string[];
  /** Peers allowed to call /_tls/ask (Caddy on-demand TLS): 'loopback' and/or exact IPs. */
  tlsAskFrom: string[];
  provisioner: 'process' | 'docker';
  process: { entry: string; nodeBin: string; startTimeoutMs: number; uiDir: string | null };
  docker: { bin: string; image: string; self: string | null; readOnly: boolean };
  stripe: { secretKey: string | null; webhookSecret: string | null; apiBase: string; prices: Record<string, string>; toleranceSec: number };
  /** Dedicated deployments (CLD-05): instances the customer runs in their own VPC; we only monitor them. */
  dedicated: {
    /** Development only (CLOUD_DEDICATED_DEV=1): allow http:// and private/loopback addresses. */
    allowPrivate: boolean;
    timeoutMs: number;
  };
  /** Outbound alerts (e-mail via CLOUD_SMTP_URL, signed webhooks) per account. */
  alerts: { limitPerHour: number; timeoutMs: number };
  /** Consecutive failed health checks before an incident is opened automatically. */
  incidentAfterFailures: number;
  /** Maintenance announced at least this many hours ahead is excluded from uptime (SLA); shorter notice counts. */
  maintenanceNoticeHours: number;
  trialDays: number;
  graceDays: number;
  retentionDays: number;
  exportDays: number;
  maxWorkspacesPerAccount: number;
  signupOpen: boolean;
  smtpUrl: string | null;
  mailFrom: string;
  timeZone: string;
  healthIntervalMs: number;
  enforceIntervalMs: number;
  /** Router-level cap on proxied request bodies (instances enforce their own, smaller limits). */
  proxyMaxBodyBytes: number;
  limits: { loginPerEmail: number; loginPerIp: number; loginWindowMs: number; signupPerIp: number; signupWindowMs: number };
  quiet: boolean;
}

const here = path.dirname(fileURLToPath(import.meta.url));
/** Repository / app root (cloud/ in development, dist/cloud/ in a bundle). */
export const ROOT = fs.existsSync(path.resolve(here, '../package.json')) ? path.resolve(here, '..') : path.resolve(here, '../..');

function num(v: string | undefined, def: number): number {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : def;
}

/** Load or (in development only) create the control-plane secret key. Production without a key fails closed. */
function loadSecretKey(env: NodeJS.ProcessEnv, dataDir: string): Buffer {
  if (env.CLOUD_SECRET_KEY) {
    const k = Buffer.from(env.CLOUD_SECRET_KEY, 'base64');
    if (k.length !== 32) throw new Error('CLOUD_SECRET_KEY moet 32 bytes zijn (base64)');
    return k;
  }
  if (env.NODE_ENV === 'production') throw new Error('CLOUD_SECRET_KEY ontbreekt (verplicht in productie)');
  const file = path.join(dataDir, 'cloud-secret.key');
  if (fs.existsSync(file)) return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  const k = crypto.randomBytes(32);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, k.toString('base64'), { mode: 0o600 });
  return k;
}

export function loadCloudConfig(env: NodeJS.ProcessEnv = process.env, over: Partial<CloudConfig> = {}): CloudConfig {
  const listenPort = over.listenPort ?? num(env.CLOUD_PORT, 8080);
  const rawUrl = over.url || env.CLOUD_URL || `http://cloud.localhost:${listenPort}`;
  const u = new URL(rawUrl);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('CLOUD_URL moet met http:// of https:// beginnen');
  const scheme = u.protocol === 'https:' ? 'https' : 'http';
  const dataDir = path.resolve(over.dataDir || env.CLOUD_DATA || path.join(ROOT, '.data', 'cloud'));
  fs.mkdirSync(dataDir, { recursive: true });
  if (env.CLOUD_DEDICATED_DEV === '1' && env.NODE_ENV === 'production') {
    throw new Error('CLOUD_DEDICATED_DEV=1 (http en privé-adressen voor dedicated) is alleen voor ontwikkeling, niet in productie');
  }
  const prices: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    const m = /^STRIPE_PRICE_([A-Z0-9_]+)$/.exec(k);
    if (m && v) prices[m[1].toLowerCase()] = v;
  }
  const cfg: CloudConfig = {
    url: u.origin,
    scheme,
    domain: u.hostname.toLowerCase(),
    portSuffix: u.port ? `:${u.port}` : '',
    listenHost: env.CLOUD_HOST || '127.0.0.1',
    listenPort,
    dataDir,
    databaseUrl: env.DATABASE_URL || null,
    secretKey: over.secretKey || loadSecretKey(env, dataDir),
    cookieSecure: env.CLOUD_COOKIE_SECURE ? env.CLOUD_COOKIE_SECURE === '1' : scheme === 'https',
    trustProxy: (env.CLOUD_TRUST_PROXY ?? 'loopback')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && s !== 'none'),
    tlsAskFrom: (env.CLOUD_TLS_ASK_FROM ?? 'loopback')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && s !== 'none'),
    provisioner: env.CLOUD_PROVISIONER === 'docker' ? 'docker' : 'process',
    process: {
      entry: path.resolve(env.CLOUD_TEAMBOT_ENTRY || path.join(ROOT, 'dist', 'server', 'main.js')),
      nodeBin: env.CLOUD_NODE_BIN || process.execPath,
      startTimeoutMs: num(env.CLOUD_START_TIMEOUT_MS, 30_000),
      // Development only: UI folder for instances (TEAMBOT_UI_DIR), e.g. when the checkout lives in a dot-folder.
      uiDir: env.CLOUD_TEAMBOT_UI_DIR ? path.resolve(env.CLOUD_TEAMBOT_UI_DIR) : null,
    },
    docker: {
      bin: env.CLOUD_DOCKER_BIN || 'docker',
      image: env.CLOUD_DOCKER_IMAGE || 'teambot:latest',
      self: env.CLOUD_DOCKER_SELF || null,
      readOnly: env.CLOUD_DOCKER_READ_ONLY !== '0',
    },
    stripe: {
      secretKey: env.STRIPE_SECRET_KEY || null,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET || null,
      apiBase: env.STRIPE_API_BASE || 'https://api.stripe.com',
      prices,
      toleranceSec: num(env.STRIPE_TOLERANCE_SEC, 300),
    },
    dedicated: {
      allowPrivate: env.CLOUD_DEDICATED_DEV === '1',
      timeoutMs: num(env.CLOUD_DEDICATED_TIMEOUT_MS, 5000),
    },
    alerts: { limitPerHour: Math.max(1, num(env.CLOUD_ALERT_LIMIT, 20)), timeoutMs: num(env.CLOUD_ALERT_TIMEOUT_MS, 5000) },
    incidentAfterFailures: Math.max(1, num(env.CLOUD_INCIDENT_AFTER, 3)),
    maintenanceNoticeHours: num(env.CLOUD_MAINTENANCE_NOTICE_HOURS, 48),
    trialDays: num(env.CLOUD_TRIAL_DAYS, 14),
    graceDays: num(env.CLOUD_GRACE_DAYS, 7),
    retentionDays: num(env.CLOUD_RETENTION_DAYS, 30),
    exportDays: num(env.CLOUD_EXPORT_DAYS, 7),
    maxWorkspacesPerAccount: num(env.CLOUD_MAX_WORKSPACES, 3),
    signupOpen: env.CLOUD_SIGNUP !== '0',
    smtpUrl: env.CLOUD_SMTP_URL || null,
    mailFrom: env.CLOUD_MAIL_FROM || `TeamBot Cloud <no-reply@${u.hostname}>`,
    timeZone: env.CLOUD_TZ || 'Europe/Amsterdam',
    healthIntervalMs: num(env.CLOUD_HEALTH_INTERVAL_MS, 30_000),
    enforceIntervalMs: num(env.CLOUD_ENFORCE_INTERVAL_MS, 5 * 60_000),
    proxyMaxBodyBytes: num(env.CLOUD_PROXY_MAX_BODY_MB, 256) * 1024 * 1024,
    limits: {
      loginPerEmail: num(env.CLOUD_LOGIN_LIMIT, 5),
      loginPerIp: num(env.CLOUD_LOGIN_IP_LIMIT, 30),
      loginWindowMs: 15 * 60_000,
      signupPerIp: num(env.CLOUD_SIGNUP_LIMIT, 10),
      signupWindowMs: 60 * 60_000,
    },
    quiet: env.CLOUD_QUIET === '1',
  };
  return {
    ...cfg,
    ...over,
    url: cfg.url,
    scheme: cfg.scheme,
    domain: cfg.domain,
    portSuffix: cfg.portSuffix,
    dataDir: cfg.dataDir,
    limits: { ...cfg.limits, ...(over.limits || {}) },
    stripe: { ...cfg.stripe, ...(over.stripe || {}) },
    process: { ...cfg.process, ...(over.process || {}) },
    docker: { ...cfg.docker, ...(over.docker || {}) },
    dedicated: { ...cfg.dedicated, ...(over.dedicated || {}) },
    alerts: { ...cfg.alerts, ...(over.alerts || {}) },
  };
}

/** Public URL of a workspace. */
export function workspaceUrl(cfg: CloudConfig, slug: string): string {
  return `${cfg.scheme}://${slug}.${cfg.domain}${cfg.portSuffix}`;
}
