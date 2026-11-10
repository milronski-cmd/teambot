import { uiLocale } from '../../lib/i18n';
// Shapes returned by /api/skills/* (see server/modules/skills/routes.ts).

export type Level = 'ok' | 'info' | 'warn' | 'danger';

export interface Finding {
  severity: 'info' | 'warn' | 'danger';
  kind: string;
  file: string;
  line?: number;
  message: string;
  excerpt?: string;
}

export interface ScanFileView {
  path: string;
  size: number;
  type: 'skill' | 'text' | 'script' | 'executable' | 'binary';
}

export interface Permissions {
  tools: string[];
  groups: string[];
  scripts: { path: string; sha256: string }[];
  binaries: string[];
  domains: string[];
}

export interface PermissionDiff {
  addedTools: string[];
  removedTools: string[];
  addedGroups: string[];
  addedScripts: string[];
  changedScripts: string[];
  removedScripts: string[];
  addedBinaries: string[];
  addedDomains: string[];
  removedDomains: string[];
  elevated: boolean;
}

/** Publisher signature state (server: server/modules/skills/publishers.ts). */
export type SignatureState = 'builtin' | 'trusted' | 'untrusted' | 'unsigned' | 'invalid';

export interface SignatureView {
  state: SignatureState;
  label: string;
  publisher: string | null;
  declaredPublisher: string | null;
  publisherId: string | null;
  publicKey: string | null;
  fingerprint: string | null;
  packageName: string | null;
  version: string | null;
  license: string | null;
  teambot: string | null;
  via: string | null;
  compatible: boolean;
  incompatible: string[];
  errors: string[];
  warnings: string[];
  blocked: boolean;
  blockReason: string | null;
}

export type PublisherPolicy = 'open' | 'signed-only' | 'allowlist';

export interface PolicyDecision {
  policy: PublisherPolicy;
  allowed: boolean;
  needsOverride: boolean;
  canOverride: boolean;
  blocked: boolean;
  reason: string | null;
}

export interface PublisherChange {
  from: { name: string; fingerprint: string | null } | null;
  to: { name: string; fingerprint: string | null } | null;
  reason: string;
}

export interface TrustedPublisher {
  publicKey: string;
  name: string;
  fingerprint: string;
  publisherId: string;
  addedBy: string;
  addedAt: string;
}

export interface PublishersView {
  policy: PublisherPolicy;
  policyLabel: string;
  policies: { id: PublisherPolicy; label: string }[];
  trusted: TrustedPublisher[];
  canManage: boolean;
  restricted: boolean;
  mode: string;
}

