import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachmentNotice } from '../ui/src/shell/attachmentNotice.js';

test('attachment notice: silent for what works (also a zip, audio and Office files), honest for video, other archives and binaries', () => {
  for (const ok of [
    { name: 'scherm.png', mime: 'image/png' },
    { name: 'foto.jpg', mime: 'image/jpeg' },
    { name: 'offerte.pdf', mime: 'application/pdf' },
    { name: 'notities.md', mime: 'application/octet-stream' },
    { name: 'data.csv', mime: 'text/csv' },
    { name: 'mail.eml', mime: 'message/rfc822' },
    { name: 'script.py', mime: '' },
    // unpacked / written out / read with read_document for the bot (server/agent/attachments.ts)
    { name: 'fotos.zip', mime: 'application/zip' },
    { name: 'stukken.zip', mime: 'application/x-zip-compressed' },
    { name: 'liedje.mp3', mime: 'audio/mpeg' },
    { name: 'spraak.ogg', mime: 'audio/ogg' },
    { name: 'cijfers.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    { name: 'dia.pptx', mime: '' },
    { name: 'brief.docx', mime: '' },
  ])
    assert.equal(attachmentNotice(ok), null, ok.name);
  assert.equal(attachmentNotice({ name: 'map.7z', mime: 'application/octet-stream' })?.kind, 'Archief');
  assert.match(attachmentNotice({ name: 'oud.rar', mime: 'application/vnd.rar' })!.text, /alleen zip-bestanden/);
  const video = attachmentNotice({ name: 'filmpje.mp4', mime: 'video/mp4' })!;
  assert.equal(video.kind, 'Video');
  assert.match(video.text, /beeld van een video niet bekijken.*schrijft TeamBot voor hem uit/);
  assert.equal(attachmentNotice({ name: 'logo.svg', mime: 'image/svg+xml' })?.kind, 'Afbeelding');
  assert.equal(attachmentNotice({ name: 'setup.exe', mime: 'application/x-msdownload' })?.kind, 'Bestand');
  for (const n of ['map.7z', 'setup.exe']) {
    const t = attachmentNotice({ name: n, mime: 'application/octet-stream' })!.text;
    assert.match(t, /bestand/i, `${n}: says the bot gets the file`);
    assert.doesNotMatch(t, /undefined|null/);
  }
});
