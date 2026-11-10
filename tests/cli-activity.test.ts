import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acpActivity, acpPendingTitle, acpPermissionSummary, appNames, cliActivity, cliPending, cliStatus, pendingTitle } from '../server/modules/cli-agents/activity-labels.js';
import { claudeStatusText, handleClaudeLine } from '../server/modules/cli-agents/claude.js';
import { describeTool } from '../server/modules/cli-agents/acp.js';
import { LANGUAGE_NOTE, sessionInstructions, withLanguage } from '../server/modules/cli-agents/context.js';
import { preparingText } from '../server/agent/runner.js';

const RAW = /mcp__|__|[A-Z][a-z]+[A-Z]|\{|\}/;

test('CLI steps are shown in plain words; internal housekeeping is hidden', () => {
  assert.equal(cliActivity('ToolSearch', { query: 'select:WebSearch' }), null);
  assert.equal(cliActivity('mcp__teambot__permission_prompt', {}), null);
  assert.equal(cliActivity('mcp__teambot__memory_update', { id: 'm:1', content: 'x' }), 'Werkte het geheugen bij');
  assert.equal(cliActivity('mcp__teambot__web_search', { query: 'x' }), 'Zocht op internet');
  assert.equal(cliActivity('mcp__github__create_issue', {}), 'Gebruikte github');
  assert.equal(cliActivity('WebSearch', { query: 'hoofdstad Australië' }), 'Zocht op internet: hoofdstad Australië');
  assert.equal(cliActivity('Read', { file_path: 'C:\\werk\\rapporten\\dag.md' }), 'Las rapporten/dag.md');
  // The working folder is named after the bot's internal id and attachments get a short id: neither is shown.
  assert.equal(cliActivity('Write', { file_path: 'C:\\TeamBot\\workspaces\\ag_858756a502274f46a685ee\\opruimen.py' }), 'Schreef opruimen.py');
  assert.equal(cliActivity('Read', { file_path: 'uploads/a31b28-offerte-zonnepanelen.pdf' }), 'Las uploads/offerte-zonnepanelen.pdf');
  assert.equal(cliActivity('Bash', { command: 'npm   test' }), 'Voerde uit: npm test');
  assert.equal(cliActivity('TodoWrite', { todos: [] }), 'Werkte zijn takenlijstje bij');
  assert.doesNotMatch(String(cliActivity('SomeNewTool', { a: 1 })), /[{}]/, 'never raw JSON');
});

test('a CLI error in the chat quotes its last output without stack-trace lines', async () => {
  const { lastOutput } = await import('../server/modules/cli-agents/context.js');
  // Seen in the round-2 soak: OpenCode failing to start showed Bun stack frames in the chat.
  const tail = 'Error: Standalone server exited before reporting readiness\n    at <anonymous> (B:/~BUN/root/chunk-d288gyy1.js:2:1020)\n    at cli.standalone.endpoint (B:/~BUN/root/chunk-thfrb1rb.js:11:5182)\n    at cli.acp (definition) (B:/~BUN/root/chunk-thfrb1rb.js:11:4984)';
  assert.equal(lastOutput(tail), 'Error: Standalone server exited before reporting readiness');
  assert.equal(lastOutput('boom: interne fout\n'), 'boom: interne fout');
  // Acceptance round 3 (A-05): OpenCode's colour codes showed as broken characters in "Profiel maken mislukt".
  assert.equal(lastOutput('\x1b[91m\x1b[1mError: \x1b[0mFree usage limit reached.'), 'Error: Free usage limit reached.');
  assert.equal(lastOutput(''), '');
});

test('tools of connected apps are named after the app, not after their technical name', () => {
  const apps = appNames([
    { name: 'mcp_bestanden_referentieserv_write_file', app: 'Bestanden (referentieserver)' },
    { name: 'memory_search' },
  ]);
  assert.deepEqual([...apps], [['mcp_bestanden_referentieserv_write_file', 'Bestanden (referentieserver)']]);
  assert.equal(cliActivity('mcp__teambot__mcp_bestanden_referentieserv_write_file', { path: 'a.txt' }, apps), 'Gebruikte Bestanden (referentieserver)');
  assert.equal(cliStatus('mcp__teambot__mcp_bestanden_referentieserv_write_file', apps), 'Gebruikt Bestanden (referentieserver)…');
  // without the list (older session) it still never shows the raw name
  assert.equal(cliStatus('mcp__teambot__mcp_bestanden_referentieserv_write_file'), 'Gebruikt een app…');
});

