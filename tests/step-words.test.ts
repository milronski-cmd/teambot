/**
 * The line next to a tool step in the chat ("Taak aan Pen: Lees alle oude berichten na.") stayed Dutch in English: the
 * tools built it as one finished Dutch sentence, which the chat shows as written because it holds the bot's words. Now
 * a tool gives TeamBot's words with values (`words()`, shared/i18n-core.ts): the step stores the template and the
 * values, and the chat shows the template in the reader's language and the values exactly as written. The Dutch text
 * stays as well (what the bot, the log and an export read). An older step stored as plain text is shown as it was.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Translator, fillWords, ownPieces, words, type Piece, type Words } from '../shared/i18n-core.js';
import { stepSummary } from '../server/tools/execute.js';
import { makeScope } from '../server/modules/cli-agents/context.js';
import { teambotTools } from '../server/modules/cli-agents/toolhost.js';
import type { ToolDef } from '../server/core/types.js';
import { startTestApp } from './helpers.js';
import { msgs, settle, team, until } from './team-mock.js';

process.env.TEAMBOT_TEST_NO_AUTO_MAIN = '1';

// The English dictionary, plus the new templates as the translator adds them.
const dict = JSON.parse(fs.readFileSync(path.join('ui', 'src', 'i18n', 'en.json'), 'utf8'));
const en = new Translator({ ...dict, 'Taak aan {0}: {1}': 'Task for {0}: {1}', 'Taak bijwerken: {0} → {1}': 'Update task: {0} → {1}', 'TeamBot · {0}': 'TeamBot · {0}', 'Melding: {0}': 'Notification: {0}' }, 'en-GB');
const english = (w: Words) => ownPieces(w.text, w.values || [], (x, v) => en.format(x, v));
const own = (p: Piece[]) => p.filter((x): x is { own: string } => typeof x !== 'string').map((x) => x.own);
const text = (p: Piece[]) => p.map((x) => (typeof x === 'string' ? x : x.own)).join('');
const tool = (summarize: ToolDef['summarize']): ToolDef => ({ name: 'x_tool', group: 'core', description: '', risk: 'read', parameters: { type: 'object' }, summarize, run: async () => '' });

const TASK = 'Lees alle oude berichten na.';

test('a step’s line is stored as template plus values and shown in the reader’s language, the values unchanged', () => {
  const s = stepSummary(tool((a) => words('Taak aan {0}: {1}', a.bot, a.task)), { bot: 'Pen', task: TASK });
  assert.equal(s.summary, `Taak aan Pen: ${TASK}`, 'the Dutch line, for the bot and the log');
  assert.deepEqual(s.words, { text: 'Taak aan {0}: {1}', values: ['Pen', TASK] });
  // English: TeamBot's words translated, the name and the task exactly as written.
  assert.deepEqual(english(s.words!), ['Task for ', { own: 'Pen' }, ': ', { own: TASK }]);
  // A value that is a word of the dictionary stays as written ("Klaar" is "Done" in the dictionary).
  assert.equal(en.translate('Klaar'), 'Done');
  assert.deepEqual(own(english(words('Taak aan {0}: {1}', 'Pen', 'Klaar'))), ['Pen', 'Klaar']);
  // TeamBot's words inside TeamBot's words (a status label): translated as well, the task title still as written.
  const upd = words('Taak bijwerken: {0} → {1}', 'Offerte opvragen', words('Bezig'));
  assert.equal(fillWords(upd), 'Taak bijwerken: Offerte opvragen → Bezig');
  assert.equal(text(english(upd)), 'Update task: Offerte opvragen → Busy');
  assert.deepEqual(own(english(upd)), ['Offerte opvragen']);
  // A template the dictionary does not have yet: Dutch, the values still apart and as written.
  assert.deepEqual(own(english(words('Nog niet vertaald: {0}', 'Elke werkdag om 9:00'))), ['Elke werkdag om 9:00']);
});

test('a secret in a value is hidden in the line and in its words; an older plain line stays as it was', () => {
  const key = 'sk-ant-' + 'a'.repeat(30);
  const s = stepSummary(tool((a) => words('Opdracht: {0}', a.command)), { command: `curl -H "x-api-key: ${key}" https://x.test` });
  assert.doesNotMatch(s.summary, /a{30}/);
  assert.doesNotMatch(JSON.stringify(s.words), /a{30}/);
  assert.match(String(s.words!.values![0]), /^curl -H "x-api-key: sk-a…\[verborgen\]" https:\/\/x\.test$/);
  // A tool (or a step stored before) with one finished text: no words, the text shown as written.
  const old = stepSummary(tool(() => `Taak aan Pen: ${TASK}`), {});
  assert.deepEqual(old, { summary: `Taak aan Pen: ${TASK}` });
});

test('API engine: the step of delegate_task is stored with the template and the bot’s own words', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    await m.bot('Pen');
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    m.script('Ada', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Pen', task: TASK, expected_output: 'een lijst' } }] }, { text: 'Doorgegeven.' }, { text: 'Pen is klaar.' });
    m.script('Pen', { text: 'Gedaan.' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Laat Pen de berichten nalezen.' });
    const call = await until(() => msgs(t, th.id).flatMap((x: any) => x.parts.toolCalls || []).find((c: any) => c.name === 'delegate_task'));
    await settle(t);
    assert.equal(call.summary, `Taak aan Pen: ${TASK}`);
    assert.deepEqual(call.words, { text: 'Taak aan {0}: {1}', values: ['Pen', TASK] });
    // What the chat shows in English.
    assert.equal(text(english(call.words)), `Task for Pen: ${TASK}`);
  } finally {
    await t.close();
  }
});

test('teambot_do: the line built from the route is TeamBot’s words, the name in it as given', async () => {
  const { planCall } = await import('../server/modules/teams/manage.js');
  const t = await startTestApp();
  try {
    const p: any = planCall(t.app.ctx, t.app.ctx.auth.owner()!.id, { method: 'POST', path: '/routines', body: { name: TASK } });
    assert.ok(p.words, JSON.stringify(p));
    assert.equal(p.summary, fillWords(p.words), 'the Dutch line is the words filled in');
    assert.match(p.summary, new RegExp(`‘${TASK.replace('.', '\\.')}’ maken$`));
    assert.deepEqual(own(english(p.words)), [TASK]);
  } finally {
    await t.close();
  }
});

test('CLI engine: TeamBot’s line for one of its tools carries the same words', async () => {
  const t = await startTestApp();
  try {
    const ctx = t.app.ctx;
    const a = await t.agent({ access_mode: 'auto' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    const input = ctx.store.createMessage({ thread_id: th.id, role: 'user', author_type: 'user', author_id: a.user_id, author_name: 'Ik', content: 'x' } as any);
    const run = ctx.store.createRun({ thread_id: th.id, agent_id: a.id, user_id: a.user_id, status: 'running', trigger: 'user', input_message_id: input.id, meta: {} });
    const events: any[] = [];
    const scope = makeScope(ctx, ctx.providers.config(t.providerId)!, { model: '', system: '', prompt: 'x', attachments: [], workspace: a.workspace, accessMode: a.access_mode, agentId: a.id, threadId: th.id, runId: run.id, userId: a.user_id }, new AbortController().signal, (e) => events.push(e));
    const host = teambotTools(scope, { engine: 'claude' });
    await host.list();
    await host.call('notify_user', { message: TASK }, new AbortController().signal);
    const item = events.filter((e) => e.type === 'activity').map((e) => e.item).at(-1);
    assert.equal(item.title, `TeamBot · Melding: ${TASK}`);
    assert.deepEqual(item.words, { text: 'TeamBot · {0}', values: [{ text: 'Melding: {0}', values: [TASK] }] });
    assert.equal(text(english(item.words)), `TeamBot · Notification: ${TASK}`);
    assert.deepEqual(own(english(item.words)), [TASK]);
  } finally {
    await t.close();
  }
});
