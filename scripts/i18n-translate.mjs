// Translates the interface texts (i18n/strings.json, Dutch) into every language in ui/src/i18n/languages.json with an
// OpenAI model. Incremental: only texts without a (valid) translation are sent; texts that left the source are dropped.
// Product terms come from a per-language glossary (i18n/glossary.json, made once per language by the same model and
// then kept, so terms stay consistent). Placeholders, plural blocks and markup are checked; failures are retried.
//
// Usage: node scripts/i18n-translate.mjs [--lang de,fr|all] [--model gpt-5.4-mini] [--concurrency 8] [--dry]
//        [--recheck]  also re-send existing translations that fail the checks (placeholders, markup, still Dutch)
//        [--tier flex|default]  flex (default) is half price and a little slower; falls back to default when busy
//        [--effort low]  reasoning effort for reasoning models
// Key: OPENAI_API_KEY, or a file named in TEAMBOT_TRANSLATE_KEY_FILE (never printed). Cost per language is printed
// from the token counts (cached input apart) with the model's list price, or TEAMBOT_TRANSLATE_PRICE
// ("<usd per 1M in>,<usd per 1M cached in>,<usd per 1M out>").
import fs from 'node:fs';
import { extractStrings } from './i18n-extract.mjs';
import { GLOSSARY_FILE, copiedDutchTest, dutchWords, fixMenuPaths, missingPlurals, nameLike, problems, readDict, root, sourceStrings, targets, writeDict, wrongScript } from './i18n-lib.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);
const model = opt('model', process.env.TEAMBOT_TRANSLATE_MODEL || 'gpt-5.4-mini');
const concurrency = Math.max(1, Number(opt('concurrency', 8)));
const dry = flag('dry');
const recheck = flag('recheck');
const wanted = opt('lang', 'all');
const langs = targets().filter((l) => wanted === 'all' || wanted.split(',').includes(l.code));
if (!langs.length) throw new Error(`Onbekende taal: ${wanted}. Talen: ${targets().map((l) => l.code).join(', ')}`);

const key = process.env.OPENAI_API_KEY || (process.env.TEAMBOT_TRANSLATE_KEY_FILE ? fs.readFileSync(process.env.TEAMBOT_TRANSLATE_KEY_FILE, 'utf8').trim() : '');
if (!key && !dry) throw new Error('Zet OPENAI_API_KEY of TEAMBOT_TRANSLATE_KEY_FILE');
// USD per 1M tokens: input, cached input, output (standard tier; flex is half). developers.openai.com/api/docs/pricing
const PRICES = { 'gpt-5.4-mini': [0.75, 0.075, 4.5], 'gpt-5.4-nano': [0.2, 0.02, 1.25], 'gpt-5.4': [2.5, 0.25, 15] };
let tier = opt('tier', process.env.TEAMBOT_TRANSLATE_TIER || 'flex');
const envPrice = (process.env.TEAMBOT_TRANSLATE_PRICE || '').split(',').map(Number);
const listPrice = envPrice.length === 3 && envPrice.every((x) => x >= 0) ? envPrice : PRICES[model];
/** Cost in USD of token counts {in, cached, out, flexShare} (flex requests at half price). */
function costOf(u) {
  if (!listPrice) return null;
  const [pin, pcached, pout] = listPrice;
  const full = ((u.in - u.cached) * pin + u.cached * pcached + u.out * pout) / 1e6;
  return full * (1 - 0.5 * (u.flexShare ?? 0));
}

const strings = sourceStrings();
// Where each text is used (file paths), as context for the model.
const where = (() => {
  try {
    return extractStrings(root).strings;
  } catch {
    return new Map();
  }
})();

