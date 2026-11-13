// Tool calls that free and local models write as text (TeamBot 0.4.4): Qwen's <tool_call>{…}</tool_call>, the
// Qwen3-Coder form <function=…><parameter=…> (ported from Ollama's qwen3coder.go, MIT), slightly broken argument JSON
// (jsonrepair), and the full JSON-schema check of the arguments (@cfworker/json-schema). Fixtures in
// tests/fixtures/toolcalls; ads-roas-campagnes.txt is the answer that failed that quality task twice
// (docs/quality/attempts/2026-11-09-ollama-qwen3.6-uncensored-snel-latest-0.4.2/ads-roas-campagnes/_reply.md).
// No test calls Ollama or any other real server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { ChatResult, ToolSpec } from '../server/core/types.js';
import { readTextToolCalls, repairTextToolCalls, toolCallsFromText } from '../server/providers/toolcall-text.js';
import { QwenCallError, readQwenCall, parseValue } from '../server/providers/qwen3coder.js';
import { parseJsonValue, parseToolArgs } from '../server/providers/tool-args.js';
import { checkArgs, coerceArgs, validateArgs } from '../server/tools/schema.js';
import { builtinKinds } from '../server/providers/kinds.js';
import { startTestApp } from './helpers.js';

const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'toolcalls', name), 'utf8');

const TOOLS: ToolSpec[] = [
  { name: 'read_file', description: 'Leest een bestand.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  {
    name: 'write_file',
    description: 'Schrijft een bestand.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['path', 'content'] },
  },
  { name: 'list_dir', description: 'Toont een map.', parameters: { type: 'object', properties: { path: { type: 'string' }, depth: { type: 'integer' }, hidden: { type: 'boolean' } } } },
];
const result = (text: string, stop: ChatResult['stop'] = 'end'): ChatResult => ({ text, toolCalls: [], usage: { input: 1, output: 1 }, stop, model: 'qwen' });

// ------------------------------------------------------------------ Qwen3-Coder XML (port of Ollama's parser)

test('ads-roas-campagnes: the Qwen3-Coder call that stayed text (opening <tool_call> eaten) is now a real read_file call', () => {
  const r = repairTextToolCalls(result(fixture('ads-roas-campagnes.txt')), TOOLS);
  assert.equal(r.stop, 'tool_use');
  assert.equal(r.text, '', 'no raw markup left as the answer');
  assert.deepEqual(
    r.toolCalls.map((c) => [c.name, c.args]),
    [['read_file', { path: 'campagnes.csv' }]],
  );
  assert.match(r.toolCalls[0].id, /^call_text_/);
});

test('Qwen3-Coder: a sentence before a wrapped call stays as text; several calls, values typed along the schema', () => {
  const prose = readTextToolCalls(fixture('qwen-prose-wrapped.txt'), TOOLS);
  assert.ok(prose && 'calls' in prose);
  assert.equal(prose.prose, 'Ik lees eerst de campagnes in.');
  assert.deepEqual(prose.calls[0].args, { path: 'campagnes.csv' });

  const two = toolCallsFromText(fixture('qwen-two-calls-typed.txt'), TOOLS)!;
  assert.deepEqual(
    two.map((c) => c.name),
    ['list_dir', 'write_file'],
  );
  assert.deepEqual(two[0].args, { path: '.', depth: 2, hidden: false }, 'integer and boolean from the schema');
  assert.deepEqual(two[1].args.tags, ['ads', 'roas'], 'array parsed as JSON');
  const content = two[1].args.content.replace(/\r\n/g, '\n');
  assert.match(content, /"<\/function>" and "<\/tool_call>" in a value are text/, 'only </parameter> ends a value');
  assert.ok(content.startsWith('def roas(') && content.endsWith('else None'), 'one leading and one trailing newline dropped');
});

