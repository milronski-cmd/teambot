// Types for scripts/release-feed.mjs (used by tests/update-feed.test.ts).
export function installerFileName(version: string, pattern?: string): string;
export function latestYml(o: { version: string; name: string; sha512: string; size: number; releaseDate: string; releaseNotes?: string }): string;
export function changelogNotes(version: string, changelog?: string): string;
export function makeFeed(o?: {
  dir?: string;
  out?: string;
  version?: string;
  pattern?: string;
  previous?: boolean;
  notes?: boolean;
  now?: Date;
}): Promise<{ out: string; version: string; name: string; sha512: string; size: number; files: string[]; previous: string | null }>;
export function checkFeed(dir?: string): Promise<{ ok: true; version: string; name: string } | { ok: false; reason: string }>;
