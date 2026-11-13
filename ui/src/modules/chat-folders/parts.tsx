import React, { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Folder, FolderMinus, FolderOpen, FolderPlus, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { Button, Input, Modal, Spinner, askConfirm, cx, toast } from '../../components/ui';
import { t } from '../../lib/i18n';
import { useDismiss } from '../../components/Menu';
import { useTeamView } from '../teams/scope';
import { DRAG_TYPE, createFolder, deleteFolder, dragState, fitsFolder, folderOf, foldersInView, itemKey, loadChatFolders, moveChat, renameFolder, setCollapsed, useChatFolders, type ChatFolder, type ChatItem, type ChatKind } from './api';

/**
 * The chat list with folders (PARITEIT 4.2). The chat list (shell/ChatList.tsx) renders its rows; this puts them in the
 * folders of the team in view (collapsible, remembered on the server) and lets you drag a row onto a folder, or out of
 * it onto the list. On a phone (no drag by touch) and from the keyboard the chat menu's "Verplaats naar map…" does the
 * same (MoveToFolderDialog).
 */

export interface ListRow {
  kind: ChatKind;
  id: string;
  node: React.ReactNode;
}

const readDrag = (e: React.DragEvent): ChatItem | null => {
  const raw = e.dataTransfer.getData(DRAG_TYPE);
  const m = /^(agent|room):(.+)$/.exec(raw);
  return m ? { kind: m[1] as ChatKind, id: m[2] } : dragState.current;
};
const isChatDrag = (e: React.DragEvent) => Array.from(e.dataTransfer.types || []).includes(DRAG_TYPE);

function DraggableRow({ row, from, onDrag }: { row: ListRow; from: string | null; onDrag(from: string | null | undefined): void }) {
  return (
    <li
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, itemKey(row.kind, row.id));
        e.dataTransfer.effectAllowed = 'move';
        dragState.start({ kind: row.kind, id: row.id }, from);
        onDrag(from);
      }}
      onDragEnd={() => {
        dragState.end();
        onDrag(undefined);
      }}
    >
      {row.node}
    </li>
  );
}

/** Drop handlers with a highlight while a chat is held above it. */
function useDropZone(onItem: (item: ChatItem) => void) {
  const [over, setOver] = useState(false);
  const props = {
    onDragOver(e: React.DragEvent) {
      if (!isChatDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (!over) setOver(true);
    },
    onDragLeave(e: React.DragEvent) {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
    },
    onDrop(e: React.DragEvent) {
      if (!isChatDrag(e)) return;
      e.preventDefault();
      setOver(false);
      const item = readDrag(e);
      dragState.end();
      if (item) onItem(item);
    },
  };
  return { over, props };
}

function FolderMenu({ folder }: { folder: ChatFolder }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, ref, () => setOpen(false));
  const save = async () => {
    if (name !== null && name.trim() && (await renameFolder(folder.id, name.trim()))) setName(null);
  };
  const item = 'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-start text-sm hover:bg-surface-2 coarse:py-3';
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className="flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg coarse:h-11 coarse:w-11"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={t('Opties voor de map {0}', folder.name)}
        onClick={() => setOpen(!open)}
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden />
      </button>
      {open && (
        <div className="absolute end-0 top-8 z-30 w-56 rounded-2xl border border-line bg-surface p-1.5 shadow-2xl coarse:top-12" role="menu">
          <button type="button" role="menuitem" className={item} onClick={() => (setOpen(false), setName(folder.name))}>
            <Pencil className="h-4 w-4 shrink-0" aria-hidden /> Naam wijzigen…
          </button>
          <button
            type="button"
            role="menuitem"
            className={cx(item, 'text-danger hover:bg-danger-soft')}
            onClick={async () => {
              setOpen(false);
              if (await askConfirm(t('Map “{0}” verwijderen? De chats erin gaan terug naar de lijst. Er wordt niets gewist.', folder.name), { ok: 'Map verwijderen' })) void deleteFolder(folder.id);
            }}
          >
            <Trash2 className="h-4 w-4 shrink-0" aria-hidden /> Map verwijderen…
          </button>
        </div>
      )}
      <Modal
        open={name !== null}
        onClose={() => setName(null)}
        title="Naam van de map"
        footer={
          <Button variant="primary" onClick={save} disabled={!name?.trim()}>
            Opslaan
          </Button>
        }
      >
        <Input value={name || ''} onChange={(e) => setName(e.target.value)} autoFocus maxLength={60} aria-label="Naam van de map" onKeyDown={(e) => e.key === 'Enter' && void save()} />
      </Modal>
    </div>
  );
}