export interface SourceInfo {
  type: string;
  label?: string;
  url?: string;
  path?: string;
  catalogId?: string;
  itemId?: string;
  version?: string;
  verified?: boolean;
  publisher?: string;
  agentId?: string;
  /** TeamBot catalogue: pinned origin of this revision. */
  repo?: string;
  commit?: string;
  commitDate?: string;
  license?: string;
  licenseFile?: string;
  dropped?: { path: string; reason: string }[];
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  status: 'active' | 'draft' | 'disabled';
  version: string;
  license: string;
  author: string;
  kind: 'prompt' | 'scripts';
  labels: string[];
  scanLevel: Level;
  pinned: boolean;
  trusted: boolean;
  source: SourceInfo;
  catalogRef: string | null;
  blocked: boolean;
  activeRev: number;
  latestRev: number;
  newerStoredRevision: boolean;
  catalogUpdate: { version: string; catalogId: string; itemId: string; commit?: string } | null;
  /** Origin and update state of a skill from the TeamBot catalogue. */
  curated?: CuratedBadge | null;
  installScope?: 'user' | 'team';
  /** Package B4: the team it is installed for, or null with allTeams ("voor alle teams"). */
  teamId?: string | null;
  teamName?: string;
  allTeams?: boolean;
  checksum: string;
  signature: SignatureView;
  agents: { id: string; name: string }[];
  draftAgentId: string | null;
  draftThreadId: string | null;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VersionView {
  rev: number;
  version: string;
  checksum: string;
  note: string;
  createdBy: string;
  createdAt: string;
  source: SourceInfo;
  size: number;
  fileCount: number;
  scanLevel: Level;
  labels: string[];
  signature: SignatureView;
  active: boolean;
  diffFromActive: PermissionDiff | null;
}

export interface SkillMeta {
  name: string;
  description: string;
  license: string;
  version: string;
  allowedTools: string[];
  metadata: Record<string, string>;
  compatibility: string;
  author: string;
  homepage: string;
  dependencies: string[];
  platforms: string[];
}

export interface SkillDetail extends SkillSummary {
  skillMd: string;
  meta: SkillMeta;
  warnings: string[];
  scan: { level: Level; kind: string; labels: string[]; findings: Finding[]; files: ScanFileView[]; scripts: string[]; binaries: string[]; domains: string[] };
  permissions: Permissions;
  files: ScanFileView[];
  versions: VersionView[];
  catalogItem: { catalogId: string; itemId: string; title: string; version: string; changelog: Changelog[]; verified: boolean; publisher: string; signature?: SignatureView } | null;
  draftAgent: string | null;
  nameConflict: boolean;
}

export interface Changelog {
  version: string;
  date: string;
  notes: string;
}

/** Whether a skill does anything itself (server: skills/substance.ts). */
export interface Substance {
  thin: boolean;
  words: number;
  pointsTo: string[];
  message: string | null;
}

export interface Candidate {
  key: string;
  root: string;
  name: string;
  description: string;
  version: string;
  license: string;
  author: string;
  homepage: string;
  dependencies: string[];
  platforms: string[];
  compatibility: string;
  allowedTools: string[];
  errors: string[];
  warnings: string[];
  scan: { level: Level; kind: string; labels: string[]; findings: Finding[]; files: ScanFileView[]; domains: string[] };
  permissions: Permissions;
  checksum: string;
  size: number;
  fileCount: number;
  skillMd: string;
  source: SourceInfo;
  existing: { id: string; version: string; rev: number; pinned: boolean } | null;
  action: 'create' | 'update' | 'unchanged' | 'add-version';
  diff: PermissionDiff;
  needsConfirmation: boolean;
  needsAcknowledge: boolean;
  substance?: Substance;
  signature: SignatureView;
  policy: PolicyDecision;
  publisherChange: PublisherChange | null;
  needsPublisherConfirmation: boolean;
  /** GitHub owner compared with known publishers; 'lookalike' must be acknowledged. */
  publisherCheck?: PublisherCheck | null;
}

export interface PublisherCheck {
  owner: string;
  status: 'known' | 'lookalike' | 'unknown';
  like?: string;
  reason?: string;
}

export interface StagingView {
  stagingId: string;
  label: string;
  expiresAt: string;
  candidates: Candidate[];
}

export interface CommitResult {
  key: string;
  name: string;
  status: 'created' | 'updated' | 'version-added' | 'unchanged' | 'needs-confirmation' | 'needs-acknowledge' | 'needs-policy-override' | 'needs-publisher-confirmation' | 'blocked' | 'error';
  skillId?: string;
  rev?: number;
  error?: string;
  diff?: PermissionDiff;
}

export interface MarketSkillItem {
  type: 'skill';
  catalogId: string;
  catalogName: string;
  sourceKind: 'builtin' | 'external' | 'server';
  id: string;
  name: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  version: string;
  license: string;
  publisher: string;
  author: string;
  verified: boolean;
  signature: SignatureView;
  hasDownload: boolean;
  installed: { skillId: string; version: string; updateAvailable: boolean } | null;
}

export interface MarketSkillDetail extends MarketSkillItem {
  policy: PolicyDecision;
  homepage: string;
  changelog: Changelog[];
  platforms: string[];
  dependencies: string[];
  sha256: string | null;
  download: { host: string; size: number | null } | null;
  analysis: null | { error?: string; skillMd?: string; meta?: SkillMeta; errors?: string[]; warnings?: string[]; scan?: Candidate['scan']; permissions?: Permissions; checksum?: string; substance?: Substance };
}

export interface MarketBotItem {
  type: 'bot';
  catalogId: string;
  catalogName: string;
  sourceKind: 'builtin' | 'external' | 'server';
  id: string;
  title: string;
  role: string;
  avatar: string;
  color: string;
  description: string;
  category: string;
  tags: string[];
  version: string;
  license: string;
  publisher: string;
  verified: boolean;
  signature: SignatureView;
  skills: string[];
  installedCount: number;
}

export interface MarketBotDetail extends MarketBotItem {
  policy: PolicyDecision;
  instructions: string;
  tool_groups: string[];
  access_mode: string;
  model_hint: string;
  changelog: Changelog[];
  homepage: string;
}

export interface TemplatePreview {
  bot: { name: string; role: string; description: string; instructions: string; avatar: string; color: string; access_mode: string; requested_access_mode: string; tool_groups: { id: string; label: string; description: string; known: boolean }[]; model_hint: string };
  skills: { name: string; action: 'create' | 'use-existing' | 'use-existing-different' | 'error'; error?: string; existingId: string | null; description: string; version: string; license: string; checksum: string; scan: { level: Level; kind: string; labels: string[]; findings: Finding[] } | null; permissions: Permissions | null }[];
  routines: { count: number; supported: boolean };
  externalCalls: string[];
  needsAcknowledge: boolean;
  warnings: string[];
  signature?: SignatureView;
  policy?: PolicyDecision;
}

export interface AppItem {
  type: 'app';
  id: string;
  title: string;
  description: string;
  category: string;
  publisher: string;
  verified: boolean;
  license: string;
  version: string;
  transport: string;
  permissions: string[];
  externalCalls: string[];
  homepage: string;
  installed: boolean;
  needsAuth: boolean;
  changelog: Changelog[];
  catalogId: string;
  catalogName?: string;
  sourceKind?: 'builtin' | 'external' | 'server';
  /** External connector package: installed through the connector module. */
  packaged?: boolean;
  signature: SignatureView;
}

export interface SourceView {
  id: string;
  rowId?: string;
  name: string;
  publisher: string;
  kind: 'builtin' | 'server' | 'external';
  verified: boolean;
  url?: string;
  enabled?: boolean;
  expectedSha256?: string | null;
  sha256?: string | null;
  fetchedAt?: string;
  error?: string | null;
  warnings?: string[];
  skills: number;
  bots: number;
  connectors?: number;
}

export interface ReportRow {
  id: string;
  user_id: string;
  reporter?: string;
  item_type: 'skill' | 'bot' | 'app';
  catalog_id: string;
  item_id: string;
  item_name: string;
  reason: string;
  details: string;
  status: 'open' | 'resolved' | 'dismissed';
  resolution: string;
  created_at: string;
  resolved_at: string | null;
  blocked: boolean;
}

export const REPORT_REASONS: { id: string; label: string }[] = [
  { id: 'malware', label: 'Schadelijke code' },
  { id: 'injectie', label: 'Verdachte instructies (prompt-injectie)' },
  { id: 'privacy', label: 'Verzamelt of lekt gegevens' },
  { id: 'auteursrecht', label: 'Schendt auteursrecht of licentie' },
  { id: 'misleidend', label: 'Misleidend of onjuist' },
  { id: 'werkt-niet', label: 'Werkt niet' },
  { id: 'anders', label: 'Anders' },
];

export const SOURCE_TYPES: Record<string, string> = {
  paste: 'Geplakt',
  zip: 'Zip-bestand',
  folder: 'Map (upload)',
  path: 'Map op deze computer',
  discover: 'Gevonden op deze computer',
  url: 'Internetadres',
  github: 'GitHub',
  catalog: 'Marktplaats',
  bot: 'Voorgesteld door een bot',
  template: 'Uit een bot-sjabloon',
  edit: 'Bewerkt',
  curated: 'TeamBot-catalogus',
  chat: 'Bewaard uit een gesprek',
  document: 'Gemaakt van een document',
};

/** Sizes in the interface locale ("13 kB", "1,5 MB" / "1.5 MB"), never by hand: that gave "13.3 KB" in Dutch. */
export { formatBytes } from '../../lib/format';

export function fmtDate(iso: string | null | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString(uiLocale(), { dateStyle: 'medium', timeStyle: 'short' });
}

// ---------------------------------------------------------------- internet sources
// Shapes returned by /api/skills/web/* (server/modules/skills/web-routes.ts) and /api/mcp/registry/* (server/modules/mcp/api.ts).

export interface LicenseView {
  spdx: string | null;
  label: string;
  status: 'open' | 'restricted' | 'unknown';
  source: 'skill-file' | 'frontmatter' | 'repo-file' | 'github' | 'registry' | 'none';
  file?: string;
}

export interface WebSkillItem {
  type: 'skill';
  source: 'github' | 'skills.sh';
  catalogId: string;
  id: string;
  ref?: string;
  repo: string | null;
  path: string | null;
  skillId?: string;
  sourceLabel?: string;
  name: string;
  title: string;
  description: string;
  category: string;
  version?: string;
  commit?: string | null;
  updatedAt?: string | null;
  publisher: string;
  author?: string;
  license: LicenseView;
  installable: boolean | null;
  reason: string | null;
  stars?: number | null;
  installs: number | null;
  kind?: 'prompt' | 'scripts';
  scanLevel?: Level;
  labels?: string[];
  fileCount?: number;
  size?: number;
  partial?: boolean;
  unresolved?: boolean;
  url?: string;
  installed: { skillId: string; version: string; status: string; updateAvailable: boolean } | null;
}

/** A skill from TeamBot's own catalogue, shown while the internet collections are fetched for the first time. */
export interface StarterSkill {
  catalogId: string;
  id: string;
  title: string;
  description: string;
  category: string;
  version: string;
}

export interface WebSkillList {
  items: WebSkillItem[];
  total: number;
  categories: string[];
  /** Collections that are still downloading for the first time. */
  pending: string[];
  /** Collections shown from the cache while they are checked for changes. */
  refreshing: string[];
  collections: { total: number; ready: number };
  starter: StarterSkill[];
  starterTotal: number;
  errors: { repo: string; error: string }[];
  stale: boolean;
  skillsSh: { used: boolean; error: string | null; stale: boolean };
  offline: boolean;
}

/** A connector from TeamBot's own catalogue, shown while the MCP Registry is fetched for the first time. */
export interface StarterApp {
  id: string;
  title: string;
  description: string;
  publisher: string;
}

export interface RegistryList {
  mode: 'featured' | 'search';
  items: RegistryCard[];
  categories: string[];
  nextCursor: string | null;
  stale: boolean;
  offline?: boolean;
  error?: string | null;
  errors?: string[];
  pending?: string[];
  refreshing?: string[];
  featuredTotal?: number;
  starter?: StarterApp[];
  starterTotal?: number;
}

export interface WebSkillDetail extends WebSkillItem {
  skillMd: string;
  meta: SkillMeta;
  errors: string[];
  warnings: string[];
  scan: { level: Level; kind: 'prompt' | 'scripts'; labels: string[]; findings: Finding[]; files: ScanFileView[]; domains: string[] };
  permissions: Permissions;
  files: ScanFileView[];
  checksum: string;
  substance?: Substance;
  repoMeta: { stars: number; license: string | null; pushedAt: string | null; description: string; archived: boolean; htmlUrl: string } | null;
  repoLicense: LicenseView | null;
  indexMode: 'zip' | 'tree';
  stale: boolean;
}

export interface WebSources {
  offline: boolean;
  github: { tokenSet: boolean; apiBlockedUntil: number | null };
  skillsSh: { blockedUntil: number | null };
  collections: { repo: string; note: string; url: string; indexed: boolean; mode: string | null; skills: number | null; installable: number | null; commit: string | null; updatedAt: string | null; fetchedAt: string | null; license: string | null; stars: number | null }[];
}

export interface RegistryCard {
  name: string;
  title: string;
  description: string;
  version: string;
  status: 'active' | 'deprecated' | 'deleted';
  publisher: string;
  publisherKind: 'github' | 'domain';
  /** TeamBot's own icon route (API path, load with authUrl), never the publisher's URL. */
  icon: string | null;
  category: string;
  featured: boolean;
  remote: boolean;
  local: boolean;
  repository: string | null;
  websiteUrl: string | null;
  updatedAt: string | null;
  kinds: string[];
  needsSecrets: boolean;
  installable: boolean;
  installed: { id: string; display: string; version: string; option: string }[];
}

export interface RegistryField {
  name: string;
  label: string;
  help?: string;
  secret?: boolean;
  required?: boolean;
  prefix?: string;
  placeholder?: string;
  default?: string;
}

export interface RegistryOption {
  key: string;
  kind: string;
  label: string;
  transport: 'stdio' | 'http' | 'sse';
  supported: boolean;
  available: boolean;
  reason?: string;
  unavailableReason?: string;
  runtime?: string;
  commandFound?: boolean;
  identifier?: string;
  version?: string;
  packageUrl?: string;
  url?: string;
  command?: string;
  args?: string[];
  inputs: { name: string; label: string; help?: string; required: boolean; default?: string; choices?: string[]; kind: 'url' | 'arg' }[];
  env: RegistryField[];
  headers: RegistryField[];
  preview: string;
}

export interface RegistryDetail extends RegistryCard {
  statusMessage: string;
  publishedAt: string | null;
  isLatest: boolean;
  subfolder: string | null;
  options: RegistryOption[];
  versions: { version: string; publishedAt: string | null; status: string; isLatest: boolean }[];
  license: string | null;
  licenseSource: string | null;
  registryUrl: string;
  stale: boolean;
  fetchedAt: string;
  signature: SignatureView;
  policy: PolicyDecision;
}

// ------------------------------------------------------------------ TeamBot catalogue (pinned sources)

export interface CuratedUpdate {
  to: string;
  origin: 'catalogus' | 'bron';
  changes: string[];
  checkedAt: string;
  /** A newer pin in TeamBot's catalogue, known without a check (PARITEIT 7.3). */
  pin?: { toDate: string; note: string; changesKnown: boolean };
}

export interface CuratedBadge {
  id: string;
  repo: string;
  commit: string | null;
  license: string | null;
  publisher: string;
  inCatalog: boolean;
  update: CuratedUpdate | null;
}

export interface CuratedCard {
  id: string;
  name: string;
  note: string;
  pack: string;
  category: string;
  sourceId: string;
  repo: string;
  path: string;
  publisher: string;
  owner: string;
  publisherStatus: 'known' | 'lookalike' | 'unknown';
  license: string;
  commit: string;
  commitDate: string;
  verifiedAt: string;
  url: string;
  scripts: boolean;
  windows: { status: 'ja' | 'deels' | 'niet-getest'; note: string } | null;
  needs: string;
  installed: { skillId: string; status: string; commit: string | null; version: string; trusted: boolean; update: CuratedUpdate | null } | null;
}

export interface CuratedList {
  sources: { id: string; repo: string; publisher: string; owner: string; license: string; commit: string; commitDate: string; verifiedAt: string; note: string; url: string; skills: number }[];
  packs: string[];
  items: CuratedCard[];
  offline: boolean;
}

export interface CuratedLicense {
  spdx: string | null;
  status: 'open' | 'restricted' | 'unknown';
  file: string | null;
  storedAs: string | null;
  matches: boolean;
  problem: string | null;
}

export interface CuratedDetail extends CuratedCard {
  commitShown: string;
  meta: SkillMeta;
  errors: string[];
  warnings: string[];
  skillMd: string;
  scan: { level: Level; kind: string; labels: string[]; findings: Finding[]; files: ScanFileView[]; domains: string[] };
  permissions: Permissions;
  files: ScanFileView[];
  size: number;
  checksum: string;
  licenseFound: CuratedLicense;
  dropped: { path: string; reason: string }[];
  refused: { path: string; reason: string }[];
  sourceFiles: string[];
  sourceDir: string;
  description: { changed: boolean; repaired: boolean; error?: string };
  problems: string[];
  installable: boolean;
  substance?: Substance;
}

export interface DiffLineView {
  op: ' ' | '-' | '+';
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface FileDiffView {
  path: string;
  status: 'added' | 'removed' | 'changed';
  diff: { added: number; removed: number; truncated: boolean; tooLarge?: boolean; hunks: { oldStart: number; newStart: number; lines: DiffLineView[] }[] };
}

export interface CuratedDiff {
  skillId: string;
  name: string;
  id: string;
  repo: string;
  from: { commit: string | null; version: string; url: string | null };
  to: { commit: string; version: string; url: string; inCatalog: boolean };
  compare: string | null;
  files: { files: FileDiffView[]; added: number; removed: number; changed: number; unchanged: number };
  permissions: PermissionDiff;
  scan: { level: Level; kind: string; labels: string[]; findings: Finding[] };
  trustReset: boolean;
  license: CuratedLicense;
  dropped: { path: string; reason: string }[];
  problems: string[];
  identical: boolean;
}

export interface CuratedInstallResult {
  status: CommitResult['status'] | 'installed';
  skillId?: string;
  name?: string;
  error?: string | null;
  commit?: string;
  license?: string | null;
  staging?: StagingView | null;
  /** Bots of another team that did not get the skill (the server says so, never silently). */
  notEnabled?: { agentId: string; name: string; skill: string }[];
}
