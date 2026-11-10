import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp } from './helpers.js';

/**
 * Checklist A-11: a bot exported from the bot editor (Sjabloon en delen › Exporteren als bestand) can be imported in an
 * empty data dir; profile and face come along, conversations, memory and secrets do not. The round-2 acceptance test
 * found that "Alle bots › Importeren" refused the file ("Onbekend bestandsformaat").
 */
test('editor export → import in an empty data dir: profile yes; conversations, memory and keys no', async () => {
  const a = await startTestApp();
  const b = await startTestApp();
  try {
    const bot = await a.agent({ name: 'Gezinskok', role: 'Planner', instructions: 'Plan de maaltijden.', avatar: 'face:{"shape":"egg"}' });
    const th = await a.api('POST', '/threads', { agentId: bot.id });
    a.script.push({ text: 'Hallo' });
    await a.api('POST', `/threads/${th.id}/messages`, { content: 'Onthoud dat mijn kat Mo heet.' });
    await a.api('PUT', '/secrets/GEHEIM', { value: 'sk-niet-meenemen-123456' });
    const res = await fetch(`${a.app.url}/api/skills/templates/export/${bot.id}`, { headers: { authorization: `Bearer ${a.app.ctx.auth.ensureLocalOwner()}` } });
    const raw = await res.text();
    const tpl = JSON.parse(raw);
    assert.equal(tpl.format, 'teambot.bot-template/v1');
    assert.ok(!/Mo heet|sk-niet-meenemen|messages/.test(raw), 'no conversation, memory or secret in the file');
    // What the "Importeren" button on "Alle bots" does with this format.
    await b.api('POST', '/skills/templates/install', { template: tpl });
    const imported = (await b.api('GET', '/agents')).find((x: any) => x.name === 'Gezinskok');
    assert.ok(imported, 'the bot exists in the empty data dir');
    assert.equal(imported.instructions, 'Plan de maaltijden.');
    assert.equal((await b.api('GET', '/threads')).length, 0);
    assert.equal((await b.api('GET', '/memory/items')).items.length, 0);
    // The import button accepts the editor's format.
    const ui = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'ui', 'src', 'pages', 'Agents.tsx'), 'utf8');
    assert.match(ui, /teambot\.bot-template\/v1/);
  } finally {
    await a.close();
    await b.close();
  }
});