/** Product terms that must be translated the same way everywhere (Dutch → what it means in TeamBot). */
const TERMS = {
  TeamBot: 'product name, never translated',
  bot: 'an AI assistant the user made in TeamBot (keep "bot" where the language uses that loanword)',
  bots: 'plural of bot',
  gesprek: 'a chat with a bot (conversation)',
  groep: 'a group chat with several bots and people',
  groepsgesprek: 'group chat',
  routine: 'a scheduled or triggered recurring task a bot runs by itself',
  routines: 'plural of routine',
  'Wacht op jou': 'name of the inbox tab: questions and approvals waiting for the user',
  goedkeuring: 'approval of an action a bot wants to take',
  goedkeuren: 'to approve',
  weigeren: 'to deny / decline',
  toestemming: 'permission',
  'vraagt toestemming': 'access mode: the bot asks permission before acting',
  'alleen lezen': 'access mode: read-only',
  automatisch: 'automatic (also an access mode)',
  'volledige toegang': 'access mode: full access',
  'alleen chatten': 'access mode: chat only, no tools',
  werkmap: "a bot's working folder on the computer (workspace)",
  geheugen: 'what the bots remember about the user (memory)',
  'Over jou': 'memory section: facts about the user',
  dossier: 'a project file in memory that collects decisions and events',
  vergeten: 'to forget (remove from memory)',
  skill: 'a reusable instruction package for bots (keep "skill" if that is the usual loanword)',
  marktplaats: 'marketplace for skills and apps',
  'apps en connectoren': 'external services connected via MCP',
  kanaal: 'a chat app connection such as Telegram or WhatsApp (channel)',
  koppelen: 'to connect (an account, app, phone or service)',
  sleutel: 'API key',
  eigenaar: 'owner of the TeamBot installation',
  lid: 'member (user account)',
  gast: 'guest',
  takenbord: 'task board',
  teamtabellen: 'shared data tables of the team',
  vergadernotities: 'meeting notes',
  notulen: 'minutes of a meeting',
  meldingen: 'notifications',
  Instellingen: 'Settings',
  Algemeen: 'General (settings tab)',
  engine: 'the AI engine a bot runs on (Claude Code, Codex, an API model)',
  provider: 'AI provider (OpenAI, Anthropic, …)',
  model: 'AI model',
  dicteren: 'dictation (speech to text)',
  voorlezen: 'read aloud (text to speech)',
  spraak: 'voice / speech features',
  stem: 'a text-to-speech voice',
  'live gesprek': 'a live voice call with a bot',
  Meer: 'More (bottom tab on the phone)',
  Chats: 'Chats (bottom tab on the phone)',
  'Bot-instellingen': 'the settings of one bot',
  'Nieuwe bot': 'New bot',
  delen: 'to share',
  Versturen: 'Send (a message)',
  Opslaan: 'Save',
  Annuleren: 'Cancel',
};

const STYLE = {
  en: 'British/international English. Second person ("you"), plain and friendly.',
  de: 'German. Address the user informally with "du" (lowercase), as modern consumer apps do; never "Sie". Correct noun capitalisation.',
  fr: 'French (France). Address the user with "vous". French typography: a space before ? ! : ; is fine but not required; use « » only where the source uses quotes around a phrase.',
  es: 'Spanish (Spain). Address the user informally with "tú".',
  it: 'Italian. Address the user informally with "tu".',
  pt: 'Brazilian Portuguese (pt-BR). Address the user with "você".',
  pl: 'Polish. Address the user informally in the second person singular, or use neutral/infinitive forms for buttons and labels as Polish apps do.',
  tr: 'Turkish. Address the user politely with "siz" forms, as Turkish software does; keep sentences short.',
  uk: 'Ukrainian. Address the user with "ви" (lowercase), as Ukrainian software does. Use Ukrainian, never Russian, words and spelling.',
  ar: 'Modern Standard Arabic, clear and neutral for all Arabic speakers. Address the user in the masculine singular where Arabic requires a gender. Keep Latin digits and the placeholders as they are; Latin product names stay in Latin script.',
};

const pluralCats = (locale) => new Intl.PluralRules(locale).resolvedOptions().pluralCategories.join(', ');

function systemPrompt(lang, glossary) {
  return `You translate the user interface of "TeamBot" from Dutch into ${lang.english} (${lang.name}, locale ${lang.locale}). TeamBot is an open-source desktop and phone app where people run their own team of AI bots: chats, group chats, routines, approvals, memory, voice, connected apps.
Input: a JSON object {id: {"t": Dutch text, "w": source file it appears in}}. Output: ONLY a JSON object {id: translation} with every id.
Style: ${STYLE[lang.code] || `${lang.english}, natural and concise, as a native product writer would phrase app UI.`}
Rules:
- Translate the meaning naturally for an app interface; short labels stay short. A single word is usually a button, label, tab or heading. Texts that start or end mid-sentence (", bezig:", "Alle taken van") are fragments of a longer sentence: translate them as fitting fragments.
- Keep every placeholder {0} {1} … exactly (same set). When a placeholder is a count (a number followed by a noun, "bericht(en)", "{0} bots"), use ICU plural syntax for it: {0, plural, one {# …} other {# …}} with exactly these categories for this language: ${pluralCats(lang.locale)} ("other" is required, "#" is the number). Otherwise keep the plain {0}.
- Keep leading/trailing spaces, punctuation style, line breaks, markdown (**bold**, \`code\`), tags such as <b>, URLs, keyboard keys (Ctrl+K, Enter, Esc), file names, paths, commands, code and emoji exactly as they are.
- Brand and product names stay as is: TeamBot, OpenBot, OpenAI, ChatGPT, Anthropic, Claude, Claude Code, Codex, OpenCode, Gemini, Ollama, LM Studio, OpenRouter, MCP, ACP, Telegram, WhatsApp, Slack, Discord, Signal, Brave, Tavily, SearXNG, DuckDuckGo, Wikipedia, Tailscale, Google, Microsoft, GitHub, Notion, Piper, Parakeet, Whisper, Windows, macOS, Linux, Android, iPhone, PWA, SSO, SCIM, DPAPI, API.
- Names of bots and people and literal example data stay as they are.
- Use this glossary for product terms, consistently:
${Object.entries(glossary).map(([nl, tr]) => `  ${nl} → ${tr}`).join('\n')}
Do not add explanations or notes.`;
}

