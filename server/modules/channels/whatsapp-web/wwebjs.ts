import fs from 'node:fs';
import { browserCandidates, realProbes } from '../../browser/capabilities.js';
import { ChannelError } from '../types.js';
import { DriverEmitter, phoneDigits, type DriverOptions, type WaDriver, type WaIncoming, type WaKind, type WaMe, type WaOutFile } from './driver.js';
import { SessionStore } from './session.js';

const KIND: Record<string, WaKind> = {
  chat: 'text',
  image: 'image',
  video: 'video',
  audio: 'audio',
  ptt: 'voice',
  document: 'document',
  sticker: 'sticker',
  location: 'location',
  vcard: 'contact',
  multi_vcard: 'contact',
};
const EXT: Record<string, string> = { image: 'jpg', video: 'mp4', audio: 'ogg', voice: 'ogg', document: 'bin', sticker: 'webp' };

const ser = (v: any): string => (v && typeof v === 'object' ? String(v._serialized || '') : String(v || ''));

/**
 * whatsapp-web.js message → WaIncoming. Pure (all lookups injected) so it is unit-tested without a browser.
 * `meIds` holds every jid of the linked account (phone and LID form).
 */
export async function mapWwebjsMessage(
  m: any,
  o: { meIds: Set<string>; phoneOf(jid: string): Promise<string | null>; chatTitle(chatId: string): Promise<string | undefined> },
): Promise<WaIncoming | null> {
  const id = String(m?.id?.id || '');
  if (!id) return null;
  const chatId = ser(m.id?.remote) || (m.fromMe ? ser(m.to) : ser(m.from));
  const broadcast = !!m.isStatus || !!m.broadcast || /@(broadcast|newsletter)$/.test(chatId);
  const isGroup = chatId.endsWith('@g.us');
  const selfChat = !!m.fromMe && !isGroup && o.meIds.has(chatId);
  const senderJid = m.fromMe ? [...o.meIds][0] || '' : isGroup ? ser(m.author) : chatId;
  const senderPhone = phoneDigits(senderJid) || (senderJid ? await o.phoneOf(senderJid).catch(() => null) : null) || null;
  const kind: WaKind = KIND[String(m.type)] || 'other';
  const raw = m._data || {};
  let media: WaIncoming['media'];
  if (m.hasMedia && typeof m.downloadMedia === 'function') {
    const mime = String(raw.mimetype || '').split(';')[0] || 'application/octet-stream';
    const name = String(raw.filename || '') || `${kind === 'voice' ? 'spraakbericht' : kind}-${id.slice(-8)}.${EXT[kind] || 'bin'}`;
    media = {
      name,
      mime,
      size: Number(raw.size) || undefined,
      fetch: async () => {
        const mm = await m.downloadMedia();
        if (!mm?.data) throw new ChannelError('Bestand niet (meer) beschikbaar op WhatsApp');
        return Buffer.from(mm.data, 'base64');
      },
    };
  }
  let body = String(m.body || '');
  if (kind === 'location' && m.location) body = `📍 Locatie: ${m.location.latitude}, ${m.location.longitude}${m.location.description ? ` (${m.location.description})` : ''}`;
  return {
    id,
    key: typeof m.id?._serialized === 'string' ? m.id._serialized : undefined,
    chatId,
    fromMe: !!m.fromMe,
    selfChat,
    isGroup,
    chatTitle: isGroup ? await o.chatTitle(chatId).catch(() => undefined) : undefined,
    senderPhone,
    senderJid,
    senderName: String(raw.notifyName || raw.pushname || '') || (senderPhone ? '+' + senderPhone : senderJid),
    kind,
    body,
    media,
    quotedId: m.hasQuotedMsg && raw.quotedStanzaID ? String(raw.quotedStanzaID) : undefined,
    mentionsMe: Array.isArray(m.mentionedIds) && m.mentionedIds.some((x: any) => o.meIds.has(ser(x))),
    timestamp: (Number(m.timestamp) || Math.floor(Date.now() / 1000)) * 1000,
    broadcast,
  };
}

/**
 * WhatsApp Web via whatsapp-web.js (Apache-2.0) in the Edge/Chrome that is already installed (puppeteer-core,
 * no browser download). The session lives in an encrypted archive (see session.ts); the plaintext browser
 * profile only exists while the connection runs.
 */
export class WwebjsDriver extends DriverEmitter implements WaDriver {
  private client: any = null;
  private store: SessionStore;
  private meIds = new Set<string>();
  private lidCache = new Map<string, string | null>();
  private titleCache = new Map<string, string>();
  private authed = false;
  private stopping = false;
  private starting: Promise<void> | null = null;
  private restoredFrom: ReturnType<SessionStore['restore']> = 'none';
  private backupTimer: NodeJS.Timeout | null = null;
  private firstBackup: NodeJS.Timeout | null = null;

