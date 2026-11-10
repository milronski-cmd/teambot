process.env.TEAMBOT_BROWSER_HEADLESS_ONLY = '1'; // never open GUI windows in tests

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startTestApp, type TestApp } from './helpers.js';
import {
  appAllowed,
  appVisible,
  approvalNeed,
  blockedReason,
  classifySideEffect,
  cleanHostOptions,
  DEFAULT_HOST_OPTIONS,
  driverPolicy,
  forbiddenCombo,
  grantCovers,
  keyNames,
  parseKeySequence,
  pickMonitor,
  planShot,
  RateWindow,
  toScreen,
  toShot,
  userMovedMouse,
  zoomArea,
  type TaskGrant,
} from '../server/modules/browser/screen-policy.js';
import { asciiJson } from '../server/modules/browser/screen.js';
import { toolOutputToMcpContent } from '../server/tools/images.js';
import type { Capabilities } from '../server/modules/browser/capabilities.js';
import type { ComputerService } from '../server/modules/browser/service.js';

// ---------------- unit: levels ----------------

test('access levels: every asks per action, task asks once, full access never; side effects always ask', () => {
  const base = { danger: false, grantOk: false, runnerAsked: false };
  assert.equal(approvalNeed({ ...base, level: 'every' }), 'action');
  assert.equal(approvalNeed({ ...base, level: 'every', runnerAsked: true }), 'none', 'no double ask when the runner already asked');
  assert.equal(approvalNeed({ ...base, level: 'every', grantOk: true }), 'none', '"always" on an action = grant for the rest of the task');
  assert.equal(approvalNeed({ ...base, level: 'task' }), 'scope');
  assert.equal(approvalNeed({ ...base, level: 'task', grantOk: true }), 'none');
  assert.equal(approvalNeed({ ...base, level: 'auto' }), 'none');
  for (const level of ['every', 'task', 'auto'] as const) {
    assert.equal(approvalNeed({ level, danger: true, grantOk: true, runnerAsked: true }), 'danger', `${level}: external side effects always ask`);
  }
});

test('task grants cover only their bot, thread, apps and time', () => {
  const now = Date.now();
  const g: TaskGrant = { id: 'g', agentId: 'a1', threadId: 't1', goal: 'x', apps: ['notepad'], createdAt: now, until: now + 60_000, actions: 0, maxActions: 3, by: 'u' };
  assert.equal(grantCovers(g, { agentId: 'a1', threadId: 't1', app: 'Notepad.exe', now }), true);
  assert.equal(grantCovers(g, { agentId: 'a1', threadId: 't2', app: 'notepad', now }), false, 'other task (thread)');
  assert.equal(grantCovers(g, { agentId: 'a2', threadId: 't1', app: 'notepad', now }), false, 'other bot');
  assert.equal(grantCovers(g, { agentId: 'a1', threadId: 't1', app: 'excel', now }), false, 'other app');
  assert.equal(grantCovers(g, { agentId: 'a1', threadId: 't1', app: 'notepad', now: now + 61_000 }), false, 'expired');
  assert.equal(grantCovers({ ...g, actions: 3 }, { agentId: 'a1', threadId: 't1', app: 'notepad', now }), false, 'action budget used up');
  assert.equal(grantCovers({ ...g, apps: ['*'] }, { agentId: 'a1', threadId: 't1', app: 'excel', now }), true, 'all-apps scope');
  assert.equal(grantCovers(null, { agentId: 'a1', threadId: 't1', app: 'notepad', now }), false);
});

test('host options are bounded and keep previous values', () => {
  const o = cleanHostOptions({ screen: 'full', taskMinutes: 9999, maxPerMinute: 1, blockWords: ['  Mijn Bank ', 'x', 'mijn bank'], monitor: -3, allApps: 'yes' });
  assert.equal(o.screen, 'full');
  assert.equal(o.taskMinutes, 240);
  assert.equal(o.maxPerMinute, 5);
  assert.deepEqual(o.blockWords, ['mijn bank']);
  assert.equal(o.monitor, 0);
  assert.equal(o.allApps, true);
  const keep = cleanHostOptions({}, o);
  assert.deepEqual(keep, o);
  assert.deepEqual(cleanHostOptions(null), DEFAULT_HOST_OPTIONS);
});

// ---------------- unit: blocklist ----------------

