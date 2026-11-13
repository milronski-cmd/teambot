/**
 * "Een bot kan wat de gebruiker in het scherm kan": every setting the screens show is found by a bot through
 * teambot_find by the words on the screen (its title and its line, in Dutch and in the user's interface language), with
 * the call, the field and what each value means. The words live once, in shared/settings.ts: the screens take them from
 * there (SettingRow, SwitchRow, the list of Instellingen), so a new setting without a description fails here.
 * And the marketplace: a bot searches and adds from the same marketplace the owner sees, in the same order.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownerTurn, startTestApp } from './helpers.js';
import { MANAGE_DO, MANAGE_FIND, routesOf } from '../server/modules/teams/manage.js';
import { SETTINGS, SETTINGS_PAGES, SETTINGS_ROWS, type SettingDef } from '../shared/settings.js';
import { SETTINGS_ALIASES } from '../ui/src/lib/palette.js';
import { translatorFor } from '../server/core/i18n.js';
import type { ToolDef, ToolOutput } from '../server/core/types.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function files(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'i18n' && e.name !== 'node_modules') files(p, out);
    } else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** The attributes of one JSX tag that starts at `at` (`<SettingRow`), up to its closing `>` outside braces and quotes. */
function attrsAt(src: string, at: number): string {
  let depth = 0;
  let quote = '';
  for (let i = at + 1; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote && src[i - 1] !== '\\') quote = '';
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return src.slice(at, i);
  }
  return src.slice(at);
}
/** The attributes outside any {…}: `label="…"` there is a literal label. */
const topLevel = (attrs: string) => {
  let depth = 0;
  let out = '';
  for (const c of attrs) {
    if (c === '{') depth++;
    if (depth === 0) out += c;
    if (c === '}') depth--;
  }
  return out;
};

/** Every setting row and switch the screens define, and every other place that shows a setting by its id. */
function uiSettings() {
  const rows: { file: string; tag: string; id: string | null; literal: boolean }[] = [];
  const used = new Set<string>();
  for (const file of files(path.join(root, 'ui', 'src'))) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/<(SettingRow|SwitchRow)\b/g)) {
      const attrs = attrsAt(src, m.index!);
      const id = /\bsetting="([^"]+)"/.exec(attrs)?.[1] ?? null;
      rows.push({ file: path.relative(root, file), tag: m[1], id, literal: /\blabel=/.test(topLevel(attrs)) });
      if (id) used.add(id);
    }
    for (const m of src.matchAll(/\bsetting(?:Text|Options)(?:<[^>]*>)?\('([^']+)'\)/g)) used.add(m[1]);
  }
  return { rows, used };
}

async function setup(language?: string) {
  const t = await startTestApp();
  const ctx = t.app.ctx;
  const userId = ctx.auth.owner()!.id;
  if (language) await t.api('PUT', '/settings', { language });
  const bot = await t.agent({ name: 'Baas' });
  const tools: ToolDef[] = ctx.services.teams.manageTools;
  const run = async (name: string, args: any): Promise<ToolOutput> => {
    const tool = tools.find((x) => x.name === name)!;
    const out = await tool.run(args, { ctx, agent: ctx.store.agent(bot.id)!, thread: ctx.chat.threadForAgent(userId, bot.id), userId, run: ownerTurn(ctx, userId, bot.id), signal: new AbortController().signal, toolCallId: 'c1', progress() {} });
    return typeof out === 'string' ? { text: out } : out;
  };
  const find = async (word: string) => {
    const out = await run(MANAGE_FIND, { word });
    return { text: out.text, ids: ((out as any).data?.settings || []).map((h: any) => h.id) as string[] };
  };
  return { t, ctx, userId, bot, run, find };
}

test('the screens take every setting row and switch from shared/settings.ts: no literal label, no id that is not described, nothing described that no screen shows', () => {
  const { rows, used } = uiSettings();
  assert.ok(rows.length >= 35, `found ${rows.length} rows`);
  const literal = rows.filter((r) => r.literal || !r.id).map((r) => `${r.file}: <${r.tag}> without setting="…"`);
  assert.deepEqual(literal, [], 'a setting row or switch has its words in shared/settings.ts (SETTINGS), by setting="<id>"');
  const unknown = rows.filter((r) => r.id && !(r.id in SETTINGS)).map((r) => `${r.file}: ${r.id}`);
  assert.deepEqual(unknown, []);
  const orphans = Object.keys(SETTINGS).filter((id) => !used.has(id));
  assert.deepEqual(orphans, [], 'every described setting is shown by a screen');
  // Every setting says where it is and how a bot changes it (or why it cannot).
  for (const [id, d] of Object.entries(SETTINGS as Record<string, SettingDef>)) {
    assert.ok(d.on === 'bot' || SETTINGS_PAGES[d.on], `${id}: on “${d.on}” is an entry of Instellingen`);
    assert.ok(d.call ? d.field && (d.choices?.length || d.takes) : d.note, `${id}: a call with its field and values, or a note why a bot cannot`);
  }
});

