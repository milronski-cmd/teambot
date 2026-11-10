import { useEffect, useState } from 'react';
import { emit, on, request } from '../../lib/api';
import { useApp } from '../../lib/store';

/**
 * Drafts = messages that could not be delivered because the host was unreachable.
 * They stay on this device (localStorage, per user) and are clearly marked "nog niet afgeleverd".
 * Sending them again is always an explicit tap — nothing is sent automatically hours later.
 */
export interface Draft {
  id: string;
  threadId: string;
  content: string;
  createdAt: string;
}

const key = () => `tb_drafts_v1:${useApp.getState().me?.id || 'anon'}`;

export function loadDrafts(): Draft[] {
  try {
    const v = JSON.parse(localStorage.getItem(key()) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function save(list: Draft[]) {
  try {
    localStorage.setItem(key(), JSON.stringify(list.slice(-100)));
  } catch {
    /* storage full / private mode: drafts then only live in memory for this event */
  }
  emit('mobile.drafts', list);
}
export function addDraft(threadId: string, content: string): Draft {
  const d: Draft = { id: Math.random().toString(36).slice(2) + Date.now().toString(36), threadId, content, createdAt: new Date().toISOString() };
  save([...loadDrafts(), d]);
  return d;
}
export function removeDraft(id: string) {
  save(loadDrafts().filter((d) => d.id !== id));
}

export async function deliver(d: Draft) {
  await request(`/threads/${encodeURIComponent(d.threadId)}/messages`, { method: 'POST', body: { content: d.content }, headers: { 'x-tb-draft': d.id } });
  removeDraft(d.id);
}

export function useDrafts(threadId?: string): Draft[] {
  const [list, setList] = useState(loadDrafts);
  useEffect(() => on('mobile.drafts', () => setList(loadDrafts())), []);
  return threadId ? list.filter((d) => d.threadId === threadId) : list;
}

const SEND = /^\/api\/threads\/([^/?#]+)\/messages$/;

/**
 * Watch failed sends without changing them: when posting a chat message fails because the host is
 * unreachable (network error or 502/503/504 from a proxy), keep a copy as a draft and say so.
 * The original result/error is passed through untouched.
 */
export function installSendObserver(onSaved: (d: Draft) => void): () => void {
  const orig = window.fetch;
  const wrapped: typeof fetch = async (input, init) => {
    let m: RegExpExecArray | null = null;
    let body: any = null;
    try {
      const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const hdrs = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
      if (method === 'POST' && !hdrs.has('x-tb-draft')) {
        m = SEND.exec(new URL(raw, location.href).pathname);
        if (m && typeof init?.body === 'string') body = JSON.parse(init.body);
      }
    } catch {
      m = null;
    }
    const keep = () => {
      const content = typeof body?.content === 'string' ? body.content : '';
      if (m && content.trim()) onSaved(addDraft(decodeURIComponent(m[1]), content));
    };
    try {
      const res = await orig.call(window, input, init);
      if (m && [502, 503, 504].includes(res.status)) keep();
      return res;
    } catch (e: any) {
      if (m && e?.name !== 'AbortError') keep();
      throw e;
    }
  };
  window.fetch = wrapped;
  return () => {
    if (window.fetch === wrapped) window.fetch = orig;
  };
}