test('always blocked: TeamBot, credential prompts, password managers, banking and payment pages', () => {
  for (const w of [
    { process: 'electron', title: 'TeamBot' },
    { process: 'chrome', title: 'TeamBot - instellingen' },
    { process: 'consent', title: '' },
    { process: 'CredentialUIBroker.exe', title: 'Windows-beveiliging' },
    { process: '1password', title: '1Password' },
    { process: 'keepassxc', title: 'Database' },
    { process: 'msedge', title: 'Mijn ING - Internetbankieren - Microsoft Edge' },
    { process: 'chrome', title: 'Rabobank - Google Chrome' },
    { process: 'firefox', title: 'Afrekenen | bol.com — Mozilla Firefox' },
    { process: 'chrome', title: 'PayPal: Inloggen' },
    { process: 'chrome', title: 'Bitwarden Web Vault' },
    { process: 'chrome', title: 'Kies uw bank - iDEAL' },
    { process: 'notepad', title: 'Windows Security' },
    { process: 'chrome', title: 'Coinbase' },
  ])
    assert.ok(blockedReason(w), `${w.process} / ${w.title}`);
  for (const w of [
    { process: 'notepad', title: 'Naamloos - Kladblok' },
    { process: 'excel', title: 'Begroting 2026.xlsx - Excel' },
    { process: 'chrome', title: 'Paypalfan forum' },
    { process: 'winword', title: 'Het ideale plan.docx - Word' },
    { process: 'chrome', title: 'Bankstellen kopen - Google Chrome' },
  ])
    assert.equal(blockedReason(w), null, `${w.process} / ${w.title}`);
  assert.ok(blockedReason({ process: 'chrome', title: 'Mijn Zorgverzekeraar' }, ['zorgverzekeraar']), 'owner-defined extra words');
});

test('allowed and visible: allowlist, whole screen, all-apps scope; blocked always wins', () => {
  const np = { process: 'notepad', title: 'Kladblok' };
  const ch = { process: 'chrome', title: 'Nieuws' };
  const bank = { process: 'chrome', title: 'ABN AMRO internetbankieren' };
  const o = { screen: 'apps' as const, blockWords: [] };
  assert.equal(appAllowed(np, ['notepad']), true);
  assert.equal(appAllowed(ch, ['notepad']), false);
  assert.equal(appAllowed(ch, [], { blockWords: [], allApps: true }), true);
  assert.equal(appAllowed(bank, ['chrome'], { blockWords: [], allApps: true }), false);
  assert.equal(appVisible(ch, ['notepad'], o), false);
  assert.equal(appVisible(ch, ['notepad'], { ...o, screen: 'full' }), true);
  assert.equal(appVisible(bank, ['chrome'], { ...o, screen: 'full' }), false);
  const p = driverPolicy(['Notepad.exe'], { screen: 'apps', blockWords: ['geheim project'] });
  assert.deepEqual(p.allow, ['notepad']);
  assert.equal(p.full, false);
  assert.equal(p.all, false);
  assert.ok(p.block.includes('1password') && p.block.includes('electron'));
  // the title pattern is what the .NET driver evaluates too
  const re = new RegExp(p.blockTitle, 'i');
  assert.ok(re.test('mijn ing - internetbankieren'));
  assert.ok(re.test('het geheim project.docx'));
  assert.ok(!re.test('naamloos - kladblok'));
});

// ---------------- unit: side effects ----------------

test('external side effects are recognised (buttons, confirmations, send shortcuts, messaging apps)', () => {
  const click = (name: string, dialog = '', process = 'outlook') => classifySideEffect({ action: 'click', target: { process, elementName: name, dialogTitle: dialog } });
  for (const n of ['Verzenden', 'Send', 'Betalen', 'Nu kopen', 'Publiceren', 'Verwijderen', 'Delete', 'Bestelling plaatsen', 'Place order', 'Overmaken']) assert.equal(click(n).danger, true, n);
  for (const n of ['Opslaan', 'Annuleren', 'Volgende', 'Sorteervolgorde', 'Sign in', 'Postvak IN', 'Bewerken']) assert.equal(click(n).danger, false, n);
  assert.equal(click('Ja', 'Bestand definitief verwijderen?', 'explorer').danger, true, 'confirm button inherits its dialog');
  assert.equal(click('OK', 'Instellingen', 'notepad').danger, false);
  const key = (combo: string, process = 'notepad', elementName = '') => classifySideEffect({ action: 'key', keys: [keyNames(combo)], target: { process, elementName } });
  assert.equal(key('ctrl+enter').danger, true);
  assert.equal(key('alt+s', 'outlook').danger, true);
  assert.equal(key('shift+delete').danger, true);
  assert.equal(key('delete', 'explorer').danger, true);
  assert.equal(key('delete', 'notepad').danger, false);
  assert.equal(key('enter', 'whatsapp').danger, true, 'Enter sends in messaging apps');
  assert.equal(key('enter', 'notepad').danger, false);
  assert.equal(key('enter', 'chrome', 'Bestelling plaatsen').danger, true, 'Enter on a danger button');
  assert.equal(classifySideEffect({ action: 'type', text: 'hoi\n', target: { process: 'ms-teams' } }).danger, true);
  assert.equal(classifySideEffect({ action: 'type', text: 'hoi\n', target: { process: 'notepad' } }).danger, false);
  const ext = classifySideEffect({ action: 'click', target: { process: 'notepad', elementName: 'Opslaan' }, external: 'mailt de offerte naar Jan' });
  assert.equal(ext.danger, true);
  assert.match(ext.reason!, /offerte naar Jan/);
});

