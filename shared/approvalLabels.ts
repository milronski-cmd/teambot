/**
 * What an approval card says the bot wants, in plain words, per tool (or tool group): "wil iets over je onthouden",
 * "wil Operations iets vragen", "wil een bestand wijzigen". Never the technical tool id ("claude-code:Write",
 * "memory_update"), and never the generic "Wijzigen – wijzigt bestanden of gegevens" for memory or team tools.
 * Pure (no React), so it is unit-tested in tests/approval-labels.test.ts.
 */

export type ApprovalTone = 'neutral' | 'warn' | 'danger';

export interface ApprovalAction {
  /** Follows the bot's name in the card header: "Assistent wil iets over je onthouden". */
  verb: string;
  /** Short badge next to the explanation. */
  badge: string;
  /** One line under the summary: what saying yes means. */
  text: string;
  tone: ApprovalTone;
}

export interface ApprovalLike {
  tool: string;
  risk: 'read' | 'write' | 'exec' | 'danger' | string;
  input?: any;
}

/** CLI engines by provider kind (server/modules/cli-agents/catalog.ts); CLI approvals are "<kind>:<tool>". */
const ENGINES: Record<string, string> = {
  'claude-code': 'Claude Code',
  'codex-cli': 'Codex',
  'gemini-cli': 'Gemini CLI',
  'qwen-code': 'Qwen Code',
  opencode: 'OpenCode',
  'copilot-cli': 'GitHub Copilot',
  'cursor-cli': 'Cursor',
  'kimi-code': 'Kimi',
  'hermes-agent': 'Hermes',
  'grok-build': 'Grok Build',
  'cline-cli': 'Cline',
  'pi-agent': 'Pi',
  'acp-custom': 'je eigen agent',
};

const str = (v: unknown, n = 60) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const bot = (input: any) => str(input?.bot, 40) || 'een andere bot';

const DANGER_TEXT = 'Kan iets versturen, publiceren, verwijderen, overschrijven of betalen. Controleer goed.';
const UNDO_MEMORY = 'Terugdraaien kan in Geheugen › Geschiedenis.';
const TEAM_TEXT = 'Gaat naar je eigen bot; die werkt met zijn eigen toestemmingen.';

function a(verb: string, badge: string, text: string, tone: ApprovalTone = 'warn'): ApprovalAction {
  return { verb, badge, text, tone };
}

