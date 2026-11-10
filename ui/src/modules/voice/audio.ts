/** Browser audio helpers: microphone, recording, level meter, voice activity detection, local speech. */
import { getLang } from '../../lib/i18n';
import { baseLang, speechLocale, sttSingleLanguage } from './language';
import { MIC_CONSTRAINTS } from './mic';

export const isIOS = () => typeof navigator !== 'undefined' && (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

export function micProblem(): string | null {
  if (typeof window === 'undefined') return 'Geen browser';
  if (!window.isSecureContext)
    return 'De microfoon werkt alleen via https of op deze computer (localhost). Open TeamBot op je telefoon via het https-adres (Tailscale, zie Instellingen › Telefoon) om te praten.';
  if (!navigator.mediaDevices?.getUserMedia) return 'Deze browser geeft geen toegang tot de microfoon.';
  return null;
}

export function recorderSupported() {
  return typeof MediaRecorder !== 'undefined' && !micProblem();
}

// With echo cancellation, noise suppression and automatic gain, always (mic.ts).
export { MIC_CONSTRAINTS, echoCancellationActive } from './mic';

/** Ask for the microphone. Only ever called right after an explicit tap. */
export async function openMic(): Promise<MediaStream> {
  const p = micProblem();
  if (p) throw new Error(p);
  try {
    return await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
  } catch (e: any) {
    if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError')
      throw new Error(
        isIOS()
          ? 'Toegang tot de microfoon is geweigerd. Op de iPhone: tik in Safari op "aA" › Website-instellingen › Microfoon › Sta toe (of Instellingen › Apps › Safari › Microfoon). Bij een app op het beginscherm vraagt iOS het opnieuw na het openen; tik dan op Sta toe.'
          : 'Toegang tot de microfoon is geweigerd. Sta de microfoon toe in je browser- of systeeminstellingen en probeer opnieuw.',
      );
    if (e?.name === 'NotFoundError') throw new Error('Geen microfoon gevonden.');
    throw new Error('Microfoon openen mislukt: ' + (e?.message || e));
  }
}

export function closeMic(stream: MediaStream | null | undefined) {
  stream?.getTracks().forEach((t) => t.stop());
}

function pickMime(): string {
  const c = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];
  for (const m of c) if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(m)) return m;
  return '';
}

/** One recording. stop() resolves with the audio blob. */
export class Recording {
  private rec: MediaRecorder;
  private chunks: Blob[] = [];
  private started = performance.now();
  private done: Promise<Blob>;
  constructor(stream: MediaStream) {
    const mime = pickMime();
    this.rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    this.done = new Promise((resolve) => {
      this.rec.onstop = () => resolve(new Blob(this.chunks, { type: (this.rec.mimeType || mime || 'audio/webm').split(';')[0] }));
    });
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start(250);
  }
  get ms() {
    return performance.now() - this.started;
  }
  async stop(): Promise<{ blob: Blob; durationMs: number }> {
    const durationMs = this.ms;
    if (this.rec.state !== 'inactive') this.rec.stop();
    return { blob: await this.done, durationMs };
  }
  cancel() {
    this.chunks = [];
    if (this.rec.state !== 'inactive') this.rec.stop();
  }
}

/** RMS input level 0..1 for the recording indicator and the energy VAD. */
export class LevelMeter {
  private ctx: AudioContext;
  private an: AnalyserNode;
  private buf: Float32Array<ArrayBuffer>;
  constructor(stream: MediaStream) {
    const AC: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
    this.ctx = new AC();
    const src = this.ctx.createMediaStreamSource(stream);
    this.an = this.ctx.createAnalyser();
    this.an.fftSize = 1024;
    src.connect(this.an);
    this.buf = new Float32Array(new ArrayBuffer(this.an.fftSize * 4));
  }
  level(): number {
    this.an.getFloatTimeDomainData(this.buf);
    let s = 0;
    for (let i = 0; i < this.buf.length; i++) s += this.buf[i] * this.buf[i];
    return Math.sqrt(s / this.buf.length);
  }
  close() {
    this.ctx.close().catch(() => {});
  }
}

export { EnergyVad } from './vad';

// ---------- Browser speech recognition (Web Speech API) ----------

export function browserSttSupported(): boolean {
  return typeof window !== 'undefined' && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
}

export const browserSttNote =
  'Spraakherkenning van de browser: in Chrome gaat de audio naar Google, in Safari naar Apple (of op het apparaat), in Edge naar Microsoft. Werkt niet in de desktop-app.';

