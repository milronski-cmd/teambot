import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { parseWav } from './pcm.js';

export interface SynthRequest {
  /** Which engine runs the voice (default 'piper'); see `voiceEngine` in catalog.ts. */
  engine?: 'piper' | 'vits';
  /** Directory with the voice files (Piper: voice.onnx + voice.onnx.json; VITS: model.onnx + tokens.txt). */
  voiceDir: string;
  /** Directory where the Piper runtime was unpacked (Piper voices only). */
  runtimeDir: string;
  text: string;
  speaker?: number;
  /** 1 = normal; 1.25 = 25 % faster. */
  speed: number;
  /** Sampling noise [noise_scale, noise_w] (the voice's own when absent). */
  noise?: [number, number];
}

export interface SynthResult {
  /** 16-bit little-endian mono PCM. */
  pcm: Buffer;
  sampleRate: number;
}

export interface TtsBackend {
  name: string;
  synth(r: SynthRequest): Promise<SynthResult>;
  /** Load the voice ahead of time (Piper takes ~1 s cold), e.g. while the bot is still thinking. */
  warm?(r: Omit<SynthRequest, 'text'>): void;
  close(): void;
}

export function piperExe(runtimeDir: string): string {
  return path.join(runtimeDir, 'piper', process.platform === 'win32' ? 'piper.exe' : 'piper');
}

/**
 * The config Piper 2023.11.14-2 gets for a voice. Voices made with newer Piper versions list phonemes of several
 * characters ("aɪ"), which that build refuses ("is not a single codepoint"). It splits espeak-ng's output into single
 * characters anyway, so such entries can never be looked up: they are left out of a copy next to the original (the
 * verified download stays as it is). Only used for voices whose language never produces them (see catalog.ts).
 */
export function piperConfig(voiceDir: string): string {
  const original = path.join(voiceDir, 'voice.onnx.json');
  let cfg: any;
  try {
    cfg = JSON.parse(fs.readFileSync(original, 'utf8'));
  } catch {
    return original;
  }
  const map = cfg?.phoneme_id_map;
  if (!map || typeof map !== 'object') return original;
  const multi = Object.keys(map).filter((k) => [...k].length !== 1);
  if (!multi.length) return original;
  for (const k of multi) delete map[k];
  const compat = path.join(voiceDir, 'voice.piper2023.onnx.json');
  const body = JSON.stringify(cfg);
  try {
    if (!fs.existsSync(compat) || fs.readFileSync(compat, 'utf8') !== body) fs.writeFileSync(compat, body);
  } catch {
    return original;
  }
  return compat;
}

interface Pending {
  file: string;
  resolve(v: SynthResult): void;
  reject(e: Error): void;
  timer: NodeJS.Timeout;
}

/** One long-running Piper process for one voice + speed (model stays loaded; JSON lines in, WAV paths out). */
class PiperProc {
  private p: ChildProcessWithoutNullStreams;
  private queue: { line: string; pending: Pending }[] = [];
  private current: Pending | null = null;
  private out = '';
  private err = '';
  dead = false;
  lastUsed = Date.now();

