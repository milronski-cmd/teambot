import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { checkName, cutPartial, scrubWith, valueVariants } from '../server/modules/script-keys/service.js';
import { promptNote, scriptKeysOf } from '../server/modules/script-keys/index.js';

const VALUE = 'shpat_' + 'a1B2c3D4e5F6g7H8i9J0';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

test('names: normalised, checked and never a name the computer uses itself', () => {
  assert.equal(checkName('shopify token'), 'SHOPIFY_TOKEN');
  assert.equal(checkName('imap-pass'), 'IMAP_PASS');
  for (const bad of ['', '1ABC', 'PATH', 'node_options', 'TEAMBOT_X', 'LD_PRELOAD', 'A', 'ÄBC']) assert.throws(() => checkName(bad), /naam|gebruikt/i, bad);
});

test('scrubbing: plain, encoded and half-printed values never show', () => {
  const items = [{ name: 'SHOPIFY_TOKEN', variants: valueVariants(VALUE) }];
  const b64 = Buffer.from(VALUE).toString('base64');
  const out = scrubWith(`token=${VALUE} url=${encodeURIComponent(VALUE)} b64=${b64}`, items);
  assert.ok(!out.includes(VALUE) && !out.includes(b64));
  assert.equal((out.match(/\[verborgen: \$SHOPIFY_TOKEN\]/g) || []).length, 3);
  // live output: the start of a value that is still coming in is held back
  assert.equal(cutPartial('bezig: ' + VALUE.slice(0, 9), items), 'bezig: ');
  assert.equal(cutPartial('klaar', items), 'klaar');
});

