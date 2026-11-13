import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp } from './helpers.js';
import { isParseError, parseRule, type ParsedRule } from '../server/modules/botrules/parse.js';
import { applyRules, type StoredRule } from '../server/modules/botrules/match.js';
import { gate } from '../server/modules/cli-agents/permissions.js';
import type { Agent } from '../server/core/types.js';

const ok = (text: string, o?: any): ParsedRule => {
  const r = parseRule(text, o);
  assert.ok(!isParseError(r), `${text} → ${isParseError(r) ? r.error : ''}`);
  return r as ParsedRule;
};

test('plain words become a fixed rule: effect, action, app, folder, website, others', () => {
  const mail = ok('Mail nooit naar klanten zonder mij te vragen');
  assert.equal(mail.effect, 'ask');
  assert.deepEqual(mail.match, { verb: 'send', app: 'mail', others: true });
  assert.equal(mail.review, false);

  const shop = ok('Vraag altijd voordat je iets in Shopify verandert');
  assert.equal(shop.effect, 'ask');
  assert.equal(shop.match.app, 'shopify');
  assert.equal(shop.match.verb, 'change');
  assert.equal(ok('vraag altijd voordat je iets in de webshop verandert').match.app, 'webshop');

  const quotes = ok('Mag altijd bestanden maken in de map Offertes');
  assert.equal(quotes.effect, 'allow');
  assert.equal(quotes.match.folder, 'Offertes');
  assert.equal(quotes.match.verb, 'change');
  assert.equal(ok('Hoeft niet te vragen om te schrijven in de map "Klanten 2026"').match.folder, 'Klanten 2026');
  assert.equal(ok('Hoeft niet te vragen om te schrijven in de map "Klanten 2026"').effect, 'allow');

  const del = ok('Verwijder nooit bestanden');
  assert.equal(del.effect, 'deny');
  assert.equal(del.match.verb, 'delete');
  assert.equal(ok('Lees nooit iets op www.example.com').match.domain, 'example.com');
  assert.equal(ok('Gebruik run_command nooit', { tools: ['run_command'] }).match.tool, 'run_command');
  assert.equal(ok('Vraag eerst voordat je iets in Boekhouding doet', { apps: [{ slug: 'boekhouding', name: 'Boekhouding' }] }).match.app, 'mcp:boekhouding');

  // English works as well
  const en = ok("Don't send emails to customers without asking me");
  assert.equal(en.effect, 'ask');
  assert.deepEqual(en.match, { verb: 'send', app: 'mail', others: true });
  assert.equal(ok('Never delete files in the Archive folder').match.folder, 'Archive');
  assert.equal(ok('May always edit files in the Quotes folder').effect, 'allow');

  // What code cannot pin down goes to Auto Review (asks, never allows)
  const prices = ok('Noem nooit prijzen zonder overleg');
  assert.equal(prices.review, true);
  assert.equal(prices.effect, 'ask');

  // A rule that loosens needs a place, and never frees sending, paying, deleting or anything for others
  for (const [text, code] of [
    ['Mag altijd alles', 'allow_target'],
    ['Mag altijd mailen in Gmail', 'allow_verb'],
    ['Mag altijd betalen met PayPal', 'allow_verb'],
    ['Mag altijd bestanden verwijderen in de map Tijdelijk', 'allow_verb'],
    ['', 'empty'],
    ['Offertes', 'effect'],
  ]) {
    const r = parseRule(text);
    assert.ok(isParseError(r), text);
    assert.equal((r as any).code, code, text);
  }
});

const bot = (over: Partial<Agent> = {}): Agent => ({ id: 'ag_1', user_id: 'u1', name: 'Bot', access_mode: 'ask', tool_policy: {}, settings: {}, tool_groups: [], ...over }) as Agent;
const stored = (text: string): StoredRule => ({ id: 'r', user_id: 'u1', agent_id: 'ag_1', team_id: null, text, created_at: '', ...ok(text) });

