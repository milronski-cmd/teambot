/**
 * The five standard team tables. Every owner's team database starts with them, so bots and the owner's interface
 * share one vocabulary out of the box: tasks, decisions for the owner, events for dossiers, a log of real changes and
 * experiments. The column names follow the Dutch conventions TeamBot's first team used (and the OpenBot skill
 * "team-database"), so instructions written for that team keep working.
 *
 * The standard tables belong to TeamBot ("system"): every bot can add and change rows, nobody can drop or alter them.
 * Bots can create their own extra tables next to them (those belong to the bot that made them).
 */

export interface StandardTable {
  name: string;
  label: string;
  about: string;
  ddl: string;
  indexes: string[];
  /** ALTER statements for databases made before a column existed (each one may fail: then it was already there). */
  upgrades?: string[];
}

export const STANDARD_TABLES: StandardTable[] = [
  {
    name: 'taken',
    label: 'Taken',
    about:
      'Taken die bots elkaar (of de eigenaar) geven, met klaar_als (wanneer is hij af). Klaar = status klaar met resultaat én bewijs; TeamBot controleert dat (zonder of met fout bewijs: wacht_op_controle). Lukt het niet: status kon_niet met de reden in resultaat.',
    ddl: `CREATE TABLE IF NOT EXISTS taken (
  id INTEGER PRIMARY KEY, titel TEXT NOT NULL, eigenaar TEXT NOT NULL, aangevraagd_door TEXT,
  site TEXT, status TEXT NOT NULL DEFAULT 'open',  -- open | bezig | wacht_op_eigenaar | wacht_op_controle | klaar | kon_niet | geannuleerd
  resultaat TEXT, bewijs TEXT, aangemaakt TEXT DEFAULT (datetime('now','localtime')), bijgewerkt TEXT, klaar_als TEXT)`,
    indexes: ['CREATE INDEX IF NOT EXISTS taken_status ON taken(status)'],
    // Columns added after the first version: added to existing databases on first use (soft: imported tables differ).
    // beschrijving = why the task exists (for a vaste taak: the measurement); bron = what made it (one open task per
    // problem); project_id = the project it belongs to (projecten.id).
    upgrades: ['ALTER TABLE taken ADD COLUMN klaar_als TEXT', 'ALTER TABLE taken ADD COLUMN beschrijving TEXT', 'ALTER TABLE taken ADD COLUMN bron TEXT', 'ALTER TABLE taken ADD COLUMN project_id INTEGER'],
  },
  {
    name: 'beslissingen',
    label: 'Beslissingen',
    about: 'Beslissingen voor de eigenaar: korte vraag, uitleg en opties. De eigenaar kiest in TeamBot; de vragende bot krijgt het antwoord als bericht.',
    ddl: `CREATE TABLE IF NOT EXISTS beslissingen (
  id INTEGER PRIMARY KEY, vraag TEXT NOT NULL, uitleg TEXT, opties TEXT, gevraagd_door TEXT,
  status TEXT NOT NULL DEFAULT 'open',  -- open | gekozen | vervallen
  antwoord TEXT, vervangt_id INTEGER, aangemaakt TEXT DEFAULT (datetime('now','localtime')), beslist TEXT)`,
    indexes: ['CREATE INDEX IF NOT EXISTS beslissingen_status ON beslissingen(status)'],
  },
  {
    name: 'gebeurtenissen',
    label: 'Gebeurtenissen',
    about: 'Wat er binnenkwam of gebeurde (klantbericht, besluit, wijziging, testresultaat), per dossier; verwerkt = 1 zodra het dossier is bijgewerkt.',
    ddl: `CREATE TABLE IF NOT EXISTS gebeurtenissen (
  id INTEGER PRIMARY KEY, soort TEXT NOT NULL,  -- klantbericht | besluit | wijziging | testresultaat | bericht_eigenaar
  dossier TEXT, bron TEXT, samenvatting TEXT, verwerkt INTEGER NOT NULL DEFAULT 0,
  tijd TEXT DEFAULT (datetime('now','localtime')))`,
    indexes: ['CREATE INDEX IF NOT EXISTS gebeurtenissen_verwerkt ON gebeurtenissen(verwerkt)'],
  },
  {
    name: 'logboek',
    label: 'Logboek',
    about: 'Elke echte wijziging (site, feed, campagne, prijs, code, bericht verstuurd): wie, wat, waarom, bewijs en hoe terug te draaien.',
    ddl: `CREATE TABLE IF NOT EXISTS logboek (
  id INTEGER PRIMARY KEY, agent TEXT NOT NULL, site TEXT, wat TEXT NOT NULL, waarom TEXT, bewijs TEXT,
  terugdraaien TEXT, tijd TEXT DEFAULT (datetime('now','localtime')))`,
    indexes: ['CREATE INDEX IF NOT EXISTS logboek_agent ON logboek(agent)'],
  },
  {
    name: 'experimenten',
    label: 'Experimenten',
    about: 'Experimenten met hypothese, meting, beginwaarde, meetdatum en uitkomst.',
    ddl: `CREATE TABLE IF NOT EXISTS experimenten (
  id INTEGER PRIMARY KEY, vak TEXT, hypothese TEXT NOT NULL, bron TEXT, sites TEXT, controle TEXT,
  meting TEXT, beginwaarde TEXT, meetdatum TEXT, terugdraaien TEXT, eigenaar TEXT,
  status TEXT NOT NULL DEFAULT 'loopt',  -- loopt | bewezen | werkt_niet | gestopt
  uitkomst TEXT, aangemaakt TEXT DEFAULT (datetime('now','localtime')))`,
    indexes: [],
  },
  {
    name: 'projecten',
    label: 'Projecten',
    about:
      'Projecten in vaste stappen: inspectie (nulmeting met echte cijfers) → diagnose → plan (met klaar_als en taken) → uitvoeren → meten → tiptop. Gebruik de tools project_start en project_stap; TeamBot bewaakt de volgorde en hoeveel projecten tegelijk in de sprint zitten.',
    ddl: `CREATE TABLE IF NOT EXISTS projecten (
  id INTEGER PRIMARY KEY, naam TEXT NOT NULL, site TEXT, doel TEXT, eigenaar TEXT,
  fase TEXT NOT NULL DEFAULT 'inspectie',  -- inspectie | diagnose | plan | uitvoeren | meten | tiptop
  status TEXT NOT NULL DEFAULT 'sprint',  -- sprint | wacht | tiptop | gestopt
  nulmeting TEXT, diagnose TEXT, plan TEXT, klaar_als TEXT, meting TEXT, werklog TEXT, kans_id INTEGER,
  aangemaakt TEXT DEFAULT (datetime('now','localtime')), bijgewerkt TEXT, tiptop_op TEXT)`,
    indexes: ['CREATE INDEX IF NOT EXISTS projecten_status ON projecten(status)'],
  },
  {
    name: 'kansen',
    label: 'Kansen',
    about:
      'Kansen die de researcher vond (nieuwe kanalen, advertentieplatforms, verdienmodellen). Alleen via kans_melden (met bronnen en datum) en kans_scoren; een kans wordt pas werk als de eigenaar ja zegt.',
    ddl: `CREATE TABLE IF NOT EXISTS kansen (
  id INTEGER PRIMARY KEY, titel TEXT NOT NULL, wat TEXT, waarom_nu TEXT, bronnen TEXT, kosten TEXT, risico TEXT, minitest TEXT,
  score INTEGER, scorekaart TEXT, gevonden_door TEXT, gescoord_door TEXT,
  status TEXT NOT NULL DEFAULT 'nieuw',  -- nieuw | gescoord | voorgelegd | ja | nee | later
  voorgelegd TEXT, beslist TEXT, project_id INTEGER, aangemaakt TEXT DEFAULT (datetime('now','localtime')))`,
    indexes: ['CREATE INDEX IF NOT EXISTS kansen_status ON kansen(status)'],
  },
];