// ---------------- unit: geometry ----------------

test('screenshots are scaled for computer-use models and coordinates map back exactly (multi-monitor, negative origin)', () => {
  assert.deepEqual(
    (({ shotW, shotH }) => ({ shotW, shotH }))(planShot({ x: 0, y: 0, w: 1920, h: 1080 })),
    { shotW: 1280, shotH: 720 },
  );
  const uhd = planShot({ x: 0, y: 0, w: 3840, h: 2160 });
  assert.deepEqual([uhd.shotW, uhd.shotH], [1280, 720]);
  const wide = planShot({ x: -1632, y: -1440, w: 5120, h: 1440 });
  assert.deepEqual([wide.shotW, wide.shotH], [1280, 360]);
  const small = planShot({ x: 0, y: 0, w: 800, h: 600 });
  assert.deepEqual([small.shotW, small.shotH], [800, 600], 'never upscaled');
  assert.ok(planShot({ x: 0, y: 0, w: 1920, h: 1920 }).shotW * planShot({ x: 0, y: 0, w: 1920, h: 1920 }).shotH <= 1_228_800);

  const left = planShot({ x: -1920, y: 0, w: 1920, h: 1080 });
  assert.deepEqual(toScreen(left, 0, 0), { x: -1920, y: 0 });
  assert.deepEqual(toScreen(left, 640, 360), { x: -960, y: 540 });
  assert.deepEqual(toScreen(left, 1280, 720), { x: -1, y: 1079 }, 'the far edge stays on the monitor');
  for (const [sx, sy] of [
    [-1920, 0],
    [-1, 1079],
    [-1000, 333],
  ]) {
    const p = toShot(left, sx, sy)!;
    const back = toScreen(left, p.x, p.y);
    assert.ok(Math.abs(back.x - sx) <= 2 && Math.abs(back.y - sy) <= 2, `round trip ${sx},${sy}`);
  }
  assert.equal(toShot(left, 10, 10), null, 'a point on another monitor');
  assert.throws(() => toScreen(left, 1281, 10), /buiten de schermafbeelding/);
  assert.throws(() => toScreen(left, -1, 10), /buiten/);
  assert.throws(() => toScreen(left, NaN, 10), /getallen/);

  const z = zoomArea(planShot({ x: 0, y: 0, w: 1920, h: 1080 }), [100, 100, 300, 200]);
  assert.deepEqual(z, { x: 150, y: 150, w: 301, h: 151 });
  assert.throws(() => zoomArea(left, [1, 2, 3]), /region/);
  const mons = [
    { index: 0, x: 0, y: 0, w: 1920, h: 1080, primary: true, dpi: 144 },
    { index: 1, x: -1920, y: 0, w: 1920, h: 1080, primary: false, dpi: 96 },
  ];
  assert.equal(pickMonitor(mons, undefined).index, 0);
  assert.equal(pickMonitor(mons, 1).x, -1920);
  assert.throws(() => pickMonitor(mons, 5), /bestaat niet/);
});

// ---------------- unit: keys, pace, mouse ----------------

test('keys: aliases from Claude/OpenAI tools, sequences, and combos that escape the allowed apps are refused', () => {
  assert.deepEqual(keyNames('Return'), ['enter']);
  assert.deepEqual(keyNames('ctrl+Page_Down'), ['ctrl', 'pagedown']);
  assert.deepEqual(keyNames('CTRL+SHIFT+t'), ['ctrl', 'shift', 't']);
  assert.deepEqual(parseKeySequence('ctrl+a ctrl+c').names, [
    ['ctrl', 'a'],
    ['ctrl', 'c'],
  ]);
  assert.deepEqual(parseKeySequence(['ctrl+s']).vks, [[0x11, 0x53]]);
  assert.throws(() => keyNames('hyper+x'), /Onbekende toets/);
  for (const bad of ['super', 'win+r', 'cmd+space', 'alt+tab', 'alt+f4', 'ctrl+alt+delete', 'ctrl+esc', 'ctrl+alt+escape', 'ctrl+shift+esc', 'printscreen']) {
    assert.throws(() => parseKeySequence(bad), /niet toegestaan/, bad);
  }
  assert.equal(forbiddenCombo(['ctrl', 's']), null);
  assert.throws(() => parseKeySequence(Array(11).fill('a')), /Maximaal 10/);
});

