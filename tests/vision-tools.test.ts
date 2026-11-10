import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp } from './helpers.js';
import { registerAttachment } from '../server/tools/builtin/files.js';
import { toOpenAIMessages } from '../server/providers/openai-compat.js';
import { toAnthropicMessages } from '../server/providers/anthropic.js';

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

test('screenshots from tools reach vision models (OpenAI-style and Anthropic-style)', async () => {
  const t = await startTestApp({ modules: [] });
  try {
    t.app.ctx.tools.register({
      name: 'take_shot',
      group: 'core',
      risk: 'read',
      description: 'test',
      parameters: { type: 'object', properties: {} },
      async run(_a, tc) {
        const f = path.join(t.dir, 'shot.png');
        fs.writeFileSync(f, PNG);
        return { text: 'Schermafbeelding gemaakt', attachments: [registerAttachment(tc.ctx, tc.userId, tc.thread.id, f, 'shot.png')] };
      },
    });
    const a = await t.agent();
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ toolCalls: [{ name: 'take_shot', args: {} }] }, { text: 'Ik zie het scherm' });
    await t.say(th.id, 'Kijk naar het scherm');
    const second = t.requests[1];
    const tool = second.messages.find((m) => m.role === 'tool')!;
    assert.ok(Array.isArray(tool.content), 'tool result carries content parts');
    assert.ok((tool.content as any[]).some((p) => p.type === 'image' && p.mime === 'image/png'));

    const oa = toOpenAIMessages('sys', second.messages);
    const toolIdx = oa.findIndex((m: any) => m.role === 'tool');
    assert.equal(typeof oa[toolIdx].content, 'string', 'OpenAI tool messages stay text');
    assert.equal(oa[toolIdx + 1].role, 'user');
    assert.ok(oa[toolIdx + 1].content.some((p: any) => p.type === 'image_url'), 'image follows in a user message');

    const an = toAnthropicMessages(second.messages, false);
    const tr = an.flatMap((m: any) => m.content).find((b: any) => b.type === 'tool_result');
    assert.ok(Array.isArray(tr.content) && tr.content.some((b: any) => b.type === 'image'), 'Anthropic tool_result holds the image');

    // Vision off for this bot: no images sent.
    await t.api('PATCH', `/agents/${a.id}`, { settings: { vision: false } });
    t.script.push({ text: 'ok' });
    await t.say(th.id, 'nog eens');
    const third = t.requests[t.requests.length - 1];
    assert.ok(third.messages.filter((m) => m.role === 'tool').every((m) => typeof m.content === 'string'));
  } finally {
    await t.close();
  }
});
