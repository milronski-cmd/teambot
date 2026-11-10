import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import { ACP_PROTOCOL_VERSION, acpWire, isWireError } from '../server/modules/cli-agents/acp-wire.js';
import { RpcPeer } from '../server/modules/cli-agents/rpc.js';
import type { Proc } from '../server/modules/cli-agents/proc.js';

/**
 * The ACP wire on the official SDK (`@agentclientprotocol/sdk`): framing, ids and errors come from the SDK; TeamBot's
 * own rules sit above it. A fake agent process: what TeamBot writes is collected, what the agent "says" is fed in.
 */
function fakeProc() {
  const out: any[] = [];
  const waiters: Array<{ match: (m: any) => boolean; resolve: (m: any) => void }> = [];
  const proc = {
    write(s: string) {
      for (const line of s.split('\n').filter(Boolean)) {
        const m = JSON.parse(line);
        out.push(m);
        for (const w of [...waiters]) if (w.match(m)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(m));
      }
    },
  } as unknown as Proc;
  const next = (match: (m: any) => boolean) =>
    new Promise<any>((resolve) => {
      const hit = out.find(match);
      if (hit) return resolve(hit);
      waiters.push({ match, resolve });
    });
  return { proc, out, next };
}

const OPTS = [
  { optionId: 'a', name: 'Allow', kind: 'allow_once' },
  { optionId: 'r', name: 'Reject', kind: 'reject_once' },
];

test('ACP wire (SDK): requests and answers, TeamBot’s own error texts, protocol version from the SDK', async () => {
  assert.equal(ACP_PROTOCOL_VERSION, PROTOCOL_VERSION);
  const { proc, next } = fakeProc();
  const wire = acpWire(proc);
  assert.ok(!(wire instanceof RpcPeer), 'the SDK is the default wire');
  const seen: string[] = [];
  wire.onRequest = async (method, p) => {
    seen.push(method);
    if (method === 'fs/read_text_file') return { content: `inhoud van ${p.path}` };
    if (method === 'fs/write_text_file') throw new RequestError(-32000, 'Geweigerd door TeamBot: deze bot staat op alleen lezen.');
    throw new RequestError(-32601, `TeamBot ondersteunt ${method} niet`);
  };

  // TeamBot → agent: a request with an id, answered by the agent.
  const init = wire.request('initialize', { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} }, 5000);
  const sent = await next((m) => m.method === 'initialize');
  assert.equal(sent.jsonrpc, '2.0');
  wire.handleLine(JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } }));
  assert.deepEqual((await init).agentCapabilities, { loadSession: true });

  // An error answer of the agent is a wire error with its code (auth detection reads it).
  const fail = wire.request('session/new', { cwd: 'C:\\x', mcpServers: [] }, 5000);
  const sn = await next((m) => m.method === 'session/new');
  wire.handleLine(JSON.stringify({ jsonrpc: '2.0', id: sn.id, error: { code: -32000, message: 'Authentication required' } }));
  const err = await fail.catch((e) => e);
  assert.ok(isWireError(err));
  assert.equal(err.code, -32000);

  // Agent → TeamBot: schema-checked requests reach the handler; the answer goes back with the agent's id.
  wire.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 'r1', method: 'fs/read_text_file', params: { sessionId: 's', path: 'a.txt' } }));
  assert.deepEqual((await next((m) => m.id === 'r1')).result, { content: 'inhoud van a.txt' });
  wire.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 'w1', method: 'fs/write_text_file', params: { sessionId: 's', path: 'a.txt', content: 'x' } }));
  const w = await next((m) => m.id === 'w1');
  assert.deepEqual(w.error && { code: w.error.code, message: w.error.message }, { code: -32000, message: 'Geweigerd door TeamBot: deze bot staat op alleen lezen.' }, 'TeamBot’s refusal reaches the agent as written');
  wire.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 't1', method: 'terminal/create', params: { sessionId: 's', command: 'ls' } }));
  assert.equal((await next((m) => m.id === 't1')).error.code, -32601, 'no terminal capability');

  // A timed-out request says so in Dutch.
  await assert.rejects(wire.request('session/set_mode', { sessionId: 's', modeId: 'plan' }, 50), /Geen antwoord van de CLI op session\/set_mode \(time-out\)/);

  // A closed wire fails what is still open, with TeamBot's reason.
  const open = wire.request('session/prompt', { sessionId: 's', prompt: [] });
  wire.close('OpenCode is gestopt');
  await assert.rejects(open, /OpenCode is gestopt/);
  await assert.rejects(wire.request('session/prompt', { sessionId: 's', prompt: [] }), /gesloten/);
  assert.ok(seen.includes('fs/read_text_file') && seen.includes('fs/write_text_file'));
});

