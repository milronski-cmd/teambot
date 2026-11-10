import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestApp } from './helpers.js';
import { createFoldersModule, folderProblem } from '../server/modules/folders/index.js';
import { agentRootList, extraRootsOf, resolveInWorkspace } from '../server/tools/builtin/files.js';
import { gate } from '../server/modules/cli-agents/permissions.js';
import { buildClaudeArgs } from '../server/modules/cli-agents/claude.js';

function dirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-folders-'));
  const team = path.join(root, 'Gedeeld');
  const kennis = path.join(root, 'Kennis');
  const werk = path.join(root, 'Werk');
  for (const d of [team, kennis, werk]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(team, 'LEESMIJ.md'), '# Teammap\n');
  fs.writeFileSync(path.join(kennis, 'seo.md'), 'SEO-kennis\n');
  fs.writeFileSync(path.join(kennis, '.env'), 'GEHEIM=1\n');
  return { root, team, kennis, werk, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

async function toolResult(t: any, agentId: string, name: string, args: any) {
  const th = await t.api('POST', '/threads', { agentId });
  t.script.push({ toolCalls: [{ name, args }] });
  t.script.push({ text: 'ok' });
  const msgs = await t.say(th.id, 'doe het');
  return msgs.find((m: any) => m.role === 'tool');
}

test('read-only extra folder: reading works, writing and deleting are refused; read-write folder works', async () => {
  const d = dirs();
  const t = await startTestApp({ modules: [createFoldersModule()] });
  try {
    const a = await t.agent({ tool_groups: ['files'], settings: { folders: [{ path: d.kennis, mode: 'ro', label: 'Kennis' }, { path: d.werk, mode: 'rw', label: 'Werk' }] } });
    const roots = agentRootList(a);
    assert.deepEqual(roots.map((r) => [r.kind, r.mode]), [['workspace', 'rw'], ['extra', 'ro'], ['extra', 'rw']]);
    assert.deepEqual(extraRootsOf(a, { writableOnly: true }), [path.resolve(d.werk)]);

    const read = await toolResult(t, a.id, 'read_file', { path: path.join(d.kennis, 'seo.md') });
    assert.match(read.content, /SEO-kennis/);
    const write = await toolResult(t, a.id, 'write_file', { path: path.join(d.kennis, 'nieuw.md'), content: 'x' });
    assert.match(write.content, /alleen-lezen/);
    assert.ok(!fs.existsSync(path.join(d.kennis, 'nieuw.md')));
    const edit = await toolResult(t, a.id, 'edit_file', { path: path.join(d.kennis, 'seo.md'), old_text: 'SEO', new_text: 'X' });
    assert.match(edit.content, /alleen-lezen/);
    assert.equal(fs.readFileSync(path.join(d.kennis, 'seo.md'), 'utf8'), 'SEO-kennis\n');
    const ok = await toolResult(t, a.id, 'write_file', { path: path.join(d.werk, 'notitie.md'), content: 'hallo' });
    assert.match(ok.content, /Aangemaakt/);
    assert.equal(fs.readFileSync(path.join(d.werk, 'notitie.md'), 'utf8'), 'hallo');
    const secret = await toolResult(t, a.id, 'read_file', { path: path.join(d.kennis, '.env') });
    assert.match(secret.content, /beschermd/);
    assert.throws(() => resolveInWorkspace(a, path.join(d.root, 'buiten.txt')), /buiten/);
    // In words, never "werkmap(pen)" (acceptance round 5, B-45): this bot has extra folders, a bot without has one map.
    assert.throws(() => resolveInWorkspace(a, path.join(d.root, 'buiten.txt')), /^Error: Pad valt buiten de toegestane werkmap en extra mappen: /);
    const solo = await t.agent({ tool_groups: ['files'] });
    assert.throws(() => resolveInWorkspace(solo, path.join(d.root, 'buiten.txt')), /^Error: Pad valt buiten de toegestane werkmap: /);
  } finally {
    await t.close();
    d.cleanup();
  }
});

// Acceptance round 6 (B-45): an Ollama bot in "Vraagt toestemming" got an approval card for a write into its
// read-only extra folder ("Maakt een bestand in de werkmap"), and only after "Eenmalig toestaan" the refusal came.
test('ask mode: a write that can never land is refused before any approval card', async () => {
  const d = dirs();
  const t = await startTestApp({ modules: [createFoldersModule()] });
  try {
    const a = await t.agent({ tool_groups: ['files'], access_mode: 'ask', settings: { folders: [{ path: d.kennis, mode: 'ro', label: 'Kennis' }] } });
    const ro = await toolResult(t, a.id, 'write_file', { path: path.join(d.kennis, 'nieuw.md'), content: 'x' });
    assert.match(ro.content, /^Geweigerd door TeamBot: Deze map is alleen-lezen/);
    const edit = await toolResult(t, a.id, 'edit_file', { path: path.join(d.kennis, 'seo.md'), old_text: 'SEO', new_text: 'X' });
    assert.match(edit.content, /alleen-lezen/);
    const outside = await toolResult(t, a.id, 'write_file', { path: path.join(d.root, 'buiten.txt'), content: 'x' });
    assert.match(outside.content, /^Geweigerd door TeamBot: Pad valt buiten/);
    const del = await toolResult(t, a.id, 'delete_file', { path: path.join(d.kennis, 'seo.md') });
    assert.match(del.content, /alleen-lezen/);
    assert.equal(t.app.ctx.store.all('SELECT id FROM approvals').length, 0, 'no card for something that is refused anyway');
    assert.ok(!fs.existsSync(path.join(d.kennis, 'nieuw.md')) && !fs.existsSync(path.join(d.root, 'buiten.txt')));
    assert.equal(fs.readFileSync(path.join(d.kennis, 'seo.md'), 'utf8'), 'SEO-kennis\n');
  } finally {
    await t.close();
    d.cleanup();
  }
});

// Acceptance round 6 (B-46): a local Ollama bot read its extra folder with the full path, then wrote
// "tb-r6e-team/teamnotitie.md" — which landed in a new look-alike folder inside its own work folder.
test('a relative path that names an extra folder or the team folder gets the full path to use, not a look-alike folder', async () => {
  const d = dirs();
  const t = await startTestApp({ modules: [createFoldersModule()] });
  try {
    const a = await t.agent({ tool_groups: ['files'], access_mode: 'ask', settings: { folders: [{ path: d.werk, mode: 'rw', label: 'Werk' }, { path: d.kennis, mode: 'ro', label: 'Kennis' }] } });
    await t.api('PUT', '/folders/team', { path: d.team, agents: [a.id] });
    const ws = t.app.ctx.store.agent(a.id)!.workspace;
    const w = await toolResult(t, a.id, 'write_file', { path: 'Gedeeld/teamnotitie.md', content: '# Notitie' });
    assert.equal(w.content, `Geweigerd door TeamBot: "Gedeeld" is geen map in je werkmap maar de teammap (${path.resolve(d.team)}). Gebruik het volledige pad: ${path.join(path.resolve(d.team), 'teamnotitie.md')}. Bedoel je echt een nieuwe map "Gedeeld" in je werkmap, schrijf dan "./Gedeeld/teamnotitie.md".`);
    assert.equal(t.app.ctx.store.all('SELECT id FROM approvals').length, 0, 'no card for a write that would land in the wrong place');
    assert.ok(!fs.existsSync(path.join(ws, 'Gedeeld')), 'no look-alike folder in the work folder');
    const ex = await toolResult(t, a.id, 'edit_file', { path: 'werk\\plan.md', old_text: 'a', new_text: 'b' });
    assert.match(ex.content, /"werk" is geen map in je werkmap maar je extra map Werk \(.*\)\. Gebruik het volledige pad: .*Werk[\\/]plan\.md\./, 'by folder name or label, any case and slash');
    const r = await toolResult(t, a.id, 'read_file', { path: 'Kennis/seo.md' });
    assert.match(r.content, /^Bestand niet gevonden: Kennis\/seo\.md\. "Kennis" is geen map in je werkmap maar je extra map Kennis .*Gebruik het volledige pad: .*seo\.md\.$/);
    const ls = await toolResult(t, a.id, 'list_files', { path: 'Gedeeld' });
    assert.match(ls.content, /^Map bestaat niet: Gedeeld\. "Gedeeld" is geen map in je werkmap maar de teammap/);
    // "./" means the work folder, and a folder of that name that is already in the work folder is just used.
    fs.mkdirSync(path.join(ws, 'Kennis'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'Kennis', 'eigen.md'), 'eigen');
    assert.match((await toolResult(t, a.id, 'read_file', { path: 'Kennis/eigen.md' })).content, /eigen/);
    t.script.push({ toolCalls: [{ name: 'write_file', args: { path: './Gedeeld/eigen.md', content: 'x' } }] }, { text: 'ok' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'schrijf' });
    const card = await (async () => {
      for (let i = 0; i < 100; i++) {
        const list = await t.api('GET', '/approvals');
        if (list.length) return list[0];
        await new Promise((res) => setTimeout(res, 30));
      }
    })();
    assert.ok(card, 'a write into the work folder with "./" asks as usual');
    await t.api('POST', `/approvals/${card.id}`, { decision: 'approve' });
    await t.waitIdle(th.id);
    assert.equal(fs.readFileSync(path.join(ws, 'Gedeeld', 'eigen.md'), 'utf8'), 'x');
  } finally {
    await t.close();
    d.cleanup();
  }
});

test('team folder: set for selected bots, used by file tools, listed in the system prompt, browsable', async () => {
  const d = dirs();
  const t = await startTestApp({ modules: [createFoldersModule()] });
  try {
    const a = await t.agent({ name: 'Een', tool_groups: ['files'] });
    const b = await t.agent({ name: 'Twee', tool_groups: ['files'] });
    await assert.rejects(t.api('PUT', '/folders/team', { path: path.join(d.root, 'bestaat-niet') }), /bestaat niet/);
    const set = await t.api('PUT', '/folders/team', { path: d.team, agents: [a.id] });
    assert.equal(set.folder.mode, 'rw');
    const team = await t.api('GET', '/folders/team');
    assert.deepEqual(team.agents.map((x: any) => [x.name, x.member]), [['Een', true], ['Twee', false]]);

    assert.ok(agentRootList(t.app.ctx.store.agent(a.id)!).some((r) => r.kind === 'team'));
    assert.ok(!agentRootList(t.app.ctx.store.agent(b.id)!).some((r) => r.kind === 'team'));

    const w = await toolResult(t, a.id, 'write_file', { path: path.join(d.team, 'Dossiers', 'klant.md'), content: '# Klant' });
    assert.match(w.content, /Aangemaakt/);
    const sys = t.requests[t.requests.length - 1].system;
    assert.match(sys, /## Mappen/);
    assert.ok(sys.includes(path.resolve(d.team)));
    assert.match(sys, /gedeeld met je teamgenoten/);
    const denied = await toolResult(t, b.id, 'read_file', { path: path.join(d.team, 'LEESMIJ.md') });
    assert.match(denied.content, /buiten/);

    const ls = await t.api('GET', '/folders/browse');
    assert.deepEqual(ls.entries.map((e: any) => [e.name, e.dir]), [['Dossiers', true], ['LEESMIJ.md', false]]);
    const sub = await t.api('GET', '/folders/browse?path=Dossiers');
    assert.equal(sub.path, 'Dossiers');
    assert.equal(sub.entries[0].name, 'klant.md');
    const file = await t.api('GET', '/folders/file?path=Dossiers/klant.md');
    assert.equal(file.text, '# Klant');
    await assert.rejects(t.api('GET', '/folders/browse?path=../Kennis'), /buiten/);

    // Read-only team folder: writes refused for every bot.
    await t.api('PUT', '/folders/team', { path: d.team, mode: 'ro' });
    const ro = await toolResult(t, b.id, 'write_file', { path: path.join(d.team, 'x.md'), content: 'x' });
    assert.match(ro.content, /alleen-lezen/);
    await t.api('DELETE', '/folders/team');
    assert.equal((await t.api('GET', '/folders/team')).folder, null);
  } finally {
    await t.close();
    d.cleanup();
  }
});

test('folders that may not be shared', async () => {
  const t = await startTestApp({ modules: [createFoldersModule()] });
  try {
    const ctx = t.app.ctx;
    assert.match(folderProblem(ctx, 'relatief/pad')!, /volledig pad/);
    assert.match(folderProblem(ctx, path.parse(process.cwd()).root)!, /schijf/);
    assert.match(folderProblem(ctx, os.homedir())!, /gebruikersmap/);
    assert.match(folderProblem(ctx, ctx.config.dataDir)!, /gegevensmap/);
    assert.match(folderProblem(ctx, path.join(os.homedir(), '.ssh'))!, /beschermd/);
    assert.equal(folderProblem(ctx, path.join(os.tmpdir(), 'iets')), null);
    const chk = await t.api('POST', '/folders/check', { path: ctx.config.dataDir });
    assert.equal(chk.ok, false);
  } finally {
    await t.close();
  }
});

test('CLI engines: every folder is an --add-dir (Claude --restricted refuses anything else); read-only ones gate writes (reads yes, writes no)', async () => {
  const d = dirs();
  const t = await startTestApp({ modules: [createFoldersModule()] });
  try {
    const a = await t.agent({ access_mode: 'auto', settings: { folders: [{ path: d.kennis, mode: 'ro' }, { path: d.werk, mode: 'rw' }] } });
    const f = { partial: true, appendFile: true, restricted: true, permissionPrompts: false, tools: true, effort: true, modes: ['acceptEdits', 'default', 'plan'] };
    const base = { maxTurns: 10, allowedTools: [], disallowedTools: [], extraArgs: [], loadUserSettings: false, useUserMcp: false };
    // With --restricted Claude Code never asks about files outside its working directories, so a read-only folder
    // must be an --add-dir too; then edits must not be auto-accepted (acceptEdits) but reach the gate.
    const auto = buildClaudeArgs(f, { ...base, mode: 'auto', addDirs: extraRootsOf(a), gateEdits: true });
    assert.ok(auto.includes('--restricted'));
    assert.ok(auto.includes(path.resolve(d.werk)));
    assert.ok(auto.includes(path.resolve(d.kennis)));
    assert.equal(auto[auto.indexOf('--permission-mode') + 1], 'default');
    const plain = buildClaudeArgs(f, { ...base, mode: 'auto', addDirs: extraRootsOf(a, { writableOnly: true }) });
    assert.equal(plain[plain.indexOf('--permission-mode') + 1], 'acceptEdits', 'without read-only folders auto keeps acceptEdits');
    const scope = { ctx: t.app.ctx, agent: a, thread: null, run: null, userId: a.user_id, signal: new AbortController().signal, ns: 'claude-code' };
    const r = await gate(scope, { tool: 'Read', risk: 'read', summary: 'Read', input: {}, paths: [path.join(d.kennis, 'seo.md')] });
    assert.equal(r.allow, true);
    const w = await gate(scope, { tool: 'Write', risk: 'write', summary: 'Write', input: {}, paths: [path.join(d.kennis, 'nieuw.md')] });
    assert.equal(w.allow, false);
    assert.match(w.message, /alleen-lezen/);
    const ok = await gate(scope, { tool: 'Write', risk: 'write', summary: 'Write', input: {}, paths: [path.join(d.werk, 'nieuw.md')] });
    assert.equal(ok.allow, true);
  } finally {
    await t.close();
    d.cleanup();
  }
});

test('server members cannot set folders or a team folder', async () => {
  const d = dirs();
  const t = await startTestApp({ modules: [createFoldersModule()], mode: 'server' });
  try {
    const u = t.app.ctx.auth.createUser({ name: 'Lid', email: 'lid2@test.local', password: 'geheim1234', role: 'member' });
    const tok = t.app.ctx.auth.createSession(u.id, 'web', 'x').token;
    const as = async (m: string, p: string, body?: any) => {
      const r = await fetch(`${t.app.url}/api${p}`, { method: m, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
    };
    assert.equal((await as('PUT', '/folders/team', { path: d.team })).status, 403);
    const bot = await as('POST', '/agents', { name: 'X', settings: { folders: [{ path: d.kennis, mode: 'rw' }] } });
    assert.equal(bot.body.settings.folders, undefined, 'folders stripped for members');
  } finally {
    await t.close();
    d.cleanup();
  }
});

test('file preview: pdf/picture/player kinds, the file itself on a signed link with safe headers, same path checks', async () => {
  const t = await startTestApp({ modules: [createFoldersModule()] });
  try {
    const a = await t.agent({ name: 'Lezer' });
    const ws = a.workspace as string;
    // An ASCII pdf (what bots often make): a pdf, never "text".
    fs.writeFileSync(path.join(ws, 'offerte.pdf'), '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');
    fs.writeFileSync(path.join(ws, 'rapport.docx'), 'PK just ascii but an office file');
    fs.writeFileSync(path.join(ws, 'pagina.html'), '<script>alert(1)</script><h1>Hoi</h1>');
    fs.writeFileSync(path.join(ws, 'notes.md'), '# Kop\n');
    fs.writeFileSync(path.join(ws, 'foto.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]));
    fs.writeFileSync(path.join(ws, 'clip.mp4'), Buffer.alloc(4096, 1));
    fs.writeFileSync(path.join(ws, '.env'), 'GEHEIM=1\n');
    const file = (p: string) => t.api('GET', `/folders/file?agentId=${a.id}&path=${encodeURIComponent(p)}`);
    assert.equal((await file('offerte.pdf')).kind, 'pdf');
    assert.equal((await file('offerte.pdf')).text, '', 'pdf bytes are never sent as text');
    assert.equal((await file('rapport.docx')).kind, 'binary');
    assert.equal((await file('notes.md')).kind, 'markdown');
    assert.equal((await file('pagina.html')).kind, 'text');
    assert.equal((await file('clip.mp4')).kind, 'video');

    const raw = (p: string, extra = '') => fetch(t.app.url + t.signed(`/api/folders/raw?agentId=${a.id}&root=0&path=${encodeURIComponent(p)}${extra}`));
    // No session token in the URL: ?token= is refused, the signed link works.
    assert.equal((await fetch(`${t.app.url}/api/folders/raw?agentId=${a.id}&path=foto.png&token=${t.token}`)).status, 401);
    const png = await raw('foto.png');
    assert.equal(png.status, 200);
    assert.equal(png.headers.get('content-type'), 'image/png');
    assert.match(png.headers.get('content-disposition') || '', /^inline/);
    assert.equal(png.headers.get('x-content-type-options'), 'nosniff');
    assert.match(png.headers.get('content-security-policy') || '', /^sandbox/);
    // HTML (and any text) is shown as plain text: nothing from a folder runs on TeamBot's origin.
    const html = await raw('pagina.html');
    assert.match(html.headers.get('content-type') || '', /^text\/plain/);
    assert.match(await html.text(), /<script>/);
    // A pdf is a download (the app shows it with its own viewer); ?download=1 makes anything a download.
    const pdf = await raw('offerte.pdf');
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.match(pdf.headers.get('content-disposition') || '', /^attachment/);
    assert.match((await raw('foto.png', '&download=1')).headers.get('content-disposition') || '', /^attachment; filename\*=UTF-8''foto\.png/);
    // Video can be scrubbed (range requests).
    const part = await fetch(t.app.url + t.signed(`/api/folders/raw?agentId=${a.id}&root=0&path=clip.mp4`), { headers: { range: 'bytes=100-199' } });
    assert.equal(part.status, 206);
    assert.equal((await part.arrayBuffer()).byteLength, 100);
    // Same path checks as browsing: no escape, no key files.
    assert.equal((await raw('../../url-signing.key')).status, 400);
    assert.equal((await raw('.env')).status, 400);
    assert.equal((await raw('bestaat-niet.txt')).status, 404);
  } finally {
    await t.close();
  }
});
