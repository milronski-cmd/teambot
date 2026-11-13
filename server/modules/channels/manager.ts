import { TERMINAL } from '../../agent/runs.js';
import { userTz } from '../../agent/prompt.js';
import fs from 'node:fs';
import { tr, trUser, trUserText, userLanguage, userLocale } from '../../core/i18n.js';
import path from 'node:path';
import type { Agent, Ctx, Message, Run, Thread, ToolDef, User } from '../../core/types.js';
import { newId, now } from '../../core/db.js';
import { redact } from '../../core/secrets.js';
import { humanCode } from '../../core/auth.js';
import { mimeOf } from '../../tools/builtin/files.js';
import { preview } from './format.js';
import { RateLimiter, scrub, sha256 } from './security.js';
import { ChannelTeams } from './teams.js';
import { botTags, plusAddress } from './email-util.js';
import { computeHealth, ERROR_KINDS, NOT_RECEIVED, parseTestCode, type HealthRecord, type HealthView } from './health.js';
import { AI_LABEL_EVERY_MS, TEXT, classifyDraft, hoursSummary, humanRequested, isOpen, knowledgeItems, nextOpening, readCustomer, type CustomerConfig, type DraftVerdict, type KnowledgeItem } from './customer.js';
import {
  ChannelError,
  type AccessLevel,
  type AdapterContext,
  type AdapterDef,
  type AdapterRuntime,
  type Binding,
  type BindingStatus,
  type BotEngine,
  type ChatMessageEvent,
  type ChatMessageResult,
  type Conversation,
  type EmailEvent,
  type Inbound,
  type InboundAttachment,
  type OutFile,
  type Outbound,
  type ReactionStatus,
  type ReceiveResult,
  type Sender,
  type Transcriber,
} from './types.js';

interface Live {
  rt: AdapterRuntime;
  ac: AbortController;
  gen: number;
}

/** Where an outgoing message came from (kept with it in the outbox on channels in customer mode). */
export interface OutboxRec {
  /** reply (the bot's answer), handoff (the "a person will reply" notice), owner, system, send (channel_send), routine. */
  kind?: string;
  /** Update this outbox row instead of adding one (a held reply that is now sent). */
  rowId?: string;
  runId?: string | null;
  messageId?: string | null;
  threadId?: string | null;
  agentId?: string | null;
  question?: string | null;
  draft?: string | null;
  reasons?: string[];
  decided_by?: string | null;
}

/** A row of channel_outbox: one message to a customer (sent, failed, held for approval, handed off, rejected). */
export interface OutboxRow {
  id: string;
  user_id: string;
  binding_id: string;
  conversation_id: string;
  conversation_ext: string | null;
  thread_id: string | null;
  run_id: string | null;
  message_id: string | null;
  agent_id: string | null;
  kind: string;
  status: 'sent' | 'failed' | 'held' | 'sending' | 'handoff' | 'rejected';
  question: string | null;
  draft: string | null;
  text: string | null;
  reasons: string[];
  files: any[];
  ext_ids: string[];
  edited: boolean;
  decided_by: string | null;
  decided_at: string | null;
  error: string | null;
  created_at: string;
  sent_at: string | null;
}

const fileRef = (f: OutFile) => ({ name: f.name, mime: f.mime, path: f.path, size: f.size });

const PAIR_CMDS = new Set(['koppel', 'pair', 'start', 'link']);
const APPROVE_CMDS: Record<string, 'y' | 'n' | 'a'> = { ja: 'y', yes: 'y', ok: 'y', goedkeuren: 'y', nee: 'n', no: 'n', weiger: 'n', weigeren: 'n', antwoord: 'a', answer: 'a' };
/** After "@Baas …" the owner keeps talking to that bot for a while without repeating the name. */
const STICKY_MS = 30 * 60_000;
/** channel_send `to` values that mean "the owner himself". */
export const OWNER_TARGETS = new Set(['owner', 'eigenaar', 'me', 'mij', 'ik', 'self', 'jezelf']);

export const ACCESS_LEVELS: AccessLevel[] = ['none', 'readonly', 'agent'];
/** The names of the access levels as the UI shows them (Kanalen › Toegang). */
export const ACCESS_LABEL: Record<AccessLevel, string> = { none: 'Alleen praten', readonly: 'Alleen lezen', agent: 'Zoals de bot zelf' };

/** “routine “A”” / “de routines “A” en “B””. */
export function routineList(names: string[]): string {
  const q = names.map((n) => `“${n}”`);
  if (q.length <= 1) return `routine ${q[0] || ''}`.trim();
  return `de routines ${q.slice(0, -1).join(', ')} en ${q.at(-1)}`;
}

/** Plain-Dutch reason why a CLI bot cannot answer someone with this access level, plus what the owner can do. */
export function refusalText(agentName: string, engine: BotEngine, level: AccessLevel): { short: string; long: string } {
  const what = level === 'none' ? 'Die werkt altijd met zijn eigen tools en kan niet “alleen praten”.' : 'Daar kan TeamBot “Alleen lezen” niet per afzender afdwingen.';
  const options = engine.levels.filter((l) => l !== level).map((l) => `“${ACCESS_LABEL[l]}”`);
  const pick = options.length > 1 ? `${options.slice(0, -1).join(', ')} of ${options.at(-1)}` : options[0] || `“${ACCESS_LABEL.agent}”`;
  return {
    short: `${agentName} draait op ${engine.label}. ${what}`,
    long: `${agentName} draait op ${engine.label}. ${what} Kies bij Kanalen › Toegang ${pick}${engine.levels.includes('none') ? '' : ' (alleen voor mensen die je volledig vertrouwt)'}, of laat een bot met een API-model antwoorden.`,
  };
}

/** "/cmd@bot arg" → { name, arg } (Telegram appends @botname in groups). */
export function parseCommand(text: string): { name: string; arg: string } | null {
  const m = text.trim().match(/^\/([a-zA-Z]{2,20})(?:@[\w.]+)?(?:\s+([\s\S]*))?$/);
  return m ? { name: m[1].toLowerCase(), arg: (m[2] || '').trim() } : null;
}

/** A pairing code in a message: "/koppel CODE", "/start CODE" or (e-mail) "koppel CODE" in the first lines. */
export function parsePairCode(text: string): string | null {
  const c = parseCommand(text);
  if (c && PAIR_CMDS.has(c.name)) {
    const code = c.arg.split(/\s+/)[0] || '';
    return /^[A-Za-z0-9]{6,12}$/.test(code) ? code.toUpperCase() : null;
  }
  const m = text.slice(0, 400).match(/\b(?:koppel|pair)(?:code)?[:\s]+([A-Z0-9]{8})\b/i);
  return m ? m[1].toUpperCase() : null;
}

/**
 * "@Baas maak het rapport", "Baas: maak het rapport", "baas, …" → { id, rest }. Longest name first, so
 * "Baas Live: …" never goes to "Baas". A bare name without @ or punctuation ("Baas maak …") does not count.
 */
export function matchBotName(text: string, bots: { id: string; name: string }[]): { id: string; rest: string } | null {
  const t = String(text || '').trimStart();
  const at = t.startsWith('@');
  const s = at ? t.slice(1) : t;
  const list = bots.filter((x) => x.name.trim().length >= 2).sort((x, y) => y.name.trim().length - x.name.trim().length);
  for (const bot of list) {
    const n = bot.name.trim();
    if (s.slice(0, n.length).toLowerCase() !== n.toLowerCase()) continue;
    const after = s.slice(n.length);
    const sep = after.match(/^\s*[:,]\s*/);
    if (sep) return { id: bot.id, rest: after.slice(sep[0].length).trim() };
    if (at && (after === '' || /^\s/.test(after))) return { id: bot.id, rest: after.trim() };
  }
  return null;
}

export class ChannelManager {
  adapters = new Map<string, AdapterDef>();
  private live = new Map<string, Live>();
  /**
   * Bindings that are being deleted. Their runtime still says "stopped" while it shuts down (WhatsApp pushes that at
   * the end of its logout); nobody needs to hear it, and an open page would ask for a binding that is gone a moment
   * later (a console 404, acceptance round 6). channels.deleted follows.
   */
  private closing = new Set<string>();
  private retry = new Map<string, { attempts: number; timer?: NodeJS.Timeout }>();
  private typingTimers = new Map<string, NodeJS.Timeout>();
  private emailListeners = new Set<(e: EmailEvent) => void | Promise<void>>();
  private chatListeners = new Set<(e: ChatMessageEvent) => ChatMessageResult | void>();
  private sendQueues = new Map<string, Promise<unknown>>();
  private handledRuns = new Set<string>();
  /** Per thread: incoming messages with a 👀 that still wait for done or error (status reactions). */
  private pendingReactions = new Map<string, { bindingId: string; convId: string; reactTo: string }[]>();
  private gen = 0;
  private logCount = 0;
  private stopped = false;
  private senderLimiter = new RateLimiter(10, 60_000);
  private bindingLimiter = new RateLimiter(60, 60_000);
  private pairLimiter = new RateLimiter(5, 3_600_000);
  private blockedLogLimiter = new RateLimiter(1, 600_000);
  private notifyLimiter = new RateLimiter(1, 86_400_000);
  webhookLimiter = new RateLimiter(300, 60_000);
  /** "<binding>:<chat>" → the bot the owner addressed last (botRouting adapters). */
  private sticky = new Map<string, { agentId: string; until: number }>();
  /** Speech-to-text for inbound voice notes (another module can plug in a local engine). */
  transcriber: Transcriber | null = null;
  /** How long the owner has to send "test CODE" before the receive test fails (tests shorten it). */
  healthTestMs = 10 * 60_000;
  private healthTimers = new Map<string, NodeJS.Timeout>();
  private healthEmitted = new Map<string, { state: string; at: number }>();
  /** Strangers writing to a channel in customer mode: at most this many messages per day each (AI costs money). */
  private openLimiter = new RateLimiter(50, 86_400_000);
  /** Channels per team (0.4, package B4): which team a channel belongs to and which bots may use it. */
  teams: ChannelTeams;

  constructor(private ctx: Ctx) {
    this.teams = new ChannelTeams(ctx);
  }

  /** The approved knowledge of a channel in customer mode: its own lines, plus its team's business profile if chosen. */
  knowledgeFor(b: Binding, cust: CustomerConfig): KnowledgeItem[] {
    return knowledgeItems(cust.knowledge, cust.profile ? this.teams.profileLines(b) : []);
  }

  // ------------------------------------------------------------------ repos

  binding(id: string | null | undefined): Binding | null {
    return id ? this.ctx.store.get<Binding>('channel_bindings', id) : null;
  }
  bindings(userId: string): Binding[] {
    return this.ctx.store.find<Binding>('channel_bindings', { user_id: userId }, { order: 'created_at' });
  }
  allEnabled(): Binding[] {
    return this.ctx.store.find<Binding>('channel_bindings', { enabled: 1 });
  }
  updateBinding(id: string, patch: Partial<Binding>) {
    this.ctx.store.update('channel_bindings', id, { ...patch, updated_at: now() });
    return this.binding(id)!;
  }
  sender(bindingId: string, externalId: string | null | undefined): Sender | null {
    if (!externalId) return null;
    const r = this.ctx.store.one('SELECT * FROM channel_senders WHERE binding_id = ? AND external_id = ?', bindingId, externalId);
    return r ? this.ctx.store.decode<Sender>('channel_senders', r) : null;
  }
  senders(bindingId: string): Sender[] {
    return this.ctx.store.find<Sender>('channel_senders', { binding_id: bindingId }, { order: 'created_at' });
  }
  conversation(id: string | null | undefined): Conversation | null {
    return id ? this.ctx.store.get<Conversation>('channel_conversations', id) : null;
  }
  conversationByExt(bindingId: string, externalId: string): Conversation | null {
    const r = this.ctx.store.one('SELECT * FROM channel_conversations WHERE binding_id = ? AND external_id = ?', bindingId, externalId);
    return r ? this.ctx.store.decode<Conversation>('channel_conversations', r) : null;
  }
  conversationByThread(threadId: string): Conversation | null {
    const r = this.ctx.store.one('SELECT * FROM channel_conversations WHERE thread_id = ? ORDER BY last_inbound_at DESC LIMIT 1', threadId);
    return r ? this.ctx.store.decode<Conversation>('channel_conversations', r) : null;
  }
  conversations(bindingId: string): Conversation[] {
    return this.ctx.store.find<Conversation>('channel_conversations', { binding_id: bindingId }, { order: 'COALESCE(last_inbound_at, created_at) DESC', limit: 500 });
  }

  def(b: Binding | null): AdapterDef | undefined {
    return b ? this.adapters.get(b.adapter) : undefined;
  }

  /** Is this secret field set? (never decrypts) */
  hasSecret(b: Binding, key: string): boolean {
    const id = b.secret_ids?.[key];
    return !!id && !!this.ctx.store.one('SELECT id FROM secrets WHERE id = ? AND user_id = ?', id, b.user_id);
  }
  secretValue(b: Binding, key: string): string | null {
    const id = b.secret_ids?.[key];
    if (!id || this.ctx.secrets.owner(id) !== b.user_id) return null;
    return this.ctx.secrets.get(id);
  }
  setSecrets(b: Binding, values: Record<string, string | null | undefined>): Binding {
    const def = this.def(b);
    const ids = { ...(b.secret_ids || {}) };
    for (const [key, value] of Object.entries(values || {})) {
      if (!def?.secretFields.some((f) => f.key === key) && key !== 'webhookSecret' && !def?.internalSecrets?.includes(key)) continue;
      if (value === null) {
        if (ids[key]) this.ctx.secrets.delete(ids[key]);
        delete ids[key];
        continue;
      }
      if (typeof value !== 'string' || !value.trim()) continue;
      ids[key] = this.ctx.secrets.set(b.user_id, `channels:${b.id}:${key}`, value.trim());
    }
    return this.updateBinding(b.id, { secret_ids: ids });
  }
  deleteSecrets(b: Binding) {
    for (const id of Object.values(b.secret_ids || {})) this.ctx.secrets.delete(id);
  }

  publicBase(b: Binding | null): string {
    const own = String(b?.config?.publicBaseUrl || '').trim();
    return (own || this.ctx.config.publicUrl || '').replace(/\/+$/, '');
  }
  webhookPath(b: Binding, kind: string) {
    return `/api/public/hooks/channels/${b.id}/${kind}`;
  }
  webhookUrl(b: Binding, kind: string): string {
    const base = this.publicBase(b);
    return base ? base + this.webhookPath(b, kind) : '';
  }

  // ------------------------------------------------------------------ views

  view(b: Binding) {
    const def = this.def(b);
    const secrets: Record<string, boolean> = {};
    for (const f of def?.secretFields || []) secrets[f.key] = this.hasSecret(b, f.key);
    const counts = {
      senders: this.ctx.store.one<any>('SELECT COUNT(*) n FROM channel_senders WHERE binding_id = ?', b.id)?.n ?? 0,
      conversations: this.ctx.store.one<any>('SELECT COUNT(*) n FROM channel_conversations WHERE binding_id = ?', b.id)?.n ?? 0,
    };
    return {
      id: b.id,
      adapter: b.adapter,
      adapterLabel: def?.label || b.adapter,
      name: b.name,
      agent_id: b.agent_id,
      room_id: b.room_id,
      config: b.config,
      secrets,
      enabled: b.enabled,
      status: b.status,
      running: this.live.has(b.id),
      last_error: b.last_error,
      last_ok_at: b.last_ok_at,
      info: b.state?.info || {},
      needsPublicUrl: def ? def.needsPublicUrl(b.config) : false,
      publicBaseUrl: this.publicBase(b),
      webhooks: (def?.webhookKinds || []).map((k) => ({ kind: k, path: this.webhookPath(b, k), url: this.webhookUrl(b, k) })),
      approveViaChannelSupported: !!def?.approveViaChannel,
      /** The platform has status reactions (👀, then done or error): shows their on/off switch. */
      reactionsSupported: !!def?.reactions,
      /** Engine of the bot that answers, with the access levels it can be held to (null for a room). */
      engine: this.engineOf(b.agent_id),
      link: this.linkPhase(b.id),
      counts,
      /** Has TeamBot really received and sent with these settings? ("verbonden" only when both are proven) */
      health: this.healthView(b),
      /** Customer mode: may strangers write in a private chat? Never on WhatsApp (QR), that is the owner's own number. */
      openDoorSupported: b.adapter !== 'whatsapp-web',
      /** The team this channel belongs to (that of its bot or group); only that team's bots answer and send on it. */
      team_id: this.teams.teamOf(b),
      teamName: this.teams.teamName(this.teams.teamOf(b)),
      /** E-mail with plus addressing (P10): the address of each bot (you+baas@…). */
      botAddresses: this.botAddresses(b),
      created_at: b.created_at,
      updated_at: b.updated_at,
    };
  }

