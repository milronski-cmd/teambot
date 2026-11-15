import { useState, useSyncExternalStore } from 'react';
import { Inbox, LogOut, PanelLeftClose, PanelLeftOpen, Search, Square, X } from 'lucide-react';
import { api, disconnectWs, setToken } from '../lib/api';
import { useApp } from '../lib/store';
import { BotFace } from '../components/BotFace';
import { cx, toast } from '../components/ui';
import { ChatList, PinnedRows } from './ChatList';
import { DESTINATIONS } from './nav';
import { useInboxExtraCount } from '../modules';
import { NotificationBell } from '../modules/notifications/parts';
import { openPalette } from './CommandPalette';
import { saveLock } from './lockCore';
import { AwakeIndicator } from './power';
import { UsageMeter } from '../modules/usage/UsageMeter';
import { TeamSwitcher } from './TeamSwitcher';
import { NewMenu } from './NewMenu';
import { t } from '../lib/i18n';
import { useAccent } from './theme';
import { accentById, DEFAULT_ACCENT } from './accent';

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
      className={cx('flex h-8 w-full items-center gap-2 rounded-control px-2.5 text-[12.5px] font-semibold text-danger transition-colors hover:bg-danger-soft coarse:h-11', className)}
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

// ---- the folded sidebar (only faces), kept on this device ----
const FOLD_KEY = 'tb_side_folded';
const foldListeners = new Set<() => void>();
function readFolded(): boolean {
  try {
    return localStorage.getItem(FOLD_KEY) === '1';
  } catch {
    return false;
  }
}
/** Fold or unfold the sidebar (desktop): folded it shows the faces of the bots and the fixed places as icons. */
export function toggleSidebarFolded() {
  try {
    localStorage.setItem(FOLD_KEY, readFolded() ? '0' : '1');
  } catch {
    /* not kept: nothing changes */
  }
  foldListeners.forEach((f) => f());
}
export function useSidebarFolded(): boolean {
  return useSyncExternalStore(
    (f) => (foldListeners.add(f), () => foldListeners.delete(f)),
    readFolded,
    () => false,
  );
}

const iconBtn = 'tb-tip flex size-9 shrink-0 items-center justify-center rounded-control text-muted transition-colors hover:bg-surface-2 hover:text-fg active:bg-surface-3 coarse:size-11';

/** One place on the rail: the icon in a pill (TeamBot orange when you are there), its name under it, a count. */
function RailItem({ href, label, icon: Icon, active, count, onNavigate }: { href: string; label: string; icon: React.ComponentType<{ className?: string }>; active: boolean; count?: number; onNavigate?(): void }) {
  return (
    <a href={href} onClick={onNavigate} aria-current={active ? 'page' : undefined} className="group flex w-full flex-col items-center gap-1 rounded-xl py-1">
      <span className={cx('relative flex h-8 w-12 items-center justify-center rounded-full transition-colors', active ? 'bg-brand-soft text-brand' : 'text-muted group-hover:bg-surface-2 group-hover:text-fg')}>
        <Icon className={cx('size-[19px]', active ? 'stroke-[2.2]' : 'stroke-[1.75]')} aria-hidden />
        {!!count && (
          <span className="absolute -end-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-warn-strong px-1 text-[10.5px] font-bold tabular-nums text-warn-fg">
            {count}
            <span className="sr-only"> open</span>
          </span>
        )}
      </span>
      <span data-i18n="label" className={cx('w-full truncate px-0.5 text-center text-[10.5px] font-semibold leading-tight', active ? 'text-fg' : 'text-muted group-hover:text-fg')}>
        {label}
      </span>
    </a>
  );
}

/**
 * The rail on the far left: TeamBot's mark, the chats, Wacht op jou and Taken at the top; the Marktplaats, Instellingen
 * and folding the list at the bottom, each with its name. Always there, also with the list folded away. Together with
 * the list next to it this is the "Hoofdmenu" (App.tsx).
 */
