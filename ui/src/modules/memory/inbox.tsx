import { useState } from 'react';
import { Scale } from 'lucide-react';
import { api } from '../../lib/api';
import { Button, toastError } from '../../components/ui';
import { t } from '../../lib/i18n';
import { type MemItem, useMem } from './lib';

/**
 * "Wacht op jou": the one case memory does not decide by itself. A new note contradicts an older one and the newer
 * one may not simply win (the old one is your own words or pinned, or the new one comes from outside). One short
 * question per pair: which one is right? Everything else memory proposes stays in Geheugen › Te beoordelen.
 */
interface Review {
  proposals: { item: MemItem; conflict: MemItem | null }[];
}

const conflicts = (d: Review | null) => (d?.proposals || []).filter((p) => p.item.proposal_reason === 'conflict' && p.conflict);

export function useConflictCount(): number {
  return conflicts(useMem<Review>('/memory/review').data).length;
}

function ConflictCard({ p, onDone }: { p: { item: MemItem; conflict: MemItem | null }; onDone(): void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const decide = async (which: 'new' | 'old') => {
    setBusy(which);
    try {
      if (which === 'new') await api.post(`/memory/items/${p.item.id}/approve`, { mode: 'replace' });
      else await api.post(`/memory/items/${p.item.id}/reject`, { reason: 'het oude klopt' });
      onDone();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div role="group" aria-label={t('Wat klopt?')} className="tb-ask tb-in w-full space-y-2 rounded-card border p-4">
      <div className="text-[15px] font-bold leading-snug">Wat klopt?</div>
      <p className="break-words text-[13.5px]">
        <span className="text-muted">{'Nieuw: '}</span>
        {p.item.content}
      </p>
      <p className="break-words text-[13.5px]">
        <span className="text-muted">{'Stond er al: '}</span>
        {p.conflict?.content}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" loading={busy === 'new'} disabled={!!busy} onClick={() => decide('new')}>
          Het nieuwe klopt
        </Button>
        <Button size="sm" variant="ghost" loading={busy === 'old'} disabled={!!busy} onClick={() => decide('old')}>
          Het oude klopt
        </Button>
      </div>
    </div>
  );
}

export function ConflictInbox() {
  const { data, reload } = useMem<Review>('/memory/review');
  const list = conflicts(data);
  if (!list.length) return null;
  return (
    <section aria-labelledby="inbox-memory" className="space-y-3">
      <h2 id="inbox-memory" className="flex items-center gap-2 pt-2 text-[15px] font-bold tracking-tight">
        <Scale className="h-4 w-4 text-muted" aria-hidden /> Geheugen: wat klopt? <span className="font-semibold tabular-nums text-muted">{list.length}</span>
      </h2>
      {list.slice(0, 10).map((p) => (
        <ConflictCard key={p.item.id} p={p} onDone={reload} />
      ))}
    </section>
  );
}
