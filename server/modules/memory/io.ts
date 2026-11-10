/**
 * Export (JSON + readable Markdown) and import of a memory export from another assistant (pasted Markdown/JSON/text):
 * every imported line becomes a review proposal, never an active memory. Imported text is data, not instructions.
 */
import { newId } from '../../core/db.js';
import type { MemoryService } from './service.js';
import type { ItemType, Outcome, Scope } from './types.js';
import { ITEM_TYPES, reviewInterval } from './types.js';
import { clean, normalize } from './text.js';
import { writeCandidate } from './pipeline.js';
import { getDossier, dossierMarkdown } from './dossiers.js';
import { renderEpisode } from './forget.js';
import { shortDate } from './context.js';
import { scopeLabel, typeLabel } from './forget.js';

export function exportJson(svc: MemoryService, userId: string) {
  const st = svc.store;
  const reader = svc.userReader(userId);
  const items = st.all<any>("SELECT * FROM memory_items WHERE user_id = ? AND status NOT IN ('forgotten','rejected') ORDER BY created_at", userId).map((r) => svc.view(st.decode('memory_items', r)));
  const dossiers = st
    .all<any>("SELECT id FROM memory_dossiers WHERE user_id = ? AND status != 'forgotten' ORDER BY created_at", userId)
    .map((d) => {
      const full = getDossier(svc, reader, d.id);
      if (!full) return null;
      const chunks = st.all<any>('SELECT source_id, seq, text FROM memory_chunks WHERE dossier_id = ? ORDER BY source_id, seq', d.id);
      return { ...full, changes: undefined, chunks };
    })
    .filter(Boolean);
  const sharedWithMe = st.all<any>('SELECT d.id, d.title, a.role, u.name AS owner FROM memory_dossier_acl a JOIN memory_dossiers d ON d.id = a.dossier_id LEFT JOIN users u ON u.id = d.user_id WHERE a.user_id = ?', userId);
  const episodes = st.all<any>('SELECT * FROM memory_episodes WHERE user_id = ? ORDER BY updated_at', userId).map((r) => st.decode('memory_episodes', r));
  const changes = st.all<any>('SELECT id, record_kind, record_id, op, summary, reason, actor, actor_id, created_at, undone_at FROM memory_changes WHERE user_id = ? ORDER BY created_at DESC LIMIT 2000', userId);
  const blocks = st.all<any>('SELECT id, kind, label, record_kind, created_at, expires_at FROM memory_tombstones WHERE user_id = ? ORDER BY created_at', userId);
  // Recurring subjects (0.4 F2): proposals and the notes waiting for them.
  const subjects = st.all<any>('SELECT id, name, kind, status, team_id, threads, pending, first_at, last_at FROM memory_subjects WHERE user_id = ? ORDER BY first_at', userId).map((r) => st.decode('memory_subjects', r));
  return {
    subjects,
    format: 'teambot.memory/v1',
    exported_at: new Date().toISOString(),
    user: { id: userId, name: st.user(userId)?.name },
    settings: svc.userSettings(userId),
    items,
    dossiers,
    shared_with_me: sharedWithMe,
    episodes,
    changes,
    blocks,
    note: 'Vergeten inhoud zit niet in deze export; blokkades bevatten alleen een label, geen inhoud.',
  };
}

