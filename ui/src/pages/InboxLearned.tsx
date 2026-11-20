import { useEffect, useState } from 'react';
import { GraduationCap } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { BotAvatar } from '../components/BotFace';
import { Button, Card, EmptyState, Textarea, timeAgo } from '../components/ui';
import { SkeletonRows } from '../components/overview';
import { stripRefs } from '../lib/preview';
import { answerTo, askedWeek, learnedCount, learnedOf, openCount } from '../shell/approvalGroupText';

interface Answer {
  id: string;
  question: string;
  answer: string;
  at: string;
}
interface BotAnswers {
  agentId: string;
  name: string;
  open: number;
  askedWeek: number;
  answers: Answer[];
}

/**
 * "Geleerd": per bot what it asked its owner and what he answered. The bots work with these answers and do not ask
 * the same thing again; here he corrects an answer or lets it lapse (then the bots ask again).
 */
export function Learned({ onOpen }: { onOpen(): void }) {
  const agents = useApp((s) => s.agents);
  const [bots, setBots] = useState<BotAnswers[] | null>(null);
  const [edit, setEdit] = useState<{ id: string; text: string } | null>(null);
  const [error, setError] = useState('');
  const load = () =>
    api
      .get<{ bots: BotAnswers[] }>('/approvals/answers')
      .then((r) => setBots(r.bots))
      .catch(() => setBots([]));
  useEffect(() => {
    load();
  }, []);
  const change = async (id: string, body: { answer: string } | { forget: true }) => {
    setError('');
    try {
      await api.put(`/approvals/${id}/answer`, body);
      setEdit(null);
      await load();
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  };
  if (bots === null) return <SkeletonRows n={4} />;
  const shown = bots.filter((b) => b.answers.length || b.open);
  if (!shown.length)
    return (
      <Card>
        <EmptyState icon={<GraduationCap />} title="Nog niets geleerd" action={<Button onClick={onOpen}>Naar open vragen</Button>}>
          Beantwoord je een vraag van een bot, dan onthoudt je team het antwoord en vraagt het niet opnieuw.
        </EmptyState>
      </Card>
    );
  return (
    <>
      <p className="text-sm text-muted">Je bots werken met deze antwoorden en vragen hetzelfde niet opnieuw. Klopt een antwoord niet meer, verbeter het dan hier of laat het vergeten.</p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {shown.map((b) => {
        const agent = agents.find((x) => x.id === b.agentId);
        return (
          <Card key={b.agentId} className="p-3 sm:p-4" role="group" aria-label={learnedOf(b.name)}>
            <div className="flex items-center gap-3">
              <BotAvatar bot={agent || { id: b.agentId, name: b.name }} size={34} />
              <div className="min-w-0 flex-1">
                <h2 className="text-[15px] font-bold">{b.name}</h2>
                <div className="text-xs text-muted">{[learnedCount(b.answers.length), b.open ? openCount(b.open) : '', b.askedWeek ? askedWeek(b.askedWeek) : ''].filter(Boolean).join(' · ')}</div>
              </div>
              {b.open > 0 && (
                <Button size="sm" variant="secondary" onClick={onOpen}>
                  Beantwoorden
                </Button>
              )}
            </div>
            {b.answers.length > 0 && (
              <ul className="mt-3 divide-y divide-line">
                {b.answers.map((a) => (
                  <li key={a.id} className="py-2.5 text-sm">
                    <div className="font-semibold [overflow-wrap:anywhere]">{stripRefs(a.question)}</div>
                    {edit?.id === a.id ? (
                      <div className="mt-2 space-y-2">
                        <Textarea aria-label={answerTo(stripRefs(a.question).slice(0, 80))} rows={3} value={edit.text} onChange={(e) => setEdit({ id: a.id, text: e.target.value })} />
                        <div className="flex gap-2">
                          <Button size="sm" onClick={() => change(a.id, { answer: edit.text })} disabled={!edit.text.trim()}>
                            Opslaan
                          </Button>
                          <Button size="sm" variant="secondary" onClick={() => setEdit(null)}>
                            Annuleren
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{a.answer}</div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                          <span>{timeAgo(a.at)}</span>
                          <Button size="sm" variant="ghost" onClick={() => setEdit({ id: a.id, text: a.answer })}>
                            Verbeteren
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => change(a.id, { forget: true })}>
                            Vergeten
                          </Button>
                        </div>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        );
      })}
    </>
  );
}
