import type React from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { cx } from '../components/ui';
import { BotFace } from '../components/BotFace';
import { MoreInfo } from '../components/MoreInfo';
import { Segmented, SettingRow, useSave } from '../components/SettingControls';
import { useFaceStyle } from '../lib/mood';
import type { FaceStyle } from '../lib/botface';
import { getAccent, setAccent, setThemePref, useAccent, useThemePref, type ThemePref } from '../shell/theme';
import { settingOptions, settingText } from '../../../shared/settings.js';
import { ACCENTS, DEFAULT_ACCENT } from '../shell/accent';

/** Store a part of `settings.ui` (accent, bot style) for the user, so every device follows. */
const putUi = (patch: Record<string, unknown>) => {
  const ui = useApp.getState().settings.ui || {};
  return api.put('/settings', { ui: { ...ui, ...patch } }).then((st) => useApp.setState({ settings: st }));
};

const THEME_ICONS: Record<ThemePref, React.ReactNode> = {
  system: <Monitor className="h-3.5 w-3.5" aria-hidden />,
  light: <Sun className="h-3.5 w-3.5" aria-hidden />,
  dark: <Moon className="h-3.5 w-3.5" aria-hidden />,
};

/** Light, dark or the system's choice; per device (a phone starts dark), see shell/theme.ts. */
function ThemeRow({ theme, onChange }: { theme: ThemePref; onChange(v: ThemePref): void }) {
  const save = useSave();
  return (
    <SettingRow setting="ui.theme">
      <Segmented value={theme} onChange={(v) => (onChange(v), void save(Promise.resolve()))} options={settingOptions<ThemePref>('ui.theme').map((o) => ({ ...o, icon: THEME_ICONS[o.value] }))} />
    </SettingRow>
  );
}

/**
 * "Kleur": the accent colour of buttons, links, selected items, the focus ring and the TeamBot figure. A row of colour
 * swatches (a colour is easier to pick by sight than by name; each swatch has its name for screen readers and as a
 * tooltip). Applied at once (the whole app is the live preview) and
 * stored for the user, so the computer, the browser and the paired phone follow.
 */
export function AccentSetting() {
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
          {settingText('ui.accent').title} <span className="font-normal text-muted">· {name}</span>
        </div>
        <div className="text-xs leading-relaxed text-muted">
          {settingText('ui.accent').hint}{' '}
          <MoreInfo>
            {(window as any).teambotDesktop
              ? 'Voor knoppen, links, wat je kiest, de focusrand en het TeamBot-figuurtje, ook in het pictogram van het venster, de taakbalk en het systeemvak.'
              : 'Voor knoppen, links, wat je kiest, de focusrand en het TeamBot-figuurtje.'}
          </MoreInfo>
        </div>
      </div>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={settingText('ui.accent').title}>
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
export function FaceStyleSetting() {
  const style = useFaceStyle();
  const save = useSave();
  const demo = { shape: 'squircle', color: 'teal', eyes: 'bean', mouth: 'smile', extra: 'antenna', cheeks: true } as const;
  return (
    <SettingRow setting="ui.botStyle">
      <Segmented
        value={style}
        onChange={(v: FaceStyle) => void save(putUi({ botStyle: v }))}
        options={settingOptions<FaceStyle>('ui.botStyle').map((o) => ({ ...o, icon: <BotFace seed="stijl" traits={demo} style={o.value} size={22} /> }))}
      />
    </SettingRow>
  );
}

/** The theme row (Instellingen › Taal en uiterlijk): light, dark or the system's choice, for this device. */
export function ThemeSetting() {
  return <ThemeRow theme={useThemePref()} onChange={setThemePref} />;
}
