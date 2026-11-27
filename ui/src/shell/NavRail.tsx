import { useSyncExternalStore } from 'react';
import { logoMark } from '../../../shared/logo.js';
import {
  Activity,
  AlarmClock,
  Blocks,
  Brain,
  CheckSquare,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  Inbox,
  LogOut,
  MessageSquareText,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  Store,
  Sun,
  type LucideIcon,
} from 'lucide-react';
import { cx } from '../components/ui';
import { t } from '../lib/i18n';
import { useApp } from '../lib/store';
import { NotificationBell } from '../modules/notifications/parts';
import { Ring } from '../modules/usage/parts';
import { openPalette } from './CommandPalette';
import { DESTINATIONS } from './nav';
import { AwakeIndicator } from './power';
import { StopAllButton, logout, toggleSidebarFolded, useSidebarFolded } from './Sidebar';
import { ChatList, PinnedRows } from './ChatList';
import { NewMenu } from './NewMenu';
import { TeamSwitcher } from './TeamSwitcher';
import { setThemePref, useThemePref } from './theme';
import { useBusy, useWaiting, useWorstUsage } from './status';

/**
 * TeamBot Editorial Arc Rail: compact 64px vertical icon rail on the far left that expands cleanly to a 232px grouped
 * menu (Werkruimte + Bouwen & Kennis + Teamkiezer + Live status/thema/instellingen). Replaces the old top bar.
 */

const KEY = 'tb_nav_open';
const listeners = new Set<() => void>();
const readOpen = () => {
  try {
    return localStorage.getItem(KEY) !== '0';
  } catch {
    return false;
  }
};
function toggleOpen() {
  try {
    localStorage.setItem(KEY, readOpen() ? '0' : '1');
  } catch {
    /* not kept */
  }
  listeners.forEach((f) => f());
}
const MORE_KEY = 'tb_nav_more';
const readMore = () => {
  try {
    return localStorage.getItem(MORE_KEY) === '1';
  } catch {
    return false;
  }
};
function toggleMore() {
  try {
    localStorage.setItem(MORE_KEY, readMore() ? '0' : '1');
  } catch {
    /* not kept */
  }
  listeners.forEach((f) => f());
}
function useMoreOpen(): boolean {
  return useSyncExternalStore(
    (f) => (listeners.add(f), () => listeners.delete(f)),
    readMore,
    () => false,
  );
}

export function useNavOpen(): boolean {
  return useSyncExternalStore(
    (f) => (listeners.add(f), () => listeners.delete(f)),
    readOpen,
    () => false,
  );
}

function RailItem({
  id,
  href,
  label,
  icon: Icon,
  active,
  count,
  open,
}: {
  id: string;
  href: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  count?: number;
  open: boolean;
}) {
  const name = t(label);
  return (
    <a
      href={href}
      aria-current={active ? 'page' : undefined}
      aria-label={count ? `${name}, ${count}` : name}
      data-tip={!open ? name : undefined}
      data-testid={`nav-${id}`}
      className={cx(
        'group relative flex items-center rounded-[11px] font-medium transition-all duration-150',
        open ? 'h-9 gap-2.5 px-2.5 text-[13.5px]' : 'tb-tip tb-tip-start mx-auto size-10 justify-center',
        active ? 'bg-surface text-fg font-semibold shadow-xs' : 'text-muted hover:bg-surface/60 hover:text-fg',
      )}
    >
      {active && <span className={cx('absolute top-1/2 -translate-y-1/2 rounded-e-full bg-fg', open ? 'start-0 h-4 w-[3px]' : '-start-3 h-5 w-[3px]')} aria-hidden />}
      <Icon className={cx('size-[18px] shrink-0', active ? 'stroke-[2.1] text-fg' : 'stroke-[1.7]')} aria-hidden />
      {open && <span className="min-w-0 flex-1 truncate">{name}</span>}
      {!!count &&
        (open ? (
          <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-warn-strong px-1.5 text-[11px] font-bold tabular-nums text-warn-fg">{count}</span>
        ) : (
          <span className="absolute -end-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-warn-strong px-1 text-[9.5px] font-bold tabular-nums text-warn-fg ring-2 ring-rail" aria-hidden>
            {count}
          </span>
        ))}
    </a>
  );
}

function SectionLabel({ open, children }: { open: boolean; children: React.ReactNode }) {
  if (!open) return <div className="mx-auto my-2 h-px w-6 bg-line-strong/70" aria-hidden />;
  return <div className="px-2.5 pb-1 pt-3 font-mono text-[10px] font-semibold uppercase tracking-widest text-muted/80">{children}</div>;
}

