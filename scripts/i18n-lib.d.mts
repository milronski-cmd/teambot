// Types for scripts/i18n-lib.mjs (used by tests/i18n.test.ts).
export interface LanguageEntry {
  code: string;
  name: string;
  english: string;
  locale: string;
  dir: 'ltr' | 'rtl';
  source?: boolean;
}
export const root: string;
export const DICT_DIR: string;
export const LANG_FILE: string;
export const STRINGS_FILE: string;
export const GLOSSARY_FILE: string;
export function languages(): LanguageEntry[];
export function targets(): LanguageEntry[];
export function sourceStrings(): string[];
export function dictFile(code: string): string;
export function readDict(code: string): Record<string, string>;
export function writeDict(code: string, dict: Record<string, string>): void;
export function writeLanguages(list: LanguageEntry[]): void;
export function placeholders(s: string): string;
export function problems(src: string, dst: unknown): string[];
export function dutchWords(lang: string): RegExp;
export function wrongScript(lang: string, v: string, src?: string): boolean;
export function nameLike(src: string): boolean;
export function fixMenuPaths(dict: Record<string, string>, en?: Record<string, string>): number;
export function missingPlurals(locale: string, v: string): string[];
export function copiedDutch(lang: string, dict?: Record<string, string>, sources?: string[], en?: Record<string, string>): string[];
export function copiedDutchTest(lang: string, dict?: Record<string, string>, sources?: string[], en?: Record<string, string>): (source: string, translation: string) => boolean;
export function dutchDetector(lang: string, o?: { sources?: string[]; dict?: Record<string, string>; en?: Record<string, string>; keep?: string[]; ownWords?: string[] }): (text: string) => string;
