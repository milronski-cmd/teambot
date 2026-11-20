import crypto from 'node:crypto';
import type { Request } from 'express';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { simpleParser } from 'mailparser';
import type { Ctx } from '../../core/types.js';
import { ah, bad, str, user } from '../../core/http.js';
import { htmlToMarkdown } from '../../tools/builtin/web.js';
import { emailAdapter, friendlyMailError } from '../channels/adapters/email.js';

/**
 * The owner's other mailboxes: any mail address he reads and writes from himself (a second Gmail, an address at his
 * own domain, a provider's mailbox), next to the one of his Google account. A mailbox is an address with its (app)
 * password; TeamBot finds the servers itself. It is read and written straight over IMAP and SMTP: nothing is copied
 * into TeamBot, and nothing is forwarded. The dashboard shows them under Post; a bot reaches them through TeamBot's
 * own API (reading freely, sending on the owner's word as every change).
 *
 * This is not the e-mail channel (modules/channels): that one gives a bot an address of its own and turns every new
 * mail into a conversation. A mailbox here stays the owner's: mail is only marked read when it is opened.
 */

const NAME = 'mcp.mailboxes';
const MAX_BOXES = 12;

export interface Mailbox {
  id: string;
  address: string;
  fromName: string;
  username: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  password: string;
}

export interface MailRow {
  id: string;
  thread: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  unread: boolean;
  snippet: string;
}
export interface MailFull extends MailRow {
  cc?: string;
  messageId?: string;
  references?: string;
  attachments: string[];
  body: string;
}
export interface MailOut {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}
type Folder = 'inbox' | 'sent';

const addr = (l: any): string =>
  (Array.isArray(l) ? l : l ? [l] : [])
    .map((a: any) => (a?.name && a?.address ? `${a.name} <${a.address}>` : a?.address || a?.name || ''))
    .filter(Boolean)
    .join(', ');

function client(b: Mailbox) {
  const c = new ImapFlow({ host: b.imapHost, port: b.imapPort, secure: b.imapSecure, auth: { user: b.username, pass: b.password }, logger: false, emitLogs: false, disableAutoIdle: true, connectionTimeout: 30_000, tls: { minVersion: 'TLSv1.2' } });
  c.on('error', () => {});
  return c;
}

async function withImap<T>(b: Mailbox, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = client(b);
  try {
    await c.connect();
  } catch (e) {
    throw bad(friendlyMailError(e, 'IMAP').message);
  }
  try {
    return await fn(c);
  } finally {
    await c.logout().catch(() => {});
  }
}

/** The folder with what was sent: the one the server marks so, else the usual names. */
async function folderOf(c: ImapFlow, which: Folder): Promise<string> {
  if (which === 'inbox') return 'INBOX';
  const all = await c.list();
  const hit = all.find((m: any) => m.specialUse === '\\Sent') || all.find((m: any) => /^(sent|sent items|sent mail|sent messages|verzonden|verzonden items|verzonden berichten)$/i.test(String(m.name || '')));
  if (!hit) throw bad('Dit postvak heeft geen map met verzonden mail.');
  return hit.path;
}

const transport = (b: Mailbox) => nodemailer.createTransport({ host: b.smtpHost, port: b.smtpPort, secure: b.smtpSecure, requireTLS: !b.smtpSecure, auth: { user: b.username, pass: b.password }, connectionTimeout: 30_000, tls: { minVersion: 'TLSv1.2' } });

