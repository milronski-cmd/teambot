import express from 'express';
import QRCode from 'qrcode';
import type { Ctx, User } from '../../core/types.js';
import { ah, bad, notFound, own, str, user } from '../../core/http.js';
import { newId, now } from '../../core/db.js';
import { canSeeThread } from '../../api/threads.js';
import { ACCESS_LEVELS, type ChannelManager } from './manager.js';
import { slackManifest } from './adapters/slack.js';
import { EMAIL_PRESETS } from './adapters/email.js';
import { discordInviteUrl } from './adapters/discord.js';
import type { Binding, Conversation } from './types.js';
import { normalizeCustomer } from './customer.js';

/** Rooms are owned by the rooms module; look them up defensively (service first, then its table). */
export function roomOwner(ctx: Ctx, roomId: string): string | null {
  try {
    const svc = ctx.services.rooms;
    const r = svc?.get?.(roomId) ?? svc?.room?.(roomId);
    if (r && typeof r === 'object' && r.user_id) return r.user_id;
  } catch {
    /* ignore */
  }
  try {
    return ctx.store.one<any>('SELECT user_id FROM rooms WHERE id = ?', roomId)?.user_id ?? null;
  } catch {
    return null;
  }
}

export function listRooms(ctx: Ctx, userId: string): { id: string; name: string }[] {
  try {
    const svc = ctx.services.rooms;
    const r = svc?.list?.(userId);
    if (Array.isArray(r)) return r.map((x: any) => ({ id: x.id, name: x.name || x.title || x.id }));
  } catch {
    /* ignore */
  }
  try {
    return ctx.store.all<any>('SELECT id, name FROM rooms WHERE user_id = ? ORDER BY name', userId).map((x) => ({ id: x.id, name: x.name || x.id }));
  } catch {
    return [];
  }
}

/** Settings that do not change how TeamBot connects (a change keeps the channel's health). */
const NOT_CONNECTION = new Set(['othersAccess', 'ownerAccess', 'approveViaChannel', 'errorReply', 'reactions', 'transcribeVoice', 'maxFileMb', 'customer']);
const connectionKey = (b: Pick<Binding, 'config' | 'secret_ids'>) =>
  JSON.stringify([Object.entries(b.config || {}).filter(([k]) => !NOT_CONNECTION.has(k)).sort(([a], [z]) => a.localeCompare(z)), Object.entries(b.secret_ids || {}).sort(([a], [z]) => a.localeCompare(z))]);

function commonConfig(input: any, prev: Record<string, any>, approveSupported: boolean, adapter: string) {
  const c = { ...prev, ...(input || {}) };
  const lvl = (v: any, d: string) => (ACCESS_LEVELS.includes(v) ? v : d);
  let publicBaseUrl = String(c.publicBaseUrl || '').trim().replace(/\/+$/, '');
  if (publicBaseUrl) {
    let u: URL;
    try {
      u = new URL(publicBaseUrl);
    } catch {
      throw bad('Publieke URL is geen geldige URL');
    }
    if (u.protocol !== 'https:') throw bad('Publieke URL moet met https:// beginnen (platforms accepteren alleen HTTPS)');
    publicBaseUrl = u.origin + u.pathname.replace(/\/+$/, '');
  }
  return {
    othersAccess: lvl(c.othersAccess, 'none'),
    ownerAccess: lvl(c.ownerAccess, 'agent'),
    approveViaChannel: approveSupported ? !!c.approveViaChannel : false,
    errorReply: c.errorReply !== false,
    // Status reactions (👀 while the bot works, then done or error) on platforms that have them; on by default.
    reactions: c.reactions !== false,
    transcribeVoice: c.transcribeVoice !== false,
    maxFileMb: Math.min(50, Math.max(1, Number(c.maxFileMb) || 20)),
    publicBaseUrl,
    // Customer mode ("Klantenservice"): AI label, hand off to the owner, approval for money and promises, hours.
    customer: normalizeCustomer(input?.customer, prev.customer, adapter),
  };
}

/**
 * A channel brought over from another app (the OpenBot import): switched off and without any token, with its name,
 * bot and allowlist. Nothing connects; the owner adds the token and switches it on at the moment he moves it over.
 * WhatsApp via QR is never made this way (a new link always starts with the warning and a new QR scan).
 */
