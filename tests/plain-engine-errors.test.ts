import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crashDetail, plainEngineError, plainError, plainErrorKind, plainStepDetail } from '../server/agent/fallback.js';
import { ProviderError } from '../server/providers/common.js';
import { startTestApp } from './helpers.js';

// Q-03: the engines' own English error texts become one plain sentence with what to do.
const NOW = Date.parse('2026-11-07T10:00:00Z');
const english = /\b(error|limit reached|please|failed|not found|cancelled|unauthorized|overloaded|usage)\b/i;

const CASES: [string, string, RegExp][] = [
  // [engine text as recorded, expected kind, expected plain text]
  ['Error: Free usage limit reached. Please wait or upgrade to continue.', 'limit', /^De gratis limiet van OpenCode is bereikt\. Probeer het later opnieuw of kies een ander model\.$/],
  [`Claude AI usage limit reached|${Math.floor((NOW + 4 * 3600_000) / 1000)}`, 'limit', /^OpenCode heeft zijn gebruikslimiet bereikt \(weer beschikbaar rond \d\d:\d\d\)\./],
  ["You've hit your usage limit. Upgrade to Pro or try again in 2 hours 5 minutes.", 'limit', /gebruikslimiet bereikt \(weer beschikbaar rond/],
  ['API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}', 'limit', /gebruikslimiet/],
  ['Invalid API key · Please run /login', 'auth', /^OpenCode is niet \(meer\) ingelogd of de sleutel klopt niet\./],
  ['OAuth token has expired. Please obtain a new token or refresh your existing token.', 'auth', /niet \(meer\) ingelogd/],
  ['ProviderModelNotFoundError: Model not found: opencode/oud-model', 'model', /^OpenCode kent dit model niet \(meer\)\. Kies een ander model/],
  // Recorded live from Claude Code 2.1.319 with an unknown model (round 4).
  ["There's an issue with the selected model (claude-bestaat-niet-9). It may not exist or you may not have access to it. Run --model to pick a different model.", 'model', /^OpenCode kent dit model niet \(meer\)/],
  ['spawn claude ENOENT', 'missing', /^OpenCode is niet gevonden op deze computer\./],
  ["'codex' is not recognized as an internal or external command", 'missing', /niet gevonden op deze computer/],
  ['getaddrinfo ENOTFOUND api.anthropic.com', 'network', /^Geen verbinding met OpenCode\. Controleer je internetverbinding/],
  ['stream error: error sending request for url (https://chatgpt.com/backend-api/codex/responses)', 'network', /Geen verbinding/],
  ['API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 'outage', /^OpenCode is even overbelast/],
  // Node's fetch when the connection breaks off mid-stream (seen live in round 5 as the whole error text in the chat).
  ['terminated', 'cut', /^De verbinding met OpenCode brak halverwege het antwoord af\. Probeer het opnieuw\.$/],
  ['TypeError: terminated', 'cut', /halverwege het antwoord af/],
  ['SocketError: other side closed', 'cut', /halverwege het antwoord af/],
];

test('common engine error texts map to plain Dutch with what to do', () => {
  for (const [raw, kind, want] of CASES) {
    assert.equal(plainErrorKind(raw), kind, raw);
    const out = plainEngineError(raw, { engine: 'OpenCode', now: NOW, tz: 'Europe/Amsterdam' });
    assert.match(out, want, raw);
    assert.doesNotMatch(out, english, `no English left: ${out}`);
  }
});

test('unknown texts and TeamBot\'s own Dutch messages stay as they are', () => {
  for (const raw of [
    'Claude Code is niet gevonden op deze computer. Installeer de CLI of stel het pad in via Instellingen › Meer mogelijkheden › AI-programma’s.',
    'De CLI is niet (meer) ingelogd. Log zelf in met: claude auth login',
    'Maximum van 500 berichten in dit gesprek',
    'Something unusual happened in step 4',
  ])
    assert.equal(plainEngineError(raw, { engine: 'X' }), raw);
  // A login command TeamBot found stays in the sentence.
  assert.equal(plainEngineError('OpenCode vraagt om in te loggen. Log zelf in met: opencode auth login. Details: 401 Unauthorized', { engine: 'OpenCode' }), 'OpenCode is niet (meer) ingelogd. Log zelf in met: opencode auth login');
});

test('a CLI that stopped unexpectedly: a plain sentence with what to do, the exit code only behind Details (Q-03)', () => {
  const raw = 'Claude Code stopte onverwacht (exitcode 3). Laatste uitvoer: boom';
  assert.equal(plainErrorKind(raw), 'crash');
  const out = plainEngineError(raw, { engine: 'Claude Code' });
  assert.equal(out, 'Claude Code stopte onverwacht. Probeer het opnieuw. Gebeurt het weer, kijk dan bij Instellingen › Meer mogelijkheden › AI-programma’s of Claude Code nog werkt, of kies een andere engine voor deze bot.');
  assert.doesNotMatch(out, /exitcode|\d/);
  assert.equal(crashDetail(raw), raw);
  assert.equal(crashDetail(new Error('Codex stopte onverwacht.')), 'Codex stopte onverwacht.');
  // A limit or a login in the program's last output says more than "stopped": that sentence wins, without details.
  const limited = 'Claude Code stopte onverwacht (exitcode 1). Laatste uitvoer: Claude AI usage limit reached';
  assert.equal(plainErrorKind(limited), 'limit');
  assert.equal(crashDetail(limited), undefined);
  assert.equal(crashDetail('getaddrinfo ENOTFOUND api.example.com'), undefined);
});

test('API errors use their category; failed step details become plain only when short and known', () => {
  const e = new ProviderError('OpenAI: 401 Sleutel ongeldig of verlopen — Incorrect API key provided: sk-abc', 401, false, '', 'auth');
  assert.match(plainError(e, { engine: 'OpenAI' }), /^OpenAI: Sleutel ongeldig of verlopen\. Maak een nieuwe API-sleutel aan en plak hem opnieuw/);
  const r = new ProviderError('x', 429, true, '', 'rate_limit');
  r.retryAfter = 20;
  assert.match(plainError(r, { engine: 'Groq' }), /Limiet bereikt.*Opnieuw mogelijk over 20 s\.$/);
  assert.equal(plainStepDetail('Web search cancelled'), 'Afgebroken voordat het klaar was.');
  assert.match(plainStepDetail('fetch failed')!, /^Geen verbinding met De dienst/);
  const output = 'Traceback (most recent call last):\n  File "x.py", line 1\nNameError: name foo is not defined';
  assert.equal(plainStepDetail(output), output, 'real command output is left alone');
});

test('a failing engine shows the plain sentence in the chat; the raw text stays in the run', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent({ name: 'Foutje' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ error: { message: 'getaddrinfo ENOTFOUND api.example.com', status: 0 } });
    const msgs = await t.say(th.id, 'Hallo');
    const m = msgs.filter((x: any) => x.role === 'assistant').pop();
    assert.equal(m.status, 'error');
    assert.match(m.parts.error, /^Geen verbinding met .+\. Controleer je internetverbinding en probeer het opnieuw\.$/);
    const run = t.app.ctx.store.one<any>('SELECT error FROM runs WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1', th.id);
    assert.match(String(run?.error || ''), /ENOTFOUND/, 'diagnosis keeps the engine text');
  } finally {
    await t.close();
  }
});
