/**
 * "Geheugen overnemen uit ChatGPT, Claude of Gemini" (0.4.4, item 12). The owner asks the other assistant to write down
 * everything it knows about him (the question is on the page), pastes the answer, and TeamBot:
 *  - turns it into short facts for "Over jou" (an assistant's chatter around the list, Claude's prose memory summary
 *    and its data-export JSON are handled; a long paragraph is split into sentences);
 *  - shows a preview first that writes nothing: new, already known (exact, nearly the same, or twice in the paste),
 *    refused (looks like a password or key), forgotten before, or rejected before;
 *  - imports every new line as a proposal (Geheugen › Te beoordelen), never as an active memory, through the regular
 *    pipeline (dedup, conflicts, secrets, forget-blocks);
 *  - can undo the whole import in one go (each item's own changes undone through the memory history).
 * The pasted text is data, never an instruction to a bot: lines that read like one are kept as data with a flag.
 */
import type { Ctx } from '../../core/types.js';
import { ah, bad, HttpError, str, user } from '../../core/http.js';
import type { MemoryService } from './service.js';
import type { ItemType, Scope } from './types.js';
import { ALL_TEAMS } from './types.js';
import { clean, detectSecret, isInjectionLike, normalize } from './text.js';
import { importText, parseImport } from './io.js';

export const ASSISTANT_SOURCES = ['chatgpt', 'claude', 'gemini', 'other'] as const;
export type AssistantSource = (typeof ASSISTANT_SOURCES)[number];
const SOURCE_LABEL: Record<AssistantSource, string> = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
  other: 'andere assistent',
};
const MAX_CHARS = 200_000;

