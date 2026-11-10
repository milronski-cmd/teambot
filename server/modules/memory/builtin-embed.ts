/**
 * The built-in model for search by meaning ("slim zoeken" for everyone, also without Ollama).
 *
 * - Model (since 0.4.4): granite-embedding-97m-multilingual-r2 (IBM, Apache-2.0; 200+ languages, Dutch among the 52
 *   with extra retrieval training, 384 dimensions, CLS pooling, no query/passage prefixes). IBM trained it only on data
 *   with permissive, enterprise-friendly licenses, so it fits business use too. Its own ONNX export, the uint8 build
 *   (`onnx/model_quint8_avx2.onnx`, runs on every x64/ARM CPU). Pinned to one revision; every file is checked against
 *   its SHA-256 before it is used. On the memory benchmark it puts the right note first for 60 % of the questions on
 *   meaning alone, multilingual-e5-small (the model before 0.4.4) for 44 % (docs/quality/memory-bench.md).
 * - Runtime: ONNX Runtime for Node (`onnxruntime-node`, MIT, Microsoft) and Hugging Face's tokenizer
 *   (`@huggingface/tokenizers`, Apache-2.0, pure JS). Loaded with `require` at first use: a build without them simply
 *   says so (state "no-runtime") and memory keeps searching by words.
 * - Download: only after the owner said yes (one calm card, "± 125 MB, blijft op je pc"), once per installation, into
 *   the data folder (`<data>/models/embed/<model>`). The yes is for "the built-in search model": an installation that
 *   said yes to the older model gets this one in the background (semantic.ts) and the old files go once it is ready.
 *   Nothing is ever sent anywhere: the model runs on the CPU of this computer, in ONNX Runtime's own threads (the event
 *   loop is not blocked).
 * - The session is released after 10 minutes without use (±200 MB of RAM back).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

export interface BuiltinFile {
  name: string;
  url: string;
  size: number;
  sha256: string;
}

const REV = '835ad14087e140460703cf0fae09f97d469d65c2';
const BASE = `https://huggingface.co/ibm-granite/granite-embedding-97m-multilingual-r2/resolve/${REV}`;

/** The pinned files (sizes and hashes as published by Hugging Face for this revision). */
export const BUILTIN_FILES: BuiltinFile[] = [
  { name: 'model.onnx', url: `${BASE}/onnx/model_quint8_avx2.onnx`, size: 98_247_878, sha256: 'a6022dd8220ea6f6595562a1328ee216f4a94faa55362f2f4747c80f1e78772e' },
  { name: 'tokenizer.json', url: `${BASE}/tokenizer.json`, size: 25_301_672, sha256: '4f2842d568e2724370aec203652a42ac783c7937f8347a1a2cc7506d71f1582f' },
  { name: 'tokenizer_config.json', url: `${BASE}/tokenizer_config.json`, size: 12_860, sha256: '6ed69389e30a8ecabfce2f9ebcdf0c908b34056f24d994340f2f216521c057d5' },
];

export const BUILTIN = {
  /** The model name stored with each vector (another model = vectors made again). */
  id: 'builtin:granite-embedding-97m-multilingual-r2',
  name: 'granite-embedding-97m-multilingual-r2',
  label: 'Ingebouwd: granite-embedding-97m-multilingual-r2',
  license: 'Apache-2.0',
  homepage: 'https://huggingface.co/ibm-granite/granite-embedding-97m-multilingual-r2',
  revision: REV,
  dim: 384,
  /** The model reads up to 32k tokens; notes and document parts are short, so 1024 keeps every call quick. */
  maxTokens: 1024,
  pooling: 'cls' as 'cls' | 'mean',
};

/**
 * The built-in model before 0.4.4 (multilingual-e5-small, MIT): its id in saved settings still means "the built-in
 * model", and its folder is removed once the new model is ready (the owner's yes was for the built-in search model).
 */
