// Quality test set (plan 0.4, package M): types, scoring and the deterministic helpers the task checkers use.
// No model is needed here; only checks marked `judge` ask a (free/local) judge model, and they are skipped without one.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export type Team = 'webshop' | 'seo' | 'ads' | 'klantenservice' | 'operations' | 'bouwen';
export const TEAMS: Team[] = ['webshop', 'seo', 'ads', 'klantenservice', 'operations', 'bouwen'];

/** What the bot left behind after one task: its work folder and what it said. */
export interface Attempt {
  /** The task's work folder after the run (the inputs were copied in before). */
  dir: string;
  /** The original inputs (read-only). */
  fixtureDirs: string[];
  /** Checker-only files (hidden tests, extra data); never in the work folder. */
  hiddenDir: string;
  /** All the bot's text in this task (every assistant message, in order). */
  reply: string;
  /** The bot's last non-empty message. */
  final: string;
  /** Questions the bot asked the owner (ask_user). */
  questions: string[];
  /** Judge model; undefined = none available (judge checks are then skipped, not failed). */
  judge?: Judge;
}

export interface JudgeVerdict {
  ok: boolean;
  detail: string;
  skipped?: boolean;
}
export type Judge = (o: { rubric: string[]; material: string; context?: string }) => Promise<JudgeVerdict>;

export interface CheckOutcome {
  ok: boolean;
  detail?: string;
  skipped?: boolean;
}

export interface Check {
  id: string;
  /** Dutch, short: what is checked. */
  label: string;
  /** Default 1. */
  weight?: number;
  /** A failed critical check fails the task whatever the score (e.g. an invented fact, a changed test). */
  critical?: boolean;
  /** Uses the judge model (never critical). */
  judge?: boolean;
  run(a: Attempt): CheckOutcome | Promise<CheckOutcome>;
}

export interface QualityTask {
  id: string;
  team: Team;
  /** Dutch one-liner for the report. */
  title: string;
  /** Missing information or a rule that forbids answering: the bot must say so instead of inventing. */
  honesty?: boolean;
  /** The bot as the owner would make it: name and what it does (no hand-tuned instructions). */
  bot: { name: string; role: string };
  /** The owner's message (Dutch). */
  prompt: string;
  /** When the work counts as done (Dutch, for the report). */
  klaarAls: string;
  /** Input folders under tests/quality/fixtures, merged in order (default: [id]). */
  inputs?: string[];
  /** Answer the owner gives if the bot asks a question (default: DEFAULT_ANSWER). */
  answer?: string;
  checks: Check[];
}

export const DEFAULT_ANSWER = 'Ik ben er nu niet bij. Alles wat ik heb staat in je werkmap: maak het werk zo goed mogelijk af en zeg duidelijk wat er eventueel ontbreekt.';

/** Score at or above this, with no critical check failed, counts as passed. */
export const PASS_AT = 0.8;

export interface CheckResult {
  id: string;
  label: string;
  ok: boolean;
  skipped: boolean;
  weight: number;
  critical: boolean;
  judge: boolean;
  detail: string;
}

export interface Evaluation {
  score: number;
  pass: boolean;
  checks: CheckResult[];
  criticalFailed: string[];
}

export async function evaluate(task: QualityTask, a: Attempt): Promise<Evaluation> {
  const checks: CheckResult[] = [];
  for (const c of task.checks) {
    let out: CheckOutcome;
    try {
      out = await c.run(a);
    } catch (e: any) {
      out = { ok: false, detail: `checker-fout: ${e?.message || e}` };
    }
    checks.push({ id: c.id, label: c.label, ok: !!out.ok && !out.skipped, skipped: !!out.skipped, weight: c.weight ?? 1, critical: !!c.critical, judge: !!c.judge, detail: clip(out.detail || '', 400) });
  }
  return { ...scoreChecks(checks), checks };
}

/** Score and pass/fail from check results (also used to re-score a saved attempt with stored judge verdicts). */
export function scoreChecks(checks: CheckResult[]): Omit<Evaluation, 'checks'> {
  const counted = checks.filter((c) => !c.skipped);
  const total = counted.reduce((s, c) => s + c.weight, 0);
  const got = counted.filter((c) => c.ok).reduce((s, c) => s + c.weight, 0);
  const criticalFailed = checks.filter((c) => c.critical && !c.ok).map((c) => c.id);
  // No required deliverable: nothing to give points for ("no invented facts" in a file that is not there is no merit).
  const noDeliverable = checks.some((c) => c.id.startsWith('bestand:') && c.critical && !c.ok);
  const score = total && !noDeliverable ? Math.round((got / total) * 1000) / 1000 : 0;
  return { score, pass: !criticalFailed.length && score >= PASS_AT, criticalFailed };
}

