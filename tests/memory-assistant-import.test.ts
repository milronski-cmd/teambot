import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { normalizeAssistantExport } from '../server/modules/memory/assistant-import.js';
import { parseImport } from '../server/modules/memory/io.js';

/** 0.4.4 P7 (item 12): memory from ChatGPT, Claude or Gemini: preview first, proposals only, undo in one go. */

const CHATGPT = `Hier is wat ik over je weet:

**Over mij**
- Je heet Sanne en woont in Utrecht.
- Werkt als ontwerper bij een klein bureau.

### Voorkeuren
- Houdt van korte antwoorden.
- Houdt van korte antwoorden.
- **Taal:** Nederlands

- Wachtwoord: hunter2

Laat me weten als je nog iets wilt aanvullen!`;

const CLAUDE_EXPORT = JSON.stringify([
  {
    conversations_memory:
      '**Work context**\n\nSanne runs a small design studio in Utrecht and builds his own bot platform called TeamBot. He prefers TypeScript over Python for his projects.\n\n**Personal context**\n\nHe has a dog named Bram.',
    project_memories: {
      p1: 'In the TeamBot project he wants plain Dutch texts in the interface.',
    },
    account_uuid: 'x',
  },
]);

test('assistant export: chatter around the list is dropped, headings kept, prose split into facts', () => {
  const n = normalizeAssistantExport(CHATGPT);
  assert.ok(!/Hier is wat ik/.test(n) && !/Laat me weten/.test(n), n);
  const items = parseImport(n).map((p) => [p.content, p.type ?? null]);
  assert.deepEqual(items, [
    ['Je heet Sanne en woont in Utrecht.', null],
    ['Werkt als ontwerper bij een klein bureau.', null],
    ['Houdt van korte antwoorden.', 'preference'],
    ['Houdt van korte antwoorden.', 'preference'],
    ['Taal: Nederlands', 'preference'],
    ['Wachtwoord: hunter2', 'preference'],
  ]);
  const c = parseImport(normalizeAssistantExport(CLAUDE_EXPORT)).map((p) => p.content);
  assert.deepEqual(c, [
    'Sanne runs a small design studio in Utrecht and builds his own bot platform called TeamBot.',
    'He prefers TypeScript over Python for his projects.',
    'He has a dog named Bram.',
    'In the TeamBot project he wants plain Dutch texts in the interface.',
  ]);
});

test('assistant import: the preview writes nothing; import = proposals; known facts and secrets left out; undo', async () => {
  const t = await startTestApp();
  try {
    await t.api('POST', '/memory/items', {
      content: 'Werkt als ontwerper bij een klein bureau.',
      scope: 'about_you',
    });
    const count = async (status: string) => {
      const r = await t.api('GET', `/memory/items?status=${status}`);
      return (r.items || r).length;
    };
    const before = [await count('active'), await count('proposed')];

    const pv = await t.api('POST', '/memory/import/preview', {
      text: CHATGPT,
      source: 'chatgpt',
    });
    assert.deepEqual(
      pv.lines.map((l: any) => l.status),
      ['new', 'duplicate', 'new', 'repeat', 'new', 'secret'],
    );
    assert.equal(pv.lines[5].content, '(verborgen: lijkt op een wachtwoord of sleutel)', 'a secret is never shown back');
    assert.deepEqual([pv.counts.new, pv.total], [3, 6]);
    assert.deepEqual([await count('active'), await count('proposed')], before, 'the preview writes nothing');

    const res = await t.api('POST', '/memory/import/assistant', {
      text: CHATGPT,
      source: 'chatgpt',
    });
    assert.equal(res.label, 'ChatGPT');
    assert.equal(res.proposed, 3);
    assert.equal(await count('active'), before[0], 'nothing active right away');
    const props = (await t.api('GET', '/memory/items?status=proposed')).items;
    assert.ok(props.some((i: any) => i.content === 'Houdt van korte antwoorden.' && i.scope === 'about_you'));
    assert.ok(!props.some((i: any) => /hunter2/.test(i.content)));

    // Recent imports list it; approving one and then undoing the import removes that one too.
    const recent = await t.api('GET', '/memory/import/recent');
    assert.equal(recent[0].batch, res.batch);
    assert.equal(recent[0].label, 'uit ChatGPT');
    const one = props.find((i: any) => i.content === 'Taal: Nederlands');
    await t.api('POST', `/memory/items/${one.id}/approve`, {});
    assert.equal(await count('active'), before[0] + 1);
    const u = await t.api('POST', `/memory/import/${res.batch}/undo`, {});
    assert.deepEqual(u, { removed: 3, kept: 0 });
    assert.deepEqual([await count('active'), await count('proposed')], before);
    await assert.rejects(t.api('POST', `/memory/import/${res.batch}/undo`, {}), /404/);
    await assert.rejects(t.api('POST', '/memory/import/preview', { text: '  ' }), /400/);
    // Importing the same text again after an undo works (not seen as already processed).
    const again = await t.api('POST', '/memory/import/assistant', { text: CHATGPT, source: 'chatgpt' });
    assert.equal(again.proposed, 3);
    await t.api('POST', `/memory/import/${again.batch}/undo`, {});

    // Claude's export JSON.
    const c = await t.api('POST', '/memory/import/assistant', {
      text: CLAUDE_EXPORT,
      source: 'claude',
    });
    assert.deepEqual([c.label, c.proposed], ['Claude', 4], JSON.stringify(c));
  } finally {
    await t.close();
  }
});
