import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { startTestApp, type TestApp } from './helpers.js';
import { docxText, documentText, pageList, readDocumentTool } from '../server/modules/folders/documents.js';
import { toolLabel } from '../shared/toolLabels.js';
import { fillWords } from '../shared/i18n-core.js';

// A-39: reading a pdf in the bot's own folders is one read step, without approvals and without the terminal.
const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = path.join(here, 'fixtures', 'cli-agents-fake-acp.mjs');

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

const OFFERTE = makePdf([
  ['Offerte zonnepanelen', 'Prijs 3950 euro'],
  ['Levering in week 11', 'Garantie 25 jaar'],
]);

test('documentText: pdf per page (with a page choice), docx paragraphs, plain text', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'tb-doc-'));
  try {
    fs.writeFileSync(path.join(dir, 'offerte.pdf'), OFFERTE);
    const all = await documentText(path.join(dir, 'offerte.pdf'));
    assert.match(all, /pdf, 2 pagina's/);
    assert.match(all, /--- pagina 1 ---\nOfferte zonnepanelen\s+Prijs 3950 euro/);
    assert.match(all, /--- pagina 2 ---\nLevering in week 11/);
    const p2 = await documentText(path.join(dir, 'offerte.pdf'), { pages: '2' });
    assert.doesNotMatch(p2, /3950/);
    assert.match(p2, /Garantie 25 jaar/);
    assert.deepEqual(pageList('1-3,5', 4), [1, 2, 3]);
    assert.deepEqual(pageList('', 2), [1, 2]);

    const zip = new AdmZip();
    zip.addFile('word/document.xml', Buffer.from('<w:document><w:body><w:p><w:r><w:t>Beste Mo,</w:t></w:r></w:p><w:p><w:r><w:t>Prijs:</w:t><w:tab/><w:t>€ 3.950 &amp; btw</w:t></w:r></w:p></w:body></w:document>'));
    const docx = zip.toBuffer();
    assert.equal(docxText(docx), 'Beste Mo,\nPrijs:\t€ 3.950 & btw');
    fs.writeFileSync(path.join(dir, 'brief.docx'), docx);
    assert.match(await documentText(path.join(dir, 'brief.docx')), /Word-document\n\nBeste Mo,/);
    fs.writeFileSync(path.join(dir, 'x.bin'), Buffer.from([0, 1, 2, 0, 5]));
    await assert.rejects(documentText(path.join(dir, 'x.bin')), /alleen pdf, Word/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function upload(t: TestApp, name: string, body: Buffer, type: string) {
  const r = await fetch(`${t.app.url}/api/attachments?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'content-type': type }, body: new Uint8Array(body) });
  return (await r.json()) as { id: string };
}

function useLog(t: TestApp) {
  const file = path.join(t.dir, 'fake-cli.log');
  process.env.FAKE_CLI_LOG = file;
  return () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
}

test('OpenCode-like engine reads a pdf attachment with read_document: no approval card, no terminal', async () => {
  const t = await startTestApp();
  const logs = useLog(t);
  try {
    const p = await t.api('POST', '/providers', { kind: 'acp-custom', config: { command: FAKE_ACP, args: [] } });
    const a = await t.api('POST', '/agents', { name: 'Lezer', provider_id: p.id, model: '', access_mode: 'ask' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    const att = await upload(t, 'offerte-zonnepanelen.pdf', OFFERTE, 'application/pdf');
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Vat deze offerte samen. SCENARIO:pdf', attachments: [att.id] });
    await t.waitIdle(th.id, 30_000);
    const L = logs();
    const prompt = L.filter((l) => l.method === 'session/prompt').at(-1)?.params?.text || '';
    assert.match(prompt, /uploads[\\/][^\s]*offerte-zonnepanelen\.pdf .*lees de tekst met de TeamBot-tool read_document/, 'the prompt names the reader');
    assert.match(prompt, /read_document: één leesstap zonder toestemming, geen script of terminalopdracht/, 'and says it needs no approval (with the attachment, not in the instructions of every turn)');
    const run = L.find((l) => l.pdf)?.pdf;
    assert.ok(run, 'scenario ran');
    assert.deepEqual(run.permissions, [{ kind: 'mcp', option: 'a' }], 'one step through TeamBot, no shell request');
    assert.match(run.read, /Prijs 3950 euro/);
    const approvals = t.app.ctx.store.all<any>('SELECT tool, status FROM approvals WHERE thread_id = ?', th.id);
    assert.deepEqual(approvals, [], 'no approval card at all');
    const m = t.app.ctx.store.messages(th.id).filter((x) => x.role === 'assistant').at(-1)!;
    assert.equal(m.status, 'done', String(m.parts.error || ''));
    assert.match(m.content, /Offerte zonnepanelen.*3950/);
    assert.ok(m.parts.activity?.some((x: any) => /read|document|lezen/i.test(x.title)), 'the read shows as a step');
    // B-04 (round 6): one call of a TeamBot tool is one step, TeamBot's own line on the engine's step, not two
    // ("Las een document" plus "TeamBot · Document lezen: …").
    const titles = (m.parts.activity || []).map((x: any) => x.title);
    const reads = (m.parts.activity || []).filter((x: any) => x.kind !== 'session' && /document|teambot/i.test(x.title));
    assert.equal(reads.length, 1, titles.join(' | '));
    assert.match(reads[0].title, /^TeamBot · .*offerte-zonnepanelen\.pdf/);
    assert.equal(reads[0].kind, 'tool_result');
  } finally {
    await t.close();
  }
});

test('without read_document (bot without file tools) the same engine falls back to two terminal cards (the old A-39 situation)', async () => {
  const t = await startTestApp();
  const logs = useLog(t);
  try {
    const p = await t.api('POST', '/providers', { kind: 'acp-custom', config: { command: FAKE_ACP, args: [] } });
    const a = await t.api('POST', '/agents', { name: 'Zonder', provider_id: p.id, model: '', access_mode: 'ask', tool_groups: ['memory'] });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    const att = await upload(t, 'offerte.pdf', OFFERTE, 'application/pdf');
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Lees dit. SCENARIO:pdf', attachments: [att.id] });
    for (let i = 0; i < 2; i++) {
      let ap: any;
      for (let k = 0; k < 200 && !ap; k++) {
        await new Promise((r) => setTimeout(r, 50));
        ap = (await t.api('GET', '/approvals')).find((x: any) => x.status === 'pending');
      }
      assert.ok(ap, `terminal card ${i + 1}`);
      await t.api('POST', `/approvals/${ap.id}`, { decision: 'deny' });
    }
    await t.waitIdle(th.id, 30_000);
    assert.deepEqual(logs().find((l) => l.pdf)?.pdf.permissions.map((x: any) => x.kind), ['execute', 'execute']);
  } finally {
    await t.close();
  }
});

test('the step reads "Las een document", and its detail names the attachment without its short id', () => {
  assert.equal(toolLabel({ name: 'read_document' }, false), 'Las een document');
  assert.equal(toolLabel({ name: 'read_document' }, true), 'Leest een document');
  assert.equal(fillWords(readDocumentTool.summarize!({ path: 'uploads\\ac62bc-offerte-zonnepanelen.pdf' })), 'Document lezen: offerte-zonnepanelen.pdf');
  assert.equal(fillWords(readDocumentTool.summarize!({ path: 'notities/uploads/ac62bc-plan.docx' })), 'Document lezen: notities/plan.docx');
  assert.equal(fillWords(readDocumentTool.summarize!({ path: 'rapport.pdf' })), 'Document lezen: rapport.pdf');
});
