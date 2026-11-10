import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { collapseDuplicates, describeAudit, shortPath, type AuditRow } from '../ui/src/shell/auditText.js';
import { startTestApp } from './helpers.js';

/**
 * Instellingen › Beveiliging › Logboek (A-84, Q-03): every event is one plain Dutch sentence — who, what, and who
 * approved it — without raw kinds, JSON, ids, `null` or technical tool ids.
 */

const ROOT = path.resolve(import.meta.dirname, '..', 'server');

/** Kinds written with a computed suffix ('autoreview.' + verdict, `memory.${op}` …) and their possible values. */
const DYNAMIC: Record<string, string[]> = {
  'autoreview.': ['allow', 'ask'],
  'approval.': ['approved', 'denied'],
  'memory.': ['archive', 'restore', 'trash', 'pin', 'unpin', 'confirm', 'share', 'move', 'update'],
  'team.': ['delegate', 'message'],
  'usage.limit_': ['warn', 'limit'],
  'desktop.': ['click', 'double_click', 'triple_click', 'type', 'key', 'scroll', 'drag'],
  'rehearsal.': ['applied', 'discarded'],
};

/** Every audit kind in the server source: the string literals before the data argument of each `audit(` call. */
function serverKinds(): string[] {
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) {
        const src = fs.readFileSync(p, 'utf8');
        for (const m of src.matchAll(/\baudit\(/g)) {
          const head = src.slice(m.index! + 6, m.index! + 400);
          // Up to the data argument (an object literal) or the end of the call.
          const args = head.slice(0, Math.min(...[head.indexOf('{'), head.indexOf(');')].filter((i) => i >= 0), head.length));
          for (const s of args.matchAll(/['`]([a-z][a-z_]*(?:\.[a-z_-]*)+)(?:\$\{[^}]*\})?['`]/g)) {
            const k = s[1];
            if (DYNAMIC[k]) for (const v of DYNAMIC[k]) out.add(k + v);
            else if (!k.endsWith('.')) out.add(k);
          }
        }
      }
    }
  };
  walk(ROOT);
  return [...out].sort();
}

const ID = '0123456789abcdef012345';
const SAMPLES: any[] = [
  {},
  {
    name: null,
    tool: 'claude-code:Write',
    summary: 'Bestand schrijven: notities/test.txt',
    path: `C:\\Users\\x\\AppData\\Roaming\\TeamBot\\workspaces\\ag_${ID}\\notities\\test.txt`,
    id: `apr_${ID}`,
    proposalId: `prop_${ID}`,
    trigger: `trg_${ID}`,
    from: 'Codeerhulp',
    to: 'Schrijver',
    reason: null,
    fields: ['instructions', 'model'],
    host: 'example.org',
    adapter: 'telegram',
    cli: 'claude-code',
    kind: 'claude-code',
    provider: 'hetzner',
    allowed: false,
    asked: true,
    count: 3,
  },
];

test('every audit kind the server writes has a plain sentence (no raw kind, ids, null or JSON)', () => {
  const kinds = serverKinds();
  assert.ok(kinds.length > 150, `expected the full list of audit kinds, found ${kinds.length}`);
  const bad: string[] = [];
  for (const kind of kinds) {
    for (const data of SAMPLES) {
      for (const agent of [null, 'Codeerhulp']) {
        const row: AuditRow = { id: 1, user_id: 'usr_me', agent_id: agent ? `ag_${ID}` : null, agent_name: agent, kind, data, created_at: new Date().toISOString() };
        const e = describeAudit(row, { meId: 'usr_me' });
        const s = e.sentence + ' ' + (e.approval?.text || '');
        const why =
          e.generic ? 'generic fallback'
          : s.includes(kind) ? 'raw kind'
          : /\b(null|undefined|NaN)\b|\[object|[{}]/.test(s) ? 'null/JSON'
          : /\b[a-z]{1,6}_[0-9a-f]{12,}\b/.test(s) ? 'id'
          : /claude-code:|\{h\}|\{is\}/.test(s) ? 'technical'
          : !/^[A-ZÀ-Ý“]/.test(e.sentence) || !e.sentence.endsWith('.') ? 'not a sentence'
          : '';
        if (why) bad.push(`${kind} (${why}): ${e.sentence}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test('who, what and who approved it', () => {
  const at = new Date().toISOString();
  const row = (kind: string, data: any, agent?: string): AuditRow => ({ id: 1, user_id: 'usr_me', agent_id: agent ? 'ag_x' : null, agent_name: agent ?? null, kind, data, created_at: at });
  const ctx = { meId: 'usr_me' };

  const perm = describeAudit(row('cli.permission', { tool: 'claude-code:Write', summary: 'Bestand schrijven: notities/test.txt', allowed: true, asked: true, reason: null }, 'Codeerhulp'), ctx);
  assert.equal(perm.sentence, 'Codeerhulp wilde een bestand wijzigen: notities/test.txt.');
  assert.deepEqual(perm.approval, { text: 'Goedgekeurd door jou', tone: 'ok' });
  assert.equal(perm.category, 'approvals');

  const auto = describeAudit(row('cli.permission', { tool: 'claude-code:Bash', summary: 'Opdracht: npm test', allowed: true, auto: true }, 'Codeerhulp'), ctx);
  assert.equal(auto.approval?.text, 'Automatisch toegestaan door het toegangsniveau');

  const call = describeAudit(row('tool.call', { tool: 'write_file', summary: 'Bestand schrijven: e2e.txt', error: false, denied: false, risk: 'write', asked: true, approved: true, by: 'usr_me' }, 'Codeerhulp'), ctx);
  assert.equal(call.sentence, 'Codeerhulp schreef een bestand: e2e.txt.');
  assert.equal(call.approval?.text, 'Goedgekeurd door jou');
  const refused = describeAudit(row('tool.call', { tool: 'delete_file', summary: 'Bestand verwijderen: a.txt', error: true, denied: true, risk: 'danger', asked: true, by: 'usr_me' }, 'Codeerhulp'), ctx);
  assert.equal(refused.sentence, 'Codeerhulp wilde een bestand verwijderen: a.txt.');
  assert.equal(refused.approval?.text, 'Geweigerd door jou');
  const read = describeAudit(row('tool.call', { tool: 'web_search', summary: 'Zoeken: weer', error: false, denied: false, risk: 'read' }, 'Codeerhulp'), ctx);
  assert.equal(read.approval, undefined, 'reading needs no approval line');
  // Acceptance round 3: "Schrijver vergat iets: m:p968gz" — a memory code means nothing in the log.
  const forgot = describeAudit(row('tool.call', { tool: 'memory_forget', summary: 'Vergeten: m:p968gz', error: false, denied: false, risk: 'write' }, 'Schrijver'), ctx);
  assert.doesNotMatch(forgot.sentence, /m:p968gz/);
  assert.match(forgot.sentence, /^Schrijver vergat iets\.?$/);

  const ok = describeAudit(row('approval.approved', { id: 'apr_0123456789abcdef0123', tool: 'write_file', summary: 'Bestand schrijven: notities/test.txt' }, 'Codeerhulp'), ctx);
  assert.equal(ok.sentence, 'Jij hebt Codeerhulp toestemming gegeven: notities/test.txt.');

  const created = describeAudit(row('agent.created', { name: 'Schrijver' }, 'Schrijver'), ctx);
  assert.equal(created.sentence, 'Jij hebt de bot “Schrijver” gemaakt.');
  const deleted = describeAudit(row('agent.deleted', { name: 'Oud', filesDeleted: false }), ctx);
  assert.equal(deleted.sentence, 'Jij hebt de bot “Oud” verwijderd; de bestanden in de werkmap bleven bewaard.');
  assert.equal(deleted.tone, 'danger');

  const file = describeAudit(row('file.write', { path: 'C:\\Users\\r\\AppData\\Roaming\\TeamBot\\workspaces\\ag_0123456789abcdef012345\\notities\\test.txt', bytes: 4 }, 'Codeerhulp'), ctx);
  assert.equal(file.sentence, 'Codeerhulp heeft een bestand geschreven: notities/test.txt.');

  const ask = describeAudit(row('team.ask', { from: 'Lead', to: 'Schrijver', delegationId: 'dlg_0123456789abcdef0123', message: 'Een herfstzin graag' }, 'Lead'), ctx);
  assert.equal(ask.sentence, 'Lead heeft Schrijver iets gevraagd: Een herfstzin graag.');

  const secret = describeAudit(row('secret.set', { name: 'search_key' }), ctx);
  assert.equal(secret.category, 'access');
  assert.match(secret.sentence, /^Jij hebt het geheim “search_key” opgeslagen/);

  // A deleted bot: the name from the row's data, else "een bot" (never the id).
  const gone = describeAudit({ ...row('file.write', { path: 'x.txt' }), agent_id: 'ag_0123456789abcdef012345', agent_name: null }, ctx);
  assert.equal(gone.sentence, 'Een bot heeft een bestand geschreven: x.txt.');
  const named = describeAudit({ ...row('file.write', { path: 'x.txt' }), agent_id: 'ag_1', agent_name: null }, { agentName: (id) => (id === 'ag_1' ? 'Mila' : undefined) });
  assert.equal(named.actor, 'Mila');
});

test('one action, one line: a file write next to its tool call is shown once', () => {
  const at = '2026-11-07T10:00:00.000Z';
  const later = '2026-11-07T10:00:01.000Z';
  const rows: AuditRow[] = [
    { id: 3, user_id: 'u', agent_id: 'ag_1', kind: 'tool.call', data: { tool: 'write_file', summary: 'Schrijven: a.txt (5 tekens)', asked: true, approved: true }, created_at: later },
    { id: 2, user_id: 'u', agent_id: 'ag_1', kind: 'file.write', data: { path: 'C:\\x\\workspaces\\ag_1\\a.txt' }, created_at: at },
    { id: 1, user_id: 'u', agent_id: 'ag_1', kind: 'file.write', data: { path: 'C:\\x\\workspaces\\ag_1\\b.txt' }, created_at: at },
  ];
  assert.deepEqual(collapseDuplicates(rows).map((r) => r.id), [3, 1]);
});

test('paths are shown relative to the work folder', () => {
  assert.equal(shortPath('C:\\Users\\r\\AppData\\Roaming\\TeamBot\\workspaces\\ag_0123456789abcdef012345\\uploads\\a1b2c3-plan.pdf'), 'uploads/plan.pdf');
  assert.equal(shortPath('/home/r/.local/share/teambot/workspaces/ag_0123456789abcdef012345/src/app.ts'), 'src/app.ts');
  assert.equal(shortPath('C:\\Users\\r\\Documents\\Projecten\\klant\\offerte.docx'), '…/Projecten/klant/offerte.docx');
  assert.equal(shortPath(null), '');
});

test('GET /audit pages with limit and before, and names the bot', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent({ name: 'Logbot' });
    const b = await t.agent({ name: 'Weg' });
    await t.api('PUT', '/secrets/test_key', { value: 'geheim-123' });
    await t.api('DELETE', `/agents/${b.id}`);
    const all = await t.api('GET', '/audit');
    assert.ok(all.length >= 4);
    const first = await t.api('GET', '/audit?limit=2');
    assert.equal(first.length, 2);
    const next = await t.api('GET', `/audit?limit=2&before=${first[1].id}`);
    assert.equal(next.length, 2);
    assert.ok(next[0].id < first[1].id);
    const created = all.find((r: any) => r.kind === 'agent.created' && r.agent_id === a.id);
    assert.equal(created.agent_name, 'Logbot');
    const deleted = all.find((r: any) => r.kind === 'agent.deleted');
    assert.equal(deleted.agent_name, null, 'a deleted bot has no current name');
    assert.equal(deleted.data.name, 'Weg');
    assert.ok(!JSON.stringify(all).includes('geheim-123'), 'secret values never reach the log');
    const capped = await t.api('GET', '/audit?limit=100000');
    assert.equal(capped.length, all.length);
    const one = await t.api('GET', `/audit?agentId=${a.id}`);
    assert.ok(one.every((r: any) => r.agent_id === a.id));
  } finally {
    await t.close();
  }
});
