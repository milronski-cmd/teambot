import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COLORS, EXTRAS, EYES, MOODS, MOUTHS, SHAPES, botSvg, cleanTraits, encodeFace, isImageAvatar, parseFace, randomTraits, traitsFor } from '../shared/botface.js';

// The bot characters (ui/src/lib/botface.ts) are drawn from stored traits. Avatars of other people's bots reach the
// UI through groups and shared bots and are injected as SVG markup, so the generator must only ever emit whitelisted
// values and computed numbers.

test('the same seed gives the same face; different seeds vary', () => {
  assert.deepEqual(traitsFor('agt_123'), traitsFor('agt_123'));
  assert.equal(botSvg('agt_123', { uid: 'a' }), botSvg('agt_123', { uid: 'a' }));
  const seen = new Set(Array.from({ length: 40 }, (_, i) => JSON.stringify(traitsFor('agt_' + i))));
  assert.ok(seen.size > 30, `only ${seen.size} different faces for 40 bots`);
});

test('stored traits override the generated ones and survive a round trip', () => {
  const t = { shape: 'ghost', color: 'pink', eyes: 'visor', mouth: 'cat', extra: 'crown', cheeks: false } as const;
  const enc = encodeFace(t);
  assert.ok(enc.startsWith('face:'));
  assert.deepEqual(parseFace(enc), t);
  assert.deepEqual(traitsFor('whatever', parseFace(enc)!), t);
  assert.equal(parseFace('🤖'), null, 'an old emoji avatar is not a face');
  assert.deepEqual(parseFace('face:{"shape":"gh'), {}, 'a truncated face falls back to the generated one');
});

test('unknown or hostile trait values are dropped, never reach the SVG', () => {
  const evil = '"/><img src=x onerror=alert(1)><x a="';
  const parsed = parseFace('face:' + JSON.stringify({ shape: evil, color: evil, eyes: evil, mouth: evil, extra: evil, cheeks: 'yes', x: 1 }));
  assert.deepEqual(parsed, {});
  assert.deepEqual(cleanTraits({ color: '#12ab9F' }), { color: '#12ab9F' });
  assert.deepEqual(cleanTraits({ color: 'red; background:url(x)' }), {});
  const svg = botSvg(evil, { traits: { color: evil as any, shape: evil as any }, uid: evil, mood: evil as any, style: evil as any });
  assert.ok(!/<img|<script|<foreignObject|\son[a-z]+\s*=|javascript:/i.test(svg), 'no injected markup or event handlers');
  const tags = new Set([...svg.matchAll(/<([a-zA-Z]+)/g)].map((m) => m[1]));
  const allowed = new Set(['svg', 'defs', 'radialGradient', 'stop', 'filter', 'feGaussianBlur', 'feTurbulence', 'feDisplacementMap', 'feColorMatrix', 'feComposite', 'feMerge', 'feMergeNode', 'clipPath', 'path', 'ellipse', 'circle', 'rect', 'g', 'text']);
  for (const t of tags) assert.ok(allowed.has(t), `unexpected element <${t}>`);
  // ids are reduced to [A-Za-z0-9]
  for (const m of svg.matchAll(/id="([^"]+)"/g)) assert.match(m[1], /^[A-Za-z0-9]+$/);
});

test('every combination of traits and moods renders a well-formed SVG with unique ids per instance', () => {
  const svgs: string[] = [];
  for (const shape of SHAPES)
    for (const eyes of EYES)
      for (const mood of MOODS) {
        const s = botSvg('x', { traits: { shape, eyes, mouth: MOUTHS[0], color: COLORS[0], extra: EXTRAS[1] }, mood, uid: `${shape}${eyes}${mood}`, style: mood === 'done' ? 'felt' : 'clay' });
        assert.ok(s.startsWith('<svg') && s.endsWith('</svg>'));
        assert.ok(!/NaN|undefined/.test(s), `${shape}/${eyes}/${mood}`);
        svgs.push(s);
      }
  const a = botSvg('same', { uid: 'one' });
  const b = botSvg('same', { uid: 'two' });
  const ids = (s: string) => [...s.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(ids(a).filter((x) => ids(b).includes(x)).length, 0, 'two faces on one page must not share gradient/filter ids');
});

test('photo avatars stay photos; random faces use only known parts', () => {
  assert.ok(isImageAvatar('https://example.com/a.png'));
  assert.ok(isImageAvatar('data:image/jpeg;base64,AAAA'));
  assert.ok(!isImageAvatar('data:text/html,<script>'));
  assert.ok(!isImageAvatar('//evil.example/x.png'));
  assert.ok(!isImageAvatar('face:{}'));
  assert.ok(!isImageAvatar('🤖'));
  let n = 7;
  const rand = () => (n = (n * 9301 + 49297) % 233280) / 233280;
  for (let i = 0; i < 50; i++) {
    const t = randomTraits(rand);
    assert.deepEqual(cleanTraits(t), t, 'every randomly chosen part is a known part');
  }
});
