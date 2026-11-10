import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestApp, type TestApp } from './helpers.js';
import { ImportError, looksSecret, localSources, maskArgs, maskUrl, parseJsonc, parsePasted, previewOf, scanLocal, shellWords } from '../server/modules/mcp/import.js';
import { parseToml } from '../server/modules/mcp/toml.js';
import { createBody } from '../server/modules/mcp/import-routes.js';

const FIX = path.resolve('tests/fixtures/mcp-import');
async function asUser(t: TestApp, token: string, method: string, p: string, body?: any) {
  const res = await fetch(t.app.url + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
const MCP_FIXTURE = path.resolve('tests/mcp-fixture-server.ts');
/** Secret values in the fixtures: they may never show up in a preview, an API response or the audit log. */
const SECRETS = ['ghp_FIXTURE0000000000000000000000000001', 'sntrys_FIXTURE00000000000000000002', 'Geheim-FIXTURE-0003', 'BSAFIXTURE00000000000000000004', 'ctx7sk-FIXTURE0000000000000000005'];
const one = (text: string) => {
  const r = parsePasted(text);
  assert.equal(r.length, 1, text);
  return r[0];
};

test('pasted commands: claude / codex / gemini mcp add, add-json and code --add-mcp are recognised', () => {
  let s = one('claude mcp add --transport http notion https://mcp.notion.com/mcp');
  assert.deepEqual([s.name, s.transport, s.url, s.auth, s.source], ['notion', 'http', 'https://mcp.notion.com/mcp', 'none', 'claude mcp add']);

  s = one('claude mcp add --transport sse asana https://mcp.asana.com/sse');
  assert.equal(s.transport, 'sse');

  s = one('claude mcp add --transport stdio airtable --env AIRTABLE_API_KEY=patFIXTURE00000000000000abcdef -- npx -y airtable-mcp-server');
  assert.deepEqual([s.name, s.transport, s.command, s.args], ['airtable', 'stdio', 'npx', ['-y', 'airtable-mcp-server']]);
  assert.deepEqual(s.env, [{ name: 'AIRTABLE_API_KEY', value: 'patFIXTURE00000000000000abcdef', secret: true }]);

  // several -e, options after the name, no "--"
  s = one('claude mcp add my-server -e API_KEY=123 -e MODE=prod npx -y @acme/server --port 3000');
  assert.deepEqual([s.command, s.args], ['npx', ['-y', '@acme/server', '--port', '3000']]);
  assert.deepEqual(
    s.env.map((e) => [e.name, e.value, e.secret]),
    [
      ['API_KEY', '123', true],
      ['MODE', 'prod', false],
    ],
  );

  // header with a bearer token → secret; documentation example values become a blank to fill in
  s = one('claude mcp add --transport http secure https://api.example.com/mcp --header "Authorization: Bearer sk-FIXTURE1234567890abcdef"');
  assert.equal(s.auth, 'headers');
  assert.deepEqual(s.headers, [{ name: 'Authorization', value: 'Bearer sk-FIXTURE1234567890abcdef', secret: true }]);
  s = one('claude mcp add --transport stdio airtable --env AIRTABLE_API_KEY=YOUR_KEY -- npx -y airtable-mcp-server');
  assert.equal(s.env[0].value, '');
  assert.equal(s.env[0].required, true);
  assert.match(s.env[0].help!, /voorbeeld/);

  // continuation lines (bash \, PowerShell `) and a prompt in front
  s = one('$ claude mcp add --transport stdio fs \\\n  -- npx -y @modelcontextprotocol/server-filesystem C:\\Users\\me\\Documents');
  assert.deepEqual(s.args, ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\me\\Documents'], 'Windows paths keep their backslashes');
  s = one('claude mcp add time `\n  -- uvx mcp-server-time');
  assert.deepEqual([s.command, s.args], ['uvx', ['mcp-server-time']]);

  // add-json, also with the JSON over several lines and a scope option first
  s = one(`claude mcp add-json -s user weather '{\n  "type": "http",\n  "url": "https://api.weather.example/mcp",\n  "headers": { "Authorization": "Bearer \${WEATHER_TOKEN}" }\n}'`);
  assert.deepEqual([s.name, s.transport, s.url, s.auth], ['weather', 'http', 'https://api.weather.example/mcp', 'headers']);
  assert.deepEqual(s.headers[0], { name: 'Authorization', value: '', secret: true, required: true, prefix: 'Bearer ', help: s.headers[0].help });
  assert.match(s.headers[0].help!, /WEATHER_TOKEN/);

  // Codex
  s = one('codex mcp add context7 --env CONTEXT7_API_KEY=ctx7sk-FIXTURE0000000000000000009 -- npx -y @upstash/context7-mcp');
  assert.deepEqual([s.name, s.command, s.args, s.env[0].secret, s.source], ['context7', 'npx', ['-y', '@upstash/context7-mcp'], true, 'codex mcp add']);
  s = one('codex mcp add docs --url https://docs.example.com/mcp --bearer-token-env-var DOCS_TOKEN');
  assert.deepEqual([s.transport, s.url, s.auth, s.headers[0].name, s.headers[0].prefix, s.headers[0].required], ['http', 'https://docs.example.com/mcp', 'headers', 'Authorization', 'Bearer ', true]);

  // Gemini CLI and VS Code
  s = one('gemini mcp add -t http deepwiki https://mcp.deepwiki.com/mcp');
  assert.deepEqual([s.name, s.transport], ['deepwiki', 'http']);
  s = one(`code --add-mcp '{"name":"fetch","command":"uvx","args":["mcp-server-fetch"]}'`);
  assert.deepEqual([s.name, s.command, s.args], ['fetch', 'uvx', ['mcp-server-fetch']]);

  // several commands at once
  const many = parsePasted('claude mcp add a -- npx -y a-server\nclaude mcp add --transport http b https://b.example/mcp\n');
  assert.deepEqual(
    many.map((x) => x.name),
    ['a', 'b'],
  );
  assert.notEqual(many[0].id, many[1].id);
});

test('pasted JSON and TOML: mcpServers, VS Code servers with inputs, fragments, one server, Codex tables', () => {
  let r = parsePasted(fs.readFileSync(path.join(FIX, 'claude_desktop_config.json'), 'utf8'));
  assert.deepEqual(
    r.map((s) => s.name),
    ['filesystem', 'brave-search'],
  );
  assert.equal(r[1].env[0].secret, true);

  r = parsePasted(fs.readFileSync(path.join(FIX, 'vscode-mcp.json'), 'utf8'));
  assert.deepEqual(
    r.map((s) => [s.name, s.transport]),
    [
      ['github-remote', 'http'],
      ['fetch', 'stdio'],
    ],
  );
  assert.deepEqual([r[0].headers[0].required, r[0].headers[0].secret, r[0].headers[0].prefix], [true, true, 'Bearer ']);
  assert.match(r[0].headers[0].help!, /GitHub Personal Access Token/);

  // a fragment copied from inside "mcpServers"
  let s = one('"sqlite": { "command": "uvx", "args": ["mcp-server-sqlite", "--db-path", "test.db"] },');
  assert.deepEqual([s.name, s.command], ['sqlite', 'uvx']);
  // one server object; the name is guessed
  s = one('{ "url": "https://mcp.linear.app/sse" }');
  assert.deepEqual([s.name, s.transport], ['linear', 'sse']);
  // "command" as one string
  s = one('{ "mcpServers": { "x": { "command": "npx -y @scope/pkg --flag" } } }');
  assert.deepEqual([s.command, s.args], ['npx', ['-y', '@scope/pkg', '--flag']]);
  // markdown code fence around it
  s = one('```json\n{ "mcpServers": { "y": { "command": "uvx", "args": ["y"] } } }\n```');
  assert.equal(s.name, 'y');

  r = parsePasted(fs.readFileSync(path.join(FIX, 'codex-config.toml'), 'utf8'));
  assert.deepEqual(
    r.map((x) => [x.name, x.transport, x.enabled]),
    [
      ['context7', 'stdio', true],
      ['docs', 'http', true],
      ['old shell', 'stdio', false],
    ],
  );
  assert.deepEqual(r[0].args, ['-y', '@upstash/context7-mcp']);
  assert.deepEqual(
    r[0].env.map((e) => [e.name, e.secret]),
    [
      ['CONTEXT7_API_KEY', true],
      ['LOG', false],
    ],
  );
  assert.equal(r[0].env[1].value, 'C:\\Users\\eigenaar\\logs', 'TOML literal strings keep backslashes');
  assert.deepEqual(
    r[1].headers.map((h) => [h.name, h.value, h.required ?? false]),
    [
      ['X-Team', 'winkel', false],
      ['Authorization', '', true],
    ],
  );
  assert.equal(r[2].command, 'C:\\tools\\shell-mcp.exe');
});

test('unrecognised input gets a clear Dutch explanation', () => {
  const err = (t: string) => {
    try {
      parsePasted(t);
    } catch (e: any) {
      assert.ok(e instanceof ImportError, t);
      return e.message as string;
    }
    assert.fail(`no error for ${t}`);
  };
  assert.match(err(''), /Plak eerst/);
  assert.match(err('hallo wereld'), /Niet herkend/);
  assert.match(err('claude mcp list'), /voegt geen server toe/);
  assert.match(err('claude mcp add naam "npx -y x'), /niet gesloten/);
  assert.match(err('{ "mcpServers": { "x": '), /niet geldig/);
  assert.match(err('{ "iets": 1 }'), /Geen MCP-servers/);
  assert.match(err('claude mcp add --onbekend x npx'), /Onbekende optie/);
});

test('helpers: shell words, JSONC, TOML, secret detection and masking', () => {
  assert.deepEqual(shellWords(`a 'b c' "d \\"e\\"" f\\ g C:\\x\\y`), ['a', 'b c', 'd "e"', 'f g', 'C:\\x\\y']);
  assert.deepEqual(parseJsonc('{ // c\n "a": [1, 2,], /* x */ "b": "http://x//y", }'), { a: [1, 2], b: 'http://x//y' });
  assert.deepEqual(parseToml('a.b = 1\n[t]\nx = """\nregel\n"""\ny = { z = [true, 2.5] }\n'), { a: { b: 1 }, t: { x: 'regel\n', y: { z: [true, 2.5] } } });
  assert.throws(() => parseToml('[t]\nx = 1\nx = 2'), /TOML regel 3: .*twee keer/);
  assert.throws(() => parseToml('a = "open\n'), /TOML regel 1: string niet afgesloten/);
  // the full spec (smol-toml): arrays of tables, dates as text
  const codex = parseToml(
    'model = "gpt-5"\n[[profiles]]\nname = "werk"\n[[profiles]]\nname = "thuis"\n[mcp_servers.docs]\nurl = "https://docs.example/mcp"\n[[mcp_servers.docs.tools]]\nname = "zoek"\n[history]\nsince = 2026-11-09T10:00:00Z\nday = 2026-11-09\n',
  );
  assert.deepEqual(codex.profiles, [{ name: 'werk' }, { name: 'thuis' }]);
  assert.equal(codex.mcp_servers.docs.url, 'https://docs.example/mcp');
  assert.deepEqual(codex.mcp_servers.docs.tools, [{ name: 'zoek' }]);
  assert.deepEqual(codex.history, { since: '2026-11-09T10:00:00.000Z', day: '2026-11-09' });
  assert.deepEqual(
    parsePasted('[[profiles]]\nname = "x"\n[mcp_servers.ctx]\ncommand = "npx"\nargs = ["-y", "@upstash/context7-mcp"]\n').map((s) => [s.name, s.transport]),
    [['ctx', 'stdio']],
    'a Codex config with [[…]] before the servers imports them',
  );
  assert.ok(looksSecret('ghp_FIXTURE0000000000000000000000000001'));
  assert.ok(looksSecret('a8Fk2LmQ9xZ0pR7tY4wE1uI6oP3sD5gH'));
  assert.ok(!looksSecret('@modelcontextprotocol/server-github'));
  assert.ok(!looksSecret('C:\\Users\\eigenaar\\Documents'));
  assert.ok(!looksSecret('https://mcp.notion.com/mcp'));
  assert.deepEqual(maskArgs(['--api-key', 'abc', '--token=xyz', 'postgresql://u:pw@db/x', 'DB_PASSWORD=pw', 'plain', 'ghp_FIXTURE0000000000000000000000000001']), ['--api-key', '••••', '--token=••••', 'postgresql://u:••••@db/x', 'DB_PASSWORD=••••', 'plain', '••••']);
  assert.equal(maskUrl('https://x.example/mcp?api_key=abc&team=winkel'), 'https://x.example/mcp?api_key=••••&team=winkel');
});

/** A home folder laid out like a real Windows profile, built from the fixtures. */
function fakeHome(extraClaude?: (j: any, home: string) => void) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-import-home-'));
  const put = (rel: string, file: string, tweak?: (s: string) => string) => {
    const to = path.join(home, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const text = fs.readFileSync(path.join(FIX, file), 'utf8');
    fs.writeFileSync(to, tweak ? tweak(text) : text);
  };
  put('.claude.json', 'claude.json', (t) => {
    const j = JSON.parse(t);
    // a project of Claude Code with its own .mcp.json
    const proj = path.join(home, 'werk', 'site');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp@latest'] } } }));
    j.projects[proj] = { mcpServers: {} };
    extraClaude?.(j, home);
    return JSON.stringify(j, null, 2);
  });
  put('AppData/Roaming/Claude/claude_desktop_config.json', 'claude_desktop_config.json');
  put('.codex/config.toml', 'codex-config.toml');
  put('.cursor/mcp.json', 'cursor-mcp.json');
  put('AppData/Roaming/Code/User/mcp.json', 'vscode-mcp.json');
  put('AppData/Roaming/Code/User/settings.json', 'vscode-settings.json');
  fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gemini', 'settings.json'), '{ "mcpServers": { "kapot": '); // broken file
  return home;
}

const digest = (dir: string) => {
  const h = crypto.createHash('sha256');
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else h.update(f + fs.statSync(f).mtimeMs + fs.readFileSync(f).toString('base64'));
    }
  };
  walk(dir);
  return h.digest('hex');
};

test('this computer: every known config is read (read-only), previews hold no secret values', () => {
  const home = fakeHome();
  try {
    const before = digest(home);
    const scans = scanLocal(localSources({ home, env: {}, platform: 'win32' }));
    const by = Object.fromEntries(scans.map((s) => [s.key, s]));
    assert.deepEqual(
      by['claude-code'].servers.map((s) => [s.name, s.source]),
      [
        ['github', 'Claude Code (alle projecten)'],
        ['sentry', 'Claude Code (alle projecten)'],
        ['postgres', 'Claude Code · project winkel'],
        ['playwright', 'Claude Code · project site (.mcp.json)'],
      ],
    );
    assert.deepEqual(
      by['claude-desktop'].servers.map((s) => s.name),
      ['filesystem', 'brave-search'],
    );
    assert.deepEqual(
      by['codex'].servers.map((s) => s.name),
      ['context7', 'docs', 'old shell'],
    );
    assert.deepEqual(
      by['cursor'].servers.map((s) => [s.name, s.transport]),
      [
        ['linear', 'sse'],
        ['notion', 'http'],
      ],
    );
    assert.deepEqual(
      by['vscode'].servers.map((s) => s.name),
      ['github-remote', 'fetch'],
    );
    assert.deepEqual(
      by['vscode-settings'].servers.map((s) => s.name),
      ['time'],
    );
    assert.equal(by['windsurf'].found, false);
    assert.equal(by['gemini'].found, true);
    assert.match(by['gemini'].error!, /Kon het bestand niet lezen/);
    assert.ok(!by['gemini'].error!.includes('kapot'), 'errors never quote the file');
    // the preview the browser gets: names and masked commands only
    const preview = JSON.stringify(scans.map((s) => s.servers.map(previewOf)));
    for (const secret of SECRETS) assert.ok(!preview.includes(secret), `preview leaks ${secret.slice(0, 12)}…`);
    assert.ok(preview.includes('GITHUB_PERSONAL_ACCESS_TOKEN'), 'the names are there');
    assert.equal(digest(home), before, 'the config files are not touched');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('import routes: paste → recognised, this computer → preview → import; secrets to the vault, read test, read-only', async () => {
  // a Claude Code server that really runs (the MCP test fixture) with its token in the config
  const home = fakeHome((j) => {
    j.mcpServers.fixture = { command: process.execPath, args: ['--import', 'tsx', MCP_FIXTURE], cwd: process.cwd(), env: { FIXTURE_TOKEN: 'fixture-secret-value-123' } };
  });
  const prev = process.env.TEAMBOT_IMPORT_HOME;
  process.env.TEAMBOT_IMPORT_HOME = home;
  const t = await startTestApp();
  try {
    const before = digest(home);
    // paste: values come back (the owner pasted them), OAuth detection does not break offline/unknown hosts
    const p = await t.api('POST', '/mcp/import/parse', { text: 'claude mcp add --transport stdio airtable --env AIRTABLE_API_KEY=patFIXTURE00000000000000abcdef -- npx -y airtable-mcp-server' });
    assert.equal(p.servers.length, 1);
    assert.equal(p.servers[0].env[0].value, 'patFIXTURE00000000000000abcdef');
    assert.equal(p.servers[0].existing, null);
    const bad = await fetch(`${t.app.url}/api/mcp/import/parse`, { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'claude mcp list' }) });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as any).error, /voegt geen server toe/);

    // this computer
    const local = await t.api('GET', '/mcp/import/local');
    const cc = local.sources.find((s: any) => s.key === 'claude-code');
    assert.ok(cc.file.startsWith(home));
    const fixture = cc.servers.find((s: any) => s.name === 'fixture');
    assert.deepEqual(fixture.env, [{ name: 'FIXTURE_TOKEN', secret: true, missing: false }]);
    for (const secret of [...SECRETS, 'fixture-secret-value-123']) assert.ok(!JSON.stringify(local).includes(secret), 'no secret values in the preview');

    // local programs need the trust confirmation
    const noTrust = await fetch(`${t.app.url}/api/mcp/import/apply`, { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ from: 'local', ids: [fixture.id] }) });
    assert.equal(noTrust.status, 400);
    assert.match(((await noTrust.json()) as any).error, /vertrouwt/);

    const bot = await t.agent({});
    const github = cc.servers.find((s: any) => s.name === 'github');
    const r = await t.api('POST', '/mcp/import/apply', { from: 'local', ids: [fixture.id, github.id], trust: true, agentIds: [bot.id] });
    assert.deepEqual(
      r.results.map((x: any) => [x.name, x.ok]),
      [
        ['fixture', true],
        ['github', true],
      ],
    );
    const conn = r.results[0].connection;
    assert.equal(conn.transport, 'stdio');
    assert.equal(conn.allow_actions, false, 'imported apps start read-only');
    // the secret went to the vault, not into the connection row
    const row = t.app.ctx.store.get<any>('mcp_connections', conn.id);
    assert.ok(row.env[0].secret_id && !JSON.stringify(row).includes('fixture-secret-value-123'));
    assert.equal(t.app.ctx.secrets.get(row.env[0].secret_id), 'fixture-secret-value-123');
    const gh = t.app.ctx.store.get<any>('mcp_connections', r.results[1].connection.id);
    assert.deepEqual(
      gh.env.map((e: any) => [e.name, !!e.secret_id, e.value ?? null]),
      [
        ['GITHUB_PERSONAL_ACCESS_TOKEN', true, null],
        ['LOG_LEVEL', false, 'info'],
      ],
    );
    // bound to the chosen bot
    assert.ok((await t.api('GET', `/mcp/agents/${bot.id}`)).find((c: any) => c.id === conn.id)?.bound);
    // the usual read test works with the imported secret
    const test1 = await t.api('POST', `/mcp/connections/${conn.id}/test`, {});
    assert.equal(test1.ok, true, test1.error);
    const sample = await t.api('POST', `/mcp/connections/${conn.id}/test`, { tool: 'env_keys', args: {} });
    assert.match(sample.sample.text, /token-ok/);
    // now it is recognised as already connected
    const again = await t.api('GET', '/mcp/import/local');
    assert.ok(again.sources.find((s: any) => s.key === 'claude-code').servers.find((s: any) => s.name === 'fixture').existing);

    // nothing secret in API answers or the audit log; the files are untouched
    const everything = JSON.stringify(await t.api('GET', '/mcp/connections')) + JSON.stringify(r) + JSON.stringify(t.app.ctx.store.all('SELECT * FROM audit'));
    for (const secret of [...SECRETS, 'fixture-secret-value-123']) assert.ok(!everything.includes(secret), `leak: ${secret.slice(0, 12)}…`);
    assert.equal(digest(home), before, 'the config files are not touched');
    await t.api('DELETE', `/mcp/connections/${conn.id}`);
  } finally {
    await t.close();
    if (prev === undefined) delete process.env.TEAMBOT_IMPORT_HOME;
    else process.env.TEAMBOT_IMPORT_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('import: members of a server never see the server’s files; the publisher policy still applies', async () => {
  const home = fakeHome();
  const prev = process.env.TEAMBOT_IMPORT_HOME;
  process.env.TEAMBOT_IMPORT_HOME = home;
  const t = await startTestApp({ mode: 'server' });
  try {
    const owner = await t.api('GET', '/mcp/import/local');
    assert.ok(owner.sources.length > 0, 'the owner may');
    const m = t.app.ctx.auth.createUser({ name: 'Lid', email: 'lid@example.nl', password: 'Lid-wachtwoord-12345!', role: 'member' });
    const tok = t.app.ctx.auth.createSession(m.id).token;
    const r = await asUser(t, tok, 'GET', '/mcp/import/local');
    assert.equal(r.status, 403);
    // pasting is fine for a member (their own config) — creating follows the normal rules
    const p = await asUser(t, tok, 'POST', '/mcp/import/parse', { text: 'claude mcp add --transport http notion https://mcp.notion.com/mcp' });
    assert.equal(p.status, 200);
  } finally {
    await t.close();
    if (prev === undefined) delete process.env.TEAMBOT_IMPORT_HOME;
    else process.env.TEAMBOT_IMPORT_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('createBody: blanks are left out, secrets marked, local URLs allowed explicitly', () => {
  const [s] = parsePasted('claude mcp add-json w \'{"type":"http","url":"http://localhost:8080/mcp","headers":{"Authorization":"Bearer ${T}","X-Team":"a"}}\'');
  const b = createBody(s, { trust: false, agentIds: [] });
  assert.deepEqual(b.headers, [{ name: 'X-Team', value: 'a' }]);
  assert.equal(b.allow_private, true);
  assert.equal(b.catalog_id, 'custom');
  const [p] = parsePasted('claude mcp add x -e TOKEN=abcdefghijklmnop -- npx x');
  assert.deepEqual(createBody(p, { trust: true, agentIds: ['a'] }).env, [{ name: 'TOKEN', secret: true, value: 'abcdefghijklmnop' }]);
  assert.equal(createBody(p, { trust: true, agentIds: [] }).trust_command, true);
});