// ------------------------------------------------------------------ files

const isFile = (p: string) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/** An output file by name: at the given path, else the same file name anywhere in the work folder (case-insensitive). */
export function findFile(dir: string, name: string): string | null {
  const exact = path.join(dir, name);
  if (isFile(exact)) return exact;
  const want = path.basename(name).toLowerCase();
  const walk = (d: string, depth: number): string | null => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) if (e.isFile() && e.name.toLowerCase() === want) return path.join(d, e.name);
    if (depth >= 4) return null;
    for (const e of entries) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name === '.git') continue;
      const hit = walk(path.join(d, e.name), depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(dir, 0);
}

export function readOut(a: Attempt, name: string): string | null {
  const p = findFile(a.dir, name);
  return p ? fs.readFileSync(p, 'utf8') : null;
}

/** The original input file (from the first input folder that has it). */
export function readInput(a: Attempt, rel: string): string {
  for (const d of [...a.fixtureDirs].reverse()) {
    const p = path.join(d, rel);
    if (isFile(p)) return fs.readFileSync(p, 'utf8');
  }
  throw new Error(`invoer ontbreekt: ${rel}`);
}

export const sha = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');

/** True when the work folder still has the input file exactly as given (line endings ignored). */
export function unchanged(a: Attempt, rel: string): boolean {
  const p = path.join(a.dir, rel);
  if (!isFile(p)) return false;
  const norm = (s: string) => s.replace(/\r\n/g, '\n');
  return norm(fs.readFileSync(p, 'utf8')) === norm(readInput(a, rel));
}

// ------------------------------------------------------------------ text

/** Text without code fences around it (bots often wrap a CSV or JSON in ```). */
export function unfence(t: string): string {
  const m = t.match(/```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n```/);
  return m ? m[1] : t;
}

