import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineChipNote, messageCostText, missingEnginesText } from '../ui/src/lib/costLabel.js';

/** Cost labels in the chat: who pays for the engine, and what an answer cost. */

test('engine chip: free CLI engines say "gratis", subscriptions "abonnement", paid APIs "eigen sleutel" with the model', () => {
  assert.deepEqual(engineChipNote('', { kind: 'opencode', type: 'cli', billing: 'free' }), { text: 'gratis', free: true });
  assert.deepEqual(engineChipNote('', { kind: 'claude-code', type: 'cli', billing: 'subscription' }), { text: 'abonnement', free: true });
  assert.deepEqual(engineChipNote('', { kind: 'codex-cli', type: 'cli' }), { text: 'abonnement', free: true });
  assert.deepEqual(engineChipNote('', { kind: 'ollama', type: 'api', billing: 'local' }), { text: 'gratis', free: true });
  // The route is always named (acceptance round 3, C-10: "OpenAI (API) · gpt-6-luna" did not say who pays).
  assert.deepEqual(engineChipNote('gpt-5.4-mini', { kind: 'openai', type: 'api', billing: 'paid' }), { text: 'eigen sleutel · gpt-5.4-mini', free: false, label: 'eigen sleutel', model: 'gpt-5.4-mini' });
  assert.deepEqual(engineChipNote('', { kind: 'openai', type: 'api', config: { defaultModel: 'gpt-5.5' } }), { text: 'eigen sleutel · gpt-5.5', free: false, label: 'eigen sleutel', model: 'gpt-5.5' });
  assert.deepEqual(engineChipNote('', { kind: 'openai-compatible', type: 'api' }), { text: 'eigen sleutel', free: false, label: 'eigen sleutel', model: undefined });
  // A member on the admin's shared provider (round 5, C-12: the header said "eigen sleutel"); the owner keeps "eigen".
  assert.deepEqual(engineChipNote('team-mini', { kind: 'openai-compatible', type: 'api', shared: true, own: false }), { text: 'gedeelde sleutel · team-mini', free: false, label: 'gedeelde sleutel', model: 'team-mini' });
  assert.deepEqual(engineChipNote('', { kind: 'openai', type: 'api', shared: true, own: false }), { text: 'gedeelde sleutel', free: false, label: 'gedeelde sleutel', model: undefined });
  // The label is shown translated and the model name never (round 5, C-15: the chip was translate=no, so "eigen
  // sleutel" stayed Dutch in English): label and model come apart.
  assert.deepEqual(engineChipNote('team-mini', { kind: 'openai-compatible', type: 'api', shared: true, own: true }), { text: 'eigen sleutel · team-mini', free: false, label: 'eigen sleutel', model: 'team-mini' });
});

test('answer cost: paid in dollars, subscription with an estimate, otherwise just tokens', () => {
  assert.equal(messageCostText(null), '');
  // Acceptance round 4 (C-17): money in the reader's notation, not "$0.24" in Dutch and German.
  const nbsp = (s: string) => s.replace(/ /g, ' ');
  assert.equal(nbsp(messageCostText({ input: 1000, output: 234, cost: 0.0123 }, 'nl-NL')), '1.234 tokens · US$ 0,0123');
  // Claude Code on a subscription: cost 0, value = the same tokens at API prices.
  assert.equal(nbsp(messageCostText({ input: 53005, output: 666, cost: 0, value: 0.2390212 }, 'nl-NL')), '53.671 tokens · via abonnement (≈ US$ 0,24)');
  assert.equal(nbsp(messageCostText({ input: 53005, output: 666, cost: 0, value: 0.2390212 }, 'de-DE')), '53.671 tokens · via abonnement (≈ 0,24 $)');
  assert.equal(messageCostText({ input: 53005, output: 666, cost: 0, value: 0.2390212 }, 'en-US'), '53,671 tokens · via abonnement (≈ $0.24)');
  assert.equal(messageCostText({ input: 12000, output: 898, cost: 0, value: null }, 'nl-NL'), '12.898 tokens');
});

// Acceptance A-01: the welcome screen names the main engines that are missing or logged out instead of leaving them out.
test('welcome: main engines that are not found or not logged in are named, others are not', () => {
  const k = (id: string, label: string, type: 'api' | 'cli', installed: boolean, loggedIn?: boolean) => ({ id, label, type, status: { installed, loggedIn } });
  const all = [k('claude-code', 'Claude Code', 'cli', true, true), k('codex-cli', 'OpenAI Codex CLI', 'cli', true, true), k('opencode', 'OpenCode', 'cli', true, true), k('ollama', 'Ollama (lokaal)', 'api', true), k('gemini-cli', 'Gemini CLI', 'cli', false)];
  assert.equal(missingEnginesText(all), '', 'all four found: nothing to say (Gemini CLI is not one of the main engines)');
  const some = [k('claude-code', 'Claude Code', 'cli', true, false), k('codex-cli', 'OpenAI Codex CLI', 'cli', false), k('opencode', 'OpenCode', 'cli', true, true), k('ollama', 'Ollama (lokaal)', 'api', false)];
  assert.equal(missingEnginesText(some), 'Claude Code staat op deze pc, maar is niet ingelogd. Niet gevonden: OpenAI Codex CLI, Ollama.');
});
