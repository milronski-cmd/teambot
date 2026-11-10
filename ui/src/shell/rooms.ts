import { useEffect } from 'react';
import { create } from 'zustand';
import { api, on } from '../lib/api';

/** The bits of a group (room) the chat list needs: name, its conversation, the member bots' faces, last message. */
export interface RoomSummary {
  id: string;
  thread_id: string;
  name: string;
  archived: boolean;
  status: 'active' | 'paused';
  bots: { agentId: string; name: string; avatar: string }[];
  last: { content: string; author_name: string; created_at: string } | null;
  updated_at: string;
}

const useRoomStore = create<{ rooms: RoomSummary[]; loaded: boolean }>(() => ({ rooms: [], loaded: false }));
let subscribed = 0;
let off: (() => void) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function load() {
  api
    .get<RoomSummary[]>('/rooms')
    .then((rooms) => useRoomStore.setState({ rooms: Array.isArray(rooms) ? rooms : [], loaded: true }))
    .catch(() => useRoomStore.setState({ loaded: true })); // groups module off or no access: just no groups in the list
}
function soon() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(load, 250);
}

/** Groups for the chat list; one shared fetch, refreshed on room changes and new room messages. */
export function useRoomList(): RoomSummary[] {
  useEffect(() => {
    if (subscribed++ === 0) {
      load();
      const a = on('rooms.changed', soon);
      const b = on('message.created', (m: { thread_id: string }) => {
        if (useRoomStore.getState().rooms.some((r) => r.thread_id === m.thread_id)) soon();
      });
      off = () => (a(), b());
    }
    return () => {
      if (--subscribed === 0) {
        off?.();
        off = null;
      }
    };
  }, []);
  return useRoomStore((s) => s.rooms);
}
