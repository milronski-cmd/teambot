/**
 * Realistic long conversations for the context budget (TeamBot 0.4, package Y): a webshop bot with three connected
 * apps, a bot that fixes code in a long run, an SEO researcher reading long web pages, and a customer-service chat.
 * Tool output is generated deterministically at realistic sizes (a product list of ~25k characters, order JSON, source
 * files, web pages of 20–25k characters, test output), so token counts are comparable between runs.
 *
 * `fixtureModule()` registers the apps (Shopify, Google Sheets, Gmail: MCP-like tools with an `app`) and replaces
 * web_search, web_fetch and run_command with fixtures (tests never reach the network or run commands).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ChatRequest, Module, ToolDef } from '../../server/core/types.js';
import type { MockStep, TestApp } from '../helpers.js';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: T[]) => xs[Math.floor(r() * xs.length)];

const BRANDS = ['Gazelle', 'Batavus', 'Cortina', 'Sparta', 'Stromer', 'VanMoof', 'Trek', 'Giant', 'Cube', 'Riese & Müller', 'QWIC', 'Koga'];
const MODELS = ['Orange C7', 'Finez', 'E-U4', 'M10', 'ST3', 'S5', 'Allant+', 'Explore E+', 'Kathmandu Hybrid', 'Supercharger', 'Premium MN7', 'F3'];
const CATS = ['E-bike stad', 'E-bike trekking', 'Speed pedelec', 'Stadsfiets', 'Kinderfiets', 'Bakfiets', 'Accessoire', 'Onderdeel'];
const WORDS =
  'de het een fiets accu motor bereik kilometer comfort frame zadel stuur remmen schijfremmen versnelling naaf ketting riem verlichting bagagedrager standaard garantie onderhoud werkplaats levering montage proefrit voorraad leverancier prijs korting actie seizoen voorjaar zomer woon-werk pendelen stad buitengebied heuvels wind regen kwaliteit duurzaam stil krachtig licht zwaar betrouwbaar veilig'.split(' ');

function sentence(r: () => number, n = 14) {
  const w = Array.from({ length: n }, () => pick(r, WORDS));
  w[0] = w[0][0].toUpperCase() + w[0].slice(1);
  return w.join(' ') + '.';
}

export function productsCsv(): string {
  const r = rng(7);
  const rows = ['sku;naam;merk;categorie;prijs_incl_btw;voorraad;leverancier;omschrijving'];
  for (let i = 0; i < 160; i++) {
    const brand = pick(r, BRANDS);
    const model = pick(r, MODELS);
    const cat = pick(r, CATS);
    const price = cat.startsWith('Accessoire') || cat === 'Onderdeel' ? 9 + Math.floor(r() * 140) : 499 + Math.floor(r() * 5200);
    rows.push(`FP-${String(1000 + i)};${brand} ${model} ${2025 + (i % 2)};${brand};${cat};${price},${pick(r, ['00', '50', '95', '99'])};${Math.floor(r() * 30)};${pick(r, ['Fietsgroothandel Oost', 'BikeParts NL', 'Velo Distributie', 'Direct van merk'])};${sentence(r, 9)}`);
  }
  return rows.join('\n');
}

export function ordersJson(): string {
  const r = rng(11);
  const orders = [];
  for (let i = 0; i < 23; i++) {
    const n = 1 + Math.floor(r() * 3);
    const items = Array.from({ length: n }, () => ({ sku: `FP-${1000 + Math.floor(r() * 160)}`, titel: `${pick(r, BRANDS)} ${pick(r, MODELS)}`, aantal: 1 + Math.floor(r() * 2), prijs: Number((20 + r() * 900).toFixed(2)) }));
    orders.push({
      id: 1031 + i,
      klant: { naam: `${pick(r, ['J.', 'M.', 'S.', 'P.', 'L.', 'A.'])} ${pick(r, ['de Vries', 'Jansen', 'Bakker', 'Visser', 'Smit', 'Meijer', 'de Boer', 'Mulder'])}`, plaats: pick(r, ['Utrecht', 'Amersfoort', 'Zwolle', 'Deventer', 'Arnhem', 'Apeldoorn']) },
      datum: `2026-11-0${1 + (i % 8)}T${String(8 + (i % 10)).padStart(2, '0')}:1${i % 6}:00+01:00`,
      status: pick(r, ['betaald', 'verzonden', 'in behandeling', 'afgerond']),
      verzending: { methode: pick(r, ['PostNL', 'DHL', 'Afhalen in de winkel']), kosten: pick(r, [0, 6.95, 12.5]) },
      items,
      totaal: Number(items.reduce((s, x) => s + x.prijs * x.aantal, 0).toFixed(2)),
      notities: sentence(r, 8),
    });
  }
  orders[16].totaal = 612;
  orders[16].klant.naam = 'J. de Vries';
  return JSON.stringify({ orders, page_info: { has_next_page: false } }, null, 2);
}

export function customersJson(): string {
  const r = rng(13);
  const customers = Array.from({ length: 40 }, (_, i) => ({
    id: 5000 + i,
    naam: `${pick(r, ['Jan', 'Marieke', 'Sanne', 'Pieter', 'Lotte', 'Ahmed', 'Fatima', 'Kees'])} ${pick(r, ['de Vries', 'Jansen', 'Bakker', 'Visser', 'Smit', 'Meijer'])}`,
    bestellingen: Math.floor(r() * 5),
    totaal_besteed: Number((r() * 4000).toFixed(2)),
    nieuwsbrief: r() > 0.4,
    laatst_besteld: `2026-${String(1 + Math.floor(r() * 10)).padStart(2, '0')}-1${Math.floor(r() * 9)}`,
    tags: [pick(r, ['vaste klant', 'zakelijk', 'nieuw', 'retour'])],
  }));
  return JSON.stringify({ customers }, null, 2);
}

export function sourceFile(name: string, seed: number, fns: number): string {
  const r = rng(seed);
  const out = [`// ${name} — Fietsplezier webshop`, `import { formatPrijs, type Product } from './types';`, ''];
  for (let i = 0; i < fns; i++) {
    const fn = `${pick(r, ['bereken', 'controleer', 'pas', 'haal', 'zet', 'tel'])}${pick(r, ['Korting', 'Totaal', 'Verzendkosten', 'Btw', 'Voorraad', 'Regel', 'Bundel', 'Actie'])}${i}`;
    out.push(`/** ${sentence(r, 10)} */`, `export function ${fn}(items: Product[], opties: { korting?: number; land?: string } = {}): number {`);
    for (let j = 0; j < 6; j++) out.push(`  const w${j} = items.reduce((s, p) => s + p.prijs * ${(1 + r()).toFixed(2)}, 0); // ${pick(r, WORDS)} ${pick(r, WORDS)}`);
    out.push(`  if (opties.korting && opties.korting > ${Math.floor(r() * 50)}) return Math.round(w0 * (1 - opties.korting / 100) * 100) / 100;`, '  return w0 + w1 - w2;', '}', '');
  }
  return out.join('\n');
}

