import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyRehearsal, compareRehearsalFiles, readManifest, rehearsalChanges, rehearsalFileDiff, revertInCopy, startRehearsalCopy } from '../server/modules/browser/workspace.js';
import { lineDiff } from '../ui/src/shell/textDiff.js';

test('practice run vs real folder (B-42): both versions side by side, apply or discard per file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-reh-'));
  try {
    const real = path.join(root, 'echt');
    const copy = path.join(root, 'kopie', 'files');
    const baseFile = path.join(root, 'kopie', 'base.json');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'plan.md'), 'Maandag: fietsen\nDinsdag: zwemmen\nWoensdag: rust\n');
    fs.writeFileSync(path.join(real, 'notities.txt'), 'oud\n');
    startRehearsalCopy(real, copy, baseFile);
    // The bot changes two files and adds one, in the copy only.
    fs.writeFileSync(path.join(copy, 'plan.md'), 'Maandag: fietsen\nDinsdag: hardlopen\nWoensdag: rust\n');
    fs.writeFileSync(path.join(copy, 'notities.txt'), 'nieuw\n');
    fs.writeFileSync(path.join(copy, 'extra.md'), 'Extra\n');
    const base = readManifest(baseFile);

    const d = rehearsalFileDiff(real, copy, base, 'plan.md');
    assert.equal(d.before, 'Maandag: fietsen\nDinsdag: zwemmen\nWoensdag: rust\n', 'left: the real folder');
    assert.equal(d.after, 'Maandag: fietsen\nDinsdag: hardlopen\nWoensdag: rust\n', 'right: the practice run');
    assert.equal(d.inOriginal, true);
    const rows = lineDiff(d.before!, d.after!);
    const changed = rows.find((r) => r.kind === 'change') as any;
    assert.ok(changed.pieces.some((p: any) => p.kind === 'del' && /zwemmen/.test(p.text)) && changed.pieces.some((p: any) => p.kind === 'ins' && /hardlopen/.test(p.text)), 'the changed words are marked on each side');
    const added = rehearsalFileDiff(real, copy, base, 'extra.md');
    assert.equal(added.inOriginal, false);
    assert.equal(added.before, '');

    // Apply one file: only that one reaches the real folder.
    assert.deepEqual(applyRehearsal(real, copy, baseFile, ['plan.md']).applied, ['plan.md']);
    assert.match(fs.readFileSync(path.join(real, 'plan.md'), 'utf8'), /hardlopen/);
    assert.equal(fs.readFileSync(path.join(real, 'notities.txt'), 'utf8'), 'oud\n');
    assert.ok(!fs.existsSync(path.join(real, 'extra.md')));
    // Discard one file: the copy goes back to the real version, the other change stays open.
    revertInCopy(real, copy, baseFile, ['notities.txt']);
    const left = rehearsalChanges(real, copy, readManifest(baseFile)).map((c) => c.path);
    assert.ok(!left.includes('notities.txt'), 'discarded');
    assert.ok(left.includes('extra.md'), 'still waiting for a choice');
    assert.equal(fs.readFileSync(path.join(real, 'notities.txt'), 'utf8'), 'oud\n', 'the real folder never changed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('two bots practising in the same folder (B-42): per file both versions side by side, apply the one you choose', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-reh2-'));
  try {
    const real = path.join(root, 'echt');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'plan.md'), 'Maandag: fietsen\nDinsdag: zwemmen\n');
    fs.writeFileSync(path.join(real, 'notities.txt'), 'oud\n');
    const a = { original: real, copyDir: path.join(root, 'a', 'files'), baseFile: path.join(root, 'a', 'base.json') };
    const b = { original: real, copyDir: path.join(root, 'b', 'files'), baseFile: path.join(root, 'b', 'base.json') };
    startRehearsalCopy(real, a.copyDir, a.baseFile);
    startRehearsalCopy(real, b.copyDir, b.baseFile);
    // Ada and Bram each make their own version of plan.md; only Bram adds a file; only Ada touches the notes.
    fs.writeFileSync(path.join(a.copyDir, 'plan.md'), 'Maandag: fietsen\nDinsdag: hardlopen\n');
    fs.writeFileSync(path.join(b.copyDir, 'plan.md'), 'Maandag: fietsen\nDinsdag: yoga\nWoensdag: rust\n');
    fs.writeFileSync(path.join(b.copyDir, 'menu.md'), 'Pasta\n');
    fs.writeFileSync(path.join(a.copyDir, 'notities.txt'), 'nieuw\n');
    const A = { ...a, base: readManifest(a.baseFile) };
    const B = { ...b, base: readManifest(b.baseFile) };

    const plan = compareRehearsalFiles(A, B, 'plan.md');
    assert.equal(plan.left, 'Maandag: fietsen\nDinsdag: hardlopen\n', "left: Ada's practice run");
    assert.equal(plan.right, 'Maandag: fietsen\nDinsdag: yoga\nWoensdag: rust\n', "right: Bram's practice run");
    assert.deepEqual([plan.leftChanged, plan.rightChanged, plan.same], [true, true, false]);
    const rows = lineDiff(plan.left!, plan.right!);
    assert.ok(rows.some((r) => r.kind === 'change'), 'the existing diff view marks what differs');
    const menu = compareRehearsalFiles(A, B, 'menu.md');
    assert.deepEqual([menu.inLeft, menu.inRight, menu.leftChanged, menu.rightChanged], [false, true, false, true], 'only Bram made it');
    const notes = compareRehearsalFiles(A, B, 'notities.txt');
    assert.deepEqual([notes.left, notes.right, notes.rightChanged], ['nieuw\n', 'oud\n', false], "Bram still has the real folder's version");

    // Choose Bram's plan: it goes into the real folder; Ada's own change to it now waits as a conflict (never
    // silently overwrites the version the owner just chose).
    assert.deepEqual(applyRehearsal(real, b.copyDir, b.baseFile, ['plan.md']).applied, ['plan.md']);
    assert.match(fs.readFileSync(path.join(real, 'plan.md'), 'utf8'), /yoga/);
    const adaLeft = rehearsalChanges(real, a.copyDir, readManifest(a.baseFile));
    assert.equal(adaLeft.find((c) => c.path === 'plan.md')!.conflict, true);
    assert.deepEqual(applyRehearsal(real, a.copyDir, a.baseFile, ['plan.md']).conflicts, ['plan.md']);
    assert.match(fs.readFileSync(path.join(real, 'plan.md'), 'utf8'), /yoga/);
    assert.ok(!fs.existsSync(path.join(real, 'menu.md')), 'nothing else moved');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('comparing practice runs over the API: only two open runs of your own in the same folder', async () => {
  const { startTestApp } = await import('./helpers.js');
  const t = await startTestApp();
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-reh3-'));
  try {
    const ada = await t.agent({ name: 'Ada' });
    const bram = await t.agent({ name: 'Bram' });
    const solo = await t.agent({ name: 'Solo' });
    const real = t.app.ctx.store.agent(ada.id)!.workspace;
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'plan.md'), 'Dinsdag: zwemmen\n');
    t.app.ctx.store.updateAgent(bram.id, { workspace: real });
    t.app.ctx.store.updateAgent(solo.id, { workspace: extra });
    const ra = await t.api('POST', `/computers/${ada.id}/rehearsal`, {});
    const rb = await t.api('POST', `/computers/${bram.id}/rehearsal`, {});
    const rs = await t.api('POST', `/computers/${solo.id}/rehearsal`, {});
    fs.writeFileSync(path.join(ra.copy_dir, 'plan.md'), 'Dinsdag: hardlopen\n');
    fs.writeFileSync(path.join(rb.copy_dir, 'plan.md'), 'Dinsdag: yoga\n');
    const both = await t.api('GET', `/computers/${ada.id}/rehearsal/compare`);
    assert.deepEqual(both.map((x: any) => x.agent).sort(), ['Ada', 'Bram']);
    const d = await t.api('GET', `/computers/rehearsals/${ra.id}/compare?with=${rb.id}&path=plan.md`);
    assert.deepEqual([d.left, d.right], ['Dinsdag: hardlopen\n', 'Dinsdag: yoga\n']);
    await assert.rejects(t.api('GET', `/computers/rehearsals/${ra.id}/compare?with=${rs.id}&path=plan.md`), /niet in dezelfde map/);
    await assert.rejects(t.api('GET', `/computers/rehearsals/${ra.id}/compare?with=${rb.id}&path=../../geheim.txt`), /-> 4\d\d/);
    // Apply Bram's version through the normal per-file apply.
    await t.api('POST', `/computers/rehearsals/${rb.id}/apply`, { files: ['plan.md'] });
    assert.equal(fs.readFileSync(path.join(real, 'plan.md'), 'utf8'), 'Dinsdag: yoga\n');
  } finally {
    await t.close();
    fs.rmSync(extra, { recursive: true, force: true });
  }
});
