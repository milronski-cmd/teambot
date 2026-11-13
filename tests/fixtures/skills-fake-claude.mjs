#!/usr/bin/env node
// The fake "claude" CLI of the tests (cli-agents-fake-claude.mjs) as a Claude Code that loads skill folders itself:
// its --help also names --plugin-dir and skills, as Claude Code 2.1 does. For a run it writes down which skills it would
// find (the plugin folder it was started with and `.claude/skills` in its working folder), then acts like the fake.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli-agents-fake-claude.mjs');
const argv = process.argv.slice(2);

if (argv[0] === '--help') {
  const r = spawnSync(process.execPath, [fake, '--help'], { encoding: 'utf8' });
  console.log(`${r.stdout}  --plugin-dir <path>          Load a plugin from a directory for this session only\n  --disable-slash-commands     Disable all skills and commands`);
  process.exit(0);
}

const skillsIn = (dir) => {
  try {
    return Object.fromEntries(
      fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md')))
        .map((e) => [e.name, fs.readFileSync(path.join(dir, e.name, 'SKILL.md'), 'utf8')]),
    );
  } catch {
    return {};
  }
};
if (argv.includes('-p') && process.env.FAKE_CLI_LOG) {
  const plugin = argv.includes('--plugin-dir') ? argv[argv.indexOf('--plugin-dir') + 1] : null;
  fs.appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ cli: 'claude', skills: true, plugin: plugin ? skillsIn(path.join(plugin, 'skills')) : null, folder: skillsIn(path.join(process.cwd(), '.claude', 'skills')) }) + '\n');
}
const child = spawn(process.execPath, [fake, ...argv], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
