/** A note for a colleague starts no turn: it is read at the start of the colleague's next turn, once. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { isNotice, leaveNote, notesContext } from '../server/modules/rooms/notes.js';

test('a notice is not a question: it waits for the colleague\'s next turn and costs no turn', async () => {
  const t = await startTestApp();
  try {
    const ctx = t.app.ctx;
    const a = ctx.store.agent((await t.agent({ name: 'Bouwer' })).id)!;
    const b = ctx.store.agent((await t.agent({ name: 'Schrijver' })).id)!;

    assert.equal(isNotice('Ter info (20-11): de pagina staat live.'), true);
    assert.equal(isNotice('Van Bouwer, ter kennisgeving voor je nameting (geen antwoord nodig): alles stuurt nu één melding.'), true);
    assert.equal(isNotice('FYI: the build is green. No reply needed.'), true);
    assert.equal(isNotice('Kun je de tekst van de homepage nakijken en zeggen wat er anders moet?'), false);
    assert.equal(isNotice('Bouw het formulier volgens de spec. Klaar als het live staat.'), false);

    assert.equal(notesContext(ctx, b), null, 'nothing waiting');
    const runsBefore = ctx.store.one<any>('SELECT COUNT(*) AS n FROM runs').n;
    leaveNote(ctx, a, b, 'De pagina /kosten staat live (PR 12).');
    leaveNote(ctx, a, b, 'Correctie: het was PR 13.');
    assert.equal(ctx.store.one<any>('SELECT COUNT(*) AS n FROM runs').n, runsBefore, 'no turn started');
    const seen = notesContext(ctx, b)!;
    assert.match(seen, /^Meldingen van collega's sinds je vorige beurt \(ter info: je hoeft er niet op te antwoorden/);
    assert.match(seen, /- Bouwer \([^)]+ UTC\): De pagina \/kosten staat live \(PR 12\)\.\n- Bouwer \([^)]+ UTC\): Correctie: het was PR 13\./);
    assert.equal(notesContext(ctx, a), null, 'only for the one it was left for');
    assert.ok(notesContext(ctx, b), 'the same turn sees it whole');
    // A later turn no longer gets it.
    ctx.store.exec('UPDATE bot_notes SET read_at = ? WHERE to_agent_id = ?', new Date(Date.now() - 20 * 60_000).toISOString(), b.id);
    assert.equal(notesContext(ctx, b), null);

    // The tool is there for every bot, next to asking.
    const names = (await ctx.tools.forAgent(a, ctx.chat.threadForAgent(a.user_id, a.id))).map((x: any) => x.name);
    assert.ok(names.includes('note_bot') && names.includes('ask_bot'), names.join(','));
  } finally {
    await t.close();
  }
});
