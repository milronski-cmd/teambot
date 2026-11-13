import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * One rule for moving the user once an answer arrives (ui/src/lib/router.ts, `navigate(to, { from })`): only whoever is
 * still on the page that asked is moved. Found in the app: after #/ → #/a/<main bot> the user went to Kosten before
 * POST /api/threads answered, and was pulled into the chat anyway (shell/ChatView.tsx, AgentChatRoute).
 */

// The few browser globals the router touches.
const g = globalThis as any;
const seen: { events: number; pushes: number; replaces: number } = { events: 0, pushes: 0, replaces: 0 };
let hash = '';
g.location = {
  get hash() {
    return hash;
  },
  set hash(h: string) {
    hash = h.startsWith('#') ? h : '#' + h;
    seen.pushes++;
  },
};
g.history = {
  replaceState: (_s: unknown, _t: string, url: string) => {
    hash = url;
    seen.replaces++;
  },
};
g.HashChangeEvent ??= class extends Event {};
g.dispatchEvent = () => (seen.events++, true);

const { navigate } = await import('../ui/src/lib/router.js');

/** The user is on `h` (typed, clicked); counters start again. */
const at = (h: string) => {
  hash = h;
  Object.assign(seen, { events: 0, pushes: 0, replaces: 0 });
};
/** A request whose answer comes when the test says so. */
const later = <T>() => {
  let answer!: (v: T) => void;
  const p = new Promise<T>((r) => (answer = r));
  return { p, answer };
};

test('a bot link: the chat opens when the answer comes and the user is still waiting there', async () => {
  at('#/a/bot-1');
  const from = g.location.hash;
  const req = later<{ id: string }>();
  const done = req.p.then((t) => navigate(`/t/${t.id}`, { from, replace: true }));
  req.answer({ id: 'th-1' });
  await done;
  assert.equal(g.location.hash, '#/t/th-1');
  assert.deepEqual(seen, { events: 1, pushes: 0, replaces: 1 }, 'in place of #/a/<bot>, no extra step back');
});

test('a bot link, then Kosten before the answer: the user stays on Kosten', async () => {
  at('#/a/bot-1');
  const from = g.location.hash;
  const req = later<{ id: string }>();
  const done = req.p.then((t) => navigate(`/t/${t.id}`, { from, replace: true }));
  g.location.hash = '#/settings/usage';
  req.answer({ id: 'th-1' });
  await done;
  assert.equal(g.location.hash, '#/settings/usage');
  assert.equal(seen.events + seen.replaces, 0, 'nothing moved');
});

test('a dialog or tab in the query is still the same page; the start page in every spelling', () => {
  at('#/m/routines');
  navigate('/m/routines/r/r-1', { from: '#/m/routines?new=1' });
  assert.equal(g.location.hash, '#/m/routines/r/r-1');
  for (const start of ['', '#', '#/']) {
    at(start);
    navigate('/a/main', { from: '#/', replace: true });
    assert.equal(g.location.hash, '#/a/main', `from "${start}"`);
  }
  at('#/inbox');
  navigate('/a/main', { from: '#/', replace: true });
  assert.equal(g.location.hash, '#/inbox', 'whoever left the start page is not sent to the main bot');
});

test('without `from` a link goes where it says, as before', () => {
  at('#/settings/usage');
  navigate('/m/routines');
  assert.equal(g.location.hash, '#/m/routines');
  assert.deepEqual(seen, { events: 0, pushes: 1, replaces: 0 }, 'a normal step in the history');
  navigate('#/m/routines');
  assert.equal(seen.pushes, 1, 'already there: nothing happens');
});