  // ------------------------------------------------------------------ health

  healthView(b: Binding): HealthView {
    const def = this.def(b);
    const kind = def?.webhookKinds?.[0];
    return computeHealth(b, def, { webhookUrl: kind ? this.webhookUrl(b, kind) : '', day: this.dayStats(b.id) });
  }

  /** In / out / errors in the last 24 hours, from the channel log. */
  private dayStats(id: string): { in: number; out: number; errors: number } {
    const since = new Date(Date.now() - 864e5).toISOString();
    const r = this.ctx.store.one<any>(
      "SELECT SUM(direction = 'in' AND kind NOT IN ('rejected','error','test_failed')) AS i, SUM(direction = 'out' AND kind = 'message') AS o, SUM(kind IN ('error','rejected','test_failed')) AS e FROM channel_log WHERE binding_id = ? AND created_at >= ?",
      id,
      since,
    );
    return { in: Number(r?.i) || 0, out: Number(r?.o) || 0, errors: Number(r?.e) || 0 };
  }

  /** Change the health record; the apps hear about it when the state changes (timestamps at most every 5 s). */
  private patchHealth(id: string, fn: (h: HealthRecord) => HealthRecord | void, force = false) {
    const b = this.binding(id);
    if (!b || this.closing.has(id)) return;
    const cur: HealthRecord = { ...(b.health || {}) };
    const next = fn(cur) || cur;
    this.ctx.store.update('channel_bindings', id, { health: next });
    const fresh = this.binding(id)!;
    const view = this.healthView(fresh);
    const last = this.healthEmitted.get(id);
    if (!force && last && last.state === view.state && Date.now() - last.at < 5000) return;
    this.healthEmitted.set(id, { state: view.state, at: Date.now() });
    this.ctx.events.emit(b.user_id, 'channels.health', { id, health: view });
  }

  /** New connection settings: evidence from before no longer counts (the history of errors stays). */
  resetHealth(id: string) {
    this.clearHealthTimer(id);
    this.patchHealth(id, (h) => ({ since: now(), lastError: h.lastError || null }), true);
  }

  /** Every log line is evidence: something arrived, something left, the platform checked us, or it failed. */
  private healthFromLog(b: Binding, direction: 'in' | 'out' | 'system', kind: string, summary: string) {
    const at = now();
    const ev = { at, text: summary };
    if (direction === 'system' && kind === 'verified') return this.patchHealth(b.id, (h) => void (h.platformAt = at), true);
    if (direction === 'in' && kind === 'rejected')
      return this.patchHealth(b.id, (h) => {
        h.lastError = ev;
        // Before the first real message this is most likely a wrong secret; afterwards it is noise (or an attacker).
        if (!h.receiveOkAt) h.receiveProblem = { at, text: `${summary}. Kwam dit verzoek van ${this.def(b)?.label || 'het platform'}, controleer dan het geheim bij Instellingen.` };
      });
    if (direction === 'in' && !NOT_RECEIVED.has(kind))
      return this.patchHealth(b.id, (h) => {
        h.inAt = at;
        h.receiveOkAt ||= at;
        h.receiveProblem = null;
      });
    if (direction === 'out' && (kind === 'message' || kind === 'system'))
      return this.patchHealth(b.id, (h) => {
        h.outAt = at;
        h.sendOkAt ||= at;
        h.sendProblem = null;
      });
    if (direction === 'out' && kind === 'error')
      return this.patchHealth(b.id, (h) => {
        h.sendProblem = ev;
        h.lastError = ev;
      });
    if (ERROR_KINDS.has(kind)) this.patchHealth(b.id, (h) => void (h.lastError = ev));
  }

  private clearHealthTimer(id: string) {
    const t = this.healthTimers.get(id);
    if (t) clearTimeout(t);
    this.healthTimers.delete(id);
  }

  private armHealthTimer(id: string, hash: string, ms: number) {
    this.clearHealthTimer(id);
    const t = setTimeout(() => void this.healthTestTimeout(id, hash).catch((e) => this.ctx.log.warn('[channels] health test', e?.message)), Math.max(0, ms));
    t.unref?.();
    this.healthTimers.set(id, t);
  }

  /**
   * Start the receive + send test: the owner sends "test CODE" to the bot (on Telegram one tap on a link), TeamBot
   * answers, and both directions are proven. Only the hash of the code is kept.
   */
  startHealthTest(b: Binding): { code: string; text: string; deepLink: string | null; expiresAt: string } {
    if (!this.live.has(b.id) || (b.status !== 'connected' && b.status !== 'listening')) throw new ChannelError('Verbind het kanaal eerst; daarna kun je testen of berichten aankomen.');
    const code = humanCode(6);
    const startedAt = now();
    const expiresAt = new Date(Date.now() + this.healthTestMs).toISOString();
    const hash = sha256(code);
    this.patchHealth(b.id, (h) => void (h.test = { codeHash: hash, startedAt, expiresAt }), true);
    this.armHealthTimer(b.id, hash, this.healthTestMs);
    this.log(b.id, 'system', 'test_started', 'Test gestart: TeamBot wacht op een bericht met de testcode');
    const uname = b.state?.info?.botUsername;
    return { code, text: `test ${code}`, deepLink: b.adapter === 'telegram' && uname ? `https://t.me/${uname}?start=test_${code}` : null, expiresAt };
  }

  cancelHealthTest(id: string) {
    this.clearHealthTimer(id);
    this.patchHealth(id, (h) => void (h.test = null), true);
  }

  /** Does this message carry the code of the running test? */
  private isTestMessage(b: Binding, text: string): boolean {
    const t = b.health?.test;
    if (!t || t.expiresAt < now()) return false;
    const code = parseTestCode(text);
    return !!code && sha256(code) === t.codeHash;
  }

  /** The test code arrived (from anyone: only the owner's screen shows it). Answer it: that proves sending. */
  private async finishHealthTest(b: Binding, def: AdapterDef, m: Inbound, extra: { senderId: string; senderName?: string; conversationId: string }): Promise<ReceiveResult> {
    this.clearHealthTimer(b.id);
    this.patchHealth(b.id, (h) => void (h.test = null));
    this.log(b.id, 'in', 'test_ok', 'Testbericht ontvangen', extra);
    const existing = this.conversationByExt(b.id, extra.conversationId);
    const conv: Conversation = existing || {
      id: '',
      binding_id: b.id,
      user_id: b.user_id,
      external_id: extra.conversationId,
      thread_id: null,
      title: m.conversation.title || m.sender.name,
      is_private: !!m.conversation.private,
      meta: m.extra || {},
      paused: false,
      last_sender_id: extra.senderId,
      last_inbound_at: null,
      last_outbound_at: null,
      created_at: now(),
    };
    let ok = true;
    let detail = '';
    try {
      await this.reply(b, conv, `✅ ${trUser(this.ctx.store, b.user_id, 'Het werkt: TeamBot ontvangt je berichten via {0} en kan antwoorden.', def.label)}`);
    } catch (e) {
      ok = false;
      detail = this.cleanError(b, e);
      this.log(b.id, 'out', 'error', `Versturen mislukt: ${detail}`, { conversationId: extra.conversationId });
    }
    const text = ok ? 'Ontvangen en versturen werken.' : `Ontvangen werkt, maar versturen lukte niet: ${detail}`;
    this.patchHealth(b.id, (h) => void (h.lastTest = { at: now(), ok, text }), true);
    this.ctx.events.emit(b.user_id, 'channels.updated', this.view(this.binding(b.id)!));
    return { status: 'command', ...(existing ? { conversationId: existing.id } : {}) };
  }

  /** Nothing arrived in time: say why, as exactly as the platform lets us know. */
  private async healthTestTimeout(id: string, hash: string) {
    this.healthTimers.delete(id);
    const b = this.binding(id);
    const t = b?.health?.test;
    if (!b || !t || t.codeHash !== hash) return;
    const others = !!b.health?.inAt && b.health.inAt > t.startedAt;
    let text: string;
    if (others) text = 'Er kwamen wel berichten binnen, maar geen met de testcode. Stuur precies “test” en de code, zonder andere tekst.';
    else text = `Er kwam geen testbericht binnen. ${await this.receiveReason(b)}`;
    this.patchHealth(
      id,
      (h) => {
        h.test = null;
        h.lastTest = { at: now(), ok: false, text };
        if (!others) h.receiveProblem = { at: now(), text };
      },
      true,
    );
    this.log(id, 'system', 'test_failed', text);
    this.ctx.events.emit(b.user_id, 'channels.updated', this.view(this.binding(id)!));
  }

  /** Why receiving does not work: no public address, what the platform reports, or the adapter's likely causes. */
  async receiveReason(b: Binding): Promise<string> {
    const def = this.def(b);
    if (!def) return '';
    const kind = def.webhookKinds?.[0];
    const url = kind ? this.webhookUrl(b, kind) : '';
    if (def.needsPublicUrl(b.config) && !url) return `${def.label} kan TeamBot niet bereiken: er is geen publiek https-adres ingesteld.`;
    try {
      const d = await this.runtime(b.id)?.diagnose?.();
      if (d) return this.cleanError(b, d);
    } catch {
      /* no extra information */
    }
    return def.receiveHint?.({ config: b.config, info: b.state?.info || {}, platformAt: b.health?.platformAt || null, webhookUrl: url }) || 'Controleer of je het bericht naar het juiste account stuurde.';
  }

  /**
   * Existing channels (from before 0.4) get their health from the log: a message that arrived or left is proof.
   * Tests that were running when TeamBot stopped continue, or fail now if their time is up.
   */
  private initHealth() {
    for (const row of this.ctx.store.all<any>('SELECT * FROM channel_bindings')) {
      const b = this.ctx.store.decode<Binding>('channel_bindings', row);
      const h = b.health || {};
      if (!h.since) {
        const lastIn = this.ctx.store.one<any>("SELECT created_at FROM channel_log WHERE binding_id = ? AND direction = 'in' AND kind NOT IN ('rejected','error','test_failed') ORDER BY id DESC LIMIT 1", b.id)?.created_at || null;
        const lastOut = this.ctx.store.one<any>("SELECT created_at FROM channel_log WHERE binding_id = ? AND direction = 'out' AND kind IN ('message','system') ORDER BY id DESC LIMIT 1", b.id)?.created_at || null;
        this.ctx.store.update('channel_bindings', b.id, { health: { since: b.created_at, inAt: lastIn, receiveOkAt: lastIn, outAt: lastOut, sendOkAt: lastOut } });
      } else if (h.test) {
        this.armHealthTimer(b.id, h.test.codeHash, Date.parse(h.test.expiresAt) - Date.now());
      }
    }
  }

  /** Pairing phase of a linked-device channel (no QR data; that is fetched separately by the owner). */
  linkPhase(id: string): Record<string, any> | null {
    const st = this.live.get(id)?.rt.linkState?.();
    if (!st) return null;
    const { qr: _qr, ...rest } = st;
    return rest;
  }

