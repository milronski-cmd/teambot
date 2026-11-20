/** Two bots in one checkout of a repository: the second hears it once, with the command for a worktree of its own. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp } from './helpers.js';
import { checkoutOf, resetSharedCheckouts, sharedCheckout } from '../server/tools/shared-repo.js';

test('the first write into a checkout where a colleague is writing is refused once; a worktree is a checkout of its own', async () => {
  const t = await startTestApp();
  try {
    resetSharedCheckouts();
    const ctx = t.app.ctx;
    const a = ctx.store.agent((await t.agent({ name: 'Bouwer Eén', access_mode: 'full' })).id)!;
    const b = ctx.store.agent((await t.agent({ name: 'Bouwer Twee', access_mode: 'full' })).id)!;
    const repo = path.join(t.dir, 'site');
    const tree = path.join(t.dir, 'site-b');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.mkdirSync(tree, { recursive: true });
    fs.writeFileSync(path.join(tree, '.git'), 'gitdir: ' + path.join(repo, '.git', 'worktrees', 'site-b'));
    assert.equal(checkoutOf(path.join(repo, 'src', 'build.mjs')), repo);
    assert.equal(checkoutOf(path.join(tree, 'x.mjs')), tree);
    assert.equal(checkoutOf(path.join(t.dir, 'los.txt')), null);

    const live = new Set(['run_a', 'run_b']);
    const o = (now: number) => ({ now, active: (id: string) => live.has(id) });
    const file = path.join(repo, 'src', 'build.mjs');
    let now = 1_800_000_000_000;
    // Alone in the checkout: nothing is said, however often.
    assert.equal(sharedCheckout(ctx, a, { id: 'run_a' }, [file], o(now)), null);
    assert.equal(sharedCheckout(ctx, a, { id: 'run_a' }, [file], o(now + 1000)), null);
    // The colleague's first write there: refused once, with who, where and the worktree command; the same step again goes on.
    now += 3 * 60_000;
    const said = sharedCheckout(ctx, b, { id: 'run_b' }, [file], o(now))!;
    assert.match(said, /^Nog niet geschreven: Bouwer Eén werkt op dit moment ook in /);
    assert.ok(said.includes(`git -C "${repo}" worktree add "`) && /werkbomen.site" -b bouwer-twee\/\d{4}-\d\d-\d\d/.test(said), said);
    assert.equal(sharedCheckout(ctx, b, { id: 'run_b' }, [file], o(now + 1000)), null);
    // In its own worktree nobody collides.
    assert.equal(sharedCheckout(ctx, b, { id: 'run_b' }, [path.join(tree, 'x.mjs')], o(now)), null);
    // The first one hears it too on its next write (the other is in the checkout now), once.
    assert.match(sharedCheckout(ctx, a, { id: 'run_a' }, [file], o(now + 2000)) || '', /Bouwer Twee werkt op dit moment ook/);
    // A colleague whose turn ended, or who wrote more than half an hour ago, is not in the way.
    resetSharedCheckouts();
    sharedCheckout(ctx, a, { id: 'run_a' }, [file], o(now));
    live.delete('run_a');
    assert.equal(sharedCheckout(ctx, b, { id: 'run_b2' }, [file], o(now + 1000)), null);
    resetSharedCheckouts();
    live.add('run_a');
    sharedCheckout(ctx, a, { id: 'run_a' }, [file], o(now));
    assert.equal(sharedCheckout(ctx, b, { id: 'run_b3' }, [file], o(now + 31 * 60_000)), null);
  } finally {
    await t.close();
  }
});
