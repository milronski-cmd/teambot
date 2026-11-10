import { execFile } from 'node:child_process';
import type { Ctx } from '../../core/types.js';
import { safeEnv } from '../../tools/builtin/shell.js';

/**
 * Is the watchdog's scheduled task there? (0.4.4, P14) The installer makes it (build/installer.nsh, customInstall);
 * this only asks Windows, read-only (`schtasks /Query`). 'none' outside Windows, in server mode and in development
 * (TEAMBOT_DATA set: a dev or test run never looks at the owner's tasks).
 */
/** Per Windows account, in the root folder (build/installer.nsh customInstall uses the same name). */
export const taskName = (env: NodeJS.ProcessEnv = process.env) => `TeamBot Wachter (${env.USERDOMAIN || ''} ${env.USERNAME || ''})`;

export type TaskState = 'on' | 'missing' | 'none';
let cache: { at: number; v: TaskState } | null = null;

export async function watchdogTask(ctx: Ctx): Promise<TaskState> {
  if (process.platform !== 'win32' || ctx.config.mode !== 'desktop' || process.env.TEAMBOT_DATA || process.env.NODE_TEST_CONTEXT) return 'none';
  if (cache && Date.now() - cache.at < 60_000) return cache.v;
  const v = await new Promise<TaskState>((resolve) =>
    execFile('schtasks.exe', ['/Query', '/TN', taskName()], { timeout: 4000, windowsHide: true, env: safeEnv() }, (err) => resolve(err ? 'missing' : 'on')),
  );
  cache = { at: Date.now(), v };
  return v;
}