test('Qwen3-Coder: Ollama test cases (literal </function>, &, < >, unicode, typed values)', () => {
  const read = (raw: string) => readQwenCall(raw, 0).call;
  assert.deepEqual(read('<function=write><parameter=content>text = "</function>"</parameter></function>'), { name: 'write', args: { content: 'text = "</function>"' } });
  assert.deepEqual(read('<function=get_current_temperature>\n<parameter=location>\nSan Francisco\n</parameter>\n<parameter=unit>\ncelsius\n</parameter>\n</function>'), {
    name: 'get_current_temperature',
    args: { location: 'San Francisco', unit: 'celsius' },
  });
  assert.deepEqual(read('<function=exec>\n<parameter=command>\nls && echo "a > b and a < b"\n</parameter>\n</function>').args, { command: 'ls && echo "a > b and a < b"' });
  assert.deepEqual(read('<function=获取天气>\n<parameter=城市>\n北京\n</parameter>\n</function>'), { name: '获取天气', args: { 城市: '北京' } });
  assert.equal(parseValue('\n3.14\n', ['number']), 3.14);
  assert.equal(parseValue('42', ['integer']), 42);
  assert.equal(parseValue('true', ['boolean']), true);
  assert.equal(parseValue('null', ['string']), null, 'null first, as in Ollama');
  assert.equal(parseValue('123', ['string', 'number']), 123, 'union: the most specific type that parses');
  assert.equal(parseValue('hello', ['string', 'number']), 'hello');
  assert.equal(parseValue('yes', ['boolean']), 'yes', 'an invalid boolean stays text (Ollama: false) so the schema check names it');
  assert.deepEqual(parseValue("['a', 'b',]", ['array']), ['a', 'b'], 'slightly broken JSON in an array value is repaired');
});

test('Qwen3-Coder: malformed calls are refused (Ollama rejection cases plus stricter ones), never run', () => {
  for (const raw of [
    "<function=write><parameter=content>print('ok')</function>",
    "<function=write><parameter=content>print('ok')</parameter=content></function>",
    '<function=write><parameter=content>text = "</function>"</parameter>',
    '<function=edit>\n<parameter=path>src/orders.py</parameter>\n<parameter=edits>\n<parameter=oldText>before</parameter>\n<parameter=newText>after</parameter>\n</function>',
    '<function=write>stray text<parameter=content>x</parameter></function>',
    '<function=write></parameter></function>',
  ])
    assert.throws(() => readQwenCall(raw, 0), QwenCallError, raw);

  const bad = repairTextToolCalls(result(fixture('qwen-unclosed-parameter.txt')), TOOLS);
  assert.equal(bad.toolCalls.length, 1, 'one call back that the tool gate refuses');
  assert.equal(bad.toolCalls[0].name, 'write_file');
  assert.match(bad.toolCalls[0].args.__invalid_call, /^INVALID_TOOL_CALL: .*niet afgesloten met <\/parameter>.*Er is niets uitgevoerd/);
  assert.equal(bad.stop, 'tool_use', 'the run goes on, so the model can correct itself');
});

test('only tools that were offered: an unknown name in markup gets a correction with the tools that exist', () => {
  const r = repairTextToolCalls(result('<tool_call>\n<function=rm_rf>\n<parameter=path>\n/\n</parameter>\n</function>\n</tool_call>'), TOOLS);
  assert.equal(r.toolCalls[0].name, 'rm_rf');
  assert.match(r.toolCalls[0].args.__invalid_call, /de tool "rm_rf" bestaat hier niet.*Beschikbare tools: read_file, write_file, list_dir/);
  const odd = repairTextToolCalls(result('<function=get current temperature>\n<parameter=x>\n1\n</parameter>\n</function>'), TOOLS);
  assert.equal(odd.toolCalls[0].name, 'tool_call', 'a name that is no valid tool name is never sent back to the provider');
  // Bare JSON without markup that names no offered tool may be a plain answer: it stays text, as before.
  assert.deepEqual(repairTextToolCalls(result('{"name": "rm_rf", "arguments": {}}'), TOOLS).toolCalls, []);
});

test('stays text: prose after a call, an example in a code block, a cut-off answer is never completed', () => {
  assert.equal(readTextToolCalls('<tool_call>\n<function=read_file>\n<parameter=path>\na\n</parameter>\n</function>\n</tool_call>\nDaarna schrijf ik het verslag.', TOOLS), null);
  assert.equal(readTextToolCalls('Zo ziet het eruit:\n```\n<function=read_file><parameter=path>a</parameter></function>\n```', TOOLS), null);
  assert.equal(readTextToolCalls('<function=read_file><parameter=path>a</parameter></function>', []), null, 'no tools offered');
  const cut = repairTextToolCalls(result('<tool_call>\n<function=write_file>\n<parameter=path>\na.txt\n</parameter>\n<parameter=content>\nhalf', 'max_tokens'), TOOLS);
  assert.match(cut.toolCalls[0].args.__invalid_call, /tokenlimiet|niet afgesloten/);
});

// ------------------------------------------------------------------ JSON calls and broken argument JSON

