import { useEffect, useState } from 'react';
import type { Agent } from '../../lib/types';
import { api } from '../../lib/api';
import { useApp } from '../../lib/store';
import { Field, Input, Toggle } from '../../components/ui';
import { SelectBox as Select } from '../../components/Listbox';
import { t } from '../../lib/i18n';
import { rowWorks } from '../../pages/agentRows';
import { LOOP_DEFAULTS as LD, LOOP_RANGE as LR } from '../../../../shared/loopGuard.js';

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
  const setLoop = (p: Record<string, any>) => set({ loopGuard: { on: loopOn, repeat: loop.repeat ?? LD.repeat, idle: loop.idle ?? LD.idle, ...p } });
  const [lessons, setLessons] = useState<number | null>(null);
  useEffect(() => {
    if (!agent.id) return;
    api
      .get<any[]>(`/quality/lessons?agentId=${agent.id}`)
      .then((l) => setLessons(Array.isArray(l) ? l.filter((x) => x.action === 'inserted' || x.action === 'superseded').length : 0))
      .catch(() => setLessons(null));
  }, [agent.id]);
  const usable = providers.filter((p) => p.enabled);
  const engine = providers.find((p) => p.id === agent.provider_id);
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
              <Input type="number" min={LR.repeat[0]} max={LR.repeat[1]} value={loop.repeat ?? LD.repeat} onChange={(e) => setLoop({ repeat: num(e.target.value, LR.repeat[0], LR.repeat[1], LD.repeat) })} aria-label="Zelfde stap, hoe vaak" />
            </Field>
            {/* Only TeamBot's own loop counts steps without anything new; a program is watched for the same step only. */}
            {rowWorks('loopIdle', engine) && (
              <Field label="Stappen zonder iets nieuws" hint="Achter elkaar, zonder nieuwe uitkomst (3–30).">
                <Input type="number" min={LR.idle[0]} max={LR.idle[1]} value={loop.idle ?? LD.idle} onChange={(e) => setLoop({ idle: num(e.target.value, LR.idle[0], LR.idle[1], LD.idle) })} aria-label="Stappen zonder iets nieuws" />
              </Field>
            )}
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
