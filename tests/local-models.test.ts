// Local models chosen smartly (TeamBot 0.4, package Q): hardware check, "past goed / werkt traag / te groot", the
// cached tool test, the warning when Ollama runs on the processor although there is a video card, downloads, and the
// context-window fitting for LM Studio and llama.cpp. Fixtures are taken from a real pc (9 November 2026: Ryzen 7
// 7800X3D, 64 GB, Radeon RX 7800 XT 16 GB, Ollama 0.40.15) where they could be; no test needs a real local server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { ChatMsg, ChatRequest, ToolSpec } from '../server/core/types.js';
import { builtinKinds } from '../server/providers/kinds.js';
import { cutNotice, kvBytesPerToken, toolCallsFromText } from '../server/providers/localmodels.js';
import { isIntegrated, mergeNvidia, parseNvidiaSmi, parseWindowsGpus, type Hardware } from '../server/modules/local-models/hardware.js';
import { GiB, bestDownload, budget, fitFor, fitLoaded, memoryNeed, pickInstalled, recommend, roomyFor, type Candidate } from '../server/modules/local-models/advice.js';
import { OLLAMA_CATALOG } from '../server/modules/local-models/catalog.js';
import { cpuWarning, parsePs } from '../server/modules/local-models/ollama.js';
import { PROBE_TOOLS, classifyProbe, probePlan, probeThink } from '../server/modules/local-models/probe.js';
import { createLocalModelsModule } from '../server/modules/local-models/index.js';
import { startTestApp } from './helpers.js';

// ------------------------------------------------------------------ fixtures

/** What the PowerShell call returned on the real pc (Win32_VideoController + display-class registry keys). */
const WIN_RAW = {
  controllers: [
    { Name: 'AMD Radeon(TM) Graphics', AdapterRAM: 536870912, DriverVersion: '32.0.21045.5002', PNPDeviceID: 'PCI\\VEN_1002&DEV_164E&SUBSYS_364E1849&REV_CB\\4&16012499&0&0041' },
    { Name: 'AMD Radeon RX 7800 XT', AdapterRAM: 4293918720, DriverVersion: '32.0.31041.1004', PNPDeviceID: 'PCI\\VEN_1002&DEV_747E&SUBSYS_53261849&REV_C8\\6&2AA3B6C0&0&00000009' },
  ],
  registry: [
    { DriverDesc: 'AMD Radeon(TM) Graphics', Qw: 536870912, MatchingDeviceId: 'PCI\\VEN_1002&DEV_164E&SUBSYS_364E1849&REV_CB' },
    { DriverDesc: 'AMD Radeon RX 7800 XT', Qw: 17163091968, MatchingDeviceId: 'PCI\\VEN_1002&DEV_747E&SUBSYS_53261849&REV_C8' },
  ],
};

const hw = (o: Partial<Hardware>): Hardware => ({ platform: 'win32', ram: 16 * GiB, ramFree: 8 * GiB, cpu: 'cpu', cores: 8, gpus: [], unified: false, sources: [], checkedAt: '2026-11-09T00:00:00Z', ...o });
const THIS_PC = hw({ ram: 67704365056, gpus: parseWindowsGpus(WIN_RAW), sources: ['Windows'] });
const GPU8 = hw({ ram: 16 * GiB, gpus: [{ name: 'NVIDIA GeForce RTX 3060 Ti', vendor: 'nvidia', vram: 8 * GiB, exact: true, dedicated: true }] });
const NO_GPU = hw({ ram: 16 * GiB, gpus: [{ name: 'Intel(R) UHD Graphics 620', vendor: 'intel', vram: 1 * GiB, exact: true, dedicated: false }] });
const MAC32 = hw({ platform: 'darwin', ram: 32 * GiB, unified: true, gpus: [{ name: 'Apple silicon', vendor: 'apple', vram: null, exact: false, dedicated: true }] });

/** The real /api/ps of that pc: one model, all of it on the video card. */
const PS_THIS_PC = {
  models: [{ name: 'qwen3.6-uncensored-snel:latest', model: 'qwen3.6-uncensored-snel:latest', size: 14781891214, size_vram: 14781891214, context_length: 16384, expires_at: '2319-02-19T00:47:33+01:00', runner: 'llamacpp' }],
};

const cat = (id: string) => OLLAMA_CATALOG.find((c) => c.id === id)!;
const fitOf = (h: Hardware, id: string) => fitFor(budget(h), memoryNeed({ weights: cat(id).size, kvPerToken: cat(id).kvPerToken })).fit;

// ------------------------------------------------------------------ hardware

test('hardware: real video memory from the driver (AdapterRAM stops at 4 GB); built-in graphics do not count', () => {
  const [igpu, card] = THIS_PC.gpus;
  assert.equal(card.name, 'AMD Radeon RX 7800 XT');
  assert.equal(card.vram, 17163091968, 'the 64-bit registry value, not the 32-bit AdapterRAM');
  assert.equal(card.exact, true);
  assert.equal(card.dedicated, true);
  assert.equal(card.vendor, 'amd');
  assert.equal(igpu.dedicated, false, "the Ryzen's own graphics");
  assert.equal(budget(THIS_PC).gpu?.name, 'AMD Radeon RX 7800 XT');

  // Without the registry value: AdapterRAM, marked as not exact (it is at most 4 GB). Virtual adapters are left out.
  const nv = parseWindowsGpus({
    controllers: { Name: 'NVIDIA GeForce RTX 4070', AdapterRAM: 4293918720, PNPDeviceID: 'PCI\\VEN_10DE&DEV_2786' },
    registry: [],
  });
  assert.deepEqual(nv.map((g) => [g.vendor, g.vram, g.exact, g.dedicated]), [['nvidia', 4293918720, false, true]]);
  assert.equal(parseWindowsGpus({ controllers: [{ Name: 'Microsoft Basic Display Adapter' }, { Name: 'Parsec Virtual Display Adapter' }] }).length, 0);
  // nvidia-smi knows NVIDIA memory exactly and replaces the Windows figure.
  const smi = parseNvidiaSmi('NVIDIA GeForce RTX 4070, 12282, 560.94\r\n');
  assert.deepEqual(smi, [{ name: 'NVIDIA GeForce RTX 4070', vendor: 'nvidia', vram: 12282 * 1024 * 1024, exact: true, dedicated: true, driver: '560.94' }]);
  assert.deepEqual(mergeNvidia(nv, smi), smi);

  for (const [name, vendor, builtIn] of [
    ['AMD Radeon(TM) Graphics', 'amd', true],
    ['AMD Radeon 780M Graphics', 'amd', true],
    ['AMD Radeon RX 7800 XT', 'amd', false],
    ['Intel(R) UHD Graphics 770', 'intel', true],
    ['Intel(R) Arc(TM) Graphics', 'intel', true],
    ['Intel(R) Arc(TM) A770 Graphics', 'intel', false],
    ['Intel(R) Arc(TM) B580 Graphics', 'intel', false],
    ['NVIDIA GeForce RTX 3060', 'nvidia', false],
  ] as const)
    assert.equal(isIntegrated(name, vendor), builtIn, name);
});

