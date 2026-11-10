import { createRequire } from 'node:module';
import { preloadOrt } from './ort.js';

const req = createRequire(import.meta.url);
let mod: any = null;
let err: string | null = null;

/** sherpa-onnx (the in-process speech engine), loaded once; null when it cannot run here (see sherpaError). */
export function loadSherpa(): any {
  if (mod || err) return mod;
  try {
    preloadOrt();
    mod = req('sherpa-onnx-node');
  } catch (e: any) {
    err = String(e?.message || e).split('\n')[0].slice(0, 300);
  }
  return mod;
}

/** Why sherpa-onnx could not be loaded (first line of the error), or null. */
export const sherpaError = (): string | null => (loadSherpa(), err);
