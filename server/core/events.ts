import { now } from './db.js';
import { stripRefs } from './plain.js';

export interface TBEvent {
  type: string;
  /** Target user id, or '*' for every connected user. */
  userId: string;
  data: any;
  ts: string;
}

type Listener = (e: TBEvent) => void;

/**
 * In-process event bus. The websocket layer forwards events to the clients of
 * the target user; modules (channels, notifications, rooms) can subscribe too.
 */
export class EventBus {
  private listeners = new Set<Listener>();

  emit(userId: string, type: string, data: any) {
    // Notifications (desktop, phone push, notification centre) show plain text: no memory codes like [m:2tdmcj].
    if (type === 'notification' && data && typeof data === 'object') {
      data = { ...data };
      if (typeof data.title === 'string') data.title = stripRefs(data.title);
      if (typeof data.body === 'string') data.body = stripRefs(data.body);
    }
    const e: TBEvent = { type, userId, data, ts: now() };
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err) {
        console.error('[events] listener failed', err);
      }
    }
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Subscribe to one event type. */
  on(type: string, fn: (e: TBEvent) => void): () => void {
    return this.subscribe((e) => {
      if (e.type === type) fn(e);
    });
  }
}