test('the owner moving the mouse is detected only while the bot is working', () => {
  const now = Date.now();
  assert.equal(userMovedMouse({ last: { x: 100, y: 100 }, lastAt: now - 1000, now, current: { x: 104, y: 98 } }), false, 'jitter');
  assert.equal(userMovedMouse({ last: { x: 100, y: 100 }, lastAt: now - 1000, now, current: { x: 400, y: 300 } }), true);
  assert.equal(userMovedMouse({ last: { x: 100, y: 100 }, lastAt: now - 3_600_000, now, current: { x: 400, y: 300 } }), false, 'a new task later is not a takeover');
  assert.equal(userMovedMouse({ last: null, lastAt: 0, now, current: { x: 1, y: 1 } }), false);
  const r = new RateWindow(2);
  assert.equal(r.waitMs(now), 0);
  r.record(now);
  r.record(now + 10);
  assert.ok(r.waitMs(now + 20) > 59_000);
  assert.equal(r.waitMs(now + 60_001), 0);
});

test('driver requests are ASCII-only (no console code page problems)', () => {
  const j = asciiJson({ text: 'Café ✓ 😀 "x"' });
  assert.ok(/^[\x00-\x7f]*$/.test(j));
  assert.deepEqual(JSON.parse(j), { text: 'Café ✓ 😀 "x"' });
});

// ---------------- integration with a fake screen driver ----------------

function caps(): Capabilities {
  const cap = (id: string, status: any, isolation: any = 'none') => ({ id, label: id, status, detail: `${id} ${status}`, isolation });
  return {
    platform: 'win32',
    osName: 'Windows 11 Home',
    edition: 'Core',
    isWindowsHome: true,
    appMode: 'desktop',
    detectedAt: new Date().toISOString(),
    browsers: [{ name: 'Microsoft Edge', path: 'C:/nope/msedge.exe' }],
    caps: {
      browser: cap('browser', 'available', 'process'),
      hyperv: cap('hyperv', 'unsupported', 'vm'),
      sandbox: cap('sandbox', 'unsupported', 'vm'),
      wsl: cap('wsl', 'missing'),
      docker: cap('docker', 'missing', 'container'),
      host: cap('host', 'available'),
      visible: cap('visible', 'unsupported', 'process'),
    },
  };
}

const NOTEPAD = { hwnd: 11, pid: 5, process: 'notepad', title: 'Naamloos - Kladblok', x: 100, y: 100, w: 800, h: 600, visible: true, allowed: true, blocked: null, foreground: true };

function fakeScreen() {
  const st: any = { cursor: { x: 5, y: 5 }, win: { ...NOTEPAD }, el: { type: 'Button', name: 'Opslaan', password: false }, fg: { ...NOTEPAD }, focused: { type: 'Edit', name: 'Tekst', password: false } };
  const calls: { action: string; input: any }[] = [];
  const driver = {
    async call(action: string, input: any) {
      calls.push({ action, input });
      switch (action) {
        case 'monitors':
          return {
            monitors: [
              { index: 0, x: 0, y: 0, w: 1920, h: 1080, primary: true, dpi: 144 },
              { index: 1, x: -1920, y: 0, w: 1920, h: 1080, primary: false, dpi: 96 },
            ],
          };
        case 'shot':
          fs.writeFileSync(input.out, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]));
          return { area: input.area, outW: input.outW, outH: input.outH, cursor: st.cursor, foreground: st.fg, windows: [st.win, { ...st.win, hwnd: 99, visible: false, title: '' }], hidden: 3, passwordMasked: 0 };
        case 'probe':
          return { cursor: st.cursor, window: st.win, element: st.el, foreground: st.fg, focused: st.focused };
        case 'cursor':
          return { cursor: st.cursor };
        case 'elements':
          return { elements: [{ type: 'Button', name: 'Opslaan', x: 120, y: 130, w: 60, h: 20, password: false, enabled: true }] };
        case 'launch':
          return { how: 'programma', window: st.win };
        default:
          if (input.x !== undefined) st.cursor = { x: input.x2 ?? input.x, y: input.y2 ?? input.y };
          return { ok: true, cursor: st.cursor };
      }
    },
    kill() {
      calls.push({ action: 'kill', input: {} });
    },
  };
  return { st, calls, driver };
}

function svcOf(t: TestApp): ComputerService {
  return t.app.ctx.services.computers._service;
}

function toolCtx(t: TestApp, agentId: string, threadId?: string) {
  const s = t.app.ctx.store;
  const agent = s.agent(agentId)!;
  const thread = threadId ? s.thread(threadId)! : s.createThread({ user_id: agent.user_id, agent_id: agent.id });
  const run = s.createRun({ thread_id: thread.id, agent_id: agent.id, user_id: agent.user_id, status: 'running' });
  const ac = new AbortController();
  return { ctx: t.app.ctx, agent, thread, run, userId: agent.user_id, signal: ac.signal, toolCallId: 'call_' + Math.random().toString(36).slice(2), progress: () => {}, abort: () => ac.abort() };
}

