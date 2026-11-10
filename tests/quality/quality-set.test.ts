// Self-test of the quality test set (plan 0.4, package M), without any model: every checker accepts the reference
// solution, rejects "nothing done", and rejects the invented ("bad") variants. Keeps the baseline scores honest.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HIDDEN_DIR, TASKS, inputDirs } from './tasks.js';
import { PASS_AT, TEAMS, evaluate, numbersIn, parseCsv, parseNumber, sentences, type Attempt, type QualityTask } from './checks.js';

const REF = path.join(import.meta.dirname, 'reference');

function attempt(task: QualityTask, overlay?: string): Attempt {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-quality-self-'));
  for (const d of inputDirs(task)) fs.cpSync(d, dir, { recursive: true });
  let reply = '';
  if (overlay) {
    fs.cpSync(overlay, dir, { recursive: true, filter: (src) => !/[\\/]_reply\.md$/.test(src) });
    const r = path.join(overlay, '_reply.md');
    if (fs.existsSync(r)) reply = fs.readFileSync(r, 'utf8');
  }
  return { dir, fixtureDirs: inputDirs(task), hiddenDir: HIDDEN_DIR(task), reply, final: reply, questions: [] };
}

const cleanup = (a: Attempt) => fs.rmSync(a.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
const failing = (e: Awaited<ReturnType<typeof evaluate>>) => e.checks.filter((c) => !c.ok && !c.skipped).map((c) => `${c.id}: ${c.detail}`);

test('the set: about 30 tasks over all six kinds of teams, with honesty tasks', () => {
  assert.ok(TASKS.length >= 28 && TASKS.length <= 32, `${TASKS.length} tasks`);
  assert.equal(new Set(TASKS.map((t) => t.id)).size, TASKS.length, 'unique ids');
  for (const team of TEAMS) assert.ok(TASKS.filter((t) => t.team === team).length >= 4, `team ${team}`);
  assert.ok(TASKS.filter((t) => t.honesty).length >= 5, 'honesty tasks');
  for (const t of TASKS) {
    assert.match(t.id, /^[a-z0-9-]+$/);
    assert.ok(t.prompt.length > 40 && t.klaarAls.length > 20 && t.title && t.bot.name, t.id);
    assert.ok(t.checks.length >= 2, `${t.id}: checks`);
    assert.equal(new Set(t.checks.map((c) => c.id)).size, t.checks.length, `${t.id}: unique check ids`);
    assert.ok(t.checks.every((c) => !(c.judge && c.critical)), `${t.id}: a judge check is never critical`);
    for (const d of inputDirs(t)) assert.ok(fs.existsSync(d), `${t.id}: input ${d}`);
    assert.ok(fs.existsSync(path.join(REF, t.id)), `${t.id}: reference solution`);
  }
});

for (const task of TASKS) {
  test(`${task.id}: the reference solution passes with full marks`, async () => {
    const a = attempt(task, path.join(REF, task.id));
    try {
      const e = await evaluate(task, a);
      assert.deepEqual(failing(e), [], 'every check passes');
      assert.equal(e.score, 1);
      assert.ok(e.pass);
    } finally {
      cleanup(a);
    }
  });

  test(`${task.id}: doing nothing fails`, async () => {
    const a = attempt(task);
    try {
      const e = await evaluate(task, a);
      assert.equal(e.pass, false, `score ${e.score}`);
    } finally {
      cleanup(a);
    }
  });

  // <id>.good-…: other correct work (e.g. a real model answer that asked instead of guessing) that must pass too.
  for (const name of fs.readdirSync(REF).filter((d) => d.startsWith(`${task.id}.good`))) {
    test(`${task.id}: other correct work passes (${name})`, async () => {
      const a = attempt(task, path.join(REF, name));
      try {
        const e = await evaluate(task, a);
        assert.ok(e.pass, `score ${e.score}: ${failing(e).join(' | ')}`);
      } finally {
        cleanup(a);
      }
    });
  }

  // <id>.bad, <id>.bad2, …: invented or broken work (some taken from real model answers).
  for (const name of fs.readdirSync(REF).filter((d) => d.startsWith(`${task.id}.bad`))) {
    const bad = path.join(REF, name);
    test(`${task.id}: invented or broken work fails on a critical check (${name})`, async () => {
      const a = attempt(task, bad);
      try {
        const e = await evaluate(task, a);
        assert.equal(e.pass, false, `score ${e.score}`);
        assert.ok(e.criticalFailed.length > 0, 'a critical check failed');
      } finally {
        cleanup(a);
      }
    });
  }
}

test('honesty tasks have an invented variant that is caught', () => {
  for (const t of TASKS.filter((x) => x.honesty)) assert.ok(fs.existsSync(path.join(REF, `${t.id}.bad`)), t.id);
});

test('a judge only counts when there is one: skipped without, counted with', async () => {
  const task = TASKS.find((t) => t.id === 'ks-retour-binnen-termijn')!;
  const a = attempt(task, path.join(REF, task.id));
  try {
    const without = await evaluate(task, a);
    assert.ok(without.checks.find((c) => c.judge)!.skipped);
    const no = await evaluate(task, { ...a, judge: async () => ({ ok: false, detail: 'te stijf' }) });
    const yes = await evaluate(task, { ...a, judge: async () => ({ ok: true, detail: 'ok' }) });
    assert.equal(yes.score, 1);
    assert.ok(no.score < 1 && no.score >= PASS_AT, 'a failed judge check costs points but never fails the task alone');
  } finally {
    cleanup(a);
  }
});

test('helpers: numbers, CSV and sentences as bots write them', () => {
  assert.equal(parseNumber('€ 1.234,56'), 1234.56);
  assert.equal(parseNumber('34,95'), 34.95);
  assert.equal(parseNumber('2.000'), 2000);
  assert.equal(parseNumber('4.10'), 4.1);
  assert.equal(parseNumber('1,234.56'), 1234.56);
  assert.equal(parseNumber('-€ 3,00'), -3);
  assert.deepEqual(numbersIn('IPX5, 400 lumen, € 34,95 en 2.000 mAh'), [400, 34.95, 2000]);
  const csv = parseCsv('```csv\nsku,naam\n"KB-1","Lamp, zwart"\n```');
  assert.deepEqual(csv.records, [{ sku: 'KB-1', naam: 'Lamp, zwart' }]);
  const table = parseCsv('| sku | tekort |\n|---|---|\n| KB-1 | 3 |');
  assert.deepEqual(table.records, [{ sku: 'KB-1', tekort: '3' }]);
  assert.deepEqual(sentences('Eerste zin. Tweede zin!\n- punt'), ['Eerste zin.', 'Tweede zin!', '- punt']);
});
