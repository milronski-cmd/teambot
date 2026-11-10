#!/usr/bin/env node
// @ts-check
// TeamBot on the command line: `teambot send` posts a message to a bot and prints the answer.
// No dependencies (Node 18+), so it runs from a checkout, after `npm link`, and from an installed app.
// Server side: server/modules/mcp/cli.ts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXIT = { OK: 0, BOT: 1, USAGE: 2, AUTH: 3, TIMEOUT: 4, OFFLINE: 5 };
const DEFAULT_TIMEOUT_SEC = 300;
const MAX_STDIN = 200_000;

class CliError extends Error {
  /** @param {number} code @param {string} message @param {Record<string, any>} [extra] */
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

const HELP_MAIN = `TeamBot op de opdrachtregel

Gebruik:
  teambot send [opties] [bericht]    Stuur een bericht naar een bot en toon het antwoord.
  teambot send --help                Alle opties van send.
`;

const HELP_SEND = `teambot send — stuur een bericht naar een bot en toon het antwoord

Gebruik:
  teambot send --bot <naam> "Je bericht"
  echo "Je bericht" | teambot send --bot <naam>

Opties:
  --bot <naam of id>   De bot die het bericht krijgt. Mag weg als je token maar één bot bereikt.
  --wacht              Wacht op het antwoord en toon het (standaard).
  --no-wait            Alleen versturen, niet wachten (ook: --niet-wachten).
  --timeout <sec>      Zo lang wachten op het antwoord, in seconden (standaard ${DEFAULT_TIMEOUT_SEC}; ook 90s of 5m).
  --nieuw              Begin een nieuw gesprek in plaats van het vorige voort te zetten.
  --json               Uitvoer als JSON, handig in scripts.
  --token <token>      Je persoonlijke token. Liever via de omgevingsvariabele TEAMBOT_TOKEN.
  --server <adres>     Adres van TeamBot (ook: TEAMBOT_URL). Standaard de app op deze computer.
  --data <map>         Datamap van TeamBot, om de app op deze computer te vinden (ook: TEAMBOT_DATA).
  --sta-extern-toe     Sta een adres op een andere computer toe, alleen via https (ook: TEAMBOT_ALLOW_REMOTE=1).
  -h, --help           Deze hulp.

Zonder token gebruikt teambot send op deze computer de aanmelding van de TeamBot-app.
Een token maak je in TeamBot onder Apps & connectors › TeamBot als server › Token maken.
De bot gebruikt zijn eigen toegangsmodus: acties met impact keur je goed in TeamBot.

Afsluitcodes:
  0  gelukt
  1  de bot gaf een fout of stopte
  2  verkeerd gebruikt (onbekende optie, geen bericht, adres geweigerd)
  3  geen toegang (token ontbreekt, is ongeldig of ingetrokken, of de bot is niet bereikbaar)
  4  geen antwoord binnen de wachttijd (het antwoord verschijnt later in TeamBot)
  5  TeamBot is niet bereikbaar
`;

/** @param {string} s */
const isLoopback = (s) => {
  const h = s.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
};

/** Same rule as the server (server/core/config.ts). */
function defaultDataDir() {
  if (process.env.TEAMBOT_DATA) return process.env.TEAMBOT_DATA;
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'TeamBot');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'TeamBot');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'teambot');
}

/** @param {string} file */
function readSmall(file) {
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    return s.length < 4096 ? s : '';
  } catch {
    return '';
  }
}

/** @param {string} v */
function parseTimeout(v) {
  const m = /^(\d+(?:[.,]\d+)?)\s*(s|sec|m|min)?$/i.exec(String(v || '').trim());
  const n = m ? Number(m[1].replace(',', '.')) * (m[2] && m[2][0].toLowerCase() === 'm' ? 60 : 1) : NaN;
  if (!(n > 0) || n > 86_400) throw new CliError(EXIT.USAGE, `Ongeldige wachttijd "${v}". Geef seconden, bijvoorbeeld --timeout 120 of --timeout 5m.`);
  return n;
}

