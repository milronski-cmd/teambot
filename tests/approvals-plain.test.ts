import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { msgs, settle, team } from './team-mock.js';
import os from 'node:os';
import path from 'node:path';
import { approvalAction, approvalToolName, approvalWhat } from '../shared/approvalLabels.js';
import { acpToolSummary, claudeToolSummary, plainCommand } from '../server/modules/cli-agents/permissions.js';
import { failedDetail } from '../server/modules/cli-agents/acp.js';
import { claudeErrorText, deniedWhat, failedStep } from '../server/modules/cli-agents/activity-labels.js';

/**
 * Fewer and clearer approvals in "Vraagt toestemming": team-internal tools (asking or giving work to your own bots,
 * the task board) run without a card, and every card says what the bot wants in plain words.
 */

test('ask mode: asking or giving work to your own bots needs no approval; memory about you still asks', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent({ access_mode: 'ask', tool_groups: ['team', 'memory'] });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    const tools = await t.app.ctx.tools.forAgent(t.app.ctx.store.agent(a.id)!, t.app.ctx.store.thread(th.id)!);
    const tool = (n: string) => tools.find((x) => x.name === n)!;
    const decide = (mode: string, n: string, policy: Record<string, string> = {}) => t.app.ctx.broker.decide({ ...t.app.ctx.store.agent(a.id)!, access_mode: mode as any, tool_policy: policy as any }, tool(n));
    for (const n of ['ask_bot', 'message_bot', 'delegate_task', 'broadcast', 'handoff', 'delegation_cancel', 'task_create', 'task_update']) {
      assert.equal(tool(n).internal, true, n);
      assert.equal(decide('ask', n), 'allow', `${n} in ask mode`);
      assert.equal(decide('readonly', n), 'deny', `${n} stays off in readonly`);
      assert.equal(decide('chat', n), 'deny');
    }
    assert.equal(decide('ask', 'ask_bot', { ask_bot: 'ask' }), 'ask', 'the owner can still ask for a card');
    assert.equal(decide('ask', 'ask_bot', { ask_bot: 'deny' }), 'deny');
    assert.equal(decide('ask', 'memory_remember'), 'ask', 'memory writes keep their approval card');
    assert.equal(decide('ask', 'memory_update'), 'ask');

    // Through the real tool path: ask_bot to another bot of the owner runs at once, no approval row.
    const m = await team(t);
    const lead = await m.bot('Lead', { access_mode: 'ask', tool_groups: ['team'] });
    await m.bot('Operations');
    m.script('Lead', { toolCalls: [{ name: 'ask_bot', args: { bot: 'Operations', message: 'Hoe staat de voorraad?', reply: false } }] }, { text: 'Gevraagd.' });
    m.script('Operations', { text: 'Voorraad is op peil.' });
    const lt = await t.api('POST', '/threads', { agentId: lead.id });
    await t.say(lt.id, 'Vraag Operations naar de voorraad');
    await settle(t);
    assert.equal(t.app.ctx.store.all("SELECT * FROM approvals WHERE agent_id = ?", lead.id).length, 0, 'no approval card for a colleague');
    assert.ok(msgs(t, lt.id).some((x) => x.role === 'tool' && /Operations/.test(x.content) && !/geweigerd/i.test(x.content)));
  } finally {
    await t.close();
  }
});