/** TeamBot's own tools (names as in the tool registry). */
function teambotAction(name: string, input: any, risk: string): ApprovalAction | null {
  switch (name) {
    // ---- memory and dossiers
    case 'memory_remember': {
      const scope = String(input?.scope || (input?.dossier ? 'dossier' : 'agent'));
      if (scope === 'about_you') return a('wil iets over je onthouden', 'Geheugen', `Komt bij “Over jou” en geldt voor al je bots. ${UNDO_MEMORY}`, 'neutral');
      if (scope === 'shared') return a('wil iets onthouden voor al je bots', 'Geheugen', `Komt in het gedeelde geheugen. ${UNDO_MEMORY}`, 'neutral');
      if (scope === 'dossier') return a('wil iets in een dossier zetten', 'Dossier', `Komt in het dossier. ${UNDO_MEMORY}`, 'neutral');
      return a('wil iets onthouden', 'Geheugen', `Komt in het eigen geheugen van deze bot. ${UNDO_MEMORY}`, 'neutral');
    }
    case 'memory_update':
      return input?.still_valid && !input?.content
        ? a('wil bevestigen dat iets in het geheugen nog klopt', 'Geheugen', UNDO_MEMORY, 'neutral')
        : a('wil iets in het geheugen aanpassen', 'Geheugen', `De oude versie blijft bewaard. ${UNDO_MEMORY}`, 'neutral');
    case 'memory_forget':
      return a('wil iets definitief vergeten', 'Vergeten', 'Dit kan niet ongedaan worden gemaakt.', 'danger');
    case 'dossier_create':
      return a('wil een dossier aanmaken', 'Dossier', 'Een nieuw dossier in Geheugen › Dossiers.', 'neutral');
    case 'dossier_add':
      return a('wil iets aan een dossier toevoegen', 'Dossier', UNDO_MEMORY, 'neutral');
    case 'dossier_update':
      return a('wil een dossier bijwerken', 'Dossier', UNDO_MEMORY, 'neutral');
    case 'dossier_note':
      return a('wil iets in een dossier zetten', 'Dossier', UNDO_MEMORY, 'neutral');
    // ---- team (other bots, task board, group files)
    case 'ask_bot':
      return input?.reply === false ? a(`wil ${bot(input)} iets laten weten`, 'Team', TEAM_TEXT, 'neutral') : a(`wil ${bot(input)} iets vragen`, 'Team', TEAM_TEXT, 'neutral');
    case 'message_bot':
      return a(`wil ${bot(input)} een bericht sturen`, 'Team', TEAM_TEXT, 'neutral');
    case 'delegate_task':
      return a(`wil een taak aan ${bot(input)} geven`, 'Team', TEAM_TEXT, 'neutral');
    case 'broadcast': {
      const list = (Array.isArray(input?.bots) ? input.bots : [input?.bots]).map((b: unknown) => str(b, 30)).filter(Boolean);
      return a(list.length ? `wil ${list.slice(0, 3).join(', ')}${list.length > 3 ? ' en anderen' : ''} iets vragen` : 'wil meerdere bots iets vragen', 'Team', TEAM_TEXT, 'neutral');
    }
    case 'handoff':
      return a(`wil het werk overdragen aan ${bot(input)}`, 'Team', TEAM_TEXT, 'neutral');
    case 'delegation_cancel':
      return a('wil een vraag aan een andere bot intrekken', 'Team', 'De andere bot stopt met dit verzoek.', 'neutral');
    case 'task_create':
      return a('wil een taak op het takenbord zetten', 'Takenbord', 'Je ziet de taak op het takenbord.', 'neutral');
    case 'task_update':
      return a('wil een taak op het takenbord bijwerken', 'Takenbord', 'Je ziet de wijziging op het takenbord.', 'neutral');
    case 'room_file_write':
      return a('wil een bestand in de groepsmap schrijven', 'Groepsmap', 'Alle leden van de groep zien het bestand.');
    // ---- files and commands
    case 'write_file':
      return a('wil een bestand schrijven', 'Bestand', 'Maakt een bestand in de werkmap of overschrijft het.');
    case 'edit_file':
      return a('wil een bestand aanpassen', 'Bestand', 'Wijzigt een bestand in de werkmap.');
    case 'delete_file':
      // With TeamBot's Prullenbak the delete is a reversible change (risk "write"); without it, it stays danger.
      return risk === 'danger' ? a('wil een bestand verwijderen', 'Verwijderen', DANGER_TEXT, 'danger') : a('wil een bestand naar de prullenbak verplaatsen', 'Prullenbak', 'Terughalen kan 30 dagen lang via Bestanden › Prullenbak.', 'neutral');
    case 'delete_file:definitief':
      return a('wil een bestand definitief verwijderen', 'Definitief', 'Het bestand past niet in de prullenbak. Terughalen kan daarna niet.', 'danger');
    case 'run_command':
      return a('wil een opdracht uitvoeren', 'Opdracht', 'Voert een opdracht of programma uit op deze computer.', risk === 'danger' ? 'danger' : 'warn');
    case 'computer_exec':
      return a('wil een opdracht uitvoeren op de computer van de bot', 'Opdracht', 'Voert een opdracht uit in de afgeschermde computer van de bot.');
    // ---- other groups
    case 'routine_create':
      return a('wil een routine aanmaken', 'Routine', 'De bot doet dit dan vanzelf op het gekozen moment. Je kunt hem altijd pauzeren.');
    case 'wait_for':
      return a('wil wachten tot er iets gebeurt', 'Wachtpunt', 'De bot gaat in dit gesprek verder zodra het gebeurt (of als het te lang duurt). Eén keer; je ziet het bij Routines en in de kalender.', 'neutral');
    case 'skill_prepare_scripts':
      return a('wil de scripts van een skill klaarzetten', 'Skill', 'Zet bestanden van de skill in de werkmap van de bot.');
    case 'skill_draft':
      return a('wil een nieuwe skill opstellen', 'Skill', 'Een concept dat je eerst zelf bekijkt.', 'neutral');
    case 'team_execute':
      return a('wil de teamdatabase wijzigen', 'Teamdatabase', 'Voegt gegevens toe of past ze aan in de teamdatabase.');
    case 'site_publish':
      return a('wil een website publiceren', 'Publiceren', 'Wie de link heeft, kan de site openen binnen het gekozen bereik (niet op internet). Controleer de map.', 'danger');
    case 'site_unpublish':
      return a('wil een website offline halen', 'Website', 'De link werkt daarna niet meer.', 'neutral');
    case 'channel_send':
      return a(`wil een bericht versturen${input?.channel ? ` via ${str(input.channel, 30)}` : ''}`, 'Versturen', 'Het bericht gaat naar buiten. Controleer aan wie en wat.', 'danger');
    case 'browser_submit':
    case 'browser_submit:betaling':
      return a(name.endsWith(':betaling') ? 'wil een betaling doen' : 'wil een formulier versturen', name.endsWith(':betaling') ? 'Betalen' : 'Versturen', DANGER_TEXT, 'danger');
    case 'browser_download':
      return a('wil een bestand downloaden', 'Browser', 'Slaat een bestand van de website op in de werkmap.');
    case 'browser_upload':
      return a('wil een bestand uploaden naar een website', 'Browser', 'Stuurt een bestand uit de werkmap naar de website.', 'danger');
    case 'desktop_request_access':
      return a('wil je bureaublad bedienen', 'Bureaublad', 'Muis en toetsenbord voor deze taak. Versturen, betalen en verwijderen vraagt nog apart.', 'danger');
    case 'desktop_request_takeover':
      return a('wil de bediening van je bureaublad overnemen', 'Bureaublad', 'Je kunt altijd op Noodstop drukken.', 'danger');
    case 'rehearsal_start':
    case 'rehearsal_finish':
      return a(name === 'rehearsal_start' ? 'wil oefenen op een kopie van de werkmap' : 'wil de geoefende wijzigingen overnemen', 'Werkmap', 'Wijzigt bestanden in de werkmap.');
    case 'workspace_snapshot':
      return a('wil een herstelpunt van de werkmap maken', 'Werkmap', 'Bewaart een kopie zodat je kunt terugzetten.', 'neutral');
  }
  if (name.startsWith('memory_') || name.startsWith('dossier_')) return a('wil iets in het geheugen doen', 'Geheugen', UNDO_MEMORY, 'neutral');
  if (name.startsWith('task_') || name.startsWith('delegation_')) return a('wil iets op het takenbord doen', 'Team', TEAM_TEXT, 'neutral');
  if (name.startsWith('browser_')) return a('wil iets doen in de browser', 'Browser', risk === 'danger' ? DANGER_TEXT : 'In de eigen browser van de bot.', risk === 'danger' ? 'danger' : 'warn');
  if (name.startsWith('desktop_')) return a('wil je bureaublad bedienen', 'Bureaublad', DANGER_TEXT, 'danger');
  if (name.startsWith('remote_')) return a('wil iets doen op de externe computer', 'Externe computer', 'Werkt op de server die aan de bot gekoppeld is.', risk === 'danger' ? 'danger' : 'warn');
  if (name.startsWith('routine_')) return a('wil een routine wijzigen', 'Routine', 'Je kunt een routine altijd pauzeren.');
  if (name.startsWith('channel_')) return a('wil iets doen in een gekoppeld kanaal', 'Kanaal', DANGER_TEXT, 'danger');
  return null;
}

