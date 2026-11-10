import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { cardPath, codexCommand, commandWriteTargets, unwrapShell } from '../server/modules/cli-agents/permissions.js';
import { defById, opencodeDataDir } from '../server/modules/cli-agents/catalog.js';
import { approvalAction } from '../shared/approvalLabels.js';
import { changeLines, codexRefusedNote, SANDBOX_REFUSED, SANDBOX_SURE } from '../server/modules/cli-agents/codex.js';
import { titleFacts } from '../server/modules/seen/index.js';

test('Codex writing a file with a command: the card says "een bestand schrijven" and names the file', () => {
  const ps = '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Set-Content -Path planten.txt -Value \'planten\'"';
  assert.equal(unwrapShell(ps), "Set-Content -Path planten.txt -Value 'planten'");
  assert.deepEqual(commandWriteTargets(ps), ['planten.txt']);
  assert.deepEqual(commandWriteTargets("Set-Content -Value 'x' -Path 'notities/kat.txt'"), ['notities/kat.txt']);
  assert.deepEqual(commandWriteTargets("'hallo' | Out-File -FilePath groet.txt -Encoding utf8"), ['groet.txt']);
  assert.deepEqual(commandWriteTargets('New-Item -Path leeg.txt -ItemType File'), ['leeg.txt']);
  assert.deepEqual(commandWriteTargets("bash -lc 'echo planten > planten.txt'"), ['planten.txt']);
  assert.deepEqual(commandWriteTargets('printf "a\\nb" >> lijst.md'), ['lijst.md']);
  // Anything more than writing a file stays "een opdracht".
  assert.equal(commandWriteTargets('Set-Content a.txt x; Remove-Item b.txt'), null);
  assert.equal(commandWriteTargets('npm test > uit.txt'), null);
  assert.equal(commandWriteTargets('New-Item -Path map -ItemType Directory'), null);
  assert.equal(commandWriteTargets('echo $(whoami) > a.txt'), null);
  assert.equal(commandWriteTargets('git status'), null);

  const card = approvalAction({ tool: 'codex-cli:bestand-schrijven', risk: 'write' });
  assert.equal(card.verb, 'wil een bestand schrijven');
  assert.equal(card.badge, 'Bestand');
  assert.match(card.text, /Codex schrijft dit bestand/);
  assert.equal(approvalAction({ tool: 'codex-cli:opdracht', risk: 'exec' }).verb, 'wil een opdracht uitvoeren');
});

test('Codex on Windows reports a command in Rust debug notation: read back to the command that ran (round 5, B-46)', () => {
  // Exactly as Codex 0.167 sent it for a refused write in the team folder (each backslash doubled in quoted parts).
  const raw = String.raw`"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -Command "Set-Content -LiteralPath 'C:\\Users\\eigenaar\\AppData\\Local\\Temp\\teammap\\ps-r5.txt' -Value 'via powershell'"`;
  const cmd = codexCommand(raw);
  assert.equal(cmd, String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "Set-Content -LiteralPath 'C:\Users\eigenaar\AppData\Local\Temp\teammap\ps-r5.txt' -Value 'via powershell'"`);
  assert.equal(unwrapShell(cmd), String.raw`Set-Content -LiteralPath 'C:\Users\eigenaar\AppData\Local\Temp\teammap\ps-r5.txt' -Value 'via powershell'`);
  assert.deepEqual(commandWriteTargets(cmd), [String.raw`C:\Users\eigenaar\AppData\Local\Temp\teammap\ps-r5.txt`]);
  assert.ok(!/\\\\/.test(cardPath(commandWriteTargets(cmd)![0], String.raw`C:\tb\data\workspaces\ag_1`)), 'the step names the file with single backslashes');
  // Plain commands stay exactly as they are: single backslashes, also ones that look like an escape.
  for (const plain of [String.raw`type "C:\Users\x\notities.txt"`, String.raw`dir "C:\new\test"`, 'npm test', String.raw`type C:\\x\\a.txt`]) {
    assert.equal(codexCommand(plain), plain, plain);
  }
  assert.equal(codexCommand(String.raw`type "\\\\server\\share\\a.txt"`), String.raw`type "\\server\share\a.txt"`, 'a network path in debug notation');
  assert.equal(codexCommand(undefined), '');
  // The files a change touched, in words (not Codex's add/update/delete).
  assert.equal(changeLines([{ path: 'a.txt', kind: { type: 'add' } }, { path: 'b.md', kind: { type: 'update' } }, { path: 'c.py', kind: 'delete' }]), 'nieuw: a.txt\ngewijzigd: b.md\nverwijderd: c.py');
  assert.deepEqual(titleFacts({ kind: 'files', title: 'Bestanden gewijzigd', detail: 'nieuw: /w/a.txt\nverwijderd: /w/c.py', ts: '' }), [{ op: 'write', target: '/w/a.txt' }, { op: 'delete', target: '/w/c.py' }]);
});

test('Codex sandbox refusals: what counts as refused (B-46), and the note the turn gets', () => {
  assert.ok(SANDBOX_SURE.test("Set-Content: Access to the path 'C:\\w\\notities.txt' is denied."));
  assert.ok(SANDBOX_SURE.test("Set-Content : Toegang tot het pad C:\\w\\notities.txt is geweigerd."));
  assert.ok(SANDBOX_SURE.test('bash: notities.txt: Read-only file system'));
  // A generic "permission denied" (git push without a key) only counts together with a write command.
  assert.ok(SANDBOX_REFUSED.test('git@github.com: Permission denied (publickey).'));
  assert.ok(!SANDBOX_SURE.test('git@github.com: Permission denied (publickey).'));
  const note = codexRefusedNote(['notities.txt'], 'Set-Content -Path notities.txt -Value hallo');
  assert.match(note, /^TeamBot: je terminalopdracht om notities\.txt te schrijven is geweigerd door de alleen-lezen sandbox; .*apply_patch.*goedkeuringskaart/);
  assert.match(codexRefusedNote([], 'python -c "open(\'a\',\'w\')"'), /je terminalopdracht \(python -c/);
});

test('OpenCode login status follows XDG_DATA_HOME (never the owner\'s own folder when it is set)', () => {
  assert.equal(opencodeDataDir({ XDG_DATA_HOME: path.join(os.tmpdir(), 'xdg') } as any), path.join(os.tmpdir(), 'xdg', 'opencode'));
  assert.equal(opencodeDataDir({} as any), path.join(os.homedir(), '.local', 'share', 'opencode'));
  const auth = defById('opencode')!.auth as { kind: 'files'; files: () => string[] };
  const old = process.env.XDG_DATA_HOME;
  try {
    process.env.XDG_DATA_HOME = path.join(os.tmpdir(), 'tb-xdg-test');
    assert.ok(auth.files().every((f) => f.startsWith(path.join(os.tmpdir(), 'tb-xdg-test', 'opencode'))), auth.files().join(', '));
  } finally {
    if (old === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = old;
  }
});
