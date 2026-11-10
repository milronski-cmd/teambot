import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Module } from '../server/core/types.js';
import { startTestApp, type TestApp } from './helpers.js';
import sso from '../server/modules/sso/index.js';
import rooms from '../server/modules/rooms/index.js';
import { effectiveBudget, memberBudgets } from '../server/api/member-policy.js';

const D = 'example.test';
const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const ERR = 'urn:ietf:params:scim:api:messages:2.0:Error';

async function call(t: TestApp, method: string, p: string, body?: any, token = t.token) {
  const r = await fetch(`${t.app.url}/api${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
}

async function scim(t: TestApp, method: string, p: string, token: string | null, body?: any) {
  const r = await fetch(`${t.app.url}/scim/v2${p}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/scim+json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, type: r.headers.get('content-type') || '', location: r.headers.get('location'), body: text ? JSON.parse(text) : null };
}

async function setup(modules: Module[] = [sso, rooms]) {
  const t = await startTestApp({ modules, mode: 'server' });
  const tok: string = (await t.api('POST', '/admin/scim/token', {})).newToken;
  const mkUser = async (name: string) => {
    const r = await scim(t, 'POST', '/Users', tok, { schemas: [USER], userName: `${name}@${D}`, displayName: name });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id as string;
  };
  const patchGroup = (id: string, ...ops: any[]) => scim(t, 'PATCH', `/Groups/${id}`, tok, { schemas: [PATCH], Operations: ops });
  const members = async (id: string) => ((await scim(t, 'GET', `/Groups/${id}`, tok)).body.members || []).map((m: any) => m.value).sort();
  const audit = (kind: string) => t.app.ctx.store.all<any>('SELECT * FROM audit WHERE kind = ? ORDER BY id', kind).map((r) => ({ ...r, data: JSON.parse(r.data) }));
  return { t, tok, mkUser, patchGroup, members, audit };
}

