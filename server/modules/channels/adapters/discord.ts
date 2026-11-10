import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, Events, GatewayIntentBits, MessageFlags, Partials, type Message as DMessage } from 'discord.js';
import { splitMessage } from '../format.js';
import { assertHost, fetchBuffer, fetchT } from '../net.js';
import { ChannelError, REACTION_EMOJI, type AdapterContext, type AdapterDef, type AdapterRuntime, type Conversation, type Outbound, type ReactionStatus } from '../types.js';

const API = 'https://discord.com/api/v10';
const MAX_TEXT = 2000;
// View Channel + Send Messages + Attach Files + Read Message History + Send Messages in Threads + Add Reactions (status reactions)
export const DISCORD_PERMISSIONS = String(1024 + 2048 + 32768 + 65536 + 274877906944 + 64);

const discordHost = (h: string) => h === 'cdn.discordapp.com' || h === 'media.discordapp.net';

export function discordInviteUrl(appId: string) {
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(appId)}&scope=bot&permissions=${DISCORD_PERMISSIONS}`;
}

/** Should the bot handle this message? DMs always; in servers only when the bot itself is @mentioned. */
export function discordShouldHandle(m: { authorBot: boolean; isDM: boolean; mentionedUserIds: string[]; botId: string }): boolean {
  if (m.authorBot) return false;
  return m.isDM || m.mentionedUserIds.includes(m.botId);
}

export function stripDiscordMention(text: string, botId: string) {
  return text.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
}

/**
 * Discord adapter. Intents are minimal: Guilds, GuildMessages, DirectMessages. Without the
 * privileged Message Content intent Discord still delivers content for DMs and for messages
 * that mention the bot — exactly the messages we answer.
 */
export const discordAdapter: AdapterDef = {
  id: 'discord',
  label: 'Discord',
  description: 'Praat met je bot in privéberichten of door hem te @vermelden in een server. Geen publieke URL nodig.',
  needsPublicUrl: () => false,
  approveViaChannel: true,
  maxText: MAX_TEXT,
  typingEveryMs: 8000,
  // needs the Add Reactions permission (in the invite link); without it Discord refuses quietly
  reactions: true,
  secretFields: [{ key: 'token', label: 'Bot-token (Developer Portal › Bot)', required: true }],
  validateSecret(key, v) {
    if (key === 'token' && !/^[A-Za-z0-9_.-]{50,100}$/.test(v.trim())) return 'Dit lijkt geen Discord-bot-token.';
    return null;
  },
  validate(c) {
    return { allowServers: c.allowServers !== false };
  },
  async test(ctx) {
    const token = ctx.secret('token');
    const res = await fetchT(`${API}/users/@me`, { headers: { authorization: `Bot ${token}` }, timeoutMs: 15_000, signal: ctx.signal });
    if (res.status === 401) return { ok: false, detail: 'Discord weigert de token. Maak een nieuwe in de Developer Portal (Bot › Reset Token).' };
    if (!res.ok) return { ok: false, detail: `Discord: HTTP ${res.status}` };
    const me: any = await res.json();
    return { ok: true, detail: `Token werkt: dit is ${me.username}.`, info: { botName: me.username, appId: me.id, inviteUrl: discordInviteUrl(me.id) } };
  },
  receiveHint({ info }) {
    const bot = info.botName || 'je bot';
    return `Stuur ${bot} een privébericht (in een server reageert hij alleen als je hem @vermeldt). Lukt een privébericht niet, nodig de bot dan eerst uit op een server waar jij ook in zit; Discord laat je anders geen bericht sturen.`;
  },
  create(ctx) {
    return new DiscordRuntime(ctx);
  },
};

class DiscordRuntime implements AdapterRuntime {
  private client: Client | null = null;
  private stopping = false;
  constructor(private ctx: AdapterContext) {}

  async start() {
    const token = this.ctx.secret('token');
    if (!token) throw new ChannelError('Bot-token ontbreekt', true);
    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages], partials: [Partials.Channel] });
    this.client = client;
    client.on(Events.MessageCreate, (m) => this.onMessage(m).catch((e) => this.ctx.log('in', 'error', `Bericht verwerken mislukt: ${e?.message || e}`)));
    client.on(Events.InteractionCreate, async (i) => {
      if (!i.isButton() || !i.customId.startsWith('tb:')) return;
      const text = await this.ctx.action({ conversationId: `ch:${i.channelId}`, senderId: i.user.id, actionId: i.customId.slice(3) }).catch(() => null);
      await i.reply({ content: text || 'Niet (meer) geldig.', flags: MessageFlags.Ephemeral }).catch(() => {});
      if (text) await i.message.edit({ components: [] }).catch(() => {});
    });
    client.on(Events.ShardDisconnect, () => !this.stopping && this.ctx.status('connecting', 'Verbinding met Discord verbroken, opnieuw verbinden…'));
    client.on(Events.ShardReconnecting, () => !this.stopping && this.ctx.status('connecting', 'Opnieuw verbinden met Discord…'));
    client.on(Events.ShardResume, () => this.ctx.status('connected', null));
    client.on(Events.ShardReady, () => this.ctx.status('connected', null));
    client.on(Events.Invalidated, () => this.ctx.fail(new ChannelError('Discord-sessie ongeldig geworden', false)));
    client.on(Events.Error, (e) => this.ctx.log('system', 'error', `Discord: ${e.message}`));
    const ready = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new ChannelError('Discord reageerde niet binnen 30 s')), 30_000);
      client.once(Events.ClientReady, (c) => {
        clearTimeout(t);
        const cur = this.ctx.binding();
        this.ctx.setState({ info: { ...(cur.state?.info || {}), botName: c.user.username, appId: c.user.id, inviteUrl: discordInviteUrl(c.user.id) } });
        resolve();
      });
    });
    try {
      await client.login(token);
    } catch (e: any) {
      const code = String(e?.code || '');
      if (code === 'TokenInvalid' || /token/i.test(String(e?.message))) throw new ChannelError('Discord weigert de bot-token. Maak een nieuwe in de Developer Portal (Bot › Reset Token).', true);
      if (/disallowed intents/i.test(String(e?.message))) throw new ChannelError('Discord weigert de gevraagde intents. Controleer de bot-instellingen in de Developer Portal.', true);
      throw new ChannelError(`Discord: ${e?.message || e}`);
    }
    await ready;
    return 'connected' as const;
  }

  async stop() {
    this.stopping = true;
    const c = this.client;
    this.client = null;
    if (c) await c.destroy().catch(() => {});
  }

  private async onMessage(m: DMessage) {
    const me = this.client?.user;
    if (!me) return;
    const isDM = m.channel.type === ChannelType.DM;
    if (!discordShouldHandle({ authorBot: m.author.bot, isDM, mentionedUserIds: [...m.mentions.users.keys()], botId: me.id })) return;
    if (!isDM && this.ctx.binding().config.allowServers === false) return;
    const text = stripDiscordMention(m.content || '', me.id);
    const maxMb = Math.min(50, Math.max(1, Number(this.ctx.binding().config.maxFileMb) || 20));
    const attachments = [...m.attachments.values()].map((a) => ({
      name: a.name || 'bestand',
      mime: a.contentType || 'application/octet-stream',
      size: a.size,
      kind: (/^image\//.test(a.contentType || '') ? 'image' : /^audio\//.test(a.contentType || '') ? (a.duration ? 'voice' : 'audio') : 'file') as any,
      fetch: () => fetchBuffer(assertHost(a.url, discordHost).toString(), { maxBytes: maxMb * 1024 * 1024, signal: this.ctx.signal }),
    }));
    const chName = 'name' in m.channel && m.channel.name ? `#${m.channel.name}` : 'kanaal';
    await this.ctx.receive({
      messageId: `d${m.id}`,
      conversation: { id: `ch:${m.channelId}`, title: isDM ? m.author.globalName || m.author.username : `${m.guild?.name || 'Server'} ${chName}`, private: isDM },
      sender: { id: m.author.id, name: m.author.globalName || m.author.username, handle: '@' + m.author.username },
      text,
      attachments,
      date: m.createdTimestamp,
      extra: { channelId: m.channelId, lastMessageId: m.id, guildId: m.guildId },
      reactTo: `${m.channelId}:${m.id}`,
    });
  }

  private async channel(id: string) {
    if (!this.client) throw new ChannelError('Niet verbonden met Discord');
    const ch = await this.client.channels.fetch(id);
    if (!ch || !ch.isSendable()) throw new ChannelError('Discord-kanaal niet gevonden of de bot mag er niet schrijven');
    return ch;
  }

  private async sendTo_(channelId: string, out: Outbound, replyTo?: string): Promise<string[]> {
    const ch = await this.channel(channelId);
    const ids: string[] = [];
    const chunks = splitMessage(out.text || '', MAX_TEXT - 50);
    const files = (out.files || []).slice(0, 10).map((f) => new AttachmentBuilder(f.path, { name: f.name }));
    const components = out.buttons?.length
      ? [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            out.buttons.slice(0, 5).map((b) => new ButtonBuilder().setCustomId(('tb:' + b.id).slice(0, 100)).setLabel(b.label.slice(0, 80)).setStyle(b.style === 'danger' ? ButtonStyle.Danger : b.style === 'primary' ? ButtonStyle.Success : ButtonStyle.Secondary)),
          ),
        ]
      : [];
    if (!chunks.length && files.length) chunks.push('');
    for (let i = 0; i < chunks.length; i++) {
      const last = i === chunks.length - 1;
      const msg = await ch.send({
        content: chunks[i] || undefined,
        files: last ? files : [],
        components: last ? components : [],
        allowedMentions: { parse: [] },
        ...(i === 0 && replyTo ? { reply: { messageReference: replyTo, failIfNotExists: false } } : {}),
      });
      ids.push(`d${msg.id}`);
    }
    return ids;
  }

  async send(conv: Conversation, out: Outbound) {
    const channelId = conv.meta?.channelId || conv.external_id.replace(/^ch:/, '');
    return this.sendTo_(channelId, out, conv.is_private ? undefined : conv.meta?.lastMessageId);
  }

  async sendTo(target: string, out: Outbound) {
    if (!this.client) throw new ChannelError('Niet verbonden met Discord');
    const t = target.trim();
    const m = t.match(/^(user|channel):(\d{15,25})$/) || (/^\d{15,25}$/.test(t) ? [t, 'user', t] : null);
    if (!m) throw new ChannelError('Geef “user:<id>” of “channel:<id>” op.');
    if (m[1] === 'user') {
      const u = await this.client.users.fetch(m[2]);
      const dm = await u.createDM();
      const ids = await this.sendTo_(dm.id, out);
      return { conversationId: `ch:${dm.id}`, title: u.globalName || u.username, private: true, ids, extra: { channelId: dm.id } };
    }
    const ids = await this.sendTo_(m[2], out);
    return { conversationId: `ch:${m[2]}`, title: `kanaal ${m[2]}`, private: false, ids, extra: { channelId: m[2] } };
  }

  async typing(conv: Conversation) {
    const ch = await this.channel(conv.meta?.channelId || conv.external_id.replace(/^ch:/, ''));
    if ('sendTyping' in ch) await ch.sendTyping();
  }

  /** Status reaction: 👀 while working, then 👀 off and ✅ or ❌ on (needs the Add Reactions permission). */
  async react(_conv: Conversation, reactTo: string, status: ReactionStatus) {
    const rest = this.client?.rest;
    const [channelId, messageId] = reactTo.split(':');
    if (!rest || !/^\d{5,25}$/.test(channelId || '') || !/^\d{5,25}$/.test(messageId || '')) return;
    const own = (e: string) => `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(e)}/@me` as const;
    if (status !== 'working') await rest.delete(own(REACTION_EMOJI.working)).catch(() => {});
    await rest.put(own(REACTION_EMOJI[status]));
  }
}
