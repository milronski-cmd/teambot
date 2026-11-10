import type { Ctx, ToolRisk } from '../../core/types.js';
import { HttpError } from '../../core/http.js';
import { type CatalogEntry, type CatalogField, type CatalogScope, catalogEntry } from './catalog.js';
import type { ConnectionRow } from './db.js';
import { isRisk } from './risk.js';
import type { InlinePackage, PackageVerification } from '../../../packages/teambot-sdk/src/index.js';
import { type PackageInfo, type SignatureView, builtinView, infoOf, unsignedView, verifyInline, viewOf, viewOfInfo } from '../skills/publishers.js';
import { scanSkill } from '../skills/scan.js';

/**
 * Connector packages: a signed `connector.json` (format `teambot.connector/v1`) that describes an MCP server the
 * same way a built-in catalogue entry does. The template is untrusted input: it is validated strictly here and
 * then goes through exactly the same connection rules as a hand-made connection (URL checks, stdio trust,
 * read-only test, actions off). Risk overrides can only make tools stricter.
 */

export const CONNECTOR_FORMAT = 'teambot.connector/v1';
const CATEGORIES = new Set(['ontwikkeling', 'productiviteit', 'communicatie', 'kennis', 'systeem', 'browser', 'eigen']);
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,100}$/;
const SAFE_OAUTH_PARAMS = new Set(['access_type', 'prompt']);

/** What a connection created from a package remembers: the publisher snapshot plus the template. */
export interface ConnectionPackage extends PackageInfo {
  template: CatalogEntry;
}

const txt = (v: any, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const flag = (v: any) => v === true;

function field(x: any): CatalogField | null {
  const name = txt(x?.name, 101);
  if (!FIELD_NAME.test(name)) return null;
  return {
    name,
    label: txt(x.label, 120) || name,
    ...(txt(x.help, 500) ? { help: txt(x.help, 500) } : {}),
    ...(flag(x.secret) ? { secret: true } : {}),
    ...(flag(x.required) ? { required: true } : {}),
    ...(txt(x.prefix, 40) ? { prefix: txt(x.prefix, 40) } : {}),
    ...(txt(x.placeholder, 200) ? { placeholder: txt(x.placeholder, 200) } : {}),
    ...(typeof x.default === 'string' && !flag(x.secret) ? { default: x.default.slice(0, 500) } : {}),
  };
}

function httpsUrl(v: any, what: string): string {
  const s = txt(v, 2000);
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new HttpError(400, `${what} in connector.json is geen geldig adres.`);
  }
  if (u.protocol !== 'https:') throw new HttpError(400, `${what} in connector.json moet een https-adres zijn.`);
  if (u.username || u.password) throw new HttpError(400, `${what} in connector.json mag geen inloggegevens bevatten.`);
  return u.href;
}

