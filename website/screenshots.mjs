// npm run website:screenshots — real screenshots of TeamBot 0.4 for the website, made with an invented setup.
// Starts a TEMPORARY TeamBot (desktop mode) on 127.0.0.1:4811 (TEAMBOT_SHOTS_PORT to change it) with a temporary data
// folder, APPDATA and home folder, so nothing of this computer is read or changed: no real AI, no accounts, no
// OpenBot. A fake engine answers; two invented teams (Webshop and Bakkerij) with a main bot, tasks with proof, memory,
// a specialist with a knowledge base, routines, an example usage bar and an accent colour are created through the same
// API the app uses. Then it photographs (desktop 1280×800 @1.5x, phone 390×844 @2x) into website/src/img as WebP
// (encoded by the browser itself; no extra tools). Every request that is not to the local TeamBot is blocked.
// Hard time-out: 4 minutes. Needs a built UI: npm run build:ui
// Which of these files the site shows, and where, is set in website/src/shots.json (the "slots"). At the end this
// script lists every slot and whether its file was just made. After new screenshots, check the alt texts under
// shots.<slot> in nl.json and en.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const killer = setTimeout(() => {
  console.error('website:screenshots: time-out na 4 minuten');
  process.exit(2);
}, 240_000);
killer.unref();

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const out = path.join(here, 'src/img');
const PORT = Number(process.env.TEAMBOT_SHOTS_PORT || 4811);
if (PORT === 4747 || PORT === 4748) throw new Error('website:screenshots: poort 4747/4748 is van de echte TeamBot; kies een andere');

