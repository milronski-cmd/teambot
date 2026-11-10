// Acceptance round 6, B-36: a move in practice mode was two rows ("verwijderd rommel/boodschappen.txt" + "nieuw
// rommel/lijstjes/boodschappen.txt"). Rejecting the new half and applying the rest removed the file from the real
// folder; only the automatic snapshot still had it. Now a move is one row that is applied or rejected as a unit, and
// a deletion whose content may live on only in a new file is never applied without that file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyRehearsal, detectMoves, planApply, readManifest, rehearsalChanges, rehearsalFileDiff, revertInCopy, similarity, startRehearsalCopy, type FileChange, type MoveSide } from '../server/modules/browser/workspace.js';

const side = (p: string, text: string | null, hash = text ?? p): MoveSide => ({ path: p, hash, size: text?.length ?? 10, text });
// Moved and rewritten too much to call it a move, but with the same name: related (similarity ≈ 0.42 + name bonus).
const TODO_OLD = 'Te doen:\n- melk halen\n- fiets maken\n';
const TODO_NEW = 'Te doen deze week:\n- melk halen\n- bellen met oma\n- tuin\n';

test('move detection: the same content is a move, also a rename in the same folder; an edit on the way is a move with an edit', () => {
  const list = 'melk\nbrood\neieren\nkaas\n';
  const plan = detectMoves(
    [side('rommel/boodschappen.txt', list), side('notities/idee.md', 'Een idee voor zondag\n'), side('weekmenu.md', '# Menu\n\nMaandag: pasta\nDinsdag: soep\nWoensdag: vis\n')],
    [side('rommel/lijstjes/boodschappen.txt', list), side('notities/ideeen.md', 'Een idee voor zondag\n'), side('archief/weekmenu.md', '# Menu\n\nMaandag: pasta\nDinsdag: soep\nWoensdag: vis\nDonderdag: stamppot\n')],
  );
  const by = Object.fromEntries(plan.moves.map((m) => [m.from, m]));
  assert.deepEqual(by['rommel/boodschappen.txt'], { from: 'rommel/boodschappen.txt', to: 'rommel/lijstjes/boodschappen.txt', edited: false });
  assert.deepEqual(by['notities/idee.md'], { from: 'notities/idee.md', to: 'notities/ideeen.md', edited: false }, 'rename in the same folder');
  assert.deepEqual(by['weekmenu.md'], { from: 'weekmenu.md', to: 'archief/weekmenu.md', edited: true }, 'moved and one line added');
  assert.deepEqual(plan.related, []);
});

test('move detection: unrelated files stay apart; two empty files are no move unless the name is the same', () => {
  const plan = detectMoves(
    [side('oud.txt', 'Vandaag heb ik de boodschappen gedaan en de fiets weggebracht.\n'), side('a/.gitkeep', '', 'leeg'), side('b/leeg.txt', '', 'leeg')],
    [side('nieuw.txt', 'The weather in the north is cold and there is a lot of rain.\n'), side('c/__init__.py', '', 'leeg'), side('d/leeg.txt', '', 'leeg')],
  );
  assert.deepEqual(plan.moves, [{ from: 'b/leeg.txt', to: 'd/leeg.txt', edited: false }]);
  assert.deepEqual(plan.related, []);
});

test('move detection: with several candidates the same name wins, and each file is in one move only', () => {
  const plan = detectMoves([side('a/rapport.md', 'zelfde', 'h1'), side('b/kopie.md', 'zelfde', 'h1')], [side('c/rapport.md', 'zelfde', 'h1')]);
  assert.deepEqual(plan.moves, [{ from: 'a/rapport.md', to: 'c/rapport.md', edited: false }]);
});

test('move detection: what only looks alike is related (two rows, safety net); a binary file with the same name too', () => {
  const plan = detectMoves(
    [side('facturen/factuur-001.md', 'Factuur 2026-001\nKlant: Jansen\nBedrag: 120 euro\nDatum: 1 november\n'), side('foto.jpg', null, 'x1')],
    [side('facturen/factuur-002.md', 'Factuur 2026-002\nKlant: Pietersen\nBedrag: 95 euro\nDatum: 3 november\n'), side('fotos/foto.jpg', null, 'x2')],
  );
  assert.deepEqual(plan.moves, []);
  assert.deepEqual(plan.related.sort((a, b) => a.from.localeCompare(b.from)), [
    { from: 'facturen/factuur-001.md', to: 'facturen/factuur-002.md' },
    { from: 'foto.jpg', to: 'fotos/foto.jpg' },
  ]);
});

