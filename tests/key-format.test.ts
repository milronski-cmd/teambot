// "Ik heb een API-sleutel" (TeamBot 0.4.2): the service of a pasted key from its format alone, and what the first
// screen says when it is not a usable key (never a Claude subscription login: docs/PROVIDER_POLICY.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanKey, guessKey, keyNoteText } from '../ui/src/pages/welcome/keyFormat.js';

const x = (n: number, c = 'a') => c.repeat(n);

test('one prefix, one service', () => {
  const cases: [string, string][] = [
    [`sk-ant-api03-${x(80, 'A')}`, 'anthropic'],
    [`sk-or-v1-${x(64, 'b')}`, 'openrouter'],
    [`sk-proj-${x(120, 'C')}`, 'openai'],
    [`sk-svcacct-${x(60, 'd')}`, 'openai'],
    [`gsk_${x(52, 'E')}`, 'groq'],
    [`AIza${x(35, 'F')}`, 'google'],
    [`xai-${x(80, 'g')}`, 'xai'],
    [`csk-${x(48, 'h')}`, 'cerebras'],
    [`nvapi-${x(64, 'i')}`, 'nvidia'],
    [`fw_${x(24, 'j')}`, 'fireworks'],
    [`hf_${x(34, 'k')}`, 'huggingface'],
    [`pplx-${x(48, 'l')}`, 'perplexity'],
    [`tgp_v1_${x(43, 'm')}`, 'together'],
    [`sk-${x(20, 'Z')}T3BlbkFJ${x(20, 'Y')}`, 'openai'],
    [`${x(32, 'a')}.${x(16, 'B')}`, 'zai'],
  ];
  for (const [key, kind] of cases) assert.deepEqual(guessKey(key), { kinds: [kind] }, key.slice(0, 12));
});

test('shared shapes give the candidates in the order to try them', () => {
  assert.deepEqual(guessKey(`sk-${'0123456789abcdef'.repeat(2)}`).kinds, ['deepseek', 'qwen', 'moonshot']);
  assert.deepEqual(guessKey(`sk-${x(48, 'Q')}`).kinds, ['moonshot', 'openai']);
  assert.deepEqual(guessKey(`sk-${x(30, 'Q')}-_x`).kinds[0], 'openai');
  assert.deepEqual(guessKey(x(32, 'R')).kinds, ['mistral', 'deepinfra']);
  assert.deepEqual(guessKey('ab12'.repeat(16)).kinds, ['together']);
  assert.deepEqual(guessKey(`eyJ${x(20)}.${x(40)}.${x(30)}`).kinds, ['minimax']);
});

test('pasted with spaces, quotes, a line end or "Bearer": the key itself counts', () => {
  const key = `sk-ant-api03-${x(80, 'A')}`;
  assert.equal(cleanKey(`  "${key}"\r\n`), key);
  assert.equal(cleanKey(`Bearer ${key}`), key);
  assert.deepEqual(guessKey(` '${key}' `), { kinds: ['anthropic'] });
});

test('a Claude subscription login is never taken as a key; admin keys and unknown text are refused with a reason', () => {
  for (const k of [`sk-ant-oat01-${x(90, 'A')}`, `sk-ant-ort01-${x(90, 'A')}`]) {
    const g = guessKey(k);
    assert.deepEqual(g, { kinds: [], note: 'claude-login' });
    assert.match(keyNoteText(g.note)!, /Claude-abonnement, geen API-sleutel/);
  }
  assert.deepEqual(guessKey(`sk-ant-admin01-${x(80, 'A')}`), { kinds: [], note: 'admin' });
  assert.deepEqual(guessKey(`sk-admin-${x(40, 'A')}`), { kinds: [], note: 'admin' });
  assert.deepEqual(guessKey('mijn wachtwoord is geheim'), { kinds: [], note: 'unknown' });
  assert.deepEqual(guessKey('sk-'), { kinds: [], note: 'short' });
  assert.deepEqual(guessKey(''), { kinds: [], note: 'unknown' });
  assert.equal(keyNoteText(undefined), null);
});