/** The network side, swappable for tests (no mail server in unit tests). */
export const mailboxIo = {
  /** Can TeamBot log in to read and to send? Throws with what to check. */
  async check(b: Mailbox): Promise<void> {
    await withImap(b, async (c) => void (await c.mailboxOpen('INBOX', { readOnly: true })));
    try {
      await transport(b).verify();
    } catch (e) {
      throw bad(friendlyMailError(e, 'SMTP').message);
    }
  },

  async list(b: Mailbox, which: Folder, query: string, limit: number): Promise<MailRow[]> {
    return withImap(b, async (c) => {
      const lock = await c.getMailboxLock(await folderOf(c, which), { readOnly: true });
      try {
        const found = await c.search(query ? { or: [{ from: query }, { to: query }, { subject: query }, { body: query }] } : { all: true }, { uid: true });
        const uids = (Array.isArray(found) ? found : []).slice(-limit);
        if (!uids.length) return [];
        const rows: MailRow[] = [];
        for await (const m of c.fetch(uids.join(','), { uid: true, envelope: true, flags: true, bodyParts: ['1'] }, { uid: true })) {
          const e: any = m.envelope || {};
          const part = m.bodyParts?.get('1');
          const text = part ? part.toString('utf8') : '';
          rows.push({
            id: `${which}:${m.uid}`,
            thread: '',
            from: addr(e.from),
            to: addr(e.to),
            subject: String(e.subject || ''),
            date: e.date ? new Date(e.date).toISOString() : '',
            unread: which === 'inbox' && !m.flags?.has('\\Seen'),
            // The first part as it lies on the server (not decoded): good enough for one line when it is plain text.
            snippet: /<html|<div|<table|^[A-Za-z0-9+/=\s]{120,}$/i.test(text.slice(0, 400)) ? '' : text.replace(/=\r?\n/g, '').replace(/\s+/g, ' ').trim().slice(0, 160),
          });
        }
        return rows.sort((x, y) => Number(y.id.split(':')[1]) - Number(x.id.split(':')[1]));
      } finally {
        lock.release();
      }
    });
  },

  async read(b: Mailbox, which: Folder, uid: number): Promise<MailFull> {
    return withImap(b, async (c) => {
      const lock = await c.getMailboxLock(await folderOf(c, which));
      try {
        const m = await c.fetchOne(String(uid), { uid: true, source: true, flags: true }, { uid: true });
        if (!m || !m.source) throw bad('Deze mail is er niet meer.');
        const p = await simpleParser(m.source);
        if (which === 'inbox' && !m.flags?.has('\\Seen')) await c.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }).catch(() => {});
        const body = p.text && p.text.trim() ? p.text : p.html ? htmlToMarkdown(String(p.html)) : '';
        const refs = Array.isArray(p.references) ? p.references.join(' ') : String(p.references || '');
        return {
          id: `${which}:${uid}`,
          thread: '',
          from: p.from?.text || '',
          to: (Array.isArray(p.to) ? p.to.map((x) => x.text).join(', ') : p.to?.text) || '',
          cc: (Array.isArray(p.cc) ? p.cc.map((x) => x.text).join(', ') : p.cc?.text) || undefined,
          subject: p.subject || '',
          date: p.date ? p.date.toISOString() : '',
          unread: false,
          snippet: body.replace(/\s+/g, ' ').trim().slice(0, 160),
          messageId: p.messageId || undefined,
          references: [refs, p.messageId || ''].join(' ').trim() || undefined,
          attachments: (p.attachments || []).map((a) => a.filename || 'bijlage').slice(0, 30),
          body: body.slice(0, 100_000),
        };
      } finally {
        lock.release();
      }
    });
  },

  async send(b: Mailbox, o: MailOut): Promise<string> {
    const mail = {
      from: b.fromName ? { name: b.fromName, address: b.address } : b.address,
      to: o.to,
      cc: o.cc || undefined,
      subject: o.subject,
      text: o.body,
      inReplyTo: o.inReplyTo || undefined,
      references: o.references || o.inReplyTo || undefined,
      messageId: `<${crypto.randomUUID()}@${b.address.split('@')[1]}>`,
    };
    const raw: Buffer = await new MailComposer(mail).compile().build();
    try {
      await transport(b).sendMail({ envelope: { from: b.address, to: [o.to, o.cc || ''].join(',').match(/[^\s<>,;"]+@[^\s<>,;"]+/g) || [] }, raw });
    } catch (e) {
      throw bad(friendlyMailError(e, 'SMTP').message);
    }
    // Gmail and Outlook keep what goes out over their SMTP themselves; elsewhere TeamBot lays it in Verzonden.
    if (!/gmail\.com$|office365\.com$|outlook\.com$/i.test(b.smtpHost))
      await withImap(b, async (c) => void (await c.append(await folderOf(c, 'sent'), raw, ['\\Seen']))).catch(() => {});
    return mail.messageId;
  },
};

export function mailboxes(ctx: Ctx, userId: string): Mailbox[] {
  try {
    const l = JSON.parse(ctx.secrets.getByName(userId, NAME) || '[]');
    return Array.isArray(l) ? l : [];
  } catch {
    return [];
  }
}

const view = (b: Mailbox) => ({ id: b.id, address: b.address, fromName: b.fromName, server: b.imapHost });
const PRESET: Record<string, string> = { 'gmail.com': 'gmail', 'googlemail.com': 'gmail', 'outlook.com': 'outlook', 'hotmail.com': 'outlook', 'live.com': 'outlook', 'live.nl': 'outlook', 'hotmail.nl': 'outlook', 'msn.com': 'outlook', 'outlook.nl': 'outlook' };

