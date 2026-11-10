process.env.TEAMBOT_BROWSER_HEADLESS_ONLY = '1'; // never open GUI windows in tests

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestApp } from './helpers.js';
import { detectCapabilities, type Probes } from '../server/modules/browser/capabilities.js';
import { BrowserManager, removeProfileDir } from '../server/modules/browser/browser.js';
import { inAppBrowserHost, inAppStorageDir, setInAppBrowserHost, type InAppHost } from '../server/modules/browser/inapp.js';
import { cleanUserAgent, fromCdpCookie, toCdpCookie } from '../desktop/inapp-helpers.js';
import type { ComputerService } from '../server/modules/browser/service.js';

/** A pc without Edge or Chrome (the owner: "no WSL or anything"). */
const bare: Probes = {
  platform: () => 'win32',
  env: () => undefined,
  exists: () => false,
  run: async () => ({ code: -1, stdout: '', stderr: '', timedOut: false }),
};

test('in-app browser: a bot has its own browser on a pc without Edge or Chrome (desktop app only)', async () => {
  const none = await detectCapabilities(bare, 'desktop');
  assert.equal(none.caps.browser.status, 'missing');
  const app = await detectCapabilities(bare, 'desktop', { inApp: true });
  assert.equal(app.caps.browser.status, 'available');
  assert.match(app.caps.browser.detail, /Ingebouwd in TeamBot/);
  assert.deepEqual(app.browsers, [], 'the list of installed browsers stays honest');
});

/** A host whose browsers never start: enough to see which engine BrowserManager picks. */
function recordingHost(): InAppHost & { opened: any[]; forgotten: string[] } {
  const h = {
    opened: [] as any[],
    forgotten: [] as string[],
    async open(o: any): Promise<any> {
      h.opened.push(o);
      throw new Error('test host: no browser');
    },
    async forget(dir: string) {
      h.forgotten.push(dir);
    },
  };
  return h;
}

const opts = (dir: string, userId = 'u1') => ({ key: 'p:x', userId, profileId: 'x', profileDir: dir, policy: () => ({ allow: [], deny: [], allowPrivate: false }) });

test('in-app browser: BrowserManager uses the app unless the owner chose Edge/Chrome (and one is there)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-inapp-'));
  try {
    const host = recordingHost();
    let engine: 'app' | 'external' = 'app';
    let found: any = { name: 'Microsoft Edge', path: 'C:/nope/msedge.exe' };
    const launched: string[] = [];
    const m = new BrowserManager({
      findBrowser: async () => found,
      inApp: () => host,
      engine: () => engine,
    });
    // default: inside TeamBot, with the policy proxy as the only way out and the profile's own storage folder
    await assert.rejects(m.ensure(opts(dir)), /Browser starten mislukt: test host/);
    assert.equal(host.opened.length, 1);
    assert.equal(host.opened[0].storageDir, inAppStorageDir(dir));
    assert.match(host.opened[0].proxy.server, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(host.opened[0].proxy.username && host.opened[0].proxy.password);
    assert.equal(host.opened[0].headed, false);
    // the owner picked Edge/Chrome: that path (a real launch of a missing file fails, but not in the host)
    engine = 'external';
    await assert.rejects(m.ensure(opts(dir)));
    assert.equal(host.opened.length, 1, 'Edge/Chrome chosen and installed: the host is not used');
    // Edge/Chrome chosen but none installed: inside TeamBot after all (a working browser, never none)
    found = null;
    await assert.rejects(m.ensure(opts(dir)), /test host/);
    assert.equal(host.opened.length, 2);
    // a test launcher always goes its own way
    const t = new BrowserManager({ findBrowser: async () => ({ name: 'Chromium', path: 'x' }), inApp: () => host, launcher: async (d) => (launched.push(d), Promise.reject(new Error('launcher'))) });
    await assert.rejects(t.ensure(opts(dir)), /launcher/);
    assert.deepEqual(launched, [dir]);
    assert.equal(host.opened.length, 2);
    // removing a profile empties its in-app session first
    fs.mkdirSync(inAppStorageDir(dir), { recursive: true });
    await m.removeProfile(dir);
    assert.deepEqual(host.forgotten, [inAppStorageDir(dir)]);
    assert.equal(fs.existsSync(dir), false);
    await m.closeAll();
    await t.closeAll();
  } finally {
    removeProfileDir(dir);
  }
});

test('in-app browser: the engine choice is a user setting, default inside TeamBot; capabilities say what is there', async () => {
  const t = await startTestApp();
  try {
    const svc: ComputerService = t.app.ctx.services.computers._service;
    const me = t.app.ctx.auth.owner()!;
    assert.equal(svc.engineChoice(me.id), 'app');
    // no in-app host in a plain server process: the page does not offer the choice
    const caps = await t.api('GET', '/computers/capabilities');
    assert.equal(caps.engine.app, false);
    const r = await t.api('PUT', '/computers/engine', { engine: 'external' });
    assert.equal(r.choice, 'external');
    assert.equal(svc.engineChoice(me.id), 'external');
    await t.api('PUT', '/computers/engine', { engine: 'whatever' });
    assert.equal(svc.engineChoice(me.id), 'app', 'anything else is the default');
    // with the desktop app's host the browser capability is there, also without Edge/Chrome
    const before = inAppBrowserHost();
    setInAppBrowserHost(recordingHost());
    try {
      svc.probes = bare;
      const c = await svc.caps(true);
      assert.equal(c.caps.browser.status, 'available');
      assert.equal((await svc.engineView(me.id)).app, true);
    } finally {
      setInAppBrowserHost(before);
    }
  } finally {
    await t.close();
  }
});

test('in-app browser: user agent without Electron marks; cookies map to CDP and back', () => {
  assert.equal(
    cleanUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) teambot/0.4.5 Chrome/142.0.7444.0 Electron/45.2.3 Safari/537.36'),
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.0 Safari/537.36',
  );
  const c = toCdpCookie({ name: 'sid', value: 'abc', domain: '.example.com', hostOnly: false, path: '/', secure: true, httpOnly: true, session: false, expirationDate: 2_000_000_000, sameSite: 'lax' } as any);
  assert.equal(c.expires, 2_000_000_000);
  assert.equal(c.sameSite, 'Lax');
  assert.equal(c.session, false);
  const back = fromCdpCookie(c);
  assert.equal(back.url, 'https://example.com/');
  assert.equal(back.domain, '.example.com');
  assert.equal(back.sameSite, 'lax');
  assert.equal(back.expirationDate, 2_000_000_000);
  // a host-only session cookie stays host-only and without an expiry
  const h = fromCdpCookie(toCdpCookie({ name: 'a', value: '1', domain: 'shop.test', path: '/x', secure: false, httpOnly: false, session: true, sameSite: 'unspecified' } as any));
  assert.equal(h.domain, undefined);
  assert.equal(h.url, 'http://shop.test/x');
  assert.equal(h.expirationDate, undefined);
  assert.equal(h.sameSite, 'unspecified');
});
