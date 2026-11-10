// "Alles stoppen" laat geen proces achter: stopping a CLI ends every process TeamBot started for it — also a child
// whose parent already exited (an orphan; `taskkill /T` alone cannot find those on Windows) — and never a process
// TeamBot did not start. Only dummy process trees (tests/fixtures/proc-tree.mjs), never the real CLIs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startProc } from '../server/modules/cli-agents/proc.js';
import { jobs } from '../server/modules/cli-agents/jobs.js';
import { startTestApp, type TestApp } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TREE = path.join(here, 'fixtures', 'proc-tree.mjs');
const FAKE_CLAUDE = path.join(here, 'fixtures', 'cli-agents-fake-claude.mjs');
const FAKE_ACP = path.join(here, 'fixtures', 'cli-agents-fake-acp.mjs');
const FAKE_CODEX = path.join(here, 'fixtures', 'cli-agents-fake-codex.mjs');

const alive = (pid: number | undefined) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until<T>(fn: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms = 15_000, what = 'voorwaarde'): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - start > ms) throw new Error(`time-out: ${what}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

const readLog = (file: string): any[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const pidsIn = (lines: any[]) => [...new Set(lines.flatMap((l) => [l.root, l.mid, l.leaf, l.self, l.grandchild]).filter((x) => typeof x === 'number'))] as number[];
const tmpLog = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-tree-')), 'tree.log');
const killAll = (pids: number[]) => {
  for (const p of pids) {
    try {
      process.kill(p);
    } catch {
      /* gone */
    }
  }
};

function tree(args: string[], log: string, ctl: AbortController) {
  return startProc({ bin: TREE, args, cwd: os.tmpdir(), env: { FAKE_TREE_LOG: log }, signal: ctl.signal, timeoutMs: 120_000, idleMs: 120_000, onLine: () => {} });
}

test('stop ends the whole tree, also a child whose parent already exited (orphan)', async () => {
  await jobs.whenReady(); // as a CLI run does (index.ts): the helper runs before the CLI starts
  const log = tmpLog();
  const ctl = new AbortController();
  const p = tree(['root', '--mid-exits'], log, ctl);
  const info = await until(() => {
    const L = readLog(log);
    const root = L.find((l) => l.root)?.root;
    const leaf = L.find((l) => l.leaf)?.leaf;
    const mid = L.find((l) => l.mid)?.mid;
    return root && leaf && mid ? { root, mid, leaf } : null;
  }, 15_000, 'tree started');
  // The middle process leaves; its child keeps running with a parent that no longer exists.
  await until(() => !alive(info.mid), 10_000, 'mid exited');
  assert.ok(alive(info.root) && alive(info.leaf), 'root and the orphaned leaf still run');
  ctl.abort();
  await p.done;
  await p.stopped;
  await until(() => !alive(info.root) && !alive(info.leaf), 10_000, 'every process gone');
});

test('an ACP-style CLI that ends itself on "cancel" still takes its children along', async () => {
  await jobs.whenReady();
  const log = tmpLog();
  const ctl = new AbortController();
  // root-exits: the CLI process itself leaves (like an agent that exits on session/cancel) while mid and leaf run.
  const p = startProc({ bin: TREE, args: ['root', '--root-exits'], cwd: os.tmpdir(), env: { FAKE_TREE_LOG: log }, signal: ctl.signal, timeoutMs: 120_000, idleMs: 120_000, graceMs: 3000, onLine: () => {} });
  const info = await until(() => {
    const L = readLog(log);
    const root = L.find((l) => l.root)?.root;
    const leaf = L.find((l) => l.leaf)?.leaf;
    const mid = L.find((l) => l.mid)?.mid;
    return root && leaf && mid ? { root, mid, leaf } : null;
  }, 15_000, 'tree started');
  ctl.abort(); // a stop: the adapter would now send its cancel and wait up to 3 s
  await p.done; // the root exits by itself within that grace time
  await p.stopped;
  await until(() => !alive(info.mid) && !alive(info.leaf), 10_000, 'children gone after a stop');
});

test('a CLI that ends by itself (no stop) keeps what it left running, and a stop never touches other processes', async () => {
  await jobs.whenReady();
  const log = tmpLog();
  const ctl = new AbortController();
  // A process TeamBot did not start for this CLI.
  const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  try {
    const p = tree(['root', '--root-exits'], log, ctl);
    const info = await until(() => {
      const L = readLog(log);
      const leaf = L.find((l) => l.leaf)?.leaf;
      const mid = L.find((l) => l.mid)?.mid;
      return leaf && mid ? { mid, leaf } : null;
    }, 15_000, 'tree started');
    await p.done;
    await new Promise((r) => setTimeout(r, 800));
    assert.ok(alive(info.mid) && alive(info.leaf), 'nobody pressed stop: unchanged behaviour');
    killAll([info.leaf, info.mid]);

    const log2 = tmpLog();
    const ctl2 = new AbortController();
    const p2 = tree(['root'], log2, ctl2);
    const info2 = await until(() => {
      const L = readLog(log2);
      const leaf = L.find((l) => l.leaf)?.leaf;
      const root = L.find((l) => l.root)?.root;
      return leaf && root ? { root, leaf } : null;
    }, 15_000, 'second tree started');
    ctl2.abort();
    await p2.done;
    await p2.stopped;
    await until(() => !alive(info2.root) && !alive(info2.leaf), 10_000, 'second tree gone');
    assert.ok(alive(other.pid), 'a process TeamBot did not start for the CLI keeps running');
  } finally {
    other.kill();
  }
});

// ---------------------------------------------------------------------------
// The real "Alles stoppen" (POST /api/stop-all) with the fake CLIs of the other tests, each wrapped so that it also
// leaves an orphan behind: Claude Code (stream-json), Codex (exec --json) and OpenCode-style ACP.
// ---------------------------------------------------------------------------

async function stopAllLeavesNothing(t: TestApp, kind: string, config: any, prompt: string, access = 'ask', target: string) {
  const log = path.join(t.dir, 'tree.log');
  process.env.FAKE_TREE_LOG = log;
  process.env.FAKE_TREE_TARGET = target;
  process.env.FAKE_TREE_HOLD = '1';
  process.env.FAKE_CLI_LOG = path.join(t.dir, 'fake-cli.log');
  try {
    const p = await t.api('POST', '/providers', { kind, config });
    const a = await t.api('POST', '/agents', { name: 'Stopbot', provider_id: p.id, model: '', access_mode: access });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    await t.api('POST', `/threads/${th.id}/messages`, { content: prompt });
    // The CLI runs, its middle process has left and the orphaned leaf runs on.
    const pids = await until(() => {
      const L = readLog(log);
      const root = L.find((l) => l.root)?.root;
      const leaf = L.find((l) => l.leaf)?.leaf;
      const mid = L.find((l) => l.mid)?.mid;
      return root && leaf && mid && !alive(mid) ? pidsIn(L) : null;
    }, 20_000, `${kind}: tree with an orphan`);
    const leaf = readLog(log).find((l) => l.leaf)!.leaf;
    assert.ok(pids.includes(leaf) && alive(leaf), `${kind}: the orphan runs before the stop`);
    const r = await t.api('POST', '/stop-all', {});
    assert.equal(r.stopped, 1, `${kind}: one run stopped`);
    await t.waitIdle(th.id, 20_000);
    const all = pidsIn([...readLog(log), ...readLog(process.env.FAKE_CLI_LOG!)]);
    await until(() => all.every((x) => !alive(x)), 15_000, `${kind}: no process left behind (${all.join(', ')})`);
    const run = t.app.ctx.store.one<any>('SELECT status FROM runs WHERE thread_id = ?', th.id);
    assert.equal(run.status, 'cancelled');
  } finally {
    delete process.env.FAKE_TREE_LOG;
    delete process.env.FAKE_TREE_TARGET;
    delete process.env.FAKE_TREE_HOLD;
    delete process.env.FAKE_CLI_LOG;
  }
}

test('Alles stoppen: Claude Code leaves no process behind (its own child and an orphan)', async () => {
  const t = await startTestApp();
  try {
    await stopAllLeavesNothing(t, 'claude-code', { path: TREE }, 'SCENARIO:hang', 'ask', FAKE_CLAUDE);
  } finally {
    await t.close();
  }
});

test('Alles stoppen: Codex leaves no process behind', async () => {
  const t = await startTestApp();
  try {
    await stopAllLeavesNothing(t, 'codex-cli', { path: TREE }, 'gewoon een vraag', 'auto', FAKE_CODEX);
  } finally {
    await t.close();
  }
});

test('Alles stoppen: an ACP engine (OpenCode-style) leaves no process behind', async () => {
  const t = await startTestApp();
  try {
    await stopAllLeavesNothing(t, 'acp-custom', { command: TREE, args: [] }, 'SCENARIO:hang', 'ask', FAKE_ACP);
  } finally {
    await t.close();
  }
});
