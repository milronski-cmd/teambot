import { webPageInWords } from './preview.js';
import { tText as t } from './format.js';

/** Plain-language labels for tool calls in the chat: [finished, running]. Unknown tools fall back to their name. */
const LABELS: Record<string, [string, string]> = {
  web_search: ['Zocht op internet', 'Zoekt op internet'],
  web_fetch: ['Las een webpagina', 'Leest een webpagina'],
  read: ['Las een bestand', 'Leest een bestand'],
  read_file: ['Las een bestand', 'Leest een bestand'],
  read_document: ['Las een document', 'Leest een document'],
  write: ['Schreef een bestand', 'Schrijft een bestand'],
  write_file: ['Schreef een bestand', 'Schrijft een bestand'],
  edit_file: ['Paste een bestand aan', 'Past een bestand aan'],
  delete_file: ['Verwijderde een bestand', 'Verwijdert een bestand'],
  list_files: ['Bekeek de werkmap', 'Bekijkt de werkmap'],
  search_files: ['Zocht in bestanden', 'Zoekt in bestanden'],
  share_file: ['Deelde een bestand', 'Deelt een bestand'],
  site_publish: ['Publiceerde een website', 'Publiceert een website'],
  site_list: ['Bekeek de websites', 'Bekijkt de websites'],
  site_unpublish: ['Haalde een website offline', 'Haalt een website offline'],
  show_html: ['Maakte een voorbeeld', 'Maakt een voorbeeld'],
  run_command: ['Voerde een opdracht uit', 'Voert een opdracht uit'],
  computer_exec: ['Voerde een opdracht uit', 'Voert een opdracht uit'],
  remote_exec: ['Voerde een opdracht uit op de server', 'Voert een opdracht uit op de server'],
  remote_read_file: ['Las een bestand op de server', 'Leest een bestand op de server'],
  remote_write_file: ['Schreef een bestand op de server', 'Schrijft een bestand op de server'],
  remote_list: ['Bekeek mappen op de server', 'Bekijkt mappen op de server'],
  remote_upload: ['Zette een bestand op de server', 'Zet een bestand op de server'],
  remote_download: ['Haalde een bestand van de server', 'Haalt een bestand van de server'],
  memory_search: ['Zocht in het geheugen', 'Zoekt in het geheugen'],
  memory_get: ['Las het geheugen', 'Leest het geheugen'],
  memory_remember: ['Onthield iets', 'Onthoudt iets'],
  memory_update: ['Werkte het geheugen bij', 'Werkt het geheugen bij'],
  memory_forget: ['Vergat iets', 'Vergeet iets'],
  dossier_get: ['Las een dossier', 'Leest een dossier'],
  dossier_write: ['Werkte een dossier bij', 'Werkt een dossier bij'],
  dossier_add: ['Vulde een dossier aan', 'Vult een dossier aan'],
  dossier_update: ['Werkte een dossier bij', 'Werkt een dossier bij'],
  dossier_note: ['Zette iets in een dossier', 'Zet iets in een dossier'],
  ask_user: ['Stelde je een vraag', 'Stelt je een vraag'],
  ask_form: ['Vroeg je om gegevens', 'Vraagt je om gegevens'],
  notify_user: ['Stuurde je een melding', 'Stuurt je een melding'],
  plan_update: ['Werkte het plan bij', 'Werkt het plan bij'],
  delegate_task: ['Vroeg een andere bot om hulp', 'Vraagt een andere bot om hulp'],
  delegation_status: ['Keek hoe ver de andere bot is', 'Kijkt hoe ver de andere bot is'],
  message_bot: ['Stuurde een andere bot een bericht', 'Stuurt een andere bot een bericht'],
  ask_bot: ['Vroeg een andere bot iets', 'Vraagt een andere bot iets'],
  delegation_cancel: ['Trok een vraag aan een andere bot in', 'Trekt een vraag aan een andere bot in'],
  propose_member: ['Stelde een nieuw teamlid voor', 'Stelt een nieuw teamlid voor'],
  routine_no_update: ['Niets nieuws te melden', 'Meldt: niets nieuws'],
  rehearsal_start: ['Begon te oefenen op een kopie', 'Oefent op een kopie'],
  rehearsal_status: ['Bekeek de oefenkopie', 'Bekijkt de oefenkopie'],
  rehearsal_finish: ['Rondde het oefenen af', 'Rondt het oefenen af'],
  workspace_snapshots: ['Bekeek de herstelpunten', 'Bekijkt de herstelpunten'],
  skill_prepare_scripts: ['Maakte de scripts van een skill klaar', 'Maakt de scripts van een skill klaar'],
  handoff: ['Gaf het werk door', 'Geeft het werk door'],
  broadcast: ['Stuurde het team een bericht', 'Stuurt het team een bericht'],
  team_status: ['Bekeek het team', 'Bekijkt het team'],
  team_tables: ['Bekeek de teamtabellen', 'Bekijkt de teamtabellen'],
  team_query: ['Las in de teamtabellen', 'Leest in de teamtabellen'],
  team_execute: ['Werkte de teamtabellen bij', 'Werkt de teamtabellen bij'],
  task_create: ['Maakte een taak', 'Maakt een taak'],
  task_update: ['Werkte een taak bij', 'Werkt een taak bij'],
  task_list: ['Bekeek de taken', 'Bekijkt de taken'],
  task_claim: ['Pakte een taak op', 'Pakt een taak op'],
  task_done: ['Meldde een taak af', 'Meldt een taak af'],
  routine_create: ['Maakte een routine', 'Maakt een routine'],
  routine_list: ['Bekeek de routines', 'Bekijkt de routines'],
  wait_for: ['Zette een wachtpunt', 'Zet een wachtpunt'],
  channel_send: ['Stuurde een bericht via een kanaal', 'Stuurt een bericht via een kanaal'],
  channel_list: ['Bekeek de kanalen', 'Bekijkt de kanalen'],
  skill_load: ['Pakte een skill erbij', 'Pakt een skill erbij'],
  tools_find: ['Zocht een TeamBot-functie op', 'Zoekt een TeamBot-functie op'],
  skill_read_file: ['Las in een skill', 'Leest in een skill'],
  skill_draft: ['Schreef een skill', 'Schrijft een skill'],
  workspace_snapshot: ['Maakte een herstelpunt', 'Maakt een herstelpunt'],
  room_file_read: ['Las een groepsbestand', 'Leest een groepsbestand'],
  room_file_write: ['Schreef een groepsbestand', 'Schrijft een groepsbestand'],
  room_files_list: ['Bekeek de groepsbestanden', 'Bekijkt de groepsbestanden'],
};

