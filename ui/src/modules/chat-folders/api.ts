import { create } from 'zustand';
import { api, on } from '../../lib/api';
import { toastError } from '../../components/ui';

/**
 * Mappen voor chats (PARITEIT 4.2, server module chat-folders): the owner's folders in the chat list, per team, with the
 * bots and groups filed in them. One shared store, loaded after login and kept live (`chatFolders.changed`, from every
 * window and the paired phone). Pure helpers (`foldersInView`, `folderOf`, `fitsFolder`) are unit-tested.
 */

export type ChatKind = 'agent' | 'room';
export interface ChatItem {
  kind: ChatKind;
  id: string;
}
export interface ChatFolder {
  id: string;
  teamId: string | null;
  name: string;
  sort: number;
  collapsed: boolean;
  items: ChatItem[];
}

interface State {
  folders: ChatFolder[];
  loaded: boolean;
  failed: boolean;
}

export const useChatFolders = create<State>(() => ({ folders: [], loaded: false, failed: false }));

export const itemKey = (kind: ChatKind, id: string) => `${kind}:${id}`;

/** The folders the chat list shows: all with "Alle teams" (''), else those of the chosen team (and without a team). */
export function foldersInView(folders: ChatFolder[], team: string): ChatFolder[] {
  return team ? folders.filter((f) => !f.teamId || f.teamId === team) : folders;
}

/** Chat key → folder id, for the given folders. */
export function folderOf(folders: ChatFolder[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of folders) for (const it of f.items) m.set(itemKey(it.kind, it.id), f.id);
  return m;
}

/** May a chat with these teams go into this folder? [] = no known team: every folder (the server checks the same). */
export function fitsFolder(folder: Pick<ChatFolder, 'teamId'>, teams: string[]): boolean {
  return !folder.teamId || !teams.length || teams.includes(folder.teamId);
}

let inflight: Promise<void> | null = null;
export function loadChatFolders(): Promise<void> {
  if (inflight) return inflight;
  inflight = api
    .get<{ folders: ChatFolder[] }>('/chat-folders')
    .then((r) => useChatFolders.setState({ folders: Array.isArray(r?.folders) ? r.folders : [], loaded: true, failed: false }))
    .catch(() => useChatFolders.setState({ loaded: true, failed: true }))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

const patchLocal = (id: string, patch: Partial<ChatFolder>) => useChatFolders.setState((s) => ({ folders: s.folders.map((f) => (f.id === id ? { ...f, ...patch } : f)) }));

/** A new folder; with `item` that chat moves in at once. Resolves to the folder, or null when it failed (toast shown). */
export async function createFolder(name: string, o: { teamId?: string; item?: ChatItem } = {}): Promise<ChatFolder | null> {
  try {
    const f = await api.post<ChatFolder>('/chat-folders', { name, ...(o.teamId ? { teamId: o.teamId } : {}), ...(o.item ? { item: o.item } : {}) });
    await loadChatFolders();
    return f;
  } catch (e) {
    toastError(e);
    return null;
  }
}

export async function renameFolder(id: string, name: string): Promise<boolean> {
  try {
    const f = await api.patch<ChatFolder>(`/chat-folders/${id}`, { name });
    patchLocal(id, { name: f.name });
    return true;
  } catch (e) {
    toastError(e);
    return false;
  }
}

/** Open or close a folder (remembered on the server, so on every device). */
export function setCollapsed(id: string, collapsed: boolean) {
  patchLocal(id, { collapsed });
  api.patch(`/chat-folders/${id}`, { collapsed }).catch((e) => {
    patchLocal(id, { collapsed: !collapsed });
    toastError(e);
  });
}

export async function deleteFolder(id: string) {
  try {
    await api.del(`/chat-folders/${id}`);
    useChatFolders.setState((s) => ({ folders: s.folders.filter((f) => f.id !== id) }));
  } catch (e) {
    toastError(e);
  }
}

/** Put a chat in a folder, or take it out (`folderId` null). Optimistic; the server has the last word. */
export async function moveChat(item: ChatItem, folderId: string | null): Promise<boolean> {
  const before = useChatFolders.getState().folders;
  useChatFolders.setState({
    folders: before.map((f) => {
      const items = f.items.filter((x) => !(x.kind === item.kind && x.id === item.id));
      return { ...f, items: f.id === folderId ? [...items, item] : items };
    }),
  });
  try {
    await api.put('/chat-folders/items', { ...item, folderId });
    return true;
  } catch (e) {
    useChatFolders.setState({ folders: before });
    toastError(e);
    return false;
  }
}

/** Live after login: other windows and the phone change folders too; a removed team takes its folders along. */
export function wireChatFolders(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const soon = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void loadChatFolders(), 150);
  };
  const offs = [on('chatFolders.changed', soon), on('teams.changed', soon), on('ws.status', (d) => d?.connected && soon())];
  void loadChatFolders();
  return () => {
    if (timer) clearTimeout(timer);
    offs.forEach((f) => f());
  };
}

// ---- drag and drop (desktop; on a phone the chat menu does the same) ----

export const DRAG_TYPE = 'application/x-teambot-chat';
/** The chat being dragged right now (dragover cannot read the data, only its type). */
let dragging: (ChatItem & { from: string | null }) | null = null;
export const dragState = {
  start(item: ChatItem, from: string | null) {
    dragging = { ...item, from };
  },
  end() {
    dragging = null;
  },
  get current() {
    return dragging;
  },
};