export function exportMarkdown(svc: MemoryService, userId: string): string {
  const st = svc.store;
  const u = st.user(userId);
  const L: string[] = [`# Geheugen van ${u?.name || 'gebruiker'}`, '', `_Geëxporteerd uit TeamBot op ${new Date().toLocaleString('nl-NL')}. Ids tussen haken (zoals [m:abc123]) verwijzen naar items in TeamBot._`, ''];
  const items = st.all<any>("SELECT * FROM memory_items WHERE user_id = ? AND status IN ('active','proposed','archived') ORDER BY scope, agent_id, type, created_at", userId).map((r) => svc.view(st.decode('memory_items', r))!);
  const groups = new Map<string, any[]>();
  for (const i of items) {
    if (i.scope === 'dossier') continue;
    const k = i.scope === 'agent' ? `Bot: ${i.agent_name || 'onbekend'}` : scopeLabel(i.scope);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(i);
  }
  for (const [k, list] of groups) {
    L.push(`## ${k}`, '');
    for (const i of list)
      L.push(`- [m:${i.ref}] ${i.content.replace(/\n+/g, ' ')} _(${[typeLabel(i.type), i.status !== 'active' ? i.status : '', i.pinned ? 'vastgezet' : '', i.sensitivity !== 'normal' ? i.sensitivity : '', shortDate(i.observed_at || i.created_at), `bron: ${i.source_kind}`].filter(Boolean).join(', ')})_`);
    L.push('');
  }
  const reader = svc.userReader(userId);
  for (const d of st.all<any>("SELECT id FROM memory_dossiers WHERE user_id = ? AND status IN ('active','closed','archived') ORDER BY title", userId)) {
    L.push(dossierMarkdown(svc, reader, d.id).replace(/^# /, '## Dossier: ').replace(/\n## /g, '\n### '), '');
  }
  const eps = st.all<any>("SELECT * FROM memory_episodes WHERE user_id = ? AND summary != '' ORDER BY updated_at DESC LIMIT 500", userId).map((r) => st.decode<any>('memory_episodes', r));
  if (eps.length) {
    L.push('## Gesprekssamenvattingen', '');
    for (const e of eps) L.push(`### [e:${e.ref}] ${e.title || 'Gesprek'} (${shortDate(e.updated_at)})`, '', renderEpisode(e), '');
  }
  return L.join('\n');
}

// ---------------------------------------------------------------------------- import

const HEADING_TYPE: [RegExp, ItemType][] = [
  [/voorkeur|preference|likes|houdt van/i, 'preference'],
  [/instructie|instruction|regels|rules|stijl|style/i, 'instruction'],
  [/besluit|decision/i, 'decision'],
  [/taak|taken|todo|task/i, 'task'],
  [/les|lessons|learned|geleerd/i, 'lesson'],
  [/persoon|people|personen|contacts|familie|family/i, 'person'],
];

interface Parsed {
  content: string;
  type?: ItemType;
  key?: string | null;
  scope?: Scope;
  sensitivity?: any;
  reviewEveryDays?: number | null;
}

export function parseImport(text: string): Parsed[] {
  const t = String(text || '').trim();
  const out: Parsed[] = [];
  const push = (content: any, extra: Partial<Parsed> = {}) => {
    const c = clean(String(content ?? ''), 1000);
    if (c.length >= 3) out.push({ content: c, ...extra });
  };
  if (/^[[{]/.test(t)) {
    try {
      const data = JSON.parse(t);
      const fromObj = (o: any) => {
        if (typeof o === 'string') return push(o);
        if (!o || typeof o !== 'object') return;
        const content = o.content ?? o.text ?? o.memory ?? o.value ?? o.fact ?? o.note ?? o.description;
        if (content === undefined) return;
        push(content, {
          type: ITEM_TYPES.includes(o.type) ? o.type : undefined,
          key: typeof o.canonical_key === 'string' ? o.canonical_key : typeof o.key === 'string' ? o.key : null,
          scope: o.scope === 'about_you' ? 'about_you' : undefined,
          sensitivity: ['normal', 'personal', 'sensitive'].includes(o.sensitivity) ? o.sensitivity : undefined,
          reviewEveryDays: o.review_every_days !== undefined && o.review_every_days !== null ? reviewInterval(o.review_every_days) : undefined,
        });
      };
      if (data?.format === 'teambot.memory/v1' && Array.isArray(data.items)) {
        for (const i of data.items) if (['active', 'proposed', 'archived'].includes(i.status)) fromObj(i);
      } else if (Array.isArray(data)) data.forEach(fromObj);
      else for (const k of ['memories', 'memory', 'items', 'facts', 'notes', 'entries']) if (Array.isArray(data?.[k])) data[k].forEach(fromObj);
      return out.slice(0, 500);
    } catch {
      /* fall through to text */
    }
  }
  let hint: ItemType | undefined;
  let inCode = false;
  for (const raw of t.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (inCode || !line) continue;
    const h = line.match(/^#{1,6}\s+(.*)$/) || line.match(/^\*\*(.+)\*\*:?$/);
    if (h) {
      hint = HEADING_TYPE.find(([re]) => re.test(h[1]))?.[1];
      continue;
    }
    const item = line.replace(/^([-*•·]|\d+[.)]|\[[ xX]\])\s+/, '').replace(/^\[[ xX]\]\s+/, '').trim();
    if (!item || /^(-{3,}|={3,})$/.test(item)) continue;
    if (item.length > 1000) {
      for (const part of item.split(/(?<=[.!?])\s+/)) push(part, { type: hint });
    } else push(item, { type: hint });
    if (out.length >= 500) break;
  }
  return out;
}

export function importText(svc: MemoryService, userId: string, text: string, o: { scope?: Scope; agentId?: string | null; dossierId?: string | null; label?: string; teamId?: string | null } = {}) {
  if (String(text || '').length > 200_000) throw new Error('Te veel tekst (maximaal 200.000 tekens per import)');
  const parsed = parseImport(text);
  const batch = newId('imp_');
  const counts: Record<string, number> = {};
  const examples: { content: string; action: string; message: string }[] = [];
  for (const p of parsed) {
    const scope: Scope = p.scope || o.scope || 'about_you';
    const out: Outcome = writeCandidate(svc, {
      userId,
      content: p.content,
      scope,
      agentId: scope === 'agent' ? o.agentId : null,
      dossierId: scope === 'dossier' ? o.dossierId : null,
      // Shared knowledge from an import: the team the owner chose (else the default team).
      teamId: scope === 'shared' ? o.teamId ?? null : null,
      type: p.type,
      key: p.key,
      sensitivity: p.sensitivity,
      reviewEveryDays: p.reviewEveryDays ?? undefined,
      source: { kind: 'import', ref: `${batch}${o.label ? ':' + clean(o.label, 60) : ''}`, trust: 'import' },
      origin: 'import',
      createdBy: 'import',
      forcePropose: true,
      proposalReason: 'import',
      idemKey: `imp:${svc.hmac(userId, normalize(p.content) + '|' + scope + '|' + (o.agentId || '') + (scope === 'shared' && o.teamId ? '|' + o.teamId : ''), 24)}`,
    });
    counts[out.action] = (counts[out.action] || 0) + 1;
    if (examples.length < 20 && out.action !== 'proposed') examples.push({ content: out.reason === 'secret' ? '(verborgen: lijkt op een geheim)' : p.content.slice(0, 120), action: out.action, message: out.message });
  }
  svc.ctx.audit(userId, 'memory.imported', { batch, total: parsed.length, counts });
  return { batch, total: parsed.length, counts, proposed: (counts.proposed || 0) + (counts.conflict || 0), examples };
}
