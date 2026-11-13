import { useEffect, useId, useRef, useState } from 'react';
import { Bot, LayoutTemplate, MessagesSquare, Plus, Users } from 'lucide-react';
import { Modal, cx } from '../components/ui';
import { Pop, menuKeys, menuRow, useDismiss } from '../components/Menu';
import { navigate } from '../lib/router';
import { NewTeamModal } from '../modules/teams/TeamsPage';
import { loadTeams, setActiveTeam, useTeamView } from '../modules/teams/scope';
import { TeamTemplateWizard } from '../modules/templates/TeamTemplateWizard';
import { NewRoomModal } from '../modules/rooms/NewRoom';

/**
 * The "+" of the sidebar and of the phone's Chats: a small menu with *Nieuwe bot*, *Nieuw team* and *Team uit een
 * sjabloon*. Before 0.4.4 the "+" went straight to the new-bot page, so a team could only be made in Instellingen ›
 * Teams or from the team switcher, which only shows from the second team on: with one team the "+" never offered one.
 * A new team becomes the team you look at, so the next bot lands in it (as the switcher's "Nieuw team" does).
 */
export function NewMenu({ size = 'desk', onNavigate }: { size?: 'desk' | 'phone'; onNavigate?(): void }) {
  const { teams } = useTeamView();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [fromTemplate, setFromTemplate] = useState(false);
  const [groupChat, setGroupChat] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const phone = size === 'phone';

  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') || [])];
  const close = (focus = true) => {
    setOpen(false);
    if (focus) btn.current?.focus();
  };
  useEffect(() => {
    if (open) items()[0]?.focus();
  }, [open]);
  useDismiss(open, wrap, () => setOpen(false), btn);

  // Arrows, Home and End walk the rows (menuKeys); Escape and a press outside close it (useDismiss); Tab leaves it.
  const onMenuKey = (e: React.KeyboardEvent<HTMLElement>) => (menuKeys(e), e.key === 'Tab' && setOpen(false));
  const item = cx(phone ? menuRow.replace('min-h-9', 'min-h-11') : menuRow, phone && 'text-[15px]');

  return (
    <div ref={wrap} className="relative" data-testid="new-menu">
      <button
        ref={btn}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label="Nieuw"
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') (e.preventDefault(), setOpen(true));
        }}
        className={cx(
          'tb-tip tb-tip-end flex items-center justify-center text-muted transition-colors hover:bg-surface-2 hover:text-fg active:bg-surface-3',
          phone ? 'h-11 w-11 rounded-full bg-surface-2 text-fg' : 'h-9 w-9 rounded-control coarse:h-11 coarse:w-11',
          open && 'bg-surface-3 text-fg',
        )}
      >
        <Plus className="size-icon-lg" aria-hidden />
      </button>
      <Pop open={open} origin="top right" ref={menu} id={menuId} role="menu" aria-label="Nieuw" onKeyDown={onMenuKey} className="absolute end-0 top-full z-40 mt-1 w-56 p-1.5">
          <a
            role="menuitem"
            tabIndex={-1}
            href="#/agents/new"
            className={item}
            onClick={() => {
              setOpen(false);
              onNavigate?.();
            }}
          >
            <Bot aria-hidden /> Nieuwe bot
          </a>
          {/* Several bots in one conversation: it lands in the chat list like any chat. */}
          <button type="button" role="menuitem" tabIndex={-1} className={item} onClick={() => (close(false), setGroupChat(true))}>
            <MessagesSquare aria-hidden /> Nieuwe groepschat
          </button>
          <button type="button" role="menuitem" tabIndex={-1} className={item} onClick={() => (close(false), setCreating(true))}>
            <Users aria-hidden /> Nieuw team
          </button>
          <button type="button" role="menuitem" tabIndex={-1} className={item} onClick={() => (close(false), setFromTemplate(true))}>
            <LayoutTemplate aria-hidden /> Team uit een sjabloon
          </button>
      </Pop>
      <NewTeamModal
        open={creating}
        count={teams.length}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          setActiveTeam(id);
          void loadTeams();
        }}
      />
      <NewRoomModal open={groupChat} onClose={() => setGroupChat(false)} />
      <Modal open={fromTemplate} onClose={() => setFromTemplate(false)} title="Team uit een sjabloon" wide>
        {fromTemplate && <TeamTemplateWizard onCancel={() => setFromTemplate(false)} onCreated={(r) => (setFromTemplate(false), void loadTeams(), navigate(`/t/${r.threadId}`), onNavigate?.())} />}
      </Modal>
    </div>
  );
}
