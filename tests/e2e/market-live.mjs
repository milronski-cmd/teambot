// LIVE test of the internet marketplace against the real internet (MCP Registry, skills.sh, GitHub), in a temporary
// TeamBot data folder (never your own data). Installs 2 skills and 2 MCP servers, uses one of each in a real bot run,
// then updates and uninstalls them, and checks that browsing still works offline from the cache.
//   OPENAI_KEY_FILE=<file with an OpenAI key> npm run market:live
// Without OPENAI_KEY_FILE the bot run is skipped. The npm server needs npx on PATH. Costs a cent or two on the key.
import fs from 'node:fs';

process.env.TEAMBOT_SKILL_COLLECTIONS ??= 'anthropics/skills,mattpocock/skills,obra/superpowers,openai/skills,remotion-dev/skills';
const KEY_FILE = process.env.OPENAI_KEY_FILE;
const MODEL = process.env.MARKET_LIVE_MODEL || 'gpt-4.1-mini';

const { startTestApp } = await import('../helpers.ts');
const results = [];
const check = (name, ok, detail = '') => {
  results.push(!!ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const t = await startTestApp();
const q = (o) => new URLSearchParams(o).toString();
try {
  // ---------------------------------------------------------------- skills
  const list = await t.api('GET', '/skills/web/skills?budget=20000');
  check('internetskills geïndexeerd uit GitHub-collecties', list.items.length > 20, `${list.items.length} skills, wacht nog op: ${list.pending.join(', ') || '-'}`);
  const restricted = list.items.find((i) => i.license.status === 'restricted');
  const unknown = list.items.find((i) => i.license.status === 'unknown' && !i.partial);
  check('licenties per skill herkend', list.items.some((i) => i.license.status === 'open'), `open ${list.items.filter((i) => i.license.status === 'open').length}, beperkt ${list.items.filter((i) => i.license.status === 'restricted').length}, onbekend ${list.items.filter((i) => i.license.status === 'unknown').length}`);
  if (restricted) await t.api('POST', '/skills/web/install', { repo: restricted.repo, path: restricted.path }).then(() => check('beperkende licentie geweigerd', false), (e) => check('beperkende licentie geweigerd', /403/.test(e.message), `${restricted.id} (${restricted.license.label})`));
  if (unknown) await t.api('POST', '/skills/web/install', { repo: unknown.repo, path: unknown.path }).then(() => check('skill zonder licentie geweigerd', false), (e) => check('skill zonder licentie geweigerd', /403/.test(e.message), unknown.id));

  const sh = await t.api('GET', `/skills/web/skills?${q({ q: 'grill-me' })}`);
  const fromSh = sh.items.find((i) => i.installs && /mattpocock\/skills/.test(i.repo || ''));
  check('skills.sh-zoekresultaat met installaties', !!fromSh, fromSh ? `${fromSh.id}: ${fromSh.installs} installaties` : sh.skillsSh.error || 'niets');

  const agent = await t.agent({ name: 'MarktBot' });
  const installSkill = async (body, label) => {
    const detail = await t.api('GET', `/skills/web/item?${q(body)}`);
    const pv = await t.api('POST', '/skills/web/install', body);
    const c = pv.candidates[0];
    const r = await t.api('POST', '/skills/import/commit', { stagingId: pv.stagingId, enableFor: [agent.id], acknowledge: c.needsAcknowledge, confirmPermissions: true });
    const res = r.results[0];
    check(`skill geïnstalleerd: ${label}`, ['created', 'updated', 'unchanged'].includes(res.status), `${res.status}, licentie ${detail.license.label}, scan ${detail.scan.level}, ${detail.files.length} bestanden`);
    return { detail, skillId: res.skillId };
  };
  const a = await installSkill({ repo: 'anthropics/skills', path: 'skills/frontend-design' }, 'anthropics/skills · frontend-design');
  const b = await installSkill(fromSh ? { source: 'mattpocock/skills', skillId: 'grill-me' } : { repo: 'obra/superpowers', path: 'skills/brainstorming' }, fromSh ? 'mattpocock/skills · grill-me (via skills.sh)' : 'obra/superpowers · brainstorming');
  const mine = await t.api('GET', '/skills');
  check('skills staan in Mijn skills met bron', mine.filter((s) => s.catalogRef?.startsWith('github/')).length === 2, mine.map((s) => s.catalogRef).join(', '));
  const after = await t.api('GET', '/skills/web/skills?' + q({ repo: 'anthropics/skills' }));
  check('marktplaats toont “geïnstalleerd”', after.items.some((i) => i.path === 'skills/frontend-design' && i.installed));

  // ---------------------------------------------------------------- apps
  const featured = await t.api('GET', '/mcp/registry/servers');
  check('MCP-register: aanbevolen servers geladen', featured.items.length >= 5, featured.items.map((i) => i.name).slice(0, 6).join(', '));
  const found = await t.api('GET', `/mcp/registry/servers?${q({ q: 'microsoft-learn' })}`);
  const learn = found.items.find((i) => i.name === 'com.microsoft/microsoft-learn-mcp');
  check('MCP-register: zoeken', !!learn, `${found.items.length} resultaten`);
  const learnDetail = await t.api('GET', `/mcp/registry/server?${q({ name: 'com.microsoft/microsoft-learn-mcp' })}`);
  const remoteOpt = learnDetail.options.find((o) => o.kind === 'remote' && o.supported);
  const e1 = await t.api('POST', '/mcp/registry/entry', { name: learnDetail.name, version: learnDetail.version, option: remoteOpt.key, inputs: {} });
  const c1 = await t.api('POST', '/mcp/connections', { registry: e1.registry, agentIds: [agent.id] });
  const t1 = await t.api('POST', `/mcp/connections/${c1.id}/test`, {});
  check('remote server uit het register gekoppeld + leestest', t1.ok, `${t1.connection?.counts?.total ?? 0} tools via ${c1.url}`);

  const ctx7 = await t.api('GET', `/mcp/registry/server?${q({ name: 'io.github.upstash/context7' })}`);
  const npmOpt = ctx7.options.find((o) => o.kind === 'npm' && o.supported);
  const e2 = await t.api('POST', '/mcp/registry/entry', { name: ctx7.name, version: ctx7.version, option: npmOpt.key, inputs: {} });
  check('npm-optie: opdracht uit het register', e2.entry.command === 'npx' && e2.entry.args.join(' ').includes('@upstash/context7-mcp@'), `${e2.entry.command} ${e2.entry.args.join(' ')}`);
  let c2 = await t.api('POST', '/mcp/connections', { registry: e2.registry });
  const blocked = await t.api('POST', `/mcp/connections/${c2.id}/test`, {});
  check('stdio start niet zonder akkoord van de eigenaar', !blocked.ok && /vertrouw/i.test(blocked.error || ''), blocked.error);
  c2 = await t.api('PATCH', `/mcp/connections/${c2.id}`, { trust_command: true, command: c2.command, args: c2.args });
  const t2 = await t.api('POST', `/mcp/connections/${c2.id}/test`, {});
  check('npm-server uit het register (npx) gekoppeld + leestest', t2.ok, t2.ok ? `${t2.connection.counts.total} tools` : t2.error);

  // ---------------------------------------------------------------- a real bot run
  if (KEY_FILE && fs.existsSync(KEY_FILE)) {
    const p = await t.api('POST', '/providers', { kind: 'openai', apiKey: fs.readFileSync(KEY_FILE, 'utf8').trim() });
    await t.api('PATCH', `/agents/${agent.id}`, { provider_id: p.id, model: MODEL, access_mode: 'auto' });
    const th = await t.api('POST', '/threads', { agentId: agent.id });
    const msgs = await t.say(th.id, 'Laad eerst je skill "frontend-design" met skill_load en noem in één zin het belangrijkste principe eruit. Zoek daarna met de Microsoft Learn-app (mcp-tool) naar "Azure Functions Python quickstart" en geef de titel van het eerste resultaat. Antwoord kort in het Nederlands.', 180_000);
    const names = msgs.flatMap((m) => (m.parts?.toolCalls || []).map((c) => c.name)).join(', ');
    check('bot gebruikte de skill (skill_load)', /skill_load/.test(names), names);
    check('bot gebruikte de connector (mcp_…)', /mcp_/.test(names), names);
    const last = msgs.filter((m) => m.role === 'assistant').pop();
    console.log('   antwoord:', String(last?.content || '').slice(0, 300).replace(/\s+/g, ' '));
  } else console.log('• bot-run overgeslagen (geen OPENAI_KEY_FILE)');

  // ---------------------------------------------------------------- updates
  t.app.ctx.store.update('mcp_connections', c1.id, { registry: { ...t.app.ctx.store.get('mcp_connections', c1.id).registry, version: '0.0.1' } });
  const upd = await t.api('POST', '/mcp/registry/check-updates', {});
  check('update in het register gedetecteerd', upd.updates.some((u) => u.id === c1.id), upd.updates.map((u) => `${u.display}: ${u.version} → ${u.latest}`).join(', '));
  const ur = await t.api('POST', `/mcp/connections/${c1.id}/registry-update`, {});
  check('connector bijgewerkt naar de registerversie', ur.ok && ur.to === learnDetail.version, `${ur.from} → ${ur.to}; leestest opnieuw nodig: ${!ur.connection.verified_at}`);

  await t.api('PUT', `/skills/${a.skillId}/content`, { skillMd: a.detail.skillMd + '\n\nLokale wijziging.\n' });
  const changed = (await t.api('GET', '/skills')).find((s) => s.id === a.skillId);
  check('skill: eigen wijziging is geen update (bronversie staat al in de versies)', !changed.catalogUpdate, JSON.stringify(changed.catalogUpdate));
  const re = await t.api('POST', '/skills/web/install', { repo: 'anthropics/skills', path: 'skills/frontend-design' });
  const rr = await t.api('POST', '/skills/import/commit', { stagingId: re.stagingId, confirmPermissions: true, acknowledge: true });
  check('skill teruggezet op de bronversie', rr.results[0].status === 'updated', rr.results[0].status);

  // ---------------------------------------------------------------- offline from cache
  process.env.TEAMBOT_OFFLINE = '1';
  const off1 = await t.api('GET', `/mcp/registry/servers?${q({ q: 'microsoft-learn' })}`);
  const off2 = await t.api('GET', '/skills/web/skills');
  check('offline: register en skills uit de cache', off1.items.length > 0 && off2.items.length > 0, `${off1.items.length} apps, ${off2.items.length} skills, verouderd: ${off1.stale || off2.stale}`);
  delete process.env.TEAMBOT_OFFLINE;

  // ---------------------------------------------------------------- uninstall
  for (const id of [a.skillId, b.skillId]) await t.api('DELETE', `/skills/${id}`);
  for (const id of [c1.id, c2.id]) await t.api('DELETE', `/mcp/connections/${id}`);
  check('verwijderd', !(await t.api('GET', '/skills')).length && !(await t.api('GET', '/mcp/connections')).length);
} catch (e) {
  check('onverwachte fout', false, e?.stack || String(e));
} finally {
  await t.close();
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} geslaagd`);
process.exit(failed ? 1 : 0);
