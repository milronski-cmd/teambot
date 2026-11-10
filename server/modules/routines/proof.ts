import fs from 'node:fs';
import path from 'node:path';
import type { Agent, Ctx } from '../../core/types.js';
import { agentRootList } from '../../tools/builtin/files.js';

/**
 * Proof for a routine run ("Bewijs bij elke klaar"): a run only counts as geslaagd with a result TeamBot can see —
 * a file written in the bot's folders, a message sent, a task created, another action with outside impact, or an
 * answer that is more than "klaar". Otherwise it is *zonder resultaat*. Nothing here asks the model: the evidence is
 * what TeamBot itself recorded (the audit log of tool calls for this bot during the run) plus the files in the bot's
 * writable folders that changed during the run (that also covers a CLI engine writing on its own).
 */

export type ProofResult = 'proven' | 'answer' | 'none';

export interface ProofItem {
  kind: 'file' | 'message' | 'task' | 'action';
  /** Plain words: "rapport.md geschreven", "bericht via Telegram verstuurd". */
  text: string;
}

export interface Proof {
  result: ProofResult;
  items: ProofItem[];
  /** The answer itself counts (more than a bare "klaar"). */
  answer: boolean;
  /** What the answer says was done, but TeamBot did not see (e.g. "een bestand"). */
  claims: string[];
  /** One sentence for the receipt and the notification when there is no result. */
  reason: string;
}

const MESSAGE_TOOLS = /^(channel_send|notify_user|site_publish)$|(^|_)(send|reply|publish|post|mail|email|message)(_|$)/i;
const TASK_TOOLS = /^(task_create)$/;
const FILE_TOOLS: Record<string, string> = { write_file: 'geschreven', edit_file: 'bewerkt', delete_file: 'naar de prullenbak', share_file: 'gedeeld', browser_download: 'gedownload', room_file_write: 'geschreven' };
/** Tools that only read, look or keep the bot's own notes: never a result on their own. */
const NOT_A_RESULT = /^(routine_no_update|read_file|list_files|search_files|web_search|web_fetch|read_document|memory_|dossier_|task_list|task_update|routine_|wait_for|delegat|ask_bot|message_bot|broadcast|handoff|workspace_snapshot|rehearsal_|skill_|team_query|team_tables|site_list|channel_list|run_command|browser_(snapshot|screenshot|tabs|wait|scroll|back|navigate|open|close|click|type|press|select))/;

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '__pycache__', 'venv', '.venv', 'target', 'coverage']);

const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
/** A path as the owner knows it: relative to the bot's work folder, or "<folder label>/<path>" in another folder. */
function shortIn(agent: Agent, p: string): string {
  const hits = agentRootList(agent)
    .map((r) => ({ r, rel: path.relative(norm(r.path), norm(p)) }))
    .filter((x) => x.rel && !x.rel.startsWith('..') && !path.isAbsolute(x.rel))
    .sort((a, b) => a.rel.length - b.rel.length);
  const hit = hits[0];
  if (!hit) return path.basename(p);
  const rel = path.relative(hit.r.path, path.resolve(p)).split(path.sep).join('/');
  return hit.r.kind === 'workspace' ? rel : `${hit.r.label}/${rel}`;
}

/**
 * A bare completion claim without content: "Klaar.", "Gedaan!", "OK", "✅", "Taak uitgevoerd", "Done". Also empty and
 * very short answers. A real answer (a reminder, a summary, a result) is not bare.
 */
