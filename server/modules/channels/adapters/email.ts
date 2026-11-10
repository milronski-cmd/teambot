import net from 'node:net';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser, type ParsedMail } from 'mailparser';
import { bad } from '../../../core/http.js';
import { assertPublicUrl, htmlToMarkdown } from '../../../tools/builtin/web.js';
import { toPlain } from '../format.js';
import { netReason } from '../net.js';
import { authResultsPass, conversationKey, domainOf, isAutomated, newMessageId, normId, parseIdList, PLUS_TAG_RE, plusTagOf, replyHeaders, stripQuoted } from '../email-util.js';
import { discoverMail } from '../email-auto.js';
import { ChannelError, type AdapterContext, type AdapterDef, type AdapterRuntime, type Conversation, type Outbound } from '../types.js';

export const EMAIL_PRESETS = {
  gmail: { imapHost: 'imap.gmail.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true },
  outlook: { imapHost: 'outlook.office365.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.office365.com', smtpPort: 587, smtpSecure: false },
  transip: { imapHost: 'imap.transip.email', imapPort: 993, imapSecure: true, smtpHost: 'smtp.transip.email', smtpPort: 465, smtpSecure: true },
} as const;

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$|^\d{1,3}(\.\d{1,3}){3}$/i;
const EMAIL_RE = /^[^\s@<>()",;]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}$/i;

async function checkHost(host: string, role: string, label: string) {
  const h = String(host || '').trim().toLowerCase();
  if (!HOST_RE.test(h)) throw bad(`${label}: ongeldige servernaam`);
  // Members may not point TeamBot at private network hosts (SSRF); owners/admins may (own mail server on LAN).
  if (role !== 'owner' && role !== 'admin') await assertPublicUrl(`https://${net.isIP(h) ? h : h}`).catch((e) => {
    throw bad(`${label}: ${e.message}`);
  });
  return h;
}

const port = (v: any, d: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : d;
};

function imapClient(cfg: Record<string, any>, pass: string, idle: boolean) {
  return new ImapFlow({
    host: cfg.imapHost,
    port: cfg.imapPort,
    secure: !!cfg.imapSecure,
    auth: { user: cfg.username, pass },
    logger: false,
    emitLogs: false,
    disableAutoIdle: !idle,
    maxIdleTime: 5 * 60_000,
    connectionTimeout: 30_000,
    tls: { minVersion: 'TLSv1.2' },
  });
}

/** Swappable for tests (no DNS or network in unit tests). */
export const emailDiscovery = { find: (address: string) => discoverMail(address) };

/** Swappable for tests (nodemailer jsonTransport). */
export const emailTransport = { create: (cfg: Record<string, any>, pass: string) => smtpTransport(cfg, pass) };

function smtpTransport(cfg: Record<string, any>, pass: string) {
  return nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: !!cfg.smtpSecure,
    requireTLS: !cfg.smtpSecure,
    auth: { user: cfg.username, pass },
    connectionTimeout: 30_000,
    tls: { minVersion: 'TLSv1.2' },
  });
}

export function friendlyMailError(e: any, side: 'IMAP' | 'SMTP'): ChannelError {
  const msg = String(e?.responseText || e?.response || e?.message || e);
  if (e?.authenticationFailed || e?.code === 'EAUTH' || /AUTHENTICATIONFAILED|Invalid credentials|authentication failed|535/i.test(msg))
    return new ChannelError(`${side}: inloggen geweigerd. Controleer gebruikersnaam en (app-)wachtwoord. Gmail vraagt een app-wachtwoord; Outlook.com staat wachtwoord-login niet meer toe.`, true);
  // The connection itself: in plain words, with what to check (the ports people mix up most).
  const why = netReason(e);
  if (why) {
    const ports = side === 'IMAP' ? 'IMAP is meestal poort 993 met TLS' : 'SMTP is meestal poort 465 met TLS of 587 met STARTTLS (TLS uit)';
    const check = /niet gevonden/.test(why) ? `Controleer de ${side}-server.` : `Controleer de ${side}-server en de poort: ${ports}.`;
    return new ChannelError(`${side}: ${why}. ${check}`);
  }
  return new ChannelError(`${side}: ${msg.slice(0, 300)}`);
}

