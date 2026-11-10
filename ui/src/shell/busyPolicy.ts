import type { Agent } from '../lib/types';

/** What a new message does while the bot works (Agent.busy_policy; server/agent/queue.ts submit). */
export const BUSY_POLICIES: { id: Agent['busy_policy']; label: string; long: string; text: string; short: string; cli?: string; cliShort?: string }[] = [
  { id: 'queue', label: 'Wachtrij', long: 'In de wachtrij zetten', text: 'Je bericht wacht tot de bot klaar is en wordt dan de volgende beurt.', short: 'Je bericht wacht tot de bot klaar is.' },
  {
    id: 'steer',
    label: 'Bijsturen',
    long: 'Bijsturen tijdens de taak',
    text: 'Je bericht gaat mee in de lopende beurt; de bot leest het bij de volgende stap.',
    short: 'De bot leest je bericht meteen mee.',
    cliShort: 'Je bericht komt vooraan in de wachtrij.',
    cli: 'Deze engine kan niet midden in een beurt bijgestuurd worden: je bericht komt vooraan in de wachtrij.',
  },
  { id: 'interrupt', label: 'Onderbreken', long: 'Huidige taak onderbreken', text: 'De bot stopt meteen en gaat verder met jouw nieuwe bericht.', short: 'De bot stopt en begint aan je bericht.' },
];

export function busyPolicy(id: string | undefined) {
  return BUSY_POLICIES.find((p) => p.id === id) || BUSY_POLICIES[0];
}
