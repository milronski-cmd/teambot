#!/usr/bin/env node
// A dummy process tree for the "Alles stoppen" tests (never a real CLI). Every process writes its pid to
// FAKE_TREE_LOG (one JSON line each).
//   proc-tree.mjs root [--mid-exits] [--root-exits]   root → mid → leaf (stays alive unless asked to exit)
//   proc-tree.mjs mid [--exit]                        mid → leaf; --exit: mid leaves, its leaf keeps running (orphan)
//   proc-tree.mjs leaf                                runs until killed
// A process that must outlive its parent is started detached: on Windows, Node (libuv) ends the normal children of a
// Node process when it exits, so a real orphan comes from a detached start (like `Start-Process` or `start /b`).
// Wrapper mode (FAKE_TREE_TARGET = one of the fake CLIs): for a real run (not a --version/login/features probe) it first
// starts a mid that leaves an orphaned leaf behind, then behaves exactly like that fake CLI. FAKE_TREE_HOLD=1 keeps
// the process alive after the fake is done (a CLI that hangs).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(import.meta.url);
const log = (o) => process.env.FAKE_TREE_LOG && fs.appendFileSync(process.env.FAKE_TREE_LOG, JSON.stringify({ ...o, at: Date.now() }) + '\n');
const argv = process.argv.slice(2);
const forever = () => setInterval(() => {}, 1000);
const child = (args, detached = false) => spawn(process.execPath, [here, ...args], { stdio: 'ignore', windowsHide: true, detached, env: process.env });

if (argv[0] === 'leaf') {
  log({ leaf: process.pid, parent: process.ppid });
  forever();
} else if (argv[0] === 'mid') {
  const leaf = child(['leaf'], argv.includes('--exit'));
  log({ mid: process.pid, leafSpawned: leaf.pid });
  if (argv.includes('--exit')) {
    leaf.unref();
    setTimeout(() => process.exit(0), 400);
  } else forever();
} else if (argv[0] === 'root') {
  const mid = child(['mid', ...(argv.includes('--mid-exits') ? ['--exit'] : [])], argv.includes('--root-exits'));
  log({ root: process.pid, midSpawned: mid.pid });
  process.stdout.write('ready\n');
  if (argv.includes('--root-exits')) {
    mid.unref();
    setTimeout(() => process.exit(0), 900);
  } else forever();
} else {
  const target = process.env.FAKE_TREE_TARGET;
  const probe = argv.some((a) => ['--version', '-v', '--help', '-h', 'auth', 'login', 'status', 'features', 'sandbox', 'models', '-o', 'mcp'].includes(a));
  if (!probe) {
    const mid = child(['mid', '--exit']);
    log({ root: process.pid, midSpawned: mid.pid, argv });
    if (process.env.FAKE_TREE_HOLD === '1') forever();
    else mid.unref();
  }
  if (target) await import(pathToFileURL(target).href);
}
