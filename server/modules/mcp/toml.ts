import { TomlDate, TomlError, parse } from 'smol-toml';

/**
 * TOML reader for importing MCP servers from Codex's `config.toml` (`[mcp_servers.<name>]`): smol-toml (BSD-3-Clause),
 * the full TOML 1.0 spec, including arrays of tables (`[[…]]`). Dates and times are kept as text, as before. It only
 * reads; nothing is ever written back. Throws a short Dutch error with the line number on input it cannot read.
 */

type Table = Record<string, any>;

/** smol-toml's messages → short Dutch (the rest: a general "cannot read this line"). */
const MESSAGES: [RegExp, string][] = [
  [/redefine/, 'deze sleutel of tabel staat er twee keer in'],
  [/unfinished string|control characters are not allowed in strings/, 'string niet afgesloten'],
  [/escape/, 'ongeldige escape in string'],
  [/unfinished array/, 'lijst niet afgesloten'],
  [/unfinished table|end of table array/, 'tabelnaam niet afgesloten'],
  [/expected comma or end of structure/, 'verwacht een komma of het einde van de lijst of tabel'],
  [/end-of-line/, 'onverwachte tekst na de waarde'],
  [/key/, 'ongeldige sleutel'],
  [/date|time/, 'ongeldige datum of tijd'],
  [/numeric|leading zero|underscore|integer/, 'ongeldig getal'],
  [/invalid value/, 'onbekende waarde'],
  [/nested/, 'te diep genest'],
];

/** Dates and times as text (TOML's own notation), everything else as parsed. */
function plain(v: any): any {
  if (v instanceof TomlDate) return v.toISOString();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') {
    const out: Table = {};
    for (const [k, x] of Object.entries(v)) out[k] = plain(x);
    return out;
  }
  return v;
}

export function parseToml(src: string): Table {
  try {
    return plain(parse(String(src).replace(/^﻿/, '')));
  } catch (e: any) {
    if (e instanceof TomlError) {
      const what = String(e.message).replace(/^Invalid TOML document: /, '').split('\n')[0];
      const nl = MESSAGES.find(([re]) => re.test(what))?.[1] || 'deze regel kan ik niet lezen';
      throw new Error(`TOML regel ${e.line}: ${nl}`);
    }
    throw new Error(`TOML: ${String(e?.message || e).slice(0, 120)}`);
  }
}