let tin = 0;
let tcached = 0;
let tout = 0;
let flexCalls = 0;
let calls = 0;
// Reasoning models translate UI texts well with little thinking; 'low' keeps a language cheap and quick.
let effort = opt('effort', process.env.TEAMBOT_TRANSLATE_EFFORT || 'low');
async function chat(system, user) {
  for (let attempt = 0; ; attempt++) {
    const useFlex = tier === 'flex' && attempt < 3;
    try {
      const body = { model, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
      if (effort && effort !== 'none') body.reasoning_effort = effort;
      if (useFlex) body.service_tier = 'flex';
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(useFlex ? 300_000 : 180_000),
      });
      const j = await r.json();
      // A model without reasoning settings, or without the flex tier: from now on without them.
      if (r.status === 400 && body.reasoning_effort && /reasoning/i.test(j?.error?.message || '')) {
        effort = 'none';
        continue;
      }
      if (r.status === 400 && useFlex && /service.?tier|flex/i.test(j?.error?.message || '')) {
        tier = 'default';
        continue;
      }
      if (!r.ok) throw Object.assign(new Error(`${r.status} ${j?.error?.message || ''}`), { status: r.status });
      tin += j.usage?.prompt_tokens || 0;
      tcached += j.usage?.prompt_tokens_details?.cached_tokens || 0;
      tout += j.usage?.completion_tokens || 0;
      calls++;
      if (j.service_tier === 'flex') flexCalls++;
      return JSON.parse(j.choices[0].message.content);
    } catch (e) {
      if (attempt >= 4 || e.status === 401 || e.status === 404) throw e;
      await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
    }
  }
}

/** The glossary for a language: made once by the model from TERMS and stored, so later runs use the same terms. */
async function glossaryFor(lang) {
  const all = fs.existsSync(GLOSSARY_FILE) ? JSON.parse(fs.readFileSync(GLOSSARY_FILE, 'utf8')) : {};
  const have = all[lang.code] || {};
  const missing = Object.keys(TERMS).filter((t) => !have[t]);
  if (missing.length && !dry) {
    const out = await chat(
      `You are a senior UI localiser. For the app "TeamBot" (an app where people run their own team of AI bots) give the standard ${lang.english} (${lang.name}) UI term for each Dutch product term, the way a native product writer would use it in this app. ${STYLE[lang.code] || ''} Return ONLY a JSON object {dutch term: ${lang.english} term}. Keep loanwords (bot, skill, chat) where they are the usual term in ${lang.english} apps.`,
      JSON.stringify(Object.fromEntries(missing.map((t) => [t, TERMS[t]]))),
    );
    for (const t of missing) if (typeof out[t] === 'string' && out[t].trim()) have[t] = out[t].trim();
    all[lang.code] = Object.fromEntries(Object.keys(TERMS).filter((t) => have[t]).map((t) => [t, have[t]]));
    fs.writeFileSync(GLOSSARY_FILE, JSON.stringify(Object.fromEntries(Object.keys(all).sort().map((k) => [k, all[k]])), null, 1) + '\n');
  }
  return have;
}

/** Per language: does a translation keep Dutch copied from its source ("Controle mislukt : {0}")? */
const copiedTests = new Map();
const copied = (lang, src, dst) => {
  if (!copiedTests.has(lang.code)) copiedTests.set(lang.code, copiedDutchTest(lang.code, readDict(lang.code), strings, readDict('en')));
  return copiedTests.get(lang.code)(src, dst);
};

