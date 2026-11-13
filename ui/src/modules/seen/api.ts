import { api } from '../../lib/api';
import { previewKindOf, type PreviewSource } from '../../components/FilePreview';
import { foldersApi } from '../folders/api';
import type { SeenFile, SeenView } from '../../../../shared/seen.js';

export const seenApi = {
  get: (agentId: string, o: { threadId?: string; days?: number } = {}) => {
    const q = new URLSearchParams();
    if (o.threadId) q.set('thread', o.threadId);
    if (o.days) q.set('days', String(o.days));
    const s = q.toString();
    return api.get<SeenView>(`/agents/${agentId}/seen${s ? `?${s}` : ''}`);
  },
};

/** Preview of a file in one of the bot's folders (same as the folder browser does it). */
export async function workspacePreview(agentId: string, f: SeenFile): Promise<PreviewSource> {
  const root = f.root ?? 0;
  const rel = f.rel || '';
  const base = {
    name: f.name,
    size: f.size ?? undefined,
    mtime: f.mtime || undefined,
    url: (download?: boolean) => foldersApi.rawUrl(agentId, root, rel, !!download),
    bytes: () => foldersApi.rawBytes(agentId, root, rel),
  };
  const kind = previewKindOf(f.name);
  if (kind === 'pdf' || kind === 'image' || kind === 'audio' || kind === 'video') return { ...base, kind };
  try {
    const p = await foldersApi.file(agentId, root, rel);
    const k = p.kind || (p.binary ? 'binary' : kind === 'markdown' ? 'markdown' : 'text');
    return { ...base, kind: k, size: p.size, mtime: p.mtime, text: k === 'text' || k === 'markdown' ? p.text : undefined, truncated: p.truncated };
  } catch (e: any) {
    return { ...base, kind: 'binary', error: e?.message || String(e) };
  }
}

/** Link into the Bestanden page with this file opened ("Openen in Bestanden"). */
export function folderLink(agentId: string, f: SeenFile): string {
  const rel = f.rel || '';
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  const q = new URLSearchParams({ root: String(f.root ?? 0), path: dir, open: f.name });
  return `#/m/folders/${agentId}?${q.toString()}`;
}
