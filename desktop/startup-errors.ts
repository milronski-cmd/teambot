/**
 * A start that fails is never silent: what went wrong goes to `<data>/logs/desktop.log`, and the owner reads one calm
 * message that says what to do and where the details are (desktop/boot.ts shows it). No Electron import, so it is
 * tested directly (tests/desktop-startup.test.ts).
 */
import fs from 'node:fs';
import path from 'node:path';

export const DESKTOP_LOG = 'desktop.log';
/** The log never grows without end: past this size the older half goes. */
const MAX_LOG_BYTES = 1_000_000;

const stackOf = (e: unknown) => (e instanceof Error ? e.stack || e.message : typeof e === 'string' ? e : JSON.stringify(e)) || String(e);

/**
 * Parts of the app are missing or unreadable (a broken or half-finished install, a virus scanner that removed a file):
 * only installing again helps. Anything else (the database, a port, a bug) is a start that failed.
 */
export function isDamagedInstall(e: any): boolean {
  const code = String(e?.code || '');
  if (['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_DLOPEN_FAILED', 'ERR_INVALID_PACKAGE_CONFIG', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(code)) return true;
  if (e instanceof SyntaxError) return true;
  return /Cannot find (module|package)|is not a valid Win32 application|The specified module could not be found/i.test(String(e?.message || e));
}

/** Append one entry to the desktop log; returns the file, or null when even that failed. */
export function recordCrash(logDir: string, kind: 'START' | 'ERROR' | 'REJECTION' | 'WINDOW', e: unknown, at = new Date()): string | null {
  const file = path.join(logDir, DESKTOP_LOG);
  try {
    fs.mkdirSync(logDir, { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) {
        const old = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, old.slice(old.indexOf('\n', old.length / 2) + 1));
      }
    } catch {
      /* no log yet */
    }
    fs.appendFileSync(file, `${at.toISOString()} ${kind} ${stackOf(e).slice(0, 8000)}\n`);
    return file;
  } catch {
    return null;
  }
}

export interface StartFailureText {
  title: string;
  message: string;
  detail: string;
  /** In this order: try again, open the log (only with a log file), quit. */
  buttons: string[];
}

/** What the owner reads when TeamBot could not start (Dutch source texts; `T` translates each whole sentence). */
export function startFailureText(e: unknown, o: { damaged: boolean; logFile: string | null }, T: (text: string) => string = (s) => s): StartFailureText {
  const first = stackOf(e).split('\n')[0].slice(0, 300);
  return {
    title: T('TeamBot kon niet starten'),
    message: o.damaged ? T('De installatie van TeamBot is beschadigd of onvolledig. Installeer TeamBot opnieuw; je gegevens blijven bewaard.') : T('Er ging iets mis bij het starten van TeamBot.'),
    detail: o.logFile ? `${first}\n\n${T('De details staan in het logboek:')} ${o.logFile}` : first,
    buttons: [T('Opnieuw proberen'), ...(o.logFile ? [T('Logboek openen')] : []), T('Afsluiten')],
  };
}
