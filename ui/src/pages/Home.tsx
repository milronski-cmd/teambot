import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ChevronRight, Lock, Plus, Search } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { navigate } from '../lib/router';
import { useIsDesktop } from '../lib/media';
import { moodText, moodTone, useAgentMood } from '../lib/mood';
import type { Agent, ProviderView } from '../lib/types';
import { BotFace, LiveBotAvatar } from '../components/BotFace';
import { Page, cx } from '../components/ui';
import { MoreInfo } from '../components/MoreInfo';
import { useProviderKinds } from './Providers';
import { ChatList } from '../shell/ChatList';
import { Mark, StopAllButton } from '../shell/Sidebar';
import { OpenBotBanner, useOpenBotOffer } from '../modules/openbot-import/Banner';
import { NotificationBell } from '../modules/notifications/parts';
import { LanguageCorner } from '../components/LanguagePicker';
import { LOCAL_KINDS, engineRank } from './newbot/choices';
import { welcomeSlots } from './welcomeSlots';
import { FreeCard, KeyCard, SubscriptionCard, freeOptions, useSubscriptions } from './welcome/StartOptions';
import { mainAction } from './welcome/mainAction';
import { useMainBot } from '../modules/teams/api';
import { TeamSwitcher } from '../shell/TeamSwitcher';
import { NewMenu } from '../shell/NewMenu';

/** A small cluster of characters for the welcome screen. */
function Faces() {
  return (
    <div className="flex items-end justify-center gap-1" aria-hidden>
      <BotFace seed="welkom-1" traits={{ shape: 'egg', color: 'teal', eyes: 'look', mouth: 'smile', extra: 'none', cheeks: true }} size={64} className="-me-2 translate-y-1" />
      <BotFace seed="welkom-2" traits={{ shape: 'squircle', color: 'cobalt', eyes: 'bean', mouth: 'smile', extra: 'antenna', cheeks: true }} size={92} />
      <BotFace seed="welkom-3" traits={{ shape: 'ghost', color: 'pink', eyes: 'happy', mouth: 'cat', extra: 'none', cheeks: true }} size={64} className="-ms-2 translate-y-1" />
    </div>
  );
}

/**
 * First run (TeamBot 0.4.2): one calm screen, nothing installed yet (no bots, teams, skills or routines). Three plain
 * ways to get going, each in one or two clicks (welcome/StartOptions.tsx): "Ik heb Claude of ChatGPT", "Ik heb een
 * API-sleutel" and "Gratis beginnen". The choice makes a ready first bot with that engine (welcome/FirstBot.tsx, 0.4.5).
 * Exactly one main button, whatever is on this PC (welcome/mainAction.ts): an OpenBot installation to take over, else
 * the AI that suits best; every other way in is a quiet choice with its own button (Gebruiken, Inloggen, Installeren,
 * Koppelen). No ports, no Tailscale, no jargon here.
 */
