import { useState } from 'react';
import { Inbox, LogOut, Search, Square, X } from 'lucide-react';
import { api, disconnectWs, setToken } from '../lib/api';
import { useApp } from '../lib/store';
import { BotFace } from '../components/BotFace';
import { Button, cx, toast } from '../components/ui';
import { ChatList, PinnedBots } from './ChatList';
import { DESTINATIONS, SIDEBAR_DESTINATIONS, type DestId } from './nav';
import { useInboxExtraCount } from '../modules';
import { NotificationBell } from '../modules/notifications/parts';
import { openPalette } from './CommandPalette';
import { saveLock } from './lockCore';
import { AwakeIndicator } from './power';
import { UsageMeter } from '../modules/usage/UsageMeter';
import { TeamSwitcher } from './TeamSwitcher';
import { NewMenu } from './NewMenu';
import { useTeamView } from '../modules/teams/scope';
import { t } from '../lib/i18n';
import { useAccent } from './theme';
import { accentById, DEFAULT_ACCENT } from './accent';

/** A fixed place of the sidebar: a 20 px icon, the name, an optional count; 36 px high (44 on a touch screen). */
export function NavItem({ href, active, icon, label, count, countTone = 'neutral', onNavigate, tab }: { href: string; active: boolean; icon: React.ReactNode; label: string; count?: number; countTone?: 'neutral' | 'warn'; onNavigate?(): void; /** One cell of the sidebar's footer row: the icon with its name under it. */ tab?: boolean }) {
  if (tab)
    return (
      <a
        href={href}
        onClick={onNavigate}
        aria-current={active ? 'page' : undefined}
        className={cx('relative flex h-12 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl px-0.5 transition-colors', active ? 'bg-surface-3 font-semibold text-fg' : 'font-medium text-muted hover:bg-surface-2 hover:text-fg')}
      >
        <span className="relative flex h-[18px] items-center justify-center [&_svg]:size-[18px] [&_svg]:stroke-[1.75]">
          {icon}
          {!!count && (
            <span className={cx('absolute -end-3 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10.5px] font-bold tabular-nums', countTone === 'warn' ? 'bg-warn-strong text-warn-fg' : 'bg-surface-3 text-fg')}>
              {count}
              <span className="sr-only"> {countTone === 'warn' ? 'open' : ''}</span>
            </span>
          )}
        </span>
        <span className="max-w-full truncate text-[10.5px] leading-none" data-i18n="label">
          {label}
        </span>
      </a>
    );
  return (
    <a
      href={href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cx('flex h-9 items-center gap-2.5 rounded-control px-2 text-sm transition-colors coarse:h-11', active ? 'bg-surface-3 font-semibold text-fg' : 'font-medium text-muted hover:bg-surface-2 hover:text-fg')}
    >
      {/* The icon sits in a slot as wide as a bot's face in the list above, so every row's text starts on one line. */}
      <span className="flex h-5 w-[26px] shrink-0 items-center justify-center [&_svg]:size-[18px] [&_svg]:stroke-[1.75]">{icon}</span>
      <span className="min-w-0 flex-1 truncate" data-i18n="label">
        {label}
      </span>
      {!!count && (
        <span className={cx('rounded-full px-1.5 py-px text-[11.5px] font-bold tabular-nums', countTone === 'warn' ? 'bg-warn-strong text-warn-fg' : 'text-muted')}>
          {count}
          <span className="sr-only"> {countTone === 'warn' ? 'open' : ''}</span>
        </span>
      )}
    </a>
  );
}

/** Stops every running task of this user (the global emergency stop). */
export async function stopAll() {
  try {
    const r = await api.post<{ stopped: number }>('/stop-all');
    toast(r.stopped ? `${r.stopped === 1 ? '1 taak' : `${r.stopped} taken`} gestopt` : 'Er liep niets; alles staat al stil', 'ok');
  } catch (e: any) {
    toast(e.message, 'danger');
  }
}

/**
 * "Alles stoppen". Hidden while nothing runs, unless `always` (Meer on the phone: always in reach): then it stays
 * visible and says calmly that nothing runs, and pressing it still stops everything that might have started.
 */
