import fs from 'node:fs';
import { bad } from '../../../core/http.js';
import { splitMessage, toPlain, toTelegramMarkdownV2 } from '../format.js';
import { checkApiBase, fetchBuffer, fetchT, netReason } from '../net.js';
import { randomToken, safeEqual } from '../security.js';
import { ChannelError, type AdapterContext, type AdapterDef, type AdapterRuntime, type Conversation, type Inbound, type InboundAttachment, type Outbound, type ReactionStatus } from '../types.js';

export const TELEGRAM_API = 'https://api.telegram.org';
const MAX_TEXT = 4096;
const GET_FILE_LIMIT = 20 * 1024 * 1024; // Bot API getFile limit on the public server
const ALLOWED_UPDATES = ['message', 'callback_query'];

class TgError extends ChannelError {
  constructor(message: string, public code: number, fatal: boolean, retryAfterMs = 0) {
    super(message, fatal, retryAfterMs);
  }
}

function client(ctx: AdapterContext) {
  const base = () => String(ctx.binding().config.apiBase || TELEGRAM_API).replace(/\/+$/, '');
  const token = () => {
    const t = ctx.secret('token');
    if (!t) throw new ChannelError('Bot-token ontbreekt', true);
    return t;
  };
  async function call<T = any>(method: string, params: Record<string, any> | FormData = {}, o: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const isForm = params instanceof FormData;
      let res: Response;
      try {
        res = await fetchT(`${base()}/bot${token()}/${method}`, {
          method: 'POST',
          headers: isForm ? {} : { 'content-type': 'application/json' },
          body: isForm ? params : JSON.stringify(params),
          timeoutMs: o.timeoutMs ?? 30_000,
          signal: o.signal ?? ctx.signal,
        });
      } catch (e: any) {
        if (o.signal?.aborted || ctx.signal.aborted) throw e;
        throw new ChannelError(`Telegram niet bereikbaar: ${netReason(e) || e?.cause?.code || e?.message || e}`);
      }
      const j: any = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
      if (j.ok) return j.result as T;
      const code = Number(j.error_code || res.status);
      const retry = Number(j.parameters?.retry_after || 0) * 1000;
      if (code === 429 && retry && retry <= 30_000 && attempt < 2) {
        await new Promise((r) => setTimeout(r, retry));
        continue;
      }
      const fatal = code === 401 || code === 404;
      const msg = fatal ? 'Telegram weigert de bot-token (ongeldig of ingetrokken). Maak een nieuwe token via @BotFather.' : code === 409 ? 'Conflict: een andere app gebruikt deze bot-token al (of er staat nog een webhook).' : `Telegram: ${j.description || 'fout ' + code}`;
      throw new TgError(msg, code, fatal, retry);
    }
  }
  return { call, base, token };
}

/** Telegram Bot API adapter (long polling by default, webhook optional). */
export const telegramAdapter: AdapterDef & { typingEveryMs: number } = {
  id: 'telegram',
  label: 'Telegram',
  description: 'Chat met je bot in Telegram. Werkt zonder publieke URL (long polling).',
  needsPublicUrl: (c) => c.mode === 'webhook',
  approveViaChannel: true,
  maxText: MAX_TEXT,
  typingEveryMs: 4500,
  // Telegram only allows a fixed set of reaction emoji: 👀, then 👍 or 😢
  reactions: true,
  webhookKinds: ['telegram'],
  secretFields: [{ key: 'token', label: 'Bot-token van @BotFather', required: true }],
  validateSecret(key, v) {
    if (key === 'token' && !/^\d{5,16}:[A-Za-z0-9_-]{30,64}$/.test(v.trim())) return 'Dit lijkt geen Telegram-bot-token (vorm: 123456789:ABC…).';
    return null;
  },
  async validate(c, o) {
    return {
      mode: c.mode === 'webhook' ? 'webhook' : 'polling',
      allowGroups: !!c.allowGroups,
      apiBase: await checkApiBase(c.apiBase, o.role, TELEGRAM_API).catch((e) => {
        throw bad(`API-adres: ${e.message}`);
      }),
    };
  },
  async test(ctx) {
    const me = await client(ctx).call('getMe', {}, { signal: ctx.signal, timeoutMs: 15_000 });
    // The token works; whether messages arrive is the receive test's job (no "verbonden" from a token alone).
    return { ok: true, detail: `Token werkt: dit is @${me.username}.`, info: { botUsername: me.username, botName: me.first_name, botId: me.id } };
  },
  receiveHint({ config, info }) {
    const bot = info.botUsername ? `@${info.botUsername}` : 'je bot';
    if (config.mode === 'webhook') return `Telegram stuurde niets naar je webhook. Controleer of het publieke adres echt naar deze computer leidt (tunnel aan?).`;
    return `Stuurde je het bericht in Telegram naar ${bot}? Gebruikt een ander programma dezelfde token (bijvoorbeeld een andere TeamBot), dan krijgt dat programma de berichten: maak dan bij @BotFather een eigen bot voor deze koppeling.`;
  },
  create(ctx) {
    return new TelegramRuntime(ctx);
  },
};

