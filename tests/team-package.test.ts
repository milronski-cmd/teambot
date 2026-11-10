import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp } from './helpers.js';
import rooms from '../server/modules/rooms/index.js';
import skills from '../server/modules/skills/index.js';
import routines from '../server/modules/routines/index.js';
import { TEAM_TEMPLATES } from '../server/modules/rooms/team-templates.js';
import { COLORS, EYES, MOUTHS, SHAPES, EXTRAS, parseFace } from '../shared/botface.js';

// A-14: a team (group with bots, roles, lead, instructions) from a template. A-63: a whole team exported and
// imported as a package — bots, roles, group settings, skills (once, by reference), routines switched off — with a
// preview first, and without secrets or conversations.

const SKILL_MD = '---\nname: offerte-check\ndescription: Controleert offertes op prijs, termijn en voorwaarden.\nversion: 1.0.0\nlicense: MIT\n---\n\n# Offerte-check\n\n- Lees de offerte.\n- Noem prijs, levertermijn en voorwaarden.\n';

async function app(): Promise<TestApp> {
  return startTestApp({ modules: [skills, routines, rooms] });
}

test('team templates: valid bots and faces, one lead, preview then a real group', async () => {
  for (const t of TEAM_TEMPLATES) {
    assert.equal(t.bots.filter((b) => b.role === 'lead').length, 1, `${t.id}: one lead`);
    for (const b of t.bots) {
      const f = parseFace(b.template.avatar)!;
      assert.ok((SHAPES as readonly string[]).includes(f.shape!) && (COLORS as readonly string[]).includes(f.color!) && (EYES as readonly string[]).includes(f.eyes!) && (MOUTHS as readonly string[]).includes(f.mouth!) && (EXTRAS as readonly string[]).includes(f.extra!), `${t.id}/${b.template.name}: face`);
      assert.ok(b.template.instructions.split('\n').length >= 3, `${t.id}/${b.template.name}: instructions`);
    }
  }
  const t = await app();
  try {
    const list = await t.api('GET', '/rooms/templates');
    assert.ok(list.length >= 3);
    const before = (await t.api('GET', '/agents')).length;
    const pv = await t.api('POST', '/rooms/packages/preview', { templateId: 'onderzoek-en-schrijven' });
    assert.equal(pv.lead, 'Redacteur');
    assert.deepEqual(pv.bots.map((b: any) => [b.name, b.groupRole]), [['Redacteur', 'lead'], ['Onderzoeker', 'member'], ['Schrijver', 'member']]);
    assert.equal((await t.api('GET', '/agents')).length, before, 'a preview creates nothing');
    const out = await t.api('POST', '/rooms/packages/install', { templateId: 'onderzoek-en-schrijven', provider_id: t.providerId, model: 'mock-1' });
    const room = await t.api('GET', `/rooms/${out.room.id}`);
    assert.equal(room.name, 'Onderzoek en schrijven');
    assert.equal(room.mode, 'lead');
    assert.match(room.instructions, /Redacteur \(teamleider\): plant/);
    assert.deepEqual(room.bots.map((b: any) => b.name).sort(), ['Onderzoeker', 'Redacteur', 'Schrijver']);
    const lead = room.bots.find((b: any) => b.agentId === room.lead_agent_id);
    assert.equal(lead.name, 'Redacteur');
    const agents = await t.api('GET', '/agents');
    assert.equal(agents.length, before + 3);
    for (const a of agents.filter((x: any) => out.agents.some((y: any) => y.id === x.id))) {
      assert.equal(a.provider_id, t.providerId);
      assert.equal(a.access_mode, 'ask', 'safe access');
    }
    // The group works: the lead answers in the group chat.
    t.script.push({ text: 'Ik maak een plan.' });
    const msgs = await t.say(out.threadId, 'Schrijf een stukje over zonnepanelen.');
    assert.ok(msgs.some((m: any) => m.author_name === 'Redacteur' && m.content === 'Ik maak een plan.'));
  } finally {
    await t.close();
  }
});

