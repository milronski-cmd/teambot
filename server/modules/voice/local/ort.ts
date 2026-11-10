import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
let done = false;

/**
 * sherpa-onnx (ONNX Runtime 1.28) and onnxruntime-node (1.30: Smart Turn of the live call, the memory's built-in
 * embeddings) each ship an onnxruntime library with the same file name, and a process keeps the first one it loads.
 * 1.30 still serves sherpa-onnx (the C API is backwards compatible), but 1.28 cannot serve onnxruntime-node (Windows:
 * "The operating system cannot run %1"). So the newer one is always loaded first, before sherpa-onnx.
 */
export function preloadOrt() {
  if (done) return;
  done = true;
  try {
    req('onnxruntime-node');
  } catch {
    /* not available here: sherpa-onnx uses its own */
  }
}
