/**
 * A bot's folder as people know it (acceptance round 4, Q-03): TeamBot's own folder is "…\workspaces\ag_<id>", an
 * internal id nobody needs to read, so it is "Werkmap van Mila"; a folder the owner chose keeps its path (their own
 * name for it). The full path is only behind a copy button (components/FolderName).
 */
import { tText as t } from './format.js';

/** TeamBot's own folder for a bot: "…\workspaces\ag_<id>" (also with a sub folder after it). */
export const isOwnWorkspace = (path: string | null | undefined) => /[\\/]workspaces[\\/][a-z]{1,6}_[0-9a-f]{12,}([\\/]|$)/i.test(String(path || ''));

/** "Werkmap van Mila", the chosen path, or "Automatisch" when none is set. */
export function folderName(path: string | null | undefined, botName?: string | null): string {
  const p = String(path || '').trim();
  if (!p) return t('Automatisch');
  if (isOwnWorkspace(p)) return botName ? t('Werkmap van {0}', botName) : t('Eigen werkmap van de bot');
  return p;
}
