import fs from 'node:fs';
import path from 'node:path';
import type { Agent, Ctx, Message } from '../../core/types.js';
import { agentRoots, isProtectedPath, resolveInWorkspace } from '../../tools/builtin/files.js';
import { toolLabel } from '../../../shared/toolLabels.js';
import type { EvidenceItem, StepItem } from './types.js';

/**
 * Evidence: what a bot attaches when it reports a task done (a file path, a link, the id of a sent message, a
 * screenshot, command output). TeamBot looks at each piece itself first: does the file exist (and what is in it), is
 * the message there, does the output appear in a step the bot really took in this turn. That costs nothing, and a
 * piece that is plainly wrong already decides "te controleren" without a model call.
 */

export const MAX_EVIDENCE = 10;
const MAX_ITEM = 2000;
const EXCERPT = 1500;
const MAX_READ = 2_000_000;

const URL_RE = /^https?:\/\/[^\s]+$/i;
const ID_RE = /^(msg|att)_[A-Za-z0-9]{6,40}$/;
const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const LABEL_RE = /^[\p{L} ]{2,24}:\s+(?=\S)/u;

/** Tools that report or keep the task itself; they are no evidence of the work. */
const BOOKKEEPING = new Set(['task_done', 'task_update', 'task_claim', 'task_create', 'task_list', 'team_status', 'plan_update']);

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** The evidence a bot gave, as a clean list of strings (array, objects with a value, or one per line). */
export function parseEvidence(raw: any): string[] {
  const list: any[] = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/\r?\n/) : raw && typeof raw === 'object' ? [raw] : [];
  const out: string[] = [];
  for (const x of list) {
    const v = typeof x === 'string' ? x : x && typeof x === 'object' ? String(x.value ?? x.path ?? x.url ?? x.link ?? x.id ?? x.text ?? '') : String(x ?? '');
    const s = v.replace(/^\s*[-*•]\s+/, '').trim().slice(0, MAX_ITEM);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= MAX_EVIDENCE) break;
  }
  return out;
}