export const LEGACY_BUILTIN = { ids: ['builtin:multilingual-e5-small'], dirs: ['multilingual-e5-small'] };
export const isBuiltinId = (id: string | null | undefined) => !!id && (id === BUILTIN.id || LEGACY_BUILTIN.ids.includes(id));

export const builtinBytes = (files = BUILTIN_FILES) => files.reduce((n, f) => n + f.size, 0);

/** One loaded model: texts in, unit vectors out (texts already carry the model's "query: "/"passage: " prefix). */
export interface BuiltinRuntime {
  embed(texts: string[]): Promise<Float32Array[]>;
  close(): void;
}
export type RuntimeLoader = (dir: string) => Promise<BuiltinRuntime>;

const req = createRequire(import.meta.url);
let runtimeErr: string | null | undefined;

/** Can the runtime load on this computer? null = yes, else a short reason (for logs; the page says it plainly). */
export function runtimeProblem(): string | null {
  if (testHooks.loader) return null;
  if (runtimeErr !== undefined) return runtimeErr;
  try {
    req('onnxruntime-node');
    req('@huggingface/tokenizers');
    runtimeErr = null;
  } catch (e: any) {
    runtimeErr = String(e?.message || e).split('\n')[0].slice(0, 300);
  }
  return runtimeErr;
}

/** Mean pooling over the real tokens, then unit length (what multilingual-e5 was trained with). */
export function meanPool(data: ArrayLike<number>, dims: readonly number[], mask: ArrayLike<bigint | number>): Float32Array[] {
  const [B, L, D] = dims as [number, number, number];
  const out: Float32Array[] = [];
  for (let b = 0; b < B; b++) {
    const v = new Float32Array(D);
    let n = 0;
    for (let i = 0; i < L; i++) {
      if (!Number(mask[b * L + i])) continue;
      n++;
      const o = (b * L + i) * D;
      for (let d = 0; d < D; d++) v[d] += Number(data[o + d]);
    }
    let s = 0;
    for (let d = 0; d < D; d++) {
      v[d] /= n || 1;
      s += v[d] * v[d];
    }
    s = Math.sqrt(s) || 1;
    for (let d = 0; d < D; d++) v[d] /= s;
    out.push(v);
  }
  return out;
}

/** The first token's hidden state (CLS pooling, what granite-embedding was trained with), then unit length. */
export function clsPool(data: ArrayLike<number>, dims: readonly number[]): Float32Array[] {
  const [B, L, D] = dims as [number, number, number];
  const out: Float32Array[] = [];
  for (let b = 0; b < B; b++) {
    const v = new Float32Array(D);
    let s = 0;
    for (let d = 0; d < D; d++) {
      v[d] = Number(data[b * L * D + d]);
      s += v[d] * v[d];
    }
    s = Math.sqrt(s) || 1;
    for (let d = 0; d < D; d++) v[d] /= s;
    out.push(v);
  }
  return out;
}

