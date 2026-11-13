/**
 * Where something is in the screens, for a message ("… bij Instellingen › Meer mogelijkheden › Zoeken op internet").
 * One source: the list of Instellingen in shared/settings.ts (SETTINGS_ROWS and SETTINGS_PAGES), which the interface
 * shows (ui/src/lib/palette.ts). A message names a place through PLACE (or placeOf for a key from data), never by
 * typing the path, so a renamed title changes in shared/settings.ts once. tests/screen-places.test.ts checks every
 * place against the settings list the interface shows, and every "Instellingen › …" a text still names itself.
 * The interface language translates such a path step by step (shared/i18n-core.ts), with the titles of the list.
 */
import { SETTINGS_PAGES, SETTINGS_ROWS } from './settings.js';

/** "Instellingen › Meer mogelijkheden › Spraak": where an entry of Instellingen is, by its key in shared/settings.ts. */
export function placeOf(key: string): string {
  const own = SETTINGS_ROWS.find((r) => r.main === key);
  if (own) return `Instellingen › ${own.title}`;
  const row = SETTINGS_ROWS.find((r) => (r.more || []).some((s) => s.items.includes(key)));
  return `Instellingen › ${row ? `${row.title} › ` : ''}${SETTINGS_PAGES[key]?.title || key}`;
}

export const PLACE = {
  /** The connected AIs, and "Toevoegen": an API key, a subscription, a free model, a model on this computer. */
  ai: placeOf('providers'),
  /** Pairing the phone (the QR code). */
  phone: placeOf('telefoon'),
  /** Name, language, theme and colour. */
  look: placeOf('general'),
  /**
   * Teaminstellingen: who may look along or direct a team, its daily budget, keys and logins. Not the row Teams: that
   * short page shows only the name of a team (ui/src/modules/teams/TeamsPage.tsx, `simple`).
   */
  teams: placeOf('teams-teams'),
  /** Telegram, WhatsApp, Discord, Slack and e-mail. */
  channels: placeOf('channels/'),
  /** The apps (MCP): Gmail, agenda, Notion … */
  apps: placeOf('mcp/'),
  /** Claude Code, Codex, OpenCode …: install, log in, the path of the program, "opnieuw toestaan". */
  aiPrograms: placeOf('cli-agents-cli'),
  /** The free reserve model when a limit is reached. */
  engineChain: placeOf('engine-chain-doorschakelen'),
  /** The AI, model, time zone and daily budget a new bot starts with. */
  botDefaults: placeOf('bot-defaults'),
  /** The search service, own search keys and "Pagina’s lezen via Jina als het zelf niet lukt". */
  search: placeOf('websearch-zoeken'),
  /** The service and model that make images, and the maximum per day. */
  images: placeOf('images-afbeeldingen'),
  /** Voices, dictation, reading aloud and the free voice on this computer. */
  voice: placeOf('voice-spraak'),
  /** The maximum for all routines together, and the reminders a bot may have waiting. */
  routineDefaults: placeOf('routines-routines'),
  /** Use and limits of the subscriptions, and the floating status window. */
  limits: placeOf('usage/'),
  /** Costs per day, bot and model, with the daily budget ("Aanpassen"). */
  costs: placeOf('usage'),
  /** Whose skills and bots are trusted (signed items). */
  trustedMakers: placeOf('skills-uitgevers'),
  /** Users of a server: invitations, roles, what members may (cloud VMs, budget). */
  users: placeOf('users'),
  /** Remote desktop: on/off (only at the computer itself) and its options. */
  remoteDesktop: placeOf('remote-desktop/'),
  /** Logins and passwords for the bots ("Login toevoegen"). */
  vault: placeOf('browser/kluis'),
  /** Signed-in devices, stored keys and the log. */
  security: placeOf('security'),
  /** What stays on this computer and what goes to an AI service; the diagnostics file. */
  privacy: placeOf('data'),
  /** A proxy for a company network. */
  proxy: placeOf('network-proxy'),
};
