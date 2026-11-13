/**
 * The bot profile history (BOT-10) in plain Dutch: which field changed and what its old value was. Never raw JSON
 * ("instellingen toen {}"). Pure, so tests/agent-history-text.test.ts can check it.
 */

import { formatNumber } from './format.js';
import { prettyModel } from './modelLabel.js';

export const LABEL: Record<string, string> = {
  name: 'naam', avatar: 'gezicht', color: 'kleur', role: 'rol', description: 'beschrijving', instructions: 'instructies', provider_id: 'AI-engine', model: 'model',
  reasoning: 'denkniveau', access_mode: 'toegang', workspace: 'werkmap', tool_groups: 'tools', tool_policy: 'toolbeleid', skills: 'skills', fallback: 'reserve-engine', busy_policy: 'als de bot bezig is', settings: 'overige instellingen',
};

const ACCESS: Record<string, string> = { chat: 'Alleen chatten', readonly: 'Alleen lezen', ask: 'Vraagt toestemming', auto: 'Automatisch', full: 'Volledige toegang' };
const REASONING: Record<string, string> = { low: 'Laag', medium: 'Middel', high: 'Hoog', xhigh: 'Zeer hoog', max: 'Maximaal', minimal: 'Minimaal' };
const POLICY: Record<string, string> = { allow: 'toestaan', ask: 'altijd vragen', deny: 'nooit' };
/** Bot settings (agent.settings) in words; unknown keys are counted, never shown as raw JSON. */
const SETTING: Record<string, string> = {
  historyTokens: 'Lengte van het gespreksgeheugen (tokens)',
  compaction: 'Automatisch samenvatten',
  fallbacks: 'Reserve-engines',
  onLimit: 'Bij een gebruikslimiet',
  folders: 'Extra mappen',
  extraRoots: 'Extra mappen',
  autoReview: 'Automatische controle',
  autoReviewModel: 'Model voor de automatische controle',
  fullAccessExternal: 'Volledige toegang: ook versturen naar anderen',
  allowPrivateNetwork: 'Interne netwerkadressen openen',
  maxTurns: 'Maximaal aantal stappen',
  vision: 'Afbeeldingen bekijken',
  voice: 'Spraak',
  memory: 'Geheugen',
  cli: 'CLI-instellingen',
  template: 'Sjabloon',
  importedFrom: 'Overgezet uit',
  answerStyle: 'Antwoordstijl',
};
const ON_LIMIT: Record<string, string> = { fallback: 'overschakelen naar de reserves', wait: 'wachten tot de limiet voorbij is', stop: 'stoppen en melden' };

function plain(v: any): string {
  if (v === true) return 'aan';
  if (v === false) return 'uit';
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number') return formatNumber(v);
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.length === 1 ? '1 item' : v.length ? `${v.length} items` : 'geen';
  return Object.keys(v).length ? 'ingesteld' : 'standaard';
}

/** The old value of one changed field, in plain Dutch (never "{}" or raw JSON). */
export function showValue(k: string, v: any, names: { provider(id: string): string | undefined; group(id: string): string | undefined }): string {
  const empty = v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && v && !Array.isArray(v) && !Object.keys(v).length);
  switch (k) {
    case 'access_mode':
      return ACCESS[v] || plain(v);
    case 'reasoning':
      return empty ? 'Standaard' : REASONING[v] || plain(v);
    case 'model':
      return empty || v === 'default' ? 'Standaard van de engine' : prettyModel(String(v));
    case 'provider_id':
      return empty ? 'Standaard-engine' : names.provider(v) || 'Een verwijderde engine';
    case 'avatar':
      return 'Het vorige gezicht';
    case 'busy_policy':
      return v === 'interrupt' ? 'Huidige taak onderbreken' : v === 'steer' ? 'Bijsturen tijdens de taak' : 'In de wachtrij zetten';
    case 'tool_groups':
      return empty ? 'Geen tools' : (v as string[]).map((g) => names.group(g) || g).join(', ');
    case 'tool_policy':
      return empty ? 'Alles volgens het toegangsniveau' : Object.entries(v).map(([t, p]) => `${t.replace(/_/g, ' ')}: ${POLICY[String(p)] || p}`).join('\n');
    case 'skills':
      return empty ? 'Geen skills' : Array.isArray(v) ? v.map((s: any) => (typeof s === 'string' ? s : s?.name || s?.id || '')).filter(Boolean).join(', ') || plain(v) : plain(v);
    case 'fallback':
      return empty ? 'Geen' : `${names.provider(v.provider_id) || 'Een verwijderde engine'}${v.model ? ` · ${prettyModel(v.model)}` : ''}`;
    case 'settings': {
      if (empty) return 'Geen extra instellingen';
      const lines: string[] = [];
      let other = 0;
      for (const [key, val] of Object.entries(v as Record<string, any>)) {
        const label = SETTING[key];
        if (!label) {
          other++;
          continue;
        }
        let text = plain(val);
        if (key === 'compaction') text = val === false ? 'uit' : 'aan';
        else if (key === 'onLimit') text = ON_LIMIT[val] || plain(val);
        else if (key === 'answerStyle') text = val === 'business' ? 'Zakelijk' : 'Natuurlijk';
        else if (key === 'fallbacks' && Array.isArray(val)) text = val.length ? val.map((f: any) => names.provider(f?.provider_id) || 'onbekend').join(', ') : 'geen';
        else if ((key === 'folders' || key === 'extraRoots') && Array.isArray(val)) text = val.length ? val.map((f: any) => (typeof f === 'string' ? f : f?.label || f?.path)).join(', ') : 'geen';
        lines.push(`${label}: ${text}`);
      }
      if (other) lines.push(other === 1 ? '1 andere instelling' : `${other} andere instellingen`);
      return lines.join('\n') || 'Geen extra instellingen';
    }
  }
  return empty ? '—' : plain(v);
}
