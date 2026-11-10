// Interface language for a browser check (a11y, mobile, screenshots): `--lang de` or TEAMBOT_LANG=ar. Without one the
// check runs in Dutch, the source language, exactly as before. With one, the owner's `language` setting and the
// device choice (localStorage tb_lang) are set, so the page renders in that language from the first paint, and the
// Dutch texts a check looks for are translated with the same dictionary the page uses (L('Weigeren') → 'رفض').
import fs from 'node:fs';
import path from 'node:path';
import { Translator } from '../../shared/i18n-core.ts';

const root = process.cwd();
const list = JSON.parse(fs.readFileSync(path.join(root, 'ui', 'src', 'i18n', 'languages.json'), 'utf8'));

export function testLanguage(argv = process.argv.slice(2)) {
  const i = argv.indexOf('--lang');
  const code = (i >= 0 ? argv[i + 1] : process.env.TEAMBOT_LANG) || 'nl';
  const info = list.find((l) => l.code === code);
  if (!info) throw new Error(`Onbekende taal: ${code}. Talen: ${list.map((l) => l.code).join(', ')}`);
  const file = path.join(root, 'ui', 'src', 'i18n', `${code}.json`);
  const tr = info.source || !fs.existsSync(file) ? null : new Translator(JSON.parse(fs.readFileSync(file, 'utf8')), info.locale);
  /** A Dutch interface text (or template with values) as the page shows it in this language. */
  const L = (text, ...values) => (tr ? (values.length ? tr.format(text, values) : tr.translate(text)) : values.length ? text.replace(/\{(\d+)\}/g, (_, n) => String(values[Number(n)] ?? '')) : text);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    code,
    info,
    dir: info.dir,
    source: !!info.source,
    L,
    /** RegExp for one or more Dutch texts in this language (alternatives), case-insensitive. */
    re: (...texts) => new RegExp(texts.map((t) => esc(L(t))).join('|'), 'i'),
    /** Store the language for the user and on every page of a browser context (before the app loads). */
    async apply(app, userId, ctx) {
      if (info.source && !process.env.TEAMBOT_LANG && i < 0) return;
      app.ctx.store.setSetting(userId, 'language', code);
      if (ctx) await ctx.addInitScript((c) => localStorage.setItem('tb_lang', c), code);
    },
    /** Playwright context options for this language (browser locale; Arabic without the -u-nu extension). */
    contextOptions: () => (info.source ? {} : { locale: info.locale.replace(/-u-.*$/, '') }),
    /** Suffix for screenshot names and log lines ("" in Dutch). */
    tag: info.source ? '' : `-${code}`,
  };
}
