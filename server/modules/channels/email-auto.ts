import dns from 'node:dns/promises';
import net from 'node:net';
import { assertPublicUrl, safeFetch } from '../../tools/builtin/web.js';
import { fetchT } from './net.js';

/**
 * Mail servers from just an address ("koppelen in één keer"): the owner types the address and the password, TeamBot
 * finds IMAP and SMTP itself. In this order: the known providers by domain, the same providers by the MX record of an
 * own domain (Google Workspace, Microsoft 365, TransIP, Hostnet, Strato, one.com …), the SRV records of RFC 6186, the
 * autoconfig file mail programs use (the domain's own, then Mozilla's public list: only the domain name is sent), and
 * last a look at imap./smtp./mail.<domain>. Nothing here ever sees the password.
 */
export interface MailServers {
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
}

export interface MailDiscovery extends MailServers {
  /** Provider name for the screen ("Gmail", "TransIP"); empty when the servers were found another way. */
  provider: string;
  /** How they were found: for the log and tests. */
  via: 'domein' | 'mx' | 'srv' | 'autoconfig' | 'gok';
}

const s = (imapHost: string, smtpHost: string, smtpPort: 465 | 587 = 465): MailServers => ({ imapHost, imapPort: 993, imapSecure: true, smtpHost, smtpPort, smtpSecure: smtpPort === 465 });

interface Known {
  name: string;
  domains?: string[];
  /** Matches the MX host of an own domain hosted at this provider. */
  mx?: RegExp;
  servers: MailServers;
}

/** Checked against each provider's own help pages (2026-11). */
export const MAIL_PROVIDERS: Known[] = [
  { name: 'Gmail', domains: ['gmail.com', 'googlemail.com'], mx: /(^|\.)(google|googlemail)\.com$/, servers: s('imap.gmail.com', 'smtp.gmail.com') },
  { name: 'Outlook', domains: ['outlook.com', 'outlook.nl', 'hotmail.com', 'hotmail.nl', 'live.com', 'live.nl', 'msn.com'], mx: /(^|\.)outlook\.com$/, servers: s('outlook.office365.com', 'smtp.office365.com', 587) },
  { name: 'iCloud', domains: ['icloud.com', 'me.com', 'mac.com'], servers: s('imap.mail.me.com', 'smtp.mail.me.com', 587) },
  { name: 'Yahoo', domains: ['yahoo.com', 'yahoo.nl', 'ymail.com'], mx: /(^|\.)yahoodns\.net$/, servers: s('imap.mail.yahoo.com', 'smtp.mail.yahoo.com') },
  { name: 'Ziggo', domains: ['ziggo.nl', 'home.nl', 'upcmail.nl', 'chello.nl', 'casema.nl', 'quicknet.nl'], servers: s('imap.ziggo.nl', 'smtp.ziggo.nl', 587) },
  { name: 'KPN', domains: ['kpnmail.nl', 'kpnplanet.nl', 'planet.nl', 'hetnet.nl'], servers: s('imap.kpnmail.nl', 'smtp.kpnmail.nl', 587) },
  { name: 'TransIP', mx: /(^|\.)transip\.email$/, servers: s('imap.transip.email', 'smtp.transip.email') },
  { name: 'Hostnet', mx: /(^|\.)hostnet\.nl$/, servers: s('imap.hostnet.nl', 'smtp.hostnet.nl', 587) },
  { name: 'Strato', mx: /(^|\.)rzone\.de$/, servers: s('imap.strato.de', 'smtp.strato.de') },
  { name: 'one.com', mx: /(^|\.)one\.com$/, servers: s('imap.one.com', 'send.one.com') },
  { name: 'Fastmail', domains: ['fastmail.com', 'fastmail.fm'], mx: /(^|\.)messagingengine\.com$/, servers: s('imap.fastmail.com', 'smtp.fastmail.com') },
];

export interface DiscoveryDeps {
  mx(domain: string): Promise<string[]>;
  srv(name: string): Promise<{ name: string; port: number }[]>;
  /** Text of a public https page, or '' when it is not there. */
  text(url: string): Promise<string>;
  /** Does this host accept a connection on this port? */
  open(host: string, port: number): Promise<boolean>;
}

const quiet = <T>(p: Promise<T>, d: T, ms = 5000): Promise<T> => Promise.race([p.catch(() => d), new Promise<T>((r) => setTimeout(() => r(d), ms).unref())]);