export function NavRail({ route, onNavigate }: { route: string[]; onNavigate?(): void }) {
  const approvals = useApp((s) => s.approvals.length) + useInboxExtraCount();
  const online = useApp((s) => s.online);
  const mode = useApp((s) => s.mode);
  const folded = useSidebarFolded();
  const d = DESTINATIONS;
  return (
    <div className="flex w-[76px] shrink-0 flex-col items-center gap-1.5 py-1">
      <a href="#/" onClick={onNavigate} aria-label="TeamBot" className="relative mb-3 flex size-12 items-center justify-center">
        <Mark size={38} />
        {!online && <span className="absolute bottom-0.5 end-0.5 h-2.5 w-2.5 rounded-full border-2 border-canvas bg-warn" aria-hidden />}
        <span className="sr-only">{online ? 'verbonden' : 'verbinding herstellen'}</span>
      </a>
      <RailItem href={d.chats.href} label={d.chats.label} icon={d.chats.icon} active={d.chats.active(route)} onNavigate={onNavigate} />
      <RailItem href={d.inbox.href} label={d.inbox.label} icon={Inbox} active={d.inbox.active(route)} count={approvals} onNavigate={onNavigate} />
      <RailItem href={d.tasks.href} label={d.tasks.label} icon={d.tasks.icon} active={d.tasks.active(route)} onNavigate={onNavigate} />
      <RailItem href={d.dashboard.href} label={d.dashboard.label} icon={d.dashboard.icon} active={d.dashboard.active(route)} onNavigate={onNavigate} />
      <div className="mt-auto flex w-full flex-col items-center gap-1.5">
        <RailItem href={d.market.href} label={d.market.label} icon={d.market.icon} active={d.market.active(route)} onNavigate={onNavigate} />
        <RailItem href={d.settings.href} label={d.settings.label} icon={d.settings.icon} active={d.settings.active(route)} onNavigate={onNavigate} />
        {mode === 'server' && (
          <button type="button" aria-label="Uitloggen" onClick={logout} className={cx(iconBtn, 'tb-tip-start size-10 rounded-xl')}>
            <LogOut className="size-5 stroke-[1.75]" aria-hidden />
          </button>
        )}
        <button type="button" aria-label={t(folded ? 'Zijbalk uitklappen' : 'Zijbalk inklappen')} onClick={toggleSidebarFolded} className={cx(iconBtn, 'tb-tip-up tb-tip-start size-10 rounded-xl')}>
          {folded ? <PanelLeftOpen className="size-5 stroke-[1.75]" aria-hidden /> : <PanelLeftClose className="size-5 stroke-[1.75]" aria-hidden />}
        </button>
      </div>
    </div>
  );
}

/**
 * Desktop sidebar, top to bottom: (the team switcher, from two teams on), TeamBot with the bell and the "+" (Nieuwe bot,
 * Nieuw team: ./NewMenu), the search box, the pinned bots (always in view), the chat list (each bot with its status
 * dot), and at the bottom the fixed places "Wacht op jou" with its count, Taken, Marktplaats and Instellingen
 * (shell/nav.tsx: Routines live in Taken, Geheugen in Instellingen), and under them the usage meters: one ring per
 * subscription or provider, each its own button (modules/usage/UsageMeter). Everything else is under Instellingen.
 */
export function Sidebar({ route, onNavigate }: { route: string[]; onNavigate?(): void }) {
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const closeSearch = () => (setQ(''), setSearching(false));

  return (
    <div className="flex h-full w-full flex-col" role="region" aria-label="Bots en gesprekken">
      {/* The team switcher (only from two teams on), then search, the bell and "+" in one row, as OpenBot. */}
      <TeamSwitcher className="mx-2 mt-2" onNavigate={onNavigate} />
      <div className="flex shrink-0 items-center gap-1 px-2 pb-2 pt-2">
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
              className="h-9 w-full rounded-control border border-line-strong bg-surface ps-9 pe-9 text-sm outline-none placeholder:text-muted coarse:h-11"
            />
            <button type="button" aria-label="Zoeken sluiten" onMouseDown={(e) => e.preventDefault()} onClick={closeSearch} className="absolute end-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-3 hover:text-fg">
              <X className="size-icon" aria-hidden />
            </button>
          </form>
        ) : (
          <button
            type="button"
            data-tip={t('Zoek een bot · Ctrl+K zoekt overal')}
            onClick={() => setSearching(true)}
            className="tb-tip flex h-9 min-w-0 flex-1 items-center gap-2 rounded-control border border-line bg-surface-2 px-3 text-sm text-muted transition-colors hover:text-fg coarse:h-11"
          >
            <Search className="size-icon stroke-[1.75]" aria-hidden />
            <span className="flex-1 text-start">Zoeken</span>
          </button>
        )}
        <NotificationBell />
        {/* "+": Nieuwe bot, Nieuw team, Team uit een sjabloon. */}
        <NewMenu onNavigate={onNavigate} />
      </div>

      {/* The list: the main bot and the pinned bots first (always in view), then every bot and group. */}
      <PinnedRows route={route} onNavigate={onNavigate} q={q} className="px-2" />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-1">
        <ChatList route={route} onNavigate={onNavigate} q={q} pinned="apart" />
      </div>

      {/* At the bottom: stop what runs, and the usage rings (one per subscription or provider; each shows its details).
          relative: the usage popover opens above this footer. */}
      <div className="relative border-t border-line px-2 py-1.5">
        <StopAllButton className="mb-1" />
        <AwakeIndicator className="mb-1" />
        <UsageMeter className="min-w-0 px-1" />
      </div>
    </div>
  );
}