async function callTool(t: TestApp, name: string, args: any, tc: ReturnType<typeof toolCtx>) {
  const tool = t.app.ctx.tools.get(name)!;
  assert.ok(tool, `tool ${name} registered`);
  try {
    const r = await tool.run(args, { ...tc, agent: t.app.ctx.store.agent(tc.agent.id)! } as any);
    return typeof r === 'string' ? { text: r } : r;
  } catch (e: any) {
    return { text: String(e.message), isError: true };
  } finally {
    svcOf(t).leases.releaseHolder(tc.run.id);
  }
}

async function waitFor<T>(fn: () => T | Promise<T>, ms = 5000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout');
}

const pendingFor = (t: TestApp, tool: string) => waitFor(async () => (await t.api('GET', '/approvals')).find((x: any) => x.tool === tool && x.status === 'pending'));

async function setup() {
  const t = await startTestApp();
  const svc = svcOf(t);
  svc.setCapabilities(caps());
  const fake = fakeScreen();
  svc.screen.driver = fake.driver;
  const a = await t.agent({ tool_groups: ['desktop'] });
  await t.api('PUT', `/computers/${a.id}/config`, { host_control: true, confirmHost: true, mode: 'host', host_apps: ['notepad'] });
  return { t, svc, fake, a };
}

test('desktop_computer: screenshot is a real image with the coordinate system, and reaches the model', async () => {
  const { t, fake, a } = await setup();
  try {
    const r: any = await callTool(t, 'desktop_computer', { action: 'screenshot', elements: true }, toolCtx(t, a.id));
    assert.ok(!r.isError, r.text);
    assert.equal(r.attachments?.[0]?.mime, 'image/jpeg');
    assert.match(r.text, /afgebeeld als 1280×720/);
    assert.match(r.text, /schaal 150%/);
    assert.match(r.text, /Naamloos - Kladblok/);
    assert.match(r.text, /3 vensters zijn donker gemaakt/);
    assert.match(r.text, /Button "Opslaan" @ \(100, 94\) 40×13/, 'UI Automation elements in screenshot coordinates');
    assert.doesNotMatch(r.text, /hwnd|99/, 'hidden windows are not described');
    const shot = fake.calls.find((c) => c.action === 'shot')!;
    assert.deepEqual(shot.input.area, { x: 0, y: 0, w: 1920, h: 1080 });
    assert.equal(shot.input.outW, 1280);
    assert.deepEqual(shot.input.policy.allow, ['notepad'], 'the driver masks with the bot policy');
    assert.equal(fake.calls.filter((c) => ['click', 'type', 'key'].includes(c.action)).length, 0);
    // other engine paths (MCP bridge for CLI engines) get the same image as MCP image content
    const mcp = toolOutputToMcpContent(t.app.ctx, r);
    assert.equal(mcp[0].type, 'text');
    assert.ok(mcp.some((c) => c.type === 'image' && c.mimeType === 'image/jpeg' && c.data.length > 0));

    // through the runner: the image is part of the tool result the (vision) model gets
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ toolCalls: [{ name: 'desktop_computer', args: { action: 'screenshot' } }] }, { text: 'Ik zie Kladblok' });
    await t.say(th.id, 'Wat staat er op mijn scherm?');
    const second = t.requests[t.requests.length - 1];
    const tool = second.messages.find((m) => m.role === 'tool')!;
    assert.ok(Array.isArray(tool.content) && (tool.content as any[]).some((p) => p.type === 'image' && p.mime === 'image/jpeg'));
  } finally {
    await t.close();
  }
});