test('a key reaches the bot (and its team) as an env var, never the model, transcript or export; computer-only on a phone', async () => {
  const t = await startTestApp();
  try {
    const bot = await t.agent({ name: 'Winkelbot', tool_groups: ['shell'] });
    const other = await t.agent({ name: 'Andere bot', tool_groups: ['shell'] });
    // validation in plain Dutch, value never echoed
    await assert.rejects(t.api('POST', '/script-keys', { name: 'PATH', value: VALUE, agent_id: bot.id }), /gebruikt je computer/);
    await assert.rejects(t.api('POST', '/script-keys', { name: 'X_KEY', value: 'kort', agent_id: bot.id }), /minstens 8/);
    const k = await t.api('POST', '/script-keys', { name: 'shopify token', value: VALUE, label: 'Webwinkel', agent_id: bot.id });
    assert.equal(k.name, 'SHOPIFY_TOKEN');
    assert.equal(k.has_value, true);
    assert.ok(!JSON.stringify(k).includes(VALUE));
    assert.ok(!JSON.stringify(await t.api('GET', '/script-keys')).includes(VALUE));
    // a second key with the same name for the same bot is refused
    await assert.rejects(t.api('POST', '/script-keys', { name: 'SHOPIFY_TOKEN', value: VALUE + 'x', agent_id: bot.id }), /heeft al een sleutel/);

    const svc = scriptKeysOf(t.app.ctx)!;
    const a = t.app.ctx.store.agent(bot.id)!;
    assert.deepEqual(svc.envFor(a), { SHOPIFY_TOKEN: VALUE });
    assert.deepEqual(svc.envFor(t.app.ctx.store.agent(other.id)!), {});
    // the system prompt names it, without the value
    const note = promptNote(t.app.ctx, svc, a)!;
    assert.match(note, /SHOPIFY_TOKEN — Webwinkel/);
    assert.ok(!note.includes(VALUE));
    assert.equal(promptNote(t.app.ctx, svc, t.app.ctx.store.agent(other.id)!), null);
    // a shared bot in a member's conversation never gets it
    assert.deepEqual(svc.envFor({ ...a, settings: { ...a.settings, sharedRun: { ownerId: 'u_x' } } }), {});

    // the bot runs a command that prints the key: the script had it, the model and the transcript only see the name
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    const cmd = process.platform === 'win32' ? 'Write-Output "waarde=$env:SHOPIFY_TOKEN"' : 'echo "waarde=$SHOPIFY_TOKEN"';
    t.script.push({ toolCalls: [{ name: 'run_command', args: { command: cmd } }] }, { text: 'klaar' });
    const msgs = await t.say(th.id, 'toon de sleutel', 60_000);
    const tool = msgs.find((m: any) => m.role === 'tool');
    assert.ok(tool, 'tool result stored');
    assert.match(tool.content, /waarde=\[verborgen: \$SHOPIFY_TOKEN\]/, tool.content);
    const seenByModel = JSON.stringify(t.requests.map((r) => [r.system, r.messages]));
    assert.match(seenByModel, /SHOPIFY_TOKEN/);
    assert.ok(!seenByModel.includes(VALUE), 'the value reached the model');
    assert.ok(!JSON.stringify(t.app.ctx.store.messages(th.id)).includes(VALUE), 'the value is in the transcript');
    assert.ok(!JSON.stringify(t.app.ctx.store.all('SELECT data FROM audit')).includes(VALUE), 'the value is in the audit log');
    const used = t.app.ctx.store.all<any>("SELECT data FROM audit WHERE kind = 'script-keys.used'");
    assert.ok(used.length >= 1 && /SHOPIFY_TOKEN/.test(used[0].data));
    // full export: names, never the value
    const res = await fetch(t.app.url + '/api/export', { headers: { authorization: `Bearer ${t.token}` } });
    const exp = await res.text();
    assert.ok(!exp.includes(VALUE));
    assert.match(exp, /SHOPIFY_TOKEN/);

    // per team: every bot whose home team it is; "alleen dit team" in Instellingen › Teams is respected
    const teamId = t.app.ctx.services.teams.teamOf(other.id);
    await t.api('POST', `/script-keys/${k.id}/grants`, { target: 'team', id: teamId });
    assert.deepEqual(svc.envFor(t.app.ctx.store.agent(other.id)!), { SHOPIFY_TOKEN: VALUE });
    const keys = await t.api('GET', '/teams/keys');
    assert.ok(keys.some((x: any) => x.kind === 'script' && x.id === k.id));
    const team2 = await t.api('POST', '/teams', { name: 'Tweede team' });
    await t.api('PUT', `/teams/keys/script/${k.id}`, { teamId: team2.id });
    assert.deepEqual(svc.envFor(t.app.ctx.store.agent(bot.id)!), {}, 'a key for another team stays away');
    const view = await t.api('GET', `/script-keys/agents/${bot.id}`);
    assert.match(view.keys[0].blocked, /Alleen voor team “Tweede team”/);
    await t.api('PUT', `/teams/keys/script/${k.id}`, { teamId: null });

    // a paired phone cannot list, add or give keys
    const ticket = await t.api('POST', '/mobile/pair', { baseUrl: 'http://192.168.1.5:4761' });
    const secret = new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('t');
    const claim = await fetch(t.app.url + '/api/public/mobile/claim', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': IPHONE_UA }, body: JSON.stringify({ secret, name: 'Telefoon' }) });
    const phone = (await claim.json()).token as string;
    for (const [m, p, b] of [
      ['GET', '/script-keys'],
      ['POST', '/script-keys', { name: 'X_TOKEN', value: VALUE, agent_id: bot.id }],
      ['GET', `/script-keys/agents/${bot.id}`],
      ['POST', `/script-keys/${k.id}/grants`, { target: 'agent', id: other.id }],
      ['DELETE', `/script-keys/${k.id}`],
    ] as [string, string, any?][]) {
      const r = await fetch(t.app.url + '/api' + p, { method: m, headers: { authorization: `Bearer ${phone}`, ...(b ? { 'content-type': 'application/json' } : {}) }, body: b ? JSON.stringify(b) : undefined });
      const j: any = await r.json().catch(() => ({}));
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.equal(j.code, 'mobile_denied');
      assert.match(j.error, /computer/);
    }

    // take it away, then delete: the secret row goes too
    await t.api('DELETE', `/script-keys/${k.id}/grants/agent/${bot.id}`);
    // both bots are in the same team: the team grant still gives it, until that goes too
    assert.deepEqual(svc.envFor(t.app.ctx.store.agent(bot.id)!), { SHOPIFY_TOKEN: VALUE });
    await t.api('DELETE', `/script-keys/${k.id}/grants/team/${teamId}`);
    assert.deepEqual(svc.envFor(t.app.ctx.store.agent(bot.id)!), {});
    await t.api('DELETE', `/script-keys/${k.id}`);
    assert.equal(t.app.ctx.store.all("SELECT id FROM secrets WHERE name LIKE 'scriptkey:%'").length, 0);
    assert.equal((await t.api('GET', '/script-keys')).length, 0);
  } finally {
    await t.close();
  }
});