test('the progress line while a step is prepared is in words (Claude Code, API runs)', () => {
  assert.equal(cliStatus('WebSearch'), 'Zoekt op internet…');
  assert.equal(cliStatus('Read'), 'Leest een bestand…');
  assert.equal(cliStatus('Bash'), 'Voert een opdracht uit…');
  assert.equal(cliStatus('mcp__teambot__memory_search'), 'Zoekt in het geheugen…');
  assert.equal(cliStatus('mcp__notion__search'), 'Gebruikt notion…');
  assert.equal(cliStatus('ToolSearch'), null, 'housekeeping keeps the current line');
  assert.equal(cliStatus('SomethingNew'), 'Bereidt een stap voor…');
  for (const t of ['WebSearch', 'WebFetch', 'Edit', 'Task', 'mcp__teambot__skill_load', 'SomethingNew']) assert.doesNotMatch(String(cliStatus(t)), RAW, t);

  // the Claude Code stream: a tool_use block start becomes a status in words, never "Tool voorbereiden: WebSearch"
  const events: any[] = [];
  const s: any = { emit: (e: any) => events.push(e), activity: () => {}, req: {}, ctx: {}, apps: new Map([['mcp_bestanden_x_write_file', 'Bestanden']]) };
  const st: any = { text: '', reasoning: '', streamedMsgs: new Set(), currentMsg: null, needSep: false, tools: new Map(), result: null, initSeen: true };
  const start = (name: string) => handleClaudeLine(s, st, JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 't' + events.length, name } } }));
  start('WebSearch');
  start('mcp__teambot__mcp_bestanden_x_write_file');
  start('ToolSearch');
  // Claude Code's own status words ("requesting") are not shown raw either
  handleClaudeLine(s, st, JSON.stringify({ type: 'system', subtype: 'status', status: 'requesting' }));
  assert.equal(claudeStatusText('compacting'), 'Vat het gesprek samen…');
  assert.equal(claudeStatusText('something_new'), 'Bezig…');
  assert.deepEqual(events, [
    { type: 'status', text: 'Zoekt op internet…' },
    { type: 'status', text: 'Gebruikt Bestanden…' },
    { type: 'status', text: 'Denkt na…' },
  ]);

  // The first step names the model in words (acceptance round 3: "Model: claude-opus-5-5").
  const acts: any[] = [];
  const s2: any = { emit: () => {}, activity: (kind: string, title: string, detail?: string) => acts.push({ kind, title, detail }), req: {}, ctx: {}, apps: new Map() };
  const st2: any = { text: '', reasoning: '', streamedMsgs: new Set(), currentMsg: null, needSep: false, tools: new Map(), result: null, initSeen: false };
  handleClaudeLine(s2, st2, JSON.stringify({ type: 'system', subtype: 'init', session_id: 'x', model: 'claude-opus-5-5', tools: [] }));
  assert.equal(acts.find((a) => a.kind === 'session')?.detail, 'Model: Opus 5.5');

  // API runs: TeamBot's own names, connected apps by their app name
  assert.equal(preparingText('web_search'), 'Zoekt op internet…');
  assert.equal(preparingText('mcp_github_create_issue', [{ name: 'mcp_github_create_issue', app: 'GitHub' } as any]), 'Gebruikt GitHub…');
});