test('SCIM Groups: token auth, Entra-style PATCH, Okta-style PUT/replace, filter, paging, attributes and errors', async () => {
  const { t, tok, mkUser, patchGroup, members, audit } = await setup();
  try {
    const none = await scim(t, 'GET', '/Groups', null);
    assert.equal(none.status, 401);
    assert.deepEqual(none.body.schemas, [ERR]);
    assert.equal((await scim(t, 'GET', '/Groups', 'tbscim_fout')).status, 401);

    const anna = await mkUser('anna');
    const bob = await mkUser('bob');
    const carl = await mkUser('carl');

    // Create.
    const c = await scim(t, 'POST', '/Groups', tok, { schemas: [GROUP], displayName: 'Ontwikkeling', externalId: 'ext-dev', members: [{ value: anna }] });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.match(c.type, /application\/scim\+json/);
    const gid = c.body.id;
    assert.equal(c.location, `${t.app.url}/scim/v2/Groups/${gid}`);
    assert.deepEqual(c.body.schemas, [GROUP]);
    assert.deepEqual(c.body.members.map((m: any) => m.value), [anna]);
    assert.equal(c.body.members[0].$ref, `${t.app.url}/scim/v2/Users/${anna}`);
    const dup = await scim(t, 'POST', '/Groups', tok, { schemas: [GROUP], displayName: 'ontwikkeling' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.scimType, 'uniqueness');
    assert.equal((await scim(t, 'POST', '/Groups', tok, { schemas: [GROUP] })).body.scimType, 'invalidValue');

    // Entra: Add / Remove with a members value array, Replace displayName; unknown ids are ignored (and audited).
    assert.equal((await patchGroup(gid, { op: 'Add', path: 'members', value: [{ value: bob }, { value: 'usr_bestaatniet' }] })).status, 200);
    assert.deepEqual(await members(gid), [anna, bob].sort());
    assert.equal(audit('scim.group.members').at(-1).data.ignored, 1);
    await patchGroup(gid, { op: 'Remove', path: 'members', value: [{ value: anna }] });
    assert.deepEqual(await members(gid), [bob]);
    await patchGroup(gid, { op: 'Replace', path: 'displayName', value: 'Development' });
    assert.equal((await scim(t, 'GET', `/Groups/${gid}`, tok)).body.displayName, 'Development');
    // Okta: remove with a filter path, replace members, replace without path.
    await patchGroup(gid, { op: 'remove', path: `members[value eq "${bob}"]` });
    assert.deepEqual(await members(gid), []);
    await patchGroup(gid, { op: 'replace', path: 'members', value: [{ value: anna }, { value: carl }] });
    assert.deepEqual(await members(gid), [anna, carl].sort());
    const np = await patchGroup(gid, { op: 'replace', value: { id: gid, displayName: 'Dev' } });
    assert.equal(np.body.displayName, 'Dev');
    assert.deepEqual(await members(gid), [anna, carl].sort(), 'members untouched by a rename');
    // Okta PUT replaces everything, members included.
    const put = await scim(t, 'PUT', `/Groups/${gid}`, tok, { schemas: [GROUP], displayName: 'Dev', externalId: 'ext-dev', members: [{ value: carl }] });
    assert.equal(put.status, 200);
    assert.deepEqual(await members(gid), [carl]);
    assert.equal((await scim(t, 'PUT', `/Groups/${gid}`, tok, { schemas: [GROUP] })).status, 400);
    // Remove without value = remove all members.
    await patchGroup(gid, { op: 'add', path: 'members', value: [{ value: anna }] });
    await patchGroup(gid, { op: 'remove', path: 'members' });
    assert.deepEqual(await members(gid), []);
    await patchGroup(gid, { op: 'add', path: 'members', value: [{ value: carl }] });
    const badOp = await patchGroup(gid, { op: 'move', path: 'members' });
    assert.equal(badOp.status, 400);
    assert.equal(badOp.body.scimType, 'invalidSyntax');

    // Filter (case-insensitive displayName, externalId, member), excludedAttributes, paging.
    const f = await scim(t, 'GET', `/Groups?filter=${encodeURIComponent('displayName eq "dev"')}`, tok);
    assert.equal(f.body.totalResults, 1);
    assert.deepEqual(f.body.Resources[0].members.map((m: any) => m.value), [carl]);
    const ex = await scim(t, 'GET', `/Groups?filter=${encodeURIComponent('displayName eq "Dev"')}&excludedAttributes=members`, tok);
    assert.equal(ex.body.Resources[0].members, undefined);
    assert.equal(ex.body.Resources[0].displayName, 'Dev');
    assert.equal((await scim(t, 'GET', `/Groups/${gid}?excludedAttributes=members`, tok)).body.members, undefined);
    assert.equal((await scim(t, 'GET', `/Groups?filter=${encodeURIComponent('externalId eq "ext-dev"')}`, tok)).body.totalResults, 1);
    assert.equal((await scim(t, 'GET', `/Groups?filter=${encodeURIComponent(`members.value eq "${carl}"`)}`, tok)).body.totalResults, 1);
    assert.equal((await scim(t, 'GET', `/Groups?filter=${encodeURIComponent('displayName eq "Niemand"')}`, tok)).body.totalResults, 0);
    await scim(t, 'POST', '/Groups', tok, { schemas: [GROUP], displayName: 'Sales' });
    await scim(t, 'POST', '/Groups', tok, { schemas: [GROUP], displayName: 'Support' });
    const page = await scim(t, 'GET', '/Groups?startIndex=2&count=1', tok);
    assert.equal(page.body.totalResults, 3);
    assert.equal(page.body.itemsPerPage, 1);
    assert.equal(page.body.startIndex, 2);
    assert.equal(page.body.Resources[0].displayName, 'Sales');
    const badFilter = await scim(t, 'GET', `/Groups?filter=${encodeURIComponent('displayName co "D"')}`, tok);
    assert.equal(badFilter.status, 400);
    assert.equal(badFilter.body.scimType, 'invalidFilter');
    const missing = await scim(t, 'GET', '/Groups/grp_bestaatniet', tok);
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body.schemas, [ERR]);
    assert.equal(missing.body.status, '404');

    // Users show their groups (read-only); discovery lists the Group type and schema.
    assert.deepEqual((await scim(t, 'GET', `/Users/${carl}`, tok)).body.groups.map((g: any) => g.display), ['Dev']);
    assert.deepEqual((await scim(t, 'GET', '/ResourceTypes', tok)).body.Resources.map((r: any) => r.endpoint), ['/Users', '/Groups']);
    assert.equal((await scim(t, 'GET', '/ResourceTypes/Group', tok)).body.schema, GROUP);
    assert.ok((await scim(t, 'GET', '/Schemas', tok)).body.Resources.some((s: any) => s.id === GROUP));
    assert.equal((await scim(t, 'GET', `/Schemas/${GROUP}`, tok)).status, 200);

    // Delete.
    assert.equal((await scim(t, 'DELETE', `/Groups/${gid}`, tok)).status, 204);
    assert.equal((await scim(t, 'GET', `/Groups/${gid}`, tok)).status, 404);
    assert.ok(audit('scim.group.deleted').length === 1);
    assert.equal(t.app.ctx.store.all('SELECT * FROM scim_group_members WHERE group_id = ?', gid).length, 0);
  } finally {
    await t.close();
  }
});

