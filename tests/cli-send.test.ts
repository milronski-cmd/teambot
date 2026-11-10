import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestApp } from './helpers.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'teambot.mjs');
// an empty data folder: the CLI must never pick up the real app's sign-in or address on this computer
const EMPTY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-cli-empty-'));
after(() => fs.rmSync(EMPTY_DATA, { recursive: true, force: true }));

function cli(args: string[], o: { env?: Record<string, string>; input?: string } = {}): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^TEAMBOT_/.test(k)) env[k] = v;
  Object.assign(env, { TEAMBOT_DATA: EMPTY_DATA }, o.env || {});
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: 'pipe', windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - start }));
    child.stdin.end(o.input ?? '');
  });
}

test('teambot send: token, stdin, --json, local app sign-in, --no-wait, wrong token, other bot, non-local address, timeout', async () => {
  const t = await startTestApp();
  try {
    const research = await t.agent({ name: 'Onderzoeker' });
    const writer = await t.agent({ name: 'Schrijver' });
    const tok = (await t.api('POST', '/mcp/server-tokens', { name: 'Script', agentIds: [research.id] })).token as string;
    const server = ['--server', t.app.url];

    // --- success: message as argument, answer on stdout, exit 0
    t.script.push({ text: 'Hier is je samenvatting.' });
    const ok = await cli(['send', ...server, '--token', tok, '--bot', 'onderzoeker', 'Vat het nieuws samen'], {});
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(ok.stdout, 'Hier is je samenvatting.\n');
    const thread = t.app.ctx.store.one<any>("SELECT * FROM threads WHERE json_extract(meta, '$.cliTokenId') IS NOT NULL");
    assert.equal(thread.title, 'Via de terminal (Script)');
    const msgs = t.app.ctx.store.messages(thread.id);
    assert.equal(msgs[0].author_type, 'external');
    assert.equal(msgs[0].author_name, 'Terminal: Script');
    assert.equal(msgs[0].content, 'Vat het nieuws samen');

    // --- stdin as the message, --json, bot omitted (the token reaches one bot), same conversation continues
    t.script.push({ text: 'Antwoord op stdin.' });
    const js = await cli(['send', ...server, '--json'], { input: 'Vraag via stdin\n', env: { TEAMBOT_TOKEN: tok } });
    assert.equal(js.code, 0, js.stderr);
    const out = JSON.parse(js.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.status, 'done');
    assert.equal(out.reply, 'Antwoord op stdin.');
    assert.equal(out.bot.name, 'Onderzoeker');
    assert.equal(out.thread_id, thread.id);
    assert.equal(t.requests.at(-1)!.messages.filter((m) => m.role === 'user').length, 2);

    // --- on this computer without a token: the desktop app's own sign-in and address from the data folder
    t.script.push({ text: 'Lokaal antwoord.' });
    const local = await cli(['send', '--bot', 'Schrijver', '--nieuw', 'Hallo vanaf de terminal'], { env: { TEAMBOT_DATA: t.dir } });
    assert.equal(local.code, 0, local.stderr);
    assert.equal(local.stdout, 'Lokaal antwoord.\n');
    assert.ok(fs.readFileSync(path.join(t.dir, 'local-url'), 'utf8').startsWith(t.app.url));

    // --- --no-wait: sent, not waited for
    t.script.push({ text: 'Later antwoord.' });
    const nw = await cli(['send', ...server, '--token', tok, '--no-wait', 'Doe dit later']);
    assert.equal(nw.code, 0, nw.stderr);
    assert.match(nw.stdout, /^Verstuurd naar Onderzoeker\. Het antwoord verschijnt in TeamBot in het gesprek "Via de terminal \(Script\)"\./);
    await t.waitIdle(thread.id);

    // --- wrong, revoked or missing token: exit 3 with a clear message
    const wrong = await cli(['send', ...server, '--token', 'tbmcp_verkeerd', '--bot', 'Onderzoeker', 'hoi']);
    assert.equal(wrong.code, 3);
    assert.match(wrong.stderr, /ongeldig of ingetrokken/);
    const session = await cli(['send', ...server, '--token', 'geen-echte-sessie', 'hoi']);
    assert.equal(session.code, 3);
    const none = await cli(['send', ...server, 'hoi']);
    assert.equal(none.code, 3);
    assert.match(none.stderr, /Geen token/);
    // a bot outside the token: refused, with the bots you can use
    const other = await cli(['send', ...server, '--token', tok, '--bot', 'Schrijver', 'hoi']);
    assert.equal(other.code, 3);
    assert.match(other.stderr, /niet bereikbaar met deze token\. Je kunt kiezen uit: Onderzoeker\./);
    // revoking the token stops it at once
    const tok2 = await t.api('POST', '/mcp/server-tokens', { name: 'Weg', agentIds: [research.id] });
    await t.api('DELETE', `/mcp/server-tokens/${tok2.id}`);
    assert.equal((await cli(['send', ...server, '--token', tok2.token, 'hoi'])).code, 3);

    // --- local only: another computer is refused before anything is sent; http never, even when allowed
    const remote = await cli(['send', '--server', 'https://teambot.example.com', '--token', tok, 'hoi']);
    assert.equal(remote.code, 2);
    assert.match(remote.stderr, /niet deze computer.*--sta-extern-toe/s);
    const plain = await cli(['send', '--server', 'http://192.168.1.20:4747', '--sta-extern-toe', '--token', tok, 'hoi']);
    assert.equal(plain.code, 2);
    assert.match(plain.stderr, /alleen via https/);
    const envRemote = await cli(['send', '--token', tok, 'hoi'], { env: { TEAMBOT_URL: 'http://10.0.0.5:4747', TEAMBOT_ALLOW_REMOTE: '1' } });
    assert.equal(envRemote.code, 2);
    // the local sign-in is never sent to another computer
    const leak = await cli(['send', '--server', 'https://teambot.example.com', '--sta-extern-toe', 'hoi'], { env: { TEAMBOT_DATA: t.dir } });
    assert.equal(leak.code, 3);
    assert.match(leak.stderr, /Geen token/);

    // --- TeamBot not running
    const off = await cli(['send', '--server', 'http://127.0.0.1:9', '--token', tok, 'hoi']);
    assert.equal(off.code, 5);
    assert.match(off.stderr, /niet bereikbaar/);

    // --- usage: help, unknown option, no message
    const help = await cli(['send', '--help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Afsluitcodes/);
    assert.equal((await cli(['send', '--onbekend', 'x'])).code, 2);
    const empty = await cli(['send', ...server, '--token', tok]);
    assert.equal(empty.code, 2);
    assert.match(empty.stderr, /Geen bericht/);
    assert.equal((await cli(['send', '--timeout', 'nooit', 'x'])).code, 2);

    // --- timeout: the bot waits for the owner (ask_user); the CLI gives up after --timeout with exit 4
    t.script.push({ toolCalls: [{ name: 'ask_user', args: { question: 'Welke kleur wil je?' } }] });
    const slow = await cli(['send', ...server, '--token', tok, '--timeout', '2', 'Maak een logo']);
    assert.equal(slow.code, 4, slow.stderr);
    assert.match(slow.stderr, /wacht op jouw goedkeuring of antwoord in TeamBot/);
    assert.match(slow.stderr, /Geen antwoord binnen 2 seconden\. Onderzoeker is nog bezig; het antwoord verschijnt in TeamBot in het gesprek "Via de terminal \(Script\)"\./);
    assert.ok(slow.ms < 15_000, `took ${slow.ms} ms`);
    const slowJson = await cli(['send', ...server, '--token', tok, '--timeout', '1', '--json', 'Nog een vraag']);
    assert.equal(slowJson.code, 4);
    assert.equal(JSON.parse(slowJson.stdout).status, 'timeout');
    t.app.ctx.runs.stopAll(t.app.ctx.auth.owner()!.id);

    // --- audit: who sent, never the message
    const audit = t.app.ctx.store.all<any>("SELECT * FROM audit WHERE kind = 'cli.send'");
    assert.ok(audit.length >= 5);
    assert.ok(!JSON.stringify(audit).includes('Vat het nieuws samen'));
  } finally {
    await t.close();
  }
});

test('teambot send: the address file is removed when TeamBot stops', async () => {
  const t = await startTestApp();
  const file = path.join(t.dir, 'local-url');
  assert.ok(fs.existsSync(file));
  await t.app.close();
  assert.ok(!fs.existsSync(file));
  fs.rmSync(t.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