function Welcome() {
  const providers = useApp((s) => s.providers);
  const settings = useApp((s) => s.settings);
  const { kinds, reload: reloadKinds } = useProviderKinds(true);
  const subs = useSubscriptions();
  const openbot = useOpenBotOffer();

  const enabled = useMemo(() => providers.filter((p) => p.enabled), [providers]);
  const kindOf = useMemo(() => new Map((kinds || []).map((k) => [k.id, k])), [kinds]);
  const free = useMemo(() => freeOptions(kinds, enabled), [kinds, enabled]);
  // Already connected with a key (or another program): under "Ik heb een API-sleutel" with "Gebruiken".
  const keyed = useMemo(() => enabled.filter((p) => !free.some((f) => f.providerId === p.id) && p.kind !== 'claude-code' && p.kind !== 'codex-cli'), [enabled, free]);
  // The ONE main button (welcome/mainAction.ts): the OpenBot offer, else the best AI (own subscription, OpenCode, a
  // local model, a free tier, a key), else logging in, else "Gratis starten". A failed look counts as nothing found.
  const primaryId = useMemo(
    () => mainAction({ openbot: openbot.shown, subs: subs.view?.items ?? (subs.err ? [] : null), free, keyed, kinds: kindOf }),
    [openbot.shown, subs.view, subs.err, free, keyed, kindOf],
  );
  // OpenCode's free models stop at a daily limit; a local model does not. Without one here, Ollama is a choice with
  // "Installeren" (StartOptions.tsx).
  const noLocal = !!kinds && !kinds.some((k) => LOCAL_KINDS.has(k.id) && k.status?.installed) && !providers.some((p) => LOCAL_KINDS.has(p.kind));
  const ollamaHere = !!kinds?.some((k) => k.id === 'ollama' && k.status?.installed);
  const LocalModels = welcomeSlots.localModels;
  const TeamTemplate = welcomeSlots.teamTemplate;
  const best = useMemo(() => {
    const list = [...enabled].map((p) => {
      const k = kindOf.get(p.kind);
      return { kind: p.kind, providerId: p.id, rank: engineRank({ kind: p.kind, type: p.type, billing: p.billing ?? k?.billing, group: k?.group }) };
    });
    return list.sort((a, b) => a.rank - b.rank)[0];
  }, [enabled, kindOf]);
  const found = useMemo(() => (kinds || []).filter((k) => k.status?.installed && !k.needsKey && !k.retired && (k.type !== 'cli' || k.status?.loggedIn !== false)), [kinds]);

  /** Connect everything found on this PC (no keys needed); the engine a first bot would use, or null. */
  const prepare = async (): Promise<ProviderView | null> => {
    if (found.some((k) => !providers.some((p) => p.kind === k.id))) await api.post('/providers/autodetect');
    await useApp.getState().refreshProviders();
    // The server picked the default engine among what it connected (it knows which CLI is logged in): the new-bot page
    // suggests that one first.
    const st = await api.get<Record<string, any>>('/settings').catch(() => null);
    if (st) useApp.setState({ settings: st });
    const list = useApp.getState().providers.filter((p) => p.enabled);
    const provider = (best?.providerId && list.find((p) => p.id === best.providerId)) || list.find((p) => p.kind === best?.kind) || list.find((p) => p.id === settings.defaultProvider) || list[0] || null;
    // A bot on OpenCode (free, with a daily limit) gets a local model as reserve when one runs here.
    if (provider?.kind === 'opencode') await api.post('/providers/free-reserve').catch(() => null);
    return provider;
  };

  return (
    <Page>
      <div className="mx-auto flex min-h-full max-w-[460px] flex-col justify-center px-5 py-10">
        <div className="-mt-4 mb-4 flex justify-end">
          <LanguageCorner />
        </div>
        <Faces />
        <h1 className="mt-6 text-center text-[28px] font-extrabold leading-tight tracking-tight">Welkom bij TeamBot</h1>
        <p className="mx-auto mt-2 max-w-sm text-center text-[15px] leading-relaxed text-muted">Je eigen team van AI-bots, op deze computer. Kies hoe je begint.</p>

        <div className="-mb-3 mt-7 empty:hidden">
          <OpenBotBanner offer={openbot} primary={primaryId === 'openbot'} />
        </div>

        <div className="mt-7 space-y-3">
          <SubscriptionCard view={subs.view} err={subs.err} primaryId={primaryId} onChanged={subs.load} />
          <KeyCard kinds={kinds} connected={keyed} primaryId={primaryId} />
          <FreeCard options={free} primaryId={primaryId} freeStartPrimary={primaryId === 'free-start'} localMissing={noLocal} onLocalFound={reloadKinds}>
            {/* Slot (package Q): which local models fit this pc, only when Ollama is here (see welcomeSlots.ts). */}
            {LocalModels && ollamaHere && (
              <div className="mt-3">
                <LocalModels />
              </div>
            )}
          </FreeCard>
        </div>

        {/* Slot (package R): start from a team template, clearly secondary to the three choices; see welcomeSlots.ts. */}
        {TeamTemplate && (
          <div className="mt-4 text-center">
            <TeamTemplate prepare={prepare} />
          </div>
        )}

        <div className="mt-4 flex flex-wrap justify-center gap-x-5 gap-y-2 text-[13px] font-semibold">
          <a className="text-muted hover:text-fg" href="#/settings/providers">
            Andere AI koppelen
          </a>
        </div>
        <p className="mx-auto mt-8 max-w-sm text-center text-xs leading-relaxed text-muted">
          <Lock className="me-1 inline h-3.5 w-3.5 align-[-2px]" aria-hidden />
          Je gesprekken blijven op deze computer.{' '}
          <a className="underline hover:text-fg" href="#/settings/data">
            Privacy en gegevens
          </a>{' '}
          {/* As the first bot starts (Volledige toegang): it does the work itself, and asks for money and messages to others. */}
          <MoreInfo>Bots doen het werk zelf en vragen het je bij geld en belangrijke berichten naar anderen.</MoreInfo>
        </p>
      </div>
    </Page>
  );
}

/** Calm summary of what waits for you (phone list and the desktop fallback). */
function WaitingBanner() {
  const n = useApp((s) => s.approvals.length);
  if (!n) return null;
  return (
    <a href="#/inbox" className="flex items-center gap-3 rounded-card border border-warn/35 bg-warn-soft px-4 py-3 text-sm font-semibold text-warn transition-colors hover:border-warn/60">
      <span className="h-2 w-2 shrink-0 rounded-full bg-warn" aria-hidden />
      <span className="flex-1">{n === 1 ? 'Er wacht één vraag op jou' : `Er wachten ${n} vragen op jou`}</span>
      <ChevronRight className="h-4 w-4" />
    </a>
  );
}

