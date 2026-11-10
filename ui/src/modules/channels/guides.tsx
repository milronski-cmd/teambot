import type React from 'react';
export { ADAPTER_ORDER } from './picker';

/** Link that opens outside the app. */
export function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="font-medium text-accent underline underline-offset-2">
      {children}
    </a>
  );
}

export const Code = ({ children }: { children: React.ReactNode }) => <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.85em]">{children}</code>;

export interface FieldDef {
  key: string;
  label: string;
  kind: 'text' | 'number' | 'toggle' | 'select' | 'secret';
  placeholder?: string;
  hint?: React.ReactNode;
  options?: { value: string; label: string }[];
  advanced?: boolean;
  show?: (c: Record<string, any>) => boolean;
  /** Secret that TeamBot can generate for you (verify token, webhook secret). */
  generate?: boolean;
  required?: (c: Record<string, any>) => boolean;
}

export interface Requirement {
  tone: 'ok' | 'warn' | 'danger';
  text: string;
}

export interface Guide {
  id: string;
  title: string;
  tagline: string;
  requirements: (c: Record<string, any>) => Requirement[];
  steps: (c: Record<string, any>) => React.ReactNode[];
  fields: FieldDef[];
  defaults: Record<string, any>;
  /**
   * Koppelen in één keer: the one line and the few fields a newcomer needs (keys of `fields`); every other field goes
   * behind "Meer opties" with its default, and `steps` behind "Hoe kom ik hieraan?". Without it the full form is shown.
   */
  quick?: { line: React.ReactNode; fields: string[] };
}

const always = () => true;

