import test from 'node:test';
import assert from 'node:assert/strict';
import { groupItems, isSubEntry, matchScore, norm, pushRecent, rank, settingsGroupOf, settingsHostOf, settingsNav, settingsParentOf, settingsRowOf, settingsSearch, staticEntries, RECENT_MAX, type PaletteItem } from '../ui/src/lib/palette.js';

// The module list as the UI has it (titles from ui/src/modules/*/index.tsx).
const MODULES = [
  { id: 'skills', label: 'Marktplaats', pages: [{ path: '', title: 'Marktplaats', nav: true }, { path: 'mine', title: 'Mijn skills', nav: true }], settingsTabs: [{ id: 'uitgevers', title: 'Uitgevers en beleid', adminOnly: true }] },
  { id: 'mcp', label: 'Apps', pages: [{ path: '', title: 'Apps', nav: true }, { path: 'c', title: 'Koppeling' }] },
  { id: 'memory', label: 'Geheugen & dossiers', pages: [{ path: '', title: 'Geheugen & dossiers', nav: true }, { path: 'over-jou', title: 'Over jou' }, { path: 'item', title: 'Herinnering' }] },
  { id: 'folders', label: 'Bestanden', pages: [{ path: '', title: 'Bestanden', nav: true }, { path: 'prullenbak', title: 'Prullenbak' }] },
  { id: 'channels', label: 'Kanalen', pages: [{ path: '', title: 'Kanalen', nav: true }] },
  { id: 'browser', label: 'Computers', pages: [{ path: '', title: 'Computers', nav: true }, { path: 'live', title: 'Live scherm' }, { path: 'kluis', title: 'Kluis' }] },
  { id: 'mobile', label: 'Telefoon', pages: [{ path: 'concepten', title: 'Concepten' }, { path: 'delen', title: 'Delen' }], settingsTabs: [{ id: 'telefoon', title: 'Telefoon' }] },
  { id: 'usage', label: 'Gebruik en limieten', pages: [{ path: '', title: 'Gebruik en limieten', nav: true }, { path: 'eiland', title: 'Statusvenster', bare: true }], settingsTabs: [{ id: 'limits', title: 'Limieten' }] },
  { id: 'notifications', label: 'Meldingen', pages: [{ path: '', title: 'Meldingen', nav: true }], settingsTabs: [{ id: 'meldingen', title: 'Meldingen' }] },
  { id: 'network', label: 'Netwerk en proxy', settingsTabs: [{ id: 'proxy', title: 'Netwerk en proxy', adminOnly: true }] },
  { id: 'routines', label: 'Routines', pages: [{ path: '', title: 'Routines', nav: true }, { path: 'kalender', title: 'Kalender' }] },
];

test('norm strips accents and case', () => {
  assert.equal(norm('  Privé-Container  '), 'prive-container');
  assert.equal(norm('Één'), 'een');
});

test('matchScore: prefixes, words, keywords; every query word must match', () => {
  assert.ok(matchScore('mark', 'Marktplaats') > matchScore('plaats', 'Marktplaats'));
  assert.ok(matchScore('plaats', 'Marktplaats') > 0, 'substring from 3 letters');
  assert.equal(matchScore('xq', 'Marktplaats'), 0);
  assert.ok(matchScore('telegram', 'Kanalen', ['telegram', 'whatsapp']) > 0, 'keyword finds the page');
  assert.ok(matchScore('Kanalen', 'Kanalen', ['telegram']) > matchScore('telegram', 'Kanalen', ['telegram']), 'title beats keyword');
  assert.ok(matchScore('mijn sk', 'Mijn skills') > 0, 'multi-word prefix');
  assert.equal(matchScore('mijn routines', 'Mijn skills'), 0, 'all words must match');
  assert.ok(matchScore('prive', 'Privé-container') > 0, 'accent-insensitive');
});