/** The real runtime: ONNX Runtime + the Hugging Face tokenizer, CPU only, a few threads. */
const ortLoader: RuntimeLoader = async (dir) => {
  const ort = req('onnxruntime-node');
  const { Tokenizer } = req('@huggingface/tokenizers');
  const read = async (f: string) => JSON.parse(await fs.promises.readFile(path.join(dir, f), 'utf8'));
  const tok = new Tokenizer(await read('tokenizer.json'), await read('tokenizer_config.json'));
  const cpus = (os as any).availableParallelism?.() || os.cpus().length || 2;
  const session = await ort.InferenceSession.create(path.join(dir, 'model.onnx'), {
    executionProviders: ['cpu'],
    intraOpNumThreads: Math.max(1, Math.min(4, Math.floor(cpus / 4))),
    interOpNumThreads: 1,
    graphOptimizationLevel: 'all',
  });
  const types = (session.inputNames as string[]).includes('token_type_ids');
  const encode = (t: string): number[] => {
    const ids: number[] = tok.encode(t).ids;
    // Keep the start, and the closing </s> the model expects.
    return ids.length > BUILTIN.maxTokens ? [...ids.slice(0, BUILTIN.maxTokens - 1), ids[ids.length - 1]] : ids;
  };
  return {
    async embed(texts) {
      const out: Float32Array[] = new Array(texts.length);
      // Similar lengths together: less padding, less work.
      const order = texts.map((t, i) => ({ i, ids: encode(t) })).sort((a, b) => a.ids.length - b.ids.length);
      for (let s = 0; s < order.length; s += 16) {
        const part = order.slice(s, s + 16);
        const L = Math.max(...part.map((p) => p.ids.length));
        const B = part.length;
        const ids = new BigInt64Array(B * L);
        const mask = new BigInt64Array(B * L);
        part.forEach((p, b) => p.ids.forEach((id, i) => ((ids[b * L + i] = BigInt(id)), (mask[b * L + i] = 1n))));
        const feeds: Record<string, any> = { input_ids: new ort.Tensor('int64', ids, [B, L]), attention_mask: new ort.Tensor('int64', mask, [B, L]) };
        if (types) feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(B * L), [B, L]);
        const res = await session.run(feeds);
        const h = res[session.outputNames[0]];
        (BUILTIN.pooling === 'cls' ? clsPool(h.data, h.dims) : meanPool(h.data, h.dims, mask)).forEach((v, b) => (out[part[b].i] = v));
      }
      return out;
    },
    close() {
      try {
        session.release?.();
      } catch {
        /* already released */
      }
    },
  };
};

/** Tests: a stand-in runtime and download source (never the real 135 MB). */
const testHooks: { loader: RuntimeLoader | null; files: BuiltinFile[] | null } = { loader: null, files: null };
export function setBuiltinForTests(o: { loader?: RuntimeLoader | null; files?: BuiltinFile[] | null }) {
  if (o.loader !== undefined) testHooks.loader = o.loader;
  if (o.files !== undefined) testHooks.files = o.files;
  runtimeErr = undefined;
}

export type BuiltinState = 'absent' | 'downloading' | 'ready' | 'error' | 'no-runtime';

export interface BuiltinStatus {
  state: BuiltinState;
  /** The owner said yes (install-wide). */
  consent: boolean;
  bytes: number;
  done: number;
  error: string | null;
  model: string;
  license: string;
}

/** The model on disk, its download and its loaded session. One per installation. */
export class BuiltinModel {
  readonly dir: string;
  private dl: { done: number; total: number; error: string | null; running: Promise<boolean> | null } = { done: 0, total: 0, error: null, running: null };
  private rt: Promise<BuiltinRuntime> | null = null;
  private idle: NodeJS.Timeout | null = null;
  private okCache: boolean | null = null;

  private readonly root: string;

  constructor(dataDir: string) {
    this.root = path.join(dataDir, 'models', 'embed');
    this.dir = path.join(this.root, BUILTIN.name);
  }

  /** The folder of the built-in model before 0.4.4 is still there (the owner said yes to that one). */
  legacyPresent(): boolean {
    return LEGACY_BUILTIN.dirs.some((d) => fs.existsSync(path.join(this.root, d)));
  }

