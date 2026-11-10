import fs from 'node:fs';
import type { Ctx, ToolOutput } from '../core/types.js';

/**
 * Images a tool returned (screenshots of the bot's browser or of the desktop), as base64 content parts.
 * API providers already get these through the chat history (agent/history.ts); this helper is for other engine
 * paths, e.g. an MCP bridge that exposes TeamBot tools to CLI engines and must answer with
 * `{ type: 'image', data, mimeType }` content next to the text.
 */
export function toolOutputImages(ctx: Ctx, out: Pick<ToolOutput, 'attachments'>, o: { max?: number; maxBytes?: number } = {}): { type: 'image'; data: string; mimeType: string }[] {
  const res: { type: 'image'; data: string; mimeType: string }[] = [];
  for (const ref of out.attachments || []) {
    if (res.length >= (o.max ?? 2)) break;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(ref.mime)) continue;
    const row = ctx.store.get<any>('attachments', ref.id);
    if (!row?.path || !fs.existsSync(row.path) || row.size > (o.maxBytes ?? 4_500_000)) continue;
    res.push({ type: 'image', data: fs.readFileSync(row.path).toString('base64'), mimeType: ref.mime });
  }
  return res;
}

/** MCP `CallToolResult` content for a TeamBot tool result: the text plus its images. */
export function toolOutputToMcpContent(ctx: Ctx, out: ToolOutput): ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] {
  return [{ type: 'text', text: out.text || '(leeg)' }, ...toolOutputImages(ctx, out)];
}