test('staticEntries + rank: the pages and settings from the acceptance test are found', () => {
  const idx = staticEntries(MODULES, { isAdmin: true });
  const first = (q: string) => rank(q, idx)[0];
  assert.equal(first('Marktplaats')?.href, '#/m/skills/');
  assert.equal(first('Kluis')?.href, '#/m/browser/kluis');
  const tel = rank('Telefoon', idx).find((i) => i.kind === 'setting');
  assert.equal(tel?.href, '#/settings/mobile-telefoon');
  assert.equal(first('Limieten')?.href, '#/settings/usage-limits');
  assert.ok(rank('whatsapp', idx).some((i) => i.href === '#/m/channels/'), 'keyword: whatsapp → Kanalen');
  assert.ok(rank('donker', idx).some((i) => i.href === '#/settings/appearance'), 'thema lives in Uiterlijk (on the Algemeen page)');
  assert.equal(first('lavendel')?.href, '#/settings/appearance', 'the colour choice is found');
  assert.ok(rank('back-up', idx).some((i) => i.href === '#/settings/backups'));
  assert.equal(first('Taken')?.href, '#/tasks', 'Taken (the one board) is a page of its own');
  assert.equal(first('geavanceerd')?.href, '#/settings/general', 'the Geavanceerd tonen switch lives under Algemeen');
  assert.ok(!idx.some((i) => i.href === '#/settings/advanced'), 'the Geavanceerd page is gone');
  // "Meer" is gone from the desktop; pages under Instellingen say where they live.
  assert.ok(!idx.some((i) => i.href === '#/more'));
  assert.equal(idx.find((i) => i.href === '#/m/channels/')?.subtitle, 'Instellingen · Apps en apparaten');
  assert.equal(idx.find((i) => i.href === '#/m/browser/kluis')?.subtitle, 'Instellingen · Apps en apparaten');
  // Geheugen: in Instellingen under Bots en teams. The Marktplaats has its own place in the sidebar: no "Instellingen"
  // under its name.
  assert.equal(idx.find((i) => i.href === '#/m/memory/')?.subtitle, 'Instellingen · Bots en teams');
  assert.equal(idx.find((i) => i.href === '#/m/skills/')?.subtitle, undefined);
  assert.equal(idx.find((i) => i.href === '#/m/routines/kalender')?.subtitle, 'Routines', 'a page with its own place keeps its module name');
  // Detail pages that need an id and bare windows are not destinations.
  assert.ok(!idx.some((i) => i.href === '#/m/mcp/c' || i.href === '#/m/browser/live' || i.href === '#/m/usage/eiland' || i.href === '#/m/mobile/delen'));
  // Admin-only tabs only for admins; Gebruikers only on a server.
  assert.ok(!staticEntries(MODULES, { isAdmin: false }).some((i) => i.id === 'settings:skills-uitgevers'));
  assert.ok(!idx.some((i) => i.id === 'settings:users'));
  assert.ok(staticEntries(MODULES, { isAdmin: true, serverMode: true }).some((i) => i.id === 'settings:users'));
});

test('rank keeps the best few per kind; groupItems puts the best group first', () => {
  const items: PaletteItem[] = [
    ...Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, kind: 'bot' as const, title: `Planner ${i}` })),
    { id: 'p', kind: 'page', title: 'Planning' },
    { id: 'm1', kind: 'message', title: 'Gesprek', snippet: '[plan]' },
  ];
  const r = rank('plan', items, 3);
  assert.equal(r.filter((i) => i.kind === 'bot').length, 3);
  // A server hit (no score) is kept as is by groupItems; local groups are ordered by their best score.
  const g = groupItems([...r, { id: 'm1', kind: 'message', title: 'Gesprek' }], { bestFirst: true });
  assert.deepEqual(
    g.map((x) => x.kind),
    ['bot', 'page', 'message'],
  );
  const exact = groupItems(rank('planning', items), { bestFirst: true });
  assert.equal(exact[0].kind, 'page', 'an exact title wins');
  // Without a query the fixed order applies (recent, actions, bots …).
  assert.deepEqual(
    groupItems([{ id: 'x', kind: 'bot', title: 'A' }, { id: 'y', kind: 'recent', title: 'B' }, { id: 'z', kind: 'action', title: 'C' }]).map((x) => x.kind),
    ['recent', 'action', 'bot'],
  );
});

test('recent list: newest first, no duplicates, bounded, no scores stored', () => {
  let list: PaletteItem[] = [];
  for (let i = 0; i < RECENT_MAX + 3; i++) list = pushRecent(list, { id: `p${i}`, kind: 'page', title: `P${i}`, score: 99 });
  assert.equal(list.length, RECENT_MAX);
  assert.equal(list[0].id, `p${RECENT_MAX + 2}`);
  list = pushRecent(list, { id: 'p5', kind: 'page', title: 'P5' });
  assert.equal(list[0].id, 'p5');
  assert.equal(list.filter((x) => x.id === 'p5').length, 1);
  assert.equal(list[0].score, undefined);
});

