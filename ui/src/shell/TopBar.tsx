import { useLayoutEffect, useRef, useState } from 'react';
import { Blocks, Inbox, LayoutDashboard, LogOut, MessageCircle, PanelLeftClose, PanelLeftOpen, Search, Settings, SquareKanban, Store, type LucideIcon } from 'lucide-react';
import { cx } from '../components/ui';
import { t } from '../lib/i18n';
import { useApp } from '../lib/store';
import { Ring } from '../modules/usage/parts';
import { NotificationBell } from '../modules/notifications/parts';
import { TeamSwitcher } from './TeamSwitcher';
import { openPalette } from './CommandPalette';
import { DESTINATIONS } from './nav';
import { AwakeIndicator } from './power';
import { Mark, StopAllButton, logout, toggleSidebarFolded, useSidebarFolded } from './Sidebar';
import { useBusy, useWorstUsage } from './status';
import { useWaiting } from './status';
import { botsBusy } from '../pages/dashboard/text';

/**
 * TeamBot's menu bar (4.17.0): one bar over the whole app, as the menu bar of an operating system. Left the mark and
 * the main menu (Chats, Dashboard, Wacht op jou, Taken, Apps, Marktplaats, Instellingen: seven places, no more), right
 * the state of the whole thing on every page (search, the bots at work, the fullest usage ring, the pc kept awake,
 * stop everything, the notifications, the time). The pages below are windows on the wallpaper; the list of bots is a
 * window of its own next to the chats. Desktop only: the phone keeps its tab bar.
 *
 * Earlier versions had a rail with icons on the left, the same shape as OpenBot's; this is TeamBot's own. The places
 * stay out of the list of bots (the owner wanted no rows for them above his bots).
 */

function Place({ href, label, icon: Icon, active, count, iconOnly }: { href: string; label: string; icon: LucideIcon; active: boolean; count?: number; iconOnly?: boolean }) {
  return (
    <a
      href={href}
      aria-label={iconOnly ? (count ? `${label}, ${count} open` : label) : undefined}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'tb-place group relative flex h-8 shrink-0 items-center gap-1.5 rounded-lg text-[13px] font-medium transition-colors',
        iconOnly ? 'tb-tip w-8 justify-center' : 'px-2.5',
        active ? 'bg-surface-2 text-fg' : 'text-muted hover:bg-surface-2/60 hover:text-fg',
      )}
      data-tip={iconOnly ? label : undefined}
    >
      <Icon className={cx('size-[16px]', active ? 'stroke-[2.2] text-brand' : 'stroke-[1.8]')} aria-hidden />
      {!iconOnly && (
        <span data-i18n="label" className="max-lg:sr-only">
          {label}
        </span>
      )}
      {!!count && (
        <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-warn-strong px-1 text-[11px] font-bold tabular-nums text-warn-fg">
          {count}
          <span className="sr-only"> open</span>
        </span>
      )}
    </a>
  );
}

/**
 * Whether the places fit with their names next to the right part of the bar. The width the menu needs with names is
 * measured while it shows them; with icons only, that last measure decides when there is room again. A language with
 * long names (French) or a narrow window gets icons, never places that run under the search button.
 */
