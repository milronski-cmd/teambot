// Approval only where it counts (plan 0.4 §G): irreversible or outward actions ask, with the exact action on the card;
// reversible work does not ask in "Automatisch"; "Volledige toegang" is only ever an explicit choice of the owner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp, type TestApp } from './helpers.js';
import { shellCommandImpact, shellCommandRisk } from '../server/tools/builtin/command-risk.js';
import { commandRisk } from '../server/modules/cli-agents/permissions.js';
import { callRisk } from '../server/tools/broker.js';
import { shellTools } from '../server/tools/builtin/shell.js';
import { createFoldersModule } from '../server/modules/folders/index.js';
import { fillWords } from '../shared/i18n-core.js';

test('shell commands: sending, publishing, pushing and deleting outside the trash are actions that ask', () => {
  for (const c of ['git push origin main', 'npm publish', 'curl -X POST https://x.test -d a=1', 'Invoke-RestMethod https://x -Method Post', 'ssh sanne@server.nl ls', 'rm notities.md', 'rm -rf build', 'Remove-Item .\\oud.txt', 'del /q *.log', 'cmd /c del rapport.docx', 'rmdir /s map', 'find . -name "*.tmp" -delete', 'git reset --hard HEAD~3', 'cd x && rm a.txt'])
    assert.equal(shellCommandRisk(c), 'danger', c);
  for (const c of ['npm test', 'ls -la', 'git status', 'git commit -m "x"', 'node build.mjs', 'Get-ChildItem', 'echo "rm is een woord"', 'python -c "print(1)"', 'curl https://example.com'])
    assert.equal(shellCommandRisk(c), 'exec', c);
  // "Volledige toegang": deleting, pushing, publishing and calling an API are the bot's own work; only a command that
  // mails someone counts as "to others".
  assert.equal(shellCommandImpact('rm -rf build'), 'local');
  assert.equal(shellCommandImpact('git push'), 'local');
  assert.equal(shellCommandImpact('curl -X POST https://x.test --data a'), 'local');
  assert.equal(shellCommandImpact('Send-MailMessage -To klant@example.com -Subject x'), 'external');
  // A mail program where a command starts mails someone; the word in an argument, a file name or typed text does not
  // (a bot on "Volledige toegang" waited for a card on `grep "… the account e-mail" tests`).
  for (const c of ['mail -s Offerte klant@example.com < offerte.txt', 'echo hoi | mailx klant@example.com', 'cd x && /usr/sbin/sendmail -t < bericht.eml', 'bash -c "mutt -s x klant@example.com"'])
    assert.equal(shellCommandImpact(c), 'external', c);
  for (const c of ['grep -rl "auto-memory off, the account e-mail" tests | head -1', 'cat mail.txt', 'git log --grep mail', 'git commit -m "mail de klant morgen"', "cat >> notities.md <<'EOF'\nmail de klant morgen\nrm oud.txt\ngit push\nEOF"]) {
    assert.equal(shellCommandImpact(c), 'local', c);
    assert.equal(shellCommandRisk(c), 'exec', c);
  }
  assert.equal(shellCommandRisk("bash <<'EOF'\nrm oud.txt\nEOF"), 'danger', 'a heredoc a shell reads is run');
  // The CLI gate treats outward commands the same way (one list, two places).
  for (const c of ['git push origin main', 'npm publish', 'curl -X POST https://x.test -d a=1', 'rm -rf build']) assert.equal(commandRisk(c), 'danger', `CLI gate: ${c}`);
});

test('run_command: the risk per call drives the broker; the card shows the exact command', () => {
  const tool = shellTools()[0];
  const t = { agent: {} as any, thread: {} as any, userId: 'u' };
  assert.equal(callRisk(tool, { command: 'git push' }, t), 'danger');
  assert.equal(callRisk(tool, { command: 'npm test' }, t), 'exec');
  const long = `node -e "${'x'.repeat(900)}"`;
  assert.ok(fillWords(tool.summarize!({ command: long })).includes(long), 'not cut off at 300 characters');
  assert.equal(fillWords(tool.summarize!({ command: 'npm test', cwd: 'app' })), 'Opdracht: npm test (in app)');
});

async function runTool(t: TestApp, agentId: string, name: string, args: any, decide?: 'approve' | 'deny') {
  const th = await t.api('POST', '/threads', { agentId });
  t.script.push({ toolCalls: [{ name, args }] }, { text: 'ok' });
  await t.api('POST', `/threads/${th.id}/messages`, { content: 'doe het' });
  for (let i = 0; i < 400; i++) {
    if (decide) for (const ap of await t.api('GET', '/approvals')) if (ap.status === 'pending') await t.api('POST', `/approvals/${ap.id}`, { decision: decide });
    if (!t.app.ctx.store.all("SELECT id FROM runs WHERE thread_id = ? AND status IN ('queued','running','waiting')", th.id).length && i > 2) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  return t.app.ctx.store.messages(th.id).find((m) => m.role === 'tool');
}

test('Automatisch: a harmless command runs; "git push" waits for a card that shows the command', async () => {
  const t = await startTestApp({ modules: [createFoldersModule()] });
  try {
    const a = await t.agent({ tool_groups: ['shell', 'files'], access_mode: 'auto' });
    await runTool(t, a.id, 'run_command', { command: 'echo hallo' });
    assert.equal((await t.api('GET', '/approvals?status=all')).length, 0, 'no card for a normal command');
    const res = await runTool(t, a.id, 'run_command', { command: 'git push origin main' }, 'deny');
    const cards = await t.api('GET', '/approvals?status=all');
    assert.equal(cards.length, 1);
    assert.equal(cards[0].risk, 'danger');
    assert.equal(cards[0].summary, 'Opdracht: git push origin main');
    assert.match(res!.content, /geweigerd/);
    // A reversible delete (into the trash) needs no card in Automatisch.
    fs.mkdirSync(a.workspace, { recursive: true });
    fs.writeFileSync(path.join(a.workspace, 'weg.txt'), 'x');
    await runTool(t, a.id, 'delete_file', { path: 'weg.txt' });
    assert.equal((await t.api('GET', '/approvals?status=all')).length, 1);
    assert.equal((await t.api('GET', '/folders/trash')).items.length, 1);
  } finally {
    await t.close();
  }
});

test('restoring an old bot version never turns Volledige toegang back on by itself', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent({ access_mode: 'full' });
    await t.api('PATCH', `/agents/${a.id}`, { access_mode: 'ask' });
    await t.api('PATCH', `/agents/${a.id}`, { name: 'Andere naam' });
    const versions = await t.api('GET', `/agents/${a.id}/versions`);
    const withFull = versions.find((v: any) => v.data.access_mode === 'full');
    assert.ok(withFull, 'an old version with full access exists');
    const upd = await t.api('POST', `/agents/${a.id}/versions/${withFull.id}/restore`, {});
    assert.equal(upd.access_mode, 'ask', 'the access level stays what the owner chose last');
    assert.equal(upd.name, 'Testbot', 'the rest of the old version is back');
  } finally {
    await t.close();
  }
});
