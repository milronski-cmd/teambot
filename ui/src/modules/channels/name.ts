/**
 * The suggested name of a new channel: "<bot or group> via <channel>" ("Lokaal via Webhook"), or just the channel
 * when nobody is chosen yet. It follows the "Wie antwoordt?" choice until the owner types a name himself (round 6:
 * a webhook for Lokaal was saved as "Assistent via Webhook", the bot that was selected when the form opened).
 */
export function autoChannelName(target: string, channel: string, agents: { id: string; name: string }[], rooms: { id: string; name: string }[]): string {
  const who = target.startsWith('room:') ? rooms.find((r) => `room:${r.id}` === target)?.name : agents.find((a) => `agent:${a.id}` === target)?.name;
  return who ? `${who} via ${channel}` : channel;
}