test('CLI engines get a firm language rule at the end of their instructions', () => {
  const sys = 'Je bent Assistent.\n\n## Jouw instructies\nWees kort.';
  const full = sessionInstructions(sys, '## TeamBot-tools\nNaast je eigen tools …');
  assert.ok(full.endsWith(LANGUAGE_NOTE), 'the language rule comes last');
  assert.match(LANGUAGE_NOTE, /^## Taal/);
  assert.match(LANGUAGE_NOTE, /Nederlands/);
  assert.match(LANGUAGE_NOTE, /tussen je stappen/);
  assert.equal(withLanguage(full), full, 'added once');
});

// Found in the acceptance test with OpenCode 2.2.5: its steps read "execute / soort: other", "write / soort: edit",
// and approval cards said "execute" or "C:\…\notitie-oc.md: C:\…\notitie-oc.md".
test('ACP (OpenCode) steps and approval cards are in words, not tool names or bare paths', () => {
  const W = 'C:\\Users\\jij\\ws\\ag_1';
  const code = { title: 'execute', kind: 'other', rawInput: { code: 'const res = await fetch("https://example.com");\nreturn await res.text();' } };
  assert.equal(acpActivity(code), 'Voerde code uit');
  assert.equal(acpPermissionSummary(code, [], W), 'Code uitvoeren: const res = await fetch("https://example.com");');
  const write = { title: `${W}\\notities\\plan.md`, kind: 'edit', locations: [{ path: `${W}\\notities\\plan.md` }] };
  assert.equal(acpActivity(write), 'Paste notities/plan.md aan');
  if (process.platform === 'win32') assert.equal(acpPermissionSummary(write, [`${W}\\notities\\plan.md`], W), 'Bestand schrijven: notities/plan.md');
  assert.equal(acpActivity({ title: 'read', kind: 'read', rawInput: { filePath: 'C:\\team\\afspraken.md' } }), 'Las team/afspraken.md');
  assert.equal(acpPermissionSummary({ title: 'bash', kind: 'execute', rawInput: { command: 'npm test' } }, [], W), 'Opdracht: npm test');
  // a title the agent wrote in words stays
  assert.equal(acpActivity({ title: 'Lees README', kind: 'read' }), 'Lees README');
  for (const c of [code, write, { title: 'webfetch', kind: 'fetch', rawInput: { url: 'https://example.com' } }]) assert.doesNotMatch(acpActivity(c), /soort:|^execute$|^write$/);
});

// Acceptance round 6 with OpenCode 2.2.6 (code mode): every TeamBot tool call was one "execute" step with a small
// program, so a bot that opened a page and asked the owner to log in showed "Voerde code uit" four times, and
// "Wil code uitvoeren" next to the login card.
test('OpenCode code mode: a program that only calls tools is named after the tool, a lookup says so, real code stays code', () => {
  const step = (code: string) => ({ title: 'execute', kind: 'other', rawInput: { code } });
  const nav = step('const nav = await tools.teambot.browser_navigate({ url: "https://example.com" });\nconst snap = await tools.teambot.browser_snapshot({});\nreturn { nav, snap };');
  assert.equal(acpActivity(nav), 'Gebruikte de browser');
  assert.equal(pendingTitle(acpActivity(nav)), 'Wil de browser gebruiken');
  // the same words as that TeamBot tool in a Claude Code run
  assert.equal(acpActivity(step('return await tools.teambot.memory_update({ id: "m1", text: "x" });')), cliActivity('mcp__teambot__memory_update', {}));
  const lookup = step('const r = await search({ query: "browser text extract", namespace: "teambot" });\nreturn r;');
  assert.equal(acpActivity(lookup), 'Zocht een TeamBot-functie op');
  assert.equal(pendingTitle(acpActivity(lookup)), 'Zoekt een TeamBot-functie op');
  // another MCP server of OpenCode itself is named like Claude Code's: "Gebruikte <server>"
  assert.equal(acpActivity(step('return await tools.github.list_issues({ repo: "a/b" });')), 'Gebruikte github');
  // real code is never dressed up as a TeamBot step
  assert.equal(acpActivity(step('const r = await fetch("https://example.com/");\nreturn (await r.text()).slice(0, 2000);')), 'Voerde code uit');
  assert.equal(acpActivity(step('const x = await tools.teambot.browser_snapshot({});\nconst r = await fetch("https://evil.example");\nreturn x;')), 'Voerde code uit');
  assert.equal(acpActivity(step('return [1, 2, 3].map((n) => n * 2);')), 'Voerde code uit');
  // the first update has no program yet: as before
  assert.equal(pendingTitle(acpActivity({ title: 'execute', kind: 'other', rawInput: {} })), 'Wil code uitvoeren');
  // waiting for its card: the TeamBot tool in the present tense, as in a Claude Code run (round 6 showed "Publiceerde
  // een website" next to the card that still asked)
  const site = step('return await tools.teambot.site_publish({ folder: "site" });');
  assert.equal(acpPendingTitle(site), cliPending('mcp__teambot__site_publish', {}));
  assert.notEqual(acpPendingTitle(site), acpActivity(site));
  assert.equal(acpPendingTitle(lookup), 'Zoekt een TeamBot-functie op');
  assert.equal(acpPendingTitle({ title: 'execute', kind: 'other', rawInput: {} }), 'Wil code uitvoeren');
  const edit = { title: 'write', kind: 'edit', locations: [{ path: 'C:\\w\\a.md' }] };
  assert.equal(acpPendingTitle(edit), pendingTitle(acpActivity(edit)), 'other steps as before');
});

// Acceptance round 6 (B-47): an OpenCode step read "TeamBot · Bestand delen: C:\…\workspaces\ag_a837…\offerte-velomax.pdf".
test('TeamBot steps of a CLI bot show files in its own folder without that folder (and its internal id)', async () => {
  const { withoutOwnFolder } = await import('../server/modules/cli-agents/toolhost.js');
  const win = process.platform === 'win32';
  const ws = win ? 'C:\\Users\\jij\\tb\\workspaces\\ag_a83726d6d14f47b4831fd3' : '/home/jij/tb/workspaces/ag_a83726d6d14f47b4831fd3';
  const team = win ? 'C:\\Users\\jij\\Teammap' : '/home/jij/Teammap';
  const agent: any = { workspace: ws, settings: { folders: [{ path: team, mode: 'rw' }] } };
  const sep = win ? '\\' : '/';
  assert.equal(withoutOwnFolder(`Bestand delen: ${ws}${sep}offerte-velomax.pdf`, agent), 'Bestand delen: offerte-velomax.pdf');
  assert.equal(withoutOwnFolder(`Bestand delen: ${ws}${sep}rapporten${sep}mei.pdf`, agent), `Bestand delen: rapporten${sep}mei.pdf`);
  // forward slashes and (on Windows) another case are the same folder
  if (win) assert.equal(withoutOwnFolder(`Bestand delen: ${ws.toLowerCase().replace(/\\/g, '/')}/a.pdf`, agent), 'Bestand delen: a.pdf');
  // another folder (the team folder) is information and stays
  assert.equal(withoutOwnFolder(`Bestand delen: ${team}${sep}plan.md`, agent), `Bestand delen: ${team}${sep}plan.md`);
  assert.equal(withoutOwnFolder('Geheugen bijwerken', agent), 'Geheugen bijwerken');
});

// Acceptance round 6 (B-45, B-36): the refusal detail read "… Toegestaan: C:\…\workspaces\ag_eff2…", and in practice
// mode a step read "Las work/README.md" (the practice copy's internal folder).
test("steps never show the bot's own folder: not its internal id, not the practice copy", async () => {
  const { withoutOwnFolder } = await import('../server/modules/cli-agents/activity-labels.js');
  const win = process.platform === 'win32';
  const sep = win ? '\\' : '/';
  const ws = win ? 'C:\\Users\\jij\\tb\\workspaces\\ag_eff2a6d6d14f47b4831fd3' : '/home/jij/tb/workspaces/ag_eff2a6d6d14f47b4831fd3';
  const team = win ? 'C:\\Users\\jij\\Teammap' : '/home/jij/Teammap';
  const agent: any = { workspace: ws, settings: { folders: [{ path: team, mode: 'rw' }] } };
  const refusal = `Geweigerd door TeamBot: Pad valt buiten de toegestane werkmap en extra mappen: ${sep}x${sep}buiten.txt. Toegestaan: ${ws} ; ${team}`;
  assert.equal(withoutOwnFolder(refusal, agent), `Geweigerd door TeamBot: Pad valt buiten de toegestane werkmap en extra mappen: ${sep}x${sep}buiten.txt. Toegestaan: de werkmap ; ${team}`);
  assert.equal(withoutOwnFolder(`${ws}${sep}a.txt valt buiten (${ws}, ${team}).`, agent), `a.txt valt buiten (de werkmap, ${team}).`);
  // another bot with a longer id is not this folder
  assert.equal(withoutOwnFolder(`${ws}99${sep}a.txt`, agent), `${ws}99${sep}a.txt`);

  // practice mode: the copy is "…\rehearsals\ag_…\rh_…\work"; steps name the file as in the bot's real folder
  const copy = win ? 'C:\\Users\\jij\\tb\\computer\\rehearsals\\ag_eff2a6d6d14f47b4831fd3\\rh_1b2c3d4e5f60718293a4b5\\work' : '/home/jij/tb/computer/rehearsals/ag_eff2a6d6d14f47b4831fd3/rh_1b2c3d4e5f60718293a4b5/work';
  assert.equal(cliActivity('Read', { file_path: `${copy}${sep}README.md` }), 'Las README.md');
  assert.equal(acpActivity({ title: 'read', kind: 'read', locations: [{ path: `${copy}${sep}rommel${sep}factuur-maart.txt` }] }), 'Las rommel/factuur-maart.txt');
  assert.equal(acpActivity({ title: 'edit', kind: 'edit', locations: [{ path: `${copy}${sep}README.md` }] }), 'Paste README.md aan');
  assert.equal(withoutOwnFolder(`Bestand delen: ${copy}${sep}README.md`, { ...agent, workspace: copy }), 'Bestand delen: README.md');
  // a folder of the owner's own named "work" stays
  assert.equal(cliActivity('Read', { file_path: `${sep}home${sep}jij${sep}work${sep}plan.md` }), 'Las work/plan.md');
});

// Acceptance round 6 with OpenCode 2.2.6 (practice mode): a shell step was titled with its bare command,
// "Get-ChildItem -Force -Recurse | …", instead of "Voerde uit: …".
test('an ACP step titled with its own command reads "Voerde uit: …"; a title in words stays', () => {
  const cmd = "Get-ChildItem -Force -Recurse | Select-Object FullName, Length";
  assert.equal(acpActivity({ title: cmd, kind: 'execute', rawInput: { command: cmd, description: 'Lijst bestanden' } }), `Voerde uit: ${cmd}`);
  assert.equal(acpPendingTitle({ title: cmd, kind: 'execute', rawInput: { command: cmd } }), `Wil een opdracht uitvoeren: ${cmd}`);
  // OpenCode puts `cd "<werkmap>" &&` in front; the title may be cut short
  const W = process.platform === 'win32' ? 'C:\\w\\ag_641f97b17bd0417097d2ea' : '/w/ag_641f97b17bd0417097d2ea';
  assert.equal(acpActivity({ title: `cd "${W}" && ${cmd}`, kind: 'execute', rawInput: { command: `cd "${W}" && ${cmd}` } }, W), `Voerde uit: ${cmd}`);
  assert.equal(acpActivity({ title: 'Get-ChildItem -Force -Recurse…', kind: 'execute', rawInput: { command: cmd } }), `Voerde uit: ${cmd}`);
  // the agent's own words stay
  assert.equal(acpActivity({ title: 'Lijst alle bestanden', kind: 'execute', rawInput: { command: cmd } }), 'Lijst alle bestanden');
});

// Acceptance round 6 (B-04): one skill showed as two steps, "Pakte een skill erbij" and "TeamBot · Skill laden: …".
test('a TeamBot tool called by an ACP agent: named in words, and recognised so TeamBot reports on that step', async () => {
  const { acpTeambotTool } = await import('../server/modules/cli-agents/activity-labels.js');
  const names = new Set(['skill_load', 'browser_navigate', 'read_document']);
  // OpenCode 1.x names the MCP tool "teambot_<tool>"
  assert.equal(acpActivity({ title: 'teambot_skill_load', kind: 'other', rawInput: { name: 'brand-guidelines' } }), 'Pakte een skill erbij');
  assert.equal(acpPendingTitle({ title: 'teambot_skill_load', kind: 'other' }), 'Pakt een skill erbij');
  assert.equal(acpTeambotTool({ title: 'teambot_skill_load', kind: 'other' }, names), 'skill_load');
  // OpenCode 2.x code mode: the first TeamBot tool of a program that only calls tools
  const code = (c: string) => ({ title: 'execute', kind: 'other', rawInput: { code: c } });
  assert.equal(acpTeambotTool(code('return await tools.teambot.skill_load({ name: "x" });'), names), 'skill_load');
  assert.equal(acpTeambotTool(code('const a = await tools.teambot.browser_navigate({ url: "https://example.com" });\nreturn a;'), names), 'browser_navigate');
  // not: real code, another server, an unknown tool, a native step, a lookup
  assert.equal(acpTeambotTool(code('const r = await fetch("https://x");\nreturn await tools.teambot.skill_load({});'), names), null);
  assert.equal(acpTeambotTool(code('return await tools.github.list_issues({});'), names), null);
  assert.equal(acpTeambotTool(code('return await tools.teambot.niet_bestaand({});'), names), null);
  assert.equal(acpTeambotTool({ title: 'teambot_skill_load', kind: 'edit', locations: [{ path: 'a.md' }] }, names), null);
  assert.equal(acpTeambotTool(code('return await search({ query: "skill" });'), names), null);
  assert.equal(acpTeambotTool({ title: 'execute', kind: 'other', rawInput: {} }, names), null);
});

test('one call of a TeamBot tool is one step: TeamBot reports on the engine\'s own step (B-04)', async () => {
  const { startTestApp } = await import('./helpers.js');
  const { makeScope } = await import('../server/modules/cli-agents/context.js');
  const t = await startTestApp();
  try {
    const a = await t.agent();
    const th = await t.api('POST', '/threads', { agentId: a.id });
    const shown: any[] = [];
    const s = makeScope(t.app.ctx, { id: 'p', kind: 'claude-code' } as any, { agentId: a.id, threadId: th.id, runId: 'run_x', userId: 'u', prompt: '' } as any, new AbortController().signal, (e) => {
      if (e.type === 'activity' && !shown.includes(e.item)) shown.push(e.item);
    });
    const st: any = { text: '', reasoning: '', streamedMsgs: new Set(), currentMsg: null, needSep: false, tools: new Map(), result: null, sessionId: 's', initSeen: true, context: null };
    const use = (id: string, name: string, input: any) => handleClaudeLine(s, st, JSON.stringify({ type: 'assistant', message: { id: 'm' + id, content: [{ type: 'tool_use', id, name, input }] }, parent_tool_use_id: null }));
    const result = (id: string, isError = false) => handleClaudeLine(s, st, JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: isError ? 'mislukt' : 'ok', is_error: isError }] }, parent_tool_use_id: null }));

    use('t1', 'mcp__teambot__skill_load', { name: 'brand-guidelines' });
    assert.deepEqual(shown.map((x) => x.title), ['Pakt een skill erbij']);
    s.teambotResult!('skill_load', 'tool_result', 'TeamBot · Skill laden: brand-guidelines', 'Skill “brand-guidelines”');
    result('t1');
    assert.deepEqual(shown.map((x) => [x.kind, x.title]), [['tool_result', 'TeamBot · Skill laden: brand-guidelines']], 'one line, TeamBot keeps its words');

    // a failed TeamBot call: TeamBot's "— mislukt" line, no second "Lukte niet" from the engine
    use('t2', 'mcp__teambot__skill_load', { name: 'onbekend' });
    s.teambotResult!('skill_load', 'tool_error', 'TeamBot · Skill laden: onbekend — mislukt', 'Skill niet gevonden');
    result('t2', true);
    assert.deepEqual(shown.slice(1).map((x) => [x.kind, x.title]), [['tool_error', 'TeamBot · Skill laden: onbekend — mislukt']]);

    // an engine step that ended without reaching TeamBot is never used for a later call
    use('t3', 'mcp__teambot__skill_load', { name: 'x' });
    result('t3', true);
    s.teambotResult!('skill_load', 'tool_result', 'TeamBot · Skill laden: y');
    assert.equal(shown.at(-1).title, 'TeamBot · Skill laden: y');
    assert.notEqual(shown.at(-1), st.tools.get('t3').item);

    // the owner reads "de werkmap", never the bot's folder path with its internal id
    const item = s.activity('permission', 'Geweigerd: een bestand wijzigen', `Geweigerd door TeamBot: Pad valt buiten de toegestane werkmap: x. Toegestaan: ${a.workspace}`);
    assert.equal(item.detail, 'Geweigerd door TeamBot: Pad valt buiten de toegestane werkmap: x. Toegestaan: de werkmap');
  } finally {
    await t.close();
  }
});

