import fs from 'node:fs';
import { publicView } from '../agent/chat.js';
import { canTalkTo } from '../agent/shared.js';
import path from 'node:path';
import express from 'express';
import type { Ctx, Message, Thread } from '../core/types.js';
import { ah, bad, notFound, own, str, user } from '../core/http.js';
import { newId, now } from '../core/db.js';
import { mimeOf } from '../tools/builtin/files.js';
import { redact } from '../core/secrets.js';
import { fallbackList, MAX_FALLBACKS } from '../agent/fallback.js';
import { applySharedModel } from './provider-policy.js';
import { prettyModel } from '../../shared/modelLabel.js';

/** Earlier versions kept per edited message. */
const MAX_VERSIONS = 20;

/** Media types that are safe to show inline (no script execution possible). */
export const SAFE_INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm', 'audio/ogg', 'video/mp4', 'video/webm', 'text/plain']);

export function canSeeThread(userId: string, t: Thread | null): t is Thread {
  return !!t && (t.user_id === userId || ((t.meta?.memberUserIds as string[]) || []).includes(userId));
}

export function threadToMarkdown(ctx: Ctx, t: Thread, msgs: Message[]): string {
  const lines = [`# ${t.title || 'Gesprek'}`, '', `_Geëxporteerd uit ${ctx.config.appName} op ${new Date().toLocaleString('nl-NL')}_`, ''];
  for (const m of msgs) {
    if (m.role === 'tool') {
      lines.push(`> 🔧 **${m.parts?.toolResult?.name}** → ${m.content.slice(0, 500).replace(/\n/g, '\n> ')}`, '');
      continue;
    }
    if (m.role === 'event') {
      lines.push(`_${m.content}_`, '');
      continue;
    }
    lines.push(`**${m.author_name || m.role}** · ${new Date(m.created_at).toLocaleString('nl-NL')}${m.edited_at ? ' · bewerkt' : ''}`, '');
    // CLI engines (Claude Code, Codex, OpenCode) keep their steps as activity lines, API engines as tool calls.
    const steps = (m.parts?.activity || []).filter((x: any) => x?.title && x.kind !== 'mode').map((x: any) => `- 🔧 ${redact(String(x.title)).slice(0, 300)}`);
    if (steps.length) lines.push(`_${steps.length === 1 ? '1 stap' : `${steps.length} stappen`}:_`, ...steps, '');
    lines.push(m.content || '', '');
    const extra = [...(m.parts?.attachments || []).map((a: any) => `- 📎 ${a.name}`), ...(m.parts?.toolCalls || []).map((c: any) => `- 🔧 ${c.name}: ${redact(String(c.summary || JSON.stringify(c.args).slice(0, 200)))} (${c.status})`)];
    if (extra.length) lines.push(...extra, '');
  }
  return lines.join('\n');
}

/** Why a thread can be resumed: a crash/restart cut the last run off, or the owner pressed stop himself. */
export type ResumeReason = 'interrupted' | 'stopped';

/** Stop reasons that come from the owner's stop buttons (chat stop, "Alles stoppen"); not a steer or a new message. */
const MANUAL_STOP = new Set(['Gestopt door gebruiker', 'Alles gestopt']);

/**
 * Can the last run of this thread be resumed ("Hervatten")? Only for a run that was cut off (restart) or stopped by the
 * owner; never after an interrupt-to-steer (the new message continues) or when something newer happened.
 */
export function resumeReason(ctx: Ctx, threadId: string): ResumeReason | null {
  const last = ctx.store.one<any>('SELECT id, status, error, meta FROM runs WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', threadId);
  if (!last) return null;
  if (last.status === 'interrupted') return 'interrupted';
  if (last.status !== 'cancelled' || !MANUAL_STOP.has(String(last.error || ''))) return null;
  // A group has its own stop/continue (several bots); "Hervatten" after a stop is for a chat with one bot.
  const t = ctx.store.thread(threadId);
  if (!t || t.kind === 'room' || t.room_id) return null;
  const meta = (() => {
    try {
      return JSON.parse(last.meta || '{}');
    } catch {
      return {};
    }
  })();
  if (meta.steerInterrupt) return null;
  // The owner already went on (a new message after the stop): nothing to resume.
  const later = ctx.store.one<any>("SELECT id FROM messages WHERE thread_id = ? AND role = 'user' AND deleted = 0 AND seq > COALESCE((SELECT MAX(seq) FROM messages WHERE run_id = ?), (SELECT seq FROM messages WHERE id = (SELECT input_message_id FROM runs WHERE id = ?)), 0) LIMIT 1", threadId, last.id, last.id);
  return later ? null : 'stopped';
}

