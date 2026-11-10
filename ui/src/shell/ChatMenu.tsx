import { useEffect, useRef, useState } from 'react';
import { Archive, BookmarkPlus, Bot, Copy, Download, Ellipsis, Eraser, Eye, FileJson, FileText, FolderInput, MessageSquarePlus, MoreVertical, PanelRight, Pencil, Pin, Search, Settings2, Shrink, Star, Trash2 } from 'lucide-react';
import { authUrl } from '../lib/api';
import type { Agent, Thread } from '../lib/types';
import { Button } from '../components/ui';
import { MenuHint, MenuLabel, MenuSeparator, Pop, SubmenuHeader, SubmenuRow, menuKeys, menuRow, menuRowDanger, useDismiss } from '../components/Menu';

const MENU_FOR_KEY = 'tb_chat_menu_for';

/** The bot editor links here for the bot actions: the chat with this bot opens with "Bot beheren" already open. */
export function openChatMenuFor(agentId: string) {
  try {
    sessionStorage.setItem(MENU_FOR_KEY, agentId);
  } catch {
    /* storage off: the chat opens without the menu */
  }
}

/** The first list, or one of the submenus that take its place. */
type View = 'root' | 'export' | 'more' | 'bot';

export interface ChatMenuActions {
  newChat(): void;
  find(): void;
  /** Phone: the side panel (files, changes) has no button of its own in the header. */
  openPanel(): void;
  rename(): void;
  togglePin(): void;
  compact(): void;
  saveAsSkill(): void;
  moveToFolder(): void;
  toggleArchive(): void;
  deleteThread(): void;
  togglePinBot(): void;
  duplicateBot(): void;
  archiveBot(): void;
  deleteHistory(): void;
  deleteBot(): void;
}

/**
 * "Meer opties" in the chat header. It was one list of seventeen rows that mixed the conversation and the bot; now the
 * first list holds what people use (about seven rows) under two plain headings, *Dit gesprek* and *Deze bot*, and what
 * is used rarely sits one step further: *Exporteren*, *Meer* and *Bot beheren* take the menu's place, with a row back.
 * What removes something stands last, in red, behind a line. Every row is still a plain button or link with the same
 * name as before.
 */
