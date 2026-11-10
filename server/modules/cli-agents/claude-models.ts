import fs from 'node:fs';
import { startProc } from './proc.js';

/**
 * The models a Claude Code login can use, as Claude Code itself reports them: the local `/model` command in print
 * mode answers without a model call (cost 0, verified with 2.1.319) with the current model and the aliases it knows
 * ("Available: sonnet, opus, haiku, fable, best, sonnet[1m], …"); the `init` event names the full model id an alias
 * resolves to (opus → claude-opus-5-5). One quick probe per alias, in parallel, cached per binary.
 */

export interface ClaudeModel {
  id: string;
  label: string;
}

interface Probe {
  /** Full id from the init event, e.g. "claude-opus-5-5". */
  id?: string;
  /** Display name from "/model", e.g. "Opus 5.5". */
  name?: string;
  aliases: string[];
  /** The command was answered locally (no model call). */
  local: boolean;
}

const ARGS = ['-p', '--output-format', 'stream-json', '--verbose', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--max-turns', '1'];
const ALIAS = /^[a-z][\w.-]{0,40}(\[1m\])?$/i;

export function parseModelCommand(text: string): { name?: string; aliases: string[] } {
  const name = text.match(/Current model:\s*`([^`]+)`/)?.[1]?.trim();
  const list = text.match(/Available:\s*([^\n]*)/)?.[1] || '';
  const aliases = list
    .replace(/,?\s*or a full model ID\.?$/i, '')
    .split(',')
    .map((s) => s.trim().replace(/\.$/, ''))
    .filter((s) => ALIAS.test(s));
  return { name, aliases: [...new Set(aliases)] };
}

function probe(bin: string, cwd: string, model: string | null, timeoutMs: number): Promise<Probe> {
  return new Promise((resolve) => {
    const out: Probe = { aliases: [], local: false };
    const ctl = new AbortController();
    const proc = startProc({
      bin,
      args: model ? [...ARGS, '--model', model] : ARGS,
      cwd,
      env: { NO_COLOR: '1' },
      signal: ctl.signal,
      timeoutMs,
      idleMs: timeoutMs,
      onLine: (l) => {
        let m: any;
        try {
          m = JSON.parse(l);
        } catch {
          return;
        }
        if (m.type === 'system' && m.subtype === 'init' && typeof m.model === 'string') out.id = m.model;
        else if (m.type === 'result') {
          // Only a locally answered command counts; an old version that sends "/model" to the model is not used again.
          out.local = m.local_command === 'model' && !(Number(m.num_turns) > 0);
          if (typeof m.result === 'string') Object.assign(out, parseModelCommand(m.result));
        }
      },
    });
    proc.write('/model');
    proc.end();
    proc.done.then(() => resolve(out));
  });
}

const cache = new Map<string, { at: number; v: ClaudeModel[] | null }>();
const TTL = 30 * 60_000;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const fixedVersion = (id: string) => {
  return `vaste versie (${id})`;
};

/** Plain Dutch label for one alias (with what it points to right now). */
function aliasLabel(alias: string, p: Probe): string {
  const now = p.name || p.id || '';
  const big = /\[1m\]$/i.test(alias);
  const base = alias.replace(/\[1m\]$/i, '');
  if (base === 'best') return `Het beste model${big ? ' met 1M context' : ''}${now ? ` (nu ${now})` : ''}`;
  if (base === 'opusplan') return 'Opus voor plannen, Sonnet voor het werk';
  // The full id is listed separately ("vaste versie"), so the alias only says what it points to now.
  return `${cap(base)}${big ? ' met 1M context' : ''} · altijd de nieuwste${now ? ` (nu ${now})` : ''}`;
}

/** The list for the bot editor: "standaard", the aliases, and the full ids they point to now. Null when unknown. */
export async function claudeModels(bin: string, cwd: string, timeoutMs = 45_000): Promise<ClaudeModel[] | null> {
  let key = bin;
  try {
    key += ':' + fs.statSync(bin).mtimeMs;
  } catch {
    /* keep bin */
  }
  const c = cache.get(key);
  if (c && Date.now() - c.at < (c.v ? TTL : 2 * 60_000)) return c.v;
  fs.mkdirSync(cwd, { recursive: true });
  const first = await probe(bin, cwd, null, timeoutMs);
  if (!first.local || !first.aliases.length) {
    cache.set(key, { at: Date.now(), v: null });
    return null;
  }
  const aliases = first.aliases.filter((a) => a !== 'default');
  const probes: [string, Probe][] = [];
  for (let i = 0; i < aliases.length; i += 5) {
    const batch = aliases.slice(i, i + 5);
    probes.push(...(await Promise.all(batch.map(async (a) => [a, await probe(bin, cwd, a, timeoutMs)] as [string, Probe]))));
  }
  const out: ClaudeModel[] = [{ id: 'default', label: `Standaard van Claude Code${first.name ? ` (nu ${first.name})` : ''}` }];
  const full = new Map<string, string>();
  for (const [alias, p] of probes) {
    if (!p.local) continue;
    out.push({ id: alias, label: aliasLabel(alias, p) });
    if (p.id && /^claude-[\w.-]+$/.test(p.id) && !full.has(p.id)) full.set(p.id, p.name || p.id);
  }
  if (first.id && /^claude-[\w.-]+$/.test(first.id) && !full.has(first.id)) full.set(first.id, first.name || first.id);
  // "vaste versie ({0})" is one translatable piece of the composed label (the page translates per " · " part).
  for (const [id, name] of full) out.push({ id, label: [name, fixedVersion(id)].join(' · ') });
  cache.set(key, { at: Date.now(), v: out });
  return out;
}

/** Tests: forget what was read. */
export function clearClaudeModels() {
  cache.clear();
}