/** A tool of an app the bot is connected to (MCP: "mcp_<app>_<tool>" in TeamBot, "mcp__<app>__<tool>" in Claude Code). */
function appAction(name: string, risk: string): ApprovalAction | null {
  const m = name.match(/^mcp__([^_].*?)__(.+)$/) || name.match(/^mcp_([a-z0-9-]+)_(.+)$/i);
  if (!m) return null;
  const app = m[1].replace(/[-_]+/g, ' ').trim() || 'een app';
  return risk === 'danger'
    ? a(`wil iets doen in ${app}`, 'App', DANGER_TEXT, 'danger')
    : risk === 'read'
      ? a(`wil iets bekijken in ${app}`, 'App', 'Leest alleen gegevens.', 'neutral')
      : a(`wil iets wijzigen in ${app}`, 'App', `Via de koppeling met ${app}.`);
}

/** The CLI's own tools, namespaced by the engine: "claude-code:Write", "codex:opdracht", "opencode:edit[:danger]". */
function cliAction(engine: string, tool: string, risk: string): ApprovalAction {
  const who = ENGINES[engine] || 'de AI-engine';
  const t = tool.replace(/^mcp__teambot__/, '');
  const danger = risk === 'danger';
  const app = appAction(t, risk);
  if (app) return app;
  // The card's title already says which file and where (relative inside the working folder, the full path in the team
  // folder or an extra folder), so the text never claims "in de werkmap" for a file that is somewhere else.
  if (/^(Write|Edit|MultiEdit|NotebookEdit|edit|move|bestanden)$/.test(t)) return a(t === 'move' ? 'wil een bestand verplaatsen' : 'wil een bestand wijzigen', 'Bestand', `${who} wijzigt dit bestand.`, danger ? 'danger' : 'warn');
  if (t === 'bestand-schrijven') return a('wil een bestand schrijven', 'Bestand', `${who} schrijft dit bestand met een opdracht.`, danger ? 'danger' : 'warn');
  if (/^(delete)$/.test(t)) return a('wil een bestand verwijderen', 'Verwijderen', DANGER_TEXT, 'danger');
  if (/^(Bash|PowerShell|execute|opdracht|KillShell|KillBash|Monitor)$/.test(t)) return a(danger ? 'wil een opdracht met gevolgen uitvoeren' : 'wil een opdracht uitvoeren', 'Opdracht', danger ? DANGER_TEXT : `${who} voert een opdracht uit op deze computer.`, danger ? 'danger' : 'warn');
  if (/^(WebFetch|fetch)$/.test(t)) return a('wil een webpagina lezen', 'Internet', 'Leest alleen gegevens.', 'neutral');
  if (t === 'netwerk') return a('wil internet gebruiken', 'Internet', `${who} krijgt netwerktoegang voor deze opdracht.`, 'danger');
  if (t === 'extra-rechten') return a('wil extra rechten', 'Extra rechten', `${who} vraagt meer rechten dan de bot nu heeft.`, 'danger');
  if (/^(ExitPlanMode|EnterPlanMode|switch_mode)$/.test(t)) return a('wil van werkwijze wisselen', 'Werkwijze', 'Bijvoorbeeld van plannen naar uitvoeren.');
  if (t === 'vraag') return a('vraagt', 'Vraag', '', 'neutral');
  return generic(risk);
}

