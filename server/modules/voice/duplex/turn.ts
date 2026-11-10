import os from 'node:os';
import { createRequire } from 'node:module';
import { logMel, N_FRAMES } from './mel.js';

/** "Is the speaker done?" for the audio of the turn so far (16 kHz). 0..1, ≥ 0.5 = done. */
export interface TurnDetector {
  name: string;
  predict(audio16k: Float32Array): Promise<number>;
  close?(): void;
}

const req = createRequire(import.meta.url);

/**
 * Pipecat Smart Turn v3.2 (BSD-2-Clause, full-precision ONNX, 32 MB, 23 languages including Dutch) on ONNX Runtime for
 * Node (MIT, already a dependency). It listens to how you speak, not to the words: a falling tone and a finished
 * sentence say "done", a rising "en…" says "wait". About 70 ms per call on a desktop CPU (features included).
 */
export class SmartTurn implements TurnDetector {
  name = 'smart-turn-v3.2';
  private session: Promise<any> | null = null;
  constructor(private file: string) {}

  private load() {
    if (!this.session) {
      const ort = req('onnxruntime-node');
      const cpus = (os as any).availableParallelism?.() || os.cpus().length || 2;
      this.session = ort.InferenceSession.create(this.file, {
        executionProviders: ['cpu'],
        intraOpNumThreads: Math.max(1, Math.min(4, Math.floor(cpus / 4))),
        interOpNumThreads: 1,
        executionMode: 'sequential',
        graphOptimizationLevel: 'all',
      });
      this.session!.catch(() => (this.session = null));
    }
    return this.session!;
  }

  warm() {
    this.load().catch(() => {});
  }

  async predict(audio16k: Float32Array): Promise<number> {
    const ort = req('onnxruntime-node');
    const session = await this.load();
    const feats = logMel(audio16k);
    const res = await session.run({ [session.inputNames[0] || 'input_features']: new ort.Tensor('float32', feats, [1, 80, N_FRAMES]) });
    const v = Number(res[session.outputNames[0]]?.data?.[0]);
    return Number.isFinite(v) ? v : 1;
  }

  close() {
    const s = this.session;
    this.session = null;
    s?.then((x) => x.release?.()).catch(() => {});
  }
}

/**
 * Without the model (or in tests): a sentence counts as done when it is long enough to be one; the caller still
 * waits for the longer pause before it answers an unfinished one.
 */
export const silenceOnlyTurn: TurnDetector = { name: 'silence', predict: async () => 1 };
