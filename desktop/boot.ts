/**
 * The first thing the desktop app runs (dist/desktop/main.js). It only does three things, with as little code as
 * possible so it still works when the rest of the install is broken:
 *  - errors nobody caught go to `<data>/logs/desktop.log` instead of Electron's raw error window (or nowhere);
 *  - it loads the real shell (desktop/main.ts → dist/desktop/shell.js); when that cannot even be loaded (a missing
 *    file or dependency) the owner reads that the install is damaged and what to do;
 *  - a start that fails later (the database, the server) gets the same calm message, with "Opnieuw proberen".
 *
 * The shell tells this file how the start went through two events on Electron's `app` (they are separate bundles):
 * `teambot:started` and `teambot:start-failed` (with the error).
 */
import { app, BrowserWindow, dialog, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from '../server/core/config.js';
import { tr } from '../server/core/i18n.js';
import { isLanguage, matchLanguage } from '../shared/languages.js';
import { readShellState } from './shell-state.js';
import { isDamagedInstall, recordCrash, startFailureText } from './startup-errors.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** An installer asked a running TeamBot to close ("TeamBot.exe --quit"): never a dialog in its way. */
const quiet = process.argv.includes('--quit');
let started = false;
let failing = false;

function dataDir(): string | null {
  try {
    return loadConfig({ mode: 'desktop' }).dataDir;
  } catch {
    return null;
  }
}
const logDir = () => path.join(dataDir() || app.getPath('temp'), 'logs');

/** The owner's language of the last run, else the system's; Dutch when even the dictionaries are gone. */
function translate(text: string): string {
  try {
    const dir = dataDir();
    const saved = dir ? readShellState(path.join(dir, 'electron')).lang : undefined;
    return tr(saved && isLanguage(saved) ? saved : matchLanguage([app.getLocale?.() || '']), text);
  } catch {
    return text;
  }
}

async function startFailed(e: unknown, damaged: boolean) {
  if (failing) return;
  failing = true;
  const logFile = recordCrash(logDir(), 'START', e);
  console.error('[desktop] start mislukt', e);
  if (quiet) return app.exit(1);
  try {
    await app.whenReady();
    // The start page ("Even geduld…") would stay behind the message.
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
    const t = startFailureText(e, { damaged, logFile }, translate);
    const { response } = await dialog.showMessageBox({ type: 'error', title: 'TeamBot', message: t.title, detail: `${t.message}\n\n${t.detail}`, buttons: t.buttons, defaultId: 0, cancelId: t.buttons.length - 1, noLink: true });
    if (response === 0) app.relaunch({ args: process.argv.slice(1) });
    else if (logFile && response === 1) await shell.openPath(logFile);
  } finally {
    app.exit(1);
  }
}

process.on('uncaughtException', (e) => {
  // Before the start is over nothing works yet: say so. After it, TeamBot keeps running and the log has the error.
  if (!started) void startFailed(e, isDamagedInstall(e));
  else {
    console.error('[desktop]', e);
    recordCrash(logDir(), 'ERROR', e);
  }
});
process.on('unhandledRejection', (e) => {
  console.error('[desktop]', e);
  recordCrash(logDir(), 'REJECTION', e);
});
(app as NodeJS.EventEmitter).on('teambot:started', () => (started = true));
(app as NodeJS.EventEmitter).on('teambot:start-failed', (e: unknown) => void startFailed(e, isDamagedInstall(e)));

try {
  // Not a static import: a missing file or dependency of the shell must end up in the catch below.
  await import(pathToFileURL(path.join(here, 'shell.js')).href);
} catch (e) {
  void startFailed(e, isDamagedInstall(e));
}
