import { Users } from 'lucide-react';
import { useApp } from '../../lib/store';
import { t } from '../../lib/i18n';
import { BotAvatar } from '../../components/BotFace';
import { Card, SectionTitle, timeAgo } from '../../components/ui';

/** What a run was started by, in the owner's words. */
const WHY: Record<string, string> = {
  user: 'jouw bericht',
  work: 'werk dat er lag',
  routine: 'een vaste taak',
  'team:delegate': 'een taak van een collega',
  'team:ask': 'een vraag van een collega',
  'team:followup': 'een antwoord dat terugkwam',
  'team:broadcast': 'een bericht aan het team',
  resume: 'hervat',
};

/**
 * The team right now: who is at work and on what, who waits for the owner, and who stands still. Read from what the
 * app already knows (the busy runs), so it moves along without a refresh.
 */
export function TeamSection() {
  const agents = useApp((s) => s.agents);
  const runs = useApp((s) => s.runs);
  const threads = useApp((s) => s.threads);
  const title = (id: string) => threads.find((x) => x.id === id)?.title || '';
  const busy = agents
    .map((a) => ({ a, runs: runs.filter((r) => r.agent_id === a.id && (r.status === 'running' || r.status === 'queued' || r.status === 'waiting')) }))
    .filter((x) => x.runs.length);
  const still = agents.filter((a) => !busy.some((b) => b.a.id === a.id));
  if (!agents.length) return null;
  return (
    <section className="space-y-2" data-testid="dashboard-team">
      <SectionTitle icon={Users} tone="violet">
        Team
      </SectionTitle>
      <Card className="p-0">
        {busy.length === 0 ? (
          <div className="p-4 text-sm text-muted">Er is nu niemand aan het werk.</div>
        ) : (
          <ul className="divide-y divide-line">
            {busy.map(({ a, runs: rs }) => (
              <li key={a.id} className="flex items-start gap-3 px-4 py-2.5" data-testid="dashboard-busy">
                <BotAvatar bot={a} size={30} mood="working" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold" translate="no">
                    {a.name}
                  </div>
                  {rs.map((r) => (
                    <a key={r.id} href={`#/t/${r.thread_id}`} className="block truncate text-[13px] text-muted hover:text-fg hover:underline">
                      {r.status === 'waiting' ? t('wacht op jou') : t(WHY[r.trigger] || 'aan het werk')}
                      {title(r.thread_id) ? <span translate="no"> · {title(r.thread_id).replace(/^↳\s*/, '').slice(0, 90)}</span> : null}
                      {r.started_at ? ` · ${timeAgo(r.started_at)}` : ''}
                    </a>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
        {still.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line px-4 py-2.5 text-[13px] text-muted" data-testid="dashboard-still">
            <span>{t('Staat stil:')}</span>
            {still.map((a) => (
              <a key={a.id} href={`#/a/${a.id}`} className="inline-flex items-center gap-1.5 hover:text-fg hover:underline" translate="no">
                <BotAvatar bot={a} size={18} />
                {a.name}
              </a>
            ))}
          </div>
        )}
      </Card>
    </section>
  );
}