test('approval cards say what the bot wants, per tool and group, never a technical tool id', () => {
  const v = (tool: string, input: any = {}, risk = 'write') => approvalAction({ tool, input, risk });
  assert.equal(v('memory_remember', { scope: 'about_you', content: 'x' }).verb, 'wil iets over je onthouden');
  assert.equal(v('memory_remember', { content: 'x' }).verb, 'wil iets onthouden');
  assert.equal(v('memory_update', { id: 'm:abc123', content: 'y' }).verb, 'wil iets in het geheugen aanpassen');
  assert.equal(v('memory_forget', {}, 'danger').tone, 'danger');
  assert.equal(v('ask_bot', { bot: 'Operations', message: 'hoi' }).verb, 'wil Operations iets vragen');
  assert.equal(v('message_bot', { bot: 'Planner' }).verb, 'wil Planner een bericht sturen');
  assert.equal(v('delegate_task', { bot: 'Schrijver' }).verb, 'wil een taak aan Schrijver geven');
  assert.equal(v('claude-code:Write', { file_path: 'C:\\x\\a.txt' }).verb, 'wil een bestand wijzigen');
  // B-46: a write in the team folder or an extra folder is not "in de werkmap"; the card's title names the file.
  for (const tool of ['claude-code:Write', 'codex-cli:bestanden', 'codex-cli:bestand-schrijven', 'opencode:edit']) {
    assert.ok(!/werkmap/.test(v(tool, { file_path: 'C:\\Teammap\\inbox.txt' }).text), `${tool}: ${v(tool).text}`);
  }
  assert.equal(v('claude-code:Bash', { command: 'npm test' }, 'exec').verb, 'wil een opdracht uitvoeren');
  assert.equal(v('claude-code:Bash:danger', { command: 'git push' }, 'danger').tone, 'danger');
  assert.equal(v('codex-cli:netwerk', {}, 'danger').verb, 'wil internet gebruiken');
  assert.equal(v('opencode:edit').badge, 'Bestand');
  assert.equal(v('mcp_gmail_send_email', {}, 'danger').verb, 'wil iets doen in gmail');
  assert.equal(v('channel_send', { channel: 'WhatsApp' }, 'danger').verb, 'wil een bericht versturen via WhatsApp');
  assert.equal(v('desktop_request_access').tone, 'danger');
  assert.equal(v('iets_onbekends', {}, 'exec').verb, 'wil een opdracht uitvoeren');
  // No card ever says "Wijzigen – wijzigt bestanden" for memory or team tools.
  for (const tool of ['memory_remember', 'memory_update', 'dossier_add', 'ask_bot', 'message_bot', 'task_create']) {
    const a = v(tool, { bot: 'X' });
    assert.notEqual(a.badge, 'Wijzigen', tool);
    assert.ok(!/bestanden/i.test(a.text), `${tool}: ${a.text}`);
  }
  for (const tool of ['claude-code:Write', 'codex-cli:opdracht', 'memory_update', 'ask_bot']) {
    const all = JSON.stringify(v(tool, { bot: 'Operations' }));
    assert.ok(!/claude-code|codex-cli|memory_update|ask_bot/.test(all), `${tool} label has no tool id: ${all}`);
  }
  assert.equal(approvalToolName({ tool: 'ask_bot', input: { bot: 'Operations' }, risk: 'write' }), 'Operations iets vragen');
  assert.equal(approvalToolName({ tool: 'ask_form', input: {}, risk: 'read', kind: 'question' }), 'vraag');
});

test('Claude Code approvals and steps in words: "Bestand schrijven: notities/plan.md", "Wacht op toestemming: een bestand wijzigen"', () => {
  const root = path.resolve(os.tmpdir(), 'tb-werkmap');
  assert.equal(claudeToolSummary('Write', { file_path: path.join(root, 'notities', 'plan.md'), content: 'x' }, root), 'Bestand schrijven: notities/plan.md');
  assert.equal(claudeToolSummary('Edit', { file_path: path.join(os.tmpdir(), 'elders.txt') }, root), `Bestand aanpassen: ${path.join(os.tmpdir(), 'elders.txt')}`, 'outside the working folder: the full path');
  assert.equal(claudeToolSummary('Bash', { command: 'npm test' }, root), 'Opdracht: npm test');
  assert.equal(claudeToolSummary('WebFetch', { url: 'https://example.org' }, root), 'Webpagina lezen: https://example.org');
  assert.equal(approvalWhat({ tool: 'claude-code:Write', risk: 'write' }), 'een bestand wijzigen');
  assert.equal(approvalWhat({ tool: 'memory_remember', risk: 'write', input: { scope: 'about_you' } }), 'iets over je onthouden');
  // A step that failed did not happen (round 5, B-45): no "Las x" / "Lukte niet: las x", no English from Claude Code,
  // and refused actions in words instead of "Read, Write".
  assert.deepEqual(failedStep('Las buiten/geheim.txt'), { title: 'Wil buiten/geheim.txt lezen', line: 'Lukte niet: buiten/geheim.txt lezen' });
  assert.deepEqual(failedStep('Deeltaak · Schreef buiten/uit.txt'), { title: 'Deeltaak · Wil buiten/uit.txt schrijven', line: 'Lukte niet: buiten/uit.txt schrijven' });
  assert.deepEqual(failedStep('Lees README'), { title: 'Lees README', line: 'Lukte niet: lees README' });
  assert.equal(
    claudeErrorText('C:\\x\\geheim.txt is outside C:\\w\\ag_1, C:\\Teammap; --restricted confines the file tools to the working directory.'),
    'C:\\x\\geheim.txt valt buiten de mappen van deze bot (C:\\w\\ag_1, C:\\Teammap).',
  );
  assert.equal(claudeErrorText('File does not exist.'), 'File does not exist.');
  const ws = path.resolve(os.tmpdir(), 'tb-werkmap');
  assert.equal(deniedWhat([{ tool_name: 'Read', tool_input: { file_path: path.join(ws, 'a.txt') } }, { tool_name: 'Write', tool_input: { file_path: path.join(ws, 'b.txt'), content: 'x' } }]).includes('Read'), false);
  assert.match(deniedWhat([{ tool_name: 'Read', tool_input: { file_path: 'C:/buiten/a.txt' } }, { tool_name: 'Write', tool_input: { file_path: 'C:/buiten/b.txt', content: 'x' } }]), /a\.txt lezen, .*b\.txt schrijven/);
});