export function markdownDoc(title: string, seed: number, paras: number): string {
  const r = rng(seed);
  const out = [`# ${title}`, ''];
  for (let i = 0; i < paras; i++) out.push(`## ${pick(r, ['Kleuren', 'Lettertypen', 'Toon', 'Logo', 'Foto’s', 'Knoppen', 'Installatie', 'Gebruik', 'Licentie'])} ${i + 1}`, Array.from({ length: 4 }, () => sentence(r, 16)).join(' '), '');
  return out.join('\n');
}

export function webPage(title: string, seed: number, chars: number): string {
  const r = rng(seed);
  const out = [`${title}`, `Gepubliceerd op 3 november 2026 · Leestijd 12 minuten`, ''];
  while (out.join('\n').length < chars) out.push(Array.from({ length: 5 }, () => sentence(r, 18)).join(' '), '');
  return out.join('\n').slice(0, chars);
}

export function searchResults(q: string, seed: number): string {
  const r = rng(seed);
  return Array.from({ length: 8 }, (_, i) => `${i + 1}. ${pick(r, BRANDS)} ${pick(r, MODELS)} getest: ${q} — https://www.${pick(r, ['fietsentest', 'ebikeweb', 'fietsersbond', 'consumentengids', 'tweewielers'])}.nl/artikel-${100 + i}\n   ${sentence(r, 20)}`).join('\n');
}

