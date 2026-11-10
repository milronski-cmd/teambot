// Types for scripts/secret-scan.mjs (used by tests/secret-scan.test.ts).
export interface Finding {
  line: number;
  kind: string;
  sample: string;
}
export interface AsarEntry {
  path: string;
  size: number;
  unpacked: boolean;
  offset?: number;
}
export const RULES: [string, RegExp][];
export const ALLOW: RegExp[];
export const SKIP_EXT: Set<string>;
export const MAX: number;
export function scanText(text: string): Finding[];
export function openAsar(file: string): { entries: AsarEntry[]; read(entry: AsarEntry): Buffer; close(): void };
export function scanAsar(file: string, label?: string, seen?: Set<string>): { entries: number; scanned: number; findings: (Finding & { file: string })[] };
