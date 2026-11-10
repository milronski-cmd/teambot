import type { Plan } from '../billing/plans.js';

/** What the control plane stores about a running instance (JSON in workspaces.instance). */
export interface InstanceInfo {
  kind: 'process' | 'docker';
  [key: string]: unknown;
}

/** Everything a provisioner needs to (re)start one workspace. The master key is decrypted only for this call. */
export interface InstanceSpec {
  workspaceId: string;
  slug: string;
  /** Public URL of the workspace (TEAMBOT_PUBLIC_URL inside the instance). */
  publicUrl: string;
  /** TEAMBOT_MASTER_KEY for the instance (base64, 32 bytes). */
  masterKey: string;
  /** TEAMBOT_SETUP_TOKEN: the instance only creates its first owner with this token (the router adds it). */
  setupToken: string;
  plan: Plan;
}

export interface Upstream {
  host: string;
  port: number;
}

/**
 * One unmodified TeamBot server (server mode) per workspace. Implementations: `process` (dev/tests: a child
 * process on a free localhost port) and `docker` (production: one hardened container + volume + network).
 */
export interface Provisioner {
  readonly kind: 'process' | 'docker';
  /** Allocate storage (volume/data dir) and networking. Idempotent. */
  create(spec: InstanceSpec): Promise<InstanceInfo>;
  /** Start the instance and wait until /healthz answers. Returns updated info (port, container id, ...). */
  start(info: InstanceInfo, spec: InstanceSpec): Promise<InstanceInfo>;
  /** Stop the instance, keep its data. */
  stop(info: InstanceInfo): Promise<void>;
  /** Stop and delete the instance including all its data. */
  remove(info: InstanceInfo): Promise<void>;
  /** True when the instance answers /healthz. Never throws. */
  health(info: InstanceInfo): Promise<boolean>;
  /** Where the router sends traffic, or null when not running. */
  upstream(info: InstanceInfo): Upstream | null;
  /** Write a ZIP export (consistent database snapshot + files + master key + LEESMIJ.txt) to outFile. */
  exportData(info: InstanceInfo, spec: InstanceSpec, outFile: string): Promise<void>;
  /** Apply plan limits to a running instance (memory/cpu/pids), when supported. */
  applyLimits?(info: InstanceInfo, plan: Plan): Promise<void>;
  /** Disk usage of the instance data in bytes, when measurable. */
  usageBytes?(info: InstanceInfo): Promise<number | null>;
  /** Called when the control plane exits (the process provisioner stops its children). */
  shutdown(): Promise<void>;
}

/** Provisioning failure with a message that is safe to show to the customer (Dutch). */
export class ProvisionError extends Error {}

export const EXPORT_README = (slug: string, date: string) => `TeamBot-export van "${slug}" (${date})

Wat zit erin
- teambot.db (of data.tar): je volledige TeamBot-database: bots, gesprekken, geheugen, routines, instellingen.
- attachments/, workspaces/, skills/: bijlagen, werkmappen van je bots en skills.
- master.key: de sleutel waarmee je opgeslagen API-sleutels versleuteld zijn. Bewaar dit bestand veilig;
  wie het heeft, kan je opgeslagen sleutels lezen.

Zelf verder draaien
1. Pak de export uit in een lege map, bijvoorbeeld /srv/teambot-data (bij data.tar: pak die ook uit).
2. Start TeamBot in servermodus met die map als datamap:
     docker run -v /srv/teambot-data:/data -p 4747:4747 teambot
   of zonder Docker:  npm start -- --mode server --data /srv/teambot-data
3. Log in met je bestaande TeamBot-account.

Niet meegenomen: browserprofielen van bots (opnieuw inloggen op websites), logbestanden en oude back-ups.
`;
