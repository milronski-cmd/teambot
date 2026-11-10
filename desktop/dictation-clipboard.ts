/**
 * The clipboard as the dictation insert step needs it, on top of Electron's clipboard API. The API and its
 * ClipboardItem class are passed in, so this file has no Electron import and is tested with a fake.
 *
 * Dictated text only passes through the clipboard on its way to Ctrl+V, so on Windows it must not land in clipboard
 * history (Win+V), the cloud clipboard or clipboard managers. Windows skips a clipboard entry that carries the formats
 * below, provided they are in the SAME clipboard transaction as the text: Electron's `clipboard.write()` commits all
 * entries of one call atomically (a second write would empty the clipboard first). The owner's earlier clipboard is
 * put back the same way: it was already in the history when it was copied, so putting it back is no new copy (and
 * something copied from a password manager must not end up in the history through us).
 */
import type { ClipSnapshot, InsertDeps } from './dictation-insert.js';

/** Windows clipboard formats that keep an entry out of clipboard history, cloud sync and clipboard monitors. */
export const PRIVATE_FORMATS = ['ExcludeClipboardContentFromMonitorProcessing', 'CanIncludeInClipboardHistory', 'CanUploadToCloudClipboard'] as const;

/** Electron's name for a raw, platform-specific clipboard format (RegisterClipboardFormat on Windows). */
export const rawType = (format: string) => `electron application/osclipboard;format="${format}"`;

/** One entry of a clipboard item: what Electron's ClipboardItem takes and what `getType()` gives back. */
export type ClipValue = string | Blob | { title: string; url: string };
export type ClipRecord = Record<string, ClipValue>;

/** The part of Electron's `clipboard` used here. */
export interface ClipboardApi {
  has(type: string): Promise<boolean>;
  read(): Promise<{ readonly types: readonly string[]; getType(type: string): Promise<unknown> }[]>;
  write(items: any[]): Promise<void>;
  readText(): Promise<string>;
  clear(): void;
}
export type ClipboardItemClass = new (entries: Record<string, any>) => unknown;

/** The marker entries, each a DWORD 0 ("no"); on other systems none (the paste step is Windows-only). */
export function privateEntries(platform: NodeJS.Platform = process.platform): Record<string, Blob> {
  if (platform !== 'win32') return {};
  return Object.fromEntries(PRIVATE_FORMATS.map((f) => [rawType(f), new Blob([new Uint8Array(4)])]));
}

/** `entries` plus the markers, for one clipboard write. */
export function privateRecord(entries: ClipRecord, platform: NodeJS.Platform = process.platform): ClipRecord {
  return { ...entries, ...privateEntries(platform) };
}

/**
 * Everything `read()` offers is copied out (not just referenced: the items read lazily) so it can be written back
 * atomically; copied files cannot be put back that way.
 */
export function dictationClipboard(clipboard: ClipboardApi, Item: ClipboardItemClass, platform: NodeJS.Platform = process.platform): InsertDeps['clipboard'] {
  return {
    async snapshot(): Promise<ClipSnapshot> {
      let files = false;
      if (platform === 'win32') {
        try {
          files = await clipboard.has(rawType('FileNameW'));
        } catch {
          /* unknown: assume not */
        }
      }
      let restorable = !files;
      const records: ClipRecord[] = [];
      try {
        for (const item of await clipboard.read()) {
          const rec: ClipRecord = {};
          for (const t of item.types) {
            try {
              rec[t] = (await item.getType(t)) as ClipValue;
            } catch {
              restorable = false;
            }
          }
          if (Object.keys(rec).length) records.push(rec);
        }
      } catch {
        restorable = false;
      }
      return { restorable, empty: !files && !records.length, data: records };
    },
    writeText: (t) => clipboard.write([new Item(privateRecord({ 'text/plain': t }, platform))]),
    readText: () => clipboard.readText(),
    async restore(s) {
      const records = (s.data as ClipRecord[]) || [];
      if (s.empty || !records.length) return clipboard.clear();
      // One item per clipboard on Windows; the markers go with the first.
      await clipboard.write(records.map((r, i) => new Item(i === 0 ? privateRecord(r, platform) : r)));
    },
  };
}