test('JSON in <tool_call>: Qwen 2.5 form, broken JSON repaired, cut-off JSON never repaired', () => {
  assert.deepEqual(toolCallsFromText('<tool_call>\n{"name": "read_file", "arguments": {"path": "a.csv"}}\n</tool_call>', TOOLS)![0].args, { path: 'a.csv' });
  assert.deepEqual(toolCallsFromText('{"name": "read_file", "arguments": {"path": "a.csv"}}\n</tool_call>', TOOLS)![0].args, { path: 'a.csv' }, 'only the closing tag left');
  assert.deepEqual(toolCallsFromText(fixture('json-broken-args.txt'), TOOLS)![0].args, { path: 'campagnes.csv' }, 'single quotes, comment, trailing comma');
  assert.deepEqual(toolCallsFromText('{"name": "read_file", "arguments": "{\'path\': \'b.csv\',}"}', TOOLS)![0].args, { path: 'b.csv' }, 'arguments as a broken JSON string');
  const cut = readTextToolCalls('<tool_call>\n{"name": "write_file", "arguments": {"path": "a.txt", "content": "half', TOOLS);
  assert.ok(cut && 'error' in cut, 'cut-off JSON in markup: a correction, not a completed call');
  assert.equal(toolCallsFromText('{"name": "read_file", "arguments": {"path": "a', TOOLS), null);
});

test('native tool-call arguments: repaired when slightly broken, never completed when cut off', () => {
  assert.deepEqual(parseToolArgs('{"path": "a.txt",}'), { path: 'a.txt' });
  assert.deepEqual(parseToolArgs("{'n': True}"), { n: true });
  assert.deepEqual(parseToolArgs(''), {});
  assert.deepEqual(parseToolArgs('{"content": "half'), { __invalid_json: '{"content": "half' }, 'does not end like JSON: not completed');
  assert.deepEqual(parseToolArgs('{"a": 1,}', true), { __invalid_json: '{"a": 1,}' }, 'the answer stopped at its token limit: no repair');
  assert.equal(parseJsonValue('not json'), undefined);
});

// ------------------------------------------------------------------ full JSON-schema check

const ORDER = {
  type: 'object',
  properties: {
    customer: { type: 'object', properties: { email: { type: 'string', format: 'email' }, tier: { enum: ['gratis', 'pro'] } }, required: ['email'] },
    items: { type: 'array', minItems: 1, items: { $ref: '#/$defs/item' } },
    note: { type: 'string' },
    rush: { type: 'boolean' },
  },
  required: ['customer', 'items'],
  additionalProperties: false,
  $defs: { item: { type: 'object', properties: { sku: { type: 'string' }, qty: { type: 'integer', minimum: 1 } }, required: ['sku', 'qty'] } },
};

test('schema check: nested objects, array items via $ref, enums, ranges, unknown arguments, with the exact place', () => {
  const ok = checkArgs(ORDER, { customer: { email: 'a@b.nl', tier: 'pro' }, items: [{ sku: 'X', qty: '2' }], rush: 'true', note: null });
  assert.equal(ok.error, null);
  assert.deepEqual(ok.args, { customer: { email: 'a@b.nl', tier: 'pro' }, items: [{ sku: 'X', qty: 2 }], rush: true }, '"2" → 2, "true" → true, optional null left out');
  assert.match(checkArgs(ORDER, { customer: { email: 'a@b.nl' }, items: [{ sku: 'X', qty: 'twee' }] }).error!, /Argument items\/0\/qty moet type integer hebben, maar is string/);
  assert.match(checkArgs(ORDER, { customer: { email: 'a@b.nl' }, items: [{ sku: 'X', qty: 0 }] }).error!, /items\/0\/qty past niet in het schema \(minimum\)/);
  assert.match(checkArgs(ORDER, { customer: { email: 'a@b.nl', tier: 'goud' }, items: [{ sku: 'X', qty: 1 }] }).error!, /customer\/tier moet een van deze waarden zijn: \["gratis","pro"\]/);
  assert.match(checkArgs(ORDER, { customer: {}, items: [{ sku: 'X', qty: 1 }] }).error!, /Verplicht argument ontbreekt: customer\/email/);
  assert.match(checkArgs(ORDER, { customer: { email: 'a@b.nl' }, items: [] }).error!, /items past niet in het schema \(minItems\)/);
  assert.match(checkArgs(ORDER, { customer: { email: 'a@b.nl' }, items: [{ sku: 'X', qty: 1 }], kleur: 'rood' }).error!, /Onbekend argument: kleur\. Toegestaan: customer, items, note, rush/);
  assert.equal(checkArgs(ORDER, { customer: { email: 'geen-adres' }, items: [{ sku: 'X', qty: 1 }] }).error, null, 'format is left to the tool');
  assert.equal(checkArgs(ORDER, { customer: { email: 'a@b.nl' }, items: '[{"sku": "X", "qty": "3"}]' }).args.items[0].qty, 3, 'an array written as JSON text');
  assert.equal(JSON.stringify(ORDER).includes('__absolute'), false, "the tool's own schema is never changed (it is also sent to the provider)");
});

