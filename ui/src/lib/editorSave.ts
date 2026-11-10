import { createContext, useContext, useEffect, useRef } from 'react';

/**
 * One "Opslaan" for the whole bot editor. Core fields live in the editor's draft; a module section with its own
 * state (e.g. Computer & bestanden) registers here, so the editor's main button saves it too, the sticky bar can
 * name it while it has unsaved changes, and leaving the editor warns instead of silently dropping it. Sections that
 * save every change at once (Apps, Kanalen, Meldingen …) need nothing: they have nothing pending.
 */

export interface EditorSection {
  /** Shown in "Niet opgeslagen: …". */
  label: string;
  /** True while the section holds changes that are not on the server yet. */
  dirty(): boolean;
  /**
   * Runs before the bot itself is saved; may return a patch for the bot (merged into what is saved), e.g. a typed
   * folder that was not added yet. Throw to stop the save with a clear message.
   */
  prepare?(): Promise<Record<string, any> | void> | Record<string, any> | void;
  /** Runs after the bot itself is saved (the section stores its own settings). */
  save?(): Promise<void>;
}

export interface EditorSaveApi {
  register(id: string, s: EditorSection): () => void;
  /** The server already has this patch (a section saved it itself): update the draft without marking it unsaved. */
  synced(patch: Record<string, any>): void;
  /** Ask the editor to recompute its unsaved-changes state (call after a section's dirty() may have changed). */
  changed(): void;
}

export const EditorSaveContext = createContext<EditorSaveApi | null>(null);

/**
 * Register a bot-editor section with its own state. `dirty`, `prepare` and `save` may change every render; the
 * latest version is used. Outside the editor (no provider) this does nothing.
 */
export function useEditorSection(id: string, s: EditorSection) {
  const api = useContext(EditorSaveContext);
  const ref = useRef(s);
  ref.current = s;
  useEffect(() => {
    if (!api) return;
    return api.register(id, {
      get label() {
        return ref.current.label;
      },
      dirty: () => {
        try {
          return !!ref.current.dirty();
        } catch {
          return false;
        }
      },
      prepare: () => ref.current.prepare?.(),
      save: () => ref.current.save?.() ?? Promise.resolve(),
    });
  }, [api, id]);
  // Let the editor's sticky bar follow the section's state.
  const dirty = (() => {
    try {
      return !!s.dirty();
    } catch {
      return false;
    }
  })();
  useEffect(() => {
    api?.changed();
  }, [api, dirty]);
  return api;
}

// ---------------------------------------------------------------- pure helpers (unit-tested)

/** Stable JSON: object keys sorted, undefined dropped (so `{a: undefined}` equals `{}`). */
export function stableJson(v: any): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : stableJson(x))).join(',') + ']';
  return (
    '{' +
    Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stableJson(v[k]))
      .join(',') +
    '}'
  );
}

/** Fields that are shown by the server but never edited in the editor (changing them elsewhere is not "unsaved"). */
const IGNORED = new Set(['id', 'user_id', 'created_at', 'updated_at', 'sort', 'pinned', 'archived', 'version', 'shared', 'owner_name']);

/** Labels for the sticky bar, per bot field. */
const FIELD_LABEL: Record<string, string> = {
  name: 'Naam',
  avatar: 'Gezicht',
  color: 'Gezicht',
  role: 'Rol',
  description: 'Beschrijving',
  instructions: 'Instructies',
  provider_id: 'Model',
  model: 'Model',
  reasoning: 'Model',
  fallback: 'Model',
  access_mode: 'Toegang',
  tool_groups: 'Tools',
  tool_policy: 'Tools',
  skills: 'Skills',
  busy_policy: 'Gedrag',
  workspace: 'Werkmap',
  settings: 'Instellingen',
  'settings.folders': 'Mappen',
  'settings.extraRoots': 'Mappen',
  'settings.voice': 'Spraak',
  'settings.memory': 'Geheugen',
  'settings.cli': 'CLI-agent',
  'settings.fallbacks': 'Model',
  'settings.notifications': 'Meldingen',
  'settings.language': 'Taal van de antwoorden',
  'settings.answerStyle': 'Antwoordstijl',
};

/** Empty strings and missing values are the same thing for a draft (an untouched workspace field is '' or undefined). */
const norm = (v: any) => (v === '' || v === null ? undefined : v);