export function isBareClaim(text: string): boolean {
  const t = String(text || '')
    .replace(/[`*_#>~|[\]()]/g, ' ')
    .replace(/\p{Extended_Pictographic}|\p{Emoji_Presentation}|[☀-➿️]/gu, ' ')
    .replace(/[.!?,:;–—-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (t.length <= 3) return true;
  const done = '(?:klaar|gedaan|afgerond|voltooid|uitgevoerd|gelukt|verwerkt|done|finished|completed|complete|ok|oké|okay|prima|in orde)';
  return new RegExp(
    `^(?:(?:ik ben|alles is|het is|dat is|is|de taak is|taak is|de opdracht is|opdracht is|de routine is|routine is|taak|opdracht|routine|task|all|it is|it's)\\s+)?${done}(?:\\s+(?:hoor|dus|zoals gevraagd|as requested))?$`,
  ).test(t);
}

const FILE_NAME = String.raw`[\w.-]+\.(?:md|txt|csv|tsv|json|pdf|docx|xlsx|pptx|html?|png|jpe?g|svg|ics|xml|ya?ml|log)`;
/** What an answer says was done, per kind (first person, or a named file), so a missing result can be named. */
const CLAIMS: { kind: ProofItem['kind']; words: string; re: RegExp }[] = [
  {
    kind: 'file',
    words: 'een opgeslagen bestand',
    re: new RegExp(
      String.raw`\b(?:ik\s+heb|heb\s+ik|i\s+have|i've)\b[^.!?\n]{0,120}?\b(?:opgeslagen|geschreven|weggeschreven|aangemaakt|bijgewerkt|bewaard|saved|written|wrote|created|updated)\b|\b(?:opgeslagen|geschreven|aangemaakt|bijgewerkt|bewaard|saved|written|created)\s+(?:als|in|naar|to|as)\s+[^\s]*${FILE_NAME}|${FILE_NAME}[^.!?\n]{0,40}\b(?:opgeslagen|aangemaakt|geschreven|bijgewerkt|saved|created|written)\b`,
      'i',
    ),
  },
  { kind: 'message', words: 'een verstuurd bericht', re: /\b(?:ik\s+heb|heb\s+ik|i\s+have|i've)\b[^.!?\n]{0,120}?\b(?:verstuurd|gestuurd|verzonden|gemaild|doorgestuurd|gepost|sent|emailed|posted|forwarded)\b|^\W*(?:het\s+)?(?:bericht|mail|e-mail|herinnering)\s+(?:is\s+)?(?:verstuurd|verzonden|gestuurd)\b/im },
  { kind: 'task', words: 'een taak op het takenbord', re: /\b(?:ik\s+heb|heb\s+ik|i\s+have|i've)\b[^.!?\n]{0,80}?\b(?:taak|taken|task|tasks)\b[^.!?\n]{0,40}?\b(?:aangemaakt|toegevoegd|gezet|created|added)\b/i },
];

/** Files in the bot's writable folders that changed between `from` and `to` (bounded walk, no hidden or build folders). */
export function changedFiles(agent: Agent, fromMs: number, toMs: number, max = 20): string[] {
  const out: string[] = [];
  let visited = 0;
  const walk = (dir: string, depth: number) => {
    if (out.length >= max || visited > 4000 || depth > 6) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max || ++visited > 4000) return;
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name) || e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile()) {
        const st = fs.statSync(full, { throwIfNoEntry: false });
        // From the start of the run (a write just before it is someone else's), a little slack after its end.
        if (st && st.mtimeMs >= fromMs && st.mtimeMs <= toMs + 2000) out.push(full);
      }
    }
  };
  for (const r of agentRootList(agent)) if (r.mode === 'rw') walk(r.path, 0);
  return out;
}

/** Collect the proof for one finished run of `agent` between `fromMs` and `toMs` with final answer `text`. */
export function gatherProof(ctx: Ctx, agent: Agent, o: { fromMs: number; toMs: number; text: string }): Proof {
  const items: ProofItem[] = [];
  const seen = new Set<string>();
  const short = (p: string) => shortIn(agent, String(p));
  const add = (kind: ProofItem['kind'], text: string) => {
    const k = `${kind}:${text}`;
    if (seen.has(k) || items.length >= 30) return;
    seen.add(k);
    items.push({ kind, text });
  };
  // From the moment the run started (its tool calls all come after that), a little slack after its end.
  const from = new Date(o.fromMs).toISOString();
  const to = new Date(o.toMs + 1000).toISOString();
  const rows = ctx.store.all<any>(
    "SELECT kind, data FROM audit WHERE user_id = ? AND agent_id = ? AND created_at >= ? AND created_at <= ? AND kind IN ('tool.call','file.write','file.edit','file.delete','cli.fs_write','cli.permission') ORDER BY id LIMIT 1000",
    agent.user_id,
    agent.id,
    from,
    to,
  );
  for (const r of rows) {
    let d: any = {};
    try {
      d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data || {};
    } catch {
      d = {};
    }
    if (r.kind === 'file.write' && d.path) add('file', `${short(d.path)} geschreven`);
    else if (r.kind === 'file.edit' && d.path) add('file', `${short(d.path)} bewerkt`);
    else if (r.kind === 'file.delete' && d.path) add('file', `${short(d.path)} ${d.permanent ? 'verwijderd' : 'naar de prullenbak'}`);
    else if (r.kind === 'cli.fs_write' && (d.path || d.file)) add('file', `${short(d.path || d.file)} geschreven`);
    else if (r.kind === 'cli.permission' && d.allowed && /:(Write|Edit|MultiEdit|NotebookEdit|edit|bestanden)\b/.test(String(d.tool || ''))) add('file', String(d.summary || 'een bestand bewerkt').slice(0, 120));
    else if (r.kind === 'tool.call' && !d.error && !d.denied) {
      const name = String(d.tool || '');
      if (!name || NOT_A_RESULT.test(name)) continue;
      const summary = String(d.summary || name).replace(/\s+/g, ' ').slice(0, 140);
      if (FILE_TOOLS[name]) continue; // its own file.* line above says which file
      if (TASK_TOOLS.test(name)) add('task', summary);
      else if (MESSAGE_TOOLS.test(name) && (d.risk === 'danger' || name === 'notify_user' || name === 'channel_send')) add('message', summary);
      // Anything else with an effect (a page in a connected app, a submitted form): a result in its own right.
      else if (d.risk === 'danger' || d.risk === 'write') add('action', summary);
    }
  }
  // A CLI engine (or anything else of the bot) that wrote files without telling TeamBot: the folders show it.
  if (!items.some((i) => i.kind === 'file')) for (const f of changedFiles(agent, o.fromMs, o.toMs)) add('file', `${short(f)} gewijzigd`);

  const text = String(o.text || '');
  const answer = !isBareClaim(text);
  const has = (k: ProofItem['kind']) => items.some((i) => i.kind === k);
  const claims = CLAIMS.filter((c) => c.re.test(text) && !has(c.kind)).map((c) => c.words);
  const result: ProofResult = items.length ? 'proven' : answer && !claims.length ? 'answer' : 'none';
  const reason =
    result !== 'none'
      ? ''
      : claims.length
        ? `De bot meldde ${claims.join(' en ')}, maar TeamBot zag dat niet gebeuren: geen bestand, bericht of taak.`
        : text.trim()
          ? `De bot meldde “${text.replace(/\s+/g, ' ').trim().slice(0, 60)}”, maar er is geen resultaat: geen bestand, bericht of taak, en geen inhoudelijk antwoord.`
          : 'De bot gaf geen antwoord en leverde geen bestand, bericht of taak.';
  return { result, items, answer, claims, reason };
}
