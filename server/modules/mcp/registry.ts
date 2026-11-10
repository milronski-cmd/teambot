import crypto from 'node:crypto';
import type { Ctx } from '../../core/types.js';
import { HttpError } from '../../core/http.js';
import { ICON_MAX_BYTES, acceptableIcon, type IconType } from './icons.js';
import { FIRST_VIEW_BUDGET_MS, WebCache, WebError, isOffline, sharedDeadline, withBudget } from '../skills/webcache.js';
import { categorize, classifyId } from '../skills/licenses.js';
import type { CatalogEntry, CatalogField } from './catalog.js';
import { commandOnPath } from './util.js';

/**
 * The official MCP Registry (registry.modelcontextprotocol.io, API v0.1) as an app source. Records are untrusted
 * input: they are validated strictly and turned into the same catalogue-shaped template the built-in connectors and
 * connector packages use, so a registry install goes through exactly the same rules (stdio trust confirmation,
 * secrets in the vault, read-only test, actions off, risk mapping). TeamBot never starts anything during browsing.
 */

export const REGISTRY_API = 'https://registry.modelcontextprotocol.io/v0.1';
const NAME_RE = /^[a-zA-Z0-9.-]{1,100}\/[a-zA-Z0-9._-]{1,120}$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const VAR_RE = /\{([A-Za-z0-9_.-]{1,64})\}/g;
const HOUR = 3600_000;
/** One registry request never takes longer than this (the cache answers when it can). */
const REGISTRY_TIMEOUT_MS = 10_000;

/**
 * "Aanbevolen": a hand-picked list of well-known servers by their registry name (only the names; all data comes live
 * from the registry). The registry itself has no popularity or categories. Picked (2026-11-07) for a clear licence:
 * the vendor's own hosted server (their terms) or an open-source package under MIT, Apache-2.0, MPL-2.0 or GPL
 * (checked on npm/PyPI/GitHub). Grouped: work, development, search and knowledge, browser and web data, data, cloud.
 */
export const FEATURED = [
  // work and productivity
  'com.notion/mcp',
  'app.linear/linear',
  'com.atlassian/atlassian-mcp-server',
  'com.monday/monday.com',
  'com.airtable/mcp',
  'com.zapier/mcp',
  'com.canva.mcp/mcp',
  'com.figma.mcp/mcp',
  // development
  'io.github.github/github-mcp-server',
  'com.gitlab/mcp',
  'io.github.getsentry/sentry-mcp',
  'com.vercel/vercel-mcp',
  'com.cloudflare.mcp/mcp',
  'com.supabase/mcp',
  'com.neon/mcp',
  'com.postman/postman-mcp-server',
  'com.circleci/mcp',
  'io.github.microsoft/playwright-mcp',
  'io.github.ChromeDevTools/chrome-devtools-mcp',
  'io.github.oraios/serena',
  // search and knowledge
  'com.microsoft/microsoft-learn-mcp',
  'io.github.upstash/context7',
  'io.github.cyanheads/wikipedia-mcp-server',
  'io.github.blazickjp/arxiv-mcp-server',
  'ai.exa/exa',
  'io.github.brave/brave-search-mcp-server',
  'ai.perplexity/mcp-server',
  'io.github.tavily-ai/tavily-mcp',
  'co.huggingface/hf-mcp-server',
  // browser and web data
  'io.github.firecrawl/firecrawl-mcp-server',
  'com.apify/apify-mcp-server',
  'io.github.browserbase/mcp-server-browserbase',
  'io.github.brightdata/brightdata-mcp',
  'io.github.mapbox/mcp-server',
  // payments and websites
  'com.stripe/mcp',
  'com.paypal.mcp/mcp',
  'com.webflow/mcp',
  'com.wix/mcp',
  // data and analytics
  'io.github.mongodb-js/mongodb-mcp-server',
  'io.github.redis/mcp-redis',
  'io.github.ClickHouse/mcp-clickhouse',
  'io.github.PostHog/mcp',
  'io.github.grafana/mcp-grafana',
  'io.github.airbytehq/airbyte',
  'io.github.algolia/algolia-productivity',
  // cloud
  'com.microsoft/azure',
  'com.microsoft/microsoft-fabric',
  'com.googleapis.run/mcp',
  'io.github.hashicorp/terraform-mcp-server',
];

export interface InputField {
  name: string;
  label: string;
  help?: string;
  required: boolean;
  default?: string;
  choices?: string[];
  /** Where the value goes. */
  kind: 'url' | 'arg';
}

export interface InstallOption {
  key: string;
  kind: string;
  label: string;
  transport: 'stdio' | 'http' | 'sse';
  supported: boolean;
  reason?: string;
  runtime?: string;
  commandFound?: boolean;
  identifier?: string;
  version?: string;
  packageUrl?: string;
  url?: string;
  command?: string;
  /** Argument template; `{name}` placeholders are filled from `inputs`. */
  args?: string[];
  inputs: InputField[];
  env: CatalogField[];
  headers: CatalogField[];
  preview: string;
}

