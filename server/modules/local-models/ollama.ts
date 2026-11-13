import { budget } from './advice.js';
import { originOf } from '../../providers/localmodels.js';
import type { CpuWarning, GpuVendor, Hardware, Placement, PullState } from '../../../shared/localModels.js';

/** Ollama's own API for what TeamBot shows on "Lokale modellen op deze pc": /api/ps, /api/tags, /api/pull. */

export async function getJson(url: string, timeoutMs = 3000): Promise<any> {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** A model Ollama has loaded now (/api/ps). */
export interface PsModel {
  name: string;
  /** Bytes in memory in total, and the part of it on the video card. */
  size: number;
  sizeVram: number;
  context: number;
}

export function parsePs(j: any): PsModel[] {
  return (Array.isArray(j?.models) ? j.models : [])
    .map((m: any) => ({ name: String(m?.name || m?.model || ''), size: Number(m?.size) || 0, sizeVram: Number(m?.size_vram) || 0, context: Number(m?.context_length) || 0 }))
    .filter((m: PsModel) => m.name);
}

/** Where Ollama runs a loaded model: `ollama ps` says "100% GPU", "48%/52% CPU/GPU" or "100% CPU". */
export const placement = (m: PsModel): Placement => (m.sizeVram <= 0 ? 'cpu' : m.sizeVram >= m.size * 0.98 ? 'gpu' : 'partly');

const DRIVERS: Record<GpuVendor, string | null> = {
  nvidia: 'https://www.nvidia.com/Download/index.aspx',
  amd: 'https://www.amd.com/en/support/download/drivers.html',
  intel: 'https://www.intel.com/content/www/us/en/download-center/home.html',
  apple: null,
  other: null,
};

/**
 * Ollama runs a model entirely on the processor although this pc has a usable video card: almost always a missing
 * or old driver (or an AMD card without ROCm), and Ollama does not say so. Only for "100% CPU", and only when no
 * loaded model uses the card: a model partly on the card is too big for it, and a second model on the processor
 * next to one on the card found the card full; neither is a driver problem.
 */
export function cpuWarning(ps: PsModel[], hw: Hardware | null): CpuWarning | null {
  if (!hw || hw.unified) return null;
  const card = budget(hw).gpu;
  if (!card || ps.some((x) => x.sizeVram > 0)) return null;
  const m = ps.find((x) => x.size > 0 && placement(x) === 'cpu');
  return m ? { model: m.name, gpu: card.name, vendor: card.vendor, driverUrl: DRIVERS[card.vendor] } : null;
}

// ------------------------------------------------------------------ downloads (/api/pull), only on the owner's click

interface Job {
  state: PullState;
  abort: AbortController;
  userId: string;
}

/** Downloads that run now (one per model), with progress summed over the layers. */
export class Pulls {
  private jobs = new Map<string, Job>();

  constructor(private emit: (userId: string, s: PullState) => void, private onDone?: (userId: string, s: PullState, base: string) => void) {}

  list(userId: string): PullState[] {
    // A finished download is shown for a while ("klaar", or why it failed), then forgotten.
    for (const [k, j] of this.jobs) if (j.state.done && Date.now() - Date.parse(j.state.startedAt) > 30 * 60_000) this.jobs.delete(k);
    return [...this.jobs.values()].filter((j) => j.userId === userId).map((j) => ({ ...j.state }));
  }

  running(model: string) {
    const j = this.jobs.get(model);
    return !!j && !j.state.done;
  }

  cancelAll() {
    for (const j of this.jobs.values()) if (!j.state.done) j.abort.abort();
  }

  cancel(model: string, userId: string): boolean {
    const j = this.jobs.get(model);
    if (!j || j.userId !== userId || j.state.done) return false;
    j.abort.abort();
    return true;
  }

  /** Start a download; resolves when it is finished (the caller does not wait for it). */
  start(base: string, model: string, userId: string): Promise<PullState> {
    const old = this.jobs.get(model);
    if (old && !old.state.done) return Promise.resolve({ ...old.state });
    const job: Job = { state: { model, status: 'starten', completed: 0, total: 0, done: false, startedAt: new Date().toISOString() }, abort: new AbortController(), userId };
    this.jobs.set(model, job);
    return this.run(base, job);
  }

  private async run(base: string, job: Job): Promise<PullState> {
    const s = job.state;
    const layers = new Map<string, { total: number; completed: number }>();
    let last = 0;
    const tell = (force = false) => {
      if (!force && Date.now() - last < 400) return;
      last = Date.now();
      this.emit(job.userId, { ...s });
    };
    try {
      const r = await fetch(`${originOf(base)}/api/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: s.model, stream: true }), signal: job.abort.signal, redirect: 'error' });
      if (!r.ok || !r.body) throw new Error(`Ollama antwoordde ${r.status}${r.body ? `: ${(await r.text()).slice(0, 200)}` : ''}`);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const line = (l: string) => {
        if (!l.trim()) return;
        const j = JSON.parse(l);
        if (j.error) throw new Error(String(j.error));
        if (j.status) s.status = String(j.status);
        if (j.digest && Number(j.total) > 0) layers.set(j.digest, { total: Number(j.total), completed: Number(j.completed) || 0 });
        s.total = [...layers.values()].reduce((n, x) => n + x.total, 0);
        s.completed = [...layers.values()].reduce((n, x) => n + x.completed, 0);
        if (j.status === 'success') s.ok = true;
        tell();
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          line(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      }
      line(buf);
      if (!s.ok) throw new Error('De download stopte voordat Ollama "success" meldde.');
      s.completed = s.total;
    } catch (e: any) {
      s.ok = false;
      if (job.abort.signal.aborted) {
        s.cancelled = true;
        s.status = 'gestopt';
      } else s.error = String(e?.message || e).slice(0, 300);
    }
    s.done = true;
    tell(true);
    try {
      this.onDone?.(job.userId, { ...s }, base);
    } catch {
      /* best effort */
    }
    return { ...s };
  }
}
