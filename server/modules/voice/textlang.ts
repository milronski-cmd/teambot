/**
 * Cheap guess of the language a text is written in, to pick a voice that can read it (local Piper voice, or the
 * language the browser voice gets). Server side on purpose: the word lists would otherwise be picked up as Dutch
 * interface text by the translation extractor (scripts/i18n-extract.mjs scans every string in ui/src).
 */
import { baseLang } from '../../../shared/voiceLanguage.js';

const words = (s: string) => new Set(s.split(' '));

/** Short, frequent function words (lower case). Words shared between languages count for each of them. */
const WORDS: Record<string, Set<string>> = {
  nl: words(
    'de het een en van ik je jij u we wij zij is zijn niet dat die wat met voor op aan in naar ook maar dan als bij nog wel kan kun wil heb heeft hebben moet gaat worden wordt dit deze er hier daar om tot uit over zo veel goed graag even mij mijn jouw onze geen al',
  ),
  en: words(
    'the a an and of i you we they he she it is are was were not that this what with for on at in to also but then if by still can could will would have has had must going be been here there about so much good please just me my your our no all from do does did',
  ),
  de: words(
    'der die das und ist nicht ich du sie wir ihr er es ein eine einen einem dem den des mit für auf im zu von bei auch aber dann wenn noch schon kann kannst können will willst habe hat haben muss wird wurde werden dies diese hier dort aus über viel gut bitte mal mich mir dich dir mein dein unser kein keine alle nur sehr wie was wo wann warum ja nein hallo danke heute gestern guten jetzt uns euch',
  ),
  fr: words(
    "le la les un une des du et est sont ne pas je tu il elle nous vous ils elles que qui quoi avec pour sur dans au aux mais donc aussi plus très bien merci ce cette ces mon ma mes ton ta votre notre leur être avoir fait peut peux veux faut tout tous rien oui non c'est j'ai bonjour salut aujourd'hui demain hier quel quelle voici voilà chez où comment pourquoi quand me te se son sa ses",
  ),
  es: words(
    'el la los las un una unos unas del y es son no yo tú él ella nosotros ellos que qué con para por en al pero también más muy bien gracias este esta estos mi mis tu su nuestro ser estar hay puede puedes quieres todo nada sí cómo dónde cuando porque está hola buenos días hoy mañana ayer aquí cuál me te se lo le les',
  ),
  it: words(
    "il lo la gli le un uno una di del della dei e è sono non io tu lui lei noi voi loro che chi con per su nel nella al alla ma se anche più molto bene grazie questo questa mio mia tuo suo nostro essere avere ha ho può puoi vuoi posso tutto niente sì come dove quando perché ciao buongiorno oggi domani ieri ecco mi ti si ci sei siamo c'è",
  ),
  pt: words(
    'o a os as um uma uns umas do da dos das e é são não eu você ele ela nós vocês eles que com para por em no na ao mas também mais muito bem obrigado obrigada este esta isso isto meu minha seu sua nosso ser estar tem pode quer tudo nada sim como onde quando porque está olá oi bom dia hoje amanhã ontem aqui qual lhe',
  ),
  pl: words(
    'i w z na nie to jest są się że do co jak ja ty on ona my wy oni ale czy tak już jeszcze bardzo dobrze dziękuję ten ta te mój moja twój nasz być mieć ma może możesz wszystko nic gdzie kiedy dlaczego bo od po przez dla jestem cześć dzień dobry dziś dzisiaj jutro wczoraj oto mi ci go jej ich proszę',
  ),
  tr: words(
    've bir bu şu o ben sen biz siz onlar değil ne için ile da de mi mı mu mü misin musun ama çok iyi teşekkürler teşekkür ederim evet hayır var yok gibi daha her şey nasıl nerede neden çünkü olarak olan oldu ise kadar sonra önce bana sana merhaba günaydın bugün yarın dün işte şimdi lütfen tamam bunu şunu senin benim bizim',
  ),
};

/** Letters that (nearly) only one of these languages uses: a little extra weight for short texts. */
const LETTERS: [RegExp, string][] = [
  [/[łąęśźżń]/g, 'pl'],
  [/[ğış]/g, 'tr'],
  [/[ãõ]/g, 'pt'],
  [/[ñ¿¡]/g, 'es'],
  [/[ßä]/g, 'de'],
  [/[ìò]/g, 'it'],
  [/[œîû]/g, 'fr'],
  [/[ĳ]/g, 'nl'],
];

/**
 * The language of a text: Arabic and Cyrillic by script (Ukrainian vs Russian by their own letters), Latin-script
 * languages by common words. null when unclear. `home` (the language of the voice that would read it anyway) wins a
 * near tie, so a mostly Dutch answer with a few English words stays Dutch.
 */
export function detectTextLanguage(text: string, home?: string | null): string | null {
  const sample = String(text || '').slice(0, 4000);
  let arabic = 0;
  let cyrillic = 0;
  let latin = 0;
  for (const ch of sample) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x600 && c <= 0x6ff) || (c >= 0x750 && c <= 0x77f) || (c >= 0xfb50 && c <= 0xfdff) || (c >= 0xfe70 && c <= 0xfeff)) arabic++;
    else if (c >= 0x400 && c <= 0x4ff) cyrillic++;
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c <= 0x24f)) latin++;
  }
  const letters = arabic + cyrillic + latin;
  if (letters >= 3 && arabic > letters * 0.5) return 'ar';
  if (letters >= 3 && cyrillic > letters * 0.5) {
    const uk = (sample.match(/[іїєґІЇЄҐ]/g) || []).length;
    const ru = (sample.match(/[ыэъёЫЭЪЁ]/g) || []).length;
    return ru > uk ? 'ru' : 'uk';
  }
  const lower = sample.toLowerCase();
  const toks = lower
    .replace(/’/g, "'")
    .split(/[^\p{L}']+/u)
    .filter(Boolean)
    .slice(0, 400);
  const score: Record<string, number> = {};
  for (const w of toks) for (const [lang, set] of Object.entries(WORDS)) if (set.has(w)) score[lang] = (score[lang] || 0) + 1;
  for (const [re, lang] of LETTERS) {
    const n = (lower.match(re) || []).length;
    if (n) score[lang] = (score[lang] || 0) + Math.min(3, n * 0.5);
  }
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;
  const [top, best] = ranked[0];
  const second = ranked[1]?.[1] || 0;
  const total = ranked.reduce((n, [, v]) => n + v, 0);
  if (total < 3 || best < 2) return null;
  const h = home ? baseLang(home) : null;
  // The home language needs a smaller lead (1.2×) than a switch away from it (1.5×).
  if (h && top === h) return best > second * 1.2 ? h : null;
  return best > second * 1.5 ? top : null;
}