/** The browser engine needs one language: a fixed choice, else the interface language ('auto-nl': Dutch). */
export const browserSttLocale = (setting: string) => speechLocale(sttSingleLanguage(setting, getLang()));

/** Recognise one utterance with the browser engine. `lang`: the dictation language setting (or a locale). */
export function recognizeOnce(lang: string, onPartial?: (t: string) => void, continuous = true): { result: Promise<string>; stop(): void; abort(): void } {
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  const r = new SR();
  r.lang = browserSttLocale(lang);
  r.interimResults = true;
  r.continuous = continuous;
  let finalText = '';
  let aborted = false;
  const result = new Promise<string>((resolve, reject) => {
    r.onresult = (e: any) => {
      let interim = '';
      finalText = '';
      for (let i = 0; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      onPartial?.((finalText + ' ' + interim).trim());
    };
    r.onerror = (e: any) => {
      if (aborted || e.error === 'aborted' || e.error === 'no-speech') return;
      reject(new Error(e.error === 'not-allowed' ? 'Microfoon of spraakherkenning geweigerd' : e.error === 'network' ? 'Browser-spraakherkenning niet beschikbaar (netwerk/dienst). Kies een spraakprovider in Instellingen › Spraak.' : `Spraakherkenning: ${e.error}`));
    };
    r.onend = () => resolve(aborted ? '' : finalText.trim());
  });
  r.start();
  return {
    result,
    stop: () => r.stop(),
    abort: () => {
      aborted = true;
      r.abort();
    },
  };
}

// ---------- Browser speech synthesis (free, local) ----------

export function browserTtsSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

export function browserVoices(): SpeechSynthesisVoice[] {
  if (!browserTtsSupported()) return [];
  return speechSynthesis.getVoices();
}

/** Voices load asynchronously in Chrome. */
export function onVoicesChanged(cb: () => void): () => void {
  if (!browserTtsSupported()) return () => {};
  speechSynthesis.addEventListener('voiceschanged', cb);
  return () => speechSynthesis.removeEventListener('voiceschanged', cb);
}

/** Browser voices for a language, the best first: on-device voices before online ones, the exact locale first. */
export function browserVoicesFor(lang: string, all = browserVoices()): SpeechSynthesisVoice[] {
  const base = baseLang(lang);
  const loc = speechLocale(lang).toLowerCase();
  const rank = (v: SpeechSynthesisVoice) => (v.localService ? 0 : 2) + (v.lang.replace('_', '-').toLowerCase() === loc ? 0 : 1);
  return all.filter((v) => baseLang(v.lang) === base).sort((a, b) => rank(a) - rank(b));
}

/**
 * The browser voice for a text in `lang`: the chosen voice when it speaks that language (or when there is none for
 * it), else the best voice for the language.
 */
function chooseVoice(name: string, lang: string): SpeechSynthesisVoice | undefined {
  const all = browserVoices();
  const chosen = all.find((v) => v.name === name);
  const forLang = browserVoicesFor(lang, all);
  if (chosen && (baseLang(chosen.lang) === baseLang(lang) || !forLang.length)) return chosen;
  return forLang[0] || chosen;
}

/**
 * Speak text locally; resolves when finished or cancelled. Long texts are queued per sentence (Chrome cuts long
 * utterances). `lang`: the language of the text (the server guesses it with /voice/speak; default: the interface
 * language).
 */
export function speakLocal(text: string, o: { voice?: string; rate?: number; lang?: string | null } = {}): Promise<void> {
  if (!browserTtsSupported()) return Promise.reject(new Error('Deze browser kan niet voorlezen'));
  speechSynthesis.cancel();
  const lang = o.lang || getLang();
  const voice = chooseVoice(o.voice || '', lang);
  const parts = text.split(/(?<=[.!?…])\s+|\n+/).filter((p) => p.trim());
  return new Promise((resolve) => {
    if (!parts.length) return resolve();
    let left = parts.length;
    for (const p of parts) {
      const u = new SpeechSynthesisUtterance(p);
      if (voice) (u.voice = voice), (u.lang = voice.lang);
      else u.lang = speechLocale(lang);
      u.rate = Math.min(2, Math.max(0.5, o.rate || 1));
      u.onend = u.onerror = () => {
        if (--left <= 0) resolve();
      };
      speechSynthesis.speak(u);
    }
  });
}

export function stopLocal() {
  if (browserTtsSupported()) speechSynthesis.cancel();
}

export { plainForSpeech } from './speechText';
