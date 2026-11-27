import { useState, useSyncExternalStore } from 'react';
import { Search, Square, X } from 'lucide-react';
import { api, disconnectWs, setToken } from '../lib/api';
import { useApp } from '../lib/store';
import { BotFace } from '../components/BotFace';
import { cx, toast } from '../components/ui';
import { ChatList, PinnedRows } from './ChatList';
import { openPalette } from './CommandPalette';
import { saveLock } from './lockCore';
import { UsageMeter } from '../modules/usage/UsageMeter';
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
        className={cx('flex shrink-0 items-center gap-1.5 rounded-full bg-danger-soft px-3.5 text-[13px] font-bold text-danger', /(^|\s)h-\d/.test(className || '') ? '' : 'h-11', className)}
        aria-label={t('Alles stoppen ({0, plural, one {# taak} other {# taken}} bezig)', runs)}
        title="Stopt alle lopende taken van je bots"
      >
        {/* "Alles stoppen" is the visible text and the start of the name; the count is drawn by the style (the name says it
            in words: checkers compare without what is between brackets). */}
        <Square className="h-3 w-3 fill-current" aria-hidden /> Alles stoppen
        <span data-count={runs} className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-danger px-1 text-[11px] tabular-nums text-danger-fg after:content-[attr(data-count)]" aria-hidden />
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
  const own = useSyncExternalStore(
    (f) => (foldListeners.add(f), () => foldListeners.delete(f)),
    readFolded,
    () => false,
  );
  return own;
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
      {/* Editorial header + "+" menu */}
      <div className="flex shrink-0 items-center justify-between px-4 pb-1 pt-4">
        <span className="tb-editorial text-[19px] font-bold text-fg">Werkruimte</span>
        <NewMenu onNavigate={onNavigate} />
      </div>
      {/* Search row */}
      <div className="flex shrink-0 items-center gap-1.5 px-3 pb-3 pt-2">
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
              className="h-8 w-full rounded-[9px] border border-line-strong bg-surface ps-9 pe-9 text-[13px] outline-none placeholder:text-muted coarse:h-11"
            />
            <button type="button" aria-label="Zoeken sluiten" onMouseDown={(e) => e.preventDefault()} onClick={closeSearch} className="absolute end-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-3 hover:text-fg">
              <X className="size-icon" aria-hidden />
            </button>
          </form>
        ) : (
          <button
            type="button"
            data-tip={t('Zoek een bot · Ctrl+K zoekt overal')}
            onClick={() => setSearching(true)}
            className="tb-tip flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[9px] border border-line bg-surface px-3 text-[13px] text-muted transition-colors hover:border-line-strong hover:text-fg coarse:h-11"
          >
            <Search className="size-3.5 stroke-[1.8]" aria-hidden />
            <span className="flex-1 text-start">Zoeken</span>
          </button>
        )}
      </div>

      {/* The list: the main bot and the pinned bots first (always in view), then every bot and group. */}
      <PinnedRows route={route} onNavigate={onNavigate} q={q} className="px-2" />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-1">
        <ChatList route={route} onNavigate={onNavigate} q={q} pinned="apart" />
      </div>

      {/* At the bottom: the usage rings (one per subscription or provider; each shows its details).
          relative: the usage popover opens above this footer. */}
      <div className="relative border-t border-line px-2 py-1.5">
        <UsageMeter className="min-w-0 px-1" />
      </div>
    </div>
  );
}