export async function importPausedBinding(
  ctx: Ctx,
  m: ChannelManager,
  o: { userId: string; adapter: string; name: string; agentId: string; senders?: { id: string; label: string }[]; importedFrom: Record<string, any> },
): Promise<Binding> {
  const def = m.adapters.get(o.adapter);
  if (!def || o.adapter === 'whatsapp-web') throw bad('Dit kanaaltype kan niet op pauze worden overgenomen.');
  const a = ctx.store.agent(o.agentId);
  if (!a || a.user_id !== o.userId) throw bad('Bot niet gevonden');
  const specific = await def.validate({}, { role: 'owner', secrets: {}, isNew: false });
  const b: Binding = {
    id: newId('ch_'),
    user_id: o.userId,
    adapter: o.adapter,
    name: str(o.name, 80).trim() || def.label,
    agent_id: a.id,
    room_id: null,
    config: { ...specific, ...commonConfig({}, {}, def.approveViaChannel, o.adapter), importedFrom: o.importedFrom },
    secret_ids: {},
    state: {},
    enabled: false,
    status: 'stopped',
    last_error: null,
    last_ok_at: null,
    health: { since: now() },
    team_id: m.teams.targetTeam({ user_id: o.userId, agent_id: a.id, room_id: null }),
    created_at: now(),
    updated_at: now(),
  };
  ctx.store.tx(() => {
    ctx.store.insert('channel_bindings', b);
    for (const s of (o.senders || []).slice(0, 200)) {
      const ext = str(s.id, 120).trim();
      if (!ext || m.sender(b.id, ext)) continue;
      ctx.store.insert('channel_senders', { id: newId('cs_'), binding_id: b.id, user_id: o.userId, external_id: ext, label: str(s.label, 80), is_owner: false, source: 'import', created_at: now() });
    }
  });
  ctx.audit(o.userId, 'channels.binding_imported', { id: b.id, adapter: b.adapter, name: b.name, senders: (o.senders || []).length }, b.agent_id);
  ctx.events.emit(o.userId, 'channels.updated', m.view(m.binding(b.id)!));
  return m.binding(b.id)!;
}

/** Remove a binding with everything that belongs to it (also used by an import's undo). */
export async function removeBinding(ctx: Ctx, m: ChannelManager, b: Binding) {
  // Quietly: no "stopped" status or WhatsApp state for a binding that is about to be gone (manager.deleting).
  await m.deleting(b.id, async () => {
    // WhatsApp (QR): unlink on WhatsApp's side too, so TeamBot disappears from "Gekoppelde apparaten" on the
    // phone instead of staying there as a dead device.
    if (b.adapter === 'whatsapp-web') {
      try {
        await m.runtime(b.id)?.logout?.();
      } catch (e: any) {
        ctx.log.warn('[channels] whatsapp logout on delete failed', e?.message);
      }
    }
    await m.disconnect(b.id);
    m.deleteSecrets(b);
    m.deleteStorage(b.id);
    ctx.store.tx(() => {
      ctx.store.exec('DELETE FROM channel_msg_ids WHERE binding_id = ?', b.id);
      ctx.store.exec('DELETE FROM channel_log WHERE binding_id = ?', b.id);
      ctx.store.exec('DELETE FROM channel_approval_prompts WHERE binding_id = ?', b.id);
      ctx.store.exec('DELETE FROM channel_outbox WHERE binding_id = ?', b.id);
      ctx.store.remove('channel_bindings', b.id);
    });
  });
  ctx.events.emit(b.user_id, 'channels.deleted', { id: b.id });
}

