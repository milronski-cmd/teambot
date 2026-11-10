import { useEffect } from 'react';
import { ChevronRight, Lock, LogOut, Search } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useApp } from '../lib/store';
import { useIsDesktop } from '../lib/media';
import { useInboxExtraCount } from '../modules';
import { Page, PageHeader, cx } from '../components/ui';
import { StopAllButton, logout } from '../shell/Sidebar';
import { UsageBar } from '../modules/usage/UsageBar';
import { phoneMoreDestinations } from '../shell/nav';
import { TeamSwitcher } from '../shell/TeamSwitcher';

interface Item {
  href: string;
  title: string;
  icon: LucideIcon;
  count?: number;
}

function Row({ it }: { it: Item }) {
  const Icon = it.icon;
  return (
    <a href={it.href} className="group flex min-h-[52px] items-center gap-3 border-b border-line px-3 py-2 last:border-b-0 hover:bg-surface-2">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-surface-3 text-fg">
        <Icon className="h-[18px] w-[18px]" />
      </span>
      <span className="min-w-0 flex-1 text-[15px] font-semibold">{it.title}</span>
      {!!it.count && <span className="rounded-full bg-warn-strong px-2 py-0.5 text-xs font-bold text-warn-fg">{it.count}</span>}
      <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
    </a>
  );
}

/**
 * #/more — on the phone the last tab: the same fixed places as the desktop sidebar that are not a tab of their own
 * (Taken, Routines, Geheugen, Marktplaats, Instellingen), plus search and "Alles stoppen". Everything else is under
 * Instellingen. The desktop has no "Meer" any more: the old link opens Instellingen.
 */
export function MorePage() {
  const desktop = useIsDesktop();
  const approvals = useApp((s) => s.approvals.length) + useInboxExtraCount();
  const mode = useApp((s) => s.mode);
  useEffect(() => {
    if (!desktop) return;
    history.replaceState(null, '', '#/settings');
    dispatchEvent(new HashChangeEvent('hashchange'));
  }, [desktop]);
  if (desktop) return null;
  const items: Item[] = [
    ...phoneMoreDestinations().map((d) => ({ href: d.href, title: d.label, icon: d.icon, count: d.id === 'inbox' ? approvals : undefined })),
    { href: '#/search', title: 'Zoeken', icon: Search },
    // "Waar staat mijn data?" stays one tap from Meer, as the lock next to Instellingen in the desktop sidebar (§15).
    { href: '#/settings/data', title: 'Waar staat mijn data?', icon: Lock },
  ];
  return (
    <Page>
      <PageHeader title="Meer" />
      <div className="mx-auto max-w-xl space-y-4 px-4 py-3">
        {/* From two teams on: the team you look at (the same choice as on Chats). */}
        <TeamSwitcher size="phone" />
        <UsageBar where="phone" />
        <StopAllButton always className="h-11" />
        <nav aria-label="Meer" className="overflow-hidden rounded-card border border-line bg-surface">
          {items.map((it) => (
            <Row key={it.href} it={it} />
          ))}
        </nav>
        {mode === 'server' && (
          <button onClick={logout} className={cx('flex min-h-11 w-full items-center gap-3 rounded-control px-3 py-2.5 text-start text-sm font-semibold text-danger hover:bg-danger-soft')}>
            <LogOut className="h-[18px] w-[18px]" /> Uitloggen
          </button>
        )}
      </div>
    </Page>
  );
}