// ------------------------------------------------------------------ advice

test('advice: past goed / werkt traag / te groot from the hardware and the model size (16k window)', () => {
  // The real pc: 16 GB card, 64 GB memory.
  assert.equal(fitOf(THIS_PC, 'qwen3:14b'), 'fits');
  assert.equal(fitOf(THIS_PC, 'gpt-oss:20b'), 'fits');
  assert.equal(fitOf(THIS_PC, 'qwen3:30b'), 'slow', '18.6 GB does not fit in 16 GB: part runs on the processor');
  assert.equal(fitOf(THIS_PC, 'qwen3.6:35b'), 'slow');
  assert.equal(fitFor(budget(THIS_PC), 80e9).fit, 'too_big');
  // 8 GB card, 16 GB memory.
  assert.equal(fitOf(GPU8, 'qwen3:8b'), 'fits');
  assert.equal(fitOf(GPU8, 'qwen3:14b'), 'slow');
  assert.equal(fitOf(GPU8, 'qwen3.6:35b'), 'too_big');
  // No video card: everything that fits in memory runs on the processor (slowly); big models do not fit.
  assert.deepEqual(fitFor(budget(NO_GPU), memoryNeed({ weights: cat('qwen3:1.7b').size, kvPerToken: cat('qwen3:1.7b').kvPerToken })), { fit: 'slow', why: 'no_gpu' });
  assert.equal(fitOf(NO_GPU, 'qwen3:14b'), 'too_big');
  // A Mac shares its memory with the GPU.
  assert.equal(fitOf(MAC32, 'qwen3:14b'), 'fits');
  assert.equal(fitOf(MAC32, 'qwen3:30b'), 'slow');
  // The window counts: the same model needs more with a bigger window.
  const m = cat('qwen3:8b');
  assert.ok(memoryNeed({ weights: m.size, kvPerToken: m.kvPerToken, context: 65536 }) > memoryNeed({ weights: m.size, kvPerToken: m.kvPerToken }) + 6 * GiB);
  // What Ollama really loaded beats the estimate.
  assert.deepEqual(fitLoaded(14781891214, 14781891214), { fit: 'fits', why: 'loaded_gpu' });
  assert.deepEqual(fitLoaded(20e9, 12e9), { fit: 'slow', why: 'loaded_partly' });
  // Hybrid models (Qwen3.6): only every 4th layer has a KV cache (from the real /api/show of qwen3.6 35B-A3B).
  const info = { 'general.architecture': 'qwen35moe', 'qwen35moe.block_count': 40, 'qwen35moe.attention.head_count': 16, 'qwen35moe.attention.head_count_kv': 2, 'qwen35moe.attention.key_length': 256, 'qwen35moe.attention.value_length': 256, 'qwen35moe.full_attention_interval': 4 };
  assert.equal(kvBytesPerToken(info), 10 * 2 * 512 * 2);
  assert.equal(kvBytesPerToken(info), cat('qwen3.6:35b').kvPerToken);
});