class TelegramRuntime implements AdapterRuntime {
  private api;
  private stopped = false;
  private me: { id: number; username: string } | null = null;
  constructor(private ctx: AdapterContext) {
    this.api = client(ctx);
  }

  async start() {
    const me = await this.api.call('getMe', {}, { timeoutMs: 15_000 });
    this.me = { id: me.id, username: me.username };
    const cur = this.ctx.binding();
    this.ctx.setState({ info: { ...(cur.state?.info || {}), botUsername: me.username, botName: me.first_name, botId: me.id } });
    if (cur.config.mode === 'webhook') {
      const url = this.ctx.webhookUrl('telegram');
      if (!/^https:\/\//.test(url)) throw new ChannelError('Webhookmodus vereist een publieke HTTPS-URL (TEAMBOT_PUBLIC_URL of “Publieke URL” bij deze koppeling). Gebruik anders long polling.', true);
      let secret = this.ctx.secret('webhookSecret');
      if (!secret) {
        secret = randomToken(32).replace(/[^A-Za-z0-9_-]/g, '');
        this.ctx.storeSecret('webhookSecret', secret);
      }
      await this.api.call('setWebhook', { url, secret_token: secret, allowed_updates: ALLOWED_UPDATES, drop_pending_updates: false });
      return 'listening' as const;
    }
    await this.api.call('deleteWebhook', { drop_pending_updates: false });
    void this.loop();
    return 'connected' as const;
  }

  async stop() {
    this.stopped = true;
  }

  /** Webhook mode: Telegram itself says why it could not deliver (getWebhookInfo). */
  async diagnose(): Promise<string | null> {
    if (this.ctx.binding().config.mode !== 'webhook') return null;
    const info: any = await this.api.call('getWebhookInfo', {}, { timeoutMs: 15_000 });
    if (!info?.url) return 'Telegram heeft geen webhook-adres voor deze bot. Verbind de koppeling opnieuw.';
    if (info.last_error_message) return `Telegram kan je webhook niet bereiken: ${info.last_error_message}.${info.pending_update_count ? ` Er wachten ${info.pending_update_count} berichten bij Telegram.` : ''}`;
    return null;
  }

  private async loop() {
    while (!this.stopped && !this.ctx.signal.aborted) {
      try {
        const offset = Number(this.ctx.binding().state?.offset || 0) || undefined;
        const updates: any[] = await this.api.call('getUpdates', { offset, timeout: 25, allowed_updates: ALLOWED_UPDATES }, { timeoutMs: 40_000 });
        for (const u of updates) {
          if (this.stopped || this.ctx.signal.aborted) return;
          this.ctx.setState({ offset: u.update_id + 1 });
          await this.handle(u).catch((e) => this.ctx.log('in', 'error', `Bericht verwerken mislukt: ${e?.message || e}`));
        }
      } catch (e: any) {
        if (this.stopped || this.ctx.signal.aborted) return;
        this.ctx.fail(e, e instanceof ChannelError && e.fatal);
        return;
      }
    }
  }

  async webhook(_kind: string, req: any, res: any) {
    const secret = this.ctx.secret('webhookSecret');
    if (!secret || !safeEqual(String(req.headers['x-telegram-bot-api-secret-token'] || ''), secret)) {
      this.ctx.log('in', 'rejected', 'Webhook met ongeldige geheime token geweigerd');
      return void res.status(401).json({ error: 'Niet toegestaan' });
    }
    res.status(200).json({ ok: true });
    try {
      const u = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '{}');
      await this.handle(u);
    } catch (e: any) {
      this.ctx.log('in', 'error', `Webhook verwerken mislukt: ${e?.message || e}`);
    }
  }

  private fileAttachment(fileId: string, name: string, mime: string, size: number | undefined, kind: InboundAttachment['kind']): InboundAttachment {
    return {
      name,
      mime,
      size,
      kind,
      fetch: async () => {
        if (size && size > GET_FILE_LIMIT && this.api.base() === TELEGRAM_API) throw new ChannelError('Telegram staat bots alleen bestanden tot 20 MB toe');
        const f = await this.api.call('getFile', { file_id: fileId });
        if (!f.file_path) throw new ChannelError('Bestand niet beschikbaar');
        const maxMb = Math.min(50, Math.max(1, Number(this.ctx.binding().config.maxFileMb) || 20));
        return fetchBuffer(`${this.api.base()}/file/bot${this.api.token()}/${f.file_path}`, { maxBytes: maxMb * 1024 * 1024, signal: this.ctx.signal });
      },
    };
  }

