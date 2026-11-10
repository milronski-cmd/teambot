/**
 * Control leases: exactly one controller (a bot run or a human) per computer resource.
 * - Bots wait in FIFO order; a human may pre-empt a bot (the bot pauses and gets it back afterwards).
 * - A lease only ends when its holder is really gone: after the TTL it expires only if `alive()` says so
 *   (or there is no liveness check). Timers alone never take control away from a live process.
 */

export interface Holder {
  kind: 'bot' | 'user';
  /** run id for bots, user id for humans */
  id: string;
  name: string;
  agentId?: string;
}

export interface Lease {
  resource: string;
  holder: Holder;
  since: number;
  expiresAt: number;
  ttlMs: number;
  alive?: () => boolean;
  /** holder that was pre-empted by a human and gets control back on release */
  suspended?: Lease | null;
}

export interface AcquireOpts {
  ttlMs?: number;
  alive?: () => boolean;
  /** humans may take control from a bot */
  preempt?: boolean;
}

type Waiter = { holder: Holder; opts: AcquireOpts; resolve: (l: Lease) => void; reject: (e: Error) => void };

export class LeaseManager {
  private leases = new Map<string, Lease>();
  private waiters = new Map<string, Waiter[]>();
  private listeners = new Set<(resource: string, lease: Lease | null) => void>();

  constructor(private clock: () => number = Date.now) {}

  onChange(fn: (resource: string, lease: Lease | null) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private changed(resource: string) {
    const l = this.leases.get(resource) || null;
    for (const fn of this.listeners) {
      try {
        fn(resource, l);
      } catch {
        /* ignore */
      }
    }
  }

  private expired(l: Lease): boolean {
    if (this.clock() < l.expiresAt) return false;
    if (!l.alive) return true;
    try {
      return !l.alive();
    } catch {
      return true;
    }
  }

  /** Current holder (drops expired leases first). */
  current(resource: string): Lease | null {
    const l = this.leases.get(resource);
    if (!l) return null;
    if (this.expired(l)) {
      this.leases.delete(resource);
      this.restoreOrNext(resource, l);
      return this.leases.get(resource) || null;
    }
    return l;
  }

  private make(resource: string, holder: Holder, opts: AcquireOpts, suspended: Lease | null = null): Lease {
    const ttl = opts.ttlMs ?? 60_000;
    return { resource, holder, since: this.clock(), expiresAt: this.clock() + ttl, ttlMs: ttl, alive: opts.alive, suspended };
  }

  private same(a: Holder, b: Holder) {
    return a.kind === b.kind && a.id === b.id;
  }

  acquire(resource: string, holder: Holder, opts: AcquireOpts = {}): { ok: true; lease: Lease } | { ok: false; holder: Holder } {
    const cur = this.current(resource);
    if (!cur) {
      const l = this.make(resource, holder, opts);
      this.leases.set(resource, l);
      this.changed(resource);
      return { ok: true, lease: l };
    }
    if (this.same(cur.holder, holder)) {
      cur.expiresAt = this.clock() + (opts.ttlMs ?? cur.ttlMs);
      if (opts.alive) cur.alive = opts.alive;
      return { ok: true, lease: cur };
    }
    if (opts.preempt && holder.kind === 'user' && cur.holder.kind === 'bot') {
      const l = this.make(resource, holder, opts, cur);
      this.leases.set(resource, l);
      this.changed(resource);
      return { ok: true, lease: l };
    }
    return { ok: false, holder: cur.holder };
  }

  renew(resource: string, holderId: string, ttlMs?: number): boolean {
    const l = this.current(resource);
    if (!l || l.holder.id !== holderId) return false;
    l.expiresAt = this.clock() + (ttlMs ?? l.ttlMs);
    return true;
  }

  release(resource: string, holderId: string): boolean {
    const l = this.leases.get(resource);
    if (!l) {
      this.dropWaiter(resource, holderId);
      return false;
    }
    if (l.holder.id !== holderId) {
      // a pre-empted bot finishing its run while a human holds control
      if (l.suspended && l.suspended.holder.id === holderId) {
        l.suspended = null;
        return true;
      }
      this.dropWaiter(resource, holderId);
      return false;
    }
    this.leases.delete(resource);
    this.restoreOrNext(resource, l);
    return true;
  }

  /** Release every lease held by a holder id (e.g. a finished run). */
  releaseHolder(holderId: string) {
    for (const r of [...this.leases.keys()]) this.release(r, holderId);
    for (const r of [...this.waiters.keys()]) this.dropWaiter(r, holderId);
  }

  private dropWaiter(resource: string, holderId: string) {
    const q = this.waiters.get(resource);
    if (!q) return;
    const rest = q.filter((w) => {
      if (w.holder.id !== holderId) return true;
      w.reject(new Error('Wachten geannuleerd'));
      return false;
    });
    if (rest.length) this.waiters.set(resource, rest);
    else this.waiters.delete(resource);
  }

  private restoreOrNext(resource: string, old: Lease) {
    const s = old.suspended;
    if (s && !(s.alive && !safe(s.alive))) {
      s.expiresAt = this.clock() + s.ttlMs;
      this.leases.set(resource, s);
      this.changed(resource);
      return;
    }
    const q = this.waiters.get(resource);
    while (q?.length) {
      const w = q.shift()!;
      if (w.opts.alive && !safe(w.opts.alive)) {
        w.reject(new Error('Houder is niet meer actief'));
        continue;
      }
      const l = this.make(resource, w.holder, w.opts);
      this.leases.set(resource, l);
      if (!q.length) this.waiters.delete(resource);
      this.changed(resource);
      w.resolve(l);
      return;
    }
    this.waiters.delete(resource);
    this.changed(resource);
  }

  /** Wait (FIFO) until the resource is free. Re-checks periodically so expired leases are noticed. */
  waitFor(resource: string, holder: Holder, o: AcquireOpts & { signal?: AbortSignal; timeoutMs?: number; onWait?: (h: Holder) => void } = {}): Promise<Lease> {
    const r = this.acquire(resource, holder, o);
    if (r.ok) return Promise.resolve(r.lease);
    o.onWait?.(r.holder);
    return new Promise<Lease>((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearTimeout(timer);
        fn();
      };
      const w: Waiter = {
        holder,
        opts: o,
        resolve: (l) => finish(() => resolve(l)),
        reject: (e) => finish(() => reject(e)),
      };
      const q = this.waiters.get(resource) || [];
      q.push(w);
      this.waiters.set(resource, q);
      const remove = () => {
        const list = this.waiters.get(resource);
        if (!list) return;
        const rest = list.filter((x) => x !== w);
        if (rest.length) this.waiters.set(resource, rest);
        else this.waiters.delete(resource);
      };
      const poll = setInterval(() => {
        // notices expiry of a dead holder even if nobody calls current()
        this.current(resource);
      }, 1000);
      poll.unref?.();
      const timer = setTimeout(() => {
        remove();
        w.reject(new Error('Wachten op de computer duurde te lang'));
      }, o.timeoutMs ?? 10 * 60_000);
      timer.unref?.();
      o.signal?.addEventListener(
        'abort',
        () => {
          remove();
          w.reject(new Error('Gestopt'));
        },
        { once: true },
      );
    });
  }

  waiting(resource: string): Holder[] {
    return (this.waiters.get(resource) || []).map((w) => w.holder);
  }

  list(): Lease[] {
    for (const r of [...this.leases.keys()]) this.current(r);
    return [...this.leases.values()];
  }
}

function safe(fn: () => boolean) {
  try {
    return fn();
  } catch {
    return false;
  }
}
