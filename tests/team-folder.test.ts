import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { startTestApp } from './helpers.js';
import { suggestTeamFolder, otherAppFolder } from '../server/modules/folders/index.js';

/** Team folder setup: a TeamBot folder under Documents as the example (never another app's live folder), created when missing. */

test('the suggested team folder is a TeamBot folder under Documents, never OpenBot\'s live folder', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-home-'));
  try {
    fs.mkdirSync(path.join(home, 'OpenBot', 'Shared'), { recursive: true });
    fs.mkdirSync(path.join(home, 'Documents'), { recursive: true });
    const s = suggestTeamFolder(home);
    assert.equal(s, path.join(home, 'Documents', 'TeamBot', 'Teammap'), 'never the live OpenBot folder');
    assert.equal(otherAppFolder(path.join(home, 'OpenBot', 'Shared'), home), 'OpenBot');
    assert.equal(otherAppFolder(s, home), null);
    fs.mkdirSync(path.join(home, 'TeamBot', 'Gedeeld'), { recursive: true });
    assert.equal(suggestTeamFolder(home), path.join(home, 'TeamBot', 'Gedeeld'), 'an older TeamBot folder in use stays');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('team folder: a folder that does not exist yet is reported as missing (the UI turns "Map aanmaken" on)', async () => {
  const t = await startTestApp();
  try {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-teammap-'));
    const target = path.join(base, 'nieuw', 'Teammap');
    const chk = await t.api('POST', '/folders/check', { path: target });
    assert.equal(chk.ok, false);
    assert.equal(chk.missing, true);
    const st = await t.api('GET', '/folders/team');
    assert.ok(!/OpenBot/i.test(st.suggestion), st.suggestion);
    await t.api('PUT', '/folders/team', { path: target, create: true });
    assert.ok(fs.existsSync(target));
    fs.rmSync(base, { recursive: true, force: true });
  } finally {
    await t.close();
  }
});

// Acceptance round 6 (B-46): a local Ollama bot read "Lees een tekstbestand uit de werkmap" as "only relative paths",
// turned C:\…\tb-r6e-extra\prijzen.txt into "tb-r6e-extra/prijzen.txt" and never reached its extra folder.
test('the file tools tell the model that a full path into an extra folder or the team folder works', async () => {
  const { fileTools } = await import('../server/tools/builtin/files.js');
  for (const name of ['list_files', 'read_file', 'write_file', 'edit_file']) {
    const def = fileTools().find((t) => t.name === name)!;
    assert.match(String((def.parameters as any).properties.path.description || ''), /volledig pad in een van je extra mappen of de teammap/, name);
  }
});