test('level "every": each click asks with a marked preview, mapped coordinates and window re-check', async () => {
  const { t, svc, fake, a } = await setup();
  try {
    const tc = toolCtx(t, a.id);
    const p = callTool(t, 'desktop_computer', { action: 'left_click', coordinate: [640, 360] }, tc);
    const pending = await pendingFor(t, 'desktop_computer');
    assert.equal(pending.risk, 'write');
    assert.match(pending.summary, /KLIK op Button "Opslaan"/);
    assert.ok(!fake.calls.some((c) => c.action === 'click'), 'nothing happens before approval');
    const pv = await t.api('GET', `/computers/${a.id}/screen/preview/${tc.toolCallId}`);
    assert.equal(pv.need, 'action');
    const marked = fake.calls.filter((c) => c.action === 'shot').pop()!;
    assert.deepEqual(marked.input.marks, [[960, 540]], 'preview marks the real screen point');
    await t.api('POST', `/approvals/${pending.id}`, { decision: 'approve' });
    const r: any = await p;
    assert.ok(!r.isError, r.text);
    const click = fake.calls.find((c) => c.action === 'click')!;
    assert.equal(click.input.x, 960);
    assert.equal(click.input.y, 540);
    assert.deepEqual(click.input.expect, { hwnd: 11, pid: 5 }, 'the driver re-checks it is still the approved window');
    assert.equal(r.attachments?.[0]?.mime, 'image/jpeg', 'a fresh screenshot after the action');
    const log = await t.api('GET', `/computers/${a.id}/actions`);
    assert.ok(log.some((x: any) => x.tool === 'desktop_computer' && x.frame), 'action log with a screenshot');

    // deny: nothing happens
    const n = fake.calls.filter((c) => c.action === 'click').length;
    const p2 = callTool(t, 'desktop_computer', { action: 'double_click', coordinate: [10, 10] }, toolCtx(t, a.id));
    await t.api('POST', `/approvals/${(await pendingFor(t, 'desktop_computer')).id}`, { decision: 'deny' });
    assert.equal(((await p2) as any).isError, true);
    assert.equal(fake.calls.filter((c) => c.action === 'click').length, n);

    // "always" = the rest of this task, not a permanent permission
    const tc3 = toolCtx(t, a.id);
    const p3 = callTool(t, 'desktop_computer', { action: 'left_click', coordinate: [20, 20] }, tc3);
    await t.api('POST', `/approvals/${(await pendingFor(t, 'desktop_computer')).id}`, { decision: 'always' });
    await p3;
    assert.equal(t.app.ctx.store.agent(a.id)!.tool_policy.desktop_computer, undefined);
    assert.ok(svc.screen.grant(a.id));
    const r4: any = await callTool(t, 'desktop_computer', { action: 'left_click', coordinate: [30, 30] }, toolCtx(t, a.id, tc3.thread.id));
    assert.ok(!r4.isError, 'same task: no new question');
  } finally {
    await t.close();
  }
});

test('full access: no per-action asks inside the allowed apps; side effects still ask; hard blocks stay', async () => {
  const { t, fake, st, a } = await (async () => {
    const s = await setup();
    return { ...s, st: s.fake.st };
  })();
  try {
    await t.api('PUT', `/computers/${a.id}/config`, { host_level: 'auto' });
    let r: any = await callTool(t, 'desktop_computer', { action: 'left_click', coordinate: [100, 100] }, toolCtx(t, a.id));
    assert.ok(!r.isError, r.text);
    r = await callTool(t, 'desktop_computer', { action: 'type', text: 'Hallo wereld' }, toolCtx(t, a.id));
    assert.ok(!r.isError, r.text);
    assert.equal(fake.calls.find((c) => c.action === 'type')!.input.text, 'Hallo wereld');
    r = await callTool(t, 'desktop_computer', { action: 'key', text: 'ctrl+s' }, toolCtx(t, a.id));
    assert.ok(!r.isError, r.text);
    assert.deepEqual(fake.calls.find((c) => c.action === 'key')!.input.combos, [[0x11, 0x53]]);
    assert.equal((await t.api('GET', '/approvals')).filter((x: any) => x.status === 'pending').length, 0);

    // a "Verzenden" button asks with risk danger, even at full access
    st.el = { type: 'Button', name: 'Verzenden', password: false };
    const clicks = fake.calls.filter((c) => c.action === 'click').length;
    const p = callTool(t, 'desktop_computer', { action: 'left_click', coordinate: [200, 200] }, toolCtx(t, a.id));
    const pending = await pendingFor(t, 'desktop_computer');
    assert.equal(pending.risk, 'danger');
    assert.match(pending.summary, /Verzenden/);
    await t.api('POST', `/approvals/${pending.id}`, { decision: 'deny' });
    assert.equal(((await p) as any).isError, true);
    assert.equal(fake.calls.filter((c) => c.action === 'click').length, clicks);
    // the bot can declare it too
    st.el = { type: 'Button', name: 'Opslaan', password: false };
    const p2 = callTool(t, 'desktop_computer', { action: 'key', text: 'enter', external: 'verstuurt de factuur' }, toolCtx(t, a.id));
    assert.equal((await pendingFor(t, 'desktop_computer')).risk, 'danger');
    await t.api('POST', `/approvals/${(await pendingFor(t, 'desktop_computer')).id}`, { decision: 'deny' });
    await p2;

    // hard blocks: banking page, not-allowed app, password field, forbidden keys
    const before = fake.calls.filter((c) => ['click', 'type', 'key'].includes(c.action)).length;
    st.win = { ...NOTEPAD, process: 'msedge', title: 'Mijn ING', allowed: false, visible: false, blocked: 'gevoelige pagina of app' };
    r = await callTool(t, 'desktop_computer', { action: 'left_click', coordinate: [100, 100] }, toolCtx(t, a.id));
    assert.match(r.text, /nooit mag bedienen.*desktop_request_takeover/);
    st.win = { ...NOTEPAD, process: 'chrome', title: 'Nieuws', allowed: false, visible: false, blocked: null };
    r = await callTool(t, 'desktop_computer', { action: 'left_click', coordinate: [100, 100] }, toolCtx(t, a.id));
    assert.match(r.text, /niet op de lijst met toegestane apps/);
    st.win = { ...NOTEPAD };
    st.focused = { type: 'Edit', name: 'Wachtwoord', password: true };
    r = await callTool(t, 'desktop_computer', { action: 'type', text: 'geheim' }, toolCtx(t, a.id));
    assert.match(r.text, /wachtwoordveld/);
    r = await callTool(t, 'desktop_computer', { action: 'key', text: 'alt+tab' }, toolCtx(t, a.id));
    assert.match(r.text, /niet toegestaan/);
    assert.equal(fake.calls.filter((c) => ['click', 'type', 'key'].includes(c.action)).length, before, 'no input reached the desktop');
  } finally {
    await t.close();
  }
});

