import type { Request, Response } from 'express';
import type { Role } from '../../core/types.js';
import type { HealthRecord } from './health.js';

/** What a sender may make the bot do through a channel. */
export type AccessLevel = 'none' | 'readonly' | 'agent';

export type BindingStatus = 'stopped' | 'connecting' | 'connected' | 'listening' | 'error';

/** A channel binding: (user, bot or room, adapter, settings, secret references, allowlist). */
export interface Binding {
  id: string;
  user_id: string;
  adapter: string;
  name: string;
  agent_id: string | null;
  room_id: string | null;
  /** Non-secret settings (hosts, modes, toggles). */
  config: Record<string, any>;
  /** field -> secret id in the core `secrets` table. Values never leave the server. */
  secret_ids: Record<string, string>;
  /** Runtime state (poll offsets, last UID, bot username). */
  state: Record<string, any>;
  enabled: boolean;
  status: BindingStatus;
  last_error: string | null;
  last_ok_at: string | null;
  /** Proof that messages really arrive and leave (health.ts); "verbonden" only with both. */
  health?: HealthRecord | null;
  /** The team this channel belongs to: that of its bot or group (0.4, package B4; null only without any team). */
  team_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Sender {
  id: string;
  binding_id: string;
  user_id: string;
  external_id: string;
  label: string;
  is_owner: boolean;
  /** 'customer' = not on the allowlist: a stranger in a private chat on a channel in customer mode (never stored). */
  source: 'manual' | 'pair' | 'log' | 'customer';
  created_at: string;
}

export interface Conversation {
  id: string;
  binding_id: string;
  user_id: string;
  external_id: string;
  thread_id: string | null;
  title: string;
  is_private: boolean;
  meta: Record<string, any>;
  paused: boolean;
  last_sender_id: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  created_at: string;
}

export interface InboundAttachment {
  name: string;
  mime: string;
  size?: number;
  kind?: 'image' | 'voice' | 'audio' | 'video' | 'file';
  data?: Buffer;
  fetch?: () => Promise<Buffer>;
}

/** A normalized inbound message produced by an adapter. */
export interface Inbound {
  /** Unique per binding; used for dedupe/idempotency (retries, replays). */
  messageId: string;
  conversation: { id: string; title?: string; private: boolean };
  sender: { id: string; name: string; handle?: string };
  text: string;
  attachments?: InboundAttachment[];
  /** Epoch ms of the original message, if known. */
  date?: number;
  /** External id (as claimed in channel_msg_ids) of the message this one replies to, if the platform says so. */
  replyToId?: string;
  /** What the adapter needs to put a status reaction on this message (its own format; adapters with `react`). */
  reactTo?: string;
  /** Adapter data needed to answer (stored in conversation meta, never secrets). */
  extra?: Record<string, any>;
}

export interface OutFile {
  name: string;
  mime: string;
  path: string;
  size: number;
}

export interface OutButton {
  id: string;
  label: string;
  style?: 'primary' | 'danger';
}

/** A status reaction: the bot started on a message, finished it, or got stuck. */
export type ReactionStatus = 'working' | 'done' | 'error';

/** The emoji per status for platforms without a fixed list (Telegram has its own: 👀 👍 😢). */
export const REACTION_EMOJI: Record<ReactionStatus, string> = { working: '👀', done: '✅', error: '❌' };

export interface Outbound {
  text: string;
  files?: OutFile[];
  /** Name of the bot that speaks (adapters where every message looks like the owner, e.g. WhatsApp's own chat). */
  senderName?: string;
  /** Interactive buttons (approval prompts). Adapters without buttons show the text command instead. */
  buttons?: OutButton[];
  /** Email only: subject for a new conversation. */
  subject?: string;
}

export interface ReceiveResult {
  status: 'ok' | 'duplicate' | 'blocked' | 'rate_limited' | 'command' | 'paired' | 'pair_failed' | 'disabled' | 'invalid';
  threadId?: string;
  conversationId?: string;
  messageId?: string;
  /** Routines this message started (chat-message trigger). */
  routines?: string[];
  /** A routine trigger said the bot should not answer this message. */
  quiet?: boolean;
  /** The bot did not get the message: its engine cannot be held to the sender's access level (CLI engines). */
  refused?: boolean;
}

/** What an adapter gets from the framework. */
export interface AdapterContext {
  bindingId: string;
  binding(): Binding;
  secret(field: string): string | null;
  /** Store a server-generated secret (e.g. a webhook token we hand to the platform). */
  storeSecret(field: string, value: string): void;
  /** Hand an inbound message to the framework (allowlist, dedupe, threads, routing). */
  receive(msg: Inbound): Promise<ReceiveResult>;
  /** A button press / callback from the platform. Returns a short confirmation text (or null when ignored). */
  action(a: { conversationId: string; senderId: string; actionId: string }): Promise<string | null>;
  /** Is this external sender on the allowlist? */
  isAllowed(externalId: string): boolean;
  /** Look up which conversation an email Message-ID belongs to (threading). */
  conversationForMessageIds(ids: string[]): string | null;
  setState(patch: Record<string, any>): void;
  /** Report a status change (e.g. reconnected). */
  status(s: BindingStatus, detail?: string | null): void;
  /** Report a broken connection; the framework reconnects with backoff unless `fatal`. */
  fail(e: any, fatal?: boolean): void;
  log(direction: 'in' | 'out' | 'system', kind: string, summary: string, extra?: { senderId?: string; senderName?: string; conversationId?: string }): void;
  /** Public base URL (TEAMBOT_PUBLIC_URL or the binding override), '' if none. */
  publicBaseUrl(): string;
  /** Full public webhook URL for this binding and route kind, '' if no public URL is known. */
  webhookUrl(kind: string): string;
  ownerRole(): Role;
  /** Private directory of this binding inside the data dir (created on demand; removed with the binding). */
  storageDir(): string;
  /** Push a live update to the owner's apps as event `channels.<kind>` ({ id: bindingId, ...data }). */
  notify(kind: string, data: Record<string, any>): void;
  /** Put the owner's own account on the allowlist as "Dit ben ik" (linked-device channels). */
  ensureOwnerSender(externalId: string, label: string): void;
  signal: AbortSignal;
  /** Email trigger fan-out to the routines module. */
  emitEmail?(e: EmailEvent): void;
}

export interface AdapterRuntime {
  /** Connect (resolves when ready; background loops report problems via ctx.fail). */
  start(): Promise<BindingStatus | void>;
  stop(): Promise<void>;
  /** Send into an existing conversation. Returns the external message ids. */
  send(conv: Conversation, out: Outbound): Promise<string[]>;
  /** Start a conversation with a new recipient (only via the approved channel_send tool). */
  sendTo?(target: string, out: Outbound): Promise<{ conversationId: string; title: string; private: boolean; ids: string[]; extra?: Record<string, any> }>;
  typing?(conv: Conversation): Promise<void>;
  /**
   * Status reaction on an incoming message (`Inbound.reactTo`): 👀 while the bot works ('working'), then 'done' or
   * 'error' (each platform picks emoji it allows). Failures are ignored by the framework (no scope, message gone …).
   */
  react?(conv: Conversation, reactTo: string, status: ReactionStatus): Promise<void>;
  /** Public webhook (raw body in req.body as Buffer). */
  webhook?(kind: string, req: Request, res: Response): Promise<void>;
  /** Linked-device channels: pairing state for the UI (QR, code, linked account). */
  linkState?(): Record<string, any>;
  /** Linked-device channels: link with a phone number instead of a QR code. */
  requestPairingCode?(phone: string): Promise<string>;
  /** Linked-device channels: unlink the device and wipe the session. */
  logout?(): Promise<void>;
  /** Why receiving does not work, as far as the platform tells us (e.g. Telegram's webhook error); null = unknown. */
  diagnose?(): Promise<string | null>;
}

export interface TestResult {
  ok: boolean;
  detail: string;
  /** Safe, non-secret info to keep in state (bot username, app id ...). */
  info?: Record<string, any>;
}

export interface SecretField {
  key: string;
  label: string;
  required: boolean | ((config: Record<string, any>) => boolean);
}

export interface AdapterDef {
  id: string;
  label: string;
  description: string;
  /** Does the adapter need a public HTTPS URL for the given config? */
  needsPublicUrl(config: Record<string, any>): boolean;
  /** Can the owner approve actions from within this channel (buttons or commands)? */
  approveViaChannel: boolean;
  /** Max characters of one outbound message. */
  maxText: number;
  /** Repeat the typing indicator every N ms while the bot works (0/undefined = once). */
  typingEveryMs?: number;
  /** The platform has status reactions (the runtime implements `react`); shows the on/off switch for them. */
  reactions?: boolean;
  secretFields: SecretField[];
  /** Webhook route kinds served under /api/public/hooks/channels/<binding>/<kind>. */
  webhookKinds?: string[];
  /** Secrets the adapter generates and stores itself (never settable through the API, never shown). */
  internalSecrets?: string[];
  /** The owner may address another bot by name in a message ("@Baas …", "Baas: …"); replies say who speaks. */
  botRouting?: boolean;
  /** Largest file the platform accepts (MB); the binding's own limit can only be lower. */
  maxFileMb?: number;
  /** Normalize/validate non-secret config; throw `bad()` with a Dutch message. `isNew` = the binding is being created. */
  validate(config: Record<string, any>, o: { role: Role; secrets: Record<string, boolean>; isNew?: boolean }): Promise<Record<string, any>> | Record<string, any>;
  /**
   * The most likely reasons a test message did not arrive, in plain Dutch (shown when the receive test times out and
   * the platform itself gives no reason).
   */
  receiveHint?(o: { config: Record<string, any>; info: Record<string, any>; platformAt: string | null; webhookUrl: string }): string;
  /** Validate a secret value when it is set (format checks only). */
  validateSecret?(key: string, value: string): string | null;
  create(ctx: AdapterContext): AdapterRuntime;
  test(ctx: AdapterContext): Promise<TestResult>;
}

/** Payload for `ctx.services.channels.onEmail(cb)` — untrusted external data. */
export interface EmailEvent {
  userId: string;
  bindingId: string;
  bindingName: string;
  /** The team the channel belongs to (0.4, package B4; null without teams): routines of other teams ignore it. */
  teamId?: string | null;
  messageId: string;
  from: { address: string; name: string };
  to: string[];
  subject: string;
  text: string;
  date: string;
  attachments: { name: string; mime: string; size: number }[];
  /** SPF/DKIM/DMARC passed according to the receiving server (Authentication-Results). */
  authenticated: boolean;
  /** Sender is on the binding's allowlist. */
  allowed: boolean;
  /** Auto-reply, bounce or mailing list. */
  automated: boolean;
}

/**
 * A chat message that came in on a channel (not e-mail: that has its own event), for routine triggers.
 * Offered after dedupe, rate limits and pairing, before the bot answers. Text and names are UNTRUSTED data;
 * `known`/`isOwner` are TeamBot's own verdict (allowlist / verified owner in a private chat).
 */
export interface ChatMessageEvent {
  userId: string;
  bindingId: string;
  bindingName: string;
  /** The team the channel belongs to (0.4, package B4; null without teams): routines of other teams ignore it. */
  teamId?: string | null;
  adapter: string;
  adapterLabel: string;
  /** The platform's message id (unique per binding: dedupe key). */
  messageId: string;
  /** TeamBot conversation id; null for a sender who is not on the allowlist (no conversation is made). */
  conversationId: string | null;
  conversationTitle: string;
  private: boolean;
  sender: { id: string; name: string; handle?: string };
  /** On the allowlist (added by hand or with a pairing code). */
  known: boolean;
  /** Verified owner in a private chat. */
  isOwner: boolean;
  text: string;
  attachments: { name: string; mime: string }[];
  date: string;
}

/** What a listener did with a chat message: the routines it started, and whether the bot should not answer. */
export interface ChatMessageResult {
  routines?: string[];
  quiet?: boolean;
}

/** What a bot's engine can be held to when someone else writes through a channel. */
export interface BotEngine {
  type: 'api' | 'cli';
  kind: string;
  label: string;
  /** Access levels this engine really enforces for channel senders. */
  levels: AccessLevel[];
}

/**
 * Speech-to-text for voice notes that arrive through a channel. Returns null when no engine is available
 * (nothing configured); throws on a real failure. Plugged in via `ctx.services.channels.setTranscriber(fn)`;
 * without one the voice module's `transcribe` is used when it is configured.
 */
export type Transcriber = (o: { userId: string; agentId: string | null; data: Buffer; mime: string; name: string; signal?: AbortSignal }) => Promise<{ text: string; engine?: string } | null>;

export class ChannelError extends Error {
  constructor(message: string, public fatal = false, public retryAfterMs = 0) {
    super(message);
  }
}
