/**
 * Reading scans: text from a picture of a page (a scanned pdf, a photo of a letter), on this computer.
 *
 * - Recognition: tesseract.js (Apache-2.0), WebAssembly, in its own worker thread (the event loop is not blocked).
 * - Pages of a pdf without a text layer are rendered to grey pixels with PDFium in WebAssembly (@hyzyla/pdfium, MIT);
 *   pdf.js keeps reading every pdf that has text.
 * - Language data: tessdata_fast (Apache-2.0), Dutch and English, pinned to release 4.1.0 (± 10 MB). Fetched by itself
 *   the first time a bot reads a scan (`ensure`), or earlier from the card in Bestanden; every file checked against
 *   its SHA-256 before use, into the data folder (`<data>/models/ocr/tessdata_fast-4.1.0`). Did the download fail (no
 *   internet), the bot says so and the next scan tries again. tesseract.js is told to read only that folder: it never
 *   fetches anything itself.
 * - Limits: at most MAX_OCR_PAGES pages per read, one page at a time, a time limit per page; what was not read is said.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fetchVerified } from '../../core/util.js';

export interface OcrLang {
  id: string;
  label: string;
  url: string;
  size: number;
  sha256: string;
}

const TAG = '4.1.0';
const BASE = `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${TAG}`;

/** Dutch first, then English (sizes and hashes of release 4.1.0). */
export const OCR_LANGS: OcrLang[] = [
  { id: 'nld', label: 'Nederlands', url: `${BASE}/nld.traineddata`, size: 6_050_296, sha256: 'ced0e5e046a84c908a6aa7accbef9a232c4a5d9a8276691b81c6ee64d02963f6' },
  { id: 'eng', label: 'Engels', url: `${BASE}/eng.traineddata`, size: 4_113_088, sha256: '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2' },
];

/** Pages read with OCR in one go (each takes a few seconds). */
export const MAX_OCR_PAGES = 20;
const PAGE_TIMEOUT_MS = 90_000;
const IDLE_MS = 2 * 60_000;

const RETRY = 'bij de volgende scan probeert TeamBot het opnieuw';
/** Why a scan was not read although TeamBot tried to fetch the language data (no internet, a site that is down). */
export const OCR_HINT = `De taaldata voor tekstherkenning (± 10 MB) kon nu niet worden opgehaald; ${RETRY}.`;
const NO_RUNTIME = 'Scans lezen kan niet in deze installatie: het onderdeel voor tekstherkenning ontbreekt. Installeer TeamBot opnieuw.';

const req = createRequire(import.meta.url);

/** In the Windows app the worker script and the wasm files are unpacked next to app.asar (package.json asarUnpack). */
const unpacked = (p: string) => p.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');

export type OcrState = 'absent' | 'downloading' | 'ready' | 'error' | 'no-runtime';
export interface OcrStatus {
  state: OcrState;
  langs: { id: string; label: string; bytes: number; present: boolean }[];
  bytes: number;
  done: number;
  error: string | null;
  license: string;
}

/** Tests: other download sources (never the real files from the internet). */
const testHooks: { langs: OcrLang[] | null } = { langs: null };
export function setOcrForTests(o: { langs?: OcrLang[] | null }) {
  if (o.langs !== undefined) testHooks.langs = o.langs;
}

let runtimeErr: string | null | undefined;
export function ocrRuntimeProblem(): string | null {
  if (runtimeErr !== undefined) return runtimeErr;
  try {
    req.resolve('tesseract.js');
    req.resolve('tesseract.js-core/package.json');
    runtimeErr = null;
  } catch (e: any) {
    runtimeErr = String(e?.message || e).split('\n')[0].slice(0, 200);
  }
  return runtimeErr;
}

type TessWorker = { recognize(img: Buffer): Promise<{ data: { text: string } }>; terminate(): Promise<any> };

