import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerError } from '../server/modules/voice/providers.js';
import { classifyError } from '../server/modules/routines/engine.js';

const res = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

test('voice provider errors: known causes in plain Dutch, without the English text or a piece of the key', async () => {
  const e401 = await providerError(res(401, { error: { message: 'Incorrect API key provided: sk-proj-************************7890. You can find your API key at https://platform.openai.com/account/api-keys.' } }), 'Voorlezen via OpenAI');
  assert.equal(e401.status, 400);
  assert.match(e401.message, /^Voorlezen via OpenAI: de sleutel wordt geweigerd/);
  assert.doesNotMatch(e401.message, /Incorrect|7890|platform\.openai/);
  assert.equal(classifyError(e401.message), 'entitlement', 'a routine still sees a key problem');
  const e429 = await providerError(res(429, { error: { message: 'You exceeded your current quota' } }), 'Spraakherkenning via OpenAI');
  assert.equal(e429.status, 429);
  assert.equal(e429.message, 'Spraakherkenning via OpenAI: limiet bereikt of tegoed op (429)');
  assert.match((await providerError(res(404, { error: { message: 'The model `x` does not exist' } }), 'Voorlezen via X')).message, /bestaat niet \(404\)$/);
  // Unknown causes keep the provider's (shortened) text, with keys masked.
  const e500 = await providerError(res(500, 'upstream boom with sk-abcdefghijklmnop'), 'Voorlezen via X');
  assert.equal(e500.status, 502);
  assert.equal(e500.message, 'Voorlezen via X: 500 upstream boom with sk-…');
});
