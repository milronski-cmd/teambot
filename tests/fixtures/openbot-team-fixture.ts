import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type OpenBotFixture, makeOpenBotFixture } from './openbot-fixture.js';

/**
 * A synthetic OpenBot team shaped like a real one (made-up data, built at test time): Baas (the lead), Baas Live (a
 * voice line that passes work to Baas), Kennis & Kansen (a daily knowledge round and a weekly opportunities round),
 * SEO & Content, Ads & Shopping, Operations, Klantenservice (its inbox routines are off in OpenBot until a dry test is
 * approved) and Bouwer; ~/OpenBot/Shared with the team tables taken, beslissingen, gebeurtenissen and experimenten in
 * agent-data.db. Builds on makeOpenBotFixture (Baas and Klantenservice come from there).
 */
export const TEAM_DECOY_SECRETS = ['decoy-team-server-private-key-321', 'decoy-team-session-token-654'];

export interface OpenBotTeamFixture extends OpenBotFixture {
  team: { baas: string; live: string; kennis: string; seo: string; ads: string; ops: string; klant: string; bouwer: string };
  agentData: string;
}

const id = (n: number) => `agent-33333333-aaaa-4bbb-8ccc-${String(n).padStart(12, '0')}`;

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

export function makeOpenBotTeamFixture(o: { workspaceName?: string } = {}): OpenBotTeamFixture {
  const fx = makeOpenBotFixture();
  const team = { baas: fx.agents.baas, live: id(3), kennis: id(4), seo: id(5), ads: id(6), ops: id(7), klant: fx.agents.klant, bouwer: id(8) };
  const ws = fx.workspace;

  // ---- the other bots: workspaces with instructions, and a skill of the knowledge bot ----
  write(path.join(ws(team.live), 'AGENTS.md'), '# Baas Live\n\nJe bent de spraaklijn van de eigenaar naar het team. Korte vragen beantwoord je zelf; werk zet je door naar de Baas.\n');
  write(
    path.join(ws(team.kennis), 'AGENTS.md'),
    '# Kennis & Kansen\n\nJe houdt het team elke dag op de hoogte van nieuwe kennis over SEO en Google Ads. Lees bij de start `~/OpenBot/Shared/LEESMIJ.md`.\n\n## Vak\n- Bronnen: Google Search Central, SE Roundtable, Reddit (via de browser), nieuwsbrieven. Blokkeert een site: browser gebruiken.\n- Alleen nieuw en relevant, met bron en datum.\n',
  );
  write(
    path.join(ws(team.kennis), '.agents', 'skills', 'kennisloop', 'SKILL.md'),
    '---\nname: kennisloop\ndescription: Nieuwe kennis ophalen, checken en in de kennisbank zetten.\n---\n\n# Kennisloop\n\nLees https://www.seroundtable.com/ en de feed per subreddit (https://www.reddit.com/r/<sub>/top/.rss?t=day).\n',
  );
  write(path.join(ws(team.seo), 'AGENTS.md'), '# SEO & Content\n\nJe maakt de sites beter vindbaar en past bewezen kennis uit de kennisbank toe.\n');
  write(path.join(ws(team.ads), 'AGENTS.md'), '# Ads & Shopping\n\nJe beheert advertenties en productfeeds: alleen waar ze winst maken.\n');
  write(path.join(ws(team.ops), 'AGENTS.md'), '# Operations\n\nBestellingen, verzending, voorraad en marges.\n');
  write(path.join(ws(team.bouwer), 'AGENTS.md'), '# Bouwer\n\nJe bouwt en onderhoudt de sites, koppelingen en scripts.\n');

  // ---- the workspace name and its keys (decoys: only the name may be read) ----
  write(
    path.join(fx.dataDir, 'openbot-team-server-v2.json'),
    JSON.stringify({ version: 2, activeAccountId: 'acc-1', hosts: [{ version: 2, serverId: 'srv-1', serverName: o.workspaceName ?? 'OpenBot', enabledOnLaunch: true, publicKey: 'pub', privateKey: TEAM_DECOY_SECRETS[0], members: [{ id: 'm1', name: 'Eigenaar', role: 'owner' }], invites: [], sessions: [{ token: TEAM_DECOY_SECRETS[1] }] }] }),
  );

  // ---- database: the bots and their routines ----
  const db = new DatabaseSync(path.join(fx.dataDir, 'openbot.db'));
  const ts = '2026-11-06T00:00:00.000Z';
  const agent = (aid: string, sort: number, j: any) => db.prepare('INSERT INTO projection_agents VALUES (?, ?, ?, ?, ?, ?, 1)').run(aid, 'openbot-thread-' + aid, j.model, ts, sort, JSON.stringify({ id: aid, threadId: 'openbot-thread-' + aid, workspacePath: ws(aid), access: 'full', computerUse: false, reasoningEffort: 'medium', provider: 'claude', ...j }));
  agent(team.live, 2, { name: 'Baas Live', description: 'Spraaklijn naar het team: live praten, korte vragen zelf, werk door naar de Baas.', model: 'gpt-test-live', provider: 'codex', avatarSeed: 'live' });
  agent(team.kennis, 3, { name: 'Kennis & Kansen', description: 'Haalt elke dag nieuwe kennis, checkt feiten, vult de kennisbank en zoekt nieuwe kansen.', model: 'claude-haiku-5-5', avatarSeed: 'kennis' });
  agent(team.seo, 4, { name: 'SEO & Content', description: 'SEO en teksten van alle sites. Past bewezen kennis toe en test nieuwe.', model: 'claude-sonnet-5-5', avatarSeed: 'seo' });
  agent(team.ads, 5, { name: 'Ads & Shopping', description: 'Advertenties en feeds, alleen waar ze winst maken.', model: 'claude-sonnet-5-5', avatarSeed: 'ads' });
  agent(team.ops, 6, { name: 'Operations', description: 'Bestellingen, verzending, voorraad en marges.', model: 'claude-sonnet-5-5', avatarSeed: 'ops' });
  agent(team.bouwer, 7, { name: 'Bouwer', description: 'Bouwt en onderhoudt alle code.', model: 'claude-sonnet-5-5', avatarSeed: 'bouwer' });
  const routine = (rid: string, agentId: string, name: string, instruction: string, schedule: any, active = 1) => {
    db.prepare('INSERT INTO projection_agent_routines VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)').run(rid, agentId, name, instruction, active, 'Europe/Amsterdam', ts, ts, 'wait', 'skip', 'thread');
    db.prepare('INSERT INTO projection_routine_triggers VALUES (?, ?, ?, ?, ?, ?, 1)').run('trg-' + rid, rid, JSON.stringify(schedule), ts, ts, ts);
  };
  routine('t-kennis-dag', team.kennis, 'Kennisronde ochtend', 'Kennisronde: lees https://developers.google.com/search/blog en r/SEO, r/PPC. Alleen nieuw, met bron en datum.', { kind: 'daily', time: '06:30' });
  routine('t-kansen-week', team.kennis, 'Kansenronde', 'Kansenronde: nieuwe niches en leadmarkten. Beste 1 tot 3 als kaart in beslissingen.', { kind: 'weekly', weekday: 1, time: '07:00' });
  routine('t-seo', team.seo, 'Search Console-ronde', 'Per site Search Console: dalers en kansen. Gebruik de kennisbank.', { kind: 'daily', time: '07:00' });
  routine('t-ads', team.ads, 'Merchant en Ads ochtend', 'Alle accounts: afkeuringen, uitgaven en conversies.', { kind: 'daily', time: '08:00' });
  routine('t-ops', team.ops, 'Orders-ronde', 'Elk uur de stand van betaalde orders die nog niet verzonden zijn.', { kind: 'custom', expression: '0 8-21 * * *' });
  routine('t-bouwer', team.bouwer, 'Sites-check', 'Zijn alle sites online en werken de formulieren?', { kind: 'daily', time: '07:15' });
  // Klantenservice's inbox routine stays off until the owner approves a dry test (as in OpenBot).
  routine('t-klant-inbox', team.klant, 'Inbox beantwoorden', 'Lees de inbox en maak concepten; verstuur niets zonder akkoord.', { kind: 'custom', expression: '*/30 8-22 * * *' }, 0);
  db.close();

  // ---- the team tables (agent-data.db in ~/OpenBot/Shared/Data) ----
  const agentData = path.join(fx.home, 'OpenBot', 'Shared', 'Data', 'agent-data.db');
  fs.mkdirSync(path.dirname(agentData), { recursive: true });
  const td = new DatabaseSync(agentData);
  td.exec(`
CREATE TABLE openbot_metadata (table_name TEXT PRIMARY KEY, owner_agent_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE taken (id INTEGER PRIMARY KEY, titel TEXT NOT NULL, eigenaar TEXT NOT NULL, aangevraagd_door TEXT, site TEXT, status TEXT NOT NULL DEFAULT 'open', resultaat TEXT, bewijs TEXT, aangemaakt TEXT, bijgewerkt TEXT);
CREATE TABLE beslissingen (id INTEGER PRIMARY KEY, vraag TEXT NOT NULL, uitleg TEXT, opties TEXT, gevraagd_door TEXT, status TEXT NOT NULL DEFAULT 'open', antwoord TEXT, vervangt_id INTEGER, aangemaakt TEXT, beslist TEXT);
CREATE TABLE gebeurtenissen (id INTEGER PRIMARY KEY, soort TEXT NOT NULL, dossier TEXT, bron TEXT, samenvatting TEXT, verwerkt INTEGER NOT NULL DEFAULT 0, tijd TEXT);
CREATE TABLE experimenten (id INTEGER PRIMARY KEY, vak TEXT, hypothese TEXT NOT NULL, bron TEXT, sites TEXT, status TEXT NOT NULL DEFAULT 'loopt', uitkomst TEXT, aangemaakt TEXT);
CREATE TABLE dagtotaal (datum TEXT PRIMARY KEY, omzet REAL, orders INTEGER);
`);
  const meta = td.prepare('INSERT INTO openbot_metadata VALUES (?, ?, ?)');
  for (const t of ['taken', 'beslissingen', 'gebeurtenissen', 'experimenten']) meta.run(t, team.baas, ts);
  meta.run('dagtotaal', team.ops, ts);
  const task = td.prepare('INSERT INTO taken (id, titel, eigenaar, aangevraagd_door, status, aangemaakt) VALUES (?, ?, ?, ?, ?, ?)');
  task.run(11, 'Feed controleren', 'Ads & Shopping', 'Baas', 'open', '2026-11-06 10:00:00');
  task.run(12, 'Kapotte links herstellen', 'Bouwer', 'SEO & Content', 'bezig', '2026-11-06 11:00:00');
  task.run(13, 'Retour afhandelen', 'Klantenservice', 'Baas', 'wacht_op_eigenaar', '2026-11-06 12:00:00');
  td.prepare('INSERT INTO beslissingen (id, vraag, opties, gevraagd_door, status, aangemaakt) VALUES (?, ?, ?, ?, ?, ?)').run(21, 'Testcampagne starten?', 'A) Ja; B) Later', 'Ads & Shopping', 'open', '2026-11-06 09:00:00');
  td.prepare('INSERT INTO beslissingen (id, vraag, opties, gevraagd_door, status, antwoord, aangemaakt) VALUES (?, ?, ?, ?, ?, ?, ?)').run(22, 'Nieuwe niche proberen?', '["Ja","Nee"]', 'Kennis & Kansen', 'gekozen', 'Ja', '2026-11-05 09:00:00');
  td.prepare('INSERT INTO gebeurtenissen (id, soort, dossier, samenvatting, verwerkt, tijd) VALUES (?, ?, ?, ?, ?, ?)').run(31, 'klantbericht', 'klant-a', 'Vraag over levertijd', 0, '2026-11-06 08:00:00');
  td.prepare('INSERT INTO experimenten (id, vak, hypothese, status, aangemaakt) VALUES (?, ?, ?, ?, ?)').run(41, 'SEO', 'Kortere titels geven meer klikken', 'loopt', '2026-11-05 10:00:00');
  td.prepare('INSERT INTO dagtotaal VALUES (?, ?, ?)').run('2026-11-06', 120.5, 3);
  td.close();

  return { ...fx, team, agentData };
}
