import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { startTestApp } from './helpers.js';
import { b64u, decryptPayload } from '../server/modules/mobile/webpush.js';
import { isApplePush } from '../server/modules/mobile/push.js';
import type { Mobile } from '../server/modules/mobile/index.js';
import { approvalIdOfItem, approvalIdOfTag, approvalTag, closeHandled, closeHandledEverywhere, PageNotes } from '../ui/src/modules/notifications/handled.js';

/**
 * PARITEIT 15.1 (web): a browser or phone-app notification for an approval or question goes away once it is handled
 * elsewhere. The Windows version is tests/desktop-notes.test.ts.
 */

class Note {
  closed = 0;
  constructor(public tag?: string) {}
  close() {
    this.closed++;
  }
}

test('handled helpers: only approval notifications of handled approvals are closed', async () => {
  assert.equal(approvalTag('apr_1'), 'apr-apr_1');
  assert.equal(approvalIdOfTag('apr-apr_1'), 'apr_1');
  assert.equal(approvalIdOfTag('n-#/t/abc'), null);
  assert.equal(approvalIdOfTag('apr-../x'), null);
  assert.equal(approvalIdOfItem({ ref: 'apr:apr_9' }), 'apr_9');
  assert.equal(approvalIdOfItem({ ref: 'run:r1' }), null);
  assert.equal(approvalIdOfItem(null), null);

  const a = new Note('apr-apr_1');
  const b = new Note('apr-apr_2');
  const other = new Note('n-#/t/abc');
  const untagged = new Note();
  assert.equal(closeHandled([a, b, other, untagged], { handled: 'apr_1' }), 1);
  assert.deepEqual([a.closed, b.closed, other.closed, untagged.closed], [1, 0, 0, 0]);
  // Opening the app: everything that no longer waits goes, what still waits stays.
  const c = new Note('apr-apr_3');
  assert.equal(closeHandled([b, c, other], { pending: new Set(['apr_3']) }), 1);
  assert.deepEqual([b.closed, c.closed, other.closed], [1, 0, 0]);
  assert.equal(closeHandled([c], {}), 0, 'no handled id and no pending list: nothing');

  // The page's own notifications plus the service worker's.
  const page = new PageNotes();
  const p1 = new Note('apr-apr_5');
  const p2 = new Note('apr-apr_6');
  page.add(p1);
  page.add(p2);
  const sw = [new Note('apr-apr_5'), new Note('n-x')];
  const asked: any[] = [];
  const reg = {
    async getNotifications(f?: { tag?: string }) {
      asked.push(f);
      return sw.filter((n) => !f?.tag || n.tag === f.tag);
    },
  };
  assert.equal(await closeHandledEverywhere(reg, page, { handled: 'apr_5' }), 2);
  assert.deepEqual(asked, [{ tag: 'apr-apr_5' }]);
  assert.deepEqual([p1.closed, p2.closed, sw[0].closed, sw[1].closed], [1, 0, 1, 0]);
  assert.equal(page.size, 1);
  page.forget(p2);
  assert.equal(page.size, 0);
  // No service worker (a plain browser tab) and a registration that throws: no error.
  assert.equal(await closeHandledEverywhere(null, page, { handled: 'apr_5' }), 0);
  assert.equal(await closeHandledEverywhere({ getNotifications: async () => Promise.reject(new Error('nope')) }, page, { handled: 'x' }), 0);
});

/** Run ui/public/sw.js in a sandbox with a fake service worker scope. */
function loadServiceWorker() {
  const listeners: Record<string, (e: any) => void> = {};
  const shown: { title: string; opts: any }[] = [];
  const notes: Note[] = [];
  const self: any = {
    location: { origin: 'https://teambot.test' },
    addEventListener: (type: string, fn: (e: any) => void) => (listeners[type] = fn),
    registration: {
      showNotification: async (title: string, opts: any) => {
        shown.push({ title, opts });
        notes.push(new Note(opts.tag));
      },
      getNotifications: async (f?: { tag?: string }) => notes.filter((n) => !n.closed && (!f?.tag || n.tag === f.tag)),
    },
    clients: { matchAll: async () => [], claim: async () => {} },
    skipWaiting: async () => {},
  };
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'ui', 'public', 'sw.js'), 'utf8');
  vm.runInNewContext(src, { self, caches: {}, fetch: async () => ({}), URL, Response: class {}, Promise, console });
  const push = async (data: any) => {
    let wait: Promise<any> = Promise.resolve();
    listeners.push({ data: { json: () => data, text: () => JSON.stringify(data) }, waitUntil: (p: Promise<any>) => (wait = p) });
    await wait;
  };
  return { push, shown, notes };
}