  constructor(private key: string, exe: string, args: string[], cwd: string, private tmp: string) {
    this.p = spawn(exe, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.p.stdout.setEncoding('utf8');
    this.p.stdout.on('data', (d: string) => {
      this.out += d;
      let i: number;
      while ((i = this.out.indexOf('\n')) >= 0) {
        const line = this.out.slice(0, i).trim();
        this.out = this.out.slice(i + 1);
        if (line) this.finishCurrent(line);
      }
    });
    this.p.stderr.on('data', (d) => (this.err = (this.err + String(d)).slice(-2000)));
    const die = (why: string) => {
      if (this.dead) return;
      this.dead = true;
      const e = new Error(`Piper stopte onverwacht (${why})${this.err ? ': ' + this.err.trim().split('\n').pop()?.slice(0, 200) : ''}`);
      if (this.current) (clearTimeout(this.current.timer), this.current.reject(e));
      for (const q of this.queue) (clearTimeout(q.pending.timer), q.pending.reject(e));
      this.current = null;
      this.queue = [];
    };
    this.p.on('exit', (code) => die(`code ${code}`));
    this.p.on('error', (e) => die(e.message));
    this.p.stdin.on('error', () => die('stdin'));
  }

  private finishCurrent(_line: string) {
    const c = this.current;
    if (!c) return;
    this.current = null;
    clearTimeout(c.timer);
    try {
      const wav = fs.readFileSync(c.file);
      fs.rmSync(c.file, { force: true });
      const { samples, sampleRate } = parseWav(wav);
      const pcm = Buffer.alloc(samples.length * 2);
      for (let i = 0; i < samples.length; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32768))), i * 2);
      c.resolve({ pcm, sampleRate });
    } catch (e: any) {
      c.reject(new Error('Piper gaf geen bruikbare audio terug: ' + (e?.message || e)));
    }
    this.next();
  }

  private next() {
    if (this.current || !this.queue.length || this.dead) return;
    const { line, pending } = this.queue.shift()!;
    this.current = pending;
    this.p.stdin.write(line + '\n');
  }

  synth(text: string, speaker?: number): Promise<SynthResult> {
    this.lastUsed = Date.now();
    if (this.dead) return Promise.reject(new Error('Piper is gestopt'));
    const file = path.join(this.tmp, `piper-${crypto.randomBytes(8).toString('hex')}.wav`);
    return new Promise((resolve, reject) => {
      const pending: Pending = {
        file,
        resolve,
        reject,
        timer: setTimeout(() => {
          reject(new Error('Voorlezen duurde te lang'));
          this.kill();
        }, 60_000),
      };
      const msg: any = { text: text.replace(/[\r\n]+/g, ' '), output_file: file };
      if (speaker !== undefined && speaker > 0) msg.speaker_id = speaker;
      this.queue.push({ line: JSON.stringify(msg), pending });
      this.next();
    });
  }

  kill() {
    try {
      this.p.kill();
    } catch {
      /* already gone */
    }
  }
}

/**
 * Piper as a separate program (MIT; ships espeak-ng, GPL-3.0, which TeamBot therefore never links). Keeps a few
 * warm processes (one per voice + speed) and stops them after 10 idle minutes.
 */
export class PiperPool implements TtsBackend {
  name = 'piper';
  private procs = new Map<string, PiperProc>();
  private timer: NodeJS.Timeout;
  private tmp: string;

  constructor(tmpDir = path.join(os.tmpdir(), 'teambot-piper')) {
    this.tmp = tmpDir;
    fs.mkdirSync(this.tmp, { recursive: true });
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref?.();
  }

  private proc(r: SynthRequest): PiperProc {
    const lengthScale = Math.round((1 / Math.min(2, Math.max(0.5, r.speed || 1))) * 100) / 100;
    const key = `${r.voiceDir}|${lengthScale}|${r.noise?.join(',') || ''}`;
    let p = this.procs.get(key);
    if (p && !p.dead) return p;
    const exe = piperExe(r.runtimeDir);
    if (!fs.existsSync(exe)) throw new Error('Piper is niet geïnstalleerd');
    if (this.procs.size >= 4) {
      const oldest = [...this.procs.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      oldest[1].kill();
      this.procs.delete(oldest[0]);
    }
    const args = [
      '--model', path.join(r.voiceDir, 'voice.onnx'),
      '--config', piperConfig(r.voiceDir),
      '--json-input',
      '--length_scale', String(lengthScale),
      '--sentence_silence', '0.15',
      '--espeak_data', path.join(r.runtimeDir, 'piper', 'espeak-ng-data'),
      ...(r.noise ? ['--noise_scale', String(r.noise[0]), '--noise_w', String(r.noise[1])] : []),
      '-q',
    ];
    p = new PiperProc(key, exe, args, path.dirname(exe), this.tmp);
    this.procs.set(key, p);
    return p;
  }

  async synth(r: SynthRequest): Promise<SynthResult> {
    return this.proc(r).synth(r.text, r.speaker);
  }

  /** Start (or keep) the warm process for this voice + speed; Piper loads the model as soon as it starts. */
  warm(r: Omit<SynthRequest, 'text'>) {
    try {
      this.proc({ ...r, text: '' }).lastUsed = Date.now();
    } catch {
      /* not installed: the real request will say so */
    }
  }

  sweep(now = Date.now()) {
    for (const [k, p] of this.procs)
      if (p.dead || now - p.lastUsed > 10 * 60_000) {
        p.kill();
        this.procs.delete(k);
      }
  }

  close() {
    clearInterval(this.timer);
    for (const p of this.procs.values()) p.kill();
    this.procs.clear();
  }
}