test('the rules make any level stricter; "mag altijd" lifts only a question of the level Vragen, never impact', () => {
  const quotes = [stored('Mag altijd bestanden maken in de map Offertes')];
  const ask = bot();
  const w = (p: string) => ({ name: 'write_file', risk: 'write' as const, args: { path: p } });
  assert.equal(applyRules(ask, w('Offertes/klant.md'), 'ask', quotes).decision, 'allow');
  assert.equal(applyRules(ask, w('C:\\werk\\Offertes\\2026\\a.docx'), 'ask', quotes).decision, 'allow');
  assert.equal(applyRules(ask, w('Offertes-oud/a.md'), 'ask', quotes).decision, 'ask', 'whole folder names only');
  assert.equal(applyRules(ask, w('Facturen/a.md'), 'ask', quotes).decision, 'ask');
  assert.equal(applyRules(ask, { name: 'move_file', risk: 'write', args: { from: 'Offertes/a.md', to: 'x' } }, 'ask', quotes).decision, 'allow');
  assert.equal(applyRules(ask, { name: 'delete_file', risk: 'danger', args: { path: 'Offertes/a.md' } }, 'ask', quotes).decision, 'ask', 'impact keeps asking');
  assert.equal(applyRules(bot({ tool_policy: { write_file: 'ask' } }), w('Offertes/a.md'), 'ask', quotes).decision, 'ask', 'a per-tool choice of the owner wins');
  assert.equal(applyRules(bot({ access_mode: 'readonly' }), w('Offertes/a.md'), 'deny', quotes).decision, 'deny', 'never beyond the level');
  assert.equal(applyRules(ask, { name: 'write_file', risk: 'write' }, 'ask', quotes).decision, 'ask', 'no concrete call: no folder rule');

  // stricter, in every level
  const mail = [stored('Mail nooit naar klanten zonder mij te vragen')];
  const full = bot({ access_mode: 'full', settings: { fullAccessExternal: true } });
  const gmail = (to: string) => ({ name: 'mcp_gmail_send_email', risk: 'danger' as const, args: { to }, impact: to === 'me' ? ('local' as const) : ('external' as const) });
  assert.equal(applyRules(full, gmail('klant@voorbeeld.nl'), 'allow', mail).decision, 'ask');
  assert.equal(applyRules(full, gmail('me'), 'allow', mail).decision, 'allow', 'to the owner himself is not "klanten"');
  assert.equal(applyRules(full, { name: 'channel_send', risk: 'write', args: { to: 'klant' }, impact: 'external', channel: 'email' }, 'allow', mail).decision, 'ask', 'a released contact via the e-mail channel');
  assert.equal(applyRules(full, { name: 'channel_send', risk: 'write', args: { to: 'klant' }, impact: 'external', channel: 'telegram' }, 'allow', mail).decision, 'allow', 'Telegram is no mail');
  assert.equal(applyRules(full, { name: 'channel_send', risk: 'write', args: { to: 'klant' }, impact: 'external', channel: '?' }, 'allow', mail).decision, 'ask', 'unknown channel: fail-safe');

  const shop = [stored('Vraag altijd voordat je iets in Shopify verandert')];
  const auto = bot({ access_mode: 'auto' });
  assert.equal(applyRules(auto, { name: 'mcp_shopify_update_product', risk: 'write', args: {} }, 'allow', shop).decision, 'ask');
  assert.equal(applyRules(auto, { name: 'mcp_shopify_list_products', risk: 'read', args: {} }, 'allow', shop).decision, 'allow', 'reading is no change');
  assert.equal(applyRules(auto, { name: 'claude-code:mcp__shopify__update_product', risk: 'write', args: {} }, 'allow', shop).decision, 'ask', 'CLI tools too');

  const never = [stored('Verwijder nooit bestanden')];
  assert.equal(applyRules(full, { name: 'delete_file', risk: 'danger', args: { path: 'a' } }, 'allow', never).decision, 'deny');
  assert.equal(applyRules(full, { name: 'claude-code:Bash', risk: 'exec', args: { command: 'rm -rf build' } }, 'allow', never).decision, 'deny');
  assert.equal(applyRules(full, { name: 'claude-code:Bash', risk: 'exec', args: { command: 'npm run build' } }, 'allow', never).decision, 'allow');
  // "never" beats "may always"
  assert.equal(applyRules(ask, w('Offertes/a.md'), 'ask', [...quotes, stored('Schrijf nooit in de map Offertes')]).decision, 'deny');
});

