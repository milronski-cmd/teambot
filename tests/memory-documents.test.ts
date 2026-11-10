/**
 * PDF and Word in dossier sources (plan 0.4 F): the text is read (Word with adm-zip, pdf with pdf.js), chunked and
 * indexed, so a bot finds and quotes it ([s:…]) in its context, with memory_search and dossier_get; by meaning too
 * with a local embedding model. Forgetting the source removes chunks, index rows and vectors.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { startTestApp, type TestApp } from './helpers.js';
import { startFakeOllama } from './memory-fake-ollama.js';
import { documentSourceText, PDF_UNAVAILABLE, pdfReadError } from '../server/modules/memory/dossiers.js';

/** A small valid pdf with text per page (Helvetica), built by hand. */
function makePdf(pages: string[][]): Buffer {
  const objs: string[] = [];
  const add = (s: string) => objs.push(s);
  const catalog = add('<< /Type /Catalog /Pages 2 0 R >>');
  add('PAGES');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids: number[] = [];
  for (const lines of pages) {
    const body = ['BT', '/F1 24 Tf', '72 760 Td', ...lines.flatMap((l, i) => (i ? ['0 -36 Td', `(${l}) Tj`] : [`(${l}) Tj`])), 'ET'].join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function makeDocx(paragraphs: string[]): Buffer {
  const zip = new AdmZip();
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`).join('');
  zip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`));
  return zip.toBuffer();
}

