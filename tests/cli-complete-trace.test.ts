/**
 * A short answer from Claude Code ("maak een profiel", a skill check, …) leaves nothing in the user's own Claude Code
 * folder (new-user check, 12 nov: every short call left a `tb-cli-complete-*` folder under ~/.claude/projects; there
 * were 508 of them). TeamBot asks Claude Code not to keep the session; an older Claude Code that cannot do that keeps
 * one, and TeamBot removes exactly that folder — nothing else of the user's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cliComplete } from '../server/modules/cli-agents/complete.js';
import { defById } from '../server/modules/cli-agents/catalog.js';

/** A Claude Code that, like the real one, keeps each `-p` call as a session in a folder named after its working folder. */
const FAKE = (flag: boolean) => `
import fs from 'node:fs';
import path from 'node:path';
const argv = process.argv.slice(2);
if (argv[0] === '--help') {
  console.log('Usage: claude [options]\\n  --setting-sources <sources>\\n  --settings <file-or-json>\\n  --tools <tools...>  Available tools${flag ? '\\n  --no-session-persistence  Disable session persistence' : ''}');
  process.exit(0);
}
if (!argv.includes('--no-session-persistence')) {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sessie.jsonl'), '{}\\n');
}
// Like the real one: with its tools on, a model that wants to read a file first ends the single turn without an answer.
const i = argv.indexOf('--tools');
console.log(i >= 0 && argv[i + 1] === '' ? 'Een profiel.' : 'Error: Reached max turns (1)');
`;

test('a short Claude Code call leaves no session folder of its own under ~/.claude/projects, and touches no other', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-trace-test-'));
  const before = process.env.CLAUDE_CONFIG_DIR;
  try {
    const config = path.join(root, 'claude-config');
    const own = path.join(config, 'projects', 'C--Users-iemand-Projecten-iets');
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, 'eigen.jsonl'), '{}\n');
    process.env.CLAUDE_CONFIG_DIR = config;
    const left = () => fs.readdirSync(path.join(config, 'projects')).sort();
    for (const flag of [true, false]) {
      const bin = path.join(root, `claude-${flag ? 'nieuw' : 'oud'}.mjs`);
      fs.writeFileSync(bin, FAKE(flag));
      assert.equal(await cliComplete(defById('claude-code')!, bin, { system: 'Je schrijft profielen.', prompt: 'Maak een profiel.' }), 'Een profiel.');
      assert.deepEqual(left(), ['C--Users-iemand-Projecten-iets'], `${flag ? 'with' : 'without'} --no-session-persistence: nothing of the call is left`);
    }
    assert.ok(fs.existsSync(path.join(own, 'eigen.jsonl')), 'the user\'s own sessions stay');
    // An older Claude Code without --tools: "max turns" is an error with a reason, never read as the answer.
    const old = path.join(root, 'claude-zonder-tools.mjs');
    fs.writeFileSync(old, FAKE(true).replace('--tools <tools...>', '--other'));
    await assert.rejects(cliComplete(defById('claude-code')!, old, { system: 's', prompt: 'p' }), /gaf geen antwoord: het model wilde eerst een tool gebruiken/);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