function FolderBlock({ folder, rows, size, onDrag }: { folder: ChatFolder; rows: ListRow[]; size: 'desk' | 'phone'; onDrag(from: string | null | undefined): void }) {
  const bodyId = useId();
  const { over, props } = useDropZone((item) => {
    if (!folder.items.some((x) => x.kind === item.kind && x.id === item.id)) void moveChat(item, folder.id);
  });
  const open = !folder.collapsed;
  const Icon = open ? FolderOpen : Folder;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div {...props} role="group" data-testid="chat-folder" data-folder={folder.name} aria-label={t('Map {0}', folder.name)} className={cx('rounded-xl transition-colors', over && 'bg-accent-soft ring-2 ring-accent')}>
      <div className="flex items-center gap-0.5 pe-0.5">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setCollapsed(folder.id, open)}
          className={cx('flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-start hover:bg-surface-2 coarse:min-h-11', size === 'phone' ? 'py-2.5' : 'py-1.5')}
        >
          <Chevron className={cx('h-4 w-4 shrink-0 text-muted', !open && 'rtl-flip')} aria-hidden />
          <Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden />
          <span className={cx('min-w-0 truncate font-semibold', size === 'phone' ? 'text-[15px]' : 'text-[13.5px]')} translate="no">
            {folder.name}
          </span>
          <span className="ms-auto shrink-0 text-xs tabular-nums text-muted">
            <span aria-hidden>{rows.length}</span>
            <span className="sr-only">{t('{0, plural, one {# chat} other {# chats}}', rows.length)}</span>
          </span>
        </button>
        <FolderMenu folder={folder} />
      </div>
      {open && (
        <div id={bodyId}>
          {rows.length ? (
            <ul className="space-y-0.5 ps-3">
              {rows.map((r) => (
                <DraggableRow key={itemKey(r.kind, r.id)} row={r} from={folder.id} onDrag={onDrag} />
              ))}
            </ul>
          ) : (
            <p className="px-3 pb-2 pt-0.5 text-xs leading-relaxed text-muted">{size === 'phone' ? 'Nog leeg. Kies in een chat Verplaats naar map.' : 'Nog leeg. Sleep een chat hierheen, of kies in een chat Verplaats naar map.'}</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The rows of the chat list, in the folders of the team in view and then the rest. While searching (`flat`) or without
 * folders it is the plain list, as before.
 */
export function FolderedList({ rows, size, flat }: { rows: ListRow[]; size: 'desk' | 'phone'; flat: boolean }) {
  const all = useChatFolders((s) => s.folders);
  const team = useTeamView().activeId;
  const [dragFrom, setDragFrom] = useState<string | null | undefined>(undefined);
  const folders = flat ? [] : foldersInView(all, team);
  const where = folderOf(folders);
  const loose = useDropZone((item) => {
    if (where.has(itemKey(item.kind, item.id))) void moveChat(item, null);
  });
  const inFolder = new Map<string, ListRow[]>();
  const rest: ListRow[] = [];
  for (const r of rows) {
    const f = where.get(itemKey(r.kind, r.id));
    if (f) inFolder.set(f, [...(inFolder.get(f) || []), r]);
    else rest.push(r);
  }
  const looseList = (
    <ul className="space-y-0.5" aria-label="Bots en groepen">
      {rest.map((r) => (
        <DraggableRow key={itemKey(r.kind, r.id)} row={r} from={null} onDrag={setDragFrom} />
      ))}
    </ul>
  );
  if (!folders.length) return rows.length ? looseList : null;
  return (
    <div className="space-y-1">
      {folders.map((f) => (
        <FolderBlock key={f.id} folder={f} rows={inFolder.get(f.id) || []} size={size} onDrag={setDragFrom} />
      ))}
      <div {...loose.props} data-testid="chat-list-loose" className={cx('rounded-xl transition-colors', loose.over && 'bg-accent-soft ring-2 ring-accent')}>
        {rest.length > 0 && looseList}
        {typeof dragFrom === 'string' && <p className="rounded-xl border border-dashed border-line px-3 py-3 text-center text-xs text-muted">Laat hier los om de chat uit de map te halen</p>}
      </div>
    </div>
  );
}

/** "Nieuwe map…" from the list's own menu: a folder in the team in view (the default team with Alle teams). */
export function NewFolderDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const team = useTeamView().activeId;
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setName('');
  }, [open]);
  const make = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const f = await createFolder(name.trim(), team ? { teamId: team } : {});
    setBusy(false);
    if (f) {
      toast(t('Map {0} gemaakt. Sleep er een chat in, of kies in een chat Verplaats naar map.', f.name), 'ok');
      onClose();
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Nieuwe map"
      footer={
        <Button variant="primary" onClick={make} loading={busy} disabled={!name.trim()}>
          Map maken
        </Button>
      }
    >
      <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={60} placeholder="Bijvoorbeeld Klanten" aria-label="Naam van de nieuwe map" onKeyDown={(e) => e.key === 'Enter' && void make()} />
    </Modal>
  );
}

/**
 * "Verplaats naar map…" in a chat's menu: the folders this chat may go into (its own team's), "Uit map halen", and a
 * new folder made for it. `teams`: the chat's teams as far as the page knows ([] = none known); the server checks.
 */
export function MoveToFolderDialog({ item, name, teams, open, onClose }: { item: ChatItem; name: string; teams: string[]; open: boolean; onClose(): void }) {
  const { folders, loaded, failed } = useChatFolders();
  const [fresh, setFresh] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setFresh('');
    if (!loaded || failed) void loadChatFolders();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const fit = folders.filter((f) => fitsFolder(f, teams));
  const current = folderOf(folders).get(itemKey(item.kind, item.id)) || null;
  const go = async (folderId: string | null, label: string) => {
    if (busy) return;
    setBusy(true);
    const ok = await moveChat(item, folderId);
    setBusy(false);
    if (ok) {
      if (folderId) toast(t('{0} staat nu in de map {1}.', name, label), 'ok');
      else toast(t('{0} staat weer gewoon in de lijst.', name), 'ok');
      onClose();
    }
  };
  const make = async () => {
    if (!fresh.trim() || busy) return;
    setBusy(true);
    const f = await createFolder(fresh.trim(), { item });
    setBusy(false);
    if (f) {
      toast(t('{0} staat nu in de map {1}.', name, f.name), 'ok');
      onClose();
    }
  };
  const row = 'flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-start text-sm hover:bg-surface-2 disabled:opacity-60 coarse:py-3';
  return (
    <Modal open={open} onClose={onClose} title={<span>{t('{0} verplaatsen naar een map', name)}</span>}>
      <div className="space-y-3" data-testid="move-to-folder">
        <p className="text-[13px] leading-relaxed text-muted">Een map houdt je lijst met chats overzichtelijk. Aan het gesprek zelf verandert niets.</p>
        {!loaded ? (
          <div className="flex justify-center py-3">
            <Spinner />
          </div>
        ) : failed ? (
          <div className="flex items-center justify-between gap-2 rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger">
            De mappen konden niet geladen worden.
            <Button size="sm" onClick={() => void loadChatFolders()}>
              Opnieuw
            </Button>
          </div>
        ) : fit.length ? (
          <ul className="space-y-0.5" aria-label="Mappen">
            {fit.map((f) => (
              <li key={f.id}>
                <button type="button" className={row} disabled={busy} aria-current={current === f.id ? 'true' : undefined} onClick={() => (current === f.id ? onClose() : void go(f.id, f.name))}>
                  {current === f.id ? <FolderOpen className="h-4 w-4 shrink-0 text-accent" aria-hidden /> : <Folder className="h-4 w-4 shrink-0 text-muted" aria-hidden />}
                  <span className="min-w-0 flex-1 truncate font-medium" translate="no">
                    {f.name}
                  </span>
                  {current === f.id && (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-muted">
                      <Check className="h-3.5 w-3.5" aria-hidden /> Staat hier
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">Nog geen mappen in dit team. Maak hieronder de eerste.</p>
        )}
        {current && (
          <button type="button" className={row} disabled={busy} onClick={() => void go(null, '')}>
            <FolderMinus className="h-4 w-4 shrink-0 text-muted" aria-hidden /> Uit map halen
          </button>
        )}
        <div className="border-t border-line pt-3">
          <label className="mb-1.5 block text-[13px] font-semibold" htmlFor="tb-new-chat-folder">
            Nieuwe map
          </label>
          <div className="flex gap-2">
            <Input id="tb-new-chat-folder" value={fresh} onChange={(e) => setFresh(e.target.value)} maxLength={60} placeholder="Naam van de nieuwe map" onKeyDown={(e) => e.key === 'Enter' && void make()} />
            <Button variant="primary" icon={<FolderPlus className="h-4 w-4" />} onClick={make} loading={busy} disabled={!fresh.trim()}>
              Maken
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