/** Validate an untrusted connector.json into a catalogue-shaped entry. Throws 400 with a readable reason. */
export function normalizeConnector(json: any, publisher: string): CatalogEntry {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new HttpError(400, 'connector.json moet een JSON-object zijn.');
  if (json.format !== CONNECTOR_FORMAT) throw new HttpError(400, `connector.json: het veld "format" moet "${CONNECTOR_FORMAT}" zijn.`);
  const name = txt(json.name, 80);
  if (!name) throw new HttpError(400, 'connector.json: "name" ontbreekt.');
  const transport = json.transport;
  if (!['stdio', 'http', 'sse'].includes(transport)) throw new HttpError(400, 'connector.json: "transport" moet stdio, http of sse zijn.');
  const auth = ['none', 'headers', 'oauth'].includes(json.auth) ? json.auth : 'none';
  const e: CatalogEntry = {
    id: 'package',
    name,
    category: CATEGORIES.has(json.category) ? json.category : 'eigen',
    description: txt(json.description, 1000),
    publisher,
    official: false,
    transport,
    auth,
    dataFlow: txt(json.dataFlow, 1000) || 'De uitgever heeft niet beschreven welke gegevens waarheen gaan.',
    license: txt(json.license, 120) || 'Niet opgegeven',
    source: '',
    verification: 'niet geverifieerd',
    verifiedAt: '',
    testStatus: 'Niet door TeamBot getest: dit sjabloon komt uit een pakket van een uitgever. TeamBot test de verbinding zelf met een leestest.',
  };
  if (transport === 'stdio') {
    const command = txt(json.command, 500);
    if (!command || /[\0\r\n]/.test(command)) throw new HttpError(400, 'connector.json: "command" ontbreekt of is ongeldig.');
    e.command = command;
    const args = Array.isArray(json.args) ? json.args : [];
    if (args.length > 64 || args.some((a: any) => typeof a !== 'string' || a.length > 4000 || /[\0\r\n]/.test(a))) throw new HttpError(400, 'connector.json: "args" moet een lijst met korte teksten zijn.');
    e.args = args;
    if (json.argsPrompt && typeof json.argsPrompt === 'object') e.argsPrompt = { label: txt(json.argsPrompt.label, 120) || 'Argumenten', help: txt(json.argsPrompt.help, 500), kind: json.argsPrompt.kind === 'paths' ? 'paths' : 'text' };
    const env = (Array.isArray(json.env) ? json.env : []).slice(0, 30).map(field).filter(Boolean) as CatalogField[];
    if (env.length) e.env = env;
  } else {
    e.url = httpsUrl(json.url, 'Het adres ("url")');
    const headers = (Array.isArray(json.headers) ? json.headers : []).slice(0, 30).map(field).filter(Boolean) as CatalogField[];
    if (headers.length) e.headers = headers;
    if (auth === 'oauth') {
      e.oauthClient = json.oauthClient === 'own-app' ? 'own-app' : 'dynamic';
      if (txt(json.oauthAppHelp, 1000)) e.oauthAppHelp = txt(json.oauthAppHelp, 1000);
      const extra: Record<string, string> = {};
      for (const [k, v] of Object.entries(json.oauthExtraParams || {})) if (SAFE_OAUTH_PARAMS.has(k) && typeof v === 'string') extra[k] = v.slice(0, 100);
      if (Object.keys(extra).length) e.oauthExtraParams = extra;
    }
  }
  const scopes: CatalogScope[] = (Array.isArray(json.scopes) ? json.scopes : [])
    .slice(0, 50)
    .map((s: any) => ({ name: txt(s?.name, 300), description: txt(s?.description, 300), ...(flag(s?.default) ? { default: true } : {}) }))
    .filter((s: CatalogScope) => s.name && !/\s/.test(s.name));
  if (scopes.length) e.scopes = scopes;
  const overrides: Record<string, ToolRisk> = {};
  for (const [k, v] of Object.entries(json.riskOverrides || {})) if (typeof k === 'string' && k.length <= 128 && isRisk(v)) overrides[k] = v as ToolRisk;
  if (Object.keys(overrides).length) e.riskOverrides = overrides;
  if (txt(json.requirements, 500)) e.requirements = txt(json.requirements, 500);
  if (json.source) e.source = httpsUrl(json.source, 'De bron ("source")');
  if (json.docs) e.docs = httpsUrl(json.docs, 'De documentatie ("docs")');
  if (txt(json.revokeHelp, 500)) e.revokeHelp = txt(json.revokeHelp, 500);
  if (txt(json.availability, 500)) e.availability = txt(json.availability, 500);
  return e;
}

/** Verify a connector package and read its template. */
export function connectorFromPackage(ctx: Ctx, p: InlinePackage) {
  const { files, verification } = verifyInline(ctx, p, 'connector');
  const raw = files.get('connector.json');
  if (!raw) throw new HttpError(400, 'Dit pakket bevat geen connector.json.');
  let json: any;
  try {
    json = JSON.parse(Buffer.from(raw).toString('utf8'));
  } catch {
    throw new HttpError(400, 'connector.json is geen geldige JSON.');
  }
  const signature = viewOf(ctx, verification);
  const entry = normalizeConnector(json, signature.publisher || verification.manifest?.publisher?.name || 'Onbekende uitgever');
  if (verification.manifest?.license && entry.license === 'Niet opgegeven') entry.license = verification.manifest.license;
  // Same static scan as skills: secrets, exfiltration addresses, hidden characters in the template.
  const scan = scanSkill(new Map([...files].map(([k, v]) => [k, Buffer.from(v)])));
  return { entry, verification, signature, scan: { level: scan.level, labels: scan.labels, findings: scan.findings.slice(0, 50), domains: scan.domains } };
}

export function packageOf(verification: PackageVerification, entry: CatalogEntry): ConnectionPackage {
  return { ...infoOf(verification), template: entry };
}

/** Catalogue entry or package template behind a connection. */
export function entryForConn(c: Pick<ConnectionRow, 'catalog_id'> & { package?: ConnectionPackage | null; registry?: ConnectionRow['registry'] }): CatalogEntry | undefined {
  return catalogEntry(c.catalog_id) || (c.package?.template ?? undefined) || (c.registry?.template ?? undefined);
}

/** Signature state of an existing connection: built-in template, package, or hand-made (unsigned). */
export function connectionSignature(ctx: Ctx, c: Pick<ConnectionRow, 'catalog_id'> & { package?: ConnectionPackage | null }): SignatureView {
  if (c.package) return viewOfInfo(ctx, c.package);
  if (c.catalog_id && c.catalog_id !== 'custom' && catalogEntry(c.catalog_id)) return builtinView();
  return unsignedView();
}