export function testOutput(seed: number, lines: number, fail = false): string {
  const r = rng(seed);
  const out = ['> fietsplezier@2.4.0 test', '> node --test', ''];
  for (let i = 0; i < lines; i++) out.push(`✔ ${sentence(r, 7).replace(/\.$/, '')} (${(r() * 40).toFixed(3)}ms)`);
  if (fail) out.push('✖ berekenKorting geeft 15% korting op een bedrag van 100 (2.104ms)', '  AssertionError: expected 85 but got 115', '    at winkelwagen.test.ts:41:12');
  out.push(`ℹ tests ${lines + (fail ? 1 : 0)}`, `ℹ pass ${lines}`, `ℹ fail ${fail ? 1 : 0}`);
  return out.join('\n');
}

// ------------------------------------------------------------------ the apps and the fixture tools

function appTool(app: string, slug: string, name: string, description: string, props: Record<string, any>, required: string[], run: (a: any) => string, risk: ToolDef['risk'] = 'read'): ToolDef {
  return { name: `mcp_${slug}_${name}`, group: 'mcp', app, risk, description, parameters: { type: 'object', properties: props, required }, run: async (a) => run(a) };
}
const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });

export function fixtureTools(): ToolDef[] {
  const ok = (what: string) => () => JSON.stringify({ ok: true, result: what });
  const S = 'Shopify';
  const G = 'Google Sheets';
  const M = 'Gmail';
  return [
    appTool(S, 'shopify', 'list_orders', 'Lijst van bestellingen in de Shopify-winkel, met klant, regels, totaal en status. Filter op status en datum.', { status: str('any, open, closed of cancelled'), created_at_min: str('ISO-datum, vanaf'), limit: num('Maximaal aantal (1-250)') }, [], () => ordersJson()),
    appTool(S, 'shopify', 'get_order', 'Eén bestelling volledig: regels, betaling, verzending, notities en tijdlijn.', { order_id: num('Het nummer van de bestelling') }, ['order_id'], (a) => JSON.stringify({ order: JSON.parse(ordersJson()).orders.find((o: any) => o.id === Number(a.order_id)) ?? null }, null, 2)),
    appTool(S, 'shopify', 'list_products', 'Producten in de winkel met varianten, prijzen en voorraad per locatie.', { query: str('Zoekterm'), limit: num('Maximaal aantal') }, [], () => productsCsv()),
    appTool(S, 'shopify', 'get_product', 'Eén product met alle varianten, afbeeldingen, metavelden en SEO-gegevens.', { product_id: str('Product-id of SKU') }, ['product_id'], (a) => JSON.stringify({ product: { id: a.product_id } })),
    appTool(S, 'shopify', 'update_product', 'Pas titel, omschrijving, prijs, tags of status van een product aan.', { product_id: str('Product-id'), fields: { type: 'object', description: 'De velden en hun nieuwe waarde' } }, ['product_id', 'fields'], ok('bijgewerkt'), 'write'),
    appTool(S, 'shopify', 'list_customers', 'Klanten met aantal bestellingen, totaal besteed, nieuwsbriefstatus en tags.', { query: str('Zoekterm (naam, e-mail, tag)'), limit: num('Maximaal aantal') }, [], () => customersJson()),
    appTool(S, 'shopify', 'get_customer', 'Eén klant met adressen, bestellingen en notities.', { customer_id: num('Klantnummer') }, ['customer_id'], (a) => JSON.stringify({ customer: { id: a.customer_id } })),
    appTool(S, 'shopify', 'create_discount', 'Maak een kortingscode of automatische korting (percentage of bedrag), met looptijd en voorwaarden.', { code: str('De code'), percentage: num('Korting in procent'), starts_at: str('Begin (ISO)'), ends_at: str('Einde (ISO)'), minimum: num('Minimaal bestelbedrag') }, ['code'], ok('korting gemaakt'), 'write'),
    appTool(S, 'shopify', 'list_discounts', 'Lopende en geplande kortingen met gebruik.', { status: str('active, scheduled of expired') }, [], () => JSON.stringify({ discounts: [{ code: 'VOORJAAR15', percentage: 15 }] })),
    appTool(S, 'shopify', 'update_inventory', 'Zet de voorraad van een variant op een locatie.', { sku: str('SKU'), location: str('Locatie'), quantity: num('Nieuwe voorraad') }, ['sku', 'quantity'], ok('voorraad bijgewerkt'), 'write'),
    appTool(S, 'shopify', 'list_collections', 'Collecties (categorieën) met aantallen producten.', {}, [], () => JSON.stringify({ collections: CATS })),
    appTool(S, 'shopify', 'create_draft_order', 'Maak een conceptbestelling voor een klant (offerte).', { customer_id: num('Klantnummer'), items: { type: 'array', items: { type: 'object' }, description: 'Regels: sku en aantal' } }, ['items'], ok('concept gemaakt'), 'write'),
    appTool(G, 'google_sheets', 'list_sheets', 'De tabbladen van een spreadsheet met hun afmetingen.', { spreadsheet: str('Naam of id van de spreadsheet') }, ['spreadsheet'], () => JSON.stringify({ sheets: ['Voorraad', 'Omzet', 'Acties'] })),
    appTool(G, 'google_sheets', 'read_range', 'Lees cellen uit een bereik (A1-notatie).', { spreadsheet: str('Naam of id'), range: str('Bereik, bijv. Voorraad!A1:F200') }, ['spreadsheet', 'range'], () => productsCsv().split('\n').slice(0, 40).join('\n')),
    appTool(G, 'google_sheets', 'append_rows', 'Voeg rijen toe onderaan een tabblad.', { spreadsheet: str('Naam of id'), sheet: str('Tabblad'), rows: { type: 'array', items: { type: 'array' }, description: 'De rijen' } }, ['spreadsheet', 'sheet', 'rows'], (a) => JSON.stringify({ ok: true, appended: Array.isArray(a.rows) ? a.rows.length : 0 }), 'write'),
    appTool(G, 'google_sheets', 'update_range', 'Overschrijf de cellen in een bereik.', { spreadsheet: str('Naam of id'), range: str('Bereik'), values: { type: 'array', items: { type: 'array' } } }, ['spreadsheet', 'range', 'values'], ok('bijgewerkt'), 'write'),
    appTool(G, 'google_sheets', 'create_sheet', 'Maak een nieuw tabblad.', { spreadsheet: str('Naam of id'), title: str('Naam van het tabblad') }, ['spreadsheet', 'title'], ok('tabblad gemaakt'), 'write'),
    appTool(G, 'google_sheets', 'clear_range', 'Maak een bereik leeg.', { spreadsheet: str('Naam of id'), range: str('Bereik') }, ['spreadsheet', 'range'], ok('leeg'), 'write'),
    appTool(G, 'google_sheets', 'find_rows', 'Zoek rijen waarin een kolom een waarde heeft.', { spreadsheet: str('Naam of id'), sheet: str('Tabblad'), column: str('Kolomnaam'), value: str('Waarde') }, ['spreadsheet', 'sheet', 'column', 'value'], () => JSON.stringify({ rows: [] })),
    appTool(G, 'google_sheets', 'format_range', 'Opmaak van een bereik: vet, kleur, getalnotatie.', { spreadsheet: str('Naam of id'), range: str('Bereik'), format: { type: 'object', description: 'Opmaak' } }, ['spreadsheet', 'range', 'format'], ok('opgemaakt'), 'write'),
    appTool(M, 'gmail', 'search_messages', 'Zoek e-mails met Gmail-zoektermen (van:, onderwerp:, na:).', { query: str('Zoekopdracht'), max: num('Maximaal aantal') }, ['query'], () => JSON.stringify({ messages: [] })),
    appTool(M, 'gmail', 'read_message', 'Lees één e-mail volledig, met bijlagen als lijst.', { id: str('Bericht-id') }, ['id'], () => JSON.stringify({ message: null })),
    appTool(M, 'gmail', 'create_draft', 'Maak een concept-e-mail (wordt niet verstuurd).', { to: str('Ontvanger(s)'), subject: str('Onderwerp'), body: str('Tekst (markdown)') }, ['to', 'subject', 'body'], ok('concept gemaakt'), 'write'),
    appTool(M, 'gmail', 'send_message', 'Verstuur een e-mail.', { to: str('Ontvanger(s)'), subject: str('Onderwerp'), body: str('Tekst'), cc: str('Cc') }, ['to', 'subject', 'body'], ok('verstuurd'), 'danger'),
    appTool(M, 'gmail', 'list_labels', 'Alle labels van het postvak.', {}, [], () => JSON.stringify({ labels: ['Klanten', 'Leveranciers'] })),
    appTool(M, 'gmail', 'add_label', 'Geef een e-mail een label.', { id: str('Bericht-id'), label: str('Label') }, ['id', 'label'], ok('label gezet'), 'write'),
    appTool(M, 'gmail', 'list_threads', 'Gespreksdraden in het postvak, nieuwste eerst.', { query: str('Zoekopdracht'), max: num('Maximaal aantal') }, [], () => JSON.stringify({ threads: [] })),
    // Fixtures for tools that would reach the network or run commands.
    {
      name: 'web_search',
      group: 'web',
      risk: 'read',
      description: 'Zoek op internet. Geeft titels, links en korte stukjes tekst.',
      parameters: { type: 'object', properties: { query: str('Zoekopdracht') }, required: ['query'] },
      run: async (a) => searchResults(String(a.query), String(a.query).length),
    },
    {
      name: 'web_fetch',
      group: 'web',
      risk: 'read',
      description: 'Lees een webpagina als tekst.',
      parameters: { type: 'object', properties: { url: str('De link') }, required: ['url'] },
      run: async (a) => webPage(`Pagina ${a.url}`, String(a.url).length * 7, /verzeker/.test(String(a.url)) ? 20_000 : /2/.test(String(a.url)) ? 22_000 : 25_000),
    },
    {
      name: 'run_command',
      group: 'shell',
      risk: 'exec',
      description: 'Voer een opdracht uit in de werkmap (PowerShell of bash) en geef de uitvoer.',
      parameters: { type: 'object', properties: { command: str('De opdracht') }, required: ['command'] },
      run: async (a) => testOutput(String(a.command).length, /--grep|0%/.test(String(a.command)) ? 60 : 110, /eerste/.test(String(a.command))),
    },
  ];
}

