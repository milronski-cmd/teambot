// npm run website:dev — builds the site, serves website/dist on http://127.0.0.1:4800 and rebuilds when
// website/src, website/build.mjs or docs/HANDLEIDING.md change. Runs until stopped (Ctrl+C).
// Options: --port 4800   --for 600 (stop by itself after 600 s; handy for scripts and background runs)
//          --no-watch    (serve only, no rebuilds)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const dist = path.join(here, 'dist');
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : def;
};
const port = Number(arg('--port', process.env.PORT || 4800));
const stopAfter = Number(arg('--for', 0));
const watch = !process.argv.includes('--no-watch');

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' };

function runBuild() {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--import', 'tsx', path.join(here, 'build.mjs')], { cwd: repo, stdio: 'inherit' });
    const t = setTimeout(() => p.kill(), 60_000);
    p.on('exit', (code) => {
      clearTimeout(t);
      resolve(code === 0);
    });
  });
}

/** Static file server for dist/ (also used by website/check.mjs). Never serves anything outside dist/. */
export function createServer(root = dist) {
  return http.createServer((req, res) => {
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    let file = path.join(root, rel);
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Niet gevonden');
        return;
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!(await runBuild())) process.exitCode = 1;
  const server = createServer();
  server.listen(port, '127.0.0.1', () => console.log(`website: http://127.0.0.1:${port}/  (Ctrl+C stopt${stopAfter ? `; stopt zelf na ${stopAfter} s` : ''})`));
  if (watch) {
    let timer = null;
    let busy = false;
    const rebuild = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (busy) return rebuild();
        busy = true;
        await runBuild();
        busy = false;
      }, 200);
    };
    for (const p of [path.join(here, 'src'), path.join(here, 'build.mjs'), path.join(repo, 'docs/HANDLEIDING.md')]) {
      try {
        fs.watch(p, { recursive: fs.statSync(p).isDirectory() }, rebuild);
      } catch (e) {
        console.warn('website: kan niet volgen:', p, e.message);
      }
    }
  }
  if (stopAfter > 0)
    setTimeout(() => {
      console.log('website: gestopt (--for)');
      process.exit(0);
    }, stopAfter * 1000);
}
