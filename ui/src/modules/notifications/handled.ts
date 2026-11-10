/**
 * PARITEIT 15.1 (browser and phone app): a notification for an approval or a question goes away once it is handled
 * elsewhere (another window, the desktop app, the paired phone), instead of staying on screen for something that is
 * already done. Phone pushes carry the tag `apr-<id>` (server/modules/mobile/push.ts) and so do the page's own web
 * notifications. A push closes them while the app is closed (the service worker, `ui/public/sw.js`); the page closes
 * them as soon as it hears the decision, and when it opens again (Apple sends no close pushes).
 */

export interface ClosableNote {
  tag?: string;
  close(): void;
}

export interface NoteRegistration {
  getNotifications(filter?: { tag?: string }): Promise<ClosableNote[]>;
}

export const approvalTag = (id: string) => `apr-${String(id).slice(0, 40)}`;

/** The approval id in a notification tag, or null for any other notification. */
export function approvalIdOfTag(tag: unknown): string | null {
  return typeof tag === 'string' ? /^apr-([\w-]{1,40})$/.exec(tag)?.[1] || null : null;
}

/** The approval a notification item is about (`ref` is `apr:<id>` on the server). */
export function approvalIdOfItem(item: { ref?: string | null } | null | undefined): string | null {
  const m = /^apr:([\w-]{1,60})$/.exec(item?.ref || '');
  return m ? m[1] : null;
}

/**
 * Close the notifications that are about handled approvals: the one approval `handled`, or with `pending` every
 * approval notification whose approval is no longer waiting. Other notifications are never touched.
 */
export function closeHandled(notes: Iterable<ClosableNote>, o: { handled?: string; pending?: ReadonlySet<string> }): number {
  let n = 0;
  for (const x of notes) {
    if (!isHandled(x?.tag, o)) continue;
    try {
      x.close();
      n++;
    } catch {
      /* already gone */
    }
  }
  return n;
}

function isHandled(tag: unknown, o: { handled?: string; pending?: ReadonlySet<string> }): boolean {
  const id = approvalIdOfTag(tag);
  if (!id) return false;
  return o.handled !== undefined ? id === String(o.handled).slice(0, 40) : !!o.pending && !o.pending.has(id);
}

/** The page's own (non-persistent) web notifications: the service worker's list does not include them. */
export class PageNotes {
  private open = new Set<ClosableNote>();
  add(n: ClosableNote) {
    this.open.add(n);
    if (this.open.size > 50) this.open.delete(this.open.values().next().value!);
  }
  forget(n: ClosableNote) {
    this.open.delete(n);
  }
  close(o: { handled?: string; pending?: ReadonlySet<string> }): number {
    const hit = [...this.open].filter((x) => isHandled(x.tag, o));
    for (const x of hit) this.open.delete(x);
    return closeHandled(hit, o);
  }
  get size() {
    return this.open.size;
  }
}

/** Close handled approval notifications shown by the service worker (pushes) and by the page itself. */
export async function closeHandledEverywhere(reg: NoteRegistration | null | undefined, page: PageNotes, o: { handled?: string; pending?: ReadonlySet<string> }): Promise<number> {
  let n = page.close(o);
  if (!reg) return n;
  try {
    const list = await reg.getNotifications(o.handled !== undefined ? { tag: approvalTag(o.handled) } : undefined);
    n += closeHandled(list, o);
  } catch {
    /* no notification support here */
  }
  return n;
}
