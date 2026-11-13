import type { Ctx, User } from '../../core/types.js';
import type { PolicyDecision, PublisherChange, PublisherPolicy, SignatureState, SignatureView, TrustedPublisher } from '../../../shared/skills.js';
import { HttpError, ah, bad, notFound, requireRole, str, user } from '../../core/http.js';
import { isRestricted } from '../../api/member-policy.js';
import {
  type InlinePackage,
  type PackageKind,
  type PackageManifest,
  type PackageVerification,
  fingerprint,
  inlineToFiles,
  normalizePublicKey,
  verifyPackage,
} from '../../../packages/teambot-sdk/src/index.js';

/**
 * Publisher identity and the organisation policy for packages (skills, bot templates, connector templates).
 * The cryptography lives in the SDK (packages/teambot-sdk); this file adds the trust list, the policy and
 * the views the API returns. Used by the skills module and the mcp module, server-side on every install path.
 *
 * Policy (setting `publisherPolicy`, user_id ''):
 *  - open        anything may be installed (with warnings)            [default]
 *  - signed-only only packages with a valid signature (+ built-ins)
 *  - allowlist   only trusted publishers + TeamBot built-ins
 * An invalid signature or an incompatible package is always refused. Restricted members (server mode) are
 * always held to the policy; owner/admin may override per install with an explicit, audited confirmation.
 */

export const POLICIES: PublisherPolicy[] = ['open', 'signed-only', 'allowlist'];
export const POLICY_SETTING = 'publisherPolicy';

export const POLICY_LABEL: Record<PublisherPolicy, string> = {
  open: 'Open: alles mag, met waarschuwingen',
  'signed-only': 'Alleen ondertekende pakketten',
  allowlist: 'Alleen vertrouwde uitgevers en ingebouwde TeamBot-items',
};

export interface PublisherSettings {
  policy: PublisherPolicy;
  trusted: TrustedPublisher[];
}

/** Snapshot stored with an installed skill revision or connection (verified at install time). */
export interface PackageInfo {
  state: 'builtin' | 'signed' | 'unsigned';
  name?: string;
  version?: string;
  kind?: PackageKind;
  publisher?: { id: string; name: string; publicKey: string; fingerprint: string } | null;
  license?: string;
  teambot?: string;
  /** Installed as part of a bot package (the skill itself has no manifest). */
  via?: 'bot';
  viaName?: string;
  verifiedAt: string;
  /** Full signed manifest (skill revisions only), so the package can be shared or downloaded again. */
  manifest?: PackageManifest;
}

// ------------------------------------------------------------------ settings

export function publisherSettings(ctx: Ctx): PublisherSettings {
  const raw = ctx.store.getSetting<any>('', POLICY_SETTING, null);
  if (!raw) return { policy: 'open', trusted: [] };
  // A stored but unreadable policy fails closed.
  const policy: PublisherPolicy = POLICIES.includes(raw.policy) ? raw.policy : 'allowlist';
  const trusted: TrustedPublisher[] = [];
  for (const t of Array.isArray(raw.trusted) ? raw.trusted : []) {
    try {
      const key = normalizePublicKey(t?.publicKey);
      if (trusted.some((x) => x.publicKey === key)) continue;
      trusted.push({ publicKey: key, name: String(t.name || '').slice(0, 120) || 'Uitgever', fingerprint: fingerprint(key), publisherId: String(t.publisherId || '').slice(0, 100), addedBy: String(t.addedBy || ''), addedAt: String(t.addedAt || '') });
    } catch {
      /* skip unreadable entries */
    }
  }
  return { policy, trusted };
}

function saveSettings(ctx: Ctx, s: PublisherSettings) {
  ctx.store.setSetting('', POLICY_SETTING, { policy: s.policy, trusted: s.trusted.map((t) => ({ publicKey: t.publicKey, name: t.name, publisherId: t.publisherId, addedBy: t.addedBy, addedAt: t.addedAt })) });
}

export function trustedMap(ctx: Ctx): Map<string, string> {
  return new Map(publisherSettings(ctx).trusted.map((t) => [t.publicKey, t.name]));
}

// ------------------------------------------------------------------ verification -> views

/** Verify a file collection (with or without teambot-package.json). Trust is applied later, at view time. */
export function verifyFiles(ctx: Ctx, files: Map<string, Uint8Array>, kind: PackageKind, o: { skipFiles?: boolean } = {}): PackageVerification {
  return verifyPackage(files, {
    appVersion: ctx.config.version,
    toolGroups: ctx.tools.groups.keys(),
    modules: ctx.modules.map((m) => m.id),
    expectKind: kind,
    skipFiles: o.skipFiles,
  });
}