test('SCIM Groups: mapping to role, rooms and budget — owner untouched, manual settings survive, removal and group delete revert', async () => {
  const { t, tok, mkUser, patchGroup, audit } = await setup();
  try {
    const ctx = t.app.ctx;
    const svc = ctx.services.rooms;
    await t.api('PATCH', '/me', { email: `eigenaar@${D}` });
    const owner = ctx.auth.owner()!;
    const bot = await t.agent({ name: 'Teambot' });
    const room = (await t.api('POST', '/rooms', { name: 'Team', agentIds: [bot.id] })).room;
    const room2 = (await t.api('POST', '/rooms', { name: 'Directie', agentIds: [bot.id] })).room;
    const anna = await mkUser('anna');
    const bob = await mkUser('bob');
    const manual = ctx.auth.createUser({ name: 'Beheerder', email: `beheer@${D}`, role: 'admin' });
    const adminTok = ctx.auth.createSession(manual.id).token;
    const role = (id: string) => ctx.store.user(id)!.role;

    const g = (await scim(t, 'POST', '/Groups', tok, { schemas: [GROUP], displayName: 'Beheer', members: [{ value: anna }, { value: owner.id }, { value: manual.id }] })).body.id;
    const leden = (await scim(t, 'POST', '/Groups', tok, { schemas: [GROUP], displayName: 'Leden', members: [{ value: bob }] })).body.id;
    // Nothing mapped yet: nobody changes.
    assert.equal(role(anna), 'member');
    assert.equal(svc.access(room.id, anna), null);

    // Overview for admins; members can't see it.
    const ov = await call(t, 'GET', '/admin/scim/groups', undefined, adminTok);
    assert.equal(ov.status, 200);
    assert.deepEqual(ov.body.rooms.map((r: any) => r.name).sort(), ['Directie', 'Team']);
    assert.equal(ov.body.canEdit, false);
    assert.equal(ov.body.groups.find((x: any) => x.id === g).members.length, 3);
    assert.equal((await call(t, 'GET', '/admin/scim/groups', undefined, ctx.auth.createSession(anna).token)).status, 403);

    // A non-owner admin can't hand out admin rights or room access; a budget is fine.
    assert.equal((await call(t, 'PUT', `/admin/scim/groups/${g}`, { role: 'admin' }, adminTok)).status, 403);
    assert.equal((await call(t, 'PUT', `/admin/scim/groups/${g}`, { roomIds: [room.id] }, adminTok)).status, 403);
    assert.equal((await call(t, 'PUT', `/admin/scim/groups/${leden}`, { dailyBudgetUsd: 2.5 }, adminTok)).status, 200);
    assert.equal(memberBudgets(ctx)[bob], 2.5, 'budget applied to the member');
    assert.equal(effectiveBudget(ctx, bob), 2.5);
    // Only the owner's rooms can be mapped.
    assert.equal((await call(t, 'PUT', `/admin/scim/groups/${g}`, { roomIds: ['room_vreemd'] })).status, 400);

    // Owner maps "Beheer" → admin + room; applied right away.
    const m1 = await call(t, 'PUT', `/admin/scim/groups/${g}`, { role: 'admin', roomIds: [room.id] });
    assert.equal(m1.status, 200, JSON.stringify(m1.body));
    assert.equal(role(anna), 'admin', 'promoted');
    assert.equal(role(owner.id), 'owner', 'owner untouched');
    assert.equal(role(manual.id), 'admin');
    assert.equal(svc.access(room.id, anna), 'member', 'added to the room');
    assert.equal(svc.access(room.id, owner.id), 'owner');
    assert.equal(ctx.store.all("SELECT * FROM room_members WHERE kind = 'user' AND ref_id = ?", owner.id).length, 0, 'owner never added as a person');
    assert.equal((await call(t, 'GET', `/rooms/${room.id}`, undefined, ctx.auth.createSession(anna).token)).status, 200, 'anna sees the room');
    assert.equal(memberBudgets(ctx)[anna], undefined, 'budgets only for members');
    assert.ok(audit('scim.group.mapping').length >= 2);
    assert.ok(audit('scim.mapping.applied').some((a) => a.user_id === anna && a.data.role === 'admin'));
    // A SCIM-promoted admin stays manageable by SCIM; a manual admin does not.
    assert.equal((await scim(t, 'PATCH', `/Users/${anna}`, tok, { schemas: [PATCH], Operations: [{ op: 'replace', path: 'displayName', value: 'Anna A.' }] })).status, 200);
    assert.equal((await scim(t, 'PATCH', `/Users/${manual.id}`, tok, { schemas: [PATCH], Operations: [{ op: 'replace', path: 'displayName', value: 'X' }] })).status, 403);

    // Mapping change is applied to the group's members (budget 2.5 → 4, room added).
    await call(t, 'PUT', `/admin/scim/groups/${leden}`, { dailyBudgetUsd: 4, roomIds: [room2.id] });
    assert.equal(memberBudgets(ctx)[bob], 4);
    assert.equal(svc.access(room2.id, bob), 'member');
    // Membership change: bob joins "Beheer" too → admin; leaves again → member, budget of "Leden" back.
    await patchGroup(g, { op: 'Add', path: 'members', value: [{ value: bob }] });
    assert.equal(role(bob), 'admin');
    assert.equal(memberBudgets(ctx)[bob], undefined, 'budget removed while admin');
    assert.equal(svc.access(room.id, bob), 'member');
    await patchGroup(g, { op: 'Remove', path: 'members', value: [{ value: bob }] });
    assert.equal(role(bob), 'member');
    assert.equal(memberBudgets(ctx)[bob], 4);
    assert.equal(svc.access(room.id, bob), null, 'left the room of "Beheer"');
    assert.equal(svc.access(room2.id, bob), 'member', 'still in the room of "Leden"');

    // Manual settings survive: a budget the admin set by hand and a room invite accepted by hand stay.
    assert.equal((await call(t, 'PUT', `/admin/usage/budget/${bob}`, { dailyBudgetUsd: 9 }, adminTok)).status, 200);
    await patchGroup(leden, { op: 'Remove', path: 'members', value: [{ value: bob }] });
    assert.equal(memberBudgets(ctx)[bob], 9, 'manual budget kept');
    assert.equal(svc.access(room2.id, bob), null);
    assert.equal(ctx.store.user(bob)!.disabled, false, 'removal never blocks or deletes');

    // Deactivated users get nothing (grants taken back) and stay deactivated; reactivation grants again.
    await scim(t, 'PATCH', `/Users/${anna}`, tok, { schemas: [PATCH], Operations: [{ op: 'Replace', path: 'active', value: 'False' }] });
    assert.equal(ctx.store.user(anna)!.disabled, true);
    assert.equal(role(anna), 'member');
    assert.equal(svc.access(room.id, anna), null);
    await call(t, 'PUT', `/admin/scim/groups/${g}`, { roomIds: [room.id, room2.id] });
    assert.equal(ctx.store.user(anna)!.disabled, true, 'mapping change does not reactivate');
    assert.equal(svc.access(room2.id, anna), null);
    await scim(t, 'PATCH', `/Users/${anna}`, tok, { schemas: [PATCH], Operations: [{ op: 'replace', value: { active: true } }] });
    assert.equal(role(anna), 'admin');
    assert.equal(svc.access(room.id, anna), 'member');
    assert.equal(svc.access(room2.id, anna), 'member');

    // Deleting the group reverts everything it granted; data stays.
    assert.equal((await scim(t, 'DELETE', `/Groups/${g}`, tok)).status, 204);
    assert.equal(role(anna), 'member');
    assert.equal(svc.access(room.id, anna), null);
    assert.equal(svc.access(room2.id, anna), null);
    assert.equal(role(manual.id), 'admin', 'manual admin untouched');
    assert.equal(role(owner.id), 'owner');
    assert.ok(ctx.store.user(anna) && !ctx.store.user(anna)!.disabled);
    assert.ok(ctx.store.thread(room.thread_id), 'room data kept');

    // "Opnieuw toepassen" is owner-only.
    assert.equal((await call(t, 'POST', '/admin/scim/groups/apply', {}, adminTok)).status, 403);
    assert.equal((await call(t, 'POST', '/admin/scim/groups/apply', {})).status, 200);
  } finally {
    await t.close();
  }
});

