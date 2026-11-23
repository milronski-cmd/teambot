// Verbruik in plain words (4.17.0). Seen with a real team: "Week · Overage Included" in Claude's own English, and
// no word on whether extra usage costs money; a paid key showed only "this week".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestApp } from './helpers.js';
import { claudeWindowLabel } from '../server/modules/usage/parse.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('a Claude window is named in words, also when an older version stored its English name; the note says what extra usage costs; a key shows this month', async () => {
  assert.equal(claudeWindowLabel('seven_day_overage_included'), 'Week · inclusief extra gebruik');
  assert.equal(claudeWindowLabel('seven_day_fable'), 'Week · Fable');
  const t = await startTestApp();
  try {
    const cc = await t.api('POST', '/providers', { kind: 'claude-code', config: { path: path.join(here, 'fixtures', 'cli-agents-fake-claude.mjs') } });
    const now = Date.now();
    // What an older version stored: Claude's English name and the old note.
    t.app.ctx.services.usage.report(cc.id, {
      windows: [{ id: 'seven_day_overage_included', label: 'Week · Overage Included', usedPercent: 100, resetsAt: now + 3600_000, level: 'limit', at: now }],
      note: 'Extra gebruik (overage) staat uit: bij de limiet stopt Claude tot de reset.',
      source: 'usage-command',
      at: now,
    });
    const { engines } = await t.api('GET', '/usage/limits');
    const e = engines.find((x: any) => x.providerId === cc.id);
    assert.equal(e.windows[0].label, 'Week · inclusief extra gebruik');
    assert.equal(e.note, 'Extra gebruik staat uit: je betaalt niets extra. Bij de limiet stopt Claude tot de reset.');
    assert.ok(e.spend.month && typeof e.spend.month.cost === 'number', 'this month is there next to today and this week');
  } finally {
    await t.close();
  }
});
