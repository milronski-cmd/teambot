/**
 * Which attachments TeamBot cannot show or hand to the bot as content, and what to tell the owner (A-24/A-25):
 * never a silent failure. Images (PNG/JPG/GIF/WebP), PDF, Word, Excel, PowerPoint, text and code files work; a .zip is
 * unpacked for the bot and audio is written out for it (server/agent/attachments.ts). Of a video the bot gets the
 * sound at most; other archives and binary files arrive only as a file in the bot's workspace.
 * Pure (tests/attachment-notice.test.ts); mirrors server/agent/history.ts (what an API bot gets inline).
 */

export interface AttachmentNotice {
  /** What kind of file this is, in words ("Video", "Zip-archief"). */
  kind: string;
  /** One sentence: what TeamBot cannot do with it and what the bot gets instead. */
  text: string;
}

const BOT_IMAGES = /^image\/(png|jpeg|gif|webp)$/;
const TEXT_MIME = /^(text\/|message\/rfc822|application\/(json|xml|javascript|x-yaml|yaml|csv|x-sh|sql|toml))/;
const TEXT_EXT = /\.(txt|md|csv|json|xml|ya?ml|toml|ini|log|js|ts|tsx|jsx|py|rb|go|rs|java|cs|php|html|css|sql|sh|ps1|bat|eml)$/i;
const ZIP = /^application\/(zip|x-zip-compressed)$/;
const ARCHIVE = /^application\/(x-7z-compressed|x-rar-compressed|vnd\.rar|gzip|x-gzip|x-tar|x-bzip2|x-xz)$/;
const ARCHIVE_EXT = /\.(7z|rar|tar|gz|tgz|bz2|xz)$/i;

export function attachmentNotice(a: { name: string; mime: string }, _o: { voice?: boolean } = {}): AttachmentNotice | null {
  const mime = (a.mime || '').toLowerCase().split(';')[0].trim();
  const name = a.name || '';
  if (BOT_IMAGES.test(mime)) return null;
  // read_document reads these.
  if (mime === 'application/pdf' || /\.(pdf|docx|xlsx|pptx)$/i.test(name)) return null;
  if (TEXT_MIME.test(mime) || TEXT_EXT.test(name)) return null;
  // Unpacked in the bot's workspace before it reads the message.
  if (/\.zip$/i.test(name) || ZIP.test(mime)) return null;
  if (mime.startsWith('image/')) return { kind: 'Afbeelding', text: 'De bot bekijkt alleen PNG, JPG, GIF en WebP als afbeelding; dit bestand krijgt hij alleen als bestand in zijn werkmap.' };
  // Written out for the bot with the speech recognition on this computer.
  if (mime.startsWith('audio/')) return null;
  if (mime.startsWith('video/')) return { kind: 'Video', text: 'De bot kan het beeld van een video niet bekijken. Wat er gezegd wordt, schrijft TeamBot voor hem uit als dat lukt; stuur voor het beeld een paar schermafbeeldingen.' };
  if (ARCHIVE.test(mime) || ARCHIVE_EXT.test(name)) return { kind: 'Archief', text: 'TeamBot pakt alleen zip-bestanden uit. De bot krijgt het bestand in zijn werkmap; uitpakken lukt alleen als hij een terminal mag gebruiken.' };
  return { kind: 'Bestand', text: 'Geen voorbeeld in TeamBot. De bot krijgt het bestand in zijn werkmap; of hij de inhoud kan lezen, hangt af van zijn engine en tools.' };
}
