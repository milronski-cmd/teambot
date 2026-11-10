/**
 * Fout 4 of the 0.4 acceptance (F-09): a small local model used a Word document from a dossier ("De dakkapel kost
 * € 7.450 inclusief plaatsing.") but wrote no [s:…], and no source showed under the answer. Now the document part it
 * was given and clearly used is a source of that answer, like a memory is (A-42), and only that one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { startTestApp, type TestApp } from './helpers.js';
import { usesDocument } from '../server/modules/memory/implied.js';

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

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

test('usesDocument: a number or name from the part, or three of its words; "7.450" is 7450; the question is no evidence', () => {
  const part = 'Offerte dakkapel voor de Verbouwing. De dakkapel kost 7450 euro inclusief plaatsing. Levertijd: zes weken na akkoord.';
  assert.equal(usesDocument(part, 'De dakkapel kost volgens de offerte € 7.450 inclusief plaatsing.', 'Wat kost de dakkapel volgens de offerte?'), true);
  assert.equal(usesDocument(part, 'Ongeveer zes weken na je akkoord.', 'Wat is de levertijd?'), true, 'three words of the part');
  assert.equal(usesDocument(part, 'Morgen wordt het zonnig.', 'Wat voor weer wordt het?'), false);
  assert.equal(usesDocument(part, 'Een dakkapel kost vaak een paar duizend euro.', 'Wat kost een dakkapel ongeveer?'), false, 'one common word is no evidence');
  assert.equal(usesDocument(part, 'Ja, 7450 euro.', 'Kost de dakkapel 7450 euro?'), false, 'the question already said it');
});

test('answer-sources: the Word document a local model used without citing it shows under the answer, and only that one', async () => {
  const t = await startTestApp();
  try {
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
    const a = await t.agent();
    const d = (await t.api('POST', '/memory/dossiers', { title: 'Verbouwing' })).dossier;
    const offer = await upload(t, 'offerte-dakkapel.docx', makeDocx(['Offerte dakkapel voor de Verbouwing', 'De dakkapel kost 7450 euro inclusief plaatsing.', 'Levertijd: zes weken na akkoord.']), DOCX);
    const s1 = await t.api('POST', `/memory/dossiers/${d.id}/sources`, { attachmentId: offer.id });
    const other = await upload(t, 'tuinplan.docx', makeDocx(['Tuinplan voor het voorjaar', 'Drie appelbomen langs de schutting en een moestuin achterin.']), DOCX);
    await t.api('POST', `/memory/dossiers/${d.id}/sources`, { attachmentId: other.id });

    const th = await t.api('POST', '/threads', { agentId: a.id });
    // The live answer of qwen3.6 on 9 November: right, from the Word document, without [s:…].
    t.script.push({ text: 'De dakkapel kost volgens de offerte € 7.450 inclusief plaatsing.' });
    const msgs = await t.say(th.id, 'Wat kost de dakkapel volgens de offerte?');
    assert.match(msgs.filter((m: any) => m.role === 'user').at(-1).parts.context, new RegExp(`\\[s:${s1.ref}\\]`), 'the offer was in the context');
    const answer = msgs.filter((m: any) => m.role === 'assistant').at(-1);

    const r = await t.api('GET', `/memory/thread/${th.id}/answer-sources`);
    const cites = r.byMessage[answer.id] || [];
    assert.deepEqual(cites.map((c: any) => [c.kind, c.p, c.ref, c.label]), [['source', 's', s1.ref, 'offerte-dakkapel.docx']]);
    assert.equal(cites[0].dossier_id, d.id, 'the link opens the dossier');

    // An answer about something else gets no document; one that cites shows its own source (nothing implied).
    t.script.push({ text: 'Morgen wordt het zonnig.' }, { text: `Zes weken [s:${s1.ref}].` });
    const weather = (await t.say(th.id, 'Wat voor weer wordt het?')).filter((m: any) => m.role === 'assistant').at(-1);
    const cited = (await t.say(th.id, 'En de levertijd van de dakkapel?')).filter((m: any) => m.role === 'assistant').at(-1);
    const r2 = await t.api('GET', `/memory/thread/${th.id}/answer-sources`);
    assert.equal(r2.byMessage[weather.id], undefined);
    assert.equal(r2.byMessage[cited.id], undefined);

    // A forgotten source is no source any more.
    await t.api('POST', `/memory/sources/${s1.id}/forget`, {});
    const r3 = await t.api('GET', `/memory/thread/${th.id}/answer-sources`);
    assert.equal(r3.byMessage[answer.id], undefined);
  } finally {
    await t.close();
  }
});