/** Pure: turn a parsed mail into the fields the framework needs (exported for tests). */
export function mailToInbound(p: Pick<ParsedMail, 'from' | 'subject' | 'text' | 'html' | 'messageId' | 'inReplyTo' | 'references' | 'headers' | 'date' | 'to'> & { cc?: ParsedMail['cc'] }, o: { ownAddress: string; fallbackId: string; lookup: (ids: string[]) => string | null; plus?: boolean }) {
  const from = (p.from?.value?.[0]?.address || '').toLowerCase().trim();
  const fromName = p.from?.value?.[0]?.name || from;
  const headers = p.headers as any;
  const addrs = (v: any) => (Array.isArray(v) ? v : v ? [v] : []).flatMap((a: any) => (a.value || []).map((x: any) => String(x.address || '').toLowerCase())).filter(Boolean);
  const toList: string[] = addrs(p.to);
  // An address per bot (P10): the plus address of this mailbox the mail was sent to (To, Cc, else Delivered-To).
  let plusTag: string | null = null;
  let plusTo: string | null = null;
  if (o.plus) {
    const hdr = (k: string) => {
      const v = headers?.get?.(k);
      return (Array.isArray(v) ? v : v ? [v] : []).map((x: any) => (typeof x === 'string' ? x : x?.text || x?.value?.[0]?.address || '')).flatMap((s: string) => s.match(/[^\s<>,;"]+@[^\s<>,;"]+/g) || []);
    };
    for (const a of [...toList, ...addrs(p.cc), ...hdr('delivered-to'), ...hdr('x-original-to')]) {
      const tag = plusTagOf(a, o.ownAddress);
      if (tag) {
        plusTag = tag;
        plusTo = a.toLowerCase();
        break;
      }
    }
  }
  let automated = isAutomated(headers, from);
  // Your own mail to a bot's plus address is a message to that bot, not TeamBot's own mail (that carries X-TeamBot).
  if (!automated && from && from === o.ownAddress.toLowerCase() && !plusTag) automated = 'eigen adres';
  if (!automated && headers?.get?.('x-teambot')) automated = 'bericht van TeamBot';
  const auth = authResultsPass(headers, from);
  const body = p.text && p.text.trim() ? p.text : p.html ? htmlToMarkdown(String(p.html)) : '';
  const messageId = normId(p.messageId) || o.fallbackId;
  const conv = conversationKey({ messageId, inReplyTo: p.inReplyTo, references: p.references }, o.lookup);
  const subject = (p.subject || '').trim() || '(geen onderwerp)';
  return {
    plusTag,
    plusTo,
    from,
    fromName,
    to: toList,
    subject,
    body,
    stripped: stripQuoted(body),
    messageId,
    conversationId: conv.key,
    newConversation: conv.isNew,
    references: [...parseIdList(p.references as any), messageId].slice(-20),
    automated,
    authenticated: auth.pass,
    authMethod: auth.method,
    date: p.date ? p.date.getTime() : Date.now(),
  };
}

