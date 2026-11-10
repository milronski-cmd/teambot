// Accent colours (PARITEIT 18.2, Instellingen › Uiterlijk › Kleur): every palette passes WCAG AA in light and in dark,
// "Standaard" is exactly the look of styles.css, the generated CSS only carries known values, the choice is stored per
// user (also from the paired phone).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ACCENTS, DEFAULT_ACCENT, NEUTRALS, STANDARD_LOGO, accentById, accentCss, accentOfSettings, cleanAccent, contrast, contrastPairs, luminance, previewVars, type Mode } from '../shared/accent.js';
import { startTestApp } from './helpers.js';

const MODES: Mode[] = ['light', 'dark'];
const HEX = /^#[0-9a-f]{6}$/i;

/** The custom properties of one CSS block of styles.css (`@theme {` or `.dark {`). */
function cssBlock(css: string, opener: string): Record<string, string> {
  const at = css.indexOf(opener);
  assert.ok(at >= 0, `styles.css has ${opener}`);
  const body = css.slice(at + opener.length, css.indexOf('}', at));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--color-([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]] = m[2].toLowerCase();
  return out;
}
const styles = fs.readFileSync(path.join(process.cwd(), 'ui', 'src', 'styles.css'), 'utf8');
const CSS = { light: cssBlock(styles, '@theme {'), dark: cssBlock(styles, '\n.dark {') };

test('WCAG contrast helper: known values', () => {
  assert.equal(Math.round(contrast('#000000', '#ffffff') * 100) / 100, 21);
  assert.equal(contrast('#777777', '#777777'), 1);
  assert.equal(Math.round(contrast('#767676', '#ffffff') * 100) / 100, 4.54, 'the classic AA grey on white');
  assert.ok(Math.abs(luminance('#ffffff') - 1) < 1e-9);
  assert.throws(() => luminance('red'));
});

test('about ten colours to choose from, lavender among them, Standaard first; ids and names unique, all #rrggbb', () => {
  assert.equal(ACCENTS[0].id, DEFAULT_ACCENT);
  assert.ok(ACCENTS.length - 1 >= 10, `${ACCENTS.length - 1} colours besides Standaard`);
  assert.ok(ACCENTS.some((a) => a.id === 'lavender' && a.label === 'Lavendel'));
  assert.equal(new Set(ACCENTS.map((a) => a.id)).size, ACCENTS.length);
  assert.equal(new Set(ACCENTS.map((a) => a.label)).size, ACCENTS.length);
  for (const a of ACCENTS) {
    assert.match(a.id, /^[a-z]+$/);
    assert.match(a.logo, HEX, `${a.id} logo`);
    for (const m of MODES) for (const [k, v] of Object.entries(a[m])) assert.match(v, HEX, `${a.id} ${m} ${k}`);
  }
});

test('every palette × light/dark passes WCAG AA: text 4.5:1, focus ring 3:1 (computed, not eyeballed)', () => {
  const failures: string[] = [];
  let pairs = 0;
  for (const a of ACCENTS)
    for (const m of MODES)
      for (const p of contrastPairs(a.id, m)) {
        pairs++;
        const c = contrast(p.fg, p.bg);
        if (c < p.min) failures.push(`${a.id}/${m}: ${p.what} ${p.fg} on ${p.bg} = ${c.toFixed(2)} < ${p.min}`);
      }
  assert.deepEqual(failures, []);
  assert.equal(pairs, ACCENTS.length * 2 * 13, 'every pair was checked');
});

