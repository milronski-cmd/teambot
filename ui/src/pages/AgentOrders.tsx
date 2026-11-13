import { useEffect, useState } from 'react';
import { api, on } from '../lib/api';
import { ownerOrders } from './agentRows';

/**
 * On the bot page, right under Instructies: what the owner told this bot in a conversation ("Vanaf nu …"), as it
 * stands in the bot's own Werknotities under "Opdrachten van de eigenaar" (memory module). Read-only here; "Aanpassen"
 * opens the bot's Geheugen page, where that text is edited. So everything about what this bot must do is in one spot.
 * Nothing is shown when the memory of this bot cannot be read (memory off, or a bot of someone else).
 */
export function AgentOrders({ agentId }: { agentId: string }) {
  const [orders, setOrders] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .get<{ dossiers: { core?: string; body: string }[] }>(`/memory/place?scope=agent&agentId=${encodeURIComponent(agentId)}`)
        .then((r) => alive && setOrders(ownerOrders(r.dossiers.find((d) => d.core === 'notes')?.body ?? r.dossiers[0]?.body)))
        .catch(() => alive && setOrders(null));
    void load();
    // An order given in a conversation while this page is open shows up here as well.
    const off = on('memory.updated', () => void load());
    return () => {
      alive = false;
      off();
    };
  }, [agentId]);
  if (orders === null) return null;
  return (
    <div className="space-y-1.5 rounded-xl border border-line px-3 py-2.5" data-testid="owner-orders">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-[13px] font-semibold">Opdrachten van de eigenaar</h4>
        <a className="ms-auto text-[13px] font-medium text-muted underline-offset-2 hover:text-fg hover:underline" href={`#/m/memory/bots/${encodeURIComponent(agentId)}`}>
          Aanpassen in Geheugen
        </a>
      </div>
      {orders ? (
        <p className="whitespace-pre-wrap text-sm" translate="no">
          {orders}
        </p>
      ) : (
        <p className="text-xs text-muted">Nog geen. Wat je de bot in een gesprek opdraagt (“vanaf nu …”), komt hier en volgt hij altijd, net als zijn instructies.</p>
      )}
    </div>
  );
}
