// Voice in every interface language: the local voice/model catalog per language (pinned, permissive), what TeamBot
// recommends for each language, how dictation hints follow the language, and which voice reads a text. No real
// models are downloaded: files come from a local test server and Piper / sherpa-onnx are replaced by small fakes.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import AdmZip from 'adm-zip';
import { startTestApp } from './helpers.js';
import { LOCAL_MODELS, VOICES_REVISION, languagesWithoutVoice, needsPiper, recommendedSttId, recommendedVoices, voiceEngineOf, type LocalModel } from '../server/modules/voice/local/catalog.js';
import { NUMBER_WORD_LANGS, spellNumbers } from '../server/modules/voice/numbers.js';
import { piperConfig } from '../server/modules/voice/local/piper.js';
import { toPcm } from '../server/modules/voice/local/vits.js';
import { STT_LANGUAGES } from '../server/modules/voice/catalog.js';
import { effectiveSettings, sanitize } from '../server/modules/voice/settings.js';
import { setSttBackend, whisperLanguage } from '../server/modules/voice/local/engine.js';
import { setLocalCatalog, setTtsBackend, setVitsProblem } from '../server/modules/voice/local/service.js';
import { guessLanguage } from '../server/modules/voice/local/pcm.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LANGUAGES } from '../shared/languages.js';
import { detectTextLanguage } from '../server/modules/voice/textlang.js';
import { speechText } from '../server/modules/voice/tts.js';
import { splitForSpeech, SpeechSplitter } from '../server/modules/voice/sentences.js';
import { resetTranslators } from '../server/core/i18n.js';
import { SPEECH_LANGS, baseLang, chooseVoice, recommendedStt, resolveSttLanguage, scriptOf, speechLocale, sttHint, sttModelLanguage, sttModelsFor, sttSingleLanguage, voicesFor } from '../shared/voiceLanguage.js';

const PERMISSIVE = ['CC-BY-4.0', 'MIT', 'CC0-1.0', 'Public domain', 'Apache-2.0', 'BSD-3-Clause'];
const INTERFACE = LANGUAGES.map((l) => l.code);
/** Pinned: a Hugging Face file at an exact 40-hex revision. */
const PINNED_HF = /^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+\/resolve\/[0-9a-f]{40}\//;

test('the speech language list covers every interface language', () => {
  assert.deepEqual([...SPEECH_LANGS].sort(), [...INTERFACE].sort());
  for (const l of INTERFACE) assert.ok(STT_LANGUAGES.some((x) => x.id === l), `fixed dictation language ${l}`);
  for (const id of ['auto-app', 'auto', 'auto-nl']) assert.ok(STT_LANGUAGES.some((x) => x.id === id), id);
  assert.equal(STT_LANGUAGES[0].id, 'auto-app', 'the automatic choice for the interface language comes first');
  for (const l of INTERFACE) assert.match(speechLocale(l), /^[a-z]{2}-[A-Z]{2}$/, `speech locale for ${l}`);
  assert.equal(speechLocale('pt'), 'pt-BR', 'Portuguese = Brazilian, like the interface');
  assert.equal(speechLocale('nl'), 'nl-NL');
  assert.equal(speechLocale('pt-PT'), 'pt-PT', 'a locale stays');
});

