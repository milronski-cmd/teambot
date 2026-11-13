import test from 'node:test';
import assert from 'node:assert/strict';
import { groupItems, isSubEntry, matchScore, norm, pushRecent, rank, settingsHostOf, settingsNav, settingsParentOf, settingsRowOf, settingsSearch, staticEntries, RECENT_MAX, type PaletteItem } from '../ui/src/lib/palette.js';

// The module list as the UI has it (titles from ui/src/modules/*/index.tsx).
const MODULES = [
  { id: 'skills', label: 'Marktplaats', pages: [{ path: '', title: 'Marktplaats', nav: true }, { path: 'mine', title: 'Mijn skills', nav: true }], settingsTabs: [{ id: 'uitgevers', title: 'Vertrouwde makers', adminOnly: true }] },
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
  assert.equal(tel?.href, '#/settings/telefoon', 'the short page (the QR code) comes first');
  assert.equal(first('Limieten')?.href, '#/settings/usage-limits');
  assert.ok(rank('whatsapp', idx).some((i) => i.href === '#/m/channels/'), 'keyword: whatsapp → Kanalen');
  assert.ok(rank('donker', idx).some((i) => i.href === '#/settings/general'), 'the theme is on Taal en uiterlijk');
  assert.equal(first('lavendel')?.href, '#/settings/general', 'the colour choice is found, on the same page');
  assert.equal(first('regels')?.href, '#/settings/regels');
  assert.equal(first('pincode')?.href, '#/settings/slot');
  assert.ok(rank('back-up', idx).some((i) => i.href === '#/settings/backups'));
  assert.equal(first('Taken')?.href, '#/tasks', 'Taken (the one board) is a page of its own');
  assert.equal(first('Meer mogelijkheden')?.href, '#/settings/meer', 'everything optional is one place');
  assert.equal(first('geavanceerd')?.href, '#/settings/meer', 'the old word finds it too');
  assert.ok(!idx.some((i) => i.href === '#/settings/advanced' || i.href === '#/settings/geavanceerd' || i.href === '#/settings/appearance'), 'old links are not listed');
  // "Meer" is gone from the desktop; pages under Instellingen say where they live.
  assert.ok(!idx.some((i) => i.href === '#/more'));
  assert.equal(idx.find((i) => i.href === '#/m/channels/')?.subtitle, 'Instellingen', 'a row of the list itself');
  assert.equal(idx.find((i) => i.href === '#/m/browser/kluis')?.subtitle, 'Instellingen · Meer mogelijkheden');
  // Geheugen: a row of Instellingen. The Marktplaats has its own place in the sidebar: no "Instellingen" under its name.
  assert.equal(idx.find((i) => i.href === '#/m/memory/')?.subtitle, 'Instellingen');
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
  { id: 'general', label: 'Taal en uiterlijk' },
  { id: 'providers', label: 'AI-diensten' },
  { id: 'telefoon', label: 'Telefoon' },
  { id: 'regels', label: 'Regels' },
  { id: 'slot', label: 'Vergrendeling' },
  { id: 'kant-en-klaar', label: 'Kant-en-klare teams' },
  { id: 'vanzelf', label: 'Wat start vanzelf' },
  { id: 'teams', label: 'Teams' },
  { id: 'veilig', label: 'Back-ups' },
  { id: 'bot-defaults', label: 'Standaarden voor nieuwe bots' },
  { id: 'ai-meer', label: 'Lokale modellen en andere diensten' },
  { id: 'systeem', label: 'Deze computer' },
  { id: 'usage', label: 'Kosten' },
  { id: 'cli-agents-cli', label: 'Abonnementen' },
  { id: 'free-models-gratis', label: 'Gratis modellen' },
  { id: 'security', label: 'Beveiliging' },
  { id: 'data', label: 'Privacy en gegevens' },
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

test('settings rows: every entry belongs to exactly one row; an unknown module tab lands under Meer mogelijkheden', () => {
  assert.equal(settingsParentOf('veilig').title, 'Back-ups');
  assert.equal(settingsParentOf('general').title, 'Taal en uiterlijk');
  assert.equal(settingsParentOf('channels/').title, 'Kanalen');
  assert.equal(settingsParentOf('agents/').title, 'Bots');
  // Everything optional lives in the one place Meer mogelijkheden: the full pages behind the short ones, the extra
  // AI programs, switching over from another product, and whatever a new module adds.
  for (const id of ['data', 'security', 'backups', 'backups-app', 'mobile-telefoon', 'notifications-meldingen', 'teams-teams', 'voice-spraak', 'network-proxy', 'usage/', 'usage', 'cli-agents-cli', 'free-models-gratis', 'openbot-import-overstappen', 'browser/', 'browser/kluis', 'nieuw-module-tab'])
    assert.equal(settingsParentOf(id).title, 'Meer mogelijkheden', `${id} is under Meer mogelijkheden`);
  assert.equal(settingsParentOf('providers').id, 'ai');
  assert.equal(settingsParentOf('meer').id, 'meer', 'the row without a page of its own is its own overview');
  // The page of a row is not an entry under it; what hangs under Meer mogelijkheden is.
  for (const id of ['general', 'providers', 'telefoon', 'regels', 'veilig', 'slot', 'teams', 'agents/', 'channels/', 'memory/', 'meer']) assert.ok(!isSubEntry(id), `${id} is the page of a row`);
  for (const id of ['data', 'backups', 'usage', 'browser/kluis', 'notifications-meldingen', 'nieuw-module-tab']) assert.ok(isSubEntry(id), `${id} is an entry under a row`);
  // Old links open the page that has it now.
  assert.equal(settingsRowOf('advanced'), 'meer');
  assert.equal(settingsRowOf('geavanceerd'), 'meer');
  assert.equal(settingsRowOf('appearance'), 'general');
  assert.equal(settingsRowOf('meldingen'), 'notifications-meldingen');
  // The palette says where a setting lives.
  assert.equal(staticEntries(MODULES).find((i) => i.id === 'settings:data')?.subtitle, 'Instellingen · Meer mogelijkheden');
  assert.equal(staticEntries(MODULES).find((i) => i.id === 'settings:general')?.subtitle, 'Instellingen');
  assert.equal(staticEntries(MODULES).find((i) => i.id === 'channels/')?.subtitle, 'Instellingen');
});

test('settings navigation: every row opens one thing; Meer mogelijkheden is the one place for everything optional', () => {
  const nav = settingsNav(TABS, MODULES);
  assert.deepEqual(
    nav.map((r) => r.title),
    ['AI-diensten', 'Telefoon', 'Taal en uiterlijk', 'Regels', 'Back-ups', 'Vergrendeling', 'Bots', 'Teams', 'Geheugen', 'Kanalen', 'Apps', 'Bestanden', 'Meer mogelijkheden'],
  );
  assert.equal(nav.at(-1)?.id, 'meer', 'Meer mogelijkheden is the last row');
  // First what you set yourself, then what your bots have; only the last row is an overview.
  assert.deepEqual(nav.filter((r) => r.work).map((r) => r.id), ['bots', 'teams', 'memory', 'channels', 'apps', 'files']);
  assert.deepEqual(nav.filter((r) => !r.hasMain).map((r) => r.id), ['meer']);
  const more = (id: string, n = nav) => n.find((r) => r.id === id)?.more.flatMap((s) => s.rows.map((r) => r.title)) || [];
  for (const r of nav.slice(0, -1)) assert.deepEqual(more(r.id), [], `${r.title} opens one thing: nothing hangs under it`);
  const opt = more('meer');
  for (const title of ['Kant-en-klare teams', 'Wat start vanzelf', 'AI-programma’s', 'Gratis modellen', 'Lokale modellen en andere diensten', 'Standaarden voor nieuwe bots', 'Spraak', 'Teaminstellingen', 'Meldingen per bot', 'Alle meldingen', 'Kosten', 'Gebruikers', 'Telefoonverbinding', 'Computers en servers', 'Kluis', 'Prullenbak', 'Deze computer', 'Beveiliging', 'Back-ups en updates', 'Privacy en gegevens', 'Netwerk en proxy', 'Overstappen van OpenBot', 'Nieuw'])
    assert.ok(opt.includes(title), `Meer mogelijkheden lists “${title}”`);
  // Where a row leads: its own page.
  const href = (id: string) => nav.find((r) => r.id === id)?.href;
  assert.equal(href('ai'), '#/settings/providers');
  assert.equal(href('phone'), '#/settings/telefoon');
  assert.equal(href('rules'), '#/settings/regels');
  assert.equal(href('backup'), '#/settings/veilig');
  assert.equal(href('lock'), '#/settings/slot');
  assert.equal(href('bots'), '#/agents');
  assert.equal(href('channels'), '#/m/channels/');
  assert.equal(href('meer'), '#/settings/meer');
  // There is no second, hidden layer: "Geavanceerd tonen" does not change the list.
  assert.deepEqual(settingsNav(TABS, MODULES, { advanced: true }), nav);
  // Every tab is reachable (a row, or an entry under Meer mogelijkheden); nothing twice.
  const everywhere = nav.flatMap((r) => [r.key, ...r.more.flatMap((s) => s.rows.map((e) => e.key))]);
  assert.equal(new Set(everywhere).size, everywhere.length, 'no entry in two places');
  for (const t of TABS) assert.ok(everywhere.includes(settingsRowOf(t.id)!), `${t.id} is reachable`);
  // One entry per thing: Back-ups and Gebruik once; their other tab marks that entry.
  assert.ok(!everywhere.includes('backups-app') && !everywhere.includes('usage-limits'));
  assert.equal(settingsRowOf('backups-app'), 'backups');
  assert.equal(settingsRowOf('usage-limits'), 'usage/');
  assert.equal(settingsRowOf('general'), 'general');
  // A row without its page is not shown (no modules: no Telefoon, Kanalen, Apps; Alle bots is always there).
  assert.deepEqual(
    settingsNav([{ id: 'general', label: 'Taal en uiterlijk' }], []).map((r) => r.id),
    ['general', 'bots'],
  );
  // Takenbord van groepen is the Taken board itself: no settings row, and not shown inside Instellingen.
  assert.equal(settingsHostOf('rooms/taken'), null);
});

test('settings search: finds every entry, also the rare ones, by the words people use', () => {
  const keys = (q: string) => settingsSearch(TABS, MODULES, q).map((r) => r.key);
  assert.deepEqual(keys('proxy'), ['network-proxy']);
  assert.ok(keys('telegram').includes('channels/'));
  assert.ok(keys('abonnementen').includes('cli-agents-cli'), 'the extra AI programs are found');
  assert.equal(keys('donker')[0], 'general', 'the theme is on Taal en uiterlijk');
  assert.equal(keys('pincode')[0], 'slot');
  assert.ok(!keys('back-up').includes('backups-app') && !keys('limieten').includes('usage-limits'));
  assert.equal(settingsSearch(TABS, MODULES, 'proxy')[0].parent, 'Meer mogelijkheden', 'a result says under which row it lives');
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