/** Phone start screen: the list of bots, like a messenger. */
function PhoneChats() {
  const [q, setQ] = useState('');
  return (
    <Page>
      <div className="safe-top">
        <div className="flex items-center gap-2 px-4 pb-2 pt-3">
          <Mark size={28} />
          <h1 className="flex-1 text-[22px] font-extrabold tracking-tight">TeamBot</h1>
          <StopAllButton compact />
          <NotificationBell size="lg" />
          <NewMenu size="phone" />
        </div>
        {/* From two teams on: which team the list shows (the same choice as in the desktop sidebar). */}
        <TeamSwitcher size="phone" className="mx-4 mb-2" />
        <form
          className="relative mx-4 mb-2"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            navigate(`/search${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`);
          }}
        >
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Zoeken"
            enterKeyHint="search"
            aria-label="Bots zoeken (Enter zoekt overal)"
            className="h-11 w-full rounded-control bg-surface-2 ps-9 pe-3 text-[15px] outline-none placeholder:text-muted"
          />
        </form>
        <div className="px-4 pb-2 empty:hidden">
          <WaitingBanner />
        </div>
        <div className="px-2 pb-4">
          {/* The main bot is the first row of the list (A3), not a separate entry above it. */}
          <ChatList route={[]} q={q} size="phone" />
          {q.trim() && (
            <a href={`#/search?q=${encodeURIComponent(q.trim())}`} className="mx-2 mt-1 flex items-center gap-3 rounded-control px-2 py-3 text-[14.5px] font-semibold transition-colors hover:bg-surface-2">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-2">
                <Search className="h-5 w-5" aria-hidden />
              </span>
              <span className="min-w-0 flex-1 truncate">Zoek “{q.trim()}” overal</span>
              <ChevronRight className="h-4 w-4 text-muted" aria-hidden />
            </a>
          )}
        </div>
      </div>
    </Page>
  );
}

/** Role, or the bot's state in words while it works, waits or failed (the face alone never carries the status). */
function BotStatusLine({ agent }: { agent: Agent }) {
  const mood = useAgentMood(agent);
  // Idle, the line is the bot's role: the user's words, never translated.
  return (
    <span className={cx('w-full truncate text-xs', mood === 'idle' ? 'text-muted' : moodTone(mood))} translate={mood === 'idle' && agent.role ? 'no' : undefined}>
      {moodText(mood, agent.role || 'Bot')}
    </span>
  );
}

/**
 * Desktop start: the main bot's conversation when there is a main bot (the front door), otherwise the most recent
 * conversation; only without any conversation show a calm "who do you want to talk to".
 */
function DesktopHome() {
  const threads = useApp((s) => s.threads);
  const agents = useApp(useShallow((s) => s.agents.filter((a) => !a.archived)));
  const main = useMainBot();
  const front = main && !main.archived ? main.id : null;
  // Your own conversations (a chat or a group), never a routine run or a bot-to-bot thread that happened to be last.
  const latest = useMemo(() => threads.filter((t) => !t.archived && t.last && (t.kind === 'chat' || t.kind === 'room')).sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0], [threads]);
  useEffect(() => {
    if (main === undefined || (!latest && !front)) return;
    // Only from the start page itself: while the main bot loaded, the owner may already have gone elsewhere (Wacht op
    // jou, a link in a notification); this effect can still run once after that hash change.
    navigate(front ? `/a/${front}` : `/t/${latest!.id}`, { from: '#/', replace: true });
  }, [latest?.id, front, main === undefined]);
  if (latest || front || main === undefined) return null;
  return (
    <Page>
      <div className="mx-auto max-w-3xl space-y-8 px-6 py-12">
        <div>
          <h1 className="text-[22px] font-bold leading-tight tracking-tight sm:text-2xl">Met wie wil je praten?</h1>
          
        </div>
        <WaitingBanner />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {agents.map((a) => (
            <a key={a.id} href={`#/a/${a.id}`} className="flex flex-col items-center gap-2 rounded-card border border-line bg-surface p-5 text-center transition-colors hover:bg-surface-2">
              <LiveBotAvatar bot={a} size={64} />
              <span className="w-full truncate text-sm font-semibold">{a.name}</span>
              <BotStatusLine agent={a} />
            </a>
          ))}
          <a href="#/agents/new" className={cx('flex flex-col items-center justify-center gap-2 rounded-card border border-dashed border-line-strong p-5 text-sm font-semibold text-muted transition-colors hover:bg-surface-2 hover:text-fg')}>
            <Plus className="h-6 w-6" /> Nieuwe bot
          </a>
        </div>
      </div>
    </Page>
  );
}

export function Home() {
  // A member with no bots of his own but bots shared with the team starts in the list, not in the welcome.
  const hasBots = useApp((s) => s.agents.some((a) => !a.archived) || s.shared.length > 0);
  const desktop = useIsDesktop();
  if (!hasBots) return <Welcome />;
  return desktop ? <DesktopHome /> : <PhoneChats />;
}