// Everything the server could read or write goes to a temporary folder (set before the server is imported).
const parentEnv = { ...process.env };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-site-shots-'));
const tmp = (p) => {
  const d = path.join(dir, p);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
Object.assign(process.env, {
  TEAMBOT_DATA: tmp('data'),
  APPDATA: tmp('appdata'),
  LOCALAPPDATA: tmp('localappdata'),
  USERPROFILE: tmp('home'),
  HOME: tmp('home'),
  TEAMBOT_OPENBOT_DIR: tmp('no-openbot'),
  TEAMBOT_OPENBOT_HOME: tmp('home'),
});

const require = createRequire(path.join(repo, 'package.json'));
const { chromium } = require('playwright-core');
const { createApp } = await import(pathToFileURL(path.join(repo, 'server/app.ts')).href);
const { encodeFace } = await import(pathToFileURL(path.join(repo, 'ui/src/lib/botface.ts')).href);
const step = (s) => console.log(`• ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(60);
  }
  return null;
}

const app = await createApp({ dataDir: process.env.TEAMBOT_DATA, port: PORT, host: '127.0.0.1', mode: 'desktop', quiet: true });
let browser;
try {
  const token = app.ctx.auth.ensureLocalOwner();
  const owner = app.ctx.auth.owner();
  const { store } = app.ctx;
  step(`tijdelijke TeamBot op ${app.url} (data in ${dir})`);

  // ---- fake engine: the main bot reads the team's tasks once, then answers (streamed) ----
  const REPLY =
    'Dit is de stand van vandaag:\n\n**Webshop**\n- Schrijver heeft de productteksten voor de wintercollectie af; het bewijs staat in de teammap.\n- De prijslijst staat op *te controleren*: er missen nog twee prijzen.\n\n**Bakkerij**\n- Boekhouder wacht op jouw akkoord voor één factuur.\n- Planner heeft het rooster voor volgende week klaargezet.\n\nZal ik Inkoper vragen de twee ontbrekende prijzen op te zoeken?';
  app.ctx.providers.registerKind({
    id: 'demo',
    label: 'Voorbeeldmodel',
    type: 'api',
    needsKey: false,
    description: 'Nep-model voor schermafbeeldingen',
    models: ['voorbeeld-1'],
    defaultModel: 'voorbeeld-1',
    create: () => ({
      kind: 'demo',
      async listModels() {
        return [{ id: 'voorbeeld-1' }];
      },
      async test() {
        return { ok: true, detail: 'demo' };
      },
      async chat(req, _signal, onEvent) {
        if (!req.messages.some((m) => m.role === 'tool'))
          return { text: '', toolCalls: [{ id: 'q1', name: 'team_query', args: { sql: "SELECT titel, eigenaar, status FROM taken WHERE status != 'klaar'" } }], usage: { input: 40, output: 12 }, stop: 'tool_use', model: req.model };
        for (const w of REPLY.match(/\S+\s*/g)) onEvent({ type: 'text', delta: w });
        return { text: REPLY, toolCalls: [], usage: { input: 120, output: 60 }, stop: 'end', model: req.model };
      },
    }),
  });
  const prov = app.ctx.providers.create(owner.id, { kind: 'demo', name: 'Voorbeeldmodel' });

  // ---- the invented teams (same figures as on the website) ----
  const BOTS = [
    { name: 'Baas', role: 'Hoofdbot: verdeelt het werk over de teams', team: 'Webshop', face: { shape: 'squircle', color: 'tangerine', eyes: 'bean', mouth: 'smile', extra: 'antenna', cheeks: true } },
    { name: 'Verkoper', role: 'Bestellingen en vragen van klanten', team: 'Webshop', face: { shape: 'egg', color: 'sky', eyes: 'look', mouth: 'smile', extra: 'sprout', cheeks: false } },
    { name: 'Schrijver', role: 'Productteksten en nieuwsbrief', team: 'Webshop', face: { shape: 'ghost', color: 'violet', eyes: 'bean', mouth: 'cat', extra: 'ears', cheeks: true } },
    { name: 'Inkoper', role: 'Specialist inkoop en prijzen', team: 'Webshop', face: { shape: 'drop', color: 'teal', eyes: 'happy', mouth: 'smile', extra: 'none', cheeks: true } },
    { name: 'Planner', role: 'Rooster en bestellingen voor de winkel', team: 'Bakkerij', face: { shape: 'pill', color: 'sun', eyes: 'visor', mouth: 'flat', extra: 'antenna', cheeks: false } },
    { name: 'Boekhouder', role: 'Facturen en uitgaven', team: 'Bakkerij', face: { shape: 'bell', color: 'mint', eyes: 'dot', mouth: 'smile', extra: 'none', cheeks: true } },
  ];
  const bots = {};
  BOTS.forEach((b, i) => {
    bots[b.name] = store.createAgent(owner.id, { name: b.name, role: b.role, avatar: encodeFace(b.face), provider_id: prov.id, model: 'voorbeeld-1', access_mode: 'ask', tool_groups: ['team', 'memory'], pinned: i === 0, sort: i });
  });

  const api = async (method, p, body) => {
    const res = await fetch(`${app.url}/api${p}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) throw new Error(`${method} ${p}: HTTP ${res.status} ${await res.text()}`);
    return res.json();
  };
  const soft = async (what, fn) => {
    try {
      return await fn();
    } catch (e) {
      step(`overgeslagen (${what}): ${e.message.slice(0, 160)}`);
      return null;
    }
  };

  // The first list call makes the default team with every bot in it: that becomes Webshop, then Bakkerij is added.
  const first = (await api('GET', '/teams'))[0];
  const webshop = await api('PATCH', `/teams/${first.id}`, { name: 'Webshop', color: '#0ea5e9' });
  const bakery = await api('POST', '/teams', { name: 'Bakkerij', color: '#f59e0b' });
  for (const b of BOTS.filter((x) => x.team === 'Bakkerij')) await api('PUT', `/teams/${bakery.id}/bots/${bots[b.name].id}`);
  await soft('hoofdbot', () => api('PUT', `/teams/main/${bots.Baas.id}`));
  step('twee verzonnen teams (Webshop, Bakkerij) met hoofdbot Baas');

  // ---- tasks with proof, one that waits for a check, one decision that waits for you ----
  const td = app.ctx.services.teamdata;
  await soft('taken Webshop', () =>
    td.write(
      owner.id,
      [
        {
          sql: 'INSERT INTO taken (titel, eigenaar, aangevraagd_door, status, resultaat, bewijs, klaar_als) VALUES (?,?,?,?,?,?,?), (?,?,?,?,?,?,?), (?,?,?,?,?,?,?), (?,?,?,?,?,?,?)',
          params: [
            'Productteksten wintercollectie', 'Schrijver', 'Baas', 'klaar', 'Twaalf teksten geschreven.', 'teammap/wintercollectie.md', 'Twaalf teksten in de teammap',
            'Prijslijst bijwerken', 'Inkoper', 'Baas', 'wacht_op_controle', 'Twee artikelen missen nog een prijs.', null, 'Elk artikel heeft een prijs',
            'Reacties op reviews beantwoorden', 'Verkoper', 'Baas', 'bezig', null, null, 'Alle reviews van deze week beantwoord',
            'Verzendkosten vergelijken', 'Inkoper', 'Baas', 'open', null, null, 'Overzicht van drie vervoerders',
          ],
        },
        { sql: 'INSERT INTO logboek (agent, wat, waarom, bewijs) VALUES (?,?,?,?)', params: ['Schrijver', 'Productteksten opgeslagen', 'taak wintercollectie', 'teammap/wintercollectie.md'] },
      ],
      webshop.id,
    ),
  );
  await soft('taken Bakkerij', () =>
    td.write(
      owner.id,
      [
        {
          sql: 'INSERT INTO taken (titel, eigenaar, aangevraagd_door, status, resultaat, bewijs, klaar_als) VALUES (?,?,?,?,?,?,?), (?,?,?,?,?,?,?)',
          params: [
            'Rooster volgende week', 'Planner', 'Baas', 'klaar', 'Rooster gedeeld.', 'teammap/rooster-week-47.pdf', 'Rooster in de teammap',
            'Factuur meelleverancier', 'Boekhouder', 'Baas', 'wacht_op_eigenaar', 'Wacht op jouw akkoord.', null, 'Factuur betaald of afgewezen',
          ],
        },
        { sql: 'INSERT INTO beslissingen (vraag, uitleg, opties, gevraagd_door) VALUES (?,?,?,?)', params: ['Factuur van Meelhandel Voorbeeld (€ 312) betalen?', 'Het bedrag klopt met de bestelling; vervaldatum is vrijdag.', '["Betalen (advies)", "Eerst navragen", "Niet betalen"]', 'Boekhouder'] },
      ],
      bakery.id,
    ),
  );

  // ---- memory: a few things about you and for the team ----
  const remember = (content, scope = 'about_you', extra = {}) => soft('geheugen', () => api('POST', '/memory/items', { content, scope, ...extra }));
  await remember('Je werkt het liefst ’s ochtends; plan overleg niet na 16:00.');
  await remember('Facturen gaan altijd vóór de 5e van de maand de deur uit.', 'shared');
  await remember('De webshop verkoopt handgemaakte kaarsen en zeep.', 'shared');
  await remember('Je wilt een samenvatting in drie punten, niet langer.');
  await remember('Nieuwe producten krijgen eerst een proefbatch van tien stuks.', 'shared');
  await remember('Retouren binnen 30 dagen zijn gratis.', 'shared');

  // ---- a specialist with a small knowledge base ----
  await soft('specialist', async () => {
    await api('PUT', `/specialists/${bots.Inkoper.id}`, { enabled: true, field: 'Inkoop van was, geurolie en verpakking voor een kleine webshop' });
    await api('POST', `/specialists/${bots.Inkoper.id}/knowledge`, { content: 'Sojawas is bij de groothandel in oktober 8% duurder geworden.', source: 'https://example.com/prijzen-oktober' });
    await api('POST', `/specialists/${bots.Inkoper.id}/knowledge`, { content: 'Glazen potjes van 200 ml zijn per 500 stuks het voordeligst.', source: 'https://example.com/verpakking' });
    await api('POST', `/specialists/${bots.Inkoper.id}/knowledge`, { content: 'Geurolie moet een IFRA-certificaat hebben voor verkoop in de EU.', source: 'https://example.com/regels' });
  });

  // ---- routines ----
  const routine = (name, bot, schedule, prompt) => soft(`routine ${name}`, () => api('POST', '/routines', { name, agent_id: bots[bot].id, prompt, timezone: 'Europe/Amsterdam', schedule }));
  await routine('Ochtendoverzicht', 'Baas', { kind: 'weekly', days: ['ma', 'di', 'wo', 'do', 'vr'], times: ['08:00'] }, 'Zet per team op een rij wat vandaag openstaat.');
  await routine('Nieuwe bestellingen nalopen', 'Verkoper', { kind: 'weekly', days: ['ma', 'wo', 'vr'], times: ['10:00'] }, 'Kijk welke bestellingen nog niet verstuurd zijn.');
  await routine('Prijzen volgen', 'Inkoper', { kind: 'weekly', days: ['ma'], times: ['09:00'] }, 'Kijk of de prijzen van was en verpakking veranderd zijn.');
  await routine('Rooster maken', 'Planner', { kind: 'weekly', days: ['vr'], times: ['15:00'] }, 'Maak het rooster voor volgende week.');
  await routine('Facturen controleren', 'Boekhouder', { kind: 'monthly', days: ['LW'], times: ['09:00'] }, 'Controleer de facturen van deze maand.');

  // ---- an example usage bar: one subscription with an example 5-hour and week window, and four free sources ----
  await soft('gebruiksbalk', async () => {
    app.ctx.providers.registerKind({
      id: 'demo-sub',
      label: 'Abonnement (voorbeeld)',
      type: 'api',
      needsKey: false,
      billing: 'subscription',
      description: 'Voorbeeldabonnement voor de gebruiksbalk op de schermafbeeldingen',
      models: ['voorbeeld'],
      defaultModel: 'voorbeeld',
      create: () => ({
        kind: 'demo-sub',
        async listModels() {
          return [{ id: 'voorbeeld' }];
        },
        async test() {
          return { ok: true, detail: 'demo' };
        },
        async chat() {
          throw new Error('niet gebruikt');
        },
      }),
    });
    const sub = app.ctx.providers.create(owner.id, { kind: 'demo-sub', name: 'Claude' });
    const usage = app.ctx.services.usage;
    const t = Date.now();
    const H = 3_600_000;
    usage.report(sub, {
      windows: [
        { id: 'five_hour', label: '5 uur', usedPercent: 38, resetsAt: t + 2.4 * H, level: 'ok', at: t },
        { id: 'seven_day', label: 'Week', usedPercent: 64, resetsAt: t + 74 * H, level: 'ok', at: t },
      ],
      billing: 'subscription',
      source: 'stats',
      at: t,
    });
    usage.reportReserve({ userId: owner.id, providerId: sub.id, windowId: 'seven_day', atPercent: 85, active: false });
    usage.reportSource({ userId: owner.id, id: 'groq', label: 'Groq', status: 'available', kind: 'free' });
    usage.reportSource({ userId: owner.id, id: 'openrouter-free', label: 'OpenRouter', status: 'low', usedPercent: 84, estimated: true, kind: 'free' });
    usage.reportSource({ userId: owner.id, id: 'kilo', label: 'Kilo', status: 'available', kind: 'free' });
    usage.reportSource({ userId: owner.id, id: 'local', label: 'Lokaal', status: 'available', kind: 'local' });
  });

  // ---- one real chat turn with the main bot ----
  const chat = app.ctx.chat.threadForAgent(owner.id, bots.Baas.id);
  const say = (bot, role, content) => {
    const th = app.ctx.chat.threadForAgent(owner.id, bot.id);
    store.createMessage(role === 'user' ? { thread_id: th.id, role, author_type: 'user', author_id: owner.id, author_name: owner.name, content } : { thread_id: th.id, role, author_type: 'agent', author_id: bot.id, author_name: bot.name, content });
  };
  say(bots.Verkoper, 'assistant', 'Drie nieuwe bestellingen vandaag; alle drie zijn ingepakt.');
  say(bots.Schrijver, 'assistant', 'De teksten voor de wintercollectie staan in de teammap.');
  say(bots.Boekhouder, 'assistant', 'Eén factuur wacht op je akkoord: Meelhandel Voorbeeld, € 312.');
  say(bots.Planner, 'assistant', 'Het rooster voor volgende week staat klaar.');
  say(bots.Inkoper, 'assistant', 'Sojawas is 8% duurder geworden; ik zoek een tweede leverancier.');
  await app.ctx.chat.postUserMessage({ thread: chat, user: owner, content: 'Hoe staat het ervoor bij de webshop en de bakkerij?' });
  const answered = await until(() => store.messages(chat.id).find((m) => m.role === 'assistant' && /ontbrekende prijzen/.test(m.content || '')), 20_000);
  if (!answered) throw new Error('nep-model gaf geen antwoord');
  step('gesprek met de hoofdbot gevoerd (nep-model, met een stap in de teamdatabase)');

  // ---- photograph ----
  browser = await chromium.launch({ channel: parentEnv.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true, env: parentEnv });
  const local = new URL(app.url).host;
  const blocked = [];
  async function context(opts) {
    const ctx = await browser.newContext({ colorScheme: 'light', locale: 'nl-NL', timezoneId: 'Europe/Amsterdam', ...opts });
    await ctx.route('**/*', (route) => {
      const u = new URL(route.request().url());
      if (u.protocol === 'data:' || u.protocol === 'blob:' || u.host === local) return route.continue();
      blocked.push(u.host);
      return route.abort();
    });
    return ctx;
  }
  const conv = await (await browser.newContext()).newPage();
  const madeFiles = new Set();
  async function save(page, name, clip) {
    const png = await page.screenshot({ type: 'png', ...(clip ? { clip } : {}) });
    const webp = await conv.evaluate(async (b64) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/webp', 0.84).split(',')[1];
    }, png.toString('base64'));
    const buf = Buffer.from(webp, 'base64');
    fs.writeFileSync(path.join(out, `${name}.webp`), buf);
    madeFiles.add(name);
    fs.rmSync(path.join(out, name + '.png'), { force: true });
    step(`${name}.webp (${Math.round(buf.length / 1024)} kB)`);
  }
  async function open(page, hash, waitFor) {
    await page.evaluate((h) => (location.hash = h), hash);
    if (waitFor) await page.getByText(waitFor).first().waitFor({ timeout: 10_000 });
    await page.waitForTimeout(1000);
  }
  // clip: only part of the window (CSS pixels), so the feature pages show the screen itself, large enough to read.
  const shoot = (page, name, hash, waitFor, before, clip) =>
    soft(name, async () => {
      await open(page, hash, waitFor);
      // no focus ring left over from the previous screen
      await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
      if (before) await before(page);
      await save(page, name, clip);
    });
  /** The page next to the sidebar and the settings list (pages under Instellingen). */
  const MAIN = (height) => ({ x: 532, y: 0, width: 748, height });
  fs.mkdirSync(out, { recursive: true });

  const desk = await context({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5 });
  const d = await desk.newPage();
  await d.goto(`${app.url}/#token=${token}`);
  await d.waitForTimeout(1500);
  // Not photographed on purpose: "Waar staat mijn data?" and "Overstappen" show the data folder and this computer's
  // network addresses, and those must never end up on the website.
  await shoot(d, 'chat-desktop', `#/t/${chat.id}`, 'ontbrekende prijzen');
  // The team picker open over the same chat: the main bot answers for both teams.
  await shoot(d, 'teams-desktop', `#/t/${chat.id}`, 'ontbrekende prijzen', async (p) => {
    await p.getByRole('button', { name: /Alle teams/ }).first().click();
    await p.getByText('Bakkerij').first().waitFor({ timeout: 5000 });
    await p.waitForTimeout(500);
  });
  await d.keyboard.press('Escape');
  await shoot(d, 'tasks-desktop', '#/tasks', 'Prijslijst bijwerken');
  await shoot(d, 'memory-desktop', '#/m/memory/gedeeld', 'handgemaakte kaarsen', null, MAIN(640));
  await shoot(d, 'specialist-desktop', `#/m/specialists/${bots.Inkoper.id}`, 'IFRA', null, MAIN(560));
  await shoot(d, 'usage-desktop', '#/m/usage/', 'Groq', null, MAIN(610));
  await shoot(d, 'channels-desktop', '#/m/channels/', null, async (p) => {
    const add = p.getByRole('button', { name: /Kanaal toevoegen/ }).first();
    if (await add.count()) {
      await add.click();
      await p.waitForTimeout(800);
    }
  });
  await d.keyboard.press('Escape');
  await shoot(d, 'market-desktop', '#/m/skills/', null, (p) => p.waitForTimeout(2000));
  await shoot(d, 'calendar-desktop', '#/m/routines/kalender', 'Ochtendoverzicht', null, { x: 308, y: 20, width: 962, height: 620 });
  await soft('kleur', () => api('PUT', '/settings', { ui: { accent: 'lavender' } }));
  await shoot(d, 'colours-desktop', '#/settings/appearance', 'Lavendel', null, MAIN(575));
  await desk.close();

  const phone = await context({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await phone.newPage();
  await p.goto(`${app.url}/#token=${token}`);
  await p.waitForTimeout(1500);
  await shoot(p, 'phone-list', '#/', 'Verkoper');
  await shoot(p, 'phone-chat', `#/t/${chat.id}`, 'ontbrekende prijzen');
  await phone.close();
  if (blocked.length) step(`geblokkeerde externe verzoeken: ${[...new Set(blocked)].join(', ')}`);
  console.log('website:screenshots: klaar →', path.relative(repo, out));
  const slots = JSON.parse(fs.readFileSync(path.join(here, 'src/shots.json'), 'utf8'));
  for (const [slot, s] of Object.entries(slots)) {
    if (slot.startsWith('_')) continue;
    const made = madeFiles.has(s.file);
    console.log(`  vak ${slot.padEnd(11)} ← ${s.file}.webp ${made ? 'nieuw gemaakt' : 'NIET door dit script gemaakt (oude afbeelding blijft staan)'}`);
  }
} catch (e) {
  console.error('website:screenshots MISLUKT:', e.stack || e.message);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(process.exitCode || 0);
