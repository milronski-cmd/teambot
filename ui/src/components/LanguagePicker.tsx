import { Languages } from 'lucide-react';
import { LANGUAGES, languageName } from '../lib/languages';
import { getLang, setLang, t, translate } from '../lib/i18n';
import { Field, cx, registerFormControl } from './ui';
import { Listbox } from './Listbox';

type ControlProps = { className?: string; id?: string; 'aria-label'?: string; 'aria-describedby'?: string };

/**
 * Interface language picker. Each language is shown in its own name ("Deutsch", "العربية"), never translated, with
 * its lang/dir so screen readers pronounce it right. Changing it stores the choice for the user and reloads.
 */
export function LanguageSelect({ className, ...p }: ControlProps) {
  return (
    <Listbox {...p} className={className} value={getLang()} onChange={(v) => void setLang(v)} options={LANGUAGES.map((l) => ({ value: l.code, label: l.name, lang: l.code, dir: l.dir, noTranslate: true }))} />
  );
}

/**
 * The language bots answer in. 'auto' (default): the language the owner writes in, falling back to the interface
 * language when that is unclear. A code: always that language. For one bot, '' follows the user setting.
 * When that setting is 'auto', following it and 'auto' are the same choice: one option, and a bot that stored 'auto'
 * shows it selected (both keep working as before).
 */
export function BotLanguageSelect({ value, onChange, inherit, className, ...p }: ControlProps & { value: string | undefined; onChange(v: string): void; inherit?: string }) {
  const fixed = inherit && inherit !== 'auto' ? LANGUAGES.find((l) => l.code === inherit) : undefined;
  const same = inherit !== undefined && !fixed;
  const stored = value || (inherit !== undefined ? '' : 'auto');
  const v = same && stored === 'auto' ? '' : stored;
  return (
    <Listbox
      {...p}
      className={className}
      value={v}
      onChange={onChange}
      options={[
        ...(inherit !== undefined ? [{ value: '', label: fixed ? t('Zoals in Instellingen: altijd in het {0}', languageName(fixed.code, getLang())) : translate('De taal waarin je schrijft (aanbevolen)') }] : []),
        ...(!same ? [{ value: 'auto', label: translate(inherit !== undefined ? 'De taal waarin je schrijft' : 'De taal waarin je schrijft (aanbevolen)') }] : []),
        ...LANGUAGES.map((l) => ({ value: l.code, label: l.name, lang: l.code, dir: l.dir, noTranslate: true, group: translate('Altijd in één taal') })),
      ]}
    />
  );
}
registerFormControl(LanguageSelect);
registerFormControl(BotLanguageSelect);

/** Compact picker for the welcome and sign-in screens: a language icon and the current language in its own name. */
export function LanguageCorner({ className }: { className?: string }) {
  const cur = getLang();
  return (
    <label className={cx('inline-flex items-center gap-1.5 text-[13px] text-muted', className)}>
      <Languages className="h-4 w-4 shrink-0" aria-hidden />
      <span className="sr-only">Taal van de app</span>
      <select
        className="h-8 cursor-pointer rounded-lg border border-transparent bg-transparent px-1.5 text-[13px] font-semibold text-fg hover:border-line focus-visible:border-line coarse:h-11"
        value={cur}
        onChange={(e) => void setLang(e.target.value)}
      >
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code} lang={l.code} dir={l.dir} translate="no">
            {l.name}
          </option>
        ))}
      </select>
    </label>
  );
}