export function fixtureModule(): Module {
  return {
    id: 'context-fixtures',
    init(ctx) {
      for (const t of fixtureTools()) ctx.tools.register(t);
    },
  };
}

// ------------------------------------------------------------------ the conversations

export interface FixtureTurn {
  user: string;
  steps: MockStep[];
}

export interface Fixture {
  id: string;
  label: string;
  agent: Record<string, any>;
  files?: Record<string, string>;
  /** Pinned memory instructions (always loaded, "vraag eerst"). */
  pinned?: string[];
  turns: FixtureTurn[];
  /** Facts the last request must still contain (from the conversation, not from shortened tool output). */
  facts: string[];
}

const call = (name: string, args: any = {}): MockStep => ({ toolCalls: [{ name, args }] });
const say = (text: string): MockStep => ({ text });

const winkelwagen = sourceFile('src/winkelwagen.ts', 21, 14);
const checkout = sourceFile('src/checkout.ts', 22, 10);
const winkelTest = sourceFile('tests/winkelwagen.test.ts', 23, 7);

export const FIXTURES: Fixture[] = [
  {
    id: 'webshop',
    label: 'Webshop met Shopify, Google Sheets en Gmail',
    agent: { name: 'Winkelhulp', role: 'webshop-assistent', tool_groups: ['files', 'web', 'memory', 'team', 'skills', 'routines', 'mcp'] },
    files: { 'producten.csv': productsCsv() },
    pinned: ['Vraag eerst toestemming voordat je iets naar klanten verstuurt.'],
    turns: [
      { user: 'Hoi! Mijn webshop heet Fietsplezier. Kun je de bestellingen van deze week uit Shopify halen?', steps: [call('mcp_shopify_list_orders', { status: 'any', created_at_min: '2026-11-01' }), say('Deze week zijn er 23 bestellingen binnengekomen, samen €4.312,50. De grootste is #1047 van J. de Vries (€612,00). 4 bestellingen staan nog op "in behandeling".')] },
      { user: 'Welke producten zijn bijna uitverkocht? De lijst staat in producten.csv.', steps: [call('read_file', { path: 'producten.csv' }), say('Bijna uitverkocht (2 of minder op voorraad): Gazelle Orange C7 2026, Cortina E-U4 2025, Stromer ST3 2026 en 5 accessoires. Zal ik ze bestellen bij de leveranciers?')] },
      { user: 'Zet die lijst in de Google Sheet "Voorraad".', steps: [call('mcp_google_sheets_append_rows', { spreadsheet: 'Voorraad', sheet: 'Voorraad', rows: [['Gazelle Orange C7 2026', 2], ['Cortina E-U4 2025', 1], ['Stromer ST3 2026', 0]] }), say('De lijst staat in het tabblad Voorraad (3 fietsen en 5 accessoires).')] },
      { user: 'Hoeveel klanten kochten twee keer of vaker?', steps: [call('mcp_shopify_list_customers', { limit: 250 }), say('17 van de 40 klanten kochten twee keer of vaker; samen goed voor 71% van de omzet. 12 van hen staan ingeschreven voor de nieuwsbrief.')] },
      { user: 'Lees de productlijst nog eens en geef de top 5 duurste fietsen.', steps: [call('read_file', { path: 'producten.csv' }), say('Top 5 duurste fietsen: 1. Riese & Müller Supercharger (€5.649), 2. Stromer ST3 (€5.512), 3. Koga F3 (€5.380), 4. QWIC Premium MN7 (€5.211), 5. Trek Allant+ (€5.105).')] },
      { user: 'Schrijf een korte nieuwsbrief over de voorjaarsactie met 15% korting op e-bikes. Sla hem op als nieuwsbrief.md.', steps: [call('write_file', { path: 'nieuwsbrief.md', content: '# Voorjaarsactie bij Fietsplezier\n\n15% korting op alle e-bikes, alleen in maart. Code: VOORJAAR15.\n' }), say('De nieuwsbrief staat in nieuwsbrief.md: een korte tekst met de code VOORJAAR15 en de top 5 als tip.')] },
      { user: 'Stuur die naar de vaste klanten.', steps: [say('Zal ik de nieuwsbrief als e-mail naar de 12 vaste klanten met nieuwsbrief sturen? Ik vraag eerst je akkoord, zoals afgesproken.')] },
      { user: 'Nog even niet. Wat was ook alweer de grootste bestelling, en hoe heet mijn webshop?', steps: [say('De grootste bestelling was #1047 van J. de Vries (€612,00). Je webshop heet Fietsplezier.')] },
    ],
    facts: ['Fietsplezier', '#1047', 'J. de Vries', 'VOORJAAR15', 'Vraag eerst toestemming voordat je iets naar klanten verstuurt.'],
  },
  {
    id: 'code',
    label: 'Kortingsfout in de webshopcode herstellen (lange run)',
    agent: { name: 'Bouwer', role: 'ontwikkelaar', tool_groups: ['files', 'web', 'memory', 'shell', 'team', 'skills', 'routines'] },
    files: { 'src/winkelwagen.ts': winkelwagen, 'src/checkout.ts': checkout, 'tests/winkelwagen.test.ts': winkelTest, 'README.md': markdownDoc('Fietsplezier webshop', 24, 14), 'docs/huisstijl.md': markdownDoc('Huisstijl Fietsplezier', 25, 16) },
    turns: [
      { user: 'Bekijk src/winkelwagen.ts en leg kort uit wat het doet.', steps: [call('read_file', { path: 'src/winkelwagen.ts' }), say('winkelwagen.ts rekent de winkelwagen uit: subtotaal, korting, btw en verzendkosten, in 14 functies. De kortingsregels staan in berekenKorting0 tot en met berekenKorting3.')] },
      {
        user: 'Er zit een fout in de kortingsberekening: 15% korting geeft een hoger bedrag. Zoek en herstel die, en draai de tests.',
        steps: [
          call('search_files', { query: 'korting', path: 'src' }),
          call('read_file', { path: 'src/winkelwagen.ts' }),
          call('read_file', { path: 'src/checkout.ts' }),
          call('run_command', { command: 'npm test -- eerste keer' }),
          call('read_file', { path: 'tests/winkelwagen.test.ts' }),
          call('edit_file', { path: 'src/winkelwagen.ts', old_text: 'return w0 + w1 - w2;', new_text: 'return Math.max(0, w0 + w1 - w2);' }),
          call('read_file', { path: 'src/winkelwagen.ts' }),
          call('run_command', { command: 'npm test' }),
          call('read_file', { path: 'src/checkout.ts' }),
          call('run_command', { command: 'npm run lint && npm test' }),
          call('read_file', { path: 'src/winkelwagen.ts' }),
          call('run_command', { command: 'npm test -- --coverage' }),
          say('Gevonden en hersteld: de korting werd opgeteld in plaats van afgetrokken. Alle 110 tests slagen nu, ook de nieuwe controle op 15% korting.'),
        ],
      },
      { user: 'Voeg een test toe voor 0% korting.', steps: [call('read_file', { path: 'tests/winkelwagen.test.ts' }), call('write_file', { path: 'tests/korting-nul.test.ts', content: "import { test } from 'node:test';\n// 0% korting laat het bedrag gelijk\n" }), call('run_command', { command: 'npm test -- --grep 0%' }), say('Test toegevoegd in tests/korting-nul.test.ts; hij slaagt.')] },
      { user: 'Werk de README bij met wat je vandaag hebt veranderd.', steps: [call('read_file', { path: 'README.md' }), call('edit_file', { path: 'README.md', old_text: '# Fietsplezier webshop', new_text: '# Fietsplezier webshop\n\nNovember 2026: kortingsfout hersteld, test voor 0% korting.' }), say('De README noemt nu de herstelde kortingsfout en de nieuwe test.')] },
      { user: 'Welke kleuren schrijft de huisstijl voor?', steps: [call('read_file', { path: 'docs/huisstijl.md' }), say('De huisstijl noemt groen als hoofdkleur, met wit en donkergrijs; knoppen zijn groen met witte tekst.')] },
      { user: 'Kort samengevat: wat heb je vandaag allemaal veranderd?', steps: [say('Vandaag: de kortingsfout in src/winkelwagen.ts hersteld (korting werd opgeteld), een test voor 0% korting toegevoegd en de README bijgewerkt. Alle tests slagen.')] },
    ],
    facts: ['src/winkelwagen.ts', 'korting werd opgeteld', 'tests/korting-nul.test.ts'],
  },
  {
    id: 'seo',
    label: 'SEO-artikel over e-bikes (lange webpagina’s)',
    agent: { name: 'Schrijver', role: 'SEO- en contentschrijver', tool_groups: ['files', 'web', 'memory', 'team', 'skills', 'routines'] },
    turns: [
      { user: 'Zoek uit wat de beste e-bikes voor woon-werkverkeer zijn in 2026.', steps: [call('web_search', { query: 'beste e-bike woon-werkverkeer 2026' }), call('web_fetch', { url: 'https://www.fietsentest.nl/beste-ebikes-2026' }), call('web_fetch', { url: 'https://www.ebikeweb.nl/test-2' }), say('De drie best geteste e-bikes voor woon-werk zijn de Gazelle Ultimate C380 (beste allrounder), de Stromer ST3 (speed pedelec, 45 km/u) en de Cortina E-U4 (beste prijs). Belangrijk: bereik van minstens 80 km en een riemaandrijving.')] },
      { user: 'Maak een opzet voor een blog van 1200 woorden.', steps: [say('Opzet: 1. Inleiding: waarom met de e-bike naar je werk; 2. Waar let je op (bereik, motor, onderhoud); 3. De drie beste e-bikes; 4. Kosten en fiscale regeling; 5. Verzekering; 6. Conclusie.')] },
      { user: 'Zoek ook uit wat een fietsverzekering kost.', steps: [call('web_search', { query: 'kosten e-bike verzekering 2026' }), call('web_fetch', { url: 'https://www.consumentengids.nl/fietsverzekering' }), say('Een e-bikeverzekering kost in 2026 gemiddeld €8 tot €15 per maand voor diefstal en schade; bij een fiets van €3.000 rekent men meestal €110 tot €170 per jaar.')] },
      { user: 'Schrijf de inleiding.', steps: [say('Inleiding: Steeds meer mensen pakken de e-bike naar hun werk. Het is gezond, goedkoper dan de auto en je staat niet in de file. Maar welke e-bike past bij jouw route? In dit artikel zetten we de beste modellen van 2026 op een rij.')] },
      { user: 'Lees de eerste testpagina nog eens voor de precieze specificaties.', steps: [call('web_fetch', { url: 'https://www.fietsentest.nl/beste-ebikes-2026' }), say('Specificaties volgens de test: Gazelle Ultimate C380, middenmotor 85 Nm, accu 625 Wh, bereik 90–140 km, prijs €3.799.')] },
      { user: 'Schrijf de rest en sla het artikel op als blog.md.', steps: [call('write_file', { path: 'blog.md', content: '# Met de e-bike naar je werk: de beste modellen van 2026\n\n(…1200 woorden…)\n' }), say('Het artikel staat in blog.md (ongeveer 1200 woorden), met de zes onderdelen uit de opzet.')] },
      { user: 'Welke bronnen heb je gebruikt?', steps: [say('Bronnen: fietsentest.nl (beste e-bikes 2026), ebikeweb.nl (test 2) en consumentengids.nl (fietsverzekering).')] },
    ],
    facts: ['Gazelle Ultimate C380', 'fietsentest.nl', 'blog.md'],
  },
  {
    id: 'service',
    label: 'Klantenservice: lang gesprek, weinig tools',
    agent: { name: 'Klantenhulp', role: 'klantenservice', tool_groups: ['files', 'web', 'memory', 'team', 'skills', 'routines'] },
    pinned: ['Vraag eerst toestemming voordat je iets naar een klant stuurt.'],
    turns: [
      { user: 'Voortaan: noem nooit prijzen zonder btw tegen klanten. We gaan vandaag de klantvragen van deze week doornemen.', steps: [say('Afgesproken: ik noem altijd prijzen inclusief btw. Welke vraag wil je als eerste doornemen?')] },
      ...Array.from({ length: 13 }, (_, i) => ({
        user: `Klantvraag ${i + 1}: ${['Een klant vraagt wanneer zijn Gazelle wordt geleverd (bestelling 10' + (31 + i) + ').', 'Iemand wil weten of we ook bakfietsen verhuren.', 'Een klant klaagt dat de accu van zijn Sparta na een jaar minder bereik heeft.', 'Kan een klant een proefrit maken op zaterdag?', 'Iemand vraagt of de voorjaarsactie ook voor speed pedelecs geldt.'][i % 5]} Wat antwoorden we?`,
        steps: [say(`Voorstel voor het antwoord op vraag ${i + 1}: ${sentence(rng(100 + i), 40)} Zal ik dit antwoord klaarzetten?`)],
      })),
    ],
    facts: ['Vraag eerst toestemming voordat je iets naar een klant stuurt.'],
  },
];

