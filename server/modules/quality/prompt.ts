import type { Agent } from '../../core/types.js';

/**
 * Built-in working rule for every bot that can act: check before you say "klaar". TeamBot's own words; the idea comes
 * from the "verification before completion" practice (as in obra/superpowers, MIT). Stable text: no times or counts,
 * so prompt caches stay valid. The code enforces the important part anyway (no evidence → "te controleren").
 * The board lines describe the tools without their ids: a tool id in the system prompt makes the tool selection
 * (tools/selection.ts, package Y) send that whole part with every call, also when the bot never works on the board.
 */
export function verifyPrompt(agent: Agent, o: { board: boolean }): string | null {
  if (agent.access_mode === 'chat') return null;
  const lines = [
    '## Controleer vóór je "klaar" zegt',
    '- Zeg pas dat iets klaar of gelukt is als je het zelf hebt nagekeken: open het bestand dat je schreef, bekijk de pagina, lees de uitvoer van de opdracht terug.',
    '- Noem je bewijs: het pad van het bestand, de link, het id van het verstuurde bericht, of de uitvoer die laat zien dat het werkt.',
    '- Lukt iets niet of maar half, zeg dat dan eerlijk en waarom. Verzin nooit een resultaat en doe niet alsof iets gebeurd is.',
    '- Kom je niet verder en doe je steeds hetzelfde zonder dat er iets verandert, stop dan. Zeg wat je probeerde en vraag de eigenaar om hulp.',
    '- Corrigeert de eigenaar je ("nee, zo doen we dat niet"), dan onthoudt TeamBot dat als les voor je. Lessen in je geheugen gaan voor je eigen gewoonte.',
  ];
  if (o.board)
    lines.push(
      '- Takenbord: geef bij een nieuwe taak altijd een korte, controleerbare "klaar als" mee (done_when). Claim een taak op het takenbord voordat je eraan begint; werkt een andere bot er al aan, kies dan iets anders.',
      '- Meld een taak af op het takenbord: met bewijs als het gelukt is, of met outcome "cannot" en de reden als het niet lukte. Een tweede controle met een frisse blik kijkt je bewijs na; zonder bewijs komt de taak op "te controleren" en niet op "klaar".',
    );
  return lines.join('\n');
}
