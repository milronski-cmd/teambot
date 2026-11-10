/** Fixed-window counters per key. In memory and per app instance (not shared between processes). */
export class Limiter {
  private hits = new Map<string, { n: number; reset: number }>();

  constructor(private max: number, private windowMs: number) {}

  private entry(key: string) {
    const t = Date.now();
    let h = this.hits.get(key);
    if (!h || h.reset <= t) {
      h = { n: 0, reset: t + this.windowMs };
      this.hits.set(key, h);
      if (this.hits.size > 5000) for (const [k, v] of this.hits) if (v.reset <= t) this.hits.delete(k);
    }
    return h;
  }

  /** Count one hit. Returns false when the key went over its limit. */
  hit(key: string): boolean {
    const h = this.entry(key);
    h.n++;
    return h.n <= this.max;
  }

  /** True when the key already used up its window. */
  blocked(key: string): boolean {
    const h = this.hits.get(key);
    return !!h && h.reset > Date.now() && h.n >= this.max;
  }

  retryAfterSec(key: string): number {
    const h = this.hits.get(key);
    return h ? Math.max(1, Math.ceil((h.reset - Date.now()) / 1000)) : 0;
  }
}
