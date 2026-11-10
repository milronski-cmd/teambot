#!/usr/bin/env node
// Fake Claude Code / Codex / OpenCode for the engine-version tests (tests/engine-versions.test.ts). Copied next to a
// config file "<this file>.json": { kind, version, drop: [flags missing from --help], handshake: "ok"|"crash"|"bad",
// log }. The test "updates" the CLI by rewriting that file. Every start is logged, so the test can prove that TeamBot
// never installed, upgraded or downgraded anything and never sent a prompt.
import fs from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const cfg = JSON.parse(fs.readFileSync(self + '.json', 'utf8'));
const argv = process.argv.slice(2);
if (cfg.log) fs.appendFileSync(cfg.log, JSON.stringify({ kind: cfg.kind, argv }) + '\n');
const drop = new Set(cfg.drop || []);
const help = (flags) => flags.filter((f) => !drop.has(f.split(' ')[0])).map((f) => `  ${f}`).join('\n');

if (argv[0] === '--version') {
  console.log(cfg.kind === 'claude' ? `${cfg.version} (Claude Code)` : cfg.kind === 'codex' ? `codex-cli ${cfg.version}` : `opencode v${cfg.version}`);
  process.exit(0);
}

if (cfg.kind === 'claude') {
  if (argv[0] === '--help') {
    console.log(
      'Usage: claude [options] [command] [prompt]\n' +
        help([
          '-p, --print                       Print response and exit',
          '--output-format <format>          "text", "json", or "stream-json" (choices: "text", "json", "stream-json")',
          '--verbose                         Verbose',
          '--resume <id>                     Resume a conversation',
          '--permission-mode <mode>          (choices: "acceptEdits", "default", "plan")',
          '--mcp-config <configs...>         Load MCP servers',
          '--strict-mcp-config               Only use MCP servers from --mcp-config',
          '--permission-prompt-tool <tool>   MCP tool for permission prompts',
          '--allowedTools <tools...>         Allowed tools',
          '--disallowedTools <tools...>      Denied tools',
          '--append-system-prompt-file <f>   Append a system prompt from a file',
          '--restricted                      Restricted mode',
          '--include-partial-messages        Partial messages',
          '--permission-prompts <target>     "host" or "none"',
          '--tools <tools...>                Built-in tools',
        ]),
    );
    process.exit(0);
  }
  if (argv[0] === 'auth' && argv[1] === 'status') {
    console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }));
    process.exit(0);
  }
  process.stderr.write('fake claude: only --version, --help and auth status\n');
  process.exit(2);
}

if (cfg.kind === 'codex') {
  if (argv[0] === 'login' && argv[1] === 'status') {
    console.log('Logged in using ChatGPT');
    process.exit(0);
  }
  if (argv[0] === 'exec' && argv[1] === '--help') {
    console.log('Run Codex non-interactively\n' + help(['--json  Print events as JSONL', '--sandbox <MODE>  Sandbox policy', '--skip-git-repo-check  Allow outside a git repo', '-C, --cd <DIR>  Working root']));
    process.exit(0);
  }
  if (argv[0] === 'app-server') {
    if (cfg.handshake === 'crash') {
      process.stderr.write('Error: unknown subcommand app-server\n');
      process.exit(3);
    }
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (l) => {
      let m;
      try {
        m = JSON.parse(l);
      } catch {
        return;
      }
      if (m.method === 'initialize') process.stdout.write(JSON.stringify({ id: m.id, result: cfg.handshake === 'bad' ? null : { userAgent: 'fake-codex', platformOs: 'windows' } }) + '\n');
    });
    rl.on('close', () => process.exit(0));
  } else {
    process.stderr.write('fake codex: only --version, login status, exec --help and app-server\n');
    process.exit(2);
  }
}

if (cfg.kind === 'opencode') {
  if (argv[0] === 'acp') {
    if (cfg.handshake === 'crash') {
      process.stderr.write('Error: unknown command "acp"\n');
      process.exit(1);
    }
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (l) => {
      let m;
      try {
        m = JSON.parse(l);
      } catch {
        return;
      }
      if (m.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: cfg.handshake === 'bad' ? { hello: 1 } : { protocolVersion: 1, agentCapabilities: { loadSession: true } } }) + '\n');
    });
    rl.on('close', () => process.exit(0));
  } else {
    process.stderr.write('fake opencode: only --version and acp\n');
    process.exit(2);
  }
}
