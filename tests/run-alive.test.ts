import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALIVE_EVERY_MS, cliRunScope, GONE_GRACE_MS, RunPulse, type RunAlive } from '../server/agent/runs.js';
import { startProc } from '../server/modules/cli-agents/proc.js';
import { startTestApp } from './helpers.js';
import { settle, team, until } from './team-mock.js';

/** The sign of life of a busy run (`run.alive`): real activity, throttled, and whether a CLI's process still exists. */

const RUN = { id: 'r1', thread_id: 't1', agent_id: 'a1' };

function pulse(o: { status?: () => string } = {}) {
  const sent: RunAlive[] = [];
  let now = 1_000_000;
  const p = new RunPulse((a) => sent.push(a), { clock: () => now, timers: false, status: o.status });
  return { p, sent, at: () => now, wait: (ms: number) => (now += ms) };
}

test('run.alive: activity moves lastActivityAt; the browser hears it at most every 10 s, also when nothing happened', () => {
  const { p, sent, at, wait } = pulse();
  const t0 = at();
  p.begin(RUN);
  // A burst of chunks right after the start: recorded, nothing sent yet.
  for (let i = 0; i < 50; i++) {
    wait(100);
    p.touch('r1');
    p.tick();
  }
  assert.equal(sent.length, 0);
  assert.equal(p.info('r1')!.lastActivityAt, t0 + 5000);
  // Ten seconds after the start the first one goes out, with the last real activity.
  wait(5000);
  p.tick();
  assert.deepEqual(sent, [{ runId: 'r1', threadId: 't1', agentId: 'a1', lastActivityAt: t0 + 5000, at: t0 + 10_000 }]);
  // Silence: still one every 10 s, and lastActivityAt stays where it was (silence is reported, not guessed).
  for (let i = 0; i < 30; i++) {
    wait(1000);
    p.tick();
  }
  assert.equal(sent.length, 4);
  assert.ok(sent.every((a) => a.lastActivityAt === t0 + 5000));
  for (let i = 1; i < sent.length; i++) assert.ok(sent[i].at - sent[i - 1].at >= ALIVE_EVERY_MS);
  // Activity after a silence is told at once, with what the bot is doing; the next chunks wait for the throttle.
  wait(10_000);
  p.touch('r1', '  Zoekt op\n internet  ');
  assert.equal(sent.length, 5);
  assert.deepEqual(sent[4], { runId: 'r1', threadId: 't1', agentId: 'a1', lastActivityAt: at(), at: at(), doing: 'Zoekt op internet' });
  wait(500);
  p.touch('r1');
  p.touch('r1', '');
  assert.equal(sent.length, 5);
  assert.equal(p.info('r1')!.doing, undefined);
  // Over: nothing more, and activity of a run that is not busy is ignored.
  p.end('r1');
  wait(60_000);
  p.tick();
  p.touch('r1');
  assert.equal(sent.length, 5);
  assert.equal(p.info('r1'), null);
});

test('run.alive: a CLI process that ends while the run goes on is said after a short grace, and taken back when it starts again', () => {
  const { p, sent, wait } = pulse();
  p.begin(RUN);
  assert.equal(p.info('r1')!.process, undefined, 'an API engine has no process');
  p.proc('r1', true);
  assert.equal(p.info('r1')!.process, 'alive');
  wait(2000);
  p.proc('r1', false);
  wait(GONE_GRACE_MS - 1);
  p.tick();
  assert.equal(sent.length, 0, 'a normal end closes the run within the grace: nothing said');
  wait(1);
  p.tick();
  assert.equal(sent.length, 1, 'not held back by the 10 s throttle');
  assert.equal(sent[0].process, 'gone');
  p.tick();
  assert.equal(sent.length, 1);
  // The engine starts again (a retry without its session): alive, at once.
  wait(1000);
  p.proc('r1', true);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].process, 'alive');
});

test('run.alive: nothing while the run waits for the owner, and the silence starts again after that', () => {
  let status = 'waiting';
  const { p, sent, at, wait } = pulse({ status: () => status });
  p.begin(RUN);
  for (let i = 0; i < 300; i++) {
    wait(1000);
    p.tick();
  }
  assert.equal(sent.length, 0);
  status = 'running';
  wait(10_000);
  p.tick();
  assert.equal(sent.length, 1);
  assert.ok(sent[0].at - sent[0].lastActivityAt <= 20_000, 'five minutes of waiting are not five minutes of silence');
  assert.equal(sent[0].at, at());
});

test('run.alive: output and the life of a CLI process started inside a run count for that run', async () => {
  const calls: string[] = [];
  const fake = { touch: () => calls.push('touch'), proc: (_id: string, alive: boolean) => calls.push(alive ? 'start' : 'end') } as unknown as RunPulse;
  const proc = cliRunScope.run({ runId: 'r1', pulse: fake }, () =>
    startProc({ bin: process.execPath, args: ['-e', "console.log('hallo'); console.error('fout')"], cwd: process.cwd(), signal: new AbortController().signal, timeoutMs: 20_000, idleMs: 20_000, onLine: () => {}, job: false }),
  );
  await proc.done;
  assert.equal(calls[0], 'start');
  assert.equal(calls.at(-1), 'end');
  assert.equal(calls.filter((c) => c === 'start').length, 1);
  assert.equal(calls.filter((c) => c === 'end').length, 1);
  assert.ok(calls.filter((c) => c === 'touch').length >= 2, 'stdout and stderr');
  // Outside a run (a login, a version check): nothing.
  const n = calls.length;
  await startProc({ bin: process.execPath, args: ['-e', "console.log('x')"], cwd: process.cwd(), signal: new AbortController().signal, timeoutMs: 20_000, idleMs: 20_000, onLine: () => {}, job: false }).done;
  assert.equal(calls.length, n);
});

test('run.alive: a busy run has a sign of life that the model stream moves; it is gone when the run ends', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    m.script('Ada', { text: 'klaar', delayMs: 400 });
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    const before = Date.now();
    await t.api('POST', `/threads/${th.id}/queue`, { content: 'hoi' });
    const run: any = await until(() => t.app.ctx.store.one("SELECT * FROM runs WHERE thread_id = ? AND status = 'running'", th.id));
    const info = t.app.ctx.runs.pulse.info(run.id)!;
    assert.equal(info.threadId, th.id);
    assert.equal(info.agentId, ada.id);
    assert.ok(info.lastActivityAt >= before && info.lastActivityAt <= Date.now());
    await settle(t);
    assert.equal(t.app.ctx.runs.pulse.info(run.id), null);
  } finally {
    await t.close();
  }
});
