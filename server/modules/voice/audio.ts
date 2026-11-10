/** Audio helpers: upload validation, speakable text, chunking and captions. */
import { tr } from '../../core/i18n.js';

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // OpenAI file transcription limit
export const MAX_TTS_CHARS = 12_000;
export const TTS_CHUNK = 4000; // /audio/speech accepts max 4096 characters

type Container = 'webm' | 'ogg' | 'mp4' | 'mp3' | 'wav' | 'flac';

const MIME_FAMILY: Record<string, Container> = {
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/ogg': 'ogg',
  'application/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mp4': 'mp4',
  'audio/m4a': 'mp4',
  'audio/x-m4a': 'mp4',
  'video/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/aac': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
};

const EXT: Record<Container, string> = { webm: 'webm', ogg: 'ogg', mp4: 'm4a', mp3: 'mp3', wav: 'wav', flac: 'flac' };

/** Detect the container from magic bytes. */
export function sniff(buf: Buffer): Container | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
  if (buf.toString('latin1', 0, 4) === 'OggS') return 'ogg';
  if (buf.toString('latin1', 4, 8) === 'ftyp') return 'mp4';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WAVE') return 'wav';
  if (buf.toString('latin1', 0, 4) === 'fLaC') return 'flac';
  if (buf.toString('latin1', 0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return 'mp3';
  return null;
}

export interface CheckedAudio {
  mime: string;
  ext: string;
  container: Container;
}

/** Validate declared mime type + actual content. Throws a message suitable for a 415 response. */
export function checkAudio(buf: Buffer, declared: string | undefined): CheckedAudio {
  const mime = String(declared || '').split(';')[0].trim().toLowerCase();
  const family = MIME_FAMILY[mime];
  if (!family) throw new Error(`Bestandstype ${mime || '(onbekend)'} wordt niet ondersteund. Gebruik webm, ogg, m4a/mp4, mp3, wav of flac.`);
  const real = sniff(buf);
  if (!real) throw new Error('Dit lijkt geen geldig audiobestand te zijn.');
  if (real !== family && !(family === 'mp3' && real === 'mp3')) throw new Error(`Het bestandstype (${mime}) klopt niet met de inhoud (${real}).`);
  return { mime, ext: EXT[real], container: real };
}

const SNIFFED_MIME: Record<Container, string> = { webm: 'audio/webm', ogg: 'audio/ogg', mp4: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac' };

/** Like checkAudio, but a missing/generic declared type (files from channels) is taken from the content. */
export function checkAudioLoose(buf: Buffer, declared: string | undefined): CheckedAudio {
  const mime = String(declared || '').split(';')[0].trim().toLowerCase();
  if (!mime || mime === 'application/octet-stream' || mime === 'binary/octet-stream') {
    const real = sniff(buf);
    if (real) return checkAudio(buf, SNIFFED_MIME[real]);
  }
  return checkAudio(buf, declared);
}

/** Markdown/chat text → something pleasant to listen to. `lang`: the user's language for the few words TeamBot adds. */
export function speakable(md: string, lang = 'nl'): string {
  let t = String(md || '');
  t = t.replace(/```[\s\S]*?```/g, ` ${tr(lang, '(codevoorbeeld overgeslagen)')} `);
  t = t.replace(/`([^`]+)`/g, '$1');
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, '$1');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/https?:\/\/\S+/g, tr(lang, 'link'));
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  t = t.replace(/^\s*>\s?/gm, '');
  t = t.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, '');
  t = t.replace(/^\s*[-*+]\s+/gm, '');
  t = t.replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, '');
  t = t.replace(/\|/g, ', ');
  t = t.replace(/(\*\*|__|~~)(.+?)\1/g, '$2');
  t = t.replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?:;]|$)/g, '$1$2');
  t = t.replace(/\n{2,}/g, '.\n').replace(/\.\.\n/g, '.\n');
  t = t.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  return t;
}

/** Split into chunks of at most `max` characters on sentence boundaries. */
export function chunkText(text: string, max = TTS_CHUNK): string[] {
  const out: string[] = [];
  let cur = '';
  const sentences = text.split(/(?<=[.!?…])\s+|\n+/).filter((s) => s.trim());
  for (let s of sentences) {
    while (s.length > max) {
      const cut = s.lastIndexOf(' ', max) > max / 2 ? s.lastIndexOf(' ', max) : max;
      if (cur) (out.push(cur), (cur = ''));
      out.push(s.slice(0, cut).trim());
      s = s.slice(cut).trim();
    }
    if ((cur + ' ' + s).trim().length > max) {
      out.push(cur.trim());
      cur = s;
    } else cur = (cur + ' ' + s).trim();
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export interface Segment {
  start: number;
  end: number;
  text: string;
}

/** Sentence-level captions with times spread proportionally over the duration (marked as estimated in the UI). */
export function estimateSegments(text: string, durationSec: number | null): Segment[] {
  const parts = String(text || '')
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return [];
  const total = parts.reduce((n, p) => n + p.length, 0) || 1;
  const dur = durationSec && durationSec > 0 ? durationSec : total / 15;
  let t = 0;
  return parts.map((p) => {
    const d = (p.length / total) * dur;
    const seg = { start: round3(t), end: round3(t + d), text: p };
    t += d;
    return seg;
  });
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

function ts(sec: number) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(r).padStart(3, '0')}`;
}

export function toVtt(segments: Segment[]): string {
  const lines = ['WEBVTT', ''];
  segments.forEach((s, i) => {
    lines.push(String(i + 1), `${ts(s.start)} --> ${ts(Math.max(s.end, s.start + 0.2))}`, s.text.replace(/-->/g, '→'), '');
  });
  return lines.join('\n');
}

/** Wrap raw 16-bit little-endian mono PCM in a WAV header. */
export function pcmToWav(pcm: Buffer, sampleRate = 24000): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1');
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
