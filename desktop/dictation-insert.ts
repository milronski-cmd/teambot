/**
 * Put dictated text into the app that has the focus: via the clipboard + Ctrl+V, then the previous clipboard comes
 * back. Never into a password field; when pasting is not possible the text is left on the clipboard (and said so).
 * No Electron here (tested with fakes); the shell passes the real clipboard (dictation-clipboard.ts: every write is
 * kept out of Windows clipboard history and the cloud clipboard) and the Windows helper.
 */
import type { InsertResult } from './dictation-machine.js';

export interface ClipSnapshot {
  /** Everything could be read and can be written back (copied files, for example, cannot). */
  restorable: boolean;
  empty: boolean;
  /** Opaque copy of the contents (the shell's own format). */
  data: unknown;
}

export interface PasteResult {
  ok: boolean;
  /** password | elevated | keys | changed | blocked | other */
  code?: string;
  error?: string;
}

export interface InsertDeps {
  /** writeText and restore must not add to clipboard history (the text is only on its way to Ctrl+V). */
  clipboard: { snapshot(): Promise<ClipSnapshot>; writeText(t: string): Promise<void>; readText(): Promise<string>; restore(s: ClipSnapshot): Promise<void> };
  /** null: no way to send keys on this system (the text stays on the clipboard). */
  keys: { paste(o: { expectPid?: number }): Promise<PasteResult>; type(text: string, o: { expectPid?: number }): Promise<PasteResult> } | null;
  sleep(ms: number): Promise<void>;
  /** How long the target app gets to read the clipboard before it is put back. */
  restoreDelayMs?: number;
  /** Tests: only ever send keys to this process (a dedicated test window). */
  expectPid?: number;
}

const WHY: Record<string, string> = {
  password: 'Niet geplakt: dit is een wachtwoordveld.',
  elevated: 'Dit programma draait als administrator; TeamBot mag daar niet typen. De tekst staat op het klembord (Ctrl+V).',
  keys: 'De toetsen werden niet losgelaten; de tekst staat op het klembord (Ctrl+V).',
  changed: 'Het venster veranderde; de tekst staat op het klembord (Ctrl+V).',
  blocked: 'In dit venster plakt TeamBot niet. De tekst staat op het klembord.',
};

export async function insertText(text: string, d: InsertDeps): Promise<InsertResult> {
  if (!d.keys) {
    await d.clipboard.writeText(text);
    return { ok: false, how: 'clipboard', message: 'De tekst staat op het klembord: plak met Ctrl+V.' };
  }
  const snap = await d.clipboard.snapshot();
  const o = { expectPid: d.expectPid };
  if (!snap.restorable) {
    // Something on the clipboard we could not put back (e.g. copied files): type the text instead.
    const r = await d.keys.type(text, o);
    if (r.ok) return { ok: true, how: 'typed' };
    if (r.code === 'password') return { ok: false, how: 'refused', message: WHY.password };
    return { ok: false, how: 'refused', message: r.error || 'Typen lukte niet.' };
  }
  await d.clipboard.writeText(text);
  let r: PasteResult;
  try {
    r = await d.keys.paste(o);
  } catch (e: any) {
    r = { ok: false, code: 'other', error: String(e?.message || e) };
  }
  if (r.ok) {
    await d.sleep(d.restoreDelayMs ?? 450);
    // Put the old clipboard back, unless something else was copied meanwhile.
    if ((await d.clipboard.readText()) === text) await d.clipboard.restore(snap);
    return { ok: true, how: 'pasted' };
  }
  if (r.code === 'password' || r.code === 'blocked') {
    await d.clipboard.restore(snap);
    return { ok: false, how: 'refused', message: WHY[r.code] };
  }
  return { ok: false, how: 'clipboard', message: WHY[r.code || ''] || `Plakken lukte niet${r.error ? ` (${r.error})` : ''}; de tekst staat op het klembord (Ctrl+V).` };
}
