import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './db.js';
import { one } from './db.js';
import { workspaceUrl, type CloudConfig } from './config.js';
import { audit, type Actor } from './audit.js';
import { decrypt, encrypt, newId, randomToken, safeEqual, sha256 } from './crypto.js';
import { planById, type Plan } from './billing/plans.js';
import { ProvisionError, type InstanceInfo, type InstanceSpec, type Provisioner, type Upstream } from './provisioner/types.js';
import { UserError } from './accounts.js';
import { addDays, slugError, type Clock, type Log } from './util.js';
import { checkInstance, UrlError, validateInstanceUrl, type Resolver } from './health.js';

export type WorkspaceStatus = 'provisioning' | 'active' | 'suspended' | 'deleting' | 'deleted';

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  owner_id: string;
  plan: string;
  status: WorkspaceStatus;
  status_reason: string | null;
  instance: InstanceInfo | Record<string, never>;
  master_key_enc: string | null;
  owner_claimed: boolean;
  claim_token_hash: string | null;
  claim_expires_at: Date | null;
  health: 'unknown' | 'healthy' | 'unhealthy';
  health_checked_at: Date | null;
  storage_bytes: string | number | null;
  trial_ends_at: Date | null;
  suspended_at: Date | null;
  delete_after: Date | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
  /** shared = we run the instance; dedicated = the customer runs it in their own VPC (CLD-05). */
  deployment: 'shared' | 'dedicated';
  /** Dedicated only: the customer's own https address. */
  external_url: string | null;
  setup_token_hash: string | null;
  health_fail_streak: number;
  health_detail: string | null;
}

export interface ExportRow {
  id: string;
  workspace_id: string;
  file: string;
  size_bytes: string | number;
  created_at: Date;
  expires_at: Date;
}

/** What the router needs per request (cached briefly, invalidated on every change made here). */
export interface RouteInfo {
  id: string;
  slug: string;
  status: WorkspaceStatus;
  upstream: Upstream | null;
  ownerClaimed: boolean;
  claimHash: string | null;
  claimExpires: Date | null;
  /** Dedicated workspaces are never proxied: they run elsewhere. */
  dedicated: boolean;
}

export interface ActorRef {
  actor: Actor;
  actorId?: string | null;
  ip?: string | null;
}

const ROUTE_TTL_MS = 2000;
const CLAIM_MINUTES = 30;

export class WorkspaceService {
  private cache = new Map<string, { at: number; info: RouteInfo | null }>();
  private locks = new Map<string, Promise<unknown>>();
  /** Provisioning in progress, per workspace id (tests await these). */
  readonly pending = new Map<string, Promise<void>>();

  constructor(private d: { db: Db; cfg: CloudConfig; plans: Plan[]; provisioner: Provisioner; clock: Clock; log: Log; resolve?: Resolver }) {}

