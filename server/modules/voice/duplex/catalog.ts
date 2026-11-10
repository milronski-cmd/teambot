/**
 * The two small extra models of the free live call, next to the speech recogniser and the voice that the free call
 * already uses. Pinned to an exact upstream revision and SHA-256, downloaded only when the user says yes (with size),
 * verified before use, into <dataDir>/voice/models/<id>/ like the other local models. Nothing is bundled.
 *
 * Licences checked 2026-11-09 on the source:
 * - Silero VAD v5.1.2 (snakers4/silero-vad, tag v5.1.2 = commit 6478567): code and model MIT. Runs in sherpa-onnx
 *   (Apache-2.0, already a dependency) as its `Vad`.
 * - Smart Turn v3.2, full precision (pipecat-ai/smart-turn-v3 on Hugging Face, revision f766f81, file
 *   smart-turn-v3.2-gpu.onnx; it runs on the CPU too, ~20 ms slower than the int8 file but measured on Dutch TTS it
 *   tells an unfinished sentence ("Zet het in mijn agenda en": 0.02) where the int8 file did not (0.79)); model card BSD-2-Clause;
 *   training data pipecat-ai/smart-turn-data-v3.1 is CC-BY-4.0; code (github.com/pipecat-ai/smart-turn) BSD-2-Clause.
 *   Runs in onnxruntime-node (MIT, already a dependency); the features are TeamBot's own code (mel.ts).
 * Not used (licence traps): LiveKit's turn detector (LiveKit Model License, only inside LiveKit Agents), TEN VAD and
 * TEN Turn Detection (forbid running on end-user devices), the GPL piper1 library.
 */
import type { LocalModel } from '../local/catalog.js';

export const SILERO_VAD = 'silero-vad-v5';
export const SMART_TURN = 'smart-turn-v3.2';
export const DUPLEX_LICENCES_CHECKED = '2026-11-09';

export const DUPLEX_MODELS: LocalModel[] = [
  {
    id: SILERO_VAD,
    kind: 'call-part',
    label: 'Silero VAD (hoort wanneer je praat)',
    description: 'Hoort binnen een fractie van een seconde dat je begint of stopt met praten, ook als de bot nog praat.',
    licence: 'MIT',
    licenceNote: 'Silero VAD v5.1.2 (snakers4), code en model MIT.',
    source: 'https://github.com/snakers4/silero-vad/tree/v5.1.2',
    languages: ['*'],
    files: [
      {
        path: 'silero_vad.onnx',
        url: 'https://raw.githubusercontent.com/snakers4/silero-vad/6478567951ae5c9979ad7b234185b5515f4be7a1/src/silero_vad/data/silero_vad.onnx',
        sha256: '2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f',
        size: 2327524,
      },
    ],
  },
  {
    id: SMART_TURN,
    kind: 'call-part',
    label: 'Smart Turn v3.2 (hoort of je klaar bent)',
    description: 'Hoort aan je stem of je zin af is of dat je nog nadenkt, zodat de bot je niet afkapt. Kent 23 talen, ook Nederlands.',
    licence: 'BSD-2-Clause',
    licenceNote: 'Pipecat Smart Turn v3.2 (Daily), model BSD-2-Clause, getraind op open data (CC-BY-4.0).',
    source: 'https://huggingface.co/pipecat-ai/smart-turn-v3',
    languages: ['*'],
    files: [
      {
        path: 'smart-turn-v3.2.onnx',
        url: 'https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/f766f81d3cfdf7737ac64aad813d91bbfd56bf93/smart-turn-v3.2-gpu.onnx',
        sha256: 'ab8dc64b88713f90b571c15b714bd1330e6c883cad8763dacf65c9376dc539be',
        size: 32411198,
      },
    ],
  },
];
