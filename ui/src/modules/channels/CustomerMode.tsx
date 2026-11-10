import type React from 'react';
import { useEffect, useState } from 'react';
import { BookCheck, Clock, Headset } from 'lucide-react';
import { api } from '../../lib/api';
import { t, uiLocale } from '../../lib/i18n';
import { Button, Card, Field, Input, Textarea, Toggle, cx, useAsync } from '../../components/ui';
import type { BindingDetail } from './shared';

export interface CustomerSettings {
  enabled: boolean;
  open: boolean;
  aiLabel: boolean;
  handoff: boolean;
  approveMoney: boolean;
  hours: { enabled: boolean; days: number[]; from: string; to: string };
  knowledge: string;
  /** Also the business profile of this channel's own team (package B4). */
  profile: boolean;
}

/** Same defaults as the server (server/modules/channels/customer.ts). */
export function customerSettings(c: any): CustomerSettings {
  const s = c && typeof c === 'object' ? c : {};
  const h = s.hours && typeof s.hours === 'object' ? s.hours : {};
  const b = (v: any, d: boolean) => (typeof v === 'boolean' ? v : d);
  return {
    enabled: b(s.enabled, false),
    open: b(s.open, true),
    aiLabel: b(s.aiLabel, true),
    handoff: b(s.handoff, true),
    approveMoney: b(s.approveMoney, true),
    hours: { enabled: b(h.enabled, false), days: Array.isArray(h.days) ? h.days : [1, 2, 3, 4, 5], from: h.from || '09:00', to: h.to || '17:00' },
    knowledge: String(s.knowledge || ''),
    profile: b(s.profile, false),
  };
}

const KNOWLEDGE_MAX = 20_000;
/** Monday first. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const dayShort = (d: number) => new Intl.DateTimeFormat(uiLocale(), { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 7 + d)));

function Switch({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange(v: boolean): void; label: string; hint: React.ReactNode; disabled?: boolean }) {
  return (
    <div>
      <Toggle checked={checked} onChange={onChange} label={label} disabled={disabled} />
      <div className="mt-1 ps-11 text-xs text-muted">{hint}</div>
    </div>
  );
}

/**
 * Klanten: a channel where the bot talks to people outside the team. A few clear switches; TeamBot enforces them on
 * every draft before it leaves (server: customer.ts), not only in the bot's instructions.
 */
