/**
 * Three first tasks for a brand-new bot's empty chat, fitting what the bot is for: a normal person does not know what
 * to type first, and one tap shows what the bot can do. Pure (no imports), so the unit tests load it. The texts are
 * whole messages: a tap sends exactly what the chip says.
 */

const SETS: { match: RegExp; tasks: [string, string, string] }[] = [
  {
    match: /hoofdbot|verdeel|teamleider|co[oö]rdin|manager/,
    tasks: ['Vertel wie er in het team zit en wat ze doen', 'Geef een overzicht van wat er nu loopt', 'Verdeel een opdracht die ik je zo geef over het team'],
  },
  {
    match: /onderzoek|research|analist|analyse|uitzoek/,
    tasks: ['Zoek het belangrijkste nieuws van deze week in mijn vakgebied', 'Vergelijk drie opties voor me; vraag eerst waarvoor', 'Leg uit hoe je je bronnen controleert'],
  },
  {
    match: /schrij|tekst|copy|content|redact|mail|social/,
    tasks: ['Schrijf een korte welkomstmail voor nieuwe klanten', 'Verbeter een tekst die ik je zo stuur', 'Bedenk vijf onderwerpen voor een bericht op sociale media'],
  },
  {
    match: /code|ontwikkel|software|program|developer|script/,
    tasks: ['Bekijk je werkmap en vertel wat erin staat', 'Schrijf een klein script dat bestanden op datum sorteert', 'Leg uit hoe je code test voordat je iets oplevert'],
  },
  {
    match: /boekhoud|financ|factu|administr|begroting/,
    tasks: ['Leg uit hoe je een factuur controleert', 'Help me een begroting voor deze maand op te zetten', 'Zeg wat je nodig hebt om mijn facturen bij te houden'],
  },
  {
    match: /verko|sales|klant|support|service|marketing|inkoop|inkoper/,
    tasks: ['Schrijf een antwoord aan een klant die om een retour vraagt', 'Maak een lijst van vragen die klanten vaak stellen', 'Bedenk een korte actie om meer klanten te bereiken'],
  },
  {
    match: /plan|agenda|rooster|secretar|organis/,
    tasks: ['Help me mijn week te plannen', 'Maak een takenlijst voor vandaag; vraag eerst wat er speelt', 'Stel een routine voor die elke ochtend mijn dag samenvat'],
  },
];

const GENERAL: [string, string, string] = ['Vertel in het kort wat je voor mij kunt doen', 'Help me mijn week te plannen', 'Stel me drie vragen om mij te leren kennen'];

/** The three suggestions for this bot: by its role first, then its description and name; else three general ones. */
export function firstTasks(bot: { name?: string | null; role?: string | null; description?: string | null }): [string, string, string] {
  for (const hint of [bot.role, bot.description, bot.name]) {
    const text = String(hint || '').toLowerCase();
    if (!text) continue;
    const hit = SETS.find((s) => s.match.test(text));
    if (hit) return hit.tasks;
  }
  return GENERAL;
}