/** E-mail over IMAP (IDLE or polling) + SMTP. Threads follow Message-ID / In-Reply-To / References. */
export const emailAdapter: AdapterDef = {
  id: 'email',
  label: 'E-mail',
  description: 'Mail je bot: nieuwe ongelezen mails in een map worden gesprekken, antwoorden gaan als reply terug. Ook bruikbaar als e-mailtrigger voor routines.',
  needsPublicUrl: () => false,
  approveViaChannel: false,
  maxText: 200_000,
  secretFields: [{ key: 'password', label: 'Wachtwoord of app-wachtwoord', required: true }],
  async validate(input, o) {
    const preset = EMAIL_PRESETS[input.preset as keyof typeof EMAIL_PRESETS];
    let c = preset ? { ...input, ...preset } : input;
    const address = String(c.address || '').trim().toLowerCase();
    if (!EMAIL_RE.test(address)) throw bad('Vul het e-mailadres van de bot in.');
    // "auto" (the quick form: only an address and a password): TeamBot finds the servers itself.
    if (c.preset === 'auto') {
      const found = await emailDiscovery.find(address);
      if (!found) throw bad(`TeamBot vond de mailservers van ${address.split('@')[1]} niet. Vul ze in onder Meer opties (IMAP- en SMTP-server).`);
      const { provider: _p, via: _v, ...servers } = found;
      c = { ...c, ...servers, preset: 'custom' };
    }
    const username = String(c.username || address).trim();
    const folder = String(c.folder || 'INBOX').trim().slice(0, 200) || 'INBOX';
    return {
      preset: ['gmail', 'outlook', 'transip', 'custom'].includes(c.preset) ? c.preset : 'custom',
      address,
      username,
      fromName: String(c.fromName || '').slice(0, 80),
      imapHost: await checkHost(c.imapHost, o.role, 'IMAP-server'),
      imapPort: port(c.imapPort, 993),
      imapSecure: c.imapSecure !== false,
      smtpHost: await checkHost(c.smtpHost, o.role, 'SMTP-server'),
      smtpPort: port(c.smtpPort, 465),
      smtpSecure: c.smtpSecure !== false,
      folder,
      idle: c.idle !== false,
      pollSeconds: Math.min(3600, Math.max(30, Number(c.pollSeconds) || 120)),
      markSeen: c.markSeen !== false,
      requireAuth: c.requireAuth !== false,
      chat: c.chat !== false,
      emitToRoutines: c.emitToRoutines !== false,
      // An address per bot (P10): mail to you+baas@… goes to Baas; answers come from that address when allowed.
      plusAddressing: c.plusAddressing === true,
      replyFromPlus: c.replyFromPlus !== false,
      plusTags: Object.fromEntries(
        Object.entries(c.plusTags && typeof c.plusTags === 'object' ? c.plusTags : {})
          .map(([k, v]) => [String(k).slice(0, 60), String(v || '').trim().toLowerCase()] as const)
          .filter(([k, v]) => /^[\w-]{1,60}$/.test(k) && PLUS_TAG_RE.test(v))
          .slice(0, 100),
      ),
    };
  },
  async test(ctx) {
    const cfg = ctx.binding().config;
    const pass = ctx.secret('password') || '';
    const client = imapClient(cfg, pass, false);
    client.on('error', () => {});
    let n = 0;
    try {
      await client.connect();
      const box = await client.mailboxOpen(cfg.folder || 'INBOX', { readOnly: true });
      n = box.exists;
    } catch (e: any) {
      const err = friendlyMailError(e, 'IMAP');
      if (/mailbox|folder|NONEXISTENT/i.test(String(e?.responseText || e?.message))) return { ok: false, detail: `IMAP: map “${cfg.folder}” niet gevonden` };
      return { ok: false, detail: err.message };
    } finally {
      await client.logout().catch(() => client.close());
    }
    try {
      await smtpTransport(cfg, pass).verify();
    } catch (e) {
      return { ok: false, detail: `IMAP OK, maar ${friendlyMailError(e, 'SMTP').message}` };
    }
    return { ok: true, detail: n === 1 ? `IMAP OK (1 bericht in ${cfg.folder || 'INBOX'}) · SMTP OK` : `IMAP OK (${n} berichten in ${cfg.folder || 'INBOX'}) · SMTP OK` };
  },
  receiveHint({ config }) {
    return `Er kwam geen nieuwe, ongelezen mail binnen in de map “${config.folder || 'INBOX'}” van ${config.address}. Kijk of de mail in spam staat of al gelezen is, en of een filter hem naar een andere map verplaatst.${config.requireAuth !== false ? ' Mail zonder geslaagde SPF/DKIM/DMARC wordt niet beantwoord (staat in het logboek).' : ''}`;
  },
  create(ctx) {
    return new EmailRuntime(ctx);
  },
};

class EmailRuntime implements AdapterRuntime {
  private client: ImapFlow | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private again = false;
  private stopped = false;
  constructor(private ctx: AdapterContext) {}

  private cfg() {
    return this.ctx.binding().config;
  }

