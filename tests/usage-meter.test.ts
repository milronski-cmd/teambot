// The usage meters in the sidebar footer (0.4.5): one ring per subscription or provider (week outside, 5 hours inside),
// grey until 75%, amber from 75%, red from 90%, the provider's mark (or its initial) in the middle, and one plain
// sentence per line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockedSentence, leftSentence, markOf, meterItems, meterTone, meterWorst, monograms, ringWindows, sourceLine, sourceRing, type MeterEngine } from '../ui/src/modules/usage/meter.js';

test('mark: a known provider gets its own mark, every other one keeps its initial', () => {
  assert.equal(markOf('claude'), 'claude');
  assert.equal(markOf('', 'claude-code', 'Werk'), 'claude', 'an own name: the kind tells');
  assert.equal(markOf('openrouter-free', 'OpenRouter'), 'openrouter');
  assert.equal(markOf('opencode', 'OpenCode'), 'opencode');
  assert.equal(markOf('local', 'Ollama (lokaal)'), 'ollama');
  assert.equal(markOf('cf', 'Cloudflare Workers AI'), 'cloudflare');
  assert.equal(markOf('codex', 'codex-cli', 'Codex'), 'codex', "no licensed mark for OpenAI: TeamBot's own prompt glyph");
  assert.equal(markOf('groq', 'Groq'), 'groq');
  assert.equal(markOf('kilo', 'Kilo Gateway'), 'kilo');
  assert.equal(markOf('zai', 'Z.ai GLM'), null, 'any other provider keeps its initial');
  assert.equal(markOf(null, undefined, ''), null);
});

const L = 'nl-NL';
const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min).getTime();
// Monday 9 November 2026, 14:00 (local time).
const NOW = at(2026, 11, 9, 14);
const win = (id: string, usedPercent: number | null, resetsAt: number | null = null, level: 'ok' | 'warn' | 'limit' | 'unknown' = 'ok', estimated = false) => ({ id, label: id, usedPercent, resetsAt, level, at: NOW, estimated });

test('tone: grey until 75%, amber from 75%, red from 90% and at the limit; no number is unknown', () => {
  assert.equal(meterTone(0), 'calm');
  assert.equal(meterTone(74.9), 'calm');
  assert.equal(meterTone(75), 'warn');
  assert.equal(meterTone(89.9), 'warn');
  assert.equal(meterTone(90), 'danger');
  assert.equal(meterTone(100), 'danger');
  assert.equal(meterTone(12, 'limit'), 'danger', 'the engine says it is at its limit');
  assert.equal(meterTone(null), 'unknown');
  assert.equal(meterTone(null, 'warn'), 'warn');
  assert.equal(meterTone(40, 'warn'), 'warn', 'the engine warned itself');
});

test('ring: the week outside, the 5 hours inside; a second limit of the same account never takes the place', () => {
  const claude = ringWindows([win('five_hour', 12), win('seven_day', 38), win('seven_day_opus', 50)]);
  assert.equal(claude.outer?.id, 'seven_day');
  assert.equal(claude.inner?.id, 'five_hour');
  const codex = ringWindows([win('codex:300', 93), win('codex:10080', 78), win('gpt-5-codex-spark:300', 10), win('gpt-5-codex-spark:10080', 5)]);
  assert.equal(codex.outer?.id, 'codex:10080');
  assert.equal(codex.inner?.id, 'codex:300');
  const onlyFive = ringWindows([win('five_hour', 20)]);
  assert.equal(onlyFive.outer?.id, 'five_hour', 'without a week the one window is the ring');
  assert.equal(onlyFive.inner, null);
  assert.deepEqual(ringWindows([]), { outer: null, inner: null });
});

test('initials: one letter, two where names start alike', () => {
  assert.deepEqual(monograms(['Claude', 'Codex', 'Groq']), ['Cl', 'Co', 'G']);
  assert.deepEqual(monograms(['Claude', 'Groq']), ['C', 'G']);
  assert.deepEqual(monograms(['ollama']), ['O']);
});

