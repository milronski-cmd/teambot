import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/core/config.js';

/**
 * The data folder is always an absolute path, also when it is given relative (the documented dev command uses
 * `TEAMBOT_DATA=.data/dev`). A relative one broke every Claude Code turn: Claude Code runs in the bot's own folder and
 * did not find TeamBot's instructions file there ("Append system prompt file not found").
 */
test('a relative data folder (TEAMBOT_DATA or --data) becomes an absolute path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-datadir-'));
  const rel = path.relative(process.cwd(), dir);
  const prev = process.env.TEAMBOT_DATA;
  try {
    // Only meaningful when the temp folder is on the same drive (path.relative is then really relative).
    assert.equal(path.isAbsolute(rel), false, `relative path expected, got ${rel}`);
    process.env.TEAMBOT_DATA = rel;
    const fromEnv = loadConfig({ mode: 'desktop', uiDir: null });
    assert.ok(path.isAbsolute(fromEnv.dataDir), fromEnv.dataDir);
    assert.equal(fromEnv.dataDir, dir);
    const fromArg = loadConfig({ mode: 'desktop', uiDir: null, dataDir: rel });
    assert.equal(fromArg.dataDir, dir);
    assert.ok(fs.existsSync(path.join(dir, 'workspaces')), 'the folders are made in the same place');
  } finally {
    if (prev === undefined) delete process.env.TEAMBOT_DATA;
    else process.env.TEAMBOT_DATA = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
