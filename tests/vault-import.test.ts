process.env.TEAMBOT_BROWSER_HEADLESS_ONLY = '1'; // never open GUI windows in tests

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp, type TestApp } from './helpers.js';
import { detectFormat, IMPORT_MAX_ROWS, parseCsv, parseExport, toCandidates, VaultImportError } from '../server/modules/browser/vault-import.js';
import type { ComputerService } from '../server/modules/browser/service.js';

const svcOf = (t: TestApp): ComputerService => t.app.ctx.services.computers._service;

async function raw(t: TestApp, token: string, method: string, p: string, body?: any) {
  const res = await fetch(t.app.url + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

function dumpDb(t: TestApp): string {
  const tables = t.app.ctx.store.all<any>("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
  return tables.map((n) => JSON.stringify(t.app.ctx.store.all(`SELECT * FROM "${n}"`))).join('\n');
}

/** Every file under the data dir (database, WAL, logs, caches) as one buffer per file. */
function filesUnder(dir: string): { file: string; data: Buffer }[] {
  const out: { file: string; data: Buffer }[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else if (e.isFile()) {
      try {
        out.push({ file: p, data: fs.readFileSync(p) });
      } catch {
        /* locked */
      }
    }
  }
  return out;
}

// ---------------- fixtures: what the apps really export ----------------

const BW_PW = 'Ge"heim,1';
const BITWARDEN = [
  'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp',
  'Werk,1,login,Webwinkel,"Notitie met, komma\nen een tweede regel",,0,"https://shop.example.nl/login,https://admin.example.nl",sanne@example.nl,"Ge""heim,1",JBSWY3DPEHPK3PXP',
  ',,note,Recepten,geheime notitie,,0,,,,',
  ',,login,Telefoonapp,,,0,androidapp://com.example.app,app-user,app-pw-123,',
  ',,login,Zonder wachtwoord,,,0,https://nopw.example.nl,user,,',
  ',,login,Steam,,,0,https://store.steampowered.com,gamer,Bw-steam-pw,steam://ABCDEFGH',
].join('\n');

const OP_PW = 'Wacht"woord, met komma';
const ONEPASSWORD = [
  'Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes',
  'Google Ads,https://ads.google.com/aw/overview,sanne@example.nl,P@ss;word-1P,otpauth://totp/Google:sanne?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Google,false,false,,',
  `Bank,bank.example.com,klant123,"Wacht""woord, met komma",,true,false,financien,"Meerdere\nregels"`,
].join('\n');

// Chrome: UTF-8 BOM and CRLF line ends
const CHROME_PW = 'Chr0me-pw!';
const CHROME = '﻿' + ['name,url,username,password,note', `shop.example.nl,https://shop.example.nl/account/login,sanne@example.nl,${CHROME_PW},`, 'com.example.app,android://abc@com.example.app/,user,apppw-xyz,', 'forum.example.org,https://forum.example.org/,,Forum-pw-2,"notitie\r\nmet regel"'].join('\r\n') + '\r\n';

// Edge (older Chromium export without "note")
const EDGE = ['name,url,username,password', 'accounts.example.com,"https://accounts.example.com/signin?continue=a,b",user@example.com,Edge-pw-3', 'accounts.example.com,https://accounts.example.com/other,user@example.com,Edge-pw-dup'].join('\n');

const FIREFOX = ['"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"', '"https://forum.example.org","fox","Fx-pw-1",,"https://forum.example.org","{abc}","1700000000000","1700000000000","1700000000000"'].join('\n');

// Excel with Dutch settings saves with semicolons
const GENERIC = ['Naam;Website;Gebruikersnaam;Wachtwoord', 'Intranet;intranet.example.nl;r.de.vries;Puntkomma-pw', 'Router;http://192.168.1.1;admin;Rtr-pw-9'].join('\r\n');

// ---------------- unit: CSV ----------------

test('CSV: quotes, commas and line breaks inside quotes, doubled quotes, BOM, CRLF/LF/CR, empty lines', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x,1","y\n2"\r\n"he said ""hi""",z\n\n'), [
    ['a', 'b'],
    ['x,1', 'y\n2'],
    ['he said "hi"', 'z'],
  ]);
  assert.deepEqual(parseCsv('﻿a,b\rc,d\r'), [
    ['a', 'b'],
    ['c', 'd'],
  ]);
  assert.deepEqual(parseCsv('a,b,\n1,,3\n'), [
    ['a', 'b', ''],
    ['1', '', '3'],
  ]);
  assert.deepEqual(parseCsv('a,b\n"",""'), [
    ['a', 'b'],
    ['', ''],
  ]);
  // a quote in the middle of a field is an ordinary character
  assert.deepEqual(parseCsv('a,b\nab"c,d'), [
    ['a', 'b'],
    ['ab"c', 'd'],
  ]);
  // semicolon and tab files
  assert.deepEqual(parseCsv('a;b\n"x;1";2'), [
    ['a', 'b'],
    ['x;1', '2'],
  ]);
  assert.deepEqual(parseCsv('a\tb\nx\ty'), [
    ['a', 'b'],
    ['x', 'y'],
  ]);
  // a missing closing quote: a clear message with the line, never the content
  assert.throws(
    () => parseCsv('name,url,username,password\nx,https://x.nl,u,"Geheim-Onafgesloten\n'),
    (e: any) => e instanceof VaultImportError && /regel 2/.test(e.message) && !e.message.includes('Geheim'),
  );
  // row limit
  const many = 'url,password\n' + Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => `https://s${i}.example.nl,pw${i}`).join('\n');
  assert.throws(() => parseCsv(many), (e: any) => e instanceof VaultImportError && /meer dan 2000/.test(e.message));
});

// ---------------- unit: one parser per format ----------------

test('Bitwarden: several URIs, only logins, quoted password with comma and quote, TOTP, app-only and empty rows skipped', () => {
  const { format, candidates } = parseExport(BITWARDEN);
  assert.equal(format.id, 'bitwarden');
  assert.equal(format.label, 'Bitwarden');
  assert.equal(candidates.length, 5);
  const [shop, note, app, nopw, steam] = candidates;
  assert.deepEqual(shop.origins, ['https://shop.example.nl', 'https://admin.example.nl']);
  assert.equal(shop.label, 'Webwinkel');
  assert.equal(shop.username, 'sanne@example.nl');
  assert.equal(shop.password, BW_PW);
  assert.equal(shop.totp?.secret, 'JBSWY3DPEHPK3PXP');
  assert.equal(shop.line, 2);
  assert.equal(shop.skip, undefined);
  assert.match(note.skip!, /Geen login/);
  assert.equal(note.line, 3, 'rows are counted as a spreadsheet does: the two-line note of row 2 is still one row');
  assert.match(app.skip!, /app/);
  assert.equal(nopw.skip, 'Geen wachtwoord');
  // a Steam Guard key is not a standard TOTP key: imported without it, with a remark
  assert.equal(steam.skip, undefined);
  assert.equal(steam.totp, null);
  assert.match(steam.warning!, /2FA-sleutel niet herkend/);
  // organisation export (collections instead of folder/favorite) is Bitwarden too
  assert.equal(detectFormat(['collections', 'type', 'name', 'notes', 'fields', 'reprompt', 'login_uri', 'login_username', 'login_password', 'login_totp']).id, 'bitwarden');
});

test('1Password: Title/Url/OTPAuth export, bare host gets https, multi-line notes ignored', () => {
  const { format, candidates } = parseExport(ONEPASSWORD);
  assert.equal(format.id, '1password');
  assert.equal(format.label, '1Password');
  const [ads, bank] = candidates;
  assert.deepEqual(ads.origins, ['https://ads.google.com']);
  assert.equal(ads.password, 'P@ss;word-1P');
  assert.equal(ads.totp?.secret, 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
  assert.deepEqual(bank.origins, ['https://bank.example.com']);
  assert.equal(bank.password, OP_PW);
  assert.equal(bank.username, 'klant123');
  assert.equal(bank.totp, null);
  // older 1Password apps: Website / One-time password
  assert.equal(detectFormat(['Title', 'Website', 'Username', 'Password', 'One-time password', 'Notes']).id, '1password');
});

test('Chrome: BOM + CRLF, android app rows skipped, login without username kept', () => {
  const { format, candidates } = parseExport(CHROME);
  assert.equal(format.id, 'chrome');
  assert.equal(format.label, 'Chrome of Edge');
  assert.equal(candidates.length, 3);
  const [shop, app, forum] = candidates;
  assert.deepEqual(shop.origins, ['https://shop.example.nl']);
  assert.equal(shop.password, CHROME_PW);
  assert.equal(shop.label, 'shop.example.nl');
  assert.match(app.skip!, /app/);
  assert.equal(forum.username, '');
  assert.equal(forum.skip, undefined);
});

test('Edge: Chromium export without note column, comma inside a quoted URL', () => {
  const { format, candidates } = parseExport(EDGE);
  assert.equal(format.id, 'chrome');
  assert.deepEqual(candidates[0].origins, ['https://accounts.example.com']);
  assert.equal(candidates[0].password, 'Edge-pw-3');
  assert.equal(candidates[1].password, 'Edge-pw-dup');
});

test('Firefox and other CSV files: header sniffing, semicolons, http marked as not encrypted', () => {
  const ff = parseExport(FIREFOX);
  assert.equal(ff.format.id, 'firefox');
  assert.deepEqual(ff.candidates[0].origins, ['https://forum.example.org']);
  assert.equal(ff.candidates[0].label, 'forum.example.org');
  const gen = parseExport(GENERIC);
  assert.equal(gen.format.id, 'generic');
  assert.equal(gen.candidates[0].label, 'Intranet');
  assert.deepEqual(gen.candidates[0].origins, ['https://intranet.example.nl']);
  assert.equal(gen.candidates[0].username, 'r.de.vries');
  assert.equal(gen.candidates[1].insecure, true);
  // not a password export, or not CSV at all: a clear message
  assert.throws(() => parseExport('voornaam,achternaam\nJan,Jansen'), /herken ik niet/);
  assert.throws(() => parseExport('{"encrypted":false,"items":[]}'), /JSON-export/);
  assert.throws(() => parseExport('PK\u0003\u0004zipdata'), /geen CSV-bestand/);
  assert.throws(() => parseExport('   '), /leeg/);
  assert.throws(() => parseExport('name,url,username,password\n'), /geen logins/);
  // a cell that is not a web address is skipped without repeating it
  const odd = toCandidates(detectFormat(['url', 'password']), [['https://u:Geheim-In-Url@x.nl', 'pw-1'], ['niet een adres', 'pw-2'], ['*.example.nl', 'pw-3']]);
  for (const c of odd) assert.equal(c.skip, 'Geen bruikbaar webadres');
});

// ---------------- API: preview → choose → import, secrets never come back ----------------

test('vault import API: preview without passwords, duplicates marked, chosen rows encrypted, summary with reasons', async () => {
  const t = await startTestApp({ mode: 'server' });
  try {
    const logs: string[] = [];
    const log: any = t.app.ctx.log;
    for (const k of ['info', 'warn', 'error']) {
      const orig = log[k].bind(log);
      log[k] = (...a: any[]) => (logs.push(a.map((x) => (typeof x === 'string' ? x : x instanceof Error ? `${x.message} ${x.stack}` : JSON.stringify(x))).join(' ')), orig(...a));
    }
    const events: string[] = [];
    const emit = t.app.ctx.events.emit.bind(t.app.ctx.events);
    (t.app.ctx.events as any).emit = (userId: string, type: string, data: any) => (events.push(type + ' ' + JSON.stringify(data)), emit(userId, type, data));

    // already in the vault: the shop login (same site and account, other case)
    await t.api('POST', '/computers/vault', { label: 'Winkel', origins: 'https://shop.example.nl', username: 'Sanne@Example.nl', password: 'oud-wachtwoord' });

    const ALL_SECRETS = [BW_PW, 'Bw-steam-pw', 'app-pw-123', 'JBSWY3DPEHPK3PXP', 'P@ss;word-1P', OP_PW, CHROME_PW, 'Forum-pw-2', 'Edge-pw-3'];

    // --- Bitwarden: preview
    const pv = await t.api('POST', '/computers/vault/import/preview', { csv: BITWARDEN });
    assert.equal(pv.format.label, 'Bitwarden');
    assert.match(pv.handle, /^vi_/);
    assert.equal(pv.room, 499);
    assert.deepEqual(
      pv.rows.map((r: any) => [r.label, r.status]),
      [
        ['Webwinkel', 'duplicate'],
        ['Recepten', 'skip'],
        ['Telefoonapp', 'skip'],
        ['Zonder wachtwoord', 'skip'],
        ['Steam', 'new'],
      ],
    );
    assert.equal(pv.rows[0].reason, 'Staat al in de kluis');
    assert.equal(pv.rows[4].username, 'gamer');
    assert.deepEqual(pv.rows[4].origins, ['https://store.steampowered.com']);
    const pvJson = JSON.stringify(pv);
    for (const s of ALL_SECRETS) assert.ok(!pvJson.includes(s), `preview never contains ${s}`);
    assert.ok(!('password' in pv.rows[4]) && !('totp' in pv.rows[4]));
    // nothing stored yet
    assert.equal((await t.api('GET', '/computers/vault')).length, 1);

    // another user cannot use this preview; a paired phone cannot import at all
    const other = t.app.ctx.auth.createUser({ name: 'Lid', email: 'lid@example.nl', password: 'wachtwoord123', role: 'member' });
    const otherTok = t.app.ctx.auth.createSession(other.id, 'web').token;
    assert.equal((await raw(t, otherTok, 'POST', '/computers/vault/import', { handle: pv.handle, rows: [4] })).status, 404);
    const owner = t.app.ctx.auth.owner()!;
    const phone = t.app.ctx.auth.createSession(owner.id, 'device', 'Telefoon', 365).token;
    assert.equal((await raw(t, phone, 'POST', '/computers/vault/import/preview', { csv: BITWARDEN })).status, 403);
    assert.equal((await raw(t, phone, 'POST', '/computers/vault/import', { handle: pv.handle, rows: [4] })).status, 403);

    // choosing a duplicate or a skipped row does not import it
    const res = await t.api('POST', '/computers/vault/import', { handle: pv.handle, rows: [0, 1, 4] });
    assert.equal(res.imported, 1);
    assert.deepEqual(
      res.skipped.map((s: any) => [s.label, s.reason]),
      [
        ['Webwinkel', 'Staat al in de kluis'],
        ['Recepten', 'Geen login (een notitie, kaart of identiteit)'],
        ['Telefoonapp', 'Alleen voor een app, geen website'],
        ['Zonder wachtwoord', 'Geen wachtwoord'],
      ],
    );
    // a preview works once
    const again = await raw(t, t.token, 'POST', '/computers/vault/import', { handle: pv.handle, rows: [4] });
    assert.equal(again.status, 404);
    assert.match(again.body.error, /verlopen of al gebruikt/);

    // --- 1Password + Chrome + Edge: all rows, not chosen ones reported
    const op = await t.api('POST', '/computers/vault/import/preview', { csv: ONEPASSWORD });
    assert.equal(op.format.label, '1Password');
    assert.equal(op.rows[0].has_totp, true);
    const opRes = await t.api('POST', '/computers/vault/import', { handle: op.handle, rows: [0] });
    assert.equal(opRes.imported, 1);
    assert.deepEqual(opRes.skipped, [{ line: 3, label: 'Bank', reason: 'Niet gekozen' }]);
    const ch = await t.api('POST', '/computers/vault/import/preview', { csv: CHROME });
    assert.equal(ch.format.label, 'Chrome of Edge');
    assert.equal(ch.rows[0].status, 'duplicate', 'shop login already in the vault');
    assert.equal((await t.api('POST', '/computers/vault/import', { handle: ch.handle, rows: ch.rows.map((r: any) => r.index) })).imported, 1);
    const ed = await t.api('POST', '/computers/vault/import/preview', { csv: EDGE });
    assert.deepEqual(
      ed.rows.map((r: any) => [r.status, r.reason]),
      [
        ['new', undefined],
        ['duplicate', 'Staat twee keer in het bestand'],
      ],
    );
    // a newer preview replaces the older one of the same user
    const ed2 = await t.api('POST', '/computers/vault/import/preview', { csv: EDGE });
    assert.equal((await raw(t, t.token, 'POST', '/computers/vault/import', { handle: ed.handle, rows: [0] })).status, 404);
    assert.equal((await t.api('POST', '/computers/vault/import', { handle: ed2.handle, rows: [0] })).imported, 1);

    // --- what is stored: encrypted, write-only, all bots may ask (the owner approves every use)
    const list = await t.api('GET', '/computers/vault');
    assert.equal(list.length, 5);
    const listJson = JSON.stringify(list);
    for (const s of ALL_SECRETS) assert.ok(!listJson.includes(s), `list never contains ${s}`);
    const steam = list.find((e: any) => e.label === 'Steam');
    assert.equal(steam.has_password, true);
    assert.equal(steam.has_totp, false);
    assert.deepEqual(steam.agent_ids, []);
    const ads = list.find((e: any) => e.label === 'Google Ads');
    assert.equal(ads.has_totp, true);
    assert.equal(ads.username, 'sanne@example.nl');
    const vault = svcOf(t).vault!;
    assert.equal(vault.credentials(vault.row(ads.id)!).password, 'P@ss;word-1P');
    assert.equal(vault.credentials(vault.row(steam.id)!).password, 'Bw-steam-pw');
    for (const e of list) {
      const r = t.app.ctx.store.get<any>('vault_logins', e.id);
      assert.match(r.password_enc, /^v1:/);
    }
    const db = dumpDb(t);
    for (const s of [...ALL_SECRETS, 'oud-wachtwoord']) assert.ok(!db.includes(s), `${s} not in the database in plain text`);
    // not on disk at all: no file in the data dir (database, WAL, logs) holds a password, and no CSV was saved
    const files = filesUnder(t.dir);
    for (const f of files) for (const s of ALL_SECRETS) assert.ok(!f.data.includes(Buffer.from(s)), `${s} not in ${f.file}`);
    assert.ok(!files.some((f) => f.file.toLowerCase().endsWith('.csv')));
    // audit and events: only counts and the format
    const audit = t.app.ctx.store.all<any>("SELECT * FROM audit WHERE kind = 'vault.imported'");
    assert.equal(audit.length, 4);
    const auditJson = JSON.stringify(audit);
    assert.ok(!auditJson.includes('sanne@example.nl') && !auditJson.includes('gamer'));
    for (const s of ALL_SECRETS) assert.ok(!auditJson.includes(s));
    assert.ok(events.some((e) => e.startsWith('vault.updated {"imported":1}')));
    for (const s of ALL_SECRETS) assert.ok(!events.join('\n').includes(s), `event never contains ${s}`);
    for (const s of ALL_SECRETS) assert.ok(!logs.join('\n').includes(s), `log never contains ${s}`);

    // --- limits and wrong files: clear messages, never a piece of the file
    const big = await raw(t, t.token, 'POST', '/computers/vault/import/preview', { csv: 'url,password\n' + 'x'.repeat(2 * 1024 * 1024 + 10) });
    assert.equal(big.status, 400);
    assert.match(big.body.error, /te groot/);
    const many = await raw(t, t.token, 'POST', '/computers/vault/import/preview', { csv: 'url,password\n' + Array.from({ length: 2001 }, (_, i) => `https://s${i}.example.nl,pw${i}`).join('\n') });
    assert.equal(many.status, 400);
    assert.match(many.body.error, /meer dan 2000 logins/);
    const json = await raw(t, t.token, 'POST', '/computers/vault/import/preview', { csv: '{"items":[{"login":{"password":"Json-Geheim"}}]}' });
    assert.match(json.body.error, /JSON-export/);
    assert.ok(!json.body.error.includes('Json-Geheim'));
    const broken = await raw(t, t.token, 'POST', '/computers/vault/import/preview', { csv: 'name,url,username,password\nx,https://x.nl,u,"Kapot-Geheim\n' });
    assert.equal(broken.status, 400);
    assert.ok(!broken.body.error.includes('Kapot-Geheim'));
    assert.equal((await raw(t, t.token, 'POST', '/computers/vault/import/preview', {})).status, 400);

    // --- a full vault: what does not fit is reported, not silently dropped
    t.app.ctx.store.tx(() => {
      for (let i = 0; i < 494; i++) t.app.ctx.store.insert('vault_logins', { id: `vl_fill${i}`, user_id: owner.id, label: `Vul ${i}`, origins: [`https://fill${i}.example.nl`], username_enc: null, password_enc: null, totp_enc: null, agent_ids: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_used_at: null });
    });
    const gen = await t.api('POST', '/computers/vault/import/preview', { csv: GENERIC });
    assert.equal(gen.room, 1);
    const genRes = await t.api('POST', '/computers/vault/import', { handle: gen.handle, rows: [0, 1] });
    assert.equal(genRes.imported, 1);
    assert.deepEqual(genRes.skipped, [{ line: 3, label: 'Router', reason: 'De kluis is vol (maximaal 500 logins)' }]);
  } finally {
    await t.close();
  }
});