test('Standaard is exactly the look of styles.css (the default does not change), and NEUTRALS mirror styles.css', () => {
  const std = accentById(DEFAULT_ACCENT);
  for (const m of MODES) {
    assert.equal(std[m].accent, CSS[m].accent, `${m} accent`);
    assert.equal(std[m].accentSoft, CSS[m]['accent-soft'], `${m} accent-soft`);
    assert.equal(std[m].accentFg, CSS[m]['accent-fg'], `${m} accent-fg`);
    assert.equal(std[m].ring, CSS[m].fg, `${m}: the ring stays the text colour`);
    for (const [k, v] of Object.entries(NEUTRALS[m])) assert.equal(v, CSS[m][k], `${m} ${k}`);
  }
  assert.equal(std.logo, STANDARD_LOGO);
  // The focus ring falls back to the text colour when no accent sets one.
  assert.match(styles, /:focus-visible\s*\{\s*outline:\s*2px solid var\(--color-ring, var\(--color-fg\)\);/);
  // No rule for Standaard: without data-accent nothing is overridden.
  assert.doesNotMatch(accentCss(), /standard/);
});

test('generated CSS: one light and one dark rule per colour with exactly its own values', () => {
  const css = accentCss();
  for (const a of ACCENTS.filter((x) => x.id !== DEFAULT_ACCENT)) {
    for (const [m, sel] of [
      ['light', `:root[data-accent="${a.id}"]{`],
      ['dark', `:root.dark[data-accent="${a.id}"]{`],
    ] as const) {
      const at = css.indexOf(sel);
      assert.ok(at >= 0, `${a.id} ${m} rule`);
      const body = css.slice(at + sel.length, css.indexOf('}', at));
      const t = a[m];
      assert.equal(body, `--color-accent:${t.accent};--color-accent-soft:${t.accentSoft};--color-accent-fg:${t.accentFg};--color-btn:${t.accent};--color-btn-fg:${t.accentFg};--color-ring:${t.ring}`);
    }
  }
  assert.equal(css.split('\n').length, (ACCENTS.length - 1) * 2);
});

test('a stored value only becomes a known colour (anything else is Standaard)', () => {
  assert.equal(cleanAccent('lavender'), 'lavender');
  for (const bad of [undefined, null, '', 'Lavender', 'lavender"]{}', '#ff0000', 42, {}, 'toString', '__proto__']) assert.equal(cleanAccent(bad), DEFAULT_ACCENT, String(bad));
  assert.equal(accentOfSettings({ ui: { accent: 'teal' } }), 'teal');
  assert.equal(accentOfSettings({}), DEFAULT_ACCENT);
  assert.equal(accentOfSettings(null), DEFAULT_ACCENT);
  assert.equal(accentById('nope').id, DEFAULT_ACCENT);
});

test('preview panels get every neutral and accent token of their own mode', () => {
  for (const m of MODES) {
    const v = previewVars('lavender', m);
    assert.equal(v.colorScheme, m);
    for (const [k, val] of Object.entries(NEUTRALS[m])) assert.equal(v[`--color-${k}`], val);
    assert.equal(v['--color-accent'], accentById('lavender')[m].accent);
    assert.equal(v['--color-accent-soft'], accentById('lavender')[m].accentSoft);
    assert.equal(v['--color-accent-fg'], accentById('lavender')[m].accentFg);
    assert.equal(v['--color-ring'], accentById('lavender')[m].ring);
  }
});

test('the colour is stored per user with the other settings, and the paired phone reads and changes the same one', async () => {
  const t = await startTestApp({ modules: undefined });
  try {
    const before = await t.api('GET', '/settings');
    assert.equal(accentOfSettings(before), DEFAULT_ACCENT, 'nobody chose: Standaard');
    await t.api('PUT', '/settings', { ui: { botStyle: 'felt', accent: 'lavender' } });
    const s = await t.api('GET', '/settings');
    assert.equal(s.ui.accent, 'lavender');
    assert.equal(s.ui.botStyle, 'felt', 'next to the other look settings');

    // The phone: a real pairing (QR ticket claimed like the iPhone app does), its own device session.
    const ticket = await t.api('POST', '/mobile/pair', { baseUrl: 'http://192.168.1.5:4748' });
    const secret = new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('t');
    const claim = await fetch(`${t.app.url}/api/public/mobile/claim`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (iPhone) TeamBotiOS/0.4.3' }, body: JSON.stringify({ secret, name: 'iPhone', platform: 'ios', client: 'ios-app' }) });
    assert.equal(claim.status, 200);
    const phone = ((await claim.json()) as any).token as string;
    const asPhone = async (method: string, p: string, body?: any) => {
      const r = await fetch(`${t.app.url}/api${p}`, { method, headers: { authorization: `Bearer ${phone}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: (await r.json()) as any };
    };
    assert.equal((await asPhone('GET', '/me')).body.session?.kind, 'device');
    assert.equal(accentOfSettings((await asPhone('GET', '/settings')).body), 'lavender', 'the phone shows the colour chosen on the computer');
    const put = await asPhone('PUT', '/settings', { ui: { ...s.ui, accent: 'teal' } });
    assert.equal(put.status, 200, 'the phone may change it');
    assert.equal(accentOfSettings(await t.api('GET', '/settings')), 'teal', 'and the computer follows');
  } finally {
    await t.close();
  }
});

test('another user on a shared server keeps their own colour', async () => {
  const t = await startTestApp({ modules: [], mode: 'server' });
  try {
    const m = t.app.ctx.auth.createUser({ name: 'Vriend', email: 'vriend@test.local', password: 'geheim1234', role: 'member' });
    const tok = t.app.ctx.auth.createSession(m.id, 'web', 'x').token;
    const as = async (method: string, p: string, body?: any) => (await fetch(`${t.app.url}/api${p}`, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json() as Promise<any>;
    await t.api('PUT', '/settings', { ui: { accent: 'gold' } });
    await as('PUT', '/settings', { ui: { accent: 'grape' } });
    assert.equal(accentOfSettings(await t.api('GET', '/settings')), 'gold');
    assert.equal(accentOfSettings(await as('GET', '/settings')), 'grape');
  } finally {
    await t.close();
  }
});