/** A verification that failed before the SDK could run (unreadable package). */
export function failedVerification(message: string): PackageVerification {
  return { state: 'invalid', manifest: null, signed: false, signatureValid: false, filesValid: false, publisher: null, trustedName: null, compatible: true, incompatible: [], errors: [message], warnings: [] };
}

/** Verify an inline `{ manifest, files }` package (API bodies, catalog entries). */
export function verifyInline(ctx: Ctx, p: InlinePackage, kind: PackageKind): { files: Map<string, Uint8Array>; verification: PackageVerification } {
  let files: Map<string, Uint8Array>;
  try {
    files = inlineToFiles(p);
  } catch (e: any) {
    throw new HttpError(400, e.message);
  }
  return { files, verification: verifyFiles(ctx, files, kind) };
}

const blank = (state: SignatureState, label: string): SignatureView => ({
  state,
  label,
  publisher: null,
  declaredPublisher: null,
  publisherId: null,
  publicKey: null,
  fingerprint: null,
  packageName: null,
  version: null,
  license: null,
  teambot: null,
  via: null,
  compatible: true,
  incompatible: [],
  errors: [],
  warnings: [],
  blocked: false,
  blockReason: null,
});

export function builtinView(): SignatureView {
  return { ...blank('builtin', 'Vertrouwd: TeamBot (ingebouwd)'), publisher: 'TeamBot', declaredPublisher: 'TeamBot' };
}

export function unsignedView(): SignatureView {
  return blank('unsigned', 'Niet ondertekend');
}

function signedLabel(state: SignatureState, name: string | null) {
  return state === 'trusted' ? `Ondertekend door ${name}` : 'Ondertekend, onbekende uitgever';
}

/** Turn a fresh verification into a view, applying the current trust list. */
export function viewOf(ctx: Ctx, v: PackageVerification): SignatureView {
  const m = v.manifest;
  let state: SignatureState = v.state;
  let trustedName: string | null = null;
  if (state === 'trusted' || state === 'untrusted') {
    trustedName = trustedMap(ctx).get(v.publisher!.publicKey) ?? null;
    state = trustedName !== null ? 'trusted' : 'untrusted';
  }
  const label = state === 'invalid' ? 'Handtekening ongeldig' : state === 'unsigned' ? 'Niet ondertekend' : signedLabel(state, trustedName);
  const view: SignatureView = {
    ...blank(state, label),
    publisher: trustedName ?? v.publisher?.name ?? m?.publisher?.name ?? null,
    declaredPublisher: v.publisher?.name ?? m?.publisher?.name ?? null,
    publisherId: m?.publisher?.id ?? null,
    publicKey: v.publisher?.publicKey ?? null,
    fingerprint: v.publisher?.fingerprint ?? null,
    packageName: m?.name ?? null,
    version: m?.version ?? null,
    license: m?.license ?? null,
    teambot: m?.teambot ?? null,
    compatible: v.compatible,
    incompatible: [...v.incompatible],
    errors: [...v.errors],
    warnings: [...v.warnings],
  };
  if (state === 'invalid') {
    view.blocked = true;
    view.blockReason = `Handtekening ongeldig: ${v.errors.join(' ')} Niet geïnstalleerd.`;
  } else if (!v.compatible) {
    view.blocked = true;
    view.blockReason = `Niet compatibel met deze TeamBot-versie: ${v.incompatible.join(' ')}`;
  }
  return view;
}

/** Re-derive the view of something already installed (signature checked at install time). */
export function viewOfInfo(ctx: Ctx, info: PackageInfo | null | undefined): SignatureView {
  if (!info) return unsignedView();
  if (info.state === 'builtin') return { ...builtinView(), via: info.viaName || null, version: info.version || null };
  if (info.state === 'unsigned' || !info.publisher?.publicKey) return { ...unsignedView(), packageName: info.name || null, version: info.version || null, via: info.viaName || null };
  const trustedName = trustedMap(ctx).get(info.publisher.publicKey) ?? null;
  const state: SignatureState = trustedName !== null ? 'trusted' : 'untrusted';
  return {
    ...blank(state, signedLabel(state, trustedName)),
    publisher: trustedName ?? info.publisher.name,
    declaredPublisher: info.publisher.name,
    publisherId: info.publisher.id,
    publicKey: info.publisher.publicKey,
    fingerprint: info.publisher.fingerprint,
    packageName: info.name || null,
    version: info.version || null,
    license: info.license || null,
    teambot: info.teambot || null,
    via: info.viaName || null,
  };
}

