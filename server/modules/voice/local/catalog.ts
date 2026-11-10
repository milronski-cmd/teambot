/**
 * Local (free, on-device) speech models. Every file is pinned to an exact upstream revision and SHA-256, downloaded
 * on first use into <dataDir>/voice/models/<id>/ and verified before use. Nothing here is bundled in the installer.
 *
 * Licences checked 2026-11-08 (each model's own card on Hugging Face / GitHub release pages):
 * - Parakeet TDT 0.6B v3: CC-BY-4.0 (NVIDIA), ONNX conversion by the sherpa-onnx project (Apache-2.0). 25 European
 *   languages, among them all interface languages except Turkish and Arabic.
 * - Whisper large-v3 turbo: MIT (OpenAI), ONNX conversion by the sherpa-onnx project. 99 languages: the local choice
 *   for Turkish and Arabic. (Whisper small from the same project was tried: a third of the size, but on the CPU hardly
 *   faster than turbo — its decoder is the slow part — and clearly less accurate, so it is not offered.)
 * - Piper 2023.11.14-2: MIT. The download also contains espeak-ng 1.52 (GPL-3.0-or-later), used by piper.exe for
 *   pronunciation. TeamBot never links it: it only starts piper as a separate program, and the user downloads it
 *   from the upstream release (TeamBot does not redistribute it).
 * - Voices: only voices trained from scratch, or fine-tuned from such voices, on CC0 / CC-BY-4.0 / Apache-2.0 /
 *   BSD / public-domain data, with a clear licence on their own model card. Left out: voices fine-tuned from "lessac"
 *   (Blizzard 2013 data under a research-only licence) or "ryan" (RyanSpeech, CC-BY-NC-SA), voices whose card says
 *   only "see URL" or nothing about the training data, non-commercial licences (MMS-TTS, the OpenVoiceOS miro/dii
 *   voices: CC-BY-NC-ND) and OpenRAIL (Supertonic 3, use restrictions). M-AILABS voices count as public domain: the
 *   recordings are LibriVox (public domain) and M-AILABS allows any use, also commercial.
 *   Two engines (`voiceEngine`):
 *   - 'piper' (rhasspy/piper-voices and one community voice): run by the Piper program. Voices made with newer Piper
 *     versions may list phonemes of several characters, which Piper 2023.11.14-2 refuses; piper.ts then hands Piper a
 *     copy of the config without them. That is only safe where espeak-ng never produces those phonemes for the
 *     language (checked for Turkish: they are English diphthongs) — it_IT-serena and rdh stay out.
 *   - 'vits' (Coqui models by NeonGecko, ONNX by the sherpa-onnx project): character-based, so no espeak-ng at all;
 *     sherpa-onnx (already an npm dependency) runs them in the server process. They cannot read digits: TeamBot writes
 *     numbers out in words first (`spellNumbers`, numbers.ts).
 *   Result: a voice for every interface language except Arabic. Arabic has none that passes: the Piper voice
 *   ar_JO-kareem is a lessac fine-tune on data with "see URL" as licence; the free Arabic models (Nabra-82M) need a
 *   diacritiser and espeak-ng phonemes that this pipeline cannot supply without a new GPL helper. For Arabic the
 *   browser/system voice reads aloud.
 */

import { SPEECH_LANGS, recommendedStt, voicesFor } from '../../../../shared/voiceLanguage.js';

export const LICENCES_CHECKED = '2026-11-08';

/** 'call-part': the voice-activity and turn models of the free live call (duplex/catalog.ts, its own store). */
export type LocalKind = 'stt' | 'tts-runtime' | 'tts-voice' | 'call-part';

export interface LocalFile {
  /** Path inside the model directory. */
  path: string;
  url: string;
  sha256: string;
  size: number;
  /** Archive that is unpacked into the model directory after verification (then deleted). */
  extract?: 'zip' | 'tar.gz';
}

