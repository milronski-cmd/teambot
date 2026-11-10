import type { Request, Router } from 'express';
import type { Ctx, User } from '../../core/types.js';
import { defineTable, newId, now } from '../../core/db.js';
import { ah, bad, forbidden, notFound, requireRole } from '../../core/http.js';
import { memberBudgets } from '../../api/member-policy.js';
import { GROUP_SCHEMA, LIST, PATCH_OP, ScimError, clean, paging, parseEqFilter, send, wantAttr } from './scim-util.js';

/**
 * SCIM 2.0 Groups (RFC 7643 §4.2, RFC 7644) as Microsoft Entra ID and Okta push them, plus the owner's mapping of
 * each group to TeamBot: a role (member/admin), rooms (groups & teams module) and a per-member daily budget.
 *
 * The mapping is applied whenever a membership or a mapping changes. It only ever undoes what it granted itself
 * (tracked in scim_applied): a manually made admin, a manually invited room member or a manually set budget stays.
 * The owner account is never touched, data is never deleted, and blocked accounts get nothing new.
 */

defineTable('scim_groups', { json: ['room_ids'] });
defineTable('scim_applied', { json: ['room_ids'], bool: ['role_granted'] });

export interface GroupRow {
  id: string;
  display_name: string;
  external_id: string | null;
  role: 'member' | 'admin';
  room_ids: string[];
  daily_budget_usd: number | null;
  created_at: string;
  updated_at: string;
}

interface Applied {
  user_id: string;
  role_granted: boolean;
  budget: number | null;
  room_ids: string[];
}

interface RoomsHook {
  roomsOf(userId: string): { id: string; name: string }[];
  addPerson(roomId: string, userId: string, byUserId: string): 'added' | 'accepted' | 'already' | 'skipped';
  removePerson(roomId: string, userId: string, byUserId: string): boolean;
}

export class GroupMapper {
  constructor(private ctx: Ctx) {}

  /** The rooms module's hook, or null when that module is not loaded. */
  rooms(): RoomsHook | null {
    const r = this.ctx.services.rooms;
    return r && typeof r.addPerson === 'function' && typeof r.removePerson === 'function' && typeof r.roomsOf === 'function' ? r : null;
  }

  /** Rooms a group can be mapped to: the owner's own active rooms (their bots, their conversations). */
  mappableRooms(): { id: string; name: string }[] | null {
    const r = this.rooms();
    const owner = this.ctx.auth.owner();
    return r && owner ? r.roomsOf(owner.id) : r ? [] : null;
  }

  group(id: string): GroupRow | null {
    return this.ctx.store.get<GroupRow>('scim_groups', id);
  }
  groups(): GroupRow[] {
    return this.ctx.store.find<GroupRow>('scim_groups', {}, { order: 'display_name' });
  }
  members(groupId: string): string[] {
    return this.ctx.store.all<{ user_id: string }>('SELECT user_id FROM scim_group_members WHERE group_id = ? ORDER BY created_at, user_id', groupId).map((r) => r.user_id);
  }
  groupsOf(userId: string): GroupRow[] {
    return this.ctx.store
      .all<any>('SELECT g.* FROM scim_groups g JOIN scim_group_members m ON m.group_id = g.id WHERE m.user_id = ? ORDER BY g.display_name', userId)
      .map((r) => this.ctx.store.decode<GroupRow>('scim_groups', r));
  }

  private applied(userId: string): Applied {
    const row = this.ctx.store.get<Applied>('scim_applied', userId, 'user_id');
    return row ? { ...row, room_ids: Array.isArray(row.room_ids) ? row.room_ids : [] } : { user_id: userId, role_granted: false, budget: null, room_ids: [] };
  }

  /** May SCIM manage this account? Members, and admins whose admin role came from a SCIM group. Never the owner. */
  managed(u: Pick<User, 'id' | 'role'>): boolean {
    if (u.role === 'member') return true;
    return u.role === 'admin' && this.applied(u.id).role_granted;
  }