function unquote(s: string): string {
  return s.replace(/^[`'"“”‘’]+|[`'"“”‘’]+$/g, '').trim();
}

/** "Bestand: rapport.md" → "rapport.md" when what follows the label is a path, link or id. */
function dropLabel(s: string): string {
  const m = s.match(LABEL_RE);
  if (!m) return s;
  const rest = unquote(s.slice(m[0].length));
  return URL_RE.test(rest) || ID_RE.test(rest) || looksLikePath(rest) ? rest : s;
}

export function looksLikePath(v: string): boolean {
  if (!v || v.length > 500 || /[\r\n]/.test(v) || URL_RE.test(v)) return false;
  if (/^[a-zA-Z]:[\\/]/.test(v) || v.startsWith('/') || v.startsWith('./') || v.startsWith('~/')) return true;
  // "map/bestand.md", "rapport.pdf": a name with an extension, no sentence around it.
  return /^[\w .,()@+-]+([\\/][\w .,()@+-]+)*\.[A-Za-z0-9]{1,8}$/.test(v) && v.split(/\s+/).length <= 6;
}

/** What the bot really did in a run: its tool calls with their status and the start of their output (CLI: its steps). */
export function runSteps(ctx: Ctx, runId: string | null | undefined, o: { exclude?: string[] } = {}): StepItem[] {
  if (!runId) return [];
  const skip = new Set([...BOOKKEEPING, ...(o.exclude || [])]);
  const rows = ctx.store.all<any>('SELECT * FROM messages WHERE run_id = ? ORDER BY seq', runId).map((r) => ctx.store.decode<Message>('messages', r));
  const steps: (StepItem & { id?: string })[] = [];
  for (const m of rows) {
    if (m.role === 'assistant') {
      for (const c of m.parts?.toolCalls || []) {
        if (skip.has(c.name)) continue;
        steps.push({ id: c.id, tool: c.name, summary: c.summary ? `${toolLabel(c, false)}: ${c.summary}` : toolLabel(c, false), ok: c.status === 'done' });
      }
      for (const a of m.parts?.activity || []) {
        if (!a?.title || ['session', 'cli_session', 'settings', 'question', 'mode'].includes(a.kind)) continue;
        steps.push({ tool: a.kind || 'stap', summary: `${a.title}${a.detail ? `: ${String(a.detail).slice(0, 200)}` : ''}`, ok: true, out: a.detail ? String(a.detail).slice(0, 4000) : undefined });
      }
    } else if (m.role === 'tool' && m.parts?.toolResult) {
      const s = steps.find((x) => x.id === m.parts.toolResult!.toolCallId);
      if (s) {
        s.out = String(m.content || '').slice(0, 4000);
        s.ok = s.ok && !m.parts.toolResult.isError;
      }
    }
  }
  return steps.slice(-30).map(({ id: _id, ...s }) => s);
}

/** The stored form of steps (short outputs; the record is shown to the owner and given to the checker). */
export function shortSteps(steps: StepItem[]): StepItem[] {
  return steps.slice(-15).map((s) => ({ tool: s.tool, summary: s.summary.slice(0, 240), ok: s.ok, out: s.out ? s.out.slice(0, 300) : undefined }));
}

function sizeText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace('.', ',')} kB`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

function readExcerpt(file: string, size: number): string | undefined {
  if (size > MAX_READ) return undefined;
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 8000).includes(0)) return undefined;
  const t = buf.toString('utf8');
  return t.length > EXCERPT ? `${t.slice(0, EXCERPT)}\n… (${t.length - EXCERPT} tekens meer)` : t;
}

function fileItem(value: string, full: string, readable: boolean): EvidenceItem {
  const st = fs.statSync(full);
  if (st.isDirectory()) return { type: 'file', value, ok: true, note: 'map bestaat' };
  const image = IMAGE_RE.test(full);
  const note = `${image ? 'afbeelding' : 'bestand'} bestaat (${sizeText(st.size)}, gewijzigd ${st.mtime.toISOString().slice(0, 16).replace('T', ' ')})`;
  if (!st.size) return { type: image ? 'screenshot' : 'file', value, ok: false, note: 'bestand is leeg' };
  if (image || !readable) return { type: image ? 'screenshot' : 'file', value, ok: true, note: readable ? note : `${note}; buiten de mappen van de bot, inhoud niet gelezen` };
  return { type: 'file', value, ok: true, note, excerpt: readExcerpt(full, st.size) };
}

/** Find a file the bot named: in the group folder (relative paths in a group), then in the bot's own folders. */
function findFile(ctx: Ctx, agent: Agent | null, value: string, roomFile?: (rel: string) => string | null): EvidenceItem {
  const p = value.replace(/^~[\\/]/, '');
  if (isProtectedPath(p)) return { type: 'file', value, ok: null, note: 'beschermd bestand (geheimen of sleutels); niet gelezen' };
  const tries: { full: string; readable: boolean }[] = [];
  if (!path.isAbsolute(p) && roomFile) {
    try {
      const f = roomFile(p);
      if (f) tries.push({ full: f, readable: true });
    } catch {
      /* not a valid group path */
    }
  }
  if (agent) {
    try {
      tries.push({ full: resolveInWorkspace(agent, p), readable: true });
    } catch {
      if (path.isAbsolute(p)) tries.push({ full: path.resolve(p), readable: false });
    }
    // A relative path may also be meant inside one of the bot's extra folders.
    if (!path.isAbsolute(p))
      for (const root of agentRoots(agent).slice(1)) {
        const full = path.resolve(root, p);
        const rel = path.relative(root, full);
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) tries.push({ full, readable: true });
      }
  } else if (path.isAbsolute(p)) tries.push({ full: path.resolve(p), readable: false });
  for (const t of tries) {
    try {
      if (fs.existsSync(t.full)) return fileItem(value, t.full, t.readable);
    } catch {
      /* unreadable: try the next place */
    }
  }
  return { type: IMAGE_RE.test(p) ? 'screenshot' : 'file', value, ok: false, note: 'bestand niet gevonden' };
}

/** Look at each piece of evidence (no model call). `steps`: what the bot really did in this turn. */
export function inspectEvidence(ctx: Ctx, o: { userId: string; agent: Agent | null; values: string[]; steps: StepItem[]; roomFile?: (rel: string) => string | null }): EvidenceItem[] {
  const outs = o.steps.filter((s) => s.out).map((s) => ({ s, text: norm(s.out!) }));
  const fromStep = (v: string) => {
    const n = norm(v);
    if (n.length < 8) return null;
    // Long output: a recognisable piece of it is enough (models shorten what they quote).
    const probe = n.length > 120 ? n.slice(0, 120) : n;
    return outs.find((x) => x.text.includes(probe))?.s || null;
  };
  return o.values.map((raw): EvidenceItem => {
    const v = dropLabel(unquote(raw));
    if (URL_RE.test(v)) {
      const s = fromStep(v);
      return s ? { type: 'link', value: v, ok: true, note: `link uit een echte stap (${s.summary.slice(0, 80)})` } : { type: 'link', value: v, ok: null, note: 'link (niet geopend)' };
    }
    if (ID_RE.test(v)) {
      if (v.startsWith('msg_')) {
        const m = ctx.store.message(v);
        const th = m ? ctx.store.thread(m.thread_id) : null;
        if (!m || !th || th.user_id !== o.userId || m.deleted) return { type: 'message', value: v, ok: false, note: 'bericht niet gevonden' };
        return { type: 'message', value: v, ok: true, note: `bericht van ${m.author_name || 'onbekend'} in “${th.title || 'gesprek'}”`, excerpt: String(m.content || '').slice(0, 600) };
      }
      const a = ctx.store.get<any>('attachments', v);
      if (!a || a.user_id !== o.userId) return { type: 'attachment', value: v, ok: false, note: 'bijlage niet gevonden' };
      const image = /^image\//.test(a.mime || '');
      return { type: image ? 'screenshot' : 'attachment', value: v, ok: true, note: `${image ? 'afbeelding' : 'bijlage'} “${a.name}” (${sizeText(Number(a.size) || 0)})` };
    }
    if (looksLikePath(v)) return findFile(ctx, o.agent, v, o.roomFile);
    const s = fromStep(v);
    if (s) return { type: 'output', value: v.slice(0, 600), ok: true, note: `staat in de uitvoer van een echte stap (${s.summary.slice(0, 80)})` };
    return { type: 'text', value: v.slice(0, 600), ok: null, note: 'niet terug te vinden in de stappen van deze beurt' };
  });
}
