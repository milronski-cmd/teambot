import { useEffect, useState } from 'react';
import type { Agent } from '../../lib/types';
import { api } from '../../lib/api';
import { useApp } from '../../lib/store';
import { Field, Input, Toggle } from '../../components/ui';
import { SelectBox as Select } from '../../components/Listbox';
import { t } from '../../lib/i18n';

/**
 * Bot editor › Werk dat af is: the second look before "klaar" (and on which engine), stopping loops, and learning from
 * the owner's corrections. Everything is on by default; saved with the bot (settings.quality).
 */
export function QualityAgentSection({ agent, onChange }: { agent: Agent; onChange(patch: Partial<Agent>): void }) {
  const providers = useApp((s) => s.providers);
  const q = agent.settings?.quality || {};
  const loop = q.loopGuard && typeof q.loopGuard === 'object' ? q.loopGuard : {};
  const loopOn = q.loopGuard !== false && loop.on !== false;
  const set = (p: Record<string, any>) => onChange({ settings: { ...(agent.settings || {}), quality: { ...q, ...p } } });
  const setLoop = (p: Record<string, any>) => set({ loopGuard: { on: loopOn, repeat: loop.repeat ?? 3, idle: loop.idle ?? 6, ...p } });
  const [lessons, setLessons] = useState<number | null>(null);
  useEffect(() => {
    if (!agent.id) return;
    api
      .get<any[]>(`/quality/lessons?agentId=${agent.id}`)
      .then((l) => setLessons(Array.isArray(l) ? l.filter((x) => x.action === 'inserted' || x.action === 'superseded').length : 0))
      .catch(() => setLessons(null));
  }, [agent.id]);
  const usable = providers.filter((p) => p.enabled);
  const num = (v: string, lo: number, hi: number, d: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : d;
  };
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Toggle checked={q.check !== false} onChange={(v) => set({ check: v })} label="Tweede blik vóór klaar" />
        <p className="text-xs leading-relaxed text-muted">
          Meldt deze bot een taak af, dan kijkt een aparte, korte controle (zonder het gesprek) zijn bewijs na tegen “klaar als”. Klopt het niet of ontbreekt bewijs, dan staat de taak op “te controleren”. Zonder bewijs is een taak nooit klaar, ook als dit uit staat.
        </p>
        {q.check !== false && (
          <Field label="Controle-engine" hint="Standaard de engine van de bot zelf. Kies een goedkopere of lokale als je wilt.">
            <Select value={q.checkProviderId || ''} onChange={(e) => set({ checkProviderId: e.target.value || undefined, checkModel: undefined })} aria-label="Controle-engine">
              <option value="">Zelfde als de bot</option>
              {usable.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {q.check !== false && q.checkProviderId && (
          <Field label="Model voor de controle" hint="Leeg = het standaardmodel van die engine.">
            <Input value={q.checkModel || ''} onChange={(e) => set({ checkModel: e.target.value.trim() || undefined })} placeholder="standaard" aria-label="Model voor de controle" />
          </Field>
        )}
      </div>
      <div className="space-y-2 border-t border-line pt-3">
        <Toggle checked={loopOn} onChange={(v) => setLoop({ on: v })} label="Lussen stoppen" />
        <p className="text-xs leading-relaxed text-muted">Komt de bot niet vooruit, dan stopt hij en vraagt jou om hulp.</p>
        {loopOn && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Zelfde stap, hoe vaak" hint="Dezelfde stap met hetzelfde resultaat (2–10).">
              <Input type="number" min={2} max={10} value={loop.repeat ?? 3} onChange={(e) => setLoop({ repeat: num(e.target.value, 2, 10, 3) })} aria-label="Zelfde stap, hoe vaak" />
            </Field>
            <Field label="Stappen zonder iets nieuws" hint="Achter elkaar, zonder nieuwe uitkomst (3–30).">
              <Input type="number" min={3} max={30} value={loop.idle ?? 6} onChange={(e) => setLoop({ idle: num(e.target.value, 3, 30, 6) })} aria-label="Stappen zonder iets nieuws" />
            </Field>
          </div>
        )}
      </div>
      <div className="space-y-2 border-t border-line pt-3">
        <Toggle checked={q.lessons !== false} onChange={(v) => set({ lessons: v })} label="Leren van je correcties" />
        <p className="text-xs leading-relaxed text-muted">
          Zeg je “doe dit voortaan anders”, dan onthoudt de bot dat als les. Ongedaan maken kan in Geheugen.
          {lessons !== null && lessons > 0 && <> {t('{0, plural, one {# les geleerd} other {# lessen geleerd}}', lessons)}.</>}{' '}
          <a className="underline" href="#/m/memory/">
            Naar Geheugen
          </a>
        </p>
      </div>
    </div>
  );
}