  /** Bring one account in line with its SCIM groups (see the file comment). */
  apply(userId: string, why: string) {
    const ctx = this.ctx;
    const u = ctx.store.user(userId);
    if (!u || u.role === 'owner') return;
    const groups = this.groupsOf(userId);
    const active = !u.disabled;
    const prev = this.applied(userId);
    const next: Applied = { ...prev, room_ids: [...prev.room_ids] };
    const changes: Record<string, any> = {};

    // Role: promote members in an admin-mapped group; demote only those SCIM promoted.
    const wantAdmin = active && groups.some((g) => g.role === 'admin');
    if (wantAdmin && u.role === 'member') {
      ctx.store.update('users', u.id, { role: 'admin' });
      next.role_granted = true;
      changes.role = 'admin';
    } else if (!wantAdmin && prev.role_granted) {
      if (u.role === 'admin') {
        ctx.store.update('users', u.id, { role: 'member' });
        changes.role = 'member';
      }
      next.role_granted = false;
    }

    // Rooms: join mapped rooms; leave only the rooms SCIM added.
    const svc = this.rooms();
    const owner = ctx.auth.owner();
    if (svc && owner) {
      const want = active ? [...new Set(groups.flatMap((g) => g.room_ids || []))] : [];
      for (const rid of want) {
        if (next.room_ids.includes(rid)) continue;
        try {
          if (svc.addPerson(rid, u.id, owner.id) === 'added') {
            next.room_ids.push(rid);
            (changes.roomsAdded ||= []).push(rid);
          }
        } catch (e: any) {
          ctx.log.warn(`[scim] toevoegen aan groep ${rid} mislukt: ${e?.message || e}`);
        }
      }
      for (const rid of [...next.room_ids]) {
        if (want.includes(rid)) continue;
        try {
          svc.removePerson(rid, u.id, owner.id);
        } catch (e: any) {
          ctx.log.warn(`[scim] verwijderen uit groep ${rid} mislukt: ${e?.message || e}`);
        }
        next.room_ids = next.room_ids.filter((x) => x !== rid);
        (changes.roomsRemoved ||= []).push(rid);
      }
    }

    // Budget (members only): the highest budget of the mapped groups; removed again only if still ours.
    const role = ctx.store.user(u.id)!.role;
    const budgets = groups.map((g) => g.daily_budget_usd).filter((b): b is number => typeof b === 'number');
    const want = active && role === 'member' && budgets.length ? Math.max(...budgets) : null;
    const all = { ...memberBudgets(ctx) };
    if (want !== null) {
      if (all[u.id] !== want) {
        all[u.id] = want;
        ctx.store.setSetting('', 'memberBudgets', all);
        changes.budget = want;
      }
      next.budget = want;
    } else if (prev.budget !== null) {
      if (all[u.id] === prev.budget) {
        delete all[u.id];
        ctx.store.setSetting('', 'memberBudgets', all);
        changes.budget = null;
      }
      next.budget = null;
    }

    ctx.store.exec(
      'INSERT INTO scim_applied (user_id, role_granted, budget, room_ids, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET role_granted = excluded.role_granted, budget = excluded.budget, room_ids = excluded.room_ids, updated_at = excluded.updated_at',
      u.id,
      next.role_granted ? 1 : 0,
      next.budget,
      JSON.stringify(next.room_ids),
      now(),
    );
    if (Object.keys(changes).length) ctx.audit(u.id, 'scim.mapping.applied', { why, ...changes, groups: groups.map((g) => g.display_name) });
  }

  applyMany(userIds: Iterable<string>, why: string) {
    for (const id of new Set(userIds)) this.apply(id, why);
  }

  /** Everyone the mapping may concern: group members plus accounts that still hold something SCIM granted. */
  everyone(): string[] {
    return this.ctx.store.all<{ id: string }>('SELECT user_id AS id FROM scim_group_members UNION SELECT user_id AS id FROM scim_applied').map((r) => r.id);
  }
}

// ---------------------------------------------------------------- SCIM /Groups

/** Member ids from `[{value}]`, `{value}` or a plain string. */
function idsFrom(v: any): string[] {
  const list = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
  return list.map((x) => clean(typeof x === 'object' && x ? x.value : x, 100)).filter(Boolean);
}

