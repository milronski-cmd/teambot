/**
 * Windows notifications that wait for the owner (an approval or a question). When it is decided anywhere else — on the
 * paired phone, in another window, in the app itself — its notification is taken away, so Windows does not keep
 * offering buttons for something that is already done. No Electron import: the logic is tested on its own.
 */
export interface Closable {
  close(): void;
}

export class PendingNotes<N extends Closable = Closable> {
  private byApproval = new Map<string, N>();

  /** Remember the notification of a pending approval (a newer one for the same approval replaces the old one). */
  add(approvalId: string, n: N) {
    const old = this.byApproval.get(approvalId);
    if (old && old !== n) close(old);
    this.byApproval.set(approvalId, n);
  }

  /** The notification went away by itself (clicked, dismissed, failed). */
  forget(n: N) {
    for (const [k, v] of this.byApproval) if (v === n) this.byApproval.delete(k);
  }

  /** An `approval.updated` event: once it is no longer pending, its notification is closed. True when one was closed. */
  approvalUpdated(a: { id?: unknown; status?: unknown } | null | undefined): boolean {
    if (!a || typeof a.id !== 'string' || typeof a.status !== 'string' || a.status === 'pending') return false;
    const n = this.byApproval.get(a.id);
    if (!n) return false;
    this.byApproval.delete(a.id);
    close(n);
    return true;
  }

  get size() {
    return this.byApproval.size;
  }

  clear() {
    this.byApproval.clear();
  }
}

function close(n: Closable) {
  try {
    // On Windows this also removes it from the notification centre (Electron's Notification.close()).
    n.close();
  } catch {
    /* already gone */
  }
}