  constructor(private o: DriverOptions) {
    super();
    this.store = new SessionStore(o.dir, o.sessionKey);
  }

  private browserPath(): string {
    const p = this.o.browserPath || browserCandidates(realProbes)[0]?.path;
    if (!p)
      throw new ChannelError(
        'Geen Microsoft Edge, Google Chrome of Chromium gevonden. WhatsApp (QR) draait in een onzichtbaar browservenster; installeer een van deze browsers of zet TEAMBOT_BROWSER_PATH.',
        true,
      );
    return p;
  }

  private backup(why: string) {
    if (!this.authed) return;
    try {
      const n = this.store.backup();
      if (n) this.o.log(`Sessie versleuteld bewaard (${why}, ${Math.round(n / 1024)} kB)`);
    } catch (e: any) {
      this.o.log(`Sessie bewaren mislukt: ${e?.message || e}`);
    }
  }

  async start() {
    const executablePath = this.browserPath();
    const src = this.store.restore();
    this.restoredFrom = src;
    if (src === 'unreadable') this.o.log('De bewaarde sessie kon niet worden ontsleuteld; koppel opnieuw met een QR-code.');
    const mod: any = await import('whatsapp-web.js');
    const wa = mod.default ?? mod;
    const self = this;
    // Duck-typed auth strategy: the profile directory is ours (encrypted at rest by SessionStore).
    const auth = {
      setup(client: any) {
        this.client = client;
      },
      client: null as any,
      async beforeBrowserInitialized() {
        this.client.options.puppeteer = { ...this.client.options.puppeteer, userDataDir: self.store.profileDir };
      },
      async afterBrowserInitialized() {},
      async onAuthenticationNeeded() {
        return { failed: false, restart: false, failureEventPayload: undefined };
      },
      async getAuthEventPayload() {},
      async afterAuthReady() {
        self.authed = true;
        // WhatsApp keeps writing keys right after linking; take the first snapshot when it has settled.
        self.firstBackup = setTimeout(() => self.backup('na koppelen'), 60_000);
        self.firstBackup.unref?.();
        self.backupTimer = setInterval(() => self.backup('periodiek'), 15 * 60_000);
        self.backupTimer.unref?.();
      },
      async disconnect() {},
      async destroy() {
        self.clearTimers();
      },
      async logout() {
        self.clearTimers();
        self.authed = false;
        self.store.wipeAll();
      },
    };
    const args = ['--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--mute-audio'];
    // Containers (Docker image with WITH_CHROMIUM=1) have no user namespaces for Chromium's sandbox.
    if (process.platform === 'linux' && fs.existsSync('/.dockerenv')) args.push('--no-sandbox', '--disable-dev-shm-usage');
    const client = new wa.Client({
      authStrategy: auth,
      puppeteer: { executablePath, headless: true, args },
      webVersionCache: { type: 'none' },
      // No deviceName/browserName: whatsapp-web.js patches an internal WhatsApp Web module for that, which current
      // WhatsApp Web builds no longer have (the start fails). The phone shows the browser name instead.
      authTimeoutMs: 90_000,
      qrMaxRetries: 0,
    });
    this.client = client;
    client.on('qr', (qr: string) => this.emit('qr', qr));
    client.on('code', (code: string) => this.emit('code', code));
    client.on('loading_screen', (p: number) => this.emit('loading', Number(p) || 0));
    client.on('authenticated', () => {
      this.authed = true;
      this.emit('authenticated');
    });
    client.on('auth_failure', (msg: string) => this.emit('authFailure', String(msg || 'Koppelen mislukt')));
    client.on('ready', async () => {
      const me = await this.readMe().catch(() => null);
      if (me) this.emit('ready', me);
    });
    client.on('disconnected', (reason: string) => {
      if (this.stopping) return;
      const r = String(reason || 'onbekend');
      this.emit('disconnected', r, /LOGOUT|UNPAIRED/i.test(r));
    });
    client.on('change_state', (state: string) => {
      if (!this.stopping && /CONFLICT|TIMEOUT/.test(String(state))) this.o.log(`WhatsApp-status: ${state}`);
    });
    client.on('message_create', async (m: any) => {
      try {
        const msg = await mapWwebjsMessage(m, { meIds: this.meIds, phoneOf: (j) => this.phoneOf(j), chatTitle: (c) => this.chatTitle(c) });
        if (msg) this.emit('message', msg);
      } catch (e: any) {
        this.o.log(`Bericht lezen mislukt: ${e?.message || e}`);
      }
    });
    this.starting = client.initialize();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
    if (this.stopping) {
      // stop() came while the browser was still launching: make sure it does not linger.
      await client.destroy().catch(() => {});
      return;
    }
    client.pupBrowser?.on?.('disconnected', () => {
      if (!this.stopping) this.emit('disconnected', 'browser gesloten', false);
    });
  }