export const GUIDES: Record<string, Guide> = {
  telegram: {
    id: 'telegram',
    title: 'Telegram',
    tagline: 'Je eigen bot in Telegram, op je telefoon en computer.',
    quick: {
      line: (
        <>
          Stuur <Code>/newbot</Code> naar <Ext href="https://t.me/BotFather">@BotFather</Ext> in Telegram en plak de token die je krijgt.
        </>
      ),
      fields: ['token'],
    },
    defaults: { mode: 'polling', allowGroups: false },
    requirements: (c) =>
      c.mode === 'webhook'
        ? [{ tone: 'warn', text: 'Webhookmodus: publieke HTTPS-URL vereist' }]
        : [
            { tone: 'ok', text: 'Geen publieke URL nodig' },
            { tone: 'warn', text: 'TeamBot moet aan staan om berichten te ontvangen' },
          ],
    steps: () => [
      <>
        Open <Ext href="https://t.me/BotFather">@BotFather</Ext> in Telegram, stuur <Code>/newbot</Code> en kies een naam die op <Code>bot</Code> eindigt.
      </>,
      <>Plak de token die BotFather je stuurt. Hij wordt versleuteld opgeslagen.</>,
      <>Sla op en tik op “Koppel mijn Telegram”.</>,
    ],
    fields: [
      { key: 'token', label: 'Bot-token', kind: 'secret', placeholder: '123456789:AA…' },
      {
        key: 'mode',
        label: 'Ontvangen via',
        kind: 'select',
        options: [
          { value: 'polling', label: 'Long polling (aanbevolen, werkt overal)' },
          { value: 'webhook', label: 'Webhook (vereist publieke HTTPS-URL)' },
        ],
        advanced: true,
      },
      { key: 'publicBaseUrl', label: 'Publieke URL voor deze koppeling', kind: 'text', placeholder: 'https://bot.jouwdomein.nl', show: (c) => c.mode === 'webhook', hint: 'Het https-adres van buiten. Leeg = het vaste adres van de server.' },
      {
        key: 'allowGroups',
        label: 'Ook in groepen reageren',
        kind: 'toggle',
        advanced: true,
        hint: 'In groepen ziet de bot alleen /commando’s, @vermeldingen en antwoorden op zijn berichten.',
      },
      { key: 'apiBase', label: 'Eigen Bot API-server', kind: 'text', placeholder: 'https://api.telegram.org', advanced: true, hint: 'Alleen als je een eigen Telegram Bot API-server draait (voor grotere bestanden). Leeg = officiële server.' },
    ],
  },

  discord: {
    id: 'discord',
    title: 'Discord',
    tagline: 'Privéberichten met je bot, of @vermeld hem in een server.',
    defaults: { allowServers: true },
    quick: {
      line: (
        <>
          Maak een app in het <Ext href="https://discord.com/developers/applications">Discord Developer Portal</Ext>, open <b>Bot</b> › <b>Reset Token</b> en plak de token.
        </>
      ),
      fields: ['token'],
    },
    requirements: () => [
      { tone: 'ok', text: 'Geen publieke URL nodig' },
      { tone: 'ok', text: 'Geen speciale (privileged) intents nodig' },
      { tone: 'warn', text: 'TeamBot moet aan staan' },
    ],
    steps: () => [
      <>
        Ga naar het <Ext href="https://discord.com/developers/applications">Discord Developer Portal</Ext> › <b>New Application</b> en geef hem een naam.
      </>,
      <>
        Open de tab <b>Bot</b>, klik <b>Reset Token</b> en kopieer de token. De schakelaars bij <i>Privileged Gateway Intents</i> mogen uit blijven: TeamBot leest alleen privéberichten en berichten waarin de bot wordt @vermeld.
      </>,
      <>Plak de token en sla op. Na een geslaagde test krijg je een uitnodigingslink voor je server.</>,
      <>Koppel jezelf: stuur de bot een privébericht met de koppelcode.</>,
    ],
    fields: [
      { key: 'token', label: 'Bot-token', kind: 'secret', placeholder: 'MTE…' },
      { key: 'allowServers', label: 'Reageren op @vermeldingen in servers', kind: 'toggle', hint: 'Uit = alleen privéberichten.' },
    ],
  },

  slack: {
    id: 'slack',
    title: 'Slack',
    tagline: 'Je bot in je Slack-workspace: privéberichten en @vermeldingen.',
    defaults: { mode: 'socket' },
    quick: {
      line: (
        <>
          Maak de app op <Ext href="https://api.slack.com/apps?new_app=1">api.slack.com/apps</Ext> met het manifest hieronder (From a manifest), installeer hem en plak de twee tokens.
        </>
      ),
      fields: ['botToken', 'appToken'],
    },
    requirements: (c) =>
      c.mode === 'events'
        ? [{ tone: 'warn', text: 'Events API: publieke HTTPS-URL vereist' }]
        : [
            { tone: 'ok', text: 'Socket Mode: geen publieke URL nodig' },
            { tone: 'warn', text: 'TeamBot moet aan staan' },
          ],
    steps: (c) => [
      <>Kopieer het app-manifest hieronder.</>,
      <>
        Ga naar <Ext href="https://api.slack.com/apps?new_app=1">api.slack.com/apps</Ext> › <b>Create New App</b> › <b>From a manifest</b>, kies je workspace en plak het manifest.
      </>,
      <>
        Klik <b>Install to Workspace</b>. Kopieer daarna onder <b>OAuth &amp; Permissions</b> de <b>Bot User OAuth Token</b> (<Code>xoxb-…</Code>).
      </>,
      <>
        Voor reacties (👀 ✅ ❌) heb je de scope <Code>reactions:write</Code> nodig. Voeg hem toe onder <b>OAuth &amp; Permissions</b> › <b>Scopes</b> en klik <b>Reinstall to Workspace</b>.
      </>,
      c.mode === 'events' ? (
        <>
          Kopieer onder <b>Basic Information</b> de <b>Signing Secret</b>. Sla hier op; zet daarna in Slack bij <b>Event Subscriptions</b> en <b>Interactivity</b> de webhook-URL van deze koppeling.
        </>
      ) : (
        <>
          Onder <b>Basic Information</b> › <b>App-Level Tokens</b> › <b>Generate Token</b>: scope <Code>connections:write</Code>, kopieer de <Code>xapp-…</Code>-token.
        </>
      ),
      <>
        Plak de tokens hieronder. Stuur de bot daarna een privébericht, of nodig hem uit in een kanaal (<Code>/invite @bot</Code>) en @vermeld hem. Slack kent geen “typt…”-indicator voor bots.
      </>,
    ],
    fields: [
      {
        key: 'mode',
        label: 'Verbinding',
        kind: 'select',
        options: [
          { value: 'socket', label: 'Socket Mode (aanbevolen, geen publieke URL)' },
          { value: 'events', label: 'Events API via publieke HTTPS-URL' },
        ],
      },
      { key: 'botToken', label: 'Bot User OAuth Token', kind: 'secret', placeholder: 'xoxb-…' },
      { key: 'appToken', label: 'App-Level Token', kind: 'secret', placeholder: 'xapp-…', show: (c) => c.mode !== 'events' },
      { key: 'signingSecret', label: 'Signing Secret', kind: 'secret', show: (c) => c.mode === 'events' },
      { key: 'publicBaseUrl', label: 'Publieke URL voor deze koppeling', kind: 'text', placeholder: 'https://bot.jouwdomein.nl', show: (c) => c.mode === 'events', hint: 'Het https-adres van buiten. Leeg = het vaste adres van de server.' },
    ],
  },

  email: {
    id: 'email',
    title: 'E-mail',
    tagline: 'Mail je bot; hij antwoordt in dezelfde draad.',
    quick: { line: 'Vul het adres en het wachtwoord van de mailbox van je bot in. TeamBot zoekt de mailservers zelf.', fields: ['address', 'password'] },
    defaults: { preset: 'auto', folder: 'INBOX', idle: true, pollSeconds: 120, markSeen: true, requireAuth: true, chat: true, emitToRoutines: true, plusAddressing: false, replyFromPlus: true, imapSecure: true, smtpSecure: true, imapPort: 993, smtpPort: 465 },
    requirements: (c) => [
      { tone: 'ok', text: 'Geen publieke URL nodig' },
      { tone: 'warn', text: 'Gebruik bij voorkeur een apart mailadres voor de bot' },
      ...(c.preset === 'outlook' ? [{ tone: 'danger' as const, text: 'Outlook.com/Microsoft 365: wachtwoord-login is meestal uitgeschakeld' }] : []),
    ],
    steps: (c) =>
      c.preset === 'gmail'
        ? [
            <>
              Zet <Ext href="https://myaccount.google.com/signinoptions/twosv">2-stapsverificatie</Ext> aan op het Google-account van de bot.
            </>,
            <>
              Maak een <Ext href="https://myaccount.google.com/apppasswords">app-wachtwoord</Ext> (naam bijv. “TeamBot”) en plak dat hieronder — niet je gewone wachtwoord.
            </>,
            <>Vul het Gmail-adres in.</>,
          ]
        : c.preset === 'auto'
          ? [<>Alleen nieuwe, ongelezen mails worden opgepakt. Gebruik liefst een apart adres.</>]
          : c.preset === 'outlook'
          ? [
              <>
                Let op: Microsoft heeft inloggen met alleen een wachtwoord (basic auth) voor Outlook.com/Hotmail sinds september 2024 uitgezet, en bij Microsoft 365 staat het meestal ook uit. Dit werkt dus alleen als je beheerder IMAP/SMTP met wachtwoord nog toestaat.
              </>,
              <>Alternatief dat altijd werkt: laat Outlook je mail doorsturen naar een Gmail- of TransIP-adres en koppel dat.</>,
            ]
          : c.preset === 'transip'
            ? [<>Gebruikersnaam is je volledige e-mailadres.</>, <>Alleen nieuwe, ongelezen mails in de gekozen map worden opgepakt.</>]
            : [<>Vul de server-gegevens van je mailprovider in.</>],
    fields: [
      {
        key: 'preset',
        label: 'Mailprovider',
        kind: 'select',
        options: [
          { value: 'auto', label: 'Automatisch (TeamBot zoekt de servers)' },
          { value: 'gmail', label: 'Gmail (app-wachtwoord)' },
          { value: 'outlook', label: 'Outlook / Microsoft 365' },
          { value: 'transip', label: 'TransIP' },
          { value: 'custom', label: 'Zelf invullen' },
        ],
      },
      { key: 'address', label: 'E-mailadres van de bot', kind: 'text', placeholder: 'bot@voorbeeld.nl' },
      { key: 'password', label: 'Wachtwoord of app-wachtwoord', kind: 'secret' },
      { key: 'username', label: 'Gebruikersnaam (leeg = e-mailadres)', kind: 'text', advanced: true },
      { key: 'fromName', label: 'Afzendernaam', kind: 'text', placeholder: 'Mijn bot', advanced: true },
      { key: 'imapHost', label: 'IMAP-server', kind: 'text', placeholder: 'imap.voorbeeld.nl', show: (c) => c.preset === 'custom', required: always },
      { key: 'imapPort', label: 'IMAP-poort', kind: 'number', show: (c) => c.preset === 'custom' },
      { key: 'imapSecure', label: 'IMAP via TLS', kind: 'toggle', show: (c) => c.preset === 'custom' },
      { key: 'smtpHost', label: 'SMTP-server', kind: 'text', placeholder: 'smtp.voorbeeld.nl', show: (c) => c.preset === 'custom', required: always },
      { key: 'smtpPort', label: 'SMTP-poort', kind: 'number', show: (c) => c.preset === 'custom' },
      { key: 'smtpSecure', label: 'SMTP via TLS (uit = STARTTLS)', kind: 'toggle', show: (c) => c.preset === 'custom' },
      { key: 'folder', label: 'Map', kind: 'text', placeholder: 'INBOX', hint: 'Alleen nieuwe ongelezen mail in deze map. Tip: laat een filter mails voor de bot naar een eigen map verplaatsen.' },
      { key: 'chat', label: 'Bot beantwoordt mails van de allowlist', kind: 'toggle' },
      {
        key: 'plusAddressing',
        label: 'Een eigen adres per bot (plusadres)',
        kind: 'toggle',
        hint: 'Mail aan jij+baas@… komt bij Baas, mail aan het gewone adres bij deze bot.',
      },
      {
        key: 'replyFromPlus',
        label: 'Antwoorden vanaf het adres van de bot',
        kind: 'toggle',
        show: (c) => c.plusAddressing === true,
        hint: 'Bij Gmail voeg je elk adres eenmalig toe onder Instellingen › Accounts › Verzenden als.',
      },
      { key: 'emitToRoutines', label: 'Doorgeven aan routines (e-mailtrigger)', kind: 'toggle', hint: 'Routines met een e-mailtrigger zien elke nieuwe mail in deze map — als onbetrouwbare data.' },
      {
        key: 'requireAuth',
        label: 'Alleen geverifieerde afzenders (SPF/DKIM/DMARC)',
        kind: 'toggle',
        hint: 'Beschermt tegen vervalste afzenders. Zet alleen uit als je provider dit niet ondersteunt.',
        advanced: true,
      },
      { key: 'idle', label: 'Direct ophalen (IMAP IDLE)', kind: 'toggle', advanced: true, hint: 'Uit = elke paar minuten controleren.' },
      { key: 'pollSeconds', label: 'Controle-interval (seconden)', kind: 'number', advanced: true, show: (c) => c.idle === false },
      { key: 'markSeen', label: 'Verwerkte mail als gelezen markeren', kind: 'toggle', advanced: true },
    ],
  },

  'whatsapp-web': {
    id: 'whatsapp-web',
    title: 'WhatsApp (QR-code)',
    tagline: 'Je eigen WhatsApp, gekoppeld met een QR-code. Alleen voor jezelf.',
    quick: { line: 'Scan de QR-code met WhatsApp op je telefoon.', fields: [] },
    defaults: { ownerPhone: '', selfChat: true, allowGroups: false, maxAgeHours: 24 },
    requirements: () => [
      { tone: 'danger', text: 'Onofficieel: WhatsApp kan je nummer blokkeren, ook voorgoed' },
      { tone: 'ok', text: 'Geen bedrijfsaccount of publieke URL nodig' },
      { tone: 'warn', text: 'TeamBot en Edge/Chrome moeten op deze computer aan staan' },
    ],
    steps: () => [
      <>Sla op; TeamBot start onzichtbaar WhatsApp Web en toont een QR-code.</>,
      <>
        Open op je telefoon WhatsApp › <b>Instellingen</b> (iPhone) of <b>⋮</b> (Android) › <b>Gekoppelde apparaten</b> › <b>Apparaat koppelen</b> en scan de code. Zit je op je telefoon zelf? Kies dan
        “Koppelen met telefoonnummer” en voer de code van 8 tekens in.
      </>,
      <>
        Klaar. Praat met je bots in je chat <b>“Bericht aan jezelf”</b>: “@Baas maak het dagrapport”. Antwoorden en pdf’s komen in die chat terug, gemarkeerd met 🤖.
      </>,
      <>Niet voor klanten: gebruik daarvoor WhatsApp Business.</>,
    ],
    fields: [
      {
        key: 'ownerPhone',
        label: 'Je eigen nummer (aanbevolen)',
        kind: 'text',
        placeholder: '31612345678',
        hint: 'Extra slot: wordt er met een ander nummer gekoppeld, dan ontkoppelt TeamBot meteen weer.',
      },
      { key: 'selfChat', label: 'Mijn chat “Bericht aan jezelf” gebruiken om met de bots te praten', kind: 'toggle' },
      { key: 'allowGroups', label: 'Groepen toestaan (alleen als je account wordt genoemd met @)', kind: 'toggle', advanced: true },
      { key: 'maxAgeHours', label: 'Berichten ouder dan (uur) negeren', kind: 'number', advanced: true, hint: 'Na een tijd offline: oudere berichten worden niet alsnog beantwoord.' },
    ],
  },

  whatsapp: {
    id: 'whatsapp',
    title: 'WhatsApp Business (Cloud API)',
    tagline: 'Officieel via Meta, voor je klanten. Vraagt een Meta-bedrijfsaccount en een publiek adres.',
    defaults: { apiVersion: 'v25.0', maxAgeHours: 24, customer: { enabled: true } },
    requirements: () => [
      { tone: 'warn', text: 'Alleen voor de klanten van je eigen bedrijf (regel van Meta)' },
      { tone: 'danger', text: 'Meta-bedrijfsaccount + eigen telefoonnummer nodig' },
      { tone: 'danger', text: 'Publieke HTTPS-URL vereist' },
      { tone: 'warn', text: 'Vrij antwoorden alleen binnen 24 uur na iemands laatste bericht' },
    ],
    steps: () => [
      <>
        Meta staat op WhatsApp alleen bots toe die de klanten van je eigen bedrijf helpen (vragen, afspraken, bestellingen), geen algemene AI-assistent. Laat daarom <b>Klantenservice</b> aan staan: de bot zegt dat hij AI is, zet
        twijfel door naar jou en vraagt je akkoord bij geld en beloftes.
      </>,
      <>
        Maak op <Ext href="https://developers.facebook.com/apps">developers.facebook.com/apps</Ext> een app van het type <b>Business</b> en voeg het product <b>WhatsApp</b> toe. Je hebt een Meta-bedrijfsaccount (Business Portfolio) nodig.
      </>,
      <>
        Kopieer onder <b>WhatsApp › API Setup</b> het <b>Phone number ID</b>. Gebruik het testnummer van Meta of een eigen nummer dat niet al in de WhatsApp-app wordt gebruikt.
      </>,
      <>
        Maak een permanente token: <b>Bedrijfsinstellingen › Systeemgebruikers</b> › token genereren met <Code>whatsapp_business_messaging</Code> en <Code>whatsapp_business_management</Code>. De tijdelijke token uit API Setup verloopt na 24 uur.
      </>,
      <>
        Kopieer onder <b>App-instellingen › Basis</b> de <b>App secret</b> (daarmee controleert TeamBot dat berichten echt van Meta komen).
      </>,
      <>Sla op. Vul daarna in Meta bij <b>WhatsApp › Configuratie › Webhook</b> de webhook-URL en dezelfde verify token in, en abonneer op het veld <Code>messages</Code>.</>,
      <>Meta heeft een publiek https-adres nodig. Vul het hieronder in bij “Publieke URL voor deze koppeling”.</>,
    ],
    fields: [
      { key: 'phoneNumberId', label: 'Phone number ID', kind: 'text', placeholder: '123456789012345', required: always },
      { key: 'accessToken', label: 'Access token (permanent)', kind: 'secret', placeholder: 'EAA…' },
      { key: 'appSecret', label: 'App secret', kind: 'secret' },
      { key: 'verifyToken', label: 'Verify token', kind: 'secret', generate: true, hint: 'Zelf gekozen geheim; vul hetzelfde in bij Meta. Daarna zie je het niet meer.' },
      { key: 'publicBaseUrl', label: 'Publieke URL voor deze koppeling', kind: 'text', placeholder: 'https://bot.jouwdomein.nl', hint: 'Leeg = het vaste adres van de server (als de beheerder dat heeft ingesteld).' },
      { key: 'apiVersion', label: 'Graph API-versie', kind: 'text', placeholder: 'v25.0', advanced: true },
      { key: 'maxAgeHours', label: 'Berichten ouder dan (uur) negeren', kind: 'number', advanced: true, hint: 'Bescherming tegen herhaalde oude webhooks.' },
    ],
  },

  webhook: {
    id: 'webhook',
    title: 'Webhook',
    tagline: 'Eigen integraties (Home Assistant, n8n, scripts) praten met je bot via HTTP.',
    quick: { line: 'TeamBot maakt een adres en een geheim; die zet je in je eigen integratie.', fields: [] },
    defaults: { replyMode: 'sync', syncTimeoutSec: 55 },
    requirements: () => [
      { tone: 'ok', text: 'Werkt lokaal of op je netwerk' },
      { tone: 'warn', text: 'Van buitenaf: publieke URL nodig' },
    ],
    steps: () => [
      <>Kies hieronder hoe het antwoord terugkomt en kopieer het gedeelde geheim.</>,
      <>
        Je integratie stuurt <Code>POST</Code> met JSON <Code>{'{"id":"uniek","sender":{"id":"ha","name":"Home Assistant"},"conversation":{"id":"woonkamer"},"text":"…"}'}</Code>.
      </>,
      <>
        Onderteken met kopteksten <Code>X-TeamBot-Timestamp</Code> (unix-seconden) en <Code>X-TeamBot-Signature: sha256=HMAC_SHA256(geheim, timestamp + "." + body)</Code>. Verzoeken ouder dan 5 minuten of met een herhaalde handtekening worden geweigerd.
      </>,
      <>Zet de sender.id op de allowlist. Antwoorden naar een callback-URL worden op dezelfde manier ondertekend.</>,
    ],
    fields: [
      { key: 'signingSecret', label: 'Gedeeld geheim', kind: 'secret', generate: true, hint: 'Kopieer het vóór het opslaan; daarna toont TeamBot het niet meer.' },
      {
        key: 'replyMode',
        label: 'Antwoord',
        kind: 'select',
        options: [
          { value: 'sync', label: 'In de HTTP-response (wacht op de bot)' },
          { value: 'callback', label: 'Later naar een callback-URL' },
          { value: 'none', label: 'Geen antwoord terugsturen' },
        ],
      },
      { key: 'callbackUrl', label: 'Callback-URL', kind: 'text', placeholder: 'https://…', show: (c) => c.replyMode !== 'none', hint: 'Bij “in de HTTP-response” alleen gebruikt als de bot te lang nodig heeft.' },
      { key: 'syncTimeoutSec', label: 'Maximaal wachten (seconden)', kind: 'number', show: (c) => c.replyMode === 'sync', advanced: true },
      { key: 'allowBearer', label: 'Ook “Authorization: Bearer <geheim>” accepteren', kind: 'toggle', advanced: true, hint: 'Eenvoudiger voor tools zonder HMAC, maar zonder bescherming tegen herhaalde verzoeken.' },
      { key: 'allowPrivateCallback', label: 'Callback naar lokaal netwerk toestaan', kind: 'toggle', advanced: true, hint: 'Alleen voor eigenaar/beheerder (bijv. Home Assistant op je LAN).' },
      { key: 'publicBaseUrl', label: 'Publieke URL voor deze koppeling', kind: 'text', placeholder: 'https://bot.jouwdomein.nl', advanced: true, hint: 'Alleen nodig als je integratie van buiten je netwerk komt. Leeg = het vaste adres van de server.' },
    ],
  },
};