/** The language data on disk, its download, and one recognition worker that is let go when idle. */
export class OcrEngine {
  readonly dir: string;
  private dl: { done: number; total: number; error: string | null; running: Promise<boolean> | null } = { done: 0, total: 0, error: null, running: null };
  private worker: { langs: string; w: Promise<TessWorker> } | null = null;
  private idle: NodeJS.Timeout | null = null;
  private queue: Promise<any> = Promise.resolve();

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'models', 'ocr', `tessdata_fast-${TAG}`);
  }

  get langs(): OcrLang[] {
    return testHooks.langs || OCR_LANGS;
  }

  private marker() {
    return path.join(this.dir, 'verified.json');
  }

  private verified(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(this.marker(), 'utf8')) || {};
    } catch {
      return {};
    }
  }

  /** The languages whose file is there with the hash that was checked after the download. */
  presentLangs(): string[] {
    const m = this.verified();
    return this.langs
      .filter((l) => {
        try {
          return m[l.id] === l.sha256 && fs.statSync(path.join(this.dir, `${l.id}.traineddata`)).size === l.size;
        } catch {
          return false;
        }
      })
      .map((l) => l.id);
  }

  ready(): boolean {
    return !ocrRuntimeProblem() && this.presentLangs().length > 0;
  }

  status(): OcrStatus {
    const have = new Set(this.presentLangs());
    const bytes = this.langs.reduce((n, l) => n + l.size, 0);
    const base = {
      langs: this.langs.map((l) => ({ id: l.id, label: l.label, bytes: l.size, present: have.has(l.id) })),
      bytes,
      done: this.dl.done,
      error: this.dl.error,
      license: 'Apache-2.0',
    };
    if (ocrRuntimeProblem()) return { ...base, state: 'no-runtime' };
    if (this.dl.running) return { ...base, state: 'downloading' };
    if (have.size === this.langs.length) return { ...base, state: 'ready', done: bytes };
    return { ...base, state: this.dl.error ? 'error' : 'absent' };
  }

  /** Download and check the language files (single-flight). Resolves true when every language is there. */
  download(fetchImpl: typeof fetch = fetch): Promise<boolean> {
    if (this.dl.running) return this.dl.running;
    this.dl = { done: 0, total: this.langs.reduce((n, l) => n + l.size, 0), error: null, running: null };
    this.dl.running = (async () => {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        const verified = this.verified();
        for (const l of this.langs) {
          const dest = path.join(this.dir, `${l.id}.traineddata`);
          const fetched = await fetchVerified(fetchImpl, l, dest, { timeoutMs: 20 * 60_000, onBytes: (n) => (this.dl.done += n) });
          verified[l.id] = l.sha256;
          if (fetched) fs.writeFileSync(this.marker(), JSON.stringify(verified, null, 1));
        }
        fs.writeFileSync(this.marker(), JSON.stringify(verified, null, 1));
        return this.presentLangs().length === this.langs.length;
      } catch (e: any) {
        this.dl.error = String(e?.message || e).slice(0, 200);
        return false;
      } finally {
        this.dl.running = null;
      }
    })();
    return this.dl.running;
  }

  /** Ready to read a scan: the language data is there, or is fetched now (once; a failed try is tried again next time). */
  async ensure(): Promise<boolean> {
    if (this.ready()) return true;
    if (ocrRuntimeProblem()) return false;
    await this.download();
    return this.ready();
  }

  /** In plain words why a scan cannot be read right now (after `ensure` said no). */
  problem(): string {
    if (ocrRuntimeProblem()) return NO_RUNTIME;
    return this.dl.error ? `De taaldata voor tekstherkenning (± 10 MB) kon nu niet worden opgehaald (${this.dl.error}); ${RETRY}.` : OCR_HINT;
  }

  /** Remove the language data (the card in Bestanden); the next scan fetches it again. */
  async remove() {
    await this.release();
    fs.rmSync(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    this.dl.error = null;
  }

  private async getWorker(): Promise<TessWorker> {
    const langs = this.presentLangs().join('+');
    if (!langs) throw new Error(`Er is nog geen taaldata om scans te lezen. ${OCR_HINT}`);
    if (this.worker && this.worker.langs === langs) return this.worker.w;
    await this.release();
    const tess = req('tesseract.js');
    const workerPath = unpacked(path.join(path.dirname(req.resolve('tesseract.js/package.json')), 'src', 'worker-script', 'node', 'index.js'));
    // OEM 1 = LSTM only (what tessdata_fast contains); langPath = our checked folder, never a download.
    const w: Promise<TessWorker> = tess.createWorker(langs, 1, {
      langPath: this.dir,
      cachePath: this.dir,
      cacheMethod: 'none',
      gzip: false,
      workerPath,
      logger: () => {},
      errorHandler: () => {},
    });
    this.worker = { langs, w };
    w.catch(() => {
      if (this.worker?.w === w) this.worker = null;
    });
    return w;
  }

  private touch() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => void this.release(), IDLE_MS);
    this.idle.unref?.();
  }

  /** Stop the recognition worker (it starts again on the next scan). */
  async release() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const cur = this.worker;
    this.worker = null;
    if (cur) await cur.w.then((w) => w.terminate()).catch(() => {});
  }

  /** Text of one encoded image (png, jpeg, bmp, pnm …). One at a time; a page that takes too long stops the worker. */
  recognize(img: Buffer): Promise<string> {
    const job = this.queue.then(async () => {
      const w = await this.getWorker();
      let timer: NodeJS.Timeout | null = null;
      try {
        const r = await Promise.race([
          w.recognize(img),
          new Promise<never>((_, rej) => {
            timer = setTimeout(() => rej(new Error('Het lezen van deze pagina duurde te lang.')), PAGE_TIMEOUT_MS);
          }),
        ]);
        return String(r?.data?.text || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      } catch (e) {
        await this.release();
        throw e;
      } finally {
        if (timer) clearTimeout(timer);
        this.touch();
      }
    });
    this.queue = job.catch(() => {});
    return job;
  }

  /**
   * OCR of some pages of a pdf (1-based numbers). Each page is rendered at about 250 dpi (longest side at most 3500
   * pixels) in grey, then read. Returns the text per page, in order.
   */
  async pdfPages(data: Uint8Array, pages: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    if (!pages.length) return out;
    const { PDFiumLibrary } = await import('@hyzyla/pdfium');
    const wasmPath = unpacked(path.join(path.dirname(req.resolve('@hyzyla/pdfium/package.json')), 'dist', 'pdfium.wasm'));
    const lib = await PDFiumLibrary.init({ wasmBinary: fs.readFileSync(wasmPath) });
    try {
      const doc = await lib.loadDocument(data);
      try {
        for (const n of pages) {
          if (n < 1 || n > doc.getPageCount()) continue;
          const page = doc.getPage(n - 1);
          try {
            const { originalWidth: w, originalHeight: h } = page.getOriginalSize();
            const scale = Math.max(0.5, Math.min(250 / 72, 3500 / Math.max(w, h, 1)));
            const r = await page.render({ scale, colorSpace: 'Gray', render: 'bitmap' });
            out.set(n, await this.recognize(pgm(r.data, r.width, r.height)));
          } finally {
            page.close();
          }
        }
      } finally {
        doc.destroy();
      }
    } finally {
      lib.destroy();
    }
    return out;
  }
}

/** Grey pixels as a binary PGM (P5) image, which Tesseract's image library reads natively. */
export function pgm(gray: Uint8Array, w: number, h: number): Buffer {
  return Buffer.concat([Buffer.from(`P5\n${w} ${h}\n255\n`, 'latin1'), Buffer.from(gray.buffer, gray.byteOffset, w * h)]);
}

/** One engine per installation (set by the folders module at start; tests may make their own). */
let shared: OcrEngine | null = null;
export function setOcrEngine(e: OcrEngine | null) {
  shared = e;
}
export function ocrEngine(): OcrEngine | null {
  return shared;
}
export function isImage(buf: Buffer): boolean {
  const b = buf;
  return (
    (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) || // png
    (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || // jpeg
    (b[0] === 0x42 && b[1] === 0x4d) || // bmp
    (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || // tiff (little endian)
    (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a) || // tiff (big endian)
    (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') ||
    b.subarray(0, 4).toString('latin1') === 'GIF8' ||
    (b[0] === 0x50 && b[1] >= 0x31 && b[1] <= 0x36 && /\s/.test(String.fromCharCode(b[2])))
  );
}