const TABS = [
  { id: 'general', label: 'Algemeen' },
  { id: 'appearance', label: 'Uiterlijk' },
  { id: 'providers', label: 'AI-diensten' },
  { id: 'usage', label: 'Kosten' },
  { id: 'cli-agents-cli', label: 'Abonnementen' },
  { id: 'free-models-gratis', label: 'Gratis modellen' },
  { id: 'security', label: 'Beveiliging' },
  { id: 'data', label: 'Waar staat mijn data?' },
  { id: 'backups', label: 'Back-ups' },
  { id: 'backups-app', label: 'Back-ups' },
  { id: 'usage-limits', label: 'Limieten' },
  { id: 'mobile-telefoon', label: 'Telefoon' },
  { id: 'notifications-meldingen', label: 'Meldingen' },
  { id: 'voice-spraak', label: 'Spraak' },
  { id: 'teams-teams', label: 'Teams' },
  { id: 'openbot-import-overstappen', label: 'Overstappen' },
  { id: 'network-proxy', label: 'Netwerk en proxy' },
  { id: 'users', label: 'Gebruikers' },
  { id: 'nieuw-module-tab', label: 'Nieuw' },
];

test('settings rows: every entry belongs to exactly one row; an unknown module tab lands under Algemeen', () => {
  assert.equal(settingsGroupOf('data').title, 'Privacy en back-ups');
  assert.equal(settingsGroupOf('general').title, 'Algemeen');
  assert.equal(settingsGroupOf('channels/').title, 'Apps en apparaten');
  assert.equal(settingsGroupOf('agents/').title, 'Bots en teams');
  assert.equal(settingsGroupOf('backups-app').title, 'Privacy en back-ups', 'an alias belongs to its row');
  assert.equal(settingsGroupOf('appearance').title, 'Algemeen', 'Uiterlijk is part of Algemeen');
  assert.equal(settingsGroupOf('nieuw-module-tab').title, 'Algemeen', 'a new tab is never lost');
  assert.equal(settingsParentOf('providers').id, 'ai');
  assert.equal(settingsParentOf('bots').id, 'bots', 'a row without a page of its own is its own overview');
  // The page of a row is not an entry under "Meer"; what hangs under it is.
  assert.ok(!isSubEntry('general') && !isSubEntry('providers') && !isSubEntry('usage/') && !isSubEntry('bots') && !isSubEntry('usage-limits'));
  assert.ok(isSubEntry('channels/') && isSubEntry('data') && isSubEntry('backups') && isSubEntry('usage') && isSubEntry('nieuw-module-tab'));
  // The old Geavanceerd page shows Algemeen (its one switch lives there).
  assert.equal(settingsRowOf('advanced'), 'general');
  // The palette says where a setting lives.
  assert.equal(staticEntries(MODULES).find((i) => i.id === 'settings:data')?.subtitle, 'Instellingen · Privacy en back-ups');
  assert.equal(staticEntries(MODULES).find((i) => i.id === 'channels/')?.subtitle, 'Instellingen · Apps en apparaten');
});