async function upload(t: TestApp, name: string, body: Buffer, type: string) {
  const r = await fetch(`${t.app.url}/api/attachments?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'content-type': type }, body: new Uint8Array(body) });
  return (await r.json()) as { id: string };
}

const ctxOf = (m: any): string => m?.parts?.context ?? '';
const userMsg = (msgs: any[]) => msgs.filter((m) => m.role === 'user').at(-1);

test('a Word source is read, indexed and quoted by the bot; a pdf too; forgetting removes every derived copy', async () => {
  const t = await startTestApp();
  try {
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
    const a = await t.agent();
    const d = (await t.api('POST', '/memory/dossiers', { title: 'Verbouwing' })).dossier;
    const docx = await upload(t, 'offerte-dakkapel.docx', makeDocx(['Offerte dakkapel voor de Verbouwing', 'De dakkapel kost 7450 euro inclusief plaatsing.', 'Levertijd: zes weken na akkoord.']), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    const s1 = await t.api('POST', `/memory/dossiers/${d.id}/sources`, { attachmentId: docx.id });
    assert.equal(s1.kind, 'attachment');
    assert.equal(s1.title, 'offerte-dakkapel.docx');
    assert.ok(s1.chunks >= 1, 'chunked');
    assert.match(s1.excerpt, /7450 euro/);

    const pdf = await upload(t, 'garantie.pdf', makePdf([['Garantievoorwaarden zonnepanelen'], ['De garantie op de omvormer is 12 jaar']]), 'application/pdf');
    const s2 = await t.api('POST', `/memory/dossiers/${d.id}/sources`, { attachmentId: pdf.id, title: 'Garantie' });
    assert.ok(s2.chunks >= 1);
    const chunkText = t.app.ctx.store.all<any>('SELECT text FROM memory_chunks WHERE source_id = ?', s2.id).map((c) => c.text).join('\n');
    assert.match(chunkText, /--- pagina 2 ---\nDe garantie op de omvormer is 12 jaar/);

    // The bot's per-turn context quotes the Word document with its citable id.
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ text: `De dakkapel kost 7450 euro [s:${s1.ref}].` });
    const ctx1 = ctxOf(userMsg(await t.say(th.id, 'Wat kost de dakkapel volgens de offerte?')));
    assert.match(ctx1, /Documenten:/);
    assert.match(ctx1, new RegExp(`\\[s:${s1.ref}\\] “offerte-dakkapel\\.docx”: .*7450 euro`));
    const refs = await t.api('GET', `/memory/refs?refs=s:${s1.ref}`);
    assert.equal(refs[0].kind, 'source');
    assert.equal(refs[0].label, 'offerte-dakkapel.docx');

    // memory_search and dossier_get(query) find the pdf text.
    t.script.push({ toolCalls: [{ name: 'memory_search', args: { query: 'omvormer garantie' } }] }, { toolCalls: [{ name: 'dossier_get', args: { dossier: 'Verbouwing', query: 'omvormer' } }] }, { text: '12 jaar' });
    const msgs = await t.say(th.id, 'Hoe lang is de garantie op de omvormer?');
    const tools = msgs.filter((m: any) => m.role === 'tool').slice(-2).map((m: any) => m.content);
    assert.match(tools[0], new RegExp(`\\[s:${s2.ref}\\] Document “Garantie”: .*12 jaar`));
    assert.match(tools[1], new RegExp(`Uit documenten:\\n- \\[s:${s2.ref}\\]`));

    // A bot adds a pdf from its own workspace.
    fs.mkdirSync(a.workspace, { recursive: true });
    fs.writeFileSync(path.join(a.workspace, 'planning.pdf'), makePdf([['Planning: de steiger komt op 3 maart']]));
    t.script.push({ toolCalls: [{ name: 'dossier_add', args: { dossier: 'Verbouwing', kind: 'source', title: 'Planning', file: 'planning.pdf' } }] }, { text: 'Toegevoegd' });
    const m2 = await t.say(th.id, 'Zet de planning.pdf bij het dossier');
    assert.match(m2.filter((m: any) => m.role === 'tool').at(-1)!.content, /Bron toegevoegd: \[s:[a-z0-9]+\] Planning \(1 delen doorzoekbaar\)/);

    // Forget the Word source: chunks, index rows and the quote in the frozen context are gone.
    const chunkIds = t.app.ctx.store.all<any>('SELECT id FROM memory_chunks WHERE source_id = ?', s1.id).map((c) => c.id);
    await t.api('POST', `/memory/sources/${s1.id}/forget`, {});
    assert.equal(t.app.ctx.store.all('SELECT * FROM memory_chunks WHERE source_id = ?', s1.id).length, 0);
    for (const id of chunkIds) assert.equal(t.app.ctx.store.all("SELECT * FROM memory_fts WHERE kind = 'chunk' AND rid = ?", id).length, 0);
    assert.equal((await t.api('GET', '/memory/search?q=dakkapel')).documents.length, 0);
    assert.doesNotMatch(ctxOf(t.app.ctx.store.message(userMsg(t.app.ctx.store.messages(th.id).slice(0, 2)).id)), /7450 euro/);
  } finally {
    await t.close();
  }
});

test('document reading is honest: a scan without text, an empty or broken Word file, and pdf.js missing', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || '/tmp', 'tb-memdoc-'));
  try {
    const scan = path.join(dir, 'scan.pdf');
    fs.writeFileSync(scan, makePdf([[]]));
    await assert.rejects(documentSourceText(scan), /geen leesbare tekst/);
    const empty = path.join(dir, 'leeg.docx');
    fs.writeFileSync(empty, makeDocx([]));
    await assert.rejects(documentSourceText(empty), /geen tekst/);
    const broken = path.join(dir, 'kapot.docx');
    fs.writeFileSync(broken, Buffer.from('PK\u0003\u0004 not really a zip'));
    await assert.rejects(documentSourceText(broken), /kon niet worden gelezen/);
    const txt = path.join(dir, 'notitie.txt');
    fs.writeFileSync(txt, 'gewone tekst');
    assert.equal(await documentSourceText(txt), null, 'no pdf or Word: handled as before');
    // A build without pdf.js says so plainly; any other failure names the file problem.
    const missing = Object.assign(new Error("Cannot find package 'pdfjs-dist' imported from documents.js"), { code: 'ERR_MODULE_NOT_FOUND' });
    assert.equal(pdfReadError(missing).message, PDF_UNAVAILABLE);
    assert.match(PDF_UNAVAILABLE, /^PDF lezen lukt niet: het onderdeel pdf\.js ontbreekt/);
    assert.match(pdfReadError(new Error('Invalid PDF structure')).message, /^Deze pdf kon niet worden gelezen: Invalid PDF structure/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('document parts are found by meaning with a local embedding model', async () => {
  const t = await startTestApp();
  const o = await startFakeOllama();
  try {
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
    t.app.ctx.providers.create(t.app.ctx.auth.owner()!.id, { kind: 'ollama', base_url: `${o.url}/v1` });
    const d = (await t.api('POST', '/memory/dossiers', { title: 'Dak' })).dossier;
    const doc = await upload(t, 'offerte.docx', makeDocx(['Offerte voor zonnepanelen op het dak.', 'Twaalf panelen met omvormer.']), 'application/octet-stream');
    const s = await t.api('POST', `/memory/dossiers/${d.id}/sources`, { attachmentId: doc.id });
    await t.app.ctx.services.memory.drain();
    assert.equal(t.app.ctx.store.all("SELECT * FROM memory_vectors WHERE kind = 'chunk'").length, s.chunks);
    // "zonnestroom" is not in the text; its meaning is.
    const r = await t.api('GET', '/memory/search?q=zonnestroom');
    assert.equal(r.documents[0]?.ref, s.ref, JSON.stringify(r.documents));
    assert.equal(r.documents[0].meaning, true);
    await t.api('POST', `/memory/sources/${s.id}/forget`, {});
    assert.equal(t.app.ctx.store.all("SELECT * FROM memory_vectors WHERE kind = 'chunk'").length, 0, 'chunk vectors forgotten too');
  } finally {
    await o.close();
    await t.close();
  }
});
