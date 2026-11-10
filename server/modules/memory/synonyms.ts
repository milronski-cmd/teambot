/**
 * Synonyms for word search, so "wagen" also finds "auto" without any embedding model.
 *
 * Two sources, both only in the word index (FTS), never in what a memory says:
 * 1. what the learner adds per memory in the same call that extracts it (`terms`: keywords and synonyms in Dutch and
 *    English, validated below);
 * 2. this small built-in list of everyday words in Dutch and English (home, family, health, food, money, work, shop,
 *    software, time). Groups are kept tight (real synonyms or translations), because a wider word net makes search
 *    find more of the wrong things too.
 *
 * Own list (no copied thesaurus): common words a person uses about his own life and business.
 */
import { detectSecret, isInjectionLike, normalize, stem } from './text.js';

const GROUPS: string[][] = [
  // vehicles and transport
  ['auto', 'wagen', 'car', 'voertuig', 'vehicle', 'automobiel'],
  ['fiets', 'rijwiel', 'bike', 'bicycle'],
  ['motor', 'motorfiets', 'motorbike', 'motorcycle'],
  ['vrachtwagen', 'truck', 'vrachtauto'],
  ['trein', 'train', 'spoor'],
  ['vliegtuig', 'plane', 'airplane', 'vlucht', 'flight'],
  ['rijbewijs', 'driving licence', 'drivers license'],
  ['parkeerplaats', 'parking', 'parkeerplek'],
  // home
  ['huis', 'woning', 'home', 'house', 'thuis'],
  ['appartement', 'flat', 'apartment'],
  ['huur', 'rent', 'huurprijs'],
  ['hypotheek', 'mortgage'],
  ['verhuizen', 'verhuizing', 'move', 'moving', 'relocate'],
  ['adres', 'address', 'woonadres'],
  ['woonplaats', 'stad', 'dorp', 'city', 'town', 'woon'],
  ['tuin', 'garden', 'achtertuin'],
  ['keuken', 'kitchen'],
  ['badkamer', 'bathroom'],
  ['slaapkamer', 'bedroom'],
  ['zolder', 'attic', 'vliering'],
  ['verbouwing', 'renovatie', 'renovation', 'verbouwen', 'remodel'],
  ['loodgieter', 'plumber'],
  ['elektricien', 'electrician'],
  ['zonnepanelen', 'zonnepaneel', 'solar', 'zonnestroom', 'pv'],
  ['warmtepomp', 'heat pump'],
  ['verwarming', 'heating', 'cv', 'ketel', 'boiler'],
  ['energie', 'stroom', 'electricity', 'energy'],
  ['wasmachine', 'washing machine'],
  // family and people
  ['vrouw', 'echtgenote', 'wife', 'partner', 'vriendin'],
  ['man', 'echtgenoot', 'husband', 'partner', 'vriend'],
  ['partner', 'echtgenoot', 'echtgenote', 'spouse', 'wederhelft'],
  ['kind', 'kinderen', 'child', 'children', 'kids', 'kroost'],
  ['zoon', 'son'],
  ['dochter', 'daughter'],
  ['moeder', 'mama', 'mother', 'mom', 'mam'],
  ['vader', 'papa', 'father', 'dad', 'pap'],
  ['ouders', 'parents'],
  ['broer', 'brother'],
  ['zus', 'zuster', 'sister'],
  ['opa', 'grootvader', 'grandfather', 'grandpa'],
  ['oma', 'grootmoeder', 'grandmother', 'grandma'],
  ['buurman', 'buurvrouw', 'buren', 'neighbour', 'neighbor'],
  ['vriend', 'vriendin', 'friend', 'maat'],
  ['verjaardag', 'jarig', 'birthday', 'geboortedag'],
  ['geboortedatum', 'date of birth', 'birthdate'],
  ['bruiloft', 'trouwen', 'huwelijk', 'wedding', 'marriage'],
  // pets
  ['huisdier', 'pet', 'huisdieren'],
  ['hond', 'dog', 'viervoeter', 'puppy', 'pup'],
  ['kat', 'poes', 'cat', 'kitten'],
  ['dierenarts', 'vet', 'veterinarian'],
  // health
  ['dokter', 'arts', 'huisarts', 'doctor', 'gp', 'physician'],
  ['tandarts', 'dentist', 'gebit'],
  ['ziekenhuis', 'hospital', 'kliniek', 'clinic'],
  ['medicijn', 'medicijnen', 'medicatie', 'medication', 'medicine', 'pillen'],
  ['allergie', 'allergisch', 'allergy', 'allergic', 'overgevoelig'],
  ['ziek', 'ziekte', 'sick', 'ill', 'illness'],
  ['fysiotherapeut', 'fysio', 'physio', 'physiotherapist'],
  ['zwanger', 'zwangerschap', 'pregnant', 'pregnancy'],
  ['sporten', 'sport', 'training', 'workout', 'exercise'],
  ['sportschool', 'gym', 'fitness'],
  ['hardlopen', 'rennen', 'running', 'jogging'],
  ['afvallen', 'gewicht', 'weight', 'lose weight'],
  ['slapen', 'slaap', 'sleep'],
  // food and diet
  ['eten', 'maaltijd', 'food', 'meal'],
  ['dieet', 'diet', 'voeding'],
  ['vegetarisch', 'vegetarier', 'vegetarian', 'geen vlees'],
  ['veganistisch', 'vegan', 'plantaardig'],
  ['glutenvrij', 'gluten free', 'coeliakie'],
  ['lactose', 'zuivel', 'dairy', 'melk'],
  ['pinda', 'pindas', 'peanut', 'peanuts', 'noten', 'nuts'],
  ['koffie', 'coffee', 'espresso', 'cappuccino'],
  ['thee', 'tea'],
  ['bier', 'beer'],
  ['wijn', 'wine'],
  ['ontbijt', 'breakfast'],
  ['lunch', 'middageten'],
  ['avondeten', 'diner', 'dinner', 'avondmaal'],
  ['restaurant', 'eetcafe', 'eten buiten de deur'],
  ['boodschappen', 'groceries', 'supermarkt', 'supermarket'],
  // money
  ['geld', 'money', 'cash'],
  ['prijs', 'kosten', 'kost', 'price', 'cost', 'tarief', 'bedrag'],
  ['betalen', 'betaling', 'payment', 'pay', 'afrekenen'],
  ['factuur', 'rekening', 'invoice', 'bill', 'nota'],
  ['onbetaald', 'openstaand', 'unpaid', 'outstanding', 'achterstallig'],
  ['offerte', 'quote', 'quotation', 'prijsopgave'],
  ['salaris', 'loon', 'salary', 'wage', 'inkomen', 'income'],
  ['belasting', 'tax', 'belastingdienst', 'fiscus'],
  ['btw', 'vat', 'omzetbelasting'],
  ['bank', 'bankrekening', 'bank account', 'rekeningnummer', 'iban'],
  ['spaargeld', 'sparen', 'savings', 'save'],
  ['verzekering', 'insurance', 'polis'],
  ['pensioen', 'pension', 'retirement'],
  ['budget', 'begroting', 'budgetten'],
  ['korting', 'discount', 'aanbieding', 'sale'],
  ['abonnement', 'subscription', 'lidmaatschap', 'membership'],
  ['schuld', 'lening', 'debt', 'loan'],
  ['boekhouding', 'administratie', 'bookkeeping', 'accounting'],
  ['boekhouder', 'accountant'],
  ['omzet', 'revenue', 'turnover', 'sales'],
  ['winst', 'profit', 'marge', 'margin'],
  // work and business
  ['werk', 'baan', 'job', 'work', 'werkt'],
  ['werkgever', 'employer', 'baas', 'bedrijf waar ik werk'],
  ['werknemer', 'medewerker', 'employee', 'personeel', 'staff'],
  ['collega', 'collegas', 'colleague', 'colleagues'],
  ['baas', 'manager', 'leidinggevende', 'chef', 'boss'],
  ['beroep', 'functie', 'vak', 'profession', 'occupation', 'role'],
  ['bedrijf', 'zaak', 'onderneming', 'firma', 'company', 'business', 'bv'],
  ['winkel', 'zaak', 'shop', 'store'],
  ['webshop', 'webwinkel', 'online winkel', 'online shop', 'e-commerce', 'ecommerce'],
  ['klant', 'klanten', 'client', 'customer', 'opdrachtgever'],
  ['leverancier', 'supplier', 'vendor', 'groothandel'],
  ['contract', 'overeenkomst', 'agreement'],
  // (an appointment is no meeting: "afspraak met de notaris" matched "Wanneer vergaderen we?")
  ['afspraak', 'appointment'],
  ['vergadering', 'overleg', 'meeting', 'bespreking', 'standup'],
  ['deadline', 'uiterlijk', 'due date', 'einddatum'],
  ['project', 'opdracht', 'klus'],
  ['taak', 'taken', 'task', 'todo', 'actiepunt'],
  ['vakantie', 'verlof', 'holiday', 'vacation', 'vrije dagen'],
  ['ziekmelding', 'sick leave', 'ziek gemeld'],
  ['kantoor', 'office', 'werkplek'],
  ['thuiswerken', 'remote', 'home office', 'werk vanuit huis'],
  ['openingstijden', 'opening hours', 'geopend', 'sluitingstijd', 'gesloten', 'dicht', 'closed'],
  ['levering', 'leveren', 'bezorging', 'delivery', 'verzending', 'shipping'],
  ['retour', 'retourneren', 'terugsturen', 'return', 'refund', 'terugbetaling'],
  ['voorraad', 'stock', 'inventory', 'inventaris'],
  ['bestelling', 'order', 'bestellen'],
  ['marketing', 'reclame', 'advertising', 'advertenties', 'ads'],
  ['seo', 'vindbaarheid', 'zoekmachine', 'search engine'],
  ['nieuwsbrief', 'newsletter', 'mailing'],
  ['klantenservice', 'support', 'helpdesk', 'customer service'],
  ['werkuren', 'werktijden', 'working hours', 'werkweek'],
  // software, web and IT
  ['computer', 'pc', 'laptop', 'notebook'],
  ['telefoon', 'mobiel', 'gsm', 'smartphone', 'phone', 'iphone'],
  ['website', 'site', 'webpagina', 'webpage', 'homepage'],
  ['hosting', 'webhosting', 'host', 'hostingprovider', 'server', 'webserver'],
  ['server', 'vps', 'backend'],
  ['domein', 'domeinnaam', 'domain'],
  ['wachtwoordmanager', 'password manager'],
  ['inloggen', 'login', 'log in', 'aanmelden', 'sign in'],
  ['email', 'e-mail', 'mail', 'mailtje'],
  ['versie', 'version', 'release', 'update'],
  ['programmeertaal', 'programming language'],
  ['database', 'databank', 'db'],
  ['backup', 'back-up', 'reservekopie'],
  ['app', 'applicatie', 'application', 'programma', 'software'],
  ['printer', 'printen', 'afdrukken', 'print'],
  ['internet', 'wifi', 'netwerk', 'network'],
  ['storing', 'kapot', 'defect', 'outage', 'broken', 'stuk'],
  ['bug', 'fout', 'error', 'probleem', 'issue'],
  // time and planning
  ['maandag', 'monday'],
  ['dinsdag', 'tuesday'],
  ['woensdag', 'wednesday'],
  ['donderdag', 'thursday'],
  ['vrijdag', 'friday'],
  ['zaterdag', 'saturday'],
  ['zondag', 'sunday'],
  ['weekend', 'zaterdag en zondag'],
  ['ochtend', 'morning', 'voormiddag', 'smorgens'],
  ['middag', 'afternoon', 'namiddag'],
  ['avond', 'evening', 'savonds'],
  ['dagelijks', 'elke dag', 'daily', 'iedere dag'],
  ['wekelijks', 'elke week', 'weekly', 'iedere week'],
  ['maandelijks', 'elke maand', 'monthly'],
  ['jaarlijks', 'elk jaar', 'yearly', 'annual'],
  ['agenda', 'kalender', 'calendar', 'planning', 'schedule'],
  // communication and documents
  ['bellen', 'telefoneren', 'call', 'gebeld', 'phone call'],
  ['bericht', 'berichtje', 'message', 'appje', 'sms'],
  ['brief', 'letter', 'post'],
  ['document', 'bestand', 'file', 'doc'],
  ['handtekening', 'ondertekenen', 'signature', 'sign'],
  ['paspoort', 'passport', 'id-kaart', 'identiteitsbewijs'],
  ['contactpersoon', 'contact', 'aanspreekpunt'],
  ['telefoonnummer', 'nummer', 'phone number', 'mobiel nummer'],
  // travel and places
  ['reis', 'trip', 'travel', 'reizen', 'uitje'],
  ['hotel', 'accommodatie', 'overnachting', 'accommodation'],
  ['camping', 'kamperen', 'camping trip', 'tent'],
  ['strand', 'beach', 'zee', 'sea'],
  ['buitenland', 'abroad', 'overseas'],
  ['school', 'opleiding', 'studie', 'education', 'study'],
  ['universiteit', 'university', 'hogeschool', 'college'],
  // (not "training": that is sport just as often — "Waar train ik?" found a welding course)
  ['cursus', 'course', 'workshop'],
  ['examen', 'toets', 'exam'],
  ['kerk', 'church'],
  ['gemeente', 'municipality', 'gemeentehuis', 'city hall'],
  // preferences and style
  ['kort', 'beknopt', 'short', 'brief', 'bondig'],
  ['uitgebreid', 'lang', 'detailed', 'long', 'uitvoerig'],
  ['formeel', 'formal', 'u-vorm'],
  ['informeel', 'informal', 'je-vorm', 'jij-vorm'],
  ['favoriet', 'lievelings', 'favourite', 'favorite', 'voorkeur', 'preference'],
  ['hekel', 'haat', 'hate', 'dislike', 'niet lekker'],
  ['muziek', 'music'],
  ['film', 'movie', 'films'],
  ['boek', 'boeken', 'book', 'roman', 'novel'],
  ['hobby', 'hobbys', 'hobbies', 'vrije tijd', 'pastime'],
  ['voetbal', 'football', 'soccer'],
  ['kleur', 'colour', 'color'],
  ['blauw', 'blue'],
  ['rood', 'red'],
  ['groen', 'green'],
  ['zwart', 'black'],
  ['wit', 'white'],
];

