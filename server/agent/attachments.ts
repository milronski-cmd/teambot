/**
 * Attachments a bot cannot read as they are, made readable once, before its turn starts:
 *  - a .zip is unpacked next to it in the bot's workspace (limits on size and count, every path kept inside the folder);
 *  - an audio file is written out with the speech recognition on this computer (never a paid service, unless the
 *    owner chose that for attachments: voice module, transcribeAttachment), and a video's sound too where
 *    that engine takes the container (mp4, webm). TeamBot has no video decoder, so a video's picture is not read;
 *  - the text on an image, only for a model that cannot look at images (readImageText, from agent/chat-loop.ts).
 * The results are plain files beside the upload ("…-uitgepakt/", "….tekst.txt"), so they are made once, every engine
 * (API and CLI) finds them, and agent/history.ts only has to look whether they are there.
 */
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import type { Agent, AttachmentRef, Ctx, Message } from '../core/types.js';
import { isInside } from '../tools/builtin/files.js';

export function attachmentRows(ctx: Ctx, refs: AttachmentRef[] | undefined): any[] {
  if (!refs?.length) return [];
  return refs.map((r) => ctx.store.get<any>('attachments', r.id)).filter(Boolean);
}

/** Copy an uploaded attachment into the agent's workspace so file tools/CLI agents can use it. */
export function ensureInWorkspace(agent: Agent, att: any): string | null {
  try {
    const dir = path.join(agent.workspace, 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${att.id.slice(-6)}-${att.name.replace(/[^\w.\- ]+/g, '_')}`);
    if (!fs.existsSync(dest) && fs.existsSync(att.path)) fs.copyFileSync(att.path, dest);
    return dest;
  } catch {
    return null;
  }
}

export interface ZipLimits {
  zipBytes: number;
  files: number;
  fileBytes: number;
  totalBytes: number;
}
export const ZIP_LIMITS: ZipLimits = { zipBytes: 100 * 1024 * 1024, files: 500, fileBytes: 50 * 1024 * 1024, totalBytes: 200 * 1024 * 1024 };
/** What speech-to-text takes in one go (the file limit of the transcription APIs). */
const MAX_SPOKEN_BYTES = 25 * 1024 * 1024;
const MAX_TRANSCRIPT_CHARS = 60_000;

const OFFICE = /\.(docx|xlsx|pptx|odt|ods|odp|epub|jar|apk)$/i;
export const isZip = (a: { name: string; mime: string }) => (/\.zip$/i.test(a.name) || /^application\/(zip|x-zip-compressed)$/.test(a.mime)) && !OFFICE.test(a.name);
export const isAudio = (a: { name: string; mime: string }) => /^audio\//.test(a.mime) || /\.(mp3|wav|m4a|ogg|oga|opus|flac|weba)$/i.test(a.name);
export const isVideo = (a: { name: string; mime: string }) => /^video\//.test(a.mime) || /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(a.name);
export const isImage = (a: { name: string; mime: string }) => /^image\//.test(a.mime) || /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(a.name);

/** Where the unpacked files of an uploaded zip live, and where the written-out sound of an audio or video file is. */
export const unpackedDir = (upload: string) => `${upload}-uitgepakt`;
export const transcriptFile = (upload: string) => `${upload}.tekst.txt`;

export interface UnpackResult {
  files: string[];
  /** Entries left out, with the reason in words (too many, too large, a path outside the folder). */
  skipped: string[];
}

/**
 * Unpack a zip into `dest`. Nothing is ever written outside `dest`: an entry with an absolute path, a drive letter or
 * ".." is left out, and so is anything past the limits (a zip bomb stops at the first entry that is larger than it
 * says, or at the total). Entries are written as ordinary files; links in the archive are not followed or made.
 */
export function unpackZip(zipPath: string, dest: string, limits: ZipLimits = ZIP_LIMITS): UnpackResult {
  const out: UnpackResult = { files: [], skipped: [] };
  if (fs.statSync(zipPath).size > limits.zipBytes) throw new Error('het zip-bestand is te groot om uit te pakken');
  const zip = new AdmZip(zipPath);
  let total = 0;
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const name = e.entryName.replace(/\\/g, '/');
    const target = path.resolve(dest, name);
    if (!name || name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.split('/').includes('..') || !isInside(target, dest)) {
      out.skipped.push(`${name.slice(0, 80)} (pad buiten de map)`);
      continue;
    }
    if (out.files.length >= limits.files) {
      out.skipped.push(`${name.slice(0, 80)} (meer dan ${limits.files} bestanden)`);
      continue;
    }
    // The size the archive declares, before inflating; the real size after (a wrong declaration is a bomb).
    const declared = Number(e.header.size) || 0;
    if (declared > limits.fileBytes || total + declared > limits.totalBytes) {
      out.skipped.push(`${name.slice(0, 80)} (te groot)`);
      continue;
    }
    const data = e.getData();
    if (data.length > limits.fileBytes || total + data.length > limits.totalBytes) {
      out.skipped.push(`${name.slice(0, 80)} (te groot)`);
      continue;
    }
    total += data.length;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    out.files.push(name);
  }
  return out;
}

/** The files of an unpacked zip, relative to its folder (for the note the bot reads). */
export function listUnpacked(dir: string, max = 40): { names: string[]; total: number } {
  const names: string[] = [];
  let total = 0;
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (++total <= max) names.push(r);
    }
  };
  try {
    walk(dir, '');
  } catch {
    /* gone meanwhile */
  }
  return { names, total };
}

/**
 * Make the attachments of this message readable for the bot (see the top of this file). Runs before the turn; never
 * fails the turn: what cannot be unpacked or written out stays an ordinary attachment, and the log says why.
 */
export async function prepareAttachments(ctx: Ctx, agent: Agent, userId: string, m: Message | null | undefined, signal?: AbortSignal): Promise<void> {
  // A voice memo is its own transcript (history.ts): nothing to write out again.
  const memo = !!m?.parts?.voice || (m?.content || "").includes("[Spraakbericht, automatisch uitgeschreven");
  for (const a of attachmentRows(ctx, m?.parts?.attachments)) {
    const local = ensureInWorkspace(agent, a);
    if (!local || !fs.existsSync(local)) continue;
    try {
      if (isZip(a)) {
        const dir = unpackedDir(local);
        if (fs.existsSync(dir)) continue;
        const tmp = `${dir}.bezig`;
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.mkdirSync(tmp, { recursive: true });
        try {
          const r = unpackZip(local, tmp);
          if (r.skipped.length) fs.writeFileSync(path.join(tmp, '_NIET_UITGEPAKT.txt'), r.skipped.join('\n') + '\n');
          fs.renameSync(tmp, dir);
        } catch (e) {
          fs.rmSync(tmp, { recursive: true, force: true });
          throw e;
        }
      } else if ((isAudio(a) && !memo) || isVideo(a)) {
        const file = transcriptFile(local);
        const voice = ctx.services.voice;
        if (fs.existsSync(file) || typeof voice?.transcribeAttachment !== 'function' || a.size > MAX_SPOKEN_BYTES) continue;
        // A video goes in without a declared type: the engine takes it when it knows the container (mp4, webm).
        const r = await voice.transcribeAttachment(userId, fs.readFileSync(local), isAudio(a) ? a.mime : '', { agentId: agent.id, signal });
        const text = String(r?.text || '').trim();
        if (text) fs.writeFileSync(file, text.slice(0, MAX_TRANSCRIPT_CHARS));
      }
    } catch (e: any) {
      ctx.log.warn(`[bijlage] ${a.name}: ${String(e?.message || e).split('\n')[0].slice(0, 200)}`);
    }
  }
}

/**
 * The text on the images of this message, for a model that cannot look at images (agent/chat-loop.ts): read once with
 * the text recognition on this computer (the OCR of read_document, which fetches its language data itself the first
 * time) and kept beside the upload, like the words of an audio file. Never fails the turn: an image that could not be
 * read stays an image the bot is told it cannot see (history.ts).
 */
export async function readImageText(ctx: Ctx, agent: Agent, m: Message | null | undefined, signal?: AbortSignal): Promise<void> {
  const ocr = ctx.services.ocr;
  for (const a of attachmentRows(ctx, m?.parts?.attachments)) {
    if (!isImage(a) || signal?.aborted) continue;
    const local = ensureInWorkspace(agent, a);
    if (!local || !fs.existsSync(local) || fs.existsSync(transcriptFile(local))) continue;
    try {
      if (!ocr || !(await ocr.ensure())) {
        ctx.log.warn(`[bijlage] ${a.name}: tekst op de afbeelding niet gelezen. ${ocr?.problem?.() || 'Geen tekstherkenning.'}`);
        return;
      }
      const text = String((await ocr.recognize(fs.readFileSync(local))) || '').trim();
      fs.writeFileSync(transcriptFile(local), text.slice(0, MAX_TRANSCRIPT_CHARS));
    } catch (e: any) {
      ctx.log.warn(`[bijlage] ${a.name}: ${String(e?.message || e).split('\n')[0].slice(0, 200)}`);
    }
  }
}

/**
 * What the bot reads about an attachment that was made readable (null: it was not): the files of an unpacked zip,
 * what was said in an audio or video file, or the text on an image (readImageText). That text is data, like any
 * attachment.
 */
export function preparedNote(agent: Agent, a: { name: string; mime: string; size: number }, local: string | null): string | null {
  if (!local) return null;
  if (isZip(a) && fs.existsSync(unpackedDir(local))) {
    const dir = unpackedDir(local);
    const { names, total } = listUnpacked(dir);
    const list = names.filter((n) => n !== '_NIET_UITGEPAKT.txt');
    const left = names.length !== list.length ? ' Niet alles is uitgepakt: zie _NIET_UITGEPAKT.txt in die map.' : '';
    const count = total - (names.length - list.length);
    return `[bijlage: ${a.name} (zip, ${Math.round(a.size / 1024)} kB) — uitgepakt in je werkmap in de map ${path.relative(agent.workspace, dir)} (${count} bestanden): ${list.join(', ')}${total > names.length ? ', …' : ''}.${left}]`;
  }
  if ((isAudio(a) || isVideo(a) || isImage(a)) && fs.existsSync(transcriptFile(local))) {
    const said = fs.readFileSync(transcriptFile(local), 'utf8').slice(0, MAX_TRANSCRIPT_CHARS);
    const what = isVideo(a)
      ? 'video; dit is het uitgeschreven geluid, het beeld is niet bekeken'
      : isImage(a)
        ? 'afbeelding; dit is de tekst erop, gelezen met tekstherkenning (controleer namen en getallen), het beeld is niet bekeken'
        : 'audio, automatisch uitgeschreven';
    return `<bijlage naam="${a.name}" pad="${path.relative(agent.workspace, local)}" soort="${what}">\n${said || '(geen tekst gevonden op deze afbeelding)'}\n</bijlage>`;
  }
  return null;
}

/** The notes of all prepared attachments of a message (for a CLI engine, which gets the files but not their story). */
export function preparedNotes(ctx: Ctx, agent: Agent, m: Message | null | undefined): string[] {
  return attachmentRows(ctx, m?.parts?.attachments)
    .map((a) => preparedNote(agent, a, ensureInWorkspace(agent, a)))
    .filter((n): n is string => !!n);
}
