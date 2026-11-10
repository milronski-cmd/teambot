import { FolderOpen } from 'lucide-react';
import { t } from '../../lib/i18n';
import type { Agent } from '../../lib/types';
import { Button, toastError } from '../../components/ui';
import { FolderName } from '../../components/FolderName';

/** The desktop app opens a bot's werkplek in Explorer (desktop/main.ts, only from the TeamBot window). */
const openInDesktop = (): ((agentId: string) => Promise<unknown>) | null => {
  const d = (window as any).teambotDesktop;
  return typeof d?.openWerkplek === 'function' ? d.openWerkplek : null;
};

/**
 * "Werkplek: <map>" on the bot page (0.4.5, "Eigen werkplek"): the bot's own folder, where its files, terminal and
 * downloads live. Outside its folders it asks first; a colleague's werkplek it may only read.
 */
export function WerkplekLine({ agent }: { agent: Pick<Agent, 'id' | 'name' | 'workspace'> }) {
  const open = openInDesktop();
  if (!agent.workspace) return null;
  return (
    <div className="rounded-2xl border border-line bg-surface px-4 py-3" data-testid="bot-workplace">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <FolderOpen className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        <span className="font-semibold">Werkplek:</span>
        <FolderName path={agent.workspace} bot={agent.name} className="min-w-0 flex-1 text-[13px]" />
        {open && (
          <Button size="sm" variant="ghost" onClick={() => open(agent.id).catch(toastError)} aria-label={t('Werkplek van {0} openen', agent.name)}>
            Openen
          </Button>
        )}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted">{t('Hier werkt {0}: bestanden, terminal en downloads. Daarbuiten vraagt de bot eerst toestemming.', agent.name)}</p>
    </div>
  );
}