test('catalog: every voice pinned at an exact revision, permissive, trained from scratch, language matches', () => {
  const voices = LOCAL_MODELS.filter((m) => m.kind === 'tts-voice');
  const ids = new Set<string>();
  for (const v of voices) {
    assert.ok(!ids.has(v.id), `unique id ${v.id}`);
    ids.add(v.id);
    assert.ok(PERMISSIVE.includes(v.licence), `${v.id}: licence ${v.licence}`);
    assert.match(v.licenceNote || '', /vanaf nul getraind/, `${v.id}: trained from scratch (no lessac/ryan fine-tune)`);
    assert.ok(v.lang && INTERFACE.includes(v.lang), `${v.id}: lang ${v.lang}`);
    assert.equal(v.id.slice(0, 2), v.lang, `${v.id}: id starts with its language`);
    assert.deepEqual(v.languages, [v.lang]);
    assert.ok(v.sampleRate === 16000 || v.sampleRate === 22050, `${v.id}: sample rate`);
    assert.match(v.source, /^https:\/\/huggingface\.co\//, `${v.id}: model card`);
    if (v.noise) for (const x of v.noise) assert.ok(x > 0 && x <= 1, `${v.id}: noise ${x}`);
    const engine = voiceEngineOf(v);
    if (engine === 'piper') {
      assert.deepEqual(v.files.map((f) => f.path).sort(), ['voice.onnx', 'voice.onnx.json']);
      assert.ok(needsPiper(v), `${v.id}: a Piper voice needs the Piper program`);
    } else {
      // In-process (sherpa-onnx) voices: character-based, no Piper program; they cannot read digits.
      assert.equal(engine, 'vits');
      assert.deepEqual(v.files.map((f) => f.path).sort(), ['model.onnx', 'tokens.txt']);
      assert.ok(!needsPiper(v), `${v.id}: no Piper program`);
      assert.ok(v.spellNumbers && NUMBER_WORD_LANGS.includes(v.lang!), `${v.id}: numbers in words for ${v.lang}`);
    }
    for (const f of v.files) {
      assert.match(f.url, PINNED_HF, `${v.id}: pinned url ${f.url}`);
      // The official Piper voices come from the one pinned revision of rhasspy/piper-voices, under their own name.
      if (f.url.includes('/rhasspy/piper-voices/')) {
        assert.ok(f.url.startsWith(`https://huggingface.co/rhasspy/piper-voices/resolve/${VOICES_REVISION}/${v.lang}/${v.id.slice(0, 5)}/`), `${v.id}: pinned url ${f.url}`);
        assert.ok(f.url.endsWith(`/${v.id}${f.path === 'voice.onnx' ? '.onnx' : '.onnx.json'}`), `${v.id}: file name ${f.url}`);
      }
      assert.match(f.sha256, /^[0-9a-f]{64}$/);
      assert.ok(f.size > (f.path === 'voice.onnx' || f.path === 'model.onnx' ? 10_000_000 : 1000), `${v.id}: size ${f.size}`);
    }
    if (v.speakers) {
      assert.ok(v.speakers.length >= 2, `${v.id}: speakers listed`);
      assert.equal(new Set(v.speakers.map((s) => s.id)).size, v.speakers.length, `${v.id}: unique speakers`);
    }
  }
  // A voice for every interface language except Arabic (no Arabic voice with a clear free licence: catalog header).
  for (const l of INTERFACE.filter((x) => x !== 'ar')) assert.ok(voicesFor(l, LOCAL_MODELS).length, `voice for ${l}`);
  assert.deepEqual(languagesWithoutVoice(), ['ar']);
  // Every language with a voice has exactly one recommended voice.
  for (const l of INTERFACE) {
    const list = voicesFor(l, LOCAL_MODELS);
    if (list.length) assert.equal(list.filter((m) => m.recommended).length, 1, `one recommended voice for ${l}`);
  }
});

test('catalog: Whisper models have the files the engine loads; Parakeet does not claim Turkish or Arabic', () => {
  const stt = LOCAL_MODELS.filter((m) => m.kind === 'stt');
  for (const m of stt.filter((x) => x.engine === 'whisper')) {
    for (const suffix of ['-encoder.int8.onnx', '-decoder.int8.onnx', '-tokens.txt']) assert.ok(m.files.some((f) => f.path.endsWith(suffix)), `${m.id} has *${suffix}`);
    assert.deepEqual(m.languages, ['*']);
    assert.equal(m.licence, 'MIT');
  }
  const parakeet = stt.find((m) => m.id === 'parakeet-tdt-0.6b-v3')!;
  for (const l of INTERFACE.filter((x) => x !== 'tr' && x !== 'ar')) assert.ok(parakeet.languages.includes(l), `Parakeet knows ${l}`);
  assert.ok(!parakeet.languages.includes('tr') && !parakeet.languages.includes('ar'));
  assert.ok(stt.find((m) => m.id === 'whisper-large-v3-turbo')!.recommendedFor?.includes('tr'));
});

test('recommendations per interface language: speech model and voice', () => {
  const sttWant: Record<string, string> = { tr: 'whisper-large-v3-turbo', ar: 'whisper-large-v3-turbo' };
  const voiceWant: Record<string, string | undefined> = {
    nl: 'nl_NL-alex-medium',
    en: 'en_US-ljspeech-medium',
    de: 'de_DE-mls-medium',
    fr: 'fr_FR-mls-medium',
    es: 'es_ES-carlfm-x_low',
    it: 'it_IT-riccardo-x_low',
    pt: 'pt-cv-vits',
    pl: 'pl_PL-mai_female-vits',
    tr: 'tr_TR-antalia-medium',
    uk: 'uk_UA-ukrainian_tts-medium',
  };
  for (const l of INTERFACE) {
    const id = recommendedSttId(l);
    assert.equal(id, sttWant[l] || 'parakeet-tdt-0.6b-v3', `speech model for ${l}`);
    const m = LOCAL_MODELS.find((x) => x.id === id)!;
    assert.ok(m.languages.includes(l) || m.languages.includes('*'), `${id} handles ${l}`);
    assert.equal(recommendedVoices(l)[0], voiceWant[l], `voice for ${l}`);
    // Models that do not know the language are not offered for it.
    for (const x of sttModelsFor(l, LOCAL_MODELS)) assert.ok(x.languages.includes(l) || x.languages.includes('*'));
  }
  assert.equal(recommendedStt('pt-BR', LOCAL_MODELS)?.id, 'parakeet-tdt-0.6b-v3', 'locales work too');
});

test('settings: automatic choices follow the interface language; Dutch stays exactly as before', () => {
  const d = sanitize({});
  assert.equal(d.stt.language, 'auto-app');
  assert.equal(d.stt.localModel, '', 'automatic');
  assert.equal(d.tts.localVoice, '', 'automatic');
  const nl = effectiveSettings(d, 'nl');
  assert.equal(nl.stt.language, 'auto-nl', 'Dutch interface: the same as the old default');
  assert.equal(nl.stt.localModel, 'parakeet-tdt-0.6b-v3');
  assert.equal(nl.tts.localVoice, 'nl_NL-alex-medium');
  assert.equal(nl.tts.localVoiceEn, 'en_US-ljspeech-medium');
  const de = effectiveSettings(d, 'de');
  assert.equal(de.stt.language, 'auto-de');
  assert.equal(de.tts.localVoice, 'de_DE-mls-medium');
  const tr = effectiveSettings(d, 'tr');
  assert.equal(tr.stt.localModel, 'whisper-large-v3-turbo');
  assert.equal(tr.tts.localVoice, 'tr_TR-antalia-medium');
  assert.equal(effectiveSettings(d, 'ar').tts.localVoice, '', 'no free Arabic voice: the browser voice reads aloud');
  assert.equal(effectiveSettings(d, 'pl').tts.localVoice, 'pl_PL-mai_female-vits');
  assert.equal(effectiveSettings(d, 'pt').tts.localVoice, 'pt-cv-vits');
  // Explicit choices (and everything users stored before) are kept.
  const own = sanitize({ stt: { language: 'auto-nl', localModel: 'parakeet-tdt-0.6b-v3' }, tts: { localVoice: 'nl_NL-alex-medium' } });
  const ownDe = effectiveSettings(own, 'de');
  assert.equal(ownDe.stt.language, 'auto-nl');
  assert.equal(ownDe.stt.localModel, 'parakeet-tdt-0.6b-v3');
  assert.equal(ownDe.tts.localVoice, 'nl_NL-alex-medium');
  assert.equal(sanitize({ stt: { language: 'uk' } }).stt.language, 'uk');
  assert.equal(sanitize({ stt: { language: 'klingon' } }).stt.language, 'auto-app');
  // An installed voice for the language is preferred over downloading the recommended one.
  const installed = new Set(['nl_NL-mls-medium']);
  assert.equal(effectiveSettings(d, 'nl', (id) => installed.has(id)).tts.localVoice, 'nl_NL-mls-medium');
  assert.equal(effectiveSettings(d, 'nl', (id) => id === 'whisper-large-v3-turbo').stt.localModel, 'whisper-large-v3-turbo');
});

test('dictation: the automatic speech model follows the dictation language, and knows it', () => {
  // Every language, as interface language (automatic) and as fixed dictation language in a Dutch interface.
  for (const l of INTERFACE) {
    const d = sanitize({});
    // ('auto-xx' is what 'auto-app' resolves to; it is not stored itself.)
    for (const s of [effectiveSettings(d, l), effectiveSettings(sanitize({ stt: { language: l } }), 'nl'), effectiveSettings({ ...d, stt: { ...d.stt, language: `auto-${l}` } }, 'nl')]) {
      const m = LOCAL_MODELS.find((x) => x.id === s.stt.localModel)!;
      assert.ok(m.languages.includes(l) || m.languages.includes('*'), `${s.stt.language}: ${m.id} knows ${l}`);
      assert.equal(m.id, l === 'tr' || l === 'ar' ? 'whisper-large-v3-turbo' : 'parakeet-tdt-0.6b-v3', `${s.stt.language}`);
    }
  }
  // Turkish dictation with a Dutch interface used to get Parakeet (the interface language decided).
  assert.equal(effectiveSettings(sanitize({ stt: { language: 'tr' } }), 'nl').stt.localModel, 'whisper-large-v3-turbo');
  assert.equal(sttModelLanguage('auto-app', 'ar'), 'ar');
  assert.equal(sttModelLanguage('auto', 'tr'), 'tr', 'detect without a hint: the interface language');
  assert.equal(sttModelLanguage('auto-nl', 'tr'), 'nl', 'the old Dutch default keeps meaning Dutch');
  assert.equal(sttModelLanguage('pt-BR', 'nl'), 'pt');
  // An explicit choice stays, also when it does not know the language (the settings page warns about it).
  assert.equal(effectiveSettings(sanitize({ stt: { language: 'tr', localModel: 'parakeet-tdt-0.6b-v3' } }), 'nl').stt.localModel, 'parakeet-tdt-0.6b-v3');
});

test('dictation hints: automatic = the interface language (and English); fixed = exactly that language', () => {
  assert.deepEqual(sttHint('auto-app', 'nl'), { fixed: null, prefer: ['nl', 'en'] });
  assert.deepEqual(sttHint('auto-nl', 'de'), { fixed: null, prefer: ['nl', 'en'] }, 'old default keeps its meaning');
  assert.deepEqual(sttHint('auto-app', 'de'), { fixed: null, prefer: ['de', 'en'] });
  assert.deepEqual(sttHint('auto-app', 'en'), { fixed: null, prefer: ['en'] });
  assert.deepEqual(sttHint(resolveSttLanguage('auto-app', 'tr'), 'nl'), { fixed: null, prefer: ['tr', 'en'] }, 'resolved setting needs no interface language');
  assert.deepEqual(sttHint('auto', 'tr'), { fixed: null, prefer: [] });
  assert.deepEqual(sttHint('uk', 'nl'), { fixed: 'uk', prefer: ['uk'] });
  assert.equal(resolveSttLanguage('auto-app', 'pt'), 'auto-pt');
  assert.equal(resolveSttLanguage('auto-nl', 'pt'), 'auto-nl');
  // Browser speech recognition needs one language.
  assert.equal(speechLocale(sttSingleLanguage('auto-app', 'ar')), 'ar-SA');
  assert.equal(speechLocale(sttSingleLanguage('auto', 'nl')), 'nl-NL', 'Dutch: as before');
  assert.equal(speechLocale(sttSingleLanguage('auto-nl', 'en')), 'nl-NL');
  assert.equal(speechLocale(sttSingleLanguage('fr', 'nl')), 'fr-FR');
  // Local Whisper: automatic = detect (it can only be forced to one language).
  for (const s of ['auto', 'auto-app', 'auto-nl', 'auto-tr']) assert.equal(whisperLanguage(s), '');
  assert.equal(whisperLanguage('tr'), 'tr');
});

const SAMPLES: Record<string, string[]> = {
  nl: ['Ik heb de afspraak met de tandarts voor je gemaakt, en het is morgen om drie uur.', 'De factuur is gisteren betaald en staat nu in de map.'],
  en: ['I have made the appointment with the dentist for you and it is tomorrow at three.', 'The invoice was paid yesterday and is now in the folder.'],
  de: ['Ich habe den Termin beim Zahnarzt für dich gemacht, er ist morgen um drei Uhr.', 'Kannst du mir bitte sagen, wie das Wetter am Wochenende wird?'],
  fr: ["J'ai pris rendez-vous chez le dentiste pour toi, c'est demain à trois heures.", 'La facture a été payée hier et elle est maintenant dans le dossier.'],
  es: ['He pedido la cita con el dentista para ti, es mañana a las tres.', '¿Puedes decirme qué tiempo hará el fin de semana?'],
  it: ["Ho preso l'appuntamento dal dentista per te, è domani alle tre.", 'La fattura è stata pagata ieri e ora è nella cartella.'],
  pt: ['Eu marquei a consulta com o dentista para você, é amanhã às três horas.', 'Bom dia! Aqui está o seu resumo de hoje.'],
  pl: ['Umówiłem ci wizytę u dentysty, jest jutro o trzeciej.', 'Rachunek został zapłacony wczoraj i teraz jest w folderze.'],
  tr: ['Senin için dişçiden randevu aldım, yarın saat üçte.', 'Bana hafta sonu havanın nasıl olacağını söyleyebilir misin?'],
  uk: ['Я записав тебе до стоматолога, це завтра о третій годині.', 'Чи можеш ти сказати мені, яка буде погода на вихідних?'],
  ar: ['لقد حجزت لك موعدًا عند طبيب الأسنان، وهو غدًا في الساعة الثالثة.', 'هل يمكنك أن تخبرني كيف سيكون الطقس في عطلة نهاية الأسبوع؟'],
  ru: ['Я записал тебя к стоматологу, это завтра в три часа. Ты сможешь прийти?'],
};

test('text language: script for Arabic/Cyrillic, common words for Latin languages, null when unclear', () => {
  for (const [lang, list] of Object.entries(SAMPLES))
    for (const s of list) for (const home of [null, 'nl', lang]) assert.equal(detectTextLanguage(s, home), lang, `${lang} (home ${home}): ${s}`);
  assert.equal(detectTextLanguage('OK'), null);
  assert.equal(detectTextLanguage(''), null);
  assert.equal(detectTextLanguage('Dit is een test with some English words in it', 'nl'), null, 'mixed: keep the voice you have');
  // The old two-language guess still answers the same.
  assert.equal(guessLanguage(SAMPLES.nl[0]), 'nl');
  assert.equal(guessLanguage(SAMPLES.en[0]), 'en');
  assert.equal(guessLanguage(SAMPLES.de[0]), null, 'German is neither');
  assert.equal(guessLanguage('OK'), null);
  assert.equal(scriptOf('ar'), 'arabic');
  assert.equal(scriptOf('uk-UA'), 'cyrillic');
  assert.equal(scriptOf('pl'), 'latin');
  assert.equal(baseLang('pt_BR'), 'pt');
});

test('the few words TeamBot adds when reading aloud are in the user\'s language (via the dictionaries)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-voice-i18n-'));
  const prev = process.env.TEAMBOT_I18N_DIR;
  try {
    fs.copyFileSync(path.resolve('ui/src/i18n/languages.json'), path.join(dir, 'languages.json'));
    fs.writeFileSync(path.join(dir, 'de.json'), JSON.stringify({ '(codevoorbeeld overgeslagen)': '(Codebeispiel übersprungen)', 'De rest staat in het gesprek.': 'Der Rest steht im Chat.', link: 'Link' }));
    process.env.TEAMBOT_I18N_DIR = dir;
    resetTranslators();
    assert.equal(speechText('Siehe https://example.org und\n```\ncode\n```', 'de').text.replace(/\s+/g, ' '), 'Siehe Link und (Codebeispiel übersprungen)');
    assert.equal(speechText('Zie https://example.org', 'nl').text, 'Zie link', 'Dutch: as before');
    const long = speechText('Satz. '.repeat(3000), 'de');
    assert.ok(long.truncated && long.text.endsWith('. Der Rest steht im Chat.'));
    assert.deepEqual(splitForSpeech('```\nalleen code\n```'), ['(codevoorbeeld overgeslagen)']);
    const s = new SpeechSplitter('de');
    assert.deepEqual([...s.push('```\ncode\n```\n'), ...s.end()], ['(Codebeispiel übersprungen)']);
  } finally {
    if (prev === undefined) delete process.env.TEAMBOT_I18N_DIR;
    else process.env.TEAMBOT_I18N_DIR = prev;
    resetTranslators();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const v = (id: string, lang: string, recommended = false) => ({ id, kind: 'tts-voice', languages: [lang], lang, recommended });
const MODELS = [v('nl-a', 'nl', true), v('nl-b', 'nl'), v('en-a', 'en', true), v('en-b', 'en'), v('de-a', 'de', true), v('uk-a', 'uk', true)];
const pick = (o: { main: string; text: string; usable: string[]; switching?: boolean; english?: string }) =>
  chooseVoice({ main: MODELS.find((m) => m.id === o.main)!, textLang: detectTextLanguage(o.text, MODELS.find((m) => m.id === o.main)!.lang), models: MODELS, usable: (id) => o.usable.includes(id), switching: o.switching ?? true, english: o.english }).id;

test('voice for a text: an installed voice for its language, else the configured voice', () => {
  const all = MODELS.map((m) => m.id);
  assert.equal(pick({ main: 'nl-a', text: SAMPLES.nl[0], usable: all }), 'nl-a', 'own language: own voice');
  assert.equal(pick({ main: 'nl-a', text: SAMPLES.de[0], usable: all }), 'de-a', 'German text: German voice');
  assert.equal(pick({ main: 'nl-a', text: SAMPLES.de[0], usable: ['nl-a'] }), 'nl-a', 'not installed: configured voice');
  assert.equal(pick({ main: 'nl-a', text: SAMPLES.fr[0], usable: all }), 'nl-a', 'no French voice: configured voice');
  assert.equal(pick({ main: 'de-a', text: SAMPLES.nl[0], usable: all }), 'nl-a', 'a German user hears Dutch text in Dutch');
  // English: the user's English voice; '' = read English with the configured voice (as before).
  assert.equal(pick({ main: 'nl-a', text: SAMPLES.en[0], usable: all, english: 'en-b' }), 'en-b');
  assert.equal(pick({ main: 'nl-a', text: SAMPLES.en[0], usable: all, english: '' }), 'nl-a');
  assert.equal(pick({ main: 'nl-a', text: SAMPLES.en[0], usable: ['nl-a', 'en-a'], english: 'en-b' }), 'en-a', 'chosen English voice missing: another installed one');
  // A bot with its own voice keeps it, except for letters it cannot read.
  assert.equal(pick({ main: 'nl-b', text: SAMPLES.de[0], usable: all, switching: false }), 'nl-b');
  assert.equal(pick({ main: 'nl-b', text: SAMPLES.uk[0], usable: all, switching: false }), 'uk-a');
  // Russian has no voice: the Ukrainian voice can at least read the letters.
  assert.equal(pick({ main: 'nl-a', text: SAMPLES.ru[0], usable: all }), 'uk-a');
  assert.equal(pick({ main: 'nl-a', text: SAMPLES.ar[0], usable: all }), 'nl-a', 'no Arabic voice (the server then uses the browser voice)');
});

// ---------- end to end with fake engines ----------

setSttBackend({ name: 'fake-stt', problem: () => null, async create() { return { async decode() { return 'hallo'; } }; } });
const synths: { text: string; voiceDir: string; speaker?: number; engine?: string; noise?: [number, number] }[] = [];
setTtsBackend({
  name: 'fake-piper',
  async synth(r) {
    synths.push({ text: r.text, voiceDir: r.voiceDir, speaker: r.speaker, engine: r.engine, noise: r.noise });
    return { pcm: Buffer.alloc(r.text.length * 40), sampleRate: 22050 };
  },
  close() {},
});

const files = new Map<string, Buffer>();
const server = http.createServer((req, res) => {
  const f = files.get(req.url || '');
  if (!f) return res.writeHead(404).end();
  res.writeHead(200, { 'content-length': f.length }).end(f);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
// Registered after the top-level await: a hook registered before it ran as soon as the tests above had finished,
// so the API tests below used the real engines instead of these fakes.
after(() => {
  server.close();
  setSttBackend(null);
  setTtsBackend(null);
  setLocalCatalog(null);
  setVitsProblem(null);
});
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const serve = (name: string, body: Buffer) => {
  files.set('/' + name, body);
  return { path: name.split('/').pop()!, url: `${base}/${name}`, sha256: crypto.createHash('sha256').update(body).digest('hex'), size: body.length };
};
const real = (id: string) => LOCAL_MODELS.find((m) => m.id === id)!;
const zip = new AdmZip();
zip.addFile('piper/piper.exe', Buffer.from('nep'));
const fakeVoice = (id: string): LocalModel => ({ ...real(id), files: [{ ...serve(`${id}/voice.onnx`, crypto.randomBytes(500)), path: 'voice.onnx' }, { ...serve(`${id}/voice.onnx.json`, Buffer.from('{}')), path: 'voice.onnx.json' }] });
/** An in-process (VITS) voice: model.onnx + tokens.txt, no Piper program. */
const fakeVits = (id: string): LocalModel => ({ ...real(id), files: [{ ...serve(`${id}/model.onnx`, crypto.randomBytes(500)), path: 'model.onnx' }, { ...serve(`${id}/tokens.txt`, Buffer.from('a 1\n')), path: 'tokens.txt' }] });
const testCatalog: LocalModel[] = [
  { ...real('parakeet-tdt-0.6b-v3'), files: [serve('p/tokens.txt', Buffer.from('a 0\n'))] },
  { ...real('whisper-large-v3-turbo'), files: [serve('w/turbo-tokens.txt', Buffer.from('a 0\n'))] },
  { ...real('piper-runtime'), platforms: undefined, files: [{ ...serve('piper.zip', zip.toBuffer()), path: 'piper.zip', extract: 'zip' as const }] },
  fakeVoice('nl_NL-alex-medium'),
  fakeVoice('en_US-ljspeech-medium'),
  fakeVoice('de_DE-mls-medium'),
  fakeVoice('tr_TR-antalia-medium'),
  fakeVoice('uk_UA-ukrainian_tts-medium'),
  fakeVits('pl_PL-mai_female-vits'),
  fakeVits('pt-cv-vits'),
];

test('API: defaults follow the interface language, the old Dutch default stays valid, voices follow the text', async () => {
  setLocalCatalog(testCatalog);
  const t = await startTestApp({ mode: 'server' });
  try {
    const ctx = t.app.ctx;
    const owner = ctx.auth.owner()!.id;
    const install = async (id: string) => {
      await t.api('POST', `/voice/local/models/${id}/install`, {});
      for (let i = 0; i < 200; i++) {
        const v = await t.api('GET', '/voice/local');
        if (['piper-runtime', id].every((x) => v.models.find((m: any) => m.id === x).status === 'installed')) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('not installed: ' + id);
    };

    // Dutch user (never chose a language): automatic everything, exactly the old Dutch behaviour.
    const nl = await t.api('GET', '/voice/settings');
    assert.equal(nl.settings.stt.language, 'auto-app');
    assert.equal(nl.settings.tts.localVoice, '');
    assert.deepEqual(nl.effective.stt, { language: 'auto-nl', localModel: 'parakeet-tdt-0.6b-v3', modelLanguage: 'nl' });
    assert.equal(nl.effective.tts.localVoice, 'nl_NL-alex-medium');
    assert.equal(nl.effective.language, 'nl');
    // The old stored default reads as the automatic choice for a Dutch interface (one option, not two)...
    await t.api('PUT', '/voice/settings', { stt: { language: 'auto-nl' } });
    assert.equal((await t.api('GET', '/voice/settings')).settings.stt.language, 'auto-app');
    // ...and stays "Dutch preferred" for someone with another interface language.
    ctx.store.setSetting(owner, 'voice', { ...ctx.store.getSetting(owner, 'voice', {}), stt: { language: 'auto-nl' } });
    ctx.store.setSetting(owner, 'language', 'en');
    const en = await t.api('GET', '/voice/settings');
    assert.equal(en.settings.stt.language, 'auto-nl');
    assert.equal(en.effective.stt.language, 'auto-nl');
    assert.equal(en.effective.tts.localVoice, 'en_US-ljspeech-medium');

    // Turkish interface: Whisper (Parakeet does not know Turkish) and the Turkish voice; until that is downloaded the
    // browser voice reads aloud (a Turkish one), and the settings say why.
    ctx.store.setSetting(owner, 'language', 'tr');
    await t.api('PUT', '/voice/settings', { stt: { language: 'auto-app' } });
    const tr = await t.api('GET', '/voice/settings');
    assert.deepEqual(tr.effective.stt, { language: 'auto-tr', localModel: 'whisper-large-v3-turbo', modelLanguage: 'tr' });
    assert.deepEqual(tr.effective.recommended, { stt: 'whisper-large-v3-turbo', voices: ['tr_TR-antalia-medium'] });
    assert.equal(tr.effective.tts.localVoice, 'tr_TR-antalia-medium');
    assert.equal(tr.status.tts.engine, 'browser');
    assert.match(tr.status.tts.localMissing, /Antalia.*nog niet gedownload/);
    const trSpeak = await t.api('POST', '/voice/speak', { text: 'Merhaba! Bugün için özetin hazır, teşekkürler.' });
    assert.equal(trSpeak.engine, 'browser');
    assert.equal(trSpeak.lang, 'tr', 'the browser picks a Turkish voice');
    await install('tr_TR-antalia-medium');
    synths.length = 0;
    const trLocal = await t.api('POST', '/voice/speak', { text: 'Merhaba! Bugün için özetin hazır, teşekkürler.' });
    assert.equal(trLocal.engine, 'local');
    assert.equal(trLocal.model, 'tr_TR-antalia-medium');
    await (await fetch(t.app.url + '/api' + trLocal.stream, { headers: { authorization: `Bearer ${t.token}` } })).arrayBuffer();
    assert.equal(synths[0]?.engine, 'piper');
    assert.deepEqual(synths[0]?.noise, [0.333, 0.333], 'the clearer sampling noise of this voice');

    // Arabic interface: no free local voice → the browser voice, told why.
    ctx.store.setSetting(owner, 'language', 'ar');
    const ar = await t.api('GET', '/voice/settings');
    assert.deepEqual(ar.effective.recommended, { stt: 'whisper-large-v3-turbo', voices: [] });
    assert.equal(ar.effective.tts.localVoice, '');
    assert.equal(ar.status.tts.engine, 'browser');
    assert.match(ar.status.tts.localMissing, /Arabisch/);

    // Dutch interface, Turkish dictation: Whisper (this used to follow the interface language: Parakeet, no Turkish).
    ctx.store.setSetting(owner, 'language', 'nl');
    await t.api('PUT', '/voice/settings', { stt: { language: 'tr' } });
    const nlTr = await t.api('GET', '/voice/settings');
    assert.deepEqual(nlTr.effective.stt, { language: 'tr', localModel: 'whisper-large-v3-turbo', modelLanguage: 'tr' });
    assert.equal(nlTr.effective.recommended.stt, 'whisper-large-v3-turbo');
    assert.equal(nlTr.status.stt.model, 'whisper-large-v3-turbo', 'dictation uses it');
    await t.api('PUT', '/voice/settings', { stt: { language: 'auto-app' } });

    // German interface: the German voice is the automatic voice.
    ctx.store.setSetting(owner, 'language', 'de');
    const de = await t.api('GET', '/voice/settings');
    assert.equal(de.effective.tts.localVoice, 'de_DE-mls-medium');
    assert.equal(de.effective.recommended.stt, 'parakeet-tdt-0.6b-v3');
    await install('de_DE-mls-medium');
    const deSpeak = await t.api('POST', '/voice/speak', { text: 'Guten Morgen! Hier ist deine Übersicht für heute.' });
    assert.equal(deSpeak.engine, 'local');
    assert.equal(deSpeak.model, 'de_DE-mls-medium');
    // Dutch text for a German user: the German voice until a Dutch voice is installed, then the Dutch voice.
    assert.equal((await t.api('POST', '/voice/speak', { text: 'Ik heb de afspraak met de tandarts voor je gemaakt, en het is morgen.' })).model, 'de_DE-mls-medium');
    await install('nl_NL-alex-medium');
    assert.equal((await t.api('POST', '/voice/speak', { text: 'Ik heb de afspraak met de tandarts voor je gemaakt, en het is morgen om drie uur.' })).model, 'nl_NL-alex-medium');
    // Ukrainian text: the Ukrainian voice (other letters) once installed; before that the browser reads it.
    const ukText = 'Я записав тебе до стоматолога, це завтра о третій годині.';
    const ukBrowser = await t.api('POST', '/voice/speak', { text: ukText });
    assert.equal(ukBrowser.engine, 'browser', 'the German voice cannot read Cyrillic');
    assert.equal(ukBrowser.lang, 'uk');
    await install('uk_UA-ukrainian_tts-medium');
    synths.length = 0;
    const uk = await t.api('POST', '/voice/speak', { text: ukText, });
    assert.equal(uk.model, 'uk_UA-ukrainian_tts-medium');
    // Multi-speaker voices use one of the curated speakers.
    const deModel = real('de_DE-mls-medium');
    const deAgain = await t.api('POST', '/voice/speak', { text: 'Kannst du mir bitte sagen, wie das Wetter am Wochenende wird?' });
    assert.equal(deAgain.model, 'de_DE-mls-medium');
    assert.ok(deModel.speakers!.some((s) => deAgain.voice.includes(s.label)), deAgain.voice);

    // Provider dictation gets the interface language as hint (German interface, automatic setting).
    // (Checked through the hint helper: the provider request itself is covered in voice.test.ts.)
    assert.deepEqual(sttHint(de.effective.stt.language, 'de'), { fixed: null, prefer: ['de', 'en'] });
  } finally {
    await t.close();
    setLocalCatalog(null);
  }
});

test('API: a voice that runs in TeamBot itself needs no Piper download, reads numbers in words and says when it cannot run', async () => {
  setLocalCatalog(testCatalog);
  const t = await startTestApp({ mode: 'server' });
  try {
    const ctx = t.app.ctx;
    const owner = ctx.auth.owner()!.id;
    ctx.store.setSetting(owner, 'language', 'pl');
    const s = await t.api('GET', '/voice/settings');
    assert.equal(s.effective.tts.localVoice, 'pl_PL-mai_female-vits');
    assert.equal(s.local.models.find((m: any) => m.id === 'pl_PL-mai_female-vits').voiceEngine, 'vits');
    assert.equal(s.local.models.find((m: any) => m.id === 'tr_TR-antalia-medium').voiceEngine, 'piper');
    await t.api('POST', '/voice/local/models/pl_PL-mai_female-vits/install', {});
    let v: any;
    for (let i = 0; i < 200; i++) {
      v = await t.api('GET', '/voice/local');
      if (v.models.find((m: any) => m.id === 'pl_PL-mai_female-vits').status === 'installed') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(v.models.find((m: any) => m.id === 'pl_PL-mai_female-vits').status, 'installed');
    assert.equal(v.models.find((m: any) => m.id === 'piper-runtime').status, 'missing', 'the Piper program is not downloaded for it');
    synths.length = 0;
    const sp = await t.api('POST', '/voice/speak', { text: 'Spotkanie jest jutro o 10:30 w sali 3.' });
    assert.equal(sp.engine, 'local', 'ready without Piper');
    assert.equal(sp.model, 'pl_PL-mai_female-vits');
    await (await fetch(t.app.url + '/api' + sp.stream, { headers: { authorization: `Bearer ${t.token}` } })).arrayBuffer();
    assert.equal(synths[0].engine, 'vits');
    assert.deepEqual(synths[0].noise, [0.333, 0.333]);
    assert.equal(synths[0].text, 'Spotkanie jest jutro o dziesiątej trzydzieści w sali trzy.', 'digits written out: the voice cannot read them');
    // The in-process engine cannot start on this system: the browser voice reads aloud, with the reason.
    setVitsProblem(() => 'Lokaal voorlezen in TeamBot zelf kon niet starten: test');
    const b = await t.api('POST', '/voice/speak', { text: 'Dzień dobry, jak się masz dzisiaj?' });
    assert.equal(b.engine, 'browser');
    assert.match(b.localMissing, /kon niet starten/);
    assert.match((await t.api('GET', '/voice/local')).runtime.vitsProblem, /kon niet starten/);
  } finally {
    setVitsProblem(null);
    await t.close();
    setLocalCatalog(null);
  }
});

test('numbers in words for voices that cannot read digits (Portuguese, Polish)', () => {
  assert.deepEqual(NUMBER_WORD_LANGS.sort(), ['pl', 'pt']);
  const pt = (s: string) => spellNumbers(s, 'pt');
  assert.equal(pt('Amanhã às 10:30 temos 3 reuniões.'), 'Amanhã às dez e trinta temos três reuniões.');
  assert.equal(pt('Às 1:00 e às 21:00.'), 'Às uma hora e às vinte e uma horas.');
  assert.equal(pt('São 1.250 pessoas em 2026.'), 'São mil duzentos e cinquenta pessoas em dois mil e vinte e seis.');
  assert.equal(pt('100, 101, 1020, 1500, 2000000'), 'cem, cento e um, mil e vinte, mil e quinhentos, dois milhões');
  assert.equal(pt('Custa R$ 15,50 ou 20 €.'), 'Custa quinze reais cinquenta ou vinte euros.');
  assert.equal(pt('Cresceu 2,5% e 0 erros.'), 'Cresceu dois vírgula cinco por cento e zero erros.');
  assert.equal(pt('Data: 07/11/2026.'), 'Data: sete onze dois mil e vinte e seis.');
  assert.equal(pt('Ligue 0612345678.'), 'Ligue zero seis um dois três quatro cinco seis sete oito.', 'codes digit by digit');
  const pl = (s: string) => spellNumbers(s, 'pl');
  assert.equal(pl('Od 9:00 do 17:30, spotkanie 22:00.'), 'Od dziewiątej do siedemnastej trzydzieści, spotkanie dwudziesta druga.');
  assert.equal(pl('1 250 osób, 22 tysiące, 5000, 1000000, 2000000.'), 'tysiąc dwieście pięćdziesiąt osób, dwadzieścia dwa tysiące, pięć tysięcy, milion, dwa miliony.');
  assert.equal(pl('25 zł, 2 zł, 1 zł, 12 zł'), 'dwadzieścia pięć złotych, dwa złote, jeden złoty, dwanaście złotych');
  assert.equal(pl('Wzrost o 2,5% w 2025 roku.'), 'Wzrost o dwa przecinek pięć procent w dwa tysiące dwadzieścia pięć roku.');
  // Other languages and text without digits stay exactly as they are.
  assert.equal(spellNumbers('Om 10:30 uur', 'nl'), 'Om 10:30 uur');
  assert.equal(pt('Bom dia!'), 'Bom dia!');
  // Every in-process voice speaks a language with number words.
  for (const v of LOCAL_MODELS.filter((m) => m.spellNumbers)) assert.ok(NUMBER_WORD_LANGS.includes(v.lang!), v.id);
});

test('Piper 2023 gets a config without phonemes of several characters; the download stays as it is', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-voice-cfg-'));
  try {
    const original = JSON.stringify({ espeak: { voice: 'tr' }, phoneme_id_map: { _: [0], a: [14], 'aɪ': [161], 'oʊ': [165] } });
    fs.writeFileSync(path.join(dir, 'voice.onnx.json'), original);
    const cfg = piperConfig(dir);
    assert.notEqual(cfg, path.join(dir, 'voice.onnx.json'));
    assert.deepEqual(JSON.parse(fs.readFileSync(cfg, 'utf8')).phoneme_id_map, { _: [0], a: [14] });
    assert.equal(fs.readFileSync(path.join(dir, 'voice.onnx.json'), 'utf8'), original, 'the verified file is untouched');
    assert.equal(piperConfig(dir), cfg, 'the same copy next time');
    // A config with single characters only is used as it is.
    fs.writeFileSync(path.join(dir, 'voice.onnx.json'), JSON.stringify({ phoneme_id_map: { _: [0], a: [14] } }));
    assert.equal(piperConfig(dir), path.join(dir, 'voice.onnx.json'));
    // The in-process engine ends each sentence with the same short pause as Piper (0,15 s).
    const pcm = toPcm(new Float32Array([0.5, -0.5]), 20000);
    assert.equal(pcm.length, (2 + 3000) * 2);
    assert.equal(pcm.readInt16LE(0), 16384);
    assert.equal(pcm.readInt16LE(4), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
