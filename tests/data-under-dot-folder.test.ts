// A data folder under a folder whose name starts with a dot (~/.local/share/teambot on Linux, a trial or test folder
// under .data\). Express refuses such a path by default, so every frame of a bot's browser came back as "not found"
// dressed as "image/jpeg; charset=utf-8", and spoken or recorded audio as JSON (the full test run with TMP under
// .data\, 12 Nov 2026). TeamBot's own files go through one sender (core/http.ts sendOwnFile), and an error is JSON
// with its own type, never under the type of the file the route meant to send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestApp, type TestApp } from './helpers.js';
import { HttpError } from '../server/core/http.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 0xff, 0xd9]);

/** A test app whose data folder lies under `.local/share` (the temporary folder points there while it starts). */
async function underDotFolder(): Promise<TestApp> {
  const dotted = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-dot-')), '.local', 'share');
  fs.mkdirSync(dotted, { recursive: true });
  const keep = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = dotted;
  try {
    return await startTestApp();
  } finally {
    for (const [k, v] of Object.entries(keep)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

test('a data folder under a dot-folder: a frame of the bot’s browser is served as the image it is', async () => {
  const t = await underDotFolder();
  try {
    assert.ok(t.dir.includes(`${path.sep}.local${path.sep}`), t.dir);
    const ctx = t.app.ctx;
    const userId = ctx.auth.owner()!.id;
    const bot = await t.agent({ name: 'Kijker' });
    ctx.store.insert('computer_actions', { id: 'act_dot', user_id: userId, agent_id: bot.id, actor: 'bot', tool: 'browser_screenshot', created_at: new Date().toISOString() });
    await ctx.services.computers._service.saveFrame(userId, bot.id, 'act_dot', JPEG);
    const r = await fetch(`${t.app.url}/api/computers/${bot.id}/actions/act_dot/frame`, { headers: { authorization: `Bearer ${t.token}` } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), JPEG);
  } finally {
    await t.close();
  }
});

test('an error after a route named its file type is JSON with its own type, not "image/jpeg; charset=utf-8"', async () => {
  const t = await underDotFolder();
  try {
    t.app.ctx.api.get('/proef/kapot-beeld', (_req, res, next) => {
      res.type('jpeg').setHeader('content-disposition', 'attachment; filename="beeld.jpg"');
      next(new HttpError(404, 'Beeld is opgeruimd'));
    });
    const r = await fetch(`${t.app.url}/api/proef/kapot-beeld`, { headers: { authorization: `Bearer ${t.token}` } });
    assert.equal(r.status, 404);
    assert.equal(r.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(r.headers.get('content-disposition'), null);
    assert.deepEqual(await r.json(), { error: 'Beeld is opgeruimd' });
  } finally {
    await t.close();
  }
});