  private async readMe(): Promise<WaMe> {
    const wid = this.client.info?.wid;
    const jid = ser(wid);
    this.meIds = new Set([jid].filter(Boolean));
    let phone = phoneDigits(jid);
    try {
      const [r] = await this.client.getContactLidAndPhone([jid]);
      if (r?.lid) this.meIds.add(String(r.lid));
      if (r?.pn) {
        this.meIds.add(String(r.pn));
        phone = phone || phoneDigits(r.pn);
      }
    } catch {
      /* older WhatsApp Web builds: phone jid only */
    }
    return { jid, phone, name: String(this.client.info?.pushname || '') };
  }

  private async phoneOf(jid: string): Promise<string | null> {
    if (!jid.endsWith('@lid')) return phoneDigits(jid) || null;
    if (this.lidCache.has(jid)) return this.lidCache.get(jid)!;
    let pn: string | null = null;
    try {
      const [r] = await this.client.getContactLidAndPhone([jid]);
      pn = phoneDigits(r?.pn) || null;
    } catch {
      pn = null;
    }
    if (this.lidCache.size > 2000) this.lidCache.clear();
    this.lidCache.set(jid, pn);
    return pn;
  }

  private async chatTitle(chatId: string): Promise<string | undefined> {
    if (this.titleCache.has(chatId)) return this.titleCache.get(chatId);
    const chat = await this.client.getChatById(chatId);
    const t = String(chat?.name || '') || undefined;
    if (t) this.titleCache.set(chatId, t);
    return t;
  }

  private clearTimers() {
    if (this.backupTimer) clearInterval(this.backupTimer);
    if (this.firstBackup) clearTimeout(this.firstBackup);
    this.backupTimer = this.firstBackup = null;
  }

  async stop() {
    this.stopping = true;
    this.clearTimers();
    // Still launching (no browser handle yet): wait briefly so the browser that is coming up gets closed too.
    if (this.starting && !this.client?.pupBrowser) await Promise.race([this.starting.catch(() => {}), new Promise((r) => setTimeout(r, 15_000))]);
    try {
      await this.client?.destroy();
    } catch {
      /* browser already gone */
    }
    // Browser closed: the profile files are released. Keep only the encrypted archive.
    // Not connected this time: the archive stays the source of truth, except for a crash-recovered profile that is
    // newer than the archive and could not be re-encrypted yet (keep it once more rather than lose session keys).
    if (this.authed) {
      this.backup('afsluiten');
      if (this.store.hasBackup()) this.store.wipeProfile();
    } else if (this.restoredFrom !== 'profile' || !this.store.hasBackup()) this.store.wipeProfile();
  }

  async logout() {
    this.stopping = true;
    this.clearTimers();
    try {
      if (this.client?.pupPage) await this.client.logout();
    } catch {
      /* not linked or browser gone: wipe locally anyway */
    }
    try {
      await this.client?.destroy();
    } catch {
      /* ignore */
    }
    this.authed = false;
    this.store.wipeAll();
  }

  async requestPairingCode(phone: string) {
    if (!this.client?.pupPage) throw new ChannelError('WhatsApp is nog niet gestart');
    return String(await this.client.requestPairingCode(phoneDigits(phone), true));
  }

  async sendText(chatId: string, text: string) {
    const r = await this.client.sendMessage(chatId, text, { linkPreview: false });
    return String(r?.id?.id || '');
  }

  async sendFile(chatId: string, f: WaOutFile, caption?: string) {
    const mod: any = await import('whatsapp-web.js');
    const wa = mod.default ?? mod;
    const media = wa.MessageMedia.fromFilePath(f.path);
    media.filename = f.name;
    media.mimetype = f.mime || media.mimetype;
    const asImage = /^image\/(jpeg|png|webp)$/.test(f.mime);
    const r = await this.client.sendMessage(chatId, media, { caption: caption || undefined, sendMediaAsDocument: !asImage });
    return String(r?.id?.id || '');
  }

  async typing(chatId: string) {
    const chat = await this.client.getChatById(chatId);
    await chat?.sendStateTyping?.();
  }

  /** whatsapp-web.js `client.sendReaction(serializedId, emoji)` ('' removes the reaction). */
  async react(messageKey: string, emoji: string) {
    if (typeof this.client?.sendReaction !== 'function') return;
    await this.client.sendReaction(messageKey, emoji);
  }

  async resolveNumber(phone: string) {
    const r = await this.client.getNumberId(phoneDigits(phone));
    return r ? ser(r) : null;
  }
}
