import crypto from 'node:crypto';
import { bad } from '../../../core/http.js';
import { splitMessage, toWhatsApp } from '../format.js';
import { parsePairCode } from '../manager.js';
import { ChannelError, REACTION_EMOJI, type AdapterContext, type AdapterDef, type AdapterRuntime, type BindingStatus, type Conversation, type InboundAttachment, type Outbound, type ReactionStatus } from '../types.js';
import { phoneDigits, type DriverFactory, type WaDriver, type WaIncoming, type WaMe } from '../whatsapp-web/driver.js';
import { SessionStore } from '../whatsapp-web/session.js';
import { WwebjsDriver } from '../whatsapp-web/wwebjs.js';

const MAX_TEXT = 4000;
/** How long a QR code / pairing code flow may wait for the phone before we stop the hidden browser. */
export const LINK_WINDOW_MS = 5 * 60_000;
const START_TIMEOUT_MS = 120_000;
/** Marks the bot's messages in the owner's own chat (every message there looks like "you"). */
export const BOT_MARK = '🤖';

type Phase = 'starting' | 'qr' | 'code' | 'syncing' | 'ready' | 'stopped' | 'error';

export interface WaLinkState {
  phase: Phase;
  qr?: string;
  qrVersion?: number;
  code?: string;
  percent?: number;
  me?: { phone: string; name: string };
  expiresAt?: string;
  detail?: string;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 500);
export const ownJid = (me: WaMe | null) => me?.jid || '';

/**
 * WhatsApp as a linked device: the owner scans a QR code (or enters a pairing code) with his own phone, like
 * WhatsApp Web. No Meta business account, no public URL. Unofficial (WhatsApp's terms), so the UI says so.
 *
 * Who reaches the bot:
 *  - the owner in his "message yourself" chat (always verified: only his own devices can write there);
 *  - numbers on the allowlist (or who send a pairing code);
 *  - nothing else: other chats of the owner are never read, messages from unknown numbers are dropped
 *    without logging their content.
 */
export function whatsappWebAdapter(o: { driverFactory?: () => DriverFactory | null } = {}): AdapterDef {
  return {
    id: 'whatsapp-web',
    label: 'WhatsApp (QR)',
    description: 'Je eigen WhatsApp als gekoppeld apparaat via een QR-code. Onofficieel: WhatsApp kan het nummer blokkeren, ook voorgoed. Geen bedrijfsaccount of publieke URL nodig.',
    needsPublicUrl: () => false,
    approveViaChannel: true,
    maxText: MAX_TEXT,
    typingEveryMs: 20_000,
    reactions: true,
    secretFields: [],
    internalSecrets: ['sessionKey'],
    botRouting: true,
    maxFileMb: 64,
    async validate(c, opts) {
      if (opts.role === 'member') throw bad('Alleen een eigenaar of beheerder kan WhatsApp (QR) koppelen: elke koppeling start een eigen onzichtbare browser.');
      // The honest warning comes first: a new QR link only after the owner said he understands the risk.
      if (opts.isNew && c.riskAccepted !== true && !c.riskAcceptedAt)
        throw bad('Lees eerst de waarschuwing: WhatsApp kan een nummer dat via een onofficiële koppeling werkt blokkeren, ook voorgoed. Bevestig dat je dat begrijpt.');
      const ownerPhone = phoneDigits(c.ownerPhone);
      if (ownerPhone && (ownerPhone.length < 8 || ownerPhone.length > 15)) throw bad('Vul je eigen nummer in internationale vorm in (bijv. 31612345678), of laat het leeg.');
      return {
        // When the owner accepted the risk (kept; channels from before 0.4 saw the warning of 0.3 and have none).
        riskAcceptedAt: c.riskAcceptedAt || (c.riskAccepted === true ? new Date().toISOString() : null),
        ownerPhone,
        selfChat: c.selfChat !== false,
        allowGroups: !!c.allowGroups,
        maxAgeHours: Math.min(168, Math.max(1, Number(c.maxAgeHours) || 24)),
      };
    },
    async test(ctx) {
      const b = ctx.binding();
      const store = new SessionStore(ctx.storageDir(), Buffer.alloc(32));
      const info = b.state?.info || {};
      const { browserCandidates, realProbes } = await import('../../browser/capabilities.js');
      const browser = browserCandidates(realProbes)[0];
      if (!browser) return { ok: false, detail: 'Geen Microsoft Edge, Google Chrome of Chromium gevonden. Installeer er een (of zet TEAMBOT_BROWSER_PATH).' };
      if (!store.hasBackup() && !store.hasProfile()) return { ok: false, detail: `Nog niet gekoppeld. Klik op “Koppelen” en scan de QR-code met WhatsApp op je telefoon. (Browser: ${browser.name})` };
      return { ok: b.status === 'connected', detail: b.status === 'connected' ? `Verbonden als +${info.phone || '?'}${info.name ? ` (${info.name})` : ''}.` : `Sessie aanwezig, maar nu niet verbonden (${b.status}). Klik op “Verbinden”.` };
    },
    receiveHint() {
      return 'Stuur het testbericht in WhatsApp in je chat “Bericht aan jezelf” (op de telefoon die je koppelde). Berichten van onbekende nummers leest TeamBot hier nooit.';
    },
    create(ctx) {
      return new WhatsAppWebRuntime(ctx, o.driverFactory?.() || null);
    },
  };
}

