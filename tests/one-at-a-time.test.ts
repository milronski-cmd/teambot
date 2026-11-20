/** One bot at a time on what cannot be shared: putting a site live and writing to a person. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp } from './helpers.js';
import { deployClash, mailClash, repoOf, resetOneAtATime } from '../server/tools/one-at-a-time.js';

test('a second deploy of the same site minutes later is said once; a mail to a person a colleague just wrote too', async () => {
  const t = await startTestApp();
  try {
    resetOneAtATime();
    const ctx = t.app.ctx;
    const a = ctx.store.agent((await t.agent({ name: 'Bouwer Eén' })).id)!;
    const b = ctx.store.agent((await t.agent({ name: 'Bouwer Twee' })).id)!;
    const repo = path.join(t.dir, 'site');
    const tree = path.join(t.dir, 'wt', 'site-b');
    fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'site-b'), { recursive: true });
    fs.mkdirSync(tree, { recursive: true });
    fs.writeFileSync(path.join(tree, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'site-b')}\n`);
    assert.equal(repoOf(tree), repo, 'a worktree belongs to its repository');
    let now = 1_800_000_000_000;
    const live = (dir: string) => `cd "${dir}" && node build.mjs && vercel deploy --prod --yes`;
    assert.equal(deployClash(a, { id: 'r1' }, live(repo), undefined, now), null);
    assert.equal(deployClash(a, { id: 'r1' }, live(repo), undefined, now + 60_000), null, 'the same bot again');
    const said = deployClash(b, { id: 'r2' }, live(tree), undefined, now + 5 * 60_000)!;
    assert.match(said, /^Nog niet live gezet: Bouwer Eén zette site 4 min geleden live\./);
    assert.match(said, /git fetch, bouw vanaf de nieuwste main/);
    assert.equal(deployClash(b, { id: 'r2' }, live(tree), undefined, now + 6 * 60_000), null, 'the same step again goes through');
    resetOneAtATime();
    deployClash(a, { id: 'r1' }, live(repo), undefined, now);
    assert.equal(deployClash(b, { id: 'r3' }, live(repo), undefined, now + 21 * 60_000), null, 'long enough ago');
    assert.equal(deployClash(b, { id: 'r3' }, `cd "${repo}" && node build.mjs && git push`, undefined, now), null, 'no deploy');

    // Mail: a colleague wrote this person yesterday.
    const conn = `mcp_${Math.random().toString(36).slice(2, 12)}`;
    ctx.store.exec("INSERT INTO mcp_calls (user_id, connection_id, agent_id, thread_id, kind, tool, risk, summary, ok, error, duration_ms, created_at) VALUES (?, ?, ?, NULL, 'tool', 'gmail_draft', 'write', ?, 1, NULL, 5, ?)", a.user_id, conn, a.id, 'to: Jan <jan@klant.test> · subject: Offerte', new Date(Date.now() - 3_600_000).toISOString());
    const mail = mailClash(ctx, b, { id: 'r9' }, 'mcp_google_gmail_send', { to: 'Jan de Vries <Jan@klant.test>', subject: 'Re: Offerte', body: 'Hallo' })!;
    assert.match(mail, /^Nog niet gedaan: Bouwer Eén zette een concept klaar aan jan@klant\.test/);
    assert.equal(mailClash(ctx, b, { id: 'r9' }, 'mcp_google_gmail_send', { to: 'jan@klant.test' }), null, 'once per turn');
    assert.equal(mailClash(ctx, a, { id: 'r8' }, 'mcp_google_gmail_send', { to: 'jan@klant.test' }), null, 'his own contact');
    assert.equal(mailClash(ctx, b, { id: 'r7' }, 'mcp_google_gmail_send', { to: 'piet@ander.test' }), null, 'another person');
    assert.equal(mailClash(ctx, b, { id: 'r6' }, 'mcp_google_gmail_search', { to: 'jan@klant.test' }), null, 'reading is free');
  } finally {
    await t.close();
  }
});