function generic(risk: string): ApprovalAction {
  switch (risk) {
    case 'read':
      return a('wil iets bekijken', 'Lezen', 'Leest alleen gegevens.', 'neutral');
    case 'exec':
      return a('wil een opdracht uitvoeren', 'Opdracht', 'Voert een opdracht of programma uit.');
    case 'danger':
      return a('wil iets doen met gevolgen', 'Impact', DANGER_TEXT, 'danger');
    default:
      return a('wil iets wijzigen', 'Wijzigen', 'Wijzigt iets in de werkmap of in TeamBot.');
  }
}

export function approvalAction(x: ApprovalLike): ApprovalAction {
  const tool = String(x.tool || '');
  const risk = String(x.risk || 'write');
  // "<engine>:<tool>[:danger]" from a CLI's own permission prompt (TeamBot tool names never have a hyphen-only prefix).
  const cli = tool.match(/^([a-z0-9-]+):(.+?)(:danger)?$/i);
  if (cli) return cliAction(cli[1], cli[2], cli[3] ? 'danger' : risk);
  return teambotAction(tool, x.input, risk) || appAction(tool, risk) || generic(risk);
}

/** What the bot wants without "wil" ("iets over je onthouden"), e.g. for "Wacht op toestemming: …" in its steps. */
export function approvalWhat(x: ApprovalLike): string {
  return approvalAction(x).verb.replace(/^wil /, '');
}

/** Short plain name of the tool behind an approval, for lists (e.g. the history in "Wacht op jou"). */
export function approvalToolName(x: ApprovalLike & { kind?: string }): string {
  if (x.kind === 'question') return 'vraag';
  const v = approvalAction(x).verb.replace(/^wil /, '');
  return v.charAt(0).toUpperCase() + v.slice(1);
}

/** The engine behind a CLI approval ("Claude Code"), or '' for TeamBot's own tools. */
export function approvalEngine(tool: string): string {
  const m = String(tool || '').match(/^([a-z0-9-]+):/i);
  return m ? ENGINES[m[1]] || '' : '';
}
