import { useEffect, useState } from 'react';
import { History } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import type { Approval } from '../lib/types';
import { BotAvatar, BotFace } from '../components/BotFace';
import { Badge, Button, Card, EmptyState, Page, PageHeader, timeAgo } from '../components/ui';
import { SkeletonRows } from '../components/overview';
import { Segmented } from '../components/SettingControls';
import { MoreInfo } from '../components/MoreInfo';
import { navigate } from '../lib/router';
import { ApprovalCard } from '../shell/ApprovalCard';
import { approvalToolName } from '../shell/approvalLabels';
import { stripRefs } from '../lib/preview';
import { uiModules, useInboxExtraCount } from '../modules';

/** A form answer is stored as JSON; show its values ("Sanne, herfst"), never the raw JSON. */
function answerText(answer: string): string {
  try {
    const v = JSON.parse(answer);
    if (v && typeof v === 'object' && !Array.isArray(v)) return Object.values(v).filter((x) => x !== '' && x !== null && x !== false).map((x) => (x === true ? 'ja' : String(x))).join(', ');
  } catch {
    /* plain text answer */
  }
  return answer;
}

/** "Wacht op jou": every pending question/approval across bots, plus a history of decisions. */
export function InboxPage() {
  const pending = useApp((s) => s.approvals);
  const agents = useApp((s) => s.agents);
  const extra = useInboxExtraCount();
  const [tab, setTab] = useState<'open' | 'history'>('open');
  const [history, setHistory] = useState<Approval[] | null>(null);
  useEffect(() => {
    if (tab === 'history') api.get<Approval[]>('/approvals?status=all').then((l) => setHistory(l.filter((a) => a.status !== 'pending'))).catch(() => setHistory([]));
  }, [tab]);
  const statusTone = { approved: 'ok', denied: 'danger', expired: 'neutral', pending: 'warn' } as const;
  const statusText = { approved: 'Toegestaan', denied: 'Geweigerd', expired: 'Verlopen', pending: 'Open' };
  return (
    <Page>
      <PageHeader
        title="Wacht op jou"
        subtitle={
          <>
            Vragen en goedkeuringen van je bots. <MoreInfo>Een melding keurt nooit vanzelf iets goed: je beslist hier of in het gesprek.</MoreInfo>
          </>
        }
        width="3xl"
      />
      <div className="mx-auto max-w-3xl px-4 pb-8 pt-3 sm:px-6">
        <Segmented<'open' | 'history'>
          label="Wat je ziet"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'open', label: `Open (${pending.length + extra})` },
            { value: 'history', label: 'Geschiedenis' },
          ]}
        />
        <div key={tab} className="tb-in space-y-3 pt-4">
          {tab === 'open' &&
            (pending.length === 0 && extra === 0 ? (
              <EmptyState
                art={<BotFace seed="inbox-rust" traits={{ shape: 'squircle', color: 'mint', eyes: 'happy', mouth: 'smile', extra: 'none', cheeks: true }} mood="done" size={72} />}
                title="Niets dat op je wacht"
                action={<Button onClick={() => navigate('/')}>Naar je chats</Button>}
              >
                Vraagt een bot iets, dan zie je het hier.
              </EmptyState>
            ) : (
              pending.map((a) => <ApprovalCard key={a.id} a={a} showThreadLink />)
            ))}
          {tab === 'open' &&
            uiModules.map((m) => {
              const Section = m.inbox?.component;
              return Section ? <Section key={m.id} /> : null;
            })}
          {tab === 'history' &&
            (history === null ? (
              <SkeletonRows n={4} />
            ) : history.length === 0 ? (
              <Card>
                <EmptyState icon={<History />} title="Nog geen geschiedenis" action={<Button onClick={() => setTab('open')}>Naar open vragen</Button>}>
                  Beslissingen die je neemt, verschijnen hier.
                </EmptyState>
              </Card>
            ) : (
              <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
                {history.map((a) => {
                  const agent = agents.find((x) => x.id === a.agent_id);
                  return (
                    <li key={a.id} className="flex items-start gap-3 px-4 py-3 text-sm">
                      <BotAvatar bot={agent || { id: a.agent_id, name: 'bot' }} size={30} />
                      <div className="min-w-0 flex-1">
                        <div className="line-clamp-2 font-semibold [overflow-wrap:anywhere]">{stripRefs(a.summary)}</div>
                        <div className="mt-0.5 text-xs text-muted [overflow-wrap:anywhere]">
                          {agent?.name || 'Bot'} · {approvalToolName(a)} · {timeAgo(a.created_at)}
                          {a.answer ? ` · antwoord: ${answerText(a.answer).slice(0, 80)}` : ''}
                        </div>
                      </div>
                      <Badge tone={statusTone[a.status]}>{statusText[a.status]}</Badge>
                    </li>
                  );
                })}
              </ul>
            ))}
        </div>
      </div>
    </Page>
  );
}
