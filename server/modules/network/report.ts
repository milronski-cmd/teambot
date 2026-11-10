import fs from 'node:fs';
import path from 'node:path';
import type { Agent, Ctx } from '../../core/types.js';
import { privacyLabel, worse, type PrivacyLabel } from './privacy.js';
import { currentProxy } from './proxy.js';
import type { ExposureReport } from './exposure.js';
import { searchSettings } from '../../tools/builtin/web.js';

/** "Wat verlaat je pc?": per bot which engine gets what, other outgoing traffic, and where the keys are. */

export interface EngineView {
  role: 'main' | 'reserve';
  providerId: string;
  provider: string;
  kind: string;
  kindLabel: string;
  model: string;
  privacy: PrivacyLabel;
}

export interface AgentPrivacy {
  agentId: string;
  name: string;
  engines: EngineView[];
  /** The main engine's label (null: the bot has no engine yet). */
  main: PrivacyLabel | null;
  /** The worst label over the main engine and its reserves. */
  worst: PrivacyLabel | null;
}

export function engineView(ctx: Ctx, role: EngineView['role'], providerId: string, model: string): EngineView | null {
  const cfg = ctx.providers.config(providerId);
  if (!cfg) return null;
  const k = ctx.providers.kind(cfg.kind);
  const billing = (cfg.config?.billing as any) || undefined;
  return {
    role,
    providerId: cfg.id,
    provider: cfg.name,
    kind: cfg.kind,
    kindLabel: k?.label || cfg.kind,
    model,
    privacy: privacyLabel(cfg.kind, model || k?.defaultModel || '', { baseUrl: cfg.base_url || k?.baseUrl || '', billing, providerLabel: k?.label || cfg.name }),
  };
}

function reserves(agent: Agent): { provider_id: string; model: string }[] {
  const raw: any[] = Array.isArray(agent.settings?.fallbacks) ? agent.settings.fallbacks : agent.fallback ? [agent.fallback] : [];
  return raw.filter((f) => typeof f?.provider_id === 'string' && f.provider_id).slice(0, 5).map((f) => ({ provider_id: f.provider_id, model: typeof f.model === 'string' ? f.model : '' }));
}

export function agentPrivacy(ctx: Ctx, agent: Agent): AgentPrivacy {
  const engines: EngineView[] = [];
  if (agent.provider_id) {
    const e = engineView(ctx, 'main', agent.provider_id, agent.model);
    if (e) engines.push(e);
  }
  for (const f of reserves(agent)) {
    const e = engineView(ctx, 'reserve', f.provider_id, f.model);
    if (e) engines.push(e);
  }
  const main = engines.find((e) => e.role === 'main')?.privacy || null;
  const worst = engines.reduce<PrivacyLabel | null>((w, e) => (w ? worse(w, e.privacy) : e.privacy), null);
  return { agentId: agent.id, name: agent.name, engines, main, worst };
}

/** Where the master key of the encrypted vault lives, in words. */
export function keyStorage(dataDir: string, env: NodeJS.ProcessEnv = process.env): { kind: string; text: string } {
  const has = (f: string) => fs.existsSync(path.join(dataDir, f));
  const base = 'Sleutels, tokens en wachtwoorden staan versleuteld (AES-256-GCM) in de database van TeamBot en komen nooit in gesprekken, logboeken, exports of foutmeldingen.';
  if (env.TEAMBOT_MASTER_KEY) return { kind: 'env', text: `${base} De hoofdsleutel komt uit TEAMBOT_MASTER_KEY (bijvoorbeeld uit een kluis van je server).` };
  if (has('master.key.dpapi')) return { kind: 'dpapi', text: `${base} De hoofdsleutel is beveiligd met Windows (DPAPI): alleen jouw Windows-account op deze pc kan hem openen. Een gekopieerde datamap is zonder dat account onleesbaar.` };
  if (has('master.key.keychain')) return { kind: 'keychain', text: `${base} De hoofdsleutel staat in de sleutelhanger van macOS.` };
  if (has('master.key.secret-service')) return { kind: 'secret-service', text: `${base} De hoofdsleutel staat in de kluis van je Linux-bureaublad.` };
  if (has('master.key')) return { kind: 'file', text: `${base} De hoofdsleutel staat in het bestand master.key in de datamap, alleen leesbaar voor jouw gebruiker. Wie de hele datamap kan kopiëren, kan de sleutels ook lezen.` };
  return { kind: 'unknown', text: base };
}

