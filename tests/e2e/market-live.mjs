// LIVE test of the internet marketplace against the real internet (MCP Registry, skills.sh, GitHub search), in a temporary
// TeamBot data folder (never your own data). Installs 2 skills and 2 MCP servers, uses one of each in a real bot run,
// then updates and uninstalls them, and checks that browsing still works offline from the cache.
//   OPENAI_KEY_FILE=<file with an OpenAI key> npm run market:live
// Without OPENAI_KEY_FILE the bot run is skipped. The npm server needs npx on PATH. Costs a cent or two on the key.
import fs from 'node:fs';

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
  // ---------------------------------------------------------------- skills: everything public
  const list = await t.api('GET', '/skills/web/search');
  check('open zoeken: repositories op GitHub, meeste sterren eerst', list.github.items.length > 10, `${list.github.items.length} van ${list.github.total}${list.limit ? ` · ${list.limit.text}` : ''}`);
  check('open zoeken: losse skills uit skills.sh', (list.directory?.items.length || 0) > 10, `${list.directory?.items.length || 0} skills`);
  check('open zoeken: skills van ClawHub, met zijn eigen sterren en downloads', (list.clawhub?.items.length || 0) > 10, `${list.clawhub?.items.length || 0} skills${list.clawhub?.error ? ` · ${list.clawhub.error}` : ''}`);
  const sh = await t.api('GET', `/skills/web/search?${q({ q: 'grill-me' })}`);
  const fromSh = sh.directory?.items.find((i) => i.installs && i.repo === 'mattpocock/skills');
  check('skills.sh-zoekresultaat met installaties', !!fromSh, fromSh ? `${fromSh.id}: ${fromSh.installs} installaties` : sh.directory?.error || 'niets');

  const agent = await t.agent({ name: 'MarktBot' });
  const installSkill = async (id, label) => {
    const detail = await t.api('GET', `/skills/curated/item?${q({ id })}`);
    let r = await t.api('POST', '/skills/curated/install', { id });
    // Serious scan findings or a look-alike publisher: the click becomes a confirmation (confirmed here).
    const asked = !!r.staging;
    if (r.staging) r = (await t.api('POST', '/skills/import/commit', { stagingId: r.staging.stagingId, acknowledge: true, confirmPermissions: true })).results[0];
    check(`skill toegevoegd: ${label}`, ['created', 'installed', 'updated', 'unchanged'].includes(r.status), `${r.status}${asked ? ' (na bevestiging)' : ''}, ${detail.checked ? 'gecontroleerd' : 'niet gecontroleerd'}, commit ${String(detail.commit).slice(0, 7)}, licentie ${detail.licenseFound.spdx || 'niet gevonden'}, scan ${detail.scan.level}, ${detail.files.length} bestanden`);
    return { detail, skillId: r.skillId };
  };
  const a = await installSkill('github/anthropics/skills/frontend-design', 'anthropics/skills · frontend-design');
  const b = await installSkill(fromSh ? fromSh.id : 'github/obra/superpowers/skills/brainstorming', fromSh ? 'mattpocock/skills · grill-me (via skills.sh)' : 'obra/superpowers · brainstorming');
  const mine = await t.api('GET', '/skills');
  check('skills staan in Mijn skills met bron en vaste commit', mine.filter((s) => s.catalogRef?.startsWith('curated/') && s.source?.commit).length === 2, mine.map((s) => `${s.catalogRef}@${String(s.source?.commit).slice(0, 7)}`).join(', '));
  const after = await t.api('GET', `/skills/web/repo?${q({ repo: 'anthropics/skills' })}`);
  check('marktplaats toont “toegevoegd”', after.skills.some((i) => i.name === 'frontend-design' && i.installed));

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
  const rr = await t.api('POST', '/skills/curated/update', { skillId: a.skillId, commit: a.detail.commit, confirmPermissions: true, acknowledge: true });
  check('skill teruggezet op de bronversie', rr.status === 'updated', rr.status);

  // ---------------------------------------------------------------- offline from cache
  process.env.TEAMBOT_OFFLINE = '1';
  const off1 = await t.api('GET', `/mcp/registry/servers?${q({ q: 'microsoft-learn' })}`);
  const off2 = await t.api('GET', '/skills/web/search');
  check('offline: register en open zoeken uit de cache', off1.items.length > 0 && off2.github.items.length > 0, `${off1.items.length} apps, ${off2.github.items.length} repositories, verouderd: ${off1.stale || off2.github.stale}`);
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