test('advice: one model for a first bot — on this pc first, the biggest that fits and can use tools', () => {
  const catalog = (h: Hardware): Candidate[] => OLLAMA_CATALOG.map((c) => ({ id: c.id, size: c.size, fit: fitOf(h, c.id), tools: 'unknown', firstBot: c.firstBot }));
  assert.equal(bestDownload(catalog(THIS_PC))?.id, 'qwen3:14b');
  assert.equal(bestDownload(catalog(GPU8))?.id, 'qwen3:8b');
  assert.equal(bestDownload(catalog(NO_GPU))?.id, 'qwen3:1.7b', 'nothing fits: the smallest that works');
  // Nothing installed: the best download.
  assert.deepEqual(recommend([], catalog(THIS_PC)), { id: 'qwen3:14b', installed: false });
  assert.deepEqual(recommend([], catalog(NO_GPU)), { id: 'qwen3:1.7b', installed: false });
  // The real pc: two copies of the same 35B model (a few bytes apart) fit on the card, but only just (15.4 of 16.6 GB
  // by an estimate that is a lower bound). A 22 GB model is slow. Loaded on the card now = used last: that one.
  const installed: Candidate[] = [
    { id: 'hf.co/mradermacher/Qwen3.6-35B-A3B-uncensored-heretic-i1-GGUF:IQ3_XS', size: 14484145728, fit: 'fits', tools: 'unknown', roomy: false },
    { id: 'qwen3.6-uncensored-snel:latest', size: 14484145455, fit: 'fits', tools: 'unknown', loaded: true, roomy: false },
    { id: 'qwen3.6-uncensored:latest', size: 22136431163, fit: 'slow', tools: 'unknown' },
  ];
  assert.deepEqual(recommend(installed, catalog(THIS_PC)), { id: 'qwen3.6-uncensored-snel:latest', installed: true });
  assert.equal(pickInstalled(installed)?.id, 'qwen3.6-uncensored-snel:latest');
  // Not loaded (acceptance 12 Nov: connecting Ollama took the 34.7B model): a model that fits with room to spare, a
  // good all-rounder first. With only the big ones installed: a download that fits well is the advice, and a
  // connection starts on the smallest installed one that runs.
  const cold = installed.map((c) => ({ ...c, loaded: false }));
  const small: Candidate = { id: 'qwen3:1.7b', size: 1359292957, fit: 'fits', tools: 'unknown', firstBot: true, roomy: roomyFor(budget(THIS_PC), memoryNeed({ weights: 1359292957, kvPerToken: 114688 })) };
  assert.equal(small.roomy, true);
  assert.equal(roomyFor(budget(THIS_PC), memoryNeed({ weights: 14484145455, kvPerToken: 20480 })), false, 'the 35B model fills the card to the brim');
  assert.deepEqual(recommend([...cold, small], catalog(THIS_PC)), { id: 'qwen3:1.7b', installed: true });
  assert.equal(pickInstalled([...cold, small])?.id, 'qwen3:1.7b');
  assert.deepEqual(recommend(cold, catalog(THIS_PC)), { id: 'qwen3:14b', installed: false });
  assert.equal(pickInstalled(cold)?.id, 'qwen3.6-uncensored-snel:latest', 'nothing runs well: the smallest that runs, the plain Ollama name');
  // Two that fit with room: the all-rounder from the list goes before a bigger unknown model; else the biggest.
  const coder: Candidate = { id: 'some-coder:7b', size: 4.7e9, fit: 'fits', tools: 'yes', roomy: true };
  assert.equal(pickInstalled([coder, small])?.id, 'qwen3:1.7b');
  assert.equal(pickInstalled([coder, { ...small, firstBot: false }])?.id, 'some-coder:7b');
  // A model that cannot use tools is never advised; a model that is only slow gives way to a download that fits.
  assert.deepEqual(recommend([{ id: 'gemma:2b', size: 1.7e9, fit: 'fits', tools: 'no' }], catalog(THIS_PC)), { id: 'qwen3:14b', installed: false });
  assert.deepEqual(recommend([installed[2]], catalog(THIS_PC)), { id: 'qwen3:14b', installed: false });
  // Only slow models anywhere (no video card): the installed one, no download needed.
  assert.deepEqual(recommend([{ id: 'qwen3:4b', size: 2.5e9, fit: 'slow', tools: 'yes' }], catalog(NO_GPU)), { id: 'qwen3:4b', installed: true });
});

// ------------------------------------------------------------------ warning: Ollama on the processor

test('GPU warning: Ollama runs a model 100% on the processor while the pc has a video card (fixture /api/ps)', () => {
  assert.equal(cpuWarning(parsePs(PS_THIS_PC), THIS_PC), null, 'all of it on the card: fine');
  const cpu = parsePs({ models: [{ name: 'qwen3:8b', size: 6_000_000_000, size_vram: 0, context_length: 4096 }] });
  assert.deepEqual(cpuWarning(cpu, THIS_PC), { model: 'qwen3:8b', gpu: 'AMD Radeon RX 7800 XT', vendor: 'amd', driverUrl: 'https://www.amd.com/en/support/download/drivers.html' });
  assert.equal(cpuWarning(cpu, GPU8)?.driverUrl, 'https://www.nvidia.com/Download/index.aspx');
  assert.equal(cpuWarning(cpu, NO_GPU), null, 'no video card: the processor is all there is');
  assert.equal(cpuWarning(cpu, MAC32), null, 'Apple silicon: Ollama always uses the GPU');
  assert.equal(cpuWarning(cpu, null), null, 'hardware unknown: say nothing');
  // Partly on the card = too big for it, not a driver problem; a second model on the processor next to one on the
  // card found the card full.
  assert.equal(cpuWarning(parsePs({ models: [{ name: 'qwen3:30b', size: 20e9, size_vram: 14e9 }] }), THIS_PC), null);
  assert.equal(cpuWarning(parsePs({ models: [...PS_THIS_PC.models, { name: 'qwen3:1.7b', size: 1.9e9, size_vram: 0 }] }), THIS_PC), null);
});

// ------------------------------------------------------------------ the tool test

test('tool test: tools werken / alleen tekst / onbetrouwbaar, and how it runs without disturbing a loaded model', () => {
  const r = (o: any) => ({ text: '', toolCalls: [], usage: { input: 0, output: 0 }, stop: 'end' as const, ...o });
  assert.deepEqual(classifyProbe(r({ toolCalls: [{ id: 'c', name: 'get_time', args: { city: 'Amsterdam' } }] })), { verdict: 'tools', detail: 'ok' });
  assert.deepEqual(classifyProbe(r({ text: '{"name": "get_time", "arguments": {"city": "Amsterdam"}}' })), { verdict: 'tools', detail: 'as_text' });
  assert.deepEqual(classifyProbe(r({ text: 'Het is 15:00 in Amsterdam.' })), { verdict: 'text', detail: 'no_call' });
  assert.equal(classifyProbe(r({ toolCalls: [{ id: 'c', name: 'get_weather', args: { city: 'Amsterdam' } }] })).verdict, 'unreliable');
  assert.deepEqual(classifyProbe(null, new Error('Ollama: 400 registry.ollama.ai/library/gemma:2b does not support tools')), { verdict: 'text', detail: 'no_tools' });
  assert.deepEqual(classifyProbe(r({ text: 'hoi', notice: 'llama.cpp draait zonder --jinja en kan zo geen tools gebruiken' })), { verdict: 'text', detail: 'jinja' });
  assert.equal(classifyProbe(null, new Error('fetch failed')).verdict, 'error');

  const ps = parsePs(PS_THIS_PC);
  const vram = budget(THIS_PC).vram;
  assert.deepEqual(probePlan('qwen3.6-uncensored-snel', ps, vram, 15e9), { numCtx: 16384, where: 'loaded' }, 'loaded: as it is loaded, no reload');
  assert.deepEqual(probePlan('qwen3:1.7b', ps, vram, 2.1e9), { numCtx: 4096, numGpu: 0, keepAlive: '30s', where: 'cpu' }, 'would push the loaded model off the card: on the processor');
  assert.deepEqual(probePlan('qwen3:1.7b', [], vram, 2.1e9), { numCtx: 4096, keepAlive: '30s', where: 'gpu' });
  assert.equal(probeThink(['tools', 'thinking'], ['none', 'on']), false, 'thinking off for the test');
  assert.equal(probeThink(['tools', 'thinking'], ['low', 'medium', 'high']), 'low', 'gpt-oss cannot switch it off');
  assert.equal(probeThink(['tools'], []), undefined);
});