test('ACP wire (SDK): a malformed permission request never reaches the gate; stdout noise is skipped; updates keep their order', async () => {
  const { proc, out, next } = fakeProc();
  const wire = acpWire(proc);
  const order: string[] = [];
  let gateCalls = 0;
  wire.onNotification = (method, p) => order.push(`${method}:${p?.update?.sessionUpdate}:${p?.update?.toolCallId || ''}`);
  wire.onRequest = async (method, p) => {
    if (method === 'session/request_permission') {
      gateCalls++;
      order.push(`permission:${p.toolCall.toolCallId}`);
      return { outcome: { outcome: 'selected', optionId: 'a' } };
    }
    throw new RequestError(-32601, 'nee');
  };

  // A banner or log line on stdout is not answered (the SDK would send a parse error).
  wire.handleLine('dit is een logregel en geen JSON');
  wire.handleLine('[1,2]');

  // Missing options / unknown option kind: refused by the SDK's schema check, the gate is never asked.
  wire.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 'p0', method: 'session/request_permission', params: { sessionId: 's', toolCall: { toolCallId: 'x' } } }));
  const bad = await next((m) => m.id === 'p0');
  assert.equal(bad.error.code, -32602);
  wire.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 'p1', method: 'session/request_permission', params: { sessionId: 's', toolCall: { toolCallId: 'x' }, options: [{ optionId: 'a', name: 'Allow', kind: 'allow_forever' }] } }));
  assert.equal((await next((m) => m.id === 'p1')).error.code, -32602);
  assert.equal(gateCalls, 0, 'deny by default: nothing malformed reaches the permission gate');

  // OpenCode announces a tool call and asks permission for it right after: TeamBot sees them in that order.
  wire.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Schrijf a.txt', kind: 'edit', status: 'pending' } } }));
  wire.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 'p2', method: 'session/request_permission', params: { sessionId: 's', toolCall: { toolCallId: 't1' }, options: OPTS } }));
  wire.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } } }));
  assert.deepEqual((await next((m) => m.id === 'p2')).result, { outcome: { outcome: 'selected', optionId: 'a' } });
  assert.equal(order[0], 'session/update:tool_call:t1', 'the tool call is known before its permission request');
  assert.ok(order.includes('permission:t1'));
  // An update the stable schema does not know yet still reaches the chat (display only, read defensively).
  wire.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'nieuw_soort_update', x: 1 } } }));
  assert.equal(order.at(-1), 'session/update:nieuw_soort_update:');
  assert.ok(!out.some((m) => m.id === null), 'no parse-error answers to stdout noise');
  wire.close('klaar');
});

test('ACP wire: TEAMBOT_ACP_WIRE=legacy switches back to TeamBot’s own peer for one release', () => {
  process.env.TEAMBOT_ACP_WIRE = 'legacy';
  try {
    const wire = acpWire(fakeProc().proc);
    assert.ok(wire instanceof RpcPeer);
  } finally {
    delete process.env.TEAMBOT_ACP_WIRE;
  }
});
