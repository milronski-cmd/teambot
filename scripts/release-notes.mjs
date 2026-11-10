#!/usr/bin/env node
// Release notes for one version: the "## [<version>]" section of CHANGELOG.md, printed to stdout (Markdown).
// The release workflow uses it as the body of the GitHub release; electron-updater shows that body as the update's notes.
// Usage: node scripts/release-notes.mjs [version]   (default: version in package.json); exit 1 when there is no section.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2] || JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const lines = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').split(/\r?\n/);
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
if (start < 0) {
  console.error(`CHANGELOG.md heeft geen sectie "## [${version}]"`);
  process.exit(1);
}
const end = lines.findIndex((l, i) => i > start && /^## \[/.test(l));
const body = lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
if (!body) {
  console.error(`De sectie "## [${version}]" in CHANGELOG.md is leeg`);
  process.exit(1);
}
process.stdout.write(`# TeamBot ${version}\n\n${body}\n`);