  async start() {
    const cfg = this.cfg();
    const pass = this.ctx.secret('password');
    if (!pass) throw new ChannelError('Wachtwoord ontbreekt', true);
    const client = imapClient(cfg, pass, cfg.idle !== false);
    this.client = client;
    client.on('error', (e: any) => {
      if (!this.stopped) this.ctx.fail(friendlyMailError(e, 'IMAP'));
    });
    client.on('close', () => {
      if (!this.stopped) this.ctx.fail(new ChannelError('IMAP-verbinding gesloten'));
    });
    client.on('exists', () => this.kick());
    try {
      await client.connect();
    } catch (e) {
      throw friendlyMailError(e, 'IMAP');
    }
    let box;
    try {
      box = await client.mailboxOpen(cfg.folder || 'INBOX');
    } catch (e: any) {
      throw new ChannelError(`IMAP: map “${cfg.folder}” kan niet worden geopend (${String(e?.responseText || e?.message).slice(0, 120)})`, true);
    }
    const st = this.ctx.binding().state || {};
    const uv = String(box.uidValidity);
    // Only mail that arrives after the binding starts is processed (no backlog surprise).
    if (st.uidValidity !== uv) this.ctx.setState({ uidValidity: uv, lastUid: Math.max(0, Number(box.uidNext) - 1) });
    const every = (cfg.idle !== false ? 300 : Number(cfg.pollSeconds) || 120) * 1000;
    this.timer = setInterval(() => this.kick(), every);
    this.timer.unref?.();
    this.kick();
    return 'connected' as const;
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    const c = this.client;
    this.client = null;
    if (c) await c.logout().catch(() => c.close());
  }

  private kick() {
    if (this.stopped) return;
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    this.processNew()
      .catch((e) => this.ctx.log('in', 'error', `Mail ophalen mislukt: ${e?.message || e}`))
      .finally(() => {
        this.busy = false;
        if (this.again) {
          this.again = false;
          this.kick();
        }
      });
  }

