// The right-click menu of the app window: spelling suggestions for a misspelled word, "Toevoegen aan woordenboek",
// and cut/copy/paste/select all. Electron shows no menu at all without this, so a red underline could not be fixed
// and nothing could be pasted with the mouse. Pure (no Electron import), so it is unit-tested; main.ts turns the
// items into a native Menu. The spellchecker language stays Electron's default (the language of Windows): choosing
// another one would download a dictionary from the internet.

/** The parts of Electron's ContextMenuParams this menu uses. */
export interface MenuParams {
  misspelledWord?: string;
  dictionarySuggestions?: string[];
  isEditable?: boolean;
  selectionText?: string;
  linkURL?: string;
  editFlags?: { canCut?: boolean; canCopy?: boolean; canPaste?: boolean; canSelectAll?: boolean };
}

export type MenuAction = 'replace' | 'learn' | 'cut' | 'copy' | 'paste' | 'selectAll' | 'copyLink';
export type MenuEntry = { kind: 'separator' } | { kind: 'item'; label: string; action: MenuAction; enabled: boolean; word?: string };

/** At most this many spelling suggestions (Chromium usually gives up to 5). */
export const MAX_SUGGESTIONS = 5;

/** The menu for one right click; empty = show nothing. `L` puts a Dutch text in the owner's language. */
export function contextMenuEntries(p: MenuParams, L: (text: string) => string = (t) => t): MenuEntry[] {
  const out: MenuEntry[] = [];
  const item = (label: string, action: MenuAction, enabled = true, word?: string) => out.push({ kind: 'item', label, action, enabled, ...(word !== undefined ? { word } : {}) });
  const sep = () => out.length && out[out.length - 1].kind !== 'separator' && out.push({ kind: 'separator' });
  const flags = p.editFlags || {};
  const word = (p.misspelledWord || '').trim();
  if (p.isEditable && word) {
    const sugg = (p.dictionarySuggestions || []).filter((s) => s && s !== word).slice(0, MAX_SUGGESTIONS);
    if (sugg.length) for (const s of sugg) item(s, 'replace', true, s);
    else item(L('Geen suggesties'), 'replace', false);
    item(L('Toevoegen aan woordenboek'), 'learn', true, word);
    sep();
  }
  if (p.isEditable) {
    item(L('Knippen'), 'cut', flags.canCut !== false && !!p.selectionText);
    item(L('Kopiëren'), 'copy', flags.canCopy !== false && !!p.selectionText);
    item(L('Plakken'), 'paste', flags.canPaste !== false);
    sep();
    item(L('Alles selecteren'), 'selectAll', flags.canSelectAll !== false);
  } else if ((p.selectionText || '').trim()) {
    item(L('Kopiëren'), 'copy', flags.canCopy !== false);
  }
  if (/^(https?:|mailto:)/i.test(p.linkURL || '')) {
    sep();
    item(L('Link kopiëren'), 'copyLink');
  }
  while (out.length && out[out.length - 1].kind === 'separator') out.pop();
  return out;
}