test('settings navigation: one flat list of six rows, everything else two clicks away under its row', () => {
  const nav = settingsNav(TABS, MODULES);
  assert.deepEqual(
    nav.map((r) => r.title),
    ['Algemeen', 'AI-diensten', 'Bots en teams', 'Apps en apparaten', 'Privacy en back-ups', 'Gebruik'],
  );
  assert.ok(nav.length <= 6);
  const more = (id: string, n = nav) => n.find((r) => r.id === id)?.more.flatMap((s) => s.rows.map((r) => r.title)) || [];
  assert.deepEqual(more('general'), ['Meldingen', 'Spraak', 'Alle meldingen', 'Overstappen van OpenBot', 'Nieuw'], 'an unknown module tab is never hidden');
  // Abonnementen and Gratis modellen are linked on the AI-diensten page itself: not again under "Meer".
  assert.deepEqual(more('ai'), []);
  assert.deepEqual(more('gebruik'), ['Kosten']);
  assert.deepEqual(more('bots'), ['Alle bots', 'Teams', 'Geheugen', 'Gebruikers']);
  assert.deepEqual(more('apps'), ['Telefoon', 'Computers', 'Kanalen', 'Apps', 'Bestanden']);
  assert.deepEqual(more('privacy'), ['Back-ups', 'Waar staat mijn data?']);
  // Where a row leads: its own page, or its overview.
  const href = (id: string) => nav.find((r) => r.id === id)?.href;
  assert.equal(href('ai'), '#/settings/providers');
  assert.equal(href('gebruik'), '#/m/usage/');
  assert.equal(href('bots'), '#/settings/bots');
  assert.equal(href('privacy'), '#/settings/security');
  // Rarely needed entries only with "Geavanceerd tonen", or while that page is open. The list of rows never grows.
  const adv = settingsNav(TABS, MODULES, { advanced: true });
  assert.equal(adv.length, nav.length);
  assert.deepEqual(more('general', adv), ['Meldingen', 'Spraak', 'Alle meldingen', 'Overstappen van OpenBot', 'Netwerk en proxy', 'Nieuw']);
  assert.deepEqual(more('apps', adv), ['Telefoon', 'Computers', 'Concepten', 'Kanalen', 'Apps', 'Bestanden', 'Prullenbak', 'Kluis']);
  assert.ok(more('apps', settingsNav(TABS, MODULES, { current: 'browser/kluis' })).includes('Kluis'));
  // Every tab is reachable (its row, "Meer" with Geavanceerd tonen on, or the AI-diensten page itself); nothing twice.
  const everywhere = adv.flatMap((r) => [r.key, ...r.more.flatMap((s) => s.rows.map((e) => e.key))]);
  assert.equal(new Set(everywhere).size, everywhere.length, 'no entry in two places');
  for (const t of TABS) assert.ok(everywhere.includes(settingsRowOf(t.id)!) || ['cli-agents-cli', 'free-models-gratis'].includes(t.id), `${t.id} is reachable`);
  // One entry per thing: Back-ups and Gebruik once; their other tab marks that row.
  assert.ok(!everywhere.includes('backups-app') && !everywhere.includes('usage-limits'));
  assert.equal(settingsRowOf('backups-app'), 'backups');
  assert.equal(settingsRowOf('usage-limits'), 'usage/');
  assert.equal(settingsRowOf('general'), 'general');
  // A row without a page of its own and without entries is not shown (no modules: no Apps en apparaten; Alle bots is always there).
  assert.deepEqual(
    settingsNav([{ id: 'general', label: 'Algemeen' }], []).map((r) => r.id),
    ['general', 'bots'],
  );
  // Takenbord van groepen is the Taken board itself: no settings row, and not shown inside Instellingen.
  assert.equal(settingsHostOf('rooms/taken'), null);
});

test('settings search: finds every entry, also the rare ones, by the words people use', () => {
  const keys = (q: string) => settingsSearch(TABS, MODULES, q).map((r) => r.key);
  assert.deepEqual(keys('proxy'), ['network-proxy']);
  assert.ok(keys('telegram').includes('channels/'));
  assert.ok(keys('abonnementen').includes('cli-agents-cli'), 'also what the AI-diensten page links to itself');
  assert.equal(keys('donker')[0], 'general', 'the theme is on the Algemeen page');
  assert.ok(!keys('back-up').includes('backups-app') && !keys('limieten').includes('usage-limits'));
  assert.equal(settingsSearch(TABS, MODULES, 'proxy')[0].parent, 'Algemeen', 'a result says under which row it lives');
  assert.deepEqual(keys('xqzv'), []);
  assert.deepEqual(keys(' '), []);
});

test('settingsHostOf: pages under Instellingen, detail pages under their list, own places stay out', () => {
  assert.equal(settingsHostOf('channels/'), 'channels/');
  assert.equal(settingsHostOf('browser/kluis'), 'browser/kluis');
  assert.equal(settingsHostOf('mcp/c'), 'mcp/');
  assert.equal(settingsHostOf('agents/'), 'agents/');
  // Geheugen lives under Instellingen with all its tabs and detail pages (0.4.2); the Marktplaats and Nu bezig are own places (0.4.5).
  for (const [page, host] of [['memory/', 'memory/'], ['memory/over-jou', 'memory/'], ['memory/item', 'memory/']]) assert.equal(settingsHostOf(page), host, page);
  for (const own of ['routines/', 'routines/kalender', 'teamdata/', 'usage/eiland', 'usage/status', 'seen/', 'skills/', 'skills/mine']) assert.equal(settingsHostOf(own), null, own);
});