export interface LocalModel {
  id: string;
  kind: LocalKind;
  label: string;
  description: string;
  licence: string;
  licenceNote?: string;
  source: string;
  /** ISO 639-1 codes the model handles well ('*' = many). */
  languages: string[];
  files: LocalFile[];
  /** `${process.platform}-${process.arch}` values this entry is for (default: all). */
  platforms?: string[];
  // STT
  engine?: 'parakeet' | 'whisper';
  /** Rough decode time per 10 s of speech on a modern 8-core desktop CPU (measured, see docs/modules/voice.md). */
  speedHint?: string;
  // TTS voices
  lang?: string;
  sampleRate?: number;
  speakers?: { id: number; label: string }[];
  /**
   * How TeamBot runs the voice. 'piper' (default): the Piper program (needs the piper-runtime download; files
   * voice.onnx + voice.onnx.json). 'vits': sherpa-onnx in the server process (character-based VITS, no espeak-ng and
   * no extra program; files model.onnx + tokens.txt).
   */
  voiceEngine?: 'piper' | 'vits';
  /** Sampling noise [noise_scale, noise_w]; lower is clearer (and a little flatter). Default: the voice's own. */
  noise?: [number, number];
  /** The voice cannot read digits: numbers are written out in words first (numbers.ts). */
  spellNumbers?: boolean;
  /** STT: the best choice for the languages it lists; voices: the best voice for its language. */
  recommended?: boolean;
  /** Languages this model is the recommended choice for although it does not list them itself ('*' models). */
  recommendedFor?: string[];
}

const HF = 'https://huggingface.co';
const PARAKEET = `${HF}/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78`;
const TURBO = `${HF}/csukuangfj/sherpa-onnx-whisper-turbo/resolve/2ca6ff69fc878651b770880507669577ac41c2ff`;
export const VOICES_REVISION = 'e7229f7d33a10e145e109b886d661984201ac3c4';
const VOICES = `${HF}/rhasspy/piper-voices/resolve/${VOICES_REVISION}`;
const PIPER = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2';
const ANTALIA = `${HF}/ozgurguler/piper-tr-antalia-medium/resolve/4e510fcb99a1b9e63238e6d9a36686173d5d540c`;
const COQUI_PL = `${HF}/csukuangfj/vits-coqui-pl-mai_female/resolve/19e9a1a8e697491e5b9849f8f904584792d60fb8`;
const COQUI_PT = `${HF}/csukuangfj/vits-coqui-pt-cv/resolve/9092b0c5e3717b6c61ae563cfd98dc86cc536b3a`;
// Measured in a TTS → speech recognition round trip (docs/modules/voice.md): the default sampling noise doubled the
// errors of these three voices; 0.333 for both halves them.
const CLEAR: [number, number] = [0.333, 0.333];

/** Dutch defaults (also what users who set up TeamBot before other languages existed have stored). */
export const LOCAL_STT_DEFAULT = 'parakeet-tdt-0.6b-v3';
export const LOCAL_VOICE_DEFAULT = 'nl_NL-alex-medium';
export const LOCAL_VOICE_EN_DEFAULT = 'en_US-ljspeech-medium';
export const PIPER_RUNTIME = 'piper-runtime';

const PARAKEET_LANGS = ['nl', 'en', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'da', 'sv', 'fi', 'cs', 'sk', 'sl', 'hr', 'bg', 'el', 'et', 'hu', 'lv', 'lt', 'mt', 'ro', 'ru', 'uk'];

// Multi-speaker voices: of all speakers, these were understood best in a TTS → Parakeet round trip (6 sentences;
// German 2-5 % WER of 236 speakers, French 3-7 % of 125). Man/vrouw from the measured pitch.
const DE_SPEAKERS = [
  { id: 194, label: 'Spreker 194 (man)' },
  { id: 108, label: 'Spreker 108 (vrouw)' },
  { id: 231, label: 'Spreker 231 (man)' },
  { id: 78, label: 'Spreker 78 (vrouw)' },
  { id: 121, label: 'Spreker 121 (man)' },
];
const FR_SPEAKERS = [
  { id: 95, label: 'Spreker 95 (vrouw)' },
  { id: 42, label: 'Spreker 42 (man)' },
  { id: 86, label: 'Spreker 86 (vrouw)' },
  { id: 82, label: 'Spreker 82 (man)' },
  { id: 43, label: 'Spreker 43 (vrouw)' },
];