export class WhatsAppWebRuntime implements AdapterRuntime {
  private driver: WaDriver | null = null;
  private link: WaLinkState = { phase: 'starting' };
  private me: WaMe | null = null;
  private stopped = false;
  private linkTimer: NodeJS.Timeout | null = null;
  private qrVersion = 0;
  /** Normalized bodies we are about to send (echo filter for message_create in the own chat). */
  private outgoing = new Map<string, number>();
  private sentIds = new Set<string>();

  constructor(private ctx: AdapterContext, private factory: DriverFactory | null) {}

  linkState(): WaLinkState {
    return { ...this.link };
  }

  private setLink(patch: Partial<WaLinkState>, push = true) {
    this.link = { ...this.link, ...patch };
    if (push) {
      const { qr: _qr, ...safe } = this.link; // the QR itself is fetched by the owner's UI, not broadcast
      this.ctx.notify('whatsapp', safe);
    }
  }

  private sessionKey(): Buffer {
    let k = this.ctx.secret('sessionKey');
    if (!k) {
      k = crypto.randomBytes(32).toString('base64');
      this.ctx.storeSecret('sessionKey', k);
    }
    return Buffer.from(k, 'base64');
  }

  private armLinkTimeout() {
    if (this.linkTimer) return;
    this.setLink({ expiresAt: new Date(Date.now() + LINK_WINDOW_MS).toISOString() }, false);
    this.linkTimer = setTimeout(() => {
      this.linkTimer = null;
      if (this.stopped || this.link.phase === 'ready' || this.link.phase === 'syncing') return;
      this.setLink({ phase: 'error', qr: undefined, code: undefined, detail: 'Niet op tijd gekoppeld' });
      this.ctx.fail(new ChannelError('Niet binnen 5 minuten gekoppeld. Klik op “Koppelen” om een nieuwe QR-code te maken.', true));
    }, LINK_WINDOW_MS);
    this.linkTimer.unref?.();
  }

  private clearLinkTimeout() {
    if (this.linkTimer) clearTimeout(this.linkTimer);
    this.linkTimer = null;
  }

