import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const APP_NAME = 'TeamBot';
/** Version from package.json (repo root in development; app root in the bundle, installer and Docker image). */
function readVersion(): string {
  for (const rel of ['../../package.json', '../package.json', '../../../package.json']) {
    try {
      const j = JSON.parse(fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'));
      if (j?.name === 'teambot' && typeof j.version === 'string') return j.version;
    } catch {
      /* try the next location */
    }
  }
  return '0.0.0';
}
export const APP_VERSION = process.env.TEAMBOT_VERSION || readVersion();

export interface Config {
  appName: string;
  version: string;
  dataDir: string;
  port: number;
  host: string;
  /** desktop = single-owner local app; server = multi-user self-host/cloud */
  mode: 'desktop' | 'server';
  publicUrl: string;
  uiDir: string | null;
  allowSignup: boolean;
}

function defaultDataDir() {
  return process.env.TEAMBOT_DATA || standardDataDir();
}

/**
 * Where an installed TeamBot keeps its data on this computer when nothing else is set. A TeamBot with another data
 * folder (TEAMBOT_DATA, a test, a trial install, a server in Docker) is a run of its own: it keeps its team folders in
 * that data folder too (modules/folders, `documentsFor`).
 */
export function standardDataDir() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), APP_NAME);
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'teambot');
}

function findUiDir(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.TEAMBOT_UI_DIR,
    path.resolve(here, '../ui'),
    path.resolve(here, '../../dist/ui'),
    path.resolve(process.cwd(), 'dist/ui'),
  ].filter(Boolean) as string[];
  for (const c of candidates) if (fs.existsSync(path.join(c, 'index.html'))) return c;
  return null;
}

export function loadConfig(over: Partial<Config> = {}): Config {
  const mode = (over.mode || (process.env.TEAMBOT_MODE as Config['mode']) || 'server') as Config['mode'];
  const port = Number(over.port ?? process.env.TEAMBOT_PORT ?? 4747);
  // Closed by default (0.4, package P): every mode listens on this computer only. Reaching it from other devices is
  // an explicit choice (TEAMBOT_HOST / --host, the Docker image sets 0.0.0.0 inside its own network); the startup
  // check in server/modules/network/exposure.ts refuses or warns about unsafe combinations.
  const host = over.host || process.env.TEAMBOT_HOST || '127.0.0.1';
  // Always absolute: an engine that runs in a bot's own folder (Claude Code) gets file paths in the data folder.
  const dataDir = path.resolve(over.dataDir || defaultDataDir());
  fs.mkdirSync(dataDir, { recursive: true });
  for (const d of ['workspaces', 'attachments', 'skills', 'browser', 'backups', 'logs']) fs.mkdirSync(path.join(dataDir, d), { recursive: true });
  return {
    appName: APP_NAME,
    version: APP_VERSION,
    dataDir,
    port,
    host,
    mode,
    publicUrl: over.publicUrl || process.env.TEAMBOT_PUBLIC_URL || '',
    uiDir: over.uiDir === undefined ? findUiDir() : over.uiDir,
    allowSignup: over.allowSignup ?? process.env.TEAMBOT_ALLOW_SIGNUP === '1',
  };
}