  /** Remove the older built-in model's files (once this model is ready, or with "verwijderen"). */
  removeLegacy() {
    for (const d of LEGACY_BUILTIN.dirs) fs.rmSync(path.join(this.root, d), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  get files(): BuiltinFile[] {
    return testHooks.files || BUILTIN_FILES;
  }

  private marker() {
    return path.join(this.dir, 'verified.json');
  }

  /** All files there, with the verified hashes (checked once after download; sizes on every start). */
  present(): boolean {
    if (this.okCache !== null) return this.okCache;
    let ok = false;
    try {
      const m = JSON.parse(fs.readFileSync(this.marker(), 'utf8'));
      ok = this.files.every((f) => m?.[f.name] === f.sha256 && fs.statSync(path.join(this.dir, f.name)).size === f.size);
    } catch {
      ok = false;
    }
    this.okCache = ok;
    return ok;
  }

  status(consent: boolean): BuiltinStatus {
    const total = builtinBytes(this.files);
    const base = { consent, bytes: total, done: this.dl.done, error: this.dl.error, model: BUILTIN.name, license: BUILTIN.license };
    if (runtimeProblem()) return { ...base, state: 'no-runtime' };
    if (this.dl.running) return { ...base, state: 'downloading' };
    if (this.present()) return { ...base, state: 'ready', done: total };
    return { ...base, state: this.dl.error ? 'error' : 'absent' };
  }

  /** Download and verify every file (single-flight). Resolves true when the model is ready. */
  download(fetchImpl: typeof fetch = fetch): Promise<boolean> {
    if (this.dl.running) return this.dl.running;
    this.dl = { done: 0, total: builtinBytes(this.files), error: null, running: null };
    this.dl.running = (async () => {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        const verified: Record<string, string> = {};
        for (const f of this.files) {
          const dest = path.join(this.dir, f.name);
          if (fs.existsSync(dest) && fs.statSync(dest).size === f.size && (await sha256File(dest)) === f.sha256) {
            this.dl.done += f.size;
            verified[f.name] = f.sha256;
            continue;
          }
          const part = dest + '.part';
          const r = await fetchImpl(f.url, { redirect: 'follow', signal: AbortSignal.timeout(60 * 60_000) });
          if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
          const hash = crypto.createHash('sha256');
          const out = fs.createWriteStream(part);
          let n = 0;
          try {
            const reader = r.body.getReader();
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              n += value.byteLength;
              if (n > f.size) throw new Error('groter dan verwacht');
              hash.update(value);
              this.dl.done += value.byteLength;
              if (!out.write(value)) await new Promise((res) => out.once('drain', res));
            }
          } finally {
            await new Promise((res) => out.end(res));
          }
          const got = hash.digest('hex');
          if (n !== f.size || got !== f.sha256) {
            fs.rmSync(part, { force: true });
            throw new Error('de controle van het bestand klopte niet');
          }
          fs.renameSync(part, dest);
          verified[f.name] = f.sha256;
        }
        fs.writeFileSync(this.marker(), JSON.stringify(verified, null, 1));
        this.okCache = null;
        return this.present();
      } catch (e: any) {
        this.dl.error = String(e?.message || e).slice(0, 200);
        this.okCache = null;
        return false;
      } finally {
        this.dl.running = null;
      }
    })();
    return this.dl.running;
  }

  /** Look at the files on disk again (after they were put there by hand, e.g. from a model cache). */
  recheck() {
    this.okCache = null;
  }

  /** Remove the model from disk (Opslag › "Ingebouwd model verwijderen"). */
  remove() {
    this.release();
    fs.rmSync(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    this.removeLegacy();
    this.okCache = null;
    this.dl.error = null;
  }

  /** Embed texts (with their prefixes already added). Throws when the model or runtime is not there. */
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!texts.length) return [];
    if (!this.present()) throw new Error('Het ingebouwde zoekmodel is nog niet gedownload');
    const problem = runtimeProblem();
    if (problem) throw new Error(problem);
    if (!this.rt) {
      const load = (testHooks.loader || ortLoader)(this.dir);
      this.rt = load;
      load.catch(() => {
        if (this.rt === load) this.rt = null;
      });
    }
    const rt = await this.rt;
    this.touch();
    return rt.embed(texts);
  }

  private touch() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.release(), 10 * 60_000);
    this.idle.unref?.();
  }

  /** Free the loaded session (it loads again at the next search). */
  release() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const cur = this.rt;
    this.rt = null;
    void cur?.then((r) => r.close()).catch(() => {});
  }
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}
