import { Copy } from 'lucide-react';
import { t } from '../lib/i18n';
import { folderName, isOwnWorkspace } from '../lib/folderName';
import { cx, toast } from './ui';

export { folderName, isOwnWorkspace };

/** Copies the full path of a folder (the only place it is shown in full). */
export function CopyPath({ path, className }: { path: string; className?: string }) {
  if (!path) return null;
  return (
    <button
      type="button"
      className={cx('inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg coarse:h-9 coarse:w-9', className)}
      aria-label={t('Kopieer het volledige pad')}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(path).then(
          () => toast(t('Pad gekopieerd'), 'ok'),
          () => toast(path),
        );
      }}
    >
      <Copy className="h-3.5 w-3.5" aria-hidden />
    </button>
  );
}

/** "Werkmap van Mila" with a copy button for the full path; never the raw path with its internal id. */
export function FolderName({ path, bot, className }: { path: string | null | undefined; bot?: string | null; className?: string }) {
  const name = folderName(path, bot);
  return (
    <span className={cx('inline-flex min-w-0 max-w-full items-center gap-1 align-middle', className)}>
      <span className={cx('min-w-0 break-words', !isOwnWorkspace(path) && path && 'font-mono [overflow-wrap:anywhere]')}>{name}</span>
      {path ? <CopyPath path={String(path)} /> : null}
    </span>
  );
}