  /** Exposed for tests: process one Bot API update. */
  async handle(u: any) {
    if (u.callback_query) return this.handleCallback(u.callback_query);
    const m = u.message;
    if (!m || !m.from || m.from.is_bot) return;
    const cfg = this.ctx.binding().config;
    const priv = m.chat?.type === 'private';
    if (!priv && !cfg.allowGroups) {
      this.ctx.log('in', 'ignored', `Bericht in groep “${m.chat?.title || m.chat?.id}” genegeerd (groepen staan uit)`, { senderId: String(m.from.id), conversationId: String(m.chat?.id) });
      return;
    }
    let text: string = m.text ?? m.caption ?? '';
    const uname = this.me?.username || this.ctx.binding().state?.info?.botUsername;
    if (!priv) {
      const mentioned = uname && text.toLowerCase().includes('@' + String(uname).toLowerCase());
      const replyToBot = m.reply_to_message?.from?.id && this.me && m.reply_to_message.from.id === this.me.id;
      if (!mentioned && !replyToBot && !text.startsWith('/')) return;
    }
    if (uname) text = text.replace(new RegExp('@' + String(uname).replace(/[^\w]/g, ''), 'ig'), '').trim();
    const atts: InboundAttachment[] = [];
    if (Array.isArray(m.photo) && m.photo.length) {
      const p = [...m.photo].sort((a, b) => (b.file_size || b.width * b.height) - (a.file_size || a.width * a.height)).find((x) => !x.file_size || x.file_size <= GET_FILE_LIMIT) || m.photo[0];
      atts.push(this.fileAttachment(p.file_id, `foto-${m.message_id}.jpg`, 'image/jpeg', p.file_size, 'image'));
    }
    if (m.document) atts.push(this.fileAttachment(m.document.file_id, m.document.file_name || `bestand-${m.message_id}`, m.document.mime_type || 'application/octet-stream', m.document.file_size, 'file'));
    if (m.voice) atts.push(this.fileAttachment(m.voice.file_id, `spraakbericht-${m.message_id}.ogg`, m.voice.mime_type || 'audio/ogg', m.voice.file_size, 'voice'));
    if (m.audio) atts.push(this.fileAttachment(m.audio.file_id, m.audio.file_name || `audio-${m.message_id}.mp3`, m.audio.mime_type || 'audio/mpeg', m.audio.file_size, 'audio'));
    if (m.video) atts.push(this.fileAttachment(m.video.file_id, m.video.file_name || `video-${m.message_id}.mp4`, m.video.mime_type || 'video/mp4', m.video.file_size, 'video'));
    if (m.video_note) atts.push(this.fileAttachment(m.video_note.file_id, `videobericht-${m.message_id}.mp4`, 'video/mp4', m.video_note.file_size, 'video'));
    if (m.location) text = `${text}\n📍 Locatie: ${m.location.latitude}, ${m.location.longitude}`.trim();
    if (m.contact) text = `${text}\n👤 Contact: ${[m.contact.first_name, m.contact.last_name].filter(Boolean).join(' ')} ${m.contact.phone_number || ''}`.trim();
    if (m.sticker && !text) text = `[sticker ${m.sticker.emoji || ''}]`.trim();
    const topic = m.is_topic_message && m.message_thread_id ? m.message_thread_id : null;
    const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') || m.from.username || String(m.from.id);
    const msg: Inbound = {
      messageId: `u${u.update_id ?? `${m.chat.id}:${m.message_id}`}`,
      conversation: { id: topic ? `${m.chat.id}:${topic}` : String(m.chat.id), title: priv ? name : m.chat.title || String(m.chat.id), private: priv },
      sender: { id: String(m.from.id), name, handle: m.from.username ? '@' + m.from.username : undefined },
      text,
      attachments: atts,
      date: m.date ? m.date * 1000 : undefined,
      extra: { chatId: m.chat.id, topicId: topic, lastMessageId: m.message_id },
      reactTo: `${m.chat.id}:${m.message_id}`,
    };
    await this.ctx.receive(msg);
  }