function useFits(deps: unknown[]) {
  const bar = useRef<HTMLElement>(null);
  const menu = useRef<HTMLElement>(null);
  const right = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  // Both parts are measured as they are with names (the right part is narrower with icons only: measuring it then
  // would make room that is not there, and the bar would flip back and forth).
  const need = useRef({ menu: 0, right: 0 });
  useLayoutEffect(() => {
    const b = bar.current;
    const m = menu.current;
    const r = right.current;
    if (!b || !m || !r) return;
    // The width of what is in it, by its boxes: scrollWidth also counts the tooltips (absolutely placed ::after of
    // .tb-tip), which made the menu seem far wider than it is and hid the names at every width (24 Nov 2026).
    const used = (el: HTMLElement) => {
      const kids = [...el.children] as HTMLElement[];
      const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
      return kids.reduce((s, c) => s + c.getBoundingClientRect().width, 0) + gap * Math.max(0, kids.length - 1);
    };
    const fit = () => {
      // The places row may be squeezed (min-w-0): count what its buttons need, not the box it got.
      const places = m.querySelector<HTMLElement>('.tb-places');
      const squeezed = places ? used(places) - places.getBoundingClientRect().width : 0;
      if (!compact) need.current = { menu: used(m) + Math.max(0, squeezed), right: used(r) };
      const room = b.clientWidth - need.current.right - 40;
      const next = need.current.menu > room;
      if (next !== compact) setCompact(next);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(b);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compact, ...deps]);
  return { bar, menu, right, compact };
}

export function TopBar({ route, listShown }: { route: string[]; listShown: boolean }) {
  const online = useApp((s) => s.online);
  const mode = useApp((s) => s.mode);
  useSidebarFolded();
  const waiting = useWaiting();
  const { agents, busy } = useBusy();
  const worst = useWorstUsage();
  const d = DESTINATIONS;
  const chats = d.chats.active(route);
  const pill = 'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[13px] transition-colors hover:bg-fg/[0.07]';
  const usedText = worst ? new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 }).format((worst.usedPercent || 0) / 100) : '';
  const lang = typeof document !== 'undefined' ? document.documentElement.lang : '';
  const { bar, menu, right, compact } = useFits([lang, waiting > 0, chats, agents.length > 0, !!worst, busy.length > 0]);
  return (
    <header ref={bar} className="tb-topbar flex h-[52px] shrink-0 items-center gap-1 border-b border-line bg-surface px-3.5" data-testid="topbar" data-compact={compact || undefined}>
      <nav ref={menu} aria-label="Hoofdmenu" className="flex min-w-0 items-center gap-1.5">
        <span className="relative me-1 flex h-9 shrink-0 items-center gap-2 pe-2 ps-1" title="TeamBot">
          <Mark size={30} />
          {!compact && (
            <span className="hidden text-[16px] font-extrabold tracking-tight xl:inline" translate="no">
              TeamBot
            </span>
          )}
          {!online && <span className="absolute bottom-1 start-6 h-2.5 w-2.5 rounded-full border-2 border-canvas bg-warn" aria-hidden />}
          <span className="sr-only">{online ? 'verbonden' : 'verbinding herstellen'}</span>
        </span>
        <TeamSwitcher className="w-44 shrink-0" />
        {chats && (
          <button type="button" aria-label={t(listShown ? 'Zijbalk inklappen' : 'Zijbalk uitklappen')} onClick={toggleSidebarFolded} className={cx(pill, 'tb-tip tb-tip-start size-9 justify-center px-0 text-muted hover:text-fg')}>
            {listShown ? <PanelLeftClose className="size-[18px] stroke-[1.8]" aria-hidden /> : <PanelLeftOpen className="size-[18px] stroke-[1.8]" aria-hidden />}
          </button>
        )}
        <div className="tb-places mx-1 flex min-w-0 items-center gap-0.5">
          <Place href={d.chats.href} label={d.chats.label} icon={MessageCircle} active={chats} iconOnly={compact} />
          <Place href={d.dashboard.href} label={d.dashboard.label} icon={LayoutDashboard} active={d.dashboard.active(route)} iconOnly={compact} />
          <Place href={d.inbox.href} label={d.inbox.label} icon={Inbox} active={d.inbox.active(route)} count={waiting} iconOnly={compact} />
          <Place href={d.tasks.href} label={d.tasks.label} icon={SquareKanban} active={d.tasks.active(route)} iconOnly={compact} />
          <Place href={d.apps.href} label={d.apps.label} icon={Blocks} active={d.apps.active(route)} iconOnly={compact} />
          <Place href={d.market.href} label={d.market.label} icon={Store} active={d.market.active(route)} iconOnly={compact} />
          <span className="mx-0.5 h-5 w-px shrink-0 bg-fg/10" aria-hidden />
          <Place href={d.settings.href} label={d.settings.label} icon={Settings} active={d.settings.active(route)} iconOnly />
        </div>
      </nav>
      <div ref={right} className="ms-auto flex shrink-0 items-center gap-0.5">
        {/* 24 Nov 2026: a quiet bar. Search as one icon (Ctrl K), no clock and no counters the dashboard already shows. */}
        <button type="button" onClick={() => openPalette()} aria-label={t('Zoeken')} data-tip={`${t('Zoeken')} (${t('Ctrl K')})`} className={cx(pill, 'tb-search tb-tip size-9 justify-center px-0 text-muted hover:text-fg')}>
          <Search className="size-4 stroke-[1.9]" aria-hidden />
        </button>
        <StopAllButton compact className="h-9" />
        <AwakeIndicator className="max-w-[12rem] rounded-full" />
        {busy.length > 0 && (
          <a href="#/dashboard/team" className={pill} title={botsBusy(busy.length, agents.length)}>
            <span className="size-2 animate-pulse rounded-full bg-ok" aria-hidden />
            <span className="font-semibold tabular-nums">{busy.length}</span>
          </a>
        )}
        {worst && (
          <a href="#/dashboard/verbruik" className={pill} title={t(worst.label)} aria-label={`${t('Gebruik en limieten')}: ${usedText}`}>
            <Ring value={worst.usedPercent} size={18} stroke={3} level={worst.level} />
            <span className="font-semibold tabular-nums">{usedText}</span>
          </a>
        )}
        <NotificationBell />
        {mode === 'server' && (
          <button type="button" aria-label="Uitloggen" onClick={logout} className={cx(pill, 'tb-tip tb-tip-end size-9 justify-center px-0 text-muted hover:text-fg')}>
            <LogOut className="size-[18px] stroke-[1.8]" aria-hidden />
          </button>
        )}
      </div>
    </header>
  );
}
