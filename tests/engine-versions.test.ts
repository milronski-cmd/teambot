// Engine version pinning (package N, plan G "Motorversies vastzetten"): a changed version of Claude Code, Codex or
// OpenCode is noticed and told plainly, a self-check that costs no model quota says pass or fail, and on a failure the
// exact command back to the known-good version is shown. Fake CLIs only (tests/fixtures/engine-fake-cli.mjs); the
// owner's real CLIs are never started, and TeamBot never installs or downgrades anything by itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestApp } from './helpers.js';
import cliAgents from '../server/modules/cli-agents/index.js';
import { RUNTIMES } from '../server/modules/cli-agents/runtimes.js';
import type { EngineVersions } from '../server/modules/cli-agents/versions.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'engine-fake-cli.mjs');

function fakeCli(dir: string, kind: 'claude' | 'codex' | 'opencode', cfg: Record<string, any>) {
  const bin = path.join(dir, `${kind}.mjs`);
  fs.copyFileSync(FIXTURE, bin);
  const set = (c: Record<string, any>) => fs.writeFileSync(bin + '.json', JSON.stringify({ kind, log: path.join(dir, 'calls.log'), ...c }));
  set(cfg);
  return { bin, set };
}

const calls = (dir: string) =>
  fs.existsSync(path.join(dir, 'calls.log'))
    ? fs
        .readFileSync(path.join(dir, 'calls.log'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    : [];

test('a changed engine version is noticed, self-checked for free, and a failure shows the way back', async () => {
  const t = await startTestApp({ modules: [cliAgents] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-engines-'));
  const notes: any[] = [];
  const off = t.app.ctx.events.subscribe((e) => e.type === 'notification' && notes.push(e.data));
  try {
    const versions: EngineVersions = t.app.ctx.services['cli-agents'].versions;
    // No waiting in the test: the check after a change starts at once.
    (versions as any).o.checkDelayMs = 0;
    const tested = RUNTIMES['claude-code'].pinned;
    const claude = fakeCli(dir, 'claude', { version: tested });
    await t.api('PUT', '/cli-agents/paths/claude-code', { path: claude.bin });

    // First sighting of the version TeamBot was tested with: recorded, no message.
    let items = (await t.api('GET', '/cli-agents/versions?fresh=1')).items;
    let c = items.find((i: any) => i.id === 'claude-code');
    assert.equal(c.version, tested);
    assert.equal(c.state, 'getest');
    assert.equal(c.tested, tested);
    assert.equal(notes.length, 0);

    // Claude Code updates itself to a version TeamBot has not tested: noticed and said plainly, then checked.
    claude.set({ version: '2.1.400' });
    await t.api('GET', '/cli-agents/status?fresh=1');
    await versions.idle();
    assert.ok(
      notes.some((n) => n.title === 'Claude Code is bijgewerkt naar 2.1.400' && /Nog niet getest met TeamBot/.test(n.body)),
      JSON.stringify(notes),
    );
    items = (await t.api('GET', '/cli-agents/versions')).items;
    c = items.find((i: any) => i.id === 'claude-code');
    assert.equal(c.previous, tested);
    assert.equal(c.check.ok, true, JSON.stringify(c.check));
    assert.equal(c.state, 'werkt');
    assert.ok(c.check.steps.some((s: any) => s.id === 'flags' && s.ok));
    assert.deepEqual(c.good, ['2.1.400']);

    // The next update drops an option TeamBot relies on: the check fails and says exactly what to run.
    claude.set({ version: '2.1.401', drop: ['--permission-prompt-tool'] });
    await t.api('GET', '/cli-agents/status?fresh=1');
    await versions.idle();
    items = (await t.api('GET', '/cli-agents/versions')).items;
    c = items.find((i: any) => i.id === 'claude-code');
    assert.equal(c.state, 'mislukt');
    assert.equal(c.check.ok, false);
    const flags = c.check.steps.find((s: any) => s.id === 'flags');
    assert.equal(flags.ok, false);
    assert.match(flags.detail, /--permission-prompt-tool/);
    // Back to the last version that worked here (2.1.400), as a command the owner runs himself.
    assert.equal(c.rollback.target, '2.1.400');
    assert.equal(c.rollback.command, 'claude install 2.1.400');
    assert.equal(c.rollback.oneClick, undefined, 'the owner\'s own CLI is never changed with one click');
    const warn = notes.find((n) => n.title === 'Claude Code 2.1.401 werkt niet goed met TeamBot');
    assert.ok(warn, JSON.stringify(notes));
    assert.match(warn.body, /claude install 2\.1\.400/);
    assert.equal(warn.kind, 'warning');

    // Accepting the version silences the state, until the next version.
    items = (await t.api('POST', '/cli-agents/versions/claude-code/accept')).items;
    assert.equal(items.find((i: any) => i.id === 'claude-code').state, 'akkoord');

    // npm-installed CLIs get the npm command.
    assert.equal(versions.rollback('claude-code', { version: '2.1.401', path: 'C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd', source: 'gevonden', good: [] }).command, `npm install -g @anthropic-ai/claude-code@${tested}`);
    assert.equal(versions.rollback('codex-cli', { version: '0.170.0', path: '/usr/lib/node_modules/@openai/codex/bin/codex.js', source: 'gevonden' }).command, `npm install -g @openai/codex@${RUNTIMES['codex-cli'].pinned}`);
    // TeamBot's own copy: the one-click way back is a verified install of the tested version.
    assert.equal(versions.rollback('opencode', { version: '2.3.0', source: 'teambot' }).oneClick, 'runtime');

    // Only --version, --help and the login state were asked: no install, no upgrade, no prompt.
    const all = calls(dir);
    assert.ok(all.length >= 6);
    for (const x of all) assert.ok(x.argv[0] === '--version' || x.argv[0] === '--help' || (x.argv[0] === 'auth' && x.argv[1] === 'status'), JSON.stringify(x.argv));
    assert.ok(!all.some((x) => x.argv.some((a: string) => /^(install|upgrade|update|-p|--print)$/.test(a))));
  } finally {
    off();
    await t.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('self-check of Codex (app-server handshake) and OpenCode (ACP handshake): pass and fail', async () => {
  const t = await startTestApp({ modules: [cliAgents] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-engines-'));
  try {
    const versions: EngineVersions = t.app.ctx.services['cli-agents'].versions;
    (versions as any).o.handshakeMs = 15_000;
    const codex = fakeCli(dir, 'codex', { version: '0.170.0' });
    const oc = fakeCli(dir, 'opencode', { version: '2.3.1' });
    await t.api('PUT', '/cli-agents/paths/codex-cli', { path: codex.bin });
    await t.api('PUT', '/cli-agents/paths/opencode', { path: oc.bin });

    let r = (await t.api('POST', '/cli-agents/versions/codex-cli/check')).check;
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.steps.find((s: any) => s.id === 'handshake').ok);
    r = (await t.api('POST', '/cli-agents/versions/opencode/check')).check;
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(r.steps.find((s: any) => s.id === 'handshake').detail, /initialize/);

    // A Codex without its app-server and an OpenCode that does not speak ACP fail the check, with the reason.
    codex.set({ version: '0.170.0', handshake: 'crash' });
    oc.set({ version: '2.3.1', handshake: 'bad' });
    r = (await t.api('POST', '/cli-agents/versions/codex-cli/check')).check;
    assert.equal(r.ok, false);
    const hs = r.steps.find((s: any) => s.id === 'handshake');
    assert.equal(hs.ok, false);
    assert.match(hs.detail, /stopte|unknown subcommand/);
    r = (await t.api('POST', '/cli-agents/versions/opencode/check')).check;
    assert.equal(r.ok, false);
    const items = (await t.api('GET', '/cli-agents/versions')).items;
    const o = items.find((i: any) => i.id === 'opencode');
    assert.equal(o.state, 'mislukt');
    assert.equal(o.rollback.command, `opencode upgrade v${RUNTIMES.opencode.pinned}`);
    // A missing option of "codex exec" fails too.
    codex.set({ version: '0.170.0', drop: ['--skip-git-repo-check'] });
    r = (await t.api('POST', '/cli-agents/versions/codex-cli/check')).check;
    assert.equal(r.steps.find((s: any) => s.id === 'flags').ok, false);
    // Nothing but version, help, login state and the two handshakes was started.
    for (const x of calls(dir)) assert.ok(['--version', 'exec', 'app-server', 'acp', 'login'].includes(x.argv[0]), JSON.stringify(x.argv));
    // Members never see this (CLI-agents are the owner's).
    const m = t.app.ctx.auth.createUser({ name: 'Lid', email: 'lid@test.local', password: 'geheim1234', role: 'member' });
    const s = t.app.ctx.auth.createSession(m.id, 'web', 'test');
    assert.equal((await fetch(`${t.app.url}/api/cli-agents/versions`, { headers: { authorization: `Bearer ${s.token}` } })).status, 403);
  } finally {
    await t.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
