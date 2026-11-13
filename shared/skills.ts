/**
 * The JSON shapes of /api/skills/* written once: the server (server/modules/skills) builds them, the page
 * (ui/src/modules/skills/api.ts) reads them. Plus the one number format both show (stars, downloads).
 */

/** 1234 → "1,2k", 56789 → "57k" (Dutch decimal comma). */
export function starsText(n: number | undefined | null): string {
  if (!n || n < 0) return '';
  if (n < 1000) return String(n);
  if (n < 10_000) return (Math.round(n / 100) / 10).toString().replace('.', ',') + 'k';
  return Math.round(n / 1000) + 'k';
}

// ---------------------------------------------------------------- the safety scan (server/modules/skills/scan.ts)

export type Severity = 'info' | 'warn' | 'danger';

export interface Finding {
  severity: Severity;
  kind: 'script' | 'binary' | 'injection' | 'exfiltration' | 'secret' | 'network' | 'hidden' | 'command' | 'sensitive';
  file: string;
  line?: number;
  message: string;
  excerpt?: string;
}

export interface Permissions {
  /** Declared tools (allowed-tools), as written. */
  tools: string[];
  /** TeamBot tool groups the declared tools map onto. */
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
  /** True when the new version needs more than the old one (requires explicit confirmation). */
  elevated: boolean;
}

// ---------------------------------------------------------------- SKILL.md (server/modules/skills/format.ts)

/** The frontmatter of a SKILL.md as TeamBot reads it. */
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

// ---------------------------------------------------------------- publishers (server/modules/skills/publishers.ts)

export type PublisherPolicy = 'open' | 'signed-only' | 'allowlist';

export interface TrustedPublisher {
  publicKey: string;
  name: string;
  fingerprint: string;
  publisherId: string;
  addedBy: string;
  addedAt: string;
}

export type SignatureState = 'builtin' | 'trusted' | 'untrusted' | 'unsigned' | 'invalid';

/** What the API shows wherever a package appears. */
export interface SignatureView {
  state: SignatureState;
  label: string;
  /** Display name: trust-list name, "TeamBot" for built-ins, otherwise the self-declared name. */
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
  /** Invalid signature or incompatible: never installable, not even with an override. */
  blocked: boolean;
  blockReason: string | null;
}

export interface PolicyDecision {
  policy: PublisherPolicy;
  allowed: boolean;
  /** Not allowed by the policy, but this user may confirm an override. */
  needsOverride: boolean;
  canOverride: boolean;
  /** Refused outright (invalid/incompatible, or a restricted member outside the policy). */
  blocked: boolean;
  reason: string | null;
}

export interface PublisherChange {
  from: { name: string; fingerprint: string | null } | null;
  to: { name: string; fingerprint: string | null } | null;
  reason: string;
}

// ---------------------------------------------------------------- the open search (websource.ts, curated-routes.ts)

export type OpenSort = 'stars' | 'trending' | 'new' | 'updated';

/** One result of an open source: a repository on GitHub, or one skill (of a GitHub repository, or hosted by ClawHub). */
export interface OpenHit {
  kind: 'repo' | 'skill';
  from: 'github' | 'skills.sh' | 'clawhub';
  /** `owner/name` on GitHub; for ClawHub `owner/slug` there. */
  repo: string;
  /** Name of the skill inside the repository; null for a repository. */
  skill: string | null;
  name: string;
  description: string;
  /** Stars on GitHub; for ClawHub its own stars (another count: the card says so). */
  stars: number | null;
  /** Downloads counted by ClawHub. */
  downloads: number | null;
  /** The library itself marks this skill as suspicious. */
  flagged: boolean;
  /** Installs counted by the directory (all time). */
  installs: number | null;
  /** Installs in the last 24 hours (the directory's trending list). */
  recent: number | null;
  /** SPDX id as GitHub detected it for the repository. */
  license: string | null;
  updatedAt: string | null;
  createdAt: string | null;
  archived: boolean;
}

/** A result of the open search as the marketplace and `skill_find` show it. */
export interface OpenCard extends OpenHit {
  /**
   * What installs it: a catalogue id when TeamBot checked this skill, else `github/<owner>/<repo>[/<skill>]` or
   * `clawhub/<owner>/<slug>`.
   */
  id: string;
  url: string;
  /** In TeamBot's checked catalogue (a repository: how many of its skills are). */
  checked: boolean;
  checkedCount: number;
  /** Skills in the repository, when it was opened before (null = not looked yet). */
  skillCount: number | null;
  publisherStatus: 'known' | 'lookalike' | 'unknown';
  publisherNote: string;
  /** A skill: the installed one. A repository: how many of its skills the team has. */
  installed: { skillId: string } | null;
  installedCount: number;
}

export interface OpenSection {
  items: OpenCard[];
  total: number | null;
  more: boolean;
  stale: boolean;
  error: string | null;
}
