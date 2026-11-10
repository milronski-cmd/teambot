import net from 'node:net';
import type { Config } from '../../core/config.js';

/**
 * Exposure check at startup (0.4, package P: "alles wat de pc verlaat staat standaard uit").
 *
 * TeamBot listens on 127.0.0.1 unless the owner explicitly chooses otherwise (TEAMBOT_HOST / --host). Before the
 * server binds, createApp() runs checkExposure(): an unsafe combination is refused (the server does not start) or
 * reported loudly (log + the "Wat verlaat je pc?" page for admins). TeamBot never forwards to Ollama or other local
 * services: the only listeners are the app itself, the opt-in phone gateway (device tokens only) and opt-in sites.
 *
 * Refused:
 *  - desktop mode on a non-loopback address. Desktop mode has a password-less owner (local token); the network may
 *    only reach it through the phone gateway or Tailscale. Override for experts: TEAMBOT_UNSAFE_EXPOSE=1 (warning).
 * Warned:
 *  - server mode reachable from the network without https (TEAMBOT_PUBLIC_URL is not https://): passwords and chats
 *    travel unencrypted unless a https proxy or Tailscale sits in front.
 *  - sign-up without an invite (TEAMBOT_ALLOW_SIGNUP=1): anyone who reaches the server can make an account.
 *  - TEAMBOT_TRUST_PROXY set to "everything" while reachable from the network (X-Forwarded-For can be forged, so the
 *    per-address limits on logins and pairing codes stop working).
 * Info:
 *  - a fresh server (no owner yet): creating the owner from another device needs the one-time setup code that
 *    TeamBot prints at startup (core Auth.setupCode), so nobody on the network can claim it first.
 */

export type FindingLevel = 'refuse' | 'warn' | 'info';

export interface ExposureFinding {
  level: FindingLevel;
  code: 'desktop-exposed' | 'no-https' | 'open-signup' | 'trust-proxy-all' | 'setup-locked' | 'gateway-lan';
  message: string;
  fix: string;
}

export interface ExposureInput {
  mode: Config['mode'];
  host: string;
  publicUrl: string;
  allowSignup: boolean;
  /** Accounts that exist (0 = a fresh server whose owner is not made yet). */
  users: number;
  /** TEAMBOT_SETUP_TOKEN is set (managed cloud / unattended install). */
  setupToken: boolean;
  trustProxy: string;
  /** TEAMBOT_UNSAFE_EXPOSE=1: the owner insists on exposing desktop mode (refusal becomes a warning). */
  unsafeOverride: boolean;
}

export interface ExposureReport {
  host: string;
  mode: Config['mode'];
  /** Only this computer can connect. */
  loopbackOnly: boolean;
  /** The public address is https (TLS in front of TeamBot). */
  https: boolean;
  findings: ExposureFinding[];
  checkedAt: string;
}

export class ExposureRefusedError extends Error {
  code = 'exposure_refused';
  constructor(public findings: ExposureFinding[]) {
    super(findings.map((f) => `${f.message} ${f.fix}`).join('\n'));
  }
}

/** True when an address or host name only reaches this computer. */
export function isLoopbackHost(host: string | null | undefined): boolean {
  let h = String(host || '').trim().toLowerCase();
  if (h.startsWith('[') && h.includes(']')) h = h.slice(1, h.indexOf(']'));
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.startsWith('::ffff:')) h = h.slice(7);
  if (net.isIPv4(h)) return h.split('.')[0] === '127';
  if (net.isIPv6(h)) return h === '::1' || /^0*:0*:0*:0*:0*:0*:0*:0*1$/.test(h);
  return false;
}

const truthy = (v: string | undefined) => v === '1' || v === 'true' || v === 'yes';

