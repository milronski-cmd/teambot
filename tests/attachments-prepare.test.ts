// Attachments a bot could not read are made readable before its turn (server/agent/attachments.ts): a zip is unpacked
// safely, audio is written out, a video's sound where the speech engine takes it, and xlsx/pptx point at read_document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { startTestApp } from './helpers.js';
import { unpackZip, ZIP_LIMITS } from '../server/agent/attachments.js';
import { cliPrompt } from '../server/agent/prompt.js';
import { registerAttachment } from '../server/tools/builtin/files.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tb-att-'));
const until = async (fn: () => any, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 30));
  }
};
/** A zip whose entry names are rewritten in the raw bytes (zip libraries refuse to write "../" themselves). */
function zipWith(files: Record<string, string>, rename: [string, string][] = []): string {
  const z = new AdmZip();
  for (const [name, text] of Object.entries(files)) z.addFile(name, Buffer.from(text));
  let buf = z.toBuffer().toString('latin1');
  for (const [from, to] of rename) {
    assert.equal(from.length, to.length);
    assert.ok(buf.includes(from), `entry ${from} is in the archive`);
    buf = buf.split(from).join(to);
  }
  const file = path.join(tmp(), 'pakket.zip');
  fs.writeFileSync(file, Buffer.from(buf, 'latin1'));
  return file;
}

test('unpackZip: nothing lands outside the folder, and the limits hold', () => {
  const root = tmp();
  const dest = path.join(root, 'uit');
  fs.mkdirSync(dest);
  const zip = zipWith({ 'notities.txt': 'hallo', 'map/diep/cijfers.csv': 'a;b\n1;2', 'AA/kwaad.txt': 'buiten', 'BB/weg.txt': 'buiten' }, [['AA/kwaad.txt', '../kwaad.txt'], ['BB/weg.txt', 'C:/weg.txt']]);
  assert.ok(new AdmZip(zip).getEntries().some((e) => e.entryName.includes('..') || /kwaad/.test(e.entryName)), 'the archive really holds the bad entry');
  const r = unpackZip(zip, dest);
  assert.deepEqual(r.files.sort(), ['map/diep/cijfers.csv', 'notities.txt']);
  assert.equal(fs.readFileSync(path.join(dest, 'map', 'diep', 'cijfers.csv'), 'utf8'), 'a;b\n1;2');
  assert.equal(fs.existsSync(path.join(root, 'kwaad.txt')), false, 'no file next to the folder');
  assert.deepEqual(fs.readdirSync(root).sort(), ['uit']);
  assert.equal(r.skipped.length, 2);
  assert.match(r.skipped.join('\n'), /pad buiten de map/);

  // Count, size per file and total size.
  const many = zipWith({ 'a.txt': 'x'.repeat(50), 'b.txt': 'y'.repeat(50), 'c.txt': 'z'.repeat(50), 'groot.txt': 'g'.repeat(5000) });
  const d2 = path.join(root, 'uit2');
  fs.mkdirSync(d2);
  const r2 = unpackZip(many, d2, { ...ZIP_LIMITS, files: 2, fileBytes: 1000 });
  assert.deepEqual(r2.files, ['a.txt', 'b.txt']);
  assert.match(r2.skipped.join('\n'), /c\.txt \(meer dan 2 bestanden\)/);
  const d3 = path.join(root, 'uit3');
  fs.mkdirSync(d3);
  const r3 = unpackZip(many, d3, { ...ZIP_LIMITS, fileBytes: 1000, totalBytes: 120 });
  assert.deepEqual(r3.files, ['a.txt', 'b.txt'], 'the third file would pass the total');
  assert.match(r3.skipped.join('\n'), /groot\.txt \(te groot\)/);
  assert.throws(() => unpackZip(many, d3, { ...ZIP_LIMITS, zipBytes: 10 }), /te groot om uit te pakken/);
});

