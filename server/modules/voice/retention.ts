import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../../core/types.js';
import { getSettings } from './settings.js';

const rm = (p: string | null | undefined) => {
  if (!p) return;
  try {
    fs.rmSync(p, { force: true });
  } catch {
    /* ignore */
  }
};

/** Delete one voice-memo audio file everywhere it lives (attachment store + copies in bot workspaces). */
export function deleteClipAudio(ctx: Ctx, attachmentId: string) {
  const att = ctx.store.get<any>('attachments', attachmentId);
  if (att) {
    rm(att.path);
    const copyName = `${att.id.slice(-6)}-${String(att.name).replace(/[^\w.\- ]+/g, '_')}`;
    for (const a of ctx.store.agents(att.user_id, { archived: true })) rm(path.join(a.workspace, 'uploads', copyName));
    ctx.store.remove('attachments', att.id);
  }
  ctx.store.exec('UPDATE voice_clips SET audio_deleted = 1 WHERE attachment_id = ?', attachmentId);
}

export function deleteTtsRows(ctx: Ctx, rows: { id: string; path: string }[]) {
  for (const r of rows) {
    rm(r.path);
    ctx.store.exec('DELETE FROM voice_tts WHERE id = ?', r.id);
  }
  return rows.length;
}

/** Apply each user's retention settings. Safe to run often. */
export function runRetention(ctx: Ctx, onlyUser?: string): { tts: number; audio: number } {
  let tts = 0;
  let audio = 0;
  const users = onlyUser
    ? [onlyUser]
    : ctx.store.all<{ user_id: string }>('SELECT user_id FROM voice_tts UNION SELECT user_id FROM voice_clips').map((r) => r.user_id);
  for (const userId of users) {
    const s = getSettings(ctx, userId);
    const ttsCut = new Date(Date.now() - s.ttsCacheDays * 864e5).toISOString();
    tts += deleteTtsRows(ctx, ctx.store.all('SELECT id, path FROM voice_tts WHERE user_id = ? AND last_used_at < ?', userId, ttsCut));
    // Spoken versions of deleted messages are useless and should not linger.
    tts += deleteTtsRows(
      ctx,
      ctx.store.all('SELECT v.id, v.path FROM voice_tts v LEFT JOIN messages m ON m.id = v.message_id WHERE v.user_id = ? AND v.message_id IS NOT NULL AND (m.id IS NULL OR m.deleted = 1)', userId),
    );
    if (s.audioDays > 0) {
      const cut = new Date(Date.now() - s.audioDays * 864e5).toISOString();
      for (const c of ctx.store.all<{ attachment_id: string }>('SELECT attachment_id FROM voice_clips WHERE user_id = ? AND audio_deleted = 0 AND created_at < ?', userId, cut)) {
        deleteClipAudio(ctx, c.attachment_id);
        audio++;
      }
    }
  }
  return { tts, audio };
}
