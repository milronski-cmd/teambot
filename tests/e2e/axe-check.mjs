// axe-core (WCAG 2.x A/AA, as tests/e2e/a11y.mjs) on what a page shows right now, for screens that a11y.mjs does not
// open (a dialog, a filled list). The browser context needs `bypassCSP: true`. Returns the serious and critical rules.
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

/**
 * Wait until every running transition or animation that ends has ended. Contrast is measured on what stays on screen:
 * a button that just became enabled fades from 45 % to full in 150 ms and measured half-way it fails (2.6:1).
 * Spinners and loading placeholders run forever and are left alone.
 */
export async function settled(page) {
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime)).map((a) => a.finished.catch(() => {}))));
}

export async function axeCheck(page) {
  if (!(await page.evaluate(() => !!window.axe))) await page.addScriptTag({ content: axeSource });
  await settled(page);
  return page.evaluate(async () => {
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
    return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length}): ${v.nodes[0]?.target?.join(' ')}`);
  });
}
