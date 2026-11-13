// Memory reaches an engine with its own session (Claude Code, Codex, an ACP agent) the way every instruction does
// (modules/cli-agents/context.ts): the dossiers are a "## Dossiers" part of the bot's instructions. The session gets the
// whole text when it starts, and after that only a part that changed since it last saw it: a dossier a colleague
// changed between two turns arrives at the next turn, once; a turn without a change carries no memory text at all
// (memory no longer repeats itself per turn). Checked on the real CLI routes with the scripted fake engines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestApp, type TestApp } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = {
  'claude-code': { path: path.join(here, 'fixtures', 'cli-agents-fake-claude.mjs') },
  'codex-cli': { path: path.join(here, 'fixtures', 'cli-agents-fake-codex.mjs') },
  'acp-custom': { command: path.join(here, 'fixtures', 'cli-agents-fake-acp.mjs'), args: [] },
} as const;
type Kind = keyof typeof FAKE;

function useLog(t: TestApp) {
  const file = path.join(t.dir, 'fake-cli.log');
  process.env.FAKE_CLI_LOG = file;
  return () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
}

/** What each turn handed the engine, in order: the text of the turn and (Claude Code) the system prompt file. */
const turns = (log: any[], kind: Kind): { prompt: string; system?: string }[] =>
  kind === 'acp-custom'
    ? log.filter((l) => l.method === 'session/prompt').map((l) => ({ prompt: String(l.params.text) }))
    : log.filter((l) => l.cli === (kind === 'codex-cli' ? 'codex' : 'claude') && l.argv && typeof l.prompt === 'string').map((l) => ({ prompt: l.prompt, system: l.system }));

test('a dossier a colleague changed between two turns reaches a CLI session at the next turn, once; a turn without a change carries no memory text — Codex, ACP and Claude Code', async () => {
  const t = await startTestApp();
  const logs = useLog(t);
  process.env.CODEX_HOME = t.dir;
  try {
    // A colleague on a model through an API key keeps the team's dossier.
    const ada = await t.agent({ name: 'Ada' });
    const write = async (content: string) => {
      const th = await t.api('POST', '/threads', { agentId: ada.id });
      t.script.push({ toolCalls: [{ name: 'dossier_write', args: { dossier: 'Overzicht', content } }] }, { text: 'Bijgewerkt.' });
      await t.say(th.id, 'Zet het in het overzicht.');
    };
    await write('- De winkel is op maandag dicht.');
    for (const kind of ['codex-cli', 'acp-custom', 'claude-code'] as Kind[]) {
      const n = logs().length;
      const p = await t.api('POST', '/providers', { kind, config: FAKE[kind] });
      // (Read-only: no approval card in between; Codex then runs one `codex exec` per turn.)
      const bot = await t.api('POST', '/agents', { name: `Cli ${kind}`, provider_id: p.id, model: '', access_mode: 'readonly' });
      const th = await t.api('POST', '/threads', { agentId: bot.id });
      await t.say(th.id, 'een');
      await t.say(th.id, 'twee');
      await write(`- Nieuwe leverancier voor ${kind}: levert elke dinsdag.`);
      await t.say(th.id, 'drie');
      await t.say(th.id, 'vier');
      const T = turns(logs().slice(n), kind);
      assert.equal(T.length, 4, kind);
      // The session starts with the dossiers as they are.
      assert.match(kind === 'claude-code' ? T[0].system! : T[0].prompt, /## Dossiers[\s\S]*De winkel is op maandag dicht\./, kind);
      // Nothing changed: the turn is the question and its context, no memory text.
      assert.doesNotMatch(T[1].prompt, /teambot_instructies|## Dossiers|## Geheugen|winkel is op maandag/, `${kind}: nothing changed → no memory text`);
      // The colleague's change: the dossiers part, once, at the next turn (not the rest of the instructions).
      assert.match(T[2].prompt, new RegExp(`<teambot_instructies_update>[\\s\\S]*## Dossiers[\\s\\S]*Nieuwe leverancier voor ${kind}: levert elke dinsdag\\.[\\s\\S]*</teambot_instructies_update>`), kind);
      assert.doesNotMatch(T[2].prompt, /## Geheugen\n/, `${kind}: only the part that changed`);
      assert.doesNotMatch(T[3].prompt, /teambot_instructies|## Dossiers|leverancier/, `${kind}: sent once`);
    }
  } finally {
    delete process.env.CODEX_HOME;
    await t.close();
  }
});
