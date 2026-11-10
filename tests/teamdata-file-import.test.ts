import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp } from './helpers.js';
import { msgs, team } from './team-mock.js';
import { safeName, tableFromRows } from '../server/modules/teamdata/import-file.js';
import type { TeamData } from '../server/modules/teamdata/service.js';

/** CSV and Excel into the team database: types per column, idempotent per file, undone exactly; also as a bot tool. */

const FIX = path.join(import.meta.dirname, 'fixtures', 'documents');
const svcOf = (t: any): TeamData => t.app.ctx.services.teamdata;

async function upload(t: any, name: string, body: Buffer | string) {
  const r = await fetch(`${t.app.url}/api/attachments?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/octet-stream' }, body: typeof body === 'string' ? body : new Uint8Array(body) });
  assert.equal(r.status, 200);
  return r.json();
}

test('column names and types from the first row and the values', () => {
  assert.equal(safeName('Omzet (€) 2026', 'x'), 'omzet_2026');
  assert.equal(safeName('Één', 'x'), 'een');
  assert.equal(safeName('2026', 'x'), 'k_2026');
  assert.equal(safeName('  ', 'kolom_3'), 'kolom_3');
  const d = tableFromRows(
    [
      ['Naam', 'Aantal', 'Prijs', 'id', 'Naam'],
      ['Appel', '3', '1,25', 'A1', 'x'],
      ['Peer', '12', '0.9', 'A2', ''],
    ],
    'fruit',
  );
  assert.equal(d.sql, 'CREATE TABLE "fruit" (id INTEGER PRIMARY KEY, "naam" TEXT, "aantal" INTEGER, "prijs" REAL, "id_bron" TEXT, "naam_2" TEXT)');
  assert.deepEqual(d.rows[0], { id: 1, __rowid: '1', naam: 'Appel', aantal: 3, prijs: 1.25, id_bron: 'A1', naam_2: 'x' });
  assert.equal(d.rows[1].naam_2, null);
});

test('CSV and Excel become team tables; the same file twice adds nothing; undo removes exactly the import', async () => {
  const t = await startTestApp();
  try {
    const owner = t.app.ctx.auth.owner()!;
    const csv = await upload(t, 'Klanten lijst.csv', 'Naam;Plaats;Omzet\nBakkerij Jansen;Utrecht;1250,50\n"Fietsenmaker; Ali";Zwolle;830\n');
    const r1 = await t.api('POST', '/teamdata/import', { attachmentId: csv.id });
    assert.deepEqual([r1.table, r1.created, r1.inserted, r1.skipped], ['klanten_lijst', true, 2, 0]);
    const rows = await svcOf(t).rows(owner.id, 'SELECT * FROM klanten_lijst ORDER BY id');
    assert.deepEqual(rows, [
      { id: 1, naam: 'Bakkerij Jansen', plaats: 'Utrecht', omzet: 1250.5 },
      { id: 2, naam: 'Fietsenmaker; Ali', plaats: 'Zwolle', omzet: 830 },
    ]);
    // Again: nothing doubled.
    const r2 = await t.api('POST', '/teamdata/import', { attachmentId: csv.id });
    assert.deepEqual([r2.created, r2.inserted, r2.skipped, r2.source], [false, 0, 2, r1.source]);
    // A row a bot added since stays when the import is undone; the table stays because it is not empty.
    await svcOf(t).write(owner.id, [{ sql: 'INSERT INTO klanten_lijst (naam) VALUES (?)', params: ['Later toegevoegd'] }]);
    const undo = await t.api('POST', '/teamdata/import/undo', { source: r1.source });
    assert.deepEqual(undo.map((x: any) => [x.name, x.removed, x.dropped]), [['klanten_lijst', 2, false]]);
    assert.deepEqual((await svcOf(t).rows(owner.id, 'SELECT naam FROM klanten_lijst')).map((r) => r.naam), ['Later toegevoegd']);

    // Excel: the first sheet with data, named after the sheet when the workbook has more than one.
    const xl = await upload(t, 'cijfers.xlsx', fs.readFileSync(path.join(FIX, 'cijfers.xlsx')));
    const r3 = await t.api('POST', '/teamdata/import', { attachmentId: xl.id });
    assert.deepEqual([r3.table, r3.sheet, r3.inserted], ['klanten', 'Klanten', 2]);
    assert.deepEqual(r3.columns.map((c: any) => `${c.name}:${c.type}`), ['naam:TEXT', 'plaats:TEXT', 'omzet:REAL']);
    const r4 = await t.api('POST', '/teamdata/import', { attachmentId: xl.id, sheet: 'Notities', table: 'Notities van klant' });
    assert.deepEqual([r4.table, r4.inserted], ['notities_van_klant', 1]);
    // Undo of a table the import made and nobody touched: the table goes too.
    const u2 = await t.api('POST', '/teamdata/import/undo', { source: r4.source });
    assert.deepEqual(u2.map((x: any) => [x.name, x.removed, x.dropped]), [['notities_van_klant', 1, true]]);
    assert.ok(!(await t.api('GET', '/teamdata/tables')).some((x: any) => x.name === 'notities_van_klant'));

    // Honest refusals.
    const pdf = await upload(t, 'scan.pdf', fs.readFileSync(path.join(FIX, 'scan.pdf')));
    await assert.rejects(t.api('POST', '/teamdata/import', { attachmentId: pdf.id }), /Alleen CSV-bestanden en Excel-werkmappen/);
    await assert.rejects(t.api('POST', '/teamdata/import', { attachmentId: xl.id, sheet: 'Bestaat niet' }), /Het blad “Bestaat niet” bestaat niet\. Bladen: Klanten, Notities/);
    await assert.rejects(t.api('POST', '/teamdata/import/undo', { source: '../x' }), /Onbekende import/);
  } finally {
    await t.close();
  }
});

test('a bot imports a CSV from its work folder with team_import_file (only into its own or a new table)', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const bot = await m.bot('Data', { tool_groups: ['files', 'team:data'] });
    fs.mkdirSync(bot.workspace, { recursive: true });
    fs.writeFileSync(path.join(bot.workspace, 'leads.csv'), 'naam,score\nAnna,8\nBram,6\n');
    m.script(
      'Data',
      { toolCalls: [{ name: 'team_import_file', args: { path: 'leads.csv' } }] },
      { toolCalls: [{ name: 'team_import_file', args: { path: 'leads.csv', table: 'taken' } }] },
      { text: 'Klaar.' },
    );
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    await t.say(th.id, 'Zet leads.csv in de teamdatabase');
    const out = msgs(t, th.id).filter((x: any) => x.role === 'tool' && x.parts?.toolResult?.name === 'team_import_file');
    assert.match(out[0].content, /^Tabel leads gemaakt: 2 rijen toegevoegd\. Kolommen: id, naam \(TEXT\), score \(INTEGER\)\./);
    assert.match(out[1].content, /De tabel taken is niet van jou/);
    const owner = t.app.ctx.auth.owner()!;
    assert.deepEqual((await svcOf(t).rows(owner.id, 'SELECT naam, score FROM leads ORDER BY id')).map((r) => `${r.naam}:${r.score}`), ['Anna:8', 'Bram:6']);
    const tbl = (await t.api('GET', '/teamdata/tables')).find((x: any) => x.name === 'leads');
    assert.equal(tbl.owner.name, 'Data', 'the table belongs to the bot that imported it');
  } finally {
    await t.close();
  }
});