  /** Private files of a binding (e.g. the encrypted WhatsApp session). */
  storageDir(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error('Ongeldige koppeling');
    return path.join(this.ctx.config.dataDir, 'channels', id);
  }
  deleteStorage(id: string) {
    try {
      fs.rmSync(this.storageDir(id), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (e: any) {
      this.ctx.log.warn('[channels] storage cleanup failed', e?.message);
    }
  }

  /** Put the owner's own account on the allowlist (linked-device channels know it for sure). */
  ensureOwnerSender(bindingId: string, externalId: string, label: string) {
    const b = this.binding(bindingId);
    const ext = String(externalId || '').slice(0, 200);
    if (!b || !ext) return;
    const s = this.sender(b.id, ext);
    if (s?.is_owner) return;
    if (s) this.ctx.store.update('channel_senders', s.id, { is_owner: true });
    else this.ctx.store.insert('channel_senders', { id: newId('cs_'), binding_id: b.id, user_id: b.user_id, external_id: ext, label: label.slice(0, 80), is_owner: true, source: 'pair', created_at: now() });
    this.ctx.audit(b.user_id, 'channels.owner_linked', { binding: b.id, adapter: b.adapter, sender: ext }, b.agent_id);
    this.ctx.events.emit(b.user_id, 'channels.updated', this.view(b));
  }

  // ------------------------------------------------------------------ lifecycle

  private adapterCtx(b: Binding, ac: AbortController, gen: number): AdapterContext {
    const id = b.id;
    const userId = b.user_id;
    return {
      bindingId: id,
      binding: () => this.binding(id)!,
      secret: (f) => {
        const cur = this.binding(id);
        return cur ? this.secretValue(cur, f) : null;
      },
      storeSecret: (f, v) => {
        const cur = this.binding(id);
        if (cur) this.setSecrets(cur, { [f]: v });
      },
      receive: (m) => this.receive(id, m),
      action: (a) => this.handleAction(id, a),
      isAllowed: (ext) => !!this.sender(id, ext),
      conversationForMessageIds: (ids) => this.convForMsgIds(id, ids),
      setState: (patch) => {
        const cur = this.binding(id);
        if (cur) this.ctx.store.update('channel_bindings', id, { state: { ...cur.state, ...patch } });
      },
      status: (s, d) => {
        if (gen < 0 || this.isCurrent(id, gen)) this.setStatus(id, s, d ?? null);
      },
      fail: (e, fatal) => {
        if (gen >= 0 && this.isCurrent(id, gen)) this.onFailure(id, e, !!fatal || (e instanceof ChannelError && e.fatal));
      },
      log: (dir, kind, summary, extra) => this.log(id, dir, kind, summary, extra),
      publicBaseUrl: () => this.publicBase(this.binding(id)),
      webhookUrl: (k) => {
        const cur = this.binding(id);
        return cur ? this.webhookUrl(cur, k) : '';
      },
      ownerRole: () => this.ctx.store.user(userId)?.role || 'member',
      storageDir: () => {
        const d = this.storageDir(id);
        fs.mkdirSync(d, { recursive: true });
        return d;
      },
      notify: (kind, data) => {
        if (this.closing.has(id)) return;
        if (gen < 0 || this.isCurrent(id, gen)) this.ctx.events.emit(userId, `channels.${kind}`, { ...data, id });
      },
      ensureOwnerSender: (ext, label) => this.ensureOwnerSender(id, ext, label),
      signal: ac.signal,
      emitEmail: (e) => this.emitEmail(e),
    };
  }

  private isCurrent(id: string, gen: number) {
    return this.live.get(id)?.gen === gen;
  }

  missingSecrets(b: Binding): string[] {
    const def = this.def(b);
    if (!def) return [];
    return def.secretFields.filter((f) => (typeof f.required === 'function' ? f.required(b.config) : f.required) && !this.hasSecret(b, f.key)).map((f) => f.label);
  }

  async connect(id: string): Promise<void> {
    const b = this.binding(id);
    if (!b || !b.enabled || this.stopped) return;
    await this.disconnect(id, false);
    const def = this.def(b);
    if (!def) return void this.setStatus(id, 'error', `Onbekend kanaaltype "${b.adapter}"`);
    const missing = this.missingSecrets(b);
    if (missing.length) return void this.setStatus(id, 'error', `Nog niet ingevuld: ${missing.join(', ')}`);
    if (!b.agent_id && !b.room_id) return void this.setStatus(id, 'error', 'Kies eerst een bot of room voor deze koppeling');
    const ac = new AbortController();
    const gen = ++this.gen;
    let rt: AdapterRuntime;
    try {
      rt = def.create(this.adapterCtx(b, ac, gen));
    } catch (e) {
      return void this.setStatus(id, 'error', this.cleanError(b, e));
    }
    this.live.set(id, { rt, ac, gen });
    this.setStatus(id, 'connecting', null);
    try {
      const st = (await rt.start()) || 'connected';
      if (!this.isCurrent(id, gen)) return;
      if (this.binding(id)?.status !== 'connected' || st !== 'connecting') this.setStatus(id, st, null);
      // Not "verbonden" yet: that needs a message in and a message out (health).
      if (st !== 'connecting') this.log(id, 'system', 'connected', st === 'listening' ? 'Webhook staat klaar; ontvangen is nog niet getest' : 'Verbinding gemaakt; ontvangen en versturen zijn nog niet getest');
      const t = setTimeout(() => {
        if (this.isCurrent(id, gen)) this.retry.delete(id);
      }, 60_000);
      t.unref?.();
    } catch (e: any) {
      if (!this.isCurrent(id, gen)) return;
      this.onFailure(id, e, e instanceof ChannelError && e.fatal);
    }
  }

  private onFailure(id: string, e: any, fatal: boolean) {
    const b = this.binding(id);
    if (!b) return;
    const msg = this.cleanError(b, e);
    const live = this.live.get(id);
    if (live) {
      this.live.delete(id);
      live.ac.abort();
      live.rt.stop().catch(() => {});
    }
    this.log(id, 'system', 'error', msg);
    if (fatal || !b.enabled || this.stopped) {
      this.setStatus(id, 'error', msg);
      return;
    }
    const r = this.retry.get(id) || { attempts: 0 };
    if (r.timer) clearTimeout(r.timer);
    const base = Math.min(300_000, 2000 * 2 ** r.attempts);
    const delay = Math.round(Math.max(Number(e?.retryAfterMs) || 0, base) * (0.8 + Math.random() * 0.4));
    r.attempts++;
    r.timer = setTimeout(() => {
      this.connect(id).catch((err) => this.ctx.log.warn('[channels] reconnect failed', err?.message));
    }, delay);
    r.timer.unref?.();
    this.retry.set(id, r);
    this.setStatus(id, 'error', `${msg} — nieuwe poging over ${Math.max(1, Math.round(delay / 1000))} s`);
  }

  async disconnect(id: string, clearRetry = true) {
    if (clearRetry) {
      const r = this.retry.get(id);
      if (r?.timer) clearTimeout(r.timer);
      this.retry.delete(id);
    }
    const live = this.live.get(id);
    if (!live) return;
    this.live.delete(id);
    live.ac.abort();
    try {
      await live.rt.stop();
    } catch {
      /* ignore */
    }
  }

  async startAll() {
    this.stopped = false;
    // Retention: dedupe ids of chat platforms are only needed briefly; e-mail ids keep threads together longer.
    try {
      const day = 864e5;
      this.ctx.store.exec(
        "DELETE FROM channel_msg_ids WHERE created_at < ? AND binding_id NOT IN (SELECT id FROM channel_bindings WHERE adapter = 'email')",
        new Date(Date.now() - 30 * day).toISOString(),
      );
      this.ctx.store.exec('DELETE FROM channel_msg_ids WHERE created_at < ?', new Date(Date.now() - 365 * day).toISOString());
      this.ctx.store.exec('DELETE FROM channel_approval_prompts WHERE created_at < ?', new Date(Date.now() - 7 * day).toISOString());
    } catch (e: any) {
      this.ctx.log.warn('[channels] retention cleanup failed', e?.message);
    }
    try {
      this.initHealth();
    } catch (e: any) {
      this.ctx.log.warn('[channels] health init failed', e?.message);
    }
    for (const b of this.allEnabled()) this.connect(b.id).catch((e) => this.ctx.log.warn('[channels] connect failed', e?.message));
  }

  async stopAll() {
    this.stopped = true;
    for (const t of this.typingTimers.values()) clearInterval(t);
    this.typingTimers.clear();
    for (const t of this.healthTimers.values()) clearTimeout(t);
    this.healthTimers.clear();
    await Promise.all([...this.live.keys(), ...this.retry.keys()].map((id) => this.disconnect(id)));
  }

  isLive(id: string) {
    return this.live.has(id);
  }

  /** Delete a binding's runtime side quietly (see `closing`): `fn` logs out, disconnects and removes the rows. */
  async deleting<T>(id: string, fn: () => Promise<T>): Promise<T> {
    this.closing.add(id);
    try {
      return await fn();
    } finally {
      this.closing.delete(id);
    }
  }
  runtime(id: string): AdapterRuntime | null {
    return this.live.get(id)?.rt || null;
  }

  setStatus(id: string, status: BindingStatus, error: string | null) {
    const b = this.binding(id);
    if (!b || this.closing.has(id)) return;
    const patch: any = { status, last_error: error };
    if (status === 'connected' || status === 'listening') patch.last_ok_at = now();
    this.ctx.store.update('channel_bindings', id, patch);
    this.ctx.events.emit(b.user_id, 'channels.status', { id, status, last_error: error, last_ok_at: patch.last_ok_at ?? b.last_ok_at });
  }

  cleanError(b: Binding, e: any): string {
    const vals = Object.keys(b.secret_ids || {}).map((k) => this.secretValue(b, k));
    return redact(scrub(String(e?.message || e || 'Onbekende fout'), vals)).slice(0, 500);
  }

  /** Test the connection details without (re)starting the binding. */
  async test(b: Binding) {
    const def = this.def(b);
    if (!def) return { ok: false, detail: 'Onbekend kanaaltype' };
    const missing = this.missingSecrets(b);
    if (missing.length) return { ok: false, detail: `Nog niet ingevuld: ${missing.join(', ')}` };
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 30_000);
    try {
      const r = await def.test(this.adapterCtx(b, ac, -1));
      if (r.info) {
        const cur = this.binding(b.id)!;
        this.ctx.store.update('channel_bindings', b.id, { state: { ...cur.state, info: { ...(cur.state?.info || {}), ...r.info } } });
      }
      this.log(b.id, 'system', r.ok ? 'test_ok' : 'test_failed', r.detail);
      return { ok: r.ok, detail: this.cleanError(b, r.detail) };
    } catch (e) {
      const detail = this.cleanError(b, e);
      this.log(b.id, 'system', 'test_failed', detail);
      return { ok: false, detail };
    } finally {
      clearTimeout(t);
      ac.abort();
    }
  }

  // ------------------------------------------------------------------ log

  log(bindingId: string, direction: 'in' | 'out' | 'system', kind: string, summary: string, extra: { senderId?: string; senderName?: string; conversationId?: string } = {}) {
    const b = this.binding(bindingId);
    if (!b) return;
    const row = {
      binding_id: bindingId,
      user_id: b.user_id,
      direction,
      kind,
      sender_id: extra.senderId ? String(extra.senderId).slice(0, 200) : null,
      sender_name: extra.senderName ? String(extra.senderName).slice(0, 120) : null,
      conversation_id: extra.conversationId ? String(extra.conversationId).slice(0, 300) : null,
      summary: redact(String(summary || '')).slice(0, 300),
      created_at: now(),
    };
    try {
      const r = this.ctx.store.exec(
        'INSERT INTO channel_log (binding_id, user_id, direction, kind, sender_id, sender_name, conversation_id, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        row.binding_id,
        row.user_id,
        row.direction,
        row.kind,
        row.sender_id,
        row.sender_name,
        row.conversation_id,
        row.summary,
        row.created_at,
      );
      if (++this.logCount % 50 === 0)
        this.ctx.store.exec('DELETE FROM channel_log WHERE binding_id = ? AND id <= (SELECT id FROM channel_log WHERE binding_id = ? ORDER BY id DESC LIMIT 1 OFFSET 1000)', bindingId, bindingId);
      this.ctx.events.emit(b.user_id, 'channels.log', { id: Number(r.lastInsertRowid), ...row });
    } catch (e) {
      this.ctx.log.warn('[channels] log failed', (e as any)?.message);
    }
    try {
      this.healthFromLog(b, direction, kind, row.summary);
    } catch (e) {
      this.ctx.log.warn('[channels] health failed', (e as any)?.message);
    }
  }

  // ------------------------------------------------------------------ dedupe / email threading

  /** Record an external message id; false when it was seen before (duplicate / replay). */
  claim(bindingId: string, externalId: string, direction: 'in' | 'out', conversationId: string | null): boolean {
    const r = this.ctx.store.exec(
      'INSERT OR IGNORE INTO channel_msg_ids (binding_id, external_id, conversation_id, direction, created_at) VALUES (?, ?, ?, ?, ?)',
      bindingId,
      String(externalId).slice(0, 500),
      conversationId,
      direction,
      now(),
    );
    return Number(r.changes) === 1;
  }

  private convForMsgIds(bindingId: string, ids: string[]): string | null {
    for (const id of ids.slice(0, 30)) {
      const r = this.ctx.store.one<any>(
        'SELECT c.external_id FROM channel_msg_ids m JOIN channel_conversations c ON c.id = m.conversation_id WHERE m.binding_id = ? AND m.external_id = ?',
        bindingId,
        id,
      );
      if (r?.external_id) return r.external_id;
    }
    return null;
  }

  // ------------------------------------------------------------------ inbound

  accessFor(b: Binding, conv: Pick<Conversation, 'is_private' | 'meta'>, sender: Sender | null): AccessLevel {
    // Customer mode: someone who is not on the allowlist (a stranger who simply wrote) never gets any tools.
    if ((!sender || sender.source === 'customer') && readCustomer(b.config?.customer, b.adapter).enabled) return 'none';
    const owner = !!sender?.is_owner && conv.is_private && !conv.meta?.unverified;
    const lvl = owner ? b.config.ownerAccess : b.config.othersAccess;
    return ACCESS_LEVELS.includes(lvl) ? lvl : owner ? 'agent' : 'none';
  }

  /**
   * The inbound pipeline: dedupe → rate limit → allowlist / pairing → commands →
   * conversation + thread → attachments → post as external message → route to the bot.
   */
  async receive(bindingId: string, m: Inbound): Promise<ReceiveResult> {
    const b = this.binding(bindingId);
    if (!b || !b.enabled) return { status: 'disabled' };
    const def = this.def(b);
    const senderId = String(m.sender?.id || '').slice(0, 200);
    const convExt = String(m.conversation?.id || '').slice(0, 300);
    if (!def || !senderId || !convExt || !m.messageId) return { status: 'invalid' };
    if (!this.claim(b.id, m.messageId, 'in', null)) return { status: 'duplicate' };
    const extra = { senderId, senderName: m.sender.name, conversationId: convExt };
    if (!this.bindingLimiter.take(b.id) || !this.senderLimiter.take(`${b.id}:${senderId}`)) {
      if (this.blockedLogLimiter.take(`rl:${b.id}:${senderId}`)) this.log(b.id, 'in', 'rate_limited', 'Te veel berichten: tijdelijk genegeerd', extra);
      return { status: 'rate_limited' };
    }
    const text = String(m.text || '').slice(0, 20_000).trim();
    // The receive + send test: whoever sends the code saw it on the owner's screen.
    if (this.isTestMessage(b, text)) return this.finishHealthTest(b, def, m, extra);
    let sender = this.sender(b.id, senderId);
    const pairCode = parsePairCode(text);
    /** Not on the allowlist, but may write: a customer in a private chat on a channel in customer mode. */
    let stranger = false;

    if (!sender && !pairCode && this.openDoor(b, m)) {
      if (!this.openLimiter.take(`${b.id}:${senderId}`)) {
        if (this.blockedLogLimiter.take(`open:${b.id}:${senderId}`)) this.log(b.id, 'in', 'rate_limited', 'Meer dan 50 berichten vandaag van deze klant: tot morgen genegeerd', extra);
        return { status: 'rate_limited' };
      }
      sender = { id: `open_${sha256(`${b.id}:${senderId}`).slice(0, 16)}`, binding_id: b.id, user_id: b.user_id, external_id: senderId, label: String(m.sender.name || senderId).slice(0, 80), is_owner: false, source: 'customer', created_at: now() };
      stranger = true;
    }

    if (!sender) {
      if (pairCode) return this.handlePair(b, def, m, pairCode);
      // Never to the bot. Only a routine whose trigger explicitly accepts unknown senders may start from it.
      const trig = this.offerToRoutines(b, def, m, text, [], { known: false, isOwner: false, conversationId: null });
      if (trig.routines.length) {
        this.log(b.id, 'in', 'routine', `Onbekende afzender, niet naar de bot gestuurd. Startte ${routineList(trig.routines)}.`, extra);
        return { status: 'blocked', routines: trig.routines };
      }
      if (this.blockedLogLimiter.take(`${b.id}:${senderId}`)) this.log(b.id, 'in', 'blocked', `Onbekende afzender genegeerd: ${preview(text, 60)}`, extra);
      if (this.notifyLimiter.take(`${b.id}:${senderId}`))
        this.ctx.events.emit(b.user_id, 'notification', {
          title: `Onbekende afzender op ${def.label}`,
          body: `${m.sender.name || senderId} probeerde “${b.name}” te bereiken. Niets doorgestuurd; voeg toe aan de allowlist als je dat wilt.`,
          link: `#/m/channels/${b.id}`,
          kind: 'channel',
        });
      return { status: 'blocked' };
    }

    const conv = this.upsertConversation(b, m, senderId);
    this.ctx.store.exec('UPDATE channel_msg_ids SET conversation_id = ? WHERE binding_id = ? AND external_id = ?', conv.id, b.id, String(m.messageId).slice(0, 500));
    if (pairCode && parseCommand(text)) {
      await this.reply(b, conv, 'Je bent al gekoppeld. Stuur gewoon een bericht.');
      return { status: 'command', conversationId: conv.id };
    }
    const cmd = parseCommand(text);
    if (cmd && (await this.handleCommand(b, conv, sender, cmd))) return { status: 'command', conversationId: conv.id };

    // The owner can talk to any of his bots through one chat: "@Baas …", "Baas: …", or reply to a bot's message.
    let target = conv;
    let body = text;
    if (def.botRouting && !!sender.is_owner && conv.is_private && !conv.meta?.unverified) {
      const pick = this.pickBot(b, conv, text, m.replyToId);
      body = pick.text;
      // Teams (package B4): a bot of another team does not answer on this channel, also not when named.
      const named = pick.agentId ? this.ctx.store.agent(pick.agentId) : null;
      const wall = named ? this.teams.refusal(named, b) : null;
      if (wall) {
        await this.reply(b, conv, wall.replace(/^Geweigerd door TeamBot: /, '')).catch(() => {});
        this.log(b.id, 'in', 'refused', `${named!.name} hoort bij een ander team; niet doorgestuurd`, extra);
        return { status: 'command', conversationId: conv.id };
      }
      if (pick.agentId && pick.agentId !== b.agent_id) target = this.botConversation(b, conv, pick.agentId, senderId);
      if (pick.explicit && !body && !(m.attachments || []).length) {
        const who = this.ctx.store.agent(pick.agentId || b.agent_id || '')?.name || 'het team';
        await this.reply(b, conv, `Je praat nu met ${who}. Stuur gewoon je bericht.`).catch(() => {});
        return { status: 'command', conversationId: target.id };
      }
      if (target.id !== conv.id) this.ctx.store.exec('UPDATE channel_msg_ids SET conversation_id = ? WHERE binding_id = ? AND external_id = ?', target.id, b.id, String(m.messageId).slice(0, 500));
    }
    // An address per bot (P10): mail to you+baas@… is a conversation with Baas. A mail thread keeps the bot it began
    // with; an unknown tag, or a bot of another team, goes to the channel's own bot (and the log says so).
    const plusTag = b.adapter === 'email' && b.config?.plusAddressing === true && typeof m.extra?.plusTag === 'string' ? m.extra.plusTag : '';
    if (plusTag && !target.thread_id && !target.meta?.agentId) {
      const bot = this.botForPlusTag(b, plusTag);
      if (bot) {
        this.ctx.store.update('channel_conversations', target.id, { meta: { ...target.meta, agentId: bot.id, agentName: bot.name } });
        target = this.conversation(target.id)!;
      } else this.log(b.id, 'in', 'ignored', `Geen bot met het plusadres +${plusTag}; naar de bot van dit kanaal`, extra);
    }
    const agentId = this.agentFor(b, target);

    const thread = this.ensureThread(b, def, target);
    const { refs, notes, transcripts } = await this.saveAttachments(b, thread, m.attachments || []);
    const content = [body, ...notes].filter(Boolean).join('\n\n') || (refs.length ? '' : '(leeg bericht)');
    const name = sender.label || m.sender.name || senderId;
    const isOwner = !!sender.is_owner && target.is_private && !target.meta?.unverified;
    // Routines with a chat-message trigger see the message first (as untrusted data); a trigger can keep the bot quiet.
    const trig = this.offerToRoutines(b, def, m, text, transcripts, { known: !stranger, isOwner, name, conversationId: target.id });
    let route = !target.paused && !!(agentId || b.room_id) && !trig.quiet;
    // Customer mode: someone who asks for a person gets one, without the bot in between.
    const cust = this.customerFor(b, target);
    const wantsHuman = !!cust?.handoff && route && humanRequested(body);
    if (wantsHuman) route = false;
    const level = this.accessFor(b, target, sender);
    // CLI engines (Claude Code, Codex, OpenCode …) bring their own tools, which the channel tool filter cannot cap.
    // Claude Code can be run without any tools (its "Alleen chat" mode), so "Alleen praten" works there; any other
    // combination is refused, and the owner is told why.
    let runMeta: Record<string, any> | null = null;
    let refusal: { engine: BotEngine; agentName: string } | null = null;
    if (route && agentId && level !== 'agent') {
      const engine = this.engineOf(agentId);
      if (engine?.type === 'cli') {
        if (level === 'none' && engine.levels.includes('none')) runMeta = { override: { access_mode: 'chat', tool_groups: [] } };
        else refusal = { engine, agentName: this.ctx.store.agent(agentId)?.name || 'De bot' };
      }
    }
    if (refusal) route = false;
    const msg = await this.ctx.chat.postUserMessage({
      thread,
      user: { id: `ext:${sender.id}`, name },
      authorType: 'external',
      authorName: `${name} (${def.label})`,
      content,
      attachments: refs,
      parts: {
        channel: {
          bindingId: b.id,
          adapter: b.adapter,
          adapterLabel: def.label,
          conversationId: target.id,
          senderId,
          senderName: m.sender.name || '',
          senderHandle: m.sender.handle || '',
          isOwner,
          private: target.is_private,
          conversationTitle: target.title,
          access: level,
          ...(refusal ? { refused: true } : {}),
          ...(trig.routines.length ? { routines: trig.routines, quiet: trig.quiet } : {}),
        },
      },
      route: route && !runMeta,
      trigger: 'channel',
    });
    // Without tools: the run gets Claude Code's chat mode as a per-run override (it can only narrow access).
    if (runMeta && agentId) this.ctx.chat.startAgent(thread, agentId, msg.id, 'channel', runMeta);
    this.log(b.id, 'in', 'message', preview(content || (refs.length === 1 ? '[1 bijlage]' : `[${refs.length} bijlagen]`)), extra);
    if (trig.routines.length) {
      const ev = `Dit bericht startte ${routineList(trig.routines)}.${trig.quiet ? ' De bot antwoordt hier niet: zo staat het bij de trigger.' : ''}`;
      this.ctx.chat.addEvent(thread, ev, { kind: 'channel_routine' });
      this.log(b.id, 'in', 'routine', ev, extra);
    }
    if (refusal) await this.refuseForEngine(b, def, thread, target, level, name, refusal, extra);
    if (route && agentId) {
      this.startTyping(b, target, thread);
      this.reactStart(b, target, thread, m.reactTo);
    }
    if (wantsHuman) await this.startHandoff(b, target, thread, { reason: 'De klant vraagt om een mens', question: body, name }).catch((e) => this.ctx.log.warn('[channels] handoff failed', e?.message));
    else if (target.paused)
      this.ctx.events.emit(b.user_id, 'notification', {
        title: target.meta?.handoff ? `${name} wacht op jouw antwoord (${def.label})` : `${name} via ${def.label}`,
        body: preview(content, 160),
        link: `#/t/${thread.id}`,
        kind: 'channel',
        ...(target.meta?.handoff ? { important: true } : {}),
      });
    return { status: 'ok', threadId: thread.id, conversationId: target.id, messageId: msg.id, ...(trig.routines.length ? { routines: trig.routines } : {}), ...(trig.quiet ? { quiet: true } : {}), ...(refusal ? { refused: true } : {}) };
  }

  /**
   * A CLI bot cannot be held to this sender's access level: nothing goes to the bot. The sender gets a short note, the
   * owner a clear explanation in the thread, in the log and as a notification (once a day per sender).
   */
  private async refuseForEngine(b: Binding, def: AdapterDef, thread: Thread, conv: Conversation, level: AccessLevel, name: string, r: { engine: BotEngine; agentName: string }, extra: { senderId: string; senderName?: string; conversationId: string }) {
    const why = refusalText(r.agentName, r.engine, level);
    this.ctx.chat.addEvent(thread, `Niet beantwoord. ${why.long}`, { kind: 'channel_blocked' });
    this.log(b.id, 'in', 'refused', `Niet beantwoord. ${why.short}`, extra);
    if (this.notifyLimiter.take(`cli:${b.id}:${extra.senderId}`))
      this.ctx.events.emit(b.user_id, 'notification', { title: `${name} kreeg geen antwoord via ${def.label}`, body: `${why.short} Open Toegang om dit te regelen.`, link: `#/m/channels/${b.id}`, kind: 'channel' });
    await this.reply(b, conv, 'Deze bot kan je via dit kanaal nu niet helpen.').catch(() => {});
  }

  /** The engine behind a bot and the access levels it really enforces for people who write through a channel. */
  engineOf(agentId: string | null | undefined): BotEngine | null {
    const a = agentId ? this.ctx.store.agent(agentId) : null;
    if (!a) return null;
    const pid = a.provider_id || this.ctx.store.getSetting<string | null>(a.user_id, 'defaultProvider', null);
    const cfg = this.ctx.providers.config(pid);
    const kind = cfg ? this.ctx.providers.kind(cfg.kind) : undefined;
    if (!cfg || !kind) return null;
    if (kind.type !== 'cli') return { type: 'api', kind: kind.id, label: kind.label, levels: [...ACCESS_LEVELS] };
    // TeamBot's tool filter cannot see a CLI's own tools. Claude Code can be started without any tools; "Alleen lezen"
    // cannot be held per sender on any CLI, and Codex / OpenCode / other ACP engines cannot run without tools at all.
    return { type: 'cli', kind: kind.id, label: kind.label, levels: kind.id === 'claude-code' ? ['none', 'agent'] : ['agent'] };
  }

  /** Offer a chat message to routine triggers (never e-mail: that has its own trigger). Untrusted data. */
  private offerToRoutines(b: Binding, def: AdapterDef, m: Inbound, text: string, transcripts: string[], o: { known: boolean; isOwner: boolean; name?: string; conversationId: string | null }): { quiet: boolean; routines: string[] } {
    if (b.adapter === 'email' || !this.chatListeners.size) return { quiet: false, routines: [] };
    const date = m.date && Number.isFinite(new Date(m.date).getTime()) ? new Date(m.date).toISOString() : now();
    return this.emitChat({
      userId: b.user_id,
      bindingId: b.id,
      bindingName: b.name,
      teamId: this.teams.teamOf(b),
      adapter: b.adapter,
      adapterLabel: def.label,
      messageId: String(m.messageId).slice(0, 500),
      conversationId: o.conversationId,
      conversationTitle: String(m.conversation.title || '').slice(0, 120),
      private: !!m.conversation.private,
      sender: { id: String(m.sender.id).slice(0, 200), name: String(o.name || m.sender.name || '').slice(0, 120), ...(m.sender.handle ? { handle: String(m.sender.handle).slice(0, 120) } : {}) },
      known: o.known,
      isOwner: o.isOwner,
      text: [text, ...transcripts].filter(Boolean).join('\n').slice(0, 20_000),
      attachments: (m.attachments || []).slice(0, 10).map((a) => ({ name: String(a.name || 'bestand').slice(0, 120), mime: String(a.mime || '').slice(0, 100) })),
      date,
    });
  }

  /** The bot that answers in a conversation: a bot the owner addressed by name, else the binding's bot. */
  agentFor(b: Binding, conv: Pick<Conversation, 'meta'>): string | null {
    const id = conv.meta?.agentId;
    if (id) {
      const a = this.ctx.store.agent(String(id));
      if (a && a.user_id === b.user_id && !a.archived) return a.id;
    }
    return b.agent_id;
  }

  /** The bots that have their own address on an e-mail channel with plus addressing (P10): this team's bots only. */
  botAddresses(b: Binding): { agentId: string; name: string; tag: string; address: string; own: boolean }[] {
    if (b.adapter !== 'email' || b.config?.plusAddressing !== true || !b.config?.address) return [];
    const bots = this.ctx.store.agents(b.user_id).filter((a) => !a.archived && this.teams.usable(a, b));
    const tags = botTags(bots, b.config.plusTags || {});
    return bots
      .filter((a) => tags.has(a.id))
      .map((a) => ({ agentId: a.id, name: a.name, tag: tags.get(a.id)!, address: plusAddress(b.config.address, tags.get(a.id)!)!, own: a.id === b.agent_id }))
      .filter((x) => !!x.address);
  }

  private botForPlusTag(b: Binding, tag: string): Agent | null {
    const hit = this.botAddresses(b).find((x) => x.tag === tag);
    return hit ? this.ctx.store.agent(hit.agentId) || null : null;
  }

  /** Which bot does the owner mean? Explicit name > reply to a bot message > the bot he addressed recently > default. */
  private pickBot(b: Binding, base: Conversation, text: string, replyToId?: string): { agentId: string | null; text: string; explicit: boolean } {
    const key = `${b.id}:${base.external_id}`;
    const bots = this.ctx.store.agents(b.user_id).filter((a) => !a.archived);
    const hit = matchBotName(text, bots);
    if (hit) {
      // A bot of another team is refused by the caller; it never becomes the bot this chat sticks to.
      const foreign = !this.teams.usable(bots.find((a) => a.id === hit.id)!, b);
      if (hit.id === b.agent_id || foreign) this.sticky.delete(key);
      else this.sticky.set(key, { agentId: hit.id, until: Date.now() + STICKY_MS });
      return { agentId: hit.id, text: hit.rest, explicit: true };
    }
    if (replyToId) {
      const row = this.ctx.store.one<any>('SELECT conversation_id FROM channel_msg_ids WHERE binding_id = ? AND external_id = ?', b.id, String(replyToId).slice(0, 500));
      const c = row?.conversation_id ? this.conversation(row.conversation_id) : null;
      if (c && c.binding_id === b.id && this.sameChat(c, base)) {
        const agentId = this.agentFor(b, c);
        if (agentId && agentId !== b.agent_id) this.sticky.set(key, { agentId, until: Date.now() + STICKY_MS });
        else this.sticky.delete(key);
        return { agentId, text, explicit: false };
      }
    }
    const st = this.sticky.get(key);
    if (st && st.until > Date.now() && bots.some((a) => a.id === st.agentId)) {
      st.until = Date.now() + STICKY_MS;
      return { agentId: st.agentId, text, explicit: false };
    }
    this.sticky.delete(key);
    return { agentId: null, text, explicit: false };
  }

  /** Conversation (own thread) for "this chat, but with bot X". Replies go to the same external chat. */
  private botConversation(b: Binding, base: Conversation, agentId: string, senderId: string): Conversation {
    const ext = `${base.external_id}#${agentId}`.slice(0, 300);
    const agent = this.ctx.store.agent(agentId);
    const title = `${base.title} · ${agent?.name || 'bot'}`.slice(0, 120);
    const meta = { ...base.meta, agentId, baseExternalId: base.external_id };
    const existing = this.conversationByExt(b.id, ext);
    if (existing) {
      this.ctx.store.update('channel_conversations', existing.id, { title, meta, last_sender_id: senderId, last_inbound_at: now() });
      return this.conversation(existing.id)!;
    }
    const c: Conversation = { ...base, id: newId('cv_'), external_id: ext, thread_id: null, title, meta, paused: false, last_sender_id: senderId, last_inbound_at: now(), last_outbound_at: null, created_at: now() };
    this.ctx.store.insert('channel_conversations', c);
    return c;
  }

  /** Two conversation rows that are the same external chat (a chat and its "with bot X" variants). */
  sameChat(a: Pick<Conversation, 'external_id' | 'meta' | 'binding_id'>, b: Pick<Conversation, 'external_id' | 'meta' | 'binding_id'>): boolean {
    if (a.binding_id !== b.binding_id) return false;
    return (a.meta?.baseExternalId || a.external_id) === (b.meta?.baseExternalId || b.external_id);
  }

  /** A chat and its "with bot X" variants. */
  private chatConversations(conv: Conversation): Conversation[] {
    return this.conversations(conv.binding_id).filter((c) => this.sameChat(c, conv));
  }

  private upsertConversation(b: Binding, m: Inbound, senderId: string): Conversation {
    const ext = String(m.conversation.id).slice(0, 300);
    const title = String(m.conversation.title || m.sender.name || ext).slice(0, 120);
    const existing = this.conversationByExt(b.id, ext);
    const meta = { ...(existing?.meta || {}), ...(m.extra || {}) };
    if (m.extra && 'unverified' in m.extra) meta.unverified = !!m.extra.unverified;
    if (existing) {
      this.ctx.store.update('channel_conversations', existing.id, { title, meta, last_sender_id: senderId, last_inbound_at: now() });
      return this.conversation(existing.id)!;
    }
    const c: Conversation = {
      id: newId('cv_'),
      binding_id: b.id,
      user_id: b.user_id,
      external_id: ext,
      thread_id: null,
      title,
      is_private: !!m.conversation.private,
      meta,
      paused: false,
      last_sender_id: senderId,
      last_inbound_at: now(),
      last_outbound_at: null,
      created_at: now(),
    };
    this.ctx.store.insert('channel_conversations', c);
    return c;
  }

  ensureThread(b: Binding, def: AdapterDef, conv: Conversation, fresh = false): Thread {
    let t = !fresh && conv.thread_id ? this.ctx.store.thread(conv.thread_id) : null;
    if (t && t.user_id !== b.user_id) t = null;
    if (t?.archived) t = this.ctx.store.updateThread(t.id, { archived: false });
    if (!t) {
      const agentId = this.agentFor(b, conv);
      const own = !!conv.meta?.agentId && agentId === conv.meta.agentId;
      t = this.ctx.store.createThread({
        user_id: b.user_id,
        agent_id: agentId,
        room_id: own ? null : b.room_id,
        kind: 'channel',
        title: `${def.label} · ${conv.title}`.slice(0, 120),
        meta: { channel: { bindingId: b.id, adapter: b.adapter, conversationId: conv.id, externalId: conv.external_id, title: conv.title, private: conv.is_private } },
      });
      this.ctx.store.update('channel_conversations', conv.id, { thread_id: t.id });
      conv.thread_id = t.id;
      this.ctx.events.emit(b.user_id, 'thread.updated', t);
    }
    return t;
  }

  /** Largest file (bytes) this binding may receive or send: the owner's setting, capped by the platform. */
  maxFileBytes(b: Binding): number {
    const platform = Number(this.def(b)?.maxFileMb) || 50;
    return Math.min(platform, 50, Math.max(1, Number(b.config.maxFileMb) || 20)) * 1024 * 1024;
  }

  private voiceTranscriber(): Transcriber | null {
    if (this.transcriber) return this.transcriber;
    const v = this.ctx.services.voice;
    if (typeof v?.transcribe !== 'function') return null;
    return async (o) => {
      const r = await v.transcribe(o.userId, o.data, o.mime, { agentId: o.agentId });
      return r?.text ? { text: String(r.text), engine: r.providerName || r.model } : null;
    };
  }

  /** Voice note → text, when an engine is available. null = no engine (or switched off), { error } = it failed. */
  private async transcribe(b: Binding, thread: Thread, data: Buffer, mime: string, name: string): Promise<{ text?: string; error?: string } | null> {
    if (b.config.transcribeVoice === false) return null;
    const fn = this.voiceTranscriber();
    if (!fn) return null;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 120_000);
    try {
      const r = await Promise.race([
        fn({ userId: b.user_id, agentId: thread.agent_id, data, mime, name, signal: ac.signal }),
        new Promise<never>((_, rej) => ac.signal.addEventListener('abort', () => rej(new Error('Uitschrijven duurde te lang')))),
      ]);
      const text = String(r?.text || '').trim();
      return text ? { text: text.slice(0, 8000) } : null;
    } catch (e: any) {
      if (e?.code === 'voice_no_stt') return null; // nothing configured: not an error
      return { error: this.cleanError(b, e).slice(0, 160) };
    } finally {
      clearTimeout(timer);
    }
  }