test('OpenCode and other ACP engines in words: no "shell", no "soort: execute", no working-folder path, no command twice', () => {
  const root = path.resolve(os.tmpdir(), 'tb-werkmap');
  const cmd = `cd "${root}" && ls -la uploads && which pdftotext python python3 2>/dev/null`;
  // OpenCode sends the command as the title too: the card used to show "<command>: <command>".
  assert.equal(acpToolSummary({ kind: 'execute', title: cmd, rawInput: { command: cmd } }, root), 'Opdracht: ls -la uploads && which pdftotext python python3 2>/dev/null');
  assert.equal(acpToolSummary({ kind: 'execute', title: 'shell', locations: [{ path: root }] }, root), 'Opdracht');
  assert.equal(acpToolSummary({ kind: 'edit', title: 'edit', rawInput: { filePath: path.join(root, 'notities', 'plan.md') } }, root), 'Bestand aanpassen: notities/plan.md');
  assert.equal(acpToolSummary({ kind: 'read', title: 'read', locations: [{ path: path.join(root, 'uploads', 'offerte.pdf') }] }, root), 'Bestand lezen: uploads/offerte.pdf');
  assert.equal(acpToolSummary({ kind: 'fetch', title: 'webfetch', rawInput: { url: 'https://example.org' } }, root), 'Webpagina lezen: https://example.org');
  assert.equal(acpToolSummary({ kind: 'other', title: 'Plan opstellen' }, root), 'Plan opstellen');
  // OpenCode's own tool names were shown as steps: "websearch", "websearch — mislukt".
  assert.equal(acpToolSummary({ kind: 'fetch', title: 'websearch', rawInput: { query: 'weer Utrecht morgen' } }, root), 'Zoeken op internet: weer Utrecht morgen');
  assert.equal(acpToolSummary({ kind: 'other', title: 'todowrite' }, root), 'Plan bijwerken');
  // Only the bot's own folder is dropped from a command; another cd stays visible.
  assert.equal(plainCommand(`cd "${root}" && npm test`, root), 'npm test');
  assert.equal(plainCommand('cd C:\Windows && dir', root), 'cd C:\Windows && dir');
  // After TeamBot refused a step, OpenCode's English "The user declined this tool call" is no detail in the steps.
  assert.equal(failedDetail('The user declined this tool call'), 'Niet toegestaan.');
  assert.equal(failedDetail('user rejected permission.'), 'Niet toegestaan.');
  assert.equal(failedDetail('Bestand niet gevonden: a.txt'), 'Bestand niet gevonden: a.txt');
});

test('a dossier card or notification never reads Dossier “” when the bot named the dossier by its code', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent({ access_mode: 'ask', tool_groups: ['memory'] });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    const tools = await t.app.ctx.tools.forAgent(t.app.ctx.store.agent(a.id)!, t.app.ctx.store.thread(th.id)!);
    const s = (name: string, args: any) => tools.find((x: any) => x.name === name)!.summarize!(args);
    assert.equal(s('dossier_add', { dossier: 'd:ab12cd', kind: 'action', title: 'Offerte opvragen' }), 'Dossier: actie — Offerte opvragen');
    assert.equal(s('dossier_add', { dossier: 'Zolder', kind: 'action', title: 'Offerte opvragen' }), 'Dossier “Zolder”: actie — Offerte opvragen');
    assert.equal(s('dossier_get', { dossier: 'd:ab12cd' }), 'Dossier lezen');
    assert.equal(s('dossier_update', { id: 'd:ab12cd', status: 'closed' }), 'Dossier bijwerken → closed');
  } finally {
    await t.close();
  }
});