/** Lines around the list that are the assistant talking, not a fact ("Hier is wat ik over je weet:", "Laat me weten …"). */
const CHATTER = [
  /^(hier (is|zijn)|dit is|dit zijn|zeker|natuurlijk|graag|goed(e vraag)?|oké|ok)\b.*:?$/i,
  /^(here('s| is| are)|sure|certainly|of course|absolutely|great question)\b.*:?$/i,
  /\b(wat ik (over|van) (je|jou|u) weet|what i know about you|i know about you|i remember about you|ik weet over (je|jou))\b.*:\s*$/i,
  /^(laat (me|het) (maar )?weten|wil je (dat ik|nog)|kan ik (je )?(nog )?(ergens|iets)|ik hoop dat|let me know|do you want|would you like|is there anything|i hope this|feel free)\b/i,
  /^(note|let op|opmerking)\s*:\s*(this|dit|deze lijst|ik)\b/i,
];

/** Extra heading words that the generic import does not know ("Over mij", "Work context", "Top of mind"). */
const HEADING_HINTS: [RegExp, ItemType][] = [
  [/over mij|about me|personal|persoonlijk|identiteit|identity|achtergrond|background|werk|work|beroep|career|job|context|top of mind|history|geschiedenis/i, 'fact'],
];

/** The text of an assistant's export as Markdown lines the generic parser understands. */
export function normalizeAssistantExport(raw: string): string {
  let text = String(raw || '')
    .replace(/^﻿/, '')
    .trim();
  // Claude's data export (memories.json): [{ conversations_memory: "<prose>", project_memories: { id: "<prose>" } }].
  if (/^[[{]/.test(text)) {
    try {
      const data = JSON.parse(text);
      const list = Array.isArray(data) ? data : [data];
      const prose: string[] = [];
      for (const o of list) {
        if (typeof o?.conversations_memory === 'string') prose.push(o.conversations_memory);
        if (o?.project_memories && typeof o.project_memories === 'object') for (const v of Object.values(o.project_memories)) if (typeof v === 'string') prose.push(v);
      }
      if (prose.length) text = prose.join('\n\n');
      else return text; // another JSON shape: the generic import reads it (memories/items/facts arrays).
    } catch {
      /* not JSON: text */
    }
  }
  const out: string[] = [];
  let inCode = false;
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line.startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (inCode || !line) {
      out.push('');
      continue;
    }
    if (CHATTER.some((re) => re.test(line))) continue;
    // "**Werk**" or "**Work context**" on its own line, or a Markdown heading: keep as a heading.
    const bold = line.match(/^\*\*(.+?)\*\*:?$/);
    if (bold) line = `## ${bold[1]}`;
    const head = line.match(/^#{1,6}\s+(.*)$/);
    if (head) {
      const hint = HEADING_HINTS.find(([re]) => re.test(head[1]));
      out.push(
        hint && !/voorkeur|preference|instructie|instruction|regels|rules|stijl|style|besluit|decision|taak|task|les|lesson|persoon|people|personen|contacts|familie|family/i.test(head[1])
          ? '## Feiten'
          : line,
      );
      continue;
    }
    // Formatting inside a fact ("**Naam:** Sanne") is not part of it.
    line = line.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1');
    const bullet = /^([-*•·]|\d+[.)]|\[[ xX]\])\s+/.test(line);
    if (!bullet && /[.!?]\s+\S/.test(line)) {
      // A paragraph of prose (Claude's memory summary): one fact per sentence.
      for (const s of line.split(/(?<=[.!?])\s+(?=[A-ZÀ-ÖØ-Þ0-9"“(])/)) if (s.trim().length >= 3) out.push(`- ${s.trim()}`);
      continue;
    }
    out.push(line);
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export type PreviewStatus = 'new' | 'duplicate' | 'repeat' | 'secret' | 'blocked' | 'rejected_before';

export interface PreviewLine {
  content: string;
  type: ItemType | null;
  status: PreviewStatus;
  /** Reads like an instruction to a bot: imported as data, with a flag. */
  instructionLike?: boolean;
}

/** What an import would do, line by line, without writing anything. */
export function previewAssistantImport(svc: MemoryService, userId: string, text: string, o: { scope?: Scope; teamId?: string | null } = {}) {
  if (String(text || '').length > MAX_CHARS) throw new Error('Te veel tekst (maximaal 200.000 tekens per import)');
  const parsed = parseImport(normalizeAssistantExport(text));
  const scope: Scope = o.scope === 'shared' ? 'shared' : 'about_you';
  const bucket = {
    scope,
    agent_id: null,
    dossier_id: null,
    team_id: scope === 'shared' && o.teamId && o.teamId !== ALL_TEAMS ? o.teamId : null,
  };
  const seen = new Set<string>();
  const lines: PreviewLine[] = [];
  for (const p of parsed) {
    const content = clean(p.content);
    const line: PreviewLine = { content, type: p.type ?? null, status: 'new' };
    const n = normalize(content);
    if (detectSecret(content)) {
      line.status = 'secret';
      line.content = '(verborgen: lijkt op een wachtwoord of sleutel)';
    } else if (seen.has(n)) line.status = 'repeat';
    else if (svc.blockedBy(userId, content, null, ['forget'])) line.status = 'blocked';
    else if (svc.blockedBy(userId, content, null, ['reject'])) line.status = 'rejected_before';
    else if (svc.exactDuplicate(userId, bucket, svc.contentHash(userId, content))) line.status = 'duplicate';
    else {
      const top = svc.similar(userId, bucket, content, 3).filter((s) => s.row.status === 'active' || s.row.status === 'proposed')[0];
      if (top && top.sim >= 0.9) line.status = 'duplicate';
    }
    if (line.status === 'new' && isInjectionLike(content)) line.instructionLike = true;
    seen.add(n);
    lines.push(line);
  }
  const counts: Record<PreviewStatus, number> = {
    new: 0,
    duplicate: 0,
    repeat: 0,
    secret: 0,
    blocked: 0,
    rejected_before: 0,
  };
  for (const l of lines) counts[l.status]++;
  return { total: lines.length, counts, lines: lines.slice(0, 500) };
}

/** Import as proposals (one batch); the batch id is what "Ongedaan maken" uses. */
export function importAssistantMemory(svc: MemoryService, userId: string, text: string, o: { source?: string; scope?: Scope; teamId?: string | null } = {}) {
  const source = (ASSISTANT_SOURCES as readonly string[]).includes(String(o.source)) ? (o.source as AssistantSource) : 'other';
  const scope: Scope = o.scope === 'shared' ? 'shared' : 'about_you';
  const normalized = normalizeAssistantExport(text);
  if (!parseImport(normalized).length) throw new Error('Geen feiten gevonden in de geplakte tekst. Plak het antwoord van de assistent (een lijst met één feit per regel).');
  const res = importText(svc, userId, normalized, {
    scope,
    label: `uit ${SOURCE_LABEL[source]}`,
    teamId: scope === 'shared' ? (o.teamId ?? null) : null,
  });
  svc.ctx.audit(userId, 'memory.assistant_imported', {
    batch: res.batch,
    source,
    total: res.total,
    proposed: res.proposed,
  });
  return { ...res, source, label: SOURCE_LABEL[source] };
}

/** Items of one import batch that are still there (proposed, active or archived). */
function batchItems(svc: MemoryService, userId: string, batch: string) {
  return svc.store.all<any>(
    "SELECT id, status FROM memory_items WHERE user_id = ? AND source_kind = 'import' AND (source_ref = ? OR source_ref LIKE ?) AND status IN ('proposed','active','archived')",
    userId,
    batch,
    `${batch}:%`,
  );
}

/** Undo one import: every item of the batch goes back (to the trash), with its own changes undone newest first. */
export function undoAssistantImport(svc: MemoryService, userId: string, batch: string) {
  if (!/^imp_[A-Za-z0-9_-]{4,40}$/.test(batch)) throw new HttpError(400, 'Onbekende import');
  const items = batchItems(svc, userId, batch);
  if (!items.length) throw new HttpError(404, 'Niets meer om ongedaan te maken voor deze import.');
  const r = undoImportItems(svc, userId, items);
  svc.ctx.audit(userId, 'memory.import_undone', { batch, ...r });
  svc.ctx.events.emit(userId, 'memory.updated', { op: 'undo', batch });
  return r;
}

/** Undo imported items: each item's own changes, newest first (a proposal goes to the trash; an approved one too). */
export function undoImportItems(svc: MemoryService, userId: string, items: { id: string }[]) {
  let removed = 0;
  let kept = 0;
  for (const it of items) {
    const changes = svc.store.all<any>("SELECT id FROM memory_changes WHERE record_id = ? AND user_id = ? AND undone_at IS NULL AND op != 'undo' ORDER BY created_at DESC, rowid DESC", it.id, userId);
    try {
      for (const ch of changes) {
        // An earlier undo in this loop may have undone a batch this change belonged to.
        const cur = svc.store.one<any>('SELECT undone_at FROM memory_changes WHERE id = ?', ch.id);
        if (cur?.undone_at) continue;
        svc.undo(userId, ch.id, userId);
      }
      const after = svc.store.one<any>('SELECT status FROM memory_items WHERE id = ?', it.id);
      if (after && ['proposed', 'active', 'archived'].includes(after.status)) kept++;
      else {
        // Importing the same text again later must work: the import's idempotency key goes with the undone item.
        svc.store.exec('UPDATE memory_items SET idem_key = NULL WHERE id = ?', it.id);
        removed++;
      }
    } catch {
      kept++;
    }
  }
  return { removed, kept };
}

/** The owner's recent imports from another assistant (for "Ongedaan maken" later). */
export function recentImports(svc: MemoryService, userId: string) {
  const rows = svc.store.all<any>(
    "SELECT source_ref, status, created_at FROM memory_items WHERE user_id = ? AND source_kind = 'import' AND source_ref LIKE 'imp_%' ORDER BY created_at DESC LIMIT 2000",
    userId,
  );
  const map = new Map<string, { batch: string; label: string; at: string; open: number; active: number }>();
  for (const r of rows) {
    const [batch, ...rest] = String(r.source_ref).split(':');
    const e = map.get(batch) || {
      batch,
      label: rest.join(':'),
      at: r.created_at,
      open: 0,
      active: 0,
    };
    if (r.status === 'proposed') e.open++;
    if (r.status === 'active' || r.status === 'archived') e.active++;
    if (r.created_at < e.at) e.at = r.created_at;
    map.set(batch, e);
  }
  return [...map.values()].filter((e) => e.open + e.active > 0).slice(0, 10);
}

export function assistantImportRoutes(ctx: Ctx, svc: MemoryService) {
  const api = ctx.api;
  const body = (req: any) => {
    const b = req.body || {};
    const text = str(b.text, MAX_CHARS);
    if (!text.trim()) throw bad('Plak eerst het antwoord van de andere assistent.');
    const scope: Scope = b.scope === 'shared' ? 'shared' : 'about_you';
    const teamId = scope === 'shared' && typeof b.teamId === 'string' && (b.teamId === ALL_TEAMS || svc.validTeam(user(req).id, b.teamId)) ? b.teamId : null;
    return { text, scope, teamId, source: str(b.source, 20) };
  };
  api.post(
    '/memory/import/preview',
    ah(async (req) => {
      const u = user(req);
      const b = body(req);
      return previewAssistantImport(svc, u.id, b.text, b);
    }),
  );
  api.post(
    '/memory/import/assistant',
    ah(async (req) => {
      const u = user(req);
      const b = body(req);
      try {
        return importAssistantMemory(svc, u.id, b.text, b);
      } catch (e: any) {
        if (e instanceof HttpError) throw e;
        throw bad(String(e?.message || e));
      }
    }),
  );
  api.get(
    '/memory/import/recent',
    ah(async (req) => recentImports(svc, user(req).id)),
  );
  api.post(
    '/memory/import/:batch/undo',
    ah(async (req) => undoAssistantImport(svc, user(req).id, str(req.params.batch, 60))),
  );
}