/** Snapshot for storage. Only what passed verification ends up as "signed". */
export function infoOf(v: PackageVerification | 'builtin', o: { keepManifest?: boolean; via?: 'bot'; viaName?: string } = {}): PackageInfo {
  const base = { verifiedAt: new Date().toISOString(), ...(o.via ? { via: o.via, viaName: o.viaName } : {}) };
  if (v === 'builtin') return { state: 'builtin', ...base };
  const m = v.manifest;
  const signed = (v.state === 'trusted' || v.state === 'untrusted') && !!v.publisher;
  return {
    state: signed ? 'signed' : 'unsigned',
    ...(m ? { name: m.name, version: m.version, kind: m.kind, license: m.license, teambot: m.teambot } : {}),
    publisher: signed ? { id: v.publisher!.id, name: v.publisher!.name, publicKey: v.publisher!.publicKey, fingerprint: v.publisher!.fingerprint } : null,
    ...(signed && o.keepManifest && m ? { manifest: m } : {}),
    ...base,
  };
}

/** Snapshot without the (large) manifest, for denormalised rows. */
export function infoSummary(i: PackageInfo | null | undefined): PackageInfo | null {
  if (!i) return null;
  const { manifest: _m, ...rest } = i;
  return rest;
}

// ------------------------------------------------------------------ policy

function policyReason(p: PublisherPolicy) {
  return p === 'allowlist'
    ? 'Het uitgeversbeleid staat alleen pakketten van vertrouwde uitgevers en ingebouwde TeamBot-items toe.'
    : 'Het uitgeversbeleid staat alleen ondertekende pakketten toe.';
}

export function allowedByPolicy(policy: PublisherPolicy, state: SignatureState): boolean {
  if (policy === 'open') return state !== 'invalid';
  if (policy === 'signed-only') return state === 'builtin' || state === 'trusted' || state === 'untrusted';
  return state === 'builtin' || state === 'trusted';
}

export function decide(ctx: Ctx, u: Pick<User, 'role'> | null | undefined, sig: SignatureView): PolicyDecision {
  const policy = publisherSettings(ctx).policy;
  if (sig.blocked) return { policy, allowed: false, needsOverride: false, canOverride: false, blocked: true, reason: sig.blockReason };
  if (allowedByPolicy(policy, sig.state)) return { policy, allowed: true, needsOverride: false, canOverride: false, blocked: false, reason: null };
  if (isRestricted(ctx, u)) return { policy, allowed: false, needsOverride: false, canOverride: false, blocked: true, reason: `${policyReason(policy)} Vraag de beheerder van deze server om dit pakket toe te staan.` };
  return { policy, allowed: false, needsOverride: true, canOverride: true, blocked: false, reason: `${policyReason(policy)} Als eigenaar of beheerder kun je dit voor deze installatie toch toestaan; dat wordt vastgelegd in het auditlog.` };
}

/**
 * Enforce the policy for one install/update. Throws 422 (invalid/incompatible), 403 (refused for a member)
 * or 409 `policy-override-required`. An accepted override is audited.
 */
export function enforcePolicy(ctx: Ctx, u: User, sig: SignatureView, o: { override?: boolean; what: string; item?: string }): PolicyDecision {
  const d = decide(ctx, u, sig);
  if (d.blocked) throw new HttpError(sig.blocked ? 422 : 403, d.reason || 'Niet toegestaan.', sig.blocked ? 'package-blocked' : 'policy-blocked');
  if (d.needsOverride && !o.override) throw new HttpError(409, d.reason || 'Bevestiging nodig.', 'policy-override-required');
  if (d.needsOverride) auditOverride(ctx, u.id, sig, d, o.what, o.item);
  return d;
}

export function auditOverride(ctx: Ctx, userId: string, sig: SignatureView, d: PolicyDecision, what: string, item?: string) {
  ctx.audit(userId, 'package.policy_override', { what, item: item || sig.packageName, policy: d.policy, state: sig.state, publisher: sig.declaredPublisher, fingerprint: sig.fingerprint });
}

/**
 * Self-authored content (pasted/edited skills, published drafts, hand-configured connectors) has no
 * publisher at all: a restricted member may only add it while the policy is "open".
 */
export function assertMaySelfAuthor(ctx: Ctx, u: User, what: string) {
  const policy = publisherSettings(ctx).policy;
  if (policy !== 'open' && isRestricted(ctx, u)) throw new HttpError(403, `Op deze server geldt het uitgeversbeleid “${POLICY_LABEL[policy]}”: leden kunnen geen ${what}. Vraag de beheerder.`, 'policy-blocked');
}