export function StopAllButton({ className, compact, always }: { className?: string; compact?: boolean; always?: boolean }) {
  const runs = useApp((s) => s.runs.length);
  if (!runs && !always) return null;
  if (!runs)
    return (
      <button
        onClick={stopAll}
        title="Stopt alle lopende taken van je bots"
        className={cx('flex h-8 w-full items-center justify-center gap-2 rounded-control border border-line bg-surface text-[13px] font-semibold text-muted hover:bg-surface-2 hover:text-fg coarse:h-11', className)}
      >
        <Square className="h-3 w-3 fill-current" aria-hidden /> Alles stoppen <span className="font-medium">· er loopt niets</span>
      </button>
    );
  if (compact)
    return (
      <button
        onClick={stopAll}
        className={cx('flex h-11 shrink-0 items-center gap-1.5 rounded-full bg-danger-soft px-3.5 text-[13px] font-bold text-danger', className)}
        aria-label={t('Alles stoppen ({0, plural, one {# taak} other {# taken}} bezig)', runs)}
        title="Stopt alle lopende taken van je bots"
      >
        <Square className="h-3 w-3 fill-current" aria-hidden /> {runs}
      </button>
    );
  return (
    <button
      onClick={stopAll}
      title="Stopt alle lopende taken van je bots"
      className={cx('flex h-8 w-full items-center justify-center gap-2 rounded-control bg-danger-soft text-[13px] font-bold text-danger hover:opacity-90 coarse:h-11', className)}
    >
      <Square className="h-3 w-3 fill-current" aria-hidden /> Alles stoppen ({runs})
    </button>
  );
}

export async function logout() {
  // The app lock belongs to whoever was signed in on this device.
  saveLock(null);
  await api.post('/auth/logout').catch(() => {});
  disconnectWs();
  setToken(null);
  location.hash = '#/';
  location.reload();
}

/**
 * TeamBot's own mark: the figure of the app icon. Tangerine as always with the standard look; with an accent colour
 * (Instellingen › Uiterlijk) the figure takes that colour.
 */
export function Mark({ size = 24, accent }: { size?: number; accent?: string }) {
  const current = useAccent();
  const id = accent ?? current;
  const color = id === DEFAULT_ACCENT ? 'tangerine' : accentById(id).logo;
  return <BotFace seed="TeamBot" traits={{ shape: 'squircle', color, eyes: 'bean', mouth: 'smile', extra: 'antenna', cheeks: true }} size={size} />;
}

/**
 * Desktop sidebar, top to bottom: (the team switcher, from two teams on), TeamBot with the bell and the "+" (Nieuwe bot,
 * Nieuw team: ./NewMenu), the search box, the pinned bots (always in view), the chat list (each bot with its status
 * dot), and at the bottom the fixed places "Wacht op jou" with its count, Taken, Marktplaats and Instellingen
 * (shell/nav.tsx: Routines live in Taken, Geheugen in Instellingen), and under them the usage meters: one ring per
 * subscription or provider, each its own button (modules/usage/UsageMeter). Everything else is under Instellingen.
 */