export function registerMailboxes(ctx: Ctx) {
  const api = ctx.api;
  const save = (userId: string, l: Mailbox[]) => void ctx.secrets.set(userId, NAME, JSON.stringify(l));
  const box = (req: Request): Mailbox => {
    const b = mailboxes(ctx, user(req).id).find((x) => x.id === req.params.id);
    if (!b) throw bad('Dit postvak is niet gekoppeld.');
    return b;
  };
  const folder = (v: any): Folder => (v === 'sent' ? 'sent' : 'inbox');

  api.get('/mcp/mailboxes', ah(async (req) => ({ boxes: mailboxes(ctx, user(req).id).map(view) })));

  /** Connect a mailbox: the address and its (app) password; the servers only when TeamBot cannot find them. */
  api.post(
    '/mcp/mailboxes',
    ah(async (req) => {
      const u = user(req);
      const all = mailboxes(ctx, u.id);
      const address = str(req.body?.address, 320).trim().toLowerCase();
      const password = str(req.body?.password, 500);
      if (!password) throw bad('Vul het wachtwoord of app-wachtwoord van dit postvak in.');
      if (all.some((b) => b.address === address)) throw bad('Dit postvak is al gekoppeld.');
      if (all.length >= MAX_BOXES) throw bad(`Je kunt ${MAX_BOXES} postvakken koppelen.`);
      const own = str(req.body?.imapHost, 253).trim();
      const cfg: any = await emailAdapter.validate!(
        { address, username: str(req.body?.username, 320).trim() || undefined, fromName: str(req.body?.fromName, 80).trim(), ...(own ? { preset: 'custom', imapHost: own, imapPort: req.body?.imapPort, smtpHost: str(req.body?.smtpHost, 253).trim() || own, smtpPort: req.body?.smtpPort, smtpSecure: Number(req.body?.smtpPort) !== 587 } : { preset: PRESET[address.split('@')[1] || ''] || 'auto' }) },
        { role: u.role } as any,
      );
      const b: Mailbox = { id: `mb_${crypto.randomBytes(8).toString('hex')}`, address: cfg.address, fromName: cfg.fromName, username: cfg.username, imapHost: cfg.imapHost, imapPort: cfg.imapPort, imapSecure: cfg.imapSecure, smtpHost: cfg.smtpHost, smtpPort: cfg.smtpPort, smtpSecure: cfg.smtpSecure, password };
      await mailboxIo.check(b);
      save(u.id, [...all, b]);
      ctx.audit(u.id, 'mcp.mailbox.added', { address: b.address });
      return { boxes: mailboxes(ctx, u.id).map(view) };
    }),
  );

  api.delete(
    '/mcp/mailboxes/:id',
    ah(async (req) => {
      const u = user(req);
      const b = box(req);
      save(u.id, mailboxes(ctx, u.id).filter((x) => x.id !== b.id));
      ctx.audit(u.id, 'mcp.mailbox.removed', { address: b.address });
      return { boxes: mailboxes(ctx, u.id).map(view) };
    }),
  );

  /** The newest mail of one mailbox (what came in, or what went out), or what a search finds. */
  api.get(
    '/mcp/mailboxes/:id/mail',
    ah(async (req) => ({ messages: await mailboxIo.list(box(req), folder(req.query.box), str(req.query.q, 200).trim(), Math.min(25, Math.max(1, Number(req.query.limit) || 15))) })),
  );

  api.get(
    '/mcp/mailboxes/:id/mail/:mid',
    ah(async (req) => {
      const [which, uid] = str(req.params.mid, 40).split(':');
      if (!/^\d+$/.test(uid || '')) throw bad('Onbekende mail.');
      return mailboxIo.read(box(req), folder(which), Number(uid));
    }),
  );

  /** A mail from this address: an answer (with what it answers) or a new one. */
  api.post(
    '/mcp/mailboxes/:id/mail/send',
    ah(async (req) => {
      const b = box(req);
      const to = str(req.body?.to, 500).trim();
      const body = str(req.body?.body, 100_000);
      if (!/\S+@\S+\.\S+/.test(to)) throw bad('Vul een e-mailadres in.');
      if (!body.trim()) throw bad('Het bericht is leeg.');
      const id = await mailboxIo.send(b, { to, cc: str(req.body?.cc, 500).trim() || undefined, subject: str(req.body?.subject, 400).trim(), body, inReplyTo: str(req.body?.inReplyTo, 400) || undefined, references: str(req.body?.references, 4000) || undefined });
      ctx.audit(user(req).id, 'mcp.mailbox.mail_sent', { from: b.address, to: to.slice(0, 120), reply: !!req.body?.inReplyTo });
      return { ok: true, id };
    }),
  );
}
