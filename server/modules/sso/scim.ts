import crypto from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import type { Ctx, User } from '../../core/types.js';
import { now } from '../../core/db.js';
import { redact } from '../../core/secrets.js';
import { HttpError } from '../../core/http.js';
import { SCIM_PATH, publicBase, scimSettings, sha256 } from './config.js';
import { Limiter } from '../../core/util.js';
import { deactivateUser, deleteUserData, reactivateUser } from './accounts.js';
import { type GroupMapper, scimGroupRoutes } from './groups.js';
import { ENTERPRISE_SCHEMA, ERROR, GROUP_SCHEMA, LIST, MAX_COUNT, PATCH_OP, ScimError, USER_SCHEMA, clean, paging, parseEqFilter, send, toBool, wantAttr } from './scim-util.js';
import { PLACE } from '../../../shared/places.js';

/**
 * SCIM 2.0 (RFC 7643/7644) — the subset Microsoft Entra ID and Okta use for provisioning: Users and Groups with
 * list/filter (eq), get, create, replace, patch and delete, plus the discovery endpoints. Authenticated with one
 * bearer token created by the owner (stored as a SHA-256 hash, compared in constant time). Accounts created here are
 * always members; the owner and manually made admins are read-only for SCIM (an admin role that came from a SCIM
 * group mapping stays manageable, so offboarding keeps working).
 */

export interface ScimUserRow {
  user_id: string;
  external_id: string | null;
  user_name: string;
  deleted: number;
  created_at: string;
  updated_at: string;
}

const looksEmail = (s: string) => /^[^@\s]{1,64}@[^@\s]{1,255}$/.test(s);

/** Attributes TeamBot keeps from a SCIM user. undefined = not mentioned. */
interface Changes {
  userName?: string;
  email?: string;
  name?: string;
  givenName?: string;
  familyName?: string;
  externalId?: string | null;
  active?: boolean;
}

function primaryEmail(emails: any): string | undefined {
  if (!Array.isArray(emails) || !emails.length) return undefined;
  const pick = emails.find((e) => e && (e.primary === true || toBool(e.primary) === true)) || emails.find((e) => e?.type === 'work') || emails[0];
  const v = clean(pick?.value, 200).toLowerCase();
  return v || undefined;
}

/** Apply one attribute (by SCIM path, case-insensitive) to the change set. Unknown attributes are ignored. */
function setAttr(ch: Changes, rawPath: string, value: any, op: 'add' | 'replace' | 'remove') {
  const p = rawPath.trim().replace(new RegExp(`^${USER_SCHEMA.replace(/[.:]/g, '\\$&')}:`, 'i'), '');
  const lp = p.toLowerCase();
  if (op === 'remove') {
    if (lp === 'externalid') ch.externalId = null;
    return;
  }
  if (lp === 'active') {
    const b = toBool(value);
    if (b === undefined) throw new ScimError(400, '“active” moet true of false zijn', 'invalidValue');
    ch.active = b;
  } else if (lp === 'username') ch.userName = clean(value, 200);
  else if (lp === 'displayname') ch.name = clean(value, 100) || ch.name;
  else if (lp === 'name.formatted') ch.name = clean(value, 100) || ch.name;
  else if (lp === 'name.givenname') ch.givenName = clean(value, 60);
  else if (lp === 'name.familyname') ch.familyName = clean(value, 60);
  else if (lp === 'name' && value && typeof value === 'object') {
    if (value.formatted) ch.name = clean(value.formatted, 100);
    if (value.givenName !== undefined) ch.givenName = clean(value.givenName, 60);
    if (value.familyName !== undefined) ch.familyName = clean(value.familyName, 60);
  } else if (lp === 'externalid') ch.externalId = clean(value, 200) || null;
  else if (lp === 'emails') {
    const e = primaryEmail(Array.isArray(value) ? value : [value]);
    if (e) ch.email = e;
  } else if (/^emails\[.*\]\.value$/.test(lp) || lp === 'emails.value') {
    const v = clean(Array.isArray(value) ? value[0]?.value ?? value[0] : value, 200).toLowerCase();
    if (v) ch.email = v;
  }
}