  async start(): Promise<BindingStatus> {
    const b = this.ctx.binding();
    const dir = this.ctx.storageDir();
    const key = this.sessionKey();
    const store = new SessionStore(dir, key);
    const linked = store.hasBackup() || store.hasProfile();
    const requested = Date.parse(b.state?.linkRequestedAt || '') || 0;
    const created = Date.parse(b.created_at) || 0;
    // Never start a hidden browser just to show a QR code nobody asked for (e.g. at app start-up).
    if (!linked && Date.now() - Math.max(requested, created) > LINK_WINDOW_MS) {
      this.setLink({ phase: 'stopped', detail: 'Nog niet gekoppeld' });
      throw new ChannelError('Nog niet gekoppeld. Klik op “Koppelen” en scan de QR-code met WhatsApp op je telefoon.', true);
    }
    const d = (this.factory || ((x) => new WwebjsDriver(x)))({
      bindingId: b.id,
      dir,
      sessionKey: key,
      deviceName: 'TeamBot',
      browserPath: process.env.TEAMBOT_BROWSER_PATH || undefined,
      log: (t) => this.ctx.log('system', 'whatsapp', t),
    });
    this.driver = d;
    d.on('qr', (qr) => {
      this.armLinkTimeout();
      this.setLink({ phase: 'qr', qr, code: undefined, qrVersion: ++this.qrVersion, detail: undefined });
    });
    d.on('code', (code) => {
      this.armLinkTimeout();
      this.setLink({ phase: 'code', code, qr: undefined, detail: undefined });
    });
    d.on('authenticated', () => {
      this.clearLinkTimeout();
      // whatsapp-web.js repeats this on every re-sync; a live connection stays "ready" (sending keeps working).
      if (this.link.phase !== 'ready') this.setLink({ phase: 'syncing', qr: undefined, code: undefined, expiresAt: undefined });
    });
    d.on('loading', (percent) => this.setLink({ phase: this.link.phase === 'ready' ? 'ready' : 'syncing', percent }));
    d.on('ready', (me) => void this.onReady(me));
    d.on('authFailure', (msg) => {
      this.clearLinkTimeout();
      this.setLink({ phase: 'error', detail: msg });
      new SessionStore(dir, key).wipeAll();
      this.ctx.fail(new ChannelError(`WhatsApp weigerde de bewaarde sessie (${msg}). Koppel opnieuw met een QR-code.`, true));
    });
    d.on('disconnected', (reason, loggedOut) => {
      if (this.stopped) return;
      this.clearLinkTimeout();
      if (loggedOut) {
        new SessionStore(dir, key).wipeAll();
        this.ctx.setState({ info: {} });
        this.setLink({ phase: 'stopped', me: undefined, detail: 'Ontkoppeld' });
        this.ctx.log('system', 'unlinked', 'TeamBot is als gekoppeld apparaat verwijderd (op de telefoon of door WhatsApp)');
        this.ctx.fail(new ChannelError('Ontkoppeld: TeamBot staat niet meer bij “Gekoppelde apparaten” op je telefoon. Koppel opnieuw met een QR-code.', true));
        return;
      }
      this.setLink({ phase: 'error', detail: reason });
      this.ctx.fail(new ChannelError(`Verbinding met WhatsApp verbroken (${reason})`));
    });
    d.on('message', (m) => {
      this.onMessage(m).catch((e) => this.ctx.log('in', 'error', `Bericht verwerken mislukt: ${e?.message || e}`));
    });
    this.setLink({ phase: 'starting', detail: linked ? 'Sessie herstellen' : 'QR-code maken' });
    // WhatsApp Web loads without a time limit; never hang in "connecting" (no internet, captive portal …).
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        d.start(),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new ChannelError('WhatsApp Web startte niet binnen 2 minuten (geen internet?)')), START_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    return 'connecting';
  }

  private async onReady(me: WaMe) {
    if (this.stopped) return;
    const cfg = this.ctx.binding().config;
    if (cfg.ownerPhone && me.phone && me.phone !== cfg.ownerPhone) {
      // Someone else's phone scanned the code: never let that account act as the owner.
      this.ctx.log('system', 'error', `Gekoppeld met +${me.phone}, maar ingesteld eigen nummer is +${cfg.ownerPhone}: weer ontkoppeld`);
      this.stopped = true;
      await this.driver?.logout().catch(() => {});
      this.setLink({ phase: 'error', me: undefined, detail: 'Verkeerd nummer gekoppeld' });
      this.ctx.fail(new ChannelError(`Er werd gekoppeld met +${me.phone}, maar bij deze koppeling staat +${cfg.ownerPhone} als jouw nummer. Uit veiligheid weer ontkoppeld.`, true));
      return;
    }
    this.me = me;
    const first = !this.ctx.binding().state?.info?.phone;
    this.ctx.setState({ info: { phone: me.phone, name: me.name, linkedAt: this.ctx.binding().state?.info?.linkedAt || new Date().toISOString() }, linkRequestedAt: null });
    if (cfg.selfChat !== false) this.ctx.ensureOwnerSender(this.ownerId(), me.name ? `${me.name} (jij)` : 'Jij (eigen WhatsApp)');
    this.setLink({ phase: 'ready', me: { phone: me.phone, name: me.name }, qr: undefined, code: undefined, expiresAt: undefined, detail: undefined });
    this.ctx.status('connected');
    this.ctx.log('system', 'connected', first ? `Gekoppeld als +${me.phone || '?'}${me.name ? ` (${me.name})` : ''}` : `Verbonden als +${me.phone || '?'}`);
  }

  private ownerId() {
    return this.me?.phone || `lid:${this.me?.jid || ''}`;
  }

  private isEcho(m: WaIncoming): boolean {
    if (this.sentIds.has(m.id)) return true;
    const body = norm(m.body);
    const t = body ? this.outgoing.get(body) : undefined;
    if (t && t > Date.now()) {
      this.outgoing.delete(body);
      return true;
    }
    return m.selfChat && m.body.trimStart().startsWith(BOT_MARK);
  }

  /** Exposed for tests (the fake driver calls it through the 'message' event). */
  async onMessage(m: WaIncoming) {
    if (this.stopped || m.broadcast) return;
    const cfg = this.ctx.binding().config;
    if (m.fromMe) {
      // The owner's own messages: only the "message yourself" chat reaches the bot, never his chats with others.
      if (!m.selfChat || cfg.selfChat === false || this.isEcho(m)) return;
    } else {
      if (m.isGroup && !cfg.allowGroups) return;
      const sid = m.senderPhone || `lid:${m.senderJid}`;
      // Unknown numbers: dropped without logging anything about them (this is the owner's personal WhatsApp).
      if (!this.ctx.isAllowed(sid) && !parsePairCode(m.body)) return;
      if (m.isGroup && !m.mentionsMe) return;
    }
    const maxAge = (Number(cfg.maxAgeHours) || 24) * 3600_000;
    if (m.timestamp && Date.now() - m.timestamp > maxAge) {
      this.ctx.log('in', 'ignored', 'Oud bericht genegeerd (van vóór de verbinding)');
      return;
    }
    const atts: InboundAttachment[] = [];
    let text = m.body;
    if (m.media && m.kind !== 'sticker') {
      const kind = m.kind === 'voice' ? 'voice' : m.kind === 'audio' ? 'audio' : m.kind === 'image' ? 'image' : m.kind === 'video' ? 'video' : 'file';
      atts.push({ name: m.media.name, mime: m.media.mime, size: m.media.size, kind, fetch: () => m.media!.fetch() });
    }
    if (m.kind === 'sticker' && !text) text = '[sticker]';
    if (m.kind === 'contact' && !text) text = '[contactkaart]';
    const self = m.fromMe && m.selfChat;
    const senderId = self ? this.ownerId() : m.senderPhone || `lid:${m.senderJid}`;
    const convId = self ? this.ownerId() : m.isGroup ? m.chatId : senderId;
    await this.ctx.receive({
      messageId: `w:${m.id}`,
      conversation: { id: convId, title: self ? 'Bericht aan jezelf' : m.isGroup ? m.chatTitle || 'WhatsApp-groep' : m.senderName, private: !m.isGroup },
      sender: { id: senderId, name: self ? this.me?.name || 'Jij' : m.senderName, handle: m.senderPhone ? '+' + m.senderPhone : undefined },
      text,
      attachments: atts,
      date: m.timestamp,
      replyToId: m.quotedId ? `w:${m.quotedId}` : undefined,
      reactTo: m.key,
      extra: { chatId: m.chatId, selfChat: !!self },
    });
  }

  private chatOf(conv: Pick<Conversation, 'external_id' | 'meta'>): string {
    if (conv.meta?.chatId) return String(conv.meta.chatId);
    const ext = String(conv.meta?.baseExternalId || conv.external_id);
    if (ext.includes('@')) return ext;
    if (ext.startsWith('lid:')) return ext.slice(4);
    if (this.me?.phone && ext === this.me.phone) return ownJid(this.me);
    return `${phoneDigits(ext)}@c.us`;
  }

  private remember(id: string) {
    if (!id) return;
    this.sentIds.add(id);
    if (this.sentIds.size > 1000) this.sentIds = new Set([...this.sentIds].slice(-300));
  }

  private async sendTo_(chatId: string, self: boolean, out: Outbound): Promise<string[]> {
    if (!this.driver || this.link.phase !== 'ready') throw new ChannelError('WhatsApp is niet verbonden');
    const ids: string[] = [];
    const head = self ? `${BOT_MARK} *${(out.senderName || 'TeamBot').replace(/[*_~]/g, '')}*` : '';
    const body = toWhatsApp(out.text || '');
    const chunks = splitMessage(body, MAX_TEXT - 100);
    for (let i = 0; i < chunks.length; i++) {
      const text = i === 0 && head ? `${head}\n${chunks[i]}` : self ? `${BOT_MARK} ${chunks[i]}` : chunks[i];
      this.outgoing.set(norm(text), Date.now() + 60_000);
      const id = await this.driver.sendText(chatId, text);
      this.remember(id);
      ids.push(`w:${id}`);
    }
    for (const f of out.files || []) {
      const caption = self ? `${BOT_MARK} ${f.name}` : undefined;
      if (caption) this.outgoing.set(norm(caption), Date.now() + 60_000);
      const id = await this.driver.sendFile(chatId, { path: f.path, name: f.name, mime: f.mime }, caption);
      this.remember(id);
      ids.push(`w:${id}`);
    }
    if (this.outgoing.size > 200) for (const [k, t] of this.outgoing) if (t < Date.now()) this.outgoing.delete(k);
    return ids;
  }

  async send(conv: Conversation, out: Outbound) {
    return this.sendTo_(this.chatOf(conv), !!conv.meta?.selfChat, out);
  }

  async sendTo(target: string, out: Outbound) {
    if (!this.driver || this.link.phase !== 'ready') throw new ChannelError('WhatsApp is niet verbonden');
    const t = target.trim();
    if (/@g\.us$/.test(t)) {
      const ids = await this.sendTo_(t, false, out);
      return { conversationId: t, title: 'WhatsApp-groep', private: false, ids, extra: { chatId: t } };
    }
    const digits = phoneDigits(t);
    if (digits.length < 8 || digits.length > 15) throw new ChannelError('Geef een telefoonnummer in internationale vorm op (bijv. 31612345678).');
    if (this.me?.phone && digits === this.me.phone) {
      const ids = await this.sendTo_(ownJid(this.me), true, out);
      return { conversationId: digits, title: 'Bericht aan jezelf', private: true, ids, extra: { chatId: ownJid(this.me), selfChat: true } };
    }
    const chatId = await this.driver.resolveNumber(digits);
    if (!chatId) throw new ChannelError(`+${digits} heeft geen WhatsApp.`);
    const ids = await this.sendTo_(chatId, false, out);
    return { conversationId: digits, title: '+' + digits, private: true, ids, extra: { chatId } };
  }

  async typing(conv: Conversation) {
    if (conv.meta?.selfChat || !this.driver || this.link.phase !== 'ready') return;
    await this.driver.typing(this.chatOf(conv));
  }

  /** Status reaction on the incoming message (one reaction per account: a new one replaces 👀). */
  async react(_conv: Conversation, reactTo: string, status: ReactionStatus) {
    if (!this.driver?.react || this.link.phase !== 'ready') return;
    await this.driver.react(reactTo, REACTION_EMOJI[status]);
  }

  async requestPairingCode(phone: string) {
    if (!this.driver) throw new ChannelError('WhatsApp is niet gestart');
    if (this.link.phase === 'ready' || this.link.phase === 'syncing') throw new ChannelError('Al gekoppeld');
    const digits = phoneDigits(phone);
    if (digits.length < 8 || digits.length > 15) throw new ChannelError('Vul je nummer in internationale vorm in (bijv. 31612345678).');
    const code = await this.driver.requestPairingCode(digits);
    this.armLinkTimeout();
    this.setLink({ phase: 'code', code, qr: undefined });
    return code;
  }

  async logout() {
    this.stopped = true;
    this.clearLinkTimeout();
    await this.driver?.logout();
    this.ctx.setState({ info: {} });
    this.setLink({ phase: 'stopped', me: undefined, qr: undefined, code: undefined });
  }

  async stop() {
    const wasStopped = this.stopped;
    this.stopped = true;
    this.clearLinkTimeout();
    if (!wasStopped) await this.driver?.stop().catch(() => {});
    if (this.link.phase !== 'error') this.setLink({ phase: 'stopped', qr: undefined, code: undefined }, false);
  }
}