test('service worker: a close push takes the approval notification away and shows nothing', async () => {
  const sw = loadServiceWorker();
  await sw.push({ title: 'Ada vraagt toestemming', body: 'a.txt schrijven', link: '#/t/abc', tag: 'apr-apr_1', kind: 'approval' });
  await sw.push({ title: 'Ada is klaar', body: 'Rapport', link: '#/t/abc', tag: 'run-abc', kind: 'run' });
  assert.equal(sw.shown.length, 2);
  assert.equal(sw.shown[0].opts.requireInteraction, true);
  await sw.push({ title: 'TeamBot', body: 'Al afgehandeld', link: '#/', tag: 'apr-apr_1', kind: 'close', silent: true });
  assert.equal(sw.shown.length, 2, 'a close push shows nothing');
  assert.equal(sw.notes[0].closed, 1, 'the approval notification is closed');
  assert.equal(sw.notes[1].closed, 0, 'other notifications stay');
  // A close push can only close approval notifications.
  await sw.push({ kind: 'close', tag: 'run-abc' });
  await sw.push({ kind: 'close' });
  assert.equal(sw.notes[1].closed, 0);
  assert.equal(sw.shown.length, 2);
});

function subscriber() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { priv: ecdh.getPrivateKey(), p256dh: b64u.enc(ecdh.getPublicKey()), auth: b64u.enc(crypto.randomBytes(16)) };
}

test('an approval pushed to the phone gets a close push once decided elsewhere (not to Apple, not twice, not for others)', async () => {
  assert.equal(isApplePush('https://web.push.apple.com/abc'), true);
  assert.equal(isApplePush('https://fcm.googleapis.com/fcm/send/x'), false);
  assert.equal(isApplePush('https://push.apple.com.evil.example/x'), false);
  assert.equal(isApplePush('not a url'), false);
  const t = await startTestApp();
  try {
    const m: Mobile = t.app.ctx.services.mobile.instance;
    const sent: { url: string; body: Buffer }[] = [];
    m.push.transport = async (url, init) => {
      sent.push({ url, body: init.body });
      return { status: 201 };
    };
    const owner = t.app.ctx.auth.owner()!;
    const A = subscriber();
    const B = subscriber();
    const fcm = 'https://fcm.googleapis.com/fcm/send/owner-phone';
    const apple = 'https://web.push.apple.com/owner-ipad';
    const tokA = t.app.ctx.auth.createSession(owner.id, 'web', 'Android').token;
    const tokB = t.app.ctx.auth.createSession(owner.id, 'web', 'iPad').token;
    for (const [tok, ep, s] of [[tokA, fcm, A], [tokB, apple, B]] as const) {
      const r = await fetch(`${t.app.url}/api/mobile/push/subscribe`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ subscription: { endpoint: ep, keys: { p256dh: s.p256dh, auth: s.auth } } }) });
      assert.equal(r.status, 200);
    }
    const a = await t.agent({ name: 'Ada' });
    const agent = t.app.ctx.store.agent(a.id)!;
    const until = async (fn: () => boolean) => {
      for (let i = 0; i < 300 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
      assert.ok(fn());
    };
    const decode = (x: { url: string; body: Buffer }) => {
      const s = x.url === fcm ? A : B;
      return JSON.parse(decryptPayload(x.body, s.priv, s.p256dh, s.auth).toString());
    };
    const pendingId = () => t.app.ctx.store.one<any>("SELECT id FROM approvals WHERE user_id = ? AND status = 'pending'", owner.id)?.id as string | undefined;

    const decided = t.app.ctx.broker.request({ userId: owner.id, agent, thread: null, run: null, kind: 'tool', tool: 'write_file', input: { path: 'a.txt' }, summary: 'a.txt schrijven', risk: 'write' });
    await until(() => sent.length === 2);
    const id = pendingId()!;
    assert.deepEqual(sent.map(decode).map((p) => [p.kind, p.tag]), [['approval', `apr-${id}`], ['approval', `apr-${id}`]]);

    // Decided in another window (the owner's own session).
    await t.api('POST', `/approvals/${id}`, { decision: 'approve' });
    await decided;
    await until(() => sent.length === 3);
    const close = decode(sent[2]);
    assert.equal(sent[2].url, fcm, 'only to the Android phone: Apple does not allow a push that shows nothing');
    assert.equal(close.kind, 'close');
    assert.equal(close.tag, `apr-${id}`);
    assert.equal(close.silent, true);
    assert.equal(close.body, 'Al afgehandeld', 'what an older service worker shows instead (quietly, same tag)');

    // Once only, and nothing for an approval that was never pushed.
    t.app.ctx.events.emit(owner.id, 'approval.updated', { id, status: 'approved' });
    t.app.ctx.events.emit(owner.id, 'approval.updated', { id: 'apr_never', status: 'denied' });
    t.app.ctx.events.emit(owner.id, 'approval.updated', { id, status: 'pending' });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(sent.length, 3);

    // A question answered on the phone itself closes it there too (the phone's other notifications included).
    const answered = t.app.ctx.broker.request({ userId: owner.id, agent, thread: null, run: null, kind: 'question', tool: 'ask_user', input: { question: 'Welke map?' }, summary: 'Welke map?', risk: 'write' });
    await until(() => sent.length === 5);
    const q = pendingId()!;
    const r = await fetch(`${t.app.url}/api/approvals/${q}`, { method: 'POST', headers: { authorization: `Bearer ${tokA}`, 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approve', answer: 'Facturen' }) });
    assert.equal(r.status, 200);
    await answered;
    await until(() => sent.length === 6);
    assert.deepEqual([sent[5].url, decode(sent[5]).kind, decode(sent[5]).tag], [fcm, 'close', `apr-${q}`]);
  } finally {
    await t.close();
  }
});