test('schema check: the old top-level messages, odd schemas and draft-07 keep working', () => {
  const schema = { type: 'object', properties: { path: { type: 'string' }, n: { type: 'number' } }, required: ['path'] };
  assert.equal(validateArgs(schema, {}), 'Verplicht argument ontbreekt: path');
  assert.match(validateArgs(schema, { path: 1 })!, /Argument path moet type string hebben/);
  assert.equal(validateArgs(schema, { path: 'a', n: '2.5' }), null);
  assert.equal(validateArgs(schema, []), 'Argumenten moeten een object zijn.');
  assert.equal(validateArgs({ type: 'object', properties: { p: { type: 'string', pattern: '(' } } }, { p: 'x' }) === null || true, true, 'a broken pattern never throws');
  assert.equal(validateArgs(undefined, { a: 1 }), null);
  const d7 = { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { list: { type: 'array', items: [{ type: 'string' }, { type: 'number' }] } }, definitions: {} };
  assert.equal(validateArgs(d7, { list: ['a', 1] }), null);
  assert.match(validateArgs(d7, { list: ['a', 'b'] })!, /list\/1 moet type number/);
  assert.deepEqual(coerceArgs({ type: 'object', properties: { x: { anyOf: [{ type: 'integer' }, { type: 'null' }] } } }, { x: null }), { x: null }, 'null kept where the schema allows it');
});

// ------------------------------------------------------------------ end to end: adapter and tool gate

test('OpenAI-compatible adapter (Ollama /v1 without a PARSER): the ads-roas answer becomes a real call', async () => {
  const text = fixture('ads-roas-campagnes.txt');
  const s = http.createServer((rq, res) => {
    rq.resume();
    rq.on('end', () => {
      if (rq.url === '/api/ps') return res.writeHead(200, { 'content-type': 'application/json' }), res.end('{"models":[]}');
      if (rq.url === '/api/show') return res.writeHead(200, { 'content-type': 'application/json' }), res.end('{}');
      // Ollama's native chat (TeamBot sends it a window that fits): the same answer, as NDJSON.
      if (rq.url === '/api/chat') {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(JSON.stringify({ message: { content: text }, done: false }) + '\n');
        return res.end(JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 10 }) + '\n');
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  try {
    for (const kind of ['ollama', 'openai-compatible']) {
      const a = builtinKinds()
        .find((k) => k.id === kind)!
        .create({ id: 'p', user_id: 'u', kind, name: kind, base_url: url + '/v1', secret_id: null, config: {}, enabled: true, shared: false, created_at: '' }, null, {} as any);
      const r = await a.chat!({ model: 'qwen3.6-uncensored-snel:latest', system: 'x', messages: [{ role: 'user', content: 'Bereken de ROAS.' }], tools: TOOLS }, new AbortController().signal, () => {});
      assert.deepEqual(
        r.toolCalls.map((c) => [c.name, c.args]),
        [['read_file', { path: 'campagnes.csv' }]],
        kind,
      );
      assert.equal(r.stop, 'tool_use', kind);
    }
  } finally {
    await new Promise<void>((r) => s.close(() => r()));
  }
});

test('tool gate: an unreadable text call and arguments that do not fit the schema never run; the model reads why', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent({ tool_groups: ['files'] });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push(
      { toolCalls: [{ name: 'write_file', args: { __invalid_call: 'INVALID_TOOL_CALL: test. Er is niets uitgevoerd.' } }] },
      { toolCalls: [{ name: 'write_file', args: { path: 'a.txt', content: 1 } }] },
      { toolCalls: [{ name: 'write_file', args: { path: 'b.txt', content: 'goed' } }] },
      { text: 'Klaar' },
    );
    const msgs = await t.say(th.id, 'schrijf');
    const tools = msgs.filter((m) => m.role === 'tool').map((m) => m.content);
    assert.match(tools[0], /^INVALID_TOOL_CALL: test/);
    assert.match(tools[1], /Argument content moet type string hebben, maar is number\. Roep write_file opnieuw aan/);
    assert.equal(fs.existsSync(path.join(a.workspace, 'a.txt')), false, 'nothing malformed ran');
    assert.equal(fs.readFileSync(path.join(a.workspace, 'b.txt'), 'utf8'), 'goed', 'the corrected call ran');
    assert.equal(msgs[msgs.length - 1].content, 'Klaar');
  } finally {
    await t.close();
  }
});