export function scimGroupRoutes(r: Router, ctx: Ctx, mapper: GroupMapper, base: (req: Request) => string) {
  /** Users SCIM can see (same rule as /Users): not deleted via SCIM, and with an e-mail or a SCIM record. */
  const visibleUser = (id: string): User | null => {
    const u = ctx.store.user(id);
    if (!u) return null;
    const m = ctx.store.one<{ deleted: number }>('SELECT deleted FROM scim_users WHERE user_id = ?', u.id);
    if (m?.deleted || (!u.email && !m)) return null;
    return u;
  };

  const resource = (req: Request, g: GroupRow) => ({
    schemas: [GROUP_SCHEMA],
    id: g.id,
    ...(g.external_id ? { externalId: g.external_id } : {}),
    displayName: g.display_name,
    ...(wantAttr(req, 'members')
      ? {
          members: mapper.members(g.id).map((uid) => ({ value: uid, display: ctx.store.user(uid)?.name || '', $ref: `${base(req)}/Users/${uid}`, type: 'User' })),
        }
      : {}),
    meta: { resourceType: 'Group', created: g.created_at, lastModified: g.updated_at, location: `${base(req)}/Groups/${g.id}` },
  });

  const find = (id: string) => {
    const g = mapper.group(id);
    if (!g) throw new ScimError(404, 'Groep niet gevonden');
    return g;
  };
  const nameTaken = (name: string, exceptId: string) => !!ctx.store.one('SELECT id FROM scim_groups WHERE lower(display_name) = lower(?) AND id != ?', name, exceptId);

  /** Write the new member set; returns the users whose membership changed (they get the mapping re-applied). */
  const writeMembers = (g: GroupRow, wanted: Set<string>): { changed: string[]; added: string[]; removed: string[]; ignored: number } => {
    const current = new Set(mapper.members(g.id));
    const added: string[] = [];
    const removed: string[] = [];
    let ignored = 0;
    for (const id of wanted) {
      if (current.has(id)) continue;
      if (!visibleUser(id)) {
        ignored++;
        continue;
      }
      ctx.store.exec('INSERT OR IGNORE INTO scim_group_members (group_id, user_id, created_at) VALUES (?, ?, ?)', g.id, id, now());
      added.push(id);
    }
    for (const id of current) {
      if (wanted.has(id)) continue;
      ctx.store.exec('DELETE FROM scim_group_members WHERE group_id = ? AND user_id = ?', g.id, id);
      removed.push(id);
    }
    return { changed: [...added, ...removed], added, removed, ignored };
  };

  const touch = (g: GroupRow, patch: Partial<GroupRow> = {}) => ctx.store.update('scim_groups', g.id, { ...patch, updated_at: now() });

  const afterMembers = (g: GroupRow, w: ReturnType<typeof writeMembers>, kind: string) => {
    if (w.added.length || w.removed.length || w.ignored) ctx.audit(null, 'scim.group.members', { group: g.display_name, groupId: g.id, via: kind, added: w.added, removed: w.removed, ignored: w.ignored });
    mapper.applyMany(w.changed, `groep ${g.display_name}`);
  };

  r.get('/Groups', (req, res) => {
    const where: string[] = [];
    const params: any[] = [];
    const f = parseEqFilter(req.query.filter);
    if (f) {
      const [a, v] = f;
      if (a === 'displayname') (where.push('lower(display_name) = lower(?)'), params.push(v));
      else if (a === 'externalid') (where.push('external_id = ?'), params.push(v));
      else if (a === 'id') (where.push('id = ?'), params.push(v));
      else if (a === 'members.value' || a === 'members') (where.push('id IN (SELECT group_id FROM scim_group_members WHERE user_id = ?)'), params.push(v));
      else throw new ScimError(400, `Filter op “${a.slice(0, 40)}” wordt niet ondersteund`, 'invalidFilter');
    }
    const { startIndex, count } = paging(req);
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = ctx.store.one<{ n: number }>(`SELECT COUNT(*) AS n FROM scim_groups ${clause}`, ...params)?.n || 0;
    const rows = count ? ctx.store.all<any>(`SELECT * FROM scim_groups ${clause} ORDER BY created_at, id LIMIT ? OFFSET ?`, ...params, count, startIndex - 1) : [];
    const list = rows.map((x) => resource(req, ctx.store.decode<GroupRow>('scim_groups', x)));
    send(res, 200, { schemas: [LIST], totalResults: total, startIndex, itemsPerPage: list.length, Resources: list });
  });

  r.get('/Groups/:id', (req, res) => send(res, 200, resource(req, find(req.params.id))));

  r.post('/Groups', (req, res) => {
    const b = req.body;
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new ScimError(400, 'Ongeldige groep', 'invalidSyntax');
    const name = clean(b.displayName, 200);
    if (!name) throw new ScimError(400, 'displayName is verplicht', 'invalidValue');
    if (nameTaken(name, '')) throw new ScimError(409, 'Er bestaat al een groep met deze naam', 'uniqueness');
    const ts = now();
    const g: GroupRow = { id: newId('grp_'), display_name: name, external_id: clean(b.externalId, 200) || null, role: 'member', room_ids: [], daily_budget_usd: null, created_at: ts, updated_at: ts };
    ctx.store.insert('scim_groups', g);
    ctx.audit(null, 'scim.group.created', { group: name, groupId: g.id });
    afterMembers(g, writeMembers(g, new Set(idsFrom(b.members))), 'post');
    res.setHeader('Location', `${base(req)}/Groups/${g.id}`);
    send(res, 201, resource(req, mapper.group(g.id)!));
  });

  r.put('/Groups/:id', (req, res) => {
    const g = find(req.params.id);
    const b = req.body;
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new ScimError(400, 'Ongeldige groep', 'invalidSyntax');
    const name = clean(b.displayName, 200);
    if (!name) throw new ScimError(400, 'displayName is verplicht', 'invalidValue');
    if (nameTaken(name, g.id)) throw new ScimError(409, 'Er bestaat al een groep met deze naam', 'uniqueness');
    if (name !== g.display_name) ctx.audit(null, 'scim.group.renamed', { groupId: g.id, from: g.display_name, to: name });
    touch(g, { display_name: name, external_id: clean(b.externalId, 200) || null });
    // PUT replaces everything: members that are not sent are removed (RFC 7644 §3.5.1).
    const fresh = mapper.group(g.id)!;
    afterMembers(fresh, writeMembers(fresh, new Set(idsFrom(b.members))), 'put');
    send(res, 200, resource(req, mapper.group(g.id)!));
  });

  r.patch('/Groups/:id', (req, res) => {
    const g = find(req.params.id);
    const ops = req.body?.Operations ?? req.body?.operations;
    if (!Array.isArray(ops)) throw new ScimError(400, 'PatchOp zonder Operations', 'invalidSyntax');
    if (Array.isArray(req.body?.schemas) && !req.body.schemas.includes(PATCH_OP)) throw new ScimError(400, `schemas moet ${PATCH_OP} bevatten`, 'invalidSyntax');
    const members = new Set(mapper.members(g.id));
    let name = g.display_name;
    let externalId = g.external_id;
    const onMembers = (op: string, value: any) => {
      const ids = idsFrom(value);
      if (op === 'replace') {
        members.clear();
        for (const id of ids) members.add(id);
      } else if (op === 'add') for (const id of ids) members.add(id);
      else if (value === undefined || value === null) members.clear();
      else for (const id of ids) members.delete(id);
    };
    for (const o of ops.slice(0, 200)) {
      const op = String(o?.op || '').toLowerCase();
      if (!['add', 'replace', 'remove'].includes(op)) throw new ScimError(400, `Onbekende operatie: ${String(o?.op).slice(0, 20)}`, 'invalidSyntax');
      const path = typeof o.path === 'string' ? o.path.trim() : '';
      const lp = path.toLowerCase();
      if (path) {
        const sel = /^members\[\s*value\s+eq\s+"((?:[^"\\]|\\.)*)"\s*\]$/i.exec(path);
        if (lp === 'displayname') {
          if (op !== 'remove') name = clean(o.value, 200) || name;
        } else if (lp === 'externalid') externalId = op === 'remove' ? null : clean(o.value, 200) || null;
        else if (lp === 'members') onMembers(op, o.value);
        else if (sel) {
          const id = sel[1].replace(/\\(.)/g, '$1');
          if (op === 'remove') members.delete(id);
          else members.add(id);
        }
        // Other attributes are not stored and are ignored.
      } else if (o.value && typeof o.value === 'object' && !Array.isArray(o.value)) {
        for (const [k, v] of Object.entries(o.value)) {
          const lk = k.toLowerCase();
          if (lk === 'displayname' && op !== 'remove') name = clean(v, 200) || name;
          else if (lk === 'externalid') externalId = op === 'remove' ? null : clean(v, 200) || null;
          else if (lk === 'members') onMembers(op, v);
        }
      } else if (op !== 'remove') throw new ScimError(400, 'Operatie zonder path vraagt een object als value', 'invalidSyntax');
    }
    if (name !== g.display_name && nameTaken(name, g.id)) throw new ScimError(409, 'Er bestaat al een groep met deze naam', 'uniqueness');
    if (name !== g.display_name) ctx.audit(null, 'scim.group.renamed', { groupId: g.id, from: g.display_name, to: name });
    touch(g, { display_name: name, external_id: externalId });
    const fresh = mapper.group(g.id)!;
    afterMembers(fresh, writeMembers(fresh, members), 'patch');
    // Entra expects 204 or 200; 200 with the resource helps Okta.
    send(res, 200, resource(req, mapper.group(g.id)!));
  });

  r.delete('/Groups/:id', (req, res) => {
    const g = find(req.params.id);
    const ids = mapper.members(g.id);
    ctx.store.exec('DELETE FROM scim_groups WHERE id = ?', g.id); // memberships cascade
    ctx.audit(null, 'scim.group.deleted', { group: g.display_name, groupId: g.id, members: ids.length });
    mapper.applyMany(ids, `groep ${g.display_name} verwijderd`);
    send(res, 204);
  });
}