test('level "task": one scoped approval per task, then the bot works on its own in that task only', async () => {
  const { t, svc, fake, a } = await setup();
  try {
    await t.api('PUT', `/computers/${a.id}/config`, { host_level: 'task', host_options: { taskMinutes: 15 } });
    const tc = toolCtx(t, a.id);
    const p = callTool(t, 'desktop_request_access', { goal: 'Begroting bijwerken' }, tc);
    const pending = await pendingFor(t, 'desktop_request_access');
    assert.match(pending.summary, /Begroting bijwerken/);
    assert.match(pending.summary, /15 minuten/);
    await t.api('POST', `/approvals/${pending.id}`, { decision: 'approve' });
    assert.match(((await p) as any).text, /Toestemming gekregen/);
    const g = svc.screen.grant(a.id)!;
    assert.ok(g && g.until - Date.now() <= 15 * 60_000 + 1000);
    const r: any = await callTool(t, 'desktop_computer', { action: 'left_click', coordinate: [50, 50] }, toolCtx(t, a.id, tc.thread.id));
    assert.ok(!r.isError, r.text);
    assert.equal((await t.api('GET', '/approvals')).filter((x: any) => x.status === 'pending').length, 0);
    // another task (thread) asks again for its scope, automatically on the first action
    const p2 = callTool(t, 'desktop_computer', { action: 'left_click', coordinate: [50, 50], goal: 'Iets anders' }, toolCtx(t, a.id));
    const scope = await pendingFor(t, 'desktop_computer');
    assert.match(scope.summary, /voor deze taak: Iets anders/);
    await t.api('POST', `/approvals/${scope.id}`, { decision: 'deny' });
    assert.equal(((await p2) as any).isError, true);
    // revoking from the app (or phone) ends the scope
    await t.api('DELETE', `/computers/${a.id}/screen/grant`);
    assert.equal(svc.screen.grant(a.id), null);
    assert.ok(fake.calls.some((c) => c.action === 'click'));
  } finally {
    await t.close();
  }
});

test('owner moving the mouse pauses the bot; emergency stop kills input and pauses until resumed', async () => {
  const { t, svc, fake, a } = await setup();
  try {
    await t.api('PUT', `/computers/${a.id}/config`, { host_level: 'auto' });
    let r: any = await callTool(t, 'desktop_computer', { action: 'left_click', coordinate: [100, 100] }, toolCtx(t, a.id));
    assert.ok(!r.isError);
    fake.st.cursor = { x: 1500, y: 900 }; // the owner grabs the mouse
    r = await callTool(t, 'desktop_computer', { action: 'left_click', coordinate: [100, 100] }, toolCtx(t, a.id));
    assert.match(r.text, /Gepauzeerd: de gebruiker bewoog de muis/);
    const ctl = svc.controller('desktop:host');
    assert.equal(ctl?.kind, 'user');
    const st = await t.api('GET', '/computers/desktop/state');
    assert.equal(st.paused, true);
    assert.equal(st.agentId, a.id);
    // hand back
    await t.api('POST', `/computers/${a.id}/screen/resume`, {});
    assert.equal(svc.controller('desktop:host'), null);
    r = await callTool(t, 'desktop_computer', { action: 'left_click', coordinate: [100, 100] }, toolCtx(t, a.id));
    assert.ok(!r.isError, r.text);

    // indicator state while a bot holds the desktop
    const states: any[] = [];
    const off = svc.screen.onState((s) => states.push(s));
    const tc = toolCtx(t, a.id);
    await svc.hostFor({ ...tc, agent: t.app.ctx.store.agent(a.id)! } as any);
    await waitFor(() => states.some((s) => s.active && s.agentName === 'Testbot'));
    // emergency stop (app / phone / hotkey all use this)
    const res = await t.api('POST', '/computers/desktop/stop', { source: 'telefoon' });
    assert.equal(res.agents, 1);
    assert.equal(svc.controller('desktop:host'), null, 'the bot lost the desktop');
    assert.ok(fake.calls.some((c) => c.action === 'kill'), 'in-flight input is killed');
    assert.ok(svc.hostStopped.has(a.id));
    off();
    r = await callTool(t, 'desktop_computer', { action: 'screenshot' }, toolCtx(t, a.id));
    assert.match(r.text, /noodstop/);
    assert.equal((await t.api('GET', `/computers/${a.id}/screen`)).stopped, true);
    await t.api('POST', `/computers/${a.id}/screen/resume`, {});
    r = await callTool(t, 'desktop_computer', { action: 'screenshot' }, toolCtx(t, a.id));
    assert.ok(!r.isError);
    // the desktop shell uses the same stop
    t.app.ctx.services.computers.desktop.setHotkey('Ctrl+Alt+Esc');
    assert.equal(t.app.ctx.services.computers.desktop.stop('sneltoets').agents, 1);
    assert.equal((await t.api('GET', `/computers/${a.id}/screen`)).hotkey, 'Ctrl+Alt+Esc');
  } finally {
    await t.close();
  }
});