export function CustomerTab({ b, reload }: { b: BindingDetail; reload(): void }) {
  const [c, setC] = useState<CustomerSettings>(() => customerSettings(b.config.customer));
  useEffect(() => setC(customerSettings(b.config.customer)), [b.config.customer]);
  const act = useAsync();
  const set = (patch: Partial<CustomerSettings>) => setC((x) => ({ ...x, ...patch }));
  const setHours = (patch: Partial<CustomerSettings['hours']>) => setC((x) => ({ ...x, hours: { ...x.hours, ...patch } }));
  const save = () =>
    act.run(async () => {
      await api.patch(`/channels/bindings/${b.id}`, { config: { customer: c } });
      reload();
    }, 'Opgeslagen');
  const qr = b.adapter === 'whatsapp-web';
  const lines = c.knowledge.split('\n').filter((l) => l.trim().length > 1).length;

  return (
    <Card className="space-y-5 p-4">
      <div className="flex items-start gap-3">
        <Headset className="mt-0.5 h-5 w-5 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0 space-y-1">
          <Toggle checked={c.enabled} onChange={(v) => set({ enabled: v })} label="Klantenservice: deze bot praat met klanten" />
          <p className="text-sm text-muted">
            Voor mensen buiten je team. TeamBot controleert elk antwoord vóór het verstuurd wordt.
          </p>
          {qr && <p className="text-sm text-danger">WhatsApp via QR-code is je eigen nummer: niet geschikt voor klanten. Gebruik WhatsApp Business of Telegram.</p>}
        </div>
      </div>

      {c.enabled && (
        <>
          <div className="space-y-4 border-t border-line pt-4">
            <Switch
              checked={c.open && !qr}
              disabled={qr || b.openDoorSupported === false}
              onChange={(v) => set({ open: v })}
              label="Iedereen mag de bot een bericht sturen"
              hint="Klanten hoeven geen koppelcode te sturen. Uit = alleen mensen op de allowlist."
            />
            <Switch checked={c.aiLabel} onChange={(v) => set({ aiLabel: v })} label="AI-label" hint="Het eerste antwoord in een gesprek (en na een dag stilte) begint met: 🤖 Je praat met een AI-assistent." />
            <Switch
              checked={c.handoff}
              onChange={(v) => set({ handoff: v })}
              label="Doorzetten naar mij"
              hint="Weet de bot het niet, dan krijg jij het gesprek en zwijgt de bot tot jij antwoordt."
            />
            <Switch
              checked={c.approveMoney}
              onChange={(v) => set({ approveMoney: v })}
              label="Goedkeuren bij geld en beloftes"
              hint="Antwoorden over geld of beloftes wachten onder Wacht op jou."
            />
            <div className="space-y-2">
              <Switch
                checked={c.hours.enabled}
                onChange={(v) => setHours({ enabled: v })}
                label="Werktijden"
                hint="Wat de klant hoort over wanneer er een mens is, bijv. “binnen onze werktijden”."
              />
              {c.hours.enabled && (
                <div className="space-y-2 ps-11">
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="Werkdagen">
                    {WEEK.map((d) => {
                      const on = c.hours.days.includes(d);
                      return (
                        <button
                          key={d}
                          type="button"
                          aria-pressed={on}
                          onClick={() => setHours({ days: on ? c.hours.days.filter((x) => x !== d) : [...c.hours.days, d] })}
                          className={cx('min-w-11 rounded-lg border px-2 py-1 text-sm', on ? 'border-accent bg-accent-soft text-fg' : 'border-line bg-surface text-muted')}
                        >
                          {dayShort(d)}
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex flex-wrap items-end gap-2">
                    <Clock className="mb-2.5 h-4 w-4 text-muted" aria-hidden />
                    <Field label="Van">
                      <Input type="time" value={c.hours.from} onChange={(e) => setHours({ from: e.target.value })} className="w-32" />
                    </Field>
                    <Field label="Tot">
                      <Input type="time" value={c.hours.to} onChange={(e) => setHours({ to: e.target.value })} className="w-32" />
                    </Field>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="space-y-2 border-t border-line pt-4">
            <div className="flex items-center gap-2 font-semibold">
              <BookCheck className="h-4 w-4 text-accent" aria-hidden /> Goedgekeurde kennis
            </div>
            <p className="text-sm text-muted">
              Alleen dit mag de bot klanten vertellen, één feit per regel. Elk getal, bedrag en elke link in een antwoord moet
              hierin staan.
            </p>
            <Textarea
              rows={8}
              value={c.knowledge}
              maxLength={KNOWLEDGE_MAX}
              onChange={(e) => set({ knowledge: e.target.value })}
              placeholder={'Openingstijden: maandag t/m vrijdag 09:00–17:00\nRetourneren kan binnen 30 dagen met je bon; je krijgt je geld terug.\nDe Stadsfiets kost € 499.'}
              aria-label="Goedgekeurde kennis"
            />
            <div className="text-xs text-muted">
              {lines === 0 && !c.profile ? 'Nog leeg: zonder kennis zet de bot elke inhoudelijke vraag door naar jou.' : t('{0, plural, one {# regel kennis} other {# regels kennis}}', lines)}
            </div>
            <Switch
              checked={c.profile}
              onChange={(v) => set({ profile: v })}
              label="Bedrijfsprofiel van het team ook gebruiken"
              hint={
                <>
                  Naam, wat het bedrijf doet, toon en regels uit Instellingen › Teams{b.teamName ? <> (team <span translate="no">{b.teamName}</span>)</> : null}. Alleen het profiel van het team van dit kanaal, nooit dat van een ander team.
                </>
              }
            />
          </div>

          <p className="text-xs text-muted">Elk bericht aan klanten staat met de volledige tekst in het logboek (Logboek › Verstuurd aan klanten).</p>
        </>
      )}
      <div>
        <Button variant="primary" onClick={save} loading={act.busy}>
          Opslaan
        </Button>
      </div>
    </Card>
  );
}
