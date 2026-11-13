import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { tarGz } from './runtime-fixture.js';

/** A PC without Node, npm or uv (tests of server/core/runtimes.ts and of Apps), and a local stand-in for downloads. */

export const isWin = process.platform === 'win32';
/** A PATH without Node, npm or uv: only the system folders (cmd.exe / sh stay reachable). */
export function bareSystemPath(): string {
  const dirs = isWin ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'), process.env.SystemRoot || 'C:\\Windows'] : ['/usr/bin', '/bin'];
  return dirs.filter((d) => !['node', 'npx', 'uvx'].some((c) => fs.existsSync(path.join(d, c + (isWin ? '.exe' : ''))) || fs.existsSync(path.join(d, c + '.cmd')))).join(path.delimiter);
}

export async function withPath<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const old = process.env[key];
  process.env[key] = value;
  try {
    return await fn();
  } finally {
    process.env[key] = old;
  }
}

/** A stand-in for the npm package: npx runs a package's program with `node` from PATH, like the real npm does. */
export function fakeNpm(): Buffer {
  const npx = `const { spawn } = require('child_process');
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('npx-fixture'); process.exit(0); }
// "npx -y <pkg> <args…>": the fixture runs <args…> with node (found on PATH: TeamBot's launcher).
const args = a.filter((x, i) => !(i === 0 && x === '-y')).slice(1);
const child = spawn('node', args.map((x) => (/\\s/.test(x) ? '"' + x + '"' : x)), { stdio: 'inherit', shell: process.platform === 'win32' });
child.on('exit', (c) => process.exit(c == null ? 1 : c));
`;
  return tarGz([
    { name: 'package/package.json', data: JSON.stringify({ name: 'npm', version: '0.0.1-fixture' }) },
    { name: 'package/bin/npx-cli.js', data: npx },
    { name: 'package/bin/npm-cli.js', data: "console.log('npm-fixture ' + (process.env.npm_config_prefix ? 'prefix-set' : 'no-prefix'));" },
  ]);
}

export async function serve(files: Record<string, Buffer>) {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const p = new URL(req.url || '/', 'http://x').pathname;
    hits.push(p);
    const b = files[p];
    if (!b) return res.writeHead(404).end();
    res.writeHead(200, { 'content-length': String(b.length) }).end(b);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, hits, close: () => new Promise<void>((r) => server.close(() => r())) };
}