test('levels, scope and phone access: owner only, explicit confirmation for all apps, phone may watch and stop', async () => {
  const { t, a } = await setup();
  try {
    const member = t.app.ctx.auth.createUser({ name: 'Vriend', email: 'vriend@example.com', password: 'wachtwoord123', role: 'member' });
    const mt = t.app.ctx.auth.createSession(member.id).token;
    const res = await fetch(t.app.url + `/api/computers/${a.id}/config`, { method: 'PUT', headers: { authorization: `Bearer ${mt}`, 'content-type': 'application/json' }, body: JSON.stringify({ host_level: 'auto' }) });
    assert.ok(res.status === 403 || res.status === 404);
    await assert.rejects(t.api('PUT', `/computers/${a.id}/config`, { host_options: { allApps: true } }), /Bevestig/);
    const saved = await t.api('PUT', `/computers/${a.id}/config`, { host_options: { allApps: true }, confirmAllApps: true, host_level: 'auto', host_apps: ['notepad', '1password', 'KeePass.exe'] });
    assert.equal(saved.config.host_options.allApps, true);
    assert.deepEqual(saved.config.host_apps, ['notepad'], 'password managers never make it onto the allowlist');
    const routes: any[] = t.app.ctx.services.mobileRoutes;
    for (const p of ['/computers/desktop/stop', '/computers/:agentId/screen/stream', '/computers/:agentId/screen/pause', '/computers/:agentId/stop']) assert.ok(routes.some((r) => r.path === p), p);
    assert.ok(!routes.some((r) => r.path.includes('/config')), 'a phone can never change the level');
    // system prompt explains the level and the rules
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ text: 'ok' });
    await t.say(th.id, 'hoi');
    const sys = t.requests[t.requests.length - 1].system;
    assert.match(sys, /Volledige toegang/);
    assert.match(sys, /desktop_computer/);
    assert.match(sys, /desktop_request_takeover/);
    assert.match(sys, /external/);
  } finally {
    await t.close();
  }
});

test('desktop_launch starts only allowed apps; desktop_request_takeover hands control to the owner and back', async () => {
  const { t, svc, fake, a } = await setup();
  try {
    await t.api('PUT', `/computers/${a.id}/config`, { host_level: 'auto' });
    let r: any = await callTool(t, 'desktop_launch', { app: 'regedit' }, toolCtx(t, a.id));
    assert.match(r.text, /niet op de lijst/);
    r = await callTool(t, 'desktop_launch', { app: 'Notepad.exe' }, toolCtx(t, a.id));
    assert.ok(!r.isError, r.text);
    assert.equal(fake.calls.find((c) => c.action === 'launch')!.input.name, 'notepad');
    const tc = toolCtx(t, a.id);
    const p = callTool(t, 'desktop_request_takeover', { reason: 'Log in bij de boekhouding' }, tc);
    const q = await pendingFor(t, 'desktop_request_takeover');
    assert.equal(q.kind, 'question');
    assert.equal(svc.controller('desktop:host')?.kind, 'user', 'the owner holds the desktop while the bot waits');
    await t.api('POST', `/approvals/${q.id}`, { decision: 'approve', answer: 'Klaar, de bot mag verder' });
    assert.match(((await p) as any).text, /geeft de bediening terug/);
    assert.equal(svc.controller('desktop:host'), null);
  } finally {
    await t.close();
  }
});
