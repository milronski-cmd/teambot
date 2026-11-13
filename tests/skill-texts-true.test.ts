import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SKILL_PLACES } from '../server/modules/skills/workspace.js';

/**
 * Mijn skills says what really happens (ui/src/modules/skills/MySkills.tsx): where a skill's folders are in a bot's
 * work folder (server/modules/skills/workspace.ts), when a bot asks before a script runs (the bot's access level,
 * tools/gate.ts), and what choosing bots does (PUT /skills/:id/agents takes the skill from the bots left out).
 */
const src = fs.readFileSync('ui/src/modules/skills/MySkills.tsx', 'utf8');

test('delete dialog and Veiligheid name the folders the skills really live in', () => {
  for (const place of SKILL_PLACES) assert.ok(src.includes(`${place}/{s.name}`), `names ${place}`);
  assert.ok(!src.includes('.skills/{s.name}'), 'the old .skills/<naam> folder is gone');
});

test('Veiligheid does not promise a question for every script: that depends on the access level', () => {
  assert.ok(!/vraagt de bot bij elk script om jouw toestemming/.test(src));
  assert.match(src, /Volledige toegang/);
  assert.match(src, /Vraagt toestemming/);
});

test('choosing bots does not claim the skill goes "vooraan in hun instructies"', () => {
  assert.ok(!/vooraan in hun instructies/.test(src));
  assert.match(src, /kan die bot de skill niet meer laden/);
});