export const STANDARD = new Set(STANDARD_TABLES.map((t) => t.name));

/** Decision statuses that still wait for the owner. Everything else counts as handled. */
export const OPEN_DECISION = 'open';

// ---------------------------------------------------------------- decision options

export interface DecisionOption {
  /** Label as the bot wrote it ("A", "1"), or the position (1-based) for list options. */
  key: string;
  /** Option text without its label. */
  text: string;
  /** The option exactly as it will be written back as the answer ("B) Na Black Friday"). */
  answer: string;
}

const clean = (s: string) =>
  s
    .replace(/\s+/g, ' ')
    .replace(/^[\s;,.–-]+|[\s;,]+$/g, '')
    .trim();

/**
 * Read the options a bot wrote for a decision. Bots write them in several ways; all of these work:
 *  - a JSON list: ["Ja", "Nee"] (also [{"label": "Ja"}]);
 *  - lettered: "A) Ja; B) Later; C) Nee" or "A. Ja B. Nee";
 *  - numbered: "1) Ja 2) Nee" or "1. Ja 2. Nee";
 *  - one option per line.
 * Fewer than two recognisable options → [] (the owner answers in his own words).
 */
export function parseOptions(raw: unknown): DecisionOption[] {
  if (raw === null || raw === undefined) return [];
  const s = String(raw).trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const j = JSON.parse(s);
      if (Array.isArray(j)) {
        const list = j
          .map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' ? String(x.label ?? x.text ?? x.titel ?? x.optie ?? '') : String(x ?? '')))
          .map((x) => x.trim())
          .filter(Boolean)
          .slice(0, 12);
        if (list.length >= 2) {
          return list.map((t, i) => {
            const m = t.match(/^([A-H]|\d{1,2})[).:]\s+(.*)$/s);
            return { key: m ? m[1] : String(i + 1), text: clean(m ? m[2] : t), answer: t };
          });
        }
      }
    } catch {
      /* not JSON: try the text formats */
    }
  }
  for (const style of [
    { first: 'A', next: (k: string) => String.fromCharCode(k.charCodeAt(0) + 1), re: /(^|[\s;,(])([A-H])([).:])\s+/g },
    { first: '1', next: (k: string) => String(Number(k) + 1), re: /(^|[\s;,(])(\d{1,2})([).:])\s+/g },
  ]) {
    const marks: { key: string; punct: string; at: number; end: number }[] = [];
    for (const m of s.matchAll(style.re)) {
      const at = (m.index ?? 0) + m[1].length;
      // "(1)" is a reference inside a sentence, not an option label.
      if (m[1] === '(') continue;
      marks.push({ key: m[2], punct: m[3], at, end: (m.index ?? 0) + m[0].length });
    }
    const firstMark = marks.find((x) => x.key === style.first);
    if (!firstMark) continue;
    // Follow the chain A → B → C (or 1 → 2 → 3) in the same punctuation as the first label.
    const chain = [firstMark];
    let want = style.next(style.first);
    for (const x of marks) {
      if (x.at <= chain[chain.length - 1].at) continue;
      if (x.key === want && x.punct === firstMark.punct) {
        chain.push(x);
        want = style.next(want);
      }
    }
    if (chain.length < 2 || s.slice(0, firstMark.at).trim().length > 0) continue;
    return chain.map((x, i) => {
      const body = s.slice(x.end, i + 1 < chain.length ? chain[i + 1].at : s.length);
      const text = clean(body).replace(/[.;]$/, '');
      return { key: x.key, text, answer: `${x.key}${x.punct} ${text}` };
    });
  }
  const lines = s
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*•]\s+/, '').trim())
    .filter(Boolean);
  if (lines.length >= 2 && lines.length <= 12) return lines.map((t, i) => ({ key: String(i + 1), text: clean(t), answer: t }));
  return [];
}
