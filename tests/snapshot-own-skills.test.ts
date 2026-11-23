// A snapshot of a bot's work folder keeps the bot's work, not what TeamBot writes there itself: the bot's skills as
// folders for a CLI engine (modules/skills/workspace.ts). Seen 21 nov 2026 in the full screen tests: "Herstellen" offered
// to put TeamBot's own list file back and to delete two skill folders as "later gemaakt", next to the one file the bot
// had really made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSnapshot, restorePlan, restoreSnapshot } from '../server/modules/browser/workspace.js';
import { SKILL_PLACES, ownSkillPaths } from '../server/modules/skills/workspace.js';

test('a snapshot leaves the skill folders TeamBot wrote itself alone: not kept, not put back, not deleted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-snap-root-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-snap-dir-'));
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-snap-old-'));
  const write = (rel: string, text: string) => {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  };
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
  const list = (names: string[]) => JSON.stringify({ managedBy: 'TeamBot', skills: Object.fromEntries(names.map((n) => [n, { id: n, state: 's', files: {} }])), kept: {} });
  try {
    write('werk.txt', 'oud');
    // At the time of the snapshot: one skill of TeamBot in both places, and a skill of the owner's own next to it.
    for (const place of SKILL_PLACES) {
      write(`${place}/.teambot-skills.json`, list(['schrijven']));
      write(`${place}/schrijven/SKILL.md`, 'schrijven');
    }
    write('.claude/skills/eigen/SKILL.md', 'van de eigenaar');
    // (An old snapshot, from before this rule: it has TeamBot's files in it.)
    assert.ok(createSnapshot(root, old).files['.claude/skills/schrijven/SKILL.md']);
    const m = createSnapshot(root, dir, { skip: ownSkillPaths(root) });
    assert.deepEqual(Object.keys(m.files).sort(), ['.claude/skills/eigen/SKILL.md', 'werk.txt'], 'the bot’s work and the owner’s own skill; nothing of TeamBot’s');

    // Later: the bot made a file, the owner changed his own skill, and TeamBot wrote a second skill and its list.
    write('later.txt', 'later gemaakt');
    write('.claude/skills/eigen/SKILL.md', 'aangepast');
    for (const place of SKILL_PLACES) {
      write(`${place}/.teambot-skills.json`, list(['schrijven', 'grill-me']));
      write(`${place}/grill-me/SKILL.md`, 'grill-me');
    }
    const own = ownSkillPaths(root);
    assert.equal(own('.agents/skills/grill-me/SKILL.md'), true);
    assert.equal(own('.agents/skills/.teambot-skills.json'), true);
    assert.equal(own('.claude/skills/eigen/SKILL.md'), false, 'a folder that is not on TeamBot’s list is the owner’s');
    assert.equal(own('later.txt'), false);

    const plan = restorePlan(root, dir, own);
    assert.deepEqual(plan.overwrite, ['.claude/skills/eigen/SKILL.md']);
    assert.deepEqual(plan.recreate, []);
    assert.deepEqual(plan.extra, ['later.txt'], 'only what the bot made later');
    // As it was, without the rule: TeamBot's own files were offered for deletion.
    assert.ok(restorePlan(root, dir).extra.includes('.claude/skills/grill-me/SKILL.md'));
    // The old snapshot has TeamBot's list file in it, and that file changed since: it is not put back either.
    const fromOld = restorePlan(root, old, own);
    assert.deepEqual(fromOld.overwrite, ['.claude/skills/eigen/SKILL.md']);
    assert.deepEqual(fromOld.extra, ['later.txt']);

    // Restoring with "delete what was made later": the bot's file goes, the owner's skill is back, TeamBot's stay.
    restoreSnapshot(root, dir, { deleteExtra: true, skip: own });
    assert.equal(fs.existsSync(path.join(root, 'later.txt')), false);
    assert.equal(read('.claude/skills/eigen/SKILL.md'), 'van de eigenaar');
    assert.equal(read('.claude/skills/grill-me/SKILL.md'), 'grill-me');
    assert.equal(read('.agents/skills/.teambot-skills.json'), list(['schrijven', 'grill-me']));

    // A folder without a list file of TeamBot, or with someone else's: nothing is TeamBot's.
    fs.rmSync(path.join(root, '.agents/skills/.teambot-skills.json'));
    write('.claude/skills/.teambot-skills.json', JSON.stringify({ managedBy: 'iemand anders', skills: { schrijven: {} } }));
    const none = ownSkillPaths(root);
    assert.equal(none('.agents/skills/grill-me/SKILL.md'), false);
    assert.equal(none('.claude/skills/schrijven/SKILL.md'), false);
  } finally {
    for (const d of [root, dir, old]) fs.rmSync(d, { recursive: true, force: true });
  }
});