test('every row and entry of Instellingen is described once, and every module settings tab is in the list', () => {
  const listed = SETTINGS_ROWS.flatMap((r) => [...(r.main ? [r.main] : []), ...(r.more || []).flatMap((s) => s.items)]);
  assert.deepEqual(listed.filter((k) => !SETTINGS_PAGES[k]), [], 'every entry has its title and line in SETTINGS_PAGES');
  assert.deepEqual(Object.keys(SETTINGS_PAGES).filter((k) => !listed.includes(k)), [], 'and nothing is described that the list does not show');
  for (const r of SETTINGS_ROWS) assert.ok(r.title && r.hint, `row ${r.id}: a title and a line`);
  // A module that brings a settings tab: it is an entry of the list (or an alias of one).
  const tabs: string[] = [];
  for (const dir of fs.readdirSync(path.join(root, 'ui', 'src', 'modules'))) {
    const index = ['index.tsx', 'index.ts'].map((f) => path.join(root, 'ui', 'src', 'modules', dir, f)).find((f) => fs.existsSync(f));
    if (!index) continue;
    const block = /settingsTabs:\s*\[([\s\S]*?)\]/.exec(fs.readFileSync(index, 'utf8'))?.[1] || '';
    for (const m of block.matchAll(/\{\s*id:\s*'([^']+)'/g)) tabs.push(`${dir}-${m[1]}`);
  }
  assert.ok(tabs.length >= 15, `module tabs: ${tabs.join(', ')}`);
  assert.deepEqual(tabs.filter((k) => !SETTINGS_PAGES[k] && !SETTINGS_ALIASES[k]), [], 'a module settings tab without a description in shared/settings.ts');
});

test('a bot finds every setting by the words on the screen (its title, its line), with the call, the field and the values; and every page and row of Instellingen', async () => {
  const e = await setup();
  try {
    const routes = routesOf(e.ctx).map((r) => `${r.method} ${r.path}`);
    for (const [id, d] of Object.entries(SETTINGS as Record<string, SettingDef>)) {
      if (d.call) assert.ok(routes.includes(d.call), `${id}: ${d.call} is a route of TeamBot`);
      for (const words of [d.title, d.hint].filter(Boolean) as string[]) {
        const hit = await e.find(words);
        assert.ok(hit.ids.includes(id), `“${words}” finds ${id}; got ${hit.ids.join(', ') || hit.text.slice(0, 300)}`);
      }
      const { text } = await e.find(d.title);
      if (d.call) assert.match(text, new RegExp(`${d.call.replace(/[/:]/g, '\\$&')}${d.field ? ' met body' : ''}`), `${id}: the call`);
      for (const c of d.choices || []) assert.ok(text.includes(`${JSON.stringify(c.value)} = ${c.label}`), `${id}: the value ${JSON.stringify(c.value)} and what it is`);
    }
    for (const [key, p] of Object.entries(SETTINGS_PAGES)) {
      for (const prefix of p.api) assert.ok(routes.some((r) => r.split(' ')[1] === prefix || r.split(' ')[1].startsWith(prefix + '/')), `${key}: ${prefix} is part of TeamBot's API`);
      for (const words of [p.title, p.hint].filter(Boolean) as string[]) assert.ok((await e.find(words)).text.includes(`“${p.title}”`), `“${words}” finds the page ${key}`);
    }
    for (const r of SETTINGS_ROWS) for (const words of [r.title, r.hint]) assert.ok((await e.find(words)).text.includes(`“${r.main ? SETTINGS_PAGES[r.main].title : r.title}”`), `“${words}” finds the row ${r.id}`);

    // The words the owner used, and what the checker tried.
    for (const word of ['figuurtjes', 'stijl', 'vilt', 'zet de stijl van de figuurtjes op vilt']) assert.ok((await e.find(word)).ids.includes('ui.botStyle'), word);
    for (const word of ['thema', 'donker', 'zet het thema op donker']) assert.ok((await e.find(word)).ids.includes('ui.theme'), word);
    const look = await e.find('uiterlijk');
    assert.ok(['ui.theme', 'ui.botStyle', 'ui.accent', 'language'].every((id) => look.ids.includes(id)), look.ids.join(', '));
    assert.match((await e.find('stijl figuurtjes')).text, /PUT \/settings met body \{"ui":\{"botStyle":…\}\}; waarden: "clay" = Glad .*"felt" = Vilt/);
    // PUT /settings itself says its fields.
    assert.match((await e.find('instellingen')).text, /PUT \/settings — Instellingen aanpassen — velden: .*ui\.botStyle.*ui\.theme|PUT \/settings — Instellingen aanpassen — velden: .*ui\.theme.*ui\.botStyle/);
    // What a bot cannot do is found too, and says so.
    assert.match((await e.find('Bereikbaar via')).text, /Niet via een bot: inlogsessies, gekoppelde apparaten, koppelen/);
  } finally {
    await e.t.close();
  }
});

test('in the user’s interface language: an English owner’s words find the setting, and the answer shows them', async () => {
  const e = await setup('en');
  try {
    const en = translatorFor('en')!;
    let checked = 0;
    for (const [id, d] of Object.entries(SETTINGS as Record<string, SettingDef>)) {
      const title = en.translate(d.title);
      if (!title || title === d.title) continue; // not translated yet (the translation round adds it)
      const hit = await e.find(title);
      assert.ok(hit.ids.includes(id), `“${title}” (${d.title}) finds ${id}; got ${hit.ids.join(', ')}`);
      assert.ok(hit.text.includes(`“${title}” (${d.title})`), `${id}: both words in the answer`);
      checked++;
    }
    assert.ok(checked >= 10, `translated titles checked: ${checked}`);
    for (const word of ['Theme', 'Dark', 'Character style', 'Felt']) assert.ok((await e.find(word)).ids.length, word);
    assert.ok((await e.find('Theme')).ids.includes('ui.theme'));
    assert.ok((await e.find('Felt')).ids.includes('ui.botStyle'));
  } finally {
    await e.t.close();
  }
});

test('what a bot finds it can set: one field of ui keeps the rest, a wrong value says which values there are, a theme is stamped for every device', async () => {
  const e = await setup();
  try {
    await e.t.api('PUT', '/settings', { ui: { accent: 'lavender', advanced: true } });
    const out = await e.run(MANAGE_DO, { method: 'PUT', path: '/settings', body: { ui: { botStyle: 'felt' } } });
    assert.equal(out.isError ?? false, false, out.text);
    assert.match(out.text, /^Instellingen aanpassen: Stijl figuurtjes “Vilt” — gelukt\./);
    let ui = e.ctx.store.getSetting<any>(e.userId, 'ui', {});
    assert.deepEqual([ui.botStyle, ui.accent, ui.advanced], ['felt', 'lavender', true], 'the other fields of ui stay');
    // A body as JSON text (Claude Code sometimes sends it so) is the same object; text that is no JSON is said.
    await e.run(MANAGE_DO, { method: 'PUT', path: '/settings', body: '{"ui": {"botStyle": "clay"}}' });
    assert.equal(e.ctx.store.getSetting<any>(e.userId, 'ui', {}).botStyle, 'clay');
    assert.match((await e.run(MANAGE_DO, { method: 'PUT', path: '/settings', body: 'ui.botStyle=felt' })).text, /De body is geen geldige JSON/);
    await e.run(MANAGE_DO, { method: 'PUT', path: '/settings', body: { ui: { botStyle: 'felt' } } });
    const wrong = await e.run(MANAGE_DO, { method: 'PUT', path: '/settings', body: { ui: { botStyle: 'vilt' } } });
    assert.equal(wrong.isError, true);
    assert.match(wrong.text, /Onbekende waarde voor Stijl figuurtjes \(ui\.botStyle\): kies uit "clay" \(Glad\), "felt" \(Vilt\)/);
    // The theme: stamped, so every device takes it over once; a screen that sends its whole ui back changes no stamp.
    assert.equal((await e.run(MANAGE_DO, { method: 'PUT', path: '/settings', body: { ui: { theme: 'dark' } } })).isError ?? false, false);
    ui = e.ctx.store.getSetting<any>(e.userId, 'ui', {});
    assert.equal(ui.theme, 'dark');
    assert.ok(typeof ui.themeAt === 'string' && ui.themeAt, 'stamped');
    const stamp = ui.themeAt;
    await e.t.api('PUT', '/settings', { ui: { ...ui, accent: 'mint' } });
    assert.equal(e.ctx.store.getSetting<any>(e.userId, 'ui', {}).themeAt, stamp, 'the echo of the screen is no new theme');
    await new Promise((r) => setTimeout(r, 5));
    await e.run(MANAGE_DO, { method: 'PUT', path: '/settings', body: { ui: { theme: 'dark' } } });
    assert.notEqual(e.ctx.store.getSetting<any>(e.userId, 'ui', {}).themeAt, stamp, 'the same theme asked again is taken over again');
  } finally {
    await e.t.close();
  }
});

test('the marketplace: “marktplaats” and “skill” lead to the search the owner sees (checked first, most stars first), not to TeamBot’s own starter catalogue', async () => {
  const e = await setup();
  try {
    for (const word of ['marktplaats', 'skill zoeken', 'skills']) {
      const { text } = await e.find(word);
      const first = /^- (GET|POST) (\S+)/m.exec(text);
      assert.equal(first?.[2], '/skills/web/search', `${word}: the first route is the search of the marketplace\n${text.slice(0, 600)}`);
      assert.match(text, /- POST \/skills\/curated\/install — Marktplaats: een skill toevoegen/);
    }
    const { text } = await e.find('marktplaats');
    assert.ok(text.indexOf('/skills/market/skills') > text.indexOf('/skills/curated/install'), 'the starter catalogue comes after');
    assert.match(text, /GET \/skills\/market\/skills — Eigen catalogi: .*Meer opties › Zelf geschreven en eigen catalogi/);
    assert.doesNotMatch(text, /Vaardigheid \((curated|web)\)/);
    // The search itself: the checked catalogue in the same order as the screen (most stars first), and the item the
    // owner would find ("Cold email" of the most starred marketing set) is there.
    // (Offline: the public sources are not asked in a test; the checked catalogue is TeamBot's own.)
    process.env.TEAMBOT_OFFLINE = '1';
    for (const q of ['koude e-mails', 'cold email']) {
      const found = await e.run(MANAGE_DO, { method: 'GET', path: '/skills/web/search', query: { q } });
      assert.equal(found.isError ?? false, false, found.text);
      const checked = found.text.slice(found.text.indexOf('"checked"'), found.text.indexOf('"github"') > 0 ? found.text.indexOf('"github"') : undefined);
      assert.match(checked, /"id": "[^"]*cold-email"/, `${q}: ${found.text.slice(0, 600)}`);
    }
    const stars = (await e.t.api('GET', '/skills/curated')).items.map((i: any) => i.stars ?? 0);
    assert.deepEqual(stars, [...stars].sort((a: number, b: number) => b - a), 'most stars first, as in the screen');
  } finally {
    delete process.env.TEAMBOT_OFFLINE;
    await e.t.close();
  }
});

test('the owner names a setting in his own words: the bot sees, that turn, that it is TeamBot’s own setting and how to set it', async () => {
  const e = await setup();
  try {
    const kim = await e.t.agent({ name: 'Kim' });
    const thread = await e.t.api('POST', '/threads', { agentId: kim.id });
    const turn = async (text: string) => {
      e.t.script.push({ text: 'Goed.' });
      await e.t.say(thread.id, text);
      // What this turn adds: the context of the last message (earlier turns keep their own).
      return JSON.stringify(e.t.requests.at(-1)!.messages.at(-1));
    };
    const style = await turn('zet de stijl van de figuurtjes op vilt');
    assert.match(style, /Dit kan over een instelling van TeamBot zelf gaan; die zet je met teambot_do/);
    assert.match(style, /“Stijl figuurtjes” \(Instellingen › Taal en uiterlijk\): PUT \/settings met body \{\\"ui\\":\{\\"botStyle\\":…\}\}; waarden: \\"clay\\" = Glad, \\"felt\\" = Vilt/);
    assert.match(await turn('zet het thema op donker'), /“Thema” \(Instellingen › Taal en uiterlijk\): PUT \/settings/);
    // A message about something else gets nothing extra.
    for (const text of ['Hoi', 'schrijf een korte mail aan de klant over de levering', 'zoek en installeer een skill voor koude e-mails']) assert.doesNotMatch(await turn(text), /instelling van TeamBot zelf/, text);
  } finally {
    await e.t.close();
  }
});
