import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A fake Hermes Agent data folder (made-up data, never a real one), in the layout Hermes uses: config.yaml, SOUL.md,
 * memories/MEMORY.md + USER.md (entries separated by "\n§\n"), skills/<category>/<name>/SKILL.md with a
 * .bundled_manifest, cron/jobs.json and a second profile under profiles/. The decoys must never reach TeamBot.
 */
export const HERMES_DECOYS = ['sk-decoy-hermes-config-key-123', 'decoy-hermes-mcp-token-456', 'sk-decoy-hermes-env-key-789', 'decoy-hermes-telegram-000', 'decoy-hermes-auth-111'];

export interface HermesFixture {
  root: string;
  home: string;
  cleanup(): void;
}

export function makeHermesFixture(): HermesFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-hermes-'));
  const home = path.join(root, '.hermes');
  const w = (rel: string, text: string) => {
    const p = path.join(home, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  w(
    'config.yaml',
    [
      '# Fake Hermes Agent config for TeamBot tests (not real data).',
      'model:',
      '  provider: openrouter',
      '  default: anthropic/claude-opus-4.7',
      "  base_url: ''",
      `  api_key: ${HERMES_DECOYS[0]}`,
      'timezone: Europe/Amsterdam',
      'mcp_servers:',
      '  agenda:',
      '    command: npx',
      '    args: [agenda-mcp]',
      '    env:',
      `      AGENDA_TOKEN: ${HERMES_DECOYS[1]}`,
      '',
    ].join('\n'),
  );
  w('.env', `OPENROUTER_API_KEY=${HERMES_DECOYS[2]}\nTELEGRAM_BOT_TOKEN=${HERMES_DECOYS[3]}\n`);
  w('auth.json', JSON.stringify({ providers: { nous: { access_token: HERMES_DECOYS[4] } } }));
  w('SOUL.md', '# Wie je bent\n\nJe bent de persoonlijke assistent van Sam. Je antwoordt kort en in het Nederlands.\nJe plant, zoekt dingen uit en houdt de agenda bij.\n');
  // Windows line endings and an empty entry: both are handled like Hermes does (split, trim, drop empty).
  w('memories/MEMORY.md', 'Sam werkt als zelfstandig fotograaf.\r\n§\r\nFacturen gaan altijd via het boekhoudpakket, nooit los per mail.\n§\n\n§\nDe NAS staat op 192.168.1.20.');
  w('memories/USER.md', 'Sam heet voluit Sam de Vries.\n§\nSam wil antwoorden zonder emoji.');
  w('skills/.bundled_manifest', 'arxiv:3f2a9c\n');
  w('skills/research/DESCRIPTION.md', 'Research skills.\n');
  w('skills/research/arxiv/SKILL.md', '---\nname: arxiv\ndescription: Zoek artikelen op arXiv en vat ze samen.\n---\n\n# arXiv\n\nZoek met de web-tool op arxiv.org en vat de abstracts samen.\n');
  w('skills/eigen/factuur-check/SKILL.md', '---\nname: factuur-check\ndescription: Controleer een factuur op bedrag, btw en vervaldatum.\n---\n\n# Factuur controleren\n\n1. Lees de factuur.\n2. Controleer het btw-bedrag (21% of 9%).\n3. Noem de vervaldatum.\n');
  w('skills/.archive/oud/SKILL.md', '---\nname: oud\ndescription: Gearchiveerd.\n---\nOud.\n');
  w(
    'cron/jobs.json',
    JSON.stringify(
      {
        jobs: [
          { id: 'a1b2c3', name: 'Ochtendbriefing', prompt: 'Geef me een korte briefing: agenda, weer en open facturen.', schedule: { kind: 'cron', expr: '0 8 * * 1-5', display: '0 8 * * 1-5' }, schedule_display: '0 8 * * 1-5', enabled: true, deliver: 'telegram', skills: ['factuur-check'] },
          { id: 'd4e5f6', name: 'Back-up controleren', prompt: 'Kijk of de back-up van de NAS gelukt is.', schedule: { kind: 'interval', minutes: 360, display: 'every 360m' }, enabled: false },
          { id: 'g7h8i9', name: 'Herinnering btw-aangifte', prompt: 'Herinner me aan de btw-aangifte.', schedule: { kind: 'once', run_at: '2027-01-20T09:00:00+01:00', display: 'once at 2027-01-20 09:00' }, enabled: true, model: 'openai/gpt-5' },
          { id: 'j0k1l2', name: 'Schijfruimte', script: 'df -h', no_agent: true, schedule: { kind: 'interval', minutes: 60 }, enabled: true },
        ],
        updated_at: '2026-11-01T10:00:00+00:00',
      },
      null,
      2,
    ),
  );
  w('profiles/schrijver/config.yaml', 'model:\n  provider: lmstudio\n  default: qwen3-8b\n');
  w('profiles/schrijver/SOUL.md', 'Je bent een schrijfhulp. Je schrijft blogs in de stijl van Sam: kort, warm en zonder jargon.\n');
  w('profiles/schrijver/memories/MEMORY.md', 'Blogs zijn maximaal 600 woorden.');
  w('profiles/schrijver/memories/USER.md', 'Sam wil antwoorden zonder emoji.\n§\nSam schrijft voor fotografen.');
  // The older bare-list form, with a schedule in its text form.
  w('profiles/schrijver/cron/jobs.json', JSON.stringify([{ id: 'w1', name: 'Weekblog', prompt: 'Schrijf een concept voor de weekblog.', schedule: 'every 7d', enabled: true }]));
  w('profiles/schrijver/skills/eigen/blog-stijl/SKILL.md', '---\nname: blog-stijl\ndescription: Schrijf in de blogstijl van Sam.\n---\n\n# Blogstijl\n\nKorte zinnen. Eén idee per alinea. Sluit af met een vraag aan de lezer.\n');
  // Not profiles: a dot folder and a folder with an invalid name.
  w('profiles/.verborgen/SOUL.md', 'niet echt');
  w('profiles/Hoofd Letters/SOUL.md', 'niet echt');
  return { root, home, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Every file in the folder with its bytes (to prove the import only reads). */
export function snapshotFolder(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(path.relative(dir, p), fs.readFileSync(p).toString('base64') + ':' + fs.statSync(p).mtimeMs);
    }
  };
  walk(dir);
  return out;
}
