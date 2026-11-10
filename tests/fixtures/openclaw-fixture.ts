import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A synthetic OpenClaw installation (state folder ~/.openclaw) in a temp folder, laid out as OpenClaw documents it:
 * openclaw.json (JSON5 with comments, unquoted keys, trailing commas), a default agent "main" with a workspace
 * (AGENTS.md, SOUL.md, IDENTITY.md, USER.md, MEMORY.md, a daily log, a workspace skill), a second agent with its own
 * workspace-<id>, a shared skill, scheduled jobs (cron, every, at, and a command that is never taken over), and the
 * places that hold secrets (credentials/, .env, the agent's auth profiles, keys in the config). Every secret is a
 * "LOKAAS" decoy: a test fails when one ends up anywhere in TeamBot.
 */
export const DECOY = 'LOKAAS';

export function makeOpenClawFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-openclaw-'));
  const home = path.join(root, 'home');
  const state = path.join(home, '.openclaw');
  const w = (rel: string, text: string) => {
    const f = path.join(state, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  };
  w(
    'openclaw.json',
    `// OpenClaw gateway configuration
{
  agents: {
    defaults: { model: { primary: 'anthropic/claude-sonnet-4-6', fallbacks: ['openai/gpt-5.2'] }, },
    list: [
      { id: 'main', default: true, identity: { name: 'Clawd', emoji: '🦞' } },
      { id: 'research', name: "Onderzoeker", model: 'openai/gpt-5.2', }, /* second agent */
    ],
  },
  channels: { telegram: { accounts: { default: { botToken: '${DECOY}-TELEGRAM-123456789' } } }, whatsapp: { accounts: {} } },
  models: { providers: { openai: { apiKey: 'sk-${DECOY}000000000000000000000000' } } },
  env: { vars: { GITHUB_TOKEN: 'ghp_${DECOY}0000000000000000000000000000' } },
  gateway: { auth: { token: '${DECOY}-GATEWAY' } },
}
`,
  );
  w('workspace/AGENTS.md', '# Werkwijze\n\nJe bent de persoonlijke assistent van Sanne. Antwoord kort en in het Nederlands.\n');
  w('workspace/SOUL.md', 'Rustig, behulpzaam en een beetje droog gevoel voor humor.\n');
  w('workspace/IDENTITY.md', '- **Name:** Clawd\n- **Emoji:** 🦞\n- **Vibe:** kalm\n');
  w('workspace/USER.md', '# Over Sanne\n\n- Woont in Utrecht\n- Werkt als ontwerper bij een klein bureau\n- Wachtwoord: hunter2-' + DECOY + '\n');
  w('workspace/MEMORY.md', '## Voorkeuren\n\n- Houdt van korte antwoorden\n- Drinkt geen koffie na 15:00\n');
  w('workspace/memory/2026-11-01.md', '- Vandaag de offerte voor Jansen besproken.\n');
  w('workspace/skills/notities/SKILL.md', '---\nname: notities\ndescription: Maakt korte notities van een gesprek.\n---\n\n# Notities\n\n1. Vat samen in drie punten.\n');
  w('workspace-research/AGENTS.md', '# Onderzoek\n\nZoek bronnen en vat ze samen met links.\n');
  w('workspace-research/MEMORY.md', '- Gebruikt bij voorkeur Nederlandse bronnen\n');
  w('skills/weer/SKILL.md', '---\nname: weer\ndescription: Geeft het weerbericht voor een plaats.\n---\n\n# Weer\n\nNoem temperatuur en neerslag.\n');
  w(
    'cron/jobs.json',
    JSON.stringify(
      {
        version: 1,
        jobs: [
          {
            id: 'job-ochtend',
            name: 'Ochtendbriefing',
            enabled: true,
            agentId: 'main',
            schedule: {
              kind: 'cron',
              expr: '0 7 * * 1-5',
              tz: 'Europe/Amsterdam',
            },
            sessionTarget: 'isolated',
            payload: {
              kind: 'agentTurn',
              message: 'Geef mijn ochtendbriefing.',
            },
            delivery: { mode: 'announce', channel: 'telegram', to: '12345' },
          },
          {
            id: 'job-bronnen',
            name: 'Bronnen checken',
            enabled: false,
            owner: { agentId: 'research' },
            schedule: { kind: 'every', everyMs: 4 * 3600_000 },
            payload: {
              kind: 'agentTurn',
              message: 'Kijk of er nieuwe bronnen zijn.',
            },
          },
          {
            id: 'job-herinnering',
            name: 'Tandarts',
            enabled: true,
            agentId: 'main',
            schedule: { kind: 'at', at: '2026-12-01T09:30:00Z' },
            payload: {
              kind: 'systemEvent',
              text: 'Herinner me aan de tandarts.',
            },
            deleteAfterRun: true,
          },
          {
            id: 'job-backup',
            name: 'Back-up script',
            enabled: true,
            agentId: 'main',
            schedule: { kind: 'cron', expr: '0 3 * * *' },
            payload: {
              kind: 'command',
              argv: ['rsync', '-a', '/home', '/backup'],
            },
          },
        ],
      },
      null,
      2,
    ),
  );
  // Where OpenClaw keeps secrets: never read.
  w('credentials/whatsapp/default/creds.json', JSON.stringify({ token: `${DECOY}-WHATSAPP` }));
  w('.env', `OPENAI_API_KEY=sk-${DECOY}-ENV\n`);
  w('agents/main/agent/auth-profiles.json', JSON.stringify({ anthropic: { token: `${DECOY}-AUTH` } }));
  w('agents/main/sessions/abc.jsonl', JSON.stringify({ role: 'user', content: `Gesprek met ${DECOY}` }) + '\n');
  return { root, home, state };
}

/** Every file of the fixture with its bytes (to prove OpenClaw is never changed). */
export function snapshotFiles(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else out.set(path.relative(dir, f), fs.readFileSync(f).toString('base64'));
    }
  };
  walk(dir);
  return out;
}