  private async handleCallback(cq: any) {
    const chat = cq.message?.chat;
    const data = String(cq.data || '');
    let text: string | null = null;
    if (data.startsWith('tb:') && chat) {
      const topic = cq.message?.is_topic_message && cq.message?.message_thread_id ? cq.message.message_thread_id : null;
      text = await this.ctx.action({ conversationId: topic ? `${chat.id}:${topic}` : String(chat.id), senderId: String(cq.from?.id), actionId: data.slice(3) });
    }
    await this.api.call('answerCallbackQuery', { callback_query_id: cq.id, text: (text || 'Niet (meer) geldig').slice(0, 190) }).catch(() => {});
    if (text && chat && cq.message?.message_id) await this.api.call('editMessageReplyMarkup', { chat_id: chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  }

  private target(conv: Conversation) {
    const chatId = conv.meta?.chatId ?? conv.external_id.split(':')[0];
    const topic = conv.meta?.topicId || (conv.external_id.includes(':') ? Number(conv.external_id.split(':')[1]) : null);
    return { chat_id: chatId, ...(topic ? { message_thread_id: topic } : {}) };
  }

  async send(conv: Conversation, out: Outbound): Promise<string[]> {
    return this.sendRaw(this.target(conv), out);
  }

  private async sendRaw(target: Record<string, any>, out: Outbound): Promise<string[]> {
    const ids: string[] = [];
    const chunks = splitMessage(out.text || '', 3500);
    const keyboard = out.buttons?.length ? { inline_keyboard: [out.buttons.map((b) => ({ text: b.label, callback_data: ('tb:' + b.id).slice(0, 64) }))] } : undefined;
    for (let i = 0; i < chunks.length; i++) {
      const last = i === chunks.length - 1;
      const md = toTelegramMarkdownV2(chunks[i]);
      const base = { ...target, link_preview_options: { is_disabled: true }, ...(last && keyboard ? { reply_markup: keyboard } : {}) };
      let r: any;
      if (md.length <= MAX_TEXT) {
        try {
          r = await this.api.call('sendMessage', { ...base, text: md, parse_mode: 'MarkdownV2' });
        } catch (e: any) {
          if (!(e instanceof TgError) || e.code !== 400) throw e;
          r = null; // formatting rejected: fall back to plain text below
        }
      }
      if (!r) {
        const parts = splitMessage(toPlain(chunks[i]), MAX_TEXT);
        for (let j = 0; j < parts.length; j++) {
          r = await this.api.call('sendMessage', { ...target, link_preview_options: { is_disabled: true }, text: parts[j], ...(last && j === parts.length - 1 && keyboard ? { reply_markup: keyboard } : {}) });
          if (j < parts.length - 1) ids.push(`m${r.chat?.id}:${r.message_id}`);
        }
      }
      ids.push(`m${r.chat?.id}:${r.message_id}`);
    }
    for (const f of out.files || []) {
      const fd = new FormData();
      for (const [k, v] of Object.entries(target)) fd.append(k, String(v));
      const photo = /^image\/(jpeg|png|webp)$/.test(f.mime) && f.size <= 10 * 1024 * 1024;
      if (!photo && f.size > 50 * 1024 * 1024) continue;
      fd.append(photo ? 'photo' : 'document', new Blob([fs.readFileSync(f.path)], { type: f.mime }), f.name);
      const r = await this.api.call(photo ? 'sendPhoto' : 'sendDocument', fd, { timeoutMs: 120_000 });
      ids.push(`m${r.chat?.id}:${r.message_id}`);
    }
    return ids;
  }

  async sendTo(target: string, out: Outbound) {
    const t = target.trim();
    if (!/^(-?\d{3,20}|@[A-Za-z][\w]{3,40})$/.test(t)) throw new ChannelError('Geef een Telegram-chat-id (getal) of @kanaalnaam op.');
    const chat = await this.api.call('getChat', { chat_id: t }).catch(() => null);
    const ids = await this.sendRaw({ chat_id: chat?.id ?? t }, out);
    const id = String(chat?.id ?? t);
    const title = chat ? chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || id : id;
    return { conversationId: id, title, private: chat?.type === 'private', ids, extra: { chatId: chat?.id ?? t } };
  }

  async typing(conv: Conversation) {
    await this.api.call('sendChatAction', { ...this.target(conv), action: 'typing' }, { timeoutMs: 10_000 });
  }

  /** Status reaction (setMessageReaction replaces the bot's earlier one); Telegram only allows its own emoji list. */
  async react(_conv: Conversation, reactTo: string, status: ReactionStatus) {
    const i = reactTo.lastIndexOf(':');
    const chatId = reactTo.slice(0, i);
    const messageId = Number(reactTo.slice(i + 1));
    if (!chatId || !messageId) return;
    await this.api.call('setMessageReaction', { chat_id: chatId, message_id: messageId, reaction: [{ type: 'emoji', emoji: TELEGRAM_REACTION[status] }] }, { timeoutMs: 10_000 });
  }
}

/** Reaction emoji Telegram accepts from bots (a fixed list): looking, thumbs up, crying. */
export const TELEGRAM_REACTION: Record<ReactionStatus, string> = { working: '👀', done: '👍', error: '😢' };