  /** Serialise lifecycle operations per workspace (no start during a stop, no delete during an export, ...). */
  private lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    const tail = next.catch(() => {});
    this.locks.set(id, tail);
    tail.then(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    });
    return next;
  }

  private now() {
    return this.d.clock.now();
  }

  private async log(ref: ActorRef, kind: string, workspaceId: string, data?: Record<string, unknown>) {
    await audit(this.d.db, this.d.clock, { actor: ref.actor, actorId: ref.actorId, ip: ref.ip, kind, workspaceId, data });
  }

  invalidate(slug: string) {
    this.cache.delete(slug);
  }

  async get(id: string): Promise<Workspace | null> {
    return one<Workspace>(this.d.db, 'SELECT * FROM workspaces WHERE id = $1', [id]);
  }

  /** A workspace of this owner (tenant check for every dashboard route), excluding tombstones. */
  async getOwned(id: string, ownerId: string): Promise<Workspace | null> {
    return one<Workspace>(this.d.db, "SELECT * FROM workspaces WHERE id = $1 AND owner_id = $2 AND status <> 'deleted'", [id, ownerId]);
  }

  async listForOwner(ownerId: string): Promise<Workspace[]> {
    return this.d.db.query<Workspace>("SELECT * FROM workspaces WHERE owner_id = $1 AND status <> 'deleted' ORDER BY created_at", [ownerId]);
  }

  async listAll(): Promise<(Workspace & { owner_email: string; sub_status: string | null; sub_provider: string | null })[]> {
    return this.d.db.query(
      `SELECT w.*, a.email AS owner_email, s.status AS sub_status, s.provider AS sub_provider
       FROM workspaces w JOIN accounts a ON a.id = w.owner_id LEFT JOIN subscriptions s ON s.workspace_id = w.id
       ORDER BY w.status = 'deleted', w.created_at DESC`,
    );
  }

  url(ws: Pick<Workspace, 'slug'>) {
    return workspaceUrl(this.d.cfg, ws.slug);
  }

  /** Where "Openen" goes: our subdomain for shared workspaces, the customer's own address for dedicated ones. */
  openUrl(ws: Pick<Workspace, 'slug' | 'deployment' | 'external_url'>): string {
    return ws.deployment === 'dedicated' ? ws.external_url || '' : this.url(ws);
  }

  plan(ws: Pick<Workspace, 'plan'>): Plan {
    return planById(this.d.plans, ws.plan);
  }

  /** Decrypt the master key only for the provisioner call that needs it. */
  private spec(ws: Workspace): InstanceSpec {
    if (ws.deployment === 'dedicated') throw new ProvisionError('Een dedicated omgeving draait bij de klant; wij starten of stoppen die niet.');
    if (!ws.master_key_enc) throw new ProvisionError('Sleutel van deze workspace ontbreekt.');
    return { workspaceId: ws.id, slug: ws.slug, publicUrl: this.url(ws), masterKey: decrypt(this.d.cfg.secretKey, ws.master_key_enc, ws.id), setupToken: this.setupToken(ws.id), plan: this.plan(ws) };
  }

  /** Per-workspace setup token, derived from CLOUD_SECRET_KEY (nothing extra to store). */
  setupToken(workspaceId: string): string {
    return crypto.createHmac('sha256', this.d.cfg.secretKey).update(`teambot-setup:${workspaceId}`).digest('base64url');
  }

  async create(ownerId: string, input: { name: string; slug: string }, ref: ActorRef, subscriptionProvider: 'manual' | 'stripe'): Promise<Workspace> {
    const slug = String(input.slug || '').trim().toLowerCase();
    const name = String(input.name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!name) throw new UserError('Geef je workspace een naam.');
    const err = slugError(slug);
    if (err) throw new UserError(err);
    const count = await one<{ n: number }>(this.d.db, "SELECT COUNT(*)::int AS n FROM workspaces WHERE owner_id = $1 AND status <> 'deleted'", [ownerId]);
    if ((count?.n ?? 0) >= this.d.cfg.maxWorkspacesPerAccount) throw new UserError(`Je kunt maximaal ${this.d.cfg.maxWorkspacesPerAccount} workspaces hebben.`);
    // Slugs are never reused, not even after deletion (tombstones keep theirs): no confusion or phishing via old links.
    if (await one(this.d.db, 'SELECT id FROM workspaces WHERE slug = $1', [slug])) throw new UserError('Dit adres is al bezet. Kies een ander.', 409);
    const id = newId('ws_');
    const now = this.now();
    const masterKey = crypto.randomBytes(32).toString('base64');
    try {
      await this.d.db.tx(async (q) => {
        await q.query(
          `INSERT INTO workspaces (id, slug, name, owner_id, plan, status, master_key_enc, trial_ends_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'trial', 'provisioning', $5, $6, $7, $7)`,
          [id, slug, name, ownerId, encrypt(this.d.cfg.secretKey, masterKey, id), addDays(now, this.d.cfg.trialDays).toISOString(), now.toISOString()],
        );
        await q.query(
          `INSERT INTO subscriptions (id, workspace_id, provider, plan, status, created_at, updated_at) VALUES ($1, $2, $3, 'trial', 'trialing', $4, $4)`,
          [newId('sub_'), id, subscriptionProvider, now.toISOString()],
        );
        await audit(q, this.d.clock, { actor: ref.actor, actorId: ref.actorId, ip: ref.ip, kind: 'workspace.created', workspaceId: id, data: { slug } });
      });
    } catch (e: any) {
      if (e?.code === '23505') throw new UserError('Dit adres is al bezet. Kies een ander.', 409);
      throw e;
    }
    this.startProvisioning(id);
    return (await this.get(id))!;
  }

  // ---------- dedicated deployments (CLD-05) ----------

  /** Check an operator-entered instance address (https, public, not ours). */
  async checkUrl(raw: string): Promise<string> {
    try {
      return await validateInstanceUrl(raw, { allowPrivate: this.d.cfg.dedicated.allowPrivate, cloudDomain: this.d.cfg.domain, resolve: this.d.resolve });
    } catch (e) {
      if (e instanceof UrlError) throw new UserError(e.message);
      throw e;
    }
  }

  /**
   * Register a dedicated workspace for an existing account. Nothing is provisioned: the customer runs the standard
   * TeamBot image in their own VPC (deploy/dedicated/). Returns the setup token once; only its hash is stored.
   */
  async createDedicated(ownerId: string, input: { name: string; slug: string; url: string }, ref: ActorRef): Promise<{ ws: Workspace; setupToken: string }> {
    const slug = String(input.slug || '').trim().toLowerCase();
    const name = String(input.name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!name) throw new UserError('Geef de omgeving een naam.');
    const err = slugError(slug);
    if (err) throw new UserError(err);
    const url = await this.checkUrl(input.url);
    if (await one(this.d.db, 'SELECT id FROM workspaces WHERE slug = $1', [slug])) throw new UserError('Dit adres is al bezet. Kies een ander.', 409);
    const plan = this.d.plans.find((p) => p.deployment === 'dedicated');
    if (!plan) throw new UserError('Er is geen dedicated abonnement ingesteld.');
    const id = newId('ws_');
    const now = this.now().toISOString();
    const setupToken = randomToken();
    try {
      await this.d.db.tx(async (q) => {
        await q.query(
          `INSERT INTO workspaces (id, slug, name, owner_id, plan, status, deployment, external_url, setup_token_hash, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'active', 'dedicated', $6, $7, $8, $8)`,
          [id, slug, name, ownerId, plan.id, url, sha256(setupToken), now],
        );
        // Dedicated is invoiced by default (manual); Stripe stays optional (STRIPE_PRICE_DEDICATED + checkout).
        await q.query(`INSERT INTO subscriptions (id, workspace_id, provider, plan, status, created_at, updated_at) VALUES ($1, $2, 'manual', $3, 'active', $4, $4)`, [
          newId('sub_'),
          id,
          plan.id,
          now,
        ]);
        await audit(q, this.d.clock, { actor: ref.actor, actorId: ref.actorId, ip: ref.ip, kind: 'workspace.dedicated_registered', workspaceId: id, data: { slug, url } });
      });
    } catch (e: any) {
      if (e?.code === '23505') throw new UserError('Dit adres is al bezet. Kies een ander.', 409);
      throw e;
    }
    return { ws: (await this.get(id))!, setupToken };
  }

  async setExternalUrl(id: string, raw: string, ref: ActorRef) {
    const ws = await this.get(id);
    if (!ws || ws.deployment !== 'dedicated' || ws.status === 'deleted') throw new UserError('Dit is geen dedicated omgeving.');
    const url = await this.checkUrl(raw);
    await this.d.db.query("UPDATE workspaces SET external_url = $2, health = 'unknown', health_fail_streak = 0, health_detail = NULL, updated_at = $3 WHERE id = $1", [
      id,
      url,
      this.now().toISOString(),
    ]);
    await this.log(ref, 'workspace.dedicated_url', id, { url });
  }

  /** New TEAMBOT_SETUP_TOKEN for a dedicated workspace (e.g. the first one got lost). Shown once. */
  async rotateSetupToken(id: string, ref: ActorRef): Promise<string> {
    const ws = await this.get(id);
    if (!ws || ws.deployment !== 'dedicated' || ws.status === 'deleted') throw new UserError('Dit is geen dedicated omgeving.');
    const token = randomToken();
    await this.d.db.query('UPDATE workspaces SET setup_token_hash = $2, updated_at = $3 WHERE id = $1', [id, sha256(token), this.now().toISOString()]);
    await this.log(ref, 'workspace.setup_token_rotated', id);
    return token;
  }

  private startProvisioning(id: string) {
    const p = this.provision(id).finally(() => {
      if (this.pending.get(id) === p) this.pending.delete(id);
    });
    this.pending.set(id, p);
  }

  /** Retry a failed provisioning. */
  async retry(id: string) {
    const ws = await this.get(id);
    if (ws?.status === 'provisioning' && !this.pending.has(id)) this.startProvisioning(id);
  }

  private provision(id: string): Promise<void> {
    return this.lock(id, async () => {
      const ws = await this.get(id);
      if (!ws || ws.status !== 'provisioning') return;
      await this.d.db.query('UPDATE workspaces SET status_reason = NULL, updated_at = $2 WHERE id = $1', [id, this.now().toISOString()]);
      try {
        const spec = this.spec(ws);
        let info = await this.d.provisioner.create(spec);
        await this.d.db.query('UPDATE workspaces SET instance = $2::jsonb WHERE id = $1', [id, JSON.stringify(info)]);
        info = await this.d.provisioner.start(info, spec);
        await this.d.db.query(
          "UPDATE workspaces SET status = 'active', status_reason = NULL, instance = $2::jsonb, health = 'healthy', health_checked_at = $3, updated_at = $3 WHERE id = $1",
          [id, JSON.stringify(info), this.now().toISOString()],
        );
        await this.log({ actor: 'system' }, 'workspace.provisioned', id, { provisioner: this.d.provisioner.kind });
      } catch (e: any) {
        const msg = e instanceof ProvisionError ? e.message : 'onbekende fout';
        this.d.log.error(`klaarzetten van ${ws.slug} mislukte: ${e?.message || e}`);
        await this.d.db.query('UPDATE workspaces SET status_reason = $2, updated_at = $3 WHERE id = $1', [id, `Klaarzetten mislukte: ${msg}`, this.now().toISOString()]);
        await this.log({ actor: 'system' }, 'workspace.provision_failed', id, { error: msg });
      } finally {
        this.invalidate(ws.slug);
      }
    });
  }

  /** Stop the instance and keep its data. reason: trial_ended | payment_failed | canceled | operator. */
  suspend(id: string, reason: string, ref: ActorRef): Promise<void> {
    return this.lock(id, async () => {
      const ws = await this.get(id);
      if (!ws) return;
      if (ws.status === 'suspended') {
        // An operator hold overrides a billing pause (billing must not resume it).
        if (reason === 'operator' && ws.status_reason !== 'operator') {
          await this.d.db.query("UPDATE workspaces SET status_reason = 'operator', updated_at = $2 WHERE id = $1", [id, this.now().toISOString()]);
          await this.log(ref, 'workspace.suspended', id, { reason });
        }
        return;
      }
      if (ws.status !== 'active') return;
      const now = this.now().toISOString();
      await this.d.db.query("UPDATE workspaces SET status = 'suspended', status_reason = $2, suspended_at = $3, health = 'unknown', updated_at = $3 WHERE id = $1", [id, reason, now]);
      this.invalidate(ws.slug); // the router shows the paused page from this moment on
      // Dedicated: we cannot (and do not) stop the customer's server. Suspension = licence/support status only.
      if (ws.deployment !== 'dedicated') {
        try {
          await this.d.provisioner.stop(ws.instance as InstanceInfo);
        } catch (e) {
          this.d.log.error(`stoppen van ${ws.slug} mislukte`, e);
        }
      }
      await this.log(ref, 'workspace.suspended', id, { reason, deployment: ws.deployment });
    });
  }

  /** Start a suspended instance again (same data, same master key). */
  resume(id: string, ref: ActorRef): Promise<void> {
    return this.lock(id, async () => {
      const ws = await this.get(id);
      if (!ws || ws.status !== 'suspended') return;
      const info = ws.deployment === 'dedicated' ? ws.instance : await this.d.provisioner.start(ws.instance as InstanceInfo, this.spec(ws));
      const now = this.now().toISOString();
      await this.d.db.query(
        "UPDATE workspaces SET status = 'active', status_reason = NULL, suspended_at = NULL, instance = $2::jsonb, health = $4, health_checked_at = $3, health_fail_streak = 0, updated_at = $3 WHERE id = $1",
        [id, JSON.stringify(info), now, ws.deployment === 'dedicated' ? 'unknown' : 'healthy'],
      );
      this.invalidate(ws.slug);
      await this.log(ref, 'workspace.resumed', id);
    });
  }

  /** Delete the instance and all its data; keep a minimal tombstone row. */
  remove(id: string, ref: ActorRef): Promise<void> {
    return this.lock(id, async () => {
      const ws = await this.get(id);
      if (!ws || ws.status === 'deleted') return;
      const now = this.now().toISOString();
      await this.d.db.query("UPDATE workspaces SET status = 'deleting', updated_at = $2 WHERE id = $1", [id, now]);
      this.invalidate(ws.slug);
      // Dedicated: the customer's server and data stay where they are (their responsibility, see the dashboard).
      if (ws.deployment !== 'dedicated' && ws.instance && (ws.instance as InstanceInfo).kind) await this.d.provisioner.remove(ws.instance as InstanceInfo);
      for (const ex of await this.d.db.query<ExportRow>('SELECT * FROM exports WHERE workspace_id = $1', [id])) this.unlinkExport(ex);
      fs.rmSync(path.join(this.d.cfg.dataDir, 'exports', id), { recursive: true, force: true });
      await this.d.db.query('DELETE FROM exports WHERE workspace_id = $1', [id]);
      await this.d.db.query(
        `UPDATE workspaces SET status = 'deleted', status_reason = NULL, deleted_at = $2, master_key_enc = NULL, instance = '{}'::jsonb,
           claim_token_hash = NULL, claim_expires_at = NULL, health = 'unknown', storage_bytes = NULL, external_url = NULL, setup_token_hash = NULL,
           health_detail = NULL, health_fail_streak = 0, updated_at = $2 WHERE id = $1`,
        [id, this.now().toISOString()],
      );
      this.invalidate(ws.slug);
      await this.log(ref, 'workspace.deleted', id, { slug: ws.slug });
    });
  }

  /** Change the plan and apply its resource limits to a running instance. */
  async setPlan(id: string, planId: string) {
    const plan = planById(this.d.plans, planId);
    const ws = await this.get(id);
    if (!ws) return;
    await this.d.db.query('UPDATE workspaces SET plan = $2, updated_at = $3 WHERE id = $1', [id, plan.id, this.now().toISOString()]);
    if (ws.status === 'active' && ws.deployment !== 'dedicated' && this.d.provisioner.applyLimits) {
      await this.d.provisioner.applyLimits(ws.instance as InstanceInfo, plan).catch((e) => this.d.log.error(`limieten van ${ws.slug} aanpassen mislukte`, e));
    }
  }

  // ---------- export ----------

  private exportsDir(id: string) {
    return path.join(this.d.cfg.dataDir, 'exports', id);
  }

  private unlinkExport(ex: ExportRow) {
    const file = path.resolve(this.exportsDir(ex.workspace_id), path.basename(ex.file));
    fs.rmSync(file, { force: true });
  }

  createExport(id: string, ref: ActorRef): Promise<ExportRow> {
    return this.lock(id, async () => {
      const ws = await this.get(id);
      if (ws?.deployment === 'dedicated') {
        throw new UserError('Je dedicated TeamBot draait op je eigen server; exporteren doe je daar (Instellingen → Gegevens → Back-ups, of een volume-back-up). Wij hebben geen kopie van je data.');
      }
      if (!ws || (ws.status !== 'active' && ws.status !== 'suspended')) throw new UserError('Deze workspace kan nu niet worden geëxporteerd.');
      const now = this.now();
      const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      const file = `teambot-${ws.slug}-${stamp}-${randomToken(4).replace(/[^a-z0-9]/gi, '')}.zip`;
      const out = path.join(this.exportsDir(id), file);
      try {
        await this.d.provisioner.exportData(ws.instance as InstanceInfo, this.spec(ws), out);
      } catch (e: any) {
        fs.rmSync(out, { force: true });
        this.d.log.error(`export van ${ws.slug} mislukte: ${e?.message || e}`);
        throw new UserError(e instanceof ProvisionError ? e.message : 'De export is mislukt. Probeer het later opnieuw.', 500);
      }
      const row: ExportRow = {
        id: newId('exp_'),
        workspace_id: id,
        file,
        size_bytes: fs.statSync(out).size,
        created_at: now,
        expires_at: addDays(now, this.d.cfg.exportDays),
      };
      await this.d.db.query('INSERT INTO exports (id, workspace_id, file, size_bytes, created_by, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
        row.id,
        id,
        file,
        row.size_bytes,
        ref.actorId ?? null,
        now.toISOString(),
        row.expires_at.toISOString(),
      ]);
      await this.log(ref, 'workspace.exported', id, { size: row.size_bytes });
      return row;
    });
  }

  async exports(id: string): Promise<ExportRow[]> {
    return this.d.db.query<ExportRow>('SELECT * FROM exports WHERE workspace_id = $1 AND expires_at > $2 ORDER BY created_at DESC', [id, this.now().toISOString()]);
  }

  /** Absolute path of an export file of this workspace, or null. */
  async exportPath(workspaceId: string, exportId: string): Promise<string | null> {
    const ex = await one<ExportRow>(this.d.db, 'SELECT * FROM exports WHERE id = $1 AND workspace_id = $2 AND expires_at > $3', [exportId, workspaceId, this.now().toISOString()]);
    if (!ex) return null;
    const dir = path.resolve(this.exportsDir(workspaceId));
    const file = path.resolve(dir, path.basename(ex.file));
    return file.startsWith(dir + path.sep) && fs.existsSync(file) ? file : null;
  }

  async cleanupExports() {
    const rows = await this.d.db.query<ExportRow>('SELECT * FROM exports WHERE expires_at <= $1', [this.now().toISOString()]);
    for (const ex of rows) this.unlinkExport(ex);
    if (rows.length) await this.d.db.query('DELETE FROM exports WHERE expires_at <= $1', [this.now().toISOString()]);
  }

  // ---------- owner claim (bootstrap of the TeamBot owner account) ----------

  /** One-time link that lets the workspace owner create the owner account inside their fresh TeamBot. */
  async newClaimLink(id: string, ref: ActorRef): Promise<string> {
    const ws = await this.get(id);
    if (ws?.deployment === 'dedicated') throw new UserError('Bij een dedicated omgeving maak je het eigenaar-account aan met de setup-link uit de installatie-instructies.');
    if (!ws || ws.status !== 'active') throw new UserError('Je workspace draait nog niet.');
    if (ws.owner_claimed) throw new UserError('Het eigenaar-account bestaat al. Log in op je TeamBot.');
    const token = randomToken();
    await this.d.db.query('UPDATE workspaces SET claim_token_hash = $2, claim_expires_at = $3 WHERE id = $1', [id, sha256(token), new Date(this.now().getTime() + CLAIM_MINUTES * 60_000).toISOString()]);
    this.invalidate(ws.slug);
    await this.log(ref, 'workspace.claim_link', id);
    return `${this.url(ws)}/_cloud/claim?t=${encodeURIComponent(token)}`;
  }

  validClaim(route: RouteInfo, token: string | undefined | null): boolean {
    if (!token || token.length > 200 || route.ownerClaimed || !route.claimHash || !route.claimExpires) return false;
    return safeEqual(sha256(token), route.claimHash) && new Date(route.claimExpires) > this.now();
  }

  async markClaimed(id: string, ip: string | null) {
    const rows = await this.d.db.query<{ slug: string }>(
      'UPDATE workspaces SET owner_claimed = TRUE, claim_token_hash = NULL, claim_expires_at = NULL, updated_at = $2 WHERE id = $1 AND owner_claimed = FALSE RETURNING slug',
      [id, this.now().toISOString()],
    );
    if (rows.length) {
      this.invalidate(rows[0].slug);
      await this.log({ actor: 'user', ip }, 'workspace.owner_claimed', id);
    }
  }

  // ---------- routing ----------

  async route(slug: string): Promise<RouteInfo | null> {
    const hit = this.cache.get(slug);
    if (hit && Date.now() - hit.at < ROUTE_TTL_MS) return hit.info;
    const ws = await one<Workspace>(this.d.db, 'SELECT * FROM workspaces WHERE slug = $1', [slug]);
    const info: RouteInfo | null = ws
      ? {
          id: ws.id,
          slug: ws.slug,
          status: ws.status,
          upstream: ws.status === 'active' && ws.deployment !== 'dedicated' && (ws.instance as InstanceInfo)?.kind ? this.d.provisioner.upstream(ws.instance as InstanceInfo) : null,
          ownerClaimed: ws.owner_claimed,
          claimHash: ws.claim_token_hash,
          claimExpires: ws.claim_expires_at,
          dedicated: ws.deployment === 'dedicated',
        }
      : null;
    this.cache.set(slug, { at: Date.now(), info });
    return info;
  }

  // ---------- background ----------

  /**
   * One health check of one active workspace. Shared: the provisioner (and a restart when a dev process died).
   * Dedicated: GET <url>/healthz from outside, with the SSRF guards in health.ts. Never throws.
   */
  async checkHealth(ws: Workspace, measureUsage = false): Promise<{ ok: boolean; detail: string | null; usage?: number | null }> {
    if (ws.deployment === 'dedicated') {
      if (!ws.external_url) return { ok: false, detail: 'geen adres ingesteld' };
      const r = await checkInstance(ws.external_url, { allowPrivate: this.d.cfg.dedicated.allowPrivate, timeoutMs: this.d.cfg.dedicated.timeoutMs, resolve: this.d.resolve });
      return { ok: r.ok, detail: r.ok ? null : r.error || 'niet bereikbaar' };
    }
    const info = ws.instance as InstanceInfo;
    let healthy = info?.kind ? await this.d.provisioner.health(info) : false;
    if (!healthy && info?.kind === 'process' && this.d.provisioner.upstream(info) === null) {
      // Dev provisioner: the child process died (crash, control-plane restart). Start it again.
      await this.lock(ws.id, async () => {
        const cur = await this.get(ws.id);
        if (cur?.status !== 'active') return;
        try {
          const next = await this.d.provisioner.start(cur.instance as InstanceInfo, this.spec(cur));
          await this.d.db.query('UPDATE workspaces SET instance = $2::jsonb WHERE id = $1', [ws.id, JSON.stringify(next)]);
          this.invalidate(ws.slug);
          healthy = true;
          await this.log({ actor: 'system' }, 'workspace.restarted', ws.id);
        } catch (e) {
          this.d.log.error(`herstarten van ${ws.slug} mislukte`, e);
        }
      });
    }
    const usage = measureUsage && info?.kind && this.d.provisioner.usageBytes ? await this.d.provisioner.usageBytes(info).catch(() => null) : undefined;
    return { ok: healthy, detail: healthy ? null : 'instantie reageert niet', usage };
  }

  /** After a control-plane restart: make sure every active instance runs (the process provisioner lost its children). */
  async restoreOnBoot() {
    const rows = await this.d.db.query<Workspace>("SELECT * FROM workspaces WHERE status IN ('active', 'provisioning') AND deployment = 'shared'");
    for (const ws of rows) {
      if (ws.status === 'provisioning') {
        this.startProvisioning(ws.id);
        continue;
      }
      await this.lock(ws.id, async () => {
        try {
          const info = await this.d.provisioner.start(ws.instance as InstanceInfo, this.spec(ws));
          await this.d.db.query('UPDATE workspaces SET instance = $2::jsonb, health = $3 WHERE id = $1', [ws.id, JSON.stringify(info), 'healthy']);
        } catch (e) {
          this.d.log.error(`starten van ${ws.slug} na herstart mislukte`, e);
          await this.d.db.query("UPDATE workspaces SET health = 'unhealthy' WHERE id = $1", [ws.id]);
        }
        this.invalidate(ws.slug);
      });
    }
  }

  /** Wait until all background provisioning finished (tests, shutdown). */
  async idle() {
    await Promise.allSettled([...this.pending.values()]);
    await Promise.allSettled([...this.locks.values()]);
  }
}