export function NavRail({ route, listShown }: { route: string[]; listShown: boolean }) {
  const d = DESTINATIONS;
  const open = useNavOpen();
  useSidebarFolded();
  const waiting = useWaiting();
  const { busy } = useBusy();
  const worst = useWorstUsage();
  const mode = useApp((s) => s.mode);
  const online = useApp((s) => s.online);
  const theme = useThemePref();
  const isDark = theme === 'dark' || (theme === 'system' && typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const chatsActive = d.chats.active(route);
  const more = useMoreOpen();
  const settingsOn = d.settings.active(route);

  // Open: one sidebar like a modern AI app (4.18.14): logo, search pill, the places with their names, then the bots as
  // the conversation list, and the small tools at the bottom. Folded it is the icon rail below.
  if (open)
    return (
      <nav aria-label="Hoofdmenu" data-testid="navrail" data-open className="tb-rail relative z-20 flex w-[284px] shrink-0 flex-col select-none">
        <div className="flex items-center gap-2.5 px-4 pb-2 pt-4">
          <a href="#/" title="TeamBot" className="relative flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-black ring-1 ring-white/10 transition hover:opacity-90">
            <svg viewBox="0 0 512 512" className="size-7" aria-hidden dangerouslySetInnerHTML={{ __html: logoMark('var(--color-brand)', '#000') }} />
            {busy.length > 0 && <span className="absolute -end-1 -top-1 size-2.5 animate-pulse rounded-full bg-ok ring-2 ring-rail" aria-hidden />}
            {!online && <span className="absolute -bottom-0.5 -end-0.5 size-2.5 rounded-full bg-warn ring-2 ring-rail" aria-hidden />}
          </a>
          <div className="min-w-0 flex-1 text-[17px] font-bold tracking-tight text-fg" translate="no">
            TeamBot
          </div>
          <NotificationBell className="flex size-8 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-fg" />
          <button type="button" onClick={toggleOpen} aria-expanded data-testid="nav-toggle" aria-label={t('Menu inklappen')} className="flex size-8 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-fg">
            <PanelLeftClose className="size-[17px]" aria-hidden />
          </button>
        </div>

        <div className="px-3 pb-2">
          <button type="button" onClick={() => openPalette()} aria-label={`${t('Zoeken')} (Ctrl K)`} className="flex h-10 w-full items-center gap-2.5 rounded-full border border-line-strong bg-surface px-4 text-[13.5px] text-muted transition-colors hover:border-fg/25 hover:text-fg">
            <Search className="size-4 shrink-0" aria-hidden />
            <span className="flex-1 text-start">{t('Zoeken')}</span>
            <kbd className="font-mono text-[10.5px] text-muted">Ctrl K</kbd>
          </button>
        </div>

        <div className="space-y-0.5 px-3 pb-1">
          {(
            [
              ['dashboard', d.dashboard, Activity, 0],
              ['inbox', d.inbox, Inbox, waiting],
              ['tasks', d.tasks, CheckSquare, 0],
              ...(more || [d.routines, d.memory, d.apps, d.market].some((x) => x.active(route))
                ? ([
                    ['routines', d.routines, AlarmClock, 0],
                    ['memory', d.memory, Brain, 0],
                    ['apps', d.apps, Blocks, 0],
                    ['market', d.market, Store, 0],
                  ] as const)
                : []),
            ] as const
          ).map(([id, dest, Icon, count]) => {
            const active = dest.active(route);
            return (
              <a
                key={id}
                href={dest.href}
                data-testid={`nav-${id}`}
                aria-current={active ? 'page' : undefined}
                className={cx('flex h-9 items-center gap-3 rounded-full px-3.5 text-[13.5px] font-medium transition-colors', active ? 'bg-surface-2 text-fg' : 'text-muted hover:bg-surface-2/70 hover:text-fg')}
              >
                <Icon className={cx('size-[17px] shrink-0', active ? 'text-brand stroke-[2.2]' : 'stroke-[1.8]')} aria-hidden />
                <span className="min-w-0 flex-1 truncate">{t(dest.label)}</span>
                {!!count && <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1.5 text-[11px] font-bold tabular-nums text-black">{count}</span>}
              </a>
            );
          })}
          <button type="button" onClick={toggleMore} aria-expanded={more} className="flex h-9 w-full items-center gap-3 rounded-full px-3.5 text-[13.5px] font-medium text-muted transition-colors hover:bg-surface-2/70 hover:text-fg">
            <ChevronDown className={cx('size-[17px] shrink-0 transition-transform', more && 'rotate-180')} aria-hidden />
            <span className="flex-1 text-start">{t(more ? 'Minder' : 'Meer')}</span>
          </button>
        </div>

        <div className="px-3 pt-1">
          <TeamSwitcher className="w-full" />
        </div>

        <div className="flex items-center justify-between px-5 pb-1 pt-3">
          <a href={d.chats.href} aria-current={chatsActive ? 'page' : undefined} className="text-[11.5px] font-semibold uppercase tracking-wider text-muted hover:text-fg">
            {t('Gesprekken')}
          </a>
          <NewMenu />
        </div>
        <PinnedRows route={route} className="px-2" />
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          <ChatList route={route} pinned="apart" />
        </div>

        <div className="space-y-1 border-t border-line px-3 pb-3 pt-2">
          <StopAllButton />
          <AwakeIndicator className="w-full rounded-full" />
          <div className="flex items-center gap-1 pt-1">
            <a href={d.settings.href} aria-current={settingsOn ? 'page' : undefined} className={cx('flex h-9 flex-1 items-center gap-2.5 rounded-full px-3 text-[13px] font-medium transition-colors', settingsOn ? 'bg-surface-2 text-fg' : 'text-muted hover:bg-surface-2/70 hover:text-fg')}>
              <Settings className="size-[17px] shrink-0" aria-hidden />
              {t(d.settings.label)}
            </a>
            <button type="button" onClick={() => setThemePref(isDark ? 'light' : 'dark')} aria-label={isDark ? t('Licht thema') : t('Donker thema')} className="flex size-9 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-fg">
              {isDark ? <Sun className="size-[17px]" /> : <Moon className="size-[17px]" />}
            </button>
            {mode === 'server' && (
              <button type="button" onClick={logout} aria-label="Uitloggen" className="flex size-9 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-fg">
                <LogOut className="size-[17px]" aria-hidden />
              </button>
            )}
          </div>
        </div>
      </nav>
    );

  const utilClass = cx(
    'flex items-center rounded-[10px] text-muted transition-colors hover:bg-surface/65 hover:text-fg',
    open ? 'h-9 w-full gap-2.5 px-2.5 text-[13px] font-medium' : 'mx-auto size-9 justify-center',
  );

  return (
    <nav
      aria-label="Hoofdmenu"
      data-testid="navrail"
      data-open={open || undefined}
      className={cx(
        'tb-rail relative z-20 flex shrink-0 flex-col py-3.5 select-none transition-[width] duration-200',
        open ? 'w-[232px] px-3' : 'w-[66px] px-2',
      )}
    >
      {/* Top: Editorial TB Monogram + Expandable Wordmark */}
      <div className={cx('mb-4 flex items-center gap-2.5', open ? 'px-1' : 'justify-center')}>
        <a
          href="#/"
          title="TeamBot"
          className="relative flex size-10 shrink-0 items-center justify-center rounded-[11px] bg-black ring-1 ring-white/10 transition hover:opacity-90"
        >
          <svg viewBox="0 0 512 512" className="size-7" aria-hidden dangerouslySetInnerHTML={{ __html: logoMark('var(--color-brand)', '#000') }} />
          {busy.length > 0 && <span className="absolute -end-1 -top-1 size-2.5 animate-pulse rounded-full bg-ok ring-2 ring-rail" aria-hidden />}
          {!online && <span className="absolute -bottom-0.5 -end-0.5 size-2.5 rounded-full bg-warn ring-2 ring-rail" aria-hidden />}
        </a>
        {open && (
          <div className="min-w-0 flex-1">
            <div className="tb-editorial text-[17px] font-bold leading-none text-fg" translate="no">
              TeamBot
            </div>
            <div className="mt-0.5 font-mono text-[10px] text-muted">{busy.length > 0 ? `${busy.length} actief` : 'gereed'}</div>
          </div>
        )}
        {chatsActive && open && (
          <button
            type="button"
            onClick={toggleSidebarFolded}
            aria-label={t(listShown ? 'Zijbalk inklappen' : 'Zijbalk uitklappen')}
            className="flex size-7 items-center justify-center rounded-lg text-muted hover:bg-surface/70 hover:text-fg"
          >
            {listShown ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />}
          </button>
        )}
      </div>

      {/* Team switcher integrated into rail when unfolded */}
      {open && (
        <div className="mb-3">
          <TeamSwitcher className="w-full" />
        </div>
      )}

      {/* Primary & Secondary Grouped Menus */}
      <div className={cx('min-h-0 flex-1 space-y-1', open ? 'scroll-thin overflow-y-auto overflow-x-hidden' : 'overflow-visible')}>
        {open && <div className="px-2.5 pb-1 font-mono text-[10px] font-semibold uppercase tracking-widest text-muted/80">Werkruimte</div>}
        <RailItem open={open} id="chats" href={d.chats.href} label={d.chats.label} icon={MessageSquareText} active={chatsActive} />
        <RailItem open={open} id="dashboard" href={d.dashboard.href} label={d.dashboard.label} icon={Activity} active={d.dashboard.active(route)} />
        <RailItem open={open} id="inbox" href={d.inbox.href} label={d.inbox.label} icon={Inbox} active={d.inbox.active(route)} count={waiting} />
        <RailItem open={open} id="tasks" href={d.tasks.href} label={d.tasks.label} icon={CheckSquare} active={d.tasks.active(route)} />

        <SectionLabel open={open}>Kennis & Apps</SectionLabel>
        <RailItem open={open} id="routines" href={d.routines.href} label={d.routines.label} icon={AlarmClock} active={d.routines.active(route)} />
        <RailItem open={open} id="memory" href={d.memory.href} label={d.memory.label} icon={Brain} active={d.memory.active(route)} />
        <RailItem open={open} id="apps" href={d.apps.href} label={d.apps.label} icon={Blocks} active={d.apps.active(route)} />
        <RailItem open={open} id="market" href={d.market.href} label={d.market.label} icon={Store} active={d.market.active(route)} />
      </div>

      {/* Bottom Utility Strip */}
      <div className="mt-2 space-y-1 border-t border-line-strong/60 pt-2.5">
        {open && <StopAllButton className="mb-1" />}
        {open && <AwakeIndicator className="w-full rounded-[10px]" />}

        {chatsActive && !open && (
          <button
            type="button"
            onClick={toggleSidebarFolded}
            aria-label={t(listShown ? 'Bots verbergen' : 'Bots tonen')}
            data-tip={t(listShown ? 'Bots verbergen' : 'Bots tonen')}
            className={cx(utilClass, 'tb-tip tb-tip-start')}
          >
            {listShown ? <PanelLeftClose className="size-[17px]" /> : <PanelLeftOpen className="size-[17px]" />}
          </button>
        )}

        <button
          type="button"
          onClick={() => openPalette()}
          aria-label={`${t('Zoeken')} (Ctrl K)`}
          data-tip={!open ? `${t('Zoeken')} (Ctrl+K)` : undefined}
          className={cx(utilClass, !open && 'tb-tip tb-tip-start')}
        >
          <Search className="size-[17px] shrink-0" aria-hidden />
          {open && <span className="flex-1 text-start">{t('Zoeken')}</span>}
          {open && <kbd className="font-mono text-[10px] text-muted">Ctrl+K</kbd>}
        </button>

        {worst && (
          <a
            href="#/dashboard/verbruik"
            title={t(worst.label)}
            data-tip={!open ? `${t('Verbruik')}: ${Math.round(worst.usedPercent || 0)}%` : undefined}
            className={cx(utilClass, !open && 'tb-tip tb-tip-start')}
          >
            <Ring value={worst.usedPercent} size={18} stroke={3} level={worst.level} />
            {open && <span className="flex-1 truncate text-start">{t('Verbruik')}</span>}
            {open && <span className="font-mono text-[11px]">{Math.round(worst.usedPercent || 0)}%</span>}
          </a>
        )}

        <NotificationBell labeled={open ? 'beside' : undefined} className={utilClass} />

        <button
          type="button"
          onClick={() => setThemePref(isDark ? 'light' : 'dark')}
          aria-label={isDark ? t('Licht thema') : t('Donker thema')}
          data-tip={!open ? (isDark ? t('Licht thema') : t('Donker thema')) : undefined}
          className={cx(utilClass, !open && 'tb-tip tb-tip-start')}
        >
          {isDark ? <Sun className="size-[17px] shrink-0" /> : <Moon className="size-[17px] shrink-0" />}
          {open && <span className="flex-1 text-start">{isDark ? t('Licht thema') : t('Donker thema')}</span>}
        </button>

        <a
          href={d.settings.href}
          aria-current={settingsOn ? 'page' : undefined}
          aria-label={t(d.settings.label)}
          data-tip={!open ? t(d.settings.label) : undefined}
          className={cx(utilClass, !open && 'tb-tip tb-tip-start', settingsOn && 'bg-surface text-fg font-semibold shadow-xs')}
        >
          <Settings className="size-[17px] shrink-0" aria-hidden />
          {open && <span className="flex-1 text-start">{t(d.settings.label)}</span>}
        </a>

        {mode === 'server' && (
          <button type="button" onClick={logout} aria-label="Uitloggen" className={utilClass}>
            <LogOut className="size-[17px] shrink-0" aria-hidden />
            {open && <span className="flex-1 text-start">Uitloggen</span>}
          </button>
        )}

        <button
          type="button"
          onClick={toggleOpen}
          aria-expanded={open}
          data-testid="nav-toggle"
          aria-label={open ? t('Menu inklappen') : t('Menu uitklappen')}
          data-tip={!open ? t('Menu uitklappen') : undefined}
          className={cx(utilClass, !open && 'tb-tip tb-tip-start')}
        >
          {open ? <ChevronsLeft className="size-[17px] shrink-0" /> : <ChevronsRight className="size-[17px] shrink-0" />}
          {open && <span className="flex-1 text-start">{t('Inklappen')}</span>}
        </button>
      </div>
    </nav>
  );
}