test('one plain sentence: what is left and when it is full again', () => {
  // Thursday 12 November 09:00: within the week, so the weekday and the time.
  assert.equal(leftSentence(win('seven_day', 38, at(2026, 11, 12, 9)), NOW, L), 'Nog 62%, weer vol om do 09:00.');
  assert.equal(leftSentence(win('five_hour', 12, at(2026, 11, 9, 17, 30)), NOW, L), 'Nog 88%, weer vol om 17:30.', 'today: the time');
  assert.equal(leftSentence(win('seven_day', 10, at(2026, 11, 20, 9)), NOW, L), 'Nog 90%, weer vol op 20 nov.', 'later: the date');
  assert.equal(leftSentence(win('seven_day', 100, at(2026, 11, 9, 18)), NOW, L), 'Op, weer vol om 18:00.');
  assert.equal(leftSentence(win('seven_day', 40, at(2026, 11, 9, 18), 'limit'), NOW, L), 'Op, weer vol om 18:00.', 'the engine refused: op');
  assert.equal(leftSentence(win('seven_day', null), NOW, L), 'Nog niet gemeld.');
  assert.equal(leftSentence(win('seven_day', 30, null, 'ok', true), NOW, L), 'Nog ≈ 70%.', 'an estimate says so');
  assert.equal(blockedSentence(null, NOW, L), 'Op.');
});

test('free and local sources: a ring only from real numbers; "op" is a full red ring', () => {
  const ok = { label: 'Groq', status: 'available' as const, resetsAt: null };
  assert.deepEqual(sourceRing(ok, NOW), { value: null, tone: 'calm', dashed: false });
  assert.equal(sourceLine(ok, NOW, L), 'Beschikbaar.');
  const gone = { label: 'Kilo', status: 'limited' as const, resetsAt: at(2026, 11, 9, 16) };
  assert.deepEqual(sourceRing(gone, NOW), { value: 100, tone: 'danger', dashed: false });
  assert.equal(sourceLine(gone, NOW, L), 'Op, weer vol om 16:00.');
  // Its reset has passed: available again.
  assert.deepEqual(sourceRing({ ...gone, resetsAt: NOW - 1 }, NOW).tone, 'calm');
  const low = { label: 'Groq', status: 'low' as const, resetsAt: at(2026, 11, 9, 17), usedPercent: 82 };
  assert.deepEqual(sourceRing(low, NOW), { value: 82, tone: 'warn', dashed: false });
  assert.equal(sourceLine(low, NOW, L), 'Nog 18%, weer vol om 17:00.');
  assert.deepEqual(sourceRing({ label: 'X', status: 'offline', resetsAt: null }, NOW), { value: null, tone: 'unknown', dashed: true });
  assert.equal(sourceLine({ label: 'X', status: 'offline', resetsAt: null }, NOW, L), 'Niet bereikbaar.');
});

test('the items: engines first with both rings, a blocked engine red, sources after, initials and words for the button', () => {
  const engines: MeterEngine[] = [
    { providerId: 'p1', name: 'Claude Code', family: 'claude', plan: 'Max', windows: [win('five_hour', 12, at(2026, 11, 9, 17)), win('seven_day', 38, at(2026, 11, 12, 9))], blocked: null },
    { providerId: 'p2', name: 'Codex', family: 'codex', plan: null, windows: [win('codex:300', 93, at(2026, 11, 9, 15), 'warn'), win('codex:10080', 78, at(2026, 11, 12, 17), 'warn')], blocked: null },
    { providerId: 'p3', name: 'Werk-Claude', family: 'other', plan: null, windows: [], blocked: { until: at(2026, 11, 9, 19) } },
  ];
  const items = meterItems({ engines, sources: [{ id: 'groq', label: 'Groq', status: 'available', resetsAt: null, kind: 'free' }] }, NOW, L);
  assert.deepEqual(
    items.map((i) => [i.name, i.mono, i.outer.tone, i.inner?.tone || null]),
    [
      ['Claude', 'Cl', 'calm', 'calm'],
      ['Codex', 'Co', 'warn', 'danger'],
      ['Werk-Claude', 'W', 'danger', null],
      ['Groq', 'G', 'calm', null],
    ],
  );
  assert.deepEqual(items.map((i) => i.mark), ['claude', 'codex', 'claude', 'groq'], 'Claude by its family, "Werk-Claude" by its name; Codex and Groq their own glyph');
  assert.equal(items[0].lines.map((l) => `${l.name}: ${l.sentence}`).join(' | '), 'Week: Nog 62%, weer vol om do 09:00. | 5 uur: Nog 88%, weer vol om 17:00.');
  assert.equal(items[1].summary, 'Codex nog 22%');
  assert.equal(items[2].lines[0].sentence, 'Op, weer vol om 19:00.');
  assert.equal(items[2].summary, 'Werk-Claude op');
  assert.equal(items[3].sub, 'Gratis');
  assert.equal(items[3].summary, 'Groq beschikbaar');
  assert.equal(meterWorst(items), 'danger');
  assert.equal(meterWorst(items.slice(0, 1)), 'calm');
});
