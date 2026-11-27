import { useEffect, useState } from 'react';
import { ChevronRight, ListChecks } from 'lucide-react';
import { api } from '../../lib/api';
import { t } from '../../lib/i18n';
import { Card, SectionTitle } from '../../components/ui';
import { BotName } from '../../modules/teamdata/parts';

/** The way from a block on the start screen into its app (the same part of the dashboard, whole). */
export function OpenApp({ href, label }: { href: string; label?: string }) {
  return (
    <a href={href} className="inline-flex h-8 items-center gap-0.5 rounded-lg px-2 text-[13px] text-muted transition-colors hover:bg-surface-2 hover:text-fg" data-testid="dashboard-open">
      {label || t('Alles')}
      <ChevronRight className="h-4 w-4" aria-hidden />
    </a>
  );
}

interface TaskRow {
  id: string;
  title: string;
  status: string;
  statusLabel?: string;
  ownerName?: string;
  owner_type?: string;
  important?: boolean;
}

/** What the team still has to do: how much is open, and the first of it, with who has it. The whole board is Taken. */
export function TasksBlock() {
  const [rows, setRows] = useState<TaskRow[] | null>(null);
  useEffect(() => {
    api.get<TaskRow[]>('/rooms/tasks').then(
      (l) => setRows(Array.isArray(l) ? l : []),
      () => setRows([]),
    );
  }, []);
  const open = (rows || []).filter((x) => x.status !== 'done');
  const doing = open.filter((x) => x.status === 'doing').length;
  const blocked = open.filter((x) => x.status === 'blocked').length;
  // What is being worked on first, then what waits, then the rest.
  const rank = (x: TaskRow) => (x.status === 'doing' ? 0 : x.status === 'blocked' ? 1 : 2);
  const first = [...open].sort((a, b) => rank(a) - rank(b)).slice(0, 5);
  const openText = t('open, waarvan {0} bezig en {1} wachtend', doing, blocked);
  const state = rows === null ? 'loading' : open.length ? 'list' : 'none';
  return (
    <section className="space-y-2" data-testid="dashboard-tasks">
      <SectionTitle icon={ListChecks} tone="violet" action={<OpenApp href="#/tasks" />}>
        Taken
      </SectionTitle>
      <Card className="p-0">
        {state === 'loading' && <div className="p-4 text-sm text-muted">…</div>}
        {state === 'none' && <div className="p-4 text-sm text-muted">Niets open.</div>}
        {state === 'list' && (
          <>
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 p-4 pb-2">
              <span className="text-3xl font-bold leading-tight tracking-tight tabular-nums">{open.length}</span>
              <span className="text-sm text-muted">{openText}</span>
            </div>
            <ul className="divide-y divide-line">
              {first.map((x) => (
                <li key={x.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate" translate="no" title={x.title}>
                    {x.title}
                  </span>
                  <span className="shrink-0 text-xs text-muted">{x.statusLabel ? t(x.statusLabel) : ''}</span>
                  {x.ownerName && x.owner_type === 'agent' ? <BotName name={x.ownerName} size={16} bold={false} className="max-w-28 shrink-0 text-xs text-muted" /> : null}
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </section>
  );
}