test('team package: export a group and import it elsewhere — bots, roles, settings, skills, routines off; no secrets or conversations', async () => {
  const src = await app();
  const dst = await app();
  try {
    // A team with a skill, a routine, a secret in the instructions and a conversation.
    const owner = src.app.ctx.auth.owner()!;
    await src.app.ctx.services.skills.installTemplate(owner.id, {
      format: 'teambot.bot-template/v1',
      name: 'Inkoper',
      role: 'Inkoop',
      instructions: '- Vergelijk offertes.\n- Gebruik de API-sleutel sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghij voor niets.',
      tool_groups: ['files', 'skills', 'team'],
      skills: [{ name: 'offerte-check', version: '1.0.0', checksum: '', files: { 'SKILL.md': SKILL_MD } }],
    }, { provider_id: src.providerId, model: 'mock-1' });
    const inkoper = (await src.api('GET', '/agents')).find((a: any) => a.name === 'Inkoper');
    const lead = await src.agent({ name: 'Chef', role: 'Teamleider', instructions: '- Verdeel het werk.' });
    await src.api('POST', '/routines', { name: 'Maandagoverzicht', agent_id: inkoper.id, prompt: 'Vat de offertes van vorige week samen.', timezone: 'Europe/Amsterdam', schedule: { kind: 'weekly', days: ['ma'], times: ['09:00'] } });
    const created = await src.api('POST', '/rooms', { name: 'Inkoopteam', agentIds: [lead.id, inkoper.id], mode: 'lead', leadAgentId: lead.id, instructions: 'Altijd drie offertes vergelijken.', limits: { maxTurnsPerMessage: 5, maxCostUsd: 2 } });
    src.script.push({ text: 'GEHEIM-GESPREK-123 genoteerd.' });
    await src.say(created.threadId, 'Onthoud GEHEIM-GESPREK-123 voor de leverancier.');

    const ex = await src.api('GET', `/rooms/${created.room.id}/package?preview=1`);
    const pkg = ex.package;
    const raw = JSON.stringify(pkg);
    assert.equal(pkg.format, 'teambot.team/v1');
    assert.equal(pkg.bots.length, 2);
    assert.deepEqual(pkg.bots.map((b: any) => [b.template.name, b.role]), [['Chef', 'lead'], ['Inkoper', 'member']]);
    assert.deepEqual(pkg.bots[1].skillRefs, ['offerte-check']);
    assert.equal(pkg.skills.length, 1, 'skills once, by reference');
    assert.equal(pkg.bots[1].template.skills.length, 0);
    assert.equal(pkg.bots[1].template.routines.length, 1);
    assert.equal(pkg.instructions, 'Altijd drie offertes vergelijken.');
    assert.equal(pkg.limits.maxTurnsPerMessage, 5);
    assert.doesNotMatch(raw, /sk-ant-api03/, 'no secrets');
    assert.ok(ex.warnings.some((w: string) => /geheim/i.test(w)), 'removed secret is reported');
    assert.doesNotMatch(raw, /GEHEIM-GESPREK-123/, 'no conversations');
    assert.doesNotMatch(raw, new RegExp(src.providerId), 'no provider choice');
    assert.doesNotMatch(raw, /workspaces/, 'no working folders');

    // Download as a file.
    const res = await fetch(`${src.app.url}/api/rooms/${created.room.id}/package`, { headers: { authorization: `Bearer ${src.token}` } });
    assert.match(res.headers.get('content-disposition') || '', /Inkoopteam\.teambot-team\.json/);

    // Import elsewhere: preview first, then install.
    const pv = await dst.api('POST', '/rooms/packages/preview', { package: pkg });
    assert.equal(pv.name, 'Inkoopteam');
    assert.equal(pv.lead, 'Chef');
    assert.equal(pv.routines, 1);
    assert.deepEqual(pv.bots.find((b: any) => b.name === 'Inkoper').skills, [{ name: 'offerte-check', action: 'create' }]);
    assert.equal((await dst.api('GET', '/agents')).length, 0, 'preview creates nothing');
    const inst = await dst.api('POST', '/rooms/packages/install', { package: pkg });
    const room = await dst.api('GET', `/rooms/${inst.room.id}`);
    assert.equal(room.name, 'Inkoopteam');
    assert.equal(room.instructions, 'Altijd drie offertes vergelijken.');
    assert.equal(room.limits.maxTurnsPerMessage, 5);
    assert.equal(room.bots.find((b: any) => b.agentId === room.lead_agent_id).name, 'Chef');
    const ink = (await dst.api('GET', '/agents')).find((a: any) => a.name === 'Inkoper');
    const skillsList = dst.app.ctx.services.skills.list(dst.app.ctx.auth.owner()!.id);
    assert.ok(skillsList.some((s: any) => s.name === 'offerte-check'), 'skill installed');
    assert.ok((ink.skills || []).length === 1, 'bot uses the skill');
    const rts = await dst.api('GET', '/routines');
    assert.equal(rts.length, 1);
    assert.equal(rts[0].status, 'paused', 'routines come in switched off');
    assert.match(rts[0].paused_reason, /Geïmporteerd/);
    assert.equal(dst.app.ctx.store.all("SELECT id FROM messages WHERE content LIKE '%GEHEIM-GESPREK%'").length, 0);
    // A file that is no team package is refused clearly.
    await assert.rejects(dst.api('POST', '/rooms/packages/preview', { package: { format: 'teambot.agent/v1' } }), /geen teampakket/);
  } finally {
    await src.close();
    await dst.close();
  }
});
