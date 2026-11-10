// Live check of TeamBot's own CLI copies (C-07) against the real sources. Metadata only by default:
//  - Claude Code and Codex (npm): the pinned version's manifest for this platform, the registry signature with the key
//    pinned in TeamBot, the SHA-512 against TeamBot's own pin, and the newest version;
//  - OpenCode (GitHub releases): the pinned release, its asset for this platform and GitHub's digest against TeamBot's
//    SHA-256 pin, the download address, and the newest stable 2.x.
// With --download opencode it also installs TeamBot's own OpenCode for real into a TEMP data folder (≈120 MB, nothing
// global, removed afterwards) and starts it once with --version.
// Usage: node --import tsx tests/e2e/cli-runtimes-live.mjs [--download opencode]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RUNTIMES, Runtimes, platformKey, verifyRegistrySignature } from '../../server/modules/cli-agents/runtimes.ts';
import { runQuick } from '../../server/modules/cli-agents/proc.ts';

const plat = platformKey();
const results = [];
const ok = (name, cond, detail = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const rt = new Runtimes(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-rt-live-meta-')));
for (const [id, spec] of Object.entries(RUNTIMES)) {
  if (spec.source === 'github') {
    const tag = `v${spec.pinned}`;
    const r = await fetch(`https://api.github.com/repos/${spec.main}/releases/tags/${tag}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'TeamBot-live-check' } });
    const rel = await r.json();
    ok(`${id}: uitgave ${spec.main} ${tag}`, r.ok && rel.tag_name === tag && !rel.draft && !rel.prerelease, `HTTP ${r.status}`);
    const name = spec.asset(plat);
    const a = (rel.assets || []).find((x) => x.name === name);
    ok(`${id}: download voor ${plat} (${name})`, !!a, a ? `${Math.round(a.size / 1e6)} MB` : '');
    ok(`${id}: SHA-256 van GitHub gelijk aan TeamBot's pin`, a?.digest === spec.integrity[plat], a?.digest?.slice(0, 24) + '…');
    ok(`${id}: downloadadres bij de uitgaven van de maker`, String(a?.browser_download_url || '').startsWith(`https://github.com/${spec.main}/releases/download/${tag}/`), a?.browser_download_url);
    const latest = await rt.latest(id, true);
    ok(`${id}: nieuwste stabiele ${spec.line}.x leesbaar`, !!latest && latest.startsWith(`${spec.line}.`), `nieuwste ${latest}, vastgezet ${spec.pinned}`);
    continue;
  }
  const pkg = spec.pkg(plat, spec.pinned);
  const r = await fetch(`https://registry.npmjs.org/${pkg.name.replace('/', '%2f')}/${pkg.version}`, { headers: { accept: 'application/json' } });
  const m = await r.json();
  ok(`${id}: manifest ${pkg.name}@${pkg.version}`, r.ok && m.version === pkg.version, `HTTP ${r.status}`);
  ok(`${id}: npm-handtekening klopt (vastgezette sleutel)`, verifyRegistrySignature(pkg.name, pkg.version, m.dist?.integrity, m.dist?.signatures));
  ok(`${id}: SHA-512 gelijk aan TeamBot's pin`, m.dist?.integrity === spec.integrity[plat], m.dist?.integrity?.slice(0, 24) + '…');
  ok(`${id}: tarball op het register`, new URL(m.dist?.tarball).origin === 'https://registry.npmjs.org', m.dist?.tarball);
  const latest = await rt.latest(id, true);
  ok(`${id}: nieuwste versie leesbaar`, !!latest, `nieuwste ${latest}, vastgezet ${spec.pinned}`);
}

const dl = process.argv.indexOf('--download');
if (dl > 0) {
  const id = process.argv[dl + 1] || 'opencode';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-rt-live-'));
  try {
    const live = new Runtimes(dir);
    const t0 = Date.now();
    let last = '';
    const inst = await live.install(id, null, (p) => {
      const line = `${p.phase}${p.total ? ` ${Math.round(((p.received || 0) / p.total) * 100)}%` : ''}`;
      if (line !== last && (p.phase !== 'download' || /0%$/.test(line))) console.log('  ', line);
      last = line;
    });
    ok(`${id}: echt geïnstalleerd in TEMP`, inst.bin.startsWith(dir), `${inst.version} in ${((Date.now() - t0) / 1000).toFixed(1)} s → ${inst.bin} (${inst.integrity.slice(0, 20)}…)`);
    const v = await runQuick(inst.bin, ['--version'], { timeoutMs: 60_000 });
    ok(`${id}: start met --version`, /\d+\.\d+\.\d+/.test(v.stdout + v.stderr), (v.stdout || v.stderr).trim().slice(0, 80));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} geslaagd`);
process.exit(failed ? 1 : 0);