export function toolLabel(call: { name: string }, running: boolean): string {
  const n = call.name;
  const l = LABELS[n];
  if (l) return l[running ? 1 : 0];
  if (n.startsWith('browser_')) return running ? 'Gebruikt de browser' : 'Gebruikte de browser';
  if (n.startsWith('desktop_')) return running ? 'Bedient het bureaublad' : 'Bediende het bureaublad';
  if (n.startsWith('mcp_') || n.includes('__')) {
    const app = n.includes('__') ? n.split('__')[0].replace(/^mcp_?/, '') : '';
    return running ? `Gebruikt ${app || 'een app'}` : `Gebruikte ${app || 'een app'}`;
  }
  // An internal id without words of its own ("some_tool"): never shown as such.
  if (TOOL_ID.test(n)) return running ? 'Gebruikt een hulpmiddel' : 'Gebruikte een hulpmiddel';
  return n.replace(/_/g, ' ');
}

/** An internal tool id: snake_case with at least two parts ("rehearsal_finish", "memory_search"). */
const TOOL_ID = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

/**
 * A step title without internal tool ids, for titles that come from an engine as text: "(wait_for)" is dropped, a
 * title that is only an id gets its words ("rehearsal_finish" → "Rondde het oefenen af"), and an id inside a sentence
 * becomes "een hulpmiddel". File names ("my_notes.txt", "src/my_file") stay as they are.
 */