/** Same-publisher rule for updates: null when the update keeps the installed publisher (or nothing was signed). */
export function publisherChange(installed: PackageInfo | null | undefined, incoming: SignatureView): PublisherChange | null {
  const key = (state: string | undefined, pk: string | null | undefined) => (state === 'builtin' ? 'builtin' : pk || null);
  const before = installed?.state === 'builtin' ? 'builtin' : installed?.state === 'signed' ? key('signed', installed.publisher?.publicKey) : null;
  if (!before) return null;
  const after = incoming.state === 'builtin' ? 'builtin' : incoming.state === 'trusted' || incoming.state === 'untrusted' ? key('signed', incoming.publicKey) : null;
  if (before === after) return null;
  const from = installed!.state === 'builtin' ? { name: 'TeamBot', fingerprint: null } : { name: installed!.publisher!.name, fingerprint: installed!.publisher!.fingerprint };
  const to = after === null ? null : after === 'builtin' ? { name: 'TeamBot', fingerprint: null } : { name: incoming.declaredPublisher || 'onbekend', fingerprint: incoming.fingerprint };
  const reason = to
    ? `Andere uitgever: de geïnstalleerde versie is van ${from.name}${from.fingerprint ? ` (${from.fingerprint})` : ''}, deze versie is ondertekend door ${to.name}${to.fingerprint ? ` (${to.fingerprint})` : ''}. Bevestig alleen als je deze wissel vertrouwt.`
    : `Andere uitgever: de geïnstalleerde versie is ondertekend door ${from.name}, deze versie is niet ondertekend. Bevestig alleen als je deze wissel vertrouwt.`;
  return { from, to, reason };
}

// ------------------------------------------------------------------ routes

export function publisherRoutes(ctx: Ctx) {
  const api = ctx.api;
  const view = (u: User) => {
    const s = publisherSettings(ctx);
    return {
      policy: s.policy,
      policyLabel: POLICY_LABEL[s.policy],
      policies: POLICIES.map((id) => ({ id, label: POLICY_LABEL[id] })),
      trusted: s.trusted,
      canManage: u.role !== 'member',
      restricted: isRestricted(ctx, u),
      mode: ctx.config.mode,
    };
  };
  api.get('/skills/publishers', ah(async (req) => view(user(req))));
  api.put(
    '/skills/publishers/policy',
    ah(async (req) => {
      const me = requireRole(req, 'admin');
      const policy = String(req.body?.policy || '') as PublisherPolicy;
      if (!POLICIES.includes(policy)) throw bad('Onbekend beleid. Kies open, signed-only of allowlist.');
      const s = publisherSettings(ctx);
      const from = s.policy;
      saveSettings(ctx, { ...s, policy });
      ctx.audit(me.id, 'publishers.policy', { from, to: policy });
      return view(me);
    }),
  );
  api.post(
    '/skills/publishers/trusted',
    ah(async (req) => {
      const me = requireRole(req, 'admin');
      let key: string;
      try {
        key = normalizePublicKey(str(req.body?.publicKey, 2000));
      } catch (e: any) {
        throw bad(e.message);
      }
      const name = str(req.body?.name, 120).trim();
      if (!name) throw bad('Geef de uitgever een naam.');
      const s = publisherSettings(ctx);
      const entry: TrustedPublisher = { publicKey: key, name, fingerprint: fingerprint(key), publisherId: str(req.body?.publisherId, 100).trim(), addedBy: me.id, addedAt: new Date().toISOString() };
      const trusted = [...s.trusted.filter((t) => t.publicKey !== key), entry];
      if (trusted.length > 200) throw bad('Maximaal 200 vertrouwde uitgevers.');
      saveSettings(ctx, { ...s, trusted });
      ctx.audit(me.id, 'publishers.trusted_added', { name, fingerprint: entry.fingerprint, publisherId: entry.publisherId || undefined });
      return view(me);
    }),
  );
  api.delete(
    '/skills/publishers/trusted/:fp',
    ah(async (req) => {
      const me = requireRole(req, 'admin');
      const fp = String(req.params.fp).replace(/[^a-f0-9]/gi, '').toLowerCase();
      const s = publisherSettings(ctx);
      const hit = s.trusted.find((t) => t.fingerprint.replace(/ /g, '') === fp);
      if (!hit) throw notFound('Uitgever niet gevonden');
      saveSettings(ctx, { ...s, trusted: s.trusted.filter((t) => t !== hit) });
      ctx.audit(me.id, 'publishers.trusted_removed', { name: hit.name, fingerprint: hit.fingerprint });
      return view(me);
    }),
  );
}