// Acceptance round 3 with OpenCode: the steps read "Deed een stap (websearch)", "Voerde een opdracht uit — paden:
// C:\…\workspaces\ag_…" and the approval card "Opdracht: cd "C:\…\workspaces\ag_…" && python -c …".
test('OpenCode steps and cards: its bare tool names in words, never the working folder or its cd prefix', () => {
  const W = process.platform === 'win32' ? 'C:\\Users\\jij\\tb\\workspaces\\ag_641f97b17bd0417097d2ea' : '/home/jij/tb/workspaces/ag_641f97b17bd0417097d2ea';
  const sep = process.platform === 'win32' ? '\\' : '/';
  assert.equal(acpActivity({ title: 'websearch', kind: 'fetch', rawInput: { query: 'weer Utrecht' } }), 'Zocht op internet: weer Utrecht');
  assert.equal(acpActivity({ title: 'websearch', kind: 'other' }), 'Zocht op internet');
  assert.equal(acpActivity({ title: 'todowrite', kind: 'other' }), 'Werkte zijn takenlijstje bij');
  assert.equal(acpActivity({ title: 'skill', kind: 'other', rawInput: { name: 'pdf' } }), 'Pakte een skill erbij: pdf');
  const cmd = `cd "${W}" && python -c "print(1)"`;
  assert.equal(acpActivity({ title: 'bash', kind: 'execute', rawInput: { command: cmd } }, W), 'Voerde uit: python -c "print(1)"');
  assert.equal(acpPermissionSummary({ title: 'bash', kind: 'execute', rawInput: { command: cmd } }, [], W), 'Opdracht: python -c "print(1)"');
  // Another folder after cd stays visible: that is information.
  assert.match(acpPermissionSummary({ title: 'bash', kind: 'execute', rawInput: { command: `cd "${sep}elders" && ls` } }, [], W), /elders/);
  assert.equal(describeTool({ kind: 'execute', locations: [{ path: W }] }, W), undefined);
  assert.equal(describeTool({ kind: 'execute', rawInput: { command: cmd }, locations: [{ path: W }, { path: `${W}${sep}uploads${sep}a.pdf` }] }, W), 'opdracht: python -c "print(1)" · bestand: uploads/a.pdf');
});

