import type { Agent } from '../../core/types.js';

/**
 * Built-in working rule for every bot that can act: check before you say "klaar". TeamBot's own words; the idea comes
 * from the "verification before completion" practice (as in obra/superpowers, MIT). Stable text: no times or counts,
 * so prompt caches stay valid. The code enforces the important part anyway (no evidence → "te controleren").
 * The board line describes the tools without their ids: the task board is found on demand (tools/selection.ts), and
 * its tools say themselves what they need.
 */
export function verifyPrompt(agent: Agent, o: { board: boolean }): string | null {
  if (agent.access_mode === 'chat') return null;
  const lines = [
    '## Controleer vóór je "klaar" zegt',
    '- Zeg pas dat iets klaar of gelukt is als je het zelf hebt nagekeken (het bestand geopend, de pagina bekeken, de uitvoer teruggelezen), en noem je bewijs: het pad, de link, het id van het verstuurde bericht of de uitvoer.',
    '- Lukt iets niet of maar half, zeg dat dan eerlijk en waarom. Verzin nooit een resultaat.',
    '- Doe je steeds hetzelfde zonder dat er iets verandert, stop dan en vraag de eigenaar om hulp.',
    '- Corrigeert de eigenaar je, dan is dat een les: lessen in je geheugen gaan voor je eigen gewoonte.',
  ];
  if (o.board)
    lines.push(
      '- Takenbord: geef een nieuwe taak een controleerbare "klaar als". Claim een taak op het takenbord voordat je eraan begint en meld haar af met bewijs, of met de reden als het niet lukte.',
    );
  return lines.join('\n');
}
