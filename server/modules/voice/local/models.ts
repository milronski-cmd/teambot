import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import AdmZip from 'adm-zip';
import { type LocalModel, LOCAL_MODELS, catalogFor, totalSize } from './catalog.js';

export type ModelStatus = 'missing' | 'downloading' | 'verifying' | 'installed' | 'error' | 'unsupported';

export interface ModelState {
  id: string;
  status: ModelStatus;
  /** Bytes received so far (all files of the model). */
  received: number;
  total: number;
  error: string | null;
}

const MARKER = '.installed.json';

/** Hash the files list so a catalog change (new revision) makes an old install count as missing. */
const fingerprint = (m: LocalModel) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(m.files.map((f) => [f.path, f.sha256])))
    .digest('hex')
    .slice(0, 16);

async function sha256File(file: string): Promise<string> {
  const h = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const s = fs.createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve());
    s.on('error', reject);
  });
  return h.digest('hex');
}

/**
 * Downloads and keeps the local speech models. Each file is fetched over https (resumable via Range), hashed while it
 * streams and only moved into place when size and SHA-256 match the pinned catalog value. One download per model at
 * a time; progress is reported through `onProgress`.
 */
export class LocalModels {
  private jobs = new Map<string, { state: ModelState; abort: AbortController; done: Promise<void> }>();
  private failed = new Map<string, string>();
  private readonly catalog: LocalModel[];

  constructor(
    readonly dir: string,
    opts: { catalog?: LocalModel[]; platform?: string; onProgress?: (s: ModelState) => void } = {},
  ) {
    this.catalog = catalogFor(opts.catalog || LOCAL_MODELS, opts.platform);
    this.onProgress = opts.onProgress || (() => {});
  }

  private onProgress: (s: ModelState) => void;

  list(): LocalModel[] {
    return this.catalog;
  }

  model(id: string): LocalModel | undefined {
    return this.catalog.find((m) => m.id === id);
  }

  root(id: string): string {
    if (!/^[\w.-]{1,80}$/.test(id)) throw new Error('Ongeldige model-id');
    return path.join(this.dir, id);
  }

  file(id: string, name: string): string {
    return path.join(this.root(id), name);
  }

  supported(id: string): boolean {
    return !!this.model(id)?.files.length;
  }