export function stripMd(t: string): string {
  return t
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/[*_`>|]/g, ' ');
}

export function wordCount(t: string): number {
  return stripMd(t)
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** Sentences and separate lines (bullets, headings) of a text. */
export function sentences(t: string): string[] {
  return t
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[\p{Lu}\d€"'(“‘-])/u))
    .map((s) => s.trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s));
}

/** Any sentence that matches all patterns. */
export function sentenceWith(t: string, ...res: RegExp[]): string | null {
  return sentences(t).find((s) => res.every((r) => r.test(s))) ?? null;
}

/** A sentence that matches the topic, where it or the next sentence matches the marker ("Defect? Dan betalen wij."). */
export function sentencePair(t: string, topic: RegExp, marker: RegExp): string | null {
  const list = sentences(t);
  const i = list.findIndex((s, k) => topic.test(s) && (marker.test(s) || marker.test(list[k + 1] || '')));
  return i < 0 ? null : `${list[i]} ${marker.test(list[i]) ? '' : list[i + 1]}`.trim();
}

/** Average words per sentence of the body text (headings left out). */
export function avgSentenceWords(t: string): number {
  const body = t
    .split('\n')
    .filter((l) => !/^\s{0,3}#{1,6}\s/.test(l))
    .join('\n');
  const list = sentences(body);
  if (!list.length) return 0;
  return list.reduce((n, s) => n + wordCount(s), 0) / list.length;
}

/**
 * A number as people write it: "34,95", "€ 1.234,56", "2.000", "4.10", "1,234.56". A dot followed by exactly three
 * digits (and no comma) is a thousands separator, as in Dutch.
 */
export function parseNumber(raw: string): number | null {
  let s = String(raw).replace(/[€\s ]|eur(o)?/gi, '').replace(/^\+/, '');
  if (!s) return null;
  const neg = /^[-−–]/.test(s);
  s = s.replace(/^[-−–]/, '');
  if (!/^\d[\d.,]*$/.test(s)) return null;
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  if (hasDot && hasComma) {
    s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (hasComma) {
    s = /^\d{1,3}(,\d{3})+$/.test(s) && !/,\d{1,2}$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (hasDot && /^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

/** All numbers in a text (not the digits glued to a letter, like IPX5 or H7). */
export function numbersIn(t: string): number[] {
  const out: number[] = [];
  for (const m of t.matchAll(/(?<![\p{L}\d_])\d+(?:[.,]\d+)*/gu)) {
    const n = parseNumber(m[0]);
    if (n !== null) out.push(n);
  }
  return out;
}

/** Numbers in the text that are not allowed (small numbers up to `ignoreUpTo` are always fine: "3 tips"). */
export function inventedNumbers(t: string, allowed: number[], ignoreUpTo = 10): number[] {
  return [...new Set(numbersIn(t).filter((n) => Math.abs(n) > ignoreUpTo && !allowed.some((x) => Math.abs(x - n) < 1e-6)))];
}

/** Euro amounts in a text ("€ 4,95", "€50", "12,50 euro"). */
export function euroAmounts(t: string): number[] {
  const out: number[] = [];
  for (const m of t.matchAll(/€\s?(\d[\d.,]*\d|\d)|(\d[\d.,]*\d|\d)\s?(?:euro|eur)\b/gi)) {
    const n = parseNumber(m[1] || m[2]);
    if (n !== null) out.push(n);
  }
  return out;
}

export function missing(t: string, wanted: [string, RegExp][]): string[] {
  return wanted.filter(([, r]) => !r.test(t)).map(([name]) => name);
}

export const clip = (s: string, n = 160) => {
  const one = String(s).replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
};

/** Everything the bot said to the owner, including its questions. */
export const said = (a: Attempt) => [a.reply, ...a.questions].join('\n');

/**
 * Words that say information is missing, unknown or will be checked/passed on (Dutch). Used together with the topic
 * in the same sentence, so a general "ik weet het niet" elsewhere does not count.
 */
export const HONEST =
  /(weet (ik|we|wij) (het |dat |dit )?(nog |nu )?niet|niet (zeker|bekend|vermeld|genoemd|gegeven|beschikbaar|aanwezig|gevonden|opgenomen|terug te vinden|te vinden)|nog niet (bekend|ingevuld|beschikbaar)|kan (ik|we|wij) (je |u )?(nu |op dit moment |helaas )?(niet|nog niet) (bevestigen|zeggen|vinden|beloven|toezeggen|garanderen|met zekerheid)|met zekerheid|ontbre(ekt|ken|kende)|\bmis(t|sen|te)\b|staat (er |hier )?(nog )?niet|staan (er )?(nog )?niet|komt (er )?niet\b.{0,40}\bvoor\b|niet (in|op) (de|deze|het|dit|jullie|uw|hun|je) (offerte|lijst|bestand|bestanden|map|beleid|specificaties)|geen (informatie|gegevens|prijs|data|bestand|orders|cijfers|sleutel)|onbekend|navragen|na te vragen|uitzoeken|uit te zoeken|vraag(en)? (ik|we|wij) (dit |dat |het )?na\b|zoek(en)? (ik|we|wij) (het |dit |dat )?uit|nagaan|na te gaan|doorgeven|doorgegeven|doorzetten|doorgezet|doorgestuurd|voorleggen|voorgelegd|terugkomen|kom(en)? (ik|we|wij) .{0,25}terug|neem(t|en)? .{0,25}contact .{0,20}op|laten (we|wij|ik) (je|u|jou) .{0,30}weten|laat (ik|we|wij) (je|u|jou) .{0,30}weten|laat (je|u|jou) .{0,30}weten|nader te bepalen|n\.?t\.?b\.?|in te vullen|aan te vullen|invullen|aanvullen|\bvolgt\b|nog (op te vragen|opvragen)|opvragen)/i;

// ------------------------------------------------------------------ CSV and JSON

export interface Csv {
  header: string[];
  rows: string[][];
  records: Record<string, string>[];
}

/** A CSV as bots write it: `;`, `,` or tab, optional quotes, BOM, code fences or a markdown table. */
export function parseCsv(text: string): Csv {
  let t = unfence(text.replace(/^﻿/, '')).replace(/\r\n?/g, '\n');
  let lines = t.split('\n').filter((l) => l.trim());
  // A markdown table: | a | b | with a |---| line.
  if (lines.length && /^\s*\|/.test(lines[0])) {
    lines = lines.filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l)).map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()).join('\t'));
  }
  if (!lines.length) return { header: [], rows: [], records: [] };
  const first = lines[0];
  const count = (ch: string) => first.split(ch).length - 1;
  const delim = [';', '\t', ','].sort((x, y) => count(y) - count(x))[0];
  const split = (line: string) => {
    const out: string[] = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) {
        out.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  const header = split(first).map((h) => h.toLowerCase().replace(/[`*]/g, '').trim());
  const rows = lines.slice(1).map(split);
  const records = rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
  return { header, rows, records };
}

