import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A new bot arrives twice in the interface: from the API answer and from the live "agent.updated" event. Appending
 * it blindly (`[...s.agents, a]`) showed a duplicated bot up to three times in the sidebar and made the bot search
 * show bots that did not match (React reused rows with the same key). Every add must go through upsert or a filter.
 */
test('the interface never appends a bot to the list without removing an existing copy first', () => {
  const root = path.resolve(import.meta.dirname, '..', 'ui', 'src');
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name))
        fs.readFileSync(p, 'utf8')
          .split('\n')
          .forEach((line, i) => /agents:\s*\[\s*\.\.\.(s|st|state)\.agents\s*,/.test(line) && hits.push(`${path.relative(root, p)}:${i + 1}`));
    }
  };
  walk(root);
  assert.deepEqual(hits, []);
});