  installed(id: string): boolean {
    const m = this.model(id);
    if (!m || !m.files.length) return false;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(this.root(id), MARKER), 'utf8'));
      return j?.fingerprint === fingerprint(m);
    } catch {
      return false;
    }
  }

  state(id: string): ModelState {
    const m = this.model(id);
    const total = m ? totalSize(m) : 0;
    const job = this.jobs.get(id);
    if (job) return { ...job.state };
    if (!m || !m.files.length) return { id, status: 'unsupported', received: 0, total, error: null };
    if (this.installed(id)) return { id, status: 'installed', received: total, total, error: null };
    const err = this.failed.get(id);
    return { id, status: err ? 'error' : 'missing', received: 0, total, error: err || null };
  }

  states(): ModelState[] {
    return this.catalog.map((m) => this.state(m.id));
  }

  /** Start (or join) a download. Resolves when the model is installed; rejects on error or cancel. */
  install(id: string): Promise<void> {
    const m = this.model(id);
    if (!m) return Promise.reject(new Error('Onbekend model'));
    if (!m.files.length) return Promise.reject(new Error('Dit onderdeel is niet beschikbaar voor dit besturingssysteem'));
    if (this.installed(id)) return Promise.resolve();
    const running = this.jobs.get(id);
    if (running) return running.done;
    this.failed.delete(id);
    const abort = new AbortController();
    const state: ModelState = { id, status: 'downloading', received: 0, total: totalSize(m), error: null };
    const done = this.run(m, state, abort.signal).then(
      () => {
        this.jobs.delete(id);
        this.onProgress(this.state(id));
      },
      (e) => {
        this.jobs.delete(id);
        const msg = abort.signal.aborted ? 'Download geannuleerd' : String(e?.message || e).slice(0, 300);
        this.failed.set(id, msg);
        this.onProgress(this.state(id));
        throw new Error(msg);
      },
    );
    this.jobs.set(id, { state, abort, done });
    this.onProgress({ ...state });
    return done;
  }

  cancel(id: string): boolean {
    const j = this.jobs.get(id);
    if (!j) return false;
    j.abort.abort();
    return true;
  }

  remove(id: string): void {
    this.cancel(id);
    this.failed.delete(id);
    const dir = this.root(id);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  private async run(m: LocalModel, state: ModelState, signal: AbortSignal) {
    const dir = this.root(m.id);
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.rmSync(path.join(dir, MARKER), { force: true });
    } catch {
      /* ignore */
    }
    let before = 0;
    let lastEmit = 0;
    const tick = (n: number, force = false) => {
      state.received = before + n;
      const t = Date.now();
      if (force || t - lastEmit > 300) {
        lastEmit = t;
        this.onProgress({ ...state });
      }
    };
    for (const f of m.files) {
      const dest = path.join(dir, f.path);
      if (!dest.startsWith(dir + path.sep)) throw new Error('Ongeldig bestandspad in catalogus');
      if (!f.extract && fs.existsSync(dest) && fs.statSync(dest).size === f.size && (await sha256File(dest)) === f.sha256) {
        before += f.size;
        tick(0, true);
        continue;
      }
      await this.fetchFile(f.url, dest + '.part', f.size, f.sha256, signal, tick);
      state.status = 'verifying';
      tick(f.size, true);
      if (f.extract) {
        extract(dest + '.part', f.extract, dir);
        fs.rmSync(dest + '.part', { force: true });
      } else fs.renameSync(dest + '.part', dest);
      before += f.size;
      state.status = 'downloading';
    }
    fs.writeFileSync(path.join(dir, MARKER), JSON.stringify({ id: m.id, fingerprint: fingerprint(m), installedAt: new Date().toISOString() }));
  }

  /** Download into `part` (resuming an earlier partial file), verifying size and SHA-256 at the end. */
  private async fetchFile(url: string, part: string, size: number, sha256: string, signal: AbortSignal, tick: (n: number, force?: boolean) => void): Promise<void> {
    const hash = crypto.createHash('sha256');
    let have = 0;
    if (fs.existsSync(part)) {
      have = fs.statSync(part).size;
      if (have > size) {
        fs.rmSync(part, { force: true });
        have = 0;
      } else if (have > 0) {
        await new Promise<void>((resolve, reject) => {
          const s = fs.createReadStream(part);
          s.on('data', (d) => hash.update(d));
          s.on('end', () => resolve());
          s.on('error', reject);
        });
      }
    }
    if (have < size) {
      const res = await httpGet(url, have ? { range: `bytes=${have}-` } : {}, signal);
      const status = res.statusCode || 0;
      if (status === 200 && have) {
        // Server ignored the range: start over.
        res.destroy();
        fs.rmSync(part, { force: true });
        return this.fetchFile(url, part, size, sha256, signal, tick);
      }
      if (status !== 200 && status !== 206) {
        res.resume();
        throw new Error(`Download mislukt (${status}) voor ${path.basename(part, '.part')}`);
      }
      const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
      let got = have;
      try {
        for await (const chunk of res as AsyncIterable<Buffer>) {
          if (signal.aborted) throw new Error('Download geannuleerd');
          got += chunk.length;
          if (got > size) throw new Error('Het bestand is groter dan verwacht');
          hash.update(chunk);
          if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
          tick(got);
        }
      } finally {
        await new Promise<void>((r) => out.end(() => r()));
      }
      have = got;
    }
    if (have !== size) throw new Error(`Download onvolledig (${have} van ${size} bytes); probeer opnieuw, hij gaat verder waar hij was`);
    const digest = hash.digest('hex');
    if (digest !== sha256) {
      fs.rmSync(part, { force: true });
      throw new Error('Controlegetal (SHA-256) klopt niet; het bestand is verwijderd. Probeer opnieuw.');
    }
  }
}

/**
 * GET with redirects (max 5, https only; http only to 127.0.0.1 for tests). node:https instead of fetch: on large
 * files fetch reached ~4 MB/s here where node:https and curl reached 65-70 MB/s from the same CDN.
 */
function httpGet(url: string, headers: Record<string, string>, signal: AbortSignal, hops = 0): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const local = u.protocol === 'http:' && u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !local) return reject(new Error('Alleen https-downloads zijn toegestaan'));
    const req = (local ? http : https).get(u, { headers: { 'user-agent': 'TeamBot', ...headers }, signal, timeout: 30_000 }, (res) => {
      const s = res.statusCode || 0;
      if (s >= 300 && s < 400 && res.headers.location) {
        res.resume();
        if (hops >= 5) return reject(new Error('Te veel doorverwijzingen'));
        return resolve(httpGet(new URL(res.headers.location, u).toString(), headers, signal, hops + 1));
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('Geen antwoord van de downloadserver')));
    req.on('error', reject);
  });
}

/** Unpack a verified archive into `dir`, refusing entries that would land outside it. */
function extract(file: string, kind: 'zip' | 'tar.gz', dir: string) {
  if (kind === 'zip') {
    const zip = new AdmZip(file);
    for (const e of zip.getEntries()) {
      const target = path.resolve(dir, e.entryName);
      if (!target.startsWith(path.resolve(dir) + path.sep)) throw new Error(`Onveilig pad in archief: ${e.entryName}`);
    }
    zip.extractAllTo(dir, true);
    return;
  }
  // tar.gz (Linux/macOS builds contain symlinks): the system tar handles them; the archive itself is SHA-256 pinned.
  const r = spawnSync('tar', ['-xzf', file, '-C', dir, '--no-same-owner'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`Uitpakken mislukt: ${String(r.stderr || r.error || '').slice(0, 200)}`);
}