export function channelRoutes(ctx: Ctx, m: ChannelManager) {
  const api = ctx.api;

  const ownBinding = (req: any): Binding => own(req, m.binding(String(req.params.id)), 'Koppeling niet gevonden');
  const ownConv = (req: any): Conversation => own(req, m.conversation(String(req.params.id)), 'Gesprek niet gevonden');

  async function buildConfig(u: User, adapter: string, body: any, prev: Binding | null) {
    const def = m.adapters.get(adapter);
    if (!def) throw bad('Onbekend kanaaltype');
    const merged = { ...(prev?.config || {}), ...(body?.config || {}) };
    for (const f of def.secretFields) delete merged[f.key];
    const secretsPresent: Record<string, boolean> = {};
    for (const f of def.secretFields) secretsPresent[f.key] = !!body?.secrets?.[f.key] || (prev ? m.hasSecret(prev, f.key) : false);
    const specific = await def.validate(merged, { role: u.role, secrets: secretsPresent, isNew: !prev });
    // Where an imported channel came from stays with it (an import does not make it twice; the switch-over finds it).
    const from = prev?.config?.importedFrom;
    return { ...specific, ...commonConfig(body?.config, prev?.config || {}, def.approveViaChannel, adapter), ...(from ? { importedFrom: from } : {}) };
  }

  function checkSecrets(adapter: string, secrets: any): Record<string, string> {
    const def = m.adapters.get(adapter)!;
    const out: Record<string, string> = {};
    for (const f of def.secretFields) {
      const v = secrets?.[f.key];
      if (typeof v !== 'string' || !v.trim()) continue;
      const err = def.validateSecret?.(f.key, v);
      if (err) throw bad(`${f.label}: ${err}`);
      out[f.key] = str(v, 10_000).trim();
    }
    return out;
  }

  function checkTarget(u: User, body: any, prev: Binding | null): { agent_id: string | null; room_id: string | null } {
    let agent_id = body?.agent_id !== undefined ? body.agent_id || null : prev?.agent_id ?? null;
    let room_id = body?.room_id !== undefined ? body.room_id || null : prev?.room_id ?? null;
    if (body?.agent_id) room_id = null;
    else if (body?.room_id) agent_id = null;
    if (agent_id) {
      const a = ctx.store.agent(agent_id);
      if (!a || a.user_id !== u.id) throw bad('Bot niet gevonden');
    }
    if (room_id && roomOwner(ctx, room_id) !== u.id) throw bad('Room niet gevonden');
    if (!agent_id && !room_id) throw bad('Kies een bot of een room die via dit kanaal antwoordt');
    return { agent_id, room_id };
  }

  api.get(
    '/channels/adapters',
    ah(async (req) => {
      const u = user(req);
      return {
        adapters: [...m.adapters.values()].map((d) => ({
          id: d.id,
          label: d.label,
          description: d.description,
          approveViaChannel: d.approveViaChannel,
          secretFields: d.secretFields.map((f) => ({ key: f.key, label: f.label })),
          webhookKinds: d.webhookKinds || [],
        })),
        publicUrl: ctx.config.publicUrl || '',
        mode: ctx.config.mode,
        role: u.role,
        emailPresets: EMAIL_PRESETS,
      };
    }),
  );

  api.get(
    '/channels/rooms',
    ah(async (req) => listRooms(ctx, user(req).id)),
  );

  api.get(
    '/channels/bindings',
    ah(async (req) => {
      const u = user(req);
      const agentId = (req.query.agentId as string) || '';
      // The owner sees every team's channels; ?teamId= shows one team (the team switcher).
      const teamId = str(req.query.teamId || '', 60);
      return m.bindings(u.id).filter((b) => (!agentId || b.agent_id === agentId) && (!teamId || m.teams.teamOf(b) === teamId)).map((b) => m.view(b));
    }),
  );

  api.post(
    '/channels/bindings',
    ah(async (req) => {
      const u = user(req);
      const adapter = str(req.body?.adapter, 40);
      const def = m.adapters.get(adapter);
      if (!def) throw bad('Onbekend kanaaltype');
      const target = checkTarget(u, req.body, null);
      const secrets = checkSecrets(adapter, req.body?.secrets);
      const config = await buildConfig(u, adapter, req.body, null);
      const b: Binding = {
        id: newId('ch_'),
        user_id: u.id,
        adapter,
        name: str(req.body?.name, 80).trim() || def.label,
        ...target,
        config,
        secret_ids: {},
        state: {},
        enabled: req.body?.enabled !== false,
        status: 'stopped',
        last_error: null,
        last_ok_at: null,
        health: { since: now() },
        // The team of its bot or group (package B4): only that team's bots answer and send on it.
        team_id: m.teams.targetTeam({ user_id: u.id, ...target }),
        created_at: now(),
        updated_at: now(),
      };
      ctx.store.insert('channel_bindings', b);
      const saved = m.setSecrets(b, secrets);
      // "Koppelen in één keer" (verify): the token or password is tried first. A refused one never becomes a channel:
      // the owner stays on the form with the reason and can paste another.
      let tested: { ok: boolean; detail: string } | null = null;
      if (req.body?.verify === true) {
        tested = await m.test(saved);
        if (!tested.ok) {
          await removeBinding(ctx, m, saved);
          throw bad(tested.detail);
        }
      }
      ctx.audit(u.id, 'channels.binding_created', { id: b.id, adapter, name: b.name, secrets: Object.keys(secrets) }, b.agent_id);
      if (saved.enabled) m.connect(b.id).catch(() => {});
      const view = m.view(m.binding(b.id)!);
      ctx.events.emit(u.id, 'channels.updated', view);
      return tested ? { ...view, tested } : view;
    }),
  );

  api.get(
    '/channels/bindings/:id',
    ah(async (req) => {
      const b = ownBinding(req);
      const view = m.view(b);
      return {
        ...view,
        senders: m.senders(b.id),
        pairCodes: ctx.store
          .all<any>('SELECT id, label, is_owner, expires_at, used_at, used_by, created_at FROM channel_pair_codes WHERE binding_id = ? ORDER BY created_at DESC LIMIT 50', b.id)
          .map((r) => ({ ...r, is_owner: !!r.is_owner })),
      };
    }),
  );

  api.patch(
    '/channels/bindings/:id',
    ah(async (req) => {
      const u = user(req);
      const b = ownBinding(req);
      const def = m.def(b)!;
      const patch: Partial<Binding> = {};
      if (req.body?.name !== undefined) patch.name = str(req.body.name, 80).trim() || def.label;
      const targetChanged = req.body?.agent_id !== undefined || req.body?.room_id !== undefined;
      if (targetChanged) {
        Object.assign(patch, checkTarget(u, req.body, b));
        // Another bot or group: the channel goes with it to its team (package B4).
        patch.team_id = m.teams.targetTeam({ user_id: u.id, agent_id: patch.agent_id ?? null, room_id: patch.room_id ?? null }) ?? b.team_id ?? null;
      }
      if (req.body?.config !== undefined || req.body?.secrets !== undefined) patch.config = await buildConfig(u, b.adapter, req.body, b);
      if (req.body?.enabled !== undefined) patch.enabled = !!req.body.enabled;
      const secrets = checkSecrets(b.adapter, req.body?.secrets);
      let upd = m.updateBinding(b.id, patch);
      if (Object.keys(secrets).length) upd = m.setSecrets(upd, secrets);
      // New token, address or mode: what was proven before no longer counts ("verbonden" needs a new test).
      // (A new secret keeps its id, so a secret in the request counts as a change by itself.)
      if (Object.keys(secrets).length || connectionKey(upd) !== connectionKey(b)) m.resetHealth(b.id);
      if (targetChanged && (patch.agent_id !== b.agent_id || patch.room_id !== b.room_id)) {
        // A different bot answers from now on: start fresh threads instead of mixing histories.
        ctx.store.exec('UPDATE channel_conversations SET thread_id = NULL WHERE binding_id = ?', b.id);
      }
      ctx.audit(u.id, 'channels.binding_updated', { id: b.id, fields: Object.keys(patch), secrets: Object.keys(secrets) }, upd.agent_id);
      if (upd.enabled) m.connect(b.id).catch(() => {});
      else {
        await m.disconnect(b.id);
        m.setStatus(b.id, 'stopped', null);
      }
      const view = m.view(m.binding(b.id)!);
      ctx.events.emit(u.id, 'channels.updated', view);
      return view;
    }),
  );

  api.delete(
    '/channels/bindings/:id',
    ah(async (req) => {
      const u = user(req);
      const b = ownBinding(req);
      await removeBinding(ctx, m, b);
      ctx.audit(u.id, 'channels.binding_deleted', { id: b.id, adapter: b.adapter, name: b.name }, b.agent_id);
      return { ok: true };
    }),
  );

  api.post(
    '/channels/bindings/:id/connect',
    ah(async (req) => {
      const b = ownBinding(req);
      m.updateBinding(b.id, { enabled: true });
      await m.connect(b.id);
      ctx.audit(user(req).id, 'channels.connect', { id: b.id }, b.agent_id);
      return m.view(m.binding(b.id)!);
    }),
  );

  api.post(
    '/channels/bindings/:id/disconnect',
    ah(async (req) => {
      const b = ownBinding(req);
      m.updateBinding(b.id, { enabled: false });
      await m.disconnect(b.id);
      m.setStatus(b.id, 'stopped', null);
      ctx.audit(user(req).id, 'channels.disconnect', { id: b.id }, b.agent_id);
      return m.view(m.binding(b.id)!);
    }),
  );

  api.post(
    '/channels/bindings/:id/test',
    ah(async (req) => {
      const b = ownBinding(req);
      const r = await m.test(b);
      return { ...r, binding: m.view(m.binding(b.id)!) };
    }),
  );

  // ---- health: prove that messages really arrive and leave ----
  api.post(
    '/channels/bindings/:id/health-test',
    ah(async (req) => {
      const b = ownBinding(req);
      let r;
      try {
        r = m.startHealthTest(b);
      } catch (e: any) {
        throw bad(e?.message || String(e));
      }
      ctx.audit(user(req).id, 'channels.health_test', { id: b.id }, b.agent_id);
      const qrSvg = r.deepLink ? await QRCode.toString(r.deepLink, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 }) : null;
      return { ...r, qrSvg, binding: m.view(m.binding(b.id)!) };
    }),
  );

  api.delete(
    '/channels/bindings/:id/health-test',
    ah(async (req) => {
      const b = ownBinding(req);
      m.cancelHealthTest(b.id);
      return m.view(m.binding(b.id)!);
    }),
  );

  // ---- customer mode: what went to customers, what waits for the owner ----
  api.get(
    '/channels/bindings/:id/outbox',
    ah(async (req) => {
      const b = ownBinding(req);
      return m.outbox(b.id, req.query.before ? String(req.query.before) : undefined);
    }),
  );

  api.get(
    '/channels/inbox',
    ah(async (req) => m.inbox(user(req).id)),
  );

  api.post(
    '/channels/outbox/:id/approve',
    ah(async (req) => {
      const u = user(req);
      const row = m.outboxRow(String(req.params.id));
      if (!row || row.user_id !== u.id) throw notFound('Antwoord niet gevonden');
      const text = req.body?.text !== undefined ? str(req.body.text, 20_000) : null;
      try {
        return await m.approveHeld(row.id, u, text);
      } catch (e: any) {
        throw bad(e?.message || String(e));
      }
    }),
  );

  api.post(
    '/channels/outbox/:id/reject',
    ah(async (req) => {
      const u = user(req);
      const row = m.outboxRow(String(req.params.id));
      if (!row || row.user_id !== u.id) throw notFound('Antwoord niet gevonden');
      try {
        return await m.rejectHeld(row.id, u);
      } catch (e: any) {
        throw bad(e?.message || String(e));
      }
    }),
  );

  api.post(
    '/channels/conversations/:id/release',
    ah(async (req) => {
      const u = user(req);
      const c = ownConv(req);
      return m.releaseHandoff(c.id, u.id, 'released');
    }),
  );

  api.get(
    '/channels/bindings/:id/log',
    ah(async (req) => {
      const b = ownBinding(req);
      const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
      return ctx.store.all('SELECT * FROM channel_log WHERE binding_id = ? AND user_id = ? AND id < ? ORDER BY id DESC LIMIT 200', b.id, b.user_id, before);
    }),
  );

  // ---- allowlist ----
  api.post(
    '/channels/bindings/:id/senders',
    ah(async (req) => {
      const u = user(req);
      const b = ownBinding(req);
      let ext = str(req.body?.external_id, 200).trim();
      if (b.adapter === 'email') ext = ext.toLowerCase();
      if (b.adapter === 'whatsapp') ext = ext.replace(/[^\d]/g, '');
      if (b.adapter === 'whatsapp-web' && !ext.startsWith('lid:')) ext = ext.replace(/[^\d]/g, '');
      if (!ext) throw bad('Vul de afzender-id in');
      if (m.sender(b.id, ext)) throw bad('Deze afzender staat al op de allowlist');
      const row = {
        id: newId('cs_'),
        binding_id: b.id,
        user_id: u.id,
        external_id: ext,
        label: str(req.body?.label, 80).trim() || ext,
        is_owner: !!req.body?.is_owner,
        source: req.body?.source === 'log' ? 'log' : 'manual',
        created_at: now(),
      };
      ctx.store.insert('channel_senders', row);
      ctx.audit(u.id, 'channels.sender_added', { binding: b.id, sender: ext, owner: row.is_owner }, b.agent_id);
      ctx.events.emit(u.id, 'channels.updated', m.view(b));
      return m.sender(b.id, ext);
    }),
  );

  api.patch(
    '/channels/bindings/:id/senders/:sid',
    ah(async (req) => {
      const u = user(req);
      const b = ownBinding(req);
      const s = ctx.store.get<any>('channel_senders', String(req.params.sid));
      if (!s || s.binding_id !== b.id) throw notFound('Afzender niet gevonden');
      const p: any = {};
      if (req.body?.label !== undefined) p.label = str(req.body.label, 80).trim() || s.external_id;
      if (req.body?.is_owner !== undefined) p.is_owner = !!req.body.is_owner;
      ctx.store.update('channel_senders', s.id, p);
      ctx.audit(u.id, 'channels.sender_updated', { binding: b.id, sender: s.external_id, ...p }, b.agent_id);
      return ctx.store.get('channel_senders', s.id);
    }),
  );

  api.delete(
    '/channels/bindings/:id/senders/:sid',
    ah(async (req) => {
      const u = user(req);
      const b = ownBinding(req);
      const s = ctx.store.get<any>('channel_senders', String(req.params.sid));
      if (!s || s.binding_id !== b.id) throw notFound('Afzender niet gevonden');
      ctx.store.remove('channel_senders', s.id);
      ctx.audit(u.id, 'channels.sender_removed', { binding: b.id, sender: s.external_id }, b.agent_id);
      ctx.events.emit(u.id, 'channels.updated', m.view(b));
      return { ok: true };
    }),
  );

  // ---- pairing codes ----
  api.post(
    '/channels/bindings/:id/pair-codes',
    ah(async (req) => {
      const b = ownBinding(req);
      const r = m.createPairCode(b, { label: str(req.body?.label, 80), owner: !!req.body?.owner, minutes: Number(req.body?.minutes) || 30 });
      const uname = b.state?.info?.botUsername;
      const deepLink = b.adapter === 'telegram' && uname ? `https://t.me/${uname}?start=${r.code}` : null;
      return {
        ...r,
        command: b.adapter === 'email' ? `koppel ${r.code}` : `/koppel ${r.code}`,
        deepLink,
        // Telegram on the computer: scan with the phone's camera, Telegram opens, press Start. Done.
        qrSvg: deepLink ? await QRCode.toString(deepLink, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 }) : null,
      };
    }),
  );

  api.delete(
    '/channels/bindings/:id/pair-codes/:cid',
    ah(async (req) => {
      const b = ownBinding(req);
      ctx.store.exec('DELETE FROM channel_pair_codes WHERE id = ? AND binding_id = ?', String(req.params.cid), b.id);
      return { ok: true };
    }),
  );

  // ---- conversations ----
  api.get(
    '/channels/bindings/:id/conversations',
    ah(async (req) => {
      const b = ownBinding(req);
      const senders = new Map(m.senders(b.id).map((s) => [s.external_id, s]));
      return m.conversations(b.id).map((c) => ({
        id: c.id,
        external_id: c.external_id,
        title: c.title,
        is_private: c.is_private,
        thread_id: c.thread_id,
        paused: c.paused,
        handoff: c.meta?.handoff || null,
        last_sender: c.last_sender_id ? senders.get(c.last_sender_id)?.label || c.last_sender_id : null,
        last_inbound_at: c.last_inbound_at,
        last_outbound_at: c.last_outbound_at,
        created_at: c.created_at,
      }));
    }),
  );

  api.patch(
    '/channels/conversations/:id',
    ah(async (req) => {
      const u = user(req);
      const c = ownConv(req);
      if (req.body?.paused === false && c.meta?.handoff) {
        // "Hervatten" on a conversation that was handed off: released, the bot answers again.
        m.releaseHandoff(c.id, u.id, 'released');
      } else if (req.body?.paused !== undefined) {
        ctx.store.update('channel_conversations', c.id, { paused: !!req.body.paused });
        ctx.audit(u.id, req.body.paused ? 'channels.conversation_paused' : 'channels.conversation_resumed', { conversation: c.id }, m.binding(c.binding_id)?.agent_id);
        const t = c.thread_id ? ctx.store.thread(c.thread_id) : null;
        if (t) ctx.chat.addEvent(t, req.body.paused ? 'Bot gepauzeerd in dit gesprek: nieuwe berichten komen binnen maar de bot antwoordt niet. Je kunt zelf antwoorden.' : 'Bot antwoordt weer in dit gesprek.', { kind: 'channel_pause' });
      }
      const upd = m.conversation(c.id)!;
      ctx.events.emit(u.id, 'channels.conversation', upd);
      return upd;
    }),
  );

  api.post(
    '/channels/conversations/:id/send',
    ah(async (req) => {
      const u = user(req);
      const c = ownConv(req);
      const text = str(req.body?.text, 20_000).trim();
      if (!text) throw bad('Leeg bericht');
      try {
        return await m.ownerSend(c, u, text);
      } catch (e: any) {
        throw bad(e?.message || String(e));
      }
    }),
  );

  /** Chat header: is this thread a channel conversation? */
  api.get(
    '/channels/threads/:threadId',
    ah(async (req) => {
      const u = user(req);
      const t = ctx.store.thread(String(req.params.threadId));
      if (!canSeeThread(u.id, t) || t.user_id !== u.id || t.kind !== 'channel') return { channel: null };
      const c = m.conversationByThread(t.id);
      const b = m.binding(c?.binding_id);
      if (!c || !b || b.user_id !== u.id) return { channel: null };
      const s = m.sender(b.id, c.last_sender_id);
      return {
        channel: {
          conversationId: c.id,
          title: c.title,
          paused: c.paused,
          handoff: c.meta?.handoff || null,
          is_private: c.is_private,
          bindingId: b.id,
          bindingName: b.name,
          adapter: b.adapter,
          adapterLabel: m.def(b)?.label || b.adapter,
          status: b.status,
          sender: s ? { label: s.label, is_owner: s.is_owner } : null,
          access: m.accessFor(b, c, s),
        },
      };
    }),
  );

  api.post(
    '/channels/messages/:id/resend',
    ah(async (req) => {
      const u = user(req);
      const msg = ctx.store.message(String(req.params.id));
      const t = msg ? ctx.store.thread(msg.thread_id) : null;
      if (!msg || !t || t.user_id !== u.id || t.kind !== 'channel' || msg.role !== 'assistant') throw notFound('Bericht niet gevonden');
      const c = m.conversationByThread(t.id);
      if (!c) throw bad('Geen kanaalgesprek');
      const cb = m.binding(c.binding_id);
      // Customer mode: "Opnieuw" goes through the same check as the first time (never around the approval).
      if (cb && m.customerFor(cb, c)) {
        const action = await m.customerReply(cb, c, t, { run: null, messageId: msg.id, agentId: msg.author_id, agentName: msg.author_name || '', draft: msg.content, files: [] });
        if (action === 'failed') throw bad('Versturen mislukt');
        ctx.audit(u.id, 'channels.resend', { message: msg.id, conversation: c.id, action }, msg.author_id);
        return ctx.store.message(msg.id);
      }
      try {
        await m.deliver(c, { text: msg.content }, { kind: 'reply', messageId: msg.id, threadId: t.id });
      } catch (e: any) {
        throw bad(e?.message || String(e));
      }
      const b = m.binding(c.binding_id);
      const upd = ctx.store.updateMessage(msg.id, { parts: { ...msg.parts, channelDelivery: { status: 'sent', adapter: b?.adapter, label: m.def(b)?.label, at: now(), manual: true } } });
      ctx.chat.emitMessage(t, upd, 'message.updated');
      ctx.audit(u.id, 'channels.resend', { message: msg.id, conversation: c.id }, msg.author_id);
      return upd;
    }),
  );

  api.get(
    '/channels/slack-manifest',
    ah(async (req) => {
      const u = user(req);
      const b = req.query.bindingId ? m.binding(String(req.query.bindingId)) : null;
      if (b && b.user_id !== u.id) throw notFound('Koppeling niet gevonden');
      const mode = req.query.mode === 'events' ? 'events' : 'socket';
      return slackManifest({ name: str(req.query.name, 35) || b?.name || 'TeamBot', mode, eventsUrl: b ? m.webhookUrl(b, 'slack') : '' });
    }),
  );

  api.get(
    '/channels/discord-invite',
    ah(async (req) => {
      const b = own(req, m.binding(String(req.query.bindingId || '')), 'Koppeling niet gevonden');
      const appId = b.state?.info?.appId;
      if (!appId) throw bad('Test de koppeling eerst, dan is de app-id bekend');
      return { url: discordInviteUrl(appId) };
    }),
  );

  // ---- linked device (WhatsApp QR): pairing state, QR, pairing code, unlink ----
  const linked = (req: any): Binding => {
    const b = ownBinding(req);
    if (!m.def(b)?.botRouting || b.adapter !== 'whatsapp-web') throw bad('Dit kanaal wordt niet via een QR-code gekoppeld');
    return b;
  };

  api.get(
    '/channels/bindings/:id/whatsapp',
    ah(async (req) => {
      const b = linked(req);
      const st: any = m.runtime(b.id)?.linkState?.() || { phase: b.enabled ? (b.status === 'error' ? 'error' : 'starting') : 'stopped' };
      const qrSvg = st.qr ? await QRCode.toString(String(st.qr), { type: 'svg', errorCorrectionLevel: 'M', margin: 1 }) : null;
      const { qr: _qr, ...rest } = st;
      return { ...rest, qrSvg, status: b.status, enabled: b.enabled, last_error: b.last_error, info: b.state?.info || {} };
    }),
  );

  api.post(
    '/channels/bindings/:id/whatsapp/link',
    ah(async (req) => {
      const u = user(req);
      const b = linked(req);
      m.updateBinding(b.id, { enabled: true, state: { ...b.state, linkRequestedAt: now() } });
      ctx.audit(u.id, 'channels.whatsapp_link', { id: b.id }, b.agent_id);
      await m.connect(b.id);
      return m.view(m.binding(b.id)!);
    }),
  );

  api.post(
    '/channels/bindings/:id/whatsapp/pair-phone',
    ah(async (req) => {
      const u = user(req);
      const b = linked(req);
      const rt = m.runtime(b.id);
      if (!rt?.requestPairingCode) throw bad('Start eerst het koppelen (knop “Koppelen”) en probeer het dan opnieuw.');
      try {
        const code = await rt.requestPairingCode(str(req.body?.phone, 30));
        ctx.audit(u.id, 'channels.whatsapp_pair_code', { id: b.id }, b.agent_id);
        return { code };
      } catch (e: any) {
        throw bad(m.cleanError(b, e));
      }
    }),
  );

  api.post(
    '/channels/bindings/:id/whatsapp/logout',
    ah(async (req) => {
      const u = user(req);
      const b = linked(req);
      const rt = m.runtime(b.id);
      try {
        await rt?.logout?.();
      } catch (e: any) {
        ctx.log.warn('[channels] whatsapp logout failed', e?.message);
      }
      await m.disconnect(b.id);
      m.deleteStorage(b.id);
      const cur = m.binding(b.id)!;
      m.updateBinding(b.id, { enabled: false, state: { ...cur.state, info: {}, linkRequestedAt: null } });
      m.setStatus(b.id, 'stopped', null);
      m.resetHealth(b.id);
      m.log(b.id, 'system', 'unlinked', 'Ontkoppeld vanuit TeamBot; de sessie is gewist');
      ctx.audit(u.id, 'channels.whatsapp_unlinked', { id: b.id }, b.agent_id);
      const view = m.view(m.binding(b.id)!);
      ctx.events.emit(u.id, 'channels.updated', view);
      return view;
    }),
  );

  // ---- "send without asking" per bot (channel_send to the owner himself, or to contacts the owner trusts) ----
  const ownAgent = (req: any) => {
    const a = ctx.store.agent(String(req.params.agentId));
    if (!a || a.user_id !== user(req).id) throw notFound('Bot niet gevonden');
    return a;
  };
  const rulesView = (agentId: string, userId: string) => {
    const rules = m.sendRules(agentId);
    const bindings = m.bindings(userId);
    const name = (id: string | null) => {
      const b = bindings.find((x) => x.id === id);
      return b ? `${b.name} (${m.def(b)?.label || b.adapter})` : null;
    };
    return {
      ownerWithoutApproval: rules.some((r) => r.target === 'owner' && !r.binding_id),
      contacts: rules.filter((r) => r.target !== 'owner').map((r) => ({ id: r.id, binding_id: r.binding_id, binding: name(r.binding_id), target: r.target, label: r.label, created_at: r.created_at })),
    };
  };

  api.get(
    '/channels/agents/:agentId/send-rules',
    ah(async (req) => {
      const a = ownAgent(req);
      return rulesView(a.id, a.user_id);
    }),
  );

  api.put(
    '/channels/agents/:agentId/send-rules/owner',
    ah(async (req) => {
      const u = user(req);
      const a = ownAgent(req);
      const on = !!req.body?.enabled;
      ctx.store.exec("DELETE FROM channel_send_rules WHERE agent_id = ? AND target = 'owner' AND binding_id IS NULL", a.id);
      if (on) ctx.store.insert('channel_send_rules', { id: newId('csr_'), user_id: u.id, agent_id: a.id, binding_id: null, target: 'owner', label: 'Jij (eigenaar)', created_at: now() });
      ctx.audit(u.id, on ? 'channels.send_rule_owner_on' : 'channels.send_rule_owner_off', {}, a.id);
      return rulesView(a.id, u.id);
    }),
  );

  api.post(
    '/channels/agents/:agentId/send-rules',
    ah(async (req) => {
      const u = user(req);
      const a = ownAgent(req);
      const b = m.binding(str(req.body?.binding_id, 60));
      if (!b || b.user_id !== u.id) throw bad('Kies een kanaal');
      const raw = str(req.body?.target, 300).trim();
      if (!raw) throw bad('Vul het nummer, adres of gesprek in');
      const t = m.classifyTarget(b, raw);
      if (t.owner) throw bad('Dat ben jij zelf; gebruik daarvoor de schakelaar “Mag mij zonder vragen berichten sturen”.');
      if (m.sendAllowed(a.id, b, t)) throw bad('Deze ontvanger staat er al op');
      const label = str(req.body?.label, 80).trim() || t.conv?.title || t.ext;
      ctx.store.insert('channel_send_rules', { id: newId('csr_'), user_id: u.id, agent_id: a.id, binding_id: b.id, target: t.ext, label, created_at: now() });
      ctx.audit(u.id, 'channels.send_rule_added', { binding: b.id, target: t.ext.slice(0, 120) }, a.id);
      return rulesView(a.id, u.id);
    }),
  );

  api.delete(
    '/channels/agents/:agentId/send-rules/:ruleId',
    ah(async (req) => {
      const u = user(req);
      const a = ownAgent(req);
      ctx.store.exec('DELETE FROM channel_send_rules WHERE id = ? AND agent_id = ?', String(req.params.ruleId), a.id);
      ctx.audit(u.id, 'channels.send_rule_removed', { rule: String(req.params.ruleId) }, a.id);
      return rulesView(a.id, u.id);
    }),
  );

  // ---- public webhooks (raw body; each adapter verifies its own signature) ----
  ctx.publicApi.all('/hooks/channels/:id/:kind', express.raw({ type: () => true, limit: '5mb' }), async (req, res) => {
    const id = String(req.params.id);
    const kind = String(req.params.kind);
    try {
      if (req.method !== 'GET' && req.method !== 'POST') return void res.status(405).json({ error: 'Niet toegestaan' });
      if (!m.webhookLimiter.take(id)) return void res.status(429).json({ error: 'Te veel verzoeken' });
      const b = m.binding(id);
      const def = m.def(b);
      if (!b || !def || !b.enabled || !(def.webhookKinds || []).includes(kind)) return void res.status(404).json({ error: 'Niet gevonden' });
      const rt = m.runtime(id);
      if (!rt?.webhook) return void res.status(503).json({ error: 'Kanaal is niet actief' });
      await rt.webhook(kind, req, res);
    } catch (e: any) {
      ctx.log.warn('[channels] webhook failed', e?.message);
      if (!res.headersSent) res.status(500).json({ error: 'Interne fout' });
    }
  });
}
