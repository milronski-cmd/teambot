import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { documentKind, documentText, readDocument, NO_TEXT_PAGE } from '../server/modules/folders/documents.js';
import { OcrEngine, OCR_LANGS, ocrEngine, setOcrEngine, setOcrForTests, pgm } from '../server/modules/folders/ocr.js';
import { chunkText } from '../server/modules/folders/chunk.js';
import { documentSourceText } from '../server/modules/memory/dossiers.js';

const FIX = path.join(import.meta.dirname, 'fixtures', 'documents');
const fx = (n: string) => path.join(FIX, n);

/**
 * The real language data (10 MB, Apache-2.0) is not in git. It is fetched once with the same hash check as in the app,
 * into a cache outside the repository; without internet the OCR tests are skipped (everything else still runs).
 */
const CACHE = path.join(os.tmpdir(), 'teambot-test-ocr');
let real: OcrEngine | null = null;
async function realEngine(): Promise<OcrEngine | null> {
  if (real) return real;
  const e = new OcrEngine(CACHE);
  if (!e.ready() || e.presentLangs().length < OCR_LANGS.length) await e.download();
  real = e.presentLangs().length === OCR_LANGS.length ? e : null;
  return real;
}

test('Word, Excel and PowerPoint keep their structure (mammoth, read-excel-file, own pptx reader)', async () => {
  const word = await readDocument(fx('brief.docx'));
  assert.equal(word.kind, 'word');
  assert.match(word.text, /^# Offerte zonnepanelen/m, 'heading 1 stays a heading');
  assert.match(word.text, /^## Prijzen/m);
  assert.match(word.text, /\| Product \| Prijs \|\n\| --- \| --- \|\n\| Zonnepaneel \| 320 euro \|\n\| Omvormer \| 890 euro \|/, 'a table stays a table');

  const xl = await readDocument(fx('cijfers.xlsx'));
  assert.equal(xl.kind, 'excel');
  assert.match(xl.text, /## Blad: Klanten\n\n\| Naam \| Plaats \| Omzet \|\n\| --- \| --- \| --- \|\n\| Bakkerij Jansen \| Utrecht \| 1250\.5 \|/);
  assert.match(xl.text, /## Blad: Notities\n\n\| Opmerking \|\n\| --- \|\n\| Bel in januari terug \|/);

  const pp = await readDocument(fx('presentatie.pptx'));
  assert.equal(pp.kind, 'powerpoint');
  // Deck order comes from presentation.xml (slide2.xml is the first slide), with the speaker notes.
  assert.match(pp.text, /## Dia 1\nPlan voor 2027\nDrie nieuwe winkels & een webshop\n\n## Dia 2\nBudget\nTotaal 40\.000 euro\nNotities: Noem de subsidie van de gemeente/);

  // Kinds by content, also without the right extension (an attachment's stored name).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-doc-'));
  try {
    fs.copyFileSync(fx('cijfers.xlsx'), path.join(tmp, 'bijlage.bin'));
    assert.equal((await readDocument(path.join(tmp, 'bijlage.bin'))).kind, 'excel');
    assert.equal((await readDocument(path.join(tmp, 'bijlage.bin'), { name: 'cijfers.xlsx' })).kind, 'excel');
    // A broken docx still gives its paragraphs through the plain reader.
    const AdmZip = (await import('adm-zip')).default;
    const z = new AdmZip();
    z.addFile('word/document.xml', Buffer.from('<w:document><w:body><w:p><w:r><w:t>Alleen tekst</w:t></w:r></w:p></w:body></w:document>'));
    fs.writeFileSync(path.join(tmp, 'kaal.docx'), z.toBuffer());
    assert.match(await documentText(path.join(tmp, 'kaal.docx')), /Word-document\n\nAlleen tekst/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  assert.equal(documentKind(fs.readFileSync(fx('scan.png')), 'x'), 'image');
  assert.equal(documentKind(fs.readFileSync(fx('scan.pdf')), 'x'), 'pdf');
});

test('a scan without language data: honest about what was not read, nothing downloaded by itself', async () => {
  const before = ocrEngine();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-ocr-none-'));
  setOcrEngine(new OcrEngine(dir));
  try {
    const d = await readDocument(fx('scan.pdf'));
    assert.match(d.text, new RegExp(`--- pagina 1 ---\\n${NO_TEXT_PAGE.replace(/[()]/g, '\\$&')}`));
    assert.deepEqual(d.pdf?.unread, [1]);
    assert.match(d.notes.join(' '), /Pagina 1 is een scan zonder tekst\. Scans lezen kan nadat de eigenaar de taaldata heeft gedownload/);
    await assert.rejects(readDocument(fx('scan.png')), /Dit is een afbeelding\. Scans lezen kan nadat/);
    await assert.rejects(documentSourceText(fx('scan.pdf')), /geen leesbare tekst \(waarschijnlijk een scan\)\. Scans lezen kan nadat/);
    assert.equal(await documentSourceText(fx('scan.png')), null, 'a picture is kept as a source without text, as before');
    assert.equal(fs.existsSync(path.join(dir, 'models')), false, 'no download without a yes');
  } finally {
    setOcrEngine(before);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('language data: downloaded only on request, every file checked against its hash', async () => {
  const files: Record<string, Buffer> = { '/nld.traineddata': Buffer.from('nederlands'.repeat(50)), '/eng.traineddata': Buffer.from('engels'.repeat(40)) };
  let bad = false;
  const srv = http.createServer((req, res) => {
    const b = files[req.url || ''];
    if (!b) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-length': b.length });
    res.end(bad && req.url === '/eng.traineddata' ? Buffer.from('x'.repeat(b.length)) : b);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as any).port;
  const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
  setOcrForTests({
    langs: [
      { id: 'nld', label: 'Nederlands', url: `http://127.0.0.1:${port}/nld.traineddata`, size: files['/nld.traineddata'].length, sha256: sha(files['/nld.traineddata']) },
      { id: 'eng', label: 'Engels', url: `http://127.0.0.1:${port}/eng.traineddata`, size: files['/eng.traineddata'].length, sha256: sha(files['/eng.traineddata']) },
    ],
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-ocr-dl-'));
  try {
    const e = new OcrEngine(dir);
    assert.equal(e.status().state, 'absent');
    bad = true;
    assert.equal(await e.download(), false);
    assert.match(e.status().error || '', /controle van het bestand klopte niet/);
    assert.deepEqual(e.presentLangs(), ['nld'], 'the good file stays, the bad one is thrown away');
    assert.ok(!fs.existsSync(path.join(e.dir, 'eng.traineddata')) && !fs.existsSync(path.join(e.dir, 'eng.traineddata.part')));
    bad = false;
    assert.equal(await e.download(), true);
    assert.equal(e.status().state, 'ready');
    // A changed file on disk is not trusted.
    fs.appendFileSync(path.join(e.dir, 'eng.traineddata'), 'x');
    assert.deepEqual(e.presentLangs(), ['nld']);
    await e.remove();
    assert.equal(e.status().state, 'absent');
  } finally {
    setOcrForTests({ langs: null });
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('OCR reads a scanned pdf and a photo of a page (Dutch and English language data)', async (t) => {
  const e = await realEngine();
  if (!e) return t.skip('language data could not be downloaded (offline?)');
  const before = ocrEngine();
  setOcrEngine(e);
  try {
    const d = await readDocument(fx('scan.pdf'));
    assert.match(d.text, /--- pagina 1 ---\nFactuur 2026-118\nTotaal te betalen: 245 euro\nGraag betalen voor 1 december\./);
    assert.deepEqual(d.pdf?.ocr, [1]);
    assert.match(d.notes.join(' '), /Pagina 1 is een scan en is gelezen met tekstherkenning \(OCR\)/);
    const img = await readDocument(fx('scan.png'));
    assert.equal(img.kind, 'image');
    assert.match(img.text, /Totaal te betalen: 245 euro/);
    // As a dossier source: searchable text with the page line.
    const src = await documentSourceText(fx('scan.pdf'), 'factuur.pdf');
    assert.match(src || '', /--- pagina 1 ---\nFactuur 2026-118/);
    // A blank page gives no text and no error.
    const blank = await e.recognize(pgm(new Uint8Array(200 * 100).fill(255), 200, 100));
    assert.equal(blank, '');
  } finally {
    setOcrEngine(before);
    await e.release();
  }
});

test('chunks: split at sentences, about 15% overlap, page or heading in front, more than 200 pieces', () => {
  const sentence = (i: number) => `Dit is zin nummer ${i} over de offerte voor zonnepanelen op het dak.`;
  const long = Array.from({ length: 60 }, (_, i) => sentence(i)).join(' ');
  const text = `--- pagina 1 ---\nInleiding.\n\n--- pagina 2 ---\n${long}\n\n## Prijzen\n\nHet paneel kost 320 euro.`;
  const chunks = chunkText(text, 1200);
  assert.ok(chunks.length >= 4);
  for (const c of chunks) {
    assert.ok(c.length <= 1200 + 60, `piece not much longer than the size (${c.length})`);
    // Never a word cut in half: every piece ends with a full sentence or a whole word.
    assert.doesNotMatch(c, /zonnepan$|offert$/);
  }
  // Pieces in the middle of page 2 say where they are.
  const p2 = chunks.filter((c) => /zin nummer 40/.test(c));
  assert.ok(p2.length >= 1 && p2.every((c) => c.startsWith('--- pagina 2 ---\n')));
  // Overlap: the last sentence of a piece starts the next one.
  const i = chunks.findIndex((c) => /zin nummer 1\b/.test(c) && !/zin nummer 59/.test(c));
  const lastOfFirst = chunks[i].match(/Dit is zin nummer (\d+)[^.]*\.\s*$/)![1];
  assert.match(chunks[i + 1], new RegExp(`zin nummer ${lastOfFirst} `), 'next piece repeats the end of the previous one');
  // Heading of a section in front of its pieces.
  assert.match(chunks[chunks.length - 1], /## Prijzen\n+Het paneel kost 320 euro\./);
  // More than 200 pieces for a big document (was cut at 200), never more than 400.
  const big = Array.from({ length: 2000 }, (_, k) => `Alinea ${k}. ${'woord '.repeat(150)}`).join('\n\n');
  const many = chunkText(big);
  assert.equal(many.length, 400);
  // A word longer than a piece (a url) is still cut, so nothing is lost.
  const url = 'https://example.com/' + 'a'.repeat(3000);
  assert.equal(chunkText(url, 1200, { overlap: 0 }).join(''), url);
});