export function exposureInput(config: Pick<Config, 'mode' | 'host' | 'publicUrl' | 'allowSignup'>, users: number, env: NodeJS.ProcessEnv = process.env): ExposureInput {
  return {
    mode: config.mode,
    host: config.host,
    publicUrl: config.publicUrl || '',
    allowSignup: !!config.allowSignup,
    users,
    setupToken: !!env.TEAMBOT_SETUP_TOKEN,
    trustProxy: String(env.TEAMBOT_TRUST_PROXY || ''),
    unsafeOverride: truthy(env.TEAMBOT_UNSAFE_EXPOSE),
  };
}

export function checkExposure(i: ExposureInput): ExposureReport {
  const loopbackOnly = isLoopbackHost(i.host);
  const https = /^https:\/\//i.test(i.publicUrl);
  const findings: ExposureFinding[] = [];
  if (i.mode === 'desktop' && !loopbackOnly) {
    findings.push({
      level: i.unsafeOverride ? 'warn' : 'refuse',
      code: 'desktop-exposed',
      message: `De desktopversie van TeamBot luistert alleen op deze computer, niet op ${i.host}: de eigenaar heeft hier geen wachtwoord.`,
      fix: i.unsafeOverride
        ? 'TEAMBOT_UNSAFE_EXPOSE=1 staat aan: TeamBot is nu via het netwerk bereikbaar met alleen het lokale token. Zet dit zo snel mogelijk weer uit.'
        : 'Gebruik voor je telefoon Instellingen › Telefoon (Tailscale), of draai TeamBot in servermodus met accounts en https. Laat TEAMBOT_HOST weg (dan 127.0.0.1).',
    });
  }
  if (i.mode === 'server' && !loopbackOnly && !https) {
    findings.push({
      level: 'warn',
      code: 'no-https',
      message: `TeamBot is via het netwerk bereikbaar (${i.host}) zonder https: wachtwoorden en gesprekken gaan onversleuteld over het netwerk.`,
      fix: 'Zet een https-proxy (Caddy, Traefik, Cloudflare Tunnel) of Tailscale ervoor en zet TEAMBOT_PUBLIC_URL op het https-adres, of laat TeamBot alleen op 127.0.0.1 luisteren.',
    });
  }
  if (i.mode === 'server' && i.allowSignup) {
    findings.push({
      level: 'warn',
      code: 'open-signup',
      message: 'Aanmelden zonder uitnodiging staat aan (TEAMBOT_ALLOW_SIGNUP=1): iedereen die deze server bereikt, kan een account maken.',
      fix: 'Zet TEAMBOT_ALLOW_SIGNUP uit en nodig mensen uit via Instellingen › Gebruikers.',
    });
  }
  if (!loopbackOnly && /^(true|\*|all)$/i.test(i.trustProxy.trim())) {
    findings.push({
      level: 'warn',
      code: 'trust-proxy-all',
      message: 'TEAMBOT_TRUST_PROXY vertrouwt elk doorstuuradres: iemand kan zich dan voordoen als een ander adres en de grenzen op inlogpogingen omzeilen.',
      fix: 'Zet TEAMBOT_TRUST_PROXY op het adres van je eigen proxy (bijvoorbeeld 127.0.0.1 of 172.18.0.0/16).',
    });
  }
  if (i.mode === 'server' && i.users === 0 && !i.setupToken) {
    findings.push({
      level: 'info',
      code: 'setup-locked',
      message: 'Nog geen eigenaar: vanaf een ander apparaat kan het eigenaar-account alleen worden gemaakt met de eenmalige code die TeamBot bij het starten toont.',
      fix: 'Open de link uit het venster van de server (bij Docker: docker compose logs teambot).',
    });
  }
  return { host: i.host, mode: i.mode, loopbackOnly, https, findings, checkedAt: new Date().toISOString() };
}

/** Throws ExposureRefusedError when the report contains a refusal. */
export function assertExposureAllowed(r: ExposureReport): void {
  const refused = r.findings.filter((f) => f.level === 'refuse');
  if (refused.length) throw new ExposureRefusedError(refused);
}
