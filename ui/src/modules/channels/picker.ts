/**
 * The channel picker (Kanaal toevoegen). Telegram comes first: its own bot, no open port, no public address, no ban
 * risk for your number, set up in a minute. Then WhatsApp via the QR code (behind an honest warning that the owner
 * must accept before anything connects; the server refuses a new QR channel without it) and e-mail. WhatsApp Business
 * needs a Meta business account and a public address: it sits behind "Meer opties".
 */

export const ADAPTER_ORDER = ['telegram', 'whatsapp-web', 'email', 'discord', 'slack', 'webhook', 'whatsapp'];

/** Channels an ordinary user does not need (a public address, a business account): behind "Meer opties". */
export const MORE_ADAPTERS = ['whatsapp'];

/** The easy, safe default. */
export const RECOMMENDED = 'telegram';

export interface PickBadge {
  tone: 'ok' | 'warn' | 'danger';
  text: string;
}

/** The badge on a channel in the picker (besides its requirements). */
export const PICK_BADGE: Record<string, PickBadge> = {
  telegram: { tone: 'ok', text: 'Makkelijkst en veiligst' },
  whatsapp: { tone: 'ok', text: 'officieel' },
  'whatsapp-web': { tone: 'danger', text: 'onofficieel' },
};

/** Channels whose risk the owner must read and accept before connecting. */
export const needsRiskAck = (adapter: string) => adapter === 'whatsapp-web';

/** The warning for WhatsApp via QR code: shown before connecting, and on the channel itself. */
export const QR_RISK = {
  title: 'WhatsApp kan je nummer blokkeren',
  lines: [
    'Deze koppeling werkt zoals WhatsApp Web, maar via een onofficiële weg. Dat staat niet in de voorwaarden van WhatsApp.',
    'WhatsApp kan het nummer daarom blokkeren, tijdelijk of voorgoed, zonder dat je bezwaar kunt maken. Je raakt dan ook je chats op dat nummer kwijt. De kans is groter bij veel berichten aan mensen die jou niet kennen.',
    'Voor je bedrijf of je klanten: gebruik WhatsApp Business (officieel) of Telegram. Gebruik deze koppeling alleen voor jezelf, het liefst met een apart nummer.',
  ],
  accept: 'Ik begrijp dat WhatsApp dit nummer kan blokkeren',
};

/** Picker order for the adapters the server offers. */
export function pickerOrder(available: string[]): string[] {
  return ADAPTER_ORDER.filter((id) => available.includes(id));
}
