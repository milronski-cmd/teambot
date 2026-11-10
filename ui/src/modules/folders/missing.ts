/**
 * Does the team folder form say "Deze map bestaat nog niet"? Only for the path as it is typed now, and never for the
 * folder that is saved: saving creates it (practice test 0.4.4: after "Opslaan" the note stayed, for a folder that
 * TeamBot had just made).
 */
export function folderMissing(check: { path: string; missing: boolean } | null, path: string, saved: string | null | undefined): boolean {
  const p = path.trim();
  if (!check || check.path !== p || !check.missing) return false;
  return !saved || saved.trim() !== p;
}