test('a turn with a zip, an audio file, a video, an xlsx and a pptx: the bot reads what is in them', async () => {
  const t = await startTestApp();
  try {
    const ctx = t.app.ctx;
    const a = await t.api('POST', '/agents', { name: 'Ada', provider_id: t.providerId, model: 'mock' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    const agent = ctx.store.agent(a.id)!;
    const owner = ctx.auth.owner()!;
    // The owner's speech-to-text, as the voice module offers it to other parts of TeamBot.
    const heard: { mime: string; bytes: number }[] = [];
    ctx.services.voice = {
      async transcribeAttachment(_userId: string, buf: Buffer, mime: string) {
        heard.push({ mime, bytes: buf.length });
        if (buf.toString('latin1', 0, 4) === 'STIL') throw new Error('Dit lijkt geen geldig audiobestand te zijn.');
        return { text: buf.toString('latin1', 0, 4) === 'RIFF' ? 'Bel de leverancier morgen terug over de offerte.' : 'Welkom bij de rondleiding door het magazijn.' };
      },
    };
    const dir = tmp();
    const put = (name: string, data: Buffer | string) => {
      const f = path.join(dir, name);
      fs.writeFileSync(f, data);
      return registerAttachment(ctx, owner.id, th.id, f, name);
    };
    const zipFile = zipWith({ 'offerte/prijzen.csv': 'product;prijs\nfiets;499', 'leesmij.txt': 'Lees dit eerst', 'AA/kwaad.txt': 'x' }, [['AA/kwaad.txt', '../kwaad.txt']]);
    const refs = [
      registerAttachment(ctx, owner.id, th.id, zipFile, 'stukken.zip'),
      put('memo.wav', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(200)])),
      put('rondleiding.mp4', Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(200)])),
      put('stom.mov', Buffer.concat([Buffer.from('STIL'), Buffer.alloc(50)])),
      put('cijfers.xlsx', 'PK-niet-echt'),
      put('dia.pptx', 'PK-niet-echt'),
    ];
    t.script.push({ text: 'Gelezen.' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Wat staat hierin?', attachments: refs.map((r) => r.id) });
    await until(() => t.requests.length >= 1 && !ctx.runs.activeRuns().length);
    const last = t.requests[0].messages.filter((m: any) => m.role === 'user').at(-1)!;
    const text = typeof last.content === 'string' ? last.content : last.content.map((p: any) => (p.type === 'text' ? p.text : '')).join('\n');

    // zip: unpacked in the workspace, its files named, the bad entry reported and not written
    const m = text.match(/stukken\.zip \(zip[^\]]*uitgepakt in je werkmap in de map ([^ ]+) \(2 bestanden\): leesmij\.txt, offerte\/prijzen\.csv\. Niet alles is uitgepakt/);
    assert.ok(m, text);
    const unpacked = path.join(agent.workspace, m![1]);
    assert.equal(fs.readFileSync(path.join(unpacked, 'offerte', 'prijzen.csv'), 'utf8'), 'product;prijs\nfiets;499');
    assert.equal(fs.existsSync(path.join(agent.workspace, 'uploads', 'kwaad.txt')), false);
    assert.match(fs.readFileSync(path.join(unpacked, '_NIET_UITGEPAKT.txt'), 'utf8'), /pad buiten de map/);

    // audio: written out, as data inside the attachment block
    assert.match(text, /<bijlage naam="memo\.wav" pad="[^"]+" soort="audio, automatisch uitgeschreven">\nBel de leverancier morgen terug over de offerte\.\n<\/bijlage>/);
    // video: its sound where the engine takes the container; honest about the picture
    assert.match(text, /<bijlage naam="rondleiding\.mp4" [^>]*soort="video; dit is het uitgeschreven geluid, het beeld is niet bekeken">\nWelkom bij de rondleiding/);
    assert.deepEqual(heard.find((h) => h.bytes === 212), { mime: '', bytes: 212 }, 'a video goes in by its content, not as "video/mp4"');
    // a video the engine cannot take stays an attachment, and the bot is told not to pretend
    assert.match(text, /\[bijlage: stom\.mov [^\]]*een video[^\]]*Je kunt het beeld niet bekijken en het geluid is niet uitgeschreven/);
    // xlsx and pptx: read_document reads them
    assert.match(text, /\[bijlage: cijfers\.xlsx [^\]]*lees de tekst met read_document\]/);
    assert.match(text, /\[bijlage: dia\.pptx [^\]]*lees de tekst met read_document\]/);

    // A CLI engine keeps its own history: its prompt says the same about the prepared files.
    const input = ctx.store.messages(th.id, { limit: 20 }).find((x) => x.role === 'user')!;
    const cli = cliPrompt(ctx, agent, ctx.store.thread(th.id)!, input);
    assert.match(cli, /stukken\.zip \(zip[^\]]*uitgepakt in je werkmap/);
    assert.match(cli, /soort="audio, automatisch uitgeschreven">\nBel de leverancier/);

    // Once: a second turn does not unpack or transcribe again.
    const calls = heard.length;
    t.script.push({ text: 'Nogmaals.' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'En verder?' });
    await until(() => t.requests.length >= 2 && !ctx.runs.activeRuns().length);
    assert.equal(heard.length, calls);
    assert.match(JSON.stringify(t.requests[1].messages), /Bel de leverancier morgen terug/, 'still in the history');
  } finally {
    await t.close();
  }
});
