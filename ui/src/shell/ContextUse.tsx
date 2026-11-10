import { api } from '../lib/api';
import { agentById, useApp } from '../lib/store';
import type { Message, Thread } from '../lib/types';
import { t } from '../lib/i18n';
import { formatNumber } from '../lib/format';
import { Toggle, toastError } from '../components/ui';

/** What the server stores per answer (server/agent/context-budget.ts ContextStats). */
interface ContextStats {
  engine: 'api' | 'cli';
  parts: { system: number; tools: number; memory: number; history: number; toolOutputs: number; attachments: number };
  total: number;
  tools: { sent: number; of: number; leftOut: string[] };
  shortened: { toolOutputs: number; duplicates: number; attachments: number; images: number; dropped: number; carried: number; thinking: number; savedTokens: number };
  saver: boolean;
  summary?: boolean;
  delegation?: number;
  reported?: { input: number; cacheRead?: number };
  engineOwn?: number;
}

const ROWS: [keyof ContextStats['parts'], string][] = [
  ['system', 'Systeemprompt'],
  ['tools', 'Tooldefinities'],
  ['memory', 'Geheugen en beurtcontext'],
  ['history', 'Gesprek'],
  ['toolOutputs', 'Tool-uitvoer'],
  ['attachments', 'Bijlagen'],
];

/** The newest answer of a bot in this conversation that carries context stats. */
export function lastContextStats(messages: Message[]): { m: Message; s: ContextStats } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.parts?.contextStats?.parts) return { m, s: m.parts.contextStats as ContextStats };
  }
  return null;
}

/**
 * Side panel › Details: what the bot got with its latest step, per part, in (estimated) tokens, what was shortened
 * to save room, and the switch for this bot. Folded in by default (it is a detail for whoever wants to know).
 */
export function ContextUse({ thread }: { thread: Thread }) {
  const messages = useApp((s) => s.messages[thread.id]) || [];
  const hit = lastContextStats(messages);
  if (!hit) return null;
  const { m, s } = hit;
  const agent = agentById(m.author_id);
  const max = Math.max(1, ...ROWS.map(([k]) => s.parts[k] || 0));
  const sh = s.shortened;
  const notes: string[] = [];
  if (sh.toolOutputs) notes.push(t('{0, plural, one {# ouder tool-resultaat ingekort} other {# oudere tool-resultaten ingekort}}', sh.toolOutputs));
  if (sh.duplicates) notes.push(t('{0, plural, one {# herhaald tool-resultaat niet opnieuw meegestuurd} other {# herhaalde tool-resultaten niet opnieuw meegestuurd}}', sh.duplicates));
  if (sh.attachments) notes.push(t('{0, plural, one {# oudere bijlage ingekort} other {# oudere bijlagen ingekort}}', sh.attachments));
  if (sh.images) notes.push(t('{0, plural, one {# afbeelding uit een oudere beurt weggelaten} other {# afbeeldingen uit oudere beurten weggelaten}}', sh.images));
  if (sh.dropped) notes.push(t('{0, plural, one {# ouder bericht weggelaten} other {# oudere berichten weggelaten}}', sh.dropped));
  if (s.summary) notes.push(t('Het oudere deel ging mee als samenvatting.'));
  if (sh.carried) notes.push(t('{0, plural, one {# vaste regel bleef bewaard} other {# vaste regels bleven bewaard}}', sh.carried));
  if (sh.thinking) notes.push(t('{0, plural, one {# oude denkstap weggelaten} other {# oude denkstappen weggelaten}}', sh.thinking));
  if (s.tools.leftOut.length) notes.push(t('Niet meegestuurd (de bot kan ze zelf erbij halen): {0}', s.tools.leftOut.join(', ')));
  if (s.delegation) notes.push(t('Gedelegeerde taak: het gesprek is begrensd op {0} tokens.', formatNumber(s.delegation)));
  // The bot's own setting when it has one (so the switch moves at once), else what the latest step ran with.
  const own = agent?.settings?.contextSaver;
  const saverOn = own === false ? false : own === true ? true : own && typeof own === 'object' && typeof own.on === 'boolean' ? own.on : s.saver;
  const setSaver = (on: boolean) => {
    if (!agent) return;
    const next = { ...(own && typeof own === 'object' ? own : {}), on };
    api.patch(`/agents/${agent.id}`, { settings: { ...(agent.settings || {}), contextSaver: next } }).catch(toastError);
  };
  return (
    <details className="rounded-lg border border-line p-3 text-xs">
      <summary className="cursor-pointer font-medium">Context van de laatste stap</summary>
      <div className="mt-2 space-y-3">
        <p className="text-muted">
          {s.engine === 'cli'
            ? t('Schatting van wat TeamBot aan {0} meegaf.', m.parts?.providerName || m.author_name)
            : t('Wat {0} bij de laatste stap meekreeg, geschat in tokens. Het model leest dit bij elke stap opnieuw.', m.author_name)}
        </p>
        <table className="w-full">
          <tbody>
            {ROWS.map(([k, label]) => (
              <tr key={k}>
                <th scope="row" className="w-1/2 py-0.5 text-start font-normal text-muted">
                  {k === 'tools' && s.tools.of ? t('{0} ({1} van {2})', label, s.tools.sent, s.tools.of) : label}
                </th>
                <td className="w-1/4 py-0.5 pe-2">
                  <div className="h-1.5 rounded-full bg-surface-2" aria-hidden>
                    <div className="h-1.5 rounded-full bg-accent" style={{ width: `${Math.round(((s.parts[k] || 0) / max) * 100)}%` }} />
                  </div>
                </td>
                <td className="py-0.5 text-end tabular-nums">{formatNumber(s.parts[k] || 0)}</td>
              </tr>
            ))}
            <tr>
              <th scope="row" className="pt-1 text-start font-medium">
                Totaal (schatting)
              </th>
              <td />
              <td className="pt-1 text-end font-medium tabular-nums">{formatNumber(s.total)}</td>
            </tr>
          </tbody>
        </table>
        {s.reported && (
          <p className="text-muted">
            {s.reported.cacheRead
              ? t('De engine telde zelf {0} tokens, waarvan {1} uit de cache.', formatNumber(s.reported.input), formatNumber(s.reported.cacheRead))
              : t('De engine telde zelf {0} tokens.', formatNumber(s.reported.input))}
            {s.engine === 'cli' && s.engineOwn ? ` ${t('Daarvan kwamen ongeveer {0} van de engine zelf (eigen instructies, tools en sessie).', formatNumber(s.engineOwn))}` : ''}
          </p>
        )}
        {notes.length > 0 && (
          <div>
            <div className="font-medium">Ingekort om ruimte te sparen</div>
            <ul className="mt-1 list-disc space-y-0.5 ps-4 text-muted">
              {notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
            {sh.savedTokens > 0 && <p className="mt-1 text-muted">{t('Bespaard bij deze stap: ongeveer {0} tokens. De bot ziet bij elk ingekort stuk dat het is ingekort.', formatNumber(sh.savedTokens))}</p>}
          </div>
        )}
        {agent && s.engine === 'api' && (
          <div className="space-y-1">
            <Toggle checked={saverOn} onChange={setSaver} label="Zuinig met context" />
            <p className="text-muted">Korte tool-uitvoer en alleen de tools die nodig lijken. Vaste regels blijven heel.</p>
          </div>
        )}
      </div>
    </details>
  );
}