/** @param {string[]} args */
function parseSendArgs(args) {
  /** @type {{ bot?: string, wait: boolean, timeout: number, fresh: boolean, json: boolean, token?: string, server?: string, data?: string, allowRemote: boolean, help: boolean, words: string[] }} */
  const o = { wait: true, timeout: DEFAULT_TIMEOUT_SEC, fresh: false, json: false, allowRemote: /^(1|true|ja|yes)$/i.test(process.env.TEAMBOT_ALLOW_REMOTE || ''), help: false, words: [] };
  for (let i = 0; i < args.length; i++) {
    let a = args[i];
    if (a === '--') {
      o.words.push(...args.slice(i + 1));
      break;
    }
    if (!a.startsWith('-') || a === '-') {
      o.words.push(a);
      continue;
    }
    let val;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) {
      val = a.slice(eq + 1);
      a = a.slice(0, eq);
    }
    const value = () => {
      if (val !== undefined) return val;
      const next = args[i + 1];
      if (next === undefined || (next.startsWith('--') && next.length > 2)) throw new CliError(EXIT.USAGE, `Optie ${a} heeft een waarde nodig. Zie teambot send --help.`);
      i++;
      return next;
    };
    switch (a) {
      case '--bot':
      case '-b':
        o.bot = value();
        break;
      case '--wacht':
      case '--wait':
        o.wait = true;
        break;
      case '--no-wait':
      case '--niet-wachten':
      case '--nowait':
        o.wait = false;
        break;
      case '--timeout':
      case '--wachttijd':
        o.timeout = parseTimeout(value());
        break;
      case '--nieuw':
      case '--new':
        o.fresh = true;
        break;
      case '--json':
        o.json = true;
        break;
      case '--token':
        o.token = value();
        break;
      case '--server':
      case '--url':
        o.server = value();
        break;
      case '--data':
        o.data = value();
        break;
      case '--sta-extern-toe':
      case '--allow-remote':
        o.allowRemote = true;
        break;
      case '-h':
      case '--help':
      case '--hulp':
        o.help = true;
        break;
      default:
        throw new CliError(EXIT.USAGE, `Onbekende optie "${a}". Zie teambot send --help.`);
    }
  }
  return o;
}

/** Everything piped in (echo tekst | teambot send …). */
async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  let size = 0;
  for await (const c of process.stdin) {
    size += c.length;
    if (size > MAX_STDIN) throw new CliError(EXIT.USAGE, 'Het bericht via stdin is te lang (maximaal 20.000 tekens).');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '');
}

/**
 * The TeamBot address: --server, TEAMBOT_URL, the address the app wrote in its data folder, or 127.0.0.1:4747.
 * Only this computer, unless explicitly allowed — and then only https (the token must not travel in plain text).
 * @param {ReturnType<typeof parseSendArgs>} o @param {string} dataDir
 */