/** Is an existing translation still acceptable? */
function acceptable(lang, src, dst, lastTry = false) {
  if (problems(src, dst).length) return false;
  if (wrongScript(lang.code, dst, src)) return false;
  if (!lastTry && copied(lang, src, dst)) return false;
  // Every plural form the language needs ("few" and "many" in Polish, Ukrainian and Arabic); on the last try a
  // block with fewer forms beats a Dutch text.
  if (!lastTry && missingPlurals(lang.locale, dst).length) return false;
  // Identical to a clearly Dutch source: not translated (unless the model keeps it after being asked again: names,
  // words that are the same in both languages).
  if (!lastTry && dst === src && dutchWords(lang.code).test(src) && src.split(' ').length > 1 && !nameLike(src)) return false;
  return true;
}

async function translateLanguage(lang) {
  const dict = readDict(lang.code);
  const keep = new Set(strings);
  for (const k of Object.keys(dict)) if (!keep.has(k)) delete dict[k];
  // Always again: translations that kept Dutch from their source (the check calls them "nog Nederlands").
  let todo = strings.filter((s) => !(s in dict) || (recheck ? !acceptable(lang, s, dict[s]) : copied(lang, s, dict[s])));
  const t0 = { tin, tout };
  console.log(`[${lang.code}] ${todo.length} te vertalen (van ${strings.length}).`);
  if (dry || !todo.length) {
    if (!dry) {
      fixMenuPaths(dict);
      writeDict(lang.code, dict);
    }
    return { lang: lang.code, sent: 0, failed: dry ? todo.length : 0 };
  }
  const glossary = await glossaryFor(lang);
  const system = systemPrompt(lang, glossary);
  // Texts from the same file together: the model sees related texts side by side.
  const fileOf = (s) => [...(where.get(s) || [])][0] || '';
  todo.sort((a, b) => fileOf(a).localeCompare(fileOf(b)) || a.localeCompare(b));
  let failed = [];
  for (let round = 0; round < 3 && todo.length; round++) {
    const batches = [];
    let cur = [];
    let size = 0;
    const max = round === 0 ? 70 : 20;
    for (const s of todo) {
      if (cur.length >= max || size + s.length > 7000) {
        batches.push(cur);
        cur = [];
        size = 0;
      }
      cur.push(s);
      size += s.length;
    }
    if (cur.length) batches.push(cur);
    failed = [];
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        const input = Object.fromEntries(batch.map((s, i) => [String(i + 1), { t: s, w: fileOf(s) || undefined }]));
        let res = {};
        try {
          res = await chat(system, JSON.stringify(input));
        } catch (e) {
          console.warn(`[${lang.code}] batch mislukt: ${e.message}`);
        }
        batch.forEach((s, i) => {
          const v = res[String(i + 1)];
          if (typeof v === 'string' && acceptable(lang, s, v, round === 2)) dict[s] = v;
          else failed.push(s);
        });
        done++;
        if (done % 10 === 0 || done === batches.length) {
          writeDict(lang.code, dict);
          console.log(`[${lang.code}] ronde ${round + 1}: ${done}/${batches.length} batches`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
    writeDict(lang.code, dict);
    todo = failed;
  }
  // Menu paths name the labels as this language shows them ("Instellingen › Spraak" → "Paramètres › Voix").
  const paths = fixMenuPaths(dict);
  if (paths) {
    writeDict(lang.code, dict);
    console.log(`[${lang.code}] ${paths} menupad(en) met Nederlandse labels vertaald.`);
  }
  const used = { in: tin - t0.tin, out: tout - t0.tout };
  console.log(`[${lang.code}] klaar: ${Object.keys(dict).length} vertalingen, ${failed.length} niet gelukt. Tokens ${used.in} in / ${used.out} uit.`);
  for (const s of failed.slice(0, 15)) console.log(`   niet vertaald: ${JSON.stringify(s).slice(0, 140)}`);
  return { lang: lang.code, failed: failed.length, tokens: used };
}

const results = [];
// Languages one after another (each runs `concurrency` requests at once).
for (const l of langs) results.push(await translateLanguage(l));
// Totals over all languages (per-language cost is printed by translateLanguage).
const sum = results.reduce((a, r) => ({ in: a.in + (r.tokens?.in || 0), cached: a.cached + (r.tokens?.cached || 0), out: a.out + (r.tokens?.out || 0) }), { in: 0, cached: 0, out: 0 });
const total = costOf(sum);
console.log(`\nTotaal: ${sum.in} tokens in (${sum.cached} uit de cache) / ${sum.out} uit${total == null ? '' : ` ≈ $${total.toFixed(3)}`}. ${results.map((r) => `${r.lang}: ${r.failed} open`).join(', ')}`);