/** Run one fixture conversation in a test app; returns the requests of this conversation. */
export async function runFixture(t: TestApp, fx: Fixture, o: { saver: boolean; settings?: Record<string, any> } = { saver: true }): Promise<{ requests: ChatRequest[]; threadId: string; agentId: string }> {
  // These conversations repeat a step with the same output on purpose (repeated output is sent once), which the loop
  // guard of package C1 would stop; that guard has its own tests (tests/quality.test.ts).
  const a = await t.agent({ access_mode: 'auto', ...fx.agent, settings: { compaction: false, quality: { loopGuard: false }, ...(o.settings || {}), ...(o.saver ? {} : { contextSaver: false }) } });
  for (const [rel, body] of Object.entries(fx.files || {})) {
    const p = path.join(a.workspace, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  for (const text of fx.pinned || []) {
    const out = await t.api('POST', '/memory/items', { content: text, scope: 'about_you', type: 'instruction' });
    await t.api('POST', `/memory/items/${out.item.id}/pin`);
  }
  const th = await t.api('POST', '/threads', { agentId: a.id });
  const from = t.requests.length;
  for (const turn of fx.turns) {
    t.script.push(...turn.steps);
    await t.say(th.id, turn.user, 20_000);
  }
  return { requests: t.requests.slice(from), threadId: th.id, agentId: a.id };
}