/** word (normalised, single words only) → the other words of its groups. */
const INDEX = new Map<string, Set<string>>();
for (const g of GROUPS) {
  const words = g.map((w) => normalize(w)).filter(Boolean);
  for (const w of words) {
    if (w.includes(' ')) continue;
    for (const k of [w, stem(w)]) {
      const set = INDEX.get(k) || new Set<string>();
      for (const o of words) if (o !== w) set.add(o);
      INDEX.set(k, set);
    }
  }
}

/**
 * Heads of Dutch compounds that are too ambiguous to stand for the whole word ("spaarrekening" is no invoice,
 * "e-mailadres" no home address, "zakenpartner" no spouse).
 */
const AMBIGUOUS_HEADS = new Set(['rekening', 'adres', 'partner', 'vrouw', 'vriend', 'vriendin', 'brief', 'post', 'nummer', 'contact', 'kleur', 'stad']);

/**
 * The head of a Dutch compound when it is a known everyday word (the last part carries the meaning: "teamoverleg" is an
 * "overleg", "webwinkel" a "winkel", "schoonvader" a "vader"). At least 5 letters, after at least 3; null otherwise.
 */
export function compoundHead(word: string, evenKnown = false): string | null {
  const w = normalize(word);
  if (w.length < 8 || /\d|\s/.test(w) || (!evenKnown && (INDEX.has(w) || INDEX.has(stem(w))))) return null;
  for (let i = 3; i <= w.length - 5; i++) {
    const head = w.slice(i);
    if (AMBIGUOUS_HEADS.has(head) || AMBIGUOUS_HEADS.has(stem(head))) continue;
    if (INDEX.has(head) || INDEX.has(stem(head))) return head;
  }
  return null;
}