/** A column by one of its possible names (case-insensitive, also "prijs_incl" ~ "prijs incl."). */
export function col(csv: Csv, ...names: string[]): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const n of names) {
    const hit = csv.header.find((h) => norm(h) === norm(n));
    if (hit) return hit;
  }
  for (const n of names) {
    const hit = csv.header.find((h) => norm(h).includes(norm(n)));
    if (hit) return hit;
  }
  return null;
}

/** JSON from a file a bot wrote (also inside a code fence). */
export function parseJson(text: string): any {
  const t = unfence(text.replace(/^﻿/, '')).trim();
  return JSON.parse(t);
}

// ------------------------------------------------------------------ days

const DAYS = [
  ['ma', 'maandag', 'mon', 'monday'],
  ['di', 'dinsdag', 'tue', 'tuesday'],
  ['wo', 'woensdag', 'wed', 'wednesday'],
  ['do', 'donderdag', 'thu', 'thursday'],
  ['vr', 'vrijdag', 'fri', 'friday'],
];
/** 0 = Monday … 4 = Friday, -1 = not a working day name. */
export function dayIndex(s: string): number {
  const v = String(s).toLowerCase().replace(/[^a-z]/g, '');
  return DAYS.findIndex((names) => names.includes(v));
}

// ------------------------------------------------------------------ running code

/** Environment for code from the work folder: no test-runner context, no loaders, no keys. */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^NODE_TEST|^NODE_OPTIONS$|^NODE_CHANNEL|API_KEY|TOKEN|SECRET/i.test(k)) delete env[k];
  // The owner's time zone, on every machine: date code that only works in UTC must fail everywhere, not only here.
  env.TZ = 'Europe/Amsterdam';
  return env;
}

export function runNode(args: string[], cwd: string, timeoutMs = 60_000): { ok: boolean; code: number | null; out: string } {
  const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: timeoutMs, env: childEnv(), windowsHide: true });
  const out = `${r.stdout || ''}\n${r.stderr || ''}${r.error ? `\n${r.error.message}` : ''}`;
  return { ok: r.status === 0, code: r.status, out };
}

/** A throwaway copy of the work folder (without node_modules/.git) for running hidden checks. */
export function scratchCopy(a: Attempt): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-quality-check-'));
  fs.cpSync(a.dir, tmp, { recursive: true, filter: (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(src) });
  return tmp;
}

export function removeDir(d: string) {
  try {
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* temp folder */
  }
}

/** The project's own tests (`node --test`, as in its package.json). */
export function projectTests(a: Attempt): { ok: boolean; out: string } {
  const tmp = scratchCopy(a);
  try {
    const r = runNode(['--test'], tmp, 90_000);
    return { ok: r.ok, out: r.out };
  } finally {
    removeDir(tmp);
  }
}

/** Hidden tests (files from hidden/<task>) run against a copy of the bot's work. */
export function hiddenTests(a: Attempt, files: string[]): { ok: boolean; out: string } {
  const tmp = scratchCopy(a);
  try {
    for (const f of files) fs.copyFileSync(path.join(a.hiddenDir, f), path.join(tmp, f));
    const r = runNode(['--test', ...files], tmp, 90_000);
    return { ok: r.ok, out: r.out };
  } finally {
    removeDir(tmp);
  }
}

/** The failing lines of a node:test run, short. */
export function testFailures(out: string): string {
  const lines = out.split('\n').filter((l) => /not ok|✖|Error|assert|expected|actual|fail \d/i.test(l));
  return clip(lines.slice(0, 6).join(' | ') || out, 300);
}

// ------------------------------------------------------------------ check builders

export function fileExists(name: string, opts: { critical?: boolean; weight?: number } = {}): Check {
  return {
    id: `bestand:${name}`,
    label: `${name} bestaat`,
    critical: opts.critical ?? true,
    weight: opts.weight ?? 1,
    run: (a) => {
      const p = findFile(a.dir, name);
      return p ? { ok: true, detail: path.relative(a.dir, p) } : { ok: false, detail: `${name} niet gevonden in de werkmap` };
    },
  };
}

/** A judge check: a strict yes/no rubric over some material (never critical; skipped without a judge). */
export function judged(id: string, label: string, rubric: string[], material: (a: Attempt) => string | null, context?: string): Check {
  return {
    id,
    label,
    judge: true,
    weight: 1,
    async run(a) {
      if (!a.judge) return { ok: false, skipped: true, detail: 'geen beoordelaar beschikbaar' };
      const m = material(a);
      if (!m || !m.trim()) return { ok: false, detail: 'niets om te beoordelen' };
      return a.judge({ rubric, material: m.slice(0, 12_000), context });
    },
  };
}
