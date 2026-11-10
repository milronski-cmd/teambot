import { useEffect, useMemo, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Button, EmptyState } from '../../components/ui';
import { Skeleton } from '../../components/overview';
import { BotAvatar } from '../../components/BotFace';
import { on } from '../../lib/api';
import { navigate } from '../../lib/router';
import type { Agent } from '../../lib/types';
import type { CuratedCard, CuratedList, RegistryCard, RegistryList, StagingView } from './api';
import { ErrorCard, LoadingCards, useList } from './marketParts';
import { AddDialog, AppCard, SkillCard, useOwnBots } from './ClearMarket';
import { CuratedDetailModal, ReviewModal, UpdateDiffModal } from './Catalog';
import { RegistryDetailModal } from './RegistryApps';
import { fitScore, groupIdOf, tileIdOf } from './marketGroups';

/**
 * "Aanbevolen voor je bots" (0.4.5): a short list per bot, matched to its name, role and description (a SEO bot gets
 * the SEO skills and apps first). Nothing is guessed beyond the words: a bot without a match gets no list, and without
 * bots there is one short starter list (one skill per subject).
 */

const SKILLS_PER_BOT = 3;
const APPS_PER_BOT = 2;
const MAX_BOTS = 8;

const botText = (a: Agent) => `${a.name} ${a.role || ''} ${a.description || ''}`;
const skillText = (c: CuratedCard) => `${c.name.replace(/[-_]/g, ' ')} ${c.note} ${c.category} ${c.pack}`;
const appText = (i: RegistryCard) => `${i.title} ${i.name.split('/').pop() || ''} ${i.description} ${i.category}`;

function top<T>(items: T[], score: (i: T) => number, n: number): T[] {
  return items
    .map((i, k) => ({ i, s: score(i), k }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.k - b.k)
    .slice(0, n)
    .map((x) => x.i);
}

export function RecommendedTab() {
  const bots = useOwnBots();
  const skills = useList<CuratedList>('/skills/curated');
  const apps = useList<RegistryList>('/mcp/registry/servers');
  const [adding, setAdding] = useState<{ c: CuratedCard; bot?: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [app, setApp] = useState<string | null>(null);
  const [review, setReview] = useState<StagingView | null>(null);
  const [diff, setDiff] = useState<{ skillId: string; commit: string } | null>(null);
  const reload = skills.reload;
  useEffect(() => on('skills.updated', reload), [reload]);
  const lists = useMemo(() => {
    const items = skills.data?.items || [];
    const regs = (apps.data?.items || []).filter((i) => i.installable && i.status !== 'deprecated');
    return bots
      .slice(0, MAX_BOTS)
      .map((b) => {
        const text = botText(b);
        const mine = new Set(b.skills || []);
        return {
          bot: b,
          skills: top(items.filter((c) => !(c.installed && mine.has(c.installed.skillId))), (c) => fitScore(text, skillText(c), tileIdOf(c.category, c.pack)), SKILLS_PER_BOT),
          apps: top(regs.filter((i) => !i.installed.length), (i) => fitScore(text, appText(i), groupIdOf(i.category)), APPS_PER_BOT),
        };
      })
      .filter((x) => x.skills.length || x.apps.length);
  }, [bots, skills.data, apps.data]);
  // Something fits a bot but it already has it all: say that, not "nothing fits".
  const allAdded = useMemo(() => {
    const items = skills.data?.items || [];
    return !lists.length && bots.some((b) => items.some((c) => c.installed && (b.skills || []).includes(c.installed.skillId) && fitScore(botText(b), skillText(c), tileIdOf(c.category, c.pack)) > 0));
  }, [lists, bots, skills.data]);
  // One skill per subject to start with (no bots yet, or none of them matched).
  const starter = useMemo(() => {
    const seen = new Set<string>();
    return (skills.data?.items || []).filter((c) => {
      const g = tileIdOf(c.category, c.pack);
      if (seen.has(g) || c.installed) return false;
      seen.add(g);
      return true;
    }).slice(0, 6);
  }, [skills.data]);
  const card = (c: CuratedCard, bot?: Agent) => (
    <li key={`${bot?.id || ''}${c.id}`} className="min-w-0">
      <SkillCard c={c} forBot={bot} onAdd={() => setAdding({ c, bot: bot?.id })} onDetails={() => setOpen(c.id)} onDiff={() => c.installed?.update && setDiff({ skillId: c.installed.skillId, commit: c.installed.update.to })} />
    </li>
  );
  if (skills.error) return <ErrorCard error={skills.error} retry={skills.reload} />;
  if (!skills.data)
    return (
      <div className="space-y-3">
        <Skeleton className="h-7 w-40" />
        <LoadingCards n={3} />
      </div>
    );
  return (
    <div className="space-y-6">
      {!bots.length && !starter.length ? (
        <EmptyState icon={<Sparkles />} title="Nog geen bots" action={<Button onClick={() => navigate('/m/skills/skills')}>Alle skills bekijken</Button>}>
          Maak eerst een bot. Daarna zie je hier wat bij zijn werk past.
        </EmptyState>
      ) : !bots.length ? null : !lists.length && allAdded ? (
        <p className="text-sm text-muted">Je bots hebben al wat bij hun werk past.</p>
      ) : !lists.length ? (
        <p className="text-sm text-muted">Bij je bots past nog niets. Geef een bot een rol, bijvoorbeeld “SEO” of “klantenservice”.</p>
      ) : (
        lists.map((l) => (
          <section key={l.bot.id} aria-labelledby={`rec-${l.bot.id}`} className="space-y-3" data-rec-bot={l.bot.id}>
            <h2 id={`rec-${l.bot.id}`} className="flex min-w-0 items-center gap-2 text-[15px] font-bold tracking-tight">
              <BotAvatar bot={l.bot} size={28} />
              <span className="min-w-0 break-words">
                Voor <span translate="no">{l.bot.name}</span>
              </span>
            </h2>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {l.skills.map((c) => card(c, l.bot))}
              {l.apps.map((i) => (
                <li key={`${l.bot.id}${i.name}`} className="min-w-0">
                  <AppCard i={i} onAdd={() => setApp(i.name)} />
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      {(!lists.length || !bots.length) && starter.length > 0 && (
        <section aria-labelledby="rec-start" className="space-y-3">
          <h2 id="rec-start" className="text-[15px] font-bold tracking-tight">
            Goed om mee te beginnen
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{starter.map((c) => card(c))}</ul>
        </section>
      )}
      {adding && <AddDialog c={adding.c} teamId="" presetBot={adding.bot} onClose={() => setAdding(null)} onReview={(s) => (setAdding(null), setReview(s))} onDone={() => (setAdding(null), reload())} />}
      {open && <CuratedDetailModal id={open} onClose={() => (setOpen(null), reload())} onAdd={(c) => (setOpen(null), setAdding({ c }))} onReview={(s) => (setOpen(null), setReview(s))} onDiff={(skillId, commit) => (setOpen(null), setDiff({ skillId, commit }))} />}
      {app && <RegistryDetailModal name={app} onClose={() => (setApp(null), apps.reload())} />}
      {review && <ReviewModal staging={review} onClose={() => (setReview(null), reload())} />}
      {diff && <UpdateDiffModal skillId={diff.skillId} commit={diff.commit} onClose={() => (setDiff(null), reload())} />}
    </div>
  );
}
