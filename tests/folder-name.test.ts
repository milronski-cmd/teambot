// A bot's folder by name, never the raw path with its internal id (acceptance round 4, Q-03: "…\workspaces\ag_…" on
// the Computers page, in the rehearsal panel and the delete dialog).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { folderName, isOwnWorkspace } from '../ui/src/lib/folderName.js';
import { folderMissing } from '../ui/src/modules/folders/missing.js';

test('team folder: "bestaat nog niet" only for the typed path, never for the folder just saved (and made)', () => {
  const p = 'C:\\Users\\x\\Documents\\TeamBot\\Teammap';
  const check = { path: p, missing: true };
  assert.equal(folderMissing(check, p, null), true, 'a new folder that does not exist yet');
  assert.equal(folderMissing(check, p, p), false, 'after "Opslaan" TeamBot made it');
  assert.equal(folderMissing(check, `${p} `, p), false, 'spaces around the path do not matter');
  assert.equal(folderMissing(check, `${p}2`, p), false, 'the check is for another path (still typing)');
  assert.equal(folderMissing({ path: `${p}2`, missing: true }, `${p}2`, p), true, 'another folder than the saved one');
  assert.equal(folderMissing({ path: p, missing: false }, p, null), false);
  assert.equal(folderMissing(null, p, null), false);
});

const OWN = 'C:\\Users\\x\\AppData\\Roaming\\TeamBot\\workspaces\\ag_0123456789abcdef012345';

test("TeamBot's own folder is \"Werkmap van <bot>\"; a chosen folder keeps its path", () => {
  assert.equal(isOwnWorkspace(OWN), true);
  assert.equal(isOwnWorkspace(`${OWN}\\notities`), true);
  assert.equal(isOwnWorkspace('/home/x/.teambot/workspaces/ag_0123456789abcdef012345'), true);
  assert.equal(isOwnWorkspace('D:\\Projecten\\website'), false);
  assert.equal(folderName(OWN, 'Mila'), 'Werkmap van Mila');
  assert.equal(folderName(OWN), 'Eigen werkmap van de bot');
  assert.equal(folderName('D:\\Projecten\\website', 'Mila'), 'D:\\Projecten\\website');
  assert.equal(folderName('', 'Mila'), 'Automatisch');
  assert.ok(!/ag_/.test(folderName(OWN, 'Mila')));
});