export const realDeps: DiscoveryDeps = {
  mx: async (d) => (await dns.resolveMx(d)).sort((a, b) => a.priority - b.priority).map((r) => r.exchange.toLowerCase()),
  srv: async (n) => (await dns.resolveSrv(n)).sort((a, b) => a.priority - b.priority).map((r) => ({ name: r.name.toLowerCase(), port: r.port })),
  text: async (url) => {
    const res = await safeFetch(url, { fetch: (u, init) => fetchT(u.href, { ...init, signal: undefined, timeoutMs: 5000 }) });
    if (!res.ok) return void res.body?.cancel().catch(() => {}), '';
    return (await res.text()).slice(0, 100_000);
  },
  open: async (host, port) => {
    // Never knock on a private address because a domain name says so.
    if (!(await assertPublicUrl(`https://${host}`).then(() => true, () => false))) return false;
    return new Promise<boolean>((resolve) => {
      const sock = net.connect({ host, port, timeout: 3000 });
      const done = (ok: boolean) => (sock.destroy(), resolve(ok));
      sock.once('connect', () => done(true)).once('timeout', () => done(false)).once('error', () => done(false));
    });
  },
};

export const mailDomain = (address: string) => String(address || '').trim().toLowerCase().split('@')[1] || '';

/** The provider of an address by its domain alone (no network): for the one-line hint while typing. */
export function knownByDomain(address: string): Known | null {
  const d = mailDomain(address);
  return (d && MAIL_PROVIDERS.find((p) => p.domains?.includes(d))) || null;
}

/** The servers of Thunderbird's autoconfig XML (first IMAP and first SMTP entry). */
export function parseAutoconfig(xml: string): MailServers | null {
  const block = (tag: string, type: string) => new RegExp(`<${tag}[^>]*type="${type}"[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml)?.[1] || '';
  const read = (b: string) => {
    const host = /<hostname>\s*([a-z0-9.-]+)\s*<\/hostname>/i.exec(b)?.[1]?.toLowerCase();
    const port = Number(/<port>\s*(\d+)\s*<\/port>/i.exec(b)?.[1]);
    const sock = (/<socketType>\s*(\w+)\s*<\/socketType>/i.exec(b)?.[1] || '').toUpperCase();
    return host && port && sock !== 'PLAIN' ? { host, port, secure: sock === 'SSL' } : null;
  };
  const i = read(block('incomingServer', 'imap'));
  const o = read(block('outgoingServer', 'smtp'));
  return i && o ? { imapHost: i.host, imapPort: i.port, imapSecure: i.secure, smtpHost: o.host, smtpPort: o.port, smtpSecure: o.secure } : null;
}

export async function discoverMail(address: string, deps: DiscoveryDeps = realDeps): Promise<MailDiscovery | null> {
  const domain = mailDomain(address);
  if (!domain) return null;
  const known = knownByDomain(address);
  if (known) return { ...known.servers, provider: known.name, via: 'domein' };

  const mx = await quiet(deps.mx(domain), [] as string[]);
  for (const host of mx) {
    const p = MAIL_PROVIDERS.find((k) => k.mx?.test(host));
    if (p) return { ...p.servers, provider: p.name, via: 'mx' };
  }

  const [imaps, subs, sub] = await Promise.all([
    quiet(deps.srv(`_imaps._tcp.${domain}`), []),
    quiet(deps.srv(`_submissions._tcp.${domain}`), []),
    quiet(deps.srv(`_submission._tcp.${domain}`), []),
  ]);
  const real = (r: { name: string; port: number }[]) => r.find((x) => x.name && x.name !== '.' && x.port);
  const out = real(subs) || real(sub);
  if (real(imaps) && out) {
    const i = real(imaps)!;
    return { imapHost: i.name, imapPort: i.port, imapSecure: true, smtpHost: out.name, smtpPort: out.port, smtpSecure: out === real(subs), provider: '', via: 'srv' };
  }

  for (const url of [`https://autoconfig.${domain}/mail/config-v1.1.xml`, `https://autoconfig.thunderbird.net/v1.1/${domain}`]) {
    const found = parseAutoconfig(await quiet(deps.text(url), '', 6000));
    if (found) return { ...found, provider: '', via: 'autoconfig' };
  }

  // Last: the names almost every host uses. The MX host itself is tried too (small hosts run everything on one box).
  const names = [...new Set([`imap.${domain}`, `mail.${domain}`, ...mx.slice(0, 1)])];
  const first = async (hosts: string[], port: number) => {
    const ok = await Promise.all(hosts.map((h) => quiet(deps.open(h, port), false, 4000)));
    return hosts[ok.indexOf(true)] || '';
  };
  const imapHost = await first(names, 993);
  if (!imapHost) return null;
  const smtpNames = [...new Set([`smtp.${domain}`, imapHost, `mail.${domain}`])];
  const smtp465 = await first(smtpNames, 465);
  const smtpHost = smtp465 || (await first(smtpNames, 587));
  if (!smtpHost) return null;
  return { imapHost, imapPort: 993, imapSecure: true, smtpHost, smtpPort: smtp465 ? 465 : 587, smtpSecure: !!smtp465, provider: '', via: 'gok' };
}