/** Which bot fields differ between what is saved and the draft (deep compare; `settings` per key, e.g. settings.voice). */
export function changedFields(saved: Record<string, any> | null | undefined, draft: Record<string, any> | null | undefined): string[] {
  if (!saved || !draft) return [];
  const out: string[] = [];
  const diff = (a: Record<string, any>, b: Record<string, any>, prefix: string) => {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!prefix && IGNORED.has(k)) continue;
      if (stableJson(norm(a[k])) === stableJson(norm(b[k]))) continue;
      if (!prefix && k === 'settings') diff(a[k] || {}, b[k] || {}, 'settings.');
      else out.push(prefix + k);
    }
  };
  diff(saved, draft, '');
  return out.sort();
}

/** Which collapsible editor section holds a bot field (for the "Niet opgeslagen" mark on a closed section). */
const FIELD_SECTION: Record<string, string> = {
  reasoning: 'core:engine',
  busy_policy: 'core:engine',
  fallback: 'core:engine',
  'settings.fallbacks': 'core:engine',
  'settings.onLimit': 'core:engine',
  workspace: 'core:workspace',
  'settings.folders': 'core:workspace',
  'settings.extraRoots': 'core:workspace',
  skills: 'skills:skills',
  'settings.voice': 'voice:voice',
  'settings.memory': 'memory:memory',
  'settings.cli': 'cli-agents:cli',
  'settings.notifications': 'notifications:meldingen',
};
/** Tool groups that are switched in a module's own section instead of under Tools. */
const GROUP_SECTION: Record<string, string> = { channels: 'channels:channels', routines: 'routines:routines' };
/** Per-tool rules that are set in a module's own section ("elke klik eerst vragen" in Computer). */
const TOOL_SECTION = (tool: string) => (tool.startsWith('browser_') ? 'browser:computer' : 'core:tools');

/** The editor sections with unsaved bot fields (fields shown in the always-open part are left out). */
export function dirtySectionKeys(saved: Record<string, any> | null | undefined, draft: Record<string, any> | null | undefined): string[] {
  if (!saved || !draft) return [];
  const out = new Set<string>();
  for (const f of changedFields(saved, draft)) {
    if (f === 'tool_groups') {
      const a = new Set<string>(saved.tool_groups || []);
      const b = new Set<string>(draft.tool_groups || []);
      for (const g of new Set([...a, ...b])) if (a.has(g) !== b.has(g)) out.add(GROUP_SECTION[g] || 'core:tools');
    } else if (f === 'tool_policy') {
      const a = saved.tool_policy || {};
      const b = draft.tool_policy || {};
      for (const t of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[t] !== b[t]) out.add(TOOL_SECTION(t));
    } else if (FIELD_SECTION[f]) out.add(FIELD_SECTION[f]);
  }
  return [...out].sort();
}

/** Human labels for changed fields + dirty sections, without duplicates, in a stable order. */
export function unsavedLabels(fields: string[], sections: string[]): string[] {
  const out: string[] = [];
  for (const f of fields) {
    const l = FIELD_LABEL[f] || 'Instellingen';
    if (!out.includes(l)) out.push(l);
  }
  for (const s of sections) if (!out.includes(s)) out.push(s);
  return out;
}

/** "Naam, Tools en Computer & bestanden" */
export function listNl(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return items.slice(0, -1).join(', ') + ' en ' + items[items.length - 1];
}

/**
 * Save the dirty sections one after another; a failing section does not stop the others. Returns which saved and
 * which failed (with the error message), so the editor can say exactly what is not stored.
 */
export async function flushSections(list: { label: string; dirty(): boolean; save?(): Promise<void> }[]): Promise<{ saved: string[]; failed: { label: string; error: string }[] }> {
  const saved: string[] = [];
  const failed: { label: string; error: string }[] = [];
  for (const s of list) {
    if (!s.dirty() || !s.save) continue;
    try {
      await s.save();
      saved.push(s.label);
    } catch (e: any) {
      failed.push({ label: s.label, error: String(e?.message || e) });
    }
  }
  return { saved, failed };
}

/** Run `prepare` of the dirty sections and merge their patches (later sections win per top-level key; settings merged). */
export async function prepareSections(list: { label: string; dirty(): boolean; prepare?(): any }[], base: Record<string, any>): Promise<Record<string, any>> {
  let out = { ...base };
  for (const s of list) {
    if (!s.dirty() || !s.prepare) continue;
    const p = await s.prepare();
    if (!p) continue;
    out = { ...out, ...p, ...(p.settings ? { settings: { ...(out.settings || {}), ...p.settings } } : {}) };
  }
  return out;
}