export function threadRoutes(ctx: Ctx) {
  const api = ctx.api;
  const getThread = (req: any): Thread => {
    const t = ctx.store.thread(req.params.id);
    if (!canSeeThread(user(req).id, t)) throw notFound('Gesprek niet gevonden');
    return t;
  };

  api.get(
    '/threads',
    ah(async (req) => {
      const u = user(req);
      const list = ctx.store.threads(u.id, {
        agentId: (req.query.agentId as string) || undefined,
        roomId: (req.query.roomId as string) || undefined,
        kind: (req.query.kind as string) || undefined,
        archived: req.query.archived === '1',
        limit: Number(req.query.limit) || 200,
      });
      // The newest message of every listed thread in one query, with only what the preview shows: the first 140
      // characters (never a whole long answer) and `parts` only for a failed answer (the budget stop below).
      const lastRows = ctx.store.all<any>(
        `SELECT m.thread_id, substr(m.content, 1, 140) AS content, m.author_name, m.created_at, m.role, m.status,
           CASE WHEN m.status = 'error' THEN m.parts END AS parts
         FROM json_each(?) j
         JOIN messages m ON m.id = (SELECT id FROM messages WHERE thread_id = j.value AND deleted = 0 ORDER BY seq DESC LIMIT 1)`,
        list.map((t) => t.id),
      );
      const lastByThread = new Map(lastRows.map((r) => [r.thread_id as string, ctx.store.decode<Pick<Message, 'content' | 'author_name' | 'created_at' | 'role' | 'status' | 'parts'>>('messages', r)]));
      return list.map((t) => {
        const last = lastByThread.get(t.id);
        // status: lets the UI show a bot's "something went wrong" face when its last answer failed; budgetUntil: it was
        // stopped by the daily budget until then (a limit, not a failure: "daglimiet bereikt").
        const budgetUntil = last?.status === 'error' && last.parts?.budget?.resetAt ? String(last.parts.budget.resetAt) : undefined;
        return { ...t, last: last ? { content: last.content.slice(0, 140), author_name: last.author_name, created_at: last.created_at, role: last.role, status: last.status, ...(budgetUntil ? { budgetUntil } : {}) } : null };
      });
    }),
  );

  api.post(
    '/threads',
    ah(async (req) => {
      const u = user(req);
      const agentId = req.body?.agentId;
      // Your own bot, or one shared with the team (then the conversation is yours alone, agent/shared.ts).
      const agent = agentId ? ctx.store.agent(agentId) : null;
      if (agentId && !(agent && agent.user_id !== u.id && canTalkTo(ctx, u.id, agent))) own(req, agent, 'Bot niet gevonden');
      const t = ctx.store.createThread({ user_id: u.id, agent_id: agentId || null, title: str(req.body?.title, 120), kind: 'chat', ...(agent && agent.user_id !== u.id ? { meta: { sharedBot: { ownerId: agent.user_id } } } : {}) });
      ctx.events.emit(u.id, 'thread.updated', t);
      return t;
    }),
  );

  api.get(
    '/threads/:id',
    ah(async (req) => {
      const t = getThread(req);
      const messages = ctx.store.messages(t.id, { limit: Number(req.query.limit) || 300, beforeSeq: Number(req.query.before) || undefined });
      const runs = ctx.store.all<any>("SELECT * FROM runs WHERE thread_id = ? AND status IN ('queued','running','waiting')", t.id).map((r) => ctx.store.decode('runs', r));
      const own = t.user_id === user(req).id;
      const reason = runs.length ? null : resumeReason(ctx, t.id);
      return { thread: t, messages: own ? messages : messages.map((m) => publicView(m)), runs, canResume: !!reason, resumeReason: reason };
    }),
  );

  api.patch(
    '/threads/:id',
    ah(async (req) => {
      const t = getThread(req);
      const p: any = {};
      if (req.body?.title !== undefined) p.title = str(req.body.title, 120);
      if (req.body?.pinned !== undefined) p.pinned = !!req.body.pinned;
      if (req.body?.archived !== undefined) p.archived = !!req.body.archived;
      const upd = ctx.store.updateThread(t.id, p);
      ctx.chat.emit(upd, 'thread.updated', upd);
      return upd;
    }),
  );

  api.delete(
    '/threads/:id',
    ah(async (req) => {
      const t = getThread(req);
      if (t.user_id !== user(req).id) throw bad('Alleen de eigenaar kan dit gesprek verwijderen');
      ctx.runs.cancelThread(t.id, undefined, 'Gesprek verwijderd');
      ctx.store.deleteThread(t.id);
      ctx.events.emit(t.user_id, 'thread.deleted', { id: t.id });
      return { ok: true };
    }),
  );

  api.post(
    '/threads/:id/messages',
    ah(async (req) => {
      const u = user(req);
      const t = getThread(req);
      const content = str(req.body?.content, 200_000);
      const attachments = Array.isArray(req.body?.attachments)
        ? req.body.attachments
            .map((id: string) => ctx.store.get<any>('attachments', id))
            .filter((a: any) => a && a.user_id === u.id)
            .map((a: any) => ({ id: a.id, name: a.name, mime: a.mime, size: a.size }))
        : [];
      if (!content.trim() && !attachments.length) throw bad('Leeg bericht');
      for (const a of attachments) ctx.store.update('attachments', a.id, { thread_id: t.id });
      return ctx.chat.postUserMessage({ thread: t, user: u, content, attachments, replyTo: req.body?.replyTo || null, parts: req.body?.voice ? { voice: true } : undefined });
    }),
  );

  api.post(
    '/threads/:id/stop',
    ah(async (req) => {
      const t = getThread(req);
      return { stopped: ctx.runs.cancelThread(t.id, (req.body?.agentId as string) || undefined) };
    }),
  );

  api.post(
    '/threads/:id/resume',
    ah(async (req) => {
      const t = getThread(req);
      const last = ctx.store.one<any>('SELECT * FROM runs WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', t.id);
      const agentId = req.body?.agentId || last?.agent_id || t.agent_id;
      if (!agentId) throw bad('Geen bot om te hervatten');
      if (ctx.store.one("SELECT id FROM runs WHERE thread_id = ? AND agent_id = ? AND status IN ('queued','running','waiting')", t.id, agentId)) throw bad('De bot is al bezig in dit gesprek');
      const stopped = resumeReason(ctx, t.id) === 'stopped';
      const content = stopped
        ? 'De eigenaar had je gestopt en vraagt je nu verder te gaan waar je gebleven was. Controleer eerst wat al gedaan is voordat je acties herhaalt.'
        : 'Ga verder waar je gebleven was. Controleer eerst wat al gedaan is voordat je acties herhaalt.';
      const sys = ctx.store.createMessage({ thread_id: t.id, role: 'system', author_type: 'system', author_name: 'TeamBot', content });
      ctx.chat.emitMessage(t, sys);
      return ctx.chat.startAgent(t, agentId, sys.id, 'resume');
    }),
  );

  api.post(
    '/threads/:id/retry',
    ah(async (req) => {
      const t = getThread(req);
      const lastUser = ctx.store.one<any>("SELECT id FROM messages WHERE thread_id = ? AND role = 'user' AND deleted = 0 ORDER BY seq DESC LIMIT 1", t.id);
      if (!lastUser) throw bad('Geen bericht om opnieuw te proberen');
      const agentId = req.body?.agentId || t.agent_id;
      if (!agentId) throw bad('Geen bot');
      return ctx.chat.startAgent(t, agentId, lastUser.id, 'retry');
    }),
  );

  /**
   * "Verder met Ollama (lokaal)": a bot whose engine hit its limit goes on with a free alternative it was offered
   * (agent/alternatives.ts) — right away, for its last message — and keeps it as its first reserve engine, so the next
   * limit switches by itself. A scheduled "probeert het rond … opnieuw" for that message is dropped.
   */
  api.post(
    '/threads/:id/switch-engine',
    ah(async (req) => {
      const u = user(req);
      const t = getThread(req);
      const agent = ctx.store.agent(str(req.body?.agentId || t.agent_id || '', 60));
      if (!agent || agent.user_id !== u.id || agent.user_id !== t.user_id) throw notFound('Bot niet gevonden');
      const cfg = ctx.providers.config(str(req.body?.providerId, 60));
      if (!cfg || !cfg.enabled || !ctx.providers.canUse(u.id, cfg)) throw bad('Deze engine is niet (meer) gekoppeld');
      const model = str(req.body?.model ?? '', 200);
      if (model) applySharedModel(cfg, u.id, model);
      const lastUser = ctx.store.one<any>("SELECT id FROM messages WHERE thread_id = ? AND role = 'user' AND deleted = 0 ORDER BY seq DESC LIMIT 1", t.id);
      if (!lastUser) throw bad('Geen bericht om opnieuw te proberen');
      const fallbacks = [{ provider_id: cfg.id, model }, ...fallbackList(agent).filter((f) => !(f.provider_id === cfg.id && f.model === model))].slice(0, MAX_FALLBACKS);
      const a = ctx.store.updateAgent(agent.id, { settings: { ...agent.settings, fallbacks }, fallback: fallbacks[0] });
      ctx.events.emit(u.id, 'agent.updated', a);
      const waiting = ctx.store.all<{ id: string }>("SELECT id FROM runs WHERE thread_id = ? AND agent_id = ? AND json_extract(meta, '$.limitRetryAt') IS NOT NULL AND json_extract(meta, '$.limitRetried') IS NULL", t.id, agent.id);
      for (const r of waiting) ctx.services.runner?.cancelLimitRetry?.(r.id);
      // The offer has been used: its buttons go.
      for (const m of ctx.store.messages(t.id).filter((x) => x.author_id === agent.id && x.parts?.switchTo)) ctx.chat.emitMessage(t, ctx.store.updateMessage(m.id, { parts: { ...m.parts, switchTo: undefined } }), 'message.updated');
      const label = `${cfg.name}${model && model !== 'default' ? ` · ${prettyModel(model)}` : ''}`;
      // The chat said "probeert het rond 17:04 automatisch opnieuw" above: say that this no longer happens (Q-12).
      // (two whole sentences, so each language can translate them as a whole)
      const said = waiting.length ? `${agent.name} gaat verder met ${label}; dat is nu ook zijn reserve-engine. Automatisch opnieuw proberen is niet meer nodig.` : `${agent.name} gaat verder met ${label}; dat is nu ook zijn reserve-engine.`;
      ctx.chat.addEvent(t, said, { kind: 'fallback' });
      ctx.audit(u.id, 'agent.switch_engine', { provider: cfg.id, model }, agent.id);
      return { run: ctx.chat.startAgent(t, agent.id, lastUser.id, 'retry', { override: { provider_id: cfg.id, model } }), agent: a };
    }),
  );

  api.get(
    '/threads/:id/export',
    ah(async (req, res) => {
      const t = getThread(req);
      const msgs = ctx.store.messages(t.id, { limit: 100_000 });
      const name = (t.title || 'gesprek').replace(/[^\w-]+/g, '_').slice(0, 60);
      if (req.query.format === 'json') {
        res.setHeader('content-disposition', `attachment; filename="${name}.json"`);
        // Engine session ids and other internal state stay out; the messages keep tool steps, attachments and versions.
        const { provider_state: _ps, ...thread } = t;
        res.json({ format: 'teambot.thread/v1', exported_at: now(), thread, messages: msgs.map((m) => ({ ...m, parts: { ...m.parts, raw: undefined, context: undefined, contextByAgent: undefined } })) });
      } else {
        res.setHeader('content-type', 'text/markdown; charset=utf-8');
        res.setHeader('content-disposition', `attachment; filename="${name}.md"`);
        res.send(threadToMarkdown(ctx, t, msgs));
      }
    }),
  );

  // ---- messages ----
  const getMsg = (req: any) => {
    const m = ctx.store.message(req.params.id);
    const t = m ? ctx.store.thread(m.thread_id) : null;
    if (!m || !canSeeThread(user(req).id, t)) throw notFound('Bericht niet gevonden');
    return { m, t: t! };
  };

  api.patch(
    '/messages/:id',
    ah(async (req) => {
      const u = user(req);
      const { m, t } = getMsg(req);
      if (m.author_id !== u.id) throw bad('Je kunt alleen je eigen berichten bewerken');
      const content = str(req.body?.content, 200_000);
      if (!content.trim() && !m.parts?.attachments?.length) throw bad('Leeg bericht; verwijder het liever.');
      if (content === m.content) return m;
      // Keep the earlier text, so "bewerkt" can show every previous version (newest last, at most 20).
      const versions = [...(Array.isArray(m.parts?.versions) ? m.parts.versions : []), { content: m.content, at: m.edited_at || m.created_at }].slice(-MAX_VERSIONS);
      const upd = ctx.store.updateMessage(m.id, { content, edited_at: now(), parts: { ...m.parts, versions } });
      ctx.chat.emitMessage(t, upd, 'message.updated');
      return upd;
    }),
  );

  /**
   * "Opnieuw" under an answer, and "Opslaan en opnieuw versturen" on your own message: the bot answers again from that
   * message of yours. What came after it leaves the conversation (hidden, marked `replaced`), so the bot does not read
   * its earlier answer; an edited text keeps its versions like any edit. Only in a conversation with one bot, and not
   * while the bot is still working.
   */
  const rerunFrom = (u: { id: string }, t: any, m: any, content?: string) => {
    if (m.role !== 'user' || m.author_id !== u.id || m.deleted) throw bad('Opnieuw antwoorden kan alleen vanaf een bericht van jezelf');
    if (t.kind !== 'chat' || t.room_id || !t.agent_id) throw bad('Opnieuw antwoorden kan alleen in een gesprek met één bot');
    if (ctx.runs.isBusy(t.id, t.agent_id)) throw bad('De bot is nog bezig. Stop hem eerst, of wacht tot hij klaar is.');
    if (content !== undefined && content !== m.content) {
      if (!content.trim() && !m.parts?.attachments?.length) throw bad('Leeg bericht; verwijder het liever.');
      const versions = [...(Array.isArray(m.parts?.versions) ? m.parts.versions : []), { content: m.content, at: m.edited_at || m.created_at }].slice(-MAX_VERSIONS);
      ctx.chat.emitMessage(t, ctx.store.updateMessage(m.id, { content, edited_at: now(), parts: { ...m.parts, versions } }), 'message.updated');
    }
    for (const later of ctx.store.messages(t.id, { limit: 5000 }).filter((x) => x.seq > m.seq)) {
      ctx.chat.emitMessage(t, ctx.store.updateMessage(later.id, { deleted: true, parts: { ...later.parts, replaced: true } }), 'message.updated');
    }
    // A CLI engine (Claude Code, Codex …) keeps the conversation in a session of its own, with the replaced answer in
    // it: forget that session, so the next turn starts a new one from what is still in this conversation.
    ctx.store.updateThread(t.id, { provider_state: {} });
    try {
      ctx.store.exec('DELETE FROM cli_sessions WHERE thread_id = ? AND agent_id = ?', t.id, t.agent_id);
    } catch {
      /* no CLI module in this build: no session table */
    }
    return ctx.chat.startAgent(ctx.store.thread(t.id) || t, t.agent_id, m.id, 'retry');
  };

  api.post(
    '/messages/:id/rerun',
    ah(async (req) => {
      const { m, t } = getMsg(req);
      return rerunFrom(user(req), t, m, req.body?.content === undefined ? undefined : str(req.body.content, 200_000));
    }),
  );

  api.post(
    '/threads/:id/regenerate',
    ah(async (req) => {
      const t = getThread(req);
      const last = ctx.store.messages(t.id, { limit: 5000 }).filter((x) => x.role === 'user').pop();
      if (!last) throw bad('Geen bericht om opnieuw te beantwoorden');
      return rerunFrom(user(req), t, last);
    }),
  );

  api.delete(
    '/messages/:id',
    ah(async (req) => {
      const { m, t } = getMsg(req);
      const me = user(req).id;
      if (m.author_id !== me && t.user_id !== me) throw bad('Je kunt alleen je eigen berichten verwijderen');
      const upd = ctx.store.updateMessage(m.id, { deleted: true });
      ctx.chat.emitMessage(t, upd, 'message.updated');
      return { ok: true };
    }),
  );

  api.post(
    '/messages/:id/react',
    ah(async (req) => {
      const u = user(req);
      const { m, t } = getMsg(req);
      const emoji = str(req.body?.emoji, 16);
      if (!emoji) throw bad('Geen emoji');
      const reactions = { ...(m.reactions || {}) };
      const list = new Set(reactions[emoji] || []);
      if (list.has(u.id)) list.delete(u.id);
      else list.add(u.id);
      if (list.size) reactions[emoji] = [...list];
      else delete reactions[emoji];
      const upd = ctx.store.updateMessage(m.id, { reactions });
      ctx.chat.emitMessage(t, upd, 'message.updated');
      return upd;
    }),
  );

  api.post(
    '/messages/:id/pin',
    ah(async (req) => {
      const { m, t } = getMsg(req);
      const upd = ctx.store.updateMessage(m.id, { pinned: !m.pinned });
      ctx.chat.emitMessage(t, upd, 'message.updated');
      return upd;
    }),
  );

  api.post(
    '/messages/:id/forward',
    ah(async (req) => {
      const u = user(req);
      const { m } = getMsg(req);
      const target = ctx.store.thread(req.body?.threadId);
      if (!canSeeThread(u.id, target)) throw notFound('Doelgesprek niet gevonden');
      return ctx.chat.postUserMessage({ thread: target, user: u, content: `Doorgestuurd van ${m.author_name}:\n\n${m.content}`, attachments: m.parts?.attachments });
    }),
  );

  // ---- attachments (raw body upload: works from browser, phone and channels) ----
  api.post(
    '/attachments',
    express.raw({ type: () => true, limit: '200mb' }),
    ah(async (req) => {
      const u = user(req);
      const name = path.basename(str(req.query.name, 200) || 'bestand');
      const buf: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!buf.length) throw bad('Leeg bestand');
      const id = newId('att_');
      const dir = path.join(ctx.config.dataDir, 'attachments', u.id);
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, id + path.extname(name));
      fs.writeFileSync(dest, buf);
      const mime = ((req.headers['content-type'] && req.headers['content-type'] !== 'application/octet-stream' ? String(req.headers['content-type']).split(';')[0] : mimeOf(name)) || 'application/octet-stream').trim().toLowerCase();
      const row = { id, user_id: u.id, thread_id: (req.query.threadId as string) || null, name, mime, size: buf.length, path: dest, created_at: now() };
      ctx.store.insert('attachments', row);
      return { id, name, mime, size: buf.length };
    }),
  );

  api.get(
    '/attachments/:id',
    ah(async (req, res) => {
      const u = user(req);
      const a = ctx.store.get<any>('attachments', req.params.id as string);
      const t = a?.thread_id ? ctx.store.thread(a.thread_id) : null;
      if (!a || (a.user_id !== u.id && !canSeeThread(u.id, t))) throw notFound('Bijlage niet gevonden');
      if (!fs.existsSync(a.path)) throw notFound('Bestand ontbreekt op schijf');
      // Only plain media is ever rendered inline on the TeamBot origin; everything else (HTML, SVG, XML, PDF, unknown)
      // is a sandboxed download, so an uploaded or bot-made file can never run script with the user's session.
      const mime = String(a.mime || '').toLowerCase().split(';')[0].trim();
      const inlineOk = SAFE_INLINE.has(mime);
      res.setHeader('content-type', inlineOk ? mime : mime && /^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime : 'application/octet-stream');
      res.setHeader('content-disposition', `${req.query.download || !inlineOk ? 'attachment' : 'inline'}; filename="${encodeURIComponent(a.name)}"`);
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('content-security-policy', "sandbox; default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'");
      fs.createReadStream(a.path).pipe(res);
    }),
  );

  api.get(
    '/search',
    ah(async (req) => {
      const u = user(req);
      const q = str(req.query.q, 200);
      if (!q.trim()) return [];
      return ctx.store.search(u.id, q, 60);
    }),
  );
}
