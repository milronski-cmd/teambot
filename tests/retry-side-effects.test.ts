import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp } from './helpers.js';
import { msgs, runsOf, settle, team } from './team-mock.js';

/**
 * A-33: "Opnieuw proberen" after a turn failed halfway, right after a write action. The write must not run twice and
 * the transcript stays consistent: the retry continues from the last step instead of starting the request over.
 */

test('API engine: a turn fails right after a write; "Opnieuw proberen" continues from the last step, the write runs once', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const file = path.join(t.dir, 'kasboek.txt');
    let writes = 0;
    t.app.ctx.tools.register({
      name: 'append_line',
      group: 'core',
      risk: 'write',
      description: 'test: appends one line to the cash book (a side effect)',
      parameters: { type: 'object', properties: { line: { type: 'string' } }, required: ['line'] },
      async run(a: any) {
        writes++;
        fs.appendFileSync(file, a.line + '\n');
        return `Regel toegevoegd: ${a.line}`;
      },
    });
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    m.script(
      'Ada',
      { toolCalls: [{ name: 'append_line', args: { line: 'fiets verkocht 120' } }] },
      // The next model call fails halfway through its answer (the engine broke off).
      { lead: 'Ik heb de regel toegevoegd en ga nu', error: 'Onverwachte fout van de server', errorStatus: 400 },
    );
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'zet de verkoop van de fiets in het kasboek' });
    await settle(t);
    assert.equal(runsOf(t, th.id)[0].status, 'error');
    assert.equal(writes, 1);

    // Opnieuw proberen: the model gets the finished write back as a tool result (nothing to redo), no half answer.
    m.script('Ada', {
      text: 'De verkoop staat in het kasboek.',
      check: (req) => {
        const calls = req.messages.flatMap((x) => x.toolCalls || []);
        assert.equal(calls.length, 1, 'one tool call in the history');
        const results = req.messages.filter((x) => x.role === 'tool');
        assert.equal(results.length, 1);
        assert.match(String(results[0].content), /Regel toegevoegd: fiets verkocht 120/);
        assert.doesNotMatch(JSON.stringify(req.messages), /ga nu/, 'the broken half answer is not given back as an answer');
        assert.equal(req.messages.filter((x) => x.role === 'user').length, 1, 'the request is not asked twice');
        assert.equal(req.messages.at(-1)!.role, 'tool', 'the model continues after its last finished step');
      },
    });
    await t.api('POST', `/threads/${th.id}/retry`, {});
    await settle(t);
    assert.equal(runsOf(t, th.id)[1].error, null, 'the retry went through');
    assert.equal(writes, 1, 'the write ran once');
    assert.equal(fs.readFileSync(file, 'utf8'), 'fiets verkocht 120\n');
    const all = msgs(t, th.id).filter((x) => !x.deleted && x.role !== 'event');
    assert.deepEqual(
      all.map((x) => `${x.role}:${x.status}`),
      ['user:done', 'assistant:done', 'tool:done', 'assistant:error', 'assistant:done'],
      'question, write step, its result, the failed attempt, the answer',
    );
    assert.equal(all.filter((x) => x.role === 'tool').length, 1);
    assert.equal(all.at(-1)!.content, 'De verkoop staat in het kasboek.');
    assert.deepEqual(runsOf(t, th.id).map((r) => r.status), ['error', 'done']);
  } finally {
    await t.close();
  }
});

test('CLI engine: a turn fails after the CLI wrote a file; the retry continues the session instead of asking again', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const cli = await m.cliBot('Cli');
    const th = await t.api('POST', '/threads', { agentId: cli.id });
    m.script('Cli', { activity: [{ kind: 'files', title: 'Schreef verslag.txt' }], error: 'Het proces stopte onverwacht' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'schrijf het verslag naar verslag.txt' });
    await settle(t);
    assert.equal(runsOf(t, th.id)[0].status, 'error');

    m.script('Cli', { text: 'Het verslag staat klaar.' });
    await t.api('POST', `/threads/${th.id}/retry`, {});
    await settle(t);
    const second = m.cliCalls.filter((c) => c.bot === 'Cli')[1];
    assert.equal(second.req.sessionId, 'sess-Cli', 'the CLI session (with what it already did) continues');
    assert.match(second.req.prompt, /vorige poging/);
    assert.match(second.req.prompt, /Schreef verslag\.txt/, 'what was already done is named');
    assert.match(second.req.prompt, /herhaal geen acties die al gelukt zijn/);
    assert.match(second.req.prompt, /schrijf het verslag naar verslag\.txt/, 'the request itself is still there for context');

    // A new message later: the failed attempt counts as seen, so the old request is not handed over again as "new".
    m.script('Cli', { text: 'Graag gedaan.' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'dank je' });
    await settle(t);
    const third = m.cliCalls.filter((c) => c.bot === 'Cli')[2];
    assert.doesNotMatch(third.req.prompt, /schrijf het verslag/);
    assert.match(third.req.prompt, /dank je/);

    // An error before the CLI did anything (no steps): the retry simply sends the request again.
    m.script('Cli', { error: 'Niet ingelogd bij de engine' }, { text: 'Hier is de samenvatting.' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'vat het samen' });
    await settle(t);
    await t.api('POST', `/threads/${th.id}/retry`, {});
    await settle(t);
    const fifth = m.cliCalls.filter((c) => c.bot === 'Cli')[4];
    assert.doesNotMatch(fifth.req.prompt, /vorige poging/);
    assert.match(fifth.req.prompt, /vat het samen/);
  } finally {
    await t.close();
  }
});