function resolveServer(o, dataDir) {
  const given = o.server || process.env.TEAMBOT_URL || '';
  const raw = given || readSmall(path.join(dataDir, 'local-url')) || `http://127.0.0.1:${process.env.TEAMBOT_PORT || 4747}`;
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'http://' + raw);
  } catch {
    throw new CliError(EXIT.USAGE, `"${raw}" is geen geldig adres. Gebruik bijvoorbeeld --server http://127.0.0.1:4747.`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new CliError(EXIT.USAGE, 'Alleen http- en https-adressen.');
  if (u.username || u.password) throw new CliError(EXIT.USAGE, 'Zet geen gebruikersnaam of wachtwoord in het adres; gebruik --token.');
  const local = isLoopback(u.hostname);
  if (!local && !o.allowRemote)
    throw new CliError(EXIT.USAGE, `${u.host} is niet deze computer. teambot send praat standaard alleen met TeamBot op deze computer. Wil je toch een andere computer gebruiken, voeg dan --sta-extern-toe toe (alleen via https).`);
  if (!local && u.protocol !== 'https:') throw new CliError(EXIT.USAGE, `Naar een andere computer alleen via https: met ${u.protocol}// zou je token onversleuteld over het netwerk gaan.`);
  return { base: u.origin + u.pathname.replace(/\/+$/, ''), local, guessed: !given };
}

/**
 * @param {{ base: string, guessed: boolean }} server @param {{ value: string, local: boolean }} token
 * @param {string} method @param {string} p @param {any} body @param {number} timeoutMs
 */
async function call(server, token, method, p, body, timeoutMs) {
  let res;
  try {
    res = await fetch(server.base + '/api/public/cli' + p, {
      method,
      headers: { authorization: `Bearer ${token.value}`, 'user-agent': 'teambot-cli', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      // a redirect could carry the token elsewhere
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (/** @type {any} */ (e)?.name === 'TimeoutError') throw new CliError(EXIT.OFFLINE, `TeamBot op ${server.base} antwoordt niet.`);
    throw new CliError(EXIT.OFFLINE, `TeamBot is niet bereikbaar op ${server.base}. Draait de app?${server.guessed ? ' Draait hij op een ander adres, gebruik dan --server of --data.' : ''}`);
  }
  /** @type {any} */
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* not JSON */
  }
  if (res.ok) return data;
  const msg = typeof data?.error === 'string' && data.error ? data.error : `TeamBot antwoordde met fout ${res.status}.`;
  if (res.status === 401)
    throw new CliError(EXIT.AUTH, token.local ? 'De aanmelding van de TeamBot-app op deze computer werkt niet (draait de app met een andere datamap?). Gebruik een persoonlijke token met --token of TEAMBOT_TOKEN.' : msg);
  if (data?.code === 'bot') throw new CliError(EXIT.AUTH, msg);
  if (data?.code === 'choose' || data?.code === 'message') throw new CliError(EXIT.USAGE, msg);
  throw new CliError(EXIT.BOT, msg);
}

/** @param {any} v */
const writeJson = (v) => process.stdout.write(JSON.stringify(v, null, 2) + '\n');

/** @param {string[]} args @param {{ json: boolean }} out */
async function send(args, out) {
  const o = parseSendArgs(args);
  out.json = o.json;
  if (o.help) {
    process.stdout.write(HELP_SEND);
    return EXIT.OK;
  }
  let message = o.words.filter((w) => w !== '-').join(' ');
  if (!message || o.words.includes('-')) message = [message, await readStdin()].filter(Boolean).join('\n');
  message = message.trim();
  if (!message) throw new CliError(EXIT.USAGE, 'Geen bericht. Zet het bericht na de opties, of stuur het via een pipe: echo "tekst" | teambot send --bot <naam>');
  if (message.length > 20_000) throw new CliError(EXIT.USAGE, 'Het bericht is te lang (maximaal 20.000 tekens).');

  const dataDir = o.data || defaultDataDir();
  const server = resolveServer(o, dataDir);
  let token = { value: o.token || process.env.TEAMBOT_TOKEN || '', local: false };
  // the desktop app's own sign-in: only read it for TeamBot on this computer, never send it elsewhere
  if (!token.value && server.local) token = { value: readSmall(path.join(dataDir, 'local-token')), local: true };
  if (!token.value)
    throw new CliError(
      EXIT.AUTH,
      server.local
        ? 'Geen token gevonden, en de TeamBot-app op deze computer is niet gevonden. Maak een token in TeamBot (Apps & connectors › TeamBot als server › Token maken) en zet die in TEAMBOT_TOKEN, of gebruik --data met de datamap van de app.'
        : 'Geen token. Maak er een in TeamBot (Apps & connectors › TeamBot als server › Token maken) en zet die in de omgevingsvariabele TEAMBOT_TOKEN.',
    );

  const sent = await call(server, token, 'POST', '/send', { bot: o.bot, message, new_conversation: o.fresh }, 30_000);
  const base = { bot: sent.bot, thread_id: sent.thread_id, thread_title: sent.thread_title, run_id: sent.run_id };
  if (!o.wait) {
    if (o.json) writeJson({ ok: true, status: 'sent', ...base });
    else process.stdout.write(`Verstuurd naar ${sent.bot.name}. Het antwoord verschijnt in TeamBot in het gesprek "${sent.thread_title}".\n`);
    return EXIT.OK;
  }

  const deadline = Date.now() + o.timeout * 1000;
  let told = false;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0)
      throw new CliError(EXIT.TIMEOUT, `Geen antwoord binnen ${o.timeout} seconden. ${sent.bot.name} is nog bezig; het antwoord verschijnt in TeamBot in het gesprek "${sent.thread_title}".`, { status: 'timeout', ...base });
    const wait = Math.max(1, Math.min(25, Math.ceil(left / 1000)));
    const st = await call(server, token, 'GET', `/runs/${encodeURIComponent(sent.run_id)}?wait=${wait}`, null, (wait + 20) * 1000);
    if (st.status === 'done') {
      if (o.json) writeJson({ ok: true, status: 'done', ...base, reply: st.reply || '' });
      else process.stdout.write((st.reply || '(geen tekstantwoord)') + '\n');
      return EXIT.OK;
    }
    if (['error', 'cancelled', 'interrupted'].includes(st.status)) {
      const why = st.status === 'error' ? `gaf een fout${st.error ? `: ${st.error}` : ''}` : 'is gestopt';
      throw new CliError(EXIT.BOT, `${sent.bot.name} ${why}.`, { status: st.status, ...base, reply: st.reply || '' });
    }
    if (st.waiting && !told && !o.json) {
      process.stderr.write(`${sent.bot.name} wacht op jouw goedkeuring of antwoord in TeamBot…\n`);
      told = true;
    }
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const out = { json: rest.includes('--json') };
  try {
    if (!cmd || ['-h', '--help', '--hulp', 'help', 'hulp'].includes(cmd)) {
      process.stdout.write(HELP_MAIN);
      return cmd ? EXIT.OK : EXIT.USAGE;
    }
    if (cmd === 'send' || cmd === 'stuur') return await send(rest, out);
    throw new CliError(EXIT.USAGE, `Onbekende opdracht "${cmd}". Bedoel je "teambot send"? Zie teambot --help.`);
  } catch (e) {
    const err = e instanceof CliError ? e : new CliError(EXIT.BOT, `Er ging iets mis: ${/** @type {any} */ (e)?.message || e}`);
    if (out.json) writeJson({ ok: false, status: 'error', ...err.extra, error: err.message, exit_code: err.code });
    else process.stderr.write(err.message + '\n');
    return err.code;
  }
}

process.exitCode = await main();