  private async saveAttachments(b: Binding, thread: Thread, list: InboundAttachment[]) {
    const maxBytes = this.maxFileBytes(b);
    const maxMb = Math.round(maxBytes / 1024 / 1024);
    const refs: { id: string; name: string; mime: string; size: number }[] = [];
    const notes: string[] = [];
    /** Voice notes in words (for routine triggers that match on text). */
    const transcripts: string[] = [];
    for (const a of list.slice(0, 10)) {
      const name = path.basename(String(a.name || 'bestand')).replace(/[^\w.\- ()]+/g, '_').slice(0, 120) || 'bestand';
      if (refs.length >= 5) {
        notes.push(`[bijlage “${name}” overgeslagen: maximaal 5 per bericht]`);
        continue;
      }
      if (a.size && a.size > maxBytes) {
        notes.push(`[bijlage “${name}” niet opgehaald: groter dan ${maxMb} MB]`);
        continue;
      }
      try {
        const buf = a.data ?? (a.fetch ? await a.fetch() : null);
        if (!buf) continue;
        if (buf.length > maxBytes) {
          notes.push(`[bijlage “${name}” niet opgehaald: groter dan ${maxMb} MB]`);
          continue;
        }
        const id = newId('att_');
        const dir = path.join(this.ctx.config.dataDir, 'attachments', b.user_id);
        fs.mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, id + path.extname(name).slice(0, 10));
        fs.writeFileSync(dest, buf);
        // WhatsApp/Telegram declare e.g. "audio/ogg; codecs=opus": keep the type, drop the parameters.
        const declared = String(a.mime || '').split(';')[0].trim().toLowerCase();
        const mime = /^[\w.+-]+\/[\w.+-]+$/.test(declared) ? declared : mimeOf(name);
        this.ctx.store.insert('attachments', { id, user_id: b.user_id, thread_id: thread.id, name, mime, size: buf.length, path: dest, created_at: now() });
        refs.push({ id, name, mime, size: buf.length });
        if (a.kind === 'voice') {
          const t = await this.transcribe(b, thread, buf, mime, name);
          if (t?.text) {
            notes.push(`[Spraakbericht, automatisch uitgeschreven (kan fouten bevatten): “${t.text}”]`);
            transcripts.push(t.text);
          }
          else notes.push(`[spraakbericht bijgevoegd: ${name}${t?.error ? ` — uitschrijven lukte niet: ${t.error}` : ''}]`);
        }
      } catch (e) {
        notes.push(`[bijlage “${name}” kon niet worden opgehaald]`);
        this.log(b.id, 'in', 'error', `Bijlage ophalen mislukt: ${this.cleanError(b, e)}`);
      }
    }
    return { refs, notes, transcripts };
  }

  private async handlePair(b: Binding, def: AdapterDef, m: Inbound, code: string): Promise<ReceiveResult> {
    const senderId = String(m.sender.id);
    const extra = { senderId, senderName: m.sender.name, conversationId: String(m.conversation.id) };
    const transient: Conversation = {
      id: '',
      binding_id: b.id,
      user_id: b.user_id,
      external_id: String(m.conversation.id),
      thread_id: null,
      title: m.conversation.title || m.sender.name,
      is_private: !!m.conversation.private,
      meta: m.extra || {},
      paused: false,
      last_sender_id: senderId,
      last_inbound_at: null,
      last_outbound_at: null,
      created_at: now(),
    };
    if (!this.pairLimiter.take(`${b.id}:${senderId}`)) {
      this.log(b.id, 'in', 'pair_failed', 'Te veel koppelpogingen', extra);
      return { status: 'rate_limited' };
    }
    const row = this.ctx.store.one<any>('SELECT * FROM channel_pair_codes WHERE code_hash = ? AND binding_id = ?', sha256(code), b.id);
    if (!row || row.used_at || row.expires_at < now()) {
      this.log(b.id, 'in', 'pair_failed', 'Ongeldige of verlopen koppelcode', extra);
      await this.reply(b, transient, 'Deze koppelcode is ongeldig of verlopen. Vraag de eigenaar om een nieuwe code.').catch(() => {});
      return { status: 'pair_failed' };
    }
    if (row.is_owner && (!m.conversation.private || m.extra?.unverified)) {
      this.log(b.id, 'in', 'pair_failed', 'Eigenaar-koppeling alleen in een privégesprek met geverifieerde afzender', extra);
      await this.reply(b, transient, 'Koppel je eigen account in een privégesprek met de bot.').catch(() => {});
      return { status: 'pair_failed' };
    }
    const label = String(row.label || m.sender.name || senderId).slice(0, 80);
    this.ctx.store.tx(() => {
      this.ctx.store.exec('UPDATE channel_pair_codes SET used_at = ?, used_by = ? WHERE id = ?', now(), senderId, row.id);
      this.ctx.store.insert('channel_senders', { id: newId('cs_'), binding_id: b.id, user_id: b.user_id, external_id: senderId, label, is_owner: !!row.is_owner, source: 'pair', created_at: now() });
    });
    this.ctx.audit(b.user_id, 'channels.sender_paired', { binding: b.id, adapter: b.adapter, sender: senderId, owner: !!row.is_owner }, b.agent_id);
    this.log(b.id, 'in', 'paired', `${label} gekoppeld${row.is_owner ? ' als eigenaar' : ''}`, extra);
    this.ctx.events.emit(b.user_id, 'channels.updated', this.view(b));
    this.ctx.events.emit(b.user_id, 'notification', { title: `Nieuw gekoppeld via ${def.label}`, body: `${label} kan nu met “${b.name}” praten.`, link: `#/m/channels/${b.id}`, kind: 'channel' });
    const conv = this.upsertConversation(b, m, senderId);
    const who = b.agent_id ? this.ctx.store.agent(b.agent_id)?.name || 'de bot' : 'het team';
    await this.reply(b, conv, `Gekoppeld! Je kunt nu met ${who} praten. Stuur gewoon een bericht (/help voor commando's).`).catch(() => {});
    return { status: 'paired', conversationId: conv.id };
  }

  private async handleCommand(b: Binding, conv: Conversation, sender: Sender, cmd: { name: string; arg: string }): Promise<boolean> {
    const def = this.def(b)!;
    const approve = APPROVE_CMDS[cmd.name];
    if (approve) {
      const [code, ...rest] = cmd.arg.split(/\s+/);
      if (!code || !/^[A-Za-z0-9]{4,12}$/.test(code)) return false;
      const p = this.ctx.store.one<any>('SELECT code FROM channel_approval_prompts WHERE code = ? AND binding_id = ?', code.toUpperCase(), b.id);
      if (!p) return false;
      const r = await this.resolvePrompt(b, conv, sender.external_id, code.toUpperCase(), approve === 'a' ? 'answer' : approve === 'y' ? 'approve' : 'deny', rest.join(' '));
      await this.reply(b, conv, r).catch(() => {});
      return true;
    }
    const who = b.agent_id ? this.ctx.store.agent(b.agent_id)?.name || 'de bot' : 'het team';
    const routing = !!def.botRouting && !!sender.is_owner && conv.is_private && !conv.meta?.unverified;
    const help = `Je praat met ${who} via TeamBot.\n${routing ? 'Een andere bot? Begin je bericht met @Naam of Naam: (bijv. “@Baas maak het dagrapport”).\n' : ''}Commando's:\n/nieuw — begin een nieuw gesprek\n/stop — stop waar de bot mee bezig is\n${routing ? '/bots — welke bots je kunt aanspreken\n' : ''}/help — deze uitleg`;
    const current = (): Conversation => {
      const st = this.sticky.get(`${b.id}:${conv.external_id}`);
      if (!routing || !st || st.until < Date.now()) return conv;
      return this.conversationByExt(b.id, `${conv.external_id}#${st.agentId}`.slice(0, 300)) || conv;
    };
    switch (cmd.name) {
      case 'bots': {
        if (!routing) return false;
        const bots = this.ctx.store.agents(b.user_id).filter((a) => !a.archived);
        const now_ = this.ctx.store.agent(this.agentFor(b, current()) || '')?.name || who;
        await this.reply(b, conv, `Je praat nu met ${now_}.\nAanspreken met @Naam:\n${bots.map((a) => `• ${a.name}${a.id === b.agent_id ? ' (standaard)' : ''}`).join('\n')}`).catch(() => {});
        return true;
      }
      case 'start':
      case 'help':
      case 'hulp':
        await this.reply(b, conv, cmd.name === 'start' ? `Hoi ${sender.label}! ${help}` : help).catch(() => {});
        return true;
      case 'stop': {
        let n = 0;
        for (const c of routing ? this.chatConversations(conv) : [conv]) if (c.thread_id) n += this.ctx.runs.cancelThread(c.thread_id, undefined, `Gestopt via ${def.label}`);
        await this.reply(b, conv, n ? 'Gestopt.' : 'Er liep niets.').catch(() => {});
        return true;
      }
      case 'nieuw':
      case 'new':
      case 'reset': {
        const c = current();
        if (c.thread_id) this.ctx.runs.cancelThread(c.thread_id, undefined, 'Nieuw gesprek gestart');
        this.ensureThread(b, def, c, true);
        await this.reply(b, conv, 'Nieuw gesprek gestart.').catch(() => {});
        return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------------------ outbound

  /** Short system reply (pairing, commands, approvals). Not stored as a bot message. */
  async reply(b: Binding, conv: Conversation, text: string, buttons?: Outbound['buttons']) {
    const rt = this.runtime(b.id);
    if (!rt) throw new ChannelError('Kanaal is niet verbonden');
    const ids = await this.enqueue(b.id, () => rt.send(conv, { text, buttons }));
    for (const id of ids) this.claim(b.id, id, 'out', conv.id || null);
    this.log(b.id, 'out', 'system', preview(text), { conversationId: conv.external_id });
    if (this.customerOn(b)) this.outboxInsert(b, conv, { kind: 'system', status: 'sent', text, ext_ids: ids, sent_at: now() });
    return ids;
  }

  private enqueue<T>(bindingId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.sendQueues.get(bindingId) || Promise.resolve();
    const p = prev.catch(() => {}).then(fn);
    this.sendQueues.set(
      bindingId,
      p.catch(() => {}).then(() => new Promise((r) => setTimeout(r, 250))),
    );
    return p;
  }

  /**
   * Send to an existing conversation (the bot's answer, an approval prompt or the owner's own text). On a channel in
   * customer mode every message is also kept in full in the outbox (the owner's record of what customers received).
   */
  async deliver(conv: Conversation, out: Outbound, rec: OutboxRec = {}): Promise<string[]> {
    const b = this.binding(conv.binding_id);
    if (!b) throw new ChannelError('Deze koppeling bestaat niet meer');
    const rt = this.runtime(b.id);
    const record = this.customerOn(b);
    const maxBytes = this.maxFileBytes(b);
    const files = (out.files || []).filter((f) => f.size <= maxBytes).slice(0, 10);
    if (!out.senderName) {
      const agentId = this.agentFor(b, conv);
      out = { ...out, senderName: (agentId && this.ctx.store.agent(agentId)?.name) || undefined };
    }
    const skipped = (out.files || []).length - files.length;
    const tooBig = skipped === 1 ? '(1 bestand is te groot om via dit kanaal te sturen; bekijk het in TeamBot.)' : `(${skipped} bestanden zijn te groot om via dit kanaal te sturen; bekijk ze in TeamBot.)`;
    const text = skipped ? `${out.text}\n\n${trUserText(this.ctx.store, b.user_id, tooBig)}`.trim() : out.text;
    const failed = (msg: string) => {
      if (!record) return;
      if (rec.rowId) this.ctx.store.update('channel_outbox', rec.rowId, { error: msg.slice(0, 500) });
      else this.outboxInsert(b, conv, { ...rec, status: 'failed', text, files: files.map(fileRef), error: msg.slice(0, 500) });
    };
    if (!rt) {
      const msg = `Kanaal “${b.name}” is niet verbonden`;
      failed(msg);
      throw new ChannelError(msg);
    }
    try {
      const ids = await this.enqueue(b.id, () => rt.send(conv, { ...out, text, files }));
      for (const id of ids) this.claim(b.id, id, 'out', conv.id);
      this.ctx.store.update('channel_conversations', conv.id, { last_outbound_at: now() });
      this.log(b.id, 'out', 'message', preview(text || (files.length === 1 ? '[1 bestand]' : `[${files.length} bestanden]`)), { conversationId: conv.external_id });
      if (record) {
        const sent = { status: 'sent', text, files: files.map(fileRef), ext_ids: ids, sent_at: now(), error: null };
        if (rec.rowId) this.ctx.store.update('channel_outbox', rec.rowId, sent);
        else this.outboxInsert(b, conv, { ...rec, ...sent });
      }
      return ids;
    } catch (e) {
      const msg = this.cleanError(b, e);
      this.log(b.id, 'out', 'error', `Versturen mislukt: ${msg}`, { conversationId: conv.external_id });
      failed(msg);
      throw new ChannelError(msg);
    }
  }

  /** New message to a (possibly new) recipient — only reachable through the approved channel_send tool. */
  async sendNew(b: Binding, target: string, out: Outbound): Promise<{ conversationId: string; ids: string[]; title: string }> {
    const rt = this.runtime(b.id);
    if (!rt) throw new ChannelError(`Kanaal “${b.name}” is niet verbonden`);
    const known = this.ctx.store.one<any>('SELECT * FROM channel_conversations WHERE binding_id = ? AND (id = ? OR external_id = ?)', b.id, target, target);
    if (known) {
      const conv = this.ctx.store.decode<Conversation>('channel_conversations', known);
      // A customer gets the AI label like with any reply (the owner already approved this exact text).
      const ids = this.customerFor(b, conv) ? await this.deliverCustomer(b, conv, out, { kind: 'send' }) : await this.deliver(conv, out, { kind: 'send' });
      return { conversationId: conv.id, ids, title: conv.title };
    }
    if (!rt.sendTo) throw new ChannelError('Dit kanaal kan geen nieuwe gesprekken beginnen; kies een bestaand gesprek.');
    const cust = readCustomer(b.config?.customer, b.adapter);
    const labeled = cust.enabled && cust.aiLabel && !this.sender(b.id, this.normalizeExternal(b, target))?.is_owner;
    if (labeled) out = { ...out, text: `🤖 ${trUser(this.ctx.store, b.user_id, cust.handoff ? TEXT.aiLabelHandoff : TEXT.aiLabel)}\n\n${out.text || ''}`.trim() };
    let r;
    try {
      r = await this.enqueue(b.id, () => rt.sendTo!(target, out));
    } catch (e) {
      const msg = this.cleanError(b, e);
      this.log(b.id, 'out', 'error', `Versturen mislukt: ${msg}`, { conversationId: target });
      throw new ChannelError(msg);
    }
    let conv = this.conversationByExt(b.id, r.conversationId);
    if (!conv) {
      conv = {
        id: newId('cv_'),
        binding_id: b.id,
        user_id: b.user_id,
        external_id: r.conversationId,
        thread_id: null,
        title: r.title.slice(0, 120),
        is_private: r.private,
        meta: r.extra || {},
        paused: false,
        last_sender_id: null,
        last_inbound_at: null,
        last_outbound_at: now(),
        created_at: now(),
      };
      this.ctx.store.insert('channel_conversations', conv);
    } else this.ctx.store.update('channel_conversations', conv.id, { last_outbound_at: now(), meta: { ...conv.meta, ...(r.extra || {}) } });
    if (labeled) this.ctx.store.update('channel_conversations', conv.id, { meta: { ...(this.conversation(conv.id)?.meta || {}), aiLabelAt: now() } });
    for (const id of r.ids) this.claim(b.id, id, 'out', conv.id);
    this.log(b.id, 'out', 'message', `Nieuw bericht naar ${r.title}: ${preview(out.text)}`, { conversationId: r.conversationId });
    if (cust.enabled) this.outboxInsert(b, conv, { kind: 'send', status: 'sent', text: out.text, files: (out.files || []).map(fileRef), ext_ids: r.ids, sent_at: now() });
    return { conversationId: conv.id, ids: r.ids, title: conv.title };
  }

  /** Should the result of this run go back to the external conversation? */
  shouldDeliver(thread: Thread, run: Run, conv: Conversation): boolean {
    return this.answersExternal(thread, run, conv) && !this.cliRunTooBroad(thread, run, conv);
  }

  /** Was this run an answer to someone outside (their message, or "Hervatten"/"Opnieuw" on it)? */
  private answersExternal(thread: Thread, run: Run, conv: Conversation): boolean {
    if (conv.paused) return false;
    const input = this.ctx.store.message(run.input_message_id);
    if (input?.thread_id === thread.id && input.author_type === 'external') return true;
    if (run.trigger === 'resume' || run.trigger === 'retry') {
      const last = this.ctx.store.one<any>("SELECT author_type FROM messages WHERE thread_id = ? AND role = 'user' AND deleted = 0 ORDER BY seq DESC LIMIT 1", thread.id);
      return last?.author_type === 'external' && (!conv.last_outbound_at || (!!conv.last_inbound_at && conv.last_outbound_at < conv.last_inbound_at));
    }
    return false;
  }

  /**
   * A CLI run with the bot's own tools on a message from someone who may not have those (e.g. "Opnieuw" pressed in
   * TeamBot on a refused message): its answer never goes out, because nothing capped what the CLI could read.
   */
  private cliRunTooBroad(thread: Thread, run: Run, conv: Conversation): boolean {
    const b = this.binding(conv.binding_id);
    // Like the routing rule in receive(): one bot per conversation (a group decides itself who answers).
    if (!b || thread.room_id) return false;
    if (this.accessFor(b, conv, this.sender(b.id, conv.last_sender_id)) === 'agent') return false;
    if (this.engineOf(run.agent_id)?.type !== 'cli') return false;
    return run.meta?.override?.access_mode !== 'chat' && this.ctx.store.agent(run.agent_id)?.access_mode !== 'chat';
  }

  /** Files the bot shared in this run (share_file and friends). */
  private runFiles(run: Run, userId: string): OutFile[] {
    return this.runFilesOf(run.id, userId);
  }

  runFilesOf(runId: string, userId: string): OutFile[] {
    const out: OutFile[] = [];
    for (const r of this.ctx.store.all<any>("SELECT parts FROM messages WHERE run_id = ? AND role IN ('tool','assistant') ORDER BY seq", runId)) {
      let parts: any = {};
      try {
        parts = JSON.parse(r.parts || '{}');
      } catch {
        /* ignore */
      }
      for (const ref of parts.attachments || []) {
        const a = this.ctx.store.get<any>('attachments', ref.id);
        if (a && a.user_id === userId && fs.existsSync(a.path)) out.push({ name: a.name, mime: a.mime, path: a.path, size: a.size });
      }
    }
    return out.slice(0, 10);
  }

  private markDelivery(thread: Thread, run: Run, patch: Record<string, any>) {
    const row = this.ctx.store.one<any>("SELECT id FROM messages WHERE run_id = ? AND role = 'assistant' AND content != '' ORDER BY seq DESC LIMIT 1", run.id);
    const m = row ? this.ctx.store.message(row.id) : null;
    if (!m) return;
    const upd = this.ctx.store.updateMessage(m.id, { parts: { ...m.parts, channelDelivery: patch } });
    this.ctx.chat.emitMessage(thread, upd, 'message.updated');
  }

  /** afterRun hook: send the bot's final answer back to the same conversation. */
  async onRunDone(agent: Agent, thread: Thread, run: Run, finalText: string) {
    if (thread.kind !== 'channel') return;
    const conv = this.conversationByThread(thread.id);
    if (!conv) return;
    this.handledRuns.add(run.id);
    this.stopTyping(thread.id);
    if (!this.answersExternal(thread, run, conv)) return;
    if (this.cliRunTooBroad(thread, run, conv)) {
      this.ctx.chat.addEvent(thread, `Dit antwoord is niet naar buiten gestuurd: ${agent.name} draaide met al zijn eigen tools, en deze afzender mag dat niet. Wil je het toch delen, gebruik dan “Zelf antwoorden”.`, { kind: 'channel_blocked' });
      return;
    }
    const files = this.runFiles(run, thread.user_id);
    const text = (finalText || '').trim();
    if (!text && !files.length) return;
    const b = this.binding(conv.binding_id);
    // Teams (package B4): only a bot of the channel's own team answers out through it (also in a group that lets
    // bots of other teams in). The answer stays in TeamBot, with the reason.
    const wall = b ? this.teams.refusal(agent, b) : null;
    if (wall) {
      this.ctx.chat.addEvent(thread, `Dit antwoord is niet naar buiten gestuurd. ${wall}`, { kind: 'channel_blocked' });
      this.log(b!.id, 'system', 'refused', `Antwoord van ${agent.name} niet verstuurd: ander team`, { conversationId: conv.external_id });
      return;
    }
    // Customer mode: the draft is checked before anything leaves (AI label, hand off, approved knowledge, approval).
    if (b && this.customerFor(b, conv)) {
      await this.customerReply(b, conv, thread, { run, messageId: this.runAnswerId(run), agentId: agent.id, agentName: agent.name, draft: text, files });
      return;
    }
    const label = this.def(b)?.label || 'kanaal';
    try {
      await this.deliver(conv, { text, files }, { kind: 'reply', runId: run.id, threadId: thread.id, agentId: agent.id });
      this.markDelivery(thread, run, { status: 'sent', adapter: b?.adapter, label, at: now() });
    } catch (e: any) {
      this.deliveryFailed(thread, run, b, e);
    }
  }

  private deliveryFailed(thread: Thread, run: Run | string | null, b: Binding | null, e: any) {
    const label = this.def(b)?.label || 'kanaal';
    const patch = { status: 'failed', adapter: b?.adapter, label, error: String(e?.message || e).slice(0, 300), at: now() };
    if (run && typeof run === 'object') this.markDelivery(thread, run, patch);
    else if (typeof run === 'string') this.markMessage(thread, run, patch);
    this.ctx.events.emit(thread.user_id, 'notification', { title: `Antwoord niet verstuurd via ${label}`, body: String(e?.message || e).slice(0, 200), link: `#/t/${thread.id}`, kind: 'channel' });
  }

  /** run.updated listener: stop typing; tell the sender politely when the bot failed. */
  async onRunUpdated(r: Run) {
    if (!r || !TERMINAL.has(r.status)) return;
    const thread = this.ctx.store.thread(r.thread_id);
    if (thread?.kind !== 'channel') return;
    if (!this.ctx.runs.activeRuns(thread.user_id).some((x) => x.thread_id === thread.id)) {
      this.stopTyping(thread.id);
      // the bot is done with everything in this conversation: done (or error) on the messages it got
      if (r.status !== 'interrupted') this.reactEnd(thread.id, r.status === 'done' ? 'done' : 'error');
    }
    if (r.status !== 'error' || this.handledRuns.has(r.id)) return;
    this.handledRuns.add(r.id);
    if (this.handledRuns.size > 2000) this.handledRuns = new Set([...this.handledRuns].slice(-500));
    const conv = this.conversationByThread(thread.id);
    const b = this.binding(conv?.binding_id);
    if (!conv || !b || !this.shouldDeliver(thread, r, conv)) return;
    // A customer whose question made the bot fail is not left with "sorry": a person takes over.
    const cust = this.customerFor(b, conv);
    if (cust?.handoff) return void (await this.startHandoff(b, conv, thread, { reason: 'De bot liep vast', question: this.questionFor(thread, r) }).catch(() => {}));
    if (b.config.errorReply === false) return;
    await this.deliver(conv, { text: trUser(this.ctx.store, b.user_id, 'Sorry, het lukte me nu niet om te antwoorden. Probeer het later nog eens.') }, { kind: 'system' }).catch(() => {});
  }

  /** The owner answers personally from TeamBot (take-over). A conversation handed off to him is his reply: released. */
  async ownerSend(conv: Conversation, u: Pick<User, 'id' | 'name'>, text: string) {
    const b = this.binding(conv.binding_id)!;
    const def = this.def(b)!;
    await this.deliver(conv, { text }, { kind: 'owner', decided_by: u.id });
    if (this.conversation(conv.id)?.meta?.handoff) this.releaseHandoff(conv.id, u.id, 'owner_replied');
    const thread = this.ensureThread(b, def, conv);
    const m = this.ctx.store.createMessage({
      thread_id: thread.id,
      role: 'user',
      author_type: 'user',
      author_id: u.id,
      author_name: u.name,
      content: text,
      parts: { channel: { outbound: true, adapter: b.adapter, adapterLabel: def.label, bindingId: b.id, conversationId: conv.id } },
    });
    this.ctx.chat.emitMessage(thread, m);
    this.ctx.audit(u.id, 'channels.owner_send', { binding: b.id, conversation: conv.id, adapter: b.adapter }, b.agent_id);
    return m;
  }

  // ------------------------------------------------------------------ customer mode

  /** Is customer mode on for this channel? (then every outgoing message is kept in full in the outbox) */
  customerOn(b: Binding): boolean {
    return readCustomer(b.config?.customer, b.adapter).enabled;
  }

  /** Customer mode settings for a conversation with someone other than the owner himself; null otherwise. */
  customerFor(b: Binding, conv: Conversation): CustomerConfig | null {
    const c = readCustomer(b.config?.customer, b.adapter);
    if (!c.enabled || this.isOwnerConversation(b, conv)) return null;
    return c;
  }

  /** May this stranger write? Only in a private chat on a channel in customer mode with an open door. */
  private openDoor(b: Binding, m: Inbound): boolean {
    const c = readCustomer(b.config?.customer, b.adapter);
    return c.enabled && c.open && !!m.conversation?.private;
  }

  /** The customer's message(s) a draft answers: their own words and numbers support the answer too. */
  questionFor(thread: Thread, run: Run | null): string {
    const input = run ? this.ctx.store.message(run.input_message_id) : null;
    const rows = this.ctx.store.all<any>("SELECT content FROM messages WHERE thread_id = ? AND role = 'user' AND author_type = 'external' AND deleted = 0 ORDER BY seq DESC LIMIT 3", thread.id);
    const parts = rows.map((r) => String(r.content || '')).reverse();
    if (input?.author_type === 'external' && input.thread_id === thread.id && !parts.includes(input.content)) parts.push(input.content);
    return parts.join('\n').slice(0, 8000);
  }

  /** The last answer message of a run (where the delivery status goes). */
  private runAnswerId(run: Run): string | null {
    return this.ctx.store.one<any>("SELECT id FROM messages WHERE run_id = ? AND role = 'assistant' AND content != '' ORDER BY seq DESC LIMIT 1", run.id)?.id || null;
  }

  private markMessage(thread: Thread, messageId: string | null, patch: Record<string, any>) {
    const m = messageId ? this.ctx.store.message(messageId) : null;
    if (!m || m.thread_id !== thread.id) return;
    const upd = this.ctx.store.updateMessage(m.id, { parts: { ...m.parts, channelDelivery: patch } });
    this.ctx.chat.emitMessage(thread, upd, 'message.updated');
  }

  outboxInsert(b: Binding, conv: Pick<Conversation, 'id' | 'external_id' | 'thread_id'> | null, row: OutboxRec & { status: string; text?: string | null; files?: any[]; ext_ids?: string[]; sent_at?: string | null; error?: string | null }): string {
    const id = newId('cob_');
    this.ctx.store.insert('channel_outbox', {
      id,
      user_id: b.user_id,
      binding_id: b.id,
      conversation_id: conv?.id || null,
      conversation_ext: conv?.external_id || null,
      thread_id: row.threadId ?? conv?.thread_id ?? null,
      run_id: row.runId ?? null,
      message_id: row.messageId ?? null,
      agent_id: row.agentId ?? null,
      kind: row.kind || 'message',
      status: row.status,
      question: row.question ? String(row.question).slice(0, 4000) : null,
      draft: row.draft ? String(row.draft).slice(0, 20_000) : null,
      text: row.text ?? null,
      reasons: row.reasons || [],
      files: row.files || [],
      ext_ids: row.ext_ids || [],
      edited: false,
      decided_by: row.decided_by ?? null,
      decided_at: row.decided_by ? now() : null,
      error: row.error ?? null,
      created_at: now(),
      sent_at: row.sent_at ?? null,
    });
    return id;
  }

  outboxRow(id: string): OutboxRow | null {
    return this.ctx.store.get<OutboxRow>('channel_outbox', id);
  }

  /**
   * A bot's draft to a customer: the gate. Hand off when it does not know or is not grounded in the approved
   * knowledge, hold for approval when it is about money or promises, otherwise send (with the AI label when due).
   */
  async customerReply(b: Binding, conv: Conversation, thread: Thread, o: { run: Run | null; messageId: string | null; agentId: string | null; agentName: string; draft: string; files: OutFile[] }): Promise<DraftVerdict['action'] | 'failed'> {
    const cust = this.customerFor(b, conv)!;
    const label = this.def(b)?.label || 'kanaal';
    const question = this.questionFor(thread, o.run);
    // What memory gave the bot about this customer in this turn (C1 …): backs numbers and citations, never policy.
    const customer: KnowledgeItem[] = (() => {
      try {
        return this.ctx.services.memory?.customerFacts?.(thread.id, o.run?.input_message_id ?? null) || [];
      } catch {
        return [];
      }
    })();
    const v = classifyDraft({ draft: o.draft, question, knowledge: this.knowledgeFor(b, cust), customer });
    const rec: OutboxRec = { kind: 'reply', runId: o.run?.id ?? null, messageId: o.messageId, threadId: thread.id, agentId: o.agentId, question, draft: o.draft, reasons: v.reasons };
    const mark = (patch: Record<string, any>) => (o.run ? this.markDelivery(thread, o.run, patch) : this.markMessage(thread, o.messageId, patch));
    if (v.action === 'handoff') {
      this.outboxInsert(b, conv, { ...rec, status: 'handoff', text: v.text });
      if (cust.handoff) {
        mark({ status: 'handoff', adapter: b.adapter, label, reason: v.reasons[0], at: now() });
        await this.startHandoff(b, conv, thread, { reason: v.reasons[0], question });
      } else {
        // Never invented: the draft is not sent. The customer gets an honest short answer instead.
        mark({ status: 'blocked', adapter: b.adapter, label, reason: v.reasons[0], at: now() });
        this.ctx.chat.addEvent(thread, `Niet verstuurd: ${v.reasons[0]}. De klant kreeg een kort bericht dat de bot dit niet kan beantwoorden.`, { kind: 'channel_blocked' });
        this.log(b.id, 'system', 'blocked_reply', `Antwoord niet verstuurd: ${v.reasons[0]}`, { conversationId: conv.external_id });
        await this.deliverCustomer(b, conv, { text: trUser(this.ctx.store, b.user_id, TEXT.noAnswer) }, { kind: 'system', threadId: thread.id }).catch(() => {});
      }
      return 'handoff';
    }
    if (v.action === 'hold' && cust.approveMoney) {
      this.holdReply(b, conv, thread, rec, v, o.files, mark);
      return 'hold';
    }
    try {
      await this.deliverCustomer(b, conv, { text: v.text, files: o.files }, rec);
      mark({ status: 'sent', adapter: b.adapter, label, at: now() });
      return 'send';
    } catch (e: any) {
      this.deliveryFailed(thread, o.run || o.messageId, b, e);
      return 'failed';
    }
  }

  /** Into "Wacht op jou": the exact text, why it waits, and an edit option. Nothing is sent until the owner says so. */
  private holdReply(b: Binding, conv: Conversation, thread: Thread | null, rec: OutboxRec, v: DraftVerdict, files: OutFile[], mark?: (p: Record<string, any>) => void): string {
    const id = this.outboxInsert(b, conv, { ...rec, status: 'held', text: v.text, files: files.map(fileRef) });
    const label = this.def(b)?.label || 'kanaal';
    mark?.({ status: 'held', outboxId: id, adapter: b.adapter, label, reasons: v.reasons, at: now() });
    const who = this.conversation(conv.id)?.title || conv.title;
    if (thread) this.ctx.chat.addEvent(thread, `Dit antwoord aan ${who} wacht op jouw goedkeuring (${v.reasons.join('; ')}). Je vindt het onder Wacht op jou; je kunt het daar ook aanpassen.`, { kind: 'channel_held', outboxId: id });
    this.log(b.id, 'system', 'held', `Wacht op goedkeuring: ${v.reasons.join('; ')}`, { conversationId: conv.external_id });
    this.ctx.audit(b.user_id, 'channels.reply_held', { binding: b.id, conversation: conv.id, outbox: id, reasons: v.reasons }, rec.agentId || b.agent_id);
    this.ctx.events.emit(b.user_id, 'notification', { title: `Antwoord aan ${who} wacht op jou`, body: `${v.reasons[0]}: “${preview(v.text, 140)}”`, link: '#/inbox', kind: 'channel', important: true });
    this.ctx.events.emit(b.user_id, 'channels.outbox', { id, status: 'held' });
    return id;
  }

  /** Send to a customer: the AI label goes first when it is due (first reply, or after a day of silence). */
  async deliverCustomer(b: Binding, conv: Conversation, out: Outbound, rec: OutboxRec = {}): Promise<string[]> {
    const cust = readCustomer(b.config?.customer, b.adapter);
    const fresh = this.conversation(conv.id) || conv;
    const at = fresh.meta?.aiLabelAt;
    const label = cust.enabled && cust.aiLabel && !this.isOwnerConversation(b, fresh) && (!at || Date.now() - Date.parse(at) > AI_LABEL_EVERY_MS);
    const text = label ? `🤖 ${trUser(this.ctx.store, b.user_id, cust.handoff ? TEXT.aiLabelHandoff : TEXT.aiLabel)}\n\n${out.text || ''}`.trim() : out.text;
    const ids = await this.deliver(fresh, { ...out, text }, rec);
    if (label && fresh.id) {
      const cur = this.conversation(fresh.id);
      if (cur) this.ctx.store.update('channel_conversations', cur.id, { meta: { ...cur.meta, aiLabelAt: now() } });
    }
    return ids;
  }

  private handoffText(b: Binding, cust: CustomerConfig): string {
    const store = this.ctx.store;
    if (cust.hours.enabled) {
      const tz = userTz(this.ctx, b.user_id);
      const locale = userLocale(store, b.user_id);
      if (isOpen(cust.hours, new Date(), tz)) return trUser(store, b.user_id, TEXT.handoffOpen, hoursSummary(cust.hours, locale));
      const next = nextOpening(cust.hours, new Date(), tz, locale);
      if (next) return trUser(store, b.user_id, TEXT.handoffClosed, next);
    }
    return trUser(store, b.user_id, TEXT.handoffPlain);
  }

  /**
   * Hand the conversation to the owner: the customer hears honestly that a person will reply (and when), the owner
   * gets the conversation, and the bot stays quiet in it until the owner replies or releases it.
   */
  async startHandoff(b: Binding, conv: Conversation, thread: Thread | null, o: { reason: string; question: string; name?: string }) {
    const cur = this.conversation(conv.id);
    if (!cur) return;
    const def = this.def(b);
    if (cur.meta?.handoff) {
      // Already with the owner (e.g. a second bot in a group): no second notice to the customer or the owner.
      this.log(b.id, 'system', 'handoff', `Al doorgezet naar jou: ${o.reason}`, { conversationId: cur.external_id });
      return;
    }
    this.ctx.store.update('channel_conversations', cur.id, { paused: true, meta: { ...cur.meta, handoff: { at: now(), reason: o.reason, question: preview(o.question || '', 300) } } });
    const t = thread || (cur.thread_id ? this.ctx.store.thread(cur.thread_id) : null);
    const who = o.name || cur.title;
    if (t) this.ctx.chat.addEvent(t, `Doorgezet naar jou: ${o.reason}. De bot antwoordt niet meer in dit gesprek tot jij antwoordt of het gesprek vrijgeeft.`, { kind: 'channel_handoff' });
    this.log(b.id, 'system', 'handoff', `Doorgezet naar jou: ${o.reason}`, { conversationId: cur.external_id });
    this.ctx.audit(b.user_id, 'channels.handoff', { binding: b.id, conversation: cur.id, reason: o.reason }, b.agent_id);
    this.ctx.events.emit(b.user_id, 'notification', {
      title: `Klantvraag voor jou via ${def?.label || 'kanaal'}`,
      body: `${who}: “${preview(o.question || '', 120)}” (${o.reason})`,
      link: t ? `#/t/${t.id}` : '#/inbox',
      kind: 'channel',
      important: true,
    });
    this.ctx.events.emit(b.user_id, 'channels.conversation', this.conversation(cur.id));
    this.ctx.events.emit(b.user_id, 'channels.outbox', { conversationId: cur.id, handoff: true });
    const cust = readCustomer(b.config?.customer, b.adapter);
    await this.deliverCustomer(b, this.conversation(cur.id)!, { text: this.handoffText(b, cust) }, { kind: 'handoff', question: o.question, threadId: t?.id ?? null }).catch((e) => this.ctx.log.warn('[channels] handoff notice failed', e?.message));
  }

  /** The owner replied or released the conversation: the bot answers again. */
  releaseHandoff(convId: string, userId: string, why: 'released' | 'owner_replied'): Conversation | null {
    const c = this.conversation(convId);
    if (!c) return null;
    const { handoff: _h, ...meta } = c.meta || {};
    this.ctx.store.update('channel_conversations', c.id, { paused: false, meta });
    const t = c.thread_id ? this.ctx.store.thread(c.thread_id) : null;
    if (t && _h) this.ctx.chat.addEvent(t, why === 'owner_replied' ? 'Je hebt zelf geantwoord: de bot antwoordt weer in dit gesprek.' : 'Gesprek vrijgegeven: de bot antwoordt weer.', { kind: 'channel_pause' });
    this.ctx.audit(userId, 'channels.handoff_released', { conversation: c.id, why }, this.binding(c.binding_id)?.agent_id);
    const upd = this.conversation(c.id)!;
    this.ctx.events.emit(c.user_id, 'channels.conversation', upd);
    this.ctx.events.emit(c.user_id, 'channels.outbox', { conversationId: c.id, handoff: false });
    return upd;
  }

  /** The owner approves a held reply (his edited text, if he changed it): only now is it sent. */
  async approveHeld(id: string, u: Pick<User, 'id' | 'name'>, editedText?: string | null): Promise<OutboxRow> {
    const row = this.outboxRow(id);
    if (!row || row.user_id !== u.id) throw new ChannelError('Antwoord niet gevonden');
    if (row.status !== 'held') throw new ChannelError('Dit antwoord is al afgehandeld');
    const b = this.binding(row.binding_id);
    const conv = this.conversation(row.conversation_id);
    if (!b || !conv) throw new ChannelError('Dit gesprek bestaat niet meer');
    const proposed = String(row.text || '');
    const finalText = typeof editedText === 'string' && editedText.trim() ? editedText.trim().slice(0, 20_000) : proposed;
    const edited = finalText !== proposed;
    // One decision only, also with two windows open.
    const claim = this.ctx.store.exec("UPDATE channel_outbox SET status = 'sending' WHERE id = ? AND status = 'held'", id);
    if (Number(claim.changes) !== 1) throw new ChannelError('Dit antwoord is al afgehandeld');
    const files: OutFile[] = (row.files || []).filter((f: any) => f?.path && fs.existsSync(f.path));
    try {
      await this.deliverCustomer(b, conv, { text: finalText, files }, { rowId: id });
    } catch (e: any) {
      this.ctx.store.update('channel_outbox', id, { status: 'held', error: String(e?.message || e).slice(0, 500) });
      this.ctx.events.emit(b.user_id, 'channels.outbox', { id, status: 'held' });
      throw e instanceof ChannelError ? e : new ChannelError(String(e?.message || e));
    }
    // deliver() filled in the sent text (with the AI label) while customer mode is on; if the owner switched it off in
    // the meantime, the row is completed here.
    const done = this.outboxRow(id);
    this.ctx.store.update('channel_outbox', id, { status: 'sent', text: done?.status === 'sent' ? done.text : finalText, sent_at: done?.sent_at || now(), edited, decided_by: u.id, decided_at: now() });
    const thread = row.thread_id ? this.ctx.store.thread(row.thread_id) : null;
    if (thread) {
      this.ctx.chat.addEvent(thread, edited ? `Na jouw goedkeuring verstuurd, met jouw aanpassing: “${preview(finalText, 300)}”` : 'Na jouw goedkeuring verstuurd.', { kind: 'channel_held', outboxId: id });
      this.markMessage(thread, row.message_id, { status: 'sent', adapter: b.adapter, label: this.def(b)?.label, approved: true, edited, at: now() });
    }
    this.log(b.id, 'system', 'approval', edited ? 'Aangepast antwoord verstuurd na jouw goedkeuring' : 'Antwoord verstuurd na jouw goedkeuring', { conversationId: conv.external_id });
    this.ctx.audit(u.id, 'channels.reply_approved', { binding: b.id, conversation: conv.id, outbox: id, edited }, row.agent_id || b.agent_id);
    this.ctx.events.emit(b.user_id, 'channels.outbox', { id, status: 'sent' });
    return this.outboxRow(id)!;
  }

  /** The owner does not want the bot's reply sent: the conversation becomes his (the customer hears a person will reply). */
  async rejectHeld(id: string, u: Pick<User, 'id' | 'name'>): Promise<OutboxRow> {
    const row = this.outboxRow(id);
    if (!row || row.user_id !== u.id) throw new ChannelError('Antwoord niet gevonden');
    const claim = this.ctx.store.exec("UPDATE channel_outbox SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'held'", u.id, now(), id);
    if (Number(claim.changes) !== 1) throw new ChannelError('Dit antwoord is al afgehandeld');
    const b = this.binding(row.binding_id);
    const conv = this.conversation(row.conversation_id);
    const thread = row.thread_id ? this.ctx.store.thread(row.thread_id) : null;
    if (thread) this.markMessage(thread, row.message_id, { status: 'rejected', adapter: b?.adapter, label: this.def(b)?.label, at: now() });
    this.ctx.audit(u.id, 'channels.reply_rejected', { binding: row.binding_id, conversation: row.conversation_id, outbox: id }, row.agent_id);
    if (b && conv) await this.startHandoff(b, conv, thread, { reason: 'Je hield het antwoord van de bot tegen', question: row.question || '' });
    this.ctx.events.emit(u.id, 'channels.outbox', { id, status: 'rejected' });
    return this.outboxRow(id)!;
  }

  /** "Wacht op jou": replies that wait for approval and conversations handed off to the owner. */
  inbox(userId: string) {
    const bindings = new Map(this.bindings(userId).map((b) => [b.id, b]));
    const name = (bid: string) => {
      const b = bindings.get(bid);
      // "Wacht op jou" shows every team's customers; each item says its team (package B4).
      const team = b ? this.teams.teamOf(b) : null;
      return { binding_name: b?.name || '', adapter: b?.adapter || '', adapter_label: this.def(b || null)?.label || b?.adapter || '', team_id: team, team_name: this.teams.teamName(team) };
    };
    const held = this.ctx.store
      .all<any>("SELECT * FROM channel_outbox WHERE user_id = ? AND status IN ('held','sending') ORDER BY created_at", userId)
      .map((r) => this.ctx.store.decode<OutboxRow>('channel_outbox', r))
      .map((r) => {
        const c = this.conversation(r.conversation_id);
        return { id: r.id, binding_id: r.binding_id, ...name(r.binding_id), conversation_id: r.conversation_id, conversation_title: c?.title || '', thread_id: r.thread_id || c?.thread_id || null, agent_id: r.agent_id, kind: r.kind, status: r.status, question: r.question, text: r.text, reasons: r.reasons, files: (r.files || []).map((f: any) => ({ name: f.name, size: f.size })), error: r.error, created_at: r.created_at };
      });
    const handoffs = this.ctx.store
      .all<any>("SELECT * FROM channel_conversations WHERE user_id = ? AND json_extract(meta, '$.handoff.at') IS NOT NULL ORDER BY json_extract(meta, '$.handoff.at')", userId)
      .map((r) => this.ctx.store.decode<Conversation>('channel_conversations', r))
      .filter((c) => bindings.has(c.binding_id))
      .map((c) => ({ conversation_id: c.id, binding_id: c.binding_id, ...name(c.binding_id), title: c.title, thread_id: c.thread_id, reason: c.meta.handoff.reason, question: c.meta.handoff.question, at: c.meta.handoff.at, last_inbound_at: c.last_inbound_at }));
    return { held, handoffs };
  }

  /** Everything that went to customers on this channel (full text), newest first. */
  outbox(bindingId: string, before?: string) {
    return this.ctx.store
      .all<any>('SELECT * FROM channel_outbox WHERE binding_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 100', bindingId, before || '9999')
      .map((r) => this.ctx.store.decode<OutboxRow>('channel_outbox', r))
      .map(({ files, ...r }) => ({ ...r, files: (files || []).map((f: any) => ({ name: f.name, size: f.size })) }));
  }

  /**
   * A message a routine wants to send to a customer conversation: same gate as a reply, but a routine has nobody to
   * hand off to, so anything that is not plainly fine waits for the owner.
   */
  async deliverRoutine(b: Binding, conv: Conversation, out: Outbound): Promise<string[]> {
    const cust = this.customerFor(b, conv);
    if (!cust) return this.deliver(conv, out, { kind: 'routine' });
    const v = classifyDraft({ draft: out.text, question: '', knowledge: this.knowledgeFor(b, cust) });
    if (v.action === 'send' || (v.action === 'hold' && !cust.approveMoney)) return this.deliverCustomer(b, conv, { ...out, text: v.text }, { kind: 'routine', draft: out.text, reasons: v.reasons });
    const thread = conv.thread_id ? this.ctx.store.thread(conv.thread_id) : null;
    this.holdReply(b, conv, thread, { kind: 'routine', draft: out.text, reasons: v.reasons, threadId: thread?.id ?? null }, v, out.files || []);
    throw new ChannelError(`Wacht op jouw goedkeuring onder Wacht op jou: ${v.reasons[0]}`);
  }

  /** channel_send to a customer in customer mode: must the owner see this exact text first? */
  customerSendNeedsApproval(b: Binding, to: string, text: string): boolean {
    const cust = readCustomer(b.config?.customer, b.adapter);
    if (!cust.enabled) return false;
    const t = this.classifyTarget(b, to);
    if (t.owner) return false;
    return classifyDraft({ draft: text, question: '', knowledge: this.knowledgeFor(b, cust) }).action !== 'send';
  }

  // ------------------------------------------------------------------ typing

  startTyping(b: Binding, conv: Conversation, thread: Thread) {
    const rt = this.runtime(b.id);
    const def = this.def(b);
    if (!rt?.typing || !def) return;
    this.stopTyping(thread.id);
    const fire = () => rt.typing!(conv).catch(() => {});
    fire();
    const every = def.typingEveryMs;
    if (!every) return;
    const until = Date.now() + 180_000;
    const timer = setInterval(() => {
      if (Date.now() > until || this.runtime(b.id) !== rt) return this.stopTyping(thread.id);
      fire();
    }, every);
    timer.unref?.();
    this.typingTimers.set(thread.id, timer);
  }

  stopTyping(threadId: string) {
    const t = this.typingTimers.get(threadId);
    if (t) clearInterval(t);
    this.typingTimers.delete(threadId);
  }

  // ------------------------------------------------------------------ status reactions

  /**
   * 👀 on a message the bot starts on (platforms with reactions, unless the channel switched them off). Remembered per
   * conversation until the bot is done there; then `reactEnd` puts done or error on each. A platform that refuses
   * (missing scope or permission, message gone) is ignored quietly: reactions are a courtesy, never a failure.
   */
  reactStart(b: Binding, conv: Conversation, thread: Thread, reactTo: string | undefined) {
    const rt = this.runtime(b.id);
    if (!reactTo || !rt?.react || b.config?.reactions === false || !this.def(b)?.reactions) return;
    rt.react(conv, reactTo, 'working').catch(() => {});
    const list = this.pendingReactions.get(thread.id) || [];
    list.push({ bindingId: b.id, convId: conv.id, reactTo });
    this.pendingReactions.set(thread.id, list.slice(-20));
  }

  reactEnd(threadId: string, status: ReactionStatus) {
    const list = this.pendingReactions.get(threadId);
    if (!list) return;
    this.pendingReactions.delete(threadId);
    for (const p of list) {
      const b = this.binding(p.bindingId);
      const rt = this.runtime(p.bindingId);
      const conv = this.conversation(p.convId);
      if (!b || !rt?.react || !conv || b.config?.reactions === false) continue;
      rt.react(conv, p.reactTo, status).catch(() => {});
    }
  }

  // ------------------------------------------------------------------ approvals via channel

  /** approval.created listener: offer buttons in the channel only to the verified owner, if enabled. */
  async onApprovalCreated(a: any) {
    if (!a?.thread_id || a.status !== 'pending') return;
    const thread = this.ctx.store.thread(a.thread_id);
    if (thread?.kind !== 'channel' || thread.user_id !== a.user_id) return;
    const conv = this.conversationByThread(thread.id);
    const b = this.binding(conv?.binding_id);
    const def = this.def(b);
    if (!conv || !b || !def || !b.enabled || !b.config.approveViaChannel || !def.approveViaChannel || !conv.is_private || conv.meta?.unverified) return;
    const sender = this.sender(b.id, conv.last_sender_id);
    if (!sender?.is_owner) return;
    const code = humanCode(6);
    this.ctx.store.insert('channel_approval_prompts', { code, approval_id: a.id, binding_id: b.id, conversation_id: conv.id, sender_id: sender.external_id, user_id: b.user_id, created_at: now(), used: 0 });
    const agent = this.ctx.store.agent(a.agent_id);
    // The owner reads this in the chat app: in their interface language (the commands stay as they are).
    const lang = userLanguage(this.ctx.store, b.user_id);
    const who = agent?.name || tr(lang, 'Je bot');
    const summary = trUserText(this.ctx.store, b.user_id, String(a.summary || ''));
    let text: string;
    let buttons: Outbound['buttons'];
    if (a.kind === 'question') {
      const opts: string[] = Array.isArray(a.options) ? a.options : [];
      text = `❓ ${tr(lang, '{0} vraagt: {1}', who, summary)}\n\n${tr(lang, 'Antwoord met: {0}', `/antwoord ${code} <${tr(lang, 'je antwoord')}>`)}`;
      buttons = opts.slice(0, 3).map((o, i) => ({ id: `apr:${code}:o${i}`, label: String(o).slice(0, 20) }));
    } else {
      const head = a.risk === 'danger' ? tr(lang, '{0} vraagt toestemming voor een actie met impact:', who) : tr(lang, '{0} vraagt toestemming:', who);
      text = `🔐 ${head}\n${summary}\n\n${tr(lang, 'Tik op een knop of antwoord met {0} of {1}.', `/ja ${code}`, `/nee ${code}`)}`;
      buttons = [
        { id: `apr:${code}:y`, label: tr(lang, 'Goedkeuren'), style: 'primary' },
        { id: `apr:${code}:n`, label: tr(lang, 'Weigeren'), style: 'danger' },
      ];
    }
    await this.deliver(conv, { text, buttons }).catch((e) => this.ctx.log.warn('[channels] approval prompt failed', e?.message));
  }

  onApprovalUpdated(a: any) {
    if (a?.id && a.status !== 'pending') this.ctx.store.exec('UPDATE channel_approval_prompts SET used = 1 WHERE approval_id = ?', a.id);
  }

  async handleAction(bindingId: string, a: { conversationId: string; senderId: string; actionId: string }): Promise<string | null> {
    const b = this.binding(bindingId);
    if (!b) return null;
    const m = String(a.actionId || '').match(/^apr:([A-Z0-9]{4,12}):(y|n|o\d)$/);
    if (!m) return null;
    const conv = this.conversationByExt(b.id, String(a.conversationId));
    if (!conv) return 'Onbekende of verlopen aanvraag.';
    // (resolvePrompt accepts a prompt from any "with bot X" variant of this chat)
    if (m[2] === 'y') return this.resolvePrompt(b, conv, String(a.senderId), m[1], 'approve');
    if (m[2] === 'n') return this.resolvePrompt(b, conv, String(a.senderId), m[1], 'deny');
    return this.resolvePrompt(b, conv, String(a.senderId), m[1], 'option', m[2].slice(1));
  }

  private async resolvePrompt(b: Binding, conv: Conversation, senderId: string, code: string, decision: 'approve' | 'deny' | 'answer' | 'option', answer = ''): Promise<string> {
    const p = this.ctx.store.one<any>('SELECT * FROM channel_approval_prompts WHERE code = ? AND binding_id = ?', code, b.id);
    const pc = p ? this.conversation(p.conversation_id) : null;
    if (!p || !pc || (pc.id !== conv.id && !this.sameChat(pc, conv)) || p.sender_id !== senderId) return 'Onbekende of verlopen aanvraag.';
    const sender = this.sender(b.id, senderId);
    if (!sender?.is_owner || !b.config.approveViaChannel || !conv.is_private || conv.meta?.unverified) return 'Goedkeuren via dit kanaal staat uit. Gebruik TeamBot.';
    if (p.used) return 'Deze aanvraag is al afgehandeld.';
    const appr = this.ctx.store.get<any>('approvals', p.approval_id);
    if (!appr || appr.user_id !== b.user_id) return 'Onbekende of verlopen aanvraag.';
    let d: 'approve' | 'deny' = decision === 'deny' ? 'deny' : 'approve';
    let ans: string | undefined;
    if (decision === 'option') ans = (Array.isArray(appr.options) ? appr.options : [])[Number(answer)] ?? undefined;
    if (decision === 'answer') {
      if (!answer.trim()) return 'Zet je antwoord achter de code.';
      ans = answer.trim().slice(0, 4000);
    }
    if (appr.kind === 'question' && d === 'approve' && ans === undefined) ans = 'ja';
    try {
      this.ctx.broker.resolve(p.approval_id, b.user_id, d, ans);
    } catch (e: any) {
      this.ctx.store.exec('UPDATE channel_approval_prompts SET used = 1 WHERE code = ?', code);
      return String(e?.message || 'Dit verzoek is al afgehandeld');
    }
    this.ctx.store.exec('UPDATE channel_approval_prompts SET used = 1 WHERE code = ?', code);
    this.ctx.audit(b.user_id, 'channels.approval_via_channel', { binding: b.id, adapter: b.adapter, approval: p.approval_id, decision: d, sender: senderId }, appr.agent_id);
    this.log(b.id, 'in', 'approval', `${d === 'approve' ? 'Goedgekeurd' : 'Geweigerd'} via kanaal: ${preview(appr.summary || '', 80)}`, { senderId, conversationId: conv.external_id });
    if (appr.kind === 'question') return 'Antwoord doorgegeven.';
    return d === 'approve' ? '✅ Goedgekeurd.' : '❌ Geweigerd.';
  }

  // ------------------------------------------------------------------ tools / prompt helpers

  /** Tool cap for channel threads (registered as a ToolRegistry filter). */
  filterTools(_agent: Agent, thread: Thread, tools: ToolDef[]): ToolDef[] {
    if (thread.kind !== 'channel') return tools;
    const conv = this.conversationByThread(thread.id);
    const b = this.binding(conv?.binding_id);
    if (!conv || !b) return [];
    const level = this.accessFor(b, conv, this.sender(b.id, conv.last_sender_id));
    if (level === 'none') return [];
    if (level === 'readonly') return tools.filter((t) => t.risk === 'read');
    return tools;
  }

  // ------------------------------------------------------------------ channel_send targets + "send without asking"

  /** Is this the owner's own verified private conversation? */
  isOwnerConversation(b: Binding, conv: Conversation): boolean {
    if (!conv.is_private || conv.meta?.unverified || conv.binding_id !== b.id) return false;
    return !!this.sender(b.id, conv.last_sender_id)?.is_owner || !!this.sender(b.id, conv.meta?.baseExternalId || conv.external_id)?.is_owner;
  }

  /** The owner's most recent own conversation on this binding (the plain chat, not a "with bot X" variant). */
  ownerConversation(b: Binding): Conversation | null {
    const list = this.conversations(b.id).filter((c) => this.isOwnerConversation(b, c));
    return list.find((c) => !c.meta?.agentId) || list[0] || null;
  }

  /** Normalize an address the way the allowlist stores it. */
  normalizeExternal(b: Binding, v: string): string {
    const t = String(v || '').trim().slice(0, 300);
    if (b.adapter === 'email') return t.toLowerCase();
    if ((b.adapter === 'whatsapp' || b.adapter === 'whatsapp-web') && /^\+?[\d\s().-]{8,20}$/.test(t)) return t.replace(/[^\d]/g, '');
    return t;
  }

  /** What does a channel_send `to` point at? */
  classifyTarget(b: Binding, to: string): { owner: boolean; ext: string; conv: Conversation | null } {
    const raw = String(to || '').trim();
    if (OWNER_TARGETS.has(raw.toLowerCase())) return { owner: true, ext: 'owner', conv: this.ownerConversation(b) };
    const ext = this.normalizeExternal(b, raw);
    const row = this.ctx.store.one<any>('SELECT * FROM channel_conversations WHERE binding_id = ? AND (id = ? OR external_id = ? OR external_id = ?)', b.id, raw, raw, ext);
    const conv = row ? this.ctx.store.decode<Conversation>('channel_conversations', row) : null;
    if (conv) return { owner: this.isOwnerConversation(b, conv), ext: conv.meta?.baseExternalId || conv.external_id, conv };
    return { owner: !!this.sender(b.id, ext)?.is_owner, ext, conv: null };
  }

  sendRules(agentId: string): { id: string; user_id: string; agent_id: string; binding_id: string | null; target: string; label: string; created_at: string }[] {
    return this.ctx.store.all<any>('SELECT * FROM channel_send_rules WHERE agent_id = ? ORDER BY created_at', agentId);
  }

  /** Did the owner allow this bot to send to this target without asking? ('owner' rules may cover all channels.) */
  sendAllowed(agentId: string, b: Binding, t: { owner: boolean; ext: string }): boolean {
    const target = t.owner ? 'owner' : t.ext;
    if (!target) return false;
    return !!this.ctx.store.one<any>(
      'SELECT id FROM channel_send_rules WHERE agent_id = ? AND user_id = ? AND target = ? AND (binding_id IS NULL OR binding_id = ?)',
      agentId,
      b.user_id,
      target,
      b.id,
    );
  }

  /** Message the owner himself on this binding: his own conversation, else a new private chat with his account. */
  async sendToOwner(b: Binding, out: Outbound): Promise<{ conversationId: string; ids: string[]; title: string }> {
    const conv = this.ownerConversation(b);
    if (conv) {
      const ids = await this.deliver(conv, out);
      return { conversationId: conv.id, ids, title: conv.title };
    }
    const owner = this.senders(b.id).find((x) => x.is_owner);
    if (!owner) throw new ChannelError(`Op “${b.name}” staat nog niemand als “Dit ben ik”. Koppel jezelf eerst (koppelcode “voor mezelf”).`);
    if (!this.runtime(b.id)?.sendTo) throw new ChannelError(`Nog geen gesprek met jou op “${b.name}”. Stuur de bot daar eerst zelf een bericht.`);
    return this.sendNew(b, owner.external_id, out);
  }

  /** Bindings a bot may use with channel_send/channel_list: only channels of its own team (package B4). */
  bindingsForAgent(agent: Agent, thread: Thread | null): Binding[] {
    // Linked-device channels (the owner's own WhatsApp) are shared by all his bots of that team: he addresses them by name.
    return this.bindings(agent.user_id).filter((b) => (b.agent_id === agent.id || (!!b.room_id && thread?.room_id === b.room_id) || (!!this.def(b)?.botRouting && b.enabled)) && this.teams.usable(agent, b));
  }

  /**
   * Channels of other teams this bot may look into (meekijken or aansturen on that team): shown read-only in
   * channel_list, never usable for sending or answering. Empty with one team.
   */
  readOnlyBindingsFor(agent: Agent, thread: Thread | null): Binding[] {
    const mine = new Set(this.bindingsForAgent(agent, thread).map((b) => b.id));
    return this.bindings(agent.user_id).filter((b) => !mine.has(b.id) && !this.teams.usable(agent, b) && this.teams.readable(agent, b));
  }

  // ------------------------------------------------------------------ e-mail trigger fan-out

  onEmail(cb: (e: EmailEvent) => void | Promise<void>): () => void {
    this.emailListeners.add(cb);
    return () => this.emailListeners.delete(cb);
  }

  private emitEmail(e: EmailEvent) {
    // The team of the mailbox (package B4): a routine only reacts to mail of its own team.
    const b = this.binding(e.bindingId);
    if (b && e.teamId === undefined) e = { ...e, teamId: this.teams.teamOf(b) };
    for (const cb of this.emailListeners) {
      try {
        Promise.resolve(cb(e)).catch((err) => this.ctx.log.warn('[channels] onEmail listener failed', err?.message));
      } catch (err: any) {
        this.ctx.log.warn('[channels] onEmail listener failed', err?.message);
      }
    }
  }

  /** Chat-message trigger for routines (every adapter except e-mail). Listeners answer synchronously. */
  onChatMessage(cb: (e: ChatMessageEvent) => ChatMessageResult | void): () => void {
    this.chatListeners.add(cb);
    return () => this.chatListeners.delete(cb);
  }

  private emitChat(e: ChatMessageEvent): { quiet: boolean; routines: string[] } {
    const out = { quiet: false, routines: [] as string[] };
    for (const cb of this.chatListeners) {
      try {
        const r = cb(e);
        if (!r || typeof (r as any).then === 'function') continue;
        if (r.quiet) out.quiet = true;
        for (const n of r.routines || []) if (!out.routines.includes(n)) out.routines.push(String(n).slice(0, 80));
      } catch (err: any) {
        this.ctx.log.warn('[channels] onChatMessage listener failed', err?.message);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ pairing codes

  createPairCode(b: Binding, o: { label?: string; owner?: boolean; minutes?: number }) {
    const code = humanCode(8);
    const minutes = Math.min(24 * 60, Math.max(5, Number(o.minutes) || 30));
    const row = {
      id: newId('cp_'),
      code_hash: sha256(code),
      binding_id: b.id,
      user_id: b.user_id,
      label: String(o.label || '').slice(0, 80),
      is_owner: !!o.owner,
      expires_at: new Date(Date.now() + minutes * 60_000).toISOString(),
      used_at: null,
      used_by: null,
      created_at: now(),
    };
    this.ctx.store.insert('channel_pair_codes', row);
    this.ctx.audit(b.user_id, 'channels.pair_code_created', { binding: b.id, owner: row.is_owner, minutes }, b.agent_id);
    const { code_hash: _h, ...safe } = row;
    return { ...safe, code };
  }
}

export type { Message };