export function Sidebar({ route, onNavigate }: { route: string[]; onNavigate?(): void }) {
  const approvals = useApp((s) => s.approvals.length) + useInboxExtraCount();
  const online = useApp((s) => s.online);
  const mode = useApp((s) => s.mode);
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const { multi } = useTeamView();
  const item = (id: DestId) => {
    const d = DESTINATIONS[id];
    const Icon = d.icon;
    return <NavItem tab key={id} href={d.href} active={d.active(route)} icon={<Icon />} label={d.label} onNavigate={onNavigate} />;
  };

  const iconBtn = 'tb-tip flex size-9 shrink-0 items-center justify-center rounded-control text-muted transition-colors hover:bg-surface-2 hover:text-fg active:bg-surface-3 coarse:size-11';
  const closeSearch = () => (setQ(''), setSearching(false));

  return (
    <nav className="flex h-full w-full flex-col bg-surface" aria-label="Hoofdmenu">
      {/* One header row: the app (or, from two teams on, the team you look at), search, the bell and "+". The search
          field takes the row's place while you search. */}
      <div className="flex h-14 shrink-0 items-center gap-0.5 px-2">
        {searching ? (
          <form
            className="relative min-w-0 flex-1"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              // Enter: search everything (chats, pages, settings, channels, skills, apps, files …) in the palette.
              openPalette(q.trim());
              closeSearch();
              onNavigate?.();
            }}
          >
            <Search className="pointer-events-none absolute start-3 top-1/2 size-icon -translate-y-1/2 text-muted" aria-hidden />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && (e.preventDefault(), closeSearch())}
              onBlur={() => !q.trim() && setSearching(false)}
              placeholder="Zoek een bot (Enter: overal)"
              aria-label="Bots zoeken (Enter zoekt overal)"
              className="h-9 w-full rounded-control border border-line-strong bg-surface-2 ps-9 pe-9 text-sm outline-none placeholder:text-muted coarse:h-11"
            />
            <button type="button" aria-label="Zoeken sluiten" onMouseDown={(e) => e.preventDefault()} onClick={closeSearch} className="absolute end-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-3 hover:text-fg">
              <X className="size-icon" aria-hidden />
            </button>
          </form>
        ) : (
          <>
            <a href="#/" onClick={onNavigate} aria-label={multi ? 'TeamBot' : undefined} className={cx('flex h-9 min-w-0 items-center gap-2 rounded-control ps-2 font-bold', !multi && 'flex-1')}>
              <span className="relative shrink-0">
                <Mark size={24} />
                {/* Only when the connection is gone: a calm app shows no dot at all. */}
                {!online && <span className="absolute -bottom-0.5 -end-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-warn" aria-hidden />}
              </span>
              {!multi && <span className="truncate text-[15px] tracking-tight">TeamBot</span>}
              <span className="sr-only">{online ? 'verbonden' : 'verbinding herstellen'}</span>
            </a>
            {/* The team switcher: only from two teams on (one team = nothing about teams in view). */}
            <TeamSwitcher className="min-w-0 flex-1" onNavigate={onNavigate} />
            <button type="button" aria-label="Zoeken" data-tip={t('Zoek een bot · Ctrl+K zoekt overal')} onClick={() => setSearching(true)} className={iconBtn}>
              <Search className="size-icon-lg stroke-[1.75]" aria-hidden />
            </button>
            <NotificationBell />
            {/* "+": Nieuwe bot, Nieuw team, Team uit een sjabloon. */}
            <NewMenu onNavigate={onNavigate} />
          </>
        )}
      </div>

      {/* The list: pinned bots first (always in view), then every bot and group, all in the same one-line rows. */}
      <PinnedBots route={route} onNavigate={onNavigate} q={q} className="px-2 pb-1" />

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <ChatList route={route} onNavigate={onNavigate} q={q} pinned="apart" />
      </div>

      {/* One footer: the fixed places and the usage rings on the same grid, under one line. */}
      {/* relative: the usage popover (UsageMeter) opens above this whole footer. */}
      <div className="relative border-t border-line px-2 py-1.5">
        <StopAllButton className="mb-2" />
        <AwakeIndicator className="mb-1" />
        {/* The fixed places as one row of named icons, so the list above keeps the height (the owner has 23 bots). */}
        <div className="flex items-stretch gap-0.5">
          <NavItem tab href="#/inbox" active={DESTINATIONS.inbox.active(route)} icon={<Inbox />} label="Wacht op jou" count={approvals} countTone="warn" onNavigate={onNavigate} />
          {SIDEBAR_DESTINATIONS.map(item)}
          {mode === 'server' && (
            <Button variant="ghost" size="icon" aria-label="Uitloggen" className="tb-tip tb-tip-up tb-tip-end h-9" onClick={logout}>
              <LogOut className="size-icon" />
            </Button>
          )}
        </div>
        {/* Usage: one ring per subscription or provider (week outside, 5 hours inside); each ring shows its own details. */}
        <UsageMeter className="mt-0.5 px-1" />
      </div>
    </nav>
  );
}
