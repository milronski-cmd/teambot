/**
 * Dictation for the desktop shell's global hotkey: the shell captures 16 kHz PCM (its own small overlay window) and
 * pushes it here in-process. Local engine: the same live dictation session as the composer (text while you talk,
 * only the last stretch is recognised after you stop). Provider engine: one WAV upload at the end.
 */
import type { Ctx } from '../../core/types.js';
import { HttpError } from '../../core/http.js';
import { pcmToWav, checkAudio } from './audio.js';
import { getSettings } from './settings.js';
import { transcribe } from './stt.js';
import { localVoice } from './local/service.js';
import { STT_RATE } from './local/pcm.js';

export interface HotkeyDictation {
  engine: 'local' | 'provider';
  /** 16-bit mono PCM at 16 kHz; returns the text so far (local engine only, else ''). */
  push(pcm: Buffer): { text: string };
  end(): Promise<{ text: string; seconds: number }>;
  cancel(): void;
}

const MAX_BYTES = 10 * 60 * STT_RATE * 2;

/** Throws an Error with a Dutch reason when dictation is not possible right now (e.g. model not downloaded). */
export function openDictation(ctx: Ctx, userId: string): HotkeyDictation {
  const user = ctx.store.user(userId);
  if (!user) throw new Error('Onbekende gebruiker');
  const s = getSettings(ctx, userId);
  const lv = localVoice(ctx);
  // The browser engine cannot work outside the browser: use the free local one when it is there.
  const local = s.stt.engine === 'local' || (s.stt.engine === 'browser' && !lv.sttProblem(s.stt.localModel));
  if (local) {
    const problem = lv.sttProblem(s.stt.localModel);
    if (problem) throw new HttpError(409, problem, 'voice_local_missing');
    const sess = lv.sessions.open(userId, s.stt.localModel, s.stt.language, null);
    let closed = false;
    return {
      engine: 'local',
      push: (pcm) => ({ text: closed ? '' : sess.push(pcm).text }),
      async end() {
        if (closed) return { text: '', seconds: 0 };
        closed = true;
        try {
          const r = await sess.end();
          return { text: r.text, seconds: r.seconds };
        } finally {
          lv.sessions.close(sess.id);
        }
      },
      cancel() {
        closed = true;
        lv.sessions.close(sess.id);
      },
    };
  }
  if (s.stt.engine === 'browser') throw new Error('Dicteren met de sneltoets werkt met de gratis lokale spraakherkenning of een spraakprovider (Instellingen › Spraak).');
  const parts: Buffer[] = [];
  let bytes = 0;
  let closed = false;
  return {
    engine: 'provider',
    push(pcm) {
      if (!closed && bytes + pcm.length <= MAX_BYTES) (parts.push(Buffer.from(pcm)), (bytes += pcm.length));
      return { text: '' };
    },
    async end() {
      closed = true;
      const seconds = bytes / 2 / STT_RATE;
      if (seconds < 0.3) return { text: '', seconds };
      const wav = pcmToWav(Buffer.concat(parts), STT_RATE);
      const r = await transcribe(ctx, user, wav, checkAudio(wav, 'audio/wav'), { durationMs: seconds * 1000 });
      return { text: r.text, seconds };
    },
    cancel() {
      closed = true;
      parts.length = 0;
    },
  };
}