// Acceptance round 4 (Q-12): a Claude Code step read "Schreef inbox-3.txt" while its approval card still asked.
test('a CLI step that waits for its result (or an approval) says what the bot wants to do; past tense once it is done', () => {
  assert.equal(pendingTitle('Schreef inbox-3.txt'), 'Wil inbox-3.txt schrijven');
  assert.equal(pendingTitle('Paste notities/plan.md aan'), 'Wil notities/plan.md aanpassen');
  assert.equal(pendingTitle('Las een webpagina: https://example.com'), 'Wil een webpagina lezen: https://example.com');
  assert.equal(pendingTitle('Las rapporten/dag.md'), 'Wil rapporten/dag.md lezen');
  assert.equal(pendingTitle('Voerde uit: npm test'), 'Wil een opdracht uitvoeren: npm test');
  assert.equal(pendingTitle('Verwijderde oud.txt'), 'Wil oud.txt verwijderen');
  assert.equal(pendingTitle('Deeltaak · Schreef a.md'), 'Deeltaak · Wil a.md schrijven');
  assert.equal(pendingTitle('Lees README'), 'Lees README', "the agent's own words stay");
  assert.equal(cliPending('Write', { file_path: 'C:\\w\\ag_858756a502274f46a685ee\\inbox-3.txt' }), 'Wil inbox-3.txt schrijven');
  assert.equal(cliPending('mcp__teambot__memory_update', {}), 'Werkt het geheugen bij', "TeamBot's own tools in the present tense");
  assert.equal(cliPending('ToolSearch', {}), null);

  // Claude Code's stream: tool_use → (approval) → tool_result. The same step is renamed, never a second line.
  const items: any[] = [];
  const s: any = {
    emit: () => {},
    activity: (kind: string, title: string) => (items.push({ kind, title }), items.at(-1)),
    retitle: (item: any, title: string) => (item.title = title),
    req: {},
    ctx: {},
    apps: new Map(),
  };
  const st: any = { text: '', reasoning: '', streamedMsgs: new Set(), currentMsg: null, needSep: false, tools: new Map(), result: null, sessionId: 's', initSeen: true, context: null };
  handleClaudeLine(s, st, JSON.stringify({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 'tu', name: 'Write', input: { file_path: 'inbox-3.txt', content: 'x' } }] }, parent_tool_use_id: null }));
  assert.deepEqual(items.map((i) => i.title), ['Wil inbox-3.txt schrijven'], 'while the card waits');
  handleClaudeLine(s, st, JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu', content: 'ok' }] }, parent_tool_use_id: null }));
  assert.deepEqual(items.map((i) => i.title), ['Schreef inbox-3.txt'], 'once the result is in');
});