export function ChatMenu({
  thread,
  agent,
  desktop,
  advanced,
  shared,
  canFile,
  canDeleteHistory,
  canDeleteRoomHistory,
  act,
}: {
  thread: Thread;
  agent?: Agent;
  desktop: boolean;
  advanced: boolean;
  /** A bot someone else shares: its settings and actions are not yours. */
  shared: boolean;
  /** This chat has a row in the list that can go into a folder. */
  canFile: boolean;
  canDeleteHistory: boolean;
  canDeleteRoomHistory: boolean;
  act: ChatMenuActions;
}) {
  const [view, setView] = useState<View | null>(null);
  /** What the closing menu still shows during its exit animation. */
  const [last, setLast] = useState<View>('root');
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  /** The keyboard (or a row) opened this list: the focus goes to its first row. */
  const focusFirst = useRef(false);
  const room = thread.kind === 'room';
  const botId = room ? '' : agent?.id || '';

  const show = (v: View | null, focus = false) => {
    focusFirst.current = focus;
    if (v) setLast(v);
    setView(v);
  };
  /** A row was chosen: the menu closes, then the action runs. */
  const run = (fn: () => void) => () => {
    show(null);
    fn();
  };
  useDismiss(!!view, wrap, () => show(null), btn);
  useEffect(() => {
    if (!view || !focusFirst.current) return;
    focusFirst.current = false;
    panel.current?.querySelector<HTMLElement>('a[href], button')?.focus({ preventScroll: true });
  }, [view]);
  // From the bot editor ("Open het chatmenu"): straight to the bot's own actions.
  useEffect(() => {
    if (!botId) return;
    try {
      if (sessionStorage.getItem(MENU_FOR_KEY) !== botId) return;
      sessionStorage.removeItem(MENU_FOR_KEY);
    } catch {
      return;
    }
    setLast('bot');
    setView('bot');
  }, [botId]);

  const cur = view || last;
  return (
    <div className="relative" ref={wrap}>
      <Button
        ref={btn}
        variant="ghost"
        size="icon"
        className="tb-tip tb-tip-end aria-expanded:bg-surface-3 aria-expanded:text-fg"
        aria-label="Meer opties"
        aria-haspopup="true"
        aria-expanded={!!view}
        onClick={() => show(view ? null : 'root')}
        onKeyDown={(e) => e.key === 'ArrowDown' && !view && (e.preventDefault(), show('root', true))}
      >
        <MoreVertical className="size-icon" />
      </Button>
      <Pop
        ref={panel}
        open={!!view}
        origin="top right"
        className="absolute end-0 top-full z-30 mt-1 w-64 p-1.5"
        onKeyDown={(e) => {
          menuKeys(e);
          // Left arrow: back out of a submenu, as the right arrow opened it.
          if (e.key === 'ArrowLeft' && view && view !== 'root') (e.preventDefault(), show('root', true));
        }}
      >
        <div key={cur} className="tb-swap" data-from={cur === 'root' ? 'back' : undefined}>
          {cur === 'root' && (
            <>
              <MenuLabel>Dit gesprek</MenuLabel>
              {agent && !room && (
                <button className={menuRow} onClick={run(act.newChat)}>
                  <MessageSquarePlus aria-hidden /> Nieuw gesprek
                </button>
              )}
              <button className={menuRow} onClick={run(act.find)}>
                <Search aria-hidden /> Zoeken in dit gesprek
                {desktop && <MenuHint>Ctrl+F</MenuHint>}
              </button>
              {!desktop && (
                <button className={menuRow} onClick={run(act.openPanel)}>
                  <PanelRight aria-hidden /> {advanced ? 'Activiteit, bestanden en details' : 'Bestanden en wijzigingen'}
                </button>
              )}
              <SubmenuRow icon={<Download aria-hidden />} onOpen={() => show('export', true)}>
                Exporteren
              </SubmenuRow>
              <SubmenuRow icon={<Ellipsis aria-hidden />} onOpen={() => show('more', true)}>
                Meer acties
              </SubmenuRow>
              {agent && !shared && (
                <>
                  <MenuLabel>{room ? 'Bot van deze groep' : 'Deze bot'}</MenuLabel>
                  <a className={menuRow} href={`#/agents/${agent.id}`} onClick={() => show(null)}>
                    <Settings2 aria-hidden /> Bot-instellingen
                  </a>
                  {!room && (
                    <>
                      <a className={menuRow} href={`#/m/seen/${agent.id}`} onClick={() => show(null)} title="Bestanden, webpagina's, opdrachten, apps en goedkeuringen van deze bot">
                        <Eye aria-hidden />
                        <span className="min-w-0 truncate">Wat {agent.name} zag en deed</span>
                      </a>
                      <SubmenuRow icon={<Bot aria-hidden />} onOpen={() => show('bot', true)}>
                        Bot beheren
                      </SubmenuRow>
                    </>
                  )}
                </>
              )}
              <MenuSeparator />
              {canDeleteRoomHistory && (
                <button className={menuRowDanger} onClick={run(act.deleteHistory)} title="Alle gesprekken van deze groep wissen; de groep, de bots en de taken blijven">
                  <Eraser aria-hidden /> Geschiedenis van de groep wissen…
                </button>
              )}
              <button className={menuRowDanger} onClick={run(act.deleteThread)}>
                <Trash2 aria-hidden /> Gesprek verwijderen
              </button>
            </>
          )}
          {cur === 'export' && (
            <>
              <SubmenuHeader onBack={() => show('root', true)}>Exporteren</SubmenuHeader>
              <a className={menuRow} href={authUrl(`/threads/${thread.id}/export?format=md`)} onClick={() => show(null)} title="Leesbaar bestand met berichten, stappen en bijlagenamen">
                <FileText aria-hidden /> Exporteren als Markdown
              </a>
              <a className={menuRow} href={authUrl(`/threads/${thread.id}/export?format=json`)} onClick={() => show(null)} title="Volledig bestand voor andere programma's (berichten, stappen, versies); zonder sleutels">
                <FileJson aria-hidden /> Exporteren als JSON
              </a>
            </>
          )}
          {cur === 'more' && (
            <>
              <SubmenuHeader onBack={() => show('root', true)}>Meer acties</SubmenuHeader>
              <button className={menuRow} onClick={run(act.rename)}>
                <Pencil aria-hidden /> Naam van gesprek wijzigen
              </button>
              <button className={menuRow} onClick={run(act.togglePin)}>
                <Pin aria-hidden /> {thread.pinned ? 'Gesprek losmaken' : 'Gesprek vastpinnen'}
              </button>
              {thread.agent_id && (
                <button className={menuRow} onClick={run(act.compact)} title="Vat het oudere deel samen zodat de bot het overzicht houdt; originele berichten blijven bewaard">
                  <Shrink aria-hidden /> Gesprek samenvatten
                </button>
              )}
              <button className={menuRow} onClick={run(act.saveAsSkill)} title="Maak van wat hier lukte een werkwijze die de bot opnieuw kan gebruiken">
                <BookmarkPlus aria-hidden /> Bewaar als skill…
              </button>
              {canFile && (
                <button className={menuRow} onClick={run(act.moveToFolder)} title="Zet deze chat in een map in je lijst">
                  <FolderInput aria-hidden /> Verplaats naar map…
                </button>
              )}
              <button className={menuRow} onClick={run(act.toggleArchive)}>
                <Archive aria-hidden /> {thread.archived ? 'Uit archief halen' : 'Archiveren'}
              </button>
            </>
          )}
          {cur === 'bot' && agent && (
            <>
              <SubmenuHeader onBack={() => show('root', true)}>Bot beheren</SubmenuHeader>
              <button className={menuRow} onClick={run(act.togglePinBot)}>
                <Star aria-hidden /> {agent.pinned ? 'Niet meer vastzetten' : 'Bot vastzetten (bovenaan)'}
              </button>
              <button className={menuRow} onClick={run(act.duplicateBot)} title="Nieuwe bot met dezelfde instellingen; gesprekken en geheugen gaan niet mee">
                <Copy aria-hidden /> Bot dupliceren
              </button>
              <button className={menuRow} onClick={run(act.archiveBot)}>
                <Archive aria-hidden /> {agent.archived ? 'Bot uit archief halen' : 'Bot archiveren'}
              </button>
              <MenuSeparator />
              {canDeleteHistory && (
                <button className={menuRowDanger} onClick={run(act.deleteHistory)} title="Alle gesprekken met deze bot wissen; de bot, zijn geheugen en routines blijven">
                  <Eraser aria-hidden /> Geschiedenis wissen…
                </button>
              )}
              <button className={menuRowDanger} onClick={run(act.deleteBot)}>
                <Trash2 aria-hidden /> Bot verwijderen…
              </button>
            </>
          )}
        </div>
      </Pop>
    </div>
  );
}
