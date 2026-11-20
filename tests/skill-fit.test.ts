/** A turn that brings work names the bot's own skills, the ones that fit the work first. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillFitContext } from '../server/modules/skills/menu.js';

const skill = (name: string, description: string) => ({ id: 'sk_' + name, name, description }) as any;
const lib = (list: any[]) => ({ enabledFor: () => list }) as any;
const bot = (o: any = {}) => ({ id: 'ag_1', name: 'Pen', access_mode: 'auto', ...o }) as any;
const msg = (content: string, role = 'user') => ({ role, content }) as any;

test('work names the skills of the bot, best fit first; small talk, a picked skill and a bot without skills get nothing', () => {
  const mine = [
    skill('humanizer', 'Maakt een tekst natuurlijker en minder stijf.'),
    skill('copy-editing', 'Loopt een bestaande tekst na op fouten, toon en lengte.'),
    skill('seo-content-brief', 'Maakt een briefing voor een pagina: zoekwoorden, koppen en vragen die de pagina moet beantwoorden.'),
    skill('copywriting', 'Schrijft overtuigende verkooptekst voor een pagina of advertentie.'),
  ];
  const task = 'Maak een briefing voor de pagina over warmtepomp kosten: welke zoekwoorden en koppen moeten erin?';
  const said = skillFitContext({} as any, lib(mine), bot(), msg(task))!;
  assert.match(said, /^Je skills voor dit werk: seo-content-brief \(Maakt een briefing voor een pagina/);
  for (const s of mine) assert.ok(said.includes(s.name), s.name);
  assert.match(said, /pak die er dan eerst bij .* zeg in je antwoord welke skill je gebruikte\. Past er geen, werk dan zonder\.$/);

  // More skills than fit: the rest is counted, never listed.
  const many = [...mine, ...['a', 'b', 'c', 'd', 'e'].map((x) => skill('extra-' + x, 'Iets anders.'))];
  assert.match(skillFitContext({} as any, lib(many), bot(), msg(task))!, /; en nog 3\. /);

  assert.equal(skillFitContext({} as any, lib(mine), bot(), msg('Goedemorgen, alles goed?')), null);
  assert.equal(skillFitContext({} as any, lib(mine), bot(), msg('Gebruik /humanizer en maak de tekst op de homepage wat natuurlijker en korter.')), null);
  assert.equal(skillFitContext({} as any, lib([]), bot(), msg(task)), null);
  assert.equal(skillFitContext({} as any, lib(mine), bot({ access_mode: 'chat' }), msg(task)), null);
  assert.equal(skillFitContext({} as any, lib(mine), bot(), msg(task, 'assistant')), null);
  // Work the bot takes up by itself (a line of TeamBot) is work too: its skills are named, in their own order.
  const own = skillFitContext({} as any, lib(mine), bot(), { role: 'system', content: 'Er ligt werk voor je klaar: 1 punt.', parts: { work: { refs: ['tk::1'] } } } as any)!;
  assert.match(own, /^Je skills voor dit werk: humanizer \(/);
  assert.equal(skillFitContext({} as any, lib(mine), bot(), { role: 'system', content: 'Een melding van het systeem over iets anders dan werk.' } as any), null);
});
