import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronsUpDown, Plus, Settings2 } from 'lucide-react';
import { cx } from '../components/ui';
import { MenuSeparator, Pop, menuRow } from '../components/Menu';
import { t } from '../lib/i18n';
import { moduleById } from '../modules';
import { NewTeamModal } from '../modules/teams/TeamsPage';
import { loadTeams, setActiveTeam, useTeamView } from '../modules/teams/scope';
import { AllTeamsDots as AllDots, TeamDot } from './TeamDot';

/** The overview of all teams (package C2: #/m/teams/alle), when this app has it. */
const OVERVIEW = '#/m/teams/alle';
const hasOverview = () => !!moduleById('teams')?.pages?.some((p) => p.path === 'alle');

/**
 * The team switcher (0.4, package A): hidden while there is one team; from the second team on a calm button at the top
 * of the sidebar (and on the phone's Chats and Meer) with the colour and name of the team you look at. Its menu:
 * *Alle teams*, every team, *Nieuw team* and *Teams beheren*. The choice is kept on this device and filters the chat list
 * and the task board (and every page that uses ../modules/teams/scope). *Alle teams* also opens the overview of all
 * teams when the app has one (package C2).
 */
export function TeamSwitcher({ size = 'desk', className, onNavigate }: { size?: 'desk' | 'phone'; className?: string; onNavigate?(): void }) {
  const { teams, multi, active } = useTeamView();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') || [])];
  const close = (focus = true) => {
    setOpen(false);
    if (focus) btn.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    // Focus the current choice (or the first item) when the menu opens.
    const list = items();
    (list.find((el) => el.getAttribute('aria-checked') === 'true') || list[0])?.focus();
    const away = (e: MouseEvent) => wrap.current && !wrap.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  if (!multi) return null;

  const choose = (id: string) => {
    setActiveTeam(id);
    close();
    if (!id && hasOverview()) {
      location.hash = OVERVIEW;
      onNavigate?.();
    }
  };
  const onMenuKey = (e: React.KeyboardEvent) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    const to = (n: number) => (e.preventDefault(), list[(n + list.length) % list.length]?.focus());
    if (e.key === 'ArrowDown') to(i + 1);
    else if (e.key === 'ArrowUp') to(i - 1);
    else if (e.key === 'Home') to(0);
    else if (e.key === 'End') to(list.length - 1);
    else if (e.key === 'Escape') (e.preventDefault(), close());
    else if (e.key === 'Tab') setOpen(false);
  };
  const phone = size === 'phone';
  const item = cx(phone ? menuRow.replace('min-h-9', 'min-h-11') : menuRow, 'gap-2.5 font-normal');
  const manage = active ? `#/m/teams/${active.id}` : '#/settings/teams-teams';

  return (
    <div ref={wrap} className={cx('relative', className)} data-testid="team-switcher">
      <button
        ref={btn}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title="Kies een team"
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') (e.preventDefault(), setOpen(true));
        }}
        className={cx(
          'flex w-full min-w-0 items-center rounded-control text-start font-semibold transition-colors',
          // The sidebar's header row: quiet, like the app name it stands in for; the phone keeps the bordered field.
          // Tight padding: "Alle teams" has to fit next to the three header buttons without being cut off.
          phone ? 'h-11 gap-2.5 border border-line bg-surface-2 px-2.5 text-[15px] hover:bg-surface-3' : 'h-9 gap-1.5 px-1.5 text-sm hover:bg-surface-2 aria-expanded:bg-surface-2 coarse:h-11',
        )}
      >
        {active ? <TeamDot color={active.color} size={phone ? 12 : 10} /> : <AllDots teams={teams} size={phone ? 12 : 10} />}
        <span className="min-w-0 flex-1 truncate" translate={active ? 'no' : undefined}>
          <span className="sr-only">Team: </span>
          {active ? active.name : 'Alle teams'}
        </span>
        <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted" aria-hidden />
      </button>
      <Pop open={open} ref={menu} id={menuId} role="menu" aria-label="Teams" onKeyDown={onMenuKey} className={cx('scroll-thin absolute start-0 top-full z-40 mt-1 max-h-[70vh] overflow-y-auto p-1.5', phone ? 'end-0' : 'w-60')}>
          <button type="button" role="menuitemradio" aria-checked={!active} tabIndex={-1} className={item} onClick={() => choose('')}>
            <span className="flex w-[26px] shrink-0 justify-center">
              <AllDots teams={teams} />
            </span>
            <span className="min-w-0 flex-1 truncate font-medium">Alle teams</span>
            {!active && <Check className="h-4 w-4 shrink-0" aria-hidden />}
          </button>
          {teams.map((x) => (
            <button key={x.id} type="button" role="menuitemradio" aria-checked={active?.id === x.id} tabIndex={-1} className={item} onClick={() => choose(x.id)}>
              <span className="flex w-[26px] shrink-0 justify-center">
                <TeamDot color={x.color} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium" translate="no">
                  {x.name}
                </span>
                <span className="block text-xs text-muted">{t('{0, plural, one {# bot} other {# bots}}', x.bots.length)}</span>
              </span>
              {active?.id === x.id && <Check className="h-4 w-4 shrink-0" aria-hidden />}
            </button>
          ))}
          <MenuSeparator />
          <button type="button" role="menuitem" tabIndex={-1} className={item} onClick={() => (setOpen(false), setCreating(true))}>
            <span className="flex w-[26px] shrink-0 justify-center">
              <Plus className="h-4 w-4" aria-hidden />
            </span>
            <span className="min-w-0 flex-1 font-medium">Nieuw team</span>
          </button>
          <a role="menuitem" tabIndex={-1} href={manage} className={item} onClick={() => (setOpen(false), onNavigate?.())}>
            <span className="flex w-[26px] shrink-0 justify-center">
              <Settings2 className="h-4 w-4" aria-hidden />
            </span>
            <span className="min-w-0 flex-1 font-medium">Teams beheren</span>
          </a>
      </Pop>
      <NewTeamModal
        open={creating}
        count={teams.length}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          // The new (empty) team is the one you look at, so a new bot lands in it.
          setActiveTeam(id);
          void loadTeams();
        }}
      />
    </div>
  );
}