export interface RegistryItem {
  name: string;
  title: string;
  description: string;
  version: string;
  status: 'active' | 'deprecated' | 'deleted';
  statusMessage: string;
  publishedAt: string | null;
  updatedAt: string | null;
  isLatest: boolean;
  namespace: string;
  /** Who the namespace was verified for by the registry (GitHub account or domain). */
  publisher: string;
  publisherKind: 'github' | 'domain';
  repository: string | null;
  subfolder: string | null;
  websiteUrl: string | null;
  icon: string | null;
  category: string;
  options: InstallOption[];
  remote: boolean;
  local: boolean;
  featured: boolean;
}

/** Stored on a connection installed from the registry. */
export interface ConnectionRegistry {
  name: string;
  version: string;
  option: string;
  kind: string;
  identifier?: string;
  inputs: Record<string, string>;
  publishedAt?: string | null;
  installedAt: string;
  template: CatalogEntry;
}

const txt = (v: any, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function httpsUrl(v: any, allowVars = false): string | null {
  const s = txt(v, 2000);
  if (!s) return null;
  try {
    const u = new URL(allowVars ? s.replace(VAR_RE, 'x') : s);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    return allowVars ? s : u.href;
  } catch {
    return null;
  }
}

function publisherOf(ns: string): { publisher: string; kind: 'github' | 'domain' } {
  const p = ns.split('.');
  if (p[0] === 'io' && p[1] === 'github' && p[2]) return { publisher: `github.com/${p.slice(2).join('.')}`, kind: 'github' };
  return { publisher: [...p].reverse().join('.'), kind: 'domain' };
}

const GENERIC = new Set(['mcp', 'server', 'mcpserver', 'remote', 'official', 'api']);

/** Display name when the record has no title: the server part of the name, or the organisation for generic names ("com.notion/mcp" → "Notion"). */
function prettify(name: string) {
  const [ns, last = ''] = name.split('/');
  const words = last.split(/[-_.\s]+/).filter(Boolean);
  const meaningful = words.filter((w) => !GENERIC.has(w.toLowerCase()));
  const parts = ns.split('.');
  const org = parts[0] === 'io' && parts[1] === 'github' ? parts.slice(2).join('.') : parts[1] || parts[0];
  const base = meaningful.length ? meaningful : [org];
  return base.map((w) => (/^(ai|mcp|api|sdk|aws|gcp|sql|ui)$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}

/** A registry KeyValueInput (env var or header) as a catalogue field. */
function kvField(x: any, kind: 'env' | 'header'): CatalogField | null {
  const name = txt(x?.name, 128);
  if (!(kind === 'env' ? ENV_RE : HEADER_RE).test(name)) return null;
  const value = txt(x?.value, 500);
  const vars = x?.variables && typeof x.variables === 'object' ? x.variables : {};
  const varNames = [...value.matchAll(VAR_RE)].map((m) => m[1]);
  const secretVar = varNames.some((v) => vars[v]?.isSecret === true);
  const f: CatalogField = { name, label: name, ...(txt(x?.description, 500) ? { help: txt(x.description, 500) } : {}) };
  if (x?.isSecret === true || secretVar) f.secret = true;
  if (x?.isRequired === true || varNames.some((v) => vars[v]?.isRequired === true)) f.required = true;
  // "Bearer {token}" → a secret with a prefix; other templates are shown as help.
  const pre = /^([A-Za-z]+ )\{[A-Za-z0-9_.-]+\}$/.exec(value);
  if (pre) {
    f.prefix = pre[1];
    if (!f.secret && varNames.some((v) => vars[v]?.isSecret !== false)) f.secret = true;
  } else if (value && !varNames.length && !f.secret) f.default = value;
  else if (value && varNames.length) f.help = `${f.help ? f.help + ' ' : ''}Formaat: ${value}`.slice(0, 500);
  if (!f.secret && !f.default && typeof x?.default === 'string') f.default = x.default.slice(0, 500);
  if (typeof x?.placeholder === 'string') f.placeholder = x.placeholder.slice(0, 200);
  return f;
}

/** Turn registry Arguments into argument tokens with {placeholders}; collects the inputs the user has to give. */
function argTokens(list: any, inputs: Map<string, InputField>, origin: string, o: { dockerEnv?: CatalogField[] } = {}): { tokens: string[]; error?: string } {
  const tokens: string[] = [];
  const arr = Array.isArray(list) ? list.slice(0, 40) : [];
  let n = 0;
  for (const a of arr) {
    if (!a || typeof a !== 'object') continue;
    n++;
    const vars = a.variables && typeof a.variables === 'object' ? a.variables : {};
    const secretVar = Object.values<any>(vars).some((v) => v?.isSecret === true);
    if (a.isSecret === true || secretVar) {
      // Secrets never go on a command line. `docker run -e NAME={secret}` becomes `-e NAME` with NAME as a vault-backed
      // environment variable; an optional argument with a secret is left out; a required one makes the option unusable.
      const env = /^([A-Za-z_][A-Za-z0-9_]{0,127})=\{[A-Za-z0-9_.-]+\}$/.exec(typeof a.value === 'string' ? a.value : '');
      if (o.dockerEnv && a.type === 'named' && (a.name === '-e' || a.name === '--env') && env) {
        o.dockerEnv.push({ name: env[1], label: env[1], secret: true, ...(a.isRequired === true ? { required: true } : {}), ...(txt(a.description, 500) ? { help: txt(a.description, 500) } : {}) });
        tokens.push('-e', env[1]);
        continue;
      }
      if (a.isRequired !== true) continue;
      return { tokens, error: 'Deze installatievorm vraagt een geheim als opdrachtregelargument; dat slaat TeamBot niet veilig op. Kies een andere vorm.' };
    }
    let value = typeof a.value === 'string' ? a.value.slice(0, 1000) : typeof a.default === 'string' ? a.default.slice(0, 1000) : '';
    const hint = txt(a.valueHint, 64).replace(/[^A-Za-z0-9_.-]/g, '_') || `${origin}${n}`;
    if (!value && a.isRequired === true) value = `{${hint}}`;
    const needed = [...value.matchAll(VAR_RE)].map((m) => m[1]);
    for (const v of needed) {
      if (inputs.has(v)) continue;
      const meta = vars[v] || (v === hint ? a : {});
      inputs.set(v, {
        name: v,
        label: txt(meta.description, 120) || txt(a.description, 120) || v,
        ...(txt(a.description, 500) ? { help: txt(a.description, 500) } : {}),
        required: meta.isRequired === true || a.isRequired === true,
        ...(typeof meta.default === 'string' ? { default: meta.default.slice(0, 500) } : {}),
        ...(Array.isArray(meta.choices) ? { choices: meta.choices.filter((c: any) => typeof c === 'string').slice(0, 50) } : {}),
        kind: 'arg',
      });
    }
    if (a.type === 'named') {
      const name = txt(a.name, 100);
      if (!/^-{1,2}[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) continue;
      if (value) tokens.push(name, value);
      else if (a.isRequired === true) tokens.push(name);
    } else if (value) tokens.push(value);
  }
  if (tokens.some((t) => /[\0\r\n]/.test(t))) return { tokens, error: 'Ongeldig argument in het register.' };
  return { tokens };
}

function remoteOption(r: any, i: number): InstallOption {
  const transport = r?.type === 'streamable-http' ? 'http' : r?.type === 'sse' ? 'sse' : null;
  const base: InstallOption = { key: `remote:${i}`, kind: 'remote', label: transport === 'sse' ? 'Remote (SSE)' : 'Remote (Streamable HTTP)', transport: transport || 'http', supported: false, inputs: [], env: [], headers: [], preview: '' };
  if (!transport) return { ...base, reason: `Onbekend transport “${txt(r?.type, 40)}”.` };
  const url = httpsUrl(r.url, true);
  if (!url) return { ...base, reason: 'Geen geldig https-adres in het register.' };
  const vars = r.variables && typeof r.variables === 'object' ? r.variables : {};
  const inputs: InputField[] = [...new Set([...url.matchAll(VAR_RE)].map((m) => m[1]))].map((v) => ({
    name: v,
    label: txt(vars[v]?.description, 120) || v,
    ...(txt(vars[v]?.description, 500) ? { help: txt(vars[v].description, 500) } : {}),
    required: vars[v]?.isRequired !== false,
    ...(typeof vars[v]?.default === 'string' ? { default: vars[v].default.slice(0, 200) } : {}),
    ...(Array.isArray(vars[v]?.choices) ? { choices: vars[v].choices.filter((c: any) => typeof c === 'string').slice(0, 50) } : {}),
    kind: 'url' as const,
  }));
  if (Object.values<any>(vars).some((v) => v?.isSecret === true)) return { ...base, url, reason: 'Dit adres bevat een geheim; dat slaat TeamBot niet veilig op in een adres. Kies een andere vorm.' };
  const headers = (Array.isArray(r.headers) ? r.headers : []).slice(0, 30).map((h: any) => kvField(h, 'header')).filter(Boolean) as CatalogField[];
  return { ...base, supported: true, url, inputs, headers, preview: url };
}

function packageOption(p: any, i: number): InstallOption {
  const kind = txt(p?.registryType, 20).toLowerCase() || 'onbekend';
  const identifier = txt(p?.identifier, 300);
  const version = txt(p?.version, 64);
  const t = p?.transport?.type;
  const labels: Record<string, string> = { npm: 'npm-pakket (npx)', pypi: 'Python-pakket (uvx)', oci: 'Docker-image', nuget: '.NET-tool (dnx)', mcpb: 'MCPB-bundel', cargo: 'Rust-crate' };
  const base: InstallOption = { key: `package:${i}`, kind, label: labels[kind] || `Pakket (${kind})`, transport: 'stdio', supported: false, identifier, version, inputs: [], env: [], headers: [], preview: identifier };
  const env = (Array.isArray(p?.environmentVariables) ? p.environmentVariables : []).slice(0, 40).map((e: any) => kvField(e, 'env')).filter(Boolean) as CatalogField[];
  base.env = env;
  if (t !== 'stdio') return { ...base, reason: 'Dit pakket start een eigen lokale webserver; TeamBot start alleen pakketten die via stdio werken. Kies een andere installatievorm.' };
  if (kind === 'mcpb') return { ...base, reason: 'Een MCPB-bundel installeert TeamBot niet. Kies een andere installatievorm.' };
  if (kind === 'cargo') return { ...base, reason: 'Rust-crates moeten eerst gebouwd worden; dat doet TeamBot niet. Kies een andere installatievorm.' };
  const pinned = version && VERSION_RE.test(version) && !/^(latest|next)$/i.test(version) ? version : '';
  const registryBase = txt(p?.registryBaseUrl, 300).replace(/\/+$/, '');
  const inputs = new Map<string, InputField>();
  const dockerEnv: CatalogField[] = [];
  const rt = argTokens(p?.runtimeArguments, inputs, 'runtime', kind === 'oci' ? { dockerEnv } : {});
  const pk = argTokens(p?.packageArguments, inputs, 'arg');
  if (rt.error || pk.error) return { ...base, reason: rt.error || pk.error };
  for (const e of dockerEnv) if (!env.some((x) => x.name === e.name)) env.push(e);
  const fromRuntime = new Set(dockerEnv.map((e) => e.name));
  let command = '';
  let args: string[] = [];
  let packageUrl: string | undefined;
  if (kind === 'npm') {
    if (!/^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i.test(identifier)) return { ...base, reason: 'Ongeldige npm-pakketnaam.' };
    if (registryBase && registryBase !== 'https://registry.npmjs.org') return { ...base, reason: `Pakket uit een ander npm-register (${registryBase}); dat ondersteunt TeamBot niet.` };
    command = 'npx';
    args = ['-y', ...rt.tokens.filter((x) => x !== '-y' && x !== '--yes'), pinned ? `${identifier}@${pinned}` : identifier, ...pk.tokens];
    packageUrl = `https://www.npmjs.com/package/${identifier}${pinned ? '/v/' + pinned : ''}`;
  } else if (kind === 'pypi') {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(identifier)) return { ...base, reason: 'Ongeldige Python-pakketnaam.' };
    if (registryBase && !/^https:\/\/pypi\.org(\/simple)?$/.test(registryBase)) return { ...base, reason: `Pakket uit een andere Python-index (${registryBase}); dat ondersteunt TeamBot niet.` };
    command = 'uvx';
    args = [...rt.tokens, pinned ? `${identifier}==${pinned}` : identifier, ...pk.tokens];
    packageUrl = `https://pypi.org/project/${identifier}/${pinned ? pinned + '/' : ''}`;
  } else if (kind === 'oci') {
    if (!/^[a-z0-9]+([._/-][a-z0-9]+)*(:[A-Za-z0-9._-]{1,128})?(@sha256:[a-f0-9]{64})?$/.test(identifier)) return { ...base, reason: 'Ongeldige image-naam.' };
    const hasTag = /:[^/]+$/.test(identifier) || identifier.includes('@sha256:');
    const image = hasTag || !pinned ? identifier : `${identifier}:${pinned}`;
    command = 'docker';
    args = ['run', '-i', '--rm', ...env.filter((e) => !fromRuntime.has(e.name)).flatMap((e) => ['-e', e.name]), ...rt.tokens, image, ...pk.tokens];
  } else if (kind === 'nuget') {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(identifier)) return { ...base, reason: 'Ongeldige NuGet-pakketnaam.' };
    command = 'dnx';
    args = [pinned ? `${identifier}@${pinned}` : identifier, '--yes', ...rt.tokens, ...pk.tokens];
    packageUrl = `https://www.nuget.org/packages/${identifier}${pinned ? '/' + pinned : ''}`;
  } else return { ...base, reason: `Pakketsoort “${kind}” wordt niet ondersteund.` };
  if (args.some((a) => /[\0\r\n]/.test(a))) return { ...base, reason: 'Ongeldig argument in het register.' };
  return { ...base, supported: true, runtime: command, command, args, packageUrl, commandFound: commandOnPath(command), inputs: [...inputs.values()], preview: [command, ...args].join(' ') };
}

/**
 * The icon to show from a record's `icons` list: only PNG, JPEG or WebP over https (never SVG). Records often list
 * several sizes (a 16 px favicon first); take the smallest one of at least 64 px, else the largest stated size, else
 * the first usable one.
 */
export function pickIcon(icons: unknown): { src: string } | null {
  const usable = (Array.isArray(icons) ? icons : [])
    .slice(0, 20)
    .map((i: any) => {
      const src = httpsUrl(i?.src);
      const mime = txt(i?.mimeType, 40);
      if (!src || src.length > 255 || !(/^image\/(png|jpe?g|webp)$/.test(mime) || (!mime && /\.(png|jpe?g|webp)(\?|$)/i.test(src)))) return null;
      const sides = (Array.isArray(i?.sizes) ? i.sizes : [])
        .map((x: any) => /^(\d{1,4})x(\d{1,4})$/.exec(String(x)))
        .filter(Boolean)
        .map((m: RegExpExecArray) => Math.min(Number(m[1]), Number(m[2])));
      return { src, side: sides.length ? Math.max(...sides) : 0 };
    })
    .filter(Boolean) as { src: string; side: number }[];
  if (!usable.length) return null;
  const big = usable.filter((i) => i.side >= 64).sort((a, b) => a.side - b.side)[0];
  const largest = [...usable].sort((a, b) => b.side - a.side)[0];
  return { src: (big || (largest.side ? largest : usable[0])).src };
}

/** Validate one registry record (ServerResponse). Returns null for anything unusable. */
export function normalizeServer(raw: any, featured = false): RegistryItem | null {
  const s = raw?.server;
  if (!s || typeof s !== 'object') return null;
  const name = txt(s.name, 220);
  if (!NAME_RE.test(name) || name.split('/').some((p) => /^[.-]|[.-]$|\.\./.test(p))) return null;
  const version = txt(s.version, 255);
  if (!version) return null;
  const meta = raw?._meta?.['io.modelcontextprotocol.registry/official'] || {};
  const status = ['active', 'deprecated', 'deleted'].includes(meta.status) ? meta.status : 'active';
  const ns = name.split('/')[0];
  const pub = publisherOf(ns);
  const icon = pickIcon(s.icons);
  const options = [...(Array.isArray(s.remotes) ? s.remotes.slice(0, 10).map(remoteOption) : []), ...(Array.isArray(s.packages) ? s.packages.slice(0, 20).map(packageOption) : [])];
  const title = txt(s.title, 100) || prettify(name);
  const description = txt(s.description, 400);
  return {
    name,
    title,
    description,
    version,
    status,
    statusMessage: txt(meta.statusMessage, 500),
    publishedAt: txt(meta.publishedAt, 40) || null,
    updatedAt: txt(meta.updatedAt, 40) || null,
    isLatest: meta.isLatest === true,
    namespace: ns,
    publisher: pub.publisher,
    publisherKind: pub.kind,
    repository: httpsUrl(s.repository?.url),
    subfolder: txt(s.repository?.subfolder, 300) || null,
    websiteUrl: httpsUrl(s.websiteUrl),
    icon: icon ? icon.src : null,
    category: categorize(title, description, name),
    options,
    remote: options.some((o) => o.kind === 'remote' && o.supported),
    local: options.some((o) => o.kind !== 'remote' && o.supported),
    featured,
  };
}

/**
 * What the browser gets instead of the publisher's icon URL: TeamBot's own icon route (relative to /api). `v`
 * changes when the record points to another icon, so a cached image is not shown for a new one.
 */
export function iconPath(it: Pick<RegistryItem, 'name' | 'icon'>): string | null {
  if (!it.icon) return null;
  return `/mcp/registry/icon?name=${encodeURIComponent(it.name)}&v=${crypto.createHash('sha256').update(it.icon).digest('hex').slice(0, 10)}`;
}

/** Map our display categories onto the connector categories of the built-in catalogue. */
function connectorCategory(label: string): CatalogEntry['category'] {
  const m: Record<string, CatalogEntry['category']> = {
    Ontwikkeling: 'ontwikkeling',
    'Cloud & DevOps': 'ontwikkeling',
    Beveiliging: 'systeem',
    'Data & analyse': 'kennis',
    'Zoeken & kennis': 'kennis',
    Financiën: 'kennis',
    Documenten: 'productiviteit',
    Productiviteit: 'productiviteit',
    Communicatie: 'communicatie',
    'Browser & automatisering': 'browser',
  };
  return m[label] || 'eigen';
}

const REQUIREMENTS: Record<string, string> = {
  npx: 'Node.js met npx (de eerste start downloadt het pakket van npm).',
  uvx: 'Python met uv (uvx); de eerste start downloadt het pakket van PyPI.',
  docker: 'Docker; de eerste start downloadt de image.',
  dnx: '.NET 10 SDK (dnx); de eerste start downloadt het pakket van NuGet.',
};

function fill(template: string, values: Record<string, string>, where: 'url' | 'arg'): string {
  return template.replace(VAR_RE, (_, v) => {
    const val = values[v] ?? '';
    return where === 'url' ? encodeURIComponent(val) : val;
  });
}

/**
 * Build the connector template for one install option. Inputs are validated (no line breaks, URL parts encoded);
 * a required input without a value is refused.
 */
export function entryFor(item: RegistryItem, key: string, rawInputs: Record<string, any> = {}, o: { auth?: 'none' | 'headers' | 'oauth'; license?: string | null } = {}): { entry: CatalogEntry; option: InstallOption; inputs: Record<string, string> } {
  const opt = item.options.find((x) => x.key === key);
  if (!opt) throw new HttpError(400, 'Onbekende installatievorm.');
  if (!opt.supported) throw new HttpError(422, opt.reason || 'Deze installatievorm wordt niet ondersteund.');
  if (item.status === 'deleted') throw new HttpError(410, 'Deze server is uit het register verwijderd.');
  const inputs: Record<string, string> = {};
  for (const f of opt.inputs) {
    const v = typeof rawInputs[f.name] === 'string' ? rawInputs[f.name].trim().slice(0, 1000) : '';
    const val = v || f.default || '';
    if (!val && f.required) throw new HttpError(400, `Vul “${f.label}” in.`);
    if (/[\0\r\n]/.test(val)) throw new HttpError(400, `Ongeldige waarde voor ${f.label}.`);
    if (f.choices?.length && val && !f.choices.includes(val)) throw new HttpError(400, `Kies een geldige waarde voor ${f.label}.`);
    inputs[f.name] = val;
  }
  const source = item.repository || item.websiteUrl || `${REGISTRY_API}/servers/${encodeURIComponent(item.name)}/versions/${encodeURIComponent(item.version)}`;
  const e: CatalogEntry = {
    id: 'registry',
    name: item.title.slice(0, 80),
    category: connectorCategory(item.category),
    description: item.description,
    publisher: item.publisher,
    official: false,
    transport: opt.transport,
    auth: 'none',
    dataFlow: '',
    license: o.license || 'Onbekend (zie de bron)',
    source,
    ...(item.websiteUrl ? { docs: item.websiteUrl } : {}),
    verification: 'niet geverifieerd',
    verifiedAt: '',
    testStatus: `Uit het officiële MCP-register (${item.name} ${item.version}${item.publishedAt ? `, gepubliceerd ${item.publishedAt.slice(0, 10)}` : ''}). Niet door TeamBot getest; TeamBot doet zelf eerst een leestest en zet acties pas aan als jij dat kiest.`,
    ...(item.status === 'deprecated' ? { availability: `Verouderd volgens het register${item.statusMessage ? ': ' + item.statusMessage : '.'}` } : {}),
  };
  if (opt.kind === 'remote') {
    const url = fill(opt.url!, inputs, 'url');
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:') throw new Error('x');
    } catch {
      throw new HttpError(400, 'Het adres is na het invullen ongeldig.');
    }
    e.url = new URL(url).href;
    if (opt.headers.length) e.headers = opt.headers;
    e.auth = o.auth || (opt.headers.some((h) => h.secret) ? 'headers' : 'none');
    if (e.auth === 'oauth') e.oauthClient = 'dynamic';
    e.dataFlow = `Verzoeken van de bot gaan naar ${new URL(url).host} (${item.publisher}). Resultaten komen in het gesprek en gaan naar je AI-provider.`;
  } else {
    e.command = opt.command;
    // An optional argument left empty is dropped (with its flag), instead of passing an empty value.
    const args: string[] = [];
    for (const a of opt.args || []) {
      const v = fill(a, inputs, 'arg');
      if (v === '' && a !== '') {
        if (args.length && /^-/.test(args[args.length - 1])) args.pop();
        continue;
      }
      args.push(v);
    }
    e.args = args;
    if (opt.env.length) e.env = opt.env;
    e.requirements = REQUIREMENTS[opt.runtime || ''] || undefined;
    e.dataFlow = `Draait lokaal op deze computer via ${opt.runtime} (${opt.identifier}${opt.version ? ' ' + opt.version : ''}, gedownload van ${opt.kind === 'npm' ? 'npm' : opt.kind === 'pypi' ? 'PyPI' : opt.kind === 'oci' ? 'het image-register' : 'NuGet'}). Wat de server ophaalt of leest komt in het gesprek en gaat naar je AI-provider.`;
  }
  return { entry: e, option: opt, inputs };
}

export class Registry {
  private latest = new Map<string, { version: string; at: number }>();
  /** Icon URL per server name from the records we handed out (null: the record has no usable icon). */
  private icons = new Map<string, string | null>();
  /** Icon URLs that failed recently (not retried for an hour). */
  private badIcons = new Map<string, number>();
  /** When the last network fetch of a featured server's record ended (whatever the outcome), and its error. */
  private tried = new Map<string, number>();
  private triedError = new Map<string, string>();

  constructor(
    private ctx: Ctx,
    readonly cache: WebCache,
  ) {}

  private async list(params: Record<string, string>, ttlMs: number) {
    const u = new URL(`${REGISTRY_API}/servers`);
    for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
    const key = `list:${u.search}`;
    const hit = await this.cache.json<any>(key, u.toString(), { ttlMs, timeoutMs: REGISTRY_TIMEOUT_MS });
    const servers = Array.isArray(hit.data?.servers) ? hit.data.servers : [];
    const items = servers.map((s: any) => normalizeServer(s, FEATURED.includes(s?.server?.name))).filter(Boolean) as RegistryItem[];
    for (const it of items) this.noteLatest(it);
    return { items, nextCursor: typeof hit.data?.metadata?.nextCursor === 'string' ? hit.data.metadata.nextCursor.slice(0, 300) : null, stale: hit.stale, error: hit.error, fetchedAt: hit.fetchedAt };
  }

  private noteLatest(it: RegistryItem) {
    if (it.isLatest || !this.latest.has(it.name)) this.latest.set(it.name, { version: it.version, at: Date.now() });
    this.noteIcon(it);
  }

  /** Search by server name (the registry's own search is a name substring match, minimum 3 characters). */
  async search(q: string, cursor?: string | null) {
    const query = q.trim().slice(0, 100);
    if (query.length < 3) throw new HttpError(400, 'Zoek met minstens 3 tekens.');
    try {
      const r = await this.list({ search: query, version: 'latest', limit: '30', cursor: cursor || '' }, HOUR);
      if (cursor) return r;
      // The registry sorts by name, so "github" starts with look-alikes (and the official GitHub server may not even be
      // on the first page). The hand-picked servers that match come first, from the cache (no extra requests).
      const needle = query.toLowerCase();
      // Match the server's own name and title, not the namespace: "io.github.getsentry/…" is not a GitHub server.
      const picked = this.cachedFeatured().filter((i) => `${i.name.split('/').pop()} ${i.title}`.toLowerCase().includes(needle));
      if (!picked.length) return r;
      const seen = new Set(picked.map((i) => i.name));
      return { ...r, items: [...picked, ...r.items.filter((i) => !seen.has(i.name))] };
    } catch (e) {
      // Offline (or the registry is unreachable) and this search was never cached: search the servers that are in
      // the cache (the featured list), the same way the registry does (name substring), instead of failing.
      if (cursor || !(e instanceof WebError) || !['offline', 'network', 'rate-limited'].includes(e.code)) throw e;
      const f = await this.featured();
      const needle = query.toLowerCase();
      const items = f.items.filter((i) => `${i.name} ${i.title}`.toLowerCase().includes(needle));
      return { items, nextCursor: null, stale: true, error: e.message, fetchedAt: null };
    }
  }

  /** The hand-picked servers that are in the cache, in FEATURED order (no network). */
  private cachedFeatured(): RegistryItem[] {
    const out: RegistryItem[] = [];
    for (const name of FEATURED) {
      const data = this.cache.peek<any>(`server:${name}@latest`)?.data;
      const it = data ? normalizeServer(data, true) : null;
      if (it && it.status !== 'deleted') out.push(it);
    }
    return out;
  }

  /**
   * The hand-picked FEATURED servers, each fetched by name, all in parallel (each with its own time limit),
   * stale-while-revalidate: a server in the cache is shown at once (when its copy is over an hour old it is checked in
   * the background: `refreshing`); one that was never fetched gets until the deadline and otherwise keeps loading in
   * the background (`pending`), so the page can ask again. Offline: only the cache.
   */
  async featured(budgetMs = FIRST_VIEW_BUDGET_MS, early = false) {
    const dl = sharedDeadline(budgetMs, early);
    const out: RegistryItem[] = [];
    const errors: string[] = [];
    const pending: string[] = [];
    const refreshing: string[] = [];
    let stale = false;
    await Promise.all(
      FEATURED.map(async (name) => {
        const key = `server:${name}@latest`;
        const cached = this.cache.peek<any>(key);
        const fresh = !!cached && this.cache.fresh(key, HOUR);
        // A check that just ended (also a failed one) counts as checked for a few minutes, so a page asking again
        // does not keep "bijwerken" up and the registry is not asked on every poll. Offline: only the cache.
        const recent = Date.now() - (this.tried.get(name) || 0) < 5 * 60_000;
        let data: any;
        if (cached && !fresh && (recent || isOffline())) {
          data = cached.data;
          stale = stale || isOffline() || !!this.triedError.get(name);
        } else {
          const p = this.getHit(name, 'latest');
          if (!fresh)
            p.then(
              (r) => (this.tried.set(name, Date.now()), r.stale ? this.triedError.set(name, r.error || 'register niet bereikbaar') : this.triedError.delete(name)),
              (e) => (this.tried.set(name, Date.now()), this.triedError.set(name, String(e?.message || e))),
            );
          try {
            // The first view never waits for a check of a cached server; a page asking again does (until the check or
            // the deadline ends); a server that was never fetched gets until the deadline.
            const r = cached && !fresh && !early ? 'pending' : fresh ? await withBudget(p, 1000) : await dl.wait(p);
            if (r === 'pending') {
              if (!cached) return void pending.push(name);
              data = cached.data;
              refreshing.push(name);
            } else {
              data = r.data;
              stale = stale || r.stale;
            }
          } catch (e: any) {
            errors.push(`${name}: ${e?.message || e}`);
            // Gone from the registry: not shown; any other failure: the last copy, marked as such.
            if (!cached || (e instanceof WebError && e.code === 'not-found')) return;
            data = cached.data;
            stale = true;
          }
        }
        const it = normalizeServer(data, true);
        if (it) this.noteIcon(it);
        if (it && it.status !== 'deleted') out.push(it);
      }),
    );
    dl.done();
    out.sort((a, b) => FEATURED.indexOf(a.name) - FEATURED.indexOf(b.name));
    return { items: out, stale, errors, pending, refreshing };
  }

  private getHit(name: string, version: string) {
    if (!NAME_RE.test(name)) throw new HttpError(400, 'Ongeldige servernaam.');
    if (version !== 'latest' && !VERSION_RE.test(version)) throw new HttpError(400, 'Ongeldige versie.');
    return this.cache.json<any>(`server:${name}@${version}`, `${REGISTRY_API}/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`, { ttlMs: version === 'latest' ? HOUR : 30 * 24 * HOUR, timeoutMs: REGISTRY_TIMEOUT_MS });
  }

  async get(name: string, version = 'latest', o: { force?: boolean } = {}): Promise<RegistryItem & { stale: boolean; fetchedAt: string }> {
    let hit;
    try {
      hit = o.force ? await this.cache.json<any>(`server:${name}@${version}`, `${REGISTRY_API}/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`, { ttlMs: HOUR, force: true, timeoutMs: REGISTRY_TIMEOUT_MS }) : await this.getHit(name, version);
    } catch (e: any) {
      if (e instanceof WebError) throw new HttpError(e.status === 404 ? 404 : e.status === 429 ? 429 : 502, e.status === 404 ? 'Deze server staat niet (meer) in het MCP-register.' : e.message);
      throw e;
    }
    const it = normalizeServer(hit.data, FEATURED.includes(name));
    if (!it) throw new HttpError(502, 'Het register gaf een onbruikbaar antwoord.');
    if (version === 'latest') {
      this.latest.set(it.name, { version: it.version, at: Date.now() });
      this.noteIcon(it);
    }
    return { ...it, stale: hit.stale, fetchedAt: hit.fetchedAt };
  }

  async versions(name: string) {
    if (!NAME_RE.test(name)) throw new HttpError(400, 'Ongeldige servernaam.');
    try {
      const hit = await this.cache.json<any>(`versions:${name}`, `${REGISTRY_API}/servers/${encodeURIComponent(name)}/versions`, { ttlMs: HOUR, timeoutMs: REGISTRY_TIMEOUT_MS });
      return (Array.isArray(hit.data?.servers) ? hit.data.servers : [])
        .map((s: any) => {
          const m = s?._meta?.['io.modelcontextprotocol.registry/official'] || {};
          return { version: txt(s?.server?.version, 64), publishedAt: txt(m.publishedAt, 40) || null, status: txt(m.status, 20) || 'active', isLatest: m.isLatest === true };
        })
        .filter((v: any) => v.version)
        .slice(-50)
        .reverse();
    } catch {
      return [];
    }
  }

  /**
   * The icon of a registry server, downloaded and cached by TeamBot (see icons.ts). Only the icon URL of the
   * server's own record is ever fetched, so the route cannot be used as an open proxy. null: no icon, or not a
   * small PNG/JPEG/WebP (also unreachable, blocked by the SSRF rules, too large or offline) → fallback icon.
   */
  async icon(name: string): Promise<{ body: Buffer; type: IconType } | null> {
    if (!NAME_RE.test(name)) return null;
    let url = this.icons.get(name) ?? null;
    if (!this.icons.has(name)) {
      try {
        url = (await this.get(name)).icon;
      } catch {
        return null;
      }
    }
    if (!url) return null;
    if ((this.badIcons.get(url) ?? 0) > Date.now()) return null;
    try {
      const hit = await this.cache.buffer(`icon:${url}`, url, { ttlMs: 7 * 24 * HOUR, maxBytes: ICON_MAX_BYTES, accept: 'image/png,image/jpeg,image/webp', timeoutMs: REGISTRY_TIMEOUT_MS });
      const type = acceptableIcon(hit.data);
      if (type) return { body: hit.data, type };
      this.cache.drop(`icon:${url}`);
    } catch {
      /* unreachable, private address, too large, offline: fallback */
    }
    if (this.badIcons.size > 2000) this.badIcons.clear();
    this.badIcons.set(url, Date.now() + HOUR);
    return null;
  }

  /**
   * Known right now to have no usable icon (its download failed in the last hour, see icon()): the card then gets no
   * icon at all, so the browser does not even ask for it again.
   */
  iconKnownBad(it: Pick<RegistryItem, 'icon'>): boolean {
    return !!it.icon && (this.badIcons.get(it.icon) ?? 0) > Date.now();
  }

  private noteIcon(it: RegistryItem) {
    if (this.icons.size > 5000) this.icons.clear();
    this.icons.set(it.name, it.icon);
  }

  /** Latest version we know of (memory or cache; never the network). */
  peekLatest(name: string): string | null {
    const m = this.latest.get(name);
    if (m) return m.version;
    const hit = this.cache.peek<any>(`server:${name}@latest`);
    const v = hit ? txt(hit.data?.server?.version, 64) : '';
    return v || null;
  }

  /** Licence of the package behind an option (npm / PyPI metadata), cached for a week. null when unknown. */
  async packageLicense(opt: InstallOption, repoSpdx?: string | null): Promise<string | null> {
    try {
      if (opt.kind === 'npm' && opt.identifier) {
        const v = opt.version && VERSION_RE.test(opt.version) ? opt.version : 'latest';
        const hit = await this.cache.json<any>(`npm:${opt.identifier}@${v}`, `https://registry.npmjs.org/${opt.identifier.replace('/', '%2F')}/${encodeURIComponent(v)}`, { ttlMs: 7 * 24 * HOUR, maxBytes: 4 * 1024 * 1024 });
        const l = hit.data?.license;
        const s = typeof l === 'string' ? l : typeof l?.type === 'string' ? l.type : '';
        if (s) return s.slice(0, 80);
      }
      if (opt.kind === 'pypi' && opt.identifier) {
        const url = opt.version && VERSION_RE.test(opt.version) ? `https://pypi.org/pypi/${encodeURIComponent(opt.identifier)}/${encodeURIComponent(opt.version)}/json` : `https://pypi.org/pypi/${encodeURIComponent(opt.identifier)}/json`;
        const hit = await this.cache.json<any>(`pypi:${opt.identifier}@${opt.version || 'latest'}`, url, { ttlMs: 7 * 24 * HOUR, maxBytes: 4 * 1024 * 1024 });
        const info = hit.data?.info || {};
        const expr = txt(info.license_expression, 80);
        if (expr) return expr;
        const short = txt(info.license, 200);
        if (short && short.length <= 40 && !/\n/.test(short)) return short;
        const cls = (Array.isArray(info.classifiers) ? info.classifiers : []).find((c: any) => typeof c === 'string' && c.startsWith('License :: OSI Approved :: '));
        if (cls) return cls.replace('License :: OSI Approved :: ', '').replace(/ License$/, '').slice(0, 80);
      }
    } catch {
      /* unknown */
    }
    return repoSpdx ? (classifyId(repoSpdx)?.label ?? null) : null;
  }
}
