import { ExternalLink, RotateCcw } from 'lucide-react';
import type { Message } from '../../lib/types';
import { api } from '../../lib/api';
import { Button, toast, useAsync } from '../../components/ui';

interface StuckPart {
  ref: string;
  kind: 'approval' | 'question' | 'error' | 'interrupted' | 'routine';
  link: string;
  retry: boolean;
  retriedAt?: string;
}

const OPEN_LABEL: Record<StuckPart['kind'], string> = {
  approval: 'Naar Wacht op jou',
  question: 'Naar Wacht op jou',
  error: 'Gesprek openen',
  interrupted: 'Gesprek openen',
  routine: 'Bonnetje bekijken',
};

/**
 * Under the main bot's message about stuck work (server/modules/teams/stuck.ts): where you answer, and "Opnieuw
 * proberen" for a broken task or a failed routine. The main bot never does this by itself; the button is your click.
 */
export function StuckExtra({ message }: { message: Message }) {
  const items = ((message.parts as any)?.stuck?.items || []) as StuckPart[];
  const { busy, run } = useAsync();
  if (!items.length) return null;
  const retry = (ref: string) =>
    run(async () => {
      await api.post('/teams/stuck/retry', { messageId: message.id, ref });
      toast('Opnieuw gestart', 'ok');
    });
  return (
    <div className="mt-2 flex flex-col gap-1.5" data-stuck>
      {items.map((i, n) => (
        <div key={i.ref} className="flex flex-wrap items-center gap-2 text-xs">
          {items.length > 1 && <span className="text-muted">{n + 1}.</span>}
          <a href={i.link} className="inline-flex items-center gap-1 text-accent hover:underline">
            <ExternalLink className="h-3 w-3" />
            {OPEN_LABEL[i.kind]}
          </a>
          {i.retry &&
            (i.retriedAt ? (
              <span className="text-muted">Opnieuw gestart</span>
            ) : (
              <Button size="sm" loading={busy} onClick={() => retry(i.ref)} icon={<RotateCcw className="h-3.5 w-3.5" />}>
                Opnieuw proberen
              </Button>
            ))}
        </div>
      ))}
    </div>
  );
}
