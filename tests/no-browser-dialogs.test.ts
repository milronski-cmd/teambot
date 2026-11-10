import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/** Confirmations use the app's own dialog (askConfirm, role="alertdialog"), never the browser's confirm/alert/prompt. */
test('the interface never calls window.confirm, alert or prompt', () => {
  const root = path.resolve(import.meta.dirname, '..', 'ui', 'src');
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx?|jsx?)$/.test(e.name)) {
        fs.readFileSync(p, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
            if (/(^|[^.\w])(window\.)?(confirm|alert)\(|window\.prompt\(/.test(code)) hits.push(`${path.relative(root, p)}:${i + 1}: ${line.trim().slice(0, 120)}`);
          });
      }
    }
  };
  walk(root);
  assert.deepEqual(hits, []);
});