export function plainStep(title: string): string {
  const s = String(title ?? '');
  const bare = s.trim();
  if (TOOL_ID.test(bare) || bare.startsWith('mcp__')) return toolLabel({ name: bare }, false);
  return s
    .replace(/\s*\((?:[a-z][a-z0-9]*(?:_[a-z0-9]+)+|mcp__[\w-]+)\)/g, '')
    .replace(/(?<![\w./\\:-])([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?![\w./\\:-])/g, (id) => (LABELS[id] || /^(browser|desktop|mcp|memory|team|task|routine|skill|rehearsal|delegat)/.test(id) ? 'een hulpmiddel' : id));
}

export function argsPreview(args: any): string {
  if (!args || typeof args !== 'object') return String(args ?? '');
  // Never a page reference such as "e12" (only the bot knows what it means); the bot's own words for it if given.
  const v = args.element || args.query || args.q || args.path || args.url || args.command || args.title || args.name || Object.entries(args).find(([k, x]) => k !== 'ref' && typeof x === 'string' && !/^e\d{1,7}$/.test(x))?.[1];
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').slice(0, 120) : '';
}

/**
 * An element of a web page in words ("de knop “Bestellen”", "de link “Factuur”", "het veld “E-mail”"), never a page
 * reference like e12. One part for the server (the step log of a bot's browser) and the page (the browser card). Every
 * kind is a whole phrase, with its name and without, so every language can translate it, also inside a sentence the
 * server stored ("Klik op de knop “Bestellen”"); never a Dutch "knop" or "veld" as a value. `fallback`: an element
 * without a kind and without a name.
 */
export function describeElement(info: any, fallback = ''): string {
  if (!info) return fallback;
  const name = String(info.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const tag = String(info.tag || '');
  const type = String(info.type || '');
  const role = String(info.role || '');
  if (tag === 'a' || role === 'link') return name ? t('de link “{0}”', name) : t('een link');
  if (tag === 'button' || role === 'button' || (tag === 'input' && /^(submit|button|image|reset)$/.test(type))) return name ? t('de knop “{0}”', name) : t('een knop');
  if (tag === 'select' || role === 'combobox' || role === 'listbox') return name ? t('de keuzelijst “{0}”', name) : t('een keuzelijst');
  if (tag === 'input' && type === 'file') return name ? t('het bestandsveld “{0}”', name) : t('een bestandsveld');
  if (tag === 'input' && (type === 'checkbox' || type === 'radio')) return name ? t('het keuzevakje “{0}”', name) : t('een keuzevakje');
  if (tag === 'input' || tag === 'textarea' || role === 'textbox') return name ? t('het veld “{0}”', name) : t('een veld');
  if (tag === 'img') return name ? t('de afbeelding “{0}”', name) : t('een afbeelding');
  return name ? t('het element “{0}”', name) : fallback;
}

/**
 * Tool results mark outside text as data for the model with tags such as <skill naam="…" geverifieerd="nee"> or
 * <webinhoud bron="…">. In the step details people read a plain heading instead of those tags.
 */
export function resultForDisplay(text: string): string {
  return webPageInWords(String(text ?? ''))
    .replace(/<skill naam="([^"]*)"([^>]*)>\n?/g, (_m, name: string, rest: string) => {
      const v = /versie="([^"]*)"/.exec(rest)?.[1];
      const b = /bron="([^"]*)"/.exec(rest)?.[1];
      const g = /geverifieerd="(ja|nee)"/.exec(rest)?.[1];
      return `Skill “${name}”${v ? `, versie ${v}` : ''}${b ? `, bron: ${b}` : ''}${g ? (g === 'ja' ? ' (geverifieerd)' : ' (niet geverifieerd)') : ''}\n`;
    })
    .replace(/<webinhoud bron="([^"]*)">\n?/g, 'Inhoud van $1:\n')
    .replace(/<serveruitvoer bron="([^"]*)"[^>]*>\n?/g, 'Uitvoer van $1:\n')
    .replace(/<groepsbestand pad="([^"]*)">\n?/g, 'Groepsbestand $1:\n')
    .replace(/\n?<\/(skill|webinhoud|serveruitvoer|groepsbestand)>/g, '');
}