test('SCIM Groups without the rooms module; seat limit on create and reactivation; delete mode cleans up', async () => {
  const prev = process.env.TEAMBOT_MAX_USERS;
  const { t, tok, mkUser } = await setup([sso]);
  try {
    const ctx = t.app.ctx;
    const ov = await t.api('GET', '/admin/scim/groups');
    assert.equal(ov.rooms, null, 'rooms module absent');
    const a = await mkUser('anna');
    const g = (await scim(t, 'POST', '/Groups', tok, { schemas: [GROUP], displayName: 'Team', members: [{ value: a }] })).body.id;
    assert.equal((await call(t, 'PUT', `/admin/scim/groups/${g}`, { roomIds: ['room_x'] })).status, 400);
    assert.equal((await call(t, 'PUT', `/admin/scim/groups/${g}`, { role: 'admin', dailyBudgetUsd: 1 })).status, 200);
    assert.equal(ctx.store.user(a)!.role, 'admin', 'role mapping works without rooms');

    // Seats: owner + anna + 1.
    process.env.TEAMBOT_MAX_USERS = '3';
    const b = await mkUser('bob');
    const full = await scim(t, 'POST', '/Users', tok, { schemas: [USER], userName: `carl@${D}` });
    assert.equal(full.status, 403);
    assert.deepEqual(full.body.schemas, [ERR]);
    assert.match(full.body.detail, /maximaal 3/);
    await scim(t, 'PATCH', `/Users/${b}`, tok, { schemas: [PATCH], Operations: [{ op: 'replace', path: 'active', value: false }] });
    assert.equal((await scim(t, 'POST', '/Users', tok, { schemas: [USER], userName: `carl@${D}` })).status, 201, 'blocking frees a seat');
    const back = await scim(t, 'PATCH', `/Users/${b}`, tok, { schemas: [PATCH], Operations: [{ op: 'replace', path: 'active', value: true }] });
    assert.equal(back.status, 403, 'reactivation needs a free seat');
    assert.equal(ctx.store.user(b)!.disabled, true);
    delete process.env.TEAMBOT_MAX_USERS;

    // Delete mode: a SCIM-promoted admin can be removed; memberships and the personal budget go with it.
    await t.api('PUT', '/admin/scim', { deleteMode: 'delete' });
    await call(t, 'PUT', `/admin/scim/groups/${g}`, { role: 'member', dailyBudgetUsd: 1 });
    assert.equal(memberBudgets(ctx)[a], 1);
    assert.equal((await scim(t, 'DELETE', `/Users/${a}`, tok)).status, 204);
    assert.equal(ctx.store.user(a), null);
    assert.equal(memberBudgets(ctx)[a], undefined);
    assert.equal(ctx.store.all('SELECT * FROM scim_group_members WHERE user_id = ?', a).length, 0);
    assert.equal((await scim(t, 'GET', `/Groups/${g}`, tok)).body.members.length, 0);
  } finally {
    if (prev === undefined) delete process.env.TEAMBOT_MAX_USERS;
    else process.env.TEAMBOT_MAX_USERS = prev;
    await t.close();
  }
});