/** A full user resource (POST/PUT body) to a change set. */
function fromResource(body: any): Changes {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ScimError(400, 'Ongeldige gebruiker', 'invalidSyntax');
  const ch: Changes = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === 'schemas' || k === 'id' || k === 'meta' || k === 'password' || k === 'groups' || k === 'roles') continue;
    if (k === ENTERPRISE_SCHEMA) continue;
    setAttr(ch, k, v, 'replace');
  }
  return ch;
}

/** A PatchOp body (Entra: capitalised ops and "False" strings; Okta: value objects without path). */
function fromPatch(body: any): Changes {
  const ops = body?.Operations ?? body?.operations;
  if (!Array.isArray(ops)) throw new ScimError(400, 'PatchOp zonder Operations', 'invalidSyntax');
  if (Array.isArray(body?.schemas) && !body.schemas.includes(PATCH_OP)) throw new ScimError(400, `schemas moet ${PATCH_OP} bevatten`, 'invalidSyntax');
  const ch: Changes = {};
  for (const o of ops.slice(0, 100)) {
    const op = String(o?.op || '').toLowerCase();
    if (!['add', 'replace', 'remove'].includes(op)) throw new ScimError(400, `Onbekende operatie: ${String(o?.op).slice(0, 20)}`, 'invalidSyntax');
    const path = typeof o.path === 'string' ? o.path : '';
    if (path) setAttr(ch, path, o.value, op as any);
    else if (o.value && typeof o.value === 'object' && !Array.isArray(o.value)) {
      for (const [k, v] of Object.entries(o.value)) if (k !== ENTERPRISE_SCHEMA) setAttr(ch, k, v, op as any);
    } else if (op !== 'remove') throw new ScimError(400, 'Operatie zonder path vraagt een object als value', 'invalidSyntax');
  }
  return ch;
}

const composeName = (ch: Changes) => ch.name || [ch.givenName, ch.familyName].filter(Boolean).join(' ').trim() || undefined;