test('a tool call written as text becomes a real one — only a whole answer of calls of offered tools', () => {
  const tools: ToolSpec[] = PROBE_TOOLS;
  const one = toolCallsFromText('{"name": "get_time", "arguments": {"city": "Amsterdam"}}', tools)!;
  assert.deepEqual(one.map((c) => [c.name, c.args]), [['get_time', { city: 'Amsterdam' }]]);
  assert.equal(toolCallsFromText('<tool_call>\n{"name": "get_weather", "arguments": {"city": "Utrecht"}}\n</tool_call>', tools)![0].name, 'get_weather');
  assert.equal(toolCallsFromText('```json\n{"name":"save_note","parameters":{"text":"melk"}}\n```', tools)![0].args.text, 'melk');
  assert.equal(toolCallsFromText('[{"name":"get_time","arguments":"{\\"city\\":\\"Gent\\"}"},{"name":"get_weather","arguments":{"city":"Gent"}}]', tools)!.length, 2);
  assert.equal(toolCallsFromText('{"type":"function","function":{"name":"get_time","arguments":{"city":"Oslo"}}}', tools)![0].args.city, 'Oslo');
  // Stays text: prose around it, a tool that was not offered, an example in an explanation.
  assert.equal(toolCallsFromText('Ik roep nu aan: {"name": "get_time", "arguments": {"city": "Amsterdam"}}', tools), null);
  assert.equal(toolCallsFromText('{"name": "rm_rf", "arguments": {}}', tools), null);
  assert.equal(toolCallsFromText('<tool_call>{"name":"get_time","arguments":{}}</tool_call> en verder nog tekst', tools), null);
  assert.equal(toolCallsFromText('{"name": "get_time"', tools), null);
  assert.equal(toolCallsFromText('{"name": "get_time", "arguments": {}}', []), null, 'no tools offered');
});

// ------------------------------------------------------------------ context-window fitting: LM Studio and llama.cpp

const docs = (n: number) => 'Azure Functions bewaart logboeken in Application Insights; standaard 90 dagen. '.repeat(Math.ceil(n / 80)).slice(0, n);
const QUESTION = 'Hoe lang bewaart Azure Functions logboeken?';
const bigTurn = (n: number): ChatMsg[] => [
  { role: 'user', content: QUESTION },
  { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'docs_search', args: { q: 'logboeken' } }] },
  { role: 'tool', toolCallId: 'c1', toolName: 'docs_search', content: docs(n) },
];
const req = (model: string, messages: ChatMsg[]): ChatRequest => ({ model, system: 'Je bent Lokaal. '.repeat(50), messages, tools: [{ name: 'docs_search', description: 'Zoekt in documentatie.', parameters: { type: 'object', properties: { q: { type: 'string' } } } }] });

/**
 * A fake OpenAI-compatible local server. llama.cpp refuses a prompt over its window (400 exceed_context_size_error);
 * LM Studio cuts it silently (its default overflow policy) — and loads a model on the first request (JIT) with a
 * 4096 window. Tokens: characters / charsPerToken of the messages and tools.
 */
