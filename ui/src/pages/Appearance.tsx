import { useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { cx } from '../components/ui';
import { BotFace } from '../components/BotFace';
import { MoreInfo } from '../components/MoreInfo';
import { Segmented, SettingRow, SettingsSection, useSave } from '../components/SettingControls';
import { useFaceStyle } from '../lib/mood';
import type { FaceStyle } from '../lib/botface';
import { defaultThemePref, getAccent, getThemePref, setAccent, setThemePref, useAccent, type ThemePref } from '../shell/theme';
import { ACCENTS, DEFAULT_ACCENT } from '../shell/accent';

/** Store a part of `settings.ui` (accent, bot style) for the user, so every device follows. */
const putUi = (patch: Record<string, unknown>) => {
  const ui = useApp.getState().settings.ui || {};
  return api.put('/settings', { ui: { ...ui, ...patch } }).then((st) => useApp.setState({ settings: st }));
};

/** Light, dark or the system's choice; per device (a phone starts dark), see shell/theme.ts. */
function ThemeRow({ theme, onChange }: { theme: ThemePref; onChange(v: ThemePref): void }) {
  const save = useSave();
  return (
    <SettingRow label="Thema" hint="Geldt voor dit apparaat.">
      <Segmented
        value={theme}
        onChange={(v) => (onChange(v), void save(Promise.resolve()))}
        options={[
          { value: 'system', label: 'Systeem', icon: <Monitor className="h-3.5 w-3.5" aria-hidden /> },
          { value: 'light', label: 'Licht', icon: <Sun className="h-3.5 w-3.5" aria-hidden /> },
          { value: 'dark', label: 'Donker', icon: <Moon className="h-3.5 w-3.5" aria-hidden /> },
        ]}
      />
    </SettingRow>
  );
}

/**
 * "Kleur": the accent colour of buttons, links, selected items, the focus ring and the TeamBot figure. A row of colour
 * swatches (a colour is easier to pick by sight than by name; each swatch has its name for screen readers and as a
 * tooltip). Applied at once (the whole app is the live preview) and
 * stored for the user, so the computer, the browser and the paired phone follow.
 */
function AccentRow() {
  const current = useAccent();
  const save = useSave();
  const pick = (id: string) => {
    if (id === current) return;
    const before = getAccent();
    setAccent(id);
    void save(putUi({ accent: id })).then((ok) => !ok && setAccent(before));
  };
  const name = ACCENTS.find((a) => a.id === current)?.label || '';
  return (
    <div className="space-y-3 py-3">
      <div>
        <div className="text-sm font-medium">
          Kleur <span className="font-normal text-muted">· {name}</span>
        </div>
        <div className="text-xs leading-relaxed text-muted">
          Geldt op al je apparaten.{' '}
          <MoreInfo>
            {(window as any).teambotDesktop
              ? 'Voor knoppen, links, wat je kiest, de focusrand en het TeamBot-figuurtje, ook in het pictogram van het venster, de taakbalk en het systeemvak.'
              : 'Voor knoppen, links, wat je kiest, de focusrand en het TeamBot-figuurtje.'}
          </MoreInfo>
        </div>
      </div>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Kleur">
        {ACCENTS.map((a) => (
          <button
            key={a.id}
            type="button"
            role="radio"
            aria-checked={current === a.id}
            aria-label={a.label}
            title={a.label}
            data-accent-choice={a.id}
            onClick={() => pick(a.id)}
            className={cx('flex h-9 w-9 items-center justify-center rounded-full border-2 transition-colors coarse:h-11 coarse:w-11', current === a.id ? 'border-fg' : 'border-transparent hover:border-line-strong')}
          >
            <span
              aria-hidden
              className="h-6 w-6 rounded-full border border-line-strong coarse:h-8 coarse:w-8"
              style={{ background: a.id === DEFAULT_ACCENT ? `linear-gradient(135deg, ${a.light.accent} 50%, ${a.dark.accent} 50%)` : a.logo }}
            />
          </button>
        ))}
      </div>
    </div>
  );
}

/** "Stijl figuurtjes": smooth (Glad) or felt (Vilt) bot characters, for the whole app. */
function FaceStyleRow() {
  const style = useFaceStyle();
  const save = useSave();
  const demo = { shape: 'squircle', color: 'teal', eyes: 'bean', mouth: 'smile', extra: 'antenna', cheeks: true } as const;
  return (
    <SettingRow label="Stijl figuurtjes" hint="Elke bot houdt zijn eigen vorm en kleur.">
      <Segmented
        value={style}
        onChange={(v: FaceStyle) => void save(putUi({ botStyle: v }))}
        options={[
          { value: 'clay', label: 'Glad', icon: <BotFace seed="stijl" traits={demo} style="clay" size={22} /> },
          { value: 'felt', label: 'Vilt', icon: <BotFace seed="stijl" traits={demo} style="felt" size={22} /> },
        ]}
      />
    </SettingRow>
  );
}

/** Instellingen › Uiterlijk: theme (this device), accent colour (all your devices) and the style of the bot figures. */
export function AppearanceSettings() {
  const [theme, setTheme] = useState<ThemePref>(getThemePref());
  const accent = useAccent();
  const style = useFaceStyle();
  const pickTheme = (v: ThemePref) => (setTheme(v), setThemePref(v));
  const isDefault = theme === defaultThemePref() && accent === DEFAULT_ACCENT && style === 'clay';
  return (
    <div className="space-y-4">
      <SettingsSection
        title="Thema en kleur"
        isDefault={isDefault}
        onReset={async () => {
          pickTheme(defaultThemePref());
          const before = getAccent();
          setAccent(DEFAULT_ACCENT);
          await putUi({ accent: DEFAULT_ACCENT, botStyle: 'clay' }).catch((e) => {
            setAccent(before);
            throw e;
          });
        }}
      >
        <ThemeRow theme={theme} onChange={pickTheme} />
        <AccentRow />
        <FaceStyleRow />
      </SettingsSection>
    </div>
  );
}
