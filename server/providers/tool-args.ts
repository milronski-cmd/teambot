import { jsonrepair } from 'jsonrepair';

/**
 * Tool arguments as JSON, a little forgiving. Models (free and local ones most of all) sometimes write argument JSON
 * with a trailing comma, single quotes, unquoted keys, Python's True/None or a comment. `jsonrepair` (ISC) fixes
 * those, so the call can still run instead of costing a turn. What it never does here: complete JSON that was cut
 * off. jsonrepair would close an unfinished string and object, and a write_file with half its content would then
 * run; so a repair is only accepted when the text ends the way a whole JSON value ends (`}` or `]`), and never for
 * an answer that stopped at its token limit.
 */

/** The parsed value, repaired when it was only slightly broken; undefined when it cannot be read for sure. */
export function parseJsonValue(raw: string, cut = false): any {
  const s = String(raw ?? '').trim();
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    if (cut || !/[}\]]$/.test(s)) return undefined;
    try {
      return JSON.parse(jsonrepair(s));
    } catch {
      return undefined;
    }
  }
}

/**
 * Arguments of a native tool call (the provider's own `arguments` string). Empty = no arguments. Unreadable =
 * `{ __invalid_json }`, which the tool gate answers with a correction instead of running anything.
 */
export function parseToolArgs(raw: string | undefined | null, cut = false): any {
  const s = String(raw ?? '');
  if (!s.trim()) return {};
  const v = parseJsonValue(s, cut);
  return v === undefined ? { __invalid_json: s } : v;
}