/** Other traffic that can leave the pc for this user (the page puts it in words, with plural forms per language). */
export interface Outgoing {
  /** Instellingen › Zoeken: `auto` (the free chain), or the source chosen first. */
  search: 'auto' | 'keenable' | 'parallel' | 'tavily' | 'exa' | 'duckduckgo' | 'brave' | 'searxng' | string;
  /** Pages TeamBot cannot read itself go to Jina Reader (switched on by the user). */
  jinaReader: boolean;
  channels: number;
  appsRemote: number;
  appsLocal: number;
  push: number;
  sites: number;
  /** host:port of the outgoing proxy, when one is active. */
  proxy: string | null;
  /** Never anything: TeamBot has no telemetry and no public share links. */
  telemetry: false;
  shareLinks: false;
}

const count = (ctx: Ctx, sql: string, ...p: any[]): number => {
  try {
    return Number(ctx.store.one<{ n: number }>(sql, ...p)?.n || 0);
  } catch {
    return 0; // module (table) not loaded
  }
};

export function outgoing(ctx: Ctx, userId: string): Outgoing {
  const search = searchSettings(ctx, userId);
  return {
    search: search.choice,
    jinaReader: search.jinaReader,
    channels: count(ctx, 'SELECT COUNT(*) AS n FROM channel_bindings WHERE user_id = ? AND enabled = 1', userId),
    appsRemote: count(ctx, "SELECT COUNT(*) AS n FROM mcp_connections WHERE user_id = ? AND enabled = 1 AND transport != 'stdio'", userId),
    appsLocal: count(ctx, "SELECT COUNT(*) AS n FROM mcp_connections WHERE user_id = ? AND enabled = 1 AND transport = 'stdio'", userId),
    push: count(ctx, 'SELECT COUNT(*) AS n FROM mobile_push_subs WHERE user_id = ?', userId),
    sites: count(ctx, "SELECT COUNT(*) AS n FROM sites WHERE user_id = ? AND status = 'live'", userId),
    proxy: currentProxy()?.label || null,
    telemetry: false,
    shareLinks: false,
  };
}

export function gatewayView(ctx: Ctx): { enabled: boolean; running: boolean; bind: string | null; port: number | null } | null {
  const m = ctx.services.mobile?.instance;
  if (!m) return null;
  try {
    const s = m.gatewaySettings();
    return { enabled: !!s.enabled, running: !!m.gateway.state.running, bind: s.bind || null, port: m.gateway.state.port ?? null };
  } catch {
    return null;
  }
}

/** The startup report plus what changed since (the phone gateway can be switched on while TeamBot runs). */
export function exposureOf(ctx: Ctx): (ExposureReport & { gateway: ReturnType<typeof gatewayView> }) | null {
  const base = ctx.services.exposure as ExposureReport | undefined;
  if (!base) return null;
  const gateway = gatewayView(ctx);
  const findings = [...base.findings];
  if (gateway?.running && gateway.bind === 'all')
    findings.push({
      level: 'warn',
      code: 'gateway-lan',
      message: 'Telefoon-toegang staat open op al je netwerken via gewone http: op wifi kan iemand meekijken.',
      fix: 'Kies in Instellingen › Telefoon voor Tailscale (versleuteld, ook onderweg) of zet de telefoon-toegang alleen op je Tailscale-adres.',
    });
  return { ...base, findings, gateway };
}