export const LOCAL_MODELS: LocalModel[] = [
  {
    id: 'parakeet-tdt-0.6b-v3',
    kind: 'stt',
    engine: 'parakeet',
    label: 'Parakeet v3 — snel, met leestekens (aanbevolen)',
    description: 'NVIDIA Parakeet TDT 0.6B v3 (int8). 25 Europese talen waaronder Nederlands en Engels; herkent de taal zelf en zet hoofdletters en leestekens.',
    licence: 'CC-BY-4.0',
    licenceNote: 'Model van NVIDIA (CC-BY-4.0), omgezet naar ONNX door het sherpa-onnx-project.',
    source: 'https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3',
    languages: PARAKEET_LANGS,
    speedHint: '≈ 0,5 s per 10 s spraak',
    recommended: true,
    files: [
      { path: 'encoder.int8.onnx', url: `${PARAKEET}/encoder.int8.onnx`, sha256: 'acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247', size: 652184281 },
      { path: 'decoder.int8.onnx', url: `${PARAKEET}/decoder.int8.onnx`, sha256: '179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e', size: 11845275 },
      { path: 'joiner.int8.onnx', url: `${PARAKEET}/joiner.int8.onnx`, sha256: '3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3', size: 6355277 },
      { path: 'tokens.txt', url: `${PARAKEET}/tokens.txt`, sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d', size: 93939 },
    ],
  },
  {
    id: 'whisper-large-v3-turbo',
    kind: 'stt',
    engine: 'whisper',
    label: 'Whisper large-v3 turbo — nauwkeuriger, trager, 99 talen',
    description: 'OpenAI Whisper large-v3 turbo (int8). Iets minder fouten met namen en getallen, maar ongeveer vijf keer trager dan Parakeet op de processor. Het lokale model voor Turks en Arabisch (die kent Parakeet niet).',
    licence: 'MIT',
    licenceNote: 'Model van OpenAI (MIT), omgezet naar ONNX door het sherpa-onnx-project.',
    source: 'https://huggingface.co/openai/whisper-large-v3-turbo',
    languages: ['*'],
    // Parakeet does not know Turkish or Arabic.
    recommendedFor: ['tr', 'ar'],
    speedHint: '≈ 2,6 s per 10 s spraak',
    files: [
      { path: 'turbo-encoder.int8.onnx', url: `${TURBO}/turbo-encoder.int8.onnx`, sha256: 'b02dcdf54f348741e93fe732b67d933c8dcb6735655f710640143081db38878b', size: 674716297 },
      { path: 'turbo-decoder.int8.onnx', url: `${TURBO}/turbo-decoder.int8.onnx`, sha256: '20accd02388482eb3a46bd615631adfdc85e1eb2c7db9ea3f02a40ffe6b81547', size: 361080764 },
      { path: 'turbo-tokens.txt', url: `${TURBO}/turbo-tokens.txt`, sha256: 'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126', size: 816730 },
    ],
  },
  {
    id: PIPER_RUNTIME,
    kind: 'tts-runtime',
    label: 'Piper (voorleesprogramma)',
    description: 'Piper zet tekst lokaal om in spraak. Draait als apart programma op deze computer.',
    licence: 'MIT',
    licenceNote: 'Piper is MIT. Het bevat espeak-ng (GPL-3.0) voor de uitspraak; TeamBot start Piper alleen als apart programma en levert het niet zelf mee.',
    source: 'https://github.com/rhasspy/piper/releases/tag/2023.11.14-2',
    languages: ['*'],
    platforms: ['win32-x64'],
    files: [{ path: 'piper_windows_amd64.zip', url: `${PIPER}/piper_windows_amd64.zip`, sha256: 'f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea', size: 22477236, extract: 'zip' }],
  },
  {
    id: PIPER_RUNTIME,
    kind: 'tts-runtime',
    label: 'Piper (voorleesprogramma)',
    description: 'Piper zet tekst lokaal om in spraak. Draait als apart programma op deze computer.',
    licence: 'MIT',
    licenceNote: 'Piper is MIT. Het bevat espeak-ng (GPL-3.0) voor de uitspraak; TeamBot start Piper alleen als apart programma en levert het niet zelf mee.',
    source: 'https://github.com/rhasspy/piper/releases/tag/2023.11.14-2',
    languages: ['*'],
    platforms: ['linux-x64'],
    files: [{ path: 'piper_linux_x86_64.tar.gz', url: `${PIPER}/piper_linux_x86_64.tar.gz`, sha256: 'a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992', size: 26460462, extract: 'tar.gz' }],
  },
  {
    id: PIPER_RUNTIME,
    kind: 'tts-runtime',
    label: 'Piper (voorleesprogramma)',
    description: 'Piper zet tekst lokaal om in spraak. Draait als apart programma op deze computer.',
    licence: 'MIT',
    licenceNote: 'Piper is MIT. Het bevat espeak-ng (GPL-3.0) voor de uitspraak; TeamBot start Piper alleen als apart programma en levert het niet zelf mee.',
    source: 'https://github.com/rhasspy/piper/releases/tag/2023.11.14-2',
    languages: ['*'],
    platforms: ['linux-arm64'],
    files: [{ path: 'piper_linux_aarch64.tar.gz', url: `${PIPER}/piper_linux_aarch64.tar.gz`, sha256: 'fea0fd2d87c54dbc7078d0f878289f404bd4d6eea6e7444a77835d1537ab88eb', size: 26004717, extract: 'tar.gz' }],
  },
  {
    id: 'nl_NL-alex-medium',
    kind: 'tts-voice',
    label: 'Alex (Nederlands, man)',
    description: 'Natuurlijke Nederlandse stem (Piper, medium).',
    licence: 'CC0-1.0',
    licenceNote: 'Dataset CC0 (OHF-Voice), verder getraind op de Vlaamse rdh-stem (dataset CC0, vanaf nul getraind).',
    source: 'https://huggingface.co/rhasspy/piper-voices/tree/main/nl/nl_NL/alex/medium',
    languages: ['nl'],
    lang: 'nl',
    sampleRate: 22050,
    recommended: true,
    files: [
      { path: 'voice.onnx', url: `${VOICES}/nl/nl_NL/alex/medium/nl_NL-alex-medium.onnx`, sha256: '22f0497c4d895a09fbc6a469459aa8954ea0955d3c6e19dbcc2e23acbb93e30b', size: 63531476 },
      { path: 'voice.onnx.json', url: `${VOICES}/nl/nl_NL/alex/medium/nl_NL-alex-medium.onnx.json`, sha256: '9ea643871742c038511b6aaf20e6fc098a78a11968122d2f6ca3e50403423f95', size: 4965 },
    ],
  },
  {
    id: 'nl_NL-mls-medium',
    kind: 'tts-voice',
    label: 'MLS (Nederlands, meerdere stemmen)',
    description: 'Nederlandse stemmen uit luisterboeken (Piper, medium). Kies per bot een andere spreker.',
    licence: 'CC-BY-4.0',
    licenceNote: 'Multilingual LibriSpeech (openslr 94), CC-BY-4.0; vanaf nul getraind.',
    source: 'https://huggingface.co/rhasspy/piper-voices/tree/main/nl/nl_NL/mls/medium',
    languages: ['nl'],
    lang: 'nl',
    sampleRate: 22050,
    // The 52 speakers differ a lot in clarity; these were best understood in a TTS → Parakeet round trip (2-5 % WER).
    speakers: [
      { id: 48, label: 'Spreker 48' },
      { id: 35, label: 'Spreker 35' },
      { id: 21, label: 'Spreker 21' },
      { id: 41, label: 'Spreker 41' },
      { id: 33, label: 'Spreker 33' },
    ],
    files: [
      { path: 'voice.onnx', url: `${VOICES}/nl/nl_NL/mls/medium/nl_NL-mls-medium.onnx`, sha256: '88312e0fbf505b87caf2373d94c1384892e86b1bf2ee482cf65dc8ba179cc7d3', size: 76584246 },
      { path: 'voice.onnx.json', url: `${VOICES}/nl/nl_NL/mls/medium/nl_NL-mls-medium.onnx.json`, sha256: '6ddb215d38f1392ab935ad45441b82ada1eeae0452a2d6849ed71ea4f2e0aa63', size: 5856 },
    ],
  },
  {
    id: 'en_US-ljspeech-medium',
    kind: 'tts-voice',
    label: 'LJ (Engels, vrouw)',
    description: 'Engelse stem voor Engelstalige antwoorden (Piper, medium).',
    licence: 'Public domain',
    licenceNote: 'LJ Speech-dataset (public domain), vanaf nul getraind.',
    source: 'https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/ljspeech/medium',
    languages: ['en'],
    lang: 'en',
    sampleRate: 22050,
    recommended: true,
    files: [
      { path: 'voice.onnx', url: `${VOICES}/en/en_US/ljspeech/medium/en_US-ljspeech-medium.onnx`, sha256: '6f52a751e2349abe7a76735eb09dc1875298c77ea2342ffd2fef79ff81b87f22', size: 63531379 },
      { path: 'voice.onnx.json', url: `${VOICES}/en/en_US/ljspeech/medium/en_US-ljspeech-medium.onnx.json`, sha256: '141d612cc0a95ed7efc1ca936b845c2364967f2e9217c5dbfcf69fc4d6c65860', size: 4972 },
    ],
  },
  {
    id: 'en_US-norman-medium',
    kind: 'tts-voice',
    label: 'Norman (Engels, man)',
    description: 'Engelse stem voor Engelstalige antwoorden (Piper, medium).',
    licence: 'Public domain',
    licenceNote: 'Opnamen van LibriVox (public domain), vanaf nul getraind.',
    source: 'https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/norman/medium',
    languages: ['en'],
    lang: 'en',
    sampleRate: 22050,
    files: [
      { path: 'voice.onnx', url: `${VOICES}/en/en_US/norman/medium/en_US-norman-medium.onnx`, sha256: 'b9739443232a80a59c7d18810dd856899bf16a7964725f5ab81ea49b1351cb71', size: 63531379 },
      { path: 'voice.onnx.json', url: `${VOICES}/en/en_US/norman/medium/en_US-norman-medium.onnx.json`, sha256: '6c2db7f558a4a8deb9fe822583c1c5105f6c4e834dd0f9de8ad17a888ee9fe1d', size: 4968 },
    ],
  },
  {
    id: 'de_DE-mls-medium',
    kind: 'tts-voice',
    label: 'MLS (Duits, meerdere stemmen)',
    description: 'Duitse stemmen uit luisterboeken (Piper, medium). Kies per bot een andere spreker.',
    licence: 'CC-BY-4.0',
    licenceNote: 'Multilingual LibriSpeech (openslr 94), CC-BY-4.0; vanaf nul getraind.',
    source: 'https://huggingface.co/rhasspy/piper-voices/tree/main/de/de_DE/mls/medium',
    languages: ['de'],
    lang: 'de',
    sampleRate: 22050,
    recommended: true,
    speakers: DE_SPEAKERS,
    files: [
      { path: 'voice.onnx', url: `${VOICES}/de/de_DE/mls/medium/de_DE-mls-medium.onnx`, sha256: '69cd1d2aa5a35839a518966fcc4924b5f93e5f8c948ed0752b1a616ad53f65bf', size: 76961079 },
      { path: 'voice.onnx.json', url: `${VOICES}/de/de_DE/mls/medium/de_DE-mls-medium.onnx.json`, sha256: 'b0af1c89ddfdc72d32e015729b0e89b99eec13c2c8caa1db7488d98e9e570b40', size: 8948 },
    ],
  },
  {
    id: 'fr_FR-mls-medium',
    kind: 'tts-voice',
    label: 'MLS (Frans, meerdere stemmen)',
    description: 'Franse stemmen uit luisterboeken (Piper, medium). Kies per bot een andere spreker.',
    licence: 'CC-BY-4.0',
    licenceNote: 'Multilingual LibriSpeech (openslr 94), CC-BY-4.0; vanaf nul getraind.',
    source: 'https://huggingface.co/rhasspy/piper-voices/tree/main/fr/fr_FR/mls/medium',
    languages: ['fr'],
    lang: 'fr',
    sampleRate: 22050,
    recommended: true,
    speakers: FR_SPEAKERS,
    files: [
      { path: 'voice.onnx', url: `${VOICES}/fr/fr_FR/mls/medium/fr_FR-mls-medium.onnx`, sha256: '0ed223f78466917f2bae05ee90096ce69ab1fdeb251f55590d0e7422d234e162', size: 76733750 },
      { path: 'voice.onnx.json', url: `${VOICES}/fr/fr_FR/mls/medium/fr_FR-mls-medium.onnx.json`, sha256: '252b0b0a6e4cc4949e23eccb956f9c779986c32f934f2f7e2191e5fdc2edca61', size: 7036 },
    ],
  },
  {
    id: 'es_ES-carlfm-x_low',
    kind: 'tts-voice',
    label: 'Carl (Spaans, man)',
    description: 'Spaanse stem (Piper, x-low: klein en snel, iets minder natuurlijk).',
    licence: 'Public domain',
    licenceNote: 'Dataset van carlfm01 (public domain), vanaf nul getraind.',
    source: 'https://huggingface.co/rhasspy/piper-voices/tree/main/es/es_ES/carlfm/x_low',
    languages: ['es'],
    lang: 'es',
    sampleRate: 16000,
    recommended: true,
    files: [
      { path: 'voice.onnx', url: `${VOICES}/es/es_ES/carlfm/x_low/es_ES-carlfm-x_low.onnx`, sha256: 'd69677323a907cd4963f42b29c20a98b5d6bfa7f3e64df339915e4650c00d125', size: 28130791 },
      { path: 'voice.onnx.json', url: `${VOICES}/es/es_ES/carlfm/x_low/es_ES-carlfm-x_low.onnx.json`, sha256: 'd9bdfa9ff01eb2bc9e62e7d2593939d1e4c4d8eb7cf75f972731539d12399966', size: 4159 },
    ],
  },
  {
    id: 'it_IT-riccardo-x_low',
    kind: 'tts-voice',
    label: 'Riccardo (Italiaans, man)',
    description: 'Italiaanse stem (Piper, x-low: klein en snel, iets minder natuurlijk).',
    licence: 'Public domain',
    licenceNote: 'M-AILABS-dataset: opnamen van LibriVox (public domain), vrij te gebruiken, ook commercieel; vanaf nul getraind.',
    source: 'https://huggingface.co/rhasspy/piper-voices/tree/main/it/it_IT/riccardo/x_low',
    languages: ['it'],
    lang: 'it',
    sampleRate: 16000,
    recommended: true,
    files: [
      { path: 'voice.onnx', url: `${VOICES}/it/it_IT/riccardo/x_low/it_IT-riccardo-x_low.onnx`, sha256: '1368de15f123275a7ef951c9e5e30be0f58a032daa14a0da44037443c1d1d21b', size: 28130791 },
      { path: 'voice.onnx.json', url: `${VOICES}/it/it_IT/riccardo/x_low/it_IT-riccardo-x_low.onnx.json`, sha256: '146ab9c634afe524e9fb7530f2510df7a42fb1db56b52658ca1fb3d98001a62a', size: 4161 },
    ],
  },
  {
    id: 'pt-cv-vits',
    kind: 'tts-voice',
    voiceEngine: 'vits',
    label: 'Common Voice (Portugees, man)',
    description: 'Portugese stem die in TeamBot zelf draait (VITS, geen apart programma nodig). Goed te verstaan, maar minder natuurlijk dan de andere stemmen. Getallen worden eerst in woorden omgezet.',
    licence: 'BSD-3-Clause',
    licenceNote: 'Model van NeonGecko (BSD-3-Clause), vanaf nul getraind op Mozilla Common Voice (CC0); omgezet naar ONNX door het sherpa-onnx-project.',
    source: 'https://huggingface.co/neongeckocom/tts-vits-cv-pt',
    languages: ['pt'],
    lang: 'pt',
    sampleRate: 22050,
    recommended: true,
    noise: CLEAR,
    spellNumbers: true,
    files: [
      { path: 'model.onnx', url: `${COQUI_PT}/model.onnx`, sha256: 'fcc22bb219ccda42df47546d0e9ea7b078b9c5a2ebf90ef7ec589c995ecbc736', size: 71024123 },
      { path: 'tokens.txt', url: `${COQUI_PT}/tokens.txt`, sha256: '4b4ba3385bf661b87735835de24365e25623d250be0621bc184dff050df4c2fb', size: 1410 },
    ],
  },
  {
    id: 'pl_PL-mai_female-vits',
    kind: 'tts-voice',
    voiceEngine: 'vits',
    label: 'M-AILABS (Pools, vrouw)',
    description: 'Poolse stem die in TeamBot zelf draait (VITS, geen apart programma nodig). Goed te verstaan, maar minder natuurlijk dan de andere stemmen. Getallen worden eerst in woorden omgezet.',
    licence: 'BSD-3-Clause',
    licenceNote: 'Model van NeonGecko (BSD-3-Clause), vanaf nul getraind op de vrouwenstem uit de M-AILABS-dataset (opnamen van LibriVox, public domain); omgezet naar ONNX door het sherpa-onnx-project.',
    source: 'https://huggingface.co/neongeckocom/tts-vits-mai-pl',
    languages: ['pl'],
    lang: 'pl',
    sampleRate: 22050,
    recommended: true,
    noise: CLEAR,
    spellNumbers: true,
    files: [
      { path: 'model.onnx', url: `${COQUI_PL}/model.onnx`, sha256: '74bd98e84c42961d58b3523ec2a9a98549480b23c3d9e8e1dd52e2f03eb00575', size: 71024119 },
      { path: 'tokens.txt', url: `${COQUI_PL}/tokens.txt`, sha256: '4b4ba3385bf661b87735835de24365e25623d250be0621bc184dff050df4c2fb', size: 1410 },
    ],
  },
  {
    id: 'tr_TR-antalia-medium',
    kind: 'tts-voice',
    label: 'Antalia (Turks, vrouw)',
    description: 'Turkse stem (Piper, medium), ingesproken door een professionele stemactrice.',
    licence: 'CC-BY-4.0',
    licenceNote:
      'Antalia-dataset van Patientdesk.ai (CC-BY-4.0; de stemactrice gaf toestemming voor openbaar gebruik), verder getraind op de LJ Speech-stem van Piper (public domain, vanaf nul getraind). Gebruik de stem nooit om iemand na te doen.',
    source: 'https://huggingface.co/ozgurguler/piper-tr-antalia-medium',
    languages: ['tr'],
    lang: 'tr',
    sampleRate: 22050,
    recommended: true,
    noise: CLEAR,
    files: [
      { path: 'voice.onnx', url: `${ANTALIA}/tr_TR-antalia-medium.onnx`, sha256: '8da26b23b8855ce9fcd600a8756dc2cbeed6f9014e899d90df637c899e03cdf4', size: 63516050 },
      { path: 'voice.onnx.json', url: `${ANTALIA}/tr_TR-antalia-medium.onnx.json`, sha256: 'e6ff7446c60e0f7e62fc972bd99f3c68a9f0a45ee48d3f508dcde764e8501f3f', size: 5259 },
    ],
  },
  {
    id: 'uk_UA-ukrainian_tts-medium',
    kind: 'tts-voice',
    label: 'Oekraïens (drie stemmen)',
    description: 'Oekraïense stemmen (Piper, medium). Kies per bot een andere spreker. Getallen in cijfers worden overgeslagen.',
    licence: 'CC0-1.0',
    licenceNote: 'Dataset CC0 (OHF-Voice), vanaf nul getraind.',
    source: 'https://huggingface.co/rhasspy/piper-voices/tree/main/uk/uk_UA/ukrainian_tts/medium',
    languages: ['uk'],
    lang: 'uk',
    sampleRate: 22050,
    recommended: true,
    speakers: [
      { id: 0, label: 'Lada (vrouw)' },
      { id: 2, label: 'Tetiana (vrouw)' },
      { id: 1, label: 'Mykyta (man)' },
    ],
    files: [
      { path: 'voice.onnx', url: `${VOICES}/uk/uk_UA/ukrainian_tts/medium/uk_UA-ukrainian_tts-medium.onnx`, sha256: '7920419ac5f6fd8b6450520f24b52ed5a319cb53dd018fbcd71c9e079cbac84f', size: 76735663 },
      { path: 'voice.onnx.json', url: `${VOICES}/uk/uk_UA/ukrainian_tts/medium/uk_UA-ukrainian_tts-medium.onnx.json`, sha256: '4e96e72917ca9b94edc77d6ccfee03a73f450ba2fc1ca93c2e562bc014e5aa55', size: 2002 },
    ],
  },
];

export const platformKey = () => `${process.platform}-${process.arch}`;

/** Catalog entries for this platform (one entry per id). */
export function catalogFor(list: LocalModel[] = LOCAL_MODELS, platform = platformKey()): LocalModel[] {
  const out = new Map<string, LocalModel>();
  for (const m of list) if (!m.platforms || m.platforms.includes(platform)) if (!out.has(m.id)) out.set(m.id, m);
  // Ids that exist only for other platforms: listed as unsupported.
  for (const m of list) if (!out.has(m.id)) out.set(m.id, { ...m, files: [] });
  return [...out.values()];
}

export const totalSize = (m: LocalModel) => m.files.reduce((n, f) => n + f.size, 0);

/** The engine that runs a voice (Piper unless the catalog says otherwise). */
export const voiceEngineOf = (m: Pick<LocalModel, 'voiceEngine'>): 'piper' | 'vits' => m.voiceEngine || 'piper';

/** Does this model need the Piper program (a Piper voice)? */
export const needsPiper = (m: Pick<LocalModel, 'kind' | 'voiceEngine'>) => m.kind === 'tts-voice' && voiceEngineOf(m) === 'piper';

/** The recommended local speech recognition model for a language (Parakeet, or Whisper for Turkish and Arabic). */
export const recommendedSttId = (lang: string, list: LocalModel[] = LOCAL_MODELS): string => recommendedStt(lang, list)?.id || LOCAL_STT_DEFAULT;

/** Local voices for a language, the recommended one first ([] = none yet: the browser/system voice reads aloud). */
export const recommendedVoices = (lang: string, list: LocalModel[] = LOCAL_MODELS): string[] => voicesFor(lang, list).map((m) => m.id);

/** Languages of the interface that have no free local voice (yet). */
export const languagesWithoutVoice = (list: LocalModel[] = LOCAL_MODELS) => SPEECH_LANGS.filter((l) => !voicesFor(l, list).length);