test('similarity: small edits score high, unrelated text low, line endings do not count', () => {
  assert.ok(similarity('melk\nbrood\neieren\n', 'melk\nbrood\neieren\nkaas\n') > 0.8);
  assert.ok(similarity('Vandaag heb ik de boodschappen gedaan.\n', 'The weather in the north is cold.\n') < 0.3);
  assert.equal(similarity('een\r\ntwee\r\n', 'een\ntwee\n'), 1);
});

/** A real folder and its practice copy in TEMP. */
function practice(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-b36-'));
  const real = path.join(root, 'echt');
  const copy = path.join(root, 'oefen', 'work');
  const baseFile = path.join(root, 'oefen', 'base.json');
  for (const [k, v] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(real, k)), { recursive: true });
    fs.writeFileSync(path.join(real, k), v);
  }
  startRehearsalCopy(real, copy, baseFile);
  const move = (from: string, to: string, content?: string) => {
    fs.mkdirSync(path.dirname(path.join(copy, to)), { recursive: true });
    fs.renameSync(path.join(copy, from), path.join(copy, to));
    if (content !== undefined) fs.writeFileSync(path.join(copy, to), content);
  };
  const changes = () => rehearsalChanges(real, copy, readManifest(baseFile));
  const has = (k: string) => fs.existsSync(path.join(real, k));
  return { root, real, copy, baseFile, move, changes, has, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('B-36: a move is one "moved" row; rejecting it keeps the file where it was, nothing disappears', () => {
  const p = practice({ 'rommel/boodschappen.txt': 'melk\nbrood\n', 'README.md': '# Map\n' });
  try {
    p.move('rommel/boodschappen.txt', 'rommel/lijstjes/boodschappen.txt');
    fs.writeFileSync(path.join(p.copy, 'README.md'), '# Map\n\nOpgeruimd.\n');
    const ch = p.changes();
    assert.deepEqual(
      ch.map((c) => [c.change, c.from ?? null, c.path, !!c.edited]),
      [
        ['modified', null, 'README.md', false],
        ['moved', 'rommel/boodschappen.txt', 'rommel/lijstjes/boodschappen.txt', false],
      ],
      'no separate "deleted" and "added" rows',
    );
    // The round 6 path: reject the move, apply the rest. The shopping list stays in the real folder.
    const rv = revertInCopy(p.real, p.copy, p.baseFile, ['rommel/lijstjes/boodschappen.txt']);
    assert.deepEqual(rv.kept, []);
    assert.ok(fs.existsSync(path.join(p.copy, 'rommel/boodschappen.txt')) && !fs.existsSync(path.join(p.copy, 'rommel/lijstjes/boodschappen.txt')), 'the copy is back as it was');
    const ap = applyRehearsal(p.real, p.copy, p.baseFile, null);
    assert.deepEqual(ap.applied, ['README.md']);
    assert.equal(fs.readFileSync(path.join(p.real, 'rommel/boodschappen.txt'), 'utf8'), 'melk\nbrood\n');
    assert.ok(!p.has('rommel/lijstjes/boodschappen.txt'));
    assert.deepEqual(p.changes(), []);
  } finally {
    p.cleanup();
  }
});

test('B-36: applying a move moves the file in the real folder; the old or the new path selects the whole move', () => {
  for (const pick of ['rommel/lijstjes/boodschappen.txt', 'rommel/boodschappen.txt']) {
    const p = practice({ 'rommel/boodschappen.txt': 'melk\nbrood\n', 'andere.txt': 'blijft\n' });
    try {
      p.move('rommel/boodschappen.txt', 'rommel/lijstjes/boodschappen.txt');
      const ap = applyRehearsal(p.real, p.copy, p.baseFile, [pick]);
      assert.deepEqual(ap.applied, ['rommel/lijstjes/boodschappen.txt'], pick);
      assert.ok(!p.has('rommel/boodschappen.txt'), 'gone from the old place');
      assert.equal(fs.readFileSync(path.join(p.real, 'rommel/lijstjes/boodschappen.txt'), 'utf8'), 'melk\nbrood\n');
      assert.deepEqual(p.changes(), [], 'nothing left to choose');
    } finally {
      p.cleanup();
    }
  }
});

test('B-36: rename in the same folder, and a move with a small edit: one row each, with a diff old place → new place', () => {
  const p = practice({ 'notities/idee.md': 'Een idee voor zondag\n', 'weekmenu.md': '# Menu\n\nMaandag: pasta\nDinsdag: soep\nWoensdag: vis\n' });
  try {
    p.move('notities/idee.md', 'notities/ideeen.md');
    p.move('weekmenu.md', 'archief/weekmenu.md', '# Menu\n\nMaandag: pasta\nDinsdag: soep\nWoensdag: vis\nDonderdag: stamppot\n');
    const by = Object.fromEntries(p.changes().map((c) => [c.path, c]));
    assert.deepEqual([by['notities/ideeen.md'].change, by['notities/ideeen.md'].from, by['notities/ideeen.md'].edited], ['moved', 'notities/idee.md', false]);
    assert.deepEqual([by['archief/weekmenu.md'].change, by['archief/weekmenu.md'].from, by['archief/weekmenu.md'].edited], ['moved', 'weekmenu.md', true]);
    const d = rehearsalFileDiff(p.real, p.copy, readManifest(p.baseFile), 'archief/weekmenu.md', 'weekmenu.md');
    assert.equal(d.added, 1);
    assert.equal(d.removed, 0);
    assert.match(d.diff, /^\+Donderdag: stamppot$/m);
    assert.equal(d.inOriginal, true);
    assert.equal(d.conflict, false);
    // Apply the moved-and-changed file: the new place has the bot's version, the old place is gone.
    applyRehearsal(p.real, p.copy, p.baseFile, ['archief/weekmenu.md']);
    assert.ok(!p.has('weekmenu.md'));
    assert.match(fs.readFileSync(path.join(p.real, 'archief/weekmenu.md'), 'utf8'), /stamppot/);
    // Reject the rename: the idea keeps its old name.
    revertInCopy(p.real, p.copy, p.baseFile, ['notities/idee.md']);
    assert.ok(fs.existsSync(path.join(p.copy, 'notities/idee.md')) && !fs.existsSync(path.join(p.copy, 'notities/ideeen.md')));
    assert.deepEqual(p.changes(), []);
  } finally {
    p.cleanup();
  }
});

test('B-36 safety net: when old and new only look alike (two rows), not adding the new file keeps the old one', () => {
  const p = practice({ 'oud/todo.txt': TODO_OLD, 'ander.txt': 'een\n' });
  try {
    // Moved and rewritten too much to call it a move.
    p.move('oud/todo.txt', 'lijst/todo.txt', TODO_NEW);
    fs.writeFileSync(path.join(p.copy, 'ander.txt'), 'twee\n');
    const by = Object.fromEntries(p.changes().map((c) => [c.path, c]));
    assert.equal(by['oud/todo.txt'].change, 'deleted');
    assert.deepEqual(by['oud/todo.txt'].related, ['lijst/todo.txt']);
    assert.deepEqual(by['lijst/todo.txt'].related, ['oud/todo.txt']);
    // The round 6 path with two rows: "Niet toevoegen" on the new file, then "Alles toepassen".
    const rv = revertInCopy(p.real, p.copy, p.baseFile, ['lijst/todo.txt']);
    assert.deepEqual(rv.kept, [{ path: 'oud/todo.txt', because: 'lijst/todo.txt' }]);
    const ap = applyRehearsal(p.real, p.copy, p.baseFile, null);
    assert.deepEqual(ap.applied, ['ander.txt']);
    assert.equal(fs.readFileSync(path.join(p.real, 'oud/todo.txt'), 'utf8'), TODO_OLD, 'the content is not lost');
  } finally {
    p.cleanup();
  }
});

test('B-36 safety net: applying only the deletion waits for its new file; together, or after it, the deletion is done', () => {
  const p = practice({ 'oud/todo.txt': TODO_OLD });
  try {
    p.move('oud/todo.txt', 'lijst/todo.txt', TODO_NEW);
    const held = applyRehearsal(p.real, p.copy, p.baseFile, ['oud/todo.txt']);
    assert.deepEqual(held.applied, []);
    assert.deepEqual(held.held, [{ path: 'oud/todo.txt', keptFor: 'lijst/todo.txt' }]);
    assert.ok(p.has('oud/todo.txt'), 'not deleted while its content is only in the copy');
    // Then rejecting the new file still keeps the old one.
    assert.deepEqual(revertInCopy(p.real, p.copy, p.baseFile, ['lijst/todo.txt']).kept, [{ path: 'oud/todo.txt', because: 'lijst/todo.txt' }]);
    assert.ok(p.has('oud/todo.txt'));
    assert.deepEqual(p.changes(), []);
  } finally {
    p.cleanup();
  }
  const q = practice({ 'oud/todo.txt': TODO_OLD });
  try {
    q.move('oud/todo.txt', 'lijst/todo.txt', TODO_NEW);
    const both = applyRehearsal(q.real, q.copy, q.baseFile, ['oud/todo.txt', 'lijst/todo.txt']);
    assert.deepEqual(both.applied.sort(), ['lijst/todo.txt', 'oud/todo.txt']);
    assert.deepEqual(both.held, []);
    assert.ok(!q.has('oud/todo.txt') && q.has('lijst/todo.txt'));
  } finally {
    q.cleanup();
  }
});

test('B-36 safety net: a deletion without a look-alike is applied as before', () => {
  const p = practice({ 'weg.txt': 'weg\n', 'blijft.txt': 'blijft\n' });
  try {
    fs.rmSync(path.join(p.copy, 'weg.txt'));
    fs.writeFileSync(path.join(p.copy, 'nieuw.txt'), 'iets heel anders dan wat er stond\n');
    const ch = p.changes();
    assert.deepEqual(ch.map((c) => [c.change, c.path, c.related ?? null]), [['added', 'nieuw.txt', null], ['deleted', 'weg.txt', null]]);
    assert.deepEqual(applyRehearsal(p.real, p.copy, p.baseFile, ['weg.txt']).applied, ['weg.txt']);
    assert.ok(!p.has('weg.txt'));
  } finally {
    p.cleanup();
  }
});

test('B-36: a move whose old file the owner changed meanwhile is a conflict; the bot\'s version only when forced', () => {
  const p = practice({ 'rommel/boodschappen.txt': 'melk\nbrood\n' });
  try {
    p.move('rommel/boodschappen.txt', 'lijstjes/boodschappen.txt');
    fs.writeFileSync(path.join(p.real, 'rommel/boodschappen.txt'), 'melk\nbrood\nkoffie\n');
    const [c] = p.changes();
    assert.deepEqual([c.change, c.conflict], ['moved', true]);
    const ap = applyRehearsal(p.real, p.copy, p.baseFile, null);
    assert.deepEqual(ap.conflicts, ['lijstjes/boodschappen.txt']);
    assert.equal(fs.readFileSync(path.join(p.real, 'rommel/boodschappen.txt'), 'utf8'), 'melk\nbrood\nkoffie\n');
    assert.ok(!p.has('lijstjes/boodschappen.txt'));
    const forced = applyRehearsal(p.real, p.copy, p.baseFile, ['rommel/boodschappen.txt'], ['rommel/boodschappen.txt']);
    assert.deepEqual(forced.applied, ['lijstjes/boodschappen.txt']);
    assert.ok(!p.has('rommel/boodschappen.txt') && p.has('lijstjes/boodschappen.txt'));
  } finally {
    p.cleanup();
  }
});

test('B-36: a rename that only changes upper/lower case keeps the file (one file on Windows and macOS)', () => {
  const p = practice({ 'Notities.txt': 'een\ntwee\n' });
  try {
    p.move('Notities.txt', 'notities.txt');
    const ch = p.changes();
    assert.deepEqual(ch.map((c) => [c.change, c.from, c.path]), [['moved', 'Notities.txt', 'notities.txt']]);
    applyRehearsal(p.real, p.copy, p.baseFile, null);
    assert.deepEqual(fs.readdirSync(p.real), ['notities.txt']);
    assert.equal(fs.readFileSync(path.join(p.real, 'notities.txt'), 'utf8'), 'een\ntwee\n');
    assert.deepEqual(p.changes(), []);
  } finally {
    p.cleanup();
  }
  const q = practice({ 'Notities.txt': 'een\ntwee\n' });
  try {
    q.move('Notities.txt', 'notities.txt');
    revertInCopy(q.real, q.copy, q.baseFile, ['notities.txt']);
    assert.deepEqual(fs.readdirSync(q.copy), ['Notities.txt'], 'rejecting the rename brings the old name back in the copy');
    assert.deepEqual(q.changes(), []);
  } finally {
    q.cleanup();
  }
});

test('planApply: a move is selected or forced by either path; held deletions are listed, not applied', () => {
  const ch: FileChange[] = [
    { path: 'b/x.txt', from: 'a/x.txt', change: 'moved', conflict: true, binary: false },
    { path: 'oud.txt', change: 'deleted', conflict: false, binary: false, related: ['nieuw.txt'] },
    { path: 'nieuw.txt', change: 'added', conflict: false, binary: false, related: ['oud.txt'] },
  ];
  assert.deepEqual(planApply(ch, ['a/x.txt']).conflicts, ['b/x.txt']);
  assert.deepEqual(planApply(ch, ['a/x.txt'], ['a/x.txt']).targets.map((c) => c.path), ['b/x.txt']);
  const only = planApply(ch, ['oud.txt']);
  assert.deepEqual([only.targets, only.held], [[], [{ path: 'oud.txt', keptFor: 'nieuw.txt' }]]);
  assert.deepEqual(planApply(ch, null, []).targets.map((c) => c.path), ['oud.txt', 'nieuw.txt']);
});

test('B-36 over the API: one moved row, a diff across the move, "kept" and "held" notices, and an undo snapshot of the old place', async () => {
  const { startTestApp } = await import('./helpers.js');
  const t = await startTestApp();
  try {
    const a = await t.agent({ name: 'Opruimer' });
    const real = t.app.ctx.store.agent(a.id)!.workspace;
    fs.mkdirSync(path.join(real, 'rommel'), { recursive: true });
    fs.writeFileSync(path.join(real, 'rommel', 'boodschappen.txt'), 'melk\nbrood\neieren\n');
    fs.writeFileSync(path.join(real, 'todo.txt'), TODO_OLD);
    const r = await t.api('POST', `/computers/${a.id}/rehearsal`, {});
    fs.mkdirSync(path.join(r.copy_dir, 'rommel', 'lijstjes'), { recursive: true });
    fs.renameSync(path.join(r.copy_dir, 'rommel', 'boodschappen.txt'), path.join(r.copy_dir, 'rommel', 'lijstjes', 'boodschappen.txt'));
    fs.appendFileSync(path.join(r.copy_dir, 'rommel', 'lijstjes', 'boodschappen.txt'), 'kaas\n');
    fs.mkdirSync(path.join(r.copy_dir, 'lijst'), { recursive: true });
    fs.renameSync(path.join(r.copy_dir, 'todo.txt'), path.join(r.copy_dir, 'lijst', 'todo.txt'));
    fs.writeFileSync(path.join(r.copy_dir, 'lijst', 'todo.txt'), TODO_NEW);

    const st = await t.api('GET', `/computers/${a.id}/rehearsal`);
    const by = Object.fromEntries(st.changes.map((c: any) => [c.path, c]));
    assert.deepEqual([by['rommel/lijstjes/boodschappen.txt'].change, by['rommel/lijstjes/boodschappen.txt'].from, by['rommel/lijstjes/boodschappen.txt'].edited], ['moved', 'rommel/boodschappen.txt', true]);
    assert.equal(by['rommel/boodschappen.txt'], undefined, 'no separate deleted row');
    const d = await t.api('GET', `/computers/rehearsals/${r.id}/diff?path=${encodeURIComponent('rommel/lijstjes/boodschappen.txt')}&from=${encodeURIComponent('rommel/boodschappen.txt')}`);
    assert.equal(d.before, 'melk\nbrood\neieren\n');
    assert.equal(d.after, 'melk\nbrood\neieren\nkaas\n');
    await assert.rejects(t.api('GET', `/computers/rehearsals/${r.id}/diff?path=x.txt&from=../../geheim.txt`), /-> 4\d\d/);

    // Deleting todo.txt alone waits for lijst/todo.txt.
    const held = await t.api('POST', `/computers/rehearsals/${r.id}/apply`, { files: ['todo.txt'] });
    assert.deepEqual(held.held, [{ path: 'todo.txt', keptFor: 'lijst/todo.txt' }]);
    assert.ok(fs.existsSync(path.join(real, 'todo.txt')));
    const rv = await t.api('POST', `/computers/rehearsals/${r.id}/revert`, { files: ['lijst/todo.txt'] });
    assert.deepEqual(rv.kept, [{ path: 'todo.txt', because: 'lijst/todo.txt' }]);

    // Apply the move: an undo snapshot holds the old place first.
    const ap = await t.api('POST', `/computers/rehearsals/${r.id}/apply`, { files: ['rommel/lijstjes/boodschappen.txt'] });
    assert.deepEqual(ap.applied, ['rommel/lijstjes/boodschappen.txt']);
    assert.ok(ap.snapshotId);
    const snap = t.app.ctx.store.get<any>('workspace_snapshots', ap.snapshotId);
    assert.equal(snap.label, 'Voor toepassen repetitie (1 bestand)');
    assert.equal(fs.readFileSync(path.join(snap.dir, 'files', 'rommel', 'boodschappen.txt'), 'utf8'), 'melk\nbrood\neieren\n');
    assert.ok(!fs.existsSync(path.join(real, 'rommel', 'boodschappen.txt')));
    assert.equal(fs.readFileSync(path.join(real, 'rommel', 'lijstjes', 'boodschappen.txt'), 'utf8'), 'melk\nbrood\neieren\nkaas\n');
    assert.deepEqual((await t.api('GET', `/computers/rehearsals/${r.id}`)).changes, []);
  } finally {
    await t.close();
  }
});
