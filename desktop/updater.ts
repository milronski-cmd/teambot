/**
 * Updates for the desktop app (REL-03, parity 16.2). Uses electron-updater with the channel of
 * desktop/update-channel.ts: a folder on a web server with `latest.yml`, the installer and its `.blockmap`
 * (`npm run release:feed`), or the GitHub Releases of a public repository.
 *
 * The flow itself (off until a channel is set, https only, the daily look, the download in the background, installing
 * only when nothing runs and the owner is away, a backup before every install, kept installers and the way back to the
 * previous version) lives in update-flow.ts without Electron, so it is tested with a fake updater and with the real
 * electron-updater against a local feed. This file only plugs in electron-updater, Electron's idle time, notifications
 * and starting an installer.
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app, Notification, powerMonitor } from 'electron';
import electronUpdater from 'electron-updater';
import { UpdateFlow } from './update-flow.js';
import { builtInChannel, type Channel } from './update-channel.js';
import type { WaitReason } from './update-idle.js';

/** resources/app-update.yml of the installed app (written by electron-builder from package.json build.publish). */
function builtIn(): Channel | null {
  try {
    return app.isPackaged ? builtInChannel(fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8')) : null;
  } catch {
    return null;
  }
}

export { type UpdateState } from './update-flow.js';

const { autoUpdater } = electronUpdater;

export class Updater extends UpdateFlow {
  constructor(
    onChange: () => void,
    /** Shell texts in the owner's language (desktop/main.ts); Dutch source texts when not given. */
    t?: (text: string, ...values: (string | number)[]) => string,
    /** `busy`: what runs on the server (server/modules/backups/app-update.ts updateBlockers); null while it starts. */
    o: { dataDir?: string; busy?: () => WaitReason[] | null } = {},
  ) {
    super({
      updater: autoUpdater as any,
      version: app.getVersion(),
      packaged: app.isPackaged,
      configDir: app.getPath('userData'),
      dataDir: o.dataDir || app.getPath('userData'),
      builtIn: builtIn(),
      onChange,
      t,
      // Never in the middle of a task, and only when the owner is away (no keyboard or mouse for a while, or locked).
      idleFacts: () => {
        const busy = o.busy?.() ?? null;
        if (!busy) return null;
        return { busy, userIdleSeconds: powerMonitor.getSystemIdleTime(), locked: powerMonitor.getSystemIdleState(60) === 'locked' };
      },
      notify: (title, body) => {
        if (Notification.isSupported()) new Notification({ title, body }).show();
      },
      // The way back: the kept installer of the previous version, detached, as electron-updater starts an installer.
      spawnInstaller: (file, args) => {
        spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      },
      // The signature check of a downloaded update (only once app-update.yml names a publisher): Windows PowerShell,
      // without a window, with its own module path (one inherited from PowerShell 7 breaks Get-AuthenticodeSignature).
      powershell:
        process.platform === 'win32'
          ? (script) =>
              new Promise<string>((resolve, reject) => {
                const env = { ...process.env };
                delete env.PSModulePath;
                execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 60_000, encoding: 'utf8', env }, (err, stdout) =>
                  err ? reject(err) : resolve(stdout),
                );
              })
          : undefined,
    });
  }
}