test('rules through the real gate: a refused delete says which rule, a question shows the rule on the card, teams, prompt', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent({ access_mode: 'full', tool_groups: ['files'] });
    fs.writeFileSync(path.join(a.workspace, 'oud.txt'), 'blijft');
    await t.api('POST', '/bot-rules', { agentId: a.id, text: 'Verwijder nooit bestanden' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ toolCalls: [{ name: 'delete_file', args: { path: 'oud.txt' } }] }, { text: 'Niet gedaan.' });
    const msgs = await t.say(th.id, 'ruim oud.txt op');
    assert.equal(fs.existsSync(path.join(a.workspace, 'oud.txt')), true);
    const res = msgs.find((m: any) => m.role === 'tool');
    assert.match(res.content, /Geweigerd door een regel van je eigenaar: “Verwijder nooit bestanden”/);
    // the bot knows its rules (system prompt)
    assert.match(JSON.stringify(t.requests.at(-1)), /Regels van je eigenaar[\s\S]*Verwijder nooit bestanden/);

    // ask: the approval card names the rule
    const b = await t.agent({ name: 'Schrijver', access_mode: 'auto', tool_groups: ['files'] });
    await t.api('POST', '/bot-rules', { agentId: b.id, text: 'Vraag altijd voordat je iets in de map Facturen verandert' });
    const th2 = await t.api('POST', '/threads', { agentId: b.id });
    t.script.push({ toolCalls: [{ name: 'write_file', args: { path: 'Facturen/f1.md', content: 'x' } }] }, { text: 'Klaar.' });
    await t.api('POST', `/threads/${th2.id}/messages`, { content: 'maak een factuur' });
    let card: any;
    for (let i = 0; i < 200 && !card; i++) {
      card = (await t.api('GET', '/approvals')).find((x: any) => x.status === 'pending');
      if (!card) await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(card, 'asks');
    assert.match(card.summary, /^Jouw regel: “Vraag altijd voordat je iets in de map Facturen verandert”/);
    await t.api('POST', `/approvals/${card.id}`, { decision: 'approve' });
    await t.waitIdle(th2.id);
    assert.equal(fs.existsSync(path.join(b.workspace, 'Facturen', 'f1.md')), true);

    // a team rule holds for the team's bots only
    const svc = t.app.ctx.services.botRules._service;
    const home = t.app.ctx.services.teams.teamOf(a.id);
    const other = await t.api('POST', '/teams', { name: 'Webwinkel', starterRules: false });
    const c = await t.agent({ name: 'Winkelbot', access_mode: 'auto', settings: { homeTeam: other.id } });
    assert.equal(t.app.ctx.services.teams.teamOf(c.id), other.id);
    await t.api('POST', '/bot-rules', { teamId: other.id, text: 'Vraag altijd voordat je iets in Shopify verandert' });
    const call = { name: 'mcp_shopify_update_product', risk: 'write' as const };
    assert.equal(t.app.ctx.broker.decide(t.app.ctx.store.agent(c.id)!, call, {}), 'ask');
    assert.equal(t.app.ctx.broker.decide(t.app.ctx.store.agent(b.id)!, call, {}), 'allow', 'other team');
    const view = await t.api('GET', `/bot-rules?agentId=${c.id}`);
    assert.equal(view.team.id, other.id);
    assert.equal(view.team.rules[0].text, 'Vraag altijd voordat je iets in Shopify verandert');
    assert.equal(svc.forAgent(t.app.ctx.store.agent(a.id)!).length, 1);
    assert.ok(home);
    // a duplicated team keeps its rules and those of its bots: a copy is never looser
    await t.api('POST', '/bot-rules', { agentId: c.id, text: 'Verwijder nooit bestanden' });
    const dup = await t.api('POST', `/teams/${other.id}/duplicate`);
    const copy = t.app.ctx.store.agents(a.user_id).find((x) => x.name.startsWith('Winkelbot') && x.id !== c.id && t.app.ctx.services.teams.teamOf(x.id) === dup.team.id);
    assert.ok(copy, 'the bot was copied');
    assert.deepEqual(svc.forAgent(copy).map((r: any) => r.text).sort(), ['Verwijder nooit bestanden', 'Vraag altijd voordat je iets in Shopify verandert']);

    // audit
    assert.ok(t.app.ctx.store.all("SELECT id FROM audit WHERE kind = 'botrules.added'").length >= 3);
  } finally {
    await t.close();
  }
});

test('CLI bots: "mag altijd" in a folder skips the question, "nooit" refuses with the rule', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent({ access_mode: 'ask' });
    await t.api('POST', '/bot-rules/loosen', { agentId: a.id, text: 'Mag altijd bestanden maken in de map Offertes' });
    await t.api('POST', '/bot-rules', { agentId: a.id, text: 'Voer nooit opdrachten uit' });
    const agent = t.app.ctx.store.agent(a.id)!;
    const gs = { ctx: t.app.ctx, agent, thread: null, run: null, userId: a.user_id, signal: new AbortController().signal, ns: 'claude-code' };
    const w = await gate(gs, { tool: 'Write', risk: 'write', summary: 'x', input: {}, paths: [path.join(a.workspace, 'Offertes', 'klant.md')] });
    assert.equal(w.allow, true);
    assert.equal(w.asked, false);
    const bash = await gate(gs, { tool: 'Bash', risk: 'exec', summary: 'ls', input: {}, command: 'ls' });
    assert.equal(bash.allow, false);
    assert.match(bash.message, /regel van je eigenaar: “Voer nooit opdrachten uit”/);
  } finally {
    await t.close();
  }
});