async function fakeServer(o: { kind: 'llamacpp' | 'lmstudio'; window: number; charsPerToken: number; jinja?: boolean; loaded?: boolean }) {
  const seen: any[] = [];
  let loaded = o.loaded ?? true;
  let cut = 0;
  const s = http.createServer((rq, res) => {
    let b = '';
    rq.on('data', (d) => (b += d));
    rq.on('end', () => {
      const body = b ? JSON.parse(b) : {};
      const send = (code: number, x: any) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(x)));
      if (rq.url === '/props' && o.kind === 'llamacpp') return send(200, { default_generation_settings: { n_ctx: o.window }, total_slots: 1, build_info: 'b1' });
      if (rq.url === '/api/v0/models' && o.kind === 'lmstudio')
        return send(200, { data: [{ id: 'qwen', type: 'llm', state: loaded ? 'loaded' : 'not-loaded', max_context_length: 32768, ...(loaded ? { loaded_context_length: o.window } : {}) }] });
      if (rq.url === '/v1/models') return send(200, { data: [{ id: o.kind === 'llamacpp' ? 'model.gguf' : 'qwen', owned_by: o.kind === 'llamacpp' ? 'llamacpp' : 'organization_owner' }] });
      if (rq.url !== '/v1/chat/completions') return send(404, { error: 'not found' });
      seen.push(body);
      if (o.kind === 'llamacpp' && body.tools && !o.jinja) return send(500, { error: { code: 500, message: 'tools param requires --jinja flag', type: 'server_error' } });
      const tokens = Math.ceil(JSON.stringify([body.messages, body.tools || []]).length / o.charsPerToken);
      let messages = body.messages;
      if (tokens > o.window) {
        if (o.kind === 'llamacpp') return send(400, { error: { code: 400, message: `request (${tokens} tokens) exceeds the available context size (${o.window} tokens), try increasing it`, type: 'exceed_context_size_error' } });
        // LM Studio: keeps the system message and cuts from the middle, without saying so.
        cut++;
        messages = [messages[0], ...messages.slice(-1)];
      }
      loaded = true;
      const sawQuestion = messages.some((m: any) => m.role === 'user' && m.content === QUESTION);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: sawQuestion ? 'Standaard 90 dagen.' : 'Waar gaat het over?' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: Math.min(tokens, o.window), completion_tokens: 4 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, seen, cuts: () => cut, close: () => new Promise<void>((r) => s.close(() => r())) };
}

const adapter = (kind: string, url: string, config: any = {}) =>
  builtinKinds()
    .find((k) => k.id === kind)!
    .create({ id: 'p', user_id: 'u', kind, name: kind, base_url: url + '/v1', secret_id: null, config, enabled: true, shared: false, created_at: '' }, null, {} as any);
const signal = () => new AbortController().signal;

test('llama.cpp: a request bigger than the server window is fitted (never refused, the question stays, the user is told)', async () => {
  const srv = await fakeServer({ kind: 'llamacpp', window: 4096, charsPerToken: 4, jinja: true });
  try {
    const raw = await fetch(srv.url + '/v1/chat/completions', { method: 'POST', body: JSON.stringify({ messages: bigTurn(40_000), tools: [] }) });
    assert.equal(raw.status, 400, 'without fitting llama-server refuses it');
    const r = await adapter('llamacpp', srv.url).chat!(req('model.gguf', bigTurn(40_000)), signal(), () => {});
    assert.equal(r.text, 'Standaard 90 dagen.');
    assert.match(r.notice || '', /tool-uitvoer paste niet in het contextvenster van dit model en is ingekort/);
    assert.equal(srv.seen.length - 1, 1, 'one call: it fitted the first time');
    // A server that counts more strictly than TeamBot's estimate: refused once, then sent with a strict count.
    const strict = await fakeServer({ kind: 'llamacpp', window: 4096, charsPerToken: 2, jinja: true });
    try {
      const r2 = await adapter('llamacpp', strict.url).chat!(req('model.gguf', bigTurn(40_000)), signal(), () => {});
      assert.equal(r2.text, 'Standaard 90 dagen.');
      assert.equal(strict.seen.length, 2);
    } finally {
      await strict.close();
    }
  } finally {
    await srv.close();
  }
});

test('llama.cpp without --jinja: answered without tools, with how to fix it (was a server error)', async () => {
  const srv = await fakeServer({ kind: 'llamacpp', window: 8192, charsPerToken: 4, jinja: false });
  try {
    const r = await adapter('llamacpp', srv.url).chat!(req('model.gguf', [{ role: 'user', content: QUESTION }]), signal(), () => {});
    assert.equal(r.text, 'Standaard 90 dagen.');
    assert.match(r.notice || '', /zonder --jinja.*Start llama-server met --jinja/);
    assert.equal(srv.seen.at(-1).tools, undefined, 'the second request went without tools');
  } finally {
    await srv.close();
  }
});

test('LM Studio: fitted into the loaded window, so LM Studio never cuts silently; JIT-loaded: cut once and said so', async () => {
  const srv = await fakeServer({ kind: 'lmstudio', window: 4096, charsPerToken: 4, loaded: true });
  try {
    const r = await adapter('lmstudio', srv.url).chat!(req('qwen', bigTurn(40_000)), signal(), () => {});
    assert.equal(r.text, 'Standaard 90 dagen.', 'the question reached the model');
    assert.equal(srv.cuts(), 0, 'LM Studio did not have to cut anything');
    assert.match(r.notice || '', /ingekort/);
  } finally {
    await srv.close();
  }
  // Not loaded yet: the window is unknown until LM Studio loads the model for this request and cuts it.
  const jit = await fakeServer({ kind: 'lmstudio', window: 4096, charsPerToken: 4, loaded: false });
  try {
    const a = adapter('lmstudio', jit.url);
    const first = await a.chat!(req('qwen', bigTurn(40_000)), signal(), () => {});
    assert.equal(jit.cuts(), 1);
    assert.equal(first.notice, cutNotice('LM Studio'), 'never silent: the person reads that a part was left out');
    const second = await a.chat!(req('qwen', bigTurn(40_000)), signal(), () => {});
    assert.equal(jit.cuts(), 1, 'the next call of the run fits');
    assert.equal(second.text, 'Standaard 90 dagen.');
  } finally {
    await jit.close();
  }
});

test('LM Studio 0.4: models and the loaded window from /api/v1/models when /api/v0 is gone', async () => {
  const s = http.createServer((rq, res) => {
    const send = (code: number, x: any) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(x)));
    if (rq.url === '/api/v1/models')
      return send(200, {
        models: [
          { type: 'llm', key: 'qwen/qwen3-4b', max_context_length: 32768, loaded_instances: [{ id: 'qwen/qwen3-4b', config: { context_length: 8192 } }], capabilities: { vision: false, trained_for_tool_use: true } },
          { type: 'embedding', key: 'nomic-embed' },
        ],
      });
    send(404, {});
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  try {
    const list = await adapter('lmstudio', `http://127.0.0.1:${(s.address() as AddressInfo).port}`).listModels();
    assert.deepEqual(list.map((m) => [m.id, m.context, m.loadedContext, m.tools]), [['qwen/qwen3-4b', 32768, 8192, true]]);
  } finally {
    await new Promise<void>((r) => s.close(() => r()));
  }
});

test('Ollama: a tool call that comes back as text (OpenAI layer and native) is run as a real tool call', async () => {
  const call = '{"name": "docs_search", "arguments": {"q": "logboeken"}}';
  const s = http.createServer((rq, res) => {
    let b = '';
    rq.on('data', (d) => (b += d));
    rq.on('end', () => {
      if (rq.url === '/api/ps') return res.writeHead(200, { 'content-type': 'application/json' }), res.end('{"models":[]}');
      if (rq.url === '/api/show') return res.writeHead(200, { 'content-type': 'application/json' }), res.end('{}');
      if (rq.url === '/api/chat') {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(JSON.stringify({ message: { content: '<think>even kijken</think>' + call }, done: false }) + '\n');
        return res.end(JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 50, eval_count: 9 }) + '\n');
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: call } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  try {
    const viaV1 = await adapter('ollama', url).chat!(req('qwen3:4b', [{ role: 'user', content: QUESTION }]), signal(), () => {});
    assert.deepEqual(viaV1.toolCalls.map((c) => [c.name, c.args]), [['docs_search', { q: 'logboeken' }]]);
    assert.equal(viaV1.text, '');
    assert.equal(viaV1.stop, 'tool_use');
    const native = await adapter('ollama', url, { contextWindows: { 'qwen3:4b': 8192 } }).chat!(req('qwen3:4b', [{ role: 'user', content: QUESTION }]), signal(), () => {});
    assert.equal(native.toolCalls[0]?.name, 'docs_search');
    assert.equal(native.reasoning, 'even kijken', 'thinking left in the answer is split off on the native API too');
  } finally {
    await new Promise<void>((r) => s.close(() => r()));
  }
});

// ------------------------------------------------------------------ the module: routes against a fake Ollama

const QWEN3_INFO = { 'general.architecture': 'qwen3', 'qwen3.block_count': 36, 'qwen3.attention.head_count': 32, 'qwen3.attention.head_count_kv': 8, 'qwen3.attention.key_length': 128, 'qwen3.attention.value_length': 128, 'qwen3.embedding_length': 4096, 'qwen3.context_length': 40960 };

async function fakeOllama(port = 0) {
  const st = {
    tags: [
      { name: 'qwen3:8b', model: 'qwen3:8b', size: 5225387677, digest: 'd8', details: { parameter_size: '8.2B', quantization_level: 'Q4_K_M', context_length: 40960 }, capabilities: ['completion', 'tools', 'thinking'] },
      { name: 'qwen3.6:35b', model: 'qwen3.6:35b', size: 22621314161, digest: 'd36', details: { parameter_size: '35.5B', quantization_level: 'Q4_K_M' }, capabilities: ['completion', 'tools', 'thinking', 'vision'] },
      { name: 'nomic-embed-text:latest', model: 'nomic-embed-text:latest', size: 274302450, digest: 'e', details: {}, capabilities: ['embedding'] },
    ] as any[],
    ps: [] as any[],
    chats: [] as any[],
    pulls: [] as any[],
  };
  const s = http.createServer((rq, res) => {
    let b = '';
    rq.on('data', (d) => (b += d));
    rq.on('end', async () => {
      const body = b ? JSON.parse(b) : {};
      const send = (x: any) => (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify(x)));
      if (rq.url === '/api/version') return send({ version: '0.40.15' });
      if (rq.url === '/api/tags') return send({ models: st.tags });
      if (rq.url === '/api/ps') return send({ models: st.ps });
      if (rq.url === '/api/show') return send({ model_info: String(body.model).startsWith('qwen3:') ? QWEN3_INFO : {}, capabilities: st.tags.find((t) => t.name === body.model)?.capabilities || [] });
      if (rq.url === '/v1/models') return send({ data: st.tags.map((t) => ({ id: t.name })) });
      if (rq.url === '/api/chat') {
        st.chats.push(body);
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        const call = body.tools?.some((t: any) => t.function.name === 'get_time');
        res.write(JSON.stringify({ message: call ? { content: '', tool_calls: [{ function: { name: 'get_time', arguments: { city: 'Amsterdam' } } }] } : { content: 'hoi' }, done: false }) + '\n');
        return res.end(JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 300, eval_count: 12 }) + '\n');
      }
      if (rq.url === '/api/pull') {
        st.pulls.push(body);
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        const step = (x: any) => new Promise<void>((r) => setTimeout(() => (res.write(JSON.stringify(x) + '\n'), r()), 30));
        await step({ status: 'pulling manifest' });
        for (const completed of [0, 1_000_000_000, 2_497_293_444]) await step({ status: 'pulling 3e4cb1417446', digest: 'sha256:3e4cb1417446', total: 2_497_293_444, completed });
        await step({ status: 'verifying sha256 digest' });
        await step({ status: 'writing manifest' });
        st.tags.push({ name: body.model, model: body.model, size: 2_497_293_444, digest: 'd4', details: { parameter_size: '4B' }, capabilities: ['completion', 'tools', 'thinking'] });
        return res.end(JSON.stringify({ status: 'success' }) + '\n');
      }
      res.writeHead(404);
      res.end('{}');
    });
  });
  await new Promise<void>((r) => s.listen(port, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, st, close: () => new Promise<void>((r) => s.close(() => r())) };
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - start > ms) throw new Error('time-out: ' + JSON.stringify(v).slice(0, 400));
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('module: the card data, a cached tool test, a download with progress, "use for new bots"', async () => {
  const ol = await fakeOllama();
  let pc = THIS_PC;
  const modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-models-'));
  const t = await startTestApp({ modules: [createLocalModelsModule({ hardware: async () => pc, hardwareTtlMs: 0, modelsDir })] });
  try {
    const p = await t.api('POST', '/providers', { kind: 'ollama', base_url: ol.url + '/v1' });
    // qwen3:8b is loaded, but all of it on the processor while the pc has a 16 GB card: the driver warning.
    ol.st.ps = [{ name: 'qwen3:8b', model: 'qwen3:8b', size: 6_100_000_000, size_vram: 0, context_length: 8192 }];
    let v = await t.api('GET', '/local-models');
    assert.equal(v.allowed, true);
    assert.equal(v.budget.gpu, 'AMD Radeon RX 7800 XT');
    assert.equal(v.ollama.running, true);
    assert.deepEqual(v.installed.map((m: any) => m.id).sort(), ['qwen3.6:35b', 'qwen3:8b'], 'embedding models are not for chat');
    const q8 = v.installed.find((m: any) => m.id === 'qwen3:8b');
    assert.deepEqual([q8.fit, q8.why, q8.loaded.placement, q8.context], ['slow', 'loaded_cpu', 'cpu', 8192]);
    assert.equal(v.installed.find((m: any) => m.id === 'qwen3.6:35b').fit, 'slow');
    assert.deepEqual(v.cpuWarning, { model: 'qwen3:8b', gpu: 'AMD Radeon RX 7800 XT', vendor: 'amd', driverUrl: 'https://www.amd.com/en/support/download/drivers.html' });
    assert.equal(v.catalog.find((c: any) => c.id === 'qwen3:8b').installed, true);
    assert.equal(v.catalog.find((c: any) => c.best).id, 'qwen3:14b');
    assert.deepEqual(v.recommended, { id: 'qwen3:14b', installed: false }, 'what is installed only runs slowly here: the best download');
    assert.equal(typeof v.diskFree, 'number');

    // Fixed driver: on the card now. The installed qwen3:8b fits and is the advice.
    ol.st.ps = [{ name: 'qwen3:8b', model: 'qwen3:8b', size: 6_100_000_000, size_vram: 6_100_000_000, context_length: 8192 }];
    v = await t.api('GET', '/local-models');
    assert.equal(v.cpuWarning, null);
    assert.deepEqual(v.recommended, { id: 'qwen3:8b', installed: true });
    assert.equal(await t.app.ctx.services.localModels.pickChatModel(t.app.ctx.providers.config(p.id), [{ id: 'qwen3.6:35b' }, { id: 'qwen3:8b' }]), 'qwen3:8b');

    // Tool test on the loaded model: as it is loaded (num_ctx 8192), thinking off, no num_gpu, no keep_alive.
    const probe = await t.api('POST', '/local-models/probe', { model: 'qwen3:8b' });
    assert.deepEqual([probe.verdict, probe.detail, probe.where], ['tools', 'ok', 'loaded']);
    const sent = ol.st.chats.at(-1);
    assert.equal(sent.options.num_ctx, 8192);
    assert.equal(sent.think, false);
    assert.equal(sent.options.num_gpu, undefined);
    assert.equal(sent.keep_alive, undefined);
    assert.deepEqual(sent.tools.map((x: any) => x.function.name), ['get_time', 'get_weather', 'save_note']);
    v = await t.api('GET', '/local-models');
    assert.equal(v.installed.find((m: any) => m.id === 'qwen3:8b').probe.verdict, 'tools', 'cached');
    assert.equal(v.installed.find((m: any) => m.id === 'qwen3:8b').toolsKnown, 'yes');
    // A model that would push the loaded one off the card is tested on the processor, and is unloaded after 30 s.
    ol.st.ps = [{ name: 'qwen3:8b', model: 'qwen3:8b', size: 15_900_000_000, size_vram: 15_900_000_000, context_length: 8192 }];
    const big = await t.api('POST', '/local-models/probe', { model: 'qwen3.6:35b' });
    assert.equal(big.where, 'cpu');
    assert.equal(ol.st.chats.at(-1).options.num_gpu, 0);
    assert.equal(ol.st.chats.at(-1).keep_alive, '30s');
    assert.equal(t.app.ctx.store.all('SELECT * FROM local_model_probes').length, 2);
    // A new download of the same name (another digest) is tested again.
    ol.st.tags[0].digest = 'd8-new';
    v = await t.api('GET', '/local-models');
    assert.equal(v.installed.find((m: any) => m.id === 'qwen3:8b').probe, null);

    // Download from the list, with progress; the tool test follows by itself.
    await assert.rejects(t.api('POST', '/local-models/pull', { model: 'llama2:70b' }), /Kies een model uit de lijst/);
    pc = GPU8;
    await assert.rejects(t.api('POST', '/local-models/pull', { model: 'qwen3.6:35b' }), /te groot voor deze pc/);
    pc = THIS_PC;
    const started = await t.api('POST', '/local-models/pull', { model: 'qwen3:4b' });
    assert.equal(started.started, true);
    v = await until(
      () => t.api('GET', '/local-models'),
      (x: any) => x.pulls.some((p: any) => p.model === 'qwen3:4b' && p.done) && x.installed.find((m: any) => m.id === 'qwen3:4b')?.probe,
    );
    const done = v.pulls.find((p: any) => p.model === 'qwen3:4b');
    assert.deepEqual([done.ok, done.completed, done.total], [true, 2_497_293_444, 2_497_293_444]);
    assert.deepEqual(ol.st.pulls, [{ model: 'qwen3:4b', stream: true }]);
    assert.equal(v.installed.find((m: any) => m.id === 'qwen3:4b').probe.verdict, 'tools', 'tested right after the download');

    // "Gebruik voor nieuwe bots": Ollama's default model (and the user's, Ollama being the default provider).
    const used = await t.api('POST', '/local-models/use', { model: 'qwen3:8b' });
    assert.equal(used.providerId, p.id);
    assert.equal(t.app.ctx.providers.config(p.id)!.config.defaultModel, 'qwen3:8b');
    // One default model: the connection's own. The user has no second value that could say something else.
    assert.equal(t.app.ctx.store.getSetting(t.app.ctx.auth.owner()!.id, 'defaultModel', ''), '');
    assert.equal((await t.api('GET', '/settings')).defaultModel, 'qwen3:8b');
    await assert.rejects(t.api('POST', '/local-models/use', { model: 'bestaat-niet' }), /staat niet in Ollama/);
  } finally {
    await t.close();
    await ol.close();
    fs.rmSync(modelsDir, { recursive: true, force: true });
  }
});

test('module: Ollama not running → said plainly, no advice that cannot be followed', async () => {
  const t = await startTestApp({ modules: [createLocalModelsModule({ hardware: async () => NO_GPU })] });
  try {
    // A port where nothing listens.
    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', () => r()));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    await t.api('POST', '/providers', { kind: 'ollama', base_url: `http://127.0.0.1:${port}/v1` });
    const v = await t.api('GET', '/local-models');
    assert.equal(v.ollama.running, false);
    assert.equal(v.ollama.local, true);
    assert.deepEqual(v.installed, []);
    assert.equal(v.cpuWarning, null);
    assert.deepEqual(v.recommended, { id: 'qwen3:1.7b', installed: false }, 'what to fetch once Ollama runs');
    await assert.rejects(t.api('POST', '/local-models/pull', { model: 'qwen3:1.7b' }), /Ollama draait niet/);
  } finally {
    await t.close();
  }
});

// ------------------------------------------------------------------ "Installeren" when Ollama is not on this pc

/** A free port on this computer (nothing listens on it until the stand-in Ollama is "installed"). */
async function freePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

test('Installeren: Ollama missing → its signed installer runs silently, Ollama is connected with a model, a bot answers', async () => {
  // A stand-in for ollama.com (the installer) and for Ollama, which only answers once the installer ran.
  const setup = Buffer.alloc(300_000, 7);
  const site = http.createServer((_rq, res) => (res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': setup.length }), res.end(setup)));
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
  const port = await freePort();
  let ol: Awaited<ReturnType<typeof fakeOllama>> | null = null;
  const steps: string[] = [];
  const plan = {
    url: `http://127.0.0.1:${(site.address() as AddressInfo).port}/download/OllamaSetup.exe`,
    file: 'OllamaSetup.exe',
    async verify(file: string) {
      steps.push(`verify ${fs.statSync(file).size}`);
      return true;
    },
    async install() {
      steps.push('install');
      ol = await fakeOllama(port);
      ol.st.tags = []; // a fresh Ollama has no models
    },
    async start() {
      steps.push('start');
    },
  };
  const t = await startTestApp({ modules: [createLocalModelsModule({ hardware: async () => THIS_PC, hardwareTtlMs: 0, installPlan: () => plan, installWaitMs: 3000 })] });
  try {
    t.app.ctx.providers.kind('ollama')!.baseUrl = `http://127.0.0.1:${port}/v1`;
    assert.equal((await t.api('GET', '/local-models')).ollama.running, false, 'Ollama is not on this pc');
    const first = await t.api('POST', '/local-models/install', {});
    assert.equal(first.phase, 'download');
    const seen: string[] = [];
    const off = t.app.ctx.events.on('localmodels.install', (e: any) => seen.push(e.data?.phase ?? e.phase));
    const end = await until(() => t.api('GET', '/local-models/install'), (s: any) => s && (s.phase === 'done' || s.phase === 'error'), 20_000);
    off();
    assert.equal(end.phase, 'done', end.error);
    assert.deepEqual(steps, [`verify ${setup.length}`, 'install'], 'checked before it ran; Ollama answered, so no extra start');
    assert.ok(!fs.existsSync(path.join(t.dir, 'downloads', 'OllamaSetup.exe')), 'the installer is cleaned up');
    // Connected, with the download that runs well on this pc (nothing was installed yet).
    const p = t.app.ctx.store.all<any>("SELECT * FROM providers WHERE kind = 'ollama'").map((r) => t.app.ctx.providers.config(r.id)!)[0];
    assert.ok(p, 'Ollama is connected');
    assert.equal(p.config?.defaultModel, 'qwen3:14b');
    assert.deepEqual(ol!.st.pulls.map((x: any) => x.model), ['qwen3:14b']);
    assert.equal(end.model, 'qwen3:14b');
    // No further step: a bot on Ollama without a model of its own answers, with a window that fits it.
    const a = await t.api('POST', '/agents', { name: 'Lokaal', provider_id: p.id, access_mode: 'auto' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    const msgs = await t.say(th.id, 'Hoi', 15_000);
    const answer = msgs.filter((m: any) => m.role === 'assistant').at(-1)!;
    assert.equal(answer.status, 'done', answer.parts?.error);
    assert.equal(answer.content, 'hoi');
    assert.equal(ol!.st.chats.at(-1).model, 'qwen3:14b');
    assert.ok(ol!.st.chats.at(-1).options.num_ctx >= 16384, `a window that fits the bot, not Ollama's 4K: ${ol!.st.chats.at(-1).options.num_ctx}`);
    assert.ok(seen.length > 0, 'progress was sent as it went');
  } finally {
    await t.close();
    await (ol as any)?.close();
    await new Promise<void>((r) => site.close(() => r()));
  }
});

test('Installeren: a download that is not signed by Ollama is never run; a computer without a silent install says what to do', async () => {
  const setup = Buffer.alloc(1000, 1);
  const site = http.createServer((_rq, res) => (res.writeHead(200, { 'content-length': setup.length }), res.end(setup)));
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
  const port = await freePort();
  let ran = false;
  let plan: any = {
    url: `http://127.0.0.1:${(site.address() as AddressInfo).port}/OllamaSetup.exe`,
    file: 'OllamaSetup.exe',
    verify: async () => false,
    install: async () => void (ran = true),
    start: async () => {},
  };
  const t = await startTestApp({ modules: [createLocalModelsModule({ hardware: async () => THIS_PC, hardwareTtlMs: 0, installPlan: () => plan, installWaitMs: 500 })] });
  try {
    t.app.ctx.providers.kind('ollama')!.baseUrl = `http://127.0.0.1:${port}/v1`;
    await t.api('POST', '/local-models/install', {});
    const end = await until(() => t.api('GET', '/local-models/install'), (s: any) => s && (s.phase === 'done' || s.phase === 'error'), 10_000);
    assert.equal(end.phase, 'error');
    assert.match(end.error, /niet ondertekend door Ollama; er is niets geïnstalleerd/);
    assert.equal(ran, false);
    assert.ok(!fs.existsSync(path.join(t.dir, 'downloads', 'OllamaSetup.exe')));
    assert.equal(t.app.ctx.store.all("SELECT id FROM providers WHERE kind = 'ollama'").length, 0, 'nothing connected');
    // Linux: Ollama's installer needs a password; TeamBot says where to get it instead of failing silently.
    plan = null;
    await assert.rejects(t.api('POST', '/local-models/install', {}), /installeert TeamBot Ollama niet zelf.*ollama\.com\/download/);
  } finally {
    await t.close();
    await new Promise<void>((r) => site.close(() => r()));
  }
});