// ---------------------------------------------------------------- admin: mapping

export function groupAdminRoutes(ctx: Ctx, mapper: GroupMapper) {
  const serverOnly = () => {
    if (ctx.config.mode !== 'server') throw bad('SSO en SCIM zijn alleen beschikbaar als TeamBot als server draait.');
  };
  const view = (g: GroupRow) => ({
    id: g.id,
    displayName: g.display_name,
    externalId: g.external_id,
    role: g.role,
    roomIds: g.room_ids || [],
    dailyBudgetUsd: g.daily_budget_usd,
    members: mapper.members(g.id).map((id) => {
      const u = ctx.store.user(id);
      return { id, name: u?.name || '', email: u?.email || null, role: u?.role || 'member', disabled: !!u?.disabled };
    }),
    updatedAt: g.updated_at,
  });
  const all = (me: User) => ({ groups: mapper.groups().map(view), rooms: mapper.mappableRooms(), canEdit: me.role === 'owner' });

  ctx.api.get(
    '/admin/scim/groups',
    ah(async (req) => {
      const me = requireRole(req, 'admin');
      serverOnly();
      return all(me);
    }),
  );

  ctx.api.put(
    '/admin/scim/groups/:id',
    ah(async (req) => {
      const me = requireRole(req, 'admin');
      serverOnly();
      const g = mapper.group(req.params.id as string);
      if (!g) throw notFound('Groep niet gevonden');
      const b = req.body || {};
      const patch: Partial<GroupRow> = {};
      if (b.role !== undefined) {
        if (!['member', 'admin'].includes(b.role)) throw bad('Kies lid of beheerder');
        if (b.role === 'admin' && g.role !== 'admin' && me.role !== 'owner') throw forbidden('Alleen de eigenaar kan een groep beheerdersrechten geven.');
        patch.role = b.role;
      }
      if (b.roomIds !== undefined) {
        const ids: string[] = [...new Set<string>((Array.isArray(b.roomIds) ? b.roomIds : []).map((x: unknown) => String(x)))];
        const cur = g.room_ids || [];
        const same = ids.length === cur.length && ids.every((x) => cur.includes(x));
        // Rooms are the owner's own conversations: only the owner decides who joins them.
        if (!same && me.role !== 'owner') throw forbidden('Alleen de eigenaar koppelt groepen aan groepsgesprekken.');
        if (ids.length) {
          const allowed = mapper.mappableRooms();
          if (!allowed) throw bad('De module voor groepsgesprekken is niet geladen.');
          for (const id of ids) if (!allowed.some((r) => r.id === id)) throw bad('Kies alleen actieve groepsgesprekken van de eigenaar.');
        }
        patch.room_ids = ids as string[];
      }
      if (b.dailyBudgetUsd !== undefined) {
        const v = b.dailyBudgetUsd;
        patch.daily_budget_usd = v === null || v === '' ? null : Math.max(0, Math.min(10_000, Number(v) || 0));
      }
      ctx.store.update('scim_groups', g.id, { ...patch, updated_at: now() });
      const fresh = mapper.group(g.id)!;
      ctx.audit(me.id, 'scim.group.mapping', { group: fresh.display_name, groupId: fresh.id, role: fresh.role, roomIds: fresh.room_ids, dailyBudgetUsd: fresh.daily_budget_usd });
      mapper.applyMany(mapper.members(g.id), `koppeling ${fresh.display_name}`);
      return all(me);
    }),
  );

  ctx.api.post(
    '/admin/scim/groups/apply',
    ah(async (req) => {
      const me = requireRole(req, 'admin');
      serverOnly();
      if (me.role !== 'owner') throw forbidden('Alleen de eigenaar beheert de SCIM-koppeling.');
      const ids = mapper.everyone();
      mapper.applyMany(ids, 'opnieuw toegepast');
      ctx.audit(me.id, 'scim.mapping.reapplied', { users: ids.length });
      return { ...all(me), applied: ids.length };
    }),
  );
}

export const GROUP_MIGRATION = {
  id: 'sso-002',
  sql: `
CREATE TABLE scim_groups (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL, external_id TEXT, role TEXT NOT NULL DEFAULT 'member',
  room_ids TEXT NOT NULL DEFAULT '[]', daily_budget_usd REAL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX scim_groups_name ON scim_groups(lower(display_name));
CREATE TABLE scim_group_members (
  group_id TEXT NOT NULL REFERENCES scim_groups(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, PRIMARY KEY (group_id, user_id)
);
CREATE INDEX scim_group_members_user ON scim_group_members(user_id);
CREATE TABLE scim_applied (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, role_granted INTEGER NOT NULL DEFAULT 0, budget REAL,
  room_ids TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL
);
`,
};