  private async processNew() {
    const client = this.client;
    if (!client || this.stopped) return;
    let last = Number(this.ctx.binding().state?.lastUid || 0);
    const found = (await client.search({ uid: `${last + 1}:*`, seen: false }, { uid: true })) || [];
    const maxBytes = Math.min(50, Math.max(1, Number(this.cfg().maxFileMb) || 20)) * 1024 * 1024 + 512 * 1024;
    for (const uid of found.filter((u) => u > last).sort((a, b) => a - b).slice(0, 25)) {
      if (this.stopped) return;
      last = uid;
      this.ctx.setState({ lastUid: uid });
      const msg = await client.fetchOne(String(uid), { uid: true, size: true, source: { maxLength: maxBytes } }, { uid: true });
      if (!msg || !msg.source) continue;
      try {
        await this.handleRaw(msg.source, uid, msg.size || 0);
      } catch (e: any) {
        this.ctx.log('in', 'error', `Mail verwerken mislukt: ${e?.message || e}`);
      }
      if (this.cfg().markSeen !== false) await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }).catch(() => {});
    }
  }

  /** Process one raw RFC 822 message (exposed for tests). */
  async handleRaw(source: Buffer, uid: number, size: number) {
    const cfg = this.cfg();
    const p = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true, maxHtmlLengthToParse: 2_000_000 });
    const st = this.ctx.binding().state || {};
    const m = mailToInbound(p, { ownAddress: cfg.address, fallbackId: `<uid-${st.uidValidity}-${uid}@${cfg.imapHost}>`, lookup: (ids) => this.ctx.conversationForMessageIds(ids), plus: cfg.plusAddressing === true });
    const atts = (p.attachments || [])
      .filter((a) => a.contentDisposition === 'attachment' || !a.related)
      .map((a) => ({ name: a.filename || 'bijlage', mime: a.contentType || 'application/octet-stream', size: a.size, data: a.content }));
    if (cfg.emitToRoutines !== false)
      this.ctx.emitEmail?.({
        userId: this.ctx.binding().user_id,
        bindingId: this.ctx.bindingId,
        bindingName: this.ctx.binding().name,
        messageId: m.messageId,
        from: { address: m.from, name: m.fromName },
        to: m.to,
        subject: m.subject,
        text: m.body.slice(0, 50_000),
        date: new Date(m.date).toISOString(),
        attachments: atts.map((a) => ({ name: a.name, mime: a.mime, size: a.size })),
        authenticated: m.authenticated,
        allowed: !!m.from && this.ctx.isAllowed(m.from),
        automated: !!m.automated,
      });
    if (cfg.chat === false || !m.from) return;
    if (m.automated) {
      this.ctx.log('in', 'ignored', `Automatische mail genegeerd (${m.automated})`, { senderId: m.from });
      return;
    }
    if (cfg.requireAuth !== false && !m.authenticated) {
      this.ctx.log('in', 'blocked', `Afzender niet geverifieerd (${m.authMethod}). Zet “Alleen geverifieerde afzenders” uit als je mailprovider geen Authentication-Results toevoegt.`, { senderId: m.from });
      return;
    }
    const note = size > source.length ? '\n\n[deze mail was te groot en is afgekapt]' : '';
    await this.ctx.receive({
      messageId: m.messageId,
      conversation: { id: m.conversationId, title: m.subject.slice(0, 100), private: true },
      sender: { id: m.from, name: m.fromName },
      text: `Onderwerp: ${m.subject}\n\n${m.stripped}${note}`.slice(0, 20_000),
      attachments: atts,
      date: m.date,
      extra: { address: m.from, subject: m.subject, lastMessageId: m.messageId, references: m.references, unverified: !m.authenticated, ...(m.plusTag ? { plusTag: m.plusTag, plusAddress: m.plusTo } : {}) },
    });
  }

  private transport() {
    return emailTransport.create(this.cfg(), this.ctx.secret('password') || '');
  }

  private from(conv?: Conversation) {
    const cfg = this.cfg();
    // A mail to a bot's plus address is answered from that address, with the bot's name (P10). Gmail and most
    // providers only keep it when it is set up as an address you may send from ("Verzenden als"); else they show the
    // mailbox address, and the mail still arrives.
    const plus = conv?.meta?.plusAddress;
    if (cfg.plusAddressing === true && cfg.replyFromPlus !== false && typeof plus === 'string' && plusTagOf(plus, cfg.address))
      return { name: conv?.meta?.agentName || cfg.fromName || this.ctx.binding().name || 'TeamBot', address: plus };
    return { name: cfg.fromName || this.ctx.binding().name || 'TeamBot', address: cfg.address };
  }

  async send(conv: Conversation, out: Outbound) {
    const cfg = this.cfg();
    const to = conv.meta?.address || (EMAIL_RE.test(conv.external_id) ? conv.external_id : '');
    if (!to) throw new ChannelError('Geen e-mailadres bekend voor dit gesprek');
    const h = replyHeaders({ parentMessageId: conv.meta?.lastMessageId || null, parentReferences: conv.meta?.references || [], subject: conv.meta?.subject || out.subject || 'Bericht', domain: domainOf(cfg.address) });
    try {
      await this.transport().sendMail({
        from: this.from(conv),
        to,
        subject: h.subject,
        text: toPlain(out.text || ''),
        messageId: h.messageId,
        inReplyTo: h.inReplyTo,
        references: h.references,
        headers: { 'Auto-Submitted': 'auto-replied', 'X-TeamBot': 'channel' },
        attachments: (out.files || []).map((f) => ({ filename: f.name, path: f.path, contentType: f.mime })),
      });
    } catch (e) {
      throw friendlyMailError(e, 'SMTP');
    }
    return [h.messageId];
  }

  async sendTo(target: string, out: Outbound) {
    const cfg = this.cfg();
    const to = target.trim().toLowerCase();
    if (!EMAIL_RE.test(to)) throw new ChannelError('Geef een geldig e-mailadres op.');
    const subject = (out.subject || `Bericht van ${this.from().name}`).replace(/[\r\n]+/g, ' ').slice(0, 200);
    const messageId = newMessageId(domainOf(cfg.address));
    try {
      await this.transport().sendMail({
        from: this.from(),
        to,
        subject,
        text: toPlain(out.text || ''),
        messageId,
        headers: { 'Auto-Submitted': 'auto-generated', 'X-TeamBot': 'channel' },
        attachments: (out.files || []).map((f) => ({ filename: f.name, path: f.path, contentType: f.mime })),
      });
    } catch (e) {
      throw friendlyMailError(e, 'SMTP');
    }
    return { conversationId: messageId, title: subject, private: true, ids: [messageId], extra: { address: to, subject, lastMessageId: messageId, references: [] } };
  }
}