test('a rule TeamBot cannot pin down goes to Auto Review, also outside auto mode; it asks the owner', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent({ access_mode: 'full', tool_groups: ['files'] });
    const r = await t.api('POST', '/bot-rules', { agentId: a.id, text: 'Noem nooit prijzen zonder overleg' });
    assert.equal(r.review, true);
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ toolCalls: [{ name: 'write_file', args: { path: 'offerte.md', content: 'Prijs: 500 euro' } }] }, { text: '{"verdict":"ask","reason":"Noemt een prijs"}' }, { text: 'Klaar.' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'maak een offerte' });
    let card: any;
    for (let i = 0; i < 200 && !card; i++) {
      card = (await t.api('GET', '/approvals')).find((x: any) => x.status === 'pending');
      if (!card) await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(card, 'asks');
    assert.match(card.summary, /Automatische controle: Noemt een prijs/);
    const review = t.requests.find((q: any) => JSON.stringify(q).includes("Regels van de eigenaar"));
    assert.ok(review, 'the reviewer got the rule');
    assert.match(JSON.stringify(review), /Noem nooit prijzen zonder overleg/);
    await t.api('POST', `/approvals/${card.id}`, { decision: 'deny' });
    await t.waitIdle(th.id);
  } finally {
    await t.close();
  }
});

test('making a bot looser is computer-only: the phone adds stricter rules and removes "allow" rules only', async () => {
  const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TeamBot/1.0';
  const t = await startTestApp();
  try {
    const a = await t.agent({ access_mode: 'ask' });
    // the computer: an allow rule only through /loosen; removing a strict one only through /loosen
    await assert.rejects(t.api('POST', '/bot-rules', { agentId: a.id, text: 'Mag altijd bestanden maken in de map Offertes' }), /409/);
    const allow = await t.api('POST', '/bot-rules/loosen', { agentId: a.id, text: 'Mag altijd bestanden maken in de map Offertes' });
    const strict = await t.api('POST', '/bot-rules', { agentId: a.id, text: 'Verwijder nooit bestanden' });
    await assert.rejects(t.api('DELETE', `/bot-rules/${strict.id}`), /409/);
    await assert.rejects(t.api('POST', '/bot-rules', { agentId: a.id, text: 'Verwijder nooit bestanden' }), /staat er al/);
    await assert.rejects(t.api('POST', '/bot-rules', { agentId: a.id, text: 'Mag altijd mailen' }), /Versturen, publiceren, betalen/);
    const pv = await t.api('POST', '/bot-rules/preview', { text: 'Mail nooit naar klanten zonder mij te vragen' });
    assert.equal(pv.rule.effect, 'ask');

    // the phone
    const ticket = await t.api('POST', '/mobile/pair', { baseUrl: 'http://192.168.1.5:4761' });
    const secret = new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('t');
    const claim = await fetch(t.app.url + '/api/public/mobile/claim', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': IPHONE_UA }, body: JSON.stringify({ secret, name: 'Telefoon' }) });
    const phone = (await claim.json()).token as string;
    const D = async (m: string, p: string, b?: any) => {
      const r = await fetch(t.app.url + '/api' + p, { method: m, headers: { authorization: `Bearer ${phone}`, ...(b ? { 'content-type': 'application/json' } : {}) }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
    };
    assert.equal((await D('GET', `/bot-rules?agentId=${a.id}`)).status, 200);
    assert.equal((await D('POST', '/bot-rules/preview', { text: 'Mag altijd bestanden maken in de map X' })).status, 200);
    assert.equal((await D('POST', '/bot-rules', { agentId: a.id, text: 'Vraag altijd voordat je iets in Shopify verandert' })).status, 200, 'stricter: fine on the phone');
    for (const [m, p, b] of [
      ['POST', '/bot-rules/loosen', { agentId: a.id, text: 'Mag altijd bestanden maken in de map Y' }],
      ['DELETE', `/bot-rules/loosen/${strict.id}`],
      ['POST', '/Bot-Rules/Loosen', { agentId: a.id, text: 'Mag altijd bestanden maken in de map Y' }],
    ] as [string, string, any?][]) {
      const r = await D(m, p, b);
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.equal(r.body.code, 'mobile_denied');
      assert.match(r.body.error, /computer/);
    }
    assert.equal((await D('POST', '/bot-rules', { agentId: a.id, text: 'Mag altijd bestanden maken in de map Z' })).status, 409, 'an allow rule never through the strict route');
    assert.equal((await D('DELETE', `/bot-rules/${allow.id}`)).status, 200, 'removing an allow rule makes it stricter');
    assert.equal(t.app.ctx.store.all('SELECT id FROM bot_rules WHERE id = ?', strict.id).length, 1, 'the strict rule is still there');

    // the computer removes the strict rule; a deleted bot takes its rules along
    await t.api('DELETE', `/bot-rules/loosen/${strict.id}`);
    await t.api('DELETE', `/agents/${a.id}`);
    assert.equal(t.app.ctx.store.all('SELECT id FROM bot_rules WHERE agent_id = ?', a.id).length, 0);
  } finally {
    await t.close();
  }
});