export function scimRouter(ctx: Ctx, mapper: GroupMapper) {
  const r = express.Router();
  const fails = new Limiter(10, 60_000);
  let lastTouch = 0;

  const base = (req: Request) => publicBase(ctx, req).url + SCIM_PATH;

  const mapping = (userId: string) => ctx.store.one<ScimUserRow>('SELECT * FROM scim_users WHERE user_id = ?', userId) || null;
  const visibleUser = (id: string): { u: User; m: ScimUserRow | null } => {
    const u = ctx.store.user(id);
    const m = u ? mapping(u.id) : null;
    if (!u || (m && m.deleted) || (!u.email && !m)) throw new ScimError(404, 'Gebruiker niet gevonden');
    return { u, m };
  };

  const resource = (req: Request, u: User, m: ScimUserRow | null) => ({
    schemas: [USER_SCHEMA],
    id: u.id,
    ...(m?.external_id ? { externalId: m.external_id } : {}),
    userName: m?.user_name || u.email,
    name: { formatted: u.name },
    displayName: u.name,
    emails: u.email ? [{ value: u.email, type: 'work', primary: true }] : [],
    active: !u.disabled,
    ...(wantAttr(req, 'groups') ? { groups: mapper.groupsOf(u.id).map((g) => ({ value: g.id, display: g.display_name, $ref: `${base(req)}/Groups/${g.id}`, type: 'direct' })) } : {}),
    meta: { resourceType: 'User', created: u.created_at, lastModified: m?.updated_at || u.created_at, location: `${base(req)}/Users/${u.id}` },
  });

  /** Reactivating takes a seat again (TEAMBOT_MAX_USERS), just like creating an account. */
  const seatFree = () => {
    const max = ctx.auth.maxUsers();
    if (!max) return;
    const active = ctx.store.one<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE disabled = 0')?.n ?? 0;
    if (active >= max) throw new ScimError(403, max === 1 ? 'Deze installatie heeft maximaal 1 gebruiker. Blokkeer eerst iemand of kies een groter abonnement.' : `Deze installatie heeft maximaal ${max} gebruikers. Blokkeer eerst iemand of kies een groter abonnement.`);
  };

  const upsertMapping = (userId: string, patch: { user_name: string; external_id?: string | null; deleted?: number }) => {
    const cur = mapping(userId);
    if (cur) ctx.store.exec('UPDATE scim_users SET user_name = ?, external_id = ?, deleted = ?, updated_at = ? WHERE user_id = ?', patch.user_name, patch.external_id === undefined ? cur.external_id : patch.external_id, patch.deleted ?? cur.deleted, now(), userId);
    else ctx.store.exec('INSERT INTO scim_users (user_id, external_id, user_name, deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', userId, patch.external_id ?? null, patch.user_name, patch.deleted ?? 0, now(), now());
  };

  const userNameTaken = (userName: string, exceptUserId: string) =>
    !!ctx.store.one('SELECT user_id FROM scim_users WHERE lower(user_name) = lower(?) AND deleted = 0 AND user_id != ?', userName, exceptUserId);

  /** Apply a change set to an existing account. Owner/admin accounts may not change at all. */
  const apply = (req: Request, u: User, m: ScimUserRow | null, ch: Changes, replace = false): { u: User; m: ScimUserRow | null; changed: string[] } => {
    const changed: string[] = [];
    const name = composeName(ch);
    const userName = ch.userName !== undefined ? ch.userName : undefined;
    let email = ch.email;
    // userName doubles as the e-mail address when no e-mail is sent (PUT/POST), or when both were the same so far.
    if (!email && userName && looksEmail(userName.toLowerCase()) && (replace || (m?.user_name || u.email || '').toLowerCase() === (u.email || '').toLowerCase())) email = userName.toLowerCase();
    if (email !== undefined && !looksEmail(email)) throw new ScimError(400, 'Ongeldig e-mailadres', 'invalidValue');
    if (userName !== undefined && !userName) throw new ScimError(400, 'userName mag niet leeg zijn', 'invalidValue');
    if (email && email !== u.email) changed.push('email');
    if (name && name !== u.name) changed.push('name');
    if (userName && userName !== (m?.user_name || u.email)) changed.push('userName');
    if (ch.externalId !== undefined && (ch.externalId || null) !== (m?.external_id || null)) changed.push('externalId');
    if (ch.active !== undefined && ch.active === u.disabled) changed.push('active');
    if (!changed.length) return { u, m, changed };
    if (!mapper.managed(u)) throw new ScimError(403, 'De eigenaar en beheerders van TeamBot kunnen niet via SCIM worden gewijzigd.', 'mutability');
    if (changed.includes('active') && ch.active === true) seatFree();
    if (email && email !== u.email && ctx.store.one('SELECT id FROM users WHERE email = ? AND id != ?', email, u.id)) throw new ScimError(409, 'Dit e-mailadres is al in gebruik', 'uniqueness');
    if (userName && userNameTaken(userName, u.id)) throw new ScimError(409, 'Deze userName is al in gebruik', 'uniqueness');
    ctx.store.tx(() => {
      const patch: any = {};
      if (changed.includes('email')) patch.email = email;
      if (changed.includes('name')) patch.name = name;
      ctx.store.update('users', u.id, patch);
      upsertMapping(u.id, { user_name: userName || m?.user_name || email || u.email || u.id, external_id: ch.externalId === undefined ? undefined : ch.externalId });
    });
    if (changed.includes('active')) {
      if (ch.active === false) {
        const r = deactivateUser(ctx, u.id);
        ctx.audit(u.id, 'scim.user.deactivated', { sessionsRevoked: r.sessions, runsStopped: r.runs });
      } else {
        reactivateUser(ctx, u.id);
        ctx.audit(u.id, 'scim.user.reactivated', {});
      }
      // Blocked: everything the group mapping granted is taken back; active again: granted again.
      mapper.apply(u.id, ch.active ? 'geactiveerd' : 'geblokkeerd');
    }
    const fields = changed.filter((f) => f !== 'active');
    if (fields.length) ctx.audit(u.id, 'scim.user.updated', { fields });
    return { u: ctx.store.user(u.id)!, m: mapping(u.id), changed };
  };

  // ---- plumbing: mode, body parser, authentication ----
  r.use((req, res, next) => {
    if (ctx.config.mode !== 'server') return send(res, 404, { schemas: [ERROR], status: '404', detail: 'SCIM is alleen beschikbaar in servermodus' });
    next();
  });
  r.use((req, res, next) => {
    const ip = req.ip || '';
    if (fails.blocked(ip)) return send(res, 429, { schemas: [ERROR], status: '429', detail: 'Te veel mislukte pogingen; probeer het over een minuut opnieuw' });
    const h = String(req.headers.authorization || '');
    const presented = /^Bearer\s+(.+)$/i.exec(h)?.[1]?.trim() || '';
    const row = ctx.store.one<{ id: string; token_hash: string }>('SELECT id, token_hash FROM scim_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 1');
    const ok = !!presented && !!row && crypto.timingSafeEqual(Buffer.from(sha256(presented), 'hex'), Buffer.from(row.token_hash, 'hex'));
    if (!ok) {
      fails.hit(ip);
      res.setHeader('WWW-Authenticate', 'Bearer realm="TeamBot SCIM"');
      return send(res, 401, { schemas: [ERROR], status: '401', detail: 'Geen of ongeldige SCIM-sleutel' });
    }
    if (Date.now() - lastTouch > 30_000) {
      lastTouch = Date.now();
      ctx.store.exec('UPDATE scim_tokens SET last_used_at = ? WHERE id = ?', now(), row!.id);
    }
    next();
  });
  // Bodies are parsed only after authentication (application/json is already parsed by the app itself).
  r.use(express.json({ type: ['application/scim+json', 'application/json'], limit: '1mb' }));

  // ---- discovery ----
  r.get('/ServiceProviderConfig', (req, res) =>
    send(res, 200, {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: MAX_COUNT },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [{ type: 'oauthbearertoken', name: 'OAuth Bearer Token', description: `SCIM-sleutel uit TeamBot (${PLACE.users})`, primary: true }],
      meta: { resourceType: 'ServiceProviderConfig', location: `${base(req)}/ServiceProviderConfig` },
    }),
  );
  const resourceType = (req: Request, id: 'User' | 'Group') => ({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
    id,
    name: id,
    endpoint: id === 'User' ? '/Users' : '/Groups',
    description: id === 'User' ? 'TeamBot-account' : 'Groep uit de identiteitsprovider (gekoppeld aan rol, groepsgesprekken en budget)',
    schema: id === 'User' ? USER_SCHEMA : GROUP_SCHEMA,
    meta: { resourceType: 'ResourceType', location: `${base(req)}/ResourceTypes/${id}` },
  });
  r.get('/ResourceTypes', (req, res) => send(res, 200, { schemas: [LIST], totalResults: 2, startIndex: 1, itemsPerPage: 2, Resources: [resourceType(req, 'User'), resourceType(req, 'Group')] }));
  r.get('/ResourceTypes/:id', (req, res) => {
    if (req.params.id !== 'User' && req.params.id !== 'Group') return send(res, 404, { schemas: [ERROR], status: '404', detail: 'Resourcetype niet gevonden' });
    send(res, 200, resourceType(req, req.params.id));
  });
  const attr = (name: string, extra: Record<string, any> = {}) => ({ name, type: 'string', multiValued: false, required: false, caseExact: false, mutability: 'readWrite', returned: 'default', uniqueness: 'none', ...extra });
  const ref = (name: string, types: string[], extra: Record<string, any> = {}) =>
    attr(name, {
      type: 'complex',
      multiValued: true,
      subAttributes: [attr('value', { mutability: 'immutable' }), attr('display', { mutability: 'readOnly' }), attr('$ref', { type: 'reference', referenceTypes: types, mutability: 'immutable' }), attr('type', { mutability: 'immutable' })],
      ...extra,
    });
  const userSchema = (req: Request) => ({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
    id: USER_SCHEMA,
    name: 'User',
    description: 'TeamBot-account (beperkte set attributen)',
    attributes: [
      attr('userName', { required: true, uniqueness: 'server' }),
      attr('name', { type: 'complex', subAttributes: [attr('formatted'), attr('givenName'), attr('familyName')] }),
      attr('displayName'),
      attr('emails', { type: 'complex', multiValued: true, subAttributes: [attr('value'), attr('type'), attr('primary', { type: 'boolean' })] }),
      attr('active', { type: 'boolean' }),
      attr('externalId', { caseExact: true }),
      ref('groups', ['Group'], { mutability: 'readOnly' }),
    ],
    meta: { resourceType: 'Schema', location: `${base(req)}/Schemas/${USER_SCHEMA}` },
  });
  const groupSchema = (req: Request) => ({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
    id: GROUP_SCHEMA,
    name: 'Group',
    description: 'Groep',
    attributes: [attr('displayName', { required: true, uniqueness: 'server' }), attr('externalId', { caseExact: true }), ref('members', ['User'])],
    meta: { resourceType: 'Schema', location: `${base(req)}/Schemas/${GROUP_SCHEMA}` },
  });
  r.get('/Schemas', (req, res) => send(res, 200, { schemas: [LIST], totalResults: 2, startIndex: 1, itemsPerPage: 2, Resources: [userSchema(req), groupSchema(req)] }));
  r.get('/Schemas/:id', (req, res) => {
    if (req.params.id === USER_SCHEMA) return send(res, 200, userSchema(req));
    if (req.params.id === GROUP_SCHEMA) return send(res, 200, groupSchema(req));
    send(res, 404, { schemas: [ERROR], status: '404', detail: 'Schema niet gevonden' });
  });

  // ---- users ----
  r.get('/Users', (req, res) => {
    const where: string[] = ['(s.deleted IS NULL OR s.deleted = 0)', '(u.email IS NOT NULL OR s.user_id IS NOT NULL)'];
    const params: any[] = [];
    const f = parseEqFilter(req.query.filter);
    if (f) {
      const [a, v] = f;
      if (a === 'username') (where.push('lower(coalesce(s.user_name, u.email)) = lower(?)'), params.push(v));
      else if (a === 'externalid') (where.push('s.external_id = ?'), params.push(v));
      else if (a === 'id') (where.push('u.id = ?'), params.push(v));
      else if (a === 'emails' || a === 'emails.value' || /^emails\[type eq "?work"?\]\.value$/.test(a)) (where.push('lower(u.email) = lower(?)'), params.push(v));
      else throw new ScimError(400, `Filter op “${a.slice(0, 40)}” wordt niet ondersteund`, 'invalidFilter');
    }
    const { startIndex, count } = paging(req);
    const from = `FROM users u LEFT JOIN scim_users s ON s.user_id = u.id WHERE ${where.join(' AND ')}`;
    const total = ctx.store.one<{ n: number }>(`SELECT COUNT(*) AS n ${from}`, ...params)?.n || 0;
    const ids = count ? ctx.store.all<{ id: string }>(`SELECT u.id ${from} ORDER BY u.created_at, u.id LIMIT ? OFFSET ?`, ...params, count, startIndex - 1) : [];
    const list = ids.map(({ id }) => {
      const u = ctx.store.user(id)!;
      return resource(req, u, mapping(id));
    });
    send(res, 200, { schemas: [LIST], totalResults: total, startIndex, itemsPerPage: list.length, Resources: list });
  });

  r.get('/Users/:id', (req, res) => {
    const { u, m } = visibleUser(req.params.id);
    send(res, 200, resource(req, u, m));
  });

  r.post('/Users', (req, res) => {
    const ch = fromResource(req.body);
    const userName = ch.userName || '';
    if (!userName) throw new ScimError(400, 'userName is verplicht', 'invalidValue');
    const email = (ch.email || (looksEmail(userName.toLowerCase()) ? userName.toLowerCase() : '')).toLowerCase();
    if (!email || !looksEmail(email)) throw new ScimError(400, 'Een e-mailadres is verplicht (userName of emails)', 'invalidValue');
    if (userNameTaken(userName, '')) throw new ScimError(409, 'Deze userName is al in gebruik', 'uniqueness');
    const existing = ctx.store.one<{ id: string }>('SELECT id FROM users WHERE email = ?', email);
    if (existing) {
      // An account that SCIM deleted earlier (deactivated) comes back when the IdP provisions it again.
      const m = mapping(existing.id);
      const u = ctx.store.user(existing.id)!;
      if (!m?.deleted || !mapper.managed(u)) throw new ScimError(409, 'Dit e-mailadres is al in gebruik', 'uniqueness');
      ctx.store.exec('UPDATE scim_users SET deleted = 0, updated_at = ? WHERE user_id = ?', now(), u.id);
      const out = apply(req, u, mapping(u.id), { ...ch, email, active: ch.active ?? true }, true);
      ctx.audit(u.id, 'scim.user.restored', { email });
      res.setHeader('Location', `${base(req)}/Users/${u.id}`);
      return send(res, 201, resource(req, out.u, out.m));
    }
    const name = composeName(ch) || email.split('@')[0];
    const u = ctx.store.tx(() => {
      const created = ctx.auth.createUser({ email, name, role: 'member' });
      upsertMapping(created.id, { user_name: userName, external_id: ch.externalId ?? null });
      return created;
    });
    if (ch.active === false) deactivateUser(ctx, u.id);
    ctx.audit(u.id, 'scim.user.created', { email, active: ch.active !== false });
    res.setHeader('Location', `${base(req)}/Users/${u.id}`);
    send(res, 201, resource(req, ctx.store.user(u.id)!, mapping(u.id)));
  });

  r.put('/Users/:id', (req, res) => {
    const { u, m } = visibleUser(req.params.id);
    const ch = fromResource(req.body);
    if (!ch.userName) throw new ScimError(400, 'userName is verplicht', 'invalidValue');
    const out = apply(req, u, m, ch, true);
    send(res, 200, resource(req, out.u, out.m));
  });

  r.patch('/Users/:id', (req, res) => {
    const { u, m } = visibleUser(req.params.id);
    const out = apply(req, u, m, fromPatch(req.body));
    send(res, 200, resource(req, out.u, out.m));
  });

  r.delete('/Users/:id', async (req, res, next) => {
    try {
      const { u, m } = visibleUser(req.params.id);
      if (!mapper.managed(u)) throw new ScimError(403, 'De eigenaar en beheerders van TeamBot kunnen niet via SCIM worden verwijderd.', 'mutability');
      const mode = scimSettings(ctx).deleteMode;
      // Block first and take back what group mappings granted (admin role, rooms, budget).
      const r2 = deactivateUser(ctx, u.id);
      mapper.apply(u.id, 'verwijderd');
      if (mode === 'delete') {
        const email = u.email;
        const r3 = await deleteUserData(ctx, u.id);
        ctx.audit(null, 'scim.user.deleted', { mode, userId: u.id, email, rows: r3.rows });
      } else {
        upsertMapping(u.id, { user_name: m?.user_name || u.email || u.id, deleted: 1 });
        // A deleted user is no longer a member of any SCIM group.
        ctx.store.exec('DELETE FROM scim_group_members WHERE user_id = ?', u.id);
        ctx.audit(u.id, 'scim.user.deleted', { mode, sessionsRevoked: r2.sessions, runsStopped: r2.runs });
      }
      send(res, 204);
    } catch (e) {
      next(e);
    }
  });

  scimGroupRoutes(r, ctx, mapper, base);
  r.use((_req, res) => send(res, 404, { schemas: [ERROR], status: '404', detail: 'Onbekend SCIM-pad' }));

  // SCIM error format for everything thrown above (also JSON parse errors and core refusals such as the seat limit).
  r.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ScimError) return send(res, err.status, { schemas: [ERROR], status: String(err.status), ...(err.scimType ? { scimType: err.scimType } : {}), detail: err.message });
    if (err instanceof HttpError && err.status < 500) return send(res, err.status, { schemas: [ERROR], status: String(err.status), ...(err.status === 409 ? { scimType: 'uniqueness' } : {}), detail: err.message });
    if (err?.type === 'entity.parse.failed' || err?.status === 400) return send(res, 400, { schemas: [ERROR], status: '400', scimType: 'invalidSyntax', detail: 'Ongeldige JSON' });
    if (err?.status === 413) return send(res, 413, { schemas: [ERROR], status: '413', detail: 'Verzoek te groot' });
    ctx.log.error('[scim]', redact(String(err?.stack || err?.message || err)));
    send(res, 500, { schemas: [ERROR], status: '500', detail: 'Interne fout' });
  });
  return r;
}