/** The known heads of the compounds in a text ("Wanneer is het teamoverleg?" → ["overleg"]). */
export function compoundHeads(text: string, max = 6): string[] {
  const out = new Set<string>();
  for (const w of normalize(text).split(' ')) {
    const h = w ? compoundHead(w) : null;
    if (h) out.add(h);
    if (out.size >= max) break;
  }
  return [...out];
}

/** Built-in synonyms of the words in a text (not the words themselves), at most `max`; compounds via their head. */
export function builtinSynonyms(text: string, max = 24): string[] {
  const own = new Set(normalize(text).split(' ').filter(Boolean));
  const out = new Set<string>();
  const add = (w: string) => {
    const hit = INDEX.get(w) || INDEX.get(stem(w));
    if (hit) for (const s of hit) if (!own.has(s)) out.add(s);
    return !!hit;
  };
  for (const w of own) {
    if (w.length < 3 && !/\d/.test(w)) continue;
    if (add(w)) {
      if (out.size >= max) break;
      continue;
    }
    // "teamoverleg": the head word itself and its group.
    const head = compoundHead(w);
    if (head && !own.has(head)) (out.add(head), add(head));
    if (out.size >= max) break;
  }
  // A synonym that is itself a compound of a known word ("webshop" → "webwinkel" → "winkel").
  for (const s of [...out]) {
    if (out.size >= max) break;
    const head = compoundHead(s, true);
    if (head && !own.has(head)) out.add(head);
  }
  return [...out].slice(0, max);
}

/**
 * The learner's keywords/synonyms for one memory, made safe: short words or two-word phrases in letters, digits and
 * hyphens, no secrets, nothing that reads like an instruction, at most 10. They only go into the word index.
 */
export function cleanTerms(input: unknown, content: string): string[] | null {
  if (!Array.isArray(input)) return null;
  const own = new Set(normalize(content).split(' '));
  const out: string[] = [];
  for (const x of input.slice(0, 20)) {
    const t = normalize(String(x ?? ''));
    if (t.length < 2 || t.length > 40 || t.split(' ').length > 3) continue;
    if (own.has(t) || out.includes(t)) continue;
    if (detectSecret(String(x)) || isInjectionLike(String(x))) continue;
    out.push(t);
    if (out.length >= 10) break;
  }
  return out.length ? out : null;
}
